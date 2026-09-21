"use client";

import React from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { byPlayOrder, isDone, isLive, matchStatusKey } from "@/lib/match-status";
import { matchRef, matchStatusTone, slotLabel, stageName } from "./match-labels";

interface MatchListProps {
  matches: any[];
  tournamentId: string;
}

/**
 * One side of a match.
 *
 * The logo slot is held for every row in the list, empty and borderless when a team has no
 * logo — a bordered box with a grey trophy in it was ~36px of a phone card spent saying "this
 * team did not upload a picture", and conditioning the slot row by row instead ships a ragged
 * left edge down the card.
 *
 * `showScore` is decided by the caller from the match, not from this row: a match with no
 * result prints nothing rather than a `0`, and nothing rather than a dash — an em dash is
 * another glyph to read, and it is not what a score looks like.
 */
function TeamRow({
  team,
  name,
  score,
  won,
  dim,
  showScore,
}: {
  team: any;
  name: string;
  score: number;
  won: boolean;
  dim: boolean;
  showScore: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="relative h-6 w-6 shrink-0 overflow-hidden rounded-sm">
        {team?.logoUrl && <Image src={team.logoUrl} alt="" fill className="object-contain p-0.5" />}
      </div>
      <span
        className={`mds-name min-w-0 flex-1 text-[13px] ${
          dim || !team?.name ? "text-fg-subtle" : "text-fg"
        }`}
      >
        {name}
      </span>
      {showScore && (
        <span
          className={`mds-numeric text-lg font-bold ${won ? "text-brand" : "text-fg-subtle"}`}
        >
          {score}
        </span>
      )}
    </div>
  );
}

export function MatchList({ matches, tournamentId }: MatchListProps) {
  const t = useTranslations("tournament");
  const tStage = useTranslations("stage");
  const tCommon = useTranslations("common");
  const tStatus = useTranslations("status");
  // Grouped by stage in play order — in a double-elimination bracket "round 1" is two different
  // stages (winners and losers), so grouping by the round number mixed them into one heading.
  const groups: { label: string; matches: any[] }[] = [];
  matches
    .slice()
    .sort(byPlayOrder)
    .forEach((match: any) => {
      const label = stageName(match, matches, tStage);
      const group = groups.find((g) => g.label === label);
      if (group) {
        group.matches.push(match);
      } else {
        groups.push({ label, matches: [match] });
      }
    });

  return (
    <div
      data-testid="public-match-board"
      className="space-y-10 animate-in fade-in duration-500"
    >
      {groups.map(({ label, matches: roundMatches }) => {
        return (
          <section key={label} className="space-y-4">
            <div className="flex items-center gap-4">
              {/* The stage a spectator knows the round by, not "Round 3". */}
              <h2 className="m-0 text-base font-bold tracking-tight">{label}</h2>
              <div className="h-px flex-1 bg-line" />
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {roundMatches.map((match: any) => {
                const live = isLive(match.status);
                // "Has a result", not "is live or done". A match reopened for a replay keeps its
                // scores while its status goes back to READY, and a status string nobody
                // enumerated must never be able to hide a score that exists.
                const hasResult =
                  live || isDone(match.status) || match.homeScore !== 0 || match.awayScore !== 0;
                const homeWon = Boolean(match.winnerId) && match.winnerId === match.homeTeam?.id;
                const awayWon = Boolean(match.winnerId) && match.winnerId === match.awayTeam?.id;

                return (
                  <div
                    key={match.id}
                    data-testid={`public-match-${match.id}`}
                    className={`mds-card flex flex-col gap-3 p-4 ${
                      live ? "border-danger" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      {/* The same short reference other views point at ("Winner of QF3"). */}
                      <span className="mds-uppercase-label text-[10px]">
                        {matchRef(match, matches, tStage)}
                        {match.bestOf > 1 ? ` · BO${match.bestOf}` : ""}
                      </span>
                      <span
                        data-testid="public-match-status"
                        className={`mds-badge shrink-0 border ${matchStatusTone(match.status)} ${
                          live ? "animate-pulse" : ""
                        }`}
                      >
                        {tStatus(matchStatusKey(match.status))}
                      </span>
                    </div>

                    <div className="space-y-2">
                      <TeamRow
                        team={match.homeTeam}
                        name={slotLabel(match, "HOME", matches, t, tCommon, tStage)}
                        score={match.homeScore}
                        won={homeWon}
                        dim={awayWon}
                        showScore={hasResult}
                      />
                      <TeamRow
                        team={match.awayTeam}
                        name={slotLabel(match, "AWAY", matches, t, tCommon, tStage)}
                        score={match.awayScore}
                        won={awayWon}
                        dim={homeWon}
                        showScore={hasResult}
                      />
                    </div>

                  </div>
                );
              })}
            </div>
          </section>
        );
      })}

      {matches.length === 0 && (
        <p className="text-sm text-fg-muted">{t("match.none")}</p>
      )}
    </div>
  );
}
