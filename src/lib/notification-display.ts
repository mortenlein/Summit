/**
 * NotificationLog rows are stored in ENGLISH on purpose: they are the record, and the stored
 * title is part of the 10-second announcement dedupe key (src/lib/discord.ts), so translating
 * them at write time would silently change how duplicate calls collapse.
 *
 * They are also shown to Norwegian crew on the marshal board. So the translation happens here,
 * at display time, keyed off the stored English title. Anything unrecognised falls through
 * unchanged — a log row is still more useful in English than not at all.
 *
 * KNOWN GAP: only the title is translated. The description is free prose composed with
 * interpolated values ("... · Round 1", "3 matches generated for 4 teams"), so it cannot be
 * looked up this way and still reads English on the board. Translating it properly means
 * storing a message key + params on NotificationLog rather than a rendered sentence — a schema
 * change, deliberately not taken close to the event. The team names in it are language-neutral
 * and the title carries the meaning, so the cost is a few English words on a staff-only feed.
 */
const TITLE_KEYS: Record<string, string> = {
  'Match ready for players': 'discord.matchTitle',
  'Match is live': 'discord.liveTitle',
  'Up next': 'discord.upnextTitle',
  'Result posted': 'discord.resultTitle',
  'Player registered': 'discord.signupTitle',
  'Bracket is live': 'discord.bracketLiveTitle',
};

type Translator = (key: string) => string;

export function notificationTitle(stored: string | null | undefined, t: Translator): string {
  if (!stored) return '';
  const key = TITLE_KEYS[stored.trim()];
  if (!key) return stored;
  try {
    return t(key);
  } catch {
    return stored;
  }
}

/**
 * The descriptions are composed for Discord, which renders **bold**. The web UI does not, so
 * the asterisks show up literally ("**Team Fjord** vs **Bergen Bears**"). Strip them.
 */
export function notificationText(stored: string | null | undefined): string {
  if (!stored) return '';
  return stored.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1');
}
