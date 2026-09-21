import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireStaffApi } from '@/lib/route-auth';
import { buildActorLabel, recordAudit } from '@/lib/audit';
import { buildReachReport } from '@/lib/discord-reach';

export const dynamic = 'force-dynamic';

/**
 * GET — who Discord can actually reach in this tournament, and whether DMs are paused.
 *
 * Staff-only, and staff-shaped: the payload carries display names, teams, seats and the last
 * outcome Discord returned, and deliberately **no `discordId`, no `steamId` and no invite
 * code**. The panel never needs a snowflake, and this route is one screenshot away from a group
 * chat of 13-year-olds.
 */
export async function GET(_request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const unauthorized = await requireStaffApi();
  if (unauthorized) return unauthorized;

  const report = await buildReachReport(params.id);
  if (!report) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json(report);
}

/**
 * POST { dmPaused: boolean } — the kill switch.
 *
 * Staff, not admin-only: this is the button an organizer or a crew member flips on a phone while
 * standing on the floor, and every direction it can be flipped only ever *reduces* what Summit
 * sends. Making it admin-only would mean the person holding the phone is the wrong person.
 */
export async function POST(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const unauthorized = await requireStaffApi();
  if (unauthorized) return unauthorized;

  const body = await request.json().catch(() => ({}));
  if (typeof body?.dmPaused !== 'boolean') {
    return NextResponse.json({ error: 'dmPaused must be a boolean' }, { status: 400 });
  }

  const existing = await prisma.tournament.findUnique({
    where: { id: params.id },
    select: { id: true },
  });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await prisma.tournament.update({
    where: { id: params.id },
    data: { discordDmPaused: body.dmPaused },
  });

  await recordAudit({
    action: body.dmPaused ? 'discord_dm.paused' : 'discord_dm.resumed',
    entityType: 'tournament',
    entityId: params.id,
    tournamentId: params.id,
    summary: body.dmPaused ? 'Paused Discord DMs for this tournament' : 'Resumed Discord DMs for this tournament',
    actor: await buildActorLabel(),
  });

  const report = await buildReachReport(params.id);
  return NextResponse.json(report);
}
