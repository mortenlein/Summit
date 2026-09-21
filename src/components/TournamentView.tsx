"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { Trophy, Users, X, Gamepad2, MoreHorizontal, Command, Share2 } from "lucide-react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMatchStream } from "@/hooks/useMatchStream";
import PublicBracket from "@/components/PublicBracket";
import { getGameMetadata } from "@/lib/games";
import { byPlayOrder, isDone, isLive, matchStatusKey } from "@/lib/match-status";
import { clientApi, ApiError } from "@/lib/client-api";
import { useToast } from "@/components/ToastProvider";

// Modular Components
import { TournamentHero } from "./tournament/TournamentHero";
import { TournamentTabs } from "./tournament/TournamentTabs";
import { TournamentOverview } from "./tournament/TournamentOverview";
import { MatchList } from "./tournament/MatchList";
import { TeamRegistry } from "./tournament/TeamRegistry";
import { StatsTable } from "./tournament/StatsTable";
import { getTournamentTabItems } from "./tournament/tournament-tabs-config";
import { currentStageProgress, slotLabel, stageName } from "./tournament/match-labels";
import { openCommandPalette } from "./CommandPalette";
import { usePerformanceBudget } from "@/hooks/usePerformanceBudget";

interface TournamentViewProps {
  id: string;
}

function useModalA11y(
  modalRef: React.RefObject<HTMLDivElement | null>,
  open: boolean,
  onClose: () => void,
  lastFocusedRef: React.MutableRefObject<HTMLElement | null>
) {
  useEffect(() => {
    if (!open) {
      return;
    }

    lastFocusedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = modalRef.current;
    if (!root) {
      return;
    }

    const focusables = root.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    first?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key === "Tab" && focusables.length > 0) {
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      lastFocusedRef.current?.focus();
    };
  }, [lastFocusedRef, modalRef, onClose, open]);
}

export default function TournamentView({ id }: TournamentViewProps) {
  usePerformanceBudget("TournamentView", 240);
  const t = useTranslations("tournament");
  const tStage = useTranslations("stage");
  const tCommon = useTranslations("common");
  const tStatus = useTranslations("status");
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const toast = useToast();
  const [activeTab, setActiveTab] = useState("overview");
  const [selectedTeam, setSelectedTeam] = useState<any>(null);
  const [selectedMatch, setSelectedMatch] = useState<any>(null);
  const [selectedPlayer, setSelectedPlayer] = useState<any>(null);
  const [showMobileTabSheet, setShowMobileTabSheet] = useState(false);
  const teamModalRef = useRef<HTMLDivElement>(null);
  const playerModalRef = useRef<HTMLDivElement>(null);
  const matchModalRef = useRef<HTMLDivElement>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  const { data: tournament } = useQuery({
    queryKey: ['tournament', id],
    queryFn: async () => {
      try {
        return await clientApi.getTournament(id);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    staleTime: Infinity
  });

  const { data: teams = [] } = useQuery({
    queryKey: ['teams', id],
    queryFn: () => clientApi.getTeams(id),
  });

  const { data: matches = [] } = useQuery({
    queryKey: ['matches', id],
    queryFn: () => clientApi.getMatches(id),
  });

  const { data: scoreboard = [] } = useQuery({
    queryKey: ['scoreboard', id],
    queryFn: () => clientApi.getScoreboard(id),
  });

  useMatchStream(id, (data) => {
    queryClient.setQueryData(['matches', id], (prev: any[] | undefined) =>
      prev?.map((m) => (m.id === data.matchId ? { ...m, ...data.match } : m))
    );
  });

  // One status vocabulary (src/lib/match-status.ts), no hand-rolled string comparisons.
  const liveMatches = matches.filter((m: any) => isLive(m.status));
  const upcoming = matches
    .filter((m: any) => !isDone(m.status) && !isLive(m.status))
    .sort(byPlayOrder)
    .slice(0, 5);
  const progress = currentStageProgress(matches, tStage);
  const gameMeta = getGameMetadata(tournament?.game || "CS2");
  const tabItems = getTournamentTabItems(tournament?.category || "BRACKET");
  const primaryMobileTabs = tabItems.slice(0, 4);
  const overflowMobileTabs = tabItems.slice(4);
  const validTabs = useMemo(() => new Set(tabItems.map((tab) => tab.id)), [tabItems]);

  useEffect(() => {
    if (!tournament) {
      return;
    }
    const tabFromUrl = searchParams.get("tab");
    if (tabFromUrl && validTabs.has(tabFromUrl) && tabFromUrl !== activeTab) {
      setActiveTab(tabFromUrl);
    }
  }, [activeTab, searchParams, validTabs, tournament]);

  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", tab);
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  };

  useModalA11y(teamModalRef, Boolean(selectedTeam), () => setSelectedTeam(null), lastFocusedRef);
  useModalA11y(playerModalRef, Boolean(selectedPlayer), () => setSelectedPlayer(null), lastFocusedRef);
  useModalA11y(matchModalRef, Boolean(selectedMatch), () => setSelectedMatch(null), lastFocusedRef);

  if (!tournament) {
    return (
      <div className="min-h-screen bg-page p-8 text-fg">
        <div className="mx-auto mt-20 max-w-xl rounded-lg border border-line bg-card p-8 text-center">
          <h1 className="m-0 text-2xl font-bold tracking-tight">{t("notFound.title")}</h1>
          <p className="mt-3 text-sm text-fg-muted">{t("notFound.body")}</p>
          <Link href="/tournaments" className="mds-btn-primary mt-6 h-10 px-6 text-sm">
            {t("notFound.back")}
          </Link>
        </div>
      </div>
    );
  }

  /**
   * Share the page.
   *
   * `navigator.share` where the platform has it — which is every phone this will be opened on,
   * and it is what makes moving this control into the "Mer" sheet a net win rather than a
   * demotion: one extra tap buys the real share sheet instead of a clipboard copy a kid then
   * has to paste somewhere. Clipboard is the fallback, and an abort (they closed the sheet) is
   * not an error.
   */
  const handleShare = async () => {
    const url = typeof window !== "undefined" ? window.location.href : "";
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({ title: tournament?.name || "Summit", url });
        return;
      } catch (error: any) {
        if (error?.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t("share.copiedTitle"), t("share.copiedBody"));
    } catch {
      // A browser that refuses both is one the kid can still copy the address bar from.
    }
  };

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden bg-page antialiased text-fg">
      <TournamentHero
        tournament={tournament}
        teamsCount={teams.length}
        matchesCount={matches.length}
        liveMatchesCount={liveMatches.length}
        gameMeta={gameMeta}
        activeTab={activeTab}
        onGoToLive={liveMatches.length > 0 ? () => handleTabChange("overview") : undefined}
        onShare={handleShare}
      />

      {/* The only tournament navigation on desktop; phones get the bottom bar below. */}
      <TournamentTabs
        activeTab={activeTab}
        setActiveTab={handleTabChange}
        tournamentCategory={tournament.category}
      />

      <div className="flex flex-1 overflow-hidden">
        <main className="custom-scrollbar flex-1 overflow-y-auto px-4 py-6 pb-28 sm:px-6 lg:px-10 lg:pb-10">
          <div className="mx-auto max-w-content">

            {activeTab === "overview" && (
              <TournamentOverview
                tournament={tournament}
                teams={teams}
                matches={matches}
                liveMatches={liveMatches}
                onViewTeam={setSelectedTeam}
                onSetTab={handleTabChange}
              />
            )}

            {activeTab === "bracket" && tournament.category !== 'BATTLE_ROYALE' && (
              <div className="animate-in fade-in duration-500">
                {/* This tab had no empty guard at all, so before the draw it rendered an empty
                    grid and then instructed the kid to pinch it. */}
                {matches.length === 0 ? (
                  <div className="mds-card flex min-h-[220px] flex-col items-center justify-center gap-2 p-8 text-center">
                    <Trophy size={26} className="text-fg-subtle" />
                    <p className="m-0 text-sm text-fg-muted">{t("overview.notGenerated")}</p>
                  </div>
                ) : (
                  <>
                    {/* Taller than it was: the canvas no longer shrinks the bracket to fit, so
                        the height is what decides how much of it a kid sees at once. */}
                    <div className="mds-card h-[60vh] min-h-[420px] overflow-hidden p-0 lg:h-[68vh]">
                      <PublicBracket
                        tournamentId={id}
                        matches={matches}
                        onMatchClick={(matchId: string) => setSelectedMatch(matches.find((m: any) => m.id === matchId))}
                      />
                    </div>
                    {/* The "tap a match for details" half is gone — the node has a pressed state
                        now, which says it better than a sentence. The pan clause stays: the tree
                        deliberately overflows, and nothing else on the canvas admits that. */}
                    <p className="m-0 mt-2 text-xs text-fg-subtle lg:hidden">{t("bracket.panHint")}</p>
                  </>
                )}
              </div>
            )}

            {activeTab === "leaderboard" && (
              <div className="space-y-4">
                <h2 className="m-0 text-xl font-bold tracking-tight">{t("leaderboard.title")}</h2>
                {scoreboard.length === 0 ? (
                  <div className="mds-card border-dashed text-center">
                    <p className="text-sm text-fg-muted">{t("leaderboard.empty")}</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto rounded-lg border border-line">
                    <table className="mds-table min-w-full">
                      <thead>
                        <tr>
                          <th>{tCommon("team")}</th>
                          <th>{t("leaderboard.points")}</th>
                          <th>{t("leaderboard.kills")}</th>
                          <th>{t("leaderboard.placement")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {scoreboard.map((entry: any, index: number) => (
                          <tr key={entry.id || `${entry.teamId}-${index}`}>
                            <td><span className="mds-name">{entry.team?.name || t("leaderboard.unknownTeam")}</span></td>
                            <td className="mds-numeric">{entry.points ?? 0}</td>
                            <td className="mds-numeric">{entry.kills ?? 0}</td>
                            <td className="mds-numeric">{entry.placement ?? "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {activeTab === "teams" && (
              <TeamRegistry
                teams={teams}
                onViewTeam={setSelectedTeam}
              />
            )}

            {activeTab === "players" && (
              <StatsTable
                players={teams.flatMap((t: any) => t.players?.map((p: any) => ({ ...p, teamName: t.name })) || [])}
                onViewPlayer={setSelectedPlayer}
              />
            )}

            {activeTab === "matches" && (
              <MatchList
                matches={matches}
                tournamentId={id}
              />
            )}

          </div>
        </main>

        {/* SCORE RAIL — live scores and what plays next, kept in view while you read the
            bracket or a roster. Not a broadcast, so it doesn't claim to be one: there is no
            stream URL anywhere in the schema. It is hidden on the overview tab, which already
            leads with the same two sections. */}
        <aside
          className={`w-72 shrink-0 flex-col border-l border-line bg-card ${
            activeTab === "overview" ? "hidden" : "hidden lg:flex"
          }`}
        >
          <div className="custom-scrollbar flex h-full flex-col gap-8 overflow-y-auto p-5">

            {progress ? (
              <section>
                <h2 className="mds-uppercase-label m-0">{t("rail.stage")}</h2>
                <p className="mds-name m-0 mt-2 text-sm text-fg">{progress.label}</p>
                <p className="m-0 mt-0.5 text-xs text-fg-subtle">
                  {t.rich("rail.playedOf", {
                    played: progress.played,
                    total: progress.total,
                    n: (chunks) => <span className="mds-numeric">{chunks}</span>,
                  })}
                </p>
              </section>
            ) : null}

            <section>
              <div className="flex items-center gap-2">
                {liveMatches.length > 0 && (
                  <span className="h-1.5 w-1.5 rounded-full bg-danger animate-pulse" />
                )}
                <h2 className={`mds-uppercase-label m-0 ${liveMatches.length > 0 ? "text-danger" : ""}`}>
                  {t("rail.liveScores")}
                </h2>
              </div>

              <div className="mt-3 space-y-3">
                {liveMatches.length > 0 ? (
                  liveMatches.map((match: any) => (
                    <div
                      key={match.id}
                      className="rounded border border-line bg-field p-3"
                    >
                      <div className="mb-2 flex items-center justify-between gap-2">
                        {/* The stage, not "R1 | BADE" — that was a UUID fragment. */}
                        <span className="mds-uppercase-label text-[10px]">{stageName(match, matches, tStage)}</span>
                        <span className="mds-uppercase-label text-[10px] text-danger">
                          {tStatus(matchStatusKey(match.status))}
                        </span>
                      </div>
                      <div className="space-y-1.5">
                        <div className="flex items-start justify-between gap-2">
                          <span className="mds-name mds-clamp-2 min-w-0 flex-1 text-[13px]">
                            {slotLabel(match, "HOME", matches, t, tCommon, tStage)}
                          </span>
                          <span className="mds-numeric text-base font-bold text-fg">
                            {match.homeScore}
                          </span>
                        </div>
                        <div className="flex items-start justify-between gap-2">
                          <span className="mds-name mds-clamp-2 min-w-0 flex-1 text-[13px] text-fg-muted">
                            {slotLabel(match, "AWAY", matches, t, tCommon, tStage)}
                          </span>
                          <span className="mds-numeric text-base font-bold text-fg-muted">
                            {match.awayScore}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="m-0 text-xs text-fg-subtle">{t("rail.nothingLive")}</p>
                )}
              </div>
            </section>

            {upcoming.length > 0 && (
              <section>
                <h2 className="mds-uppercase-label m-0">{t("upNext")}</h2>
                <div className="mt-3 space-y-2">
                  {upcoming.map((match: any) => (
                    <div
                      key={match.id}
                      className="rounded border border-line bg-field p-3"
                    >
                      <span className="mds-uppercase-label text-[10px]">{stageName(match, matches, tStage)}</span>
                      <div className="mt-1.5 space-y-0.5 text-[13px]">
                        <p className="mds-name m-0">{slotLabel(match, "HOME", matches, t, tCommon, tStage)}</p>
                        <p className="mds-name m-0 text-fg-muted">{slotLabel(match, "AWAY", matches, t, tCommon, tStage)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        </aside>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-[120] border-t border-line bg-card px-2 py-2 lg:hidden">
        <div className="grid grid-cols-5 gap-2">
          {primaryMobileTabs.map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => handleTabChange(tab.id)}
                data-testid={`tournament-mobile-tab-${tab.id}`}
                className={`flex h-12 flex-col items-center justify-center rounded-lg text-[10px] font-semibold ${active ? "bg-brand-soft text-brand" : "text-fg-muted"}`}
              >
                <Icon size={16} />
                <span className="mt-1">{t(tab.labelKey)}</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setShowMobileTabSheet(true)}
            data-testid="tournament-mobile-tab-more"
            className="flex h-12 flex-col items-center justify-center rounded-lg text-[10px] font-semibold text-fg-muted"
          >
            <MoreHorizontal size={16} />
            <span className="mt-1">{t("tabs.more")}</span>
          </button>
        </div>
      </div>

      {showMobileTabSheet ? (
        <div className="fixed inset-0 z-[220] bg-black/50 p-4 backdrop-blur-sm lg:hidden" onClick={() => setShowMobileTabSheet(false)}>
          <div data-testid="tournament-mobile-more-sheet" className="mx-auto mt-[20vh] w-full max-w-md rounded-xl border border-line bg-card p-3" onClick={(event) => event.stopPropagation()}>
            <p className="mds-uppercase-label px-3 pb-2 pt-1 text-[10px]">{t("tabs.sections")}</p>
            <div className="space-y-1">
              {overflowMobileTabs.map((tab) => {
                const Icon = tab.icon;
                const active = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => {
                      handleTabChange(tab.id);
                      setShowMobileTabSheet(false);
                    }}
                    data-testid={`tournament-mobile-tab-overflow-${tab.id}`}
                    className={`mds-nav-link w-full text-left ${active ? "active" : ""}`}
                  >
                    <Icon size={16} className={active ? "text-brand" : "text-fg-subtle"} />
                    <span>{t(tab.labelKey)}</span>
                  </button>
                );
              })}
              {/* Above the palette row on purpose: sharing a link is a thing a kid does, and
                  the palette is a thing the crew does. */}
              <button
                type="button"
                onClick={() => {
                  setShowMobileTabSheet(false);
                  void handleShare();
                }}
                data-testid="tournament-share"
                className="mds-nav-link w-full text-left"
              >
                <Share2 size={16} className="text-fg-subtle" />
                <span>{t("hero.shareLink")}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowMobileTabSheet(false);
                  openCommandPalette();
                }}
                data-testid="tournament-open-command-palette"
                className="mds-nav-link w-full text-left"
              >
                <Command size={16} className="text-fg-subtle" />
                <span>{t("tabs.commandPalette")}</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* MODALS */}
      {selectedTeam && (
        <TeamDetailsModal
            team={selectedTeam}
            onClose={() => setSelectedTeam(null)}
            matches={matches}
            modalRef={teamModalRef}
        />
      )}

      {selectedPlayer && (
        <PlayerDetailsModal
            player={selectedPlayer}
            onClose={() => setSelectedPlayer(null)}
            modalRef={playerModalRef}
        />
      )}

      {selectedMatch && (
        <MatchAnalysisModal
            match={selectedMatch}
            matches={matches}
            onClose={() => setSelectedMatch(null)}
            modalRef={matchModalRef}
        />
      )}
    </div>
  );
}

// Sub-modals for details
function TeamDetailsModal({ team, onClose, matches, modalRef }: any) {
    const t = useTranslations("tournament");
    const tStage = useTranslations("stage");
    const tCommon = useTranslations("common");
    const tStatus = useTranslations("status");
    const history = matches
      .filter((m: any) => m.homeTeamId === team.id || m.awayTeamId === team.id)
      .sort(byPlayOrder);

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 lg:p-10 animate-in fade-in duration-300">
          <div className="absolute inset-0 bg-[var(--mds-overlay)] backdrop-blur-sm" onClick={onClose} />
          <div ref={modalRef} role="dialog" aria-modal="true" aria-label={t("team.detailsAria")} className="mds-card relative z-10 flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden p-0 shadow-2xl scale-in-center">
            <header className="flex items-start justify-between gap-4 border-b border-line p-5 lg:p-6">
              <div className="flex min-w-0 items-center gap-4">
                <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded border border-line bg-field">
                  {team.logoUrl ? (
                    <Image src={team.logoUrl} alt="" fill className="object-contain p-2" />
                  ) : (
                    <Users size={22} className="absolute inset-0 m-auto text-fg-subtle" />
                  )}
                </div>
                <div className="min-w-0">
                  <h2 className="mds-name-lg m-0 text-2xl leading-tight">{team.name}</h2>
                  <p className="m-0 mt-1 text-xs text-fg-muted">
                    <span className="mds-numeric">{t("team.players", { count: team.players?.length || 0 })}</span>
                    {team.seed ? (
                      <>
                        {" · "}
                        <span className="mds-numeric">{t("team.seedInline", { seed: team.seed })}</span>
                      </>
                    ) : null}
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                aria-label={tCommon("close")}
                className="mds-btn-secondary h-9 w-9 shrink-0 p-0"
              >
                <X size={18} />
              </button>
            </header>

            <div className="custom-scrollbar grid flex-1 grid-cols-1 gap-8 overflow-y-auto p-5 lg:grid-cols-2 lg:p-6">
               <section className="space-y-3">
                 <h3 className="mds-uppercase-label m-0 border-b border-line pb-2">{t("team.roster")}</h3>
                 <ul className="m-0 list-none space-y-1.5 p-0">
                   {team.players?.map((p: any, idx: number) => (
                     <li key={p.id || idx} className="flex items-center gap-3 rounded-sm border border-line bg-field px-3 py-2">
                        <span className="mds-numeric w-6 shrink-0 text-[11px] text-fg-subtle">{idx + 1}</span>
                        <span
                          className={`mds-numeric shrink-0 rounded-sm px-1.5 py-0.5 text-[11px] font-bold ${
                            p.seating
                              ? 'bg-brand-soft text-brand'
                              : 'bg-line text-fg-subtle'
                          }`}
                        >
                          {p.seating || '—'}
                        </span>
                        <span className="mds-name min-w-0 flex-1 text-[13px]">{p.nickname || p.name}</span>
                        {p.countryCode ? (
                          <span className="mds-numeric shrink-0 text-[11px] text-fg-subtle">
                            {p.countryCode.toUpperCase()}
                          </span>
                        ) : null}
                     </li>
                   ))}
                   {!team.players?.length && (
                     <li className="text-[13px] text-fg-muted">{t("team.noPlayers")}</li>
                   )}
                 </ul>
               </section>

               <section className="space-y-3">
                 <h3 className="mds-uppercase-label m-0 border-b border-line pb-2">{tCommon("matches")}</h3>
                 <ul className="m-0 list-none space-y-1.5 p-0">
                   {history.map((m: any) => {
                       const isHome = m.homeTeamId === team.id;
                       const opponent = isHome ? m.awayTeam?.name : m.homeTeam?.name;
                       const won = Boolean(m.winnerId) && m.winnerId === team.id;

                       return (
                         <li key={m.id} className="flex items-center justify-between gap-3 rounded-sm border border-line bg-field px-3 py-2">
                           <div className="min-w-0">
                              <span className="mds-uppercase-label text-[10px]">{stageName(m, matches, tStage)}</span>
                              <p className="mds-name m-0 text-[13px]">
                                {t("team.versus", { opponent: opponent || tCommon("tbd") })}
                              </p>
                           </div>
                           <div className="shrink-0 text-right">
                              <span className="mds-numeric block text-sm font-bold">
                                {isHome ? m.homeScore : m.awayScore} : {isHome ? m.awayScore : m.homeScore}
                              </span>
                              <span className={`mds-uppercase-label text-[10px] ${
                                !isDone(m.status)
                                  ? 'text-fg-subtle'
                                  : won ? 'text-success' : 'text-danger'
                              }`}>
                                 {isDone(m.status)
                                   ? won ? t("team.win") : t("team.loss")
                                   : tStatus(matchStatusKey(m.status))}
                              </span>
                           </div>
                         </li>
                       );
                     })}
                   {history.length === 0 && (
                     <li className="text-[13px] text-fg-muted">{t("team.noMatches")}</li>
                   )}
                 </ul>
               </section>
            </div>
          </div>
        </div>
    );
}

function PlayerDetailsModal({ player, onClose, modalRef }: any) {
    const t = useTranslations("tournament");
    const tStage = useTranslations("stage");
    const tCommon = useTranslations("common");

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 lg:p-10 animate-in fade-in duration-300">
          <div className="absolute inset-0 bg-[var(--mds-overlay)] backdrop-blur-sm" onClick={onClose} />
          <div ref={modalRef} role="dialog" aria-modal="true" aria-label={t("player.detailsAria")} className="mds-card relative z-10 flex w-full max-w-lg flex-col overflow-hidden p-0 shadow-2xl scale-in-center">
            <header className="flex items-start justify-between gap-4 border-b border-line p-5">
               <div className="min-w-0">
                 <h2 className="mds-name-lg m-0 text-2xl leading-tight">{player.nickname || player.name}</h2>
                 <p className="mds-name m-0 mt-1 text-xs text-fg-muted">{player.teamName}</p>
               </div>
               <button onClick={onClose} aria-label={tCommon("close")} className="mds-btn-secondary h-9 w-9 shrink-0 p-0">
                 <X size={18} />
               </button>
            </header>

            <div className="grid grid-cols-3 gap-3 p-5">
               <div className="rounded-sm border border-line bg-field p-3">
                  <span className="mds-uppercase-label text-[10px]">{tCommon("seat")}</span>
                  <span className="mds-numeric mt-1 block text-lg font-bold text-brand">
                    {player.seating || '—'}
                  </span>
               </div>
               <div className="rounded-sm border border-line bg-field p-3">
                  <span className="mds-uppercase-label text-[10px]">{t("player.country")}</span>
                  <span className="mds-numeric mt-1 block text-lg font-bold">
                    {player.countryCode?.toUpperCase() || '—'}
                  </span>
               </div>
               <div className="rounded-sm border border-line bg-field p-3">
                  <span className="mds-uppercase-label text-[10px]">{t("player.name")}</span>
                  <span className="mds-name mt-1 block text-[13px]">{player.name}</span>
               </div>
            </div>
          </div>
        </div>
    );
}

function MatchAnalysisModal({ match, matches, onClose, modalRef }: any) {
    const t = useTranslations("tournament");
    const tStage = useTranslations("stage");
    const tCommon = useTranslations("common");
    const tStatus = useTranslations("status");
    const stage = stageName(match, matches, tStage);

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 lg:p-10 animate-in fade-in duration-300">
          <div className="absolute inset-0 bg-[var(--mds-overlay)] backdrop-blur-md" onClick={onClose} />
          <div ref={modalRef} role="dialog" aria-modal="true" aria-label={t("match.detailsAria")} className="mds-card relative z-10 flex w-full max-w-2xl flex-col overflow-hidden p-0 shadow-2xl scale-in-center">
             <header className="flex items-center justify-between gap-4 border-b border-line p-5">
                <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-brand-soft text-brand">
                        <Gamepad2 size={18} />
                    </div>
                    <div className="min-w-0">
                        <h2 className="m-0 text-lg font-bold tracking-tight">{stage}</h2>
                        <p className="mds-uppercase-label m-0 mt-0.5 text-[10px]">
                          {tStatus(matchStatusKey(match.status))}{match.bestOf > 1 ? ` · BO${match.bestOf}` : ''}
                        </p>
                    </div>
                </div>
                <button onClick={onClose} aria-label={tCommon("close")} className="mds-btn-secondary h-9 w-9 shrink-0 p-0">
                    <X size={18} />
                </button>
             </header>

             <div className="space-y-3 p-5">
                {[
                  { team: match.homeTeam, score: match.homeScore },
                  { team: match.awayTeam, score: match.awayScore },
                ].map(({ team, score }, idx) => {
                  const won = Boolean(match.winnerId) && match.winnerId === team?.id;
                  return (
                    <div key={team?.id || idx} className="flex items-center gap-3 rounded border border-line bg-field p-3">
                      <div className="relative h-9 w-9 shrink-0 overflow-hidden rounded border border-line bg-page">
                        {team?.logoUrl ? (
                          <Image src={team.logoUrl} alt="" fill className="object-contain p-1" />
                        ) : (
                          <Trophy size={16} className="absolute inset-0 m-auto text-fg-subtle" />
                        )}
                      </div>
                      <span className="mds-name min-w-0 flex-1 text-sm">{team?.name || tCommon('tbd')}</span>
                      <span className={`mds-numeric text-2xl font-bold ${won ? 'text-brand' : 'text-fg-subtle'}`}>
                        {score}
                      </span>
                    </div>
                  );
                })}

                <p className="m-0 text-xs text-fg-subtle">{t("match.noStats")}</p>
             </div>
          </div>
        </div>
    )
}
