import prisma from "@/lib/prisma";
import { groupUsersByLocale, isPushConfigured, sendPushBatches, type PushBatch } from "@/lib/push";
import { announceMatch, announceMatchLive, announceMatchUpcoming } from "@/lib/discord";
import { sendMatchDms } from "@/lib/discord-dm";
import { getServerTranslations } from "@/i18n/server";
import { byPlayOrder, isActive, isDone } from "@/lib/match-status";
import { stageLabelKey, totalRoundsOf } from "@/lib/stage-label";

/** What a match-ready push needs to say who is playing whom, and where to send the tap. */
export interface MatchReadyCopy {
  homeTeam: string;
  awayTeam: string;
  status: string;
  tournamentId: string;
  matchId: string;
}

/**
 * The push, composed once per language present among the recipients.
 *
 * This is the payload a 12-year-old sees on a lock screen ten metres from their station, so it is
 * the one string in the app that most has to be in their own language. The recipients are grouped
 * by `User.locale` first and the copy is written per group — one payload for everybody would mean
 * whoever is in the minority gets told to go to their station in a language they may not read.
 *
 * Exported so the behaviour is testable without a phone in the loop: the payload set is the whole
 * observable contract of the push, and the delivery below is just a loop over it.
 */
export async function buildMatchReadyPushBatches(
  userIds: string[],
  copy: MatchReadyCopy
): Promise<PushBatch[]> {
  const audiences = await groupUsersByLocale(userIds);

  return Promise.all(
    audiences.map(async ({ locale, userIds: recipients }) => {
      const t = await getServerTranslations(locale, "notifications");
      const key = copy.status === "LIVE" ? "push.matchLive" : "push.matchReady";
      return {
        locale,
        userIds: recipients,
        payload: {
          title: t(`${key}.title`),
          body: t(`${key}.body`, { home: copy.homeTeam, away: copy.awayTeam }),
          url: `/tournaments/${copy.tournamentId}`,
          tag: `match-${copy.matchId}`,
        },
      };
    })
  );
}

/**
 * Notify both teams in a match that it's ready / live across every channel:
 *  - web push to each registered player, in that player's own language ("du er neste — gå til
 *    plassen din" / "you're up — get to your station"),
 *  - an in-app NotificationLog entry (written by the Discord announce path, surfaced on the marshal board),
 *  - a Discord post via the existing announce path (real delivery when configured).
 *
 * Safe to call best-effort; never throws into the request path.
 */
export async function notifyMatchReady(matchId: string, status: string) {
  try {
    const match = await prisma.match.findUnique({
      where: { id: matchId },
      include: {
        tournament: { select: { id: true, name: true, game: true } },
        homeTeam: { include: { players: { select: { userId: true } } } },
        awayTeam: { include: { players: { select: { userId: true } } } },
      },
    });
    if (!match || !match.homeTeam || !match.awayTeam) return;

    const userIds = [...(match.homeTeam.players || []), ...(match.awayTeam.players || [])]
      .map((p) => p.userId)
      .filter((id): id is string => Boolean(id));

    // Nothing to compose when push is switched off (no VAPID keys) — the language lookup and one
    // translator per language would otherwise run on every match call for a payload nobody sends.
    if (userIds.length > 0 && isPushConfigured()) {
      const batches = await buildMatchReadyPushBatches(userIds, {
        homeTeam: match.homeTeam.name,
        awayTeam: match.awayTeam.name,
        status,
        tournamentId: match.tournamentId,
        matchId: match.id,
      });
      await sendPushBatches(batches);
    }

    // The in-app NotificationLog row is written by the announce path (discord.ts logs on both
    // the real and mock delivery paths), so nothing is logged here — that would double the feed.
    const matchUrl = `${process.env.NEXTAUTH_URL}/tournaments/${match.tournamentId}`;

    if (status === "LIVE") {
      const stage = stageLabelKey(match, await totalRoundsFor(match.tournamentId));
      await announceMatchLive({
        homeTeam: match.homeTeam.name,
        awayTeam: match.awayTeam.name,
        stageKey: stage.key,
        stageValues: stage.values,
        tournamentName: match.tournament.name,
        tournamentId: match.tournamentId,
        matchUrl,
        game: match.tournament.game,
      }).catch(() => {});
    } else {
      await announceMatch({
        homeTeam: match.homeTeam.name,
        awayTeam: match.awayTeam.name,
        round: match.round,
        tournamentName: match.tournament.name,
        tournamentId: match.tournamentId,
        matchUrl,
        game: match.tournament.game,
      }).catch(() => {});
    }

    // Discord DMs to the two rosters — detached on purpose. This is the marshal's tap: the
    // route must return the moment the database write and the broadcast are done, not after ten
    // paced sends or a 429 with a multi-second retry_after, or they tap "Kall opp" again in a
    // loud room. Idempotency is durable (DiscordDmAttempt), so the second tap costs nothing.
    void sendMatchDms(match.id, status === "LIVE" ? "MATCH_LIVE" : "MATCH_CALLED").catch(() => {});

    // Calling a match moves the front of the running order, so whatever is now first in play
    // order becomes "up next". Detached for the same reason.
    void announceUpcomingMatch(match.tournamentId).catch(() => {});
  } catch (err) {
    console.warn("[Notify] notifyMatchReady failed:", err);
  }
}

/** Highest winners-bracket round in a tournament — the anchor stage names count back from. */
async function totalRoundsFor(tournamentId: string): Promise<number> {
  const draw = await prisma.match.findMany({
    where: { tournamentId },
    select: { bracketType: true, round: true },
  });
  return totalRoundsOf(draw);
}

/**
 * One up-next decision at a time, per tournament.
 *
 * `announceUpcomingMatch` is triggered from three places (a call-up, a result, an advancement)
 * and two of them fire it detached. Its "at most once per match" guard is a read of
 * `NotificationLog` followed by a write, which is not atomic — two triggers landing together
 * both read "not announced" and both post. On a LAN that is the same match announced twice in
 * the channel, which is precisely what teaches a room to stop reading up-next posts.
 *
 * Serialising per tournament closes it inside the process, which is where every trigger lives
 * (one Next server, no queue by design — spec §1). It is the cheap layer: it stops two triggers
 * doing the same work at all. The durable layer is `NotificationLog.dedupeKey`, which is unique,
 * so even a race this lock cannot see (two processes, a restart mid-flight) still resolves to
 * one post.
 */
const upcomingLocks = new Map<string, Promise<unknown>>();

function serializePerTournament<T>(tournamentId: string, task: () => Promise<T>): Promise<T> {
  const previous = upcomingLocks.get(tournamentId) ?? Promise.resolve();
  const run = previous.then(task, task);
  // Release the slot once nothing is queued behind it, so this never grows with the draw.
  const settled = run.then(
    () => undefined,
    () => undefined
  );
  upcomingLocks.set(tournamentId, settled);
  void settled.then(() => {
    if (upcomingLocks.get(tournamentId) === settled) upcomingLocks.delete(tournamentId);
  });
  return run;
}

/**
 * Announce the match that is now at the front of the running order — owner ask #1.
 *
 * **What "upcoming" means here, precisely:** the single match that (a) has *both* teams known,
 * (b) is not finished and not already called or live, and (c) sorts first under `byPlayOrder`
 * from `match-status.ts` — the same comparator the player queue, the marshal board and the
 * cockpit order by. One match, not a round, because Summit runs rounds in parallel and "the
 * whole next round is up next" is both true and useless.
 *
 * Why those three conditions and not "a match just acquired its second team":
 *  - **Both teams known** excludes TBD slots. A post naming "Team Fjord vs TBD" tells nobody
 *    anything and cannot be deduplicated sensibly when the other half arrives.
 *  - **Not already called/live** is what stops the up-next post racing the call-up post for the
 *    same match; a called match is not upcoming, it is happening.
 *  - **First in play order** is the correction to the naive trigger. With parallel rounds, a
 *    round-2 match can acquire both teams while two round-1 matches are still unplayed — it is
 *    not next, and announcing it there teaches the channel that "up next" is a lie.
 *
 * Fires at most once per match: `announceMatchUpcoming` guards on the NotificationLog row.
 * Cheap to call after any event that moves the queue (a call, a result, an advancement).
 */
export async function announceUpcomingMatch(tournamentId: string) {
  return serializePerTournament(tournamentId, () => announceUpcomingMatchNow(tournamentId));
}

async function announceUpcomingMatchNow(tournamentId: string) {
  try {
    const matches = await prisma.match.findMany({
      where: { tournamentId },
      select: {
        id: true,
        round: true,
        matchOrder: true,
        bracketType: true,
        status: true,
        homeTeam: { select: { name: true } },
        awayTeam: { select: { name: true } },
      },
    });

    const next = matches
      .filter((m) => m.homeTeam && m.awayTeam && !isDone(m.status) && !isActive(m.status))
      .sort(byPlayOrder)[0];
    if (!next) return;

    const stage = stageLabelKey(next, totalRoundsOf(matches));
    const tournament = await prisma.tournament.findUnique({
      where: { id: tournamentId },
      select: { name: true },
    });
    if (!tournament) return;

    await announceMatchUpcoming({
      homeTeam: next.homeTeam!.name,
      awayTeam: next.awayTeam!.name,
      stageKey: stage.key,
      stageValues: stage.values,
      tournamentName: tournament.name,
      tournamentId,
      matchUrl: `${process.env.NEXTAUTH_URL}/tournaments/${tournamentId}`,
    });
  } catch (err) {
    console.warn("[Notify] announceUpcomingMatch failed:", err);
  }
}
