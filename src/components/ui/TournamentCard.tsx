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
  /**
   * Human game name ("Counter-Strike 2"), not the enum.
   *
   * Omitted when the board it sits on runs one game, which is every LAN this club has held: an
   * eyebrow that says the same word on all eight cards is a column of noise, not a label. The
   * caller decides, over the *unfiltered* board — computing it over the filtered rows would
   * make the eyebrow appear and disappear between keystrokes.
   */
  game?: string;
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

  return (
    <Link href={href} className="group block h-full rounded-lg">
      <Card
        interactive
        className={`flex h-full flex-col gap-4 p-5 ${isLive ? "border-live/50" : ""}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            {game && <p className="mds-uppercase-label text-fg-subtle">{game}</p>}
            <CardTitle>{name}</CardTitle>
          </div>
          <Badge tone={stageTone}>{stageLabel}</Badge>
        </div>

        {/* No glyphs on this row. A trophy next to "Enkel utslagning" and a person next to
            "8 lag" restate the words beside them, and both stats already carry a screen-reader
            label. The two blocks stay separate — one flattened "Single elim · 5v5 · 8 lag"
            string would lose those labels — so the pulsing live dot is the only glyph here. */}
        {/* Everything the card says, on one row, with the arrow at its end.
            The footer this replaces was a bordered row carrying the verb "Åpne turneringen" on
            a card that is already entirely a link — ~45px and a rule per card, eight cards to a
            board. The verb survives for a screen reader (an aria-label on the <Link> would have
            erased the name instead of adding to it).
            The progress figure also moves here as plain text: the 1px bar and its "KAMPER
            SPILT" label were two rows for one fraction, and the fraction is the signal that
            survives the lull when nothing is live. */}
        <dl className="mds-stat-row mt-auto items-center justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
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
            {progress && progress.total > 0 && (
              <div className="mds-stat">
                <dt className="sr-only">{t("matchesPlayed")}</dt>
                <dd className="mds-numeric">
                  {t("playedOf", { done: progress.done, total: progress.total })}
                </dd>
              </div>
            )}
            {isLive && liveCount > 0 && (
              // The dot stays red; the words do not. One red chip and one red dot per card,
              // instead of a chip, a phrase, a border and a bar all competing.
              <div className="mds-stat">
                <dt className="sr-only">{t("liveMatches")}</dt>
                <span className="mds-dot is-live" aria-hidden />
                <dd>{t("matchesLive", { count: liveCount })}</dd>
              </div>
            )}
          </div>
          <span className="sr-only">{isLive ? t("watchLive") : t("openTournament")}</span>
          <ArrowRight
            size={16}
            aria-hidden
            className="shrink-0 text-fg-subtle transition-transform group-hover:translate-x-0.5"
          />
        </dl>
      </Card>
    </Link>
  );
}

/** Convenience: the icon a board uses for "a tournament" in empty states. */
export const TournamentIcon = Gamepad2;
