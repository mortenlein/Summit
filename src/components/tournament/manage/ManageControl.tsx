'use client';

import React, { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, ChevronDown, ChevronRight, MapPin, Crown, Users, Trophy, GitBranch, ExternalLink } from 'lucide-react';
import PublicBracket from '@/components/PublicBracket';
import { Card, Badge, StatusBadge } from '@/components/ui';
import { byPlayOrder, isActive, isDone } from '@/lib/match-status';
import type { Translator } from '@/components/tournament/match-labels';
import { EonBridgePanel } from './EonBridgePanel';
import { DiscordReachPanel } from './DiscordReachPanel';

interface ManageControlProps {
  tournament: any;
  teams: any[];
  matches: any[];
  onOpenMatchModal: (match: any) => void;
}

const byOrder = (a: any, b: any) => byPlayOrder(a, b);

/**
 * The human name for where a match sits in the bracket. This is what an organizer says out loud
 * ("the second quarter-final"), and it is what identifies a match on screen — never its uuid.
 * Shared by every manage surface so one match is called the same thing everywhere.
 *
 * The words come from the SHARED bracket vocabulary (the `stage` message namespace), which is
 * what the public board and the OBS overlay also read; `tStage` is `useTranslations('stage')`.
 * Do not reintroduce a local table here — the organizer calling a match "Lower R2" while the
 * spectator page calls it "Taperrunde 2" is exactly the drift that namespace exists to prevent.
 */
export function stageLabel(match: any, totalRounds: number, tStage: Translator) {
  if (match.bracketType === 'GRAND_FINAL') return tStage('bracket.grandFinal');
  if (match.bracketType === 'THIRD_PLACE') return tStage('bracket.thirdPlace');
  if (match.bracketType === 'LOSERS') return tStage('bracket.losersRound', { n: match.round });
  const fromFinal = totalRounds - match.round;
  if (fromFinal === 0) return tStage('bracket.grandFinal');
  if (fromFinal === 1) return tStage('bracket.semiFinals');
  if (fromFinal === 2) return tStage('bracket.quarterFinals');
  return tStage('bracket.round', { n: match.round });
}

/** How many of a team's players floor staff have confirmed at their seat. */
function checkedIn(team: any): { seated: number; total: number } {
  const players: any[] = team?.players || [];
  return { seated: players.filter((p) => p?.checkedInAt).length, total: players.length };
}

/**
 * One side of a matchup. The name gets the full width of the row and wraps — a name the
 * organizer cannot read is worse than a name that takes two lines — with the score pinned right.
 */
function TeamLine({
  team,
  score,
  won,
  showCheckin,
}: {
  team: any;
  score: number;
  won: boolean;
  showCheckin: boolean;
}) {
  const t = useTranslations('organizer.control');
  const tCommon = useTranslations('common');
  const { seated, total } = checkedIn(team);
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <span className={`mds-name block text-sm ${won ? 'text-brand' : 'text-fg'}`}>
          {team?.name || tCommon('tbd')}
        </span>
        {showCheckin && total > 0 && (
          /* Check-in is progress, not an alarm: green once the roster is complete, amber while it
             fills, muted at zero — the workspace hydrates from a payload that can be a beat behind
             on `checkedInAt`, so "nobody yet" must not read as a red flag. */
          <span
            className={`mt-0.5 inline-flex items-center gap-1 text-xs ${
              seated === 0 ? 'text-fg-subtle' : seated === total ? 'text-success' : 'text-warning'
            }`}
          >
            {seated === total ? <Check size={11} /> : null}
            <span className="mds-numeric">{t('atSeat', { seated, total })}</span>
          </span>
        )}
      </div>
      <span className={`mds-numeric shrink-0 text-sm font-bold ${won ? 'text-brand' : 'text-fg-muted'}`}>
        {score}
      </span>
    </div>
  );
}

function GameRow({ match, totalRounds, onClick }: { match: any; totalRounds: number; onClick: () => void }) {
  const tStage = useTranslations('stage');
  const live = isActive(match.status);
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-sm border border-line bg-field px-3 py-2.5 text-left transition-all hover:border-line-hover"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="mds-uppercase-label whitespace-nowrap text-fg-subtle">{stageLabel(match, totalRounds, tStage)}</span>
        <StatusBadge status={match.status} />
      </div>
      <div className="space-y-1.5">
        <TeamLine
          team={match.homeTeam}
          score={match.homeScore}
          won={Boolean(match.winnerId) && match.winnerId === match.homeTeamId}
          showCheckin={live}
        />
        <TeamLine
          team={match.awayTeam}
          score={match.awayScore}
          won={Boolean(match.winnerId) && match.winnerId === match.awayTeamId}
          showCheckin={live}
        />
      </div>
    </button>
  );
}

function GamesSection({
  title,
  icon,
  matches,
  totalRounds,
  onOpen,
  empty,
  className = '',
}: {
  title: string;
  icon: React.ReactNode;
  matches: any[];
  totalRounds: number;
  onOpen: (m: any) => void;
  empty: string;
  className?: string;
}) {
  return (
    <div className={`space-y-2 ${className}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {icon}
          <h3 className="mds-uppercase-label text-fg-subtle">{title}</h3>
        </div>
        <Badge tone="neutral">{matches.length}</Badge>
      </div>
      {matches.length === 0 ? (
        <p className="rounded-sm border border-dashed border-line px-3 py-2 text-xs text-fg-subtle">{empty}</p>
      ) : (
        <div className="space-y-2">
          {matches.map((m) => (
            <GameRow key={m.id} match={m} totalRounds={totalRounds} onClick={() => onOpen(m)} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Which players floor staff have confirmed at their seat, read off the matches payload (the
 * teams payload doesn't carry `checkedInAt`). Only rosters already placed in a bracket slot are
 * covered — that's exactly the set the organizer is chasing.
 */
function checkinsFromMatches(matches: any[]): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const match of matches) {
    for (const side of ['homeTeam', 'awayTeam'] as const) {
      for (const player of match?.[side]?.players || []) {
        if (player?.id) map[player.id] = Boolean(player.checkedInAt);
      }
    }
  }
  return map;
}

function TeamRosterCard({ team, checkins }: { team: any; checkins: Record<string, boolean> }) {
  const t = useTranslations('organizer.control');
  const [open, setOpen] = useState(true);
  const players = team.players || [];
  const seated = players.filter((p: any) => checkins[p.id]).length;
  return (
    <div className="rounded-sm border border-line bg-field">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start justify-between gap-2 px-3 py-2 text-left"
      >
        <div className="flex min-w-0 items-start gap-2">
          {open ? (
            <ChevronDown size={14} className="mt-0.5 shrink-0 text-fg-subtle" />
          ) : (
            <ChevronRight size={14} className="mt-0.5 shrink-0 text-fg-subtle" />
          )}
          <span className="mds-name text-sm">{team.name}</span>
          {team.seed != null && <Badge tone="neutral">#{team.seed}</Badge>}
        </div>
        <span className="mds-numeric shrink-0 text-xs text-fg-subtle">
          {seated > 0 ? `${seated}/${players.length}` : players.length}
        </span>
      </button>
      {open && (
        <div className="space-y-1 border-t border-line px-3 py-2">
          {players.length === 0 ? (
            <p className="text-xs text-fg-subtle">{t('noPlayers')}</p>
          ) : (
            players.map((p: any) => (
              <div key={p.id} className="flex items-center gap-2 text-sm">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${p.isOnline ? 'bg-success' : 'bg-line-hover'}`} />
                <span className="mds-name min-w-0 flex-1">
                  {p.nickname || p.name}
                  {p.isLeader && <Crown size={11} className="ml-1 inline text-warning" />}
                </span>
                {p.countryCode && (
                  <span className="mds-uppercase-label shrink-0 text-fg-subtle">{p.countryCode}</span>
                )}
                {checkins[p.id] && (
                  <span
                    title={t('checkedIn')}
                    className="inline-flex shrink-0 items-center rounded-sm bg-success/15 px-1 py-0.5 text-success"
                  >
                    <Check size={11} />
                  </span>
                )}
                <span
                  className={`mds-numeric inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] font-bold ${
                    p.seating ? 'bg-brand-soft text-brand' : 'bg-white/5 text-fg-subtle'
                  }`}
                >
                  <MapPin size={10} />
                  {p.seating || '—'}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The screen an organizer runs the whole LAN from, in the order the questions get asked:
 *
 *   1. What needs me right now? → the games rail across the top: Now / Up next / Completed, each
 *      row one click away from the editor that changes a result.
 *   2. Who is where? → teams, seats and check-in ticks.
 *   3. What does the whole draw look like? → the bracket map, plus the full-size public bracket.
 *
 * The bracket used to own the largest panel here, but React Flow fits the entire draw into the
 * panel: at cockpit size an eight-team bracket renders at ~0.3 zoom, i.e. 4px text. It is a map,
 * not a working surface, so it gets map-sized space and the running order gets the top of the
 * screen.
 */
/** Highest winners-bracket round in a draw — the anchor "Final / Semi-Final / …" counts back from. */
export function totalRoundsOf(matches: any[]) {
  const winners = matches.filter((m) => m.bracketType === 'WINNERS');
  return winners.length ? Math.max(...winners.map((m) => m.round)) : 0;
}

export function ManageControl({ tournament, teams, matches, onOpenMatchModal }: ManageControlProps) {
  const t = useTranslations('organizer.control');
  const totalRounds = totalRoundsOf(matches);
  const checkins = useMemo(() => checkinsFromMatches(matches), [matches]);

  // Three groups the organizer actually runs the floor from:
  //   Now  — called (players sent to their stations) or live. A called match belongs here, not
  //          buried in "up next"; it's the one thing needing attention right now.
  //   Next — still pending but playable, i.e. both teams are known.
  //   Done — finished (including legacy FINISHED rows).
  // Pending matches whose teams aren't decided yet are deliberately not listed; they're
  // visible in the bracket panel and would otherwise swamp the queue.
  const now = matches.filter((m) => isActive(m.status)).sort(byOrder);
  const upNext = matches
    .filter((m) => !isActive(m.status) && !isDone(m.status) && m.homeTeamId && m.awayTeamId)
    .sort(byOrder);
  const previous = matches
    .filter((m) => isDone(m.status))
    .sort((a, b) => b.round - a.round || b.matchOrder - a.matchOrder);

  return (
    <div className="space-y-6">
      {/* The running order — the first thing on screen, because it is the first question an
          organizer asks. Column widths carry the hierarchy: what is happening now is wider than
          the queue, which is wider than the history. */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-12">
        <GamesSection
          className="md:col-span-5"
          title={t('now')}
          icon={<span className="h-2 w-2 rounded-full bg-danger" />}
          matches={now}
          totalRounds={totalRounds}
          onOpen={onOpenMatchModal}
          empty={t('nowEmpty')}
        />
        <GamesSection
          className="md:col-span-4"
          title={t('upNext')}
          icon={<span className="h-2 w-2 rounded-full bg-warning" />}
          matches={upNext}
          totalRounds={totalRounds}
          onOpen={onOpenMatchModal}
          empty={t('upNextEmpty')}
        />
        <GamesSection
          className="md:col-span-3"
          title={t('completed')}
          icon={<span className="h-2 w-2 rounded-full bg-success" />}
          matches={previous}
          totalRounds={totalRounds}
          onOpen={onOpenMatchModal}
          empty={t('completedEmpty')}
        />
      </div>

      <div className="grid grid-cols-12 gap-6">
        {/* Teams, seats and check-in */}
        <aside className="col-span-12 space-y-3 lg:col-span-4">
          <div className="flex items-center gap-2">
            <Users size={16} className="text-brand" />
            <h2 className="mds-uppercase-label text-fg-subtle">{t('rosters')}</h2>
            <Badge tone="neutral">{teams.length}</Badge>
          </div>
          {/* The rosters are the tallest thing here (8 teams x 5 players); they scroll in place so
              the cockpit stays one screen instead of a column of names next to empty space. */}
          <div className="custom-scrollbar max-h-[420px] space-y-2 overflow-y-auto pr-1">
            {teams.length === 0 ? (
              <p className="rounded-sm border border-dashed border-line px-3 py-3 text-xs text-fg-subtle">
                {t('noTeams')}
              </p>
            ) : (
              teams.map((t: any) => <TeamRosterCard key={t.id} team={t} checkins={checkins} />)
            )}
          </div>
        </aside>

        <section className="col-span-12 space-y-6 lg:col-span-8">
          <Card className="flex h-[360px] flex-col overflow-hidden p-0">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
              <div className="flex items-center gap-2">
                <GitBranch size={16} className="text-brand" />
                <h2 className="text-sm font-bold">{t('bracketMap')}</h2>
                <span className="hidden text-xs text-fg-subtle lg:block">{t('bracketMapHint')}</span>
              </div>
              <a
                href={`/tournaments/${tournament.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand hover:underline"
              >
                {t('fullBracket')} <ExternalLink size={12} />
              </a>
            </div>
            <div className="relative flex-1">
              {matches.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
                  <Trophy size={26} className="text-fg-subtle" />
                  <p className="text-sm text-fg-muted">{t('noBracket')}</p>
                </div>
              ) : (
                <PublicBracket
                  tournamentId={tournament.id}
                  matches={matches}
                  onMatchClick={(id: string) => {
                    const m = matches.find((mm) => mm.id === id);
                    if (m) onOpenMatchModal(m);
                  }}
                />
              )}
            </div>
          </Card>

          {/* Who can actually be told, before the first match is called — and the kill switch
              for DMs, which is why it sits on the cockpit rather than behind Settings. */}
          <DiscordReachPanel tournamentId={tournament.id} />

          <EonBridgePanel tournamentId={tournament.id} />
        </section>
      </div>
    </div>
  );
}
