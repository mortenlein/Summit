import { expect, test, type Page } from '@playwright/test';
import { apiAs, disposeApiContexts } from './helpers/api';
import {
  plantTeamSecrets,
  scoreMatchAsAdmin,
  seedPlayedBracket,
} from './helpers/lan-seed';

/**
 * The public tournament page as an anonymous spectator gets it: the bracket, the match board,
 * the rosters — and nothing else. Every test seeds its own tournament (8-team bracket, two
 * matches played, one on the floor) so nothing here depends on ordering.
 */
test.describe.configure({ mode: 'serial' });
test.afterEach(disposeApiContexts);

/** The ReactFlow node for one match — nodes carry `data-id="<matchId>"`. */
const bracketNode = (page: Page, matchId: string) => page.locator(`.react-flow__node[data-id="${matchId}"]`);

/** The two score readouts inside a bracket node, home first. */
const nodeScores = (page: Page, matchId: string) => bracketNode(page, matchId).locator('span.tabular-nums');

const teamName = (teams: { id: string; name: string }[], id: string | null) =>
  teams.find((t) => t.id === id)?.name ?? '';

test('bracket tab renders every match, marks the winner and flags the live one', async ({ page }) => {
  const { tournamentId, teams, matches, playedMatches, liveMatch } = await seedPlayedBracket({ teams: 8, completed: 2 });
  expect(matches).toHaveLength(7);

  await page.goto(`/tournaments/${tournamentId}?tab=bracket`);

  // All 7 matches of an 8-team single elimination are on the canvas.
  await expect(page.locator('.react-flow__node')).toHaveCount(7);
  // …labelled by stage, so a spectator knows what they are looking at. The names come from
  // STAGE_LABELS (src/lib/games.ts), the same map the organizer picks best-of stages from.
  // Scoped to the canvas: the score rail names the same stages.
  const canvas = page.locator('.react-flow');
  await expect(canvas.getByText('Grand Final')).toBeVisible();
  await expect(canvas.getByText('Semi-Finals').first()).toBeVisible();
  await expect(canvas.getByText('Quarter-Finals').first()).toBeVisible();

  // Round 1 shows real team names; a slot with no team yet names its feeder ("Winner of QF3")
  // rather than the old machine noise ("INITIALIZING...").
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    await expect(canvas.getByText(`Seed ${seed}`, { exact: true }).first()).toBeVisible();
  }
  await expect(canvas.getByText(/Winner of QF/).first()).toBeVisible();
  await expect(canvas.getByText('INITIALIZING...')).toHaveCount(0);

  // A completed match shows its score and dims the loser's side — that is the "winner" marker.
  const played = playedMatches[0];
  await expect(nodeScores(page, played.id).nth(0)).toHaveText('1');
  await expect(nodeScores(page, played.id).nth(1)).toHaveText('0');
  const playedOpacity = await nodeScores(page, played.id).evaluateAll((els) =>
    els.map((el) => window.getComputedStyle(el).opacity)
  );
  expect(playedOpacity).toEqual(['1', '0.2']);
  expect(teamName(teams, played.homeTeamId)).toBeTruthy();

  // The live match carries the pulsing live dot; a finished one does not.
  await expect(bracketNode(page, liveMatch!.id).locator('.animate-pulse')).toHaveCount(1);
  await expect(bracketNode(page, played.id).locator('.animate-pulse')).toHaveCount(0);

  // The winner of a played round-1 match has been advanced into the next node.
  const nextNode = bracketNode(page, played.nextMatchId!);
  await expect(nextNode).toContainText(teamName(teams, played.homeTeamId));
});

test('matches tab groups every round and states each match status', async ({ page }) => {
  const { tournamentId, teams, playedMatches, liveMatch } = await seedPlayedBracket({ teams: 8, completed: 2 });

  await page.goto(`/tournaments/${tournamentId}?tab=matches`);

  // Scoped to the match board: the desktop score rail repeats the same live match.
  const board = page.locator('main');
  // Rounds are grouped under the stage a spectator knows them by, not "Round 3".
  await expect(board.getByRole('heading', { name: 'Quarter-Finals' })).toBeVisible();
  await expect(board.getByRole('heading', { name: 'Semi-Finals' })).toBeVisible();
  await expect(board.getByRole('heading', { name: 'Grand Final' })).toBeVisible();

  // Played matches read Done with their score; the live one reads Live.
  const statuses = board.getByTestId('public-match-status');
  await expect(statuses.filter({ hasText: 'Done' })).toHaveCount(playedMatches.length);
  await expect(statuses.filter({ hasText: 'LIVE' })).toHaveCount(1);
  const playedScores = board.getByTestId(`public-match-${playedMatches[0].id}`).locator('span.mds-numeric');
  await expect(playedScores.nth(0)).toHaveText('1');
  await expect(playedScores.nth(1)).toHaveText('0');
  // A live match carries no bracket link of its own. The bottom tab bar already has Bracket,
  // with the same word, the same icon and the same destination — no match id was ever passed —
  // and that duplicate was pushing the call-up status of the match below it toward the fold.
  // (It used to offer "Watch Stream", which opened the transparent OBS overlay; no stream URL
  // exists anywhere in the schema, and neither control should come back.)
  await expect(board.getByTestId(`public-match-${liveMatch!.id}`).getByRole('link')).toHaveCount(0);
  await expect(board.getByRole('link', { name: /Watch Stream/i })).toHaveCount(0);

  const liveCard = board.locator('div.mds-card').filter({ hasText: teamName(teams, liveMatch!.homeTeamId) }).first();
  await expect(liveCard).toContainText(teamName(teams, liveMatch!.awayTeamId));
  await expect(liveCard).toContainText('Live');
});

test('teams tab lists every roster and its players', async ({ page }) => {
  const { tournamentId } = await seedPlayedBracket({ teams: 8, completed: 1 });

  await page.goto(`/tournaments/${tournamentId}?tab=teams`);

  const registry = page.locator('main');
  await expect(registry.getByRole('heading', { name: 'Teams', exact: true })).toBeVisible();
  for (const seed of [1, 4, 8]) {
    const card = registry.locator('div.mds-card').filter({ hasText: `Seed ${seed}` }).first();
    await expect(card).toContainText('1 PLAYERS');
    await expect(card).toContainText(`Player`);
  }
  // Eight teams, eight cards.
  await expect(page.getByText('1 PLAYERS')).toHaveCount(8);

  // The team's own search narrows the registry.
  await page.getByPlaceholder('Search teams...').fill('Seed 7');
  await expect(page.getByText('1 PLAYERS')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Seed 7', exact: true })).toBeVisible();
});

// Regression (IA gap, not a crash): the teams tab never showed where a player is sitting, which
// is the one thing a LAN spectator needs from a roster. TeamRegistry printed only the
// nickname/first name and the team modal repeated that — `seating` comes down in the public
// payload (src/app/api/tournaments/[id]/teams/route.ts:58) but was rendered only on the Players
// tab (src/components/tournament/StatsTable.tsx:64) and the OBS roster board. Both now carry the
// marshal board's mono seat chip.
test('teams tab shows each player’s seat', async ({ page }) => {
  const { tournamentId } = await seedPlayedBracket({ teams: 4, completed: 1 });

  await page.goto(`/tournaments/${tournamentId}?tab=teams`);

  const card = page.locator('div.mds-card').filter({ hasText: 'Seed 1' }).first();
  await expect(card).toContainText('S01');
});

test('players tab is the seating chart: every player, team and seat', async ({ page }) => {
  const { tournamentId } = await seedPlayedBracket({ teams: 8, completed: 1 });

  await page.goto(`/tournaments/${tournamentId}?tab=players`);

  await expect(page.getByRole('heading', { name: 'Player Directory' })).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(8);

  const row = page.locator('tbody tr').filter({ hasText: 'S03' });
  await expect(row).toContainText('Seed 3');
  await expect(row).toContainText('S03');
});

test('deep links open the requested tab straight from the URL', async ({ page }) => {
  const { tournamentId } = await seedPlayedBracket({ teams: 4, completed: 1 });

  await page.goto(`/tournaments/${tournamentId}?tab=players`);
  await expect(page.getByRole('heading', { name: 'Player Directory' })).toBeVisible();

  await page.goto(`/tournaments/${tournamentId}?tab=bracket`);
  await expect(page.locator('.react-flow__node')).toHaveCount(3);

  // An unknown tab falls back to the overview rather than rendering nothing.
  await page.goto(`/tournaments/${tournamentId}?tab=not-a-tab`);
  await expect(page.getByTestId('tournament-overview')).toBeVisible();
});

test('a missing tournament id renders the not-found state with a way back', async ({ page }) => {
  await page.goto('/tournaments/no-such-tournament-id');

  // The route-level not-found boundary (not TournamentView's client fallback, whose copy reads
  // "could not be loaded"), so the recovery links are the curated ones.
  await expect(page.getByText('Tournament Not Found')).toBeVisible();
  await expect(page.getByText('This tournament does not exist or is no longer available.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Dashboard' })).toBeVisible();

  await page.getByRole('link', { name: 'Back to Tournaments' }).click();
  await expect(page).toHaveURL(/\/tournaments$/);
});

// BUG: a missing tournament answers 200 OK while rendering the not-found page. The page calls
// notFound() (src/app/tournaments/[id]/page.tsx:21) but it is `export const dynamic =
// 'force-dynamic'` (line 11) and streamed, so the response status is committed before the
// boundary renders. Verified against the running server:
//   curl -i /tournaments/no-such-tournament-id → "HTTP/1.1 200 OK" with the
//   "does not exist or is no longer available" body.
// Consequence: crawlers, link unfurlers and uptime monitors treat a dead tournament link as a
// healthy page, and `/dashboard/tournaments/anything` (a plain routing 404) does answer 404 —
// so the two not-found paths disagree.
test('a missing tournament answers 404, not 200', async ({ page }) => {
  // Regression: a loading.tsx boundary on this segment flushed a 200 shell before notFound() ran.
  const response = await page.goto('/tournaments/no-such-tournament-id');
  expect(response?.status()).toBe(404);
});

test('nothing a spectator loads carries invite codes, steamIds or server passwords', async ({ page }) => {
  const { tournamentId } = await seedPlayedBracket({ teams: 8, completed: 2 });
  const secrets = await plantTeamSecrets(tournamentId);
  expect(secrets.length).toBeGreaterThan(8);

  // Every JSON body the page fetches, collected as it arrives.
  const payloads: { url: string; body: string }[] = [];
  page.on('response', async (response) => {
    const type = response.headers()['content-type'] || '';
    if (!type.includes('application/json')) return; // skip SSE/HTML/assets — text() would hang on a stream
    try {
      payloads.push({ url: response.url(), body: await response.text() });
    } catch {
      /* response body already gone — nothing to scan */
    }
  });

  const documentResponse = await page.goto(`/tournaments/${tournamentId}?tab=teams`);
  const documentHtml = (await documentResponse!.text()) + (await page.content());

  // Touch the tabs that show rosters and matches (the data is SSR-hydrated, so these render
  // from the payload embedded in the HTML we just captured).
  await expect(page.getByText('1 PLAYERS').first()).toBeVisible();
  await page.goto(`/tournaments/${tournamentId}?tab=players`);
  await expect(page.getByRole('heading', { name: 'Player Directory' })).toBeVisible();
  await page.goto(`/tournaments/${tournamentId}?tab=bracket`);
  await expect(page.locator('.react-flow__node').first()).toBeVisible();

  // Then make the page issue the refetches React Query would make once its data goes stale —
  // same endpoints as clientApi, same (absent) credentials.
  await page.evaluate(async (id) => {
    await Promise.all(
      [
        `/api/tournaments/${id}`,
        `/api/tournaments/${id}/teams`,
        `/api/tournaments/${id}/matches`,
        `/api/tournaments/${id}/scoreboard`,
      ].map((url) => fetch(url).then((r) => r.text()))
    );
  }, tournamentId);

  // We must actually have captured those payloads, or this test proves nothing. The bodies are
  // read asynchronously in the listener, so poll rather than assert on the first tick.
  for (const endpoint of ['/teams', '/matches', '/scoreboard']) {
    await expect
      .poll(() => payloads.filter((p) => p.url.includes(endpoint)).length, { timeout: 10000 })
      .toBeGreaterThan(0);
  }

  const haystacks = [{ url: 'document HTML', body: documentHtml }, ...payloads];
  for (const { url, body } of haystacks) {
    for (const secret of secrets) {
      expect(body.includes(secret), `${secret} leaked in ${url}`).toBe(false);
    }
    for (const field of ['inviteCode', 'steamId', 'serverPassword', 'serverIp', 'serverPort']) {
      expect(body.includes(`"${field}"`), `${field} exposed in ${url}`).toBe(false);
    }
  }
  // `userId` links a roster row to an account; the public roster shape must not carry it.
  for (const { url, body } of payloads) {
    expect(body.includes('"userId"'), `userId exposed in ${url}`).toBe(false);
  }
});

test('a double-elimination bracket shows winners, losers, grand final and the loser drops', async ({ page }) => {
  const { tournamentId, matches } = await seedPlayedBracket({
    teams: 8,
    completed: 2,
    format: 'DOUBLE_ELIMINATION',
  });

  // Premise: generation really produced the three areas.
  expect(matches.filter((m) => m.bracketType === 'WINNERS').length).toBeGreaterThan(0);
  expect(matches.filter((m) => m.bracketType === 'LOSERS').length).toBeGreaterThan(0);
  expect(matches.filter((m) => m.bracketType === 'GRAND_FINAL').length).toBeGreaterThan(0);

  await page.goto(`/tournaments/${tournamentId}?tab=bracket`);

  await expect(page.locator('.react-flow__node')).toHaveCount(matches.length);
  // Scoped to the canvas: the score rail names the same stages.
  const canvas = page.locator('.react-flow');
  await expect(canvas.getByText('WB Round 1').first()).toBeVisible();
  await expect(canvas.getByText('Winners Final')).toBeVisible();
  await expect(canvas.getByText('LB Round 1').first()).toBeVisible();
  await expect(canvas.getByText('Losers Final')).toBeVisible();
  await expect(canvas.getByText('Grand Final', { exact: true })).toBeVisible();

  // The loser of a played winners match has dropped into the losers bracket…
  const dropped = matches.find((m) => m.bracketType === 'WINNERS' && m.round === 1 && m.loserNextMatchId)!;
  const landing = await page.locator(`.react-flow__node[data-id="${dropped.loserNextMatchId}"]`);
  await expect(landing).toBeVisible();

  // …and the drop itself is drawn: loser edges are rendered alongside the winner edges.
  await expect(page.locator('.react-flow__edge[data-testid^="rf__edge-l-"]').first()).toBeAttached();
  const loserEdges = await page.locator('.react-flow__edge[data-testid^="rf__edge-l-"]').count();
  expect(loserEdges).toBeGreaterThanOrEqual(matches.filter((m) => m.loserNextMatchId).length ? 1 : 0);
});

test('a score posted by staff reaches an open spectator page without a reload', async ({ page }) => {
  const { tournamentId, liveMatch } = await seedPlayedBracket({ teams: 8, completed: 2 });

  await page.goto(`/tournaments/${tournamentId}?tab=bracket`);
  await expect(nodeScores(page, liveMatch!.id).nth(0)).toHaveText('0');

  // A marker that survives only as long as the document does.
  await page.evaluate(() => {
    (window as any).__stillTheSameDocument = true;
  });

  await scoreMatchAsAdmin(liveMatch!.id, 13, 7);

  await expect(nodeScores(page, liveMatch!.id).nth(0)).toHaveText('13', { timeout: 35000 });
  await expect(nodeScores(page, liveMatch!.id).nth(1)).toHaveText('7');
  expect(await page.evaluate(() => (window as any).__stillTheSameDocument)).toBe(true);
});

test('mobile spectator can read the bracket without the page scrolling sideways', async ({ page }) => {
  const { tournamentId, playedMatches } = await seedPlayedBracket({ teams: 8, completed: 2 });
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto(`/tournaments/${tournamentId}?tab=bracket`);
  await expect(page.locator('.react-flow__node')).toHaveCount(7);
  await expect(nodeScores(page, playedMatches[0].id).nth(0)).toHaveText('1');

  // The bracket pans inside its own clipped canvas; the document itself must not overflow.
  const overflow = await page.evaluate(() => ({
    pageScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    canvasPannable: Boolean(document.querySelector('.react-flow__pane')),
    canvasClipped: (() => {
      let el: Element | null = document.querySelector('.react-flow');
      while (el) {
        if (window.getComputedStyle(el).overflow !== 'visible') return true;
        el = el.parentElement;
      }
      return false;
    })(),
  }));
  expect(overflow.pageScroll).toBeLessThanOrEqual(0);
  expect(overflow.canvasPannable).toBe(true);
  expect(overflow.canvasClipped).toBe(true);

  // The mobile tab bar still reaches the other spectator views.
  await page.getByTestId('tournament-mobile-tab-teams').click();
  await expect(page.getByText('1 PLAYERS').first()).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  ).toBeLessThanOrEqual(0);
});

test('a spectator is never handed a staff payload for the same tournament', async ({ page }) => {
  const { tournamentId } = await seedPlayedBracket({ teams: 4, completed: 1 });
  const secrets = await plantTeamSecrets(tournamentId);

  // Sanity check from the other side: staff DO get the codes, so the public shape is a filter
  // and not just an empty database.
  const staff = await apiAs('marcus');
  const staffTeams = await (await staff.get(`/api/tournaments/${tournamentId}/teams`)).text();
  expect(staffTeams).toContain(secrets[0]);

  const anonTeams = await (await page.request.get(`/api/tournaments/${tournamentId}/teams`)).text();
  for (const secret of secrets) {
    expect(anonTeams.includes(secret)).toBe(false);
  }

  // The CSV export is the staff-only bulk copy of exactly those secrets.
  const csv = await page.request.get(`/api/tournaments/${tournamentId}/teams?format=csv`);
  expect(csv.status()).toBe(401);
});
