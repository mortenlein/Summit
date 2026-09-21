import { expect, test } from '@playwright/test';
import { apiAnon, apiAs, disposeApiContexts, json } from './helpers/api';
import { createCallableMatch, readMatch, readPlayer } from './helpers/lan-seed';
import { loginAs } from './helpers/auth';

/**
 * Floor operations: calling a match and confirming players are in their seats. Both are marshal
 * work, and both have to be visible to the rest of the staff — the call through the shared
 * notification feed, the check-in through the match feed every board reads.
 */
test.describe.configure({ mode: 'serial' });
test.afterEach(disposeApiContexts);

test('calling a match makes it READY and posts to the staff notification feed', async () => {
  const { tournament, match, home, away } = await createCallableMatch();
  const miaApi = await apiAs('mia');

  const res = await miaApi.post(`/api/matches/${match.id}/load`, { data: {} });
  expect(res.status()).toBe(200);
  const body = await json(res);
  expect(body.success).toBe(true);
  expect(body.match.status).toBe('READY');
  expect((await readMatch(match.id)).status).toBe('READY');

  const log = await json(await miaApi.get(`/api/notifications/log?tournamentId=${tournament.id}`));
  expect(log.count).toBeGreaterThanOrEqual(1);
  const entry = log.notifications[0];
  expect(entry).toMatchObject({ type: 'MATCH' });
  expect(entry.id).toBeTruthy();
  expect(Date.parse(entry.timestamp)).not.toBeNaN();
  expect(entry.embed.title).toBe('Match ready for players');
  expect(entry.embed.description).toContain(tournament.name);
  expect(entry.embed.description).toContain('Round 1');
  // The rosters are named in the announcement, which is how staff know which call it was.
  expect(home.name).toBe('Home Crew');
  expect(away.name).toBe('Away Crew');
});

test('a second tap on an already-called match keeps the check-ins the marshal just collected', async () => {
  const { match, home, away } = await createCallableMatch();
  const miaApi = await apiAs('mia');

  expect((await miaApi.post(`/api/matches/${match.id}/load`, { data: {} })).status()).toBe(200);

  // The marshal walks the row and ticks both kids in.
  for (const playerId of [home.players[0].id, away.players[0].id]) {
    expect(
      (await miaApi.post(`/api/players/${playerId}/checkin`, { data: { checkedIn: true } })).status()
    ).toBe(200);
  }

  // Then taps "Call match" again, because the board had not caught up in a loud room. This used
  // to run the per-call reset a second time and wipe the walk they had just done.
  const second = await miaApi.post(`/api/matches/${match.id}/load`, { data: {} });
  expect(second.status()).toBe(200);
  const body = await json<any>(second);
  expect(body.recall).toBe(true);
  expect(body.match.status).toBe('READY');

  for (const playerId of [home.players[0].id, away.players[0].id]) {
    expect((await readPlayer(playerId))!.checkedInAt).not.toBeNull();
  }
});

test('a called match still resets check-in for the match after it', async () => {
  // The re-call guard must not cost the first call its reset: check-in is per call, so a kid
  // ticked in for one match must start the next one as "not found yet".
  const { match, home } = await createCallableMatch();
  const miaApi = await apiAs('mia');
  const playerId = home.players[0].id;

  expect((await miaApi.post(`/api/players/${playerId}/checkin`, { data: { checkedIn: true } })).status()).toBe(200);
  expect((await readPlayer(playerId))!.checkedInAt).not.toBeNull();

  const called = await miaApi.post(`/api/matches/${match.id}/load`, { data: {} });
  expect(called.status()).toBe(200);
  expect((await json<any>(called)).recall).toBe(false);
  expect((await readPlayer(playerId))!.checkedInAt).toBeNull();
});

test('a live or finished match refuses to be called again', async () => {
  const { match } = await createCallableMatch();
  const miaApi = await apiAs('mia');

  expect((await miaApi.post(`/api/matches/${match.id}/load`, { data: {} })).status()).toBe(200);
  expect((await miaApi.post(`/api/matches/${match.id}`, { data: { status: 'LIVE' } })).status()).toBe(200);

  // The marshal board hides the button once a match is live, so this is a stale client. Honouring
  // it would flip the overlay from LIVE back to CALLED mid-map.
  const live = await miaApi.post(`/api/matches/${match.id}/load`, { data: {} });
  expect(live.status()).toBe(409);
  expect(await json<any>(live)).toMatchObject({ code: 'match_already_live' });
  expect((await readMatch(match.id)).status).toBe('LIVE');

  expect((await miaApi.post(`/api/matches/${match.id}`, { data: { homeScore: 1, awayScore: 0 } })).status()).toBe(200);
  const done = await miaApi.post(`/api/matches/${match.id}/load`, { data: {} });
  expect(done.status()).toBe(409);
  expect(await json<any>(done)).toMatchObject({ code: 'match_already_complete' });
  expect((await readMatch(match.id)).status).toBe('COMPLETED');
});

test('calling a match and reading the notification feed are both staff-only', async () => {
  const { tournament, match } = await createCallableMatch();

  const anon = await apiAnon();
  expect((await anon.post(`/api/matches/${match.id}/load`, { data: {} })).status()).toBe(401);
  expect((await anon.get(`/api/notifications/log?tournamentId=${tournament.id}`)).status()).toBe(401);

  const leoApi = await apiAs('leo');
  expect((await leoApi.post(`/api/matches/${match.id}/load`, { data: {} })).status()).toBe(401);
  expect((await leoApi.get(`/api/notifications/log?tournamentId=${tournament.id}`)).status()).toBe(401);

  expect((await readMatch(match.id)).status).toBe('PENDING');
});

test('a marshal check-in toggles the at-seat stamp the whole floor reads', async () => {
  const { tournament, match, home } = await createCallableMatch();
  const playerId = home.players[0].id;
  const miaApi = await apiAs('mia');

  const checkedIn = await miaApi.post(`/api/players/${playerId}/checkin`, { data: { checkedIn: true } });
  expect(checkedIn.status()).toBe(200);
  expect((await json(checkedIn)).player.checkedInAt).toBeTruthy();

  const findPlayer = async () => {
    const matches = await json<any[]>(await miaApi.get(`/api/tournaments/${tournament.id}/matches`));
    const row = matches.find((m) => m.id === match.id)!;
    return row.homeTeam.players.find((p: any) => p.id === playerId);
  };

  expect((await findPlayer()).checkedInAt).toBeTruthy();

  const cleared = await miaApi.post(`/api/players/${playerId}/checkin`, { data: { checkedIn: false } });
  expect(cleared.status()).toBe(200);
  expect((await json(cleared)).player.checkedInAt).toBeNull();
  expect((await findPlayer()).checkedInAt).toBeNull();

  // The flag is a boolean, not a truthy string.
  const bad = await miaApi.post(`/api/players/${playerId}/checkin`, { data: { checkedIn: 'yes' } });
  expect(bad.status()).toBe(400);
  expect((await json(bad)).error).toMatch(/must be a boolean/i);
});

test('check-in is closed to players and to anonymous callers', async () => {
  const { home } = await createCallableMatch();
  const playerId = home.players[0].id;

  const anon = await apiAnon();
  expect((await anon.post(`/api/players/${playerId}/checkin`, { data: { checkedIn: true } })).status()).toBe(401);

  const leoApi = await apiAs('leo');
  expect((await leoApi.post(`/api/players/${playerId}/checkin`, { data: { checkedIn: true } })).status()).toBe(401);

  expect((await readPlayer(playerId))!.checkedInAt).toBeNull();
});

test('the marshal board checks a player in with one tap', async ({ page }) => {
  // The board shows the newest tournament that has matches, so this fixture has to be created
  // immediately before navigating.
  const { match, home } = await createCallableMatch();
  const playerId = home.players[0].id;

  await loginAs(page, 'mia');
  await page.goto('/marshal/dashboard');

  await expect(page.getByTestId(`marshal-match-${match.id}`)).toBeVisible();
  const seatButton = page.getByTestId(`marshal-player-${playerId}`);
  await expect(seatButton).toHaveAttribute('aria-pressed', 'false');
  await expect(seatButton).toContainText('A12');

  // The board flips the row optimistically and reconciles when the write lands, so the stored
  // stamp has to be polled rather than read once.
  const storedStamp = () => expect.poll(async () => (await readPlayer(playerId))!.checkedInAt);

  await seatButton.click();
  await expect(seatButton).toHaveAttribute('aria-pressed', 'true');
  await storedStamp().not.toBeNull();

  // Tapping again clears it — marshals correct their own mistakes.
  await seatButton.click();
  await expect(seatButton).toHaveAttribute('aria-pressed', 'false');
  await storedStamp().toBeNull();
});
