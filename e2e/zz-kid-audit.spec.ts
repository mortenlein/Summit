// Audit fixture: every surface a PLAYER (12-15) touches, in Norwegian, phone-first.
// Not part of the suite (zz-*). Run with VISUAL_AUDIT=1.
import { test, type Page } from '@playwright/test';
import { loginAs, personaUserId, mintSessionToken } from './helpers/auth';
import { apiAs } from './helpers/api';
import { createTournament, createTeam, prisma } from './helpers/lan-seed';

const OUT = process.env.SHOT_DIR!;
const NICKS = ['s1mple','dev1ce','NiKo','ropz','ZywOo','flameZ','jL','b1t','donk','sh1ro',
               'broky','rain','karrigan','frozen','blameF','Spinx','torzsi','xertioN','siuhy','w0nderful'];

async function nb(browser: any, w: number, h: number) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, locale: 'nb-NO' });
  await ctx.clearCookies();
  await ctx.addCookies([{ name: 'summit.locale', value: 'nb', domain: '127.0.0.1', path: '/' }]);
  return ctx;
}
const shoot = async (p: Page, name: string) => {
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
};

test('kid-facing surfaces in Norwegian', async ({ browser }) => {
  const t = await createTournament({ name: 'Mortenlab LAN #7', teamSize: 5, steamSignupEnabled: true, bo3LastRounds: 2 });
  const names = ['Nordic Wolves','Team Fjord','Bergen Bears','Oslo Owls','Stavanger Storm','Tromsø Tigers','Kristiansand Kings','Trondheim Titans'];
  const teams = [];
  for (let i = 0; i < 8; i++) {
    teams.push(await createTeam(t.id, { name: names[i], seed: i + 1,
      players: Array.from({ length: 5 }, (_, j) => ({
        name: `Spiller ${i}${j}`, nickname: NICKS[(i*5+j) % NICKS.length],
        seating: `${String.fromCharCode(65+i)}${String(j+1).padStart(2,'0')}`,
        countryCode: ['no','se','dk','fi'][j%4], isLeader: j===0 })) }));
  }
  const admin = await apiAs('marcus');
  await admin.post(`/api/tournaments/${t.id}/generate`, { data: {} });
  const ms = await prisma.match.findMany({ where: { tournamentId: t.id }, orderBy: [{round:'asc'},{matchOrder:'asc'}] });
  await admin.post(`/api/matches/${ms[0].id}`, { data: { homeScore: 1, awayScore: 0, bestOf: 1, status: 'COMPLETED' } });
  await admin.post(`/api/matches/${ms[1].id}`, { data: { status: 'LIVE' } });
  await admin.post(`/api/matches/${ms[2].id}/load`, { data: {} });

  // leo sits on the CALLED match — the state that matters most
  await mintSessionToken('leo');
  const called = await prisma.match.findUnique({ where: { id: ms[2].id } });
  const seat = (await prisma.player.findMany({ where: { teamId: called!.homeTeamId! }, orderBy: { name: 'asc' } }))[0];
  await prisma.player.update({ where: { id: seat.id }, data: { userId: await personaUserId('leo') } });
  // a second, open tournament so register shows a live sign-up
  const open = await createTournament({ name: 'Fredagsduo', teamSize: 2, steamSignupEnabled: true });

  for (const [tag, w, h] of [['phone', 390, 844], ['desk', 1512, 950]] as const) {
    const ctx = await nb(browser, w, h);
    const p = await ctx.newPage();
    await p.goto('/');                                   await shoot(p, `${tag}-01-landing-anon`);
    await p.goto('/tournaments');                        await shoot(p, `${tag}-02-directory`);
    await p.goto('/login');                              await shoot(p, `${tag}-03-login`);
    await p.goto(`/tournaments/${t.id}`);                await shoot(p, `${tag}-04-tournament`);
    await p.goto(`/tournaments/${t.id}?tab=bracket`);    await shoot(p, `${tag}-05-bracket`);
    await p.goto(`/tournaments/${t.id}?tab=teams`);      await shoot(p, `${tag}-06-teams`);
    await p.goto(`/tournaments/${t.id}?tab=matches`);    await shoot(p, `${tag}-07-matches`);
    await loginAs(p, 'leo');
    await p.goto('/dashboard');                          await shoot(p, `${tag}-08-desk-called`);
    await p.goto(`/tournaments/${open.id}/register`);    await shoot(p, `${tag}-09-register-new`);
    await p.goto(`/tournaments/${t.id}/register`);       await shoot(p, `${tag}-10-register-myteam`);
    await p.goto('/profile');                            await shoot(p, `${tag}-11-profile`);
    await ctx.close();
  }
});
