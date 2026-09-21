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
 * Configured = the bot can actually reach us AND a kid who is not in the guild has somewhere
 * to go. Mirrors `isPushConfigured()`: the UI self-hides instead of offering a dead end, so
 * this deploys safely before the bot container exists.
 */
export function isDiscordLinkConfigured(): boolean {
  return Boolean(
    process.env.SUMMIT_BOT_KEY && process.env.DISCORD_GUILD_ID && process.env.DISCORD_INVITE_URL
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
// The DM probe seam
//
// Linking proves an address; only a message proves we can *use* it. The probe is deliberately
// injectable: there is no Discord token in this repo yet, so the default is the same mock
// posture the channel announcer already has (log, don't send), and a test can assert what
// WOULD have been sent — including a failure code — without a network.
//
// The real sender lives in the DM module and registers itself here. This file never builds a
// REST client of its own.
// ---------------------------------------------------------------------------------------

// One vocabulary, defined once in discord-dm.ts. A second copy here is how the two halves of
// this feature drifted the first time: the sender grew a MOCKED outcome that the linking half
// could not express, so the linking half kept saying SENT. (No cycle — discord-dm does not
// import this module.)
export type { DmOutcome } from "@/lib/discord-dm";
import type { DmOutcome } from "@/lib/discord-dm";

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

let probeImpl: DmProbe | null = null;

/** Register the real sender (or a test double). Returns the previous one, so a caller can restore it. */
export function setDiscordDmProbe(probe: DmProbe | null): DmProbe | null {
  const previous = probeImpl;
  probeImpl = probe;
  return previous;
}

/** True while no real token is configured — the `[STRATEGY 3 MOCK]` posture, for DMs. */
export function isDiscordDmMocked(): boolean {
  // Explicit flag ONLY, matching discord.ts. Inferring "mock" from a missing token meant a
  // forgotten DISCORD_BOT_TOKEN in the app's .env silently turned every probe into a
  // fabricated success — the exact failure this module is supposed to make impossible.
  return process.env.NEXT_PUBLIC_STRATEGY_3_MOCK === "true";
}

/**
 * Mock-only: snowflakes the mock probe refuses with 50007 ("Cannot send messages to this
 * user"), so the *failure* half of linking — the half that decides whether a marshal walks —
 * is verifiable with no Discord token in the repo. Comma-separated, unset in production, and
 * unreachable once a real sender is registered.
 */
function mockBlockedIds(): Set<string> {
  return new Set(
    (process.env.DISCORD_DM_MOCK_BLOCKED || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

const mockProbe: DmProbe = async ({ discordId, locale, body }) => {
  if (mockBlockedIds().has(discordId)) {
    console.log(`[DISCORD DM MOCK] ✗ ${discordId} (${locale}): 50007 cannot send messages to this user`);
    return { outcome: "BLOCKED", discordCode: 50007 };
  }
  console.log(`[DISCORD DM MOCK] → ${discordId} (${locale}): ${body}`);
  // NOT "SENT". Discord was never contacted, so the link stays unconfirmed and the reach panel
  // keeps counting this player as someone a marshal may still have to walk to.
  return { outcome: "MOCKED" };
};

async function runProbe(request: DmProbeRequest): Promise<DmProbeResult> {
  const probe = probeImpl ?? (isDiscordDmMocked() ? mockProbe : null);
  if (!probe) {
    // Configured for real delivery, but nothing has registered a sender. Saying SENT here is
    // the exact lie this feature exists to prevent, so the link stands and the DM does not.
    return { outcome: "ERROR", error: "no_dm_sender_registered" };
  }
  try {
    return await probe(request);
  } catch (error: any) {
    return { outcome: "ERROR", error: String(error?.message || error) };
  }
}

/** `dmState` is UNKNOWN | SENT | BLOCKED — three states, because the remedies differ. */
function dmStateFor(outcome: DmOutcome): "UNKNOWN" | "SENT" | "BLOCKED" {
  if (outcome === "SENT") return "SENT";
  if (outcome === "BLOCKED" || outcome === "UNKNOWN_USER") return "BLOCKED";
  return "UNKNOWN";
}

// ---------------------------------------------------------------------------------------
// Redemption
// ---------------------------------------------------------------------------------------

export type LinkFailure = "bad_request" | "unknown_code" | "discord_taken";

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
  const discordUsername =
    typeof input.discordUsername === "string" && input.discordUsername.trim()
      ? input.discordUsername.trim().slice(0, USERNAME_MAX)
      : "";

  if (!SNOWFLAKE.test(discordId)) {
    const t = await getServerTranslations(userLocale(null), "discord");
    return { ok: false, reason: "bad_request", reply: t("bot.noCode") };
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

  const previous = await prisma.discordLink.findUnique({ where: { userId: pending.userId } });
  const relinked = Boolean(previous && previous.discordId !== discordId);

  // One transaction: the code is spent exactly when the link is written, so a crash between
  // the two cannot leave a live code for an account that is already bound.
  try {
    await prisma.$transaction([
      prisma.discordLink.upsert({
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
      }),
      prisma.discordLinkCode.deleteMany({ where: { code } }),
    ]);
  } catch (error: any) {
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
  const probe = await runProbe({ discordId, locale, body: t("dm.probe.body") });
  const dmState = dmStateFor(probe.outcome);

  await prisma.discordLink.updateMany({
    where: { userId: pending.userId },
    data: {
      dmState,
      dmCheckedAt: new Date(),
      // MOCKED is not a failure — it is "no transport was configured, so nothing was tried".
      // Writing it here would put a non-error in the column the crew reads when a kid says
      // the DM never came.
      dmError:
        probe.outcome === "SENT" || probe.outcome === "MOCKED"
          ? null
          : probe.error || String(probe.discordCode ?? probe.outcome),
      ...(probe.dmChannelId !== undefined ? { dmChannelId: probe.dmChannelId } : {}),
    },
  });

  // One row per attempt: nothing in the UI may claim a kid was reached without one of these.
  // `matchId` is null for a probe, and SQLite treats NULLs as distinct in a unique index, so
  // re-probing never collides with the previous attempt.
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

  // Every branch names the kid. The one thing this reply exists to answer is "which Summit
  // player did I just become?", and that answer cannot depend on whether the DM landed —
  // least of all now, when an unconfigured bot takes the unconfirmed branch every time.
  const who = escapeDiscordText(name);
  const reply =
    dmState === "SENT"
      ? t("bot.linkedReply", { name: who })
      : dmState === "BLOCKED"
        ? t("bot.linkedReplyBlocked", { name: who })
        : t("bot.linkedReplyUnconfirmed", { name: who });

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

/** Self-unlink from the app side. `deleteMany` so a second click is a no-op, never a P2025. */
export async function unlinkUser(userId: string): Promise<{ removed: number }> {
  const [link] = await prisma.$transaction([
    prisma.discordLink.deleteMany({ where: { userId } }),
    prisma.discordLinkCode.deleteMany({ where: { userId } }),
  ]);
  return { removed: link.count };
}
