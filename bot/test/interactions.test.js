import test from 'node:test';
import assert from 'node:assert/strict';

import { handleKoble, handleStopp, isOptOutButton, normalizeCode } from '../src/interactions.js';
import { unreachableMessage, pickLocale } from '../src/fallback.js';

/** A stand-in for the Summit app. Records what it was asked, answers what it is told to. */
function fakeApp(response) {
  const calls = [];
  return {
    calls,
    postLink: async (payload) => { calls.push({ route: 'link', payload }); return response; },
    postOptOut: async (payload) => { calls.push({ route: 'optout', payload }); return response; },
  };
}

const okReply = (reply, extra = {}) => ({ ok: true, status: 200, body: { ok: true, reply, ...extra }, error: null });

// --- code normalization ------------------------------------------------------------------

test('normalizeCode uppercases, strips spaces and survives a pasted /koble', () => {
  assert.equal(normalizeCode('h7k2qp'), 'H7K2QP');
  assert.equal(normalizeCode('  H7K2 QP '), 'H7K2QP');
  assert.equal(normalizeCode('/koble H7K2QP'), 'H7K2QP');
  assert.equal(normalizeCode('koble H7K2QP'), 'H7K2QP');
  assert.equal(normalizeCode('H7K2-QP'), 'H7K2QP');
  // Non-breaking space: Discord's mobile keyboards produce them.
  assert.equal(normalizeCode('H7K2\u00a0QP'), 'H7K2QP');
});

test('normalizeCode returns an empty string for nothing, and bounds absurd input', () => {
  assert.equal(normalizeCode(undefined), '');
  assert.equal(normalizeCode(null), '');
  assert.equal(normalizeCode('   '), '');
  assert.equal(normalizeCode('A'.repeat(500)).length, 32);
});

// --- /koble ------------------------------------------------------------------------------

test('/koble posts the normalized code plus the Discord identity, and shows the app reply', async () => {
  const app = fakeApp(okReply("Koblet! Du er **Mia** på Summit. Jeg har sendt deg en melding – se i DM-ene dine."));
  const result = await handleKoble(
    { code: ' h7k2qp ', discordId: '123', discordUsername: 'mia', locale: 'no' },
    app,
  );

  assert.deepEqual(app.calls[0], {
    route: 'link',
    payload: { code: 'H7K2QP', discordId: '123', discordUsername: 'mia', locale: 'no' },
  });
  assert.equal(result.source, 'app');
  assert.equal(result.ok, true);
  assert.match(result.content, /^Koblet!/);
  // The bot never logs the code itself.
  assert.equal(result.codeLength, 6);
});

test('/koble with no argument still goes to the app — the bot owns no instruction copy', async () => {
  const app = fakeApp(okReply('Skriv `/koble` og lim inn koden…', { ok: false }));
  const result = await handleKoble({ code: null, discordId: '123', discordUsername: 'mia' }, app);

  assert.equal(app.calls.length, 1, 'a missing code is the app\'s question to answer, not the bot\'s');
  assert.equal(app.calls[0].payload.code, '');
  assert.equal(result.content, 'Skriv `/koble` og lim inn koden…');
  assert.equal(result.source, 'app');
});

test('a refusal from the app is shown verbatim, with its reason carried for the log', async () => {
  const app = fakeApp({
    ok: true,
    status: 200,
    body: { ok: false, reason: 'discord_taken', reply: 'Denne Discord-kontoen er allerede koblet til en annen Summit-bruker.' },
    error: null,
  });
  const result = await handleKoble({ code: 'H7K2QP', discordId: '123', discordUsername: 'mia' }, app);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'discord_taken');
  assert.match(result.content, /allerede koblet/);
});

test('app unreachable → the one fallback string, in the kid\'s Discord language', async () => {
  const down = fakeApp({ ok: false, status: 0, body: null, error: 'fetch failed' });

  const nb = await handleKoble({ code: 'H7K2QP', discordId: '1', discordUsername: 'm', locale: 'no' }, down);
  assert.equal(nb.source, 'fallback');
  assert.equal(nb.content, unreachableMessage('no'));
  assert.match(nb.content, /Summit svarer ikke/);

  const en = await handleKoble({ code: 'H7K2QP', discordId: '1', discordUsername: 'm', locale: 'en-GB' }, down);
  assert.equal(en.content, unreachableMessage('en-GB'));
  assert.match(en.content, /isn't responding/);
});

test('a 502 with an HTML body is the unreachable case, not a crash', async () => {
  const broken = fakeApp({ ok: false, status: 502, body: null, error: 'HTTP 502' });
  const result = await handleKoble({ code: 'H7K2QP', discordId: '1', discordUsername: 'm' }, broken);
  assert.equal(result.source, 'fallback');
  assert.equal(result.status, 502);
  assert.equal(result.ok, false);
});

test('an over-long app reply is truncated below Discord\'s 2000-char message cap', async () => {
  const app = fakeApp(okReply('x'.repeat(5000)));
  const result = await handleKoble({ code: 'A', discordId: '1', discordUsername: 'm' }, app);
  assert.ok(result.content.length <= 1900, `got ${result.content.length}`);
});

// --- /stopp and the button ----------------------------------------------------------------

test('/stopp and the button hit the same endpoint, tagged by how they were triggered', async () => {
  const app = fakeApp(okReply('Ok, jeg sender deg ikke flere DM-er.'));

  const viaCommand = await handleStopp({ discordId: '7', locale: 'no', via: 'command' }, app);
  const viaButton = await handleStopp({ discordId: '7', locale: 'no', via: 'button' }, app);

  assert.deepEqual(app.calls.map((c) => c.route), ['optout', 'optout']);
  assert.equal(app.calls[0].payload.via, 'command');
  assert.equal(app.calls[1].payload.via, 'button');
  assert.equal(viaCommand.content, viaButton.content);
  assert.equal(viaCommand.ok, true);
});

test('an unknown `via` is coerced, never forwarded raw', async () => {
  const app = fakeApp(okReply('ok'));
  await handleStopp({ discordId: '7', via: 'javascript:alert(1)' }, app);
  assert.equal(app.calls[0].payload.via, 'command');
});

test('the opt-out button id matches exactly, or with a suffix, and nothing else', () => {
  assert.equal(isOptOutButton('summit:dm:optout'), true);
  assert.equal(isOptOutButton('summit:dm:optout:match_123'), true);
  assert.equal(isOptOutButton('summit:dm:optout-evil'), false);
  assert.equal(isOptOutButton('some-other-bot:optout'), false);
  assert.equal(isOptOutButton(undefined), false);
});

// --- fallback locale ----------------------------------------------------------------------

test('Norwegian Discord locales map to nb, everything else to en', () => {
  assert.equal(pickLocale('no'), 'nb');
  assert.equal(pickLocale('nb-NO'), 'nb');
  assert.equal(pickLocale('nn'), 'nb');
  assert.equal(pickLocale('en-US'), 'en');
  assert.equal(pickLocale('sv-SE'), 'en');
  assert.equal(pickLocale(undefined), 'en');
});
