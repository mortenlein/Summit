# Summit Discord bot — build specification

_Designed 2026-09-20. Five areas (identity linking, event model, second-container ops, DM
deliverability, Norwegian copy) were designed independently, each attacked by an independent
reviewer, then merged. **All five came back `needs-revision`** — the spec below reflects the
fixes, not the first drafts._

---


> **OWNER CORRECTION, 2026-09-21 — read this before the spec.**
> These players are **at their PCs with Discord open. Discord is the primary channel**, not a
> complement to anything. Sections written on the older "Discord is unreliable for these kids"
> premise are wrong in their framing — specifically §3(b) (PWA/iOS web push) is **out of scope
> and will not be built**, and §9's hedging should be read as ordinary error handling, not as a
> reason to route around Discord.
>
> What survives from those sections is only the genuine Discord mechanics: a bot cannot DM a
> user who has DMs from server members switched off (error 50007), and that has to be detected
> and shown to an organizer rather than assumed. That is a Discord constraint, not an argument
> against Discord.
>
> §3(a) also stands and is a real blocker: organizer-typed players get no `userId`, so they can
> never link a Discord account and can never be DM'd.

# Summit Discord bot — merged build specification

*Every repo claim below was checked against the working tree at `859b8ee` on 2026-09-20. Where the five area designs disagreed, §13 says which won and why; where a reviewer was overruled, §14 says so.*

---

## 1. The shape, in one table

| Question | Answer | Loser |
|---|---|---|
| Who talks to Discord's REST API? | **The app** (`summit`). It already constructs `new REST().setToken(DISCORD_BOT_TOKEN)` at `src/lib/discord.ts:38`. Channel posts *and* DMs go through it. | A bot that drains a queue |
| What is the second container for? | **Gateway interactions only**: `/koble`, `/stopp`, the *Stopp DM* button. ~130 lines, no database, no i18n, no send path. | A bot that owns delivery |
| App → bot transport | **None.** There is no app→bot direction. | Outbox / poll / SSE / shared SQLite |
| Bot → app transport | `POST /api/discord/link` + `POST /api/discord/optout`, bearer `SUMMIT_BOT_KEY`, over the compose network at `http://summit:4001` | A second Prisma client on `data/prod.db` |
| Durability of a match DM | **None, deliberately.** A "go to your seat" DM that survives a restart and lands 20 minutes late sends a kid to a station someone else is playing at. | `OutboxEvent`, leases, TTL matrices, reconcilers |
| Idempotency | `DiscordDmAttempt` with `@@unique([matchId, event, userId])` | A 10-second time window |
| Observability | One `DiscordDmAttempt` row per recipient per send, surfaced on the marshal board and the organizer panel | "it returned 204" |

**This does not relitigate the gateway decision.** The always-on second container still exists and is still a gateway bot. What changed is that two independent reviewers (identity, deliverability) both concluded the send path belongs in the app, and they are right: the app already holds the REST client, the token, the Prisma client, the recipient list and every Norwegian string. Putting delivery in the bot means the bot holds all four too. Bot downtime now costs exactly one thing — nobody can link while it's down — and costs nothing on LAN night.

---

## 2. Step 0: ten minutes that ships three of the owner's five asks

Verified on the host: production `.env` contains `NEXTAUTH_SECRET, STEAM_API_KEY, ADMIN_STEAMIDS, MARSHAL_STEAMIDS, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT` — **no `DISCORD_*` of any kind, and no `CS2_WEBHOOK_KEY` either.** So `src/lib/discord.ts:129` computes `isProdReady = false` and every announcement since the feature was written has taken the `[STRATEGY 3 MOCK]` branch at `:138`. Channel announcements are **built but have never run in production.**

```
# .env on ash — this is the whole change
DISCORD_BOT_TOKEN=...
DISCORD_CHANNEL_ID=...      # #turnering
DISCORD_LOCALE=nb
```
`docker compose -f docker-compose.prod.yml up -d summit`

That delivers owner asks **#2 (live)**, **#3 (results)** and **#5 (channel messages)** with zero code. Ask **#1 (upcoming)** is one message key away (§7). Only ask **#4 (DMs)** needs the rest of this document. Do this first, today, before writing a line of the bot — it is the highest value per minute in the entire brief, and it also proves the token and the channel id work before anyone depends on them.

---

## 3. Adjacent findings that change what this feature is worth

Two verified facts about the repo make the DM feature serve a minority of a minority unless they are fixed first. Neither is Discord work. Both are cheap.

**(a) Organizer-typed players have no `User` row, so they are unreachable by every channel.** `src/app/api/teams/[id]/players/route.ts` creates a `Player` with `name, nickname, countryCode, seating, steamId, isLeader, teamId, tournamentId` — and **no `userId`**, even when `resolveSteamId()` succeeded three lines earlier. The Steam-signup path (`tournaments/[id]/signup/route.ts:83,102,136,170`) does set it. So a roster typed in by an organizer gets no push, no DM, and cannot run `/koble` (a link binds `User`, and no `Player` points at it).

Fix, ~20 lines: on player create/update, if `steamId` resolved, `prisma.user.findUnique({ where: { steamId } })` and set `userId`. Plus a reconciliation at Steam sign-in that back-fills `Player.userId` for rows matching the new user's `steamId`. Watch the `@@unique([tournamentId, userId])` constraint — swallow `P2002` and leave the row unlinked rather than 500ing the roster editor.

**(b) iPhone players cannot receive web push at all.** There is no `public/manifest.json` (verified: `public/` holds `file.svg globe.svg images logos next.svg sw.js uploads vercel.svg window.svg`) and `src/app/layout.tsx` declares neither `manifest` nor `appleWebApp`. iOS only permits Web Push for a site installed to the Home Screen from a manifest with `display: standalone`. In a Norwegian 12–15 cohort that is most of the roster. The premise "Discord is a complement to a working push channel" is therefore false today — push is missing for the majority, and Discord would be complementing nothing.

This is out of scope for "the Discord bot" and I am not putting it in the build order below as a blocker. But the owner should know that an afternoon on the manifest is worth more to the LAN than this entire document, and that the reach panel's green badge measures Android-and-laptop only until it is done.

---

## 4. Schema changes — all of them, in one place

One migration for the feature, one rider that can be cut.

**`prisma/migrations/20260922090000_discord_link/migration.sql`**

```prisma
model DiscordLink {
  userId          String    @id
  discordId       String    @unique
  discordUsername String
  /// Cached DM channel from POST /users/@me/channels. Latency only — never trusted:
  /// a 404/10003 clears it and the next send re-opens.
  dmChannelId     String?
  /// UNKNOWN | SENT | BLOCKED. Rewritten by EVERY send, not just at link time.
  /// SENT means Discord accepted the message. It does NOT mean a kid read it.
  dmState         String    @default("UNKNOWN")
  dmCheckedAt     DateTime?
  dmError         String?
  /// One tap on the Stopp DM button, or /stopp. Absolute; checked at fan-out.
  optOut          Boolean   @default(false)
  linkedAt        DateTime  @default(now())
  updatedAt       DateTime  @default(now()) @updatedAt
  user            User      @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model DiscordLinkCode {
  code      String   @id                 // 6 chars, uppercase, see §6
  userId    String   @unique             // one live code per user, for free
  expiresAt DateTime
  createdAt DateTime @default(now())
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}

/// One row per recipient per send attempt. This is the anti-assumption mechanism:
/// nothing in the UI may say "varslet" that is not backed by a row here.
model DiscordDmAttempt {
  id          String   @id @default(cuid())
  userId      String
  discordId   String
  event       String            // LINK_PROBE | MATCH_CALLED | MATCH_LIVE
  matchId     String?           // null for LINK_PROBE
  outcome     String            // SENT | BLOCKED | UNKNOWN_USER | RATE_LIMITED | ERROR | SKIPPED_OPTOUT
  discordCode Int?              // Discord's JSON error code, e.g. 50007
  locale      String
  createdAt   DateTime @default(now())
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([matchId, event, userId])
  @@index([matchId])
  @@index([createdAt])
}
```

`User` gains `discordLink DiscordLink?`, `discordLinkCode DiscordLinkCode?`, `discordDmAttempts DiscordDmAttempt[]`.
`Tournament` gains `discordDmPaused Boolean @default(false)` — the phone-reachable kill switch (§10).

SQLite treats NULLs as distinct in a unique index, so `LINK_PROBE` rows (`matchId = null`) never collide and a probe can be re-run. `MATCH_CALLED` rows do collide, which is the point: a marshal double-tapping "Kall opp" writes one row per player and sends one DM.

**Rider — `prisma/migrations/20260922090100_match_called_at/migration.sql`:** `Match.calledAt DateTime?`, stamped in `load/route.ts` beside the status write. Not needed by the DM feature, but `src/app/marshal/dashboard/page.tsx:205` currently renders "called N min ago" from `match.updatedAt`, which is `@updatedAt` — so an organizer fixing a server password on a READY match silently resets the clock to zero. One column, one line, fixes a live bug the crew already relies on. Cut it if you want a pure-Discord migration.

`Dockerfile:68` runs `prisma migrate deploy` in the container CMD, so both apply on the next `up -d`. (Note: the build-time `npm run build` → `scripts/migrate.js` targets `file:./dev.db`, not prod — the boot-time CMD is what migrates `data/prod.db`, on every restart.)

---

## 5. Environment variables — all of them, in one place

### App container `summit`, file `.env` (chmod 600, exists)

| Var | Purpose | Notes |
|---|---|---|
| `DISCORD_BOT_TOKEN` | Channel posts **and** DMs, via `@discordjs/rest` | Same token as the bot's — a gateway bot cannot avoid this |
| `DISCORD_CHANNEL_ID` | `#turnering` | Already read at `discord.ts:34` |
| `DISCORD_WEBHOOK_URL` | Alternative to the two above **for channel posts only** | A webhook cannot DM. If both are set, `discord.ts:47` prefers the webhook and DMs still need the token |
| `DISCORD_STAFF_CHANNEL_ID` | `#crew` delivery mirror (§9) | Optional; omit and the mirror is skipped |
| `DISCORD_LOCALE` | `nb` | Already read at `src/i18n/server.ts:34` |
| `DISCORD_GUILD_ID` | Gates `isDiscordLinkConfigured()` | Already documented at `.env.example:72` |
| `DISCORD_INVITE_URL` | Guild invite shown as step 1 of the profile card | **New; required.** See §6 |
| `SUMMIT_BOT_KEY` | Bearer the bot must present. `openssl rand -hex 32`. **Fail closed (503) if unset**, the posture `CS2_WEBHOOK_KEY` already has | Must not be `CS2_WEBHOOK_KEY` |
| `DISCORD_DM_ENABLED` | Hard master switch, default `false` | Ships `false`; flip to `true` after rehearsal |
| `DISCORD_DM_LOG` | Path; one JSON line per attempt | Mirrors `PUSH_DELIVERY_LOG`. At 02:00 "did the DM go out" must be answerable from a file |
| `DISCORD_CLIENT_ID` | Kept — the bot registers commands with it | **Rewrite the comment at `.env.example:66-69`**, which calls it "Optional Discord OAuth sign-in". After §11 that sentence is false |
| ~~`DISCORD_CLIENT_SECRET`~~ | **Delete** | Only the dead OAuth provider used it |

### Bot container `summit-bot`, file `.env.bot` (new, chmod 600; `.gitignore` is `.env*` with `!.env.example`, so it is covered on creation)

| Var | Purpose |
|---|---|
| `DISCORD_BOT_TOKEN` | Gateway connection |
| `DISCORD_CLIENT_ID` | Application id, for guild command registration |
| `DISCORD_GUILD_ID` | Commands are guild-scoped (instant propagation; global takes up to an hour) |
| `SUMMIT_API_URL` | `http://summit:4001` — container network, never the tunnel |
| `SUMMIT_BOT_KEY` | Same value as the app's |
| `BOT_HEALTH_PORT` | `4002`, bound to **`0.0.0.0`** inside the container (a loopback-only listener passes the HEALTHCHECK while the published port and the app's fetch both fail — the exact 01:00 confusion to avoid) |
| `TZ` | `Europe/Oslo` |

**Do not give the bot `env_file: .env`.** The app's file holds `NEXTAUTH_SECRET` and `STEAM_API_KEY`; an always-on process with an outbound socket to Discord has no business with either. Also set `TZ: Europe/Oslo` on the **`summit`** service — verified it has none today, so it logs UTC and the two streams would disagree by two hours at 01:00.

`.env.example` documents every key above with empty values. Both containers' keys go in it; the app `CLAUDE.md` requires it stays in sync.

---

## 6. Identity — `/koble <kode>`, redeemed in the guild

### Why this and not OAuth

Keep area 1's recommendation, but lead with the argument that survives review. The deciding property is **not** "a kid can't remember their Discord password" (asserted, not evidenced; on a phone an OAuth URL is usually deep-linked into the installed app and authorises in one tap). The deciding properties are:

1. **The link and its deliverability are proven in the same gesture.** `/koble` ends inside Discord, so the probe DM's result is reported in the exact place the DM would have landed. We never hold a `discordId` we silently cannot reach.
2. **Guild membership is proven for free.** A guild slash command can only be invoked by a member, and that is the precondition for DMing. No `GUILD_MEMBERS` privileged intent.
3. **No token of any kind is stored.** We hold a public snowflake the user volunteered. That is a materially better answer to a parent than "we hold an OAuth credential for your child's Discord."

### The flow

1. `/profile` → **Koble Discord**. `POST /api/me/discord/code` mints a code: 6 chars from `23456789BCDFGHJKMNPQRSTVWXYZ` (no `0/O/1/I/L`, no vowels, so it cannot spell a word), 10-minute TTL, single use, `userId @unique` so a new code replaces the old one. Deliberately **not** the existing invite-code recipe `uuidv4().slice(0, 8)` (`signup/route.ts:96`) — that contains `0`, `1`, `l`, `o` and is fine to paste, wrong to type under pressure.
2. Card renders three steps, in this order:
   **1.** Join the server → `DISCORD_INVITE_URL`. *(A kid who has Discord but was never added to 6614gamers has no path at all otherwise: `/koble` does not exist for a non-member and does not autocomplete. This was a fatal gap in the original design.)*
   **2.** Type `/koble`, **pick it from the menu**, paste the code.
   **3.** The copy button copies **only the code, never the slash** — pasting `/koble H7K2QP` sends a plain text message, because Discord's autocomplete fires only on a typed `/`. The argument is named `kode` so Discord's own UI labels the field. `/koble` with no argument is valid and replies with the instructions.
3. The card **polls `GET /api/me/discord` every 3s while a code is live** and stops at expiry. Without this the kid runs the command, tabs back to a stale page showing the same code, and concludes it failed. This will happen to most of the first cohort otherwise.
4. Bot handler, first line, non-negotiable: `await interaction.deferReply({ flags: MessageFlags.Ephemeral })`. The round trip to Summit plus a DM probe is comfortably over Discord's 3-second ACK; without the defer, a *successful* link shows a red "The application did not respond", and the kid runs it again.
5. Bot → `POST /api/discord/link { code, discordId, discordUsername }` with `Authorization: Bearer $SUMMIT_BOT_KEY`, `AbortSignal.timeout(8000)`.
6. **The app** resolves the code, writes the `DiscordLink`, opens the DM channel, sends the probe DM, writes a `LINK_PROBE` `DiscordDmAttempt`, sets `dmState`, and returns `{ ok, reply }` where `reply` is an **already-rendered localized string** in the linking user's `User.locale`. The bot renders nothing but a hardcoded fallback if the app is unreachable. Every Norwegian character stays in `messages/`, under `npm run i18n:check`.
7. Bot `interaction.editReply(reply)`.

### Conflict resolution on redemption — by owner, not by existence

This is the fix for a fatal bug in the original design: its own recovery copy (`"kjør /koble på nytt"`) hit `discord_taken`, because on the second run the `discordId` is already bound — **to the same user**.

```
existing = DiscordLink where discordId = <snowflake>
  none                     → create. 
  existing.userId == code.userId → IDEMPOTENT RE-LINK: update username,
                                   clear dmChannelId, re-probe, reply as a fresh link.
  existing.userId != code.userId → refuse: reason "discord_taken".
```
Only a *different* user's claim is refused, and it is refused rather than silently stolen — silent stealing means the first kid stops getting DMs with no signal anywhere. The refusal names the remedy ("Si fra til crewet"), and **the organizer unlink button must therefore ship in the same step as `/koble`, not later** — otherwise that sentence is a lie for a week.

### App surface

```
GET    /api/me/discord              → { configured, linked, username?, dmState?, optOut?,
                                        code?, codeExpiresAt?, inviteUrl }
POST   /api/me/discord/code         → { code, expiresAt }
DELETE /api/me/discord              → self-unlink (deleteMany, never throws P2025)
PATCH  /api/me/discord              → { optOut: true|false }
POST   /api/discord/link            (bot, bearer) → { ok, reason?, reply }
POST   /api/discord/optout          (bot, bearer) → { ok, reply }
DELETE /api/discord/link/[userId]   (requireAdminApi) organizer unlink + recordAudit
GET    /api/tournaments/[id]/discord-reach   (requireStaffApi)
```

All self-service routes use `requireSignedInUser` + `export const dynamic = 'force-dynamic'`, the pattern at `src/app/api/me/player/route.ts`. Unlink uses `deleteMany` and state writes use `updateMany` so two admins clicking at once, or a `PATCH` racing an unlink, no-op instead of 500ing a staff screen.

`isDiscordLinkConfigured()` = `Boolean(SUMMIT_BOT_KEY && DISCORD_GUILD_ID && DISCORD_INVITE_URL)`, mirroring `isPushConfigured()` at `src/lib/push.ts:9-11`. The profile card renders only when true — no new `NEXT_PUBLIC_*` flag to forget, same as how `EnableAlertsButton` hides itself with no VAPID keys.

### Where it lives, and where it deliberately does not

- **`/profile`.** Its own header comment says a "second 'linked account' nobody links" is deliberately absent — true when written, false the moment linking is backed by a table. Use the inline treatment from `EnableAlertsButton` (small icon + small text). **Never `Badge tone="ready"`** — that green is reserved for "din tur".
- **Player desk (`PlayerHome.tsx`): nothing. No card, no badge, no nag, ever.** `docs/kid-clutter-plan.md` is actively stripping that surface.
- **Acquisition happens in Discord.** The organizer pins the three-step instruction in `#turnering`. That reaches exactly the kids who look at Discord, without spending a pixel on the ones who don't. Plus one line on the registration-success screen, days before the LAN.
- **Public roster / OBS overlay: never.** `discordId` never leaves the server at all; `discordUsername` goes to staff only. Summit `CLAUDE.md` rule 2.

---

## 7. What gets announced, and where

| Owner ask | Event | Channel post | DM | Fired by |
|---|---|---|---|---|
| #1 upcoming | `MATCH_UPNEXT` | ✅ grey, no glyph, no ping | ❌ | **`handleAdvance` at `matches/[id]/route.ts:174`** — already fires the instant a downstream match acquires both teams |
| #2 live | `MATCH_LIVE` | ✅ 🔴 red | ✅ *only if this match never DM'd `MATCH_CALLED`* | `matches/[id]/route.ts:213`, `webhooks/cs2/route.ts:242` |
| — | `MATCH_CALLED` | ✅ 🟢 green | ✅ **the one that matters** | `matches/[id]/load/route.ts:65` |
| #3 results | `MATCH_RESULT` | ✅ ✅ blue | ❌ | `matches/[id]/route.ts:139` |
| #5 channels | `BRACKET_LIVE`, `SIGNUP` | ✅ existing | ❌ | `generate/route.ts:155`, `signup/route.ts:114,187` |

**Ask #1 needs no new machinery.** `handleAdvance` already calls `announceMatch` the moment a next match gets both teams — that *is* an "upcoming" post, currently mislabelled with the same `discord.matchTitle` ("Match ready for players") as a real call-up. Give it a distinct message key and a grey embed and ask #1 is done, one key, no scheduler, no reconciler, no `scheduledAt` column. The cadence is correct for parallel rounds too, because each match announces itself as it becomes playable. Bracket generation does *not* go through this path (`generate/route.ts` deliberately collapses to one summary), so there is no 32-match burst.

**No result DMs.** A kid who just finished knows the score. This also deletes an entire bug class: the losers/bronsefinale split (`Tournament.hasThirdPlace` exists and `bracket-utils.ts` writes `THIRD_PLACE` with a `loserNextMatch`, so "det var siste kamp" is wrong for a semifinal loser whenever third place is on). Results go to the channel only.

**Embed colours are inverted today and must be fixed.** `discord.ts:193` paints a *called* match `0xff1744` (red) and `:224` paints a *result* `0x00c853` (green). Everywhere else in the product green means "din tur" and red means live. A kid who learned the app reads a green Discord post as a call-up when it is a finished score. Fix: called `0x00C853`, live `0xFF1744`, result `0x0070F3`, up-next `0x6B7280`.

**No role pings on per-match posts.** A channel that pings thirty times an evening gets muted, and a muted server suppresses DMs too. Pings survive only on `bracketLive` and the champion post, and only if the club wants them (§15).

**Seats stay out of the player channel.** `src/app/api/discord/announce/route.ts:41-42` puts `${nickname} (${seating})` for every player into the embed — verified, and it is live today on the manual admin announce button (`type: 'START'` only; the automatic call path passes no rosters). Named 12-year-olds plus real-time physical location in a channel a visiting team can read is a different thing from a private DM. Drop `seating` from that embed — this week, independent of whether DMs ship.

---

## 8. The DM sender

New module `src/lib/discord-dm.ts`. Called from `notifyMatchReady`, **not awaited in the marshal's tap**.

```ts
// notify.ts, after the push batches and the channel announce:
if (dmEnabled(tournament)) void sendMatchDms(match, status).catch(() => {});
```

`src/app/api/matches/[id]/load/route.ts:65` currently does `await notifyMatchReady(...)` before responding. Ten sequential DMs, or one 429 with a multi-second `retry_after`, and the marshal's button spins in a loud room while they tap it again. The DM fan-out must be detached; the route returns as soon as the DB write and `eventBus.emit` are done.

### Rules, in order

1. **Recipients** = players of both teams with `userId != null` **and** a `DiscordLink` **and** `optOut == false` **and** `dmState != 'BLOCKED'`.
2. **Skip the whole fan-out when `match.status` was already `READY`.** `load/route.ts` has no idempotency guard today — it happily re-runs on an already-called match. Push is protected by `tag: match-${matchId}` collapsing on the device; the `NotificationLog` by the 10s dedupe; **DMs have neither.** While you are in that route: it also clears `checkedInAt` for both rosters on every call (`:42-45`), so a re-call wipes tick marks a colleague just collected on the floor. Guard both with the same check.
3. **Write the `DiscordDmAttempt` row first**, catching `P2002` and returning early. That is the durable double-tap guard. `createMany({ skipDuplicates: true })` is **not supported on SQLite** — use per-row `create()` with `P2002` caught, or raw `INSERT OR IGNORE`.
4. **Serial, one message per ~1 s with ±250 ms jitter. Never `Promise.all`.** Max fan-out is one match's roster (10 at teamSize 5), so ~10 seconds. A DM arriving 4 seconds late is fine; a 429 storm is not.
5. **Composed per recipient locale** via `getServerTranslations(userLocale(user.locale), 'discord')` — exactly what `buildMatchReadyPushBatches` already does at `notify.ts:26-48`. `{stage}` must be resolved inside the same locale, or an English player gets "Seat B12 — go there now · Kvartfinale".
6. **Plain text, never an embed.** Discord's mobile notification preview renders message content; an embed-only message previews as effectively nothing. The one message that must survive a glance at a lock screen would be the one that shows nothing. Assemble `lead \n body \n link \n tail`; the first line is the whole instruction, seat first, under ~40 chars.
7. **Never send server credentials.** `src/lib/match-links.ts` builds `steam://connect/{ip}:{port}/{password}`. A DM is forwardable and we cannot verify the recipient is still on the roster. Link to Summit; the SSE stream already strips these fields for the same reason.
8. **Escape every interpolated value** (`* _ ~ \` | >`), strip `@`, and set `allowed_mentions: { parse: [] }` on every send. Kids will name a team `@everyone`.
9. **Cap `t('...')` output nowhere; cap the tokens**: team 32 chars, tournament 48, player 24, seat never (schema max 16). One shared helper, so the same team reads identically in the channel and in a DM.

### Error handling — this is where naïve implementations get the bot banned

| HTTP | code | Meaning | Action |
|---|---|---|---|
| 200/204 | — | accepted | `outcome = SENT`, `dmState = SENT`, `dmCheckedAt = now` |
| **403** | **50007** | Cannot send messages to this user | **Terminal. One attempt. Never retried, ever.** `dmState = BLOCKED`. Indistinguishable between "DMs off", "blocked the bot" and "left the guild" — the UI must never claim a cause |
| 403 | 50001 | Missing Access | Terminal + **config alarm**: the bot is probably not in the guild. Do not retry per-user |
| 404 | 10013 | Unknown User | Terminal. Clear `dmChannelId`, prompt re-link |
| 404 | 10003 | Unknown Channel | Stale cache. Clear `dmChannelId`, **one** retry that re-opens. *This is the one place a retry is correct and the easy one to forget* |
| 429 | — | rate limited | Honour `retry_after` from the body, not a fixed backoff. `X-RateLimit-Scope: global` pauses the whole fan-out. Max 2 retries, then `RATE_LIMITED` |
| 401 | 50014 | invalid token | Stop the loop, log `FATAL` once then at most once a minute, surface on the health chip |
| 5xx | — | Discord is having a day | 2s → 8s, then `ERROR` |

Retrying 50007 across forty players is the realistic path to Discord's documented **10,000 invalid responses (401/403/429) in 10 minutes → one-hour IP ban**. That is an hour of nothing, on LAN day, for a setting the kid chose.

**Keep `dmChannelId` as a latency cache, not as a safety argument.** `POST /users/@me/channels` is the scarce route and opening many new DM channels to accounts that never interacted with the bot is a known anti-spam flag vector — but the thing that actually keeps us safe is that we never DM more than one match's roster. Cache it because it halves the calls; do not rest the design on it.

---

## 9. Never assume a DM arrived

Three structural mechanisms. If only one survives review, keep the first.

**(a) The organizer reach panel counts only proven sends.** `DiscordReachPanel` on the Control cockpit, plus a count on ManageOverview. Five states, because the remedies differ:

| state | meaning | remedy |
|---|---|---|
| `NO_ACCOUNT` | `Player.userId` is null | must sign in with Steam first — **also gets no web push**. See §3(a) |
| `NOT_LINKED` | account, no `DiscordLink` | run `/koble` — or they're under 13, leave it |
| `LINKED_UNCONFIRMED` | `dmState = UNKNOWN` | nothing. Treat as unreachable |
| `LINKED_BLOCKED` | last attempt failed | privacy settings, or they left the guild |
| `LINKED_SENT` | last attempt accepted by Discord | — |

**The headline number counts `LINKED_SENT` only**, so the panel can never overstate reach. The state is named `SENT`, not `OK`: a 204 proves Discord accepted the message, not that a phone is on, un-muted, or in a hand. Every label in every language says **sendt / sent**, never *levert / delivered / mottatt*. A marshal who reads "levert" does not walk, and that is the failure this whole design exists to prevent — add it to the i18n review checklist in `docs/i18n-conventions.md`.

A permanent, non-dismissible line inside the panel: nb *"Discord er et ekstra varsel. Crewet henter fortsatt alle."* / en *"Discord is an extra alert. The crew still fetches everyone."* (`organizer.discordReach.caveat`). It is there so nobody can read the panel as a staffing decision.

**(b) The crew sees the denominator, and the denominator is the roster.** On the marshal board, next to each called match: `DM 6/10 · push 8/10`. **Both counters denominate over roster size, not over linked players** — `Player.userId` is nullable, and "DM 3/3" over a three-linked-player denominator reads to a tired marshal as "everyone got told" while five kids got nothing. Tap for the names of the unreached.

**(c) The fetch clock runs from call time, unconditionally.** A successful DM changes nothing a marshal does. This is why the reach panel is deliberately **not** on `/marshal/dashboard` as a decision input — the marshal always behaves as if nobody got a DM. If the club wants it visible there anyway, it is read-only behind `requireStaffApi` (§15).

Optional `#crew` channel mirror of the same two numbers, gated on `DISCORD_STAFF_CHANNEL_ID`. It is a courtesy, not a monitoring channel — if Discord is the broken thing it says nothing. Note it is still Discord, still third-party, still screenshot-able: post counts and unreached **names**, never a seat list.

---

## 10. The second container

### Image — its own stage, its own dependency tree

Do **not** reuse the `runner` image with a different command. Verified: `Dockerfile:37-45` copies only `public`, `.next/standalone`, `.next/static`, `prisma`, `node_modules/.prisma`, `node_modules/@prisma`, `node_modules/sharp`. There is no `scripts/`, no repo `package.json`, no `ts-node`, and no `discord.js` (nothing in `src/` imports it, so Next's tracer never copies it). `command: ["npm","run","bot"]` crashloops on first boot, and `restart: unless-stopped` + `depends_on` means you find out at the LAN.

Do **not** build `FROM builder` either: `builder` does `COPY . .` then `npm run build`, so fixing a Discord typo at 01:00 would rebuild Next on the box running the tournament.

```dockerfile
# Stage 4: the gateway bot — its own tiny tree, no Prisma, no Next, no data mount
FROM node:22-alpine AS bot
WORKDIR /app
ENV NODE_ENV=production TZ=Europe/Oslo
COPY bot/package.json bot/package-lock.json ./
RUN npm ci --omit=dev
COPY bot/ ./
USER node
EXPOSE 4002
CMD ["node", "index.js"]
```

`bot/package.json` holds **`discord.js` only** (pinned to the same `14.27.x` as the app). Do not install `zlib-sync`, `erlpack`, `bufferutil` or `utf-8-validate` — they are *optional* performance deps of discord.js and the bot works without them, which removes the `apk add python3 make g++` native-build step entirely and keeps the image ~150 MB. Write the bot as plain JS (or pre-compile with the already-present `tsc`); do **not** bundle with an unpinned `npx esbuild` — there is no `esbuild` in `node_modules` or `package.json`, and the rest of the Dockerfile goes out of its way to avoid build-time registry fetches (`Dockerfile:47-54` bakes the Prisma CLI for exactly that reason).

The bot uses **no `@/` path aliases** and imports nothing from `src/`. It has no business logic to share.

**The image has no `./data` mount**, which is the true and sufficient statement of "the bot cannot touch the database". (The weaker claim, that a shared `node_modules` proves it, is false — the `deps` tree is ~1 GB and contains `@prisma/client`, `.prisma` engines, Next and React.)

### Compose

Appended to the **existing** `docker-compose.prod.yml` (same project → both land on the existing `summit_default` bridge; **do not create a new network** — ash's default address pools have run out before and three apps run `network_mode: bridge` because of it):

```yaml
  summit-bot:
    build: { context: ., target: bot }
    container_name: summit-bot
    init: true
    env_file: .env.bot
    ports: ["127.0.0.1:8093:4002"]     # /healthz for the host watchdog only; NOT tunnelled
    depends_on: [summit]               # start order only — never condition: service_healthy
    mem_limit: 512m
    stop_grace_period: 20s
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:4002/healthz"]
      interval: 15s
      timeout: 5s
      retries: 3
      start_period: 40s
```

No volumes — the bot holds no state, so a restart is free. `wget` is busybox-native in alpine and cheaper than spawning a 40 MB node process every 15 seconds.

**Split liveness from readiness.** `/healthz` answers *is this process alive and is the gateway READY or reconnecting* — that and only that is what the HEALTHCHECK probes. A richer `/status` carries `lastLinkOkAt`, `lastError`, `version`, `uptime` and feeds the in-app chip. If `/healthz` failed on "cannot reach the app", then every `docker compose up -d --build` of the app would flip the bot unhealthy for longer than the threshold — and `~/apps/server-vakt/server-vakt.sh` fires on container-health findings on *first* sighting (they are exempt from its flap guard), so two weeks of spurious ntfy pushes would teach the organizer to swipe them away before the LAN.

Also add a `healthcheck` to the **`summit`** service and a trivial `src/app/api/healthz/route.ts` (`force-dynamic`, one `SELECT 1`). Verified: `docker inspect summit -f '{{.State.Health}}'` is `<nil>` today, so the host watchdog cannot distinguish "Next is hung" from "Next is fine", and the runbook's liveness check renders a full React page.

### Supervision — use the watchdog that already exists

`~/apps/server-vakt/server-vakt.sh` runs on cron `*/10` and already alerts on `health=unhealthy`, `status=restarting`, non-zero exits and rising `RestartCount`, publishing to ntfy topic `ash` (which the phone is already subscribed to) and writing a heimdal tile. **Adding the two HEALTHCHECKs is the entire integration — zero new code.**

For the LAN weekend, change the existing cron line from `*/10` to `*/2` and revert on Monday. **Do not write `scripts/lan-vakt.sh`** — a 40-line script with its own state file, dedupe and `--test` mode, written and tested once on the morning of the event, is worse than one crontab edit. And **do not create a new ntfy topic**: an alerting channel nobody subscribed to at 01:00 is worse than none.

### Restart-loop protection

Discord's `IDENTIFY` limit is 1000/day per token; a 2-second crash loop burns it in ~35 minutes and Discord 429s the token for the rest of the day. So: **never exit on a recoverable error** (log and continue), and on unrecoverable ones (invalid token, 4014 disallowed intents) **sleep 30 s before exiting** so the loop is slow enough to survive and visible enough to alert.

### Slash-command registration

Guild-scoped via `Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)`. **Fetch, compare a stable JSON hash, `PUT` only if different** — `scripts/discord-bot.ts:51-54` re-`PUT`s unconditionally on every `ready`, which with `restart: unless-stopped` is a write on every crash against a 200/day per-guild limit.

Intents: **`Guilds` only.** Not `GuildMembers`, not `MessageContent` — they are privileged, they are not needed for slash commands, DMs and buttons, and *"can the bot read my kid's messages"* should have a flat no as its answer. Bot permissions at invite time: `Send Messages`, `Embed Links` in the two channels. No Administrator. **"Public Bot" off.**

### The kill switch an organizer can reach without a laptop

`Tournament.discordDmPaused`, toggled by a **Pause Discord** button in Control. The chip goes grey `Discord: pauset`. An env-var switch would require `up -d summit` → `prisma migrate deploy` + a cold Next start = 20–40 s of 502 through the tunnel, mid-tournament. This is cheaper than everything in the observability section and far more likely to be used.

### Token compromise

Developer Portal → Bot → **Reset Token** → paste into `.env.bot` **and** `.env` → `up -d summit-bot summit`. An attacker with that token can post and DM as the bot in that one guild — i.e. impersonate the tournament to 12–15-year-olds, which is why it is more sensitive than the app's own secrets, not less. They cannot read the Summit database, forge a Steam session, or reach any other service on ash. Note the repo pushes to a GitHub remote: both GitHub and Discord run secret scanning, so a token that reaches a commit is auto-revoked — recovery is the same reset, at the worst possible moment.

---

## 11. Deletions — `src/lib/auth.ts`

The `DiscordProvider` at `auth.ts:18-21` is not neutral dead code. Verified line by line:

- It ships to production constructing with **`undefined`** credentials (`process.env.DISCORD_CLIENT_ID!` with no such key in prod `.env`).
- It is **reachable**: no app code calls it (`login/page.tsx` and `profile/page.tsx` only ever `signIn("steam", …)`), but NextAuth serves its own `/api/auth/signin` page listing every registered provider.
- If it ever succeeded it would be worse. Session strategy is `jwt` with **no adapter** (`PrismaAdapter` appears nowhere in `src/`; `@next-auth/prisma-adapter` sits unused in `package.json`). So a Discord sign-in writes no `Account` row and no `User` row: the `signIn` branch at `:119-141` runs `prisma.user.update({ where: { email } })`, which throws `P2025` for an unknown email, is swallowed at `:137-140`, and returns `true`. The JWT then resolves `dbId` only if a `User` with that email already exists (`:156-167`), so `session.user.id` is `undefined` — breaking every route that reads it — and `getRoleForSteamId(undefined)` demotes them to `player`. Same cookie, so it **silently signs the kid out of their Steam identity.**
- `token.discordId` is written at `:149`, exposed at `:174`, and read by nobody in `src/`, `e2e/` or `messages/`.
- Proof it is dead: `scripts/discord-bot.ts:65-73` looks users up via `accounts: { some: { provider: 'discord' } }` — rows nothing in the codebase ever writes.

**Delete:** `auth.ts:18-21`, `:119-141`, `:148-150`, `:174`, and `DISCORD_CLIENT_SECRET` from `.env.example`.

**Consequential, same change:** with no adapter, `Account` rows are provably never written, so `accounts: true` in `src/app/api/user/profile/route.ts:20` and the `accounts.provider` selects in `src/lib/api.ts` and `tournaments/[id]/teams/route.ts` are joins that always return `[]`, read by no component. Drop them. **Leave the `Account` / `Session` / `VerificationToken` models in the schema** — inert, and dropping tables is migration risk for no gain three weeks out.

**`scripts/discord-bot.ts`: delete, don't extend.** Its only user-lookup path is the dead `accounts` query; `/nextgame` re-implements `/api/me/queue` against the DB directly, which is the coupling this design forbids; and the whole file is untranslated English in code. Keep its command-registration skeleton as a reference while writing `bot/index.js`, then remove the file and the `bot` script from `package.json`.

---

## 12. Copy

**New namespace `discord`** (`messages/{en,nb}/discord.json`), added to `NAMESPACES` in `messages/index.ts` — this is required, not optional: `loadMessages` is what `getRequestConfig` feeds, so `getServerTranslations(locale, 'discord')` cannot resolve unless it is listed.

**Do not migrate the existing `notifications.discord.*` keys.** Overruling area 5 on timing, not on judgement: the rename is correct and buys nothing before October, and it drags along the template-literal key at `discord.ts:258` (`t(\`discord.${data.titleKey}\`)`), which `scripts/check-i18n.js` phase 2 explicitly skips — so a typo there renders the literal string `discord.bracketLiveTitle` into the player channel at the most public moment of the evening. Cost of deferring: ~10 duplicated field/footer labels. Do the rename, and the `titleKey` → string-literal-union refactor, after the LAN.

Structure inside the new file: `dm.*` (one kid, `User.locale`), `channel.*` (the room, `DISCORD_LOCALE`), `crew.*` (staff), `bot.*` (ephemeral replies). The v1 key set:

| key | nb | en |
|---|---|---|
| `dm.called.lead` | `{hasSeat, select, no {Det er din tur — gå til plassen din nå.} other {Plass {seat} — gå dit nå. Det er din tur.}}` | `{hasSeat, select, no {You're up — head to your seat now.} other {Seat {seat} — go there now. You're up.}}` |
| `dm.called.body` | `{home} vs {away} · {stage} · {tournament}` | same |
| `dm.called.link` | `Åpne Summit: {url}` | `Open Summit: {url}` |
| `dm.called.tail` | `Crewet kommer og henter deg hvis du ikke er på plass.` | `The crew will come find you if you're not at your seat.` |
| `dm.live.lead` | `{hasSeat, select, no {Kampen din er live nå — kom deg til plassen din.} other {Plass {seat} — kampen din er live nå.}}` | `{hasSeat, select, no {Your match is live — get to your seat.} other {Seat {seat} — your match is live.}}` |
| `dm.probe.body` | `Discord-kontoen din er koblet til Summit. Du får en melding her når kampen din blir kalt opp. Discord er et ekstra varsel — crewet henter deg uansett. Du kan koble fra når som helst på turnering.mortenlab.xyz.` | `Your Discord account is linked to Summit. You'll get a message here when your match is called. Discord is an extra alert — the crew will come get you either way. You can unlink any time at turnering.mortenlab.xyz.` |
| `dm.stopButton` | `Stopp DM` | `Stop DMs` |
| `channel.upnext.title` | `Neste ut: {home} vs {away}` | `Up next: {home} vs {away}` |
| `channel.called.title` | `🟢 Kalt opp: {home} vs {away}` | `🟢 Called: {home} vs {away}` |
| `channel.called.description` | `**{home}** vs **{away}** · {stage} · {tournament}\nGå til plassen din nå. Crewet henter dem som ikke dukker opp.` | `**{home}** vs **{away}** · {stage} · {tournament}\nHead to your seat now. The crew will come get anyone who doesn't show.` |
| `channel.live.title` | `🔴 Live: {home} vs {away}` | `🔴 Live: {home} vs {away}` |
| `channel.result.title` | `✅ {home} {homeScore}–{awayScore} {away}` | same |
| `crew.delivery` | `DM {dmOk}/{roster} · push {pushOk}/{roster}` | same |
| `crew.unreached` | `{count, plural, =0 {Alle har fått digital beskjed.} one {# spiller mangler beskjed — hent spilleren.} other {# spillere mangler beskjed — hent dem.}}` | `{count, plural, =0 {Everyone got a digital heads-up.} one {# player got nothing — go get them.} other {# players got nothing — go get them.}}` |
| `bot.linkedReply` | `Koblet! Du er **{name}** på Summit. Jeg har sendt deg en melding – se i DM-ene dine.` | `Linked! You're **{name}** on Summit. I've sent you a message — check your DMs.` |
| `bot.linkedReplyBlocked` | `Koblet! Men jeg får ikke sendt deg DM. Skru på direktemeldinger fra servermedlemmer i Discord-innstillingene, og kjør \`/koble\` på nytt.` | `Linked! But I can't DM you. Turn on direct messages from server members in your Discord settings, then run \`/koble\` again.` |
| `bot.unknownCode` | `Fant ikke koden, eller så har den gått ut. Hent en ny på turnering.mortenlab.xyz → Profil → Koble Discord.` | `I couldn't find that code, or it expired. Get a new one at turnering.mortenlab.xyz → Profile → Link Discord.` |
| `bot.alreadyTaken` | `Denne Discord-kontoen er allerede koblet til en annen Summit-bruker. Si fra til crewet, så ordner de det.` | `This Discord account is already linked to another Summit user. Tell the crew and they'll sort it out.` |
| `bot.noCode` | `Skriv \`/koble\` og lim inn koden du finner på turnering.mortenlab.xyz → Profil → Koble Discord.` | `Type \`/koble\` and paste the code from turnering.mortenlab.xyz → Profile → Link Discord.` |
| `bot.optedOut` | `Ok, jeg sender deg ikke flere DM-er. Du får fortsatt varsel i appen, og crewet henter deg uansett.` | `OK, no more DMs. You still get the in-app alert, and the crew comes for you either way.` |

Plus `player.discord.*` in `messages/{en,nb}/player.json` for the profile card (title, optional, body, noDiscordFine, inviteStep, codeIntro, codeCopy, codeCopied, codeExpires, codeWaiting, codeExpired, newCode, linkedTo, dmUnconfirmed, dmBlockedTitle, dmBlockedBody, stopDms, unlink) and `organizer.discordReach.*` for the panel.

Binding rules:
- **ICU `select` on a caller-supplied `hasSeat`, never on `{seat}` itself.** `Player.seating` is 16 chars of free text; a kid can type `none` and land in the wrong arm.
- **The command name is `/koble`.** One fixed string, **no `name_localizations`** — Discord localizes command names by the *client's* language, which will not match `User.locale`, so Summit would print `/koble` to a kid whose Discord shows `/link`. `koble` is pure ASCII, so area 5's objection to a Norwegian command name does not apply. Localize the replies, not the name.
- No word the app does not already use: **no `taperbracketen`** (`messages/nb/stage.json` says *Taperrunde {n}* / *Taperfinale*; `player.json` says *Taperrunde {round}*). Always interpolate `{stage}` from `stage.bracket.*`.
- `bracket` is masculine (*bracketen*); no definite-form interpolation; compounds one word; du-form; no exclamation marks; do-not-translate list honoured (*live, crew, bracket, walkover, Discord, Steam, LAN, DM*).
- `bot.*` strings get **no automated coverage**: `scripts/check-i18n.js` phase 2 walks only `src/` (`srcDir = path.join(__dirname,'..','src')`), and the bot renders nothing anyway under this design — the app returns pre-rendered strings, which is precisely how these stay inside `npm run i18n:check`. The bot's only own strings are two hardcoded English fallbacks for "Summit is unreachable".

---

## 13. Contradictions between areas, resolved

| Conflict | Areas | Resolution | Why |
|---|---|---|---|
| Who sends the DM | 2/3 (bot drains an outbox) vs 1's-critique & 4's-critique (app sends in-process) | **App sends.** Bot is interaction-only | The app already holds the REST client, token, Prisma client and every string. A durable queue is the wrong machine for a payload whose correct behaviour on interruption is to vanish. Deletes ~6 subsystems |
| Does the bot touch SQLite | unanimous no | **No.** HTTP + bearer | Two writers on a rollback-journal file, a second Prisma client in migration lockstep, and a documented restore path that assumes one writer |
| `User.discordId` column vs `DiscordLink` table | 4 vs 1 | **`DiscordLink` table** | Not on payload hygiene (that argument is weak — `/api/user/profile` is session-gated and returns the requester's own row). On shape: nine nullable columns on `User` for a notification channel, with nowhere to put `dmState`/`dmChannelId`/`dmError`/`optOut`/the pending code. Same shape as `PushSubscription` |
| Re-link by the same user | 1 (refuse) vs 1's-critique (idempotent) | **Idempotent for the same `userId`; refuse only a different one** | As written, the design's own "kjør `/koble` på nytt" recovery dead-ends in `discord_taken` for exactly the kids who had a problem |
| Reach-panel states | 5 vs 3 | **Five**, with `OK` renamed **`SENT`** | The remedies differ, and `NO_ACCOUNT` is the row whose cause is not Discord. `SENT` is the honest name for a 204 |
| `UPCOMING` trigger | 2 (rank < depth) vs 2's-critique (play stage) vs 5 (round roundup) | **Neither: reuse `handleAdvance`** | It already fires per match the instant a match becomes playable, which is correct for parallel rounds, needs no scheduler, and is one message key |
| Result DMs | 5 (full catalogue) vs 4 (none) | **None** | A kid who just played knows the score, and it deletes the entire losers/bronsefinale copy bug class |
| `notifications` → `discord` rename | 5 (do it) vs 5's-critique (defer) | **New namespace now, migration after the LAN** | The rename drags the template-literal-key refactor along and breaks copy assertions three weeks out |
| Command name | 1 (`/koble`) vs 5 (`/link`) | **`/koble`** | It is already ASCII, and it is the app's own verb |
| `.env` for the bot | 3/4 (`env_file: .env`) vs 3's-critique (split) | **`.env.bot`** | An always-on Discord process has no business with `NEXTAUTH_SECRET` or `STEAM_API_KEY` |
| Watchdog | 3 (`lan-vakt.sh`, topic `summit`) vs 3's-critique (reuse server-vakt on `ash`) | **Reuse; one crontab edit for the weekend** | A script written and tested once on LAN morning, publishing to a topic nobody subscribed to |
| Bot image | 3 (`FROM builder`, `npx esbuild`) vs its critique | **Own stage, own tiny lockfile, no bundler, no native optionals** | `FROM builder` rebuilds Next to fix a Discord typo; `npx esbuild` is unpinned and absent from the tree |

---

## 14. Critiques applied — and the two I overrule

**Applied in full:** DM transport named and put in the app; fan-out detached from the marshal's tap; `deferReply({ flags: Ephemeral })` first line; idempotent re-link; guild invite URL in the card; organizer unlink in the same step as `/koble`; channel config first; `Dockerfile.bot` as its own stage from `deps`, not `builder`; no unpinned bundler; `DISCORD_DM_LOG`; rehearsal step; claim that the bot can't reach the DB rests on the missing `./data` mount; `deleteMany`/`updateMany` for concurrency; liveness split from readiness; health server bound `0.0.0.0`; `TZ` on both services; `.env.bot`; server-vakt reuse instead of a new script; Pause-Discord toggle; `SENT` not `OK`; roster-size denominators; `{stage}` not `taperbracketen`; losers split on `loserNextMatchId`; "hent spilleren" not "hent hen"; "Crewet henter **dem**"; seats out of the player channel; `createMany({skipDuplicates})` replaced with caught `P2002`; `50007` terminal; `429` honours `retry_after` and does not count as an attempt; `10003` gets exactly one re-open retry; double-call guard that also protects `checkedInAt`.

**Overruled, explicitly:**

1. **"Keep the round roundup / build a proper UPCOMING event."** Overruled on scope. The `handleAdvance` announce at `matches/[id]/route.ts:174` already fires at exactly the right moment and is currently mislabelled as a call-up. Relabelling it satisfies owner ask #1 for one message key, with no scheduler, no reconciler, no play-stage computation, and no risk of shipping alongside a duplicate per-match post. The play-stage definition is correct and should be used *if* a proper UPCOMING DM is ever wanted — it is in §15.

2. **"Ship the reachability roster in week 1 against push-presence only."** Overruled on ordering, not on value. The roster is the best idea in area 4 and it does ship early — but it is worthless until §3(a) is fixed, because it would read mostly red for a reason that has nothing to do with Discord and everything to do with `teams/[id]/players/route.ts` never setting `userId`. Fix the linkage first, in the same step; then the roster is honest on day one.

Also downgraded rather than deleted: the "a kid can't produce their Discord password" argument for `/koble`. It is plausible but unevidenced, and the recommendation stands on the deliverability probe, which is checkable.

---

## 15. Build order

Identity blocks DMs entirely — nothing can DM anyone until a Discord id exists. Sequenced so each step ships something useful alone.

**Step 0 — today, ten minutes, no code.** `DISCORD_BOT_TOKEN` + `DISCORD_CHANNEL_ID` + `DISCORD_LOCALE=nb` in `.env` on ash; `up -d summit`. → Owner asks #2, #3, #5 live. *If everything below slips, the LAN already has channel announcements.*

**Step 1 — pure deletion + the two cheap truths. Half a day.**
`auth.ts` DiscordProvider and its three dead branches; the `accounts` selects; `scripts/discord-bot.ts`. Then `Player.userId` linkage on manual add + Steam-sign-in backfill (§3a), `Match.calledAt` + marshal-board clock, the embed colour swap (`discord.ts:193`/`:224`), the new `channel.upnext.*` key on `handleAdvance` (owner ask #1), and seats out of `discord/announce/route.ts:41-42`. **Zero new surface, one live hazard removed, one live bug fixed, and ask #1 shipped.**

**Step 2 — migration + self-service link UI. Two days.**
`20260922090000_discord_link`, `src/lib/discord-link.ts`, `/api/me/discord*`, `DiscordLinkCard` on `/profile`, `messages/{en,nb}/discord.json` + `player.discord.*`. Self-hides while `SUMMIT_BOT_KEY` is unset, so it deploys safely before the bot exists.

**Step 3 — the bot container + the DM sender. Three days.**
`bot/` + `bot/package.json` + the `bot` Dockerfile stage + the compose service + both HEALTHCHECKs + `/api/healthz`. `POST /api/discord/link` and `/api/discord/optout`. `src/lib/discord-dm.ts` with the full error table. `LINK_PROBE` on link. `MATCH_CALLED`/`MATCH_LIVE` fan-out, detached, serial, guarded. **Organizer unlink (`DELETE /api/discord/link/[userId]`) ships here, not later** — `bot.alreadyTaken` promises it. Ship with `DISCORD_DM_ENABLED=false`.

**Step 4 — the honesty surfaces. One day.**
`DiscordReachPanel` on Control + a count on ManageOverview + the caveat line; the `DM n/roster` chip on the marshal board; Pause Discord in Control; optional `#crew` mirror. **These are what make the previous three steps safe to believe**, so they are last only because they depend on real data existing.

**Step 5 — runbook + rehearsal. Half a day, and it is not optional.**
`docs/LAN-RUNBOOK.md`: `SUMMIT_BOT_KEY` / `.env.bot` rows in the §(a)1 environment table; the per-service deploy commands in §(a)2 (`up -d --build summit-bot` — the current single command now rebuilds both, and `down` in the restore procedure now stops the bot, which is harmless but must be said); new §(g) entries for *is the bot alive*, *the bot died* (answer: do nothing, nothing about the tournament is blocked), *nobody is getting DMs but the channel works* (expected, fetch those players), *rotate the token*; and the crontab `*/10 → */2` line for the weekend.

**The rehearsal is a dated pre-flight item: three real kids, three real phones, `/koble`, and a real match DM from a test tournament, at least four days out.** The acceptance test for this feature is not `npx tsc --noEmit`. Then flip `DISCORD_DM_ENABLED=true`.

**Freeze four days out.** No Discord changes after that. The LAN runs fine with none of it.

**If the timeline tightens, cut in this order:** the `#crew` mirror → the reach panel → `dmChannelId` caching → the gateway container itself (Discord will POST interactions to an HTTPS endpoint with an ed25519 check — ~40 lines in a Next route, already behind the tunnel, same UX, zero new images). **Do not cut** the link-time DM probe, the `SENT`-only headline, the roster-size denominators, or the *"Crewet henter fortsatt alle"* caveat. Those are the parts that stop this from becoming the reason a kid is left at their seat.

---

## 16. E2E tests that must exist

The existing suite is **209 tests across 46 spec files** and asserts copy heavily — **211 literal-text assertions** (`getByText` / `hasText` / `toContainText`) counted across `e2e/`. That is the single biggest cost multiplier here: every message key this spec adds is an assertion someone will write, and every existing Norwegian string it *changes* breaks tests that already pass. It is also the reason the `notifications` → `discord` rename is deferred.

New spec `e2e/discord-link.spec.ts`:
1. Card is **absent** when `SUMMIT_BOT_KEY`/`DISCORD_GUILD_ID` are unset (the `isPushConfigured` pattern — `player-push.spec.ts` already tests the equivalent for alerts).
2. Card renders the **invite link, then the `/koble` instruction, then the code**, in that order; the copy button copies the bare code with **no leading slash**.
3. `POST /api/me/discord/code` twice replaces the code and leaves exactly one `DiscordLinkCode` row.
4. `POST /api/discord/link` **without** the bearer → 503/401; with a wrong bearer → 401.
5. Unknown / expired code → `ok:false, reason:"unknown_code"`, no row written.
6. Happy path → `DiscordLink` written, `LINK_PROBE` attempt row written, reply text is the **linked** string in the user's locale (run once in nb, once in en — `i18n-locale.spec.ts` has the harness).
7. **Idempotent re-link:** same `userId` redeems a second code with the same snowflake → `ok:true`, username updated, no `discord_taken`.
8. **Conflict:** a *different* `userId` claims a bound snowflake → refused, first link untouched.
9. Self-unlink deletes the row; a second unlink no-ops (no 500).
10. Organizer unlink writes an `AuditLog` row.
11. The card polls and flips to **linked** without a reload while a code is live.

New spec `e2e/discord-dm.spec.ts` (against a `DISCORD_DM_LOG` file, the way `player-push.spec.ts` uses `PUSH_DELIVERY_LOG`):
12. Calling a match writes one `DiscordDmAttempt` per **linked, non-opted-out** player and **none** for unlinked, opted-out or `NO_ACCOUNT` players.
13. **Double-tap "Kall opp" produces exactly one attempt row and one log line per player** — and does not clear `checkedInAt` a second time.
14. A mocked 403/50007 sets `dmState = BLOCKED`, writes one attempt, and **is never retried**.
15. A mocked 429 honours `retry_after` and does not consume the attempt budget.
16. `DISCORD_DM_ENABLED=false` and `Tournament.discordDmPaused=true` each suppress the fan-out completely while leaving push and the channel post untouched.
17. DM body is composed in the recipient's `User.locale`, with `{stage}` resolved in the **same** locale (the mixed-language regression).
18. DM contains no `serverIp`/`serverPort`/`serverPassword`, and no other player's seat.
19. `MATCH_LIVE` does **not** DM a match that already DM'd `MATCH_CALLED`.
20. A team named `@everyone` produces an escaped body and `allowed_mentions: { parse: [] }`.

Extend `e2e/integrations-notifications.spec.ts` and `e2e/lan-marshal-sync.spec.ts`:
21. The reach panel's headline counts **only** `LINKED_SENT`; an `UNKNOWN` link does not increment it.
22. `NO_ACCOUNT` players appear as their own state, not folded into "not linked".
23. The caveat line is present and **not dismissible**.
24. The marshal-board chip denominates over **roster size**: a match with 3 linked players out of 10 reads `DM 3/10`, never `3/3`.
25. No surface anywhere renders the words *levert* / *delivered* / *mottatt* for a DM — a grep-style assertion over the rendered board and panel. This is a two-word bug that undoes the whole design.

Plus one unit test in `npm run test:bracket`'s harness: the recipient resolver returns the away team's players with the away team's locale, not the home team's — the orientation bug class, untestable by eye at 02:00.

---

## OPEN QUESTIONS FOR THE OWNER

Deduplicated across the five areas. Each has my recommendation, so a "yes" is a complete answer.

1. **Does the club own the Discord application and token, and who can reset it at 01:00?**
   *Recommendation:* the **club** account, not a personal one — a bot that DMs minors should be owned by the club — with at least two adults able to log in. Token lives in `.env`/`.env.bot` on ash, chmod 600, and is rotated after the LAN.

2. **Under-13s.** Discord's minimum age is 13; the cohort is 12–15; the schema stores no age signal at all. Show the link card to everyone and let it go un-taken, or suppress it for players an organizer flags as under 13?
   *Recommendation:* **show it to everyone, never nag, never red, never gate.** Storing an age signal is itself a privacy decision, and a neutral optional card asks nothing of a 12-year-old. But add one line to the parental attendance form the club already collects: *"Discord-kobling er valgfritt; for spillere under 13 år gjøres den sammen med en forelder."*

3. **Safeguarding policy on bot DMs to minors.** Some youth clubs prohibit adult↔minor DMs on principle. A bot DM is categorically different, but it posts under the club's application and a written rule may need amending.
   *Recommendation:* **yes, proceed**, and tell the safeguarding lead that `DiscordDmAttempt` logs *that* a message was sent (who, when, which match) but content is one of ~6 fixed templates in `messages/`, auditable in git. If they want more, the DM itself can carry a line saying it is logged.

4. **One channel or two?** The delivery-truth mirror assumes a staff channel exists and that signup posts go there rather than into the players' channel.
   *Recommendation:* **two** — `#turnering` (called/live/results/up-next) and `#crew` (signups, delivery counts). If there is only one, **drop signup announcements entirely** rather than moving them, and put the delivery numbers only on the marshal board.

5. **Is `#turnering` internet-public or members-only?** This decides whether player names may stay in the channel embed at all.
   *Recommendation:* **members-only**, and **seats come out regardless** — they are already in the manual announce embed today, which is worth fixing this week whether or not DMs ship.

6. **Do links persist between LANs, or reset each tournament?**
   *Recommendation:* **persist.** `DiscordLink` hangs off `User`, so a kid links once and is set for every future LAN. Wiping per tournament means everyone re-links every time, which costs reach for no benefit.

7. **Should marshals see the reach panel?** It is admin-only on Control by design, and deliberately off the marshal board as a decision input.
   *Recommendation:* **no panel on the marshal board — but yes to the `DM 6/10` chip** next to each called match, tappable for the unreached names. The chip tells a marshal *who to walk to*; the panel would only tell them who not to, which is exactly the inference that must never be available.

8. **Do losing teams get anything?** (This spec sends no result DMs at all.)
   *Recommendation:* **no result DMs, winners or losers.** If the club wants one thing here, make it a *channel* post for the champion, not a phone buzzing "dere er ute" at a 13-year-old.

9. **Should there be an on-deck DM** ("one match ahead of you")?
   *Recommendation:* **not for this LAN.** There is no `scheduledAt` on `Match`, and the only honest definition is "every playable-pending match at the minimum `playStage`" — i.e. the whole next round goes on deck at once, because Summit runs rounds in parallel (`ManageControl.tsx` already models "Next" as a set, not a row). That is buildable, but it doubles DM volume for a nudge the channel post already carries. Revisit after October.

10. **Retention for `DiscordDmAttempt`.**
    *Recommendation:* **30 days**, pruned by the nightly cron alongside `scripts/backup.sh`. Longer only if the club wants an after-action record for a no-show forfeit dispute — and then it becomes personal data about minors with a stated retention period, which changes the paragraph you give a parent.
