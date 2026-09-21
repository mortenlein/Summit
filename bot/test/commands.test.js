import test from 'node:test';
import assert from 'node:assert/strict';

import { COMMANDS, OPTOUT_BUTTON_ID, commandFingerprint, needsRegistration, normalizeCommand } from '../src/commands.js';

test('registers exactly /koble and /stopp', () => {
  assert.deepEqual(COMMANDS.map((c) => c.name), ['koble', 'stopp']);
});

test('/koble takes an optional string option named kode', () => {
  const koble = COMMANDS.find((c) => c.name === 'koble');
  assert.equal(koble.options.length, 1);
  assert.equal(koble.options[0].name, 'kode');
  assert.equal(koble.options[0].type, 3);
  // Optional on purpose: `/koble` with no argument is valid and the app answers it with the
  // localized instructions.
  assert.equal(koble.options[0].required, false);
});

test('no name_localizations anywhere — the command name is one fixed ASCII string', () => {
  for (const command of COMMANDS) {
    assert.equal(command.name_localizations, undefined);
    assert.match(command.name, /^[a-z]+$/);
    for (const option of command.options) {
      assert.equal(option.name_localizations, undefined);
      assert.match(option.name, /^[a-z]+$/);
    }
  }
});

test('registration is skipped when Discord already has the same commands', () => {
  // Shape Discord actually returns: extra fields, different order, `required` omitted.
  const fromDiscord = [
    {
      id: '1',
      application_id: '2',
      version: '3',
      type: 1,
      name: 'stopp',
      description: 'Stopp DM-er fra Summit',
      default_member_permissions: null,
      dm_permission: true,
    },
    {
      id: '4',
      application_id: '2',
      version: '5',
      type: 1,
      name: 'koble',
      description: 'Koble Discord-kontoen din til Summit',
      options: [{ type: 3, name: 'kode', description: 'Koden fra Summit: Profil → Koble Discord' }],
    },
  ];
  assert.equal(needsRegistration(fromDiscord, COMMANDS), false);
});

test('registration happens when a description drifts, or a command is missing', () => {
  const drifted = COMMANDS.map((c) => ({ ...c, description: `${c.description}.` }));
  assert.equal(needsRegistration(drifted, COMMANDS), true);
  assert.equal(needsRegistration([], COMMANDS), true);
  assert.equal(needsRegistration([COMMANDS[0]], COMMANDS), true);
});

test('the fingerprint is stable and order-independent', () => {
  const reversed = [...COMMANDS].reverse();
  assert.equal(commandFingerprint(COMMANDS), commandFingerprint(reversed));
  assert.equal(commandFingerprint(COMMANDS), commandFingerprint(COMMANDS.map(normalizeCommand)));
});

test('the opt-out button id is a stable contract with the app', () => {
  // The app builds this button on its DMs; changing the string orphans every DM already sent.
  assert.equal(OPTOUT_BUTTON_ID, 'summit:dm:optout');
});
