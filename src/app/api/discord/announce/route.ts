import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { announceMatch, announceResult } from '@/lib/discord';
import { requireAdminApi } from '@/lib/route-auth';
import { buildActorLabel, recordAudit } from '@/lib/audit';

export async function POST(req: Request) {
    const unauthorized = await requireAdminApi();
    if (unauthorized) return unauthorized;

    try {
        const { matchId, tournamentId, type } = await req.json();

        if (!matchId || !tournamentId || !type) {
            return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
        }

        const tournament = await prisma.tournament.findUnique({
            where: { id: tournamentId }
        });

        const match = await prisma.match.findUnique({
            where: { id: matchId },
            include: {
                homeTeam: {
                    include: { players: true }
                },
                awayTeam: {
                    include: { players: true }
                }
            }
        });

        if (!tournament || !match) {
            return NextResponse.json({ error: 'Tournament or match not found' }, { status: 404 });
        }

        const matchUrl = `${process.env.NEXTAUTH_URL}/tournaments/${tournamentId}`;

        if (type === 'START') {
            // Names only — never `(seating)`. A Discord channel is readable by everyone in the
            // server (and screenshot-able out of it), and this embed named 12-year-olds next to
            // their real-time physical location in the hall. A seat is a private instruction to
            // the one player it belongs to; it goes in that player's DM and nowhere else.
            const homePlayers = (match.homeTeam?.players || []).map(p => p.nickname || p.name).join(', ');
            const awayPlayers = (match.awayTeam?.players || []).map(p => p.nickname || p.name).join(', ');

            await announceMatch({
                homeTeam: match.homeTeam?.name || 'TBD',
                awayTeam: match.awayTeam?.name || 'TBD',
                homePlayers,
                awayPlayers,
                round: match.round,
                tournamentName: tournament.name,
                tournamentId,
                matchUrl: matchUrl,
                game: tournament.game,
                seatingInfo: true // Flag for Strategy 3 formatting
            });
        } else if (type === 'RESULT') {
            await announceResult({
                homeTeam: match.homeTeam?.name || 'TBD',
                awayTeam: match.awayTeam?.name || 'TBD',
                homeScore: match.homeScore,
                awayScore: match.awayScore,
                tournamentName: tournament.name,
                tournamentId,
                matchUrl: matchUrl,
                game: tournament.game
            });
        } else {
            return NextResponse.json({ error: 'Invalid announcement type' }, { status: 400 });
        }

        await recordAudit({
            action: 'announcement.sent',
            entityType: 'match',
            entityId: matchId,
            tournamentId,
            summary: `Sent ${type.toLowerCase()} announcement for match ${matchId.slice(0, 8)}`,
            actor: await buildActorLabel(),
        });

        return NextResponse.json({ success: true });
    } catch (error: any) {
        console.error('Discord announcement error:', error);
        return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
    }
}
