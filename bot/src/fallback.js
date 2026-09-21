/**
 * The bot's entire string catalogue.
 *
 * Every reply a player sees is rendered by the app and handed back in the `reply` field of
 * the link/opt-out response, in that player's own `User.locale`. The only case the app cannot
 * cover is the app itself being unreachable — so this file holds exactly one message, in two
 * languages, and nothing else. If you find yourself adding a third, it belongs in
 * `messages/{en,nb}/discord.json` instead, under `npm run i18n:check`.
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

/** The one string the bot owns. */
export function unreachableMessage(discordLocale) {
  return UNREACHABLE[pickLocale(discordLocale)];
}

export default unreachableMessage;
