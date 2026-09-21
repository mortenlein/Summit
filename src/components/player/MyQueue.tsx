'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Radio, Hourglass, AlertTriangle, RefreshCw, Zap, ArrowRight, Trophy, Clock } from 'lucide-react';
import { Button, Card, StatusBadge, EmptyState } from '@/components/ui';
import { isCalled, isLive } from '@/lib/match-status';
import { buildSteamConnectUrl } from '@/lib/match-links';
import { clientApi } from '@/lib/client-api';
import { SeatEditor } from '@/components/player/SeatEditor';

interface NextMatch {
  id: string;
  round: number;
  status: string;
  bracketType: string;
  bestOf: number;
  opponent: string;
  youAreHome: boolean;
  hasOpponent: boolean;
}

export interface QueueEntry {
  tournamentId: string;
  tournamentName: string;
  game: string;
  teamName: string;
  state: 'SCHEDULED' | 'AWAITING_DRAW' | 'OUT' | 'NO_BRACKET';
  matchesAhead: number | null;
  totalPending: number;
  nextMatch: NextMatch | null;
}

/** One shared cache entry for GET /api/me/queue — the desk polls it, other readers ride along. */
export function useMyQueue({ poll = false, enabled = true }: { poll?: boolean; enabled?: boolean } = {}) {
  return useQuery<{ queue: QueueEntry[] }>({
    queryKey: ['me-queue'],
    queryFn: () => clientApi.getQueue(),
    enabled,
    ...(poll ? { refetchInterval: 15000 } : {}),
  });
}

/** The message key for where a match sits, so the stage name is translated, never built. */
function stageKey(bracketType: string): 'grandFinal' | 'thirdPlace' | 'lowerBracket' | 'round' {
  switch (bracketType) {
    case 'GRAND_FINAL':
      return 'grandFinal';
    case 'THIRD_PLACE':
      return 'thirdPlace';
    case 'LOSERS':
      return 'lowerBracket';
    default:
      return 'round';
  }
}

type Tone = 'live' | 'called' | 'next' | 'waiting';

function toneOf(entry: QueueEntry): Tone {
  const status = (entry.nextMatch?.status || '').toUpperCase();
  if (isLive(status)) return 'live';
  if (isCalled(status)) return 'called';
  return entry.matchesAhead === 0 ? 'next' : 'waiting';
}

/**
 * The one line the player came to read. A called or live match always outranks the queue
 * position — "3 matches ahead" is wrong and alarming once a marshal has called you.
 *
 * The words live in `player.headline.*`: one whole sentence per tone, with the trailing clause
 * marked up as <rest> rather than glued on here, so the em dash and the word order belong to
 * the translation. The waiting line is an ICU plural — "1 kamper foran deg" must not exist.
 */
function Headline({ entry, tone }: { entry: QueueEntry; tone: Tone }) {
  const t = useTranslations('player');
  const rest = (chunks: React.ReactNode) => <span className="font-normal opacity-80">{chunks}</span>;
  if (tone === 'live') return <>{t.rich('headline.live', { rest })}</>;
  if (tone === 'called') return <>{t.rich('headline.called', { rest })}</>;
  if (tone === 'next') return <>{t('headline.next')}</>;
  return <>{t('headline.matchesAhead', { count: entry.matchesAhead ?? 0 })}</>;
}

/**
 * Only two tones get a glyph, and neither is decorative.
 *
 * `called` and `next` used a `Flag`, which in this app's own vocabulary means *forfeit* (see
 * EditMatchModal) — so the icon on "your turn" was the icon for "your team gave up". The
 * headline already says it in words, at 3xl, on a solid green band. Nothing was added in its
 * place: the fix is one fewer thing, not a better thing.
 */
function headlineIcon(tone: Tone) {
  if (tone === 'live') return <Radio size={20} className="animate-pulse" />;
  if (tone === 'waiting') return <Hourglass size={18} />;
  return null;
}

// Called and live are solid fills on purpose: this is the frame a player has to read from
// across a loud hall, on a phone, without looking for it.
const STRIP: Record<Tone, string> = {
  live: 'bg-danger text-white',
  called: 'bg-success text-page',
  next: 'bg-brand-soft text-brand border-b border-line',
  waiting: 'bg-white/[0.03] text-fg-muted border-b border-line',
};

const FRAME: Record<Tone, string> = {
  live: 'border-danger',
  called: 'border-success',
  next: 'border-brand',
  waiting: '',
};

/** A labelled fact block — the seat, the match, what is left to play. Replaces the stat tiles. */
function Fact({
  label,
  className = '',
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded border border-line bg-field px-4 py-3 ${className}`}>
      <p className="mds-uppercase-label text-fg-subtle">{label}</p>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

/**
 * The call board: who you play, when, where you sit, and how far down the line you are — on one
 * card, at a size that reads from across a LAN hall.
 */
function CallCard({
  entry,
  seating,
  connectUrl,
  onSeatSaved,
}: {
  entry: QueueEntry;
  seating?: string | null;
  connectUrl: string | null;
  onSeatSaved?: () => void;
}) {
  const t = useTranslations('player');
  const tCommon = useTranslations('common');
  const m = entry.nextMatch!;
  const tone = toneOf(entry);
  const onNow = tone === 'live' || tone === 'called';

  return (
    <Card className={`overflow-hidden !p-0 ${FRAME[tone]}`}>
      {/* The shout. Status is the loudest thing on the desk — nothing else competes. */}
      {/* role=status: the queue polls, so this line changes under the player's eyes — a screen
          reader should announce "you're up" the moment a marshal calls the match. */}
      <div role="status" className={`flex items-start gap-3 px-4 py-3 sm:px-5 ${STRIP[tone]}`}>
        {headlineIcon(tone) && <span className="mt-0.5 shrink-0">{headlineIcon(tone)}</span>}
        <p
          className={`font-brand font-bold leading-tight [text-wrap:balance] ${onNow ? 'text-2xl sm:text-3xl' : 'text-base sm:text-lg'}`}
        >
          <Headline entry={entry} tone={tone} />
        </p>
      </div>

      <div className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          {/* A tournament name is content: the organiser's own casing, and it may wrap. */}
          <p className="mds-name text-sm text-fg-muted">{entry.tournamentName}</p>
          {/* When the match is happening now, the band above already says so in the loudest
              type on the page. A small badge repeating it is the second statement of one fact,
              and the kid reads both before acting on either. */}
          {!onNow && <StatusBadge status={m.status} />}
        </div>

        <h2 className="mds-name-lg text-xl sm:text-2xl">
          {t.rich('queue.matchup', {
            home: entry.teamName,
            away: m.hasOpponent ? m.opponent : tCommon('tbd'),
            vs: (chunks) => <span className="font-normal text-fg-subtle">{chunks}</span>,
          })}
        </h2>
        {/* The stage belongs under the matchup it describes, in muted type — not in a bordered
            box of its own next to the seat, where "BO1" in the numeric face read as a second
            seat code sixty pixels below the real one. */}
        <p className="-mt-2 text-sm text-fg-muted">
          {t(`stage.${stageKey(m.bracketType)}`, { round: m.round })}
        </p>

        <div className="grid gap-3 sm:grid-cols-3">
          {/* One green frame around the card, one green band on top of it, and the seat as the
              largest glyph inside. The accent border made a third green edge competing with
              both. */}
          <Fact label={t('seat.label')} className={onNow ? 'sm:col-span-3' : ''}>
            <SeatEditor
              size="lg"
              tournamentId={entry.tournamentId}
              seating={seating}
              onSaved={() => onSeatSaved?.()}
            />
          </Fact>
          {!onNow && entry.totalPending > 0 && (
            <Fact label={t('fact.stillToPlay')}>
              <p className="mds-numeric text-sm font-bold">
                {t('fact.stillToPlayCount', { count: entry.totalPending })}
              </p>
            </Fact>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Only ever shown when the match really carries server details (nothing writes them
              today) — a dead "one-click join" is worse than no button at all. */}
          {connectUrl && (
            <a href={connectUrl} data-testid={`join-match-${m.id}`}>
              <Button>
                <Zap size={15} />
                {t('action.oneClickJoin')}
              </Button>
            </a>
          )}
          <Link href={`/tournaments/${entry.tournamentId}`}>
            <Button variant="secondary">
              {t('action.viewBracket')}
              <ArrowRight size={15} />
            </Button>
          </Link>
        </div>
      </div>
    </Card>
  );
}

/**
 * No match to play: knocked out, or the bracket hasn't been drawn yet. A zero state, not a card —
 * the desk must never dress "nothing to do" up as a fixture, or promise a match that isn't coming.
 */
function Standby({ entries }: { entries: QueueEntry[] }) {
  const t = useTranslations('player');
  const out = entries.filter((e) => e.state === 'OUT');
  const waiting = entries.filter((e) => e.state !== 'OUT');
  const knockedOut = waiting.length === 0 && out.length > 0;
  const one = knockedOut ? (out.length === 1 ? out[0] : null) : waiting.length === 1 ? waiting[0] : null;
  // Whole sentences, named and unnamed, rather than one sentence assembled around a hole: the
  // tournament name has to stay a bare name (Norwegian puts the definite form on the noun, so
  // "ute av {navn}" works and "ute av {navn}en" cannot).
  const name = (chunks: React.ReactNode) => <span className="mds-name">{chunks}</span>;
  const body = knockedOut
    ? one
      ? t.rich('standby.outOfNamed', { tournament: one.tournamentName, name })
      : t('standby.outOfUnnamed')
    : one
      ? t.rich('standby.notDrawnNamed', { tournament: one.tournamentName, name })
      : t('standby.notDrawnNone');

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-dashed border-line bg-white/[0.02] px-5 py-6">
      <div className="space-y-1">
        <h2 className="font-brand text-lg font-bold">
          {knockedOut ? t('standby.knockedOutTitle') : t('standby.waitingTitle')}
        </h2>
        <p className="max-w-xl text-sm text-fg-muted">{body}</p>
      </div>
      <Link href={one ? `/tournaments/${one.tournamentId}` : '/tournaments'}>
        <Button variant="secondary">
          {!knockedOut && <Clock size={15} />}
          {knockedOut ? t('action.viewBracket') : t('action.openTournament')}
          {knockedOut && <ArrowRight size={15} />}
        </Button>
      </Link>
    </div>
  );
}

function CardSkeleton() {
  return (
    <Card className="space-y-3" aria-busy="true">
      <div className="h-3 w-1/3 animate-pulse rounded-sm bg-white/5" />
      <div className="h-6 w-2/3 animate-pulse rounded-sm bg-white/5" />
      <div className="h-3 w-1/2 animate-pulse rounded-sm bg-white/5" />
    </Card>
  );
}

/**
 * Everything the desk knows about "am I playing, and when?".
 *
 * `fallback` is built from the profile payload the page already holds, so the answer is painted
 * on the first frame and the /api/me/queue round-trip only adds the queue position to it — the
 * player never watches a skeleton where the answer was already on screen.
 */
/**
 * Does this tournament already have a call card on the desk?
 *
 * Exported because the tournament list below the queue has to drop the same entries, and the
 * two answers drifting apart is what put a second copy of the seat code and the pencil on the
 * screen directly under the green card — twice the B01, twice the edit, one kid.
 */
export function hasCallCard(entry: QueueEntry): boolean {
  return entry.state === 'SCHEDULED' && Boolean(entry.nextMatch);
}

export function MyQueue({
  fallback = [],
  seats = {},
  servers = {},
  profileLoading = false,
  enabled = true,
  registered = false,
  onSeatSaved,
}: {
  fallback?: QueueEntry[];
  seats?: Record<string, string | null | undefined>;
  servers?: Record<string, { ip?: string | null; port?: string | null; password?: string | null }>;
  profileLoading?: boolean;
  enabled?: boolean;
  /** Whether the player is registered anywhere — the desk shows one zero state, not two. */
  registered?: boolean;
  onSeatSaved?: () => void;
}) {
  const t = useTranslations('player');
  const tCommon = useTranslations('common');
  const { data, isLoading, error, refetch, isFetching } = useMyQueue({ poll: true, enabled });

  const entries = data?.queue ?? fallback;
  const scheduled = entries
    .filter(hasCallCard)
    .sort((a, b) => {
      const rank = (e: QueueEntry) => ({ live: 0, called: 1, next: 2, waiting: 3 })[toneOf(e)];
      return rank(a) - rank(b) || (a.matchesAhead ?? 99) - (b.matchesAhead ?? 99);
    });

  if ((!enabled || isLoading || profileLoading) && entries.length === 0) {
    return (
      <section className="space-y-3" aria-busy="true" aria-label={t('queue.label')}>
        <CardSkeleton />
      </section>
    );
  }

  // A silently missing queue reads as "you have no matches", which is the one thing it must
  // never imply. Say it failed and offer a retry — above whatever the profile already knew.
  const errorBanner = error ? (
    <Card className="flex flex-wrap items-center justify-between gap-3 border-danger">
      <div className="flex items-center gap-2">
        <AlertTriangle size={16} className="text-danger" />
        <p className="text-sm font-semibold">{t('queue.refreshFailed')}</p>
      </div>
      <Button variant="secondary" size="sm" onClick={() => void refetch()} disabled={isFetching}>
        <RefreshCw size={14} className={isFetching ? 'animate-spin' : undefined} />
        {tCommon('retry')}
      </Button>
    </Card>
  ) : null;

  if (scheduled.length === 0) {
    return (
      <section className="space-y-3" aria-label={t('queue.region')}>
        {errorBanner}
        {entries.length > 0 && <Standby entries={entries} />}
        {entries.length === 0 && !registered && (
          <EmptyState
            icon={<Trophy size={26} />}
            title={t('empty.title')}
            description={t('empty.description')}
            action={
              <Link href="/tournaments">
                <Button>{t('action.browseTournaments')}</Button>
              </Link>
            }
          />
        )}
      </section>
    );
  }

  return (
    // The heading is an aria-label, not a line of text. "KØEN DIN" sat between the kid's name
    // and the green card telling them where to go, and a label naming a region they can see is
    // one more thing to read past at the exact moment they should be standing up.
    <section className="space-y-3" aria-label={t('queue.region')}>
      {errorBanner}
      {scheduled.map((entry) => {
        const server = servers[entry.nextMatch!.id];
        return (
          <CallCard
            key={entry.tournamentId}
            entry={entry}
            seating={seats[entry.tournamentId]}
            connectUrl={server ? buildSteamConnectUrl(server.ip, server.port, server.password) : null}
            onSeatSaved={onSeatSaved}
          />
        );
      })}
    </section>
  );
}
