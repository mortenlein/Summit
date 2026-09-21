# `summit-bot` — the gateway bot

A second container whose entire job is to receive three things from Discord and hand them to
the Summit app:

| Trigger | What the bot does |
|---|---|
| `/koble <kode>` | `POST ${SUMMIT_API_URL}/api/discord/link` |
| `/stopp` | `POST ${SUMMIT_API_URL}/api/discord/optout` |
| the **Stopp DM** button (`summit:dm:optout`) | the same opt-out endpoint |

It replies with whatever string the app returns. That is the whole program.

## What it deliberately is not

- **It does not send anything.** Channel posts and DMs are both the app's job — the app
  already holds the REST client, the token, Prisma, the recipient list and every Norwegian
  string (`src/lib/discord.ts`). A bot that sent would need all four too.
- **It has no database.** No Prisma, no `@prisma/client`, and no `./data` mount in compose —
  which is the true and sufficient statement of "the bot cannot touch the tournament".
- **It has no translations.** `messages/{en,nb}` stays in the app, under `npm run i18n:check`.
  The app returns an already-rendered string in the player's own `User.locale`; the bot prints
  it. The bot's own copy is: two slash-command descriptions (Discord needs them at
  registration time, before the app is necessarily up) and one "Summit isn't responding"
  fallback in `src/fallback.js`. Nothing else, ever. If you are adding a third string here,
  it belongs in `messages/{en,nb}/discord.json` instead.
- **It has none of the app's dependencies.** `package.json` is `discord.js` and nothing else,
  with its optional native performance packages (`zlib-sync`, `erlpack`, `bufferutil`,
  `utf-8-validate`) deliberately not installed — which is what keeps the image free of a
  `python3 make g++` toolchain.

## If it is down

**Nobody can link a Discord account.** That is the complete list. The bracket, the marshal
board, check-in, scoring, push, and the Discord *channel* announcements are all the app and
all keep working. Players who linked before it went down keep getting their match DMs, because
the app sends those.

## Files

```
bot/
  index.js              wiring: gateway client, events, registration, shutdown
  src/config.js         every env var, in one place
  src/commands.js       the two commands as raw JSON + the idempotency fingerprint
  src/interactions.js   the actual behaviour, as pure functions over plain data
  src/summit-client.js  the two POSTs to the app; never throws
  src/health.js         /healthz (liveness) and /status (the richer picture)
  src/fallback.js       the one string the bot owns
  src/log.js            one line, one fact, secrets redacted
  test/                 42 tests, `npm test`, no network and no token required
```

Only `index.js` imports discord.js. Everything else is testable without a gateway.

## Running it

In production it is a compose service:

```bash
cd /home/mole/apps/Summit
docker compose -f docker-compose.prod.yml up -d --build summit-bot
docker logs -f summit-bot
```

Configuration is `/home/mole/apps/Summit/.env.bot` (chmod 600) — **not** the app's `.env`,
which holds `NEXTAUTH_SECRET` and `STEAM_API_KEY`. Every variable is documented, with the
container it belongs to, in the `summit-bot` block at the bottom of `.env.example`.

Locally:

```bash
cd bot
npm install
DISCORD_BOT_TOKEN=... DISCORD_CLIENT_ID=... DISCORD_GUILD_ID=... SUMMIT_BOT_KEY=... \
  SUMMIT_API_URL=http://127.0.0.1:4001 npm start
```

## Health

Two endpoints on `BOT_HEALTH_PORT` (4002), bound to `0.0.0.0` inside the container. Neither is
published to the host and neither is tunnelled.

- **`GET /healthz`** — liveness only: 200 while the gateway is `ready`, or `reconnecting` for
  less than `BOT_RECONNECT_GRACE_MS` (default 5 min); 503 otherwise. This is what the container
  HEALTHCHECK probes. It deliberately does **not** check whether the app is reachable: if it
  did, every `up -d --build summit` would flip the bot unhealthy and server-vakt would push an
  ntfy alert about it, teaching the organizer to swipe Summit alerts away in the week before
  the LAN. The grace window is bounded for the opposite reason: a reconnect that has been
  running for ten minutes means nobody can link, and a health endpoint that answers `ok`
  forever in that state is a lie of exactly the kind §9 of the spec exists to prevent.
- **`GET /status`** — JSON. No token, no bearer key, no link codes. Every field is a claim
  about something that actually happened:

  | field | claim |
  |---|---|
  | `state` / `stateSince` | gateway state and when it started |
  | `commandsRegistered` | `true` only when **Discord confirmed it**. `null` = unknown. Never `false`-by-assumption, because Discord may still hold a working copy from an earlier boot |
  | `lastAppOkAt` | the app **answered**. Not a link — an unknown-code reply stamps this too |
  | `lastLinkConfirmedAt` | the app said a link **happened**. This is the one that means someone linked |
  | `interactions.koble` / `.kobleLinked` | run vs. worked, counted separately |
  | `interactions.stopp` / `.button` / `.stoppConfirmed` | opt-outs asked for vs. confirmed |
  | `lastError` | last failure, bot- or app-side, redacted |

  There was a `lastLinkOkAt` here once, stamped by any 2xx from the app. The runbook told an
  organizer it meant "when a player last linked successfully"; it meant "the app was up". It is
  gone, and `bot/test/smoke.test.js` fails if it returns.

## Things that are the way they are on purpose

- **`deferReply({ flags: Ephemeral })` is the first line of every handler.** A round trip to
  Summit plus a DM probe is comfortably over Discord's 3-second ACK window; without the defer
  a *successful* link shows the kid a red "The application did not respond", and they run it
  again.
- **Command registration is idempotent.** The bot reads the guild's current commands, compares
  a stable fingerprint, and `PUT`s only on a difference. An unconditional `PUT` on every
  `clientReady`, under `restart: unless-stopped`, is a write per crash against a 200/day
  per-guild limit.
- **Intents are `Guilds` only.** Not `GuildMembers`, not `MessageContent`. They are privileged,
  they are not needed for slash commands and buttons, and *"can the bot read my kid's
  messages"* should have a flat no as its answer.
- **The command name is the fixed ASCII string `koble`, with no `name_localizations`.** Discord
  localizes command names by the *client's* language, which will not match the player's
  `User.locale` — so Summit would print "type `/koble`" to a kid whose Discord shows `/link`.
  Localize the replies, not the name.
- **`/koble` with no code is not short-circuited here.** It is posted to the app anyway, so the
  "where do I find my code" instructions come from `messages/`, in the player's language,
  rather than from a Norwegian sentence hardcoded in this repo's JavaScript.
- **It never exits on a recoverable error, and waits 30 s before exiting on an unrecoverable
  one.** Discord's IDENTIFY limit is 1000/day per token; a two-second crash loop burns it in
  about 35 minutes and then 429s the token for the rest of the day — i.e. for the LAN.
- **The opt-out button id `summit:dm:optout` is a contract with the app.** The app attaches
  that button to its DMs; changing the string here orphans every DM already sent. A `:suffix`
  is accepted, so the app may append a match id.

## Tests

```bash
cd bot && npm test          # 42 tests, no network, no Discord token, no database
```

They cover code normalization, the app-reply-vs-fallback rule, the bearer/timeout/error
behaviour of the client, health-endpoint status codes, registration idempotency against the
exact shape Discord returns, and three spawn-the-real-process smoke tests: clean boot and
`SIGTERM`, a junk token (no crash loop, either retry-with-backoff or a delayed exit), and a
missing environment variable being named in the log.

The same suite runs inside the production image:

```bash
docker compose -f docker-compose.prod.yml exec summit-bot npm test
```
