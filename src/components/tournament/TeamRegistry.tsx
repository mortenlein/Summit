"use client";

import React, { useState } from "react";
import Image from "next/image";
import { Search, ArrowRight } from "lucide-react";
import { useTranslations } from "next-intl";

interface TeamRegistryProps {
  teams: any[];
  onViewTeam: (team: any) => void;
}

export function TeamRegistry({ teams, onViewTeam }: TeamRegistryProps) {
  const t = useTranslations("tournament");
  const tCommon = useTranslations("common");
  const [search, setSearch] = useState("");

  const filteredTeams = teams.filter((t: any) =>
    t.name.toLowerCase().includes(search.toLowerCase())
  );
  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      {/* On a phone the heading and its rule pushed the first team name to roughly halfway down
          the screen, to say "Lag" on the tab already labelled Lag. It survives for a screen
          reader, and reappears at `md` where there is room — at `text-lg`, because `text-2xl`
          made it larger than every sibling heading in the app.
          No counts line either: it said "8 påmeldt · 40 spillere" over a grid the kid can
          count, and it read `teams` rather than `filteredTeams`, so searching left it
          insisting there were still 8. */}
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between md:border-b md:border-line md:pb-6">
        <div>
          <h2 className="m-0 text-lg font-bold tracking-tight sr-only md:not-sr-only">
            {tCommon("teams")}
          </h2>
        </div>
        <div className="group relative w-full md:w-80">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle transition-colors group-focus-within:text-brand" />
          <input
            type="text"
            placeholder={t("registry.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="mds-input h-10 w-full !pl-10 text-sm"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {filteredTeams.map((team: any) => (
          <div
            key={team.id}
            className="mds-card relative flex flex-col gap-4 p-5 transition-colors focus-within:border-brand hover:border-brand"
          >
            <div className="flex items-start gap-3">
              {/* Only when there is something to show. An empty bordered box with a grey glyph
                  in it spent ~52px of every card saying "no picture uploaded", and pushed the
                  player-count badge at the card's right edge. */}
              {team.logoUrl && (
                <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded">
                  <Image src={team.logoUrl} alt="" fill className="object-contain p-1.5" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                {/*
                  The name row is the button, and an absolutely-positioned ::after stretches its
                  hitbox over the whole card. The card itself cannot be a <button>: it contains
                  an <h3> and a <ul>, which is invalid inside one.
                */}
                <h3 className="mds-name-lg m-0 text-base leading-snug">
                  {/* No aria-label here. One on the button would become the *heading's* name
                      too, so the heading would announce "Seed 7 – detaljer" instead of the team
                      name. A button whose name is the team, inside the heading, announces as
                      "Seed 7, button" — which says both things without renaming either. */}
                  <button
                    type="button"
                    onClick={() => onViewTeam(team)}
                    className="text-left after:absolute after:inset-0 after:content-[''] focus:outline-none"
                  >
                    {team.name}
                  </button>
                </h3>
                {/* Seeding and the player count on one quiet line. The count used to be the
                    loudest blue on the card, in the exact `bg-brand-soft text-brand` the seat
                    pills below it use — and on this surface blue has to mean seat. A team with
                    no seed says nothing rather than "Seeding —" on every card before the draw. */}
                <p className="mds-uppercase-label m-0 mt-1 text-[10px] text-fg-subtle">
                  {team.seed ? (
                    <>
                      <span className="mds-numeric">#{team.seed}</span>
                      {" · "}
                    </>
                  ) : null}
                  {t("registry.playerBadge", { count: team.players?.length || 0 })}
                </p>
              </div>
              <ArrowRight
                size={16}
                aria-hidden
                className="mt-1 shrink-0 text-fg-subtle"
              />
            </div>

            {/* Every player, seat first. A "+1" tile in place of the fifth player helped nobody. */}
            <ul className="m-0 list-none space-y-1.5 p-0">
              {team.players?.map((p: any, idx: number) => (
                <li key={p.id || idx} className="flex items-center gap-2 py-1">
                  <span
                    className={`mds-numeric shrink-0 rounded-sm px-1.5 py-0.5 text-[10px] font-bold ${
                      p.seating
                        ? "bg-brand-soft text-brand"
                        : "bg-line text-fg-subtle"
                    }`}
                  >
                    {p.seating || "—"}
                  </span>
                  <span className="mds-name min-w-0 flex-1 text-[12px] text-fg-muted">
                    {p.nickname || p.name}
                  </span>
                </li>
              ))}
              {!team.players?.length && (
                <li className="text-[12px] text-fg-subtle">{t("team.noPlayers")}</li>
              )}
            </ul>
          </div>
        ))}
      </div>

      {/* Two different nothings. "Ingen treff på «»" for a tournament nobody has signed up to
          yet is a search result for a search the kid never ran. */}
      {filteredTeams.length === 0 && (
        <p className="text-sm text-fg-muted">
          {search.trim() ? t("registry.noMatch", { search }) : t("registry.empty")}
        </p>
      )}
    </div>
  );
}
