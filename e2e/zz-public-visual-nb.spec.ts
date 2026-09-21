// Visual audit of the PUBLIC spectator surfaces IN NORWEGIAN — not part of the suite (zz-
// prefix, `testIgnore` in playwright.config.ts). Norwegian runs 20-40% longer than English
// ("Settings" → "Innstillinger", "Leaderboard" → "Resultatliste"), so every layout that was tuned to
// English copy has to be looked at again. Run it explicitly and read the PNGs:
//
//   SHOT_DIR=/tmp/shots VISUAL_AUDIT=1 E2E_PORT=4103 npx playwright test e2e/zz-public-visual-nb.spec.ts
//
// Same seed as zz-public-visual.spec.ts (8 teams with long Norwegian club names, five-player
// rosters, two matches played, one live, one called) so the two sets of shots are comparable —
// plus the two OBS surfaces at the 1920x1080 canvas a stream actually composites.
import { test, type Page, type Browser } from '@playwright/test';
import { apiAs } from './helpers/api';
import { createTournament, createTeam, createRosterTeams, prisma } from './helpers/lan-seed';

const OUT = process.env.SHOT_DIR!;
const TEAMS = ['Nordic Wolves', 'Team Fjord', 'Bergen Bears', 'Oslo Owls', 'Stavanger Storm', 'Tromsø Tigers', 'Kristiansand Kings', 'Trondheim Titans'];
const NICKS = ['s1mple', 'dev1ce', 'NiKo', 'ropz', 'ZywOo', 'flameZ', 'jL', 'b1t', 'donk', 'sh1ro', 'electroNic', 'Ax1Le', 'broky', 'rain', 'karrigan', 'frozen', 'blameF', 'Spinx', 'torzsi', 'xertioN', 'siuhy', 'Jimpphat', 'malbsMd', 'Brollan', 'w0nderful', 'iM', 'HObbit', 'zont1x', 'magixx', 'chopper', 'Senzu', 'nicoodoz', 'roeJ', 'Staehr', 'Jabbi', 'dupreeh', 'Magisk', 'stavn', 'sjuush', 'cadiaN'];

/** The locale cookie is what `getRequestLocale` reads first — this is the whole switch. */
const NB_COOKIE = {
  name: 'summit.locale',
  value: 'nb',
  domain: '127.0.0.1',
  path: '/',
  expires: -1,
  httpOnly: false,
  secure: false,
  sameSite: 'Lax' as const,
};

function nbContext(browser: Browser, width: number, height: number) {
  return browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    locale: 'nb-NO',
    storageState: { cookies: [NB_COOKIE], origins: [] },
  });
}

async function seedBracket() {
  const t = await createTournament({ name: 'Mortenlab LAN #7', teamSize: 5, steamSignupEnabled: true, format: 'SINGLE_ELIMINATION', bo3LastRounds: 2 });
  for (let i = 0; i < 8; i++) {
    await createTeam(t.id, {
      name: TEAMS[i], seed: i + 1,
      players: Array.from({ length: 5 }, (_, j) => ({
        name: `Player ${i}${j}`, nickname: NICKS[(i * 5 + j) % NICKS.length],
        seating: `${String.fromCharCode(65 + i)}${String(j + 1).padStart(2, '0')}`,
        countryCode: ['no', 'se', 'dk', 'fi'][j % 4], isLeader: j === 0,
      })),
    });
  }
  const admin = await apiAs('marcus');
  await admin.post(`/api/tournaments/${t.id}/generate`, { data: {} });
  const matches = await prisma.match.findMany({ where: { tournamentId: t.id }, orderBy: [{ round: 'asc' }, { matchOrder: 'asc' }] });
  await admin.post(`/api/matches/${matches[0].id}`, { data: { homeScore: 1, awayScore: 0, bestOf: 1, status: 'COMPLETED' } });
  await admin.post(`/api/matches/${matches[1].id}`, { data: { homeScore: 0, awayScore: 1, bestOf: 1, status: 'COMPLETED' } });
  await admin.post(`/api/matches/${matches[2].id}`, { data: { homeScore: 0, awayScore: 0, status: 'LIVE' } });
  await admin.post(`/api/matches/${matches[3].id}/load`, { data: {} });
  return { t, matches };
}

async function shoot(page: Page, name: string, prefix: string, settle = '') {
  // `next dev` compiles each route on first hit, and both OBS sources render nothing at all
  // until their fetch lands — without waiting for real content the shot is a spinner.
  if (settle) await page.locator(settle).first().waitFor({ state: 'visible', timeout: 60000 });
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `${OUT}/${prefix}-${name}.png`, fullPage: true });
}

test('capture the Norwegian spectator tabs', async ({ browser }) => {
  const { t } = await seedBracket();
  const sizes = { desktop: [1512, 950], phone: [390, 844] } as const;

  for (const key of ['desktop', 'phone'] as const) {
    const [w, h] = sizes[key];
    const ctx = await nbContext(browser, w, h);
    const page = await ctx.newPage();

    await page.goto(`/tournaments/${t.id}`); await shoot(page, '01-oversikt', key);
    await page.goto(`/tournaments/${t.id}?tab=bracket`); await shoot(page, '02-bracket', key);
    await page.goto(`/tournaments/${t.id}?tab=teams`); await shoot(page, '03-lag', key);
    await page.goto(`/tournaments/${t.id}?tab=players`); await shoot(page, '04-spillere', key);
    await page.goto(`/tournaments/${t.id}?tab=matches`); await shoot(page, '05-kamper', key);

    // The detail modals carry the longest Norwegian compounds ("Lagoppstilling").
    await page.goto(`/tournaments/${t.id}?tab=teams`);
    await page.waitForTimeout(800);
    // The team card is the button now — its name is the team's. The repeated
    // "Detaljer →" bar under every card was ~52px x 8 teams of scroll.
    await page.locator('div.mds-card').first().getByRole('button').first().click();
    await shoot(page, '06-lagmodal', key);

    await ctx.close();
  }
});

// The OBS sources. Their "user" is a compositor at exactly 1920x1080 with nobody to scroll it,
// and Norwegian stage names are the longest strings on either surface (`åttendedelsfinale` is
// 18 characters where "Round of 16" is 11).
test('capture the Norwegian OBS surfaces at 1920x1080', async ({ browser }) => {
  const { t } = await seedBracket();

  const roster16 = await createTournament({ name: `Roster NB 16 ${Date.now().toString(36)}`, teamSize: 2 });
  await createRosterTeams(roster16.id, 16, 2);
  const roster32 = await createTournament({ name: `Roster NB 32 ${Date.now().toString(36)}`, teamSize: 5 });
  await createRosterTeams(roster32.id, 32, 5);

  const ctx = await nbContext(browser, 1920, 1080);
  const page = await ctx.newPage();

  await page.goto(`/bracket/${t.id}/overlay?chroma=%23101014`);
  await shoot(page, '07-overlay-1920', 'obs', '.react-flow__node');
  await page.goto(`/bracket/${t.id}/overlay?chroma=%23101014&compact=true`);
  await shoot(page, '08-overlay-compact', 'obs', '.react-flow__node');

  await page.goto(`/bracket/${roster16.id}/roster?chroma=%23101014`);
  await shoot(page, '09-roster-16', 'obs', 'div.rounded-3xl');
  await page.goto(`/bracket/${roster32.id}/roster?chroma=%23101014&rotate=0&page=1`);
  await shoot(page, '10-roster-32', 'obs', 'div.rounded-3xl');

  await ctx.close();
});

// A 16-team single elimination is the bracket that actually produces "Åttendedelsfinale", which
// is the stage name most likely to blow a node badge or a rail heading apart in Norwegian.
test('capture a 16-team Norwegian bracket, where the longest stage name appears', async ({ browser }) => {
  const big = await createTournament({ name: 'Mortenlab LAN #8 — 16 lag', teamSize: 2, format: 'SINGLE_ELIMINATION' });
  await createRosterTeams(big.id, 16, 2);
  const admin = await apiAs('marcus');
  await admin.post(`/api/tournaments/${big.id}/generate`, { data: {} });

  for (const [key, w, h] of [['desktop', 1512, 950], ['phone', 390, 844], ['obs', 1920, 1080]] as const) {
    const ctx = await nbContext(browser, w, h);
    const page = await ctx.newPage();
    await page.goto(`/tournaments/${big.id}?tab=bracket`); await shoot(page, '11-r16-bracket', key, '.react-flow__node');
    await page.goto(`/tournaments/${big.id}?tab=matches`); await shoot(page, '12-r16-kamper', key, '[data-testid="public-match-board"]');
    if (key === 'obs') {
      await page.goto(`/bracket/${big.id}/overlay?chroma=%23101014`);
      await shoot(page, '13-r16-overlay', key, '.react-flow__node');
    }
    await ctx.close();
  }
});
