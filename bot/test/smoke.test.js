/**
 * Smoke tests: spawn the real `index.js`.
 *
 * There is no real Discord token yet, and there will not be one before the LAN rehearsal.
 * These assert what can be asserted without one: the process boots, logs legibly, serves
 * /healthz and /status, refuses to lie about being ready, shuts down cleanly on SIGTERM, and
 * — critically — does not crash-loop when Discord is unreachable or the token is junk.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(BOT_DIR, 'index.js');

/**
 * Ask the OS for a free port rather than hardcoding one.
 *
 * These were fixed high ports. Two suite runs back to back could collide, because the previous
 * run's SIGKILLed child has not always released its socket yet — and now that a bind failure is
 * a named fatal (it used to hang forever), that collision surfaces as a confusing test failure
 * about the wrong thing. Four other agents are also running specs on this box.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const FAKE_ENV = {
  DISCORD_BOT_TOKEN: 'MTIzNDU2Nzg5MDEyMzQ1Njc4.Xxxxxx.not-a-real-token-at-all',
  DISCORD_CLIENT_ID: '123456789012345678',
  DISCORD_GUILD_ID: '987654321098765432',
  SUMMIT_BOT_KEY: 'smoke-test-bot-key',
  SUMMIT_API_URL: 'http://127.0.0.1:1', // guaranteed-closed port; the bot must not care at boot
  BOT_HEALTH_HOST: '127.0.0.1',
  TZ: 'Europe/Oslo',
};

function startBot(extraEnv) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: BOT_DIR,
    env: { ...process.env, ...FAKE_ENV, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  return {
    child,
    get output() { return output; },
    exited: new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal }))),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, { timeoutMs = 15000, everyMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(everyMs);
  }
}

const healthz = (port) => fetch(`http://127.0.0.1:${port}/healthz`).then(
  (r) => r.text().then((text) => ({ status: r.status, text })),
  () => null,
);

test('boots, serves /healthz and /status, and exits 0 on SIGTERM', async () => {
  const PORT_NO_GATEWAY = await freePort();
  const bot = startBot({ BOT_HEALTH_PORT: String(PORT_NO_GATEWAY), BOT_NO_GATEWAY: 'true' });
  try {
    const health = await waitFor(() => healthz(PORT_NO_GATEWAY));
    assert.ok(health, `health server never came up. Output:\n${bot.output}`);

    // It must NOT claim to be healthy while it has no gateway connection.
    assert.equal(health.status, 503);
    assert.match(health.text, /not-ready starting/);

    const status = await fetch(`http://127.0.0.1:${PORT_NO_GATEWAY}/status`).then((r) => r.json());
    assert.equal(status.state, 'starting');
    assert.equal(status.guildId, FAKE_ENV.DISCORD_GUILD_ID);
    assert.deepEqual(status.commands, ['koble', 'stopp']);
    assert.equal(status.summitUrl, 'http://127.0.0.1:1');
    assert.ok(status.version, 'version should be read from package.json');

    // --- /status may not overstate anything -------------------------------------------------
    // `lastLinkOkAt` used to sit here, stamped by ANY 2xx from the app — including
    // `{ok:false, reason:"unknown_code"}` and including an opt-out. The runbook told an
    // organizer it meant "when a player last linked successfully". It did not. It is gone; the
    // honest pair is `lastAppOkAt` (the app answered) and `lastLinkConfirmedAt` (a link
    // actually happened, per the app).
    assert.equal(status.lastLinkOkAt, undefined, 'lastLinkOkAt must not come back');
    assert.equal(status.lastLinkConfirmedAt, null);
    assert.equal(status.lastOptOutConfirmedAt, null);
    assert.equal(status.lastAppOkAt, null);
    assert.equal(status.appCalls, 0);
    assert.deepEqual(status.interactions, {
      koble: 0, kobleLinked: 0, stopp: 0, stoppConfirmed: 0, button: 0, failed: 0,
    });
    // Never connected, so we have not heard from Discord and must not claim its commands are
    // in place — `null` is "unknown", and it is the only true answer before ClientReady.
    assert.equal(status.commandsRegistered, null);
    assert.equal(status.commandsAction, null);

    // The two inputs /healthz bounds `reconnecting` by, so the endpoints cannot disagree.
    assert.ok(Date.parse(status.stateSince), 'stateSince should be an ISO timestamp');
    assert.equal(status.reconnectGraceMs, 300000);

    // No secret anywhere in /status or in the logs.
    const statusText = JSON.stringify(status);
    assert.ok(!statusText.includes(FAKE_ENV.DISCORD_BOT_TOKEN), statusText);
    assert.ok(!statusText.includes(FAKE_ENV.SUMMIT_BOT_KEY), statusText);
    assert.ok(!bot.output.includes(FAKE_ENV.DISCORD_BOT_TOKEN), bot.output);
    assert.ok(!bot.output.includes(FAKE_ENV.SUMMIT_BOT_KEY), bot.output);

    // The startup lines a human reads at 01:00.
    assert.match(bot.output, /Summit gateway bot v\d/);
    assert.match(bot.output, /Health server listening/);
    assert.match(bot.output, /\/healthz \/status/);

    bot.child.kill('SIGTERM');
    const { code } = await bot.exited;
    assert.equal(code, 0, `expected a clean shutdown. Output:\n${bot.output}`);
    assert.match(bot.output, /SIGTERM — shutting down/);
  } finally {
    bot.child.kill('SIGKILL');
  }
});

test('a fake token and an unreachable Discord do not produce a crash loop', async () => {
  // Either outcome is correct and both are asserted here, because it depends on whether the
  // machine running the test has internet:
  //   no network  → recoverable, logged, retried with backoff, process stays up
  //   network     → Discord 401s the junk token → unrecoverable, but the process waits before
  //                 exiting so `restart: unless-stopped` cannot burn the IDENTIFY budget.
  const PORT_FAKE_TOKEN = await freePort();
  const bot = startBot({
    BOT_HEALTH_PORT: String(PORT_FAKE_TOKEN),
    BOT_FATAL_EXIT_DELAY_MS: '3000', // 30s in production; shortened so the test is not slow
  });
  try {
    assert.ok(!/Could not bind the health port/.test(bot.output), bot.output);
    const classified = await waitFor(
      () => (/Gateway connect failed — retrying in|FATAL: Discord rejected the credentials/.test(bot.output)
        ? bot.output
        : null),
      { timeoutMs: 30000 },
    );
    assert.ok(classified, `no classified gateway outcome. Output:\n${bot.output}`);

    // Whatever happened, it was handled — never an unhandled throw or a bare stack trace.
    assert.ok(!/UnhandledPromiseRejection|\bthrow er;|node:internal\/process\/promises/.test(bot.output), bot.output);
    assert.match(bot.output, /Connecting to the Discord gateway/);

    if (/FATAL: Discord rejected the credentials/.test(bot.output)) {
      assert.match(bot.output, /Exiting in \d+s/);
      // It must still be alive right after the fatal line — the delay is the whole point.
      assert.equal(bot.child.exitCode, null);
      const { code } = await bot.exited;
      assert.equal(code, 1);
    } else {
      // Recoverable path: still running, still serving health, reporting itself not-ready.
      const health = await healthz(PORT_FAKE_TOKEN);
      assert.ok(health);
      assert.equal(health.status, 503);
      assert.equal(bot.child.exitCode, null);
    }
  } finally {
    bot.child.kill('SIGKILL');
  }
});

test('a missing required env var is named in the log, and exit is delayed', async () => {
  const PORT_MISSING_ENV = await freePort();
  const bot = startBot({
    BOT_HEALTH_PORT: String(PORT_MISSING_ENV),
    BOT_FATAL_EXIT_DELAY_MS: '2000',
    SUMMIT_BOT_KEY: '',
  });
  try {
    const seen = await waitFor(() => (/Missing required environment variables/.test(bot.output) ? bot.output : null));
    assert.ok(seen, `expected a named missing variable. Output:\n${bot.output}`);
    assert.match(bot.output, /SUMMIT_BOT_KEY/);
    assert.match(bot.output, /\.env\.bot/);

    // Health is up and honest even in the failure case, so `docker inspect` shows unhealthy
    // rather than a container that never bound a port.
    const health = await healthz(PORT_MISSING_ENV);
    assert.ok(health, 'health server should still be listening');
    assert.equal(health.status, 503);
    assert.match(health.text, /fatal/);

    const { code } = await bot.exited;
    assert.equal(code, 1);
  } finally {
    bot.child.kill('SIGKILL');
  }
});
