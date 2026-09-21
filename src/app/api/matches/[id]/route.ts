import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { announceResult } from '@/lib/discord';
import { requireStaffApi } from '@/lib/route-auth';
import { eventBus } from '@/lib/eventBus';
import { buildActorLabel, recordAudit } from '@/lib/audit';
import { announceUpcomingMatch, notifyMatchReady } from '@/lib/notify';
import { codeForText } from '@/lib/api-errors';
import { conflictResponse, errorResponse, hasTimestampConflict, normalizeExpectedUpdatedAt } from '@/lib/mutation-guards';
import { isDone } from '@/lib/match-status';
import { decideMatchResult, downstreamBlocksReset } from '@/lib/match-result';

/**
 * POST /api/matches/{id} — score / status / forfeit update. Staff (admin or marshal), because
 * marshals run matches on the floor.
 *
 * Body: { homeScore?, awayScore?, mapScores?, bestOf?, status?, forfeit?, expectedUpdatedAt? }
 * `scoreLimit` is NOT accepted — it is always derived from bestOf (first to floor(bestOf/2)+1).
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
    const params = await props.params;
    const unauthorized = await requireStaffApi();
    if (unauthorized) return unauthorized;

    try {
        const body = await request.json();
        const { homeScore, awayScore, mapScores, bestOf, status: manualStatus, forfeit } = body;

        const match = await prisma.match.findUnique({
            where: { id: params.id },
            include: {
                homeTeam: true,
                awayTeam: true,
                tournament: true
            }
        });

        if (!match) return NextResponse.json({ error: 'Match not found' }, { status: 404 });

        const expectedUpdatedAt = normalizeExpectedUpdatedAt(body.expectedUpdatedAt);
        if (hasTimestampConflict(match.updatedAt, expectedUpdatedAt)) {
            return conflictResponse();
        }

        const decision = decideMatchResult(match, {
            homeScore,
            awayScore,
            bestOf,
            status: manualStatus,
            forfeit,
        });

        if (!decision.ok) {
            // `decideMatchResult` is pure decision logic shared with a bare ts-node script, so it
            // returns a sentence rather than a code; the code is looked up from it here.
            const code = codeForText(decision.error);
            return code
                ? errorResponse(code, decision.status)
                : NextResponse.json({ error: decision.error }, { status: decision.status });
        }

        const plan = decision.plan;

        // A previous result is being rolled back: refuse the whole update if a downstream match
        // has already been started, so a team is never pulled out of a live/played game.
        for (const step of plan.unadvance) {
            const downstream = await prisma.match.findUnique({
                where: { id: step.matchId },
                select: { id: true, status: true, homeScore: true, awayScore: true, homeTeamId: true, awayTeamId: true },
            });
            if (!downstream) continue;

            const holdsTeam = step.slot === 'HOME'
                ? downstream.homeTeamId === step.teamId
                : downstream.awayTeamId === step.teamId;
            if (!holdsTeam) continue;

            if (downstreamBlocksReset(downstream)) {
                return errorResponse('downstream_started', 409, { matchRef: downstream.id.slice(0, 8) });
            }
        }

        const broadcastMatch = async (matchId: string) => {
            const fullMatch = await prisma.match.findUnique({
                where: { id: matchId },
                include: {
                    homeTeam: { include: { players: true } },
                    awayTeam: { include: { players: true } },
                },
            });

            if (!fullMatch) {
                return;
            }

            const payload = {
                matchId: fullMatch.id,
                tournamentId: fullMatch.tournamentId,
                match: fullMatch,
            };
            eventBus.emit('telemetry', payload);
            eventBus.emit(`match:${fullMatch.id}`, payload);
            eventBus.emit(`tournament:${fullMatch.tournamentId}`, payload);
        };

        // Empty the downstream slot the old winner/loser was advanced into — but only if it
        // still holds them, in case staff re-seeded it by hand.
        const clearSlot = async (matchId: string, slot: 'HOME' | 'AWAY', teamId: string) => {
            const cleared = await prisma.match.updateMany({
                where: { id: matchId, ...(slot === 'HOME' ? { homeTeamId: teamId } : { awayTeamId: teamId }) },
                data: slot === 'HOME' ? { homeTeamId: null } : { awayTeamId: null },
            });
            if (cleared.count > 0) {
                await broadcastMatch(matchId);
            }
        };

        for (const step of plan.unadvance) {
            await clearSlot(step.matchId, step.slot, step.teamId);
        }

        // Update current match
        const updatedMatch = await prisma.match.update({
            where: { id: params.id },
            data: {
                homeScore: plan.homeScore,
                awayScore: plan.awayScore,
                ...(mapScores !== undefined && { mapScores: typeof mapScores === 'string' ? mapScores : JSON.stringify(mapScores) }),
                bestOf: plan.bestOf,
                scoreLimit: plan.scoreLimit,
                winnerId: plan.winnerId,
                resultType: plan.resultType,
                status: plan.status
            }
        });

        // Announce result to Discord if just completed
        if (isDone(plan.status) && !isDone(match.status) && match.homeTeam && match.awayTeam) {
            await announceResult({
                homeTeam: match.homeTeam.name,
                awayTeam: match.awayTeam.name,
                homeScore: plan.homeScore,
                awayScore: plan.awayScore,
                tournamentName: match.tournament.name,
                tournamentId: match.tournamentId,
                matchUrl: `${process.env.NEXTAUTH_URL}/tournaments/${match.tournamentId}`,
                game: match.tournament.game
            });
        }

        const handleAdvance = async (nextMatchId: string, advancedTeamId: string, isNextHome: boolean) => {
            const existingNextMatch = await prisma.match.findUnique({
                where: { id: nextMatchId },
                select: {
                    homeTeamId: true,
                    awayTeamId: true,
                },
            });

            if (!existingNextMatch) {
                return null;
            }

            const nextMatch = await prisma.match.update({
                where: { id: nextMatchId },
                data: {
                    ...(isNextHome ? { homeTeamId: advancedTeamId } : { awayTeamId: advancedTeamId })
                },
                include: { homeTeam: true, awayTeam: true, tournament: true }
            });

            // A downstream match acquiring its second team used to post `announceMatch` here —
            // i.e. "Match ready for players", the green call-up, for a match nobody has called.
            // That is what taught the channel to ignore call-ups. The honest version of this
            // moment is the grey "up next" post, and it is decided once per tournament event by
            // `announceUpcomingMatch` below, which also knows whether this match is actually
            // next in play order (with parallel rounds, it often is not).

            const payload = {
                matchId: nextMatch.id,
                tournamentId: nextMatch.tournamentId,
                match: nextMatch,
            };
            eventBus.emit('telemetry', payload);
            eventBus.emit(`match:${nextMatch.id}`, payload);
            eventBus.emit(`tournament:${nextMatch.tournamentId}`, payload);
        };

        for (const step of plan.advance) {
            await handleAdvance(step.matchId, step.teamId, step.slot === 'HOME');
        }

        // A finished match moves the front of the running order, and the winner it just advanced
        // may have handed the next match its second team. Either way, what is "up next" has
        // changed — `announceUpcomingMatch` decides whether that is worth a post (owner ask #1)
        // and guarantees it happens at most once per match.
        if (isDone(plan.status) && !isDone(match.status)) {
            await announceUpcomingMatch(updatedMatch.tournamentId);
        }

        // A finished match releases its players: clear their at-seat stamps so the next call
        // starts from "not found yet" on every marshal's board.
        if (isDone(plan.status) && !isDone(match.status)) {
            const teamIds = [match.homeTeamId, match.awayTeamId].filter((id): id is string => Boolean(id));
            if (teamIds.length > 0) {
                await prisma.player.updateMany({ where: { teamId: { in: teamIds } }, data: { checkedInAt: null } });
            }
        }

        await broadcastMatch(updatedMatch.id);

        // Notify both teams when a match becomes ready/live (web push + in-app log).
        const wasJustActivated = (plan.status === 'LIVE' || plan.status === 'READY') && match.status !== plan.status;
        if (wasJustActivated) {
            await notifyMatchReady(updatedMatch.id, plan.status);
        }

        const forfeitNote = plan.resultType === 'FORFEIT' ? ' by forfeit' : '';
        await recordAudit({
            action: 'match.updated',
            entityType: 'match',
            entityId: updatedMatch.id,
            tournamentId: updatedMatch.tournamentId,
            summary: `Updated match ${updatedMatch.id.slice(0, 8)} to ${updatedMatch.homeScore}:${updatedMatch.awayScore} (${updatedMatch.status})${forfeitNote}`,
            actor: await buildActorLabel(),
            metadata: {
                homeScore: updatedMatch.homeScore,
                awayScore: updatedMatch.awayScore,
                status: updatedMatch.status,
                bestOf: updatedMatch.bestOf,
                scoreLimit: updatedMatch.scoreLimit,
                winnerId: updatedMatch.winnerId,
                resultType: updatedMatch.resultType,
                unadvanced: plan.unadvance.map((step) => `${step.matchId.slice(0, 8)}:${step.slot}`),
            },
        });

        return NextResponse.json(updatedMatch);
    } catch (error: any) {
        console.error('Match Update Logic Failure:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
