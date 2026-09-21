import prisma from '@/lib/prisma';
import { discordDmMode, isDiscordDmSimulated, type DiscordSendMode } from '@/lib/discord-mode';

/**
 * Who Discord can actually reach, for one tournament.
 *
 * This module exists to stop the organizer assuming. Every other surface in Summit answers
 * "did we tell them?" with an intent ("we sent a DM"); this one answers it with evidence —
 * a `DiscordDmAttempt` row Discord itself wrote the outcome into. Nothing here may report a
 * player as notified on the strength of a `DiscordLink` alone.
 *
 * It holds no send path — the app's sender (src/lib/discord.ts) does the talking — but it does
 * own the *writing down* of what Discord answered (`recordDmAttempt` at the bottom of this
 * file), because the read rule and the write rule are the same rule and splitting them is how
 * a fake SENT gets written in the first place.
 */

/**
 * The only outcome that is proof. Everything else in the vocabulary
 * (BLOCKED | UNKNOWN_USER | RATE_LIMITED | ERROR | SKIPPED_OPTOUT | SIMULATED) means Discord
 * did not accept a message for this player, and none of them may ever be counted as reach.
 */
const PROOF_OF_SEND = 'SENT';

/**
 * Written instead of `SENT` when this deployment cannot actually talk to Discord — mock mode,
 * or no bot token (see `discord-mode.ts`). The row still exists, because "we tried and nothing
 * happened" is worth recording, but it says what really occurred: nothing was sent.
 */
export const SIMULATED_OUTCOME = 'SIMULATED';

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
  /**
   * Whether this deployment can talk to Discord at all. `SIMULATED` means no DM can leave the
   * process right now, whatever the rows below say about the past — the panel has to show that,
   * because "1 of 5 can be reached" read off an unconfigured deployment is the exact sentence
   * this feature exists to stop anyone printing.
   */
  sendMode: DiscordSendMode;
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
  /** When `dmState` was last rewritten by a send. Null on a link nothing has been tried for. */
  dmCheckedAt: Date | null;
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

  // A refusal the cache learned about *after* the newest attempt we can see outranks that
  // attempt. `DiscordLink.dmState` is global to the user and is rewritten by every send, so a
  // kid who closed their DMs between two tournaments has a fresh BLOCKED in the cache and a
  // stale SENT in this tournament's rows. Counting the stale one is precisely "a stale SENT
  // surviving a fresh refusal", which this module promises never to do.
  const cacheSaysBlocked = link.dmState === 'BLOCKED';
  const cacheIsNewerThanAttempt =
    Boolean(link.dmCheckedAt) &&
    (!lastAttempt || (link.dmCheckedAt as Date).getTime() > lastAttempt.createdAt.getTime());
  if (cacheSaysBlocked && cacheIsNewerThanAttempt) return 'LINKED_BLOCKED';

  // The one green branch in this file. It requires an attempt row whose outcome is literally
  // SENT — never a cached `dmState`, and never `SIMULATED`, which is what an intercepted send
  // writes when nothing left the process.
  if (outcome === PROOF_OF_SEND) return 'LINKED_SENT';

  // No attempt yet, or SIMULATED / ERROR / RATE_LIMITED / SKIPPED_OPTOUT: nothing has been
  // accepted for them. A link whose dmState says BLOCKED is blocked even with no attempt row
  // in scope — an unexplained refusal still beats no evidence at all.
  if (cacheSaysBlocked) return 'LINKED_BLOCKED';
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
        select: {
          userId: true,
          dmState: true,
          dmCheckedAt: true,
          optOut: true,
          discordUsername: true,
        },
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
    sendMode: discordDmMode(),
    summary: summarize(rows),
    players: rows,
  };
}

/**
 * Write down what Discord answered — the only supported way to create a `DiscordDmAttempt`.
 *
 * The rule it enforces is the one the whole feature rests on: **an intercepted send can never
 * be recorded as `SENT`.** `src/lib/discord.ts` returns `true` from its `[STRATEGY 3 MOCK]`
 * branch without calling Discord, and a sender that passed that `true` straight into an attempt
 * row would manufacture exactly the evidence this table exists to demand. So when the
 * deployment cannot DM (mock mode, or no bot token) the outcome written is `SIMULATED`,
 * whatever the caller believes happened.
 *
 * Nothing calls this yet — the DM sender is the next piece of the spec (§7) — and that is the
 * point: the guard is here before the sender is, so the sender cannot get it wrong. Never
 * throws; losing the evidence row must not fail a send, and a missing row is read as "no
 * evidence", which is the safe direction.
 */
export async function recordDmAttempt(input: {
  userId: string;
  discordId: string;
  event: string;
  matchId?: string | null;
  outcome: string;
  discordCode?: number | null;
  locale: string;
}): Promise<void> {
  const simulated = isDiscordDmSimulated();
  const outcome = simulated ? SIMULATED_OUTCOME : input.outcome;
  const discordCode = simulated ? null : input.discordCode ?? null;
  const matchId = input.matchId ?? null;
  try {
    await prisma.discordDmAttempt.create({
      data: {
        userId: input.userId,
        discordId: input.discordId,
        event: input.event,
        matchId,
        outcome,
        discordCode,
        locale: input.locale,
      },
    });
  } catch {
    // A second send for the same (match, event, player) hits `@@unique([matchId, event, userId])`.
    // The newest answer replaces the old one — a retry that Discord refuses must not leave
    // yesterday's SENT standing as the evidence of record.
    try {
      await prisma.discordDmAttempt.updateMany({
        where: { userId: input.userId, event: input.event, matchId },
        data: { outcome, discordCode, createdAt: new Date() },
      });
    } catch (error) {
      console.warn('[discord-reach] attempt row write failed:', error);
    }
  }
}
