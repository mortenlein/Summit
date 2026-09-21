/**
 * The bot owns no translations — enforced, not promised.
 *
 * The architecture (docs/discord-bot-spec.md §1, §12) is that the APP renders every player-
 * facing string, in that player's own `User.locale`, and hands it back in `reply`. The bot
 * prints whatever it is given. The moment a Norwegian sentence appears in this container it
 * has forked from `messages/{en,nb}`, it is outside `npm run i18n:check`, and it will drift.
 *
 * Exactly two exceptions are allowed, both argued in the files themselves:
 *
 *   src/fallback.js — the "Summit is unreachable" line (nb + en). The app cannot render this
 *                     one, by definition, because the app is what did not answer.
 *   src/commands.js — three Discord slash-command DESCRIPTIONS. These are registration
 *                     metadata, sent to Discord at boot before the app is necessarily up; a
 *                     bot that could not register its commands during an app restart would be
 *                     useless exactly when it is needed. They are not replies.
 *
 * Anything else fails here rather than at the LAN.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMMANDS } from '../src/commands.js';
import { commandListMessage, unreachableMessage } from '../src/fallback.js';

const BOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED = new Set(['src/fallback.js', 'src/commands.js']);

/** Every .js file the container actually runs (tests and node_modules excluded). */
function shippedFiles(dir = BOT_DIR, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.name === 'node_modules' || entry.name === 'test') continue;
    if (entry.isDirectory()) out.push(...shippedFiles(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

/**
 * Norwegian letters, plus the function words that give away a Norwegian sentence.
 *
 * Deliberately NOT `koble`/`stopp`: those are the command identifiers, fixed pure-ASCII
 * strings the spec pins (§12 — localize the replies, never the command name). Every actual
 * Norwegian sentence in this product trips the letter class or one of these words.
 */
const NORWEGIAN = /[æøåÆØÅ]|\b(ikke|deg|din|ditt|dine|jeg|melding\w*|spiller\w*|crewet)\b/i;

/** Strip line comments and jsdoc/banner lines: prose explains the design, only code holds copy. */
function codeOnly(line) {
  if (/^\s*(\*|\/\*|\/\/)/.test(line)) return '';
  return line.replace(/\/\/.*$/, '');
}

test('no shipped file outside the two allowed ones contains Norwegian', () => {
  const offenders = [];
  for (const rel of shippedFiles()) {
    if (ALLOWED.has(rel)) continue;
    const lines = fs.readFileSync(path.join(BOT_DIR, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (NORWEGIAN.test(codeOnly(line))) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `Norwegian copy outside ${[...ALLOWED].join(' and ')}:\n${offenders.join('\n')}`,
  );
});

test('the fallback file holds exactly one sentence, in exactly two languages', () => {
  assert.equal(
    unreachableMessage('no'),
    'Summit svarer ikke akkurat nå. Prøv igjen om et minutt, eller si fra til crewet.',
  );
  assert.equal(
    unreachableMessage('en-GB'),
    "Summit isn't responding right now. Try again in a minute, or tell the crew.",
  );
  // Every other locale Discord can send falls back to English rather than to a third string.
  for (const locale of ['de', 'sv-SE', 'pl', '', undefined, 'zh-CN']) {
    assert.equal(unreachableMessage(locale), unreachableMessage('en-US'), `locale=${locale}`);
  }
});

test('the stale-command reply is language-neutral — it asserts nothing and translates to nothing', () => {
  const message = commandListMessage();
  assert.match(message, /^\/koble · \/stopp$/);
});

test('the only registration copy is the three command descriptions, and nothing grew', () => {
  const descriptions = COMMANDS.flatMap((c) => [
    c.description,
    ...(c.options ?? []).map((o) => o.description),
  ]);
  assert.equal(descriptions.length, 3, 'a fourth description means new copy the app should own');
  // No `*_localizations`: Discord localizes by the CLIENT's language, which will not match the
  // player's `User.locale`, so Summit would print `/koble` to a kid whose Discord shows `/link`.
  for (const command of COMMANDS) {
    assert.equal(command.name_localizations, undefined);
    assert.equal(command.description_localizations, undefined);
  }
});
