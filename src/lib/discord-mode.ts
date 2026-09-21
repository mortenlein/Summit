/**
 * Can this deployment actually talk to Discord right now?
 *
 * This exists because of one failure the reach panel is built to prevent: a send path that is
 * intercepted (mock mode) or unconfigured (no bot token) still returns "true" to its caller —
 * `src/lib/discord.ts` does exactly that in its `[STRATEGY 3 MOCK]` branch — and a caller that
 * believes it writes down a success for a message that never left the process. Verified on the
 * host and recorded in `docs/discord-bot-spec.md` §2: production `.env` on `ash` carries no
 * `DISCORD_*` key at all, so today every announcement takes the intercepted branch. A panel
 * that reported "reachable" in that deployment would be reporting on a channel that does not
 * exist.
 *
 * Pure, env-only, no Prisma and no REST client, so it is safe to import from anywhere — and
 * read at call time rather than at module construction, so changing `.env` and restarting is
 * enough to change the answer.
 */

export type DiscordSendMode = 'REAL' | 'SIMULATED';

/** Delivery is intercepted for the whole process — nothing reaches Discord, by configuration. */
function isInterceptedGlobally(): boolean {
  return process.env.NEXT_PUBLIC_STRATEGY_3_MOCK === 'true';
}

/**
 * DMs need the bot token specifically. A `DISCORD_WEBHOOK_URL` can post to a channel but can
 * never open a DM channel (`POST /users/@me/channels` is a bot-token route), so a webhook-only
 * deployment is `SIMULATED` for DM purposes even though its channel posts are real.
 */
export function discordDmMode(): DiscordSendMode {
  if (isInterceptedGlobally()) return 'SIMULATED';
  return process.env.DISCORD_BOT_TOKEN ? 'REAL' : 'SIMULATED';
}

export function isDiscordDmSimulated(): boolean {
  return discordDmMode() === 'SIMULATED';
}
