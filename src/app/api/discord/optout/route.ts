import { NextResponse } from "next/server";
import { requireBotKey } from "@/lib/discord-bot-auth";
import { setOptOutByDiscordId } from "@/lib/discord-link";

export const dynamic = "force-dynamic";

/**
 * POST /api/discord/optout — the Stopp DM button and `/stopp`, called BY the bot.
 *
 * Body `{ discordId, optOut? }`. Opting out is absolute and is checked at fan-out before any
 * send is attempted; the link itself survives, so a kid who changes their mind is one `/koble`
 * away from DMs again. Like the link route, a refusal is a 200 with `ok: false` and a string
 * the bot can print.
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

  const optOut = typeof body?.optOut === "boolean" ? body.optOut : true;
  const result = await setOptOutByDiscordId(body?.discordId, optOut);
  return NextResponse.json(result);
}
