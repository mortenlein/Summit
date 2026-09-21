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

test('/healthz is 200 for ready and reconnecting, 503 for starting and fatal', async () => {
  for (const [state, expected] of [['ready', 200], ['reconnecting', 200], ['starting', 503], ['fatal', 503]]) {
    await withServer(() => ({ state }), async (base) => {
      const res = await fetch(`${base}/healthz`);
      assert.equal(res.status, expected, `state=${state}`);
    });
  }
});

test('/healthz does NOT depend on the app being reachable', async () => {
  // Rebuilding `summit` must not flip the bot unhealthy — server-vakt alerts on first sighting.
  await withServer(() => ({ state: 'ready', lastError: 'HTTP 502', lastLinkOkAt: null }), async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
  });
});

test('isLive is the whole liveness rule', () => {
  assert.equal(isLive('ready'), true);
  assert.equal(isLive('reconnecting'), true);
  assert.equal(isLive('starting'), false);
  assert.equal(isLive('fatal'), false);
  assert.equal(isLive(undefined), false);
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
  const { config } = readConfig({ BOT_HEALTH_PORT: 'banana', SUMMIT_TIMEOUT_MS: '', BOT_FATAL_EXIT_DELAY_MS: '0' });
  assert.equal(config.healthPort, 4002);
  assert.equal(config.requestTimeoutMs, 8000);
  assert.equal(config.fatalExitDelayMs, 30000);
});
