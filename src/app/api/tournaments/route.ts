import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { SUPPORTED_GAMES, coerceLastRounds, isTournamentFormat } from '@/lib/games';
import { requireAdminApi } from '@/lib/route-auth';
import { getTournamentStage } from '@/lib/tournament-stage';
import { buildActorLabel, recordAudit } from '@/lib/audit';

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const cursor = searchParams.get('cursor');
    const limitParam = searchParams.get('limit') || '10';
    const fetchAll = limitParam === 'all';
    const limit = fetchAll ? undefined : parseInt(limitParam, 10);

    // `teams`/`matches` are selected down to the two columns `getTournamentStage` reads (an id
    // and a status) purely so the stage can be derived here — they are stripped from the
    // response below, so the directory payload stays a list of cards, not a bracket dump.
    const rows = await prisma.tournament.findMany({
        take: limit,
        skip: cursor ? 1 : 0,
        cursor: cursor && !fetchAll ? { id: cursor } : undefined,
        select: {
            id: true,
            name: true,
            game: true,
            category: true,
            format: true,
            teamSize: true,
            createdAt: true,
            updatedAt: true,
            rosterLocked: true,
            steamSignupEnabled: true,
            teams: { select: { id: true } },
            matches: { select: { status: true } },
            _count: {
                select: { teams: true, matches: true }
            }
        },
        orderBy: { createdAt: 'desc' },
    });

    const tournaments = rows.map(({ teams, matches, ...tournament }) => ({
        ...tournament,
        stage: getTournamentStage(teams, matches, tournament.steamSignupEnabled),
    }));

    const nextCursor = !fetchAll && limit && tournaments.length === limit ? tournaments[tournaments.length - 1].id : null;

    return NextResponse.json({
        tournaments,
        nextCursor,
    });
}

export async function POST(request: Request) {
    const unauthorized = await requireAdminApi();
    if (unauthorized) return unauthorized;

    try {
        const data = await request.json();
        const name = typeof data.name === 'string' ? data.name.trim() : '';
        if (!name) {
            return NextResponse.json({ error: 'Tournament name is required' }, { status: 400 });
        }

        const game = typeof data.game === 'string' ? data.game : 'CS2';
        const format = data.format === undefined ? 'SINGLE_ELIMINATION' : data.format;
        const teamSize = Number.parseInt(String(data.teamSize ?? '5'), 10);
        // The wizard sends strings, and '0' means "off" — parse first, then treat 0/NaN as null.
        const bo3LastRounds = coerceLastRounds(data.bo3LastRounds);
        const bo5LastRounds = coerceLastRounds(data.bo5LastRounds);
        const hasThirdPlace = Boolean(data.hasThirdPlace);
        // Players self-register via Steam by default (anonymous registration no longer exists);
        // organizers can switch a tournament to manual rosters in Settings.
        const steamSignupEnabled = typeof data.steamSignupEnabled === 'boolean' ? data.steamSignupEnabled : true;
        const gameMeta = SUPPORTED_GAMES.find(g => g.id === game);

        if (!gameMeta) {
            return NextResponse.json({ error: 'Unsupported game' }, { status: 400 });
        }

        if (!isTournamentFormat(format)) {
            return NextResponse.json(
                { error: 'Format must be SINGLE_ELIMINATION or DOUBLE_ELIMINATION' },
                { status: 400 }
            );
        }

        if (!gameMeta.teamSize.includes(teamSize)) {
            return NextResponse.json({ error: 'Unsupported team size for this game' }, { status: 400 });
        }

        const category = gameMeta?.category || 'BRACKET';

        const tournament = await prisma.tournament.create({
            data: {
                name,
                game,
                category,
                type: typeof data.type === 'string' && data.type.trim() ? data.type.trim() : format,
                format,
                teamSize,
                bo3LastRounds,
                bo5LastRounds,
                hasThirdPlace,
                steamSignupEnabled,
            },
        });

        await recordAudit({
            action: 'tournament.created',
            entityType: 'tournament',
            entityId: tournament.id,
            tournamentId: tournament.id,
            summary: `Created tournament ${tournament.name}`,
            actor: await buildActorLabel(),
            metadata: {
                game: tournament.game,
                format: tournament.format,
                teamSize: tournament.teamSize,
            },
        });

        return NextResponse.json(tournament);
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
