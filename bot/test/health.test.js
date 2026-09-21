import test from 'node:test';
import assert from 'node:assert/strict';

import { createHealthServer, isLive } from '../src/health.js';
import { readConfig, REQUIRED } from '../src/config.js';

async function withServer(getStatus, fn) {
  const health = createHealthServer({ getStatus, logger: { error: () => {} } });
  const address = await health.listen(0, '127.0.0.1');
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await health.close();
  }
}

test('/healthz is 200 for ready and a fresh reconnect, 503 for starting and fatal', async () => {
  const fresh = new Date().toISOString();
  const cases = [['ready', 200], ['reconnecting', 200], ['starting', 503], ['fatal', 503]];
  for (const [state, expected] of cases) {
    await withServer(() => ({ state, stateSince: fresh }), async (base) => {
      const res = await fetch(`${base}/healthz`);
      assert.equal(res.status, expected, `state=${state}`);
    });
  }
});

// This previously asserted that `reconnecting` is 200 forever. That pinned a health endpoint
// which answers `ok` while the bot has been off the gateway for an hour and nobody can run
// /koble — the observability version of claiming a player was notified. It is bounded now.
test('a reconnect that has gone on past the grace window stops reporting itself healthy', async () => {
  const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  await withServer(
    () => ({ state: 'reconnecting', stateSince: stale, reconnectGraceMs: 300000 }),
    async (base) => {
      const res = await fetch(`${base}/healthz`);
      assert.equal(res.status, 503);
      assert.match(await res.text(), /not-ready reconnecting/);
    },
  );
});

test('/healthz does NOT depend on the app being reachable', async () => {
  // Rebuilding `summit` must not flip the bot unhealthy — server-vakt alerts on first sighting.
  const status = {
    state: 'ready',
    stateSince: new Date().toISOString(),
    lastError: 'HTTP 502',
    lastAppOkAt: null,
  };
  await withServer(() => status, async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
  });
});

test('isLive is the whole liveness rule, and `reconnecting` is the only timed one', () => {
  const now = 1_000_000;
  assert.equal(isLive('ready'), true);
  assert.equal(isLive('starting'), false);
  assert.equal(isLive('fatal'), false);
  assert.equal(isLive(undefined), false);

  assert.equal(isLive('reconnecting', { since: now - 1000, graceMs: 300000, now }), true);
  assert.equal(isLive('reconnecting', { since: now - 300001, graceMs: 300000, now }), false);
  // No clock to judge by: do not invent a failure out of a missing timestamp.
  assert.equal(isLive('reconnecting', { since: null, now }), true);

  // A long-ready bot is live no matter how long it has been ready.
  assert.equal(isLive('ready', { since: now - 99_999_999, graceMs: 1, now }), true);
});

test('/status carries the bounded-liveness inputs, so the two endpoints cannot disagree', async () => {
  const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  await withServer(
    () => ({ state: 'reconnecting', stateSince: stale, reconnectGraceMs: 300000 }),
    async (base) => {
      const body = await fetch(`${base}/status`).then((r) => r.json());
      assert.equal(body.stateSince, stale);
      assert.equal(body.reconnectGraceMs, 300000);
    },
  );
});

test('/status returns JSON and leaks no secret', async () => {
  const status = {
    state: 'ready',
    guildId: '999',
    commands: ['koble', 'stopp'],
    summitUrl: 'http://summit:4001',
    lastError: null,
    uptimeSeconds: 12,
  };
  await withServer(() => status, async (base) => {
    const res = await fetch(`${base}/status`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.state, 'ready');
    assert.deepEqual(body.commands, ['koble', 'stopp']);
    const text = JSON.stringify(body);
    assert.ok(!/token|bearer|secret|password/i.test(text), text);
  });
});

test('anything else is a 404, not a stack trace', async () => {
  await withServer(() => ({ state: 'ready' }), async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 404);
  });
});

// --- config -------------------------------------------------------------------------------

test('the four required vars are named, and a missing one is reported, not guessed', () => {
  assert.deepEqual(REQUIRED, ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID', 'SUMMIT_BOT_KEY']);
  const { missing } = readConfig({ DISCORD_BOT_TOKEN: 'x', DISCORD_CLIENT_ID: ' ' });
  assert.deepEqual(missing, ['DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID', 'SUMMIT_BOT_KEY']);
});

test('the app URL defaults to the compose network, never the tunnel', () => {
  const { config } = readConfig({});
  assert.equal(config.summitUrl, 'http://summit:4001');
});

test('SUMMIT_API_URL wins over the SUMMIT_URL alias, and trailing slashes go', () => {
  const { config } = readConfig({ SUMMIT_API_URL: 'http://summit:4001/', SUMMIT_URL: 'http://other/' });
  assert.equal(config.summitUrl, 'http://summit:4001');
  const alias = readConfig({ SUMMIT_URL: 'http://summit:4001//' }).config;
  assert.equal(alias.summitUrl, 'http://summit:4001');
});

test('the health listener binds 0.0.0.0 by default, not loopback', () => {
  // A loopback-only listener passes the container HEALTHCHECK while every other reader fails.
  const { config } = readConfig({});
  assert.equal(config.healthHost, '0.0.0.0');
  assert.equal(config.healthPort, 4002);
});

test('numeric env vars fall back rather than becoming NaN', () => {
  const { config } = readConfig({
    BOT_HEALTH_PORT: 'banana',
    SUMMIT_TIMEOUT_MS: '',
    BOT_FATAL_EXIT_DELAY_MS: '0',
    BOT_RECONNECT_GRACE_MS: 'soon',
  });
  assert.equal(config.healthPort, 4002);
  assert.equal(config.requestTimeoutMs, 8000);
  assert.equal(config.fatalExitDelayMs, 30000);
  assert.equal(config.reconnectGraceMs, 300000);
});

test('pasted secrets and ids are trimmed, so a trailing newline is not a mystery outage', () => {
  // `SUMMIT_BOT_KEY=abc ` untrimmed becomes the header `Bearer abc `, and a trailing \n makes
  // Node's fetch throw "invalid header value" — which the player is then shown as "Summit
  // isn't responding".
  const { config, missing } = readConfig({
    DISCORD_BOT_TOKEN: ' tok\n',
    DISCORD_CLIENT_ID: '123 ',
    DISCORD_GUILD_ID: '\t456',
    SUMMIT_BOT_KEY: 'key\n',
    SUMMIT_API_URL: ' http://summit:4001/ ',
  });
  assert.deepEqual(missing, []);
  assert.equal(config.token, 'tok');
  assert.equal(config.clientId, '123');
  assert.equal(config.guildId, '456');
  assert.equal(config.botKey, 'key');
  assert.equal(config.summitUrl, 'http://summit:4001');
});
