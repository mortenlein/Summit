import { REST } from '@discordjs/rest';
import { Routes, APIEmbed } from 'discord-api-types/v10';
import prisma from '@/lib/prisma';
import { LOG_LOCALE, discordLocale, getServerTranslations, type ServerTranslations } from '@/i18n/server';

export interface MockNotification {
  id: string;
  timestamp: string;
  embed: APIEmbed;
  type: 'MATCH' | 'RESULT' | 'SIGNUP';
}

type AnnouncementType = 'MATCH' | 'RESULT' | 'SIGNUP';
type TournamentEmbed = APIEmbed & { tournamentId?: string };

/**
 * An embed is built twice — once in English for the record, once in the channel's language.
 *
 * Two translators, because a match's position in the draw ("Semi-Finals" / "Semifinaler") is
 * shared vocabulary that lives in the `stage` namespace, not in `notifications`. Resolving it
 * inside the builder is what keeps the Discord post saying the same word as the public board.
 */
type EmbedBuilder = (t: ServerTranslations, tStage: ServerTranslations) => TournamentEmbed;

/**
 * Two announcements with the same (type, title, tournamentId) inside this window are the same
 * call, so only the first one is logged. Retries, double-clicks on "call match", and callers
 * that both log and announce (notify.ts) therefore can't stack up duplicate rows in the
 * marshal feed.
 */
const LOG_DEDUPE_WINDOW_MS = 10_000;

/**
 * Embed colours, matching the product's own vocabulary rather than contradicting it.
 *
 * Everywhere else in Summit green means "din tur" and red means live — so a *called* match was
 * painted red and a *result* green, which taught a kid who had learned the app to read a green
 * Discord post as a call-up when it was a finished score. Fixed here, once, for every caller.
 */
const COLOR_CALLED = 0x00c853; // green — go to your seat
const COLOR_LIVE = 0xff1744; // red — being played
const COLOR_RESULT = 0x0070f3; // blue — the record
const COLOR_UPNEXT = 0x6b7280; // grey — information, no glyph, no ping

class DiscordClient {
  private rest: REST | null = null;
  private channelId: string | null = null;
  private webhookUrl: string | null = null;

  constructor() {
    const token = process.env.DISCORD_BOT_TOKEN;
    this.channelId = process.env.DISCORD_CHANNEL_ID || null;
    this.webhookUrl = process.env.DISCORD_WEBHOOK_URL || null;

    if (token) {
      this.rest = new REST({ version: '10' }).setToken(token);
    }
  }

  private async executeRealDelivery(embed: TournamentEmbed) {
    // Strip our internal `tournamentId` — Discord rejects the whole embed (HTTP 400
    // "Invalid Form Body") if it carries any field outside the embed schema.
    const { tournamentId: _ignored, ...discordEmbed } = embed;

    if (this.webhookUrl) {
      try {
        const res = await fetch(this.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ embeds: [discordEmbed] }),
        });
        if (!res.ok) {
          console.error(`Discord webhook rejected (${res.status}): ${await res.text().catch(() => '')}`);
          return false;
        }
        return true;
      } catch (error) {
        console.error('Discord webhook error:', error);
        return false;
      }
    }

    if (this.rest && this.channelId) {
      try {
        await this.rest.post(Routes.channelMessages(this.channelId), {
          body: { embeds: [discordEmbed] },
        });
        return true;
      } catch (error) {
        console.error('Discord REST error:', error);
        return false;
      }
    }

    return false;
  }

  /**
   * Record the announcement in NotificationLog. This is what feeds the marshal board's
   * "Match calls" list and the admin timeline, so it has to happen whether or not a real
   * Discord webhook is configured — it used to only run in mock mode, which left both
   * surfaces empty in production. Never throws: a failed log must not fail the delivery.
   *
   * Always written in English: this row is an internal staff record, like the audit log. It is
   * also the dedupe key (title + description), so letting it follow a configurable language
   * would quietly change how duplicate calls collapse the day somebody flips `DISCORD_LOCALE`.
   *
   * `windowMs = null` means "this announcement happens once, ever" — the row itself becomes the
   * durable guard, with no time bound. That is what `announceMatchUpcoming` needs and it is
   * why this returns whether it found a duplicate: an up-next post that fires a second time for
   * the same match teaches the channel to ignore up-next posts.
   *
   * Returns `true` when the announcement was already logged. Never throws: a failed log must
   * not fail the delivery, so an error is reported as "not a duplicate".
   */
  private async writeLog(embed: TournamentEmbed, type: AnnouncementType, windowMs: number | null = LOG_DEDUPE_WINDOW_MS) {
    const title = String(embed.title || 'Notification');
    const description = String(embed.description || '');
    const tournamentId = embed.tournamentId || null;
    try {
      // Same announcement twice inside the window (double-click, notify + announce) → one row.
      // The description is part of the key: "Match ready for players" is the same title for
      // every match, so two different matches called back-to-back must both get a row.
      const duplicate = await prisma.notificationLog.findFirst({
        where: {
          type,
          title,
          description,
          tournamentId,
          ...(windowMs === null ? {} : { createdAt: { gte: new Date(Date.now() - windowMs) } }),
        },
        select: { id: true },
      });
      if (duplicate) return true;

      await prisma.notificationLog.create({
        data: {
          type,
          title,
          description,
          tournamentId,
        },
      });
      return false;
    } catch (error) {
      console.warn('[Discord] NotificationLog write failed:', error);
      return false;
    }
  }

  /**
   * A Discord channel is one text read by a whole room at once, so — unlike a push — there is
   * nobody to personalise it for. It gets the single language the deployment configured
   * (`DISCORD_LOCALE`, Norwegian by default); the staff record keeps English.
   */
  private async send(build: EmbedBuilder, type: AnnouncementType, options: { once?: boolean } = {}) {
    const isProdReady = Boolean(this.webhookUrl || (this.rest && this.channelId));
    const isMockMode = process.env.NEXT_PUBLIC_STRATEGY_3_MOCK === 'true';

    const logEmbed = build(
      await getServerTranslations(LOG_LOCALE, 'notifications'),
      await getServerTranslations(LOG_LOCALE, 'stage')
    );

    // Log first, always — the in-app feeds are the primary channel; Discord is the extra one.
    const alreadyAnnounced = await this.writeLog(logEmbed, type, options.once ? null : LOG_DEDUPE_WINDOW_MS);
    // A once-only announcement that is already on the record is not re-posted either. (The
    // ordinary 10-second dedupe deliberately still delivers: a webhook retry is cheap, a
    // duplicate row in the marshal feed is not.)
    if (options.once && alreadyAnnounced) return false;

    if (isMockMode || !isProdReady) {
      console.log(`[STRATEGY 3 MOCK] ${type} notification intercepted:`, logEmbed.title);
      return true;
    }

    const locale = discordLocale();
    const embed =
      locale === LOG_LOCALE
        ? logEmbed
        : build(
            await getServerTranslations(locale, 'notifications'),
            await getServerTranslations(locale, 'stage')
          );
    return this.executeRealDelivery(embed);
  }

  async announceMatch(data: {
    homeTeam: string;
    awayTeam: string;
    homePlayers?: string;
    awayPlayers?: string;
    round: number | string;
    tournamentName: string;
    tournamentId?: string;
    matchUrl: string;
    game: string;
  }) {
    await this.send((t) => {
      const fields = [
        { name: t('discord.fieldHome'), value: `**${data.homeTeam}**`, inline: true },
        { name: t('discord.fieldStatus'), value: 'vs', inline: true },
        { name: t('discord.fieldAway'), value: `**${data.awayTeam}**`, inline: true },
      ];

      if (data.homePlayers) {
        fields.push({
          name: t('discord.fieldRoster', { team: data.homeTeam }),
          value: `\`${data.homePlayers}\``,
          inline: false,
        });
      }
      if (data.awayPlayers) {
        fields.push({
          name: t('discord.fieldRoster', { team: data.awayTeam }),
          value: `\`${data.awayPlayers}\``,
          inline: false,
        });
      }

      fields.push({ name: t('discord.fieldPlatform'), value: `\`${data.game}\``, inline: false });

      return {
        title: t('discord.matchTitle'),
        // Teams are in the description on purpose: the in-app feed (marshal board) shows title +
        // description only, and the 10s log dedupe keys on them — two matches called back-to-back
        // in the same round must both show up.
        description: t('discord.matchDescription', {
          home: data.homeTeam,
          away: data.awayTeam,
          tournament: data.tournamentName,
          round: data.round,
        }),
        color: COLOR_CALLED,
        fields,
        url: data.matchUrl,
        footer: { text: t('discord.footerLive') },
        timestamp: new Date().toISOString(),
        tournamentId: data.tournamentId,
      };
    }, 'MATCH');
  }

  /**
   * The match is being played now.
   *
   * Live used to reuse `announceMatch` — "Match ready for players" — for a match that is
   * already running, which is the one thing it is not. A kid reading the channel could not tell
   * a call-up from a game in progress, and neither could a marshal scrolling the feed. Live is
   * its own sentence, its own colour, and its own row.
   */
  async announceMatchLive(data: {
    homeTeam: string;
    awayTeam: string;
    stageKey: string;
    stageValues?: Record<string, number>;
    tournamentName: string;
    tournamentId?: string;
    matchUrl: string;
    game: string;
  }) {
    await this.send((t, tStage) => {
      const stage = tStage(data.stageKey, data.stageValues);
      return {
        title: t('discord.liveTitle'),
        description: t('discord.liveDescription', {
          home: data.homeTeam,
          away: data.awayTeam,
          tournament: data.tournamentName,
          stage,
        }),
        color: COLOR_LIVE,
        fields: [
          { name: t('discord.fieldHome'), value: `**${data.homeTeam}**`, inline: true },
          { name: t('discord.fieldStatus'), value: 'vs', inline: true },
          { name: t('discord.fieldAway'), value: `**${data.awayTeam}**`, inline: true },
          { name: t('discord.fieldPlatform'), value: `\`${data.game}\``, inline: false },
        ],
        url: data.matchUrl,
        footer: { text: t('discord.footerLive') },
        timestamp: new Date().toISOString(),
        tournamentId: data.tournamentId,
      };
    }, 'MATCH');
  }

  /**
   * "Up next" — owner ask #1.
   *
   * Grey, no glyph, no ping: this is information, not an instruction. It is the one per-match
   * post that is deliberately *not* urgent, so it must not look like the green call-up that is.
   * No DM goes with it either (spec §7) — a kid who is not playing yet does not need a phone
   * buzz, and the channel is on the same screen as their game.
   *
   * `once: true`: this fires at most once per match for the life of the tournament. The
   * `NotificationLog` row is the guard — durable across restarts, no new column, and it is
   * already the record the marshal board reads. The key is (type, title, description,
   * tournament), and the description carries both team names and the stage, so the same two
   * teams meeting again later in the draw is a different post, as it should be.
   */
  async announceMatchUpcoming(data: {
    homeTeam: string;
    awayTeam: string;
    stageKey: string;
    stageValues?: Record<string, number>;
    tournamentName: string;
    tournamentId?: string;
    matchUrl: string;
  }) {
    return this.send(
      (t, tStage) => ({
        title: t('discord.upnextTitle'),
        description: t('discord.upnextDescription', {
          home: data.homeTeam,
          away: data.awayTeam,
          tournament: data.tournamentName,
          stage: tStage(data.stageKey, data.stageValues),
        }),
        color: COLOR_UPNEXT,
        url: data.matchUrl,
        footer: { text: t('discord.footerUpnext') },
        timestamp: new Date().toISOString(),
        tournamentId: data.tournamentId,
      }),
      'MATCH',
      { once: true }
    );
  }

  async announceResult(data: {
    homeTeam: string;
    awayTeam: string;
    homeScore: number;
    awayScore: number;
    tournamentName: string;
    tournamentId?: string;
    matchUrl: string;
    game: string;
  }) {
    const winner = data.homeScore > data.awayScore ? data.homeTeam : data.awayTeam;
    await this.send(
      (t) => ({
        title: t('discord.resultTitle'),
        description: t('discord.resultDescription', {
          home: data.homeTeam,
          away: data.awayTeam,
          homeScore: data.homeScore,
          awayScore: data.awayScore,
          tournament: data.tournamentName,
        }),
        color: COLOR_RESULT,
        fields: [
          { name: t('discord.fieldMatch'), value: `**${data.homeTeam}** vs **${data.awayTeam}**`, inline: false },
          { name: t('discord.fieldScore'), value: `**${data.homeScore} - ${data.awayScore}**`, inline: true },
          { name: t('discord.fieldWinner'), value: `**${winner}**`, inline: true },
          { name: t('discord.fieldPlatform'), value: `\`${data.game}\``, inline: false },
        ],
        url: data.matchUrl,
        footer: { text: t('discord.footerLive') },
        timestamp: new Date().toISOString(),
        tournamentId: data.tournamentId,
      }),
      'RESULT'
    );
  }

  /**
   * A single tournament-level announcement (e.g. "bracket is live"), not per-match.
   *
   * `title` / `description` are the English record. A caller that wants the Discord post
   * translated names a key from the `notifications.discord` namespace instead of pre-rendering
   * the sentence, because only the caller knows which values go in it.
   */
  async announceTournamentUpdate(data: {
    title: string;
    description: string;
    titleKey?: string;
    descriptionKey?: string;
    values?: Record<string, string | number>;
    tournamentId?: string;
    url?: string;
  }) {
    await this.send(
      (t) => ({
        title: data.titleKey ? t(`discord.${data.titleKey}`, data.values) : data.title,
        description: data.descriptionKey
          ? t(`discord.${data.descriptionKey}`, data.values)
          : data.description,
        color: 0x0070f3,
        url: data.url,
        footer: { text: t('discord.footer') },
        timestamp: new Date().toISOString(),
        tournamentId: data.tournamentId,
      }),
      'MATCH'
    );
  }

  async announceSignup(data: {
    playerName: string;
    teamName: string;
    tournamentName: string;
    tournamentId?: string;
    countryCode?: string | null;
  }) {
    const country = data.countryCode ? data.countryCode.toUpperCase() : 'N/A';
    await this.send(
      (t) => ({
        title: t('discord.signupTitle'),
        description: t('discord.signupDescription', { tournament: data.tournamentName }),
        color: 0x0070f3,
        fields: [
          { name: t('discord.fieldPlayer'), value: `**${data.playerName}**`, inline: true },
          { name: t('discord.fieldTeam'), value: `**${data.teamName}**`, inline: true },
          { name: t('discord.fieldCountry'), value: country, inline: true },
        ],
        footer: { text: t('discord.footerSignup') },
        timestamp: new Date().toISOString(),
        tournamentId: data.tournamentId,
      }),
      'SIGNUP'
    );
  }
}

const discordClient = new DiscordClient();

export const announceMatch = (data: any) => discordClient.announceMatch(data);
export const announceMatchLive = (data: any) => discordClient.announceMatchLive(data);
export const announceMatchUpcoming = (data: any) => discordClient.announceMatchUpcoming(data);
export const announceResult = (data: any) => discordClient.announceResult(data);
export const announceTournamentUpdate = (data: any) => discordClient.announceTournamentUpdate(data);
export const announceSignup = (data: any) => discordClient.announceSignup(data);

export default discordClient;
