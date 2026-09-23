import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { v4 as uuidv4 } from 'uuid';
import { announceSignup } from '@/lib/discord';
import { requireSignedInUser } from '@/lib/route-auth';
import { recordAudit } from '@/lib/audit';
import { codeForText } from '@/lib/api-errors';
import { errorResponse } from '@/lib/mutation-guards';
import { isDiscordLinkConfigured, linkDiscordByName } from '@/lib/discord-link';

/**
 * Bind the Discord name a player typed on the registration form.
 *
 * Deliberately best-effort and deliberately last. Registration is the thing that must succeed:
 * a kid who mistypes their Discord name, or whose account this bot cannot see, is still on the
 * roster and still gets called by a human. The result rides back on the response so the form
 * can say what happened instead of pretending it worked.
 */
async function bindDiscordName(userId: string, name: string | null) {
    if (!name || !isDiscordLinkConfigured()) return null;
    try {
        return await linkDiscordByName({ userId, name });
    } catch (error) {
        console.warn('[Signup] Discord name binding failed:', error);
        return { ok: false, reason: 'lookup_failed' as const };
    }
}

export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
    const params = await props.params;
    const session = await requireSignedInUser();
    if (!session || !session.user) {
        return errorResponse('unauthorized', 401);
    }

    const { id: tournamentId } = params;

    // Fetch tournament to get its name
    const tournament = await prisma.tournament.findUnique({
        where: { id: tournamentId },
        select: {
            id: true,
            name: true,
            steamSignupEnabled: true,
            rosterLocked: true,
            teamSize: true,
        },
    });

    if (!tournament) {
        return NextResponse.json({ error: 'Tournament not found' }, { status: 404 });
    }
    if (!tournament.steamSignupEnabled) {
        return errorResponse('signups_disabled', 403);
    }
    if (tournament.rosterLocked) {
        return errorResponse('registration_locked', 423);
    }

    const body = await request.json();
    const { action, teamName, logoUrl, inviteCode } = body;

    // Optional LAN seat label the player types at registration ("B12"). Marshals use it to find
    // people on the floor; it stays editable afterwards via PATCH /api/me/player.
    const seating = typeof body?.seating === 'string' && body.seating.trim()
        ? body.seating.trim().slice(0, 16)
        : null;

    // Optional Discord name, typed in the same form. Resolved and bound AFTER the roster write
    // below — a name Discord does not recognise must never cost a kid their registration.
    const discordName = typeof body?.discordUsername === 'string' && body.discordUsername.trim()
        ? body.discordUsername.trim().slice(0, 64)
        : null;

    const sessionSteamId = ((session.user as any)?.steamId as string | undefined)?.trim();
    let user = await prisma.user.findUnique({
        where: { id: session.user.id },
    });

    if (!user && sessionSteamId) {
        user = await prisma.user.findUnique({
            where: { steamId: sessionSteamId },
        });
    }

    if (user && !user.steamId && sessionSteamId) {
        user = await prisma.user.update({
            where: { id: user.id },
            data: { steamId: sessionSteamId },
        });
    }

    if (!user || !user.steamId) {
        return errorResponse('steam_signin_required', 400);
    }

    try {
        if (action === 'CREATE_TEAM') {
            const trimmedTeamName = typeof teamName === "string" ? teamName.trim() : "";
            if (!trimmedTeamName) {
                return errorResponse('team_name_required', 400);
            }

            const team = await prisma.$transaction(async (tx) => {
                const existingPlayer = await tx.player.findFirst({
                    where: {
                        tournamentId,
                        userId: user.id,
                    },
                });

                if (existingPlayer) {
                    throw new Error('You are already registered for this tournament');
                }

                return tx.team.create({
                    data: {
                        name: trimmedTeamName,
                        // Same default as the organizer-side team route: a generated initials
                        // mark when nobody uploaded one. Self-signup skipped this, so a null
                        // logoUrl reached the bracket and the OBS overlay — and the register
                        // form no longer puts the upload in a kid's path, so the skip rate is
                        // about to be most of them.
                        logoUrl:
                            typeof logoUrl === 'string' && logoUrl.trim() !== ''
                                ? logoUrl
                                : `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(trimmedTeamName)}`,
                        tournamentId,
                        inviteCode: uuidv4().slice(0, 8),
                        players: {
                            create: {
                                name: session.user.name || 'Unknown',
                                steamId: user.steamId,
                                isLeader: true,
                                userId: user.id,
                                tournamentId,
                                seating,
                            }
                        }
                    },
                    include: {
                        players: true,
                    },
                });
            });

            await announceSignup({
                playerName: session.user.name || 'Unknown',
                teamName: team.name,
                tournamentName: tournament.name,
                tournamentId,
            });

            await recordAudit({
                action: 'signup.created_team',
                entityType: 'team',
                entityId: team.id,
                tournamentId,
                summary: `${session.user.name || 'Player'} created team ${team.name}`,
                actor: session.user.name || 'Signed-in player',
            });

            return NextResponse.json({ ...team, discord: await bindDiscordName(user.id, discordName) });
        } else if (action === 'JOIN_TEAM') {
            const team = await prisma.$transaction(async (tx) => {
                const existingPlayer = await tx.player.findFirst({
                    where: {
                        tournamentId,
                        userId: user.id,
                    },
                });

                if (existingPlayer) {
                    throw new Error('You are already registered for this tournament');
                }

                const teamRecord = await tx.team.findUnique({
                    where: { inviteCode: inviteCode as string },
                    include: { 
                        _count: { select: { players: true } },
                        tournament: true
                    }
                });

                if (!teamRecord) {
                    throw new Error('Invalid invite code');
                }

                if (teamRecord.tournamentId !== tournamentId) {
                    throw new Error('Team is not part of this tournament');
                }

                if (teamRecord._count.players >= teamRecord.tournament.teamSize) {
                    throw new Error('Team is already full');
                }

                await tx.player.create({
                    data: {
                        name: session.user.name || 'Unknown',
                        steamId: user.steamId,
                        teamId: teamRecord.id,
                        tournamentId,
                        userId: user.id,
                        seating,
                    }
                });

                return tx.team.findUnique({
                    where: { id: teamRecord.id },
                    include: {
                        players: true,
                    },
                });
            });

            if (!team) {
                return errorResponse('invalid_invite_code', 404);
            }

            await announceSignup({
                playerName: session.user.name || 'Unknown',
                teamName: team.name,
                tournamentName: tournament.name,
                tournamentId,
            });

            await recordAudit({
                action: 'signup.joined_team',
                entityType: 'team',
                entityId: team.id,
                tournamentId,
                summary: `${session.user.name || 'Player'} joined team ${team.name}`,
                actor: session.user.name || 'Signed-in player',
            });

            return NextResponse.json({ ...team, discord: await bindDiscordName(user.id, discordName) });
        }

        return errorResponse('invalid_action', 400);
    } catch (error: any) {
        console.error('Signup error:', error);
        const message = error?.message || 'Signup failed';
        const status =
            message === 'Invalid invite code' ? 404 :
            message === 'Unauthorized' ? 401 :
            message.includes('already') || message.includes('full') || message.includes('not part') ? 400 :
            500;

        // The refusals above are thrown from inside the transaction so that the team/player rows
        // roll back with them — by the time they land here they are a string, not a code. The
        // text is the lookup key; anything unrecognised (a real 500) stays an untranslated
        // English message, which is the right outcome for something only a developer reads.
        const code = codeForText(message);
        if (code) return errorResponse(code, status);

        return NextResponse.json({ error: message }, { status });
    }
}
