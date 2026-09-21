// Visual audit only — not part of the suite (zz- prefix; playwright.config.ts skips it).
//
//   VISUAL_AUDIT=1 SHOT_DIR=/tmp/nb-shots E2E_PORT=4106 npx playwright test e2e/zz-nb-visual.spec.ts
//
// The Norwegian twin of zz-chrome-visual.spec.ts. Same surfaces, every context pinned to `nb`
// with the locale cookie (the config pins the rest of the suite to English). It exists because
// Norwegian is 10-20% longer than English and this lane's surfaces are dense: the marshal board
// is a phone-first grid, the header is a single 56px row, and a chip that wraps on a 390px
// screen is a bug a Norwegian reader meets and an English one never does.
//
// 390x844 is the viewport that matters — a marshal reads this walking a venue.
import { test, expect, type Page, type Browser } from '@playwright/test';
import { loginAs } from './helpers/auth';
import { apiAs, disposeApiContexts } from './helpers/api';
import {
  createSeededTeams,
  createTeam,
  createTournament,
  prisma,
  seedPlayedBracket,
} from './helpers/lan-seed';

const OUT = process.env.SHOT_DIR || '/tmp/summit-nb-shots';

const DESKTOP = { width: 1512, height: 950 } as const;
const PHONE = { width: 390, height: 844 } as const;

/** Every context starts Norwegian — this is the whole point of the file. */
const NB_STATE = {
  cookies: [
    {
      name: 'summit.locale',
      value: 'nb',
      domain: '127.0.0.1',
      path: '/',
      expires: -1,
      httpOnly: false,
      secure: false,
      sameSite: 'Lax' as const,
    },
  ],
  origins: [],
};

test.describe.configure({ mode: 'serial' });
test.afterEach(disposeApiContexts);

async function wipeTournaments() {
  await prisma.notificationLog.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.scoreboardEntry.deleteMany();
  await prisma.match.deleteMany();
  await prisma.player.deleteMany();
  await prisma.team.deleteMany();
  await prisma.tournament.deleteMany();
}

async function shoot(page: Page, name: string) {
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
}

async function newPage(browser: Browser, viewport: typeof DESKTOP | typeof PHONE) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, storageState: NB_STATE });
  return { ctx, page: await ctx.newPage() };
}

/** Sanity: if the cookie stopped working every shot below would silently be English. */
async function expectNorwegian(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('lang', 'nb-NO');
}

test('00 — empty world: landing and directory with nothing seeded', async ({ browser }) => {
  await wipeTournaments();

  for (const [label, viewport] of [['desktop', DESKTOP], ['phone', PHONE]] as const) {
    const { ctx, page } = await newPage(browser, viewport);
    await page.goto('/');
    await expectNorwegian(page);
    await shoot(page, `${label}-00-landing-empty`);
    await page.goto('/tournaments');
    await shoot(page, `${label}-00-directory-empty`);
    await ctx.close();
  }
});

test('01 — a handful: two tournaments, every role', async ({ browser }) => {
  await wipeTournaments();
  await seedPlayedBracket({ name: 'Kristiansand Vinter-LAN #7', teams: 8, completed: 3 });
  const draft = await createTournament({ name: 'Fredagsduoer', teamSize: 2, steamSignupEnabled: true });
  await createSeededTeams(draft.id, 0).catch(() => undefined);

  for (const [label, viewport] of [['desktop', DESKTOP], ['phone', PHONE]] as const) {
    const { ctx, page } = await newPage(browser, viewport);

    await page.goto('/');
    await expectNorwegian(page);
    await shoot(page, `${label}-01-landing-anon`);
    await page.goto('/tournaments');
    await shoot(page, `${label}-01-directory-few`);

    await loginAs(page, 'leo');
    await page.goto('/');
    await shoot(page, `${label}-01-landing-player`);

    await page.context().clearCookies();
    await page.context().addCookies(NB_STATE.cookies);
    await loginAs(page, 'marcus');
    await page.goto('/');
    await shoot(page, `${label}-01-landing-admin`);
    await page.goto('/tournaments');
    await shoot(page, `${label}-01-directory-admin`);

    await ctx.close();
  }
});

test('02 — a full board: twenty tournaments', async ({ browser }) => {
  await wipeTournaments();
  await seedPlayedBracket({ name: 'Kristiansand Vinter-LAN #7 — Hovedturnering', teams: 8, completed: 3 });
  await seedPlayedBracket({ name: 'Nordisk Finalehelg', teams: 4, completed: 2, live: false });
  for (let i = 0; i < 9; i++) {
    const t = await createTournament({ name: `Åpen kvalifisering ${String(i + 1).padStart(2, '0')}`, teamSize: 5 });
    await createSeededTeams(t.id, 4);
  }
  for (let i = 0; i < 9; i++) {
    await createTournament({ name: `Kristiansand Kings Invitational ${i + 1}`, teamSize: 2 });
  }

  for (const [label, viewport] of [['desktop', DESKTOP], ['phone', PHONE]] as const) {
    const { ctx, page } = await newPage(browser, viewport);
    await page.goto('/');
    await expectNorwegian(page);
    await shoot(page, `${label}-02-landing-many`);
    await page.goto('/tournaments');
    await shoot(page, `${label}-02-directory-many`);
    await ctx.close();
  }
});

test('03 — login, palette, toast, route states, header', async ({ browser }) => {
  for (const [label, viewport] of [['desktop', DESKTOP], ['phone', PHONE]] as const) {
    const { ctx, page } = await newPage(browser, viewport);

    await page.goto('/login');
    await expectNorwegian(page);
    await shoot(page, `${label}-03-login`);
    await page.goto('/login?callbackUrl=%2Fmarshal%2Fdashboard');
    await shoot(page, `${label}-03-login-staff`);

    // The shared route-state panel (RouteStates.tsx). error.tsx and loading.tsx render the
    // same panel and are not reachable in normal use — see zz-chrome-visual.spec.ts.
    await page.goto('/tournaments/finnes-ikke');
    await shoot(page, `${label}-03-not-found`);

    const header = page.locator('header').first();
    await page.goto('/tournaments');
    await header.screenshot({ path: `${OUT}/${label}-03-header-anon.png` });

    for (const persona of ['leo', 'mia', 'marcus'] as const) {
      await page.context().clearCookies();
      await page.context().addCookies(NB_STATE.cookies);
      await loginAs(page, persona);
      await page.goto('/tournaments');
      await page.waitForTimeout(500);
      await header.screenshot({ path: `${OUT}/${label}-03-header-${persona}.png` });
    }

    if (label === 'phone') {
      // The language toggle has to be reachable without opening the drawer.
      await expect(page.getByTestId('locale-toggle')).toBeVisible();
      await page.getByTestId('mobile-nav-toggle').click();
      await expect(page.getByTestId('mobile-nav-panel')).toBeVisible();
      await page.screenshot({ path: `${OUT}/phone-03-header-drawer.png` });
    }

    await ctx.close();
  }

  // Palette (player + staff) and a toast. Desktop only for the palette legs: the header door is
  // `hidden md:flex` now, because on a phone it was the fourth glyph in a row of four and every
  // command behind it is a link already in the hamburger drawer. The Norwegian labels inside the
  // palette are still the longest strings in the app, so they are still worth a look — at the
  // viewport where a person can actually open it.
  for (const [label, viewport] of [['desktop', DESKTOP]] as const) {
    const { ctx, page } = await newPage(browser, viewport);
    await loginAs(page, 'leo');
    await page.goto('/dashboard');
    await page.getByTestId('open-command-palette').click();
    await expect(page.getByTestId('command-palette')).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/${label}-03-palette-player.png` });
    await page.keyboard.press('Escape');

    await page.context().clearCookies();
    await page.context().addCookies(NB_STATE.cookies);
    await loginAs(page, 'marcus');
    await page.goto('/tournaments');
    await page.getByTestId('open-command-palette').click();
    await expect(page.getByTestId('command-palette')).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/${label}-03-palette-admin.png` });
    await page.keyboard.press('Escape');

    const t = await prisma.tournament.findFirst({ orderBy: { createdAt: 'desc' } });
    if (t) {
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.goto(`/tournaments/${t.id}`);
      const share = page.getByRole('button', { name: /del|share/i }).first();
      if (await share.count()) {
        await share.click();
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${OUT}/${label}-03-toast.png` });
      }
    }

    await ctx.close();
  }
});

/**
 * The marshal board fixture: five-player rosters (so "3/5 på plass" is a real string rather
 * than "1/1"), a called match that has been waiting twelve minutes, a live one, and two more
 * queued behind them. This is the board a marshal actually sees.
 */
async function seedMarshalFloor() {
  await wipeTournaments();
  const tournament = await createTournament({ name: '6614gamers Vinter-LAN', teamSize: 5 });

  const roster = (prefix: string, block: string) =>
    [1, 2, 3, 4, 5].map((i) => ({
      name: `${prefix} Spiller ${i}`,
      nickname: `${prefix}${i}`,
      seating: `${block}${String(i).padStart(2, '0')}`,
    }));

  const teams = [];
  const names = ['Søre Bøkeskog', 'Kristiansand Kings', 'Vågsbygd Vipers', 'Østre Ørner'];
  const blocks = ['A', 'B', 'C', 'D'];
  for (let i = 0; i < 4; i++) {
    teams.push(
      await createTeam(tournament.id, {
        name: names[i],
        seed: i + 1,
        players: roster(names[i].split(' ')[0], blocks[i]),
      })
    );
  }

  const mkMatch = (home: string, away: string, order: number, status: string) =>
    prisma.match.create({
      data: {
        tournamentId: tournament.id,
        homeTeamId: home,
        awayTeamId: away,
        round: 1,
        matchOrder: order,
        bestOf: 1,
        scoreLimit: 1,
        status,
        bracketType: 'WINNERS',
      },
    });

  const called = await mkMatch(teams[0].id, teams[1].id, 0, 'READY');
  const live = await mkMatch(teams[2].id, teams[3].id, 1, 'LIVE');
  const pending = await mkMatch(teams[0].id, teams[2].id, 2, 'PENDING');
  // A round-2 slot with only one side known, so "N kamper til venter på tidligere resultater."
  await prisma.match.create({
    data: {
      tournamentId: tournament.id,
      homeTeamId: teams[1].id,
      awayTeamId: null,
      round: 2,
      matchOrder: 0,
      bestOf: 1,
      scoreLimit: 1,
      status: 'PENDING',
      bracketType: 'WINNERS',
    },
  });

  // Three of five seated on the called match — the "3/5 på plass" case.
  const homePlayers = await prisma.player.findMany({ where: { teamId: teams[0].id }, orderBy: { seating: 'asc' } });
  for (const p of homePlayers.slice(0, 3)) {
    await prisma.player.update({ where: { id: p.id }, data: { checkedInAt: new Date() } });
  }

  // Called twelve minutes ago: exercises the longest elapsed-time string *and* the warning tone.
  // Raw SQL because `updatedAt` is @updatedAt and Prisma would stamp "now" over it.
  await prisma.$executeRawUnsafe(
    `UPDATE "Match" SET "updatedAt" = ? WHERE id = ?`,
    new Date(Date.now() - 12 * 60000).toISOString(),
    called.id
  );

  return { tournament, called, live, pending, teams };
}

test('04 — the marshal board, the surface this lane exists for', async ({ browser }) => {
  const floor = await seedMarshalFloor();

  for (const [label, viewport] of [['desktop', DESKTOP], ['phone', PHONE]] as const) {
    const { ctx, page } = await newPage(browser, viewport);
    await loginAs(page, 'mia');
    await page.goto(`/marshal/dashboard?t=${floor.tournament.id}`);
    await expectNorwegian(page);
    await expect(page.getByTestId(`marshal-match-${floor.called.id}`)).toBeVisible();
    await shoot(page, `${label}-04-marshal-board`);

    // The dense header row on its own: connection state + refresh + (on desktop) the picker.
    await page.locator('main > div').first().screenshot({ path: `${OUT}/${label}-04-marshal-header.png` });

    // One called match card, full width — the part a marshal reads while walking.
    await page
      .getByTestId(`marshal-match-${floor.called.id}`)
      .screenshot({ path: `${OUT}/${label}-04-marshal-called-card.png` });

    await ctx.close();
  }

  // The connection state in its non-"Live" spellings: kill the stream and watch it degrade.
  const { ctx, page } = await newPage(browser, PHONE);
  await loginAs(page, 'mia');
  await page.route('**/api/tournaments/*/stream*', (route) => route.abort());
  await page.goto(`/marshal/dashboard?t=${floor.tournament.id}`);
  await page.waitForTimeout(2500);
  await page.locator('main > div').first().screenshot({ path: `${OUT}/phone-04-marshal-connection-degraded.png` });
  await ctx.close();
});

test('05 — the marshal board when things go wrong', async ({ browser }) => {
  const floor = await seedMarshalFloor();

  // The whole-board error card.
  {
    const { ctx, page } = await newPage(browser, PHONE);
    await loginAs(page, 'mia');
    await page.route('**/api/tournaments?**', (route) => route.abort());
    await page.route('**/api/tournaments', (route) => route.abort());
    await page.goto('/marshal/dashboard');
    await page.waitForTimeout(2500);
    await shoot(page, 'phone-05-marshal-load-error');
    await ctx.close();
  }

  // The action error banner: "Kunne ikke kalle opp kampen: …" over a real card.
  {
    const { ctx, page } = await newPage(browser, PHONE);
    await loginAs(page, 'mia');
    await page.goto(`/marshal/dashboard?t=${floor.tournament.id}`);
    await expect(page.getByTestId(`marshal-match-${floor.pending.id}`)).toBeVisible();
    await page.route('**/api/matches/*/load', (route) => route.abort());
    await page.getByTestId(`marshal-call-${floor.pending.id}`).click();
    await page.waitForTimeout(1200);
    await shoot(page, 'phone-05-marshal-action-error');
    await ctx.close();
  }

  // And the empty board: no tournament at all.
  {
    await wipeTournaments();
    const { ctx, page } = await newPage(browser, PHONE);
    await loginAs(page, 'mia');
    await page.goto('/marshal/dashboard');
    await page.waitForTimeout(1500);
    await shoot(page, 'phone-05-marshal-empty');
    await ctx.close();
  }

  expect(await apiAs('mia')).toBeTruthy();
});
