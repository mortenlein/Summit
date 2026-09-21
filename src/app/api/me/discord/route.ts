import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireSignedInUser } from "@/lib/route-auth";
import { errorResponse } from "@/lib/mutation-guards";
import {
  discordInviteUrl,
  isDiscordLinkConfigured,
  liveLinkCode,
  unlinkUser,
} from "@/lib/discord-link";

// Session-gated + DB per request; never prerender at build time.
export const dynamic = "force-dynamic";

/**
 * GET /api/me/discord — the state of the caller's own Discord link.
 *
 * The link card polls this every few seconds while a code is live, because the redemption
 * happens in a different application entirely: without polling the kid runs `/koble`, tabs back
 * to a page still showing the same code, and concludes it failed.
 *
 * Payload hygiene: `discordId` never leaves the server, for anybody. The username is the
 * caller's own, so it goes back to the caller and nowhere else.
 */
export async function GET() {
  const session = await requireSignedInUser();
  const userId = session?.user?.id as string | undefined;
  if (!userId) {
    return errorResponse("unauthorized", 401);
  }

  const configured = isDiscordLinkConfigured();
  if (!configured) {
    // Deliberately a 200: "this club has no Discord integration" is a state the card renders
    // (as nothing), not a failure it should retry or report.
    return NextResponse.json({ configured: false, linked: false, inviteUrl: "" });
  }

  const link = await prisma.discordLink.findUnique({
    where: { userId },
    select: { discordUsername: true, dmState: true, optOut: true, linkedAt: true },
  });

  // A live code is reported whether or not the account is linked: a player whose DMs were
  // closed the first time recovers by running `/koble` again, and that needs a code.
  const code = await liveLinkCode(userId);

  return NextResponse.json({
    configured: true,
    inviteUrl: discordInviteUrl(),
    linked: Boolean(link),
    username: link?.discordUsername ?? null,
    // SENT means Discord accepted a message. It never means a kid read one.
    dmState: link?.dmState ?? null,
    optOut: link?.optOut ?? false,
    linkedAt: link?.linkedAt ?? null,
    code: code?.code ?? null,
    codeExpiresAt: code?.expiresAt ?? null,
  });
}

/**
 * PATCH /api/me/discord  body: { optOut: boolean }
 *
 * The same switch as the Stopp DM button in Discord, reachable from the app. `updateMany` so a
 * PATCH racing an unlink no-ops instead of 500ing the profile page.
 */
export async function PATCH(request: Request) {
  const session = await requireSignedInUser();
  const userId = session?.user?.id as string | undefined;
  if (!userId) {
    return errorResponse("unauthorized", 401);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (typeof body?.optOut !== "boolean") {
    return NextResponse.json({ error: "optOut must be true or false" }, { status: 400 });
  }

  const result = await prisma.discordLink.updateMany({
    where: { userId },
    data: { optOut: body.optOut },
  });

  return NextResponse.json({ success: true, linked: result.count > 0, optOut: body.optOut });
}

/**
 * DELETE /api/me/discord — unlink, from the app side.
 *
 * `deleteMany`, so a double click (or an organizer unlinking the same row at the same moment)
 * is a no-op rather than a P2025. Any pending code goes with it: a code minted for an account
 * the kid has just disconnected is nothing but a live credential with no purpose.
 */
export async function DELETE() {
  const session = await requireSignedInUser();
  const userId = session?.user?.id as string | undefined;
  if (!userId) {
    return errorResponse("unauthorized", 401);
  }

  const { removed } = await unlinkUser(userId);
  return NextResponse.json({ success: true, removed });
}
