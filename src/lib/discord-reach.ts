import prisma from '@/lib/prisma';

/**
 * Who Discord can actually reach, for one tournament.
 *
 * This module exists to stop the organizer assuming. Every other surface in Summit answers
 * "did we tell them?" with an intent ("we sent a DM"); this one answers it with evidence —
 * a `DiscordDmAttempt` row Discord itself wrote the outcome into. Nothing here may report a
 * player as notified on the strength of a `DiscordLink` alone.
 *
 * It is deliberately read-only and holds no send path: the app's sender (src/lib/discord.ts)
 * writes the attempt rows, this reads them back.
 */

/**
 * The remedy decides the state, which is why there are six and not two. An organizer reads this
 * column to decide what to do before the first match is called:
 *
 *   NO_ACCOUNT         — no `Player.userId`. They never signed in with Steam, so there is no
 *                        account for a Discord link to hang off. Nothing digital reaches them.
 *   NOT_LINKED         — an account, no `DiscordLink`. They can run `/koble`. Or they are 12
 *                        and never will, which is fine — go and fetch them.
 *   LINKED_OPTED_OUT   — linked, then asked us to stop. There is no remedy and none is wanted.
 *   LINKED_BLOCKED     — Discord refused the last attempt (50007: DMs from server members off,
 *                        or they left the guild). A settings change on their side fixes it.
 *   LINKED_UNCONFIRMED — linked, but nothing has ever been accepted for them. Treated as
 *                        unreachable, because it is: a link is an address, not a delivery.
 *   LINKED_SENT        — Discord accepted a message for them. SENT, never "delivered": a 204
 *                        proves Discord took it, not that a kid read it.
 *
 * `LINKED_OPTED_OUT` is an addition to the spec's five (§9a), not a change to them: opt-out is
 * honoured at fan-out, so folding it into NOT_LINKED would tell the organizer to go chase a
 * remedy the player already declined.
 */
export type ReachState =
  | 'NO_ACCOUNT'
  | 'NOT_LINKED'
  | 'LINKED_OPTED_OUT'
  | 'LINKED_BLOCKED'
  | 'LINKED_UNCONFIRMED'
  | 'LINKED_SENT';

/** The last thing Discord said about this player, stripped to what an organizer can act on. */
export interface ReachAttempt {
  event: string;
  outcome: string;
  /** Discord's own JSON error code — 50007 is "cannot send messages to this user". */
  discordCode: number | null;
  createdAt: string;
}

/**
 * One roster row as the panel renders it.
 *
 * There is no `discordId` and no `steamId` on this type, on purpose. The panel never needs a
 * snowflake to do its job, and a staff-only route is still one screenshot away from a group
 * chat of 13-year-olds.
 */
export interface ReachPlayer {
  playerId: string;
  /** Display name: the in-game name if there is one, else the legal one. */
  name: string;
  teamName: string | null;
  seating: string | null;
  state: ReachState;
  linked: boolean;
  optedOut: boolean;
  /** The Discord username we linked, so crew can find them in the server. Not a snowflake. */
  discordUsername: string | null;
  lastAttempt: ReachAttempt | null;
}

export interface ReachSummary {
  /** Every player on the tournament roster. The denominator is always this. */
  total: number;
  /** Proven sends only — the headline number, and the only one that may grow a green badge. */
  reachable: number;
  linked: number;
  blocked: number;
  optedOut: number;
  noAccount: number;
  notLinked: number;
  unconfirmed: number;
}

export interface ReachReport {
  tournamentId: string;
  dmPaused: boolean;
  summary: ReachSummary;
  players: ReachPlayer[];
}

type AttemptRow = {
  event: string;
  outcome: string;
  discordCode: number | null;
  createdAt: Date;
};

type LinkRow = {
  dmState: string;
  optOut: boolean;
  discordUsername: string;
};

/**
 * The evidence rule, in one function.
 *
 * The newest attempt wins over the cached `DiscordLink.dmState`, because `dmState` is global to
 * the user while attempts are scoped to this tournament, and because a stale SENT must never
 * outrank a fresh refusal. `SENT` requires an attempt row: a `dmState` of SENT with nothing
 * behind it is UNCONFIRMED, which is what "never render a player as notified unless a
 * DiscordDmAttempt row says SENT" means in code.
 */
export function reachStateFor(
  hasUser: boolean,
  link: LinkRow | null,
  lastAttempt: AttemptRow | null
): ReachState {
  if (!hasUser) return 'NO_ACCOUNT';
  if (!link) return 'NOT_LINKED';
  if (link.optOut) return 'LINKED_OPTED_OUT';

  const outcome = lastAttempt?.outcome;
  if (outcome === 'BLOCKED' || outcome === 'UNKNOWN_USER') return 'LINKED_BLOCKED';
  if (outcome === 'SENT') return 'LINKED_SENT';
  // No attempt yet, or ERROR / RATE_LIMITED / SKIPPED_OPTOUT: nothing has been accepted for
  // them. A link whose dmState says BLOCKED is blocked even with no attempt row in scope.
  if (link.dmState === 'BLOCKED') return 'LINKED_BLOCKED';
  return 'LINKED_UNCONFIRMED';
}

/** Roll the per-player states up into the line the organizer reads at a glance. */
export function summarize(players: ReachPlayer[]): ReachSummary {
  const count = (state: ReachState) => players.filter((p) => p.state === state).length;
  return {
    total: players.length,
    reachable: count('LINKED_SENT'),
    linked: players.filter((p) => p.linked).length,
    blocked: count('LINKED_BLOCKED'),
    optedOut: count('LINKED_OPTED_OUT'),
    noAccount: count('NO_ACCOUNT'),
    notLinked: count('NOT_LINKED'),
    unconfirmed: count('LINKED_UNCONFIRMED'),
  };
}

/** Worst first: the panel is a work list, so the players needing a walk sort to the top. */
const STATE_ORDER: Record<ReachState, number> = {
  NO_ACCOUNT: 0,
  NOT_LINKED: 1,
  LINKED_BLOCKED: 2,
  LINKED_UNCONFIRMED: 3,
  LINKED_OPTED_OUT: 4,
  LINKED_SENT: 5,
};

/**
 * Build the whole report for one tournament.
 *
 * Attempts are scoped to this tournament: rows for its matches, plus the `LINK_PROBE` rows
 * (`matchId = null`) that prove a DM channel opened at link time. An attempt written for some
 * other LAN's match says nothing about tonight.
 */
export async function buildReachReport(tournamentId: string): Promise<ReachReport | null> {
  const tournament = await prisma.tournament.findUnique({
    where: { id: tournamentId },
    select: { id: true, discordDmPaused: true },
  });
  if (!tournament) return null;

  const players = await prisma.player.findMany({
    where: { tournamentId },
    select: {
      id: true,
      name: true,
      nickname: true,
      seating: true,
      userId: true,
      team: { select: { name: true } },
    },
  });

  const userIds = players.map((p) => p.userId).filter((id): id is string => Boolean(id));

  const links = userIds.length
    ? await prisma.discordLink.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, dmState: true, optOut: true, discordUsername: true },
      })
    : [];
  const linkByUser = new Map(links.map((l) => [l.userId, l]));

  const matchIds = (
    await prisma.match.findMany({ where: { tournamentId }, select: { id: true } })
  ).map((m) => m.id);

  // Newest first, then keep the first row seen per user — one pass, no N+1.
  const attempts = userIds.length
    ? await prisma.discordDmAttempt.findMany({
        where: {
          userId: { in: userIds },
          OR: [{ matchId: null }, { matchId: { in: matchIds } }],
        },
        select: { userId: true, event: true, outcome: true, discordCode: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      })
    : [];
  const lastAttemptByUser = new Map<string, AttemptRow>();
  for (const attempt of attempts) {
    if (!lastAttemptByUser.has(attempt.userId)) lastAttemptByUser.set(attempt.userId, attempt);
  }

  const rows: ReachPlayer[] = players.map((player) => {
    const link = player.userId ? linkByUser.get(player.userId) ?? null : null;
    const lastAttempt = player.userId ? lastAttemptByUser.get(player.userId) ?? null : null;
    return {
      playerId: player.id,
      name: player.nickname || player.name,
      teamName: player.team?.name ?? null,
      seating: player.seating ?? null,
      state: reachStateFor(Boolean(player.userId), link, lastAttempt),
      linked: Boolean(link),
      optedOut: Boolean(link?.optOut),
      discordUsername: link?.discordUsername ?? null,
      lastAttempt: lastAttempt
        ? {
            event: lastAttempt.event,
            outcome: lastAttempt.outcome,
            discordCode: lastAttempt.discordCode ?? null,
            createdAt: lastAttempt.createdAt.toISOString(),
          }
        : null,
    };
  });

  rows.sort(
    (a, b) =>
      STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
      (a.teamName ?? '').localeCompare(b.teamName ?? '') ||
      a.name.localeCompare(b.name)
  );

  return {
    tournamentId: tournament.id,
    dmPaused: tournament.discordDmPaused,
    summary: summarize(rows),
    players: rows,
  };
}
