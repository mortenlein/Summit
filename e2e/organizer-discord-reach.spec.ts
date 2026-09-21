import { expect, test, type Page } from '@playwright/test';
import { apiAnon, apiAs, disposeApiContexts, json } from './helpers/api';
import {
  createTeam,
  createTournament,
  createUserRow,
  linkDiscord,
  readTournament,
  recordDmAttempt,
} from './helpers/lan-seed';
import { E2E_BASE_URL, loginAs, mintSessionToken } from './helpers/auth';

/**
 * The organizer reach panel — who Discord can actually be told.
 *
 * This is the anti-assumption surface, so the assertions are about what it refuses to claim:
 * a `DiscordLink` whose cached `dmState` says SENT with no `DiscordDmAttempt` behind it is NOT
 * counted as reachable, and a player Discord refused reads as blocked with a remedy, not as a
 * blank. The headline number counts proven sends only, and the crew list is everyone else.
 */
test.describe.configure({ mode: 'serial' });
test.afterEach(disposeApiContexts);

/**
 * Five players, one per reach state, on one roster:
 *
 *   sent        — linked + a LINK_PROBE Discord accepted           → the only reachable one
 *   unproven    — linked, dmState SENT, no attempt row at all      → must NOT count as reached
 *   blocked     — linked + a refused attempt, Discord code 50007   → blocked, fetch in person
 *   notLinked   — has a Summit account, no Discord link            → can still run /koble
 *   noAccount   — a name an organizer typed, no `Player.userId`    → no digital channel at all
 */
async function seedReachRoster() {
  const tournament = await createTournament({ name: `Reach Cup ${Date.now().toString(36)}`, teamSize: 5 });

  const sentUser = await createUserRow('Reach Sent');
  const unprovenUser = await createUserRow('Reach Unproven');
  const blockedUser = await createUserRow('Reach Blocked');
  const notLinkedUser = await createUserRow('Reach Unlinked');

  const sentLink = await linkDiscord(sentUser.id, { dmState: 'SENT', discordUsername: 'sentkid' });
  const unprovenLink = await linkDiscord(unprovenUser.id, { dmState: 'SENT', discordUsername: 'unprovenkid' });
  const blockedLink = await linkDiscord(blockedUser.id, { dmState: 'BLOCKED', discordUsername: 'blockedkid' });

  await recordDmAttempt(sentUser.id, sentLink.discordId, { outcome: 'SENT' });
  await recordDmAttempt(blockedUser.id, blockedLink.discordId, {
    outcome: 'BLOCKED',
    discordCode: 50007,
  });
  // `unprovenLink` deliberately gets no attempt row — that is the whole point of this fixture.

  const team = await createTeam(tournament.id, {
    name: 'Reach Squad',
    seed: 1,
    players: [
      { name: 'Sent Player', nickname: 'SentKid', seating: 'A01', userId: sentUser.id, isLeader: true },
      { name: 'Unproven Player', nickname: 'UnprovenKid', seating: 'A02', userId: unprovenUser.id },
      { name: 'Blocked Player', nickname: 'BlockedKid', seating: 'A03', userId: blockedUser.id },
      { name: 'Unlinked Player', nickname: 'UnlinkedKid', seating: 'A04', userId: notLinkedUser.id },
      { name: 'Typed Player', nickname: 'TypedKid', seating: 'A05' },
    ],
  });

  return {
    tournament,
    team,
    snowflakes: [sentLink.discordId, unprovenLink.discordId, blockedLink.discordId],
  };
}

async function openControl(page: Page, tournamentId: string) {
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.goto(`/admin/tournaments/${tournamentId}?tab=control`);
  await expect(page.getByTestId('discord-reach-panel')).toBeVisible();
}

const row = (page: Page, name: string) =>
  page.getByTestId('discord-reach-row').filter({ hasText: name });

test('the reach count counts proven sends only — a linked player with no attempt is not reached', async ({
  page,
}) => {
  const { tournament } = await seedReachRoster();
  await loginAs(page, 'marcus');
  await openControl(page, tournament.id);

  const panel = page.getByTestId('discord-reach-panel');
  // Five on the roster, exactly one of whom Discord has ever accepted a message for.
  await expect(page.getByTestId('discord-reach-summary')).toHaveText(
    '1 of 5 players can be reached on Discord'
  );

  // The "can be reached" list is that one player, and nobody else.
  const reachable = page.getByTestId('discord-reach-reachable');
  await expect(reachable.getByTestId('discord-reach-row')).toHaveCount(1);
  await expect(reachable).toContainText('SentKid');

  // Everyone else is on the crew's walking list, the unproven link included.
  const unreachable = page.getByTestId('discord-reach-unreachable');
  await expect(unreachable.getByTestId('discord-reach-row')).toHaveCount(4);
  await expect(unreachable).toContainText('UnprovenKid');
  await expect(unreachable).toContainText('TypedKid');

  // The caveat is part of the panel, permanently: it must not be dismissible.
  await expect(panel).toContainText('Discord is an extra alert. The crew still fetches everyone.');
  await expect(panel.getByRole('button', { name: /dismiss|close/i })).toHaveCount(0);

  // "Sent", never "delivered" — a 204 from Discord is not a kid reading a phone.
  const panelText = (await panel.innerText()).toLowerCase();
  for (const forbidden of ['delivered', 'levert', 'mottatt']) {
    expect(panelText).not.toContain(forbidden);
  }
});

test('a BLOCKED player reads as blocked with a remedy, and "never tried" is a different thing', async ({
  page,
}) => {
  const { tournament } = await seedReachRoster();
  await loginAs(page, 'marcus');
  await openControl(page, tournament.id);

  // Blocked: its own state, its own words, inside the fetch-in-person list.
  const blocked = row(page, 'BlockedKid');
  await expect(blocked).toHaveAttribute('data-state', 'LINKED_BLOCKED');
  await expect(blocked).toContainText('Blocked — they have DMs closed. Go and get them.');
  await expect(blocked).toContainText('Discord code 50007');
  await expect(page.getByTestId('discord-reach-unreachable').getByTestId('discord-reach-row').first()).toContainText(
    'TypedKid'
  );

  // Never tried is not the same as refused: no attempt row, so no outcome is claimed.
  const unproven = row(page, 'UnprovenKid');
  await expect(unproven).toHaveAttribute('data-state', 'LINKED_UNCONFIRMED');
  await expect(unproven).toContainText('Never tried.');
  await expect(unproven).not.toContainText('Blocked');

  // And the player an organizer typed in has no account at all — a third, distinct remedy.
  await expect(row(page, 'TypedKid')).toHaveAttribute('data-state', 'NO_ACCOUNT');
  await expect(row(page, 'UnlinkedKid')).toHaveAttribute('data-state', 'NOT_LINKED');
  await expect(row(page, 'SentKid')).toHaveAttribute('data-state', 'LINKED_SENT');
});

test('the pause kill switch round-trips to the database and survives a reload', async ({ page }) => {
  const { tournament } = await seedReachRoster();
  await loginAs(page, 'marcus');
  await openControl(page, tournament.id);

  const panel = page.getByTestId('discord-reach-panel');
  const toggle = page.getByTestId('discord-reach-pause');
  await expect(panel).toContainText('DMs on');
  await expect(toggle).toHaveText('Pause DMs');
  expect((await readTournament(tournament.id)).discordDmPaused).toBe(false);

  await toggle.click();
  await expect(panel).toContainText('DMs paused');
  await expect(toggle).toHaveText('Resume DMs');
  await expect.poll(async () => (await readTournament(tournament.id)).discordDmPaused).toBe(true);

  // An organizer who flips this on a phone and then opens the laptop must see the same thing.
  await openControl(page, tournament.id);
  await expect(panel).toContainText('DMs paused');

  await toggle.click();
  await expect(panel).toContainText('DMs on');
  await expect.poll(async () => (await readTournament(tournament.id)).discordDmPaused).toBe(false);
});

test('the reach payload is staff-only and carries no Discord id for any player', async ({ page }) => {
  const { tournament, snowflakes } = await seedReachRoster();
  const route = `/api/tournaments/${tournament.id}/discord-reach`;

  const marcus = await apiAs('marcus');
  const response = await marcus.get(route);
  expect(response.status()).toBe(200);
  const body = await json<any>(response);
  expect(body.summary).toMatchObject({ total: 5, reachable: 1, blocked: 1, noAccount: 1, notLinked: 1 });
  expect(body.players).toHaveLength(5);

  // Not one snowflake, anywhere in the payload — not on a row, not in an attempt.
  const raw = JSON.stringify(body);
  for (const snowflake of snowflakes) {
    expect(raw).not.toContain(snowflake);
  }
  for (const player of body.players) {
    expect('discordId' in player).toBe(false);
    expect('steamId' in player).toBe(false);
    if (player.lastAttempt) expect('discordId' in player.lastAttempt).toBe(false);
  }

  // Floor staff may read it and may hit the kill switch; a player and a stranger may do neither.
  const mia = await apiAs('mia');
  expect((await mia.get(route)).status()).toBe(200);

  const leo = await apiAs('leo');
  expect((await leo.get(route)).status()).toBe(401);
  expect((await leo.post(route, { data: { dmPaused: true } })).status()).toBe(401);

  const anon = await apiAnon();
  expect((await anon.get(route)).status()).toBe(401);
  expect((await anon.post(route, { data: { dmPaused: true } })).status()).toBe(401);

  // The refusals changed nothing.
  expect((await readTournament(tournament.id)).discordDmPaused).toBe(false);

  // And a bad body is a 400, not a silent no-op that looks like a working kill switch.
  expect((await marcus.post(route, { data: { dmPaused: 'yes' } })).status()).toBe(400);

  await page.close();
});

test('the kill switch is usable on a phone — that is where an organizer flips it', async ({ page }) => {
  const { tournament } = await seedReachRoster();
  await loginAs(page, 'marcus');

  // A mid-size Android, held in one hand on the tournament floor.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/admin/tournaments/${tournament.id}?tab=control`);

  const panel = page.getByTestId('discord-reach-panel');
  await expect(panel).toBeVisible();
  const toggle = page.getByTestId('discord-reach-pause');
  await expect(toggle).toBeVisible();

  // It is a real thumb target, not a 20px link.
  const box = (await toggle.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(40);

  await toggle.click();
  await expect(panel).toContainText('DMs paused');
  await expect.poll(async () => (await readTournament(tournament.id)).discordDmPaused).toBe(true);

  // The headline still answers the question at this width.
  await expect(page.getByTestId('discord-reach-summary')).toHaveText(
    '1 of 5 players can be reached on Discord'
  );
});

test('the panel reads as Norwegian for a Norwegian organizer', async ({ browser }) => {
  const { tournament } = await seedReachRoster();
  // A fresh context, no English pin: this is what the club actually sees.
  const ctx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    locale: 'nb-NO',
    extraHTTPHeaders: { 'accept-language': 'nb-NO' },
    viewport: { width: 1280, height: 1400 },
  });
  await ctx.addCookies([
    { name: 'next-auth.session-token', value: await mintSessionToken('marcus'), url: E2E_BASE_URL },
  ]);
  const page = await ctx.newPage();
  await page.goto(`/admin/tournaments/${tournament.id}?tab=control`);

  const panel = page.getByTestId('discord-reach-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('discord-reach-summary')).toHaveText(
    '1 av 5 spillere kan nås på Discord'
  );
  await expect(panel).toContainText('Discord er et ekstra varsel. Crewet henter fortsatt alle.');
  await expect(panel).toContainText('Blokkert — de har skrudd av DM. Gå og hent spilleren.');
  await expect(page.getByTestId('discord-reach-pause')).toHaveText('Pause DM');

  // "Sendt", never "levert": the Norwegian half of the same promise.
  const text = (await panel.innerText()).toLowerCase();
  for (const forbidden of ['levert', 'mottatt', 'delivered']) {
    expect(text).not.toContain(forbidden);
  }
  await ctx.close();
});
