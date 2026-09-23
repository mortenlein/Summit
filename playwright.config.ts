import path from 'path';
import { defineConfig, devices } from '@playwright/test';

// One dev server + one SQLite file per E2E_PORT, so several suites (e.g. parallel agents in
// separate worktrees) can run on the same machine without sharing a port or a database.
const E2E_PORT = process.env.E2E_PORT || '4101';
process.env.E2E_PORT = E2E_PORT;
const DATABASE_URL = `file:${path.resolve(process.cwd(), 'prisma', `e2e-${E2E_PORT}.db`).replace(/\\/g, '/')}`;
process.env.DATABASE_URL = DATABASE_URL;
// Admin is an identity now: the "marcus" mock persona (steamid below) resolves to admin.
process.env.ADMIN_STEAMIDS = '76561198000000001';
// Marshal is an identity too: the "mia" mock persona (e2e/helpers/auth.ts) is floor staff —
// she can call matches and check players in, but is not an admin.
process.env.MARSHAL_STEAMIDS = '76561198000000006';
process.env.MOCK_AUTH_MODE = 'true';
process.env.NEXT_PUBLIC_MOCK_AUTH = 'true';
process.env.NEXT_PUBLIC_STRATEGY_3_MOCK = 'true';
process.env.NEXTAUTH_SECRET = 'test-secret';
process.env.NEXTAUTH_URL = `http://127.0.0.1:${E2E_PORT}`;
// SteamProvider throws "clientSecret is empty" on construction without this, which 500s
// EVERY /api/auth/* request (providers, session, signin) and breaks all auth in tests.
process.env.STEAM_API_KEY = 'e2e-placeholder';
// The suite asserts English copy. The app defaults to Norwegian (it is a Norwegian club), so
// pin the harness rather than translating 201 assertions; the Norwegian rendering has its own
// spec. `getRequestLocale` reads this cookie first, before Accept-Language.
process.env.E2E_LOCALE = 'en';
// Inbound CS2 webhook bearer key — explicit so tests never depend on (or leak) the real .env.
process.env.CS2_WEBHOOK_KEY = 'e2e-cs2-webhook-key';
// Discord account linking has to be *configured* for its specs to mean anything: the card and
// the bot callbacks self-hide (null / 503) when these are unset, exactly like push with no
// VAPID keys, so every assertion would otherwise pass for the wrong reason. Test-only values —
// no real guild, no real invite, and deliberately NOT the CS2 key (that one goes to a game
// server).
process.env.SUMMIT_BOT_KEY = 'e2e-summit-bot-key';
process.env.DISCORD_GUILD_ID = '000000000000000001';
process.env.DISCORD_INVITE_URL = 'https://discord.gg/e2e-6614gamers';
// A placeholder token, because `isDiscordLinkConfigured()` requires one: without the token the
// app cannot open a DM channel at all, so the card hides rather than walking a kid through
// three steps for a link that can never deliver. Nothing dials Discord with this string —
// NEXT_PUBLIC_STRATEGY_3_MOCK above is the *only* thing that selects the mock probe, and the
// mock records MOCKED, never SENT.
process.env.DISCORD_BOT_TOKEN = 'e2e-placeholder-bot-token';
// The hard master switch (§5) ships false. The suite flips it on, or every probe would record
// SKIPPED_DISABLED and the BLOCKED path — the one that decides whether a marshal walks — would
// never be exercised.
process.env.DISCORD_DM_ENABLED = 'true';
// One snowflake the mock DM probe refuses with Discord's real 50007, so the BLOCKED path —
// the one that decides whether a marshal walks to a seat — is assertable without a token.
process.env.DISCORD_DM_MOCK_BLOCKED = '300000000000000900';
// The channel-post equivalent of DISCORD_DM_SIMULATE: a spec writes `{"fail": true}` here to
// make the mock delivery path report a failed post, which is the only way to test that a
// once-per-match announcement survives a bad minute at Discord instead of spending its one
// chance on it.
process.env.DISCORD_ANNOUNCE_SIMULATE = path.resolve(process.cwd(), 'prisma', `e2e-${E2E_PORT}-announce-sim.json`);
// Web push has to be *configured* for the player-notification specs to mean anything:
// /api/push/public-key hands back null and sendPushToUsers() returns before touching a
// subscription when VAPID is unset, so "delivery was attempted" would be unfalsifiable.
// Throwaway keypair generated once with `npx web-push generate-vapid-keys` — test-only, it
// signs pushes to nothing (the specs subscribe with an unroutable endpoint).
process.env.VAPID_PUBLIC_KEY = 'BJEVgFRpP8GtXwHqfpwTfPVWJdA5MwqHPkhXgiXo7caRItlOoBBHAE3KZ0JBNCfEV2z-VFRagJ9zdZ8lhgAEaNw';
process.env.VAPID_PRIVATE_KEY = 'x65aEqVjG5zvx9JMuhvrTMQmtGSs2NKwPicYayEAP0U';
process.env.VAPID_SUBJECT = 'mailto:e2e@summit.local';
// A push is encrypted with the subscriber's own keys, so a spec cannot read what was delivered.
// src/lib/push.ts appends one JSON line per delivery attempt to this file when it is set (unset
// everywhere else, including production) — that is how player-push.spec.ts can see that two
// players on one match were written to in two different languages.
process.env.PUSH_DELIVERY_LOG = path.resolve(process.cwd(), 'prisma', `e2e-${E2E_PORT}-push.log`);
// Discord DMs. There is no bot token in a test run (and none on the box yet), so
// `src/lib/discord-dm.ts` takes its mock transport — but the fan-out itself, the attempt rows
// and the per-locale composition are the real code path, and DISCORD_DM_ENABLED has to be on or
// the whole thing returns before touching a recipient and every assertion passes for the wrong
// reason. Same posture as VAPID above.
process.env.DISCORD_DM_ENABLED = 'true';
// The config circuit breaker holds for five minutes in production. A spec has to be able to
// watch it trip AND watch it heal, and it must not poison the DM specs that run after it, so
// the harness shortens the cooldown rather than adding a reset backdoor to the module.
process.env.DISCORD_DM_BREAKER_MS = '1500';
// One JSON line per DM attempt — what would have been sent, and what Discord answered. This is
// the only way a spec can read a message body that, in production, exists nowhere but a kid's
// phone. Mirrors PUSH_DELIVERY_LOG; unset everywhere else, including production.
process.env.DISCORD_DM_LOG = path.resolve(process.cwd(), 'prisma', `e2e-${E2E_PORT}-dm.log`);
// Lets a spec make Discord fail in a named way (50007 "DMs closed", 429, …). The error table is
// the half of the DM sender most likely to be wrong and is otherwise unreachable without a real
// token and a real kid with DMs switched off. Read fresh on every send; unset in production.
process.env.DISCORD_DM_SIMULATE = path.resolve(process.cwd(), 'prisma', `e2e-${E2E_PORT}-dm-sim.json`);
// The guild's member list, for the half of Discord linking that turns a typed name into an
// account. No test run has a Discord server, so without this the "nobody has that name" and
// "several people do" branches are unreachable — and those are the two a kid will actually hit.
process.env.DISCORD_GUILD_DIRECTORY = path.resolve(process.cwd(), 'prisma', `e2e-${E2E_PORT}-guild.json`);

export default defineConfig({
  testDir: './e2e',
  // `zz-*` specs are visual-audit tools (they screenshot surfaces for a human/agent to look at),
  // not assertions, so the suite skips them. `testIgnore` wins over an explicit path argument,
  // so running one needs the flag:
  //   VISUAL_AUDIT=1 SHOT_DIR=/tmp/shots npx playwright test e2e/zz-<name>.spec.ts
  testIgnore: process.env.VISUAL_AUDIT ? undefined : '**/zz-*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Generous timeouts: `next dev` compiles each heavy route on first hit (the manage cockpit
  // and marshal board take ~10-15s), which delays client-nav URL changes and element waits.
  timeout: 90000,
  expect: { timeout: 20000 },
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    // Every context starts in English (see the note by E2E_LOCALE above).
    storageState: {
      cookies: [
        {
          name: 'summit.locale',
          value: 'en',
          domain: '127.0.0.1',
          path: '/',
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: 'Lax' as const,
        },
      ],
      origins: [],
    },
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run dev:e2e',
    url: `http://127.0.0.1:${E2E_PORT}`,
    reuseExistingServer: false,
    timeout: 180000,
    env: {
      ...process.env,
      DATABASE_URL,
      E2E_PORT,
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
