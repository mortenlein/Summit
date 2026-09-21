import { expect, test, type Locator, type Page } from '@playwright/test';
import { apiAs, disposeApiContexts, json } from './helpers/api';
import { createTournament, readPlayer } from './helpers/lan-seed';
import { loginAs } from './helpers/auth';

/**
 * The seat is the one field a player owns, and it is the field the floor runs on — a marshal
 * with no seat has to shout a name across the hall. The same `SeatEditor` is mounted on three
 * surfaces (register panel, player desk, profile), so all three are exercised here: a seat set
 * on one of them has to be the seat the other two read back.
 */
test.describe.configure({ mode: 'serial' });
test.afterEach(disposeApiContexts);

/** Leo, registered in a fresh signup tournament, with the id of his own Player row. */
async function leoRegistered(name: string, seating?: string) {
  const tournament = await createTournament({ name, teamSize: 2, steamSignupEnabled: true });
  const api = await apiAs('leo');
  const team = await json(
    await api.post(`/api/tournaments/${tournament.id}/signup`, {
      data: { action: 'CREATE_TEAM', teamName: 'Leo Legion', ...(seating ? { seating } : {}) },
    })
  );
  return { tournamentId: tournament.id, playerId: team.players[0].id as string };
}

/** The seat editor inside a given container (a card on the desk, the panel on /register). */
function seatEditor(scope: Page | Locator) {
  return {
    open: (label: RegExp) => scope.getByRole('button', { name: label }).click(),
    input: () => scope.getByLabel('Your seat'),
    save: () => scope.getByRole('button', { name: /^Save$/ }).click(),
  };
}

test('the register panel’s seat editor writes the seat through to the player row', async ({ page }) => {
  const { tournamentId, playerId } = await leoRegistered('Seat Register Cup', 'B12');
  await loginAs(page, 'leo');
  await page.goto(`/tournaments/${tournamentId}/register`);
  await expect(page.getByRole('heading', { name: 'Leo Legion' })).toBeVisible();

  const editor = seatEditor(page);
  await editor.open(/^Edit$/);
  await editor.input().fill('C04');
  await editor.save();

  await expect(page.getByText('Seat saved: C04')).toBeVisible();
  expect((await readPlayer(playerId))!.seating).toBe('C04');
  // The roster row the rest of the team reads is re-rendered from the save, not from a reload.
  await expect(page.getByRole('listitem').filter({ hasText: 'Leo' })).toContainText('C04');
});

test('the player desk’s seat editor saves and keeps the new seat after a reload', async ({ page }) => {
  const { tournamentId, playerId } = await leoRegistered('Seat Desk Cup', 'B12');
  await loginAs(page, 'leo');
  await page.goto('/dashboard');

  const card = page.locator('.mds-card', { hasText: 'Seat Desk Cup' }).first();
  await expect(card).toContainText('B12');

  const editor = seatEditor(card);
  await editor.open(/^Edit$/);
  await editor.input().fill('E07');
  await editor.save();

  await expect(page.getByText('Seat saved: E07')).toBeVisible();
  expect((await readPlayer(playerId))!.seating).toBe('E07');

  await page.reload();
  await expect(page.locator('.mds-card', { hasText: 'Seat Desk Cup' }).first()).toContainText('E07');
});

test('the profile page’s seat editor can set a seat that was never assigned', async ({ page }) => {
  // No seat at signup: the empty state has to invite the player to set one, not hide the field.
  const { playerId } = await leoRegistered('Seat Profile Cup');
  expect((await readPlayer(playerId))!.seating).toBeNull();

  await loginAs(page, 'leo');
  await page.goto('/profile');

  const card = page.locator('.mds-card', { hasText: 'Seat Profile Cup' }).first();
  await expect(card).toContainText('No seat set');

  const editor = seatEditor(card);
  await editor.open(/Set your seat/i);
  await editor.input().fill('A01');
  await editor.save();

  await expect(page.getByText('Seat saved: A01')).toBeVisible();
  expect((await readPlayer(playerId))!.seating).toBe('A01');
});

test('Escape abandons a seat edit without writing anything', async ({ page }) => {
  const { tournamentId, playerId } = await leoRegistered('Seat Escape Cup', 'B12');
  await loginAs(page, 'leo');
  await page.goto(`/tournaments/${tournamentId}/register`);
  await expect(page.getByRole('heading', { name: 'Leo Legion' })).toBeVisible();

  const editor = seatEditor(page);
  await editor.open(/^Edit$/);
  await editor.input().fill('ZZ99');
  await editor.input().press('Escape');

  // The editor closes back to the read-only display of the *stored* seat.
  await expect(editor.input()).toBeHidden();
  await expect(page.getByRole('button', { name: /^Edit$/ })).toBeVisible();
  expect((await readPlayer(playerId))!.seating).toBe('B12');
});

test('saving an empty seat clears it rather than storing a blank', async ({ page }) => {
  const { tournamentId, playerId } = await leoRegistered('Seat Clear Cup', 'B12');
  await loginAs(page, 'leo');
  await page.goto(`/tournaments/${tournamentId}/register`);
  await expect(page.getByRole('heading', { name: 'Leo Legion' })).toBeVisible();

  const editor = seatEditor(page);
  await editor.open(/^Edit$/);
  await editor.input().fill('');
  await editor.save();

  await expect(page.getByText('Seat cleared')).toBeVisible();
  expect((await readPlayer(playerId))!.seating).toBeNull();
  // Whitespace is not a seat either — an empty value becomes null, not ' '.
  await expect(page.getByRole('listitem').filter({ hasText: 'Leo' })).toContainText('No seat');
});
