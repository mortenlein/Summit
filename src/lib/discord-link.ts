import { randomInt } from "crypto";
import prisma from "@/lib/prisma";
import { getServerTranslations, userLocale } from "@/i18n/server";
import type { Locale } from "@/i18n/config";

/**
 * Account linking — the app half of `/koble`.
 *
 * Steam is the identity Summit trusts. A Discord account is only ever an *address* we are
 * allowed to deliver to, proved by the owner of both sides in one gesture: the app mints a
 * short code, the kid types it into `/koble` inside the club's Discord server, and the bot
 * hands it back here over the compose network. Nothing here talks to the gateway, and nothing
 * here stores a token of any kind — only a public snowflake the user volunteered.
 *
 * The bot renders no copy: every reply it shows is composed *here*, in the linking user's own
 * language, so all Norwegian stays in `messages/` under `npm run i18n:check`.
 */

/**
 * Unambiguous by construction: no `0/O`, no `1/I/L`, and no vowels, so a code can never spell
 * a word and can never be mistyped by a 12-year-old reading it off a screen in a loud room.
 * Deliberately not the `uuidv4().slice(0, 8)` recipe used for invite codes — that one is fine
 * to paste and wrong to type.
 */
export const LINK_CODE_ALPHABET = "23456789BCDFGHJKMNPQRSTVWXYZ";
export const LINK_CODE_LENGTH = 6;
/** Long enough to alt-tab into Discord and find the command; short enough that a shoulder-surfed code dies. */
export const LINK_CODE_TTL_MS = 10 * 60 * 1000;

/** Discord snowflakes are 17-20 digit decimal ids. Anything else is not an account. */
const SNOWFLAKE = /^\d{17,20}$/;
const USERNAME_MAX = 64;

/**
 * Configured = the bot can reach us, a kid who is not in the guild has somewhere to go, AND we
 * hold the token that a DM actually needs. The token is part of the gate on purpose: the whole
 * promise of the card is "link this and I will message you there", and without
 * `DISCORD_BOT_TOKEN` the app cannot open a DM channel at all. Offering the card anyway would
 * walk a 12-year-old through three steps to earn a link that can never deliver anything.
 *
 * Mirrors `isPushConfigured()`: the UI self-hides instead of offering a dead end.
 */
export function isDiscordLinkConfigured(): boolean {
  return Boolean(
    process.env.SUMMIT_BOT_KEY &&
      process.env.DISCORD_GUILD_ID &&
      process.env.DISCORD_INVITE_URL &&
      process.env.DISCORD_BOT_TOKEN
  );
}

export function discordInviteUrl(): string {
  return process.env.DISCORD_INVITE_URL || "";
}

/** `randomInt` (CSPRNG), not `Math.random` — this code is a bearer credential for ten minutes. */
export function generateLinkCode(): string {
  let out = "";
  for (let i = 0; i < LINK_CODE_LENGTH; i++) {
    out += LINK_CODE_ALPHABET[randomInt(LINK_CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * What the kid typed → what we look up.
 *
 * They will send `/koble H7K2QP`, or `h7k2qp`, or `H7K2-QP`. All three are the same code, and
 * refusing them would be refusing the exact person the short alphabet was designed for.
 */
export function normalizeLinkCode(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .trim()
    .replace(/^\/?koble\s+/i, "")
    .replace(/[\s-]/g, "")
    .toUpperCase()
    .slice(0, LINK_CODE_LENGTH);
}

/**
 * Discord renders message content as markdown and resolves mentions. Every value that came
 * from a human is escaped before it reaches a reply, and `@` is stripped outright — a kid will
 * name themselves `@everyone` within the hour.
 */
export function escapeDiscordText(value: string): string {
  return value.replace(/[\\*_~`|>]/g, (c) => `\\${c}`).replace(/@/g, "");
}

export interface IssuedCode {
  code: string;
  expiresAt: Date;
}

/**
 * One live code per user — `DiscordLinkCode.userId` is `@unique`, so a re-issue *replaces*
 * rather than erroring. A kid who lost the tab and clicks again gets a code, not a refusal.
 */
export async function issueLinkCode(userId: string): Promise<IssuedCode> {
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);

  // The 28^6 space makes a collision with a *live* code vanishingly unlikely, but the column
  // is the primary key, so a collision would be a 500 rather than a retry unless we say so.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateLinkCode();
    try {
      await prisma.discordLinkCode.upsert({
        where: { userId },
        create: { code, userId, expiresAt },
        update: { code, expiresAt, createdAt: new Date() },
      });
      return { code, expiresAt };
    } catch (error: any) {
      if (error?.code === "P2002") continue;
      throw error;
    }
  }
  throw new Error("Could not mint a Discord link code");
}

/** The live code for a user, or null once it has expired. An expired code is never rendered. */
export async function liveLinkCode(userId: string): Promise<IssuedCode | null> {
  const row = await prisma.discordLinkCode.findUnique({ where: { userId } });
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  return { code: row.code, expiresAt: row.expiresAt };
}

// ---------------------------------------------------------------------------------------
// The DM probe
//
// Linking proves an *address*; only a message proves we can *use* it. Everything in this
// section exists so the difference between those two is never blurred: an outcome written here
// is the only evidence anything in the product may treat as "we sent them something", so it
// may say SENT only when Discord itself returned success.
//
// There is no Discord token in this repo, so the default posture is the one the channel
// announcer already has: log, do not send — and record that as MOCKED, never as SENT.
// ---------------------------------------------------------------------------------------

/**
 * The vocabulary of `DiscordDmAttempt.outcome`.
 *
 * `SENT` is the load-bearing one and it means exactly one thing: **Discord's API accepted the
 * message** (HTTP 200/204). It does not mean a phone was on, un-muted, or in a hand, and it
 * must never be written for a message that was not really handed to Discord. Everything that
 * did not reach Discord gets its own name instead, so no counter can quietly round it up:
 *
 * - `MOCKED`           — mock mode. We composed a message and sent nothing.
 * - `SKIPPED_DISABLED` — `DISCORD_DM_ENABLED` is not `true`. Nothing was attempted.
 * - `SKIPPED_PAUSED`   — an organizer pulled the per-tournament kill switch.
 * - `SKIPPED_OPTOUT`   — the player said stop. Honoured before any send.
 * - `BLOCKED` / `UNKNOWN_USER` / `RATE_LIMITED` / `ERROR` — Discord was asked and said no.
 */
export type DmOutcome =
  | "SENT"
  | "BLOCKED"
  | "UNKNOWN_USER"
  | "RATE_LIMITED"
  | "ERROR"
  | "MOCKED"
  | "SKIPPED_DISABLED"
  | "SKIPPED_PAUSED"
  | "SKIPPED_OPTOUT";

/** The outcomes that mean "Discord was never asked", as opposed to "Discord said no". */
const NOT_ATTEMPTED: ReadonlySet<string> = new Set<DmOutcome>([
  "MOCKED",
  "SKIPPED_DISABLED",
  "SKIPPED_PAUSED",
  "SKIPPED_OPTOUT",
]);

/** True when we actually handed the message to Discord. Never infer this from `outcome !== 'SENT'`. */
export function wasDmAttempted(outcome: DmOutcome): boolean {
  return !NOT_ATTEMPTED.has(outcome);
}

export interface DmProbeRequest {
  discordId: string;
  locale: Locale;
  /** Already composed, in the recipient's language. */
  body: string;
}

export interface DmProbeResult {
  outcome: DmOutcome;
  /** Discord's own JSON error code, e.g. 50007 "Cannot send messages to this user". */
  discordCode?: number;
  /** Latency cache only — cleared by the sender on 10003, never trusted. */
  dmChannelId?: string | null;
  error?: string;
}

export type DmProbe = (request: DmProbeRequest) => Promise<DmProbeResult>;

/**
 * Mock mode is **explicit**, exactly like `discord.ts:130`: the flag, and nothing else.
 *
 * It deliberately does *not* fall back to "no `DISCORD_BOT_TOKEN`". That fallback is how a
 * production deploy with a missing token silently turned into a mock that reported success for
 * every kid on the floor. A missing token is now a misconfiguration that fails closed
 * (`isDiscordLinkConfigured()` hides the card, and `runProbe` records `ERROR`), never a
 * pretend-send.
 */
export function isDiscordDmMocked(): boolean {
  return process.env.NEXT_PUBLIC_STRATEGY_3_MOCK === "true";
}

/** The hard master switch from §5. Ships `false`; unset means off. */
export function isDiscordDmEnabled(): boolean {
  return process.env.DISCORD_DM_ENABLED === "true";
}

/**
 * Mock-only: snowflakes the mock probe refuses with 50007 ("Cannot send messages to this
 * user"), so the *failure* half of linking — the half that decides whether a marshal walks —
 * is verifiable with no Discord token in the repo. Comma-separated, unset in production.
 */
function mockBlockedIds(): Set<string> {
  return new Set(
    (process.env.DISCORD_DM_MOCK_BLOCKED || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

/**
 * The mock never returns `SENT`.
 *
 * A simulated *failure* is safe: it under-claims reach, and the remedy it triggers (a marshal
 * walks, the kid is told to re-run `/koble`) is the behaviour we want by default. A simulated
 * *success* is the one thing this feature exists to prevent, so the happy path records
 * `MOCKED` — distinguishable from a real 204 in the database, in the reach panel, and in a
 * 02:00 query.
 */
const mockProbe: DmProbe = async ({ discordId, locale, body }) => {
  if (mockBlockedIds().has(discordId)) {
    console.log(`[DISCORD DM MOCK] ✗ ${discordId} (${locale}): 50007 cannot send messages to this user`);
    return { outcome: "BLOCKED", discordCode: 50007 };
  }
  console.log(`[DISCORD DM MOCK] (nothing sent) would DM ${discordId} (${locale}): ${body}`);
  return { outcome: "MOCKED" };
};

/**
 * The phone-reachable kill switch (§10), applied to a link probe.
 *
 * A probe belongs to no match and therefore to no single tournament, so the conservative read
 * wins: if *any* tournament this player is on has `discordDmPaused`, the organizer pulled that
 * switch while this kid was on the floor, and they get no DM from us. Failing closed costs a
 * kid one "not confirmed" line on a card; failing open costs the switch its meaning.
 */
async function isDmPausedForUser(userId: string): Promise<boolean> {
  const paused = await prisma.player.findFirst({
    where: { userId, tournament: { discordDmPaused: true } },
    select: { id: true },
  });
  return Boolean(paused);
}

/**
 * Run the probe, or record honestly why we did not.
 *
 * Order matters: both kill switches are checked *before* anything is composed or sent, because
 * a switch one path ignores is not a switch. The real sender does not exist yet — when
 * `src/lib/discord-dm.ts` lands it is imported and called from the marked branch below. Until
 * then a configured-for-real deploy records `ERROR`, never `SENT`.
 */
async function runProbe(request: DmProbeRequest, userId: string): Promise<DmProbeResult> {
  if (!isDiscordDmEnabled()) {
    return { outcome: "SKIPPED_DISABLED", error: "dm_disabled" };
  }
  if (await isDmPausedForUser(userId)) {
    return { outcome: "SKIPPED_PAUSED", error: "dm_paused" };
  }
  if (isDiscordDmMocked()) {
    try {
      return await mockProbe(request);
    } catch (error: any) {
      return { outcome: "ERROR", error: String(error?.message || error) };
    }
  }
  // ── The real sender plugs in here (§8). ──
  // Configured for real delivery, but no sender exists yet. Saying SENT here is the exact lie
  // this feature exists to prevent, so the link stands and the DM does not.
  return { outcome: "ERROR", error: "no_dm_sender_registered" };
}

/**
 * `dmState` is UNKNOWN | SENT | BLOCKED — three states, because the remedies differ.
 *
 * Only a real `SENT` maps to `SENT`. Everything we never actually attempted lands on UNKNOWN,
 * which the card already renders as "not confirmed" and the reach panel already counts as
 * unreachable.
 */
function dmStateFor(outcome: DmOutcome): "UNKNOWN" | "SENT" | "BLOCKED" {
  if (outcome === "SENT") return "SENT";
  if (outcome === "BLOCKED" || outcome === "UNKNOWN_USER") return "BLOCKED";
  return "UNKNOWN";
}

// ---------------------------------------------------------------------------------------
// Redemption
// ---------------------------------------------------------------------------------------

export type LinkFailure = "bad_request" | "unknown_code" | "discord_taken";

/** Thrown inside the redemption transaction to roll it back when the code was already spent. */
class CodeAlreadySpent extends Error {
  constructor() {
    super("link code already spent");
  }
}

export interface LinkResult {
  ok: boolean;
  reason?: LinkFailure;
  /** An already-rendered string in the linking user's language. The bot prints it verbatim. */
  reply: string;
  /** Present on success, so the bot can say who it just linked. */
  name?: string;
  locale?: Locale;
  /** True when this replaced a link to a *different* Discord account. */
  relinked?: boolean;
  dmState?: string;
}

/** The name a kid recognises: their own nickname on the floor, else their Steam name. */
async function displayNameFor(userId: string, fallback: string | null): Promise<string> {
  const player = await prisma.player.findFirst({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    select: { name: true, nickname: true },
  });
  return (player?.nickname || player?.name || fallback || "Summit").slice(0, 32);
}

/**
 * Redeem a code and bind the Discord account.
 *
 * Conflicts are resolved **by owner, not by existence** (spec §6): a snowflake already bound to
 * the *same* Summit user is an idempotent re-link — which is the whole recovery path for a kid
 * whose DMs were closed the first time — and only a *different* owner is refused. Silently
 * stealing the binding would stop the first kid's DMs with no signal anywhere.
 */
export async function redeemLinkCode(input: {
  code: unknown;
  discordId: unknown;
  discordUsername: unknown;
}): Promise<LinkResult> {
  const code = normalizeLinkCode(input.code);
  const discordId = typeof input.discordId === "string" ? input.discordId.trim() : "";
  // Never the empty string: this is rendered as "Koblet til Discord som {username}" on the card
  // and next to a name on the crew's screens, and an empty slot there reads as a broken row.
  // Discord does not always give the bot a username (a stripped interaction payload, an
  // account mid-rename), so the fallback is the only honest thing we know: it is a Discord
  // account, and the snowflake behind it is staff-only.
  const discordUsername =
    typeof input.discordUsername === "string" && input.discordUsername.trim()
      ? input.discordUsername.trim().slice(0, USERNAME_MAX)
      : "Discord";

  if (!SNOWFLAKE.test(discordId)) {
    // Not the kid's mistake and not something they can fix by pasting a code: the caller sent
    // something that is not a Discord account at all. `bot.noCode` would tell them to do the
    // one thing that cannot help, so they get the "that didn't resolve, get a new code" reply.
    const t = await getServerTranslations(userLocale(null), "discord");
    return { ok: false, reason: "bad_request", reply: t("bot.unknownCode") };
  }
  if (code.length !== LINK_CODE_LENGTH) {
    const t = await getServerTranslations(userLocale(null), "discord");
    return code
      ? { ok: false, reason: "unknown_code", reply: t("bot.unknownCode") }
      : { ok: false, reason: "bad_request", reply: t("bot.noCode") };
  }

  const pending = await prisma.discordLinkCode.findUnique({
    where: { code },
    select: { code: true, userId: true, expiresAt: true, user: { select: { name: true, locale: true } } },
  });

  if (!pending) {
    const t = await getServerTranslations(userLocale(null), "discord");
    return { ok: false, reason: "unknown_code", reply: t("bot.unknownCode") };
  }

  const locale = userLocale(pending.user?.locale);
  const t = await getServerTranslations(locale, "discord");

  if (pending.expiresAt.getTime() <= Date.now()) {
    // An expired code is spent: left lying around it stays guessable for as long as the kid
    // never comes back. deleteMany, so a concurrent redeem does not 500 on P2025.
    await prisma.discordLinkCode.deleteMany({ where: { code } });
    return { ok: false, reason: "unknown_code", reply: t("bot.unknownCode") };
  }

  const existing = await prisma.discordLink.findUnique({ where: { discordId } });
  if (existing && existing.userId !== pending.userId) {
    // Refused, not stolen — and the code survives, so the right kid can still use it.
    return { ok: false, reason: "discord_taken", reply: t("bot.alreadyTaken") };
  }

  // Compare-and-swap, not read-then-write.
  //
  // The code is a bearer credential for ten minutes and it is read aloud off a screen in a loud
  // room. Spending it with a conditional `deleteMany` *inside* the transaction that writes the
  // link means exactly one redemption can win: a shoulder-surfer racing the owner (or a bot
  // retrying an 8s-timed-out call) finds `count === 0` and is refused, instead of both writing
  // and the last one silently taking the binding. The `expiresAt` guard closes the same race
  // against the TTL that the read above can only sample.
  let relinked = false;
  try {
    relinked = await prisma.$transaction(async (tx) => {
      const spent = await tx.discordLinkCode.deleteMany({
        where: { code, userId: pending.userId, expiresAt: { gt: new Date() } },
      });
      if (spent.count === 0) throw new CodeAlreadySpent();

      const previous = await tx.discordLink.findUnique({ where: { userId: pending.userId } });

      await tx.discordLink.upsert({
        where: { userId: pending.userId },
        create: {
          userId: pending.userId,
          discordId,
          discordUsername,
          dmState: "UNKNOWN",
        },
        update: {
          discordId,
          discordUsername,
          // A fresh binding proves nothing about deliverability yet, and a cached DM channel
          // from a previous account is actively wrong.
          dmChannelId: null,
          dmState: "UNKNOWN",
          dmCheckedAt: null,
          dmError: null,
          // Running /koble again is an affirmative ask for DMs. Leaving an old opt-out in
          // place would mean the kid links, sees "koblet", and still never hears anything.
          optOut: false,
        },
      });

      return Boolean(previous && previous.discordId !== discordId);
    });
  } catch (error: any) {
    // Someone else spent this code first. Same answer as any other code we cannot resolve —
    // and nothing was written, because the whole transaction rolled back.
    if (error instanceof CodeAlreadySpent) {
      return { ok: false, reason: "unknown_code", reply: t("bot.unknownCode") };
    }
    // Two kids redeeming against the same snowflake in the same second: the @unique on
    // discordId is the real arbiter, and the loser is refused exactly like the checked case
    // above rather than 500ing at a bot that can only print a string.
    if (error?.code === "P2002") {
      return { ok: false, reason: "discord_taken", reply: t("bot.alreadyTaken") };
    }
    throw error;
  }

  const name = await displayNameFor(pending.userId, pending.user?.name ?? null);

  // The probe is the point of doing this inside Discord: the result is reported in the exact
  // place the real DM would land, so we never hold an address we silently cannot reach.
  const probe = await runProbe({ discordId, locale, body: t("dm.probe.body") }, pending.userId);
  const dmState = dmStateFor(probe.outcome);

  // `dmCheckedAt` is a *check* timestamp, so it is only stamped when Discord was actually
  // asked. Stamping it for a skipped send would make a never-attempted link look freshly
  // verified on every staff screen that sorts or ages by it.
  const attempted = wasDmAttempted(probe.outcome);

  await prisma.discordLink.updateMany({
    where: { userId: pending.userId, discordId },
    data: {
      dmState,
      ...(attempted ? { dmCheckedAt: new Date() } : {}),
      dmError:
        probe.outcome === "SENT" ? null : probe.error || String(probe.discordCode ?? probe.outcome),
      ...(probe.dmChannelId !== undefined ? { dmChannelId: probe.dmChannelId } : {}),
    },
  });

  // One row per attempt: nothing in the UI may claim a kid was reached without one of these,
  // and this row says SENT only when Discord itself accepted the message. `matchId` is null for
  // a probe, and SQLite treats NULLs as distinct in a unique index, so re-probing never
  // collides with the previous attempt.
  await prisma.discordDmAttempt.create({
    data: {
      userId: pending.userId,
      discordId,
      event: "LINK_PROBE",
      outcome: probe.outcome,
      discordCode: probe.discordCode ?? null,
      locale,
    },
  });

  // What the kid is told, and it has to match what happened. "I've sent you a message" is only
  // ever printed off a real SENT; a skipped send says so rather than borrowing the vaguer
  // "couldn't confirm", which would imply we tried.
  const reply =
    dmState === "SENT"
      ? t("bot.linkedReply", { name: escapeDiscordText(name) })
      : dmState === "BLOCKED"
        ? t("bot.linkedReplyBlocked")
        : attempted
          ? t("bot.linkedReplyUnconfirmed")
          : t("bot.linkedReplyDmOff");

  return { ok: true, reply, name, locale, relinked, dmState };
}

export interface OptOutResult {
  ok: boolean;
  reason?: "bad_request" | "not_linked";
  reply: string;
}

/**
 * `/stopp`, or the Stopp DM button. Absolute and immediate: checked at fan-out before any send
 * is attempted. The link itself survives, so turning DMs back on is one `/koble` away.
 */
export async function setOptOutByDiscordId(
  discordIdRaw: unknown,
  optOut = true
): Promise<OptOutResult> {
  const discordId = typeof discordIdRaw === "string" ? discordIdRaw.trim() : "";
  if (!SNOWFLAKE.test(discordId)) {
    const t = await getServerTranslations(userLocale(null), "discord");
    return { ok: false, reason: "bad_request", reply: t("bot.notLinked") };
  }

  const link = await prisma.discordLink.findUnique({
    where: { discordId },
    select: { userId: true, user: { select: { locale: true } } },
  });
  if (!link) {
    const t = await getServerTranslations(userLocale(null), "discord");
    return { ok: false, reason: "not_linked", reply: t("bot.notLinked") };
  }

  const locale = userLocale(link.user?.locale);
  const t = await getServerTranslations(locale, "discord");
  // updateMany: two taps on the button, or a tap racing an unlink, no-op instead of 500ing.
  await prisma.discordLink.updateMany({ where: { discordId }, data: { optOut } });
  return { ok: true, reply: optOut ? t("bot.optedOut") : t("bot.optedIn") };
}

/**
 * Unlink — from the profile card, or from crew on a kid's behalf.
 *
 * `deleteMany` throughout, so a second click (or two admins at once) is a no-op, never a P2025.
 *
 * The `DiscordDmAttempt` rows go too. They exist to stop the product claiming a player was
 * reached, and once the link is gone there is no claim left to back — what remains is a
 * minor's Discord snowflake sitting in a table, which is the one thing the design promised a
 * parent it would not keep. "Unlink" has to mean the snowflake is actually gone. The delivery
 * history that a marshal could still need is the per-match `MATCH_*` rows on the *match*, and
 * those are recreated on the next send; a `LINK_PROBE` row for a link that no longer exists is
 * only personal data.
 */
export async function unlinkUser(userId: string): Promise<{ removed: number }> {
  const [link] = await prisma.$transaction([
    prisma.discordLink.deleteMany({ where: { userId } }),
    prisma.discordLinkCode.deleteMany({ where: { userId } }),
    prisma.discordDmAttempt.deleteMany({ where: { userId } }),
  ]);
  return { removed: link.count };
}
