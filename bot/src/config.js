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
 * @param {Record<string, string | undefined>} env
 * @returns {{ config: object, missing: string[] }}
 */
export function readConfig(env = process.env) {
  // SUMMIT_API_URL is the name in the spec; SUMMIT_URL is accepted as an alias so a compose
  // file written from either document works. Trailing slashes are stripped so the joined
  // paths below never produce `//api/...`.
  const rawUrl = env.SUMMIT_API_URL || env.SUMMIT_URL || DEFAULT_SUMMIT_URL;

  const config = {
    token: env.DISCORD_BOT_TOKEN || '',
    clientId: env.DISCORD_CLIENT_ID || '',
    guildId: env.DISCORD_GUILD_ID || '',
    botKey: env.SUMMIT_BOT_KEY || '',
    summitUrl: String(rawUrl).replace(/\/+$/, ''),
    requestTimeoutMs: intOr(env.SUMMIT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    // Bound to 0.0.0.0 on purpose: a loopback-only listener passes the container HEALTHCHECK
    // while every other reader fails, which is the exact 01:00 confusion to avoid.
    healthPort: intOr(env.BOT_HEALTH_PORT, DEFAULT_HEALTH_PORT),
    healthHost: env.BOT_HEALTH_HOST || '0.0.0.0',
    // How long to stay alive after an unrecoverable error, so `restart: unless-stopped`
    // cannot burn Discord's 1000 IDENTIFY/day in a tight crash loop.
    fatalExitDelayMs: intOr(env.BOT_FATAL_EXIT_DELAY_MS, 30000),
    // Set by the smoke test: build everything, never open a gateway socket.
    noGateway: env.BOT_NO_GATEWAY === 'true',
  };

  const missing = REQUIRED.filter((key) => !String(env[key] || '').trim());
  return { config, missing };
}

export default readConfig;
