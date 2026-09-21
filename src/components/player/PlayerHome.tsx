'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { isCalled, isLive } from '@/lib/match-status';
import { Button, Card, Badge } from '@/components/ui';
import { MyQueue, useMyQueue, type QueueEntry } from '@/components/player/MyQueue';
import { EnableAlertsButton } from '@/components/player/EnableAlertsButton';
import { SeatEditor } from '@/components/player/SeatEditor';

/**
 * The player desk. One question, answered at the top: am I playing, when, and where do I sit?
 *
 * `profile` is the /api/user/profile payload (registrations + the player's own active matches);
 * `user` is the session user. The queue position comes from /api/me/queue inside MyQueue, but the
 * match itself is already in `profile`, so the desk hands that down as a fallback and paints the
 * answer on the first frame instead of a skeleton.
 */
export function PlayerHome({
  user,
  profile,
  loading = false,
}: {
  user: any;
  profile: any;
  loading?: boolean;
}) {
  const t = useTranslations('player');
  const tCommon = useTranslations('common');
  const queryClient = useQueryClient();
  const { registrations = [], activeMatches = [] } = profile || {};
  const refreshProfile = () => queryClient.invalidateQueries({ queryKey: ['profile'] });

  // Seat per tournament, straight off the player's own registration rows.
  const seats: Record<string, string | null> = {};
  for (const reg of registrations) {
    if (reg?.team?.tournament?.id) seats[reg.team.tournament.id] = reg.seating ?? null;
  }

  // Server details, where a match actually has them. Nothing writes them today, so the
  // one-click-join button simply doesn't exist rather than sitting there as "Server pending".
  const servers: Record<string, { ip?: string | null; port?: string | null; password?: string | null }> = {};
  for (const match of activeMatches) {
    if (match?.serverIp) {
      servers[match.id] = { ip: match.serverIp, port: match.serverPort, password: match.serverPassword };
    }
  }

  // The same shape /api/me/queue returns, built from what the page already has. Everything but
  // the queue position is known here, so the card can render before that request comes back.
  const fallback: QueueEntry[] = [];
  for (const match of activeMatches) {
    const tournamentId = match?.tournament?.id;
    if (!tournamentId || fallback.some((e) => e.tournamentId === tournamentId)) continue;
    const youAreHome = match.playerTeamId === match.homeTeamId;
    const mine = youAreHome ? match.homeTeam : match.awayTeam;
    const opponent = youAreHome ? match.awayTeam : match.homeTeam;
    fallback.push({
      tournamentId,
      tournamentName: match.tournament.name,
      game: match.tournament.game,
      teamName: mine?.name ?? t('queue.yourTeam'),
      state: 'SCHEDULED',
      matchesAhead: null,
      totalPending: 0,
      nextMatch: {
        id: match.id,
        round: match.round,
        status: match.status,
        bracketType: match.bracketType,
        bestOf: match.bestOf ?? 1,
        opponent: opponent?.name ?? tCommon('tbd'),
        youAreHome,
        hasOpponent: Boolean(opponent?.name),
      },
    });
  }

  return (
    <div className="min-h-screen bg-page text-fg">
      <main className="mds-container space-y-6 py-6 sm:py-8">
        <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
          <div>
            <p className="mds-uppercase-label text-fg-subtle">{t('desk.label')}</p>
            {user?.name && <h1 className="mds-name-lg mt-0.5 text-2xl">{user.name}</h1>}
          </div>
          <EnableAlertsButton />
        </header>

        <MyQueue
          enabled={!loading}
          registered={registrations.length > 0}
          fallback={fallback}
          seats={seats}
          servers={servers}
          profileLoading={loading}
          onSeatSaved={refreshProfile}
        />

        <TournamentList registrations={registrations} loading={loading} onSeatSaved={refreshProfile} />

        {/* No Discord card here, deliberately. Spec §6: "Player desk: nothing. No card, no
            badge, no nag, ever" — and `docs/kid-clutter-plan.md` is actively stripping this
            surface down to one question. The card lives on /profile, and acquisition happens
            in Discord itself (a pinned three-step post in #turnering). */}
      </main>
    </div>
  );
}

/** What the queue says about a tournament, as a chip on its card. Never a raw state enum. */
function StateChip({ entry }: { entry?: QueueEntry }) {
  const t = useTranslations('player');
  if (!entry) return null;
  if (entry.state === 'OUT') return <Badge tone="done">{t('chip.knockedOut')}</Badge>;
  if (entry.state === 'NO_BRACKET' || entry.state === 'AWAITING_DRAW') {
    return <Badge tone="neutral">{t('chip.notDrawn')}</Badge>;
  }
  const status = (entry.nextMatch?.status || '').toUpperCase();
  if (isLive(status)) return <Badge tone="live">{t('chip.playingNow')}</Badge>;
  if (isCalled(status)) return <Badge tone="ready">{t('chip.youreUp')}</Badge>;
  if (entry.matchesAhead === 0) return <Badge tone="ready">{t('chip.upNext')}</Badge>;
  if (entry.matchesAhead === null) return null;
  return <Badge tone="neutral">{t('chip.matchesAhead', { count: entry.matchesAhead })}</Badge>;
}

function TournamentList({
  registrations,
  loading,
  onSeatSaved,
}: {
  registrations: any[];
  loading: boolean;
  onSeatSaved: () => void;
}) {
  const t = useTranslations('player');
  const tCommon = useTranslations('common');
  const { data } = useMyQueue({ enabled: !loading });
  const byTournament = new Map((data?.queue ?? []).map((e) => [e.tournamentId, e]));

  if (loading && registrations.length === 0) {
    return (
      <section className="space-y-3" aria-busy="true">
        <p className="mds-uppercase-label text-fg-subtle">{t('tournaments.label')}</p>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Card className="space-y-3">
            <div className="h-3 w-1/4 animate-pulse rounded-sm bg-white/5" />
            <div className="h-5 w-2/3 animate-pulse rounded-sm bg-white/5" />
            <div className="h-3 w-1/2 animate-pulse rounded-sm bg-white/5" />
          </Card>
        </div>
      </section>
    );
  }

  // No registrations: the desk already shows one zero state above. Two is noise.
  if (registrations.length === 0) return null;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="mds-uppercase-label text-fg-subtle">{t('tournaments.label')}</p>
        <Link href="/tournaments" className="text-xs font-semibold text-brand hover:underline">
          {t('action.browseAll')}
        </Link>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {registrations.map((reg: any) => (
          // The card is not one big link: the seat editor is interactive, and a button inside
          // an anchor is both invalid markup and a click trap.
          <Card key={reg.id} className="flex h-full flex-col justify-between gap-4">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="neutral">{reg.team.tournament.game}</Badge>
                <StateChip entry={byTournament.get(reg.team.tournament.id)} />
              </div>
              <Link
                href={`/tournaments/${reg.team.tournament.id}`}
                className="group flex items-start justify-between gap-3"
              >
                <h3 className="mds-name-lg text-lg group-hover:text-brand">{reg.team.tournament.name}</h3>
                <ArrowRight size={16} className="mt-1 shrink-0 text-fg-subtle group-hover:text-brand" />
              </Link>
            </div>
            <div className="grid grid-cols-2 gap-3 border-t border-line pt-3">
              <div>
                <p className="mds-uppercase-label text-fg-subtle">{tCommon('team')}</p>
                <p className="mds-name mt-1 text-sm">{reg.team.name}</p>
              </div>
              <div>
                <p className="mds-uppercase-label text-fg-subtle">{t('seat.label')}</p>
                <SeatEditor
                  className="mt-1"
                  tournamentId={reg.team.tournament.id}
                  seating={reg.seating}
                  onSaved={onSeatSaved}
                />
              </div>
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}
