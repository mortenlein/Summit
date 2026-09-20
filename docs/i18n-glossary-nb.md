# Norsk ordliste (bokmål) — Summit

The terminology that every Norwegian string is built from. Get this right and the app reads
native; get it wrong and 500 strings read like machine output.

Register: **uformelt bokmål, du-form**, for spillere fra 12 år. Not `De`, not officialese.
Norwegian gaming loanwords are kept where that is genuinely what people say — writing
`nettverkssamling` instead of `LAN` would be worse Norwegian, not better.

> The open questions were settled by the owner on 2026-09-20: **bracket** (not *kampoppsett*)
> and **crew** (not *vakt*). Both are marked ✅ below with the grammar they carry.

---

## 1. Core nouns

| English | Norsk | Note |
|---|---|---|
| Tournament | **turnering** | |
| Match | **kamp** | |
| Team | **lag** | |
| Player | **spiller** | |
| Round | **runde** | |
| Seed | **seeding** | the sports loanword, already standard in Norwegian |
| Seat | **plass** | "plassen din" = your seat. Core to the marshal flow |
| Registration | **påmelding** | |
| Invite code | **invitasjonskode** | |
| Team leader | **lagleder** | |
| Organizer | **arrangør** | |
| Queue | **kø** | |
| Settings | **innstillinger** | |
| Result | **resultat** | |
| Standings | **tabell** | |

### Bracket → **bracket** ✅ decided 2026-09-20

The loanword, everywhere, because it is what Norwegian esports players actually say out loud.
Not *kampoppsett*, not *turneringstre*.

**It inflects as masculine**: `en bracket` → `bracketen` (definite) → `brackets` (plural).
This matters: *kampoppsett* was **neuter**, so the swap left four strings with the old gender
(*et bracket*, *et nytt bracket*, *Bracketen er klart*, *lag det*). If the term ever changes
again, re-check every adjective, article and pronoun around it — not just the noun.

### Marshal (the floor staff who fetch players) → **crew** ✅ decided 2026-09-20

What youth LANs in Norway actually call this role. Not *vakt*, not *funksjonær*.
Inflects as neuter: `crewet` (definite). The board is the **crew-tavla**.

---

## 2. Match states

These four are the app's status vocabulary (`src/lib/match-status.ts`), so each needs exactly
one Norwegian word.

| State | English | Norsk | Note |
|---|---|---|---|
| `PENDING` | Scheduled | **satt opp** | |
| `READY` | Called | **kalt opp** | the marshal is coming for you |
| `LIVE` | Live | **live** | Norwegians say live; *direkte* is TV-speak |
| `COMPLETED` | Done | **ferdig** | |

Forfeit → **walkover** (the Norwegian sports term, often written *WO*).

---

## 3. Bracket stages

| English | Norsk |
|---|---|
| Grand Final | **finale** |
| Semi-Finals | **semifinale** |
| Quarter-Finals | **kvartfinale** |
| Round of 16 | **åttendedelsfinale** |
| Third place | **bronsefinale** |

*Note: `åttendedelsfinale` is correct but a mouthful and it will wrap on a phone. If you run
16-team brackets often, **runde 1** / **runde 2** may serve the players better than formal
stage names. **[VELG]***

---

## 4. The lines that matter most

The player-facing moments. These carry the whole product, so they are worth arguing about.

| Where | English | Norsk |
|---|---|---|
| Called (the money screen) | You're up — go to your station | **Du er neste — gå til plassen din** |
| Live | Live now — get to your station | **Live nå — kom deg til plassen din** |
| Waiting | 3 matches ahead of you | **3 kamper foran deg** |
| Knocked out | Your team is out of {tournament} | **Laget ditt er ute av {turnering}** |
| Not drawn yet | Not drawn yet | **Ikke trukket ennå** |
| Seat prompt | Marshals use this to find you. You can change it later. | **Crewet bruker dette for å finne deg. Du kan endre det senere.** |
| Invite | Send this to your teammates | **Send denne til lagkameratene dine** |
| Team full | This team is already full | **Dette laget er fullt** |
| Push title | Your match is ready | **Kampen din er klar** |

---

## 5. Verbs (buttons)

| English | Norsk |
|---|---|
| Save | **Lagre** |
| Cancel | **Avbryt** |
| Delete | **Slett** |
| Edit | **Rediger** |
| Sign in / out | **Logg inn / Logg ut** |
| Register (a team) | **Meld på** |
| Join team | **Bli med på laget** |
| Leave team | **Forlat laget** |
| Call match | **Kall opp** |
| Mark live | **Sett live** |
| Generate bracket | **Lag kampoppsett** |
| Copy | **Kopier** |

---

## 6. Left in English on purpose

`LAN`, `live`, `crew`, `overlay`, `Steam`, `Discord`, `CS2`, `BO1/BO3/BO5`, `walkover`.
Translating these would read as stilted, not as Norwegian.

---

## 7. Grammar notes for whoever writes the strings

- **Plurals:** Norwegian has two forms where English has two, but the counts differ from
  English in ICU terms — always use `{count, plural, one {…} other {…}}`, never string
  concatenation. `1 kamp` / `2 kamper`.
- **Definite form is a suffix**, not an article: *kampen*, *laget*, *turneringen*. Interpolating
  `{name}` into a sentence that needs the definite form is a common way to produce broken
  Norwegian — prefer phrasing that takes the bare name.
- **Compounds are written as one word**: *kampoppsett*, not *kamp oppsett*. Splitting them is
  the single most recognisable marker of sloppy Norwegian.
- **æ ø å** are in the Latin subset of all three loaded fonts — verified, no tofu.
