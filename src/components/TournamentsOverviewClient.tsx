"use client";

import React from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { Loader2, Search, Gamepad2 } from "lucide-react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { getGameMetadata, teamSizeLabel } from "@/lib/games";
import { clientApi } from "@/lib/client-api";
import { STAGE_META, STAGE_ORDER, type TournamentStage } from "@/lib/tournament-stage";
import { STAGE_KEY } from "@/lib/stage-keys";
import { EmptyState, PageHeader, TournamentCard } from "@/components/ui";

// Same tone map the landing page uses for its stage badges (src/app/page.tsx), so a
// tournament reads identically on both boards.
const STAGE_TONE: Record<TournamentStage, "neutral" | "info" | "live" | "done"> = {
  DRAFT: "neutral",
  REGISTRATION: "info",
  LIVE: "live",
  COMPLETE: "done",
};

interface DirectoryRow {
  id: string;
  name: string;
  game: string;
  format?: string | null;
  teamSize: number;
  stage?: string | null;
  _count?: { teams?: number; matches?: number };
}

export default function TournamentsOverviewClient() {
  const t = useTranslations("directory");
  const tc = useTranslations("common");
  const tStage = useTranslations("stage");
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const searchQuery = searchParams.get("search") || "";
  const stageFilter = (searchParams.get("stage") || "").toUpperCase();
  const { data: session } = useSession();
  const role = (session?.user as { role?: string } | undefined)?.role;
  const isStaff = role === "admin" || role === "marshal";

  const { data, isLoading } = useQuery({
    queryKey: ["tournaments"],
    queryFn: async () => clientApi.getTournaments("all"),
    staleTime: 60 * 1000,
  });

  const tournaments: DirectoryRow[] = data?.tournaments || [];

  const setParam = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams);
    if (value) params.set(key, value);
    else params.delete(key);
    router.replace(`${pathname}?${params.toString()}`);
  };

  // Match the name the card *prints* as well as the enum behind it. The card showed
  // "Counter-Strike 2" while this only tested `row.game` ("CS2"), so a kid typing "counter" got
  // the no-results state for a board full of Counter-Strike.
  const matchesSearch = (row: DirectoryRow) => {
    const q = searchQuery.toLowerCase();
    if (!q) return true;
    return (
      row.name.toLowerCase().includes(q) ||
      row.game.toLowerCase().includes(q) ||
      (getGameMetadata(row.game)?.name || "").toLowerCase().includes(q)
    );
  };

  const searched = tournaments.filter(matchesSearch);
  /** More than one game on the *unfiltered* board, so the eyebrow says something. */
  const multiGame = new Set(tournaments.map((row) => row.game)).size > 1;
  const filtered = stageFilter
    ? searched.filter((row) => String(row.stage || "").toUpperCase() === stageFilter)
    : searched;

  // Counts come from the data, so a filter is never offered for a bucket that is empty.
  //
  // UTKAST is filtered out for players: "draft" is organizer vocabulary for a tournament a kid
  // cannot enter, offered as something to go and look at. The cards themselves stay, badge and
  // all — a kid who scrolls past one should still see what it is; only the invitation goes.
  const stageCounts = STAGE_ORDER.map((stage) => ({
    stage,
    count: searched.filter((row) => String(row.stage || "").toUpperCase() === stage).length,
  })).filter((s) => s.count > 0 && (isStaff || s.stage !== "DRAFT"));

  // Board order, not lifecycle order: what is being played outranks what someone might sign up
  // for, which outranks a draft nobody can enter, which outranks a tournament already decided.
  const BOARD_ORDER: TournamentStage[] = ["LIVE", "REGISTRATION", "DRAFT", "COMPLETE"];
  const rank = (row: DirectoryRow) => {
    const i = BOARD_ORDER.indexOf(String(row.stage || "DRAFT").toUpperCase() as TournamentStage);
    return i === -1 ? BOARD_ORDER.length : i;
  };
  const cards = [...filtered].sort((a, b) => rank(a) - rank(b));

  // Is there anything on this server at all (before search/stage filtering)? If not, the
  // filter field and the stage chips are hidden: controls for a board that does not exist.
  const hasAny = tournaments.length > 0;
  /**
   * Both the search box and the chip row earn their space only on a board big enough to need
   * them. Six is the threshold: below it every tournament is on screen already, and a filter
   * over a list you can see is furniture.
   *
   * The `searchQuery` half of the search gate is not optional. Honouring `?search=` while
   * hiding the input produces a board filtered to nothing, a "remove the filter" line, and no
   * input to remove it in. And both gates test the PRE-filter length, never `filtered.length`,
   * or the controls delete themselves mid-keystroke.
   */
  const showSearch = searched.length > 6 || searchQuery.length > 0;
  const showChips = hasAny && searched.length > 6 && stageCounts.length > 1;

  return (
    <div className="flex min-h-screen flex-col bg-page text-fg">
      {/* Title, search, chips. The "OVERSIKT" eyebrow named the page the reader is on, the
          subtitle described a list they can see, and the red "2 spilles nå" meta line was the
          same data as the LIVE filter chip below it — except the chip also does something. */}
      <PageHeader
        title={tc("tournaments")}
        actions={
          hasAny && showSearch ? (
            <div className="relative w-full sm:w-72">
              <label htmlFor="directory-filter" className="sr-only">
                {t("filterLabel")}
              </label>
              <Search
                size={15}
                aria-hidden
                className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle"
              />
              <input
                id="directory-filter"
                type="search"
                placeholder={t("filterPlaceholder")}
                value={searchQuery}
                onChange={(e) => setParam("search", e.target.value)}
                className="mds-input pl-9"
              />
            </div>
          ) : undefined
        }
      />

      <main className="mds-container flex flex-1 flex-col gap-6 py-8">
        {showChips && (
          <div className="mds-section-head">
            {/* No "TAVLA" heading. It was ~90px of a 358px row, read as a fourth chip that does
                not tap, and in this app's Norwegian *tavla* is the crew board — so it pointed a
                kid at a screen they cannot open. The group keeps the accessible name the
                heading was carrying, and is now actually wired to the chips. */}
            <div
              className="flex flex-wrap items-center gap-2"
              role="group"
              aria-label={t("filterLabel")}
            >
              <FilterChip label={t("all")} count={searched.length} active={!stageFilter} onClick={() => setParam("stage", "")} />
              {stageCounts.map(({ stage, count }) => (
                <FilterChip
                  key={stage}
                  label={tStage(STAGE_KEY[stage])}
                  count={count}
                  tone={stage === "LIVE" ? "live" : undefined}
                  active={stageFilter === stage}
                  onClick={() => setParam("stage", stageFilter === stage ? "" : stage)}
                />
              ))}
            </div>
            {/* No count badge. It equals the active chip's own count in every reachable state,
                and on a phone the section head wraps, so it took a row of its own and pushed
                the first tournament's name down. */}
          </div>
        )}

        {isLoading ? (
          <div className="flex flex-col items-center justify-center gap-4 py-32">
            <Loader2 className="h-8 w-8 animate-spin text-brand" aria-hidden />
            <p className="mds-uppercase-label text-fg-subtle">{t("loading")}</p>
          </div>
        ) : cards.length === 0 ? (
          <EmptyState
            className="flex-1"
            icon={<Gamepad2 size={24} />}
            title={searchQuery || stageFilter ? t("noResultsTitle") : t("emptyTitle")}
            description={
              searchQuery || stageFilter ? t("noResultsBody") : t("emptyBody")
            }
          />
        ) : (
          <ul className="mds-card-grid">
            {/* `row`, not `t`: `t` is the translator in this scope. */}
            {cards.map((row) => {
              const gameMeta = getGameMetadata(row.game);
              // `stage` is derived server-side (GET /api/tournaments and the SSR prefetch).
              const stage: TournamentStage | null =
                row.stage && row.stage in STAGE_META ? (row.stage as TournamentStage) : null;
              return (
                <li key={row.id}>
                  <TournamentCard
                    href={`/tournaments/${row.id}`}
                    name={row.name}
                    game={multiGame ? gameMeta?.name || row.game : undefined}
                    format={row.format === "DOUBLE_ELIMINATION" ? "Double elim" : "Single elim"}
                    roster={teamSizeLabel(gameMeta, row.teamSize)}
                    teamCount={row._count?.teams ?? 0}
                    stageLabel={tStage(STAGE_KEY[stage ?? "DRAFT"])}
                    stageTone={stage ? STAGE_TONE[stage] : "neutral"}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </main>

    </div>
  );
}

/** A stage filter. Only rendered for stages that actually have tournaments in them. */
function FilterChip({
  label,
  count,
  active,
  tone,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  tone?: "live";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`mds-badge border transition-colors ${
        active
          ? "border-brand-line bg-brand-soft text-brand"
          : tone === "live"
            ? "border-live/40 bg-tint text-live hover:bg-tint-strong"
            : "border-line bg-tint text-fg-muted hover:bg-tint-strong hover:text-fg"
      }`}
    >
      {label}
      <span className="mds-tabular opacity-60">{count}</span>
    </button>
  );
}
