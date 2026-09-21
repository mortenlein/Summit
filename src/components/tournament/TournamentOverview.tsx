"use client";

import React from "react";
import Image from "next/image";
import { ArrowRight, Trophy } from "lucide-react";
import { useTranslations } from "next-intl";
import LiveMatchCard from "@/components/LiveMatchCard";
import { isDone, isLive, byPlayOrder } from "@/lib/match-status";
import { currentStageProgress, slotLabel, stageName } from "./match-labels";

interface TournamentOverviewProps {
  tournament: any;
  teams: any[];
  matches: any[];
  liveMatches: any[];
  onViewTeam: (team: any) => void;
  onSetTab: (tab: string) => void;
}

export function TournamentOverview({
  tournament,
  teams,
  matches,
  liveMatches,
  onViewTeam,
  onSetTab,
}: TournamentOverviewProps) {
  const t = useTranslations("tournament");
  const tStage = useTranslations("stage");
  const tCommon = useTranslations("common");
  const progress = currentStageProgress(matches, tStage);
  /** One answer for the whole chip grid — see the comment where the chips are rendered. */
  const anyTeamLogo = teams.some((team: any) => Boolean(team.logoUrl));
  const upNext = matches
    .filter((m: any) => !isDone(m.status) && !isLive(m.status))
    .sort(byPlayOrder)
    .slice(0, 4);

  // A champion is only real once the deciding match is played — and the 3rd place match is
  // never the deciding one, however late it is played.
  const decider = matches
    .filter((m: any) => (m.bracketType || "WINNERS").toUpperCase() !== "THIRD_PLACE")
    .sort(byPlayOrder)
    .slice(-1)[0];
  const champion =
    decider && isDone(decider.status) && decider.winnerId
      ? [decider.homeTeam, decider.awayTeam].find((t: any) => t?.id === decider.winnerId) || null
      : null;

  const stageLine = champion
    ? t("overview.won", { team: champion.name, stage: stageName(decider, matches, tStage) })
    : progress
      ? t("overview.progress", {
          stage: progress.label,
          played: progress.played,
          total: progress.total,
        })
      : matches.length === 0
        ? t("overview.notGenerated")
        : t("overview.allPlayed");

  return (
    <div className="space-y-10 animate-in fade-in duration-500">
      {/* What is happening right now — the reason a spectator opened the page. */}
      {liveMatches.length > 0 && (
        <section className="space-y-4">
          <div className="flex items-center gap-3">
            <span className="h-1.5 w-1.5 rounded-full bg-danger animate-pulse" />
            <h2 className="mds-uppercase-label m-0 text-danger">{t("hero.liveNow")}</h2>
            <div className="h-px flex-1 bg-gradient-to-r from-danger to-transparent" />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {liveMatches.map((match: any) => (
              <LiveMatchCard
                key={match.id}
                match={match}
                tournamentId={tournament.id}
                category={tournament.category}
                stageName={stageName(match, matches, tStage)}
              />
            ))}
          </div>
        </section>
      )}

      {upNext.length > 0 && (
        <section className="space-y-4">
          <div className="flex items-center gap-3">
            <h2 className="mds-uppercase-label m-0">{t("upNext")}</h2>
            <div className="h-px flex-1 bg-line" />
            <button
              onClick={() => onSetTab("matches")}
              className="mds-uppercase-label text-[10px] text-brand hover:underline"
            >
              {t("overview.allMatches")}
            </button>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {upNext.map((match: any) => (
              <div
                key={match.id}
                className="rounded border border-line bg-card p-4"
              >
                <span className="mds-uppercase-label text-[10px]">{stageName(match, matches, tStage)}</span>
                <div className="mt-1.5 space-y-0.5 text-sm">
                  <p className="mds-name m-0">{slotLabel(match, "HOME", matches, t, tCommon, tStage)}</p>
                  <p className="mds-name m-0 text-fg-muted">{slotLabel(match, "AWAY", matches, t, tCommon, tStage)}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section data-testid="tournament-overview" className="mds-card p-6 lg:p-8">
        <div className="mb-6 flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
          <div className="min-w-0">
            {/* Named for what it holds. A card titled after the page it sits on says nothing. */}
            <h2 className="m-0 text-xl font-bold tracking-tight">{t("overview.field")}</h2>
            {/* Where the bracket actually is, instead of a decorative "29%" progress bar. */}
            <p className="m-0 mt-1 text-sm text-fg-muted">{stageLine}</p>
          </div>
          <button
            onClick={() => onSetTab("teams")}
            className="mds-btn-secondary h-9 shrink-0 px-4 text-xs"
          >
            {t("overview.viewAllTeams")}
            <ArrowRight size={14} />
          </button>
        </div>

        {champion ? (
          <div className="mb-6 flex items-center gap-3 rounded border border-brand bg-brand-soft px-4 py-3">
            <Trophy size={18} className="shrink-0 text-brand" />
            <div className="min-w-0">
              <span className="mds-uppercase-label text-[10px]">{t("overview.champion")}</span>
              <p className="mds-name m-0 text-base text-fg">{champion.name}</p>
            </div>
          </div>
        ) : null}

        {/* Teams as named chips: a grid of anonymous logo squares told a spectator nothing.
            The logo slot is decided once for the whole grid — if no team in this tournament
            uploaded one, it is gone for all of them; if any did, it is held empty for all.
            Deciding chip by chip is what ships a ragged left edge down three columns. The chips
            are also taller than they were, because at ~36px they were under a thumb. */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {teams.map((team: any) => (
            <button
              key={team.id}
              type="button"
              onClick={() => onViewTeam(team)}
              className="mds-tap flex min-h-11 items-center gap-3 rounded border border-line bg-field px-3 py-2.5 text-left transition-colors hover:border-brand"
            >
              {anyTeamLogo && (
                <div className="relative h-6 w-6 shrink-0 overflow-hidden rounded-sm">
                  {team.logoUrl && (
                    <Image src={team.logoUrl} alt="" fill className="object-contain p-0.5" />
                  )}
                </div>
              )}
              <span className="mds-name min-w-0 flex-1 text-[13px]">{team.name}</span>
              {team.seed ? (
                <span className="mds-numeric shrink-0 text-[11px] text-fg-subtle">
                  #{team.seed}
                </span>
              ) : null}
            </button>
          ))}
          {teams.length === 0 ? (
            <p className="text-sm text-fg-muted">{t("overview.noTeams")}</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
