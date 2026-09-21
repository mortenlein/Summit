import path from 'path';
import { PrismaClient } from '@prisma/client';

/**
 * Non-destructive seeding for the LAN-flow specs.
 *
 * `helpers/seed.ts` wipes the whole database (it builds one canonical fixture), which makes
 * tests order-dependent and — worse — invalidates every already-minted session token, because
 * `User` rows are recreated with fresh ids. These helpers only ever *add* a tournament, so each
 * test owns its own data and tests stay independent of one another.
 */
const defaultDatabaseUrl = `file:${path.resolve(process.cwd(), 'prisma', `e2e-${process.env.E2E_PORT || '4101'}.db`).replace(/\\/g, '/')}`;

export const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL || defaultDatabaseUrl } },
});

let counter = 0;
const uniqueName = (prefix: string) => `${prefix} ${Date.now().toString(36)}-${counter++}`;

export interface TournamentOptions {
  name?: string;
  teamSize?: number;
  format?: 'SINGLE_ELIMINATION' | 'DOUBLE_ELIMINATION';
  steamSignupEnabled?: boolean;
  rosterLocked?: boolean;
  bo3LastRounds?: number | null;
  hasThirdPlace?: boolean;
  eonBridgeToken?: string | null;
}

/** A brand-new, empty tournament. Nothing else in the database is touched. */
export async function createTournament(options: TournamentOptions = {}) {
  const format = options.format ?? 'SINGLE_ELIMINATION';
  return prisma.tournament.create({
    data: {
      name: options.name ?? uniqueName('LAN Cup'),
      game: 'CS2',
      category: 'BRACKET',
      type: format,
      format,
      teamSize: options.teamSize ?? 1,
      steamSignupEnabled: options.steamSignupEnabled ?? false,
      rosterLocked: options.rosterLocked ?? false,
      bo3LastRounds: options.bo3LastRounds ?? null,
      hasThirdPlace: options.hasThirdPlace ?? false,
      eonBridgeToken: options.eonBridgeToken ?? null,
    },
  });
}

export interface SeedPlayer {
  name: string;
  nickname?: string;
  seating?: string;
  steamId?: string;
  userId?: string;
  isLeader?: boolean;
}

/** One team in an existing tournament, with however many player rows are asked for. */
export async function createTeam(
  tournamentId: string,
  options: { name: string; seed?: number | null; inviteCode?: string; players?: SeedPlayer[] }
) {
  return prisma.team.create({
    data: {
      name: options.name,
      tournamentId,
      seed: options.seed ?? null,
      inviteCode: options.inviteCode ?? `inv-${Math.random().toString(36).slice(2, 10)}`,
      players: {
        create: (options.players ?? []).map((player) => ({
          name: player.name,
          nickname: player.nickname ?? null,
          seating: player.seating ?? null,
          steamId: player.steamId ?? null,
          userId: player.userId ?? null,
          isLeader: player.isLeader ?? false,
          tournamentId,
        })),
      },
    },
    include: { players: true },
  });
}

/**
 * `count` seeded teams (seed 1..count) each with a single placeholder player, named so the
 * bracket assertions can talk about "the seed-3 team" rather than an opaque uuid.
 */
export async function createSeededTeams(tournamentId: string, count: number) {
  const teams = [];
  for (let seed = 1; seed <= count; seed++) {
    teams.push(
      await createTeam(tournamentId, {
        name: `Seed ${seed}`,
        seed,
        players: [{ name: `Player ${seed}`, seating: `S${String(seed).padStart(2, '0')}`, isLeader: true }],
      })
    );
  }
  return teams;
}

/** Every match of a tournament, in bracket order (round, then matchOrder). */
export async function readMatches(tournamentId: string) {
  return prisma.match.findMany({
    where: { tournamentId },
    orderBy: [{ bracketType: 'asc' }, { round: 'asc' }, { matchOrder: 'asc' }],
  });
}

export async function readMatch(matchId: string) {
  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match) throw new Error(`readMatch(${matchId}): no such match`);
  return match;
}

export async function setRosterLocked(tournamentId: string, rosterLocked: boolean) {
  return prisma.tournament.update({ where: { id: tournamentId }, data: { rosterLocked } });
}

export async function readPlayer(playerId: string) {
  return prisma.player.findUnique({ where: { id: playerId } });
}

/**
 * A callable two-team match: both rosters present (so `/load` will notify) and a server to
 * connect to, exactly like the fixture a marshal sees on the floor.
 */
export async function createCallableMatch(options: { homeUserId?: string; awayUserId?: string } = {}) {
  const tournament = await createTournament({ name: uniqueName('Floor Cup'), teamSize: 1 });
  const home = await createTeam(tournament.id, {
    name: 'Home Crew',
    seed: 1,
    players: [{ name: 'Home Player', nickname: 'Homie', seating: 'A12', userId: options.homeUserId, isLeader: true }],
  });
  const away = await createTeam(tournament.id, {
    name: 'Away Crew',
    seed: 2,
    players: [{ name: 'Away Player', nickname: 'Awayo', seating: 'C01', userId: options.awayUserId, isLeader: true }],
  });

  const match = await prisma.match.create({
    data: {
      tournamentId: tournament.id,
      homeTeamId: home.id,
      awayTeamId: away.id,
      round: 1,
      matchOrder: 0,
      bestOf: 1,
      scoreLimit: 1,
      status: 'PENDING',
      serverIp: '127.0.0.1',
      serverPort: '27015',
      bracketType: 'WINNERS',
    },
  });

  return { tournament, home, away, match };
}

// ---------------------------------------------------------------------------
// Bracket-engine helpers (appended: the helpers above this line are shared with
// the other LAN suites, so the bracket-* specs only ever add to the bottom).
//
// The import lives down here on purpose — `import type` is hoisted and costs
// nothing at runtime, and keeping it beside its users makes this block a pure
// append that cannot disturb what the other suites read.
// ---------------------------------------------------------------------------
import type { APIRequestContext } from '@playwright/test';

type MatchRow = Awaited<ReturnType<typeof readMatch>>;

/** Matches that are over. Mirrors `DONE_STATUSES` in src/lib/match-status.ts. */
const DONE = ['COMPLETED', 'FINISHED'];

/** Win condition for a best-of series — the same rule as `scoreLimitFor`. */
export const seriesLimit = (bestOf: number | null | undefined) =>
  Math.floor(Math.max(1, bestOf ?? 1) / 2) + 1;

/** True for a bye row: exactly one team, decided at generation time. */
export const isBye = (match: { homeTeamId: string | null; awayTeamId: string | null }) =>
  Boolean(match.homeTeamId) !== Boolean(match.awayTeamId);

export const isDoneRow = (match: { status: string | null }) => DONE.includes((match.status ?? '').toUpperCase());

/** The column a winner/loser lands in, as the route resolves it (explicit slot, else parity). */
export const slotColumn = (slot: string | null | undefined, matchOrder: number): 'homeTeamId' | 'awayTeamId' =>
  (slot ? slot === 'HOME' : matchOrder % 2 === 0) ? 'homeTeamId' : 'awayTeamId';

export interface BracketSeedOptions extends TournamentOptions {
  /** How many of the final rounds are BO5 (the one column `createTournament` doesn't take). */
  bo5LastRounds?: number | null;
  /** How many seeded teams to create (seed 1..teams). */
  teams: number;
}

/**
 * A generated bracket, ready to play: tournament + `teams` seeded teams + a real
 * `POST /generate` through the API, so the routing columns are the ones the product writes.
 * Throws with the response body when generation is refused, which fails the test at the call
 * site instead of three assertions later.
 */
export async function seedAndGenerate(api: APIRequestContext, options: BracketSeedOptions) {
  const { teams: teamCount, bo5LastRounds, ...tournamentOptions } = options;
  const tournament = await createTournament(tournamentOptions);
  if (bo5LastRounds !== undefined && bo5LastRounds !== null) {
    await prisma.tournament.update({ where: { id: tournament.id }, data: { bo5LastRounds } });
  }
  const teams = await createSeededTeams(tournament.id, teamCount);

  const res = await api.post(`/api/tournaments/${tournament.id}/generate`, { data: {} });
  if (res.status() !== 200) {
    throw new Error(`seedAndGenerate: /generate returned ${res.status()} — ${await res.text()}`);
  }

  return { tournamentId: tournament.id, tournament, teams, matches: await readMatches(tournament.id) };
}

/** The seeded team wearing `seed`. */
export const bySeed = <T extends { seed: number | null }>(teams: T[], seed: number): T => {
  const team = teams.find((t) => t.seed === seed);
  if (!team) throw new Error(`bySeed(${seed}): no such team`);
  return team;
};

/**
 * Score a match to its win condition through the real route, so `HOME`/`AWAY` wins it.
 * The stored `bestOf` is read first: a BO5 needs 3 maps where a BO1 needs 1, and a hard-coded
 * scoreline would quietly stop completing matches the moment a round's format changed.
 */
export async function complete(api: APIRequestContext, matchId: string, winner: 'HOME' | 'AWAY' = 'HOME') {
  const match = await readMatch(matchId);
  const limit = seriesLimit(match.bestOf);
  const data = winner === 'HOME' ? { homeScore: limit, awayScore: 0 } : { homeScore: 0, awayScore: limit };
  const res = await api.post(`/api/matches/${matchId}`, { data });
  if (res.status() !== 200) {
    throw new Error(`complete(${matchId.slice(0, 8)}, ${winner}): ${res.status()} — ${await res.text()}`);
  }
  return (await res.json()) as MatchRow & { winnerId: string | null };
}

/** Put a completed match back on the floor (the "un-advance" path). */
export async function reopen(api: APIRequestContext, matchId: string, status = 'READY') {
  return api.post(`/api/matches/${matchId}`, { data: { status } });
}

export interface PlayThroughOptions {
  /** Which side wins a given match. Default: HOME, so the higher seed of each pairing survives. */
  winner?: (match: MatchRow) => 'HOME' | 'AWAY';
  /** Safety valve: how many passes before we call the bracket stuck. */
  maxPasses?: number;
}

/**
 * Play a whole bracket out. Each pass completes every match that is currently playable (not
 * done, both teams known); finishing those fills the next slots, so the loop walks any shape —
 * single elimination with byes, a third-place match, or a double-elim bracket whose losers side
 * only becomes playable as the winners side drops teams into it.
 *
 * Returns one entry per completed match: its pre-state (routing columns included) and the row
 * the route wrote back.
 */
export async function playThrough(
  api: APIRequestContext,
  tournamentId: string,
  options: PlayThroughOptions = {}
) {
  const played: { before: MatchRow; after: MatchRow & { winnerId: string | null } }[] = [];

  for (let pass = 0; pass < (options.maxPasses ?? 40); pass++) {
    const playable = (await readMatches(tournamentId))
      .filter((m) => !isDoneRow(m) && m.homeTeamId && m.awayTeamId)
      .sort((a, b) => a.round - b.round || a.matchOrder - b.matchOrder);

    if (playable.length === 0) return played;

    for (const match of playable) {
      const after = await complete(api, match.id, options.winner?.(match) ?? 'HOME');
      played.push({ before: match, after });
    }
  }

  throw new Error(`playThrough(${tournamentId}): bracket never resolved`);
}

/** Give an existing team's players a real user, so `/api/me/queue` can find them. */
export async function assignTeamToUser(teamId: string, userId: string) {
  await prisma.player.updateMany({ where: { teamId }, data: { userId } });
}
/* ------------------------------------------------------------------------------------------- *
 * Inbound-integration fixtures (EON bridge, CS2 plugin, Discord mock, audit trail).
 * ------------------------------------------------------------------------------------------- */

let steamCounter = 0;
/** A fresh, collision-free steamid64-shaped id — the EON webhook matches rosters on these. */
export function nextSteamId(): string {
  steamCounter += 1;
  return `7656119${String(Date.now() % 1_000_000).padStart(6, '0')}${String(steamCounter).padStart(4, '0')}`;
}

/** A bridge token shaped like the one `POST /api/tournaments/{id}/eon-bridge` mints. */
export function fakeBridgeToken(): string {
  return `eon_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

export interface BridgedMatchOptions {
  /** Series length of the seeded match (1 = BO1, so the headline score is rounds). */
  bestOf?: number;
  /** Players per side; the EON frame carries exactly these steamids. */
  rosterSize?: number;
  /** Pre-minted bridge token; pass null for a tournament whose bridge is switched off. */
  token?: string | null;
  status?: string;
  homeName?: string;
  awayName?: string;
}

/**
 * A tournament with an enabled EON bridge and one live-able match whose two rosters carry
 * steamIds — the fixture the EON webhook is designed for: it identifies the match, and which
 * Summit team is currently CT, purely from the steamids seen on the game server.
 */
export async function createBridgedMatch(options: BridgedMatchOptions = {}) {
  const rosterSize = options.rosterSize ?? 2;
  const token = options.token === undefined ? fakeBridgeToken() : options.token;
  const tournament = await createTournament({
    name: uniqueName('EON Cup'),
    teamSize: rosterSize,
    eonBridgeToken: token,
  });

  const homeSteamIds = Array.from({ length: rosterSize }, () => nextSteamId());
  const awaySteamIds = Array.from({ length: rosterSize }, () => nextSteamId());

  const home = await createTeam(tournament.id, {
    name: options.homeName ?? 'Home Crew',
    seed: 1,
    players: homeSteamIds.map((steamId, i) => ({
      name: `Home ${i + 1}`,
      steamId,
      seating: `A0${i + 1}`,
      isLeader: i === 0,
    })),
  });
  const away = await createTeam(tournament.id, {
    name: options.awayName ?? 'Away Crew',
    seed: 2,
    players: awaySteamIds.map((steamId, i) => ({
      name: `Away ${i + 1}`,
      steamId,
      seating: `B0${i + 1}`,
      isLeader: i === 0,
    })),
  });

  const bestOf = options.bestOf ?? 1;
  const match = await prisma.match.create({
    data: {
      tournamentId: tournament.id,
      homeTeamId: home.id,
      awayTeamId: away.id,
      round: 1,
      matchOrder: 0,
      bestOf,
      scoreLimit: Math.floor(bestOf / 2) + 1,
      status: options.status ?? 'PENDING',
      serverIp: '10.0.0.5',
      serverPort: '27015',
      serverPassword: 'lan-secret',
      bracketType: 'WINNERS',
    },
  });

  return { tournament, token, home, away, match, homeSteamIds, awaySteamIds };
}

/** A second match in an existing tournament, so "which match is this frame about?" is testable. */
export async function addMatch(
  tournamentId: string,
  options: { homeTeamId: string; awayTeamId: string; matchOrder?: number; status?: string; bestOf?: number }
) {
  return prisma.match.create({
    data: {
      tournamentId,
      homeTeamId: options.homeTeamId,
      awayTeamId: options.awayTeamId,
      round: 1,
      matchOrder: options.matchOrder ?? 1,
      bestOf: options.bestOf ?? 1,
      scoreLimit: 1,
      status: options.status ?? 'PENDING',
      bracketType: 'WINNERS',
    },
  });
}

// readTournament / readTeam live in the organizer-UI block below (superset: rosters included).

/** The in-app announcement feed rows for a tournament (what the Discord mock path writes). */
export async function readNotifications(tournamentId: string) {
  return prisma.notificationLog.findMany({ where: { tournamentId }, orderBy: { createdAt: 'asc' } });
}

/** The audit trail rows for a tournament, oldest first. */
export async function readAuditRows(tournamentId: string) {
  return prisma.auditLog.findMany({ where: { tournamentId }, orderBy: { createdAt: 'asc' } });
}

/**
 * Hands an existing seeded team to a real persona: every player row on it becomes that user's.
 * Used after `generate`, so a spec can pick the team in a *known* bracket slot (round-1 match 3,
 * say) and only then decide which persona is sitting in it.
 */
export async function attachUserToTeam(teamId: string, userId: string) {
  await prisma.player.updateMany({ where: { teamId }, data: { userId } });
  return prisma.team.findUnique({ where: { id: teamId }, include: { players: true } });
}

/**
 * Writes a match status straight to the database, bypassing the routes.
 *
 * Only for states the API deliberately refuses to create: `POST /api/matches/{id}/load` will not
 * call a match with an empty team slot, but GET /api/me/queue promises to count such a match as
 * "ahead of you" once it is called/live, and that promise needs a fixture.
 */
export async function setMatchStatus(matchId: string, status: string) {
  return prisma.match.update({ where: { id: matchId }, data: { status } });
}

/** Every push subscription belonging to a user (newest first). */
export async function readPushSubscriptions(userId: string) {
  return prisma.pushSubscription.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
}

/** Drops a user's push subscriptions, so a spec starts from "alerts off". */
export async function clearPushSubscriptions(userId: string) {
  await prisma.pushSubscription.deleteMany({ where: { userId } });
}

/**
 * Un-registers a user everywhere: every Player row of theirs is deleted, so the next test
 * starts from "this player is in nothing".
 *
 * Only Player rows go — `User` survives, which is what keeps already-minted session tokens
 * valid (see the note at the top of this file). Use it in specs that assert an *absence* on the
 * player desk ("no match assigned", no queue section), since those are otherwise at the mercy
 * of tournaments an earlier test signed the same persona up for.
 */
export async function clearRegistrations(userId: string) {
  await prisma.player.deleteMany({ where: { userId } });
}

// ---------------------------------------------------------------------------
// Public/spectator fixtures (used by the `public-*` specs)
//
// The public surfaces (tournament page, OBS overlay, roster board) only ever *read*, so what
// they need is a tournament that already looks like a LAN in progress: a generated bracket,
// a couple of played matches with real advancement, and one match on the floor right now.
// Generation and scoring go through the admin API rather than raw Prisma writes so the fixture
// is wired exactly the way the product wires it (nextMatchSlot, winnerId, loser drops).
// ---------------------------------------------------------------------------

/** Generate the bracket for `tournamentId` as the organizer, exactly as staff would. */
export async function generateBracketAsAdmin(tournamentId: string) {
  const { apiAs } = await import('./api');
  const api = await apiAs('marcus');
  const res = await api.post(`/api/tournaments/${tournamentId}/generate`, { data: {} });
  if (res.status() !== 200) {
    throw new Error(`generateBracketAsAdmin(${tournamentId}): ${res.status()} ${await res.text()}`);
  }
  return readMatches(tournamentId);
}

/** Report a final score for a match as the organizer (real advancement + SSE broadcast). */
export async function scoreMatchAsAdmin(matchId: string, homeScore: number, awayScore: number) {
  const { apiAs } = await import('./api');
  const api = await apiAs('marcus');
  const res = await api.post(`/api/matches/${matchId}`, { data: { homeScore, awayScore } });
  if (res.status() !== 200) {
    throw new Error(`scoreMatchAsAdmin(${matchId}): ${res.status()} ${await res.text()}`);
  }
  return res;
}

/** Put a match on the floor (status LIVE) without going through the call/load flow. */
export async function setMatchLive(matchId: string) {
  return prisma.match.update({ where: { id: matchId }, data: { status: 'LIVE' } });
}

export interface PlayedBracketOptions {
  name?: string;
  teams?: number;
  format?: 'SINGLE_ELIMINATION' | 'DOUBLE_ELIMINATION';
  /** How many round-1 matches to play out (home wins 1:0). */
  completed?: number;
  /** Mark the round-1 match right after the completed ones LIVE (default: yes). */
  live?: boolean;
}

/**
 * A tournament a spectator can actually look at: seeded teams, a generated bracket, the first
 * `completed` round-1 matches played (home side wins 1:0) and optionally the next one LIVE.
 */
export async function seedPlayedBracket(options: PlayedBracketOptions = {}) {
  const teamCount = options.teams ?? 8;
  const completed = options.completed ?? 2;
  const tournament = await createTournament({
    name: options.name ?? uniqueName(options.format === 'DOUBLE_ELIMINATION' ? 'DE Showcase' : 'SE Showcase'),
    teamSize: 1,
    format: options.format ?? 'SINGLE_ELIMINATION',
  });
  const teams = await createSeededTeams(tournament.id, teamCount);
  const generated = await generateBracketAsAdmin(tournament.id);

  const roundOne = generated
    .filter((m) => m.round === 1 && m.bracketType === 'WINNERS' && m.homeTeamId && m.awayTeamId)
    .sort((a, b) => a.matchOrder - b.matchOrder);

  const played = roundOne.slice(0, completed);
  for (const match of played) {
    await scoreMatchAsAdmin(match.id, 1, 0);
  }

  let liveMatch: Awaited<ReturnType<typeof setMatchLive>> | null = null;
  if (options.live !== false && roundOne.length > completed) {
    liveMatch = await setMatchLive(roundOne[completed].id);
  }

  return {
    tournament,
    tournamentId: tournament.id,
    teams,
    playedMatches: played,
    liveMatch,
    matches: await readMatches(tournament.id),
  };
}

/**
 * Plant recognisable secrets on a tournament's teams/players/matches so a leak test can grep
 * for a literal instead of trusting a field name. Returns every string that must never reach a
 * spectator's browser.
 */
export async function plantTeamSecrets(tournamentId: string) {
  const teams = await prisma.team.findMany({ where: { tournamentId }, include: { players: true } });
  const secrets: string[] = [];

  for (const [index, team] of teams.entries()) {
    const inviteCode = `LEAKCANARY-INVITE-${index}-${team.id.slice(0, 6)}`;
    await prisma.team.update({ where: { id: team.id }, data: { inviteCode } });
    secrets.push(inviteCode);

    for (const [playerIndex, player] of team.players.entries()) {
      const steamId = `7656119855500${index}${playerIndex}`;
      await prisma.player.update({ where: { id: player.id }, data: { steamId } });
      secrets.push(steamId);
    }
  }

  // Server credentials live on matches; staff see them, spectators must not.
  const serverPassword = `LEAKCANARY-SRVPASS-${tournamentId.slice(0, 6)}`;
  await prisma.match.updateMany({
    where: { tournamentId },
    data: { serverIp: '10.0.0.9', serverPort: '27099', serverPassword },
  });
  secrets.push(serverPassword);

  return secrets;
}

/** `count` teams, each with `perTeam` seated players — the roster board's real shape. */
export async function createRosterTeams(tournamentId: string, count: number, perTeam = 2) {
  const teams = [];
  for (let seed = 1; seed <= count; seed++) {
    teams.push(
      await createTeam(tournamentId, {
        name: `Roster Squad ${seed}`,
        seed,
        players: Array.from({ length: perTeam }, (_, i) => ({
          name: `Roster Player ${seed}-${i + 1}`,
          seating: `R${String(seed).padStart(2, '0')}-${i + 1}`,
          isLeader: i === 0,
        })),
      })
    );
  }
  return teams;
}
// --- Organizer-UI helpers (appended for the e2e/organizer-*.spec.ts suites) -------------------
// Those specs drive the organizer's browser and then read the stored truth back, so what they
// need here are plain row readers rather than more fixtures.

/** The stored tournament row — the truth the settings UI claims it saved. */
export async function readTournament(id: string) {
  const tournament = await prisma.tournament.findUnique({ where: { id } });
  if (!tournament) throw new Error(`readTournament(${id}): no such tournament`);
  return tournament;
}

/** A tournament created through the UI, looked up by the name the test typed (null until saved). */
export async function findTournamentByName(name: string) {
  return prisma.tournament.findFirst({ where: { name } });
}

/**
 * Every team of a tournament with its roster attached, teams in seed order and players by name
 * (`Player` has no creation stamp, so name is the only stable ordering to assert against).
 */
export async function readTeams(tournamentId: string) {
  return prisma.team.findMany({
    where: { tournamentId },
    orderBy: { seed: 'asc' },
    include: { players: { orderBy: { name: 'asc' } } },
  });
}

/** One team with its roster (players by name), or null once the organizer has removed it. */
export async function readTeam(teamId: string) {
  return prisma.team.findUnique({
    where: { id: teamId },
    include: { players: { orderBy: { name: 'asc' } } },
  });
}

// ---------------------------------------------------------------------------
// Discord-reach fixtures (organizer reach panel).
//
// The panel's whole point is that a `DiscordLink` is an address and a `DiscordDmAttempt` is
// evidence, so the fixtures have to be able to produce those two independently: a player who is
// linked but never proven, and a player Discord refused, are different states with different
// remedies and must be seedable apart from one another.
// ---------------------------------------------------------------------------

let discordCounter = 0;

/** A bare `User` row — the thing a `Player.userId` and a `DiscordLink` both hang off. */
export async function createUserRow(name: string) {
  discordCounter += 1;
  const suffix = `${Date.now().toString(36)}-${discordCounter}`;
  return prisma.user.create({
    data: { name, email: `mock+reach-${suffix}@summit.local`, steamId: nextSteamId() },
  });
}

export interface DiscordLinkOptions {
  /** The snowflake. Tests assert this string never reaches any payload. */
  discordId?: string;
  discordUsername?: string;
  /** UNKNOWN | SENT | BLOCKED — the cached state, deliberately settable without an attempt. */
  dmState?: string;
  /**
   * When the cache was last rewritten. Settable on its own so a test can build the nasty case:
   * a fresh refusal in the cache sitting on top of an older accepted attempt.
   */
  dmCheckedAt?: Date;
  optOut?: boolean;
}

/** Link a user to Discord. Returns the row, whose `discordId` is the leak canary. */
export async function linkDiscord(userId: string, options: DiscordLinkOptions = {}) {
  discordCounter += 1;
  return prisma.discordLink.create({
    data: {
      userId,
      discordId: options.discordId ?? `9911${Date.now()}${discordCounter}`,
      discordUsername: options.discordUsername ?? `player_${discordCounter}`,
      dmState: options.dmState ?? 'UNKNOWN',
      dmCheckedAt: options.dmCheckedAt ?? null,
      optOut: options.optOut ?? false,
    },
  });
}

export interface DmAttemptOptions {
  event?: string;
  matchId?: string | null;
  /**
   * SENT | BLOCKED | UNKNOWN_USER | RATE_LIMITED | ERROR | SKIPPED_OPTOUT | SIMULATED.
   * SIMULATED is what a deployment that cannot talk to Discord writes — a row that proves a
   * send was *not* made, which the panel must never count.
   */
  outcome: string;
  discordCode?: number | null;
  locale?: string;
  /** Back-date the evidence, to test which of two facts is the newer one. */
  createdAt?: Date;
}

/** One row of proof (or of refusal) that Discord answered about this user. */
export async function recordDmAttempt(userId: string, discordId: string, options: DmAttemptOptions) {
  return prisma.discordDmAttempt.create({
    data: {
      userId,
      discordId,
      event: options.event ?? 'LINK_PROBE',
      matchId: options.matchId ?? null,
      outcome: options.outcome,
      discordCode: options.discordCode ?? null,
      locale: options.locale ?? 'nb',
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    },
  });
}
