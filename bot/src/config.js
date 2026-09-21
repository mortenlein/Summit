/**
 * Every environment variable the bot reads, in one place.
 *
 * The bot deliberately has no access to the app's `.env` (see docs/discord-bot-spec.md §5):
 * an always-on process with an outbound socket to Discord has no business holding
 * NEXTAUTH_SECRET or STEAM_API_KEY. Its own file is `.env.bot`.
 */

/** Variables without which the bot cannot do its one job. */
export const REQUIRED = ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID', 'SUMMIT_BOT_KEY'];

const DEFAULT_SUMMIT_URL = 'http://summit:4001';
const DEFAULT_HEALTH_PORT = 4002;
const DEFAULT_TIMEOUT_MS = 8000;

function intOr(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Trim every secret and id.
 *
 * `.env.bot` is written by hand at 01:00 by someone pasting from the Discord Developer Portal,
 * and a pasted value routinely carries a trailing space or newline. Untrimmed, `SUMMIT_BOT_KEY`
 * becomes the header `Bearer abc\n`, which Node's fetch rejects as an invalid header value —
 * so every `/koble` dies inside the client with an opaque TypeError and the kid is told Summit
 * is down. Untrimmed, `DISCORD_BOT_TOKEN` is simply "invalid token".
 */
function str(value) {
  return String(value ?? '').trim();
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ config: object, missing: string[] }}
 */
export function readConfig(env = process.env) {
  // SUMMIT_API_URL is the name in the spec; SUMMIT_URL is accepted as an alias so a compose
  // file written from either document works. Trailing slashes are stripped so the joined
  // paths below never produce `//api/...`.
  const rawUrl = env.SUMMIT_API_URL || env.SUMMIT_URL || DEFAULT_SUMMIT_URL;

  const config = {
    token: str(env.DISCORD_BOT_TOKEN),
    clientId: str(env.DISCORD_CLIENT_ID),
    guildId: str(env.DISCORD_GUILD_ID),
    botKey: str(env.SUMMIT_BOT_KEY),
    summitUrl: str(rawUrl).replace(/\/+$/, ''),
    requestTimeoutMs: intOr(env.SUMMIT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    // Bound to 0.0.0.0 on purpose: a loopback-only listener passes the container HEALTHCHECK
    // while every other reader fails, which is the exact 01:00 confusion to avoid.
    healthPort: intOr(env.BOT_HEALTH_PORT, DEFAULT_HEALTH_PORT),
    healthHost: env.BOT_HEALTH_HOST || '0.0.0.0',
    // How long to stay alive after an unrecoverable error, so `restart: unless-stopped`
    // cannot burn Discord's 1000 IDENTIFY/day in a tight crash loop.
    fatalExitDelayMs: intOr(env.BOT_FATAL_EXIT_DELAY_MS, 30000),
    // How long a *gateway* disconnect may keep reporting /healthz as live. discord.js
    // reconnects on its own and a blip must not flip the container unhealthy — but a bot that
    // has been "reconnecting" for ten minutes is not doing its job, and a health endpoint that
    // says `ok` forever while nobody can link is the same lie this feature exists to prevent.
    reconnectGraceMs: intOr(env.BOT_RECONNECT_GRACE_MS, 300000),
    // Set by the smoke test: build everything, never open a gateway socket.
    noGateway: str(env.BOT_NO_GATEWAY) === 'true',
  };

  const missing = REQUIRED.filter((key) => !String(env[key] || '').trim());
  return { config, missing };
}

export default readConfig;
