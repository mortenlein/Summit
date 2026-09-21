/**
 * The two guild commands, as raw application-command JSON.
 *
 * Raw JSON rather than SlashCommandBuilder on purpose: this module must be importable by the
 * tests without pulling in discord.js, and the payload is the thing that gets hashed and
 * compared against what Discord already has.
 *
 * COPY NOTE — these two descriptions (and the one option description) are the ONLY
 * user-facing Norwegian the bot owns besides the "Summit is unreachable" fallback in
 * `fallback.js`. They cannot come from the app: they are sent to Discord at boot, and a bot
 * that could not register its commands while the app was restarting would be useless exactly
 * when it is needed. Every *reply* is rendered by the app, which owns `messages/{en,nb}`.
 *
 * No `name_localizations`: Discord localizes command names by the *client's* language, which
 * will not match the player's `User.locale`, so Summit would print `/koble` to a kid whose
 * Discord shows `/link`. `koble` is pure ASCII. Localize the replies, not the name.
 */

/** Discord application-command option type 3 = STRING. */
const STRING_OPTION = 3;

export const OPTOUT_BUTTON_ID = 'summit:dm:optout';

export const COMMANDS = Object.freeze([
  {
    name: 'koble',
    description: 'Koble Discord-kontoen din til Summit',
    options: [
      {
        type: STRING_OPTION,
        name: 'kode',
        description: 'Koden fra Summit: Profil → Koble Discord',
        required: false,
      },
    ],
  },
  {
    name: 'stopp',
    description: 'Stopp DM-er fra Summit',
    options: [],
  },
]);

/**
 * Project a command (ours, or one read back from Discord, which carries id/application_id/
 * version/default_member_permissions/…) down to the fields we actually set, so the two are
 * comparable.
 */
export function normalizeCommand(command) {
  return {
    name: String(command?.name ?? ''),
    description: String(command?.description ?? ''),
    options: (command?.options ?? []).map((option) => ({
      type: Number(option?.type ?? 0),
      name: String(option?.name ?? ''),
      description: String(option?.description ?? ''),
      required: Boolean(option?.required),
    })),
  };
}

/** A stable, order-independent fingerprint of a command set. */
export function commandFingerprint(commands = []) {
  const normalized = commands.map(normalizeCommand).sort((a, b) => a.name.localeCompare(b.name));
  return JSON.stringify(normalized);
}

/**
 * Registration is idempotent: `PUT` only when Discord's copy differs from ours.
 * `restart: unless-stopped` plus an unconditional PUT on every `clientReady` is a write per
 * crash against a 200/day per-guild limit.
 */
export function needsRegistration(existing, desired = COMMANDS) {
  return commandFingerprint(existing) !== commandFingerprint(desired);
}

export default COMMANDS;
