/**
 * The stable error codes the API hands back, and their canonical English text.
 *
 * Why a code at all: a JSON error body is read by two audiences with opposite needs. A log, a
 * `curl`, and 201 e2e assertions want one fixed English string; a 12-year-old on the floor wants
 * their own language. So a refusal carries both — `error` stays exactly the English sentence it
 * has always been (nothing downstream breaks, nothing becomes un-greppable), and `code` is the
 * translation key the client looks up in the `errors` namespace for the toast.
 *
 * Only refusals a *human* has to act on get a code. Most 500s are for developers and are
 * deliberately left alone — a translated stack-trace message helps nobody.
 *
 * This module is client-safe on purpose (no prisma, no next/server), because the toast layer
 * imports it too. The response helpers live in `mutation-guards.ts`.
 *
 * Keys here are exactly the keys in `messages/<locale>/errors.json`.
 */
export const API_ERROR_TEXT = {
  // --- identity ---------------------------------------------------------------------------
  unauthorized: 'Unauthorized',
  signin_required_team: 'Sign in required to register a team',
  signin_required_upload: 'Sign in required for uploads',
  steam_signin_required: 'Steam sign-in required. Please continue with Steam and try again.',

  // --- optimistic-concurrency + lock guards (mutation-guards.ts) ---------------------------
  stale_record: 'This record changed in another session. Refresh and try again.',
  roster_locked: 'Roster changes are locked. Unlock roster edits in tournament settings first.',
  roster_locked_force:
    'Roster changes are locked. Unlock roster edits in tournament settings, or confirm a forced removal to pull the team out of its matches.',
  roster_locked_identity:
    'Roster changes are locked. Seat, name, nickname and flag edits are still allowed; Steam ID and leader changes need roster edits unlocked.',
  seeding_locked: 'Seeding is locked while the bracket is in play. Name and logo edits are still allowed.',
  bracket_locked:
    'Bracket changes are locked. Unlock roster edits in tournament settings before regenerating matches.',
  player_move_locked: 'The bracket is live — ask an organizer to move you.',

  // --- signup / registration refusals ------------------------------------------------------
  signups_disabled: 'Steam signups are disabled for this tournament',
  registration_locked: 'Registration is currently locked for this tournament',
  team_name_required: 'Team name is required',
  already_registered: 'You are already registered for this tournament',
  invalid_invite_code: 'Invalid invite code',
  team_not_in_tournament: 'Team is not part of this tournament',
  team_full: 'Team is already full',
  not_registered: 'You are not registered for this tournament',
  invalid_action: 'Invalid action',

  // --- match save refusals -----------------------------------------------------------------
  match_needs_winner: 'A completed match needs a winner',
  forfeit_needs_both_teams: 'Both teams must be assigned to record a forfeit',
  forfeit_side_invalid: 'forfeit must be HOME or AWAY',
  best_of_too_low: 'bestOf must be at least 1',
  /** Carries `params.matchRef` — the short match id the organizer has to reset first. */
  downstream_started: 'Downstream match {matchRef} has already started — reset it first.',
  both_teams_required: 'Both teams must be assigned before loading a match',
  match_already_live: 'This match is already being played — it cannot be called again',
  match_already_complete: 'This match is already finished — it cannot be called again',
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_TEXT;

export type ApiErrorParams = Record<string, string | number>;

/** The refusal body every coded error uses. `error` is the contract; `code` is the translation. */
export interface ApiErrorBody {
  error: string;
  code: ApiErrorCode;
  params?: ApiErrorParams;
}

/**
 * Fill `{placeholders}` in the canonical English text — the `error` field has to be a finished
 * sentence, because that is what lands in the log and in every existing test assertion.
 */
export function apiErrorText(code: ApiErrorCode, params?: ApiErrorParams): string {
  const template: string = API_ERROR_TEXT[code];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in params ? String(params[key]) : whole
  );
}

const CODE_BY_TEXT = new Map<string, ApiErrorCode>(
  (Object.entries(API_ERROR_TEXT) as Array<[ApiErrorCode, string]>).map(([code, text]) => [text, code])
);

/**
 * The code for an English message, or null.
 *
 * Some refusals reach the route as a bare string rather than as a code: `decideMatchResult()`
 * returns `{error}` (it is pure decision logic shared with a ts-node script, so it must not know
 * about HTTP or i18n), and the signup transaction rolls back by throwing an `Error`. Rather than
 * reshape either, the route looks the text up here. An unrecognised string simply gets no code
 * and the client falls back to showing the server's English sentence — degraded, never broken.
 */
export function codeForText(text: string | null | undefined): ApiErrorCode | null {
  if (!text) return null;
  return CODE_BY_TEXT.get(text) ?? null;
}

/** Reads the code off whatever a failed fetch produced (an `ApiError` payload, a raw body). */
export function errorCodeOf(value: unknown): ApiErrorCode | null {
  const payload = (value as { payload?: unknown })?.payload ?? value;
  const code = (payload as { code?: unknown })?.code;
  return typeof code === 'string' && code in API_ERROR_TEXT ? (code as ApiErrorCode) : null;
}

/** Reads the `params` an error body carries (only `downstream_started` has any today). */
export function errorParamsOf(value: unknown): ApiErrorParams | undefined {
  const payload = (value as { payload?: unknown })?.payload ?? value;
  const params = (payload as { params?: unknown })?.params;
  return params && typeof params === 'object' ? (params as ApiErrorParams) : undefined;
}
