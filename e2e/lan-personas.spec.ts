import { expect, test } from '@playwright/test';
import { seedEmptyTournament, seedLanScenario, setMatchStatus } from './helpers/seed';
import { loginAs } from './helpers/auth';

test.describe.configure({ mode: 'serial' });

async function loginAsAdmin(page: import('@playwright/test').Page) {
  await loginAs(page, 'marcus');
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/admin$/);
}

test('Marcus can start a match and Uncle Dave sees seats plus notifications', async ({ browser, page }) => {
  const { tournamentId, matchId } = await seedLanScenario();
  // The fixture seeds this match already READY. This test is about Marcus *calling* it, and a
  // call only does anything to a match that has not been called — so put it back to PENDING
  // first. It used to pass against a called match only because /load re-ran the whole fan-out on
  // every tap, which also wiped both rosters' check-in stamps and re-buzzed every phone.
  await setMatchStatus(matchId, 'PENDING');
  page.on('dialog', async (dialog) => {
    await dialog.accept();
  });

  await loginAsAdmin(page);
  await page.locator(`a[href="/admin/tournaments/${tournamentId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/admin/tournaments/${tournamentId}$`));
  await page.goto(`/admin/tournaments/${tournamentId}?tab=matches`);
  await page.getByTestId(`match-card-${matchId}`).click();
  await page.getByTestId('start-match-button').click();
  await expect(page.getByTestId(`match-card-${matchId}`)).toContainText(/Called/i);

  const marshalContext = await browser.newContext({
    storageState: await page.context().storageState(),
  });
  const marshalPage = await marshalContext.newPage();
  await marshalPage.goto('/marshal/dashboard');
  await expect(marshalPage.getByTestId(`marshal-match-${matchId}`)).toContainText('A12');
  await expect(marshalPage.getByTestId(`marshal-match-${matchId}`)).toContainText('A13');
  await expect(marshalPage.getByTestId(`marshal-match-${matchId}`)).toContainText('C01');
  await expect(marshalPage.getByTestId(`marshal-match-${matchId}`)).toContainText('C02');
  await expect(marshalPage.getByTestId('notification-entry').first()).toContainText(/Match ready for players/i);
  await marshalContext.close();
});

test('Leo sees a one-click join link without a trailing slash when no password exists', async ({ page }) => {
  const { matchId } = await seedLanScenario();

  await loginAs(page, 'leo');
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard$/);

  const joinLink = page.getByTestId(`join-match-${matchId}`);
  await expect(joinLink).toBeVisible();
  await expect(joinLink).toHaveAttribute('href', 'steam://connect/127.0.0.1:27015');
});

test('Admin can bulk import teams from CSV without leaving the tournament workspace', async ({ page }) => {
  const { tournamentId } = await seedEmptyTournament();

  await loginAsAdmin(page);
  await page.locator(`a[href="/admin/tournaments/${tournamentId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/admin/tournaments/${tournamentId}$`));

  await page.goto(`/admin/tournaments/${tournamentId}?tab=participants`);
  await page.getByPlaceholder('teamName,seed,playerName,nickname,countryCode,seating,steamId,isLeader').fill([
    'teamName,seed,playerName,nickname,countryCode,seating,steamId,isLeader',
    'Alpha,1,Alex,Alex,no,A01,76561198000000111,true',
    'Alpha,1,Bea,Bea,se,A02,76561198000000112,false',
    'Bravo,2,Chris,Chris,dk,B01,76561198000000113,true',
    'Bravo,2,Dana,Dana,fi,B02,76561198000000114,false',
  ].join('\n'));
  await page.getByRole('button', { name: 'Import teams' }).click();

  await expect(page.getByText('Alpha')).toBeVisible();
  await expect(page.getByText('Bravo')).toBeVisible();
});

test('Roster lock disables team edits until an admin unlocks the tournament', async ({ page }) => {
  const { tournamentId } = await seedLanScenario();

  await loginAsAdmin(page);
  await page.locator(`a[href="/admin/tournaments/${tournamentId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/admin/tournaments/${tournamentId}$`));

  await page.goto(`/admin/tournaments/${tournamentId}?tab=settings`);
  await page.getByLabel('Toggle roster lock').click();
  // Exact match: the non-editable Game field also reads "CS2 | Locked".
  await expect(page.getByText('Locked', { exact: true })).toBeVisible();

  await page.goto(`/admin/tournaments/${tournamentId}?tab=participants`);
  await expect(page.getByRole('button', { name: /Add Team/i })).toBeDisabled();
  await expect(page.getByText(/Roster edits are locked because the bracket is already in play/i)).toBeVisible();
});
