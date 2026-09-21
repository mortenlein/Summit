import { NextResponse } from "next/server";
import { requireSignedInUser } from "@/lib/route-auth";
import { errorResponse } from "@/lib/mutation-guards";
import { isDiscordLinkConfigured, issueLinkCode } from "@/lib/discord-link";

export const dynamic = "force-dynamic";

/**
 * POST /api/me/discord/code — mint (or replace) the caller's `/koble` code.
 *
 * One live code per user, enforced by the `@unique` on `DiscordLinkCode.userId`: a second call
 * upserts rather than erroring, because "I lost the tab, give me another" is the common case,
 * not an attack. The old code stops working the moment the new one is written.
 */
export async function POST() {
  const session = await requireSignedInUser();
  const userId = session?.user?.id as string | undefined;
  if (!userId) {
    return errorResponse("unauthorized", 401);
  }

  if (!isDiscordLinkConfigured()) {
    return NextResponse.json(
      { error: "Discord linking is not configured", code: "discord_link_unconfigured" },
      { status: 503 }
    );
  }

  // Deliberately allowed while already linked. "Koblet! Men jeg får ikke sendt deg DM … kjør
  // /koble på nytt" is the whole recovery path for a kid whose DMs were closed, and running it
  // again needs a code. Refusing here would make that sentence a dead end.
  const { code, expiresAt } = await issueLinkCode(userId);
  return NextResponse.json({ code, expiresAt });
}
