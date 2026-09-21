'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { MessageSquare, MapPin, BellOff, ShieldAlert } from 'lucide-react';
import { Button, Card, Badge } from '@/components/ui';
import { apiRequest } from '@/lib/client-api';
import type { ReachPlayer, ReachReport, ReachState } from '@/lib/discord-reach';

/**
 * Who Discord can actually be told — the anti-assumption surface.
 *
 * An organizer reads this *before* the first match is called, to decide who the crew has to walk
 * to. So the panel is built around one promise: the headline number counts proven sends only.
 * A `DiscordLink` is an address, not a delivery; a player appears under "can be reached" only
 * when a `DiscordDmAttempt` row says Discord accepted a message for them.
 *
 * The two failure modes it separates on purpose, because the remedies are opposite:
 *   "BLOCKED — they have DMs closed"  → a settings change on their side, or go and fetch them.
 *   "never tried"                     → we simply have no evidence yet. Not a fault, not green.
 *
 * The word is always **sent**, never *delivered* / *levert*: a 204 from Discord proves Discord
 * took the message, not that a phone was on, un-muted, or in a hand. A marshal who reads
 * "delivered" does not walk, and that is the failure this whole panel exists to prevent.
 */

/** Chip tone per state. Only a proven send is allowed to be green. */
const STATE_TONE: Record<ReachState, 'ready' | 'danger' | 'pending' | 'neutral'> = {
  LINKED_SENT: 'ready',
  LINKED_BLOCKED: 'danger',
  LINKED_UNCONFIRMED: 'pending',
  LINKED_OPTED_OUT: 'neutral',
  NOT_LINKED: 'neutral',
  NO_ACCOUNT: 'neutral',
};

type T = ReturnType<typeof useTranslations>;

/**
 * State → words. A switch of literal `t('…')` calls rather than a computed key, so
 * `npm run i18n:check` phase 2 can actually verify every one of them exists.
 */
function stateLabel(state: ReachState, t: T): string {
  switch (state) {
    case 'LINKED_SENT':
      return t('stateSent');
    case 'LINKED_BLOCKED':
      return t('stateBlocked');
    case 'LINKED_UNCONFIRMED':
      return t('stateUnconfirmed');
    case 'LINKED_OPTED_OUT':
      return t('stateOptedOut');
    case 'NOT_LINKED':
      return t('stateNotLinked');
    default:
      return t('stateNoAccount');
  }
}

/** The remedy, in one sentence — what the organizer does about this row. */
function stateHint(state: ReachState, t: T): string {
  switch (state) {
    case 'LINKED_SENT':
      return t('stateSentHint');
    case 'LINKED_BLOCKED':
      return t('stateBlockedHint');
    case 'LINKED_UNCONFIRMED':
      return t('stateUnconfirmedHint');
    case 'LINKED_OPTED_OUT':
      return t('stateOptedOutHint');
    case 'NOT_LINKED':
      return t('stateNotLinkedHint');
    default:
      return t('stateNoAccountHint');
  }
}

function outcomeLabel(outcome: string, t: T): string {
  switch (outcome) {
    case 'SENT':
      return t('outcomeSent');
    case 'BLOCKED':
      return t('outcomeBlocked');
    case 'UNKNOWN_USER':
      return t('outcomeUnknownUser');
    case 'RATE_LIMITED':
      return t('outcomeRateLimited');
    case 'SKIPPED_OPTOUT':
      return t('outcomeSkippedOptout');
    default:
      return t('outcomeError');
  }
}

function eventLabel(event: string, t: T): string {
  switch (event) {
    case 'LINK_PROBE':
      return t('eventLinkProbe');
    case 'MATCH_CALLED':
      return t('eventMatchCalled');
    case 'MATCH_LIVE':
      return t('eventMatchLive');
    default:
      return t('eventOther');
  }
}

/** One roster row: who they are, what state they are in, and the last thing Discord said. */
function PlayerRow({ player, t }: { player: ReachPlayer; t: T }) {
  const blocked = player.state === 'LINKED_BLOCKED';
  return (
    <li
      data-testid="discord-reach-row"
      data-state={player.state}
      className={`flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5 rounded-sm border px-3 py-2 ${
        blocked ? 'border-danger/40 bg-danger/5' : 'border-line bg-field'
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mds-name text-sm">{player.name}</span>
          {player.teamName && <span className="text-meta text-fg-subtle">{player.teamName}</span>}
          {player.seating && (
            <span className="mds-numeric inline-flex items-center gap-1 rounded-sm bg-tint px-1.5 py-0.5 text-[11px] text-fg-subtle">
              <MapPin size={10} />
              {player.seating}
            </span>
          )}
        </div>
        <p className={`mt-0.5 text-meta ${blocked ? 'text-danger' : 'text-fg-subtle'}`}>
          {stateHint(player.state, t)}
        </p>
        <p className="mt-0.5 text-meta text-fg-subtle">
          {player.lastAttempt
            ? t('lastAttempt', {
                event: eventLabel(player.lastAttempt.event, t),
                outcome: outcomeLabel(player.lastAttempt.outcome, t),
              })
            : t('neverTried')}
          {player.lastAttempt?.discordCode != null
            ? ` · ${t('discordCode', { code: player.lastAttempt.discordCode })}`
            : ''}
        </p>
      </div>
      <Badge tone={STATE_TONE[player.state]}>{stateLabel(player.state, t)}</Badge>
    </li>
  );
}

function Section({
  label,
  players,
  empty,
  t,
  testId,
}: {
  label: string;
  players: ReachPlayer[];
  empty: string;
  t: T;
  testId: string;
}) {
  return (
    <div className="space-y-2" data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="mds-uppercase-label text-fg-subtle">{label}</h4>
        <Badge tone="neutral">{players.length}</Badge>
      </div>
      {players.length === 0 ? (
        <p className="rounded-sm border border-dashed border-line px-3 py-2 text-meta text-fg-subtle">{empty}</p>
      ) : (
        <ul className="space-y-1.5">
          {players.map((player) => (
            <PlayerRow key={player.playerId} player={player} t={t} />
          ))}
        </ul>
      )}
    </div>
  );
}

export function DiscordReachPanel({ tournamentId }: { tournamentId: string }) {
  const t = useTranslations('organizer.discordReach');
  const [report, setReport] = useState<ReachReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setReport(await apiRequest<ReachReport>(`/api/tournaments/${tournamentId}/discord-reach`));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [tournamentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const togglePause = async () => {
    if (!report) return;
    setBusy(true);
    try {
      setReport(
        await apiRequest<ReachReport>(`/api/tournaments/${tournamentId}/discord-reach`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dmPaused: !report.dmPaused }),
        })
      );
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const summary = report?.summary;
  const reachable = (report?.players ?? []).filter((p) => p.state === 'LINKED_SENT');
  const unreachable = (report?.players ?? []).filter((p) => p.state !== 'LINKED_SENT');

  return (
    <Card className="space-y-4" data-testid="discord-reach-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <MessageSquare size={15} className="text-brand" />
          <h3 className="text-sm font-bold">{t('title')}</h3>
        </div>
        <Badge tone={report?.dmPaused ? 'danger' : 'neutral'}>
          {t(report?.dmPaused ? 'statusPaused' : 'statusActive')}
        </Badge>
      </div>

      {/* The headline. It counts proven sends and nothing else, so it can never overstate. */}
      <div>
        <p className="mds-uppercase-label text-fg-subtle">{t('summaryLabel')}</p>
        <p data-testid="discord-reach-summary" className="mds-tabular mt-1 text-lead font-bold">
          {t('summary', { reachable: summary?.reachable ?? 0, total: summary?.total ?? 0 })}
        </p>
        {/* Permanent and non-dismissible, by design: nobody may read this panel as a staffing
            decision. There is no close button here and there must never be one. */}
        <p className="mt-1 text-meta text-fg-muted">{t('caveat')}</p>
      </div>

      {summary && (
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={summary.blocked > 0 ? 'danger' : 'neutral'}>
            {t('countBlocked', { count: summary.blocked })}
          </Badge>
          <Badge tone="neutral">{t('countUnconfirmed', { count: summary.unconfirmed })}</Badge>
          <Badge tone="neutral">{t('countNotLinked', { count: summary.notLinked })}</Badge>
          <Badge tone="neutral">{t('countNoAccount', { count: summary.noAccount })}</Badge>
          <Badge tone="neutral">{t('countOptedOut', { count: summary.optedOut })}</Badge>
        </div>
      )}

      {/* The kill switch. Full width on a phone, because that is where it gets used: an organizer
          standing on the floor with one thumb free. */}
      <div className="rounded-sm border border-line bg-field p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="mds-uppercase-label text-fg-subtle">{t('pauseLabel')}</p>
            <p className="mt-0.5 text-meta text-fg-muted">
              {t(report?.dmPaused ? 'pauseHintPaused' : 'pauseHintActive')}
            </p>
          </div>
          <Button
            data-testid="discord-reach-pause"
            variant={report?.dmPaused ? 'primary' : 'secondary'}
            size="md"
            disabled={busy || !report}
            onClick={togglePause}
            className="w-full sm:w-auto"
          >
            {report?.dmPaused ? <BellOff size={14} /> : <ShieldAlert size={14} />}
            {t(report?.dmPaused ? 'resume' : 'pause')}
          </Button>
        </div>
      </div>

      {failed && !report && (
        <div className="space-y-2">
          <p className="text-meta text-danger">{t('loadFailed')}</p>
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            {t('retry')}
          </Button>
        </div>
      )}

      {!report && !failed && <p className="text-meta text-fg-subtle">{t('loading')}</p>}

      {report && report.players.length === 0 && (
        <p className="rounded-sm border border-dashed border-line px-3 py-2 text-meta text-fg-subtle">
          {t('emptyRoster')}
        </p>
      )}

      {report && report.players.length > 0 && (
        <div className="custom-scrollbar max-h-[420px] space-y-4 overflow-y-auto pr-1">
          {/* Unreachable first: this list is the walking order for the crew. */}
          <Section
            testId="discord-reach-unreachable"
            label={t('unreachableLabel')}
            players={unreachable}
            empty={t('unreachableEmpty')}
            t={t}
          />
          <Section
            testId="discord-reach-reachable"
            label={t('reachableLabel')}
            players={reachable}
            empty={t('reachableEmpty')}
            t={t}
          />
        </div>
      )}
    </Card>
  );
}
