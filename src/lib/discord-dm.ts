import fs from 'fs';
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import prisma from '@/lib/prisma';
import { getServerTranslations, userLocale } from '@/i18n/server';
import { LOCALES, type Locale } from '@/i18n/config';
import { stageLabelKey, totalRoundsOf } from '@/lib/stage-label';

/**
 * Direct messages to players, sent by the **app** — not by the gateway bot.
 *
 * The app already holds the REST client, the token, the Prisma client, the recipient list and
 * every Norwegian string; the bot (`summit-bot`) is slash commands and the opt-out button and
 * nothing else. Bot down therefore costs exactly one thing — nobody can *link* while it is
 * down — and costs nothing on LAN night. See `docs/discord-bot-spec.md` §1 and §8.
 *
 * Three rules this module exists to enforce:
 *
 *  1. **Never claim a DM arrived.** One `DiscordDmAttempt` row per recipient per send, carrying
 *     the outcome Discord actually returned. `SENT` means Discord accepted the message — never
 *     that a kid read it. Nothing in the UI may say "varslet" that is not backed by a row here.
 *  2. **Never send twice.** `@@unique([matchId, event, userId])` is the durable guard: the row
 *     is claimed *before* the send, so a marshal double-tapping "Kall opp", a retry, or an app
 *     restart mid-fan-out cannot put two "go to your seat" messages on one kid's phone.
 *  3. **Never retry a 50007.** "Cannot send messages to this user" is the kid's own privacy
 *     setting. Retrying it across forty players is the documented path to Discord's
 *     10,000-invalid-responses-in-10-minutes → one-hour IP ban, on LAN day, for nothing.
 */

// ---------------------------------------------------------------------------------------------
// Transport — the seam
// ---------------------------------------------------------------------------------------------

/**
 * Everything this module does to Discord, in two calls. Injectable so a test can assert what
 * *would* be sent (and make Discord fail in a specific way) without a token, and so the send
 * path is exercised identically whether or not one exists.
 */
export interface DmTransport {
  /**
   * Whether this transport can actually reach Discord. A mock MUST set false: it is what
   * makes it structurally impossible to record `SENT` for a message that never left the
   * process (spec §9 — nothing may claim delivery that Discord did not accept).
   */
  readonly real: boolean;
  /** POST /users/@me/channels → the DM channel id for a user. */
  openDmChannel(discordId: string): Promise<string>;
  /** POST /channels/{id}/messages. Plain text, mentions disarmed. */
  sendDm(channelId: string, discordId: string, content: string): Promise<void>;
}

/** A Discord refusal, normalised to the three things the error table keys off. */
export class DiscordDmError extends Error {
  constructor(
    readonly status: number,
    readonly code?: number,
    /** From the 429 body's `retry_after` (seconds), in ms. Never a fixed backoff of our own. */
    readonly retryAfterMs?: number,
    /** A 429 with `X-RateLimit-Scope: global` stalls the whole fan-out, not just this recipient. */
    readonly global = false
  ) {
    super(`Discord DM refused: HTTP ${status}${code ? ` (code ${code})` : ''}`);
    this.name = 'DiscordDmError';
  }
}

/** `true` once a bot token exists. Without one every send takes the mock path and logs instead. */
export function isDmProdReady(): boolean {
  return Boolean(process.env.DISCORD_BOT_TOKEN);
}

/**
 * The explicit "intercept everything" flag — the `[STRATEGY 3 MOCK]` posture, for DMs.
 *
 * Defined here rather than in discord-link.ts because it has to govern the transport, and the
 * transport lives here. It is the same flag `discord.ts` reads for channel posts, so one
 * setting silences every outbound path instead of two settings silencing one each.
 */
export function isDmIntercepted(): boolean {
  return process.env.NEXT_PUBLIC_STRATEGY_3_MOCK === "true";
}

/**
 * The master switch plus the organizer's phone-reachable kill switch.
 *
 * `DISCORD_DM_ENABLED` ships `false` and is flipped to `true` after the rehearsal;
 * `Tournament.discordDmPaused` is the Pause-Discord button in Control, which an organizer can
 * reach from a phone in a loud room without a laptop or a container restart.
 */
export function isDmEnabled(tournament?: { discordDmPaused?: boolean | null } | null): boolean {
  if (process.env.DISCORD_DM_ENABLED !== 'true') return false;
  return !tournament?.discordDmPaused;
}

/**
 * The configuration circuit breaker.
 *
 * 401 (wrong token) and 50001 (bot not in the guild) are not per-recipient failures — they will
 * happen for every recipient, identically. The first version treated them as terminal *for that
 * recipient* and moved on to the next, so one call-up on a ten-player match meant ten rejected
 * requests, and a tournament-wide re-announce meant forty. Discord counts sustained invalid
 * authorization against an application and bans for it: the failure mode of a typo'd token was
 * losing the bot, at a LAN, on the day.
 *
 * So the first config-level rejection stops every send in the process. Remaining recipients
 * still get their attempt row — those kids really were not reached, and the reach panel must
 * say so — but nothing else goes to Discord.
 *
 * The cooldown exists so a fix does not need a container restart: invite the bot to the guild,
 * wait it out, and the next call-up tries again. A wrong token will simply trip it once more.
 */
const BREAKER_COOLDOWN_MS_DEFAULT = 5 * 60 * 1000;

/** Five minutes in production. The e2e harness shortens it so a spec can watch it heal. */
function breakerCooldownMs(): number {
  const override = Number(process.env.DISCORD_DM_BREAKER_MS);
  return Number.isFinite(override) && override > 0 ? override : BREAKER_COOLDOWN_MS_DEFAULT;
}

let breaker: { reason: string; until: number } | null = null;

function tripBreaker(reason: string) {
  const cooldown = breakerCooldownMs();
  breaker = { reason, until: Date.now() + cooldown };
  console.error(
    `[DiscordDM] CONFIG BREAKER TRIPPED (${reason}). No further DMs for ${Math.round(
      cooldown / 1000
    )}s. Fix the configuration — this is not a per-player problem.`
  );
}

/** The reason DMs are being refused right now, or null. Exported for the reach panel and tests. */
export function dmBreakerReason(): string | null {
  if (!breaker) return null;
  if (Date.now() >= breaker.until) {
    breaker = null;
    return null;
  }
  return breaker.reason;
}

/** Test seam: forget a tripped breaker. */
export function resetDmBreaker() {
  breaker = null;
}

let restClient: REST | null = null;
function rest(): REST {
  if (!restClient) restClient = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN!);
  return restClient;
}

/** Turn whatever `@discordjs/rest` threw into a `DiscordDmError` the table below can read. */
function normalizeError(error: any): DiscordDmError {
  // RateLimitError (thrown before the request leaves) carries a reset, not a status.
  if (typeof error?.timeToReset === 'number' && !error?.status) {
    return new DiscordDmError(429, undefined, error.timeToReset, Boolean(error.global));
  }
  const status = Number(error?.status ?? error?.statusCode ?? 0) || 500;
  const code = typeof error?.code === 'number' ? error.code : undefined;
  const retryAfter = Number(error?.rawError?.retry_after ?? error?.retry_after ?? NaN);
  const globalScope = Boolean(error?.rawError?.global ?? error?.global);
  return new DiscordDmError(
    status,
    code,
    Number.isFinite(retryAfter) ? Math.round(retryAfter * 1000) : undefined,
    globalScope
  );
}

/** The real thing. */
export function restDmTransport(): DmTransport {
  return {
    real: true,
    async openDmChannel(discordId) {
      try {
        const channel: any = await rest().post(Routes.userChannels(), { body: { recipient_id: discordId } });
        return String(channel?.id ?? '');
      } catch (error) {
        throw normalizeError(error);
      }
    },
    async sendDm(channelId, _discordId, content) {
      try {
        await rest().post(Routes.channelMessages(channelId), {
          // `allowed_mentions: { parse: [] }` on every send: kids will name a team `@everyone`,
          // and the escaping below is belt to this braces.
          body: { content, allowed_mentions: { parse: [] } },
        });
      } catch (error) {
        throw normalizeError(error);
      }
    },
  };
}

/**
 * No token, no send. Logs what would have gone out and (only when `DISCORD_DM_SIMULATE` names a
 * file) lets a test make Discord fail in a named way — the error table is the half of this
 * module most likely to be wrong, and it is unreachable from a run with no credentials.
 *
 * The file is read fresh on every call so a spec can arm a failure between two sends. It is set
 * nowhere but `playwright.config.ts`.
 */
export function mockDmTransport(): DmTransport {
  const simulated = (discordId: string): DiscordDmError | null => {
    const file = process.env.DISCORD_DM_SIMULATE;
    if (!file || !fs.existsSync(file)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
      const rule = parsed?.[discordId] ?? parsed?.['*'];
      if (!rule) return null;
      return new DiscordDmError(
        Number(rule.status) || 500,
        typeof rule.code === 'number' ? rule.code : undefined,
        typeof rule.retryAfterMs === 'number' ? rule.retryAfterMs : undefined,
        Boolean(rule.global)
      );
    } catch {
      return null;
    }
  };

  return {
    real: false,
    async openDmChannel(discordId) {
      const failure = simulated(discordId);
      // 10003 "Unknown Channel" is a stale *cache*, so it belongs to the send, not the open.
      if (failure && failure.code !== 10003) throw failure;
      return `mock-dm-${discordId}`;
    },
    async sendDm(_channelId, discordId) {
      const failure = simulated(discordId);
      if (failure) throw failure;
      console.log(`[STRATEGY 3 MOCK] DM intercepted for ${discordId}`);
    },
  };
}

function defaultTransport(): DmTransport {
  // The flag wins over the token, in that order, deliberately. A deployment that has asked to
  // intercept everything must not start DMing 13-year-olds because somebody pasted a token into
  // .env — and an e2e run that wants the card configured has to be able to say so without the
  // sender quietly dialling Discord. Choosing on the token alone was that bug.
  if (isDmIntercepted()) return mockDmTransport();
  return isDmProdReady() ? restDmTransport() : mockDmTransport();
}

// ---------------------------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------------------------

/**
 * One DM per second, process-wide, with ±250 ms of jitter. Never `Promise.all`.
 *
 * Why one per second, and why the gate is global rather than per fan-out: the scarce route is
 * `POST /users/@me/channels`, and opening DM channels in a burst to accounts that have never
 * interacted with the bot is a known anti-spam flag vector. One match's roster is at most ten
 * players (teamSize 5), so a single call finishes in ~10 s — a DM that lands four seconds late
 * is fine; a 429 storm on LAN night is not. But a marshal calling four matches in a row would
 * otherwise start four independent fan-outs, i.e. ~40 opens in a few seconds, which is exactly
 * the shape that trips the limit. A single serial gate makes the *process* emit ≤1 DM/s no
 * matter how many matches are in flight, and a global 429 simply pushes the whole queue back.
 *
 * `DISCORD_DM_INTERVAL_MS` exists so the interval is an ops knob at 01:00, not a redeploy.
 */
const DM_INTERVAL_MS = () => Number(process.env.DISCORD_DM_INTERVAL_MS ?? 1000);
const JITTER_MS = 250;

let gate: Promise<unknown> = Promise.resolve();
let nextSlotAt = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function paced<T>(task: () => Promise<T>): Promise<T> {
  const run = gate.then(async () => {
    const wait = nextSlotAt - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await task();
    } finally {
      // `Math.max`, not an assignment: a task that hit a global 429 has already pushed the
      // queue out past its `retry_after`, and the ordinary one-second gap must not undo it.
      nextSlotAt = Math.max(
        nextSlotAt,
        Date.now() + DM_INTERVAL_MS() + Math.round((Math.random() * 2 - 1) * JITTER_MS)
      );
    }
  });
  gate = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** Stall every pending send — what a global 429 (or a `Retry-After`) actually asks for. */
function stallUntil(at: number) {
  nextSlotAt = Math.max(nextSlotAt, at);
}

// ---------------------------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------------------------

/**
 * Discord renders `* _ ~ \` | >` as markup and `@` as a mention. Every interpolated value is a
 * name somebody typed, so all of it is escaped and the `@` removed before it reaches a message.
 * Caps match the spec: team 32, tournament 48, player 24. Seats are never truncated (the column
 * is 16 chars) — a half-printed seat sends a kid to the wrong station.
 */
export function escapeDiscord(value: string, cap?: number): string {
  const stripped = String(value ?? '')
    .replace(/@/g, '')
    .replace(/([*_~`|>\\])/g, '\\$1')
    .trim();
  if (!cap || stripped.length <= cap) return stripped;
  return `${stripped.slice(0, cap - 1)}…`;
}

// ---------------------------------------------------------------------------------------------
// Sending one message
// ---------------------------------------------------------------------------------------------

export type DmEvent = 'LINK_PROBE' | 'MATCH_CALLED' | 'MATCH_LIVE';

export type DmOutcome =
  | 'PENDING'
  /** The send path ran against a mock — Discord was never contacted. Never counts as reach. */
  | 'MOCKED'
  | 'SENT'
  | 'BLOCKED'
  | 'UNKNOWN_USER'
  | 'RATE_LIMITED'
  | 'ERROR'
  /** The master flag is off. Nothing was attempted. */
  | 'SKIPPED_DISABLED'
  /** An organizer pulled the per-tournament kill switch. Nothing was attempted. */
  | 'SKIPPED_PAUSED'
  | 'SKIPPED_OPTOUT';

/** The outcomes that mean "Discord was never asked", as opposed to "Discord was asked and said no". */
const NOT_ATTEMPTED: ReadonlySet<string> = new Set<DmOutcome>([
  'PENDING',
  'MOCKED',
  'SKIPPED_DISABLED',
  'SKIPPED_PAUSED',
  'SKIPPED_OPTOUT',
]);

/**
 * True when the message really was handed to Discord.
 *
 * Never infer this from `outcome !== 'SENT'`. The two questions differ, and the column that
 * depends on the difference is `dmCheckedAt`: it is a *check* timestamp, so stamping it for a
 * send nobody attempted makes a never-tried link look freshly verified on every staff screen
 * that ages or sorts by it.
 */
export function wasDmAttempted(outcome: DmOutcome): boolean {
  return !NOT_ATTEMPTED.has(outcome);
}

/**
 * Call-up outcomes that make a MATCH_LIVE DM pointless for that one recipient. Everything NOT in
 * this set — PENDING, ERROR, RATE_LIMITED — is a kid the call-up never reached, so the live
 * message is their second chance and must go out.
 */
export const CALL_UP_NOT_WORTH_REPEATING: readonly DmOutcome[] = [
  /** It landed. They walked over thirty seconds ago; a second buzz tells them nothing. */
  'SENT',
  /** A configured mock run stood in for a landing. Not reach — but not a retry either. */
  'MOCKED',
  /** Discord refuses DMs from this bot to this account; a second try earns the same 50007. */
  'BLOCKED',
  /** The account is gone; a second try earns the same 10013. */
  'UNKNOWN_USER',
  /** They asked us not to write to them. */
  'SKIPPED_OPTOUT',
];

export interface DmRequest {
  userId: string;
  discordId: string;
  /** Cached DM channel from a previous send. Latency only — a 10003 clears it and we re-open. */
  dmChannelId?: string | null;
  event: DmEvent;
  matchId?: string | null;
  locale: Locale;
  content: string;
}

export interface DmResult {
  userId: string;
  outcome: DmOutcome;
  discordCode?: number;
  /** False when the attempt row already existed — i.e. this send was a duplicate and was skipped. */
  attempted: boolean;
}

/** Mirrors `PUSH_DELIVERY_LOG`: one JSON line per attempt, so "did the DM go out" is answerable. */
function logAttempt(entry: Record<string, unknown>) {
  const file = process.env.DISCORD_DM_LOG;
  if (!file) return;
  try {
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch {
    // Diagnostics must never silence a notification.
  }
}

/**
 * Claim the attempt row, then send.
 *
 * The row is written **first**, with outcome `PENDING`, because the unique constraint is the
 * only durable double-send guard there is: if the claim loses to an existing row, somebody
 * already sent (or is sending) this exact message to this exact player for this exact match,
 * and the correct behaviour is to do nothing at all. `createMany({ skipDuplicates })` is not
 * supported on SQLite, so this is a `create()` with `P2002` caught.
 *
 * A row left at `PENDING` means the process died between claiming and learning the outcome.
 * That is the honest record of what happened and deliberately does not count as `SENT`.
 */
export async function sendDirectMessage(
  request: DmRequest,
  transport: DmTransport = defaultTransport()
): Promise<DmResult> {
  const { userId, discordId, event, matchId = null, locale, content } = request;

  // The master switch is checked HERE, not only at the fan-out. This function is exported, the
  // bot's link probe can be wired to it, and a switch that one caller can walk around is not a
  // switch. Nothing is written: no attempt was made, and an attempt row means an attempt.
  if (!isDmEnabled()) {
    return { userId, outcome: 'SKIPPED_DISABLED', attempted: false };
  }

  let attemptId: string;
  try {
    const row = await prisma.discordDmAttempt.create({
      data: { userId, discordId, event, matchId, outcome: 'PENDING', locale },
      select: { id: true },
    });
    attemptId = row.id;
  } catch (error: any) {
    if (error?.code !== 'P2002') throw error;
    // Somebody already claimed this exact (match, event, player). Report what that attempt
    // concluded rather than inventing an outcome — the row is the record, not this call.
    const existing = await prisma.discordDmAttempt.findFirst({
      where: { matchId, event, userId },
      select: { outcome: true, discordCode: true },
    });
    return {
      userId,
      outcome: (existing?.outcome as DmOutcome) ?? 'PENDING',
      discordCode: existing?.discordCode ?? undefined,
      attempted: false,
    };
  }

  const finish = async (outcome: DmOutcome, discordCode?: number, dmState?: string, dmError?: string) => {
    await prisma.discordDmAttempt
      .update({ where: { id: attemptId }, data: { outcome, discordCode: discordCode ?? null } })
      .catch(() => {});
    if (dmState) {
      // updateMany, never update: an organizer unlinking mid-fan-out must not 500 a send.
      await prisma.discordLink
        .updateMany({
          where: { userId },
          data: { dmState, dmCheckedAt: new Date(), dmError: dmError ?? null },
        })
        .catch(() => {});
    }
    logAttempt({ event, matchId, userId, discordId, locale, outcome, discordCode, content });
    return { userId, outcome, discordCode, attempted: true } as DmResult;
  };

  let channelId = request.dmChannelId || null;
  let reopened = false;
  let serverRetries = 0;
  let rateRetries = 0;

  // A config-level failure earlier in this fan-out already told us what Discord will say. The
  // row is written (this kid was not reached, and the panel must show that) but nothing is sent.
  const tripped = dmBreakerReason();
  if (tripped) {
    // Prefixed, so the record distinguishes "Discord told us this" from "we already knew and
    // did not ask again" — which is the whole question when somebody is working out at 02:00
    // why forty players show as unreached.
    return finish('ERROR', undefined, 'UNKNOWN', `breaker_${tripped}`);
  }

  // The retry loop runs *inside* the paced slot: a 429 or a 5xx backoff has to stall everybody,
  // not just this recipient, or the retry lands in the middle of somebody else's send.
  return paced(async () => {
    for (;;) {
      try {
        if (!channelId) {
          channelId = await transport.openDmChannel(discordId);
          await prisma.discordLink.updateMany({ where: { userId }, data: { dmChannelId: channelId } }).catch(() => {});
        }
        await transport.sendDm(channelId, discordId, content);
        // A mock never contacted Discord, so it may not claim delivery — MOCKED is a separate
        // outcome precisely so the reach panel, the audit trail and the UI cannot be fooled by
        // a missing token (spec §9). `dmState` is left untouched for the same reason.
        return transport.real
          ? await finish('SENT', undefined, 'SENT')
          : await finish('MOCKED');
      } catch (raw) {
        const error = raw instanceof DiscordDmError ? raw : normalizeError(raw);

        // 50007 — DMs from server members are off, the bot is blocked, or the kid left the
        // guild. Indistinguishable from outside, terminal, and never retried.
        if (error.code === 50007) {
          return await finish('BLOCKED', 50007, 'BLOCKED', 'cannot_send_to_user');
        }
        // 50001 Missing Access — the bot is probably not in the guild. Config problem, not a
        // per-user one: terminal here, and loud in the log.
        if (error.code === 50001) {
          console.error('[DiscordDM] Missing Access (50001) — is the bot in the guild?');
          tripBreaker('missing_access');
          return await finish('ERROR', 50001, 'UNKNOWN', 'missing_access');
        }
        // 10013 Unknown User — the snowflake is gone. Clear the cache and ask for a re-link.
        if (error.code === 10013) {
          await prisma.discordLink.updateMany({ where: { userId }, data: { dmChannelId: null } }).catch(() => {});
          return await finish('UNKNOWN_USER', 10013, 'UNKNOWN', 'unknown_user');
        }
        // 10003 Unknown Channel — a stale cached channel, the one place a retry is correct.
        if (error.code === 10003 && !reopened) {
          reopened = true;
          channelId = null;
          await prisma.discordLink.updateMany({ where: { userId }, data: { dmChannelId: null } }).catch(() => {});
          continue;
        }
        // 401/50014 — the token is wrong. Nothing about this is per-recipient.
        if (error.status === 401) {
          console.error('[DiscordDM] FATAL: Discord rejected the bot token (401).');
          // Every remaining recipient would earn the same 401, and Discord bans applications for
          // sustained invalid authorization. One is a typo; forty is losing the bot.
          tripBreaker('invalid_token');
          return await finish('ERROR', error.code, 'UNKNOWN', 'invalid_token');
        }
        // 429 — honour the body's retry_after, never a backoff of our own. Does not consume the
        // send budget; two retries, then give up and say so.
        if (error.status === 429) {
          const waitMs = Math.max(0, error.retryAfterMs ?? 1000);
          stallUntil(Date.now() + waitMs);
          // A *global* 429 is the whole application being throttled, not this route. Pressing on
          // through the rest of the roster is what turns a throttle into a ban.
          if (error.global) {
            tripBreaker('global_rate_limit');
            return await finish('RATE_LIMITED', error.code, undefined, 'global_rate_limit');
          }
          if (rateRetries < 2) {
            rateRetries += 1;
            await sleep(waitMs);
            continue;
          }
          return await finish('RATE_LIMITED', error.code, undefined, 'rate_limited');
        }
        // 5xx — Discord is having a day. 2s, then 8s, then stop.
        if (error.status >= 500 && serverRetries < 2) {
          const waitMs = serverRetries === 0 ? 2000 : 8000;
          serverRetries += 1;
          await sleep(waitMs);
          continue;
        }
        return await finish('ERROR', error.code, undefined, `http_${error.status}`);
      }
    }
  });
}

// ---------------------------------------------------------------------------------------------
// The match fan-out
// ---------------------------------------------------------------------------------------------

export interface DmRecipient {
  userId: string;
  discordId: string;
  dmChannelId: string | null;
  locale: Locale;
  optOut: boolean;
  dmState: string;
  /** This player's own seat. Never anyone else's — a DM is forwardable. */
  seating: string | null;
}

/**
 * Who on this match can actually be written to.
 *
 * A player is reachable only with a `User` behind them (organizer-typed rosters had none until
 * `player-identity.ts`), a `DiscordLink`, and DMs that Discord has not already refused. Both
 * rosters are resolved in one pass and each recipient carries **their own** seat and **their
 * own** language — the orientation bug (away players told the home team's seat, or the whole
 * match composed in the home player's language) is invisible at 02:00 and obvious in a test.
 */
export async function matchDmRecipients(matchId: string): Promise<DmRecipient[]> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      homeTeam: { select: { players: { select: { userId: true, seating: true } } } },
      awayTeam: { select: { players: { select: { userId: true, seating: true } } } },
    },
  });
  if (!match?.homeTeam || !match?.awayTeam) return [];

  const players = [...match.homeTeam.players, ...match.awayTeam.players].filter(
    (p): p is { userId: string; seating: string | null } => Boolean(p.userId)
  );
  if (players.length === 0) return [];

  const seats = new Map(players.map((p) => [p.userId, p.seating]));
  const links = await prisma.discordLink.findMany({
    where: { userId: { in: Array.from(seats.keys()) } },
    select: {
      userId: true,
      discordId: true,
      dmChannelId: true,
      optOut: true,
      dmState: true,
      user: { select: { locale: true } },
    },
  });

  return links.map((link) => ({
    userId: link.userId,
    discordId: link.discordId,
    dmChannelId: link.dmChannelId,
    locale: userLocale(link.user?.locale),
    optOut: link.optOut,
    dmState: link.dmState,
    seating: seats.get(link.userId) ?? null,
  }));
}

/** One language's worth of a fan-out: who reads it, and the message each of them gets. */
export interface DmBatch {
  locale: Locale;
  messages: { recipient: DmRecipient; content: string }[];
}

/**
 * Compose the fan-out, grouped by the language each recipient reads.
 *
 * Same shape as `buildMatchReadyPushBatches` in `notify.ts`, deliberately: recipients are
 * grouped by `User.locale` and the copy is written once per group. `{stage}` is resolved inside
 * the same group, or a Norwegian player reads "Seat B12 — go there now · Kvartfinale".
 *
 * Plain text, never an embed: Discord's mobile notification preview renders `content`, and an
 * embed-only message previews as nothing. The one message that has to survive a glance at a
 * lock screen would be the one that shows nothing.
 *
 * Exported so the payload set — the whole observable contract of a DM — is testable without a
 * token in the loop.
 */
export async function buildMatchDmBatches(
  matchId: string,
  event: 'MATCH_CALLED' | 'MATCH_LIVE',
  recipients: DmRecipient[]
): Promise<DmBatch[]> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      round: true,
      bracketType: true,
      tournamentId: true,
      tournament: { select: { name: true } },
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
    },
  });
  if (!match?.homeTeam || !match?.awayTeam) return [];

  const draw = await prisma.match.findMany({
    where: { tournamentId: match.tournamentId },
    select: { bracketType: true, round: true },
  });
  const stage = stageLabelKey(match, totalRoundsOf(draw));

  const home = escapeDiscord(match.homeTeam.name, 32);
  const away = escapeDiscord(match.awayTeam.name, 32);
  const tournament = escapeDiscord(match.tournament.name, 48);
  // Never the server credentials. `match-links.ts` builds `steam://connect/{ip}:{port}/{pw}`,
  // and a DM is forwardable to a room we cannot see — so the link goes to Summit, which knows
  // who is asking. The SSE stream strips the same fields for the same reason.
  const url = `${process.env.NEXTAUTH_URL || ''}/tournaments/${match.tournamentId}`;

  const grouped = new Map<Locale, DmRecipient[]>();
  for (const recipient of recipients) {
    const bucket = grouped.get(recipient.locale);
    if (bucket) bucket.push(recipient);
    else grouped.set(recipient.locale, [recipient]);
  }

  const batches: DmBatch[] = [];
  for (const locale of LOCALES) {
    const group = grouped.get(locale);
    if (!group) continue;

    const t = await getServerTranslations(locale, 'notifications');
    const tStage = await getServerTranslations(locale, 'stage');
    const body = t('dm.body', { home, away, stage: tStage(stage.key, stage.values), tournament });
    const link = t('dm.link', { url });
    const tail = t('dm.tail');
    const leadKey = event === 'MATCH_LIVE' ? 'dm.live.lead' : 'dm.called.lead';

    batches.push({
      locale,
      messages: group.map((recipient) => {
        // ICU selects on a caller-supplied `hasSeat`, never on `{seat}` itself: `Player.seating`
        // is 16 chars of free text and a kid can type "none" straight into the wrong arm.
        const seat = recipient.seating?.trim() || '';
        const lead = t(leadKey, { hasSeat: seat ? 'yes' : 'no', seat: escapeDiscord(seat) });
        return { recipient, content: [lead, body, link, tail].join('\n') };
      }),
    });
  }
  return batches;
}

export interface SendMatchDmsOptions {
  transport?: DmTransport;
}

/**
 * DM both rosters that their match has been called, or has gone live.
 *
 * Call it detached (`void sendMatchDms(...).catch(() => {})`) — never inside the marshal's tap.
 * Ten sequential DMs, or one 429 with a multi-second `retry_after`, and the "Kall opp" button
 * spins in a loud room while they tap it again.
 *
 * Deliberately **not durable**: nothing here survives a restart, and that is the design. A "go
 * to your seat" message that outlives a container and lands twenty minutes late sends a kid to
 * a station somebody else is playing at.
 */
export async function sendMatchDms(
  matchId: string,
  event: 'MATCH_CALLED' | 'MATCH_LIVE',
  options: SendMatchDmsOptions = {}
): Promise<DmResult[]> {
  try {
    const match = await prisma.match.findUnique({
      where: { id: matchId },
      select: { id: true, tournament: { select: { discordDmPaused: true } } },
    });
    if (!match) return [];
    if (!isDmEnabled(match.tournament)) return [];

    let recipients = await matchDmRecipients(matchId);
    if (recipients.length === 0) return [];

    // §7: a match that already DM'd its call-up does not DM again when it goes live. The kid
    // walked over thirty seconds ago; the channel post carries the rest.
    //
    // Per recipient, not per match. Counting rows was the first version and it silenced the live
    // DM for the whole roster as soon as *any* call-up row existed — including a PENDING row from
    // a fan-out that died mid-flight, and an ERROR row from a 500 at Discord. The kid those rows
    // describe was never reached by anything, and the live message was their second chance.
    if (event === 'MATCH_LIVE') {
      const calledRows = await prisma.discordDmAttempt.findMany({
        where: { matchId, event: 'MATCH_CALLED' },
        select: { userId: true, outcome: true },
      });
      const settled = new Set(
        calledRows
          .filter((row) => (CALL_UP_NOT_WORTH_REPEATING as readonly string[]).includes(row.outcome))
          .map((row) => row.userId)
      );
      recipients = recipients.filter((r) => !settled.has(r.userId));
      if (recipients.length === 0) return [];
    }

    const results: DmResult[] = [];

    // Opting out is absolute and is honoured before anything is composed — but it is *recorded*,
    // because "we chose not to write to this player" and "this player is not linked" have
    // different remedies on the organizer's reach panel.
    const optedOut = recipients.filter((r) => r.optOut);
    for (const recipient of optedOut) {
      try {
        await prisma.discordDmAttempt.create({
          data: {
            userId: recipient.userId,
            discordId: recipient.discordId,
            event,
            matchId,
            outcome: 'SKIPPED_OPTOUT',
            locale: recipient.locale,
          },
        });
        results.push({ userId: recipient.userId, outcome: 'SKIPPED_OPTOUT', attempted: false });
      } catch (error: any) {
        if (error?.code !== 'P2002') throw error;
      }
    }

    // A link Discord has already refused gets no row at all: an "attempt" that was never made
    // is not an attempt, and `DiscordLink.dmState = BLOCKED` is already the record of why.
    const sendable = recipients.filter((r) => !r.optOut && r.dmState !== 'BLOCKED');
    if (sendable.length === 0) return results;

    const batches = await buildMatchDmBatches(matchId, event, sendable);
    const transport = options.transport ?? defaultTransport();

    for (const batch of batches) {
      for (const { recipient, content } of batch.messages) {
        results.push(
          await sendDirectMessage(
            {
              userId: recipient.userId,
              discordId: recipient.discordId,
              dmChannelId: recipient.dmChannelId,
              event,
              matchId,
              locale: batch.locale,
              content,
            },
            transport
          )
        );
      }
    }

    return results;
  } catch (error) {
    console.warn('[DiscordDM] fan-out failed:', error);
    return [];
  }
}
