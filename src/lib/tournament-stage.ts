import { isDone } from "@/lib/match-status";

export type TournamentStage = "DRAFT" | "REGISTRATION" | "LIVE" | "COMPLETE";

export const STAGE_ORDER: TournamentStage[] = ["DRAFT", "REGISTRATION", "LIVE", "COMPLETE"];

/**
 * Derive a tournament's lifecycle stage from its data (no DB field needed):
 *  - DRAFT: no bracket, sign-up not open, and fewer than 2 teams.
 *  - REGISTRATION: sign-up is open, or enough teams are in. Bracket not generated.
 *  - LIVE: bracket generated, matches still in progress.
 *  - COMPLETE: every match finished.
 *
 * `signupOpen` is the tournament's own `steamSignupEnabled` flag, and it decides the first two
 * on its own. Without it a published tournament reads as "Utkast" until two teams have joined
 * — and two teams cannot join a tournament that presents itself to them as a draft. The team
 * count is only a fallback for tournaments whose rosters an organizer types in by hand.
 */
export function getTournamentStage(
  teams: any[] = [],
  matches: any[] = [],
  signupOpen = false
): TournamentStage {
  if (!matches || matches.length === 0) {
    return signupOpen || (teams?.length || 0) >= 2 ? "REGISTRATION" : "DRAFT";
  }
  const allDone = matches.every((m) => isDone(String(m.status || "").toUpperCase()));
  return allDone ? "COMPLETE" : "LIVE";
}

export const STAGE_META: Record<TournamentStage, { label: string; hint: string; action: string }> = {
  DRAFT: { label: "Draft", hint: "Add at least 2 teams to begin.", action: "Add teams" },
  REGISTRATION: { label: "Registration", hint: "Teams are in — seed and generate the bracket.", action: "Generate bracket" },
  LIVE: { label: "Live", hint: "Load matches and update results as they play.", action: "Open control" },
  COMPLETE: { label: "Complete", hint: "All matches finished — champion decided.", action: "Public page" },
};
