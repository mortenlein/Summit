/**
 * Where a match sits in the draw, as a *message key* rather than a rendered word.
 *
 * The words themselves live in the shared `stage` namespace (`messages/{en,nb}/stage.json`),
 * which the public board, the OBS overlay and the organizer cockpit all read. Server-composed
 * copy — a Discord post, a DM — has no `useTranslations` hook to call, and it has to render in
 * a language chosen per recipient rather than per request, so it needs the key and the values
 * separately: resolve them with `getServerTranslations(locale, 'stage')` at compose time.
 *
 * Returning a key (not a string) is what keeps "Taperrunde 2" out of an English DM and
 * "Losers Round 2" out of a Norwegian one when both players are on the same match.
 *
 * NOTE: `stageLabel()` in `components/tournament/manage/ManageControl.tsx` is the client-side
 * twin of this function and resolves the same keys. It is deliberately left alone here (that
 * file is being edited elsewhere this week); collapse it onto this helper next time it is open.
 */

export interface StageRef {
  bracketType?: string | null;
  round: number;
}

export interface StageLabel {
  key: string;
  values?: Record<string, number>;
}

/** Highest winners-bracket round in a draw — the anchor "Final / Semi-Final / …" counts back from. */
export function totalRoundsOf(matches: StageRef[]): number {
  const winners = matches.filter((m) => (m.bracketType || 'WINNERS').toUpperCase() === 'WINNERS');
  return winners.length ? Math.max(...winners.map((m) => m.round)) : 0;
}

/**
 * The `stage.*` key for a match. Mirrors the cockpit's vocabulary exactly, including the
 * count-back from the final, so the same match is never "Round 3" in Discord and
 * "Semi-Finals" on the board.
 */
export function stageLabelKey(match: StageRef, totalRounds: number): StageLabel {
  const bracket = (match.bracketType || 'WINNERS').toUpperCase();
  if (bracket === 'GRAND_FINAL') return { key: 'bracket.grandFinal' };
  if (bracket === 'THIRD_PLACE') return { key: 'bracket.thirdPlace' };
  if (bracket === 'LOSERS') return { key: 'bracket.losersRound', values: { n: match.round } };

  const fromFinal = totalRounds - match.round;
  if (fromFinal === 0) return { key: 'bracket.grandFinal' };
  if (fromFinal === 1) return { key: 'bracket.semiFinals' };
  if (fromFinal === 2) return { key: 'bracket.quarterFinals' };
  return { key: 'bracket.round', values: { n: match.round } };
}
