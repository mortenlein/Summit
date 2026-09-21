import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireAdminApi } from "@/lib/route-auth";
import { buildActorLabel, recordAudit } from "@/lib/audit";
import { unlinkUser } from "@/lib/discord-link";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/discord/link/[userId] — organizer unlink.
 *
 * This route is what makes one sentence of copy true. When a kid runs `/koble` with a Discord
 * account that is already bound to someone else, the bot refuses and says *"Si fra til crewet,
 * så ordner de det"* (`bot.alreadyTaken`). Without a way for crew to actually reach that
 * binding, that line sends a 12-year-old to an adult who can do nothing — so spec §6 requires
 * the unlink to ship in the same step as `/koble`, not later.
 *
 * Admin-only (`requireAdminApi`), not staff: this severs another person's account binding and
 * deletes their delivery history, which is a different weight of action from calling a match.
 * Audited, because "who unlinked this kid" is a question that gets asked afterwards.
 *
 * Payload hygiene (Summit CLAUDE.md rule 2): the response carries no `discordId`. Crew get the
 * username they can recognise on the floor and nothing more; the snowflake stays server-side
 * even here.
 */
export async function DELETE(_request: Request, props: { params: Promise<{ userId: string }> }) {
  const params = await props.params;
  const unauthorized = await requireAdminApi();
  if (unauthorized) return unauthorized;

  const userId = params.userId;
  if (!userId) {
    return NextResponse.json({ error: "Missing user id" }, { status: 400 });
  }

  // Read before deleting, so the audit line names a human rather than a cuid.
  const link = await prisma.discordLink.findUnique({
    where: { userId },
    select: { discordUsername: true, user: { select: { name: true } } },
  });

  if (!link) {
    // Idempotent on purpose: two admins on the same row, or a kid who self-unlinked while crew
    // were walking over, must not turn into a 500 on a staff screen mid-tournament.
    return NextResponse.json({ success: true, removed: 0, alreadyUnlinked: true });
  }

  const { removed } = await unlinkUser(userId);

  await recordAudit({
    action: "discord.unlinked",
    entityType: "user",
    entityId: userId,
    summary: `Unlinked Discord (${link.discordUsername}) from ${link.user?.name ?? userId}`,
    actor: await buildActorLabel(),
  });

  return NextResponse.json({ success: true, removed, username: link.discordUsername });
}
