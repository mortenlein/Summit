/**
 * The bot's entire string catalogue. Two entries, and `bot/test/no-copy.test.js` fails the
 * build if a third appears anywhere else under `bot/`.
 *
 * Every reply a player sees is rendered by the APP and handed back in the `reply` field of the
 * link/opt-out response, in that player's own `User.locale`. The bot owns no translations.
 * Two cases the app cannot cover, and only two:
 *
 *   1. the app is unreachable — the one message below, nb + en;
 *   2. a stale client fires a command this bot no longer serves — a language-neutral list of
 *      the commands that do exist, which asserts nothing and needs no translation.
 *
 * Anything else belongs in `messages/{en,nb}/discord.json`, under `npm run i18n:check`.
 *
 * The three Discord *command descriptions* in `commands.js` are the one other piece of
 * Norwegian in this container. They are registration metadata, not a reply: Discord demands
 * them at boot, before the app is necessarily reachable, and a bot that could not register its
 * commands while the app was restarting would be useless exactly when it is needed.
 */

const UNREACHABLE = {
  nb: 'Summit svarer ikke akkurat nå. Prøv igjen om et minutt, eller si fra til crewet.',
  en: "Summit isn't responding right now. Try again in a minute, or tell the crew.",
};

/**
 * Discord sends BCP-47-ish locale tags (`no`, `nb`, `da`, `en-US`, …). Anything Norwegian
 * gets the Norwegian line; everything else gets English. This is a fallback, not i18n — it
 * does not need a locale negotiation library.
 */
export function pickLocale(discordLocale) {
  const tag = String(discordLocale || '').toLowerCase();
  return tag === 'no' || tag.startsWith('nb') || tag.startsWith('nn') ? 'nb' : 'en';
}

/** The one *sentence* the bot owns. Used only when Summit did not answer. */
export function unreachableMessage(discordLocale) {
  return UNREACHABLE[pickLocale(discordLocale)];
}

/**
 * The reply to a command this build does not serve — a stale Discord client, or a command left
 * over in the guild from an older version.
 *
 * Deliberately not a sentence in any language, and deliberately not the "Summit isn't
 * responding" line: Summit answered fine, the command is simply gone. Naming the two that
 * exist is the whole of the useful content.
 */
export function commandListMessage() {
  return '/koble · /stopp';
}

export default unreachableMessage;
