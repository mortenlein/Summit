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
import { commandListMessage, unreachableMessage } from './src/fallback.js';
import logger, { redact } from './src/log.js';

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

/**
 * Everything /status reports. No token, no bearer key, no link codes — ever.
 *
 * Read this the way the spec's §9 asks the UI to be read: every field here must be true of
 * something that actually happened. Nothing may be named so that a tired organizer infers a
 * success the bot cannot vouch for. That is why there is no `lastLinkOkAt` — see below.
 */
const state = {
  state: 'starting', // starting | ready | reconnecting | fatal
  stateSince: new Date().toISOString(),
  botTag: null,
  guildId: config.guildId || null,
  /** The commands this build WANTS. Whether Discord has them is `commandsRegistered`. */
  commands: COMMANDS.map((c) => c.name),
  commandsAction: null, // up-to-date | updated | failed
  /** true / false / null for "we never got an answer out of Discord". Never assumed. */
  commandsRegistered: null,
  commandsAt: null,
  gatewayAttempts: 0,
  lastGatewayError: null,
  /**
   * Attempts, and — separately — the ones the app confirmed. A single `koble` counter is the
   * observability version of claiming a player was notified: it counts a kid mistyping a code
   * exactly the same as a kid who is now linked.
   */
  interactions: { koble: 0, kobleLinked: 0, stopp: 0, stoppConfirmed: 0, button: 0, failed: 0 },
  /** Set ONLY when the app answered ok:true for a real link. */
  lastLinkConfirmedAt: null,
  lastOptOutConfirmedAt: null,
};

/** Move to a new gateway state and remember when — /healthz bounds `reconnecting` by it. */
function setState(next) {
  if (state.state === next) return;
  state.state = next;
  state.stateSince = new Date().toISOString();
}

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
    reconnectGraceMs: config.reconnectGraceMs,
    // The last time the APP ANSWERED at all. It was called `lastLinkOkAt`, which was a false
    // claim in the exact style this feature exists to prevent: it was stamped by any 2xx,
    // including `{ok:false, reason:"unknown_code"}` and including an opt-out. An organizer
    // reading "a player last linked successfully at 01:12" was reading "the app was up at
    // 01:12". `lastLinkConfirmedAt` above is the honest field, and it is set only when the
    // app said the link happened.
    lastAppOkAt: summit.stats.lastOkAt ? new Date(summit.stats.lastOkAt).toISOString() : null,
    appCalls: summit.stats.calls,
    // Redacted defensively: these strings come from discord.js and from fetch, and the point
    // of /status is that it can be pasted into a chat when asking for help.
    lastError: redact(summit.stats.lastError ?? state.lastGatewayError ?? '') || null,
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
  setState('fatal');
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
      state.commandsRegistered = true;
      state.commandsAt = new Date().toISOString();
      logger.info('Commands already registered, unchanged — no write.', {
        guild: config.guildId,
        commands: state.commands.map((n) => `/${n}`).join(' '),
      });
      return;
    }
    await rest.put(route, { body: COMMANDS });
    state.commandsAction = 'updated';
    state.commandsRegistered = true;
    state.commandsAt = new Date().toISOString();
    logger.info('Commands registered (guild-scoped, instant).', {
      guild: config.guildId,
      commands: state.commands.map((n) => `/${n}`).join(' '),
    });
  } catch (error) {
    // Recoverable: the gateway connection is up, existing commands still work, and the next
    // restart retries. Never exit over this.
    state.commandsAction = 'failed';
    // NOT `false`: Discord may well still hold a working copy from a previous boot. `null` is
    // "we do not know", which is the only thing that is true here. Nothing downstream may read
    // this as "registered".
    state.commandsRegistered = null;
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
        if (result.ok) {
          state.interactions.kobleLinked += 1;
          state.lastLinkConfirmedAt = new Date().toISOString();
        }
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
        if (result.ok) {
          state.interactions.stoppConfirmed += 1;
          state.lastOptOutConfirmedAt = new Date().toISOString();
        }
        await interaction.editReply({ content: result.content, allowedMentions: { parse: [] } });
        logger.info('/stopp', {
          discordId: interaction.user.id,
          ok: result.ok,
          status: result.status,
          reply: result.source,
        });
        return;
      }

      // A command we no longer serve, left over in a stale client. Say nothing clever, and
      // say nothing the app owns — see src/fallback.js for why this is the bot's to hold.
      await deferEphemeral(interaction);
      await interaction.editReply({ content: commandListMessage(), allowedMentions: { parse: [] } });
      return;
    }

    if (interaction.isButton() && isOptOutButton(interaction.customId)) {
      await deferEphemeral(interaction);
      const result = await handleStopp(
        { discordId: interaction.user.id, locale: interaction.locale, via: 'button' },
        summit,
      );
      state.interactions.button += 1;
      if (result.ok) {
        state.interactions.stoppConfirmed += 1;
        state.lastOptOutConfirmedAt = new Date().toISOString();
      }
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
        // Deliberately the "no answer" line and never a success line: we do not know what
        // happened, and the one thing we must not do is tell a kid it worked.
        await interaction.editReply({
          content: unreachableMessage(interaction.locale),
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
      setState('reconnecting');
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
  let address;
  try {
    address = await health.listen(config.healthPort, config.healthHost);
  } catch (error) {
    // A taken port used to leave this await pending forever: no gateway, no further log
    // lines, nothing to read but a failing HEALTHCHECK and a container that looks hung.
    await fatal(
      `Could not bind the health port ${config.healthHost}:${config.healthPort}. Another ` +
        'process has it, or BOT_HEALTH_PORT is wrong in .env.bot.',
      { message: String(error?.message || error) },
    );
    return;
  }
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
    setState('ready');
    state.botTag = c.user.tag;
    const rest = new REST({ version: '10' }).setToken(config.token);
    await registerCommands(rest);
    // The runbook greps for READY. When registration failed we do not know whether the guild
    // has the commands at all, so the line must not read as "/koble and /stopp are live".
    const commandsPart = state.commandsRegistered === true
      ? `commands ${state.commands.map((n) => `/${n}`).join(' ')} (${state.commandsAction})`
      : 'commands NOT CONFIRMED (registration failed — /koble may be missing or stale)';
    logger.info(`READY as ${c.user.tag} · guild ${config.guildId} · ${commandsPart} · app ${config.summitUrl}`);
  });

  client.on(Events.ShardDisconnect, (event, shardId) => {
    setState('reconnecting');
    state.lastGatewayError = `shard ${shardId} disconnected (${event?.code ?? '?'})`;
    logger.warn('Gateway disconnected — discord.js will reconnect.', {
      shard: shardId,
      code: event?.code,
    });
  });

  client.on(Events.ShardReconnecting, (shardId) => {
    setState('reconnecting');
    logger.warn('Gateway reconnecting.', { shard: shardId });
  });

  client.on(Events.ShardResume, (shardId) => {
    setState('ready');
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

  // An uncaught synchronous throw is different: the process state is no longer trustworthy, so
  // swallowing it would leave a bot that answers /healthz while quietly doing nothing. Exit —
  // but through fatal(), so `restart: unless-stopped` restarts it on a 30-second cadence rather
  // than a 2-second one. A tight loop here burns Discord's 1000 IDENTIFY/day in ~35 minutes and
  // 429s the token for the rest of the LAN.
  process.on('uncaughtException', (error) => {
    // Registering this handler suppresses Node's own stack dump, so print it ourselves —
    // `docker logs summit-bot` is the only forensic record there is.
    void fatal('Uncaught exception — restarting on a slow cadence.', {
      message: String(error?.message || error),
      stack: String(error?.stack || '').split('\n').slice(0, 5).join(' | '),
    });
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
