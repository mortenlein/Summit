import fs from 'fs';
import path from 'path';
import { expect, test } from '@playwright/test';
import { apiAs, disposeApiContexts, json } from './helpers/api';
import { createTournament, prisma, readDmAttempts } from './helpers/lan-seed';
import { mintSessionToken, personaUserId } from './helpers/auth';

/**
 * Linking Discord by the name a player types on the registration form.
 *
 * `/koble` is exact but it is four steps across two applications, and a roster of twelve
 * 12-to-15-year-olds will not all finish it. This is the path they do finish: one field, on the
 * form they are already filling in.
 *
 * What the name is NOT is an address. Discord DMs need the account's snowflake, so the name is
 * resolved against the club's own server before anything is written, and what gets stored is
 * whatever Discord answered. These specs exist for the resolution step, because everything
 * after it is the `/koble` path and already has its own suite.
 */
const GUILD = path.resolve(process.cwd(), 'prisma', `e2e-${process.env.E2E_PORT || '4101'}-guild.json`);
const DM_SIM = path.resolve(process.cwd(), 'prisma', `e2e-${process.env.E2E_PORT || '4101'}-dm-sim.json`);

/** The people in 6614gamers, as Discord's member search would answer. */
function guild(members: { id: string; username: string; nick?: string }[]) {
  fs.writeFileSync(
    GUILD,
    JSON.stringify(members.map((m) => ({ user: { id: m.id, username: m.username }, nick: m.nick ?? null })))
  );
}

function simulate(rules: Record<string, { status: number; code?: number }>) {
  fs.writeFileSync(DM_SIM, JSON.stringify(rules));
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(() => {
  guild([]);
  simulate({});
});

test.afterEach(async () => {
  guild([]);
  simulate({});
  await disposeApiContexts();
});

async function resetDiscord(userId: string) {
  await prisma.discordDmAttempt.deleteMany({ where: { userId } });
  await prisma.discordLink.deleteMany({ where: { userId } });
}

/** Register a fresh team, carrying whatever Discord name the player typed. */
async function registerWith(persona: 'leo' | 'sam', discordUsername: string) {
  const tournament = await createTournament({ name: `Discord name cup ${Date.now().toString(36)}`, teamSize: 1 });
  await prisma.tournament.update({ where: { id: tournament.id }, data: { steamSignupEnabled: true } });
  const api = await apiAs(persona);
  const res = await api.post(`/api/tournaments/${tournament.id}/signup`, {
    data: { action: 'CREATE_TEAM', teamName: `Team ${persona} ${Date.now().toString(36)}`, discordUsername },
  });
  return { tournament, res, body: await json<any>(res) };
}

test('a typed name is resolved against the guild, and the account is what gets stored', async () => {
  await mintSessionToken('leo');
  const leoId = await personaUserId('leo');
  await resetDiscord(leoId);
  guild([{ id: '300000000000000042', username: 'leo_6614' }]);

  const { tournament, res, body } = await registerWith('leo', 'leo_6614');
  expect(res.status()).toBe(200);
  expect(body.discord).toMatchObject({ ok: true, discordUsername: 'leo_6614' });

  // The snowflake Discord gave us, never the string the kid typed.
  const link = await prisma.discordLink.findUnique({ where: { userId: leoId } });
  expect(link).toMatchObject({ discordId: '300000000000000042', discordUsername: 'leo_6614', optOut: false });

  // And the same confirmation DM `/koble` sends, so the link is proven rather than assumed.
  const attempts = await prisma.discordDmAttempt.findMany({ where: { userId: leoId } });
  expect(attempts).toHaveLength(1);
  expect(attempts[0].event).toBe('LINK_PROBE');
  expect(attempts[0].discordId).toBe('300000000000000042');

  await prisma.tournament.delete({ where: { id: tournament.id } });
  await resetDiscord(leoId);
});

test('what a kid actually types still resolves: @handle, and the old name#1234 form', async () => {
  await mintSessionToken('leo');
  const leoId = await personaUserId('leo');
  guild([{ id: '300000000000000043', username: 'leo_6614' }]);

  for (const typed of ['@leo_6614', 'leo_6614#4821', '  leo_6614 ']) {
    await resetDiscord(leoId);
    const { tournament, body } = await registerWith('leo', typed);
    expect(body.discord, `typed as ${JSON.stringify(typed)}`).toMatchObject({ ok: true });
    expect((await prisma.discordLink.findUnique({ where: { userId: leoId } }))!.discordId).toBe(
      '300000000000000043'
    );
    await prisma.tournament.delete({ where: { id: tournament.id } });
  }
  await resetDiscord(leoId);
});

test('a name nobody in the server has writes no link, and does not cost the registration', async () => {
  await mintSessionToken('leo');
  const leoId = await personaUserId('leo');
  await resetDiscord(leoId);
  guild([{ id: '300000000000000044', username: 'someone_else' }]);

  const { tournament, res, body } = await registerWith('leo', 'leo_typo_6614');

  // Registered. A mistyped Discord name must never be the thing that keeps a kid off a roster.
  expect(res.status()).toBe(200);
  expect(body.id).toBeTruthy();
  // …and told, rather than left believing their phone will buzz.
  expect(body.discord).toMatchObject({ ok: false, reason: 'not_found' });
  expect(await prisma.discordLink.count({ where: { userId: leoId } })).toBe(0);
  expect(await prisma.discordDmAttempt.count({ where: { userId: leoId } })).toBe(0);

  await prisma.tournament.delete({ where: { id: tournament.id } });
});

test('a name that matches several people is refused, never guessed at', async () => {
  await mintSessionToken('leo');
  const leoId = await personaUserId('leo');
  await resetDiscord(leoId);
  // Two real kids in the club whose names start the same way. Picking one sends a child's match
  // call to another child, so the only safe answer is to ask.
  guild([
    { id: '300000000000000050', username: 'leo_6614' },
    { id: '300000000000000051', username: 'leo_petter' },
  ]);

  const { tournament, body } = await registerWith('leo', 'leo');
  expect(body.discord).toMatchObject({ ok: false, reason: 'ambiguous' });
  expect(body.discord.candidates.map((c: any) => c.discordUsername).sort()).toEqual([
    'leo_6614',
    'leo_petter',
  ]);
  expect(await prisma.discordLink.count({ where: { userId: leoId } })).toBe(0);

  // The full name resolves it, with no ambiguity left to guess about.
  await prisma.tournament.delete({ where: { id: tournament.id } });
  const second = await registerWith('leo', 'leo_6614');
  expect(second.body.discord).toMatchObject({ ok: true, discordUsername: 'leo_6614' });
  expect((await prisma.discordLink.findUnique({ where: { userId: leoId } }))!.discordId).toBe(
    '300000000000000050'
  );

  await prisma.tournament.delete({ where: { id: second.tournament.id } });
  await resetDiscord(leoId);
});

test('an account already linked to another player is refused, and the first link is untouched', async () => {
  await mintSessionToken('leo');
  await mintSessionToken('sam');
  const leoId = await personaUserId('leo');
  const samId = await personaUserId('sam');
  await resetDiscord(leoId);
  await resetDiscord(samId);
  guild([{ id: '300000000000000060', username: 'shared_account' }]);

  const first = await registerWith('leo', 'shared_account');
  expect(first.body.discord).toMatchObject({ ok: true });

  const second = await registerWith('sam', 'shared_account');
  expect(second.body.discord).toMatchObject({ ok: false, reason: 'discord_taken' });

  // Silently stealing the binding means the first kid stops getting DMs with no signal anywhere.
  expect((await prisma.discordLink.findUnique({ where: { userId: leoId } }))!.discordId).toBe(
    '300000000000000060'
  );
  expect(await prisma.discordLink.count({ where: { userId: samId } })).toBe(0);

  await prisma.tournament.delete({ where: { id: first.tournament.id } });
  await prisma.tournament.delete({ where: { id: second.tournament.id } });
  await resetDiscord(leoId);
});

test('a player whose DMs are shut still links, and is told so', async () => {
  await mintSessionToken('leo');
  const leoId = await personaUserId('leo');
  await resetDiscord(leoId);
  // DISCORD_DM_MOCK_BLOCKED, the one snowflake the mock probe refuses with Discord's real
  // 50007 — "direct messages from server members are off". The account resolves fine; the door
  // is what is shut.
  guild([{ id: '300000000000000900', username: 'closed_dms' }]);

  const { tournament, body } = await registerWith('leo', 'closed_dms');

  // The link stands — the account is right, the door is shut. Crew walks to this one.
  expect(body.discord).toMatchObject({ ok: true, dmState: 'BLOCKED' });
  const link = await prisma.discordLink.findUnique({ where: { userId: leoId } });
  expect(link).toMatchObject({ dmState: 'BLOCKED', discordId: '300000000000000900' });
  // Recorded as a refusal Discord actually gave, so the reach panel can name the remedy.
  const attempts = await prisma.discordDmAttempt.findMany({ where: { userId: leoId } });
  expect(attempts[0]).toMatchObject({ outcome: 'BLOCKED', discordCode: 50007 });

  await prisma.tournament.delete({ where: { id: tournament.id } });
  await resetDiscord(leoId);
});

test('the self-service endpoint links the caller and nobody else', async () => {
  await mintSessionToken('leo');
  const leoId = await personaUserId('leo');
  await resetDiscord(leoId);
  guild([{ id: '300000000000000080', username: 'later_linker' }]);

  const leo = await apiAs('leo');
  const res = await leo.post('/api/me/discord/name', { data: { name: 'later_linker' } });
  expect(res.status()).toBe(200);
  expect(await json<any>(res)).toMatchObject({ ok: true, discordUsername: 'later_linker' });
  expect((await prisma.discordLink.findUnique({ where: { userId: leoId } }))!.discordId).toBe(
    '300000000000000080'
  );

  // The snowflake is server-side only, for the owner of it too.
  expect(Object.keys(await json<any>(await leo.get('/api/me/discord')))).not.toContain('discordId');

  await resetDiscord(leoId);
});

test('the endpoint is closed to anonymous callers', async () => {
  const { apiAnon } = await import('./helpers/api');
  const anon = await apiAnon();
  expect((await anon.post('/api/me/discord/name', { data: { name: 'anyone' } })).status()).toBe(401);
});
