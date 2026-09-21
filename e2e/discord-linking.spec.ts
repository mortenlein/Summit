import { expect, test } from '@playwright/test';
import { apiAnon, apiAs, disposeApiContexts, json } from './helpers/api';
import { createTeam, createTournament, prisma } from './helpers/lan-seed';
import { loginAs, mintSessionToken, personaUserId } from './helpers/auth';

/**
 * `/koble` — account linking, the app half.
 *
 * The bot is a dumb mouth: it posts what the kid typed to `/api/discord/link` and prints the
 * string this app composes. So everything that matters about linking — the code, the conflict
 * rules, the language of the reply, the proof that a DM was even attempted — is assertable
 * here, with no gateway, no guild and (deliberately) no Discord token in the loop.
 *
 * Mirrors playwright.config.ts. Hardcoded rather than read from process.env, which isn't
 * reliably propagated into Playwright worker processes (see helpers/auth.ts for the same note).
 */
const BOT_KEY = 'e2e-summit-bot-key';
const INVITE_URL = 'https://discord.gg/e2e-6614gamers';

/** The unambiguous alphabet: no O/0, no I/1/L, no vowels, so a code can never spell a word. */
const CODE_SHAPE = /^[23456789BCDFGHJKMNPQRSTVWXYZ]{6}$/;

/** Snowflakes, not names: a Discord id is 17-20 digits and nothing else is an account. */
const LEO_DISCORD = '300000000000000001';
const LEO_DISCORD_TWO = '300000000000000002';
const SAM_DISCORD = '300000000000000003';
/** The one the mock probe refuses with 50007 (DISCORD_DM_MOCK_BLOCKED in playwright.config.ts). */
const DMS_CLOSED_DISCORD = '300000000000000900';

test.describe.configure({ mode: 'serial' });
test.afterEach(disposeApiContexts);

/** A call as the bot would make it, over the compose network, with the bearer it was given. */
async function botPost(path: string, data: unknown, key: string | null = BOT_KEY) {
  const anon = await apiAnon();
  return anon.post(path, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    data: data as any,
  });
}

async function resetDiscord(userId: string) {
  await prisma.discordDmAttempt.deleteMany({ where: { userId } });
  await prisma.discordLink.deleteMany({ where: { userId } });
  await prisma.discordLinkCode.deleteMany({ where: { userId } });
}

async function issueCodeAs(persona: 'leo' | 'sam' | 'chloe' | 'toby'): Promise<string> {
  const api = await apiAs(persona);
  const res = await api.post('/api/me/discord/code');
  expect(res.status()).toBe(200);
  const body = await json<{ code: string }>(res);
  return body.code;
}

test('a player mints a code, and a second request replaces it rather than erroring', async () => {
  await mintSessionToken('leo');
  const leoId = await personaUserId('leo');
  await resetDiscord(leoId);

  const first = await issueCodeAs('leo');
  expect(first).toMatch(CODE_SHAPE);

  const second = await issueCodeAs('leo');
  expect(second).toMatch(CODE_SHAPE);
  expect(second).not.toBe(first);

  // One live code per user — the @unique on userId, upserted rather than refused.
  const rows = await prisma.discordLinkCode.findMany({ where: { userId: leoId } });
  expect(rows).toHaveLength(1);
  expect(rows[0].code).toBe(second);
  expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now());

  // The old code is dead the moment the new one is written.
  const stale = await botPost('/api/discord/link', {
    code: first,
    discordId: LEO_DISCORD,
    discordUsername: 'leo_6614',
  });
  expect(await json(stale)).toMatchObject({ ok: false, reason: 'unknown_code' });
});

test('the state endpoint reports the live code and never leaks a Discord id', async () => {
  const leoId = await personaUserId('leo');
  const api = await apiAs('leo');
  const res = await api.get('/api/me/discord');
  expect(res.status()).toBe(200);

  const body = await json<any>(res);
  expect(body.configured).toBe(true);
  expect(body.linked).toBe(false);
  expect(body.inviteUrl).toBe(INVITE_URL);
  expect(body.code).toMatch(CODE_SHAPE);
  // Payload hygiene: the snowflake is server-side only, for the owner of it too.
  expect(Object.keys(body)).not.toContain('discordId');
  expect(await prisma.discordLinkCode.count({ where: { userId: leoId } })).toBe(1);
});

test('the bot callbacks are bearer-gated', async () => {
  const code = await issueCodeAs('leo');

  const unsigned = await botPost('/api/discord/link', { code, discordId: LEO_DISCORD }, null);
  expect(unsigned.status()).toBe(401);

  const wrong = await botPost('/api/discord/link', { code, discordId: LEO_DISCORD }, 'not-the-key');
  expect(wrong.status()).toBe(401);

  const optout = await botPost('/api/discord/optout', { discordId: LEO_DISCORD }, 'not-the-key');
  expect(optout.status()).toBe(401);

  // A refused call writes nothing at all.
  const leoId = await personaUserId('leo');
  expect(await prisma.discordLink.count({ where: { userId: leoId } })).toBe(0);
});

test('an unknown code is refused, and nothing is written', async () => {
  const before = await prisma.discordLink.count();
  const res = await botPost('/api/discord/link', {
    code: 'ZZZZZZ',
    discordId: LEO_DISCORD,
    discordUsername: 'leo_6614',
  });
  expect(res.status()).toBe(200);
  const body = await json<any>(res);
  expect(body).toMatchObject({ ok: false, reason: 'unknown_code' });
  // A refusal the kid can act on, not a stack trace. There is no user behind an unknown code,
  // so it is written in the house language: this is a Norwegian club.
  expect(body.reply).toContain('Profil');
  expect(await prisma.discordLink.count()).toBe(before);
});

test('an expired code is refused and is spent', async () => {
  const leoId = await personaUserId('leo');
  const code = await issueCodeAs('leo');
  await prisma.discordLinkCode.update({
    where: { userId: leoId },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });

  const res = await botPost('/api/discord/link', {
    code,
    discordId: LEO_DISCORD,
    discordUsername: 'leo_6614',
  });
  expect(await json(res)).toMatchObject({ ok: false, reason: 'unknown_code' });

  // Spent, not left lying around: an expired code must not stay guessable.
  expect(await prisma.discordLinkCode.count({ where: { userId: leoId } })).toBe(0);
  expect(await prisma.discordLink.count({ where: { userId: leoId } })).toBe(0);
});

test('the happy path writes the link, probes the DM, and replies in the player\'s own language', async () => {
  const leoId = await personaUserId('leo');
  await resetDiscord(leoId);
  // A Norwegian player. Most of the cohort never touches the switch, but this one did.
  await prisma.user.update({ where: { id: leoId }, data: { locale: 'nb' } });

  // The bot says who it just linked, and the name a kid recognises is the one on the floor —
  // their nickname on their newest roster row, not the Steam account name.
  const tournament = await createTournament({ name: 'Discord link cup' });
  await createTeam(tournament.id, {
    name: 'Koble FC',
    players: [{ name: 'Leo Larsen', nickname: 'LeoTheKid', userId: leoId }],
  });

  const code = await issueCodeAs('leo');
  const res = await botPost('/api/discord/link', {
    code,
    discordId: LEO_DISCORD,
    discordUsername: 'leo_6614',
  });
  const body = await json<any>(res);

  expect(body.ok).toBe(true);
  expect(body.name).toBe('LeoTheKid');
  expect(body.locale).toBe('nb');
  expect(body.relinked).toBe(false);
  // The bot prints this verbatim — every Norwegian character stays in messages/.
  expect(body.reply).toContain('Koblet!');
  expect(body.reply).toContain('LeoTheKid');

  const link = await prisma.discordLink.findUnique({ where: { userId: leoId } });
  expect(link).toMatchObject({
    discordId: LEO_DISCORD,
    discordUsername: 'leo_6614',
    optOut: false,
    dmState: 'SENT',
  });
  expect(link?.dmCheckedAt).not.toBeNull();

  // The code is spent in the same transaction as the link.
  expect(await prisma.discordLinkCode.count({ where: { userId: leoId } })).toBe(0);

  // Nothing may claim a player was reached without a row here.
  const attempts = await prisma.discordDmAttempt.findMany({ where: { userId: leoId } });
  expect(attempts).toHaveLength(1);
  expect(attempts[0]).toMatchObject({
    event: 'LINK_PROBE',
    outcome: 'SENT',
    matchId: null,
    locale: 'nb',
    discordId: LEO_DISCORD,
  });

  // Put the roster back: the seeds here only *add*, and a stray registration on this persona
  // would follow them into every later spec's desk.
  await prisma.tournament.delete({ where: { id: tournament.id } });
});

test('an English player gets the English reply for the same flow', async () => {
  await mintSessionToken('sam');
  const samId = await personaUserId('sam');
  await resetDiscord(samId);
  await prisma.user.update({ where: { id: samId }, data: { locale: 'en' } });

  const code = await issueCodeAs('sam');
  const res = await botPost('/api/discord/link', {
    code,
    discordId: SAM_DISCORD,
    discordUsername: 'sam_6614',
  });
  const body = await json<any>(res);

  expect(body.ok).toBe(true);
  expect(body.locale).toBe('en');
  expect(body.reply).toContain('Linked!');
  expect(body.reply).not.toContain('Koblet');
});

test('re-running /koble with the same Discord account is idempotent, never a conflict', async () => {
  const leoId = await personaUserId('leo');
  const code = await issueCodeAs('leo');

  const res = await botPost('/api/discord/link', {
    code,
    discordId: LEO_DISCORD,
    discordUsername: 'leo_renamed',
  });
  const body = await json<any>(res);

  // This is the recovery path the copy promises ("kjør /koble på nytt") — it must not
  // dead-end in discord_taken just because the snowflake is already bound to this same kid.
  expect(body.ok).toBe(true);
  expect(body.reason).toBeUndefined();
  expect(body.relinked).toBe(false);

  const links = await prisma.discordLink.findMany({ where: { userId: leoId } });
  expect(links).toHaveLength(1);
  expect(links[0].discordUsername).toBe('leo_renamed');
  // One probe per redemption, and a LINK_PROBE never collides with the previous one.
  expect(await prisma.discordDmAttempt.count({ where: { userId: leoId } })).toBe(2);
});

test('linking a different Discord account replaces the old binding and says so', async () => {
  const leoId = await personaUserId('leo');
  const code = await issueCodeAs('leo');

  const res = await botPost('/api/discord/link', {
    code,
    discordId: LEO_DISCORD_TWO,
    discordUsername: 'leo_new_account',
  });
  const body = await json<any>(res);
  expect(body.ok).toBe(true);
  expect(body.relinked).toBe(true);

  const links = await prisma.discordLink.findMany({ where: { userId: leoId } });
  expect(links).toHaveLength(1);
  expect(links[0].discordId).toBe(LEO_DISCORD_TWO);
  // A cached DM channel from the previous account would be actively wrong.
  expect(links[0].dmChannelId).toBeNull();
});

test('a Discord account bound to someone else is refused, and the first link is untouched', async () => {
  await mintSessionToken('chloe');
  const chloeId = await personaUserId('chloe');
  await resetDiscord(chloeId);

  const code = await issueCodeAs('chloe');
  const res = await botPost('/api/discord/link', {
    code,
    discordId: LEO_DISCORD_TWO,
    discordUsername: 'chloe_trying_leos_account',
  });
  const body = await json<any>(res);

  expect(body).toMatchObject({ ok: false, reason: 'discord_taken' });
  // The refusal names the remedy rather than leaving the kid nowhere to go.
  expect(body.reply).toContain('crew');

  // Refused, not stolen: silent stealing stops the first player's DMs with no signal anywhere.
  const leoId = await personaUserId('leo');
  const leoLink = await prisma.discordLink.findUnique({ where: { userId: leoId } });
  expect(leoLink?.discordId).toBe(LEO_DISCORD_TWO);
  expect(leoLink?.discordUsername).toBe('leo_new_account');
  expect(await prisma.discordLink.count({ where: { userId: chloeId } })).toBe(0);
  // Her code survives, so she can still link her own account.
  expect(await prisma.discordLinkCode.count({ where: { userId: chloeId } })).toBe(1);
});

test('opting out is honoured, and turning DMs back on is one PATCH away', async () => {
  const leoId = await personaUserId('leo');

  const res = await botPost('/api/discord/optout', { discordId: LEO_DISCORD_TWO });
  const body = await json<any>(res);
  expect(body.ok).toBe(true);
  expect(body.reply.length).toBeGreaterThan(0);
  expect((await prisma.discordLink.findUnique({ where: { userId: leoId } }))?.optOut).toBe(true);

  // A second tap on the button is a no-op, not a 500.
  const again = await botPost('/api/discord/optout', { discordId: LEO_DISCORD_TWO });
  expect(await json(again)).toMatchObject({ ok: true });

  // An unknown account is a refusal the bot can print, not an error.
  const unknown = await botPost('/api/discord/optout', { discordId: '300000000000000999' });
  expect(await json(unknown)).toMatchObject({ ok: false, reason: 'not_linked' });

  const api = await apiAs('leo');
  const patched = await api.patch('/api/me/discord', { data: { optOut: false } });
  expect(patched.status()).toBe(200);
  expect((await prisma.discordLink.findUnique({ where: { userId: leoId } }))?.optOut).toBe(false);
});

test('re-linking clears an opt-out, because running /koble again is asking for DMs', async () => {
  const leoId = await personaUserId('leo');
  await prisma.discordLink.updateMany({ where: { userId: leoId }, data: { optOut: true } });

  const code = await issueCodeAs('leo');
  const res = await botPost('/api/discord/link', {
    code,
    discordId: LEO_DISCORD_TWO,
    discordUsername: 'leo_new_account',
  });
  expect(await json(res)).toMatchObject({ ok: true });
  expect((await prisma.discordLink.findUnique({ where: { userId: leoId } }))?.optOut).toBe(false);
});

test('a player whose DMs are closed still links — and is told so, with a way back', async ({
  page,
}) => {
  await mintSessionToken('toby');
  const tobyId = await personaUserId('toby');
  await resetDiscord(tobyId);
  await prisma.user.update({ where: { id: tobyId }, data: { locale: 'en' } });

  const code = await issueCodeAs('toby');
  const res = await botPost('/api/discord/link', {
    code,
    // The mock probe refuses this snowflake with Discord's real 50007.
    discordId: DMS_CLOSED_DISCORD,
    discordUsername: 'toby_6614',
  });
  const body = await json<any>(res);

  // The link still stands: the address is right, the door is shut.
  expect(body.ok).toBe(true);
  expect(body.dmState).toBe('BLOCKED');
  expect(body.reply).toContain("I can't DM you");

  const link = await prisma.discordLink.findUnique({ where: { userId: tobyId } });
  expect(link?.dmState).toBe('BLOCKED');
  expect(link?.dmError).toBe('50007');

  // The attempt row carries Discord's own code — the UI must never guess at the cause.
  const attempts = await prisma.discordDmAttempt.findMany({ where: { userId: tobyId } });
  expect(attempts).toHaveLength(1);
  expect(attempts[0]).toMatchObject({ event: 'LINK_PROBE', outcome: 'BLOCKED', discordCode: 50007 });

  // And the card says it in the player's language, with the code for another run.
  await loginAs(page, 'toby');
  await page.goto('/profile');
  const card = page.getByTestId('discord-link-card');
  await expect(card).toContainText("I can't DM you");
  await expect(page.getByTestId('discord-get-code')).toBeVisible();
});

test('a player can unlink themselves, and a second unlink is a no-op', async () => {
  const leoId = await personaUserId('leo');
  const api = await apiAs('leo');

  const first = await api.delete('/api/me/discord');
  expect(first.status()).toBe(200);
  expect(await json(first)).toMatchObject({ success: true, removed: 1 });
  expect(await prisma.discordLink.count({ where: { userId: leoId } })).toBe(0);

  const second = await api.delete('/api/me/discord');
  expect(second.status()).toBe(200);
  expect(await json(second)).toMatchObject({ success: true, removed: 0 });
});

test('the link routes are closed to anonymous callers', async () => {
  const anon = await apiAnon();
  expect((await anon.post('/api/me/discord/code')).status()).toBe(401);
  expect((await anon.get('/api/me/discord')).status()).toBe(401);
  expect((await anon.delete('/api/me/discord')).status()).toBe(401);
});

test('the profile card walks a player through it, and flips to linked while they watch', async ({
  page,
}) => {
  const leoId = await personaUserId('leo');
  await resetDiscord(leoId);
  await prisma.user.update({ where: { id: leoId }, data: { locale: null } });
  await loginAs(page, 'leo');

  // The copy button must hand over the bare code: pasting "/koble H7K2QP" sends a plain text
  // message, because Discord's autocomplete only fires on a typed slash.
  await page.addInitScript(() => {
    (window as any).__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void (window as any).__copied.push(text) },
    });
  });

  await page.goto('/profile');
  const card = page.getByTestId('discord-link-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Link Discord');

  await page.getByTestId('discord-get-code').click();

  const code = page.getByTestId('discord-link-code');
  await expect(code).toBeVisible();
  const shown = (await code.innerText()).trim();
  expect(shown).toMatch(CODE_SHAPE);
  // Read off a screen and retyped, so it gets the mono face where 0/O cannot be confused.
  await expect(code).toHaveClass(/mds-numeric/);

  // Join the server, then the command, then the code — a kid who was never added to the guild
  // has no path at all otherwise.
  const text = await card.innerText();
  expect(text.indexOf('Join the Discord server')).toBeGreaterThanOrEqual(0);
  expect(text.indexOf('Join the Discord server')).toBeLessThan(text.indexOf('/koble'));
  expect(text.indexOf('/koble')).toBeLessThan(text.indexOf(shown));
  await expect(page.getByTestId('discord-invite')).toHaveAttribute('href', INVITE_URL);

  await page.getByTestId('discord-copy').click();
  expect(await page.evaluate(() => (window as any).__copied)).toEqual([shown]);

  // Never a staffing decision: the caveat is on the card and is not dismissible.
  expect(text).toContain('Discord is an extra alert');

  // Now the bot redeems it, in the other application. The card must notice on its own —
  // otherwise the kid tabs back to a stale code and concludes it failed.
  const redeemed = await botPost('/api/discord/link', {
    code: shown,
    discordId: LEO_DISCORD,
    discordUsername: 'leo_6614',
  });
  expect(await json(redeemed)).toMatchObject({ ok: true });

  await expect(page.getByTestId('discord-linked')).toContainText('leo_6614', { timeout: 15000 });
  await expect(page.getByTestId('discord-link-code')).toHaveCount(0);

  // And the unlink button is right there, which is what makes "tell the crew" honest.
  await page.getByTestId('discord-unlink').click();
  await expect(page.getByTestId('discord-get-code')).toBeVisible();
  expect(await prisma.discordLink.count({ where: { userId: leoId } })).toBe(0);
});
