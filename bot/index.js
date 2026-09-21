/**
 * Summit gateway bot.
 *
 * Its entire job: receive `/koble`, `/stopp` and the "Stopp DM" button from Discord, hand
 * them to the Summit app over the compose network, and show the kid whatever the app says.
 *
 * It holds no database, no translations and no send path. The app does all sending — channel
 * posts and DMs — because it already holds the REST client, the token, Prisma, the recipient
 * list and every Norwegian string (docs/discord-bot-spec.md §1).
 *
 * If this process is down, nobody can link a Discord account. Nothing else breaks: matches,
 * the bracket, the marshal board, push and the channel announcements are all the app.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
} from 'discord.js';

import { readConfig } from './src/config.js';
import { COMMANDS, needsRegistration, OPTOUT_BUTTON_ID } from './src/commands.js';
import { createSummitClient } from './src/summit-client.js';
import { createHealthServer } from './src/health.js';
import { handleKoble, handleStopp, isOptOutButton } from './src/interactions.js';
import logger from './src/log.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
})();

const { config, missing } = readConfig();
const startedAt = Date.now();

/** Everything /status reports. No token, no bearer key, no link codes — ever. */
const state = {
  state: 'starting', // starting | ready | reconnecting | fatal
  botTag: null,
  guildId: config.guildId || null,
  commands: COMMANDS.map((c) => c.name),
  commandsAction: null, // up-to-date | updated | failed
  commandsAt: null,
  gatewayAttempts: 0,
  lastGatewayError: null,
  interactions: { koble: 0, stopp: 0, button: 0, failed: 0 },
};

const summit = createSummitClient({
  baseUrl: config.summitUrl,
  botKey: config.botKey,
  timeoutMs: config.requestTimeoutMs,
});

function statusPayload() {
  return {
    ...state,
    version: VERSION,
    startedAt: new Date(startedAt).toISOString(),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    summitUrl: config.summitUrl,
    lastLinkOkAt: summit.stats.lastOkAt ? new Date(summit.stats.lastOkAt).toISOString() : null,
    lastError: summit.stats.lastError ?? state.lastGatewayError ?? null,
  };
}

const health = createHealthServer({ getStatus: statusPayload, logger });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Never exit on a recoverable error; on an unrecoverable one, wait before exiting.
 * Discord's IDENTIFY limit is 1000/day per token — a two-second crash loop under
 * `restart: unless-stopped` burns it in ~35 minutes and 429s the token for the rest of the
 * day, i.e. for the LAN.
 */
async function fatal(message, fields) {
  state.state = 'fatal';
  state.lastGatewayError = message;
  logger.error(`FATAL: ${message}`, fields);
  logger.error(
    `Exiting in ${Math.round(config.fatalExitDelayMs / 1000)}s. Restarting faster than this ` +
      "would burn Discord's IDENTIFY budget; fix .env.bot and `docker compose -f " +
      'docker-compose.prod.yml up -d summit-bot`.',
  );
  await sleep(config.fatalExitDelayMs);
  process.exit(1);
}

/** Errors no amount of retrying fixes. */
function isUnrecoverable(error) {
  const code = String(error?.code ?? '');
  if (code === 'TokenInvalid' || code === 'DisallowedIntents' || code === 'InvalidIntents') return true;
  const message = String(error?.message ?? '');
  return /disallowed intents|invalid token|4004|4014/i.test(message);
}

// ---------------------------------------------------------------------------------------------
// Slash-command registration — idempotent by design
// ---------------------------------------------------------------------------------------------

async function registerCommands(rest) {
  const route = Routes.applicationGuildCommands(config.clientId, config.guildId);
  try {
    const existing = await rest.get(route);
    if (!needsRegistration(existing, COMMANDS)) {
      state.commandsAction = 'up-to-date';
      state.commandsAt = new Date().toISOString();
      logger.info('Commands already registered, unchanged — no write.', {
        guild: config.guildId,
        commands: state.commands.map((n) => `/${n}`).join(' '),
      });
      return;
    }
    await rest.put(route, { body: COMMANDS });
    state.commandsAction = 'updated';
    state.commandsAt = new Date().toISOString();
    logger.info('Commands registered (guild-scoped, instant).', {
      guild: config.guildId,
      commands: state.commands.map((n) => `/${n}`).join(' '),
    });
  } catch (error) {
    // Recoverable: the gateway connection is up, existing commands still work, and the next
    // restart retries. Never exit over this.
    state.commandsAction = 'failed';
    state.lastGatewayError = `command registration: ${String(error?.message || error)}`;
    logger.error('Command registration failed — existing commands (if any) still work.', {
      guild: config.guildId,
      message: String(error?.message || error),
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------------------------

/**
 * First line of every handler, non-negotiable: defer, ephemerally.
 * The round trip to Summit plus a DM probe is comfortably over Discord's 3-second ACK; without
 * the defer a *successful* link shows a red "The application did not respond", and the kid
 * runs it again.
 */
async function deferEphemeral(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
}

async function onInteraction(interaction) {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'koble') {
        await deferEphemeral(interaction);
        const result = await handleKoble(
          {
            code: interaction.options.getString('kode'),
            discordId: interaction.user.id,
            discordUsername: interaction.user.username,
            locale: interaction.locale,
          },
          summit,
        );
        state.interactions.koble += 1;
        await interaction.editReply({ content: result.content, allowedMentions: { parse: [] } });
        logger.info('/koble', {
          discordId: interaction.user.id,
          codeLength: result.codeLength,
          ok: result.ok,
          reason: result.reason,
          status: result.status,
          reply: result.source,
        });
        return;
      }

      if (interaction.commandName === 'stopp') {
        await deferEphemeral(interaction);
        const result = await handleStopp(
          { discordId: interaction.user.id, locale: interaction.locale, via: 'command' },
          summit,
        );
        state.interactions.stopp += 1;
        await interaction.editReply({ content: result.content, allowedMentions: { parse: [] } });
        logger.info('/stopp', {
          discordId: interaction.user.id,
          ok: result.ok,
          status: result.status,
          reply: result.source,
        });
        return;
      }

      // A command we no longer serve, left over in a stale client. Say nothing clever.
      await deferEphemeral(interaction);
      await interaction.editReply({ content: '/koble · /stopp', allowedMentions: { parse: [] } });
      return;
    }

    if (interaction.isButton() && isOptOutButton(interaction.customId)) {
      await deferEphemeral(interaction);
      const result = await handleStopp(
        { discordId: interaction.user.id, locale: interaction.locale, via: 'button' },
        summit,
      );
      state.interactions.button += 1;
      await interaction.editReply({ content: result.content, allowedMentions: { parse: [] } });
      logger.info('stop-dm button', {
        discordId: interaction.user.id,
        ok: result.ok,
        status: result.status,
        reply: result.source,
      });
    }
  } catch (error) {
    // A handler that throws leaves a spinner on a kid's screen forever. Log it, try once to
    // say something, and stay up.
    state.interactions.failed += 1;
    logger.error('Interaction handler failed.', { message: String(error?.message || error) });
    try {
      if (interaction.isRepliable() && interaction.deferred && !interaction.replied) {
        await interaction.editReply({
          content: (await import('./src/fallback.js')).unreachableMessage(interaction.locale),
          allowedMentions: { parse: [] },
        });
      }
    } catch {
      /* the interaction token is gone; nothing to do but keep running */
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------

async function connectWithBackoff(client) {
  // 5s, 10s, 20s, 40s, 80s, 160s, then 300s forever. Slow enough to survive a Discord
  // outage, visible enough that `docker logs` shows what is happening.
  const delays = [5000, 10000, 20000, 40000, 80000, 160000, 300000];
  for (let attempt = 0; ; attempt += 1) {
    state.gatewayAttempts = attempt + 1;
    try {
      await client.login(config.token);
      return;
    } catch (error) {
      if (isUnrecoverable(error)) {
        await fatal(
          'Discord rejected the credentials. Check DISCORD_BOT_TOKEN in .env.bot, and that the ' +
            'bot has no privileged intents enabled it does not need.',
          { message: String(error?.message || error) },
        );
        return;
      }
      const delay = delays[Math.min(attempt, delays.length - 1)];
      state.state = 'reconnecting';
      state.lastGatewayError = String(error?.message || error);
      logger.warn(`Gateway connect failed — retrying in ${delay / 1000}s.`, {
        attempt: attempt + 1,
        message: String(error?.message || error),
      });
      await sleep(delay);
    }
  }
}

async function main() {
  logger.info(`Summit gateway bot v${VERSION} starting.`, {
    node: process.version,
    tz: process.env.TZ || 'unset',
    summitUrl: config.summitUrl,
  });

  // Health first, so a bot that cannot start is still *observable* as not started.
  const address = await health.listen(config.healthPort, config.healthHost);
  logger.info('Health server listening.', {
    address: `${config.healthHost}:${address?.port ?? config.healthPort}`,
    routes: '/healthz /status',
  });

  if (missing.length > 0) {
    await fatal(`Missing required environment variables: ${missing.join(', ')}`, {
      file: '.env.bot',
    });
    return;
  }

  const client = new Client({
    // Guilds ONLY. Not GuildMembers, not MessageContent — they are privileged, they are not
    // needed for slash commands and buttons, and "can the bot read my kid's messages" should
    // have a flat no as its answer.
    intents: [GatewayIntentBits.Guilds],
  });

  client.once(Events.ClientReady, async (c) => {
    state.state = 'ready';
    state.botTag = c.user.tag;
    const rest = new REST({ version: '10' }).setToken(config.token);
    await registerCommands(rest);
    logger.info(
      `READY as ${c.user.tag} · guild ${config.guildId} · commands ` +
        `${state.commands.map((n) => `/${n}`).join(' ')} (${state.commandsAction}) · ` +
        `app ${config.summitUrl}`,
    );
  });

  client.on(Events.ShardDisconnect, (event, shardId) => {
    state.state = 'reconnecting';
    state.lastGatewayError = `shard ${shardId} disconnected (${event?.code ?? '?'})`;
    logger.warn('Gateway disconnected — discord.js will reconnect.', {
      shard: shardId,
      code: event?.code,
    });
  });

  client.on(Events.ShardReconnecting, (shardId) => {
    state.state = 'reconnecting';
    logger.warn('Gateway reconnecting.', { shard: shardId });
  });

  client.on(Events.ShardResume, (shardId) => {
    state.state = 'ready';
    logger.info('Gateway resumed.', { shard: shardId });
  });

  client.on(Events.Error, (error) => {
    // discord.js emits this for recoverable websocket trouble. Logging it is the whole job:
    // an unhandled 'error' event on an EventEmitter would take the process down.
    state.lastGatewayError = String(error?.message || error);
    logger.error('Gateway error (recoverable).', { message: String(error?.message || error) });
  });

  client.on(Events.InteractionCreate, onInteraction);

  const shutdown = async (signal) => {
    logger.info(`${signal} — shutting down.`);
    try {
      await health.close();
    } catch { /* already closed */ }
    try {
      await client.destroy();
    } catch { /* never connected */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });

  // An unhandled rejection anywhere must not take the bot down mid-LAN.
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection (ignored, staying up).', { message: String(reason) });
  });

  if (config.noGateway) {
    // BOT_NO_GATEWAY=true builds and wires everything but never opens a socket. Used by the
    // smoke test so the bot is verifiable without a real token. It deliberately does NOT
    // report itself healthy — /healthz stays 503 `starting`, which is the truth.
    logger.warn('BOT_NO_GATEWAY=true — not connecting to Discord. Health server only.');
    return;
  }

  logger.info('Connecting to the Discord gateway…', { guild: config.guildId });
  await connectWithBackoff(client);
}

main().catch(async (error) => {
  await fatal('Unhandled error during startup.', { message: String(error?.message || error) });
});
