"use client";

import React from 'react';
import Image from 'next/image';

import Link from 'next/link';
import { getTournamentTabItems } from '@/components/tournament/tournament-tabs-config';
import { useTranslations } from 'next-intl';

interface LiveMatchCardProps {
  match: any;
  tournamentId: string;
  /** Stage this match belongs to ("Quarter-Finals"), from the caller that has every match. */
  stageName?: string;
  /** The tournament's category, so the card links at a tab this tournament actually has. */
  category?: string;
}

/**
 * `showLogoSlot` is decided once per card, not per row: if neither team has a logo the slot is
 * gone for both, and if either does it is held empty for both. Conditioning row by row is what
 * ships a ragged left edge inside one card.
 */
function TeamRow({
  team,
  score,
  leading,
  showLogoSlot,
}: {
  team: any;
  score: number;
  leading: boolean;
  showLogoSlot: boolean;
}) {
  const tCommon = useTranslations('common');

  return (
    <div className="flex items-center gap-3">
      {showLogoSlot && (
        <div className="relative h-7 w-7 shrink-0 overflow-hidden rounded">
          {team?.logoUrl && <Image src={team.logoUrl} alt="" fill className="object-contain p-1" />}
        </div>
      )}
      <span className="mds-name min-w-0 flex-1 text-sm text-fg">
        {team?.name || tCommon('tbd')}
      </span>
      <span
        className={`mds-numeric text-2xl font-bold ${
          leading ? 'text-fg' : 'text-fg-subtle'
        }`}
      >
        {score}
      </span>
    </div>
  );
}

/**
 * A live match as a scoreboard row-pair: name left, score right, so a club name has the whole
 * card width and never has to become "Tea…". The old card put a 130px logo box on either side
 * of the score, which on a phone left about 40px for each name.
 */
const LiveMatchCard: React.FC<LiveMatchCardProps> = ({ match, tournamentId, stageName, category }) => {
  const t = useTranslations('tournament');
  const tStatus = useTranslations('status');
  const meta = [stageName, match.bestOf > 1 ? `Bo${match.bestOf}` : null].filter(Boolean).join(' · ');
  const showLogoSlot = Boolean(match.homeTeam?.logoUrl || match.awayTeam?.logoUrl);

  // Never a hardcoded `?tab=bracket`: a BATTLE_ROYALE tournament has no bracket tab, TournamentView
  // only honours tabs it actually renders, and this control was already dead in those.
  const bracketTab = getTournamentTabItems(category || 'BRACKET')[1]?.id ?? 'bracket';
  const label = `${t('bracket.open')} — ${match.homeTeam?.name ?? ''} ${match.awayTeam?.name ?? ''}`.trim();

  return (
    // The card is the link. A full-width button under a card that is entirely about one match is
    // a second tap target for the only thing the card does.
    <Link
      href={`/tournaments/${tournamentId}?tab=${bracketTab}`}
      aria-label={label}
      className="mds-card flex flex-col gap-4 p-5 transition-colors hover:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="mds-uppercase-label text-[10px]">{meta}</span>
        <span className="mds-uppercase-label flex items-center gap-2 rounded-full border border-danger px-2.5 py-0.5 text-[10px] text-danger">
          <span className="h-1.5 w-1.5 rounded-full bg-danger animate-pulse" />
          {tStatus('live')}
        </span>
      </div>

      <div className="space-y-3">
        <TeamRow
          team={match.homeTeam}
          score={match.homeScore}
          leading={match.homeScore >= match.awayScore}
          showLogoSlot={showLogoSlot}
        />
        <TeamRow
          team={match.awayTeam}
          score={match.awayScore}
          leading={match.awayScore >= match.homeScore}
          showLogoSlot={showLogoSlot}
        />
      </div>
    </Link>
  );
};

export default LiveMatchCard;
