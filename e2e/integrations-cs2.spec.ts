import { expect, test } from '@playwright/test';
import { apiAnon, disposeApiContexts, json } from './helpers/api';
import {
  addMatch,
  createBridgedMatch,
  createTeam,
  prisma,
  readMatch,
  readNotifications,
  readTeam,
} from './helpers/lan-seed';

/**
 * The CS2 server plugin's webhook (`/api/webhooks/cs2`) — the other inbound score channel.
 *
 * It authenticates with a single shared bearer key from `CS2_WEBHOOK_KEY` and fails *closed*
 * when that env var is missing (503 "Webhook not configured"). `playwright.config.ts` does not
 * set the key, so the authenticated paths only run when the key is in the environment — which
 * it usually is, because whatever `.env` the Prisma client loads is visible to both the test
 * workers and the dev server (the config spreads `process.env` into the server's env). Failing
 * that, pass it on the command line:
 *
 *   E2E_PORT=4106 CS2_WEBHOOK_KEY=e2e-cs2-key npx playwright test e2e/integrations-cs2.spec.ts
 *
 * With no key at all the authenticated tests skip themselves and only the fail-closed test runs,
 * which is why every one of them reads the key from the same place the server does.
 *
 * Payloads mirror `scripts/test-cs2-webhook.js`: `{ event, matchId, team1, team2 }`.
 */
test.describe.configure({ mode: 'serial' });
test.afterEach(disposeApiContexts);

const CS2_KEY = process.env.CS2_WEBHOOK_KEY?.trim() || '';
const NO_KEY_REASON =
  'CS2_WEBHOOK_KEY is not set for this run (playwright.config.ts does not set it); ' +
  'rerun with CS2_WEBHOOK_KEY=<key> to exercise the authenticated webhook paths';

async function postEvent(payload: Record<string, unknown>, options: { key?: string | null } = {}) {
  const key = options.key === undefined ? CS2_KEY : options.key;
  const api = await apiAnon();
  return api.post('/api/webhooks/cs2', {
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    data: payload as any,
  });
}

test('the webhook refuses an unauthenticated call and changes nothing', async () => {
  const { match } = await createBridgedMatch();

  const res = await postEvent({ event: 'match_live', matchId: match.id }, { key: null });
  if (CS2_KEY) {
    // Configured: a caller with no (or a wrong) bearer token is unauthorized.
    expect(res.status()).toBe(401);
    expect((await json(res)).error).toBe('Unauthorized');
    const wrongKey = await postEvent({ event: 'match_live', matchId: match.id }, { key: 'not-the-key' });
    expect(wrongKey.status()).toBe(401);
  } else {
    // Unconfigured: fail closed rather than leaving the door open.
    expect(res.status()).toBe(503);
    expect((await json(res)).error).toBe('Webhook not configured');
    const anyKey = await postEvent({ event: 'match_live', matchId: match.id }, { key: 'anything' });
    expect(anyKey.status()).toBe(503);
  }

  expect((await readMatch(match.id)).status).toBe('PENDING');
});

test('match_live puts the referenced match live and calls both rosters', async () => {
  test.skip(!CS2_KEY, NO_KEY_REASON);
  const { tournament, match, home, away } = await createBridgedMatch();

  const res = await postEvent({
    event: 'match_live',
    matchId: match.id,
    team1: { name: home.name, score: 0, seriesScore: 0 },
    team2: { name: away.name, score: 0, seriesScore: 0 },
  });
  expect(res.status()).toBe(200);
  expect(await json(res)).toEqual({ success: true });

  expect((await readMatch(match.id)).status).toBe('LIVE');
  // Going live from the server also calls both rosters through the normal notify path — with
  // the *live* wording, not the call-up's. A match that is already being played is the one
  // thing "Match ready for players" is not.
  expect((await readNotifications(tournament.id)).map((row) => [row.type, row.title])).toEqual([
    ['MATCH', 'Match is live'],
  ]);
});

test('round_end scores go into the map they belong to', async () => {
  test.skip(!CS2_KEY, NO_KEY_REASON);
  const { match, home, away } = await createBridgedMatch({ bestOf: 3 });

  await postEvent({
    event: 'round_end',
    matchId: match.id,
    mapNumber: 1,
    team1: { name: home.name, score: 8 },
    team2: { name: away.name, score: 5 },
  });

  const updated = await readMatch(match.id);
  expect(updated.status).toBe('LIVE');
  expect(JSON.parse(updated.mapScores)).toEqual([
    { map: '', home: 0, away: 0 },
    { map: '', home: 8, away: 5 },
  ]);
  // Round scores are per-map detail; the BO3 headline score is still the series (0-0).
  expect(updated.homeScore).toBe(0);
  expect(updated.awayScore).toBe(0);
});

test('match_end completes the match and advances the winner', async () => {
  test.skip(!CS2_KEY, NO_KEY_REASON);
  const { tournament, match, home, away } = await createBridgedMatch({ bestOf: 3 });
  const final = await addMatch(tournament.id, {
    homeTeamId: home.id,
    awayTeamId: away.id,
    matchOrder: 9,
  });
  // Wire round 1 into the final's HOME slot, the way the generator does.
  await prisma.match.update({ where: { id: final.id }, data: { homeTeamId: null, awayTeamId: null } });
  await prisma.match.update({
    where: { id: match.id },
    data: { nextMatchId: final.id, nextMatchSlot: 'HOME' },
  });

  const res = await postEvent({
    event: 'match_end',
    matchId: match.id,
    winner: 'team2',
    team1: { name: home.name, score: 10, seriesScore: 0 },
    team2: { name: away.name, score: 13, seriesScore: 2 },
  });
  expect(res.status()).toBe(200);

  const completed = await readMatch(match.id);
  expect(completed.status).toBe('COMPLETED');
  expect(completed.homeScore).toBe(0);
  expect(completed.awayScore).toBe(2);
  expect(completed.winnerId).toBe(away.id);

  expect((await readMatch(final.id)).homeTeamId).toBe(away.id);
});

test('an event the route cannot place is accepted but touches nothing', async () => {
  test.skip(!CS2_KEY, NO_KEY_REASON);
  const { match, home, away } = await createBridgedMatch();

  // No matchId and no tournamentId: nothing to resolve against.
  const orphan = await postEvent({
    event: 'match_end',
    winner: 'team1',
    team1: { name: home.name, score: 13, seriesScore: 1 },
    team2: { name: away.name, score: 4, seriesScore: 0 },
  });
  // The plugin is never told off (rollout safety), but the event is dropped.
  expect(orphan.status()).toBe(200);
  expect(await json(orphan)).toEqual({ success: true });

  // An unknown matchId is a config error, and must not fall through to some other match.
  const unknown = await postEvent({ event: 'match_live', matchId: 'no-such-match-id' });
  expect(unknown.status()).toBe(200);

  const untouched = await readMatch(match.id);
  expect(untouched).toMatchObject({ status: 'PENDING', homeScore: 0, awayScore: 0, winnerId: null });
});

test('two active matches and no name match is ambiguous, so the event is ignored', async () => {
  test.skip(!CS2_KEY, NO_KEY_REASON);
  const { tournament, match, home, away } = await createBridgedMatch();
  const otherHome = await createTeam(tournament.id, { name: 'Third Wheel' });
  const second = await addMatch(tournament.id, {
    homeTeamId: otherHome.id,
    awayTeamId: away.id,
    matchOrder: 1,
  });

  const res = await postEvent({
    event: 'round_end',
    tournamentId: tournament.id,
    mapNumber: 0,
    team1: { name: 'Some Other Crew', score: 12 },
    team2: { name: 'Nobody At All', score: 3 },
  });
  expect(res.status()).toBe(200);

  for (const id of [match.id, second.id]) {
    const row = await readMatch(id);
    expect(row.mapScores, id).toBe('[]');
    expect(row.status, id).toBe('PENDING');
  }
  // Nor is any team renamed off the back of an unresolved event.
  expect((await readTeam(home.id))!.name).toBe('Home Crew');
});

test('team-name sync fills in bracket placeholders and leaves real names alone', async () => {
  test.skip(!CS2_KEY, NO_KEY_REASON);
  const placeholder = await createBridgedMatch({ homeName: 'TBA', awayName: 'Team 2' });
  const chosen = await createBridgedMatch({ homeName: 'Northern Lights', awayName: 'Away Crew' });

  await postEvent({
    event: 'match_live',
    matchId: placeholder.match.id,
    team1: { name: 'Server Home', score: 0 },
    team2: { name: 'Server Away', score: 0 },
  });
  expect((await readTeam(placeholder.home.id))!.name).toBe('Server Home');
  expect((await readTeam(placeholder.away.id))!.name).toBe('Server Away');

  await postEvent({
    event: 'match_live',
    matchId: chosen.match.id,
    team1: { name: 'Server Home', score: 0 },
    team2: { name: 'Server Away', score: 0 },
  });
  // An organizer-chosen name is never clobbered by whatever the game server happens to call it.
  expect((await readTeam(chosen.home.id))!.name).toBe('Northern Lights');
  expect((await readTeam(chosen.away.id))!.name).toBe('Away Crew');
});
