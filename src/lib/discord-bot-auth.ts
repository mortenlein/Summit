import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";

/** Constant-time compare — the key is a 32-byte hex secret, not a password hash. */
function secretsMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The bearer the gateway bot presents on its two callbacks.
 *
 * Fails **closed**: with no `SUMMIT_BOT_KEY` configured these routes are 503, not open — the
 * same posture `CS2_WEBHOOK_KEY` already has. An unset secret must never mean "no check".
 * It must also never be `CS2_WEBHOOK_KEY`: that one is handed to a game server.
 */
export type BotAuthFailure = NextResponse;

export function requireBotKey(request: Request): BotAuthFailure | null {
  const expected = process.env.SUMMIT_BOT_KEY;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "Discord bot integration is not configured", code: "discord_bot_unconfigured" },
      { status: 503 }
    );
  }

  const header = request.headers.get("authorization") || "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!presented || !secretsMatch(presented, expected)) {
    return NextResponse.json({ ok: false, error: "Unauthorized", code: "unauthorized" }, { status: 401 });
  }

  return null;
}
