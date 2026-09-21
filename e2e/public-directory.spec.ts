import { expect, test } from '@playwright/test';
import { loginAs } from './helpers/auth';
import { disposeApiContexts } from './helpers/api';
import {
  createSeededTeams,
  createTournament,
  generateBracketAsAdmin,
  scoreMatchAsAdmin,
  seedPlayedBracket,
} from './helpers/lan-seed';

/**
 * What a spectator sees before they pick a tournament: the landing board, the tournament
 * directory, the role-aware header, and the doors that are supposed to stay shut.
 *
 * Everything here runs anonymously unless a test says otherwise — the point is the surface a
 * phone in the room, or a stranger with the link, is handed.
 */
test.describe.configure({ mode: 'serial' });
test.afterEach(disposeApiContexts);

/** A tournament in each lifecycle stage, freshly created so it is among the newest on the landing page. */
async function oneOfEachStage() {
  const draft = await createTournament({ name: `Stage Draft ${Date.now().toString(36)}`, teamSize: 1 });

  const registration = await createTournament({ name: `Stage Reg ${Date.now().toString(36)}`, teamSize: 1 });
  await createSeededTeams(registration.id, 4);

  const finished = await createTournament({ name: `Stage Done ${Date.now().toString(36)}`, teamSize: 1 });
  await createSeededTeams(finished.id, 2);
  const finishedMatches = await generateBracketAsAdmin(finished.id);
  await scoreMatchAsAdmin(finishedMatches[0].id, 1, 0);

  const live = await seedPlayedBracket({ name: `Stage Live ${Date.now().toString(36)}`, teams: 4, completed: 1 });

  return { draft, registration, finished, live: live.tournament };
}

test('landing board badges every stage and offers the anonymous sign-in CTA', async ({ page }) => {
  const { draft, registration, finished, live } = await oneOfEachStage();

  await page.goto('/');

  // Anonymous: sign-in CTA, and nothing that implies staff rights.
  await expect(page.getByTestId('landing-cta-login')).toBeVisible();
  await expect(page.getByTestId('landing-cta-dashboard')).toHaveCount(0);
  await expect(page.getByTestId('landing-cta-organizer')).toHaveCount(0);

  const card = (name: string) => page.locator('li').filter({ hasText: name });
  await expect(card(draft.name)).toContainText('Draft');
  await expect(card(registration.name)).toContainText('Registration');
  await expect(card(live.name)).toContainText('Live');
  await expect(card(finished.name)).toContainText('Complete');

  // The card is the link into the tournament.
  await card(live.name).getByRole('link').first().click();
  await expect(page).toHaveURL(new RegExp(`/tournaments/${live.id}$`));
});

test('landing board shows only the nine newest tournaments', async ({ page }) => {
  const stamp = Date.now().toString(36);
  const created = [];
  for (let i = 0; i < 10; i++) {
    created.push(await createTournament({ name: `Newest ${stamp}-${String(i).padStart(2, '0')}`, teamSize: 1 }));
  }

  await page.goto('/');

  await expect(page.locator('main ul > li')).toHaveCount(9);
  // The newest nine are mine; the first one I created is the tenth-newest and must be cut.
  await expect(page.getByText(created[9].name, { exact: true })).toBeVisible();
  await expect(page.getByText(created[0].name, { exact: true })).toHaveCount(0);
});

test('directory lists tournaments and links into the detail page', async ({ page }) => {
  const first = await createTournament({ name: `Directory A ${Date.now().toString(36)}`, teamSize: 5 });
  const second = await createTournament({ name: `Directory B ${Date.now().toString(36)}`, teamSize: 1 });

  await page.goto('/tournaments');

  // The directory's own title (the marketing "Discover tournaments" headline was dropped when
  // the board was rebuilt — the page says what it is, and the rest of the width is data).
  await expect(page.getByRole('heading', { level: 1, name: 'Tournaments' })).toBeVisible();
  await expect(page.getByRole('heading', { name: first.name, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: second.name, exact: true })).toBeVisible();
  // Roster size is part of the card, so a spectator knows what they are signing up for.
  await expect(page.locator('a', { has: page.getByRole('heading', { name: first.name, exact: true }) })).toContainText('5v5');

  await page.getByRole('heading', { name: second.name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/tournaments/${second.id}$`));
});

test('directory filter narrows the list and survives reload through the URL', async ({ page }) => {
  const stamp = Date.now().toString(36);
  const wanted = await createTournament({ name: `Zephyr Open ${stamp}`, teamSize: 1 });
  const other = await createTournament({ name: `Quasar Cup ${stamp}`, teamSize: 1 });

  await page.goto('/tournaments');
  await expect(page.getByRole('heading', { name: wanted.name, exact: true })).toBeVisible();

  await page.getByPlaceholder('Filter tournaments…').fill(`Zephyr Open ${stamp}`);
  await expect(page.getByRole('heading', { name: wanted.name, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: other.name, exact: true })).toHaveCount(0);
  // Count the board itself. The "1 listed" badge is gone — it repeated whichever chip was
  // active — and so are the chips at this size: a filter row over a list of one is furniture,
  // so both the chips and the count they carry appear only above six tournaments.
  await expect(page.locator('ul.mds-card-grid > li')).toHaveCount(1);
  await expect(page).toHaveURL(/[?&]search=Zephyr/);

  // The filter is URL state, so a shared link reproduces the filtered board.
  await page.reload();
  await expect(page.getByRole('heading', { name: wanted.name, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: other.name, exact: true })).toHaveCount(0);

  await page.getByPlaceholder('Filter tournaments…').fill('no-such-tournament-anywhere');
  await expect(page.getByText('No results found')).toBeVisible();
});

// Regression: the directory never told a spectator which tournaments were actually running. The
// landing page badges every card via getTournamentStage (src/app/page.tsx — it selects `teams` +
// `matches.status` for exactly that), but the directory card only printed the game badge and the
// roster size, and the list API it reads could not derive a stage anyway: GET /api/tournaments
// selected `_count` of teams/matches but no match statuses, so LIVE and COMPLETE were
// indistinguishable from there. The route (and the SSR prefetch that mirrors it) now returns a
// server-computed `stage`.
test('directory cards carry the lifecycle stage badge', async ({ page }) => {
  const live = await seedPlayedBracket({ name: `Directory Live ${Date.now().toString(36)}`, teams: 4, completed: 1 });

  await page.goto('/tournaments');

  const card = page.locator('a', { has: page.getByRole('heading', { name: live.tournament.name, exact: true }) });
  await expect(card).toContainText('Live');
});

test('theme toggle flips the theme attribute and survives a reload', async ({ page }) => {
  await page.goto('/tournaments');

  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'dark');

  await page.getByRole('button', { name: 'Toggle Theme' }).click();
  await expect(html).toHaveAttribute('data-theme', 'light');

  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'light');

  await page.getByRole('button', { name: 'Toggle Theme' }).click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
});

test('header offers a spectator only the public surfaces', async ({ page }) => {
  await page.goto('/tournaments');

  const header = page.locator('header').first();
  await expect(header.getByRole('link', { name: 'Tournaments' })).toBeVisible();
  await expect(header.getByRole('link', { name: 'Sign in' })).toBeVisible();
  await expect(header.getByRole('link', { name: 'My desk' })).toHaveCount(0);
  await expect(header.getByRole('link', { name: 'Admin' })).toHaveCount(0);
  await expect(header.getByRole('link', { name: 'Marshal' })).toHaveCount(0);
  await expect(header.getByRole('link', { name: 'Profile' })).toHaveCount(0);
});

test('header is role-aware: player, marshal and organizer see different doors', async ({ page }) => {
  const header = page.locator('header').first();

  await loginAs(page, 'leo');
  await page.goto('/tournaments');
  await expect(header.getByRole('link', { name: 'My desk' })).toBeVisible();
  await expect(header.getByRole('link', { name: 'Profile' })).toBeVisible();
  // A player is never shown a staff door.
  await expect(header.getByRole('link', { name: 'Admin' })).toHaveCount(0);
  await expect(header.getByRole('link', { name: 'Marshal' })).toHaveCount(0);

  await page.context().clearCookies();
  await loginAs(page, 'mia');
  await page.goto('/tournaments');
  await expect(header.getByRole('link', { name: 'Marshal' })).toBeVisible();
  await expect(header.getByRole('link', { name: 'Admin' })).toHaveCount(0);

  await page.context().clearCookies();
  await loginAs(page, 'marcus');
  await page.goto('/tournaments');
  await expect(header.getByRole('link', { name: 'Admin' })).toBeVisible();
  await expect(header.getByRole('link', { name: 'Marshal' })).toBeVisible();
});

test('staff doors stay shut for spectators and players, and dead routes 404', async ({ page }) => {
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/login\?callbackUrl=%2Fadmin$/);

  await loginAs(page, 'leo');
  await page.goto('/marshal/dashboard');
  // A signed-in player is sent home (bouncing to /login would loop) — never a 500 and never the board.
  await expect(page).toHaveURL(new RegExp(`^${new URL(page.url()).origin}/$`));

  const dead = await page.goto('/dashboard/tournaments/anything');
  expect(dead?.status()).toBe(404);
});

test('mobile spectator can reach a tournament from the landing board', async ({ page }) => {
  const live = await seedPlayedBracket({ name: `Phone Cup ${Date.now().toString(36)}`, teams: 4, completed: 1 });
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto('/');
  await expect(page.getByTestId('landing-cta-login')).toBeVisible();
  const noHorizontalScroll = () =>
    page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  expect(await noHorizontalScroll()).toBe(true);

  await page.locator('li').filter({ hasText: live.tournament.name }).getByRole('link').first().click();
  await expect(page).toHaveURL(new RegExp(`/tournaments/${live.tournamentId}$`));

  await page.goto('/tournaments');
  await expect(page.getByRole('heading', { name: live.tournament.name, exact: true })).toBeVisible();
  expect(await noHorizontalScroll()).toBe(true);
});
