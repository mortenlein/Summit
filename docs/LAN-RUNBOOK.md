# Summit — LAN day runbook

For the organizer running the event. Not a developer document: every step is something you
click or paste. Production URL: **https://turnering.mortenlab.xyz** (Docker container `summit`
on host `ash`, repo at `/home/mole/apps/Summit`).

Three surfaces you will live in:

| Surface | URL | Who |
|---|---|---|
| Admin / organizer | `/admin`, `/admin/tournaments/<id>` | steamid64 in `ADMIN_STEAMIDS` |
| Marshal board (floor) | `/marshal/dashboard` | `ADMIN_STEAMIDS` or `MARSHAL_STEAMIDS` |
| Public + player | `/`, `/tournaments/<id>`, `/tournaments/<id>/register` | anyone (Steam login to register) |

Everything requires a Steam sign-in. There is no admin password — admin is an identity
(your steamid64 in the env allowlist).

---

## (a) Before the LAN

### 1. Environment checklist

`.env` lives at `/home/mole/apps/Summit/.env` (chmod 600, never in git). Required:

| Variable | Why it matters if wrong |
|---|---|
| `NEXTAUTH_SECRET` | Signs session cookies. Rotating it logs everyone out. |
| `STEAM_API_KEY` | **Nobody can log in without it** — every `/api/auth/*` request fails. Get one at https://steamcommunity.com/dev/apikey |
| `ADMIN_STEAMIDS` | Comma-separated steamid64 list. These people are organizers. |
| `MARSHAL_STEAMIDS` | Comma-separated steamid64 list for floor staff. They get `/marshal` + match control, not settings. |
| `CS2_WEBHOOK_KEY` | Bearer key for `/api/webhooks/cs2`. Fails closed (HTTP 503) if unset. **Not** needed for the EON bridge — that uses its own per-tournament token. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Phone push ("your match is up"). Generate with `npx web-push generate-vapid-keys`. If blank, the "Enable alerts" button hides itself and no push is ever sent. |
| `DISCORD_WEBHOOK_URL` | Channel announcements (match called / result / signup). Alternative: `DISCORD_BOT_TOKEN` + `DISCORD_CHANNEL_ID`. If neither is set, announcements only land in the in-app feed. |

`NEXTAUTH_URL` and `DATABASE_URL` are set for you by `docker-compose.prod.yml` — leave them.
Full list with comments: `.env.example`.

**The Discord bot has a second file: `.env.bot`** (same folder, also chmod 600). It is separate
on purpose — the bot never gets to see `NEXTAUTH_SECRET` or `STEAM_API_KEY`.

| Variable | In which file | Why it matters if wrong |
|---|---|---|
| `DISCORD_BOT_TOKEN` | **both** `.env` and `.env.bot` | The same token in both. The app uses it to post and DM; the bot uses it to log in and listen. |
| `DISCORD_CLIENT_ID` | `.env.bot` | The Discord application id. Without it the bot cannot register `/koble` and `/stopp`. |
| `DISCORD_GUILD_ID` | **both** | Which Discord server the commands live in. Also what makes the "Koble Discord" card appear on a player's profile. |
| `SUMMIT_BOT_KEY` | **both**, same value | The password the bot uses to talk to the app. `openssl rand -hex 32`. If it is missing on the app side, linking fails closed (HTTP 503) rather than letting anyone in. |
| `SUMMIT_API_URL` | `.env.bot` | `http://summit:4001`. The container-to-container address — **not** the turnering.mortenlab.xyz URL. |

If `.env.bot` does not exist yet, the app still deploys normally; only the bot fails to start,
and it says exactly which line is missing in `docker logs summit-bot`.

### 2. Deploy

```bash
cd /home/mole/apps/Summit
docker compose -f docker-compose.prod.yml up -d --build
```

Verify:

```bash
docker ps --filter name=summit          # should be "Up"
curl -sI http://127.0.0.1:8089/ | head -1 # 200 (loopback bind behind the tunnel)
docker logs --tail 50 summit            # migrations applied, then "ready"
```

Then open https://turnering.mortenlab.xyz in a browser and sign in with Steam.

Any change to `.env` needs `up -d` again (or `restart`) — the app reads env at boot.

**There are two containers now: `summit` (the site) and `summit-bot` (the Discord bot).** The
command above builds and starts both. To touch only one:

```bash
docker compose -f docker-compose.prod.yml up -d --build summit       # the site only
docker compose -f docker-compose.prod.yml up -d --build summit-bot   # the Discord bot only
```

Use the per-service form during the event. A change to `.env.bot` needs the `summit-bot` line;
a change to `.env` needs the `summit` line.

Check the bot came up:

```bash
docker ps --filter name=summit-bot                  # should be "Up" and "(healthy)"
docker logs --tail 20 summit-bot | grep READY       # names the bot, the guild and the commands
```

The READY line looks like this, and is the one thing worth reading:

```
[bot] READY as Summit#1234 · guild 987654321098765432 · commands /koble /stopp (up-to-date) · app http://summit:4001
```

Note: `docker compose ... down` in the restore procedure further down now stops the bot as
well. That is harmless — nothing about the tournament depends on it — and `up -d` brings it
back.

### 3. Verify the backup ran

```bash
./scripts/backup.sh
ls -lh data/backups/ | tail -5     # prod-<ts>.db + uploads-<ts>.tar.gz
tail -20 data/backups/backup.log   # if cron is installed
```

The snapshot is taken with SQLite `VACUUM INTO` inside the container and verified with
`PRAGMA integrity_check`; a failed check deletes the snapshot and exits non-zero. Cron line
(add with `crontab -e` — it is not installed automatically):

```cron
20 3 * * * cd /home/mole/apps/Summit && ./scripts/backup.sh >> data/backups/backup.log 2>&1
```

Run it once by hand the morning of the LAN, and again right before you generate the bracket.

### 4. Create the tournament

`/admin` → **Create Tournament** → 6-step wizard:

1. **Game** — Counter-Strike 2.
2. **Name** — shown everywhere, including the overlay.
3. **Bracket style** — Single or Double Elimination. **Team size** — 2v2 or 5v5 for CS2.
   **3rd place decider** — optional bronze match.
4. **Best-of stages** — these are *stage-relative*, counted backwards from the final, so they
   stay correct whatever the bracket size:

   | Dropdown option | Meaning |
   |---|---|
   | None | BO1 everywhere |
   | Grand Final | only the final |
   | Semi-Finals | semis **and** final |
   | Quarter-Finals | quarters onward |
   | Round of 16 | Ro16 onward |

   BO5 wins where BO3 and BO5 overlap (BO3 from Semi-Finals + BO5 from Grand Final = BO3 semis,
   BO5 final). Each match's win condition is derived from its best-of (first to
   `floor(bestOf/2)+1`) — you never type it.
5. **Review**.
6. **Done** — the wizard shows the tournament link.

All of this is still editable afterwards in **Settings** (see (c) for the catch).

### 5. Open registration

Tournament → **Settings**:

- **Signup Rules → Require Steam Sign-in: ON.** This is **off by default** and it is what turns on
  the self-service flow (create team → invite link → teammates join). With it off, the register
  page shows a manual roster form instead, and those players are never linked to a Steam account
  (no push, no self-service seat editing).
- **Operations Safety → Roster lock: Editable.** Locked = registration closed.

### 6. Share the link

```
https://turnering.mortenlab.xyz/tournaments/<tournamentId>/register
```

(the `<tournamentId>` is in the URL of the manage page). There is no QR generator in the app —
paste that URL into any QR tool for the poster at the door.

---

## (b) Registration window

### What players do

1. Open the register link → **Continue with Steam**.
2. **Team leader:** enter a team name (optional logo, optional seat like `B12`) → creates the
   team and makes them leader.
3. Leader taps **Copy Invite Link** and sends it to the team. It looks like
   `…/tournaments/<id>/register?invite=<code>`.
4. **Teammates:** open the invite link → Continue with Steam → **Join team**.
5. **Set seat.** The register page has a *Your Seat* field that stays editable at all times —
   including after the bracket is locked, because seats move on the floor. This is what marshals
   read off the board to find people.

A player may leave their team only *before* the bracket is generated (after that it's an
organizer job). If the leader leaves, the longest-standing remaining player is promoted, and a
team with nobody left is deleted.

### What admins can fix

Tournament → **Teams** tab:

- Add a team with a full roster; edit any team (name, logo, seed).
- Add / edit / remove players: name, nickname, country, **seat**, steamid, leader flag.
- Remove a team. While the bracket is locked this is a *forced* removal — the dialog spells it
  out: the team is pulled out of every match it sits in (those slots go back to TBD) and any win
  recorded for it is cleared.
- Seeds drive the bracket pairings, so fix them before you generate.

After the bracket is locked, staff can still fix seats, names, nicknames and flags. Changing a
player's **steamid** or **leader** flag, adding a player, or deleting a player is refused while
locked (HTTP 423) — unlock in Settings first if you really must.

### CSV import

Admin-only, on the Teams tab. **One row per player**, rows grouped by `teamName`; the seed is
taken from the first row of each team. Header must be exactly:

```csv
teamName,seed,playerName,nickname,countryCode,seating,steamId,isLeader
Team Alpha,1,Morten Lein,mole,NO,A1,76561198000000001,true
Team Alpha,1,Jon Doe,jdoe,NO,A2,76561198000000002,
Team Bravo,2,Ola Nordmann,ola,NO,B1,https://steamcommunity.com/id/olanordmann,true
```

Notes:

- `isLeader` is `true` or blank. Quote any value containing a comma.
- `steamId` accepts a steamid64 **or** a profile/vanity URL — it is resolved via the Steam API.
- Imported players are **not** linked to a Steam login, so they get no phone push and no player
  self-service. Fill `steamId` in anyway: the EON live-score bridge identifies matches by the
  steamids on the server.
- Export the current roster (staff only, includes steamids) from the same tab, or
  `GET /api/tournaments/<id>/teams?format=csv`.

---

## (c) Start of play

1. **Count the teams.**
   - **Double elimination requires a power of two: 4, 8, 16 or 32.** Anything else is refused with
     a message telling you exactly how many teams to add, or to switch to single elimination.
   - **Single elimination takes any count ≥ 2** and fills the gaps with byes. A bye is created
     already finished, so the team simply appears in round 2.
2. **Generate the bracket** (Control / Matches → Generate). The confirm dialog says it: this
   creates the first round from the seeded teams **and locks roster edits**.
3. **"Regenerate" destroys everything.** It deletes *all* matches — scores, forfeits, map scores,
   advancements, the lot — and rebuilds from the current teams and seeds. The dialog reads
   "This will delete all existing matches and results and rebuild the bracket." Once the first
   match has been played, treat regenerate as a last resort.
4. **Settings changes don't reshape an existing bracket.** Format, team size, best-of stages and
   the third-place toggle save immediately, but the matches already in the database keep their
   old shape. The Settings card says "Regenerate the bracket after changing these" — so make
   these decisions *before* step 2.

---

## (d) Running matches

Two places, both live-updating over SSE (no refreshing):

- **Control cockpit** — `/admin/tournaments/<id>` → **Control** tab. Organizer view: full bracket,
  rosters with check-in state, score entry, EON bridge card. Admin only.
- **Marshal board** — `/marshal/dashboard`. Floor view: *Matches needing players* sorted by
  urgency (called first, then live, then pending), seat numbers, check-in buttons, and a
  *Match calls* feed. Admin **and** marshals.

### Call match

**Call match** on the marshal board (or `POST /api/matches/<id>/load`) does all of this at once:

- sets the match to **READY** ("Called");
- **web push** to every player on both rosters who has a Steam-linked account and pressed
  *Enable alerts* — "Your match is ready. Head to your station.";
- **Discord** announcement (if configured);
- one row in the in-app notification feed (*Match calls*) — deliberately one row, not one per
  channel;
- pushes the new state to every open board and overlay.

Both teams must be assigned, otherwise it refuses with "Both teams must be assigned before
loading a match."

### Check-in at seat

On the marshal board, tap a player to mark them **at seat**. It is stored on the player row, so
it is shared live between all marshals' phones, survives a reload, and shows on the control
cockpit too. Tap again to clear it.

Check-in is **per call**: calling a match clears both rosters' ticks, and so does completing
it — a tick from an earlier match never carries over. The board lists called matches first
(oldest call at the top; the "called N min ago" chip turns amber after 10 minutes), then live,
then up next. The dot next to "Live" in the header shows whether the phone is actually
connected; if it says "Reconnecting…" the board catches up by itself, or tap the refresh icon.

### Mark live

**Mark live** flips the match to **LIVE** once the teams are seated and the game has started.
Scores are entered in Control (or arrive from EON — see (e)).

### Enter scores

Control → click a match → the edit modal:

- **Status** buttons: *Not called* (PENDING) · *Called* (READY) · *Live* (LIVE) · *Final* (COMPLETED).
- **Series score** home / away.
- **Series Map Progression** appears when best-of > 1: one row per map with the map name and the
  round score on that map (BO3 / BO5).
- **Best of** can be changed per match; the win condition follows automatically.
- Reaching the win condition **auto-completes** the match and advances the winner (and, in double
  elimination, drops the loser into the lower bracket).

### Forfeit / walkover

Modal → **Forfeit** → *Home forfeits* / *Away forfeits*. The other team is declared winner and
advances, the match is marked final **by forfeit** (it carries a Forfeit badge), and the score is
set to `0 : <win condition>` unless you typed scores yourself. Both teams must be assigned.

### Fixing a wrong result

Re-open the match, change the status or the scores, save. The previous winner is automatically
pulled back out of the next match — *unless* that downstream match has already moved on. If it
is live, final, or has any score on it, the save is refused with:

> **Downstream match `a1b2c3d4` has already started — reset it first.**

Fix it in that order: open the downstream match (the 8 characters in the message are the start of
its id), set it back to *Not called* with `0 : 0`, save — then correct the earlier match.

If instead you see **"This record changed in another session. Refresh and try again."**, another
marshal saved that same match while you had it open. Refresh and redo your edit.

---

## (e) Live scores from EON

EON runs on the observer machine and pushes scores outward to Summit (Summit cannot reach
into the LAN).

**In Summit:** tournament → **Control** → **EON live scores** → **Enable bridge**. Copy the two
values it shows:

- Bridge endpoint — `https://turnering.mortenlab.xyz/api/webhooks/eon`
- Bridge token — `eon_…` (per tournament; *Rotate token* / *Disable* are in the same card)

**On the observer machine** (EON), either set environment variables (in EON's
`ecosystem.config.cjs` `env_production`, or the shell):

```
SUMMIT_BRIDGE_ENABLED=1
SUMMIT_BRIDGE_URL=https://turnering.mortenlab.xyz     # origin only, no path
SUMMIT_BRIDGE_TOKEN=eon_xxxxxxxxxxxx
```

…or drop `summit-bridge.json` in EON's working directory (or point `SUMMIT_BRIDGE_CONFIG` at
a file):

```json
{ "enabled": true, "url": "https://turnering.mortenlab.xyz", "token": "eon_xxxxxxxxxxxx" }
```

The config is re-read every ~5 seconds, so no EON restart is needed. Full reference:
`/home/mole/apps/eon/docs/summit-bridge.md` (in the EON repo at `/home/mole/apps/eon`).

**What auto-updates**

- The bridge identifies the match **by the steamids of the players on the server**, so every
  player in that match needs a steamid on their Summit player row. Steam sign-up fills this in;
  manually added and CSV-imported players need `steamId` set or nothing will match.
- Round score → the current map's row in the map scores. Headline score = rounds for BO1, series
  wins for BO3 / BO5.
- Status flips to **LIVE** when the map/round phase goes live.
- Side swaps are handled — CT/T is re-derived from the steamids on every push, so scores don't
  flip at half time.

**What it does not do:** it never completes a match and never advances anyone. Staff still press
*Final*. A wrong token or URL fails **silently** on the EON side (no error, no retry) — if scores
aren't moving, check `docker logs summit` for 401s on `/api/webhooks/eon`.

---

## (f) OBS overlays

Public, no login, both poll every 10 seconds (the bracket overlay also rides the live stream):

| Source | URL |
|---|---|
| Bracket | `https://turnering.mortenlab.xyz/bracket/<tournamentId>/overlay` |
| Rosters + seats | `https://turnering.mortenlab.xyz/bracket/<tournamentId>/roster` |

Query flags:

| Flag | Values | Applies to |
|---|---|---|
| `chroma` | `transparent` (default), or any CSS colour — e.g. `green`, `%2300b140` | both |
| `compact` | `true` — scales to 75% | bracket overlay |

OBS setup: add a **Browser Source**, paste the URL, set 1920×1080, tick **"Refresh browser when
scene becomes active"**, and in **Custom CSS** add
`body { background-color: rgba(0,0,0,0) !important; }` as a transparency safety net.

---

## (g) Troubleshooting

**A player can't log in.** Almost always `STEAM_API_KEY` — missing or invalid makes every
`/api/auth/*` request fail, for everyone. Check it in `.env`, then
`docker logs summit | grep -i steam`. Fix and `docker compose -f docker-compose.prod.yml up -d`.

**Someone signed in but has no admin/marshal powers.** Their steamid64 isn't in `ADMIN_STEAMIDS`
or `MARSHAL_STEAMIDS`. Find it at https://steamid.io, add it, restart the container. (A signed-in
non-staff user who opens `/admin` is bounced to the home page — that's the symptom.)

**Push not arriving.** In order: are `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` set (if not, the
*Enable alerts* button is hidden and nothing is sent)? Did the player press *Enable alerts* and
allow notifications, on *that* device and browser? Push requires HTTPS — use
`https://turnering.mortenlab.xyz`, never the LAN IP or `127.0.0.1:8089`. On iOS the site must be
added to the Home Screen first. Only players with a Steam-linked account can receive push, so
CSV-imported players never will. Dead subscriptions are pruned automatically.

**Discord silent.** Set `DISCORD_WEBHOOK_URL` (or `DISCORD_BOT_TOKEN` + `DISCORD_CHANNEL_ID`) and
restart the container. If `NEXT_PUBLIC_STRATEGY_3_MOCK=true` is set, delivery is intercepted on
purpose and announcements only reach the in-app feed. Rejected posts are logged:
`docker logs summit | grep -i discord`.

**Is the Discord bot alive?**

```bash
docker ps --filter name=summit-bot            # want: Up ... (healthy)
docker logs --tail 20 summit-bot              # want: a READY line naming the guild
docker exec summit-bot wget -qO- http://127.0.0.1:4002/status   # the full picture, as JSON
```

`/status` tells you the state (`ready`, `reconnecting`, `starting`, `fatal`), which commands
are registered, when a player last linked successfully, and the last error. It holds no
passwords, so it is safe to paste into a chat when asking for help.

**The bot is down / keeps restarting. What breaks?**

**Only one thing: nobody can run `/koble`, so nobody new can link their Discord account.**
Everything else is the site, not the bot — the bracket, calling matches, check-in, scoring,
phone push, and the Discord *channel* announcements all keep working, and players who already
linked keep getting their match DMs, because the site sends those. **Do not delay the
tournament for this.** Fix it after the round, or after the LAN.

```bash
docker logs --tail 50 summit-bot     # the first error line says what is wrong, in plain words
docker compose -f docker-compose.prod.yml restart summit-bot
```

The three usual causes, all named explicitly in the log: a missing line in `.env.bot`
("Missing required environment variables: …"), a bad token ("Discord rejected the
credentials"), or Discord being unreachable ("Gateway connect failed — retrying in 5s"). The
bot waits 30 seconds before exiting on a fatal error on purpose — restarting faster would make
Discord block the token for the rest of the day — so give it a minute before concluding it is
stuck in a loop.

**Nobody is getting DMs, but the channel posts fine.** That is a different system: the channel
and the DMs are both sent by the *site*, not the bot. Check, in order: is `DISCORD_DM_ENABLED`
set to `true` in `.env`; is **Pause Discord** switched on in Control for this tournament; and
does the reach panel say those players are linked at all. A player showing *ikke koblet* never
ran `/koble`; a player showing *blokkert* has direct messages from server members switched off
in their own Discord settings (Discord error 50007) — the bot cannot get past that, and the
crew fetches them in person. Which is what the crew does anyway.

**Every player shows as unreached at once, and the log says `CONFIG BREAKER TRIPPED`.** That is
the site refusing to keep asking. A rejected token, or a bot that is not in the guild, is the
same answer for every kid, and repeating it forty times per call-up is how an application gets
banned from Discord for an hour. Look at `DiscordLink.dmError` on the reach panel: one player
will say what Discord actually answered (`invalid_token`, `missing_access`) and the rest will
say the same thing with a `breaker_` prefix, meaning nothing was sent for them. Fix the cause —
usually a token pasted into only one of the two env files, or the bot never invited to the
guild — and wait five minutes. It heals on its own; no restart, no deploy. Run the floor on the
marshal board in the meantime, which is what it is for.

**Is Discord itself having a bad day?** Check https://discordstatus.com — that is the
authoritative answer, and it takes ten seconds. From the box: `docker logs --tail 30
summit-bot` showing repeated "Gateway connect failed" with a network error, or
`docker exec summit-bot wget -qO- https://discord.com/api/v10/gateway` timing out, both point
at Discord or at the box's internet rather than at Summit. If Discord is degraded, announce it
on the floor and run the LAN on the crew and the marshal board. That path is tested and does
not need Discord at all.

**Rotate the Discord token** (do this if the token leaks, and after the LAN as routine):
Discord Developer Portal → your application → Bot → **Reset Token**. Paste the new value into
**both** `/home/mole/apps/Summit/.env` and `/home/mole/apps/Summit/.env.bot`, then:

```bash
cd /home/mole/apps/Summit
docker compose -f docker-compose.prod.yml up -d summit summit-bot
```

Nothing is lost by rotating: no player has to re-link, and no DM history is affected.

**Restart the app.**

```bash
cd /home/mole/apps/Summit
docker compose -f docker-compose.prod.yml restart summit    # plain restart
docker compose -f docker-compose.prod.yml restart summit-bot   # just the Discord bot
docker compose -f docker-compose.prod.yml up -d --build        # after a code or .env change
```

**Restore from backup** (from the `RESTORE` block in `scripts/backup.sh`):

```bash
cd /home/mole/apps/Summit
docker compose -f docker-compose.prod.yml down       # stop the app, release the DB
cp data/prod.db data/prod.db.before-restore          # escape hatch
cp data/backups/prod-<ts>.db data/prod.db            # drop the snapshot in place
rm -f data/prod.db-wal data/prod.db-shm              # stale WAL would shadow the restore
docker compose -f docker-compose.prod.yml up -d      # migrations re-run, then serve
tar xzf data/backups/uploads-<ts>.tar.gz -C uploads/ # only if you need the logos back
```

**Where the logs are.**

```bash
docker logs -f summit                 # app: auth, webhooks, push, Discord, migrations
docker logs -f summit-bot             # the Discord bot: linking only
tail -f data/backups/backup.log         # backup cron
```

In-app there is also an audit trail of every staff action (who called what, who scored what) on
the tournament page.
