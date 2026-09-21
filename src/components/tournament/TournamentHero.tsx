"use client";

import React from "react";
import Image from "next/image";
import { Share2, ArrowRight } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { formatName } from "./match-labels";

interface TournamentHeroProps {
  tournament: any;
  teamsCount: number;
  matchesCount: number;
  liveMatchesCount: number;
  gameMeta: any;
  onShare: () => void;
  /** Which tab is showing. The live pill is tab-aware, not breakpoint-aware — see below. */
  activeTab: string;
  /** Where the live pill jumps to. Omitted when nothing is live. */
  onGoToLive?: () => void;
}

/**
 * One compact identification bar, not a poster. The spectator came for the live match, so the
 * hero's job is to say which tournament this is and get out of the way — on a phone it is a
 * single band above the tabs instead of the ~700px of stock key art it used to be.
 */
export function TournamentHero({
  tournament,
  teamsCount,
  matchesCount,
  liveMatchesCount,
  gameMeta,
  onShare,
  activeTab,
  onGoToLive,
}: TournamentHeroProps) {
  const t = useTranslations("tournament");
  const tStage = useTranslations("stage");
  const canRegister = Boolean(tournament?.steamSignupEnabled) && !Boolean(tournament?.rosterLocked);
  const format = formatName(tournament?.format || tournament?.type, tStage);

  return (
    <header className="relative w-full shrink-0 overflow-hidden border-b border-line bg-card">
      {/* Game art as texture only, and only where there is room for it. */}
      {gameMeta?.bannerUrl ? (
        <div className="absolute inset-0 z-0 hidden lg:block" aria-hidden>
          <Image
            src={gameMeta.bannerUrl}
            fill
            className="object-cover opacity-[0.07] grayscale"
            alt=""
            style={{ objectPosition: gameMeta?.bannerPosition || "center" }}
            priority
          />
          <div className="absolute inset-0 bg-gradient-to-r from-card via-card to-transparent" />
        </div>
      ) : null}

      <div className="relative z-10 mx-auto flex max-w-content flex-col gap-3 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:gap-8 lg:px-10 lg:py-5">
        <div className="flex min-w-0 items-center gap-3 lg:gap-4">
          {gameMeta?.logoUrl ? (
            <div className="hidden h-11 w-11 shrink-0 items-center justify-center rounded border border-line bg-field p-1.5 sm:flex">
              <Image
                src={gameMeta.logoUrl}
                width={32}
                height={32}
                className="h-full w-full object-contain"
                alt={gameMeta?.name || tournament.game}
              />
            </div>
          ) : null}

          <div className="min-w-0">
            <h1 className="mds-name-lg m-0 text-xl leading-tight lg:text-[28px]">{tournament.name}</h1>
            <p className="m-0 mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-fg-subtle">
              <span>{gameMeta?.name || tournament.game}</span>
              {format ? (
                <>
                  <span aria-hidden>·</span>
                  <span>{format}</span>
                </>
              ) : null}
              {/* Game and format at every width: "Enkel utslagning" is the only public sentence
                  that tells a kid one loss ends their night. The two counts are desktop-only —
                  every tab below states them in a form you can act on, and on a 390px header
                  this line was four segments deep before the tournament's own name had room. */}
              <span className="hidden sm:inline" aria-hidden>·</span>
              <span className="mds-numeric hidden sm:inline">
                {t("hero.teams", { count: teamsCount })}
              </span>
              <span className="hidden sm:inline" aria-hidden>·</span>
              <span className="mds-numeric hidden sm:inline">
                {t("hero.matches", { count: matchesCount })}
              </span>
            </p>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {/* Tab-aware, not breakpoint-aware. On Oversikt the section header 35px below says
              "SPILLES NÅ" with the team names attached, so the pill is pure repetition there —
              but on Lag and Spillere it is the only live signal on the screen, and a
              `hidden lg:flex` gate would have deleted it from exactly the phone that needs it.
              Borderless and still, matching that section header: a pulsing outlined pill and a
              pulsing dot in the same viewport are two alarms for one fact. It is a button now,
              so the thing it announces is one tap away. */}
          {liveMatchesCount > 0 && activeTab !== "overview" && (
            <button
              type="button"
              onClick={onGoToLive}
              className="mds-uppercase-label mds-tap flex items-center gap-2 rounded-sm px-1 text-[10px] text-danger transition-colors hover:bg-tint"
            >
              <span className="mds-dot is-live" aria-hidden />
              {t("hero.liveNow")}
            </button>
          )}
          {/* Share is desktop-only here; below `lg` it lives in the "Mer" sheet, where a kid can
              find it beside the other things this page can do. */}
          <button onClick={onShare} className="mds-btn-secondary hidden h-9 px-4 text-xs lg:inline-flex">
            <Share2 size={14} />
            {t("hero.share")}
          </button>
          {canRegister && (
            <Link href={`/tournaments/${tournament.id}/register`} className="mds-btn-primary h-9 px-4 text-xs">
              {t("hero.registerTeam")}
              <ArrowRight size={14} />
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
