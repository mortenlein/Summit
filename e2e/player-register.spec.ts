import { expect, test, type Page } from '@playwright/test';
import { apiAs, disposeApiContexts, json } from './helpers/api';
import { createTournament, prisma, readPlayer, setRosterLocked } from './helpers/lan-seed';
import { loginAs, personaUserId, type Persona } from './helpers/auth';

/**
 * The register screen, from the player's side of the glass.
 *
 * `lan-registration.spec.ts` already pins the signup *contract* (who may read an invite code,
 * what a capacity refusal answers, when leaving 423s). This file is about whether a player can
 * actually complete the flow in a browser: the team panel, the invite link they have to hand a
 * teammate, the join form that link opens, the confirm dialog on leaving, and what the screen
 * does once the bracket locks the roster.
 */
test.describe.configure({ mode: 'serial' });
test.afterEach(disposeApiContexts);

/** A signup-enabled, two-per-team tournament — the LAN default for duos. */
async function duoTournament(name: string) {
  return createTournament({ name, teamSize: 2, steamSignupEnabled: true });
}

/** Drives the create-team form on the register page and waits for the team panel. */
async function registerTeam(page: Page, tournamentId: string, teamName: string, seat: string) {
  await page.goto(`/tournaments/${tournamentId}/register`);
  await page.getByPlaceholder('Enter unique team name').fill(teamName);
  await page.locator('#create-seating').fill(seat);
  await page.getByRole('button', { name: /Complete Registration/i }).click();
  // The confirmation header IS the team name now. "Du er påmeldt" over "Du er påmeldt med Team
  // Fjord." was word-for-word containment, and it pushed the seat down the page.
  await expect(page.getByRole('heading', { name: teamName })).toBeVisible();
}

/** The invite code the signup route minted for a persona's team. */
async function inviteCodeOf(persona: Persona, tournamentId: string) {
  const userId = await personaUserId(persona);
  const player = await prisma.player.findFirst({ where: { tournamentId, userId }, select: { teamId: true } });
  const team = await prisma.team.findUnique({ where: { id: player!.teamId }, select: { inviteCode: true } });
  return team!.inviteCode!;
}

test('creating a team in the browser shows the roster, the seat and a copyable invite link', async ({ page, context }) => {
  const tournament = await duoTournament('Browser Signup Cup');
  await loginAs(page, 'leo');
  // The copy button writes to the real clipboard on a secure origin; let the page have it so
  // the assertion can be "the link is on the clipboard", not just "a button exists".
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  await registerTeam(page, tournament.id, 'Leo Legion', 'B12');

  // Roster: one player, flagged as the viewer, sitting at the seat typed into the form.
  await expect(page.getByText('Roster (1/2)')).toBeVisible();
  const myRow = page.getByRole('listitem').filter({ hasText: 'Leo' });
  await expect(myRow).toContainText('You');
  await expect(myRow).toContainText('B12');

  // The invite link is the join credential and the only place it surfaces to a player.
  const inviteCode = await inviteCodeOf('leo', tournament.id);
  await expect(page.getByText(`/tournaments/${tournament.id}/register?invite=${inviteCode}`)).toBeVisible();
  await expect(page.getByText('1 slot left in the roster.')).toBeVisible();

  await page.getByRole('button', { name: /Copy Invite Link/i }).click();
  await expect(page.getByText('Invite link copied')).toBeVisible();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain(`/tournaments/${tournament.id}/register?invite=${inviteCode}`);
});

test('the invite link opens a join form, and the new teammate lands on the leader’s roster', async ({ page, browser }) => {
  const tournament = await duoTournament('Invite Link Cup');
  await loginAs(page, 'leo');
  await registerTeam(page, tournament.id, 'Leo Legion', 'B12');
  const inviteCode = await inviteCodeOf('leo', tournament.id);

  // Sam follows the link in his own browser context — a second identity, not a re-login.
  const samContext = await browser.newContext();
  const samPage = await samContext.newPage();
  try {
    await loginAs(samPage, 'sam');
    await samPage.goto(`/tournaments/${tournament.id}/register?invite=${inviteCode}`);

    await expect(samPage.getByRole('heading', { name: 'Join Existing Team' })).toBeVisible();
    await expect(samPage.getByText(inviteCode)).toBeVisible();
    await samPage.locator('#join-seating').fill('B13');
    await samPage.getByRole('button', { name: /Join Roster/i }).click();

    await expect(samPage.getByRole('heading', { name: 'Leo Legion' })).toBeVisible();
    await expect(samPage.getByText('Roster (2/2)')).toBeVisible();
    await expect(samPage.getByRole('listitem').filter({ hasText: 'Sam' })).toContainText('B13');
  } finally {
    await samContext.close();
  }

  // Leo reloads: his panel is the team view with both players on it, and the invite section is
  // gone because a full roster has nothing left to invite.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Leo Legion' })).toBeVisible();
  await expect(page.getByText('Roster (2/2)')).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'Sam' })).toContainText('B13');
  await expect(page.getByText('Invite Teammates')).toBeHidden();
});

test('a full team tells the third player so, instead of swallowing the refusal', async ({ page }) => {
  // BUG: register/page.tsx renders the `error` state ONLY inside the create-team <form> branch
  // (line 631). handleJoinTeam (line 178) sets exactly that state on a 400 — so on the invite
  // branch the "Team is already full" refusal is stored and never drawn, and the button just
  // stops spinning. Chloe has no idea why nothing happened.
  const tournament = await duoTournament('Full Team Cup');
  const leoApi = await apiAs('leo');
  const created = await json(
    await leoApi.post(`/api/tournaments/${tournament.id}/signup`, {
      data: { action: 'CREATE_TEAM', teamName: 'Leo Legion', seating: 'B12' },
    })
  );
  const samApi = await apiAs('sam');
  await samApi.post(`/api/tournaments/${tournament.id}/signup`, {
    data: { action: 'JOIN_TEAM', inviteCode: created.inviteCode, seating: 'B13' },
  });

  await loginAs(page, 'chloe');
  await page.goto(`/tournaments/${tournament.id}/register?invite=${created.inviteCode}`);
  await page.getByRole('button', { name: /Join Roster/i }).click();

  // Scoped to the form's own alert: the page names the tournament ("Full Team Cup") in its
  // header now, so a bare text match would pass on the heading without the refusal being drawn.
  await expect(page.getByTestId('register-error')).toContainText(/full/i);
});

test('leaving a team from the UI needs a confirmation and then really removes the player', async ({ page }) => {
  const tournament = await duoTournament('Leave Team Cup');
  const leoApi = await apiAs('leo');
  const created = await json(
    await leoApi.post(`/api/tournaments/${tournament.id}/signup`, {
      data: { action: 'CREATE_TEAM', teamName: 'Leo Legion', seating: 'B12' },
    })
  );

  await loginAs(page, 'sam');
  await page.goto(`/tournaments/${tournament.id}/register?invite=${created.inviteCode}`);
  await page.getByRole('button', { name: /Join Roster/i }).click();
  await expect(page.getByText('Roster (2/2)')).toBeVisible();

  const samUserId = await personaUserId('sam');
  const samPlayerId = (await prisma.player.findFirst({
    where: { tournamentId: tournament.id, userId: samUserId },
    select: { id: true },
  }))!.id;

  // Dismissing the confirm dialog must be a no-op, not a silent leave.
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: /Leave Team/i }).click();
  await expect(page.getByText('Roster (2/2)')).toBeVisible();
  expect(await readPlayer(samPlayerId)).not.toBeNull();

  page.once('dialog', (dialog) => {
    expect(dialog.message()).toMatch(/leave this team/i);
    return dialog.accept();
  });
  await page.getByRole('button', { name: /Leave Team/i }).click();

  // Back to the sign-up surface for this URL (an invite link, so the join form) with the team
  // panel gone — and the player row is deleted for real.
  await expect(page.getByText('You left the team')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Join Existing Team' })).toBeVisible();
  await expect(page.getByText(/^Roster \(/)).toBeHidden();
  expect(await readPlayer(samPlayerId)).toBeNull();
  // Leo's team survived — only Sam left it.
  const teams = await json<any[]>(await leoApi.get(`/api/tournaments/${tournament.id}/teams`));
  expect(teams.find((t) => t.id === created.id).players).toHaveLength(1);
});

test('a locked roster keeps the team panel and the seat editor but withdraws "leave team"', async ({ page }) => {
  const tournament = await duoTournament('Locked Roster Cup');
  const leoApi = await apiAs('leo');
  const created = await json(
    await leoApi.post(`/api/tournaments/${tournament.id}/signup`, {
      data: { action: 'CREATE_TEAM', teamName: 'Leo Legion', seating: 'B12' },
    })
  );
  await setRosterLocked(tournament.id, true);

  await loginAs(page, 'leo');
  await page.goto(`/tournaments/${tournament.id}/register`);

  // Already on a team → the team panel, never the "Registration Closed" notice.
  await expect(page.getByRole('heading', { name: 'Leo Legion' })).toBeVisible();
  await expect(page.getByText('Bracket is live — roster locked')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Registration Closed' })).toBeHidden();
  await expect(page.getByRole('button', { name: /Leave Team/i })).toBeHidden();
  // The invite link goes too: nobody may join a locked roster.
  await expect(page.getByText('Invite Teammates')).toBeHidden();

  // Seats still move on the LAN floor after the bracket exists, so this must keep working.
  await page.getByRole('button', { name: /^Edit$/ }).click();
  await page.getByLabel('Your seat').fill('D09');
  await page.getByRole('button', { name: /^Save$/ }).click();
  await expect(page.getByText('Seat saved: D09')).toBeVisible();
  expect((await readPlayer(created.players[0].id))!.seating).toBe('D09');
});

test('a visitor with no team hits the closed notice once the roster is locked', async ({ page }) => {
  const tournament = await duoTournament('Closed Notice Cup');
  await setRosterLocked(tournament.id, true);

  await loginAs(page, 'chloe');
  await page.goto(`/tournaments/${tournament.id}/register`);

  await expect(page.getByRole('heading', { name: 'Registration Closed' })).toBeVisible();
  await expect(page.getByPlaceholder('Enter unique team name')).toBeHidden();
});

test('an anonymous visitor gets the sign-in card on both kinds of tournament', async ({ page }) => {
  const steamSignup = await duoTournament('Anon Steam Cup');
  const manualEntry = await createTournament({
    name: 'Anon Manual Cup',
    teamSize: 2,
    steamSignupEnabled: false,
  });

  // Steam signup: invite links key off a Steam-linked account, so the gate says so.
  await page.goto(`/tournaments/${steamSignup.id}/register`);
  await expect(page.getByRole('heading', { name: 'Steam Verification Required' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Continue with Steam/i })).toBeVisible();
  await expect(page.getByPlaceholder('Enter unique team name')).toBeHidden();

  // Manual entry: same gate, different reason — every registration is tied to an account now.
  await page.goto(`/tournaments/${manualEntry.id}/register`);
  await expect(page.getByRole('heading', { name: 'Sign In Required' })).toBeVisible();
  await expect(page.getByPlaceholder('Enter unique team name')).toBeHidden();
});
