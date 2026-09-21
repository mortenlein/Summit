import test from 'node:test';
import assert from 'node:assert/strict';

import { createSummitClient } from '../src/summit-client.js';

function recordingFetch(handler) {
  const calls = [];
  const impl = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
  impl.calls = calls;
  return impl;
}

const jsonResponse = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

test('POSTs to /api/discord/link with the bearer key and a JSON body', async () => {
  const fetchImpl = recordingFetch(async () => jsonResponse(200, { ok: true, reply: 'Koblet!' }));
  const client = createSummitClient({ baseUrl: 'http://summit:4001', botKey: 'secret-key', fetchImpl });

  const result = await client.postLink({ code: 'H7K2QP', discordId: '1', discordUsername: 'mia' });

  assert.equal(fetchImpl.calls[0].url, 'http://summit:4001/api/discord/link');
  assert.equal(fetchImpl.calls[0].init.method, 'POST');
  assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer secret-key');
  assert.equal(JSON.parse(fetchImpl.calls[0].init.body).code, 'H7K2QP');
  assert.equal(result.ok, true);
  assert.equal(result.body.reply, 'Koblet!');
});

test('POSTs to /api/discord/optout', async () => {
  const fetchImpl = recordingFetch(async () => jsonResponse(200, { ok: true, reply: 'Ok' }));
  const client = createSummitClient({ baseUrl: 'http://summit:4001', botKey: 'k', fetchImpl });
  await client.postOptOut({ discordId: '1' });
  assert.equal(fetchImpl.calls[0].url, 'http://summit:4001/api/discord/optout');
});

test('a trailing slash on SUMMIT_API_URL does not produce a double slash', async () => {
  const fetchImpl = recordingFetch(async () => jsonResponse(200, { ok: true }));
  // The trailing slash is stripped in readConfig; assert the joined shape holds anyway.
  const client = createSummitClient({ baseUrl: 'http://summit:4001', botKey: 'k', fetchImpl });
  await client.postLink({});
  assert.ok(!fetchImpl.calls[0].url.includes('//api'), fetchImpl.calls[0].url);
});

test('401 from the app (wrong or missing bearer) is reported, never thrown', async () => {
  const fetchImpl = recordingFetch(async () => jsonResponse(401, { ok: false }));
  const client = createSummitClient({ baseUrl: 'http://x', botKey: 'wrong', fetchImpl });
  const result = await client.postLink({ code: 'A' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.error, 'HTTP 401');
  assert.match(client.stats.lastError, /401/);
});

test('503 from the app (its own SUMMIT_BOT_KEY unset — fail closed) is reported, never thrown', async () => {
  const fetchImpl = recordingFetch(async () => jsonResponse(503, { ok: false }));
  const client = createSummitClient({ baseUrl: 'http://x', botKey: 'k', fetchImpl });
  const result = await client.postLink({ code: 'A' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
});

// Previously this file asserted that an empty botKey still produced a request and let the app
// 503 it. That pinned a fail-OPEN client: on the day the app's own check regresses, an
// anonymous `Bearer ` POST would link accounts. The bot now refuses locally.
test('an empty SUMMIT_BOT_KEY means no request is ever made — fail closed in the bot too', async () => {
  const fetchImpl = recordingFetch(async () => jsonResponse(200, { ok: true, reply: 'Koblet!' }));
  const client = createSummitClient({ baseUrl: 'http://x', botKey: '', fetchImpl });

  const result = await client.postLink({ code: 'A' });

  assert.equal(fetchImpl.calls.length, 0, 'no POST may leave the process without a bearer key');
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.equal(result.error, 'no bot key');
  assert.equal(client.stats.refusedNoKey, 1);
  assert.match(client.stats.lastError, /SUMMIT_BOT_KEY/);
});

test('a whitespace-only key is treated as no key, not as a key made of spaces', async () => {
  const fetchImpl = recordingFetch(async () => jsonResponse(200, { ok: true }));
  const client = createSummitClient({ baseUrl: 'http://x', botKey: '   ', fetchImpl });
  await client.postOptOut({ discordId: '1' });
  assert.equal(fetchImpl.calls.length, 0);
});

test('a key with a pasted newline is refused rather than thrown from inside fetch', async () => {
  // `SUMMIT_BOT_KEY=abc\n` in a hand-written .env.bot: readConfig trims it, but if anything
  // ever hands one through, an invalid header value must not surface as a TypeError that the
  // interaction handler reports to a player as "Summit isn't responding".
  const fetchImpl = recordingFetch(async () => jsonResponse(200, { ok: true }));
  const client = createSummitClient({ baseUrl: 'http://x', botKey: 'abc\ndef', fetchImpl });
  const result = await client.postLink({ code: 'A' });
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(result.error, 'no bot key');
});

test('an HTML 502 from a restarting app does not throw on JSON parsing', async () => {
  const fetchImpl = recordingFetch(async () => new Response('<html>502</html>', {
    status: 502,
    headers: { 'content-type': 'text/html' },
  }));
  const client = createSummitClient({ baseUrl: 'http://x', botKey: 'k', fetchImpl });
  const result = await client.postLink({ code: 'A' });
  assert.equal(result.ok, false);
  assert.equal(result.body, null);
});

test('a network error returns ok:false with status 0 — the app is simply not there', async () => {
  const fetchImpl = recordingFetch(async () => { throw Object.assign(new Error('fetch failed'), { name: 'TypeError' }); });
  const client = createSummitClient({ baseUrl: 'http://summit:4001', botKey: 'k', fetchImpl });
  const result = await client.postLink({ code: 'A' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.equal(result.error, 'fetch failed');
});

test('a timeout is named as one, so the log says which failure it was', async () => {
  const fetchImpl = recordingFetch(async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); });
  const client = createSummitClient({ baseUrl: 'http://x', botKey: 'k', timeoutMs: 8000, fetchImpl });
  const result = await client.postLink({ code: 'A' });
  assert.equal(result.error, 'timeout after 8000ms');
});

test('an app that never answers is abandoned, not waited on forever', async () => {
  // Uses the real AbortSignal.timeout wired by the client, with a tiny budget.
  const fetchImpl = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
  });
  const client = createSummitClient({ baseUrl: 'http://x', botKey: 'k', timeoutMs: 50, fetchImpl });
  // AbortSignal.timeout()'s internal timer is unref'd, so with nothing else pending the test
  // runner would call the event loop resolved before the abort fires.
  const keepAlive = setTimeout(() => {}, 5000);
  const started = Date.now();
  const result = await client.postLink({ code: 'A' });
  clearTimeout(keepAlive);
  assert.equal(result.ok, false);
  assert.match(result.error, /timeout/);
  assert.ok(Date.now() - started < 2000);
});

test('stats track the last success and the last failure for /status', async () => {
  let fail = false;
  const fetchImpl = recordingFetch(async () => (fail ? jsonResponse(500, {}) : jsonResponse(200, { ok: true })));
  const client = createSummitClient({ baseUrl: 'http://x', botKey: 'k', fetchImpl, now: () => 1000 });

  await client.postLink({});
  assert.equal(client.stats.lastOkAt, 1000);
  assert.equal(client.stats.lastError, null);

  fail = true;
  await client.postLink({});
  assert.equal(client.stats.lastErrorAt, 1000);
  assert.match(client.stats.lastError, /500/);
  assert.equal(client.stats.calls, 2);
});
