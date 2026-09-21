import { expect, test } from '@playwright/test';
import { apiAnon, apiAs, disposeApiContexts, json } from './helpers/api';
import { createTeam, createTournament, readPlayer, setRosterLocked } from './helpers/lan-seed';
import { loginAs } from './helpers/auth';

/**
 * Registration + invite: the very first thing that happens at a LAN, and the one flow where a
 * leak matters — the invite code is a join credential, and the roster endpoint is public.
 *
 * Driven through the API with minted session cookies (see helpers/api.ts) so several identities
 * can act inside one test; the last test covers the register screen itself, because the invite
 * link only exists as UI.
 */
test.describe.configure({ mode: 'serial' });
test.afterEach(disposeApiContexts);

/** A fresh signup-enabled tournament with room for two players per team. */
async function signupTournament(teamSize = 2) {
  const tournament = await createTournament({ teamSize, steamSignupEnabled: true });
  return tournament.id;
}

async function createTeamAs(persona: 'leo' | 'sam' | 'chloe', tournamentId: string, teamName: string, seating?: string) {
  const api = await apiAs(persona);
  const res = await api.post(`/api/tournaments/${tournamentId}/signup`, {
    data: { action: 'CREATE_TEAM', teamName, ...(seating ? { seating } : {}) },
  });
  return { api, res, body: await json(res) };
}

test('a player creating a team gets a seat, a leader flag and an invite code', async () => {
  const tournamentId = await signupTournament();

  const { body: team, res } = await createTeamAs('leo', tournamentId, 'Leo Legion', 'B12');
  expect(res.status()).toBe(200);
  expect(team.name).toBe('Leo Legion');
  expect(team.inviteCode).toBeTruthy();
  expect(team.players).toHaveLength(1);
  expect(team.players[0]).toMatchObject({ name: 'Leo', seating: 'B12', isLeader: true });
});

test('the roster shows a player their own invite code and nobody else’s', async () => {
  const tournamentId = await signupTournament();
  const { api: leoApi, body: leoTeam } = await createTeamAs('leo', tournamentId, 'Leo Legion', 'B12');
  await createTeam(tournamentId, { name: 'Rival Squad', seed: 2, players: [{ name: 'Stranger' }] });

  const teams = await json<any[]>(await leoApi.get(`/api/tournaments/${tournamentId}/teams`));
  expect(teams).toHaveLength(2);

  const mine = teams.find((team) => team.id === leoTeam.id)!;
  const theirs = teams.find((team) => team.id !== leoTeam.id)!;

  // Own team: the invite code is present (it's the join credential this player is allowed to
  // share) and their own player row is flagged so the UI can single it out.
  expect(mine.inviteCode).toBe(leoTeam.inviteCode);
  expect(mine.players.map((p: any) => p.isMe)).toEqual([true]);

  // Somebody else's team: no code at all, and nothing flagged as "me".
  expect(theirs).not.toHaveProperty('inviteCode');
  expect(theirs.players.every((p: any) => p.isMe === false)).toBe(true);

  // Steam/user identifiers are never in the non-staff payload, not even on your own team.
  for (const team of teams) {
    for (const player of team.players) {
      expect(player).not.toHaveProperty('steamId');
      expect(player).not.toHaveProperty('userId');
    }
  }
});

test('the anonymous roster carries no invite codes and no identifiers', async () => {
  const tournamentId = await signupTournament();
  await createTeamAs('leo', tournamentId, 'Leo Legion', 'B12');
  await createTeam(tournamentId, { name: 'Rival Squad', seed: 2, players: [{ name: 'Stranger', steamId: '76561198000000999' }] });

  const anon = await apiAnon();
  const teams = await json<any[]>(await anon.get(`/api/tournaments/${tournamentId}/teams`));
  expect(teams).toHaveLength(2);

  for (const team of teams) {
    expect(team).not.toHaveProperty('inviteCode');
    expect(team.players.length).toBeGreaterThan(0);
    for (const player of team.players) {
      expect(player).not.toHaveProperty('steamId');
      expect(player).not.toHaveProperty('userId');
      // Seats stay public on purpose — the roster and OBS views show them.
      expect(player).toHaveProperty('seating');
      expect(player.isMe).toBe(false);
    }
  }
});

test('a teammate joins with the invite code, then the team is full and refuses more', async () => {
  const tournamentId = await signupTournament(2);
  const { body: leoTeam } = await createTeamAs('leo', tournamentId, 'Leo Legion', 'B12');
  const inviteCode = leoTeam.inviteCode as string;

  const samApi = await apiAs('sam');
  const joinRes = await samApi.post(`/api/tournaments/${tournamentId}/signup`, {
    data: { action: 'JOIN_TEAM', inviteCode, seating: 'B13' },
  });
  expect(joinRes.status()).toBe(200);
  const joined = await json(joinRes);
  expect(joined.id).toBe(leoTeam.id);
  expect(joined.players).toHaveLength(2);
  expect(joined.players.find((p: any) => p.name === 'Sam').seating).toBe('B13');

  // teamSize is 2, so a third player bounces off the capacity check.
  const chloeApi = await apiAs('chloe');
  const fullRes = await chloeApi.post(`/api/tournaments/${tournamentId}/signup`, {
    data: { action: 'JOIN_TEAM', inviteCode },
  });
  expect(fullRes.status()).toBe(400);
  expect((await json(fullRes)).error).toMatch(/already full/i);

  // A bogus code is a 404 rather than a capacity error.
  const badRes = await chloeApi.post(`/api/tournaments/${tournamentId}/signup`, {
    data: { action: 'JOIN_TEAM', inviteCode: 'not-a-code' },
  });
  expect(badRes.status()).toBe(404);
});

test('double registration is rejected on both the create and the join path', async () => {
  const tournamentId = await signupTournament(4);
  const { api: leoApi, body: leoTeam } = await createTeamAs('leo', tournamentId, 'Leo Legion');

  const secondTeam = await leoApi.post(`/api/tournaments/${tournamentId}/signup`, {
    data: { action: 'CREATE_TEAM', teamName: 'Leo Legion II' },
  });
  expect(secondTeam.status()).toBe(400);
  expect((await json(secondTeam)).error).toMatch(/already registered/i);

  const rejoin = await leoApi.post(`/api/tournaments/${tournamentId}/signup`, {
    data: { action: 'JOIN_TEAM', inviteCode: leoTeam.inviteCode },
  });
  expect(rejoin.status()).toBe(400);
  expect((await json(rejoin)).error).toMatch(/already registered/i);

  // Only the original team exists.
  const teams = await json<any[]>(await leoApi.get(`/api/tournaments/${tournamentId}/teams`));
  expect(teams).toHaveLength(1);
});

test('a player can change their own seat, even once the roster is locked', async () => {
  const tournamentId = await signupTournament();
  const { api: leoApi, body: leoTeam } = await createTeamAs('leo', tournamentId, 'Leo Legion', 'B12');

  const patched = await leoApi.patch('/api/me/player', { data: { tournamentId, seating: 'C04', nickname: 'Leoo' } });
  expect(patched.status()).toBe(200);
  expect((await json(patched)).player).toMatchObject({ seating: 'C04', nickname: 'Leoo' });

  const teams = await json<any[]>(await leoApi.get(`/api/tournaments/${tournamentId}/teams`));
  expect(teams.find((t) => t.id === leoTeam.id).players[0].seating).toBe('C04');

  // Seats move on the LAN floor after the bracket goes live, so the lock must NOT block this.
  await setRosterLocked(tournamentId, true);
  const lockedPatch = await leoApi.patch('/api/me/player', { data: { tournamentId, seating: 'D09' } });
  expect(lockedPatch.status()).toBe(200);
  expect((await json(lockedPatch)).player.seating).toBe('D09');
});

test('leaving a team works while the roster is unlocked and 423s once it locks', async () => {
  const tournamentId = await signupTournament();
  const { api: leoApi, body: leoTeam } = await createTeamAs('leo', tournamentId, 'Leo Legion', 'B12');

  const samApi = await apiAs('sam');
  await samApi.post(`/api/tournaments/${tournamentId}/signup`, {
    data: { action: 'JOIN_TEAM', inviteCode: leoTeam.inviteCode, seating: 'B13' },
  });

  const left = await samApi.delete(`/api/me/player?tournamentId=${tournamentId}`);
  expect(left.status()).toBe(200);
  expect(await json(left)).toMatchObject({ success: true, teamDeleted: false });

  const teams = await json<any[]>(await leoApi.get(`/api/tournaments/${tournamentId}/teams`));
  expect(teams.find((t) => t.id === leoTeam.id).players).toHaveLength(1);

  // Leaving twice is a 404, not a silent success.
  expect((await samApi.delete(`/api/me/player?tournamentId=${tournamentId}`)).status()).toBe(404);

  // Once the bracket exists the team is wired into matches — leaving becomes an organizer job.
  await setRosterLocked(tournamentId, true);
  const blocked = await leoApi.delete(`/api/me/player?tournamentId=${tournamentId}`);
  expect(blocked.status()).toBe(423);
  expect((await json(blocked)).error).toMatch(/bracket is live/i);
  expect(await readPlayer(leoTeam.players[0].id)).not.toBeNull();
});

test('the register screen hands a new team its invite link', async ({ page }) => {
  const tournament = await createTournament({ name: 'Register UI Cup', teamSize: 2, steamSignupEnabled: true });
  await loginAs(page, 'leo');

  await page.goto(`/tournaments/${tournament.id}/register`);
  await page.getByPlaceholder('Enter unique team name').fill('Leo Legion');
  await page.locator('#create-seating').fill('B12');
  await page.getByRole('button', { name: /Complete Registration/i }).click();

  await expect(page.getByRole('heading', { name: 'Leo Legion' })).toBeVisible();
  // The invite panel is the only place the join credential surfaces to a player.
  await expect(page.getByText('Invite Teammates')).toBeVisible();
  await expect(page.getByRole('button', { name: /Copy Invite Link/i })).toBeVisible();
  // The seat shows up twice (the editable "Your Seat" panel and the roster row); the roster row
  // is the one the whole team reads.
  await expect(page.getByRole('listitem').getByText('B12')).toBeVisible();
});
