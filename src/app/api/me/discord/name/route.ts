import { NextResponse } from "next/server";
import { requireSignedInUser } from "@/lib/route-auth";
import { errorResponse } from "@/lib/mutation-guards";
import { isDiscordLinkConfigured, linkDiscordByName } from "@/lib/discord-link";

export const dynamic = "force-dynamic";

/**
 * POST /api/me/discord/name — link the caller's Discord by the name they typed.
 *
 * The one-step alternative to `/koble`. A player writes their Discord name into the form they
 * are already filling in, Summit resolves it against the club's own server, and the bot sends
 * the same confirmation DM the slash command would have. Self-service only: the session decides
 * whose link this is, so nobody can bind an account to somebody else from here.
 *
 * Payload hygiene (Summit CLAUDE.md rule 2): the response carries the username Discord returned
 * and the delivery state. The snowflake stays server-side, here as everywhere.
 */
export async function POST(request: Request) {
  const session = await requireSignedInUser();
  const userId = session?.user?.id as string | undefined;
  if (!userId) return errorResponse("unauthorized", 401);

  if (!isDiscordLinkConfigured()) {
    return NextResponse.json({ ok: false, reason: "not_configured" }, { status: 503 });
  }

  let name = "";
  try {
    name = String(((await request.json()) as any)?.name ?? "");
  } catch {
    return NextResponse.json({ ok: false, reason: "empty" }, { status: 400 });
  }

  const result = await linkDiscordByName({ userId, name });

  // A name that matched nobody, or more than one person, is the player's to correct — 200 with
  // a reason the card renders, not a 4xx the form treats as a crash. `discord_taken` is the one
  // a kid cannot fix alone, and its copy sends them to the crew.
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}
