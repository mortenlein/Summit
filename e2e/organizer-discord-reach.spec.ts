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
 * counted as reachable, a row written by an intercepted send is NOT counted either, and a
 * player Discord refused reads as blocked with a remedy, not as a blank. The headline number
 * counts proven sends only, and the crew list is everyone else.
 *
 * Note the harness itself: `playwright.config.ts` sets `NEXT_PUBLIC_STRATEGY_3_MOCK=true`, so
 * the app under test *cannot* talk to Discord — which is also the state production on `ash` is
 * in today (no `DISCORD_*` in `.env`, spec §2). The panel has to say so instead of printing
 * "can be reached on Discord" about a channel that is not configured, and these tests pin that.
 */
test.describe.configure({ mode: 'serial' });
test.afterEach(disposeApiContexts);

/** What the headline reads in this harness, where Discord is not configured. */
const SUMMARY_UNCONFIGURED =
  '1 of 7 players have had a message accepted before — but Discord is not set up here, so nothing goes out now';

/**
 * Seven players, one per reach state, on one roster:
 *
 *   sent        — linked + a LINK_PROBE Discord accepted           → the only reachable one
 *   unproven    — linked, dmState SENT, no attempt row at all      → must NOT count as reached
 *   blocked     — linked + a refused attempt, Discord code 50007   → blocked, fetch in person
 *   notLinked   — has a Summit account, no Discord link            → can still run /koble
 *   noAccount   — a name an organizer typed, no `Player.userId`    → no digital channel at all
 *   simulated   — an attempt row from an intercepted send          → nothing was sent, not green
 *   staleSent   — an old accepted attempt, a NEWER cached refusal  → blocked, not reachable
 */
async function seedReachRoster() {
  const tournament = await createTournament({ name: `Reach Cup ${Date.now().toString(36)}`, teamSize: 5 });

  const sentUser = await createUserRow('Reach Sent');
  const unprovenUser = await createUserRow('Reach Unproven');
  const blockedUser = await createUserRow('Reach Blocked');
  const notLinkedUser = await createUserRow('Reach Unlinked');
  const simulatedUser = await createUserRow('Reach Simulated');
  const staleUser = await createUserRow('Reach Stale');

  const sentLink = await linkDiscord(sentUser.id, { dmState: 'SENT', discordUsername: 'sentkid' });
  const unprovenLink = await linkDiscord(unprovenUser.id, { dmState: 'SENT', discordUsername: 'unprovenkid' });
  const blockedLink = await linkDiscord(blockedUser.id, { dmState: 'BLOCKED', discordUsername: 'blockedkid' });
  const simulatedLink = await linkDiscord(simulatedUser.id, {
    dmState: 'UNKNOWN',
    discordUsername: 'simulatedkid',
  });
  // The cache learned about the refusal *after* the accepted attempt below: they closed their
  // DMs between the two. The newer fact has to win.
  const staleLink = await linkDiscord(staleUser.id, {
    dmState: 'BLOCKED',
    dmCheckedAt: new Date(),
    discordUsername: 'stalekid',
  });

  await recordDmAttempt(sentUser.id, sentLink.discordId, { outcome: 'SENT' });
  await recordDmAttempt(blockedUser.id, blockedLink.discordId, {
    outcome: 'BLOCKED',
    discordCode: 50007,
  });
  // What the app writes when it cannot actually talk to Discord: a row that records that
  // nothing was sent. It is evidence of a non-send, and must never be counted as reach.
  await recordDmAttempt(simulatedUser.id, simulatedLink.discordId, { outcome: 'MOCKED' });
  await recordDmAttempt(staleUser.id, staleLink.discordId, {
    outcome: 'SENT',
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
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
      { name: 'Simulated Player', nickname: 'SimulatedKid', seating: 'A06', userId: simulatedUser.id },
      { name: 'Stale Player', nickname: 'StaleKid', seating: 'A07', userId: staleUser.id },
    ],
  });

  return {
    tournament,
    team,
    snowflakes: [
      sentLink.discordId,
      unprovenLink.discordId,
      blockedLink.discordId,
      simulatedLink.discordId,
      staleLink.discordId,
    ],
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
  // Seven on the roster, exactly one of whom Discord has ever accepted a message for — and the
  // sentence is past tense, because this deployment cannot send anything right now.
  await expect(page.getByTestId('discord-reach-summary')).toHaveText(SUMMARY_UNCONFIGURED);

  // The "can be reached" list is that one player, and nobody else.
  const reachable = page.getByTestId('discord-reach-reachable');
  await expect(reachable.getByTestId('discord-reach-row')).toHaveCount(1);
  await expect(reachable).toContainText('SentKid');

  // Everyone else is on the crew's walking list, the unproven link included.
  const unreachable = page.getByTestId('discord-reach-unreachable');
  await expect(unreachable.getByTestId('discord-reach-row')).toHaveCount(6);
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

test('an intercepted send is never counted as reach, and says so in its own words', async ({ page }) => {
  const { tournament } = await seedReachRoster();
  await loginAs(page, 'marcus');
  await openControl(page, tournament.id);

  const panel = page.getByTestId('discord-reach-panel');

  // The deployment cannot talk to Discord, and the panel leads with that rather than letting an
  // organizer read the roster below as a live picture.
  await expect(page.getByTestId('discord-reach-sendmode')).toContainText(
    'Discord is not set up on this server'
  );

  // The row whose only evidence is an intercepted send is unproven, not sent — and not in the
  // reachable list.
  const simulated = row(page, 'SimulatedKid');
  await expect(simulated).toHaveAttribute('data-state', 'LINKED_UNCONFIRMED');
  await expect(simulated).toContainText('not sent — Discord was not set up');
  await expect(simulated).not.toContainText('accepted by Discord');
  await expect(page.getByTestId('discord-reach-unreachable')).toContainText('SimulatedKid');
  await expect(page.getByTestId('discord-reach-reachable')).not.toContainText('SimulatedKid');

  // It is also not an "error": nothing failed, nothing was attempted.
  await expect(panel).not.toContainText('Last attempt: link check — error');
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

test('a stale accepted attempt cannot outrank a newer refusal', async ({ page }) => {
  const { tournament } = await seedReachRoster();
  await loginAs(page, 'marcus');
  await openControl(page, tournament.id);

  // This player has a SENT attempt row from two hours ago and a refusal the link cache learned
  // about since. They closed their DMs in between, so they are not reachable now.
  const stale = row(page, 'StaleKid');
  await expect(stale).toHaveAttribute('data-state', 'LINKED_BLOCKED');
  await expect(stale).toContainText('Blocked — they have DMs closed. Go and get them.');
  await expect(page.getByTestId('discord-reach-reachable')).not.toContainText('StaleKid');

  const marcus = await apiAs('marcus');
  const body = await json<any>(await marcus.get(`/api/tournaments/${tournament.id}/discord-reach`));
  expect(body.summary).toMatchObject({ total: 7, reachable: 1, blocked: 2, unconfirmed: 2 });
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

  // And with the switch off, the headline stops claiming anyone can be reached: the number is
  // history, and the sentence says so.
  await expect(page.getByTestId('discord-reach-summary')).toHaveText(
    'DMs are paused — 1 of 7 players have had a message accepted before, but nothing is going out now'
  );

  // An organizer who flips this on a phone and then opens the laptop must see the same thing.
  await openControl(page, tournament.id);
  await expect(panel).toContainText('DMs paused');

  await toggle.click();
  await expect(panel).toContainText('DMs on');
  await expect.poll(async () => (await readTournament(tournament.id)).discordDmPaused).toBe(false);
  await expect(page.getByTestId('discord-reach-summary')).toHaveText(SUMMARY_UNCONFIGURED);
});

test('a kill switch that does not take says so instead of looking flipped', async ({ page }) => {
  const { tournament } = await seedReachRoster();
  await loginAs(page, 'marcus');
  await openControl(page, tournament.id);

  // The organizer taps Pause on the floor and the write fails (tunnel drops, server restarts).
  await page.route(`**/api/tournaments/${tournament.id}/discord-reach`, async (route) => {
    if (route.request().method() === 'POST') return route.abort('failed');
    return route.fallback();
  });

  await page.getByTestId('discord-reach-pause').click();

  // Loud, and still showing the state the database last confirmed — never a silent no-op that
  // leaves someone believing DMs are off.
  await expect(page.getByTestId('discord-reach-toggle-failed')).toContainText('That did not take');
  await expect(page.getByTestId('discord-reach-pause')).toHaveText('Pause DMs');
  await expect(page.getByTestId('discord-reach-panel')).toContainText('DMs on');
  expect((await readTournament(tournament.id)).discordDmPaused).toBe(false);
});

test('the reach payload is staff-only and carries no Discord id for any player', async ({ page }) => {
  const { tournament, snowflakes } = await seedReachRoster();
  const route = `/api/tournaments/${tournament.id}/discord-reach`;

  const marcus = await apiAs('marcus');
  const response = await marcus.get(route);
  expect(response.status()).toBe(200);
  const body = await json<any>(response);
  expect(body.summary).toMatchObject({ total: 7, reachable: 1, blocked: 2, noAccount: 1, notLinked: 1 });
  expect(body.players).toHaveLength(7);
  // The payload says out loud that this deployment cannot send, so no client can render a live
  // claim off it.
  expect(body.sendMode).toBe('SIMULATED');

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

  // A full-width, 44px thumb target — the house minimum for a control someone taps while
  // walking, asserted without relying on `@media (pointer: coarse)` being true in the harness.
  const box = (await toggle.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.width).toBeGreaterThanOrEqual(240);

  // And nothing overflows the phone: no horizontal scroll on the panel.
  const overflows = await panel.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  expect(overflows).toBe(false);

  await toggle.click();
  await expect(panel).toContainText('DMs paused');
  await expect.poll(async () => (await readTournament(tournament.id)).discordDmPaused).toBe(true);

  // The headline still answers the question at this width.
  await expect(page.getByTestId('discord-reach-summary')).toHaveText(
    'DMs are paused — 1 of 7 players have had a message accepted before, but nothing is going out now'
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
    '1 av 7 spillere har fått en melding godtatt før — men Discord er ikke satt opp her, så ingenting går ut nå'
  );
  await expect(panel).toContainText('Discord er et ekstra varsel. Crewet henter fortsatt alle.');
  await expect(panel).toContainText('Blokkert — de har skrudd av DM. Gå og hent spilleren.');
  await expect(panel).toContainText('ikke sendt — Discord var ikke satt opp');
  await expect(page.getByTestId('discord-reach-pause')).toHaveText('Pause DM');

  // "Sendt", never "levert": the Norwegian half of the same promise.
  const text = (await panel.innerText()).toLowerCase();
  for (const forbidden of ['levert', 'mottatt', 'delivered']) {
    expect(text).not.toContain(forbidden);
  }
  await ctx.close();
});
