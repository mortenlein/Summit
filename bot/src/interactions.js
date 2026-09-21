/**
 * The bot's whole behaviour, as plain functions over plain data.
 *
 * Nothing here imports discord.js, so the handlers can be exercised without a gateway, a
 * token or a network. `index.js` is the only file that knows what an Interaction is.
 */

import { unreachableMessage } from './fallback.js';
import { OPTOUT_BUTTON_ID } from './commands.js';

/** Discord's own message cap is 2000; leave room rather than get a 400 on a good reply. */
const MAX_REPLY = 1900;

/**
 * What a kid actually types into the `kode` field.
 *
 * The profile card's copy button copies the bare code, but half of them will paste the whole
 * instruction, or type it with the spaces Discord's own mobile keyboard adds, or in lower
 * case. All of those are the same code. Normalizing here costs nothing and turns three
 * support conversations into none. The app still validates — this only removes noise.
 */
export function normalizeCode(raw) {
  let value = String(raw ?? '').trim();
  if (!value) return '';
  // "/koble H7K2QP" pasted into the option field, or into the box before the menu fired.
  value = value.replace(/^\/?koble\b/i, '');
  value = value.replace(/[\s\u00a0._-]/g, '');
  value = value.toUpperCase();
  // Anything longer than this is not a link code; send a bounded string, not a paragraph.
  return value.slice(0, 32);
}

/** True for the "Stopp DM" button the app attaches to its DMs. */
export function isOptOutButton(customId) {
  const id = String(customId ?? '');
  return id === OPTOUT_BUTTON_ID || id.startsWith(`${OPTOUT_BUTTON_ID}:`);
}

/**
 * The app owns every translated string. Use its `reply` when it gave us one; fall back to the
 * single "Summit is unreachable" line otherwise. Never invent copy here.
 */
function replyFrom(result, locale) {
  const candidate = result?.body?.reply;
  if (typeof candidate === 'string' && candidate.trim()) {
    return { content: candidate.slice(0, MAX_REPLY), source: 'app' };
  }
  return { content: unreachableMessage(locale), source: 'fallback' };
}

/**
 * `/koble [kode]`.
 *
 * Note that a missing code is NOT short-circuited here: the app answers it with
 * `bot.noCode`, in the player's language, from `messages/`. The bot holding that sentence
 * would be the bot holding Norwegian copy.
 *
 * @param {{ code?: string, discordId: string, discordUsername: string, locale?: string }} input
 * @param {{ postLink: Function }} deps
 */
export async function handleKoble(input, deps) {
  const code = normalizeCode(input?.code);
  const locale = input?.locale;
  const result = await deps.postLink({
    code,
    discordId: String(input?.discordId ?? ''),
    discordUsername: String(input?.discordUsername ?? ''),
    locale: locale ?? null,
  });

  const { content, source } = replyFrom(result, locale);
  return {
    content,
    source,
    ok: Boolean(result?.ok && result?.body?.ok),
    reason: result?.body?.reason ?? null,
    status: result?.status ?? 0,
    // For the log line: a code is short-lived and low value, but there is no reason at all
    // for it to sit in `docker logs` next to a Discord id.
    codeLength: code.length,
  };
}

/**
 * `/stopp`, and the "Stopp DM" button — the same endpoint, deliberately. A kid who taps the
 * button and a kid who types the command have asked for exactly the same thing.
 *
 * @param {{ discordId: string, locale?: string, via?: 'command' | 'button' }} input
 * @param {{ postOptOut: Function }} deps
 */
export async function handleStopp(input, deps) {
  const locale = input?.locale;
  const result = await deps.postOptOut({
    discordId: String(input?.discordId ?? ''),
    locale: locale ?? null,
    via: input?.via === 'button' ? 'button' : 'command',
  });

  const { content, source } = replyFrom(result, locale);
  return {
    content,
    source,
    ok: Boolean(result?.ok && result?.body?.ok),
    reason: result?.body?.reason ?? null,
    status: result?.status ?? 0,
  };
}

export default { handleKoble, handleStopp, normalizeCode, isOptOutButton };
