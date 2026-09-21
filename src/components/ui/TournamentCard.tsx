import React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ArrowRight, Gamepad2 } from "lucide-react";
import { Badge } from "./Badge";
import { Card, CardTitle } from "./Card";

export interface TournamentCardProps {
  href: string;
  /** The organizer's own name for the tournament — rendered as content, never uppercased. */
  name: string;
  /** Human game name ("Counter-Strike 2"), not the enum. */
  game: string;
  /** Human format ("Single elim"), not SINGLE_ELIMINATION. */
  format: string;
  /** Roster size label ("5v5", "Duos"). */
  roster: string;
  teamCount: number;
  /** Derived lifecycle stage label + tone (src/lib/tournament-stage.ts). */
  stageLabel: string;
  stageTone: "neutral" | "info" | "live" | "done";
  /** Matches finished / total. Omitted where the caller has no match data — never faked. */
  progress?: { done: number; total: number };
  /** How many matches are being played right now. Only meaningful while LIVE. */
  liveCount?: number;
}

/**
 * One tournament, as it appears on any board (the landing page and the directory use the same
 * component so a tournament reads identically wherever a spectator meets it).
 *
 * The whole card is a single link: one tab stop, one tap target, nothing nested that would
 * swallow the click.
 */
export function TournamentCard({
  href,
  name,
  game,
  format,
  roster,
  teamCount,
  stageLabel,
  stageTone,
  progress,
  liveCount = 0,
}: TournamentCardProps) {
  const t = useTranslations("common");
  const isLive = stageTone === "live";
  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : null;

  return (
    <Link href={href} className="group block h-full rounded-lg">
      <Card
        interactive
        className={`flex h-full flex-col gap-4 p-5 ${isLive ? "border-live/50" : ""}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <p className="mds-uppercase-label text-fg-subtle">{game}</p>
            <CardTitle>{name}</CardTitle>
          </div>
          <Badge tone={stageTone}>{stageLabel}</Badge>
        </div>

        {/* No glyphs on this row. A trophy next to "Enkel utslagning" and a person next to
            "8 lag" restate the words beside them, and both stats already carry a screen-reader
            label. The two blocks stay separate — one flattened "Single elim · 5v5 · 8 lag"
            string would lose those labels — so the pulsing live dot is the only glyph here. */}
        <dl className="mds-stat-row">
          <div className="mds-stat">
            <dt className="sr-only">{t("format")}</dt>
            <dd>
              {format} · {roster}
            </dd>
          </div>
          <div className="mds-stat">
            <dt className="sr-only">{t("teams")}</dt>
            <dd>{t("teamCount", { count: teamCount })}</dd>
          </div>
          {isLive && liveCount > 0 && (
            <div className="mds-stat text-live">
              <dt className="sr-only">{t("liveMatches")}</dt>
              <span className="mds-dot is-live" aria-hidden />
              <dd>{t("matchesLive", { count: liveCount })}</dd>
            </div>
          )}
        </dl>

        {pct !== null && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-meta font-semibold text-fg-subtle">
              <span className="mds-uppercase-label">{t("matchesPlayed")}</span>
              <span className="mds-numeric">
                {progress!.done}/{progress!.total}
              </span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-tint-strong">
              <div
                className={`h-full rounded-full ${isLive ? "bg-live" : "bg-brand"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )}

        <div className="mt-auto flex items-center justify-between border-t border-line pt-3 text-body font-semibold">
          <span>{isLive ? t("watchLive") : t("openTournament")}</span>
          <ArrowRight
            size={16}
            aria-hidden
            className="text-fg-subtle transition-transform group-hover:translate-x-0.5"
          />
        </div>
      </Card>
    </Link>
  );
}

/** Convenience: the icon a board uses for "a tournament" in empty states. */
export const TournamentIcon = Gamepad2;
