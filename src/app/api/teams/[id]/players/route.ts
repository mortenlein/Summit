import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireStaffApi } from '@/lib/route-auth';
import { buildActorLabel, recordAudit } from '@/lib/audit';
import { resolveSteamId } from '@/lib/steam';
import { lockedResponse } from '@/lib/mutation-guards';
import { linkPlayerToUserBySteamId } from '@/lib/player-identity';

export const dynamic = 'force-dynamic';

const MAX_TEXT = 64;
const MAX_SEATING = 16;

/** Trim + cap a free-text field. `''` normalises to null. */
function cleanText(value: unknown, max = MAX_TEXT) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    return trimmed.slice(0, max);
}

/**
 * Staff add-player: `POST /api/teams/[id]/players`
 * Body: `{ name, nickname?, countryCode?, seating?, steamId?, isLeader? }`
 *
 * Adding a player changes who is eligible to play, so it stays behind the roster lock, and the
 * roster can never exceed `tournament.teamSize`.
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
    const params = await props.params;
    const unauthorized = await requireStaffApi();
    if (unauthorized) return unauthorized;

    try {
        const body = await request.json();
        const team = await prisma.team.findUnique({
            where: { id: params.id },
            include: {
                tournament: { select: { id: true, rosterLocked: true, teamSize: true } },
                _count: { select: { players: true } },
            },
        });

        if (!team) {
            return NextResponse.json({ error: 'Team not found' }, { status: 404 });
        }

        if (team.tournament.rosterLocked) {
            return lockedResponse('roster_locked');
        }

        const name = cleanText(body.name);
        if (!name) {
            return NextResponse.json({ error: 'Player name is required' }, { status: 400 });
        }

        if (team._count.players >= team.tournament.teamSize) {
            return NextResponse.json(
                { error: `${team.name} already has the maximum of ${team.tournament.teamSize} players.` },
                { status: 400 }
            );
        }

        const rawSteamId = cleanText(body.steamId);
        let steamId: string | null = null;
        if (rawSteamId) {
            steamId = await resolveSteamId(rawSteamId);
            if (!steamId) {
                return NextResponse.json({ error: 'Could not resolve that Steam ID or vanity URL' }, { status: 400 });
            }
        }

        const player = await prisma.player.create({
            data: {
                name,
                nickname: cleanText(body.nickname),
                countryCode: cleanText(body.countryCode, 8),
                seating: cleanText(body.seating, MAX_SEATING),
                steamId,
                isLeader: Boolean(body.isLeader),
                teamId: team.id,
                tournamentId: team.tournamentId,
            },
        });

        // Connect the row to its owner's account when we can: every delivery channel keys off
        // Player.userId, so an unlinked player is unreachable by Discord and by alerts.
        await linkPlayerToUserBySteamId(player.id, steamId);

        await recordAudit({
            action: 'player.created',
            entityType: 'player',
            entityId: player.id,
            tournamentId: team.tournamentId,
            summary: `Added ${player.name} to ${team.name}`,
            actor: await buildActorLabel(),
            metadata: { teamId: team.id, seating: player.seating },
        });

        return NextResponse.json(player);
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
