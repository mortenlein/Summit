import React from "react";
import Link from "next/link";
import { Gamepad2, LayoutDashboard, Trophy } from "lucide-react";
import prisma from "@/lib/prisma";
import { getSessionIdentity } from "@/lib/route-auth";
import { getGameMetadata, teamSizeLabel } from "@/lib/games";
import { getTournamentStage, type TournamentStage } from "@/lib/tournament-stage";
import { ACTIVE_STATUSES, DONE_STATUSES, LIVE_STATUSES, isLive } from "@/lib/match-status";
import { STAGE_KEY } from "@/lib/stage-keys";
import { Badge, EmptyState, PageHeader, TournamentCard } from "@/components/ui";
import { useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";

// Reads the signed-in identity and the live tournament list on every request — a prerendered
// page would bake in one visitor's session and a stale bracket list.
export const dynamic = 'force-dynamic';

const LANDING_LIMIT = 9;
const FLOOR_LIMIT = 6;
const RESULT_LIMIT = 6;

const STAGE_TONE: Record<TournamentStage, "neutral" | "info" | "live" | "done"> = {
  DRAFT: "neutral",
  REGISTRATION: "info",
  LIVE: "live",
  COMPLETE: "done",
};

/** Only the columns a spectator is allowed to see — never serverIp/password, never a steamId. */
const MATCH_CARD_SELECT = {
  id: true,
  status: true,
  round: true,
  bracketType: true,
  bestOf: true,
  homeScore: true,
  awayScore: true,
  updatedAt: true,
  tournament: { select: { id: true, name: true } },
  homeTeam: { select: { name: true } },
  awayTeam: { select: { name: true } },
} as const;

/** A `next-intl` translator, narrowed to what the helpers below actually call. */
type Translate = (key: string, values?: Record<string, string | number | Date>) => string;

/**
 * Bracket position as a word. Not a component, so it takes the `landing` translator as an
 * argument rather than calling a hook.
 */
function roundLabel(match: { round: number; bracketType: string | null }, t: Translate) {
  const bracket = (match.bracketType || "WINNERS").toUpperCase();
  if (bracket === "GRAND_FINAL") return t("roundGrandFinal");
  if (bracket === "THIRD_PLACE") return t("roundThirdPlace");
  if (bracket === "LOSERS") return t("roundLower", { round: match.round });
  return t("round", { round: match.round });
}

interface FloorMatch {
  id: string;
  status: string;
  round: number;
  bracketType: string | null;
  bestOf: number;
  homeScore: number;
  awayScore: number;
  tournament: { id: string; name: string };
  homeTeam: { name: string } | null;
  awayTeam: { name: string } | null;
}

const matchHref = (m: FloorMatch) => `/tournaments/${m.tournament.id}?tab=matches`;

/**
 * A live match, shaped like the scorebug it is: both names on one line with the score between
 * them, big enough to read standing up. This is the loudest thing the landing page renders.
 */
function LiveMatchCard({ match }: { match: FloorMatch }) {
  // Sync Server Components: `useTranslations` is the supported call here, not `getTranslations`.
  const t = useTranslations("landing");
  const tc = useTranslations("common");
  const tStatus = useTranslations("status");
  return (
    <Link
      href={matchHref(match)}
      className="mds-live-panel block p-5 transition-colors hover:border-line-hover"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Badge tone="live">{tStatus("live")}</Badge>
        <span className="mds-name text-meta font-semibold text-fg-subtle">
          {match.tournament.name} · {roundLabel(match, t)} · <span className="mds-numeric">Bo{match.bestOf}</span>
        </span>
      </div>

      <div className="mt-4 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3">
        <span className="mds-name text-right text-lead text-fg">{match.homeTeam?.name || tc("tbd")}</span>
        <span className="mds-numeric rounded-sm bg-tint px-3 py-1 text-title font-bold text-live">
          {match.homeScore} – {match.awayScore}
        </span>
        <span className="mds-name text-lead text-fg">{match.awayTeam?.name || tc("tbd")}</span>
      </div>
    </Link>
  );
}

/** A called or finished match: compact, stacked, built to sit in a row of six. */
function MatchLine({ match, tone }: { match: FloorMatch; tone: "next" | "done" }) {
  const t = useTranslations("landing");
  const tc = useTranslations("common");
  const showScore = tone === "done";
  const homeWon = match.homeScore > match.awayScore;

  return (
    <Link
      href={matchHref(match)}
      className="mds-card block p-4 transition-colors hover:border-line-hover"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="mds-uppercase-label text-fg-subtle">{roundLabel(match, t)}</span>
        <span className="mds-numeric text-meta font-semibold text-fg-subtle">Bo{match.bestOf}</span>
      </div>

      <div className="mt-3 space-y-1.5">
        {[
          { name: match.homeTeam?.name, score: match.homeScore, won: showScore && homeWon },
          {
            name: match.awayTeam?.name,
            score: match.awayScore,
            won: showScore && match.awayScore > match.homeScore,
          },
        ].map((side, i) => (
          <div key={i} className="flex items-baseline justify-between gap-3">
            <span className={`mds-name text-body ${side.won ? "text-fg" : "text-fg-muted"}`}>
              {side.name || tc("tbd")}
            </span>
            {showScore && (
              <span
                className={`mds-numeric text-lead font-bold ${side.won ? "text-success" : "text-fg-subtle"}`}
              >
                {side.score}
              </span>
            )}
          </div>
        ))}
      </div>

      <p className="mds-name mt-3 border-t border-line pt-2 text-meta text-fg-subtle">
        {match.tournament.name}
      </p>
    </Link>
  );
}

export default async function Home() {
  const [t, tc, tNav, tStage, { steamId, role }, tournaments, floorMatches, results] = await Promise.all([
    getTranslations("landing"),
    getTranslations("common"),
    getTranslations("nav"),
    getTranslations("stage"),
    getSessionIdentity(),
    prisma.tournament.findMany({
      orderBy: { createdAt: 'desc' },
      take: LANDING_LIMIT,
      select: {
        id: true,
        name: true,
        game: true,
        format: true,
        teamSize: true,
        steamSignupEnabled: true,
        teams: { select: { id: true } },
        matches: { select: { status: true } },
      },
    }),
    // What is happening on the floor right now: live first, then the matches that have been
    // called. This is the reason a spectator opened the page.
    prisma.match.findMany({
      where: { status: { in: [...ACTIVE_STATUSES] } },
      orderBy: { updatedAt: 'desc' },
      take: FLOOR_LIMIT * 2,
      select: MATCH_CARD_SELECT,
    }),
    prisma.match.findMany({
      where: { status: { in: [...DONE_STATUSES] }, winnerId: { not: null } },
      orderBy: { updatedAt: 'desc' },
      take: RESULT_LIMIT,
      select: MATCH_CARD_SELECT,
    }),
  ]);

  const signedIn = Boolean(steamId);

  // The true totals, before the board's display cap. The hero used to count the *sliced* list,
  // so a LAN with seven matches running announced six.
  const liveTotal = floorMatches.filter((m) => isLive(m.status)).length;
  const liveMatches = floorMatches.filter((m) => isLive(m.status)).slice(0, FLOOR_LIMIT);
  const calledMatches = floorMatches
    .filter((m) => !isLive(m.status))
    .slice(0, Math.max(0, FLOOR_LIMIT - liveMatches.length));

  // `row`, not `t`: `t` is the translator in this scope.
  const cards = tournaments
    .map((row) => {
      const stage = getTournamentStage(row.teams, row.matches, row.steamSignupEnabled);
      const gameMeta = getGameMetadata(row.game);
      const done = row.matches.filter((m) => DONE_STATUSES.includes(String(m.status || '').toUpperCase())).length;
      return {
        id: row.id,
        name: row.name,
        stage,
        game: gameMeta?.name || row.game,
        format: row.format === "DOUBLE_ELIMINATION" ? "Double elim" : "Single elim",
        roster: teamSizeLabel(gameMeta, row.teamSize),
        teamCount: row.teams.length,
        progress: row.matches.length > 0 ? { done, total: row.matches.length } : undefined,
        liveCount: row.matches.filter((m) => LIVE_STATUSES.includes(String(m.status || '').toUpperCase())).length,
      };
    })
    // Live tournaments first: what is running now outranks what was created most recently.
    .sort((a, b) => (a.stage === "LIVE" ? 0 : 1) - (b.stage === "LIVE" ? 0 : 1));

  // Same rule as the directory, so the two boards do not diverge: the game eyebrow only earns
  // its row when the board actually holds more than one game.
  const multiGameBoard = new Set(tournaments.map((row) => row.game)).size > 1;

  return (
    <div className="flex min-h-screen flex-col bg-page text-fg">
      {/* No eyebrow. It was the literal "CS2 LAN-TURNERINGER" while games.ts ships five games
          and this page's own query selects each tournament's game — so a Fortnite bracket sat
          under a header announcing CS2. The h1 stays: it is the only one on the page. */}
      <PageHeader
        title={
          <>
            Summit
          </>
        }
        subtitle={t("subtitle")}
        meta={
          // Nothing while something is live: the red-dotted "SPILLES NÅ" heading and the
          // scorebug below own that job on the same screen, with the team names attached.
          //
          // The slot is kept for the quiet states, and the lie it used to tell is fixed: with
          // no live match but a called one it printed "Ingen kamper spilles akkurat nå" while a
          // KALT OPP section rendered underneath.
          liveTotal > 0 ? undefined : calledMatches.length > 0 ? (
            <span className="text-body font-semibold text-fg-muted">
              {t("calledNotLive", { count: calledMatches.length })}
            </span>
          ) : (
            <span className="text-body font-semibold text-fg-subtle">
              {t("nothingPlaying")}
            </span>
          )
        }
        actions={
          <>
            {signedIn ? (
              <Link
                href="/dashboard"
                data-testid="landing-cta-dashboard"
                className="mds-btn-primary h-11 px-6 text-meta font-bold uppercase tracking-widest"
              >
                <LayoutDashboard size={15} aria-hidden />
                {t("ctaDashboard")}
              </Link>
            ) : (
              <Link
                href="/login"
                data-testid="landing-cta-login"
                className="mds-btn-primary h-11 px-6 text-meta font-bold uppercase tracking-widest"
              >
                <Gamepad2 size={15} aria-hidden />
                {tc("signInWithSteam")}
              </Link>
            )}
            {role === "admin" && (
              <Link
                href="/admin"
                data-testid="landing-cta-organizer"
                className="mds-btn-secondary h-11 px-6 text-meta font-bold uppercase tracking-widest"
              >
                <Trophy size={15} aria-hidden />
                {t("ctaOrganizer")}
              </Link>
            )}
          </>
        }
      />

      <main id="board" className="mds-container flex flex-1 flex-col gap-12 py-10">
        {/* ---- What is happening right now. Never rendered when nothing is. ---- */}
        {(liveMatches.length > 0 || calledMatches.length > 0) && (
          <section aria-labelledby="floor-heading" className="space-y-4">
            <div className="mds-section-head">
              <div className="flex items-center gap-2.5">
                {liveMatches.length > 0 && <span className="mds-dot is-live" aria-hidden />}
                <h2 id="floor-heading" className="mds-uppercase-label text-fg">
                  {liveMatches.length > 0 ? t("floorHeadingLive") : t("floorHeadingCalled")}
                </h2>
              </div>
            </div>

            {liveMatches.length > 0 && (
              <div className={`grid gap-3 ${liveMatches.length > 1 ? "xl:grid-cols-2" : ""}`}>
                {liveMatches.map((m) => (
                  <LiveMatchCard key={m.id} match={m} />
                ))}
              </div>
            )}

            {calledMatches.length > 0 && (
              <div className="space-y-3">
                {/* The word, above the cards it describes. It used to be a right-aligned count
                    about 250px higher, next to a heading about a different set of matches. */}
                {liveMatches.length > 0 && (
                  <h3 className="mds-uppercase-label m-0 text-fg-subtle">
                    {t("floorHeadingCalled")}
                  </h3>
                )}
                <div className="mds-card-grid">
                  {calledMatches.map((m) => (
                    <MatchLine key={m.id} match={m} tone="next" />
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {/* ---- The tournament board. ---- */}
        <section aria-labelledby="board-heading" className="flex flex-1 flex-col gap-4">
          <div className="mds-section-head">
            {/* No count pill: this board is capped at nine rows, so the number it printed was
                not the number of tournaments that exist. If it ever truncates, the honest thing
                to say is "+3 til", not a total. Losing the pill also gives "Se alle →" its room
                back on a phone. */}
            <h2 id="board-heading" className="mds-uppercase-label text-fg">
              {tc("tournaments")}
            </h2>
            <Link
              href="/tournaments"
              className="rounded-sm text-meta font-semibold text-fg-muted transition-colors hover:text-fg"
            >
              {t("browseAll")}
            </Link>
          </div>

          {cards.length === 0 ? (
            <EmptyState
              className="flex-1"
              icon={<Gamepad2 size={24} />}
              title={t("emptyTitle")}
              description={role === "admin" ? t("emptyAdmin") : t("emptyPublic")}
              action={
                role === "admin" ? (
                  <Link
                    href="/admin"
                    className="mds-btn-primary h-10 px-5 text-label font-bold uppercase tracking-widest"
                  >
                    {t("openOrganizer")}
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <ul className="mds-card-grid">
              {cards.map((card) => (
                <li key={card.id}>
                  <TournamentCard
                    href={`/tournaments/${card.id}`}
                    name={card.name}
                    game={multiGameBoard ? card.game : undefined}
                    format={card.format}
                    roster={card.roster}
                    teamCount={card.teamCount}
                    stageLabel={tStage(STAGE_KEY[card.stage])}
                    stageTone={STAGE_TONE[card.stage]}
                    progress={card.progress}
                    liveCount={card.liveCount}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ---- Results. Only exists once somebody has actually won something. ---- */}
        {results.length > 0 && (
          <section aria-labelledby="results-heading" className="space-y-4">
            <div className="mds-section-head">
              <h2 id="results-heading" className="mds-uppercase-label text-fg">
                {t("latestResults")}
              </h2>
            </div>
            {/* Deliberately not a list: the tournament board above is the page's only <ul>,
                and the specs identify a tournament card by `li` + its name — a result card
                carries the same name and would make that locator ambiguous. */}
            <div className="mds-card-grid">
              {results.map((m) => (
                <MatchLine key={m.id} match={m} tone="done" />
              ))}
            </div>
          </section>
        )}
      </main>

    </div>
  );
}
