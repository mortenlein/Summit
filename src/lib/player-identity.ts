import prisma from '@/lib/prisma';

/**
 * Bind a Player row to the User that owns the same steamId.
 *
 * Why this exists: a player an organizer types in by hand had no `userId`, only a `steamId`.
 * Every delivery channel keys off `Player.userId` — so those players could not be DM'd, could
 * not link a Discord account (a link binds a `User`, and no `Player` pointed at it), and got no
 * alerts at all. Only the Steam self-signup path set it.
 *
 * Returns the userId when a match was found, else null. Safe to call when steamId is null.
 */
export async function linkPlayerToUserBySteamId(
  playerId: string,
  steamId: string | null | undefined
): Promise<string | null> {
  if (!steamId) return null;

  const user = await prisma.user.findUnique({ where: { steamId }, select: { id: true } });
  if (!user) return null;

  try {
    await prisma.player.update({ where: { id: playerId }, data: { userId: user.id } });
    return user.id;
  } catch (error: any) {
    // @@unique([tournamentId, userId]) — that user already has a player in this tournament.
    // Leaving the row unlinked is correct and must never fail the organizer's roster edit.
    if (error?.code === 'P2002') return null;
    throw error;
  }
}

/**
 * Back-fill on sign-in: a player typed in before their owner ever logged in gets connected the
 * moment that Steam account appears. Without this, the fix above only helps rosters entered
 * after the player already existed as a User.
 */
export async function backfillPlayersForUser(userId: string, steamId: string | null | undefined) {
  if (!steamId) return 0;

  const orphans = await prisma.player.findMany({
    where: { steamId, userId: null },
    select: { id: true, tournamentId: true },
  });

  let linked = 0;
  for (const orphan of orphans) {
    try {
      await prisma.player.update({ where: { id: orphan.id }, data: { userId } });
      linked += 1;
    } catch (error: any) {
      if (error?.code !== 'P2002') throw error; // already has a player in that tournament
    }
  }
  return linked;
}

/**
 * Same job for a whole team at once — the CSV import and the create-team form both insert
 * players in a nested `create`, so there is no per-row hook to hang the single-row version on.
 */
export async function linkTeamPlayersBySteamId(teamId: string): Promise<number> {
  const players = await prisma.player.findMany({
    where: { teamId, userId: null, steamId: { not: null } },
    select: { id: true, steamId: true },
  });

  let linked = 0;
  for (const player of players) {
    if (await linkPlayerToUserBySteamId(player.id, player.steamId)) linked += 1;
  }
  return linked;
}
