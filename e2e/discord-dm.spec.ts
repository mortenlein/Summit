import fs from 'fs';
import path from 'path';
import { expect, test } from '@playwright/test';
import { apiAs, disposeApiContexts, json } from './helpers/api';
import {
  clearDiscordLink,
  createCallableMatch,
  linkDiscord,
  prisma,
  readDiscordLink,
  readDmAttempts,
  readMatches,
  readNotifications,
  seedAndGenerate,
  setDiscordDmPaused,
  complete,
} from './helpers/lan-seed';
import { mintSessionToken, personaUserId } from './helpers/auth';

/**
 * Discord DMs — the channel that actually reaches these players. They are 12–15, they are at
 * their PCs with Discord open, and the phone in their pocket is not the thing to aim at.
 *
 * There is no bot token in a test run (and none on the box yet), so `src/lib/discord-dm.ts`
 * takes its mock transport. Everything else is the production path: the same recipient
 * resolution, the same `DiscordDmAttempt` rows, the same per-locale composition, the same error
 * table. The two files below are how a spec can see inside a message that, in production,
 * exists nowhere but on a kid's phone:
 *
 *   DISCORD_DM_LOG      — one JSON line per attempt: what would have been sent, and the outcome.
 *   DISCORD_DM_SIMULATE — what Discord should answer, keyed by discord id. This is the only way
 *                         to exercise 50007 ("this kid has DMs from server members switched
 *                         off") without a real account that has them switched off.
 *
 * Both mirror playwright.config.ts, hardcoded for the same reason helpers/auth.ts hardcodes its
 * values: process.env is not reliably propagated into Playwright worker processes.
 */
const DM_LOG = path.resolve(process.cwd(), 'prisma', `e2e-${process.env.E2E_PORT || '4101'}-dm.log`);
const DM_SIM = path.resolve(process.cwd(), 'prisma', `e2e-${process.env.E2E_PORT || '4101'}-dm-sim.json`);

interface DmAttemptLine {
  event: string;
  matchId: string | null;
  userId: string;
  discordId: string;
  locale: string;
  outcome: string;
  discordCode?: number;
  content: string;
}

function resetDmLog() {
  fs.writeFileSync(DM_LOG, '');
}

function dmLines(): DmAttemptLine[] {
  if (!fs.existsSync(DM_LOG)) return [];
  return fs
    .readFileSync(DM_LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DmAttemptLine);
}

/**
 * The attempt rows for a match that have reached a final outcome.
 *
 * The row is claimed *before* the send (it is the double-send guard), so it exists as `PENDING`
 * for as long as the send takes. Polling on row count alone would read a fan-out mid-flight;
 * polling on settled rows is polling on "the fan-out is done".
 */
const settled = async (matchId: string) =>
  (await readDmAttempts(matchId)).filter((row) => row.outcome !== 'PENDING');

/** Arm a Discord failure for one account. `{}` clears every armed failure. */
function simulate(rules: Record<string, { status: number; code?: number; retryAfterMs?: number }>) {
  fs.writeFileSync(DM_SIM, JSON.stringify(rules));
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(() => {
  resetDmLog();
  simulate({});
});

test.afterEach(async () => {
  simulate({});
  await disposeApiContexts();
});

/** Leo (home) and Sam (away), both linked, on one callable match. */
async function linkedMatch(options: { leo?: Parameters<typeof linkDiscord>[1]; sam?: Parameters<typeof linkDiscord>[1] } = {}) {
  await mintSessionToken('leo');
  await mintSessionToken('sam');
  const leoUserId = await personaUserId('leo');
  const samUserId = await personaUserId('sam');
  await clearDiscordLink(leoUserId);
  await clearDiscordLink(samUserId);
  const leoLink = await linkDiscord(leoUserId, options.leo);
  const samLink = await linkDiscord(samUserId, options.sam);
  const seeded = await createCallableMatch({ homeUserId: leoUserId, awayUserId: samUserId });
  return { ...seeded, leoUserId, samUserId, leoLink, samLink };
}

test('calling a match DMs both rosters once, and a second tap sends nothing more', async () => {
  const { match, leoUserId, samUserId } = await linkedMatch();
  const mia = await apiAs('mia');

  expect((await mia.post(`/api/matches/${match.id}/load`)).status()).toBe(200);
  await expect.poll(async () => (await settled(match.id)).length).toBe(2);

  const first = await readDmAttempts(match.id);
  expect(first.map((row) => [row.userId, row.event, row.outcome]).sort()).toEqual(
    [
      [leoUserId, 'MATCH_CALLED', 'SENT'],
      [samUserId, 'MATCH_CALLED', 'SENT'],
    ].sort()
  );
  expect(dmLines()).toHaveLength(2);

  // A marshal double-tapping "Call match" in a loud room is the normal case, not the edge one.
  // `@@unique([matchId, event, userId])` is claimed before the send, so the second fan-out
  // finds the slot taken and puts nothing on either kid's phone.
  expect((await mia.post(`/api/matches/${match.id}/load`)).status()).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(await readDmAttempts(match.id)).toHaveLength(2);
  expect(dmLines()).toHaveLength(2);
});

test('an opted-out player is recorded as skipped and is never written to', async () => {
  const { match, leoUserId, samUserId, samLink } = await linkedMatch({ sam: { optOut: true } });
  const mia = await apiAs('mia');

  expect((await mia.post(`/api/matches/${match.id}/load`)).status()).toBe(200);
  await expect.poll(async () => (await settled(match.id)).length).toBe(2);

  const rows = await readDmAttempts(match.id);
  expect(rows.find((r) => r.userId === leoUserId)!.outcome).toBe('SENT');
  // Recorded, not silently dropped: "we chose not to write to this player" and "this player
  // never linked" have different remedies on the organizer's reach panel.
  expect(rows.find((r) => r.userId === samUserId)!.outcome).toBe('SKIPPED_OPTOUT');

  // …and nothing was actually sent to them.
  const sentTo = dmLines().map((line) => line.discordId);
  expect(sentTo).toHaveLength(1);
  expect(sentTo).not.toContain(samLink.discordId);
});

test('a paused tournament sends no DMs at all, while push and the channel post still go out', async () => {
  const { tournament, match } = await linkedMatch();
  await setDiscordDmPaused(tournament.id, true);
  const mia = await apiAs('mia');

  expect((await mia.post(`/api/matches/${match.id}/load`)).status()).toBe(200);
  await expect
    .poll(async () => (await readNotifications(tournament.id)).length)
    .toBeGreaterThanOrEqual(1);

  // The kill switch stops DMs and only DMs — the channel announcement (which the crew reads)
  // is untouched, and so is the in-app feed it writes.
  expect(await readDmAttempts(match.id)).toHaveLength(0);
  expect(dmLines()).toHaveLength(0);
  expect((await readNotifications(tournament.id)).map((row) => row.title)).toEqual([
    'Match ready for players',
  ]);
});

test('a 50007 is recorded as BLOCKED, once, and is never retried', async () => {
  const { match, samUserId, samLink } = await linkedMatch();
  // Sam has "direct messages from server members" switched off. Discord answers 403/50007 and
  // will answer it every time; retrying it across a roster is the documented path to an
  // hour-long IP ban.
  simulate({ [samLink.discordId]: { status: 403, code: 50007 } });

  const mia = await apiAs('mia');
  expect((await mia.post(`/api/matches/${match.id}/load`)).status()).toBe(200);
  await expect.poll(async () => (await settled(match.id)).length).toBe(2);

  const blocked = (await readDmAttempts(match.id)).find((row) => row.userId === samUserId)!;
  expect(blocked.outcome).toBe('BLOCKED');
  expect(blocked.discordCode).toBe(50007);

  // Exactly one attempt on the wire for Sam — no retry, no second row.
  expect(dmLines().filter((line) => line.discordId === samLink.discordId)).toHaveLength(1);

  // The link now carries the refusal, so the reach panel can show the organizer a remedy
  // instead of a claim. `dmState` is rewritten by every send, not just at link time.
  const link = await readDiscordLink(samUserId);
  expect(link!.dmState).toBe('BLOCKED');
  expect(link!.dmCheckedAt).toBeTruthy();

  // And a later call skips them entirely rather than earning another 403.
  resetDmLog();
  const { match: second } = await createCallableMatch({ awayUserId: samUserId });
  expect((await mia.post(`/api/matches/${second.id}/load`)).status()).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(dmLines().filter((line) => line.discordId === samLink.discordId)).toHaveLength(0);
});

test('a 429 waits out Discord’s own retry_after and ends as RATE_LIMITED, not as SENT', async () => {
  const { match, samUserId, samLink } = await linkedMatch();
  // Discord asks for 400 ms. We honour the number in the body — never a backoff of our own —
  // and we try twice more. A 429 is not the player's fault, so it does not consume the send
  // budget the way a 50007 does; when it still will not clear, the row says so.
  simulate({ [samLink.discordId]: { status: 429, retryAfterMs: 400 } });

  const mia = await apiAs('mia');
  const startedAt = Date.now();
  expect((await mia.post(`/api/matches/${match.id}/load`)).status()).toBe(200);
  await expect.poll(async () => (await settled(match.id)).length, { timeout: 30_000 }).toBe(2);

  const row = (await readDmAttempts(match.id)).find((r) => r.userId === samUserId)!;
  expect(row.outcome).toBe('RATE_LIMITED');
  // Two retries at 400 ms each, at minimum — proof the wait came from the body and not from a
  // tight loop that would have earned the token an hour-long ban.
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(800);

  // A rate limit says nothing about whether this kid can be DM'd, so the link is left alone
  // rather than marked BLOCKED and skipped for the rest of the evening.
  expect((await readDiscordLink(samUserId))!.dmState).not.toBe('BLOCKED');
});

/**
 * The mixed-language regression, in the one place it matters most.
 *
 * Two kids on one match, one Norwegian and one English, and the request that triggered the
 * fan-out belongs to a marshal pinned to a third context entirely. Both the lead sentence and
 * the `{stage}` inside the body have to be resolved in the *recipient's* language — resolving
 * the stage once, outside the group, is how an English player ends up reading
 * "Seat C01 — go there now · Kvartfinale".
 */
test('each player is DM’d in their own language, stage word included', async () => {
  const { match, leoUserId, samUserId, leoLink, samLink, tournament } = await linkedMatch();
  await prisma.user.update({ where: { id: leoUserId }, data: { locale: 'nb' } });
  await prisma.user.update({ where: { id: samUserId }, data: { locale: 'en' } });

  const mia = await apiAs('mia');
  expect((await mia.post(`/api/matches/${match.id}/load`)).status()).toBe(200);
  await expect.poll(() => dmLines().length).toBe(2);

  const toLeo = dmLines().find((line) => line.discordId === leoLink.discordId)!;
  const toSam = dmLines().find((line) => line.discordId === samLink.discordId)!;

  // Seat first, in their own language, and their OWN seat — Leo sits at A12, Sam at C01.
  expect(toLeo.locale).toBe('nb');
  expect(toLeo.content).toContain('Plass A12 — gå dit nå. Det er din tur.');
  expect(toLeo.content).toContain('Crewet kommer og henter deg hvis du ikke er på plass.');
  expect(toSam.locale).toBe('en');
  expect(toSam.content).toContain("Seat C01 — go there now. You're up.");
  expect(toSam.content).toContain("The crew will come find you if you're not at your seat.");

  // The stage word is resolved inside each group, not once for the match — this is the exact
  // line where an English player used to read a Norwegian round name.
  expect(toLeo.content).toContain('Finale');
  expect(toLeo.content).not.toContain('Grand Final');
  expect(toSam.content).toContain('Grand Final');

  // Both name the same match and the same tournament, and neither carries a seat that is not
  // the recipient's own.
  expect(toLeo.content).toContain(tournament.name);
  expect(toSam.content).toContain(tournament.name);
  expect(toLeo.content).not.toContain('C01');
  expect(toSam.content).not.toContain('A12');

  await prisma.user.update({ where: { id: leoUserId }, data: { locale: null } });
  await prisma.user.update({ where: { id: samUserId }, data: { locale: null } });
});

test('a DM never carries the server credentials, and a team called @everyone cannot ping', async () => {
  const { match, home } = await linkedMatch();
  await prisma.team.update({ where: { id: home.id }, data: { name: '@everyone **pwn**' } });
  await prisma.match.update({
    where: { id: match.id },
    data: { serverIp: '10.0.0.9', serverPort: '27099', serverPassword: 'LEAKCANARY-SRVPASS' },
  });

  const mia = await apiAs('mia');
  expect((await mia.post(`/api/matches/${match.id}/load`)).status()).toBe(200);
  await expect.poll(() => dmLines().length).toBe(2);

  for (const line of dmLines()) {
    // A DM is forwardable and we cannot verify who is holding the phone. The link goes to
    // Summit, which knows who is asking; the connect string does not travel.
    expect(line.content).not.toContain('LEAKCANARY-SRVPASS');
    expect(line.content).not.toContain('27099');
    expect(line.content).not.toContain('steam://');
    // Kids will name a team `@everyone`. The `@` is stripped and the markup escaped before the
    // name reaches a message body (`allowed_mentions: { parse: [] }` is the second lock).
    expect(line.content).not.toContain('@everyone');
    expect(line.content).toContain('everyone');
    expect(line.content).toContain('\\*\\*pwn\\*\\*');
  }
});

test('going live does not re-DM a match that was already called', async () => {
  const { match } = await linkedMatch();
  const mia = await apiAs('mia');

  expect((await mia.post(`/api/matches/${match.id}/load`)).status()).toBe(200);
  await expect.poll(async () => (await settled(match.id)).length).toBe(2);
  resetDmLog();

  // The kids walked over thirty seconds ago. A second buzz tells them nothing, and the channel
  // post carries the state change for everyone else. (§7)
  expect((await mia.post(`/api/matches/${match.id}`, { data: { status: 'LIVE' } })).status()).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(dmLines()).toHaveLength(0);
  expect((await readDmAttempts(match.id)).filter((row) => row.event === 'MATCH_LIVE')).toHaveLength(0);
});

test('a match that goes live without ever being called does DM its rosters', async () => {
  const { match, leoUserId } = await linkedMatch();
  const mia = await apiAs('mia');

  // Straight to LIVE — the CS2 webhook path, where nobody pressed "Call match" first.
  expect((await mia.post(`/api/matches/${match.id}`, { data: { status: 'LIVE' } })).status()).toBe(200);
  await expect.poll(async () => (await settled(match.id)).length).toBe(2);

  const rows = await readDmAttempts(match.id);
  expect(rows.every((row) => row.event === 'MATCH_LIVE')).toBe(true);
  expect(rows.find((row) => row.userId === leoUserId)!.outcome).toBe('SENT');
  expect(dmLines()[0].content).toContain('kampen din er live nå');
});

/**
 * Owner ask #1: "up next".
 *
 * Fires for the one match at the front of the running order — both teams known, not yet called,
 * first under `byPlayOrder` — at most once per match, ever. The guard is the NotificationLog
 * row, so it survives a restart, and the copy is grey and DM-free: this is information, not an
 * instruction to walk.
 */
test('up next announces the front of the running order, once per match, never a TBD slot', async () => {
  const marcus = await apiAs('marcus');
  const { tournamentId, teams } = await seedAndGenerate(marcus, { teams: 4, teamSize: 1 });
  const matches = await readMatches(tournamentId);
  const roundOne = matches.filter((m) => m.round === 1).sort((a, b) => a.matchOrder - b.matchOrder);
  const final = matches.find((m) => m.round === 2)!;
  const teamName = (id: string | null) => teams.find((t) => t.id === id)!.name;

  const titles = async () => (await readNotifications(tournamentId)).map((row) => row.title);
  const upNext = async () => (await readNotifications(tournamentId)).filter((r) => r.title === 'Up next');

  // Generation posts the bracket summary and nothing per match: the final's slots are both TBD,
  // and "TBD vs TBD is up next" is worse than silence.
  expect(await titles()).toEqual(['Bracket is live']);

  // First result: the other round-1 match is now the front of the order. The final has one team
  // and is still TBD on the other side, so it is not a candidate.
  await complete(marcus, roundOne[0].id, 'HOME');
  await expect.poll(async () => (await upNext()).length).toBe(1);
  expect((await upNext())[0].description).toContain(teamName(roundOne[1].homeTeamId));
  expect((await upNext())[0].description).toContain(teamName(roundOne[1].awayTeamId));
  expect((await upNext())[0].description).toContain('Semi-Finals');

  // Second result: the final has both teams and is now the front. The first up-next post is not
  // repeated, and the new one names the finalists.
  await complete(marcus, roundOne[1].id, 'HOME');
  await expect.poll(async () => (await upNext()).length).toBe(2);
  expect((await upNext())[1].description).toContain(teamName(roundOne[0].homeTeamId));
  expect((await upNext())[1].description).toContain(teamName(roundOne[1].homeTeamId));
  expect((await upNext())[1].description).toContain('Grand Final');

  // Re-posting an already-final score must not put the same match on the channel twice — that
  // is what teaches a room to ignore up-next posts.
  expect((await marcus.post(`/api/matches/${roundOne[1].id}`, { data: { homeScore: 1, awayScore: 0 } })).status()).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(await upNext()).toHaveLength(2);

  // Calling the final does not make it "up next" again either — it is happening now.
  const loaded = await marcus.post(`/api/matches/${final.id}/load`);
  expect(loaded.status()).toBe(200);
  expect((await json(loaded)).match.status).toBe('READY');
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(await upNext()).toHaveLength(2);
  expect(await titles()).toContain('Match ready for players');
});
