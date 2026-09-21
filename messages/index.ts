import type { Locale } from '@/i18n/config';

/**
 * One file per namespace, merged at request time.
 *
 * Why not a single messages/<locale>.json: several people (and several agents) translate
 * different surfaces at once, and a single catalogue turns every one of those into a merge
 * conflict in the same file. A namespace per surface means each owner touches only their own.
 *
 * Adding a namespace: create messages/en/<ns>.json AND messages/nb/<ns>.json, then list it
 * here. `npm run i18n:check` fails the build if the two languages drift apart.
 */
export const NAMESPACES = [
  'common',
  'status',
  'stage',
  'nav',
  'landing',
  'directory',
  'tournament',
  'player',
  'register',
  'marshal',
  'organizer',
  'errors',
  // Copy composed on the server with no request behind it: push notifications (written in the
  // recipient's stored language) and Discord posts (one configured language). See src/i18n/server.ts.
  'notifications',
  // Discord: the /koble link card (a request behind it) plus the strings the app composes for
  // the bot to print and for a DM — written in the recipient's own language, never the bot's.
  'discord',
] as const;

export async function loadMessages(locale: Locale) {
  const entries = await Promise.all(
    NAMESPACES.map(async (ns) => {
      try {
        return [ns, (await import(`./${locale}/${ns}.json`)).default] as const;
      } catch {
        // A namespace listed but not yet created is not fatal — the surface simply has no
        // translated strings yet. i18n:check is what enforces completeness.
        return [ns, {}] as const;
      }
    })
  );
  return Object.fromEntries(entries);
}
