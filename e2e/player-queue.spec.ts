import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { apiAs, disposeApiContexts, json } from './helpers/api';
import {
  attachUserToTeam,
  clearRegistrations,
  createSeededTeams,
  createTournament,
  readMatches,
  setMatchStatus,
} from './helpers/lan-seed';
import { loginAs, mintSessionToken, personaUserId } from './helpers/auth';

/**
 * The player desk and the queue: "am I playing, and when?".
 *
 * The number in "N matches ahead of you" is the only scheduling promise Summit makes to a
 * player, and GET /api/me/queue defines it narrowly (route doc comment): a match is ahead of
 * you only if it is not done, ordered before yours, and *playable* — both teams assigned — or
 * already called/live. A freshly generated bracket is mostly empty later-round slots, so the
 * "playable" clause is the whole point, and it gets its own fixture below.
 *
 * Everything is driven off a real generated 8-team single-elimination bracket, with Leo dropped
 * into a known slot afterwards so the expected number is arithmetic, not a guess.
 */
test.describe.configure({ mode: 'serial' });
test.afterEach(disposeApiContexts);

interface Bracket {
  admin: APIRequestContext;
  tournamentId: string;
  tournamentName: string;
  matches: Awaited<ReturnType<typeof readMatches>>;
}

/** A generated 8-team SE bracket: 4 first-round matches, 2 semis, 1 final. */
async function eightTeamBracket(name: string): Promise<Bracket> {
  const tournament = await createTournament({ name, teamSize: 1 });
  await createSeededTeams(tournament.id, 8);

  const admin = await apiAs('marcus');
  const generated = await admin.post(`/api/tournaments/${tournament.id}/generate`, { data: {} });
  expect(generated.status()).toBe(200);

  const matches = await readMatches(tournament.id);
  expect(matches).toHaveLength(7);
  expect(matches.filter((m) => m.round === 1)).toHaveLength(4);
  return { admin, tournamentId: tournament.id, tournamentName: name, matches };
}

/**
 * Hands Leo the team sitting in one bracket slot — and *only* that one, by first dropping every
 * registration an earlier test left him. The desk aggregates across tournaments, so half these
 * assertions are about an absence and would otherwise read another test's fixture.
 */
async function leoTakesTeam(teamId: string) {
  await mintSessionToken('leo');
  const leoUserId = await personaUserId('leo');
  await clearRegistrations(leoUserId);
  await attachUserToTeam(teamId, leoUserId);
}

async function leoQueueEntry(tournamentId: string) {
  const api = await apiAs('leo');
  const { queue } = await json<{ queue: any[] }>(await api.get('/api/me/queue'));
  const entry = queue.find((q) => q.tournamentId === tournamentId);
  expect(entry, 'leo has a queue entry for this tournament').toBeTruthy();
  return entry;
}

/**
 * The MyQueue section on the player desk — the only part of the page that polls.
 *
 * Found by its accessible name, not by a visible "Your queue" heading. That heading is gone on
 * purpose: it sat between the kid's name and the green card telling them where to go, naming a
 * region they can already see. The name still exists for a screen reader, which is what this
 * locator reads.
 */
function queueSection(page: Page) {
  return page.getByRole('region', { name: 'Match status' });
}

test('the desk shows the tournament, the next opponent and a queue position that matches the API', async ({ page }) => {
  const { tournamentId, tournamentName, matches } = await eightTeamBracket('Queue Position Cup');
  // The last first-round match: three real, playable matches are ordered before it.
  const mine = matches.filter((m) => m.round === 1)[3];
  await leoTakesTeam(mine.homeTeamId!);

  const entry = await leoQueueEntry(tournamentId);
  expect(entry).toMatchObject({ state: 'SCHEDULED', matchesAhead: 3, totalPending: 7 });
  expect(entry.nextMatch).toMatchObject({ id: mine.id, round: 1, youAreHome: true, hasOpponent: true });

  await loginAs(page, 'leo');
  await page.goto('/dashboard');

  // The hero: the one match this player's team is actually in.
  await expect(page.getByRole('heading', { name: `${entry.teamName} vs ${entry.nextMatch.opponent}` })).toBeVisible();

  // The queue card: same tournament, same opponent, and the number the API just reported.
  const card = queueSection(page).locator('.mds-card').filter({ hasText: tournamentName });
  // The stage reads on its own muted line under the matchup. No "· BO1": bestOf is 1 for every
  // round by default, so it was a constant — and in the numeric face it read as a second seat
  // code sitting below the real one.
  await expect(card).toContainText('Round 1');
  await expect(card).not.toContainText('BO1');
  await expect(card).toContainText(entry.nextMatch.opponent);
  await expect(card).toContainText('3 matches ahead of you');

  // …and it is NOT listed a second time below. A tournament with a call card is already fully
  // answered by that card — seat, opponent, server — so repeating it put a second seat code and
  // a second pencil under the kid's thumb, and the second pencil is the wrong one to press.
  const list = page.getByRole('region', { name: 'Your tournaments' });
  await expect(list).toHaveCount(0);
});

test('empty later-round slots are not counted as matches ahead — unless they have been called', async ({ page }) => {
  // Two assertions off one fixture because they are the two halves of one rule (clause (c) of
  // the matchesAhead doc comment), and the second needs the first as its baseline.
  test.setTimeout(120_000);
  const { admin, tournamentId, tournamentName, matches } = await eightTeamBracket('Queue Counting Cup');
  const round1 = matches.filter((m) => m.round === 1);
  const semis = matches.filter((m) => m.round === 2);

  // Premise: first-round matches 2 and 3 both feed the SECOND semi-final, so playing them out
  // leaves semi 0 (ordered before it) with two empty slots.
  expect(round1[2].nextMatchId).toBe(semis[1].id);
  expect(round1[3].nextMatchId).toBe(semis[1].id);

  for (const match of [round1[2], round1[3]]) {
    const res = await admin.post(`/api/matches/${match.id}`, { data: { homeScore: 1, awayScore: 0 } });
    expect(res.status()).toBe(200);
  }
  await leoTakesTeam(round1[2].homeTeamId!);

  // Pending: round1[0], round1[1], semi 0 (empty), semi 1 (Leo), final (empty).
  // Ahead of Leo: the two real first-round matches. The empty semi is not a match he waits for.
  const entry = await leoQueueEntry(tournamentId);
  expect(entry.nextMatch.id).toBe(semis[1].id);
  expect(entry).toMatchObject({ state: 'SCHEDULED', matchesAhead: 2, totalPending: 5 });

  await loginAs(page, 'leo');
  await page.goto('/dashboard');
  const card = queueSection(page).locator('.mds-card').filter({ hasText: tournamentName });
  await expect(card).toContainText('2 matches ahead of you');

  // The other half of clause (c): a marshal has called that same empty semi even though the
  // bracket has not filled it in yet. It occupies the floor now, so Leo really is one further
  // back. (Written straight to the DB — /load refuses a match with an empty team slot.)
  await setMatchStatus(semis[0].id, 'READY');
  expect((await leoQueueEntry(tournamentId)).matchesAhead).toBe(3);
  await expect(card).toContainText('3 matches ahead of you', { timeout: 35_000 });
});

test('calling the match flips the queue to "you\'re up", then to live, with no reload', async ({ page }) => {
  // Two 15s MyQueue poll windows plus a cold compile of /dashboard.
  test.setTimeout(150_000);
  const { tournamentId, tournamentName, matches } = await eightTeamBracket('Queue Called Cup');
  const mine = matches.filter((m) => m.round === 1)[0];
  await leoTakesTeam(mine.homeTeamId!);

  await loginAs(page, 'leo');
  await page.goto('/dashboard');
  const card = queueSection(page).locator('.mds-card').filter({ hasText: tournamentName });
  await expect(card).toContainText("You're up next");
  await expect(card).toContainText('Scheduled');

  // Mia is floor staff: calling a match is her job, not the organizer's.
  const mia = await apiAs('mia');
  expect((await mia.post(`/api/matches/${mine.id}/load`)).status()).toBe(200);

  // MyQueue polls every 15s — no reload, no navigation.
  await expect(card).toContainText("You're up — go to your station", { timeout: 35_000 });
  await expect(card).toContainText('Called');

  expect((await mia.post(`/api/matches/${mine.id}`, { data: { status: 'LIVE' } })).status()).toBe(200);
  await expect(card).toContainText('Live now — get to your station', { timeout: 35_000 });

  expect((await leoQueueEntry(tournamentId)).nextMatch.status).toBe('LIVE');
});

test('winning moves the queue on to the next round against a yet-unknown opponent', async ({ page }) => {
  const { admin, tournamentId, tournamentName, matches } = await eightTeamBracket('Queue Advance Cup');
  const mine = matches.filter((m) => m.round === 1)[0];
  await leoTakesTeam(mine.homeTeamId!);

  expect((await admin.post(`/api/matches/${mine.id}`, { data: { homeScore: 1, awayScore: 0 } })).status()).toBe(200);

  const entry = await leoQueueEntry(tournamentId);
  expect(entry.state).toBe('SCHEDULED');
  expect(entry.nextMatch).toMatchObject({ round: 2, hasOpponent: false, opponent: 'TBD' });

  await loginAs(page, 'leo');
  await page.goto('/dashboard');
  const card = queueSection(page).locator('.mds-card').filter({ hasText: tournamentName });
  await expect(card).toContainText('Round 2');
  await expect(card).toContainText('TBD');
});

test('losing empties the desk: no queue card, and the desk says you are knocked out', async ({ page }) => {
  const { admin, tournamentId, matches } = await eightTeamBracket('Queue Eliminated Cup');
  const mine = matches.filter((m) => m.round === 1)[0];
  await leoTakesTeam(mine.homeTeamId!);

  // Leo's team is home and loses, so it is out of a single-elimination bracket for good.
  expect((await admin.post(`/api/matches/${mine.id}`, { data: { homeScore: 0, awayScore: 1 } })).status()).toBe(200);

  const entry = await leoQueueEntry(tournamentId);
  expect(entry).toMatchObject({ state: 'OUT', nextMatch: null, matchesAhead: null });

  await loginAs(page, 'leo');
  await page.goto('/dashboard');

  // MyQueue only renders SCHEDULED entries, so the whole queue section goes away rather than
  // showing a stale position — and the desk says what actually happened instead of promising a
  // match that is never coming.
  await expect(page.getByRole('heading', { name: 'Knocked out', exact: true })).toBeVisible();
  await expect(page.getByText('Your team is out of Queue Eliminated Cup')).toBeVisible();
  // The region stays — it is where the "Knocked out" line above lives — but it holds no call
  // card. Asserting the region is gone would only ever have tested that the heading text was
  // gone, and that heading is now an accessible name rather than a line of type.
  await expect(queueSection(page).locator('.mds-card')).toHaveCount(0);
  // The tournament stays on the desk — being knocked out is not being un-registered.
  await expect(page.getByRole('heading', { name: 'Queue Eliminated Cup' })).toBeVisible();
});

test('a registered player with no bracket yet is NO_BRACKET, not "up next"', async ({ page }) => {
  const tournament = await createTournament({ name: 'Queue No Bracket Cup', teamSize: 1 });
  const [team] = await createSeededTeams(tournament.id, 2);
  await leoTakesTeam(team.id);

  const entry = await leoQueueEntry(tournament.id);
  expect(entry).toMatchObject({ state: 'NO_BRACKET', nextMatch: null, matchesAhead: null, totalPending: 0 });

  await loginAs(page, 'leo');
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Queue No Bracket Cup' })).toBeVisible();
  await expect(queueSection(page).locator('.mds-card')).toHaveCount(0);
});
