import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireStaffApi } from '@/lib/route-auth';
import { eventBus } from '@/lib/eventBus';
import { buildActorLabel, recordAudit } from '@/lib/audit';
import { notifyMatchReady } from '@/lib/notify';
import { errorResponse } from '@/lib/mutation-guards';
import { isCalled, isDone, isLive } from '@/lib/match-status';

/**
 * POST /api/matches/{id}/load
 *
 * "Start Match" — calls the match (status READY), broadcasts to live views, and notifies both
 * rosters on every channel: web push to each registered player, an in-app NotificationLog entry
 * and the Discord announce (all of that is notifyMatchReady, so this route must not announce
 * separately or Discord gets the same match twice). Staff, because marshals call matches on the
 * floor. Scores are updated by staff, or by inbound CS2/EON telemetry on /api/webhooks/cs2.
 *
 * Idempotent by status, because a marshal in a loud room taps "Kall opp" twice before the board
 * has caught up:
 *
 *   PENDING   → the real call. Reset check-in, broadcast, notify, audit.
 *   READY     → 200, and almost nothing else. Re-broadcast for any client whose stream dropped,
 *               but do NOT reset check-in: by the second tap a marshal may already have walked
 *               the row ticking players in, and wiping that costs them the walk.
 *   LIVE      → 409. The match is being played; rewinding it to READY would flip the overlay
 *               back to CALLED and re-open scoring's door. The marshal board hides the button
 *               here, so this can only be a stale client.
 *   COMPLETED → 409. Un-finishing a match without un-advancing the bracket corrupts it.
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
    const params = await props.params;
    const unauthorized = await requireStaffApi();
    if (unauthorized) return unauthorized;

    try {
        const match = await prisma.match.findUnique({
            where: { id: params.id },
            include: {
                tournament: true,
                homeTeam: { include: { players: true } },
                awayTeam: { include: { players: true } },
            },
        });

        if (!match) {
            return NextResponse.json({ error: 'Match not found' }, { status: 404 });
        }
        if (!match.homeTeam || !match.awayTeam) {
            return errorResponse('both_teams_required', 400);
        }
        if (isLive(match.status)) {
            return errorResponse('match_already_live', 409);
        }
        if (isDone(match.status)) {
            return errorResponse('match_already_complete', 409);
        }

        // Was it already called? Then this is the second tap, not a new call.
        const recall = isCalled(match.status);

        if (!recall) {
            // A first call resets both rosters' at-seat state: check-in is per call, not per
            // player for the whole event, so a marshal never sees a stale tick from an earlier
            // match. On a re-call this must not run — see the status table above.
            await prisma.player.updateMany({
                where: { teamId: { in: [match.homeTeam.id, match.awayTeam.id] } },
                data: { checkedInAt: null },
            });
        }

        const updated = recall
            ? await prisma.match.findUniqueOrThrow({
                  where: { id: params.id },
                  include: {
                      homeTeam: { include: { players: true } },
                      awayTeam: { include: { players: true } },
                  },
              })
            : await prisma.match.update({
                  where: { id: params.id },
                  data: { status: 'READY' },
                  include: {
                      homeTeam: { include: { players: true } },
                      awayTeam: { include: { players: true } },
                  },
              });

        const payload = {
            matchId: updated.id,
            tournamentId: updated.tournamentId,
            match: updated,
        };
        eventBus.emit(`match:${updated.id}`, payload);
        eventBus.emit(`tournament:${updated.tournamentId}`, payload);

        // Push + in-app log + Discord announce, all best-effort inside notifyMatchReady.
        await notifyMatchReady(updated.id, 'READY');

        // A re-call is its own action in the log. Writing `match.loaded` twice would read as two
        // separate calls of the same match, which is exactly what an audit trail must not invent.
        await recordAudit({
            action: recall ? 'match.recalled' : 'match.loaded',
            entityType: 'match',
            entityId: updated.id,
            tournamentId: updated.tournamentId,
            summary: recall
                ? `Re-called match ${updated.id.slice(0, 8)} — already called, nothing reset`
                : `Called match ${updated.id.slice(0, 8)} — both teams notified`,
            actor: await buildActorLabel(),
        });

        return NextResponse.json({
            success: true,
            recall,
            message: recall
                ? 'Match was already called. Nothing was reset.'
                : 'Match called. Both teams were notified — update scores as it plays out.',
            match: updated,
        });
    } catch (error: any) {
        console.error('[Load Match] Error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
