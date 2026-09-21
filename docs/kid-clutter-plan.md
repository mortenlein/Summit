# Summit — clutter cleanup work order

_From an 11-surface audit of every player-facing screen (Norwegian, phone-first, 2026-09-20).
Each candidate was proposed by one reviewer, then adversarially defended by an independent
second: **45 cut · 53 shrink · 2 defended** out of 100
across 11 surfaces._

---

# SUMMIT — CLEANUP WORK ORDER

Vocabulary check first (verified by grep): `vakt` appears nowhere in `src/`, `messages/` or `e2e/`. `kampoppsett` survives only in `e2e/zz-public-visual-nb.spec.ts:3` (comment) and `:80`, `:133` (screenshot filenames `02-kampoppsett`, `11-r16-kampoppsett`). Rename those to `bracket` in step 0 so the audit artifacts stop teaching the wrong word. No user-facing string is affected.

---

## TIER 1 — CUT

### 1. PLAYER DESK (`/dashboard`) — the money screen, do this first

**`src/components/player/PlayerHome.tsx`**
- **L86** — delete `<p className="mds-uppercase-label">{t('desk.label')}</p>` ("SPILLERDESK"). Move the string to `aria-label={t('desk.label')}` on the `<main>` at L83. **Companion, same commit:** delete the identical label in `src/app/dashboard/page.tsx:15` and replace that skeleton line with a shimmer bar (copy the pattern at `PlayerHome.tsx:144`), or the label flickers in on load. *After:* page opens with "Leo" at 2xl, then the green call card.
- **L102 / TournamentList (L124-201)** — filter out tournaments that already rendered a CallCard. **Implement inside `TournamentList`, not `PlayerHome`** (TournamentList holds the queue cache; PlayerHome only has `fallback`). Export the predicate from `MyQueue.tsx` (`hasCallCard(entry)` = `state === 'SCHEDULED' && nextMatch`, per `MyQueue.tsx:315`) and use it in both places so they cannot drift. When the filtered list is empty, render nothing — not the "TURNERINGENE DINE" header, not the divider. Pass the same `fallback` entries in so the card does not paint and then vanish under the kid's thumb. *After:* CALLED state is header → alerts button → green call card. Nothing below it. No second B01, no second pencil.

**`src/components/player/MyQueue.tsx`**
- **L368** (and the skeleton twin at **L324**) — delete `<p className="mds-uppercase-label">{t('queue.label')}</p>` ("KØEN DIN"). Add `aria-label={t('queue.region')}` to the `<section>` at L367 (it currently has none; the empty branch at L336 already does). Keep the `player.queue.label` string in messages. *After:* green card is the first thing under the name.
- **L169** — suppress `<StatusBadge status={m.status} />` when `onNow` (tone `live` or `called`). Keep it for `next`/`waiting`. *After:* on the CALLED card the green band is the only status statement; the tournament-name row holds just "Mortenlab LAN #7".
- **L85-89 / L157** — drop the `headlineIcon()` span for `called` **and** `next` (they share the same `Flag`, which in this app's own vocabulary means *forfeit* — `EditMatchModal.tsx:78,259`). Keep `Radio` for `live` (motion is real signal), keep or drop `Hourglass` for `waiting`. *Do not sell this as a wrap fix — "Din tur — gå til plassen din" still wraps to two lines at 390px.*
- **L193-200** — delete the `Fact label={t('fact.match')}` block on the `called`/`live` tones and widen the seat Fact to `sm:col-span-3`. Move the stage word to a muted line directly under the matchup `<h2>` (L172-179) — **not** onto the tournament-name row at L166-170, which is a wrapping flex row. In `messages/{nb,en}/player.json` `fact.matchLine`, **delete the `· BO{bestOf}` suffix** (`bestOfForRound()` returns 1 for every round by default, so "BO1" is a constant — and in `mds-numeric` it reads as the seat code "B01" sitting 60px below the real one). If BO is ever restored, spell it `Bo3` and gate on `bestOf > 1`, as `TournamentView.tsx:674` already does.
- **L181-185 + L120-127** — delete the `accent` prop and the `accent` branch in `Fact`. The seat box keeps `border-line bg-field`. *After:* one green frame (the card) under one green band, seat as the largest glyph inside.

**`src/components/player/EnableAlertsButton.tsx`**
- **L101-103** — gate the hint on error only: `{state === 'error' && <p …>{t('alerts.errorHint')}</p>}`. Remove `alerts.hint` from `messages/{nb,en}/player.json`; keep `alerts.errorHint`. *After:* bell button with no sentence under it.

---

### 2. GLOBAL CHROME — one edit, lands on every surface

**`src/components/ui/TopNav.tsx`**
- **L117-128** (button carries `data-testid="open-command-palette"` at **L122**, confirmed) — add `hidden md:flex`. Nothing deleted; desktop organizers and crew keep it. *After:* phone header = `Summit` · 🌐 NB · ☀ · ☰.
- Eight separate reviewers ruled on this element. **Do not also add a "Søk" or "Kommandopalett" row to the hamburger drawer** — the palette's filter matches command labels only (`CommandPalette.tsx:189-203`), so a "Søk" row promises a search that does not exist, and every command behind it duplicates a link already in that drawer. Tournament pages keep a labelled phone door at `TournamentView.tsx:453` (`tournament-open-command-palette`).
- **⚠️ BREAKS E2E:** `e2e/zz-nb-visual.spec.ts:186` and `:196` click `open-command-palette` inside a loop that includes `PHONE = 390×844`. Tailwind `hidden` is `display:none` — the click fails. Fix: scope that loop's palette leg to DESKTOP, or repoint the phone leg at `tournament-open-command-palette`. `e2e/navigation-foundation.spec.ts:51` (hydration gate) and `e2e/zz-chrome-visual.spec.ts:140,177,186` run at desktop viewports — unaffected, leave them alone.

---

### 3. REGISTER FLOW (`src/app/tournaments/[id]/register/page.tsx`) — one file, five cuts

- **L51** — delete `<p className="mds-uppercase-label text-fg-subtle">{t('label')}</p>` ("PÅMELDING"). Delete the `label` key from `messages/{nb,en}/register.json` (single consumer, verified). Add `pt-1` to the header so the title does not sit flush. *After:* tournament name is the first thing on the page — including on the closed branch, where "PÅMELDING" currently sits directly above the heading "Påmeldingen er stengt".
- **L55-57** — delete the two `<Badge tone="neutral">` wrappers for game and format; **keep the `perTeam` badge** (L58-63) — team size is an instruction, "get one more person". Render game + format instead as one muted line under the title: `{gameMeta?.name || tournament.game} · {formatName(tournament.format, tStage)}` using the **shared** `formatName` from `src/components/tournament/match-labels.ts:196` (→ "Enkel utslagning"). Delete the local `formatName` at **L43-44** and the `FORMAT_OPTIONS` import at **L31**. This fixes a live bug: today the badge renders the literal English `"Single Elimination"` from `src/lib/games.ts:120`, and the game badge renders the raw enum (`CS2`, `RAINBOW6`).
- **L345** — on the `userTeam || success` branch, suppress the meta block entirely (pass `showMeta={false}` to `RegisterShell`). On the team panel the kid's questions are seat / roster / invite; format and team size are not actionable there. Keep the meta on the join-by-invite and create-team branches.
- **L358-377** — collapse the confirmation header to one row: green `CheckCircle2` + **the team name** in the brand face, at the size `yourTeamTitle` occupies now. Delete `yourTeamTitle` and the `registeredWith` sentence. This applies to the `success` path too — "Du er påmeldt" over "Du er påmeldt med Team Fjord." is word-for-word containment. *After:* ✓ Team Fjord → lock notice (if locked) → **PLASSEN DIN / B01** at ~25% down instead of ~40%.
- **L694-708** — delete the `teamData.name ||` half of the preview gate and the whole panel (border, `p-4`, `t('yourTeam')` label, name echo, `Users` placeholder). Keep **only** `logoPreview`, as a ~28px thumbnail inside the logo row. *After:* typing a team name adds nothing below the fields; uploading a logo shows a thumbnail where the filename goes.
- **L320-328** — drop the `Card` wrapper from the loading state; render a plain `Loader2 + {t('loading')}` row with `role="status" aria-live="polite"`. **Better, and the real fix:** `RegisterShell` already accepts `tournament` and renders the header from it (L34-52) — the loading branch passes nothing. Server-prefetch the tournament the way the sibling route `src/app/tournaments/[id]/page.tsx` already does (`getTournament` + `dehydrate`/`HydrationBoundary`) so the name is on the first frame and only the form area waits. *After:* first paint is "Fredagsduo" + a spinner where the card will be, not a bordered box over 1400px of black.

**Copy, same file/messages:**
- **L518-523** — `closedBody`: drop the `t.rich` tournament-name interpolation (the name is the h1 two rows up, and `mds-name text-fg` makes the redundant word the loudest thing in the paragraph). New nb string: `"Bracketen er trukket. Snakk med en i crewet hvis dette er feil."` en: `"The bracket is drawn. Talk to someone on the crew if this looks wrong."` **The escalation sentence is load-bearing — a later pass must not shave it.** Mirror `arrangør` → `crew` in `messages/nb/errors.json` `player_move_locked`.
- `player.seat.helper` in `messages/nb/player.json` — trim to `"Crewet bruker denne for å finne deg."`, dropping `"Du kan endre den senere."` **Shared with `SeatEditor.tsx:150`** — check both surfaces; on the desk the dropped clause tells a kid they can change it later *while they are changing it*. Bring `messages/en/player.json` in line: "Marshals use this to find you" → crew wording.
- `createBodySteam` (rendered L629-635) — replace with one line carrying **no count**: `"Du oppretter laget nå. Invitasjonslenken til resten kommer etterpå."` Render nothing when `teamSize === 1`. This closes two live bugs: `de 1 andre spilleren` (broken Norwegian for duos, `messages/nb/register.json:47`) and `de 0 andre spillerne` for 1v1, where `canInvite` is false so the promised invite panel never appears.

---

### 4. TOURNAMENT SURFACES — the tabs they live in during the LAN

**`src/components/tournament/MatchList.tsx`**
- **L126-134** — delete the `live &&` "Åpne bracketen" Link block. The bottom bar already carries Bracket with the same icon and word, and no match id is passed so the destination is identical. **⚠️ BREAKS E2E:** `e2e/public-tournament.spec.ts:91` asserts this control by role + text. Update that spec. *After:* KF3 "KALT OPP" rises ~56px — the call-up status stops being pushed toward the fold by a duplicate nav.
- **L33-39 + call sites L110-123** — stop printing `0` on unplayed matches. Gate on **"has a result", not "is live or done"**:
  ```ts
  const hasResult = isLive(s) || isDone(s) || match.homeScore !== 0 || match.awayScore !== 0;
  ```
  Render no span at all (not a dash) when false. A reopened match must never have its score hidden by a status string nobody enumerated.
- **L19-25 (`TeamRow`)** — keep `h-6 w-6 shrink-0` and the image; drop `border border-line bg-page` and the `Trophy` fallback. Empty transparent box when there is no logo. See the consistency note below — this is not a one-file change.

**`src/components/PublicBracket.tsx`**
- **L16-24 (`TeamRow`)** — same logo treatment. At the phone's clamped ~0.4 zoom the box plus `gap-3` is ~36px of a 260px card spent on a 9px grey smudge. **Do not** replace it with initials or a coloured dot.
- **L16-37** — same `hasResult` gate on the score span; eight fake zeros disappear (KF3, KF4, SF1, SF2, FIN). The live 0–0 and every finished score stay. While there: `scoreTone` gives a live match `text-fg-subtle`, the same grey as the zeros being removed — bump a live score to `text-fg` (matching `TournamentView.tsx:349`) or the cut buys less clarity than it should.
- **L42, L57 (`PublicMatchNode`)** — add CALLED rendering alongside LIVE (`isCalled(data.status)`, vocabulary already in `match-labels.ts:186` as `border-success text-success`). Right now "go to your seat" is invisible on the bracket.

**`src/components/LiveMatchCard.tsx` / `src/components/tournament/TournamentOverview.tsx`**
- `LiveMatchCard.tsx:22-26` and `TournamentOverview.tsx:149` — same logo treatment. **Decide per card / per grid, never per row:** if no team in the group has a logo, collapse the slot for all of them; if any does, hold an empty borderless slot for all. Row-by-row conditioning ships a ragged edge.
- `LiveMatchCard.tsx` — delete the full-width "Åpne bracketen" button and make the card itself the link. Give it a real accessible name ("Åpne bracketen — Oslo Owls mot Stavanger Storm") and a visible hover/focus ring. **Pick the destination from `getTournamentTabItems`, not a hardcoded `?tab=bracket`** — `tournament-tabs-config.ts:13-20` swaps bracket→leaderboard for BATTLE_ROYALE, and `TournamentView.tsx:156` only honours tabs in `validTabs`, so today that control is already dead in those tournaments.
- `TournamentOverview.tsx:142` — while in the file, the team chips are ~36px tall, under a comfortable thumb target. Removing the glyph will not fix that on its own.

**`src/components/tournament/TeamRegistry.tsx`**
- **L56-62** — render the logo container only when `team.logoUrl` is set; drop the `<Users>` fallback and the `border`/`bg-field` box. Team name starts at the card's left padding. *After:* ~52px back per card, and the "5 SPILLERE" badge stops being pushed at the card edge (the code comment at L63 is about exactly that).
- **L29-35 + L21** — delete the `registry.counts` line ("8 påmeldt · 40 spillere") and the `playerCount` reduce. Remove `registry.counts` from `messages/{nb,en}/tournament.json`. It is also **wrong**: it reads `teams`, not `filteredTeams`, so searching "nord" leaves it insisting "8 påmeldt".
- **BLOCKING companion — L117-119:** split the empty state before shipping the above, or an empty tournament renders a bare heading, a search box and `Ingen treff på «».` Add `registry.empty` ("Ingen lag påmeldt ennå.") and gate `noMatch` on `search` being non-empty.

**`src/components/ui/TournamentCard.tsx`** *(shared by landing + directory — see consistency note)*
- **L68, L75** — delete `<Trophy size={13}/>` and `<Users size={13}/>`; drop `Trophy, Users` from the lucide import at **L4** (`ArrowRight`, `Gamepad2` stay). **Keep both `.mds-stat` blocks and their `sr-only <dt>`s** — do not flatten to one "Single elim · 5v5 · 8 lag" string. *After:* the pulsing `mds-dot is-live` is the only glyph on that row.

---

### 5. PROFILE (`src/app/profile/page.tsx`)

- **L88** — delete `<p className="mds-uppercase-label">{t('profile.label')}</p>` ("SPILLERPROFIL"). **Required same-commit companion:** guard the name at L90 — `{session?.user?.name && <h1 …>}` (mirroring `PlayerHome.tsx:87`) or render a name skeleton while `status === 'loading'`, else the cut turns a loading page into a grey square over a void. Keep the string in messages.
- **L107** — delete `<Badge tone="ready">{t('profile.steamConnected')}</Badge>`. It is unconditional (no guard on the line), and `DiscordProvider` ships to production (`src/lib/auth.ts:18`), so a Discord sign-in is told it is connected to Steam. More importantly `tone="ready"` is the app's "you're up" green (`PlayerHome.tsx:118-119`, `marshal/dashboard/page.tsx:742`) — a permanent green chip on an account page devalues that colour everywhere.
- **L57-62 (`facts`)** — drop `statTournaments` and `statSeats` and their ICU strings from `messages/{nb,en}/player.json`. **Keep `statOpenMatches` for now** — it is the only match signal on the page, and removing it while leaving two duplicated counters is the worst of the three outcomes. (Tier 2 has the proper fix.)
- **L127** — delete `<p className="mds-uppercase-label">{t('tournaments.label')}</p>` ("TURNERINGENE DINE") — a section header over one card on a page with one section. Leave the string in messages (`PlayerHome` uses it twice). Check the card's top spacing on desktop afterwards; the `<section>` loses its first child.
- **Bigger question, flagged not prescribed:** `/profile` is structurally the desk minus the status chip — `view=profile` skips `activeMatches`, so it *cannot* show "DU ER OPPE". A kid tapping "Profil" at 2am sees B01 and a tournament name and no call state. If the merge into "Min side" is taken: fix the `TopNav` hamburger breakpoint first (`md:hidden` → `lg:hidden`, or show sign-out from `md`) or 768-1023px viewports lose sign-out entirely; add `reg.isLeader` to the desk's TournamentList card; and **leave `/profile` as a redirect, not a 404** — `CommandPalette.tsx:110` pushes to it and **`e2e/navigation-foundation.spec.ts:25` asserts it**.

---

### 6. DIRECTORY (`/tournaments`)

**`src/components/TournamentsOverviewClient.tsx`** (all line numbers confirmed against the file)
- **L91** — drop `eyebrow={t("eyebrow")}` ("OVERSIKT"). Remove the `eyebrow` key from `messages/{nb,en}/directory.json`. `PageHeader` guards on `eyebrow &&`. Check the header's top padding afterwards.
- **L93** — drop `subtitle={t("subtitle")}` and the key from both locales. `PageHeader` renders `{subtitle && …}`; `meta` supplies its own `mt-4`, so no stray gap. *After:* "Turneringer" → the red live line ~150px higher.
- **L94-101 + L73** — drop the `meta={liveCount > 0 ? … : undefined}` prop **and** `const liveCount` at L73 (unused afterwards, the build will fail otherwise). The LIVE chip is the same data and it *does* something. **Conditional on the LIVE chip keeping `tone="live"` red** — if a later pass neutralises the chip, revisit this. Remove the orphaned `runningNow` key.
- **L143-145** — delete the `<Badge tone="neutral" className="mds-tabular">{t("listed", …)}</Badge>`. `filtered.length` equals the active chip's own count in every reachable state, and the `isLoading ? "…"` branch is unreachable (the whole `mds-section-head` is gated on `hasAny` at L127, which is false while loading). On phone `.mds-section-head` is `flex-wrap` + `space-between`, so it wraps to its own row and shoves "Mortenlab LAN #7" down. **Scoped to this file only** — see consistency note.
- **L129** — delete `<h2 className="mds-uppercase-label mr-1 text-fg">{t("board")}</h2>` ("TAVLA"). It is ~90px of a 358px row and reads as a fourth, non-tappable chip — and in this app's Norwegian "tavla" means the **crew** board (`messages/nb/organizer.json` `marshalBoard: "Crew-tavla"`, `messages/nb/marshal.json` "crew-boardet"), so it points a kid at the wrong screen. **Condition:** in the same change give the chip wrapper `role="group"` + `aria-label={t("filterLabel")}` ("Filtrer turneringer") — it is currently the page's only `<h2>` and is wired to nothing.
- **L190-197** — delete the whole `<footer>`. It renders `Apex<span className="text-brand">Play</span>` — the last surviving instance of the retired product name, missed by the rename commit (confirmed: this is the only occurrence left in `src/`). Drop the `footer` key from `messages/{nb,en}/directory.json`. Leave `messages/*/notifications.json`'s separate `footer` key alone.

---

### 7. LANDING (`src/app/page.tsx`) — seen once, do last

- **L313** — delete the `<Badge tone="neutral">{t("listed", …)}</Badge>` after "TURNERINGER", **and** the now-single-child wrapper `<div className="flex items-center gap-3">` at **L314** so the heading sits flush and "Se alle →" recovers its room. Remove `listed` from `messages/{nb,en}/landing.json`. *(Note the disagreement in the audit: one reviewer defended this badge as the only count on a chipless section head, another ruled it cut because the nine-row fetch cap makes it unreliable. I am taking the cut — but if the board ever truncates, the honest replacement is "+3 til", not the pill.)*
- **L227 area** — drop `eyebrow={t("eyebrow")}` ("CS2 LAN-TURNERINGER") and the key. It is a hardcoded literal while `src/lib/games.ts` ships five games and the landing query selects `game` per tournament — a Fortnite bracket sits under a header that says CS2.
- **Hero title** — collapse. **Non-negotiable condition: do not ship without an h1.** Either make the h1 the live LAN's name ("Mortenlab LAN #7" — which converts the slot into an answer to question 1) or keep a visually-hidden h1. Nothing in `e2e/` asserts the landing h1, so no test will catch this.
- **L389-409** — delete the `<footer>` outright. Do not hide it below `md:` — the desktop screenshot shows both footer links already visible in the header at the same moment.
- **Do not cut the hero status line or the Steam button.**

---

### 8. LOGIN (`src/app/login/page.tsx`) — passed through once

- **L14** — fall back to `/dashboard`, not `/admin`. Compute `staff` from the explicit param only. **This is the highest-value fix on the page:** today every bare `/login` (the header link at `TopNav.tsx:110,178`, the landing CTA) evaluates `staff = true`, so every kid reads three lines about crew allowlists. It also stops dumping a freshly-signed-in player on `/admin`, where `middleware.ts:26` bounces them to `/`.
- **L30** — delete the 56px `bg-brand` tile and its `<ShieldCheck size={26} />`. *(Realistic gain is ~36px, not 72 — the block re-centres.)*
- **L47** — delete `<ShieldCheck size={17} />` inside the button and the now-unused `gap-3`. `.mds-btn-primary` is already `inline-flex; justify-content:center`.
- **L39** — drop `mds-card` from the wrapper. In production `MockPersonaButtons` returns `null`, so the panel wraps one button; `.mds-card:hover` also lights its border as if the panel were the target. Move the card onto `MockPersonaButtons` so the dev harness keeps a surface. Safe: `e2e/player-landing.spec.ts:57,60,82,93` keys on `steam-login` / `mock-persona-*`, both on the buttons.
- **L23-24** — delete the two `bg-brand/10 blur-[120px]` orbs **and** `bg-page` from the wrapper, so `globals.css`'s own global radial atmosphere (L233-238) shows through and `/login` matches every other screen. `relative`, `overflow-hidden` and `relative z-10` exist only to contain those divs and become dead.
- **L62** — delete `<p className="mds-uppercase-label">Steam OpenID</p>` — the only hardcoded, untranslated string on a fully `t()`'d page.
- Crew path (`/login?callbackUrl=/marshal|/admin`) keeps `blurbStaff`, trimmed to one line: "Logg inn med Steam. Crew-verktøy låses opp for kontoer på crew-lista."

---

## CROSS-SURFACE CONSISTENCY — get these wrong and the app looks half-done

1. **`TournamentCard` is one component, two boards.** Consumed by `src/app/page.tsx:351` (with `progress` + `liveCount`) and `TournamentsOverviewClient.tsx:173` (with neither). Every card edit — icons, footer row, game eyebrow — lands on both simultaneously. There is no "fix it on the landing page only" option.
2. **The empty logo box.** The same `logoUrl ? <Image> : <glyph>` fallback exists in `PublicBracket.tsx:19`, `MatchList.tsx:20`, `LiveMatchCard.tsx:22`, `TournamentOverview.tsx:149`, `TeamRegistry.tsx:56` and `TournamentView.tsx:692` — and the codebase cannot even agree on the glyph (`Trophy` in two places, `Users` in three), which is proof it depicts nothing. Change all six or none; a team must look the same on the bracket as it does one tap away on Lag. Decide per card/grid, not per row.
3. **Placeholder zeros.** `PublicBracket.tsx:16-37` and `MatchList.tsx:36-38` print the same unconditional `0`. Lift one shared `hasResult(match)` helper and use it in both, or the Bracket tab and the Kamper tab will disagree about the same match.
4. **Eyebrow policy.** The rule that survives adversarial review: *an eyebrow earns its place only when the `<h1>` cannot carry the page's identity.* That keeps `Arrangørpanel · {game}` (adds the game) and the marshal's "På gulvet"; it kills landing, directory, register, desk and profile, where the h1 is already the tournament, or is a person's name that the `aria-label` can cover. Apply the whole set or the app looks arbitrary.
5. **Uppercase-label policy.** `globals.css:299` defines `.mds-uppercase-label` as *a field label for the value beneath it*. Keep every instance where the value is meaningless alone — **PLASSEN DIN**, **LAG**, **SPILLERE (5/5)**. Cut every instance that names a page or a section of one item. Do not run a blanket sweep on the class.
6. **Colour semantics.** Green `tone="ready"` = "you're up". Red `tone="live"` = a match is being played. After the profile Steam badge goes, no surface may introduce a coloured status chip for a non-status fact. This is why the directory's LIVE chip must stay red, and why the desk's seat box loses its green border (the card frame already carries the state).
7. **Both footers die in the same commit.** Landing and directory. Leaving one is how the `ApexPlay` wordmark survived a whole product rename.

---

## E2E IMPACT (209 tests, copy- and testid-heavy)

| Change | Spec | Why | Fix |
|---|---|---|---|
| `hidden md:flex` on palette button | **`e2e/zz-nb-visual.spec.ts:186, :196`** | clicks `open-command-palette` inside a loop including `PHONE 390×844`; `hidden` = `display:none` | scope the palette leg to DESKTOP, or repoint phone at `tournament-open-command-palette` |
| same | `e2e/navigation-foundation.spec.ts:51` | hydration gate, default desktop viewport | **no change** |
| same | `e2e/zz-chrome-visual.spec.ts:140,177,186` | inside desktop-only blocks | **no change** — verify before landing |
| MatchList "Åpne bracketen" cut | **`e2e/public-tournament.spec.ts:91`** | asserts the control by role + text | update/remove that assertion |
| **Tier 2** search-field threshold | **`e2e/public-directory.spec.ts:101, :112`** | `getByPlaceholder('Filter tournaments…').fill(...)` after seeding only 2 tournaments | seed past the threshold, or rewrite around the new gate. **This is a real red build, not hypothetical.** |
| Moving `LocaleToggle` into the drawer | **`e2e/zz-nb-visual.spec.ts:169`** asserts the locale toggle is reachable **without opening the drawer**; `e2e/i18n-locale.spec.ts:33,45,64,83` drive `locale-toggle` directly | reads as a deliberate product decision | **do not move it** — strip its `border border-line bg-tint` instead |
| `/profile` merge | `e2e/navigation-foundation.spec.ts:25` | asserts the route | keep a redirect |
| Message-key deletions | `zz-*-visual*.spec.ts` | these shoot screenshots rather than assert copy | re-shoot; also rename `02-kampoppsett` / `11-r16-kampoppsett` → `bracket` in `zz-public-visual-nb.spec.ts:80,133` and fix the stale comment at `:3` |
| Login card wrapper | `e2e/player-landing.spec.ts:57,60,82,93` | keyed on button testids | safe |

**Not a code change:** the black "N" disc in the audit screenshots is the Next.js dev indicator. Production is clean. **Do not add `devIndicators: false` to `next.config.js`** — the key is correctly absent, and it is the one signal that catches dev-build screenshots in future audits. Re-shoot the audit set against `npm run build && npm start`. The phone capture filed under "Register — already on a team" is actually the *registration-closed* branch, so the highest-stakes layout in the app (seat + roster + invite code at 400px) has not been audited yet — worth more than any single cut above.

---

## TIER 2 — SHRINK (visual weight, not removal)

**Player desk / register (do with Tier 1):**
- `MyQueue.tsx` `fact.matchLine` — covered above; the shrink is the stage word surviving as muted text.
- `SeatEditor` — the seat is the highest-value string on `/profile` and renders smaller than "Logg ut". Demote sign-out to `variant="ghost"`, no border, no icon, and move it below the tournament card. **Do not remove it until the `TopNav` `md:hidden` → `lg:hidden` gap is closed.**
- `profile/page.tsx` avatar — render the tile only when `session.user.image` exists; delete the `Gamepad2` fallback and the `border border-line bg-card` that frames nothing (`TopNav.tsx:88` already does `image ? <Image/> : null` — the profile page is the deviation). Reserve the box while `status === 'loading'` so the name does not slide.
- `profile/page.tsx` `statOpenMatches` — replace the dead counter with the desk's existing `StateChip` on the profile tournament card. The count is `status: { not: 'COMPLETED' }`, so "being called right now" and "three rounds away" render identically; and `stats.liveMatches` is structurally always 0 in profile view (`route.ts:80,151`).

**Tournament chrome (`TournamentHero.tsx`, shared by all five tabs, outside the scroll container):**
- **L76-81** — drop `hero.teams` and `hero.matches` below `sm:`. **Keep `{gameMeta.name} · {format}` at all widths** — "Enkel utslagning" is the only public statement that one loss ends the night. Consider rewording to the plainer string the organizer wizard already ships (`messages/nb/organizer.json:95`, "Ett tap, og du er ute"). **Blocking companion:** `MatchList` has no empty state — ship `overview.notGenerated` ("Bracketen er ikke laget ennå.") in the same change, or removing "0 kamper" turns the zero-state Kamper tab into a blank screen.
- **L86-92** — the "● LIVE NÅ" pill: make it **tab-aware, not breakpoint-aware**. Render it only when `activeTab !== "overview"` (on Oversikt the section header 35px below says the same thing). Drop the border and `animate-pulse`; match the borderless dot + red label the section header uses. Make it a link to the live match. A `hidden lg:flex` gate would strip the only live signal from Lag and Spillere on a phone — that trades visible clutter for an invisible question-1 failure.
- **L93-96** — move "Del" into the existing `TournamentView.tsx:422-460` "Mer" sheet below `lg`, labelled "Del lenke" with a `Share2` icon, **above** the Kommandopalett row. Upgrade `onShare` (`TournamentView.tsx:194-197`) to `navigator.share({title, url})` with the clipboard copy as fallback — that makes the extra tap a net win, not a demotion.

**Bracket canvas (`PublicBracket.tsx:203-222`, `TournamentView.tsx:225-232`) — the biggest readability win in the audit:**
- `fitViewOptions={{ padding: 0.06, maxZoom: 1 }}` with `minZoom={0.4}` clamps an 8-team bracket to 0.40 in a 358px card. That single clamp produces all three reported symptoms at once: ~182px of empty band, ~2px horizontal overflow clipping the FINALE card, and team names at ~4.8 CSS px. Raise `minZoom` to ~0.8, stop fitting the whole tree on phones, open centred on the live-or-next match (`setCenter`, or `fitView` on a node subset), and let the container height follow the bracket instead of `h-[52vh]`. The clipping fixes itself.
- `TournamentView.tsx:233` — the pan-hint paragraph: gate on `matches.length > 0` first (today it instructs a kid to pinch a blank grid on an ungenerated bracket — a lecturing empty state). Then give the match node an `active:border-brand active:bg-field` pressed state and cut "Trykk på en kamp for detaljer". **Keep a short clause about off-screen content unless the canvas gets an edge affordance** — do not ship the pressed state alone and leave the finale silently cut off.
- `TournamentView.tsx:226` — the bracket tab has no empty guard at all. Copy the shape from `ManageControl.tsx:358`.

**Teams tab (`TeamRegistry.tsx`):**
- **L25-36** — hide the whole header `<div>` (heading + counts) on phone; `<h2>` goes `sr-only md:not-sr-only`. Drop `border-b border-line pb-6` on small screens. First team name moves from ~47% down the screen to near the top. (This heading is `text-2xl` while its siblings are `text-lg`/`text-base` — shrinking it is a consistency fix.)
- **L75-77** — delete the blue `5 SPILLERE` badge; fold the count into the existing muted meta line as `SEEDING 1 · 5 SPILLERE`. Today the loudest blue on the card is a count, and the seat pills a kid is hunting for use the *same* `bg-brand-soft text-brand` at a smaller size. On this surface blue must mean seat.
- **L66-73** — delete the `seedEmpty` else-branch outright ("Seeding —" on every card is the normal pre-draw state) and render the seed as a quiet `#4` in the header row, matching `TournamentOverview.tsx:156-160`.
- **L106-112** — make the whole card the tap target and delete the repeated "Detaljer →" bar (~52px × 8 teams ≈ one full viewport of scroll). **Ship the chevron in the same commit**, never after. Do **not** wrap the card in `<button>` (it contains `<h3>` and `<ul>`) — make the name row the button with `aria-label="{team.name} – detaljer"` and stretch the hitbox with an absolutely-positioned `::after`. If a label survives, make it "Kamper", not "Detaljer".
- **L85** — drop `rounded-sm bg-field` from the player `<li>` (in dark mode `--mds-card` and `--mds-input` are the same token, so it paints nothing; in light mode it is an accidental zebra). **Keep the vertical padding** (`py-1`) and drop `px-2` so seat chips align flush with the team name.

**Boards (`TournamentCard.tsx` + both call sites):**
- **L104-111** — delete the `border-t` footer row; move `mt-auto` onto the `<dl className="mds-stat-row">` with `justify-between` and put the `ArrowRight` (size 16, `aria-hidden`, keep `group-hover:translate-x-0.5`) at the right of that row. **Keep the verb as an `sr-only` span** — do not use `aria-label` on the `<Link>`, which would erase the accessible name. ~45px + a rule back per card.
- **L59** — make `game` optional and render the eyebrow only when the **unfiltered** board spans more than one game (compute over `tournaments`, not `cards`, or it flickers mid-keystroke). Apply the same rule on the landing board or the two boards diverge. *Adjacent bug:* the card shows `gameMeta?.name` ("Counter-Strike 2") but search matches `row.game` ("CS2") — a kid typing "counter" gets the no-results state.
- **L87-102** — drop the 1px progress bar and the "KAMPER SPILT" label row; fold the figure into the meta row as plain text ("… · 8 lag · 1/7 spilt"). **Do not cut the number** — the no-live-match lull is when it is the only signal left — and do not make it conditional on a live match.
- **L79-83** — render the live-match stat in the same muted tone as its siblings; the small `mds-dot is-live` stays red. One red chip + one red dot per card instead of a chip, a phrase, a border and a bar.

**Directory + landing prose:**
- `TournamentsOverviewClient.tsx:102-123` — gate the search field on `searched.length > 6 || searchQuery.length > 0`. The `|| searchQuery` half is mandatory: honouring `?search=` while hiding the input produces a filtered-to-empty board with "fjern filteret" and nothing to tap. Test the pre-filter length, never `filtered.length`. **⚠️ breaks `public-directory.spec.ts:101,112`.**
- Same file, chip row **L127** — gate on `hasAny && searched.length > 6 && stageCounts.length > 1`. Separately, filter `DRAFT` out of `stageCounts` unless `role` is admin/marshal — "UTKAST" is organizer vocabulary for something a kid cannot enter. **Keep the UTKAST card and its badge**; only the chip goes.
- Landing hero subtitle — cut four lines of product pitch ("seedet bracket, live kampkontroll og en OBS-overlay — én flate hele rommet kan følge") to one kid-facing line at body size: nb `"Se hvem som spiller nå, følg bracketen og meld deg på."` Change `.workspace-subtitle` on this page from `--fs-lead` to body size. Single consumer (`page.tsx:227`), no test coupling.
- Landing `moreCalled` — drop the count, keep the word: render a plain "KALT OPP" sub-label directly above the `calledMatches` grid (`page.tsx:301`) instead of a right-aligned counter 250px above the card it describes.
- Landing hero status line — drop it in the live state (the red-dotted "SPILLES NÅ" heading and the scorebug own that job on the same screen, with team names). **Keep the slot for the not-live states and fix the bug it hides:** when `liveMatches.length === 0 && calledMatches.length > 0` the hero currently prints "Ingen kamper spilles akkurat nå" while a KALT OPP section renders below it. Also: `liveMatches` is sliced before the hero count is computed (`page.tsx:192` vs `:232`), so with >6 live matches the hero states a false number.
- Landing DRAFT cards — **do not** filter on `stage === "DRAFT"`: `getTournamentStage()` derives DRAFT from "fewer than 2 teams", so a sign-up-open tournament would be invisible until two teams join, and two teams cannot join if nobody can find it. Filter on the real flag `!steamSignupEnabled` instead (add it to the `findMany` select at `page.tsx:164-172`), keep admins seeing everything, and for a published tournament with no bracket yet say "Påmelding åpen" / "Meld deg på" instead of "Utkast" / "Åpne turneringen".
- `TournamentOverview.tsx:68` — replace the red `bg-gradient-to-r from-danger to-transparent` hairline with the flat `bg-line` rule "NESTE KAMPER" uses 40 lines down; drop `animate-pulse` from the section-head dot. **Keep the section head unconditionally** — do not gate it on `liveMatches.length > 1`; structure that appears and disappears between page loads is worse for a glancing kid than structure that is always in the same place.
- `TournamentOverview.tsx` Deltakerne card — hide the chip grid and "Se alle lag →" on phone **only when `matches.length > 0`**; keep the `<section>`, the stage line and the champion banner in every state. When no bracket exists yet, the chips are the only content on the tab.
- `MatchList.tsx:76` — `hidden md:block` on the `h-px flex-1 bg-line` spacer. `space-y-10` between sections vs `space-y-4` within already states the boundary on a single-column phone. **Do not pattern-match this onto `TournamentOverview.tsx:87`** — that one holds the "Alle kamper" link at the right edge.
- `TopNav.tsx:129-130` — move `ThemeToggle` into the `md:hidden` drawer (its pre-mount placeholder currently renders an empty bordered box in the header on every first paint). **Keep `LocaleToggle` in the bar** but strip `border border-line bg-tint` so it matches the borderless ⌘/☰ weight class — `zz-nb-visual.spec.ts:169` asserts it is reachable without opening the drawer, and the kid who needs it is precisely the kid who cannot read the drawer it would hide in.
- `register/page.tsx:649-674` — collapse "LAGLOGO (VALGFRITT)" behind a "Legg til laglogo" disclosure link placed **after** the seat field, so seat sits directly under team name. **Blocking companion:** port the DiceBear default from `teams/route.ts:220-222` into `signup/route.ts:94` first, or the higher skip rate leaves null logos in the bracket and the OBS overlay.

---

## DO NOT TOUCH

Drawn from the must-keep notes. Removing any of these is a worse failure than every cut above combined.

**Seat and identity**
- `B01` and **its `PLASSEN DIN` label** — everywhere it appears: the desk call card, `/profile`, the register team panel. The label is not a header over a single item; without it "B01" is a mystery number. Cut one of the `LAG` / `PLASSEN DIN` pair and the survivor reads as a mistake.
- The **`Rediger` pencil inside the call card** — the only route a kid has to fix a wrong seat. (The *duplicate* pencil in the filtered-away bottom card goes; this one never does.)
- **Per-row seat numbers** in the register roster and the Teams tab (`A01…A05`, `B01…B05`) — for the other four players this is the only place their seat exists.
- The **`DEG` badge** on the register roster — the only marker of which row is the viewer.
- The player's own name in the desk header and on `/profile` — kids hand each other phones at a LAN.

**Status and calls**
- The solid green band **"Din tur — gå til plassen din"** at full width, at its current size. Nothing may shrink it or push it down.
- All four status badges — **LIVE (red), KALT OPP (green), FERDIG, SATT OPP** — and the colour distinction between them. `KALT OPP` is the get-to-your-seat signal.
- The **red border** on the live match card (bracket, MatchList, TournamentCard) — finds the live match at arm's length in a noisy room, faster than any badge text.
- The **red `LIVE` badge** on the directory card and the landing scorebug.
- The landing **LIVE scorebug** in full: team names, score, "Mortenlab LAN #7 · Runde 1 · Bo1", as one tap target.

**Opponent, team, result**
- Every team name and nickname, everywhere, untruncated — including the greyed loser (grey *is* the information) and the placeholder slots **"Vinner av KF2" / "Vinner av SF1"**. Never blank those to "TBD".
- The **short match refs KF1-KF4 / SF1 / FIN** — "Vinner av KF2" and the bracket both cross-reference them.
- The **round labels** (`KVARTFINALE` / `SEMIFINALE` / `FINALE`) on bracket nodes — `data.stageName` at `PublicBracket.tsx:56` is the *only* round vocabulary on the phone Bracket tab (the desktop rail is `hidden lg:flex`). In double elimination `buildLayout` places losers round *r* in the same column as winners round *r*, the grand final and the reset in the same column, and third place in the semifinal column — the word is the only thing separating them. **Explicitly defended; do not cut.**
- **`Bo1`** on landing match cards, and `Enkel utslagning` in the hero — one map not three; one loss ends the night.
- All scores on live and finished matches, including a live `0–0`, and the green/grey winner split in SISTE RESULTATER.

**Routes that are the only route**
- The **☰ hamburger** on phone — the only path to Logg inn / Min side / Crew.
- The **🌐 NB locale control in the bar** — the only way back for anyone stranded in the wrong language, and the only one of the header icons that says what it does.
- The **"Se bracketen →"** button on the desk call card — the only "what's next" once the duplicate tournament card is filtered away.
- **"ALLE KAMPER"** on the overview — on phone "Kamper" is pushed into the "Mer" sheet, so this link is the practical route to the schedule.
- **"Se alle →"** on the landing board (`LANDING_LIMIT` caps it at 9).
- The **invite code block** and both copy controls on the register team panel — invisible in the audit screenshots because that team was full and locked, and therefore exactly the kind of thing a removal pass loses by accident.
- Both register footer links — "Åpne turneringssiden" and "Gå til desken min" go to different places and each is the only route to its destination. (Restyle the ranking — the desk is the more useful and is currently the fainter — do not delete either.)
- **"Tilbake til turneringen →"** on the closed card, and **"← Tilbake til forsiden"** on login.
- The **`Skru på kampvarsler` button** itself — push is how a kid at the kiosk learns they were called.
- A visible sign-out somewhere: the `TopNav` drawer item stays regardless of what happens to the `/profile` button.
- The **"Del" control** — not one of the four questions, but the only way to hand the link to a teammate or a parent. It may move into the "Mer" sheet; it may not disappear.
- The bottom tab bar in full. Several cuts above lean on it being permanently on screen.

**The "Spillere" tab keeps its prime slot in the bottom bar.** It is the seat directory (Player · Team · Country · Seat — no stats), and it is the only flat, team-agnostic roster: the only route to a seat when you do *not* already know the team. `StatsTable.tsx:31-32` documents a phone layout built specifically to keep the seat column on screen. **Explicitly defended; do not demote it to make room for "Kamper".**

**Also keep:** the `TESTBRUKERE` persona block (env-gated by `NEXT_PUBLIC_MOCK_AUTH`, invisible in production, load-bearing for local dev and E2E); the `UTKAST` badge on the directory card (honest "nothing to sign up for" signal); `8 lag` / `0 lag` team counts on the board (scale signal — "be first" vs "this is the main event"); the tournament name repeated at the foot of each landing match card (with two LANs live it is the only thing saying which card is yours); the `2 PER LAG` badge on register (once the leader prose is cut it is the only signal of team size); the `CS2` badge on the profile card (five games are supported); the yellow `Bracketen er live — laget er låst` notice; `SPILLERE (5/5)`; and **LIVE-first card sorting** (`BOARD_ORDER`) — the directory cuts are only safe because it guarantees the live tournament is the top card.
