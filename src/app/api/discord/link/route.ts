import { NextResponse } from "next/server";
import { requireBotKey } from "@/lib/discord-bot-auth";
import { redeemLinkCode } from "@/lib/discord-link";

export const dynamic = "force-dynamic";

/**
 * POST /api/discord/link — called BY the gateway bot, never by a browser.
 *
 * Body `{ code, discordId, discordUsername }`, `Authorization: Bearer $SUMMIT_BOT_KEY`, over
 * the compose network (`http://summit:4001`). The bot holds no database, no i18n and no send
 * path: it posts what the kid typed and prints the `reply` this route composes, in that kid's
 * own language.
 *
 * A refusal is a **200 with `ok: false`**, not a 4xx. The only caller is the bot, and the only
 * thing it can do with either is show the string — a non-2xx would make it fall back to its
 * hardcoded English "Summit is unreachable", which is wrong: Summit answered.
 */
export async function POST(request: Request) {
  const denied = requireBotKey(request);
  if (denied) return denied;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  const result = await redeemLinkCode({
    code: body?.code,
    discordId: body?.discordId,
    discordUsername: body?.discordUsername,
  });

  return NextResponse.json(result);
}
