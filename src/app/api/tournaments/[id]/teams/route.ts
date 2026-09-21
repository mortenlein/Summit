import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { resolveSteamId } from '@/lib/steam';
import { requireAdminApi, requireSignedInUser, getUserSession } from '@/lib/route-auth';
import { isStaffSteamId } from '@/lib/admin-config';
import { buildTeamsCsv, parseCsvRows } from '@/lib/csv';
import { buildActorLabel, recordAudit } from '@/lib/audit';
import { linkTeamPlayersBySteamId } from '@/lib/player-identity';
import { errorResponse, lockedResponse } from '@/lib/mutation-guards';

// Reads the session to decide how much of the roster to expose; never prerender.
export const dynamic = 'force-dynamic';

function findTeams(tournamentId: string) {
    return prisma.team.findMany({
        where: { tournamentId },
        select: {
            id: true,
            name: true,
            logoUrl: true,
            inviteCode: true,
            seed: true,
            updatedAt: true,
            players: {
                select: {
                    id: true,
                    name: true,
                    nickname: true,
                    countryCode: true,
                    seating: true,
                    steamId: true,
                    isLeader: true,
                    isOnline: true,
                    userId: true,
                    user: {
                        select: {
                            accounts: {
                                select: {
                                    provider: true
                                }
                            }
                        }
                    }
                }
            }
        },
        orderBy: { seed: 'asc' },
    });
}

type TeamRow = Awaited<ReturnType<typeof findTeams>>[number];

/**
 * Public roster shape: no Steam/user identifiers on any player, and no invite code unless the
 * viewer is on that team (the code is a join credential). Seats, names, nicknames, flags and
 * leader flags stay public — the roster/OBS pages are meant to show them.
 */
function toPublicTeam(team: TeamRow, viewerUserId?: string) {
    const players = team.players.map((player) => ({
        id: player.id,
        name: player.name,
        nickname: player.nickname,
        countryCode: player.countryCode,
        seating: player.seating,
        isLeader: player.isLeader,
        isOnline: player.isOnline,
        isMe: Boolean(viewerUserId && player.userId === viewerUserId),
    }));

    const isMyTeam = players.some((player) => player.isMe);

    return {
        id: team.id,
        name: team.name,
        logoUrl: team.logoUrl,
        seed: team.seed,
        updatedAt: team.updatedAt,
        ...(isMyTeam ? { inviteCode: team.inviteCode } : {}),
        players,
    };
}

export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
    const params = await props.params;
    // Resolve the viewer once: DB user id (for "my team") + staff flag (for the full payload).
    const session = await getUserSession();
    const isStaff = isStaffSteamId((session?.user as any)?.steamId);
    const viewerUserId = (session?.user as any)?.id as string | undefined;

    const format = new URL(request.url).searchParams.get('format');

    // The CSV export carries steamIds for every player — staff only.
    if (format === 'csv' && !isStaff) {
        return errorResponse('unauthorized', 401);
    }

    const teams = await findTeams(params.id);

    if (format === 'csv') {
        return new Response(buildTeamsCsv(teams), {
            headers: {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': `attachment; filename="tournament-${params.id}-teams.csv"`,
            },
        });
    }

    if (isStaff) {
        return NextResponse.json(teams);
    }

    return NextResponse.json(teams.map((team) => toPublicTeam(team, viewerUserId)));
}

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
    const params = await props.params;
    try {
        const body = await request.json();
        const tournament = await prisma.tournament.findUnique({
            where: { id: params.id },
            select: {
                id: true,
                name: true,
                teamSize: true,
                steamSignupEnabled: true,
                rosterLocked: true,
            },
        });

        if (!tournament) {
            return NextResponse.json({ error: 'Tournament not found' }, { status: 404 });
        }

        const adminUnauthorized = await requireAdminApi();
        const isAdminRequest = !adminUnauthorized;
        const userSession = await requireSignedInUser();

        // Anonymous registration is gone: every non-admin write needs a signed-in user, whether or
        // not the tournament uses Steam signup.
        if (!isAdminRequest && !userSession) {
            return errorResponse('signin_required_team', 401);
        }

        if (tournament.rosterLocked) {
            return lockedResponse('roster_locked');
        }

        if (body.mode === 'import') {
            if (!isAdminRequest) {
                return errorResponse('unauthorized', 401);
            }

            const rows = parseCsvRows(String(body.csv || ''));
            if (rows.length === 0) {
                return NextResponse.json({ error: 'Add at least one CSV row to import.' }, { status: 400 });
            }

            const groupedTeams = new Map<string, any[]>();
            for (const row of rows) {
                const teamName = row.teamName.trim();
                if (!teamName) continue;
                if (!groupedTeams.has(teamName)) {
                    groupedTeams.set(teamName, []);
                }
                groupedTeams.get(teamName)!.push(row);
            }

            if (groupedTeams.size === 0) {
                return NextResponse.json({ error: 'CSV must include teamName values.' }, { status: 400 });
            }

            const createdTeams = await prisma.$transaction(async (tx) => {
                const items = [];
                for (const [teamName, rowsForTeam] of groupedTeams.entries()) {
                    const firstRow = rowsForTeam[0];
                    const team = await tx.team.create({
                        data: {
                            name: teamName,
                            seed: firstRow.seed ? Number(firstRow.seed) : null,
                            tournamentId: params.id,
                            logoUrl: `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(teamName)}`,
                            players: {
                                create: rowsForTeam
                                    .filter((row) => row.playerName || row.nickname)
                                    .map((row) => ({
                                        name: row.playerName || row.nickname || 'Player',
                                        nickname: row.nickname || null,
                                        countryCode: row.countryCode || null,
                                        seating: row.seating || null,
                                        steamId: row.steamId || null,
                                        tournamentId: params.id,
                                        isLeader: String(row.isLeader).toLowerCase() === 'true',
                                    })),
                            },
                        },
                    });
                    items.push(team);
                }
                return items;
            });

            // Connect imported players to their accounts where the steamId matches — otherwise
            // an imported roster is unreachable by Discord and by alerts (Player.userId is the key).
            for (const team of createdTeams) {
                await linkTeamPlayersBySteamId(team.id);
            }

            await recordAudit({
                action: 'team.imported',
                entityType: 'tournament',
                entityId: params.id,
                tournamentId: params.id,
                summary: `Imported ${createdTeams.length} teams into ${tournament.name}`,
                actor: await buildActorLabel(),
                metadata: { teamCount: createdTeams.length },
            });

            return NextResponse.json({ success: true, count: createdTeams.length });
        }

        const { name, logoUrl, seed, players } = body;
        const trimmedName = typeof name === 'string' ? name.trim() : '';
        if (!trimmedName) {
            return NextResponse.json({ error: 'Team name is required' }, { status: 400 });
        }

        let finalLogoUrl = logoUrl;
        if (!finalLogoUrl || finalLogoUrl.trim() === '') {
            finalLogoUrl = `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(trimmedName)}`;
        }

        const resolvedPlayers = await Promise.all(
            Array.isArray(players) ? players.map(async (p: any) => ({
                name: p.name,
                nickname: p.nickname || null,
                countryCode: p.countryCode || null,
                seating: p.seating || null,
                steamId: p.steamId ? await resolveSteamId(p.steamId) : null,
                tournamentId: params.id,
            })) : []
        );

        if (!isAdminRequest && resolvedPlayers.length < tournament.teamSize) {
            return NextResponse.json(
                { error: `This tournament requires ${tournament.teamSize} players per team` },
                { status: 400 }
            );
        }

        const team = await prisma.team.create({
            data: {
                name: trimmedName,
                logoUrl: finalLogoUrl,
                seed: seed ? parseInt(seed) : null,
                tournamentId: params.id,
                players: {
                    create: resolvedPlayers
                }
            },
        });

        await linkTeamPlayersBySteamId(team.id);

        await recordAudit({
            action: 'team.created',
            entityType: 'team',
            entityId: team.id,
            tournamentId: params.id,
            summary: `Added team ${team.name}`,
            actor: isAdminRequest ? await buildActorLabel() : userSession?.user?.name || 'Signed-in player',
            metadata: {
                playerCount: resolvedPlayers.length,
            },
        });

        return NextResponse.json(team);
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
