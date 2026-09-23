import fs from "fs";
import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";

/**
 * Turn a Discord name a player typed into the account it belongs to.
 *
 * Discord has no global user directory — you genuinely cannot look a stranger up by name. But a
 * bot that is *in your server* can search that server's own member list, and every player at
 * this LAN is in 6614gamers. That is the whole trick, and it is what makes "type your Discord
 * name" a real address rather than a note nobody can send to.
 *
 * We resolve to the snowflake and store that. Usernames change; snowflakes do not, so a kid who
 * renames themselves the week before the LAN still gets called.
 */

export type ResolveFailure =
  | "not_configured"
  | "empty"
  | "not_found"
  | "ambiguous"
  | "lookup_failed";

export interface ResolvedMember {
  discordId: string;
  /** What Discord says they are called now, not what the kid typed. */
  discordUsername: string;
  /** Their per-server nickname, when they have one — what crew sees on the floor. */
  nickname: string | null;
}

export interface ResolveResult {
  ok: boolean;
  member?: ResolvedMember;
  reason?: ResolveFailure;
  /** On `ambiguous`, the names that matched, so the UI can ask which one. */
  candidates?: ResolvedMember[];
}

let restClient: REST | null = null;
function rest(): REST {
  if (!restClient) {
    restClient = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN!);
  }
  return restClient;
}

/**
 * Normalise what a 13-year-old actually types.
 *
 * They will paste `@leo_6614`, they will type the old `Leo#1234` form they still see in
 * screenshots, and they will add a space. None of those are what Discord matches on.
 */
export function normalizeDiscordName(input: string): string {
  let value = String(input ?? "").trim();
  if (value.startsWith("@")) value = value.slice(1);
  // Legacy discriminator: Discord dropped it, but it is still all over old guides and videos.
  const hash = value.lastIndexOf("#");
  if (hash > 0 && /^\d{4}$/.test(value.slice(hash + 1))) value = value.slice(0, hash);
  return value.trim();
}

export function isDiscordResolveConfigured(): boolean {
  return Boolean(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_GUILD_ID);
}

/**
 * A stand-in for the guild's member list, for tests.
 *
 * There is no Discord server in a test run and there will not be one, so the half of this
 * feature that decides whether a typed name becomes an address is otherwise unreachable —
 * including the two answers that matter most, "nobody has that name" and "several people do".
 * Read fresh on every call so a spec can change the roster between two submissions. Set
 * nowhere but `playwright.config.ts`, exactly like `DISCORD_DM_SIMULATE`.
 */
function stubbedDirectory(): any[] | null {
  const file = process.env.DISCORD_GUILD_DIRECTORY;
  if (!file) return null;
  try {
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, "utf8") || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Shape one raw guild member payload into the fields we keep. */
function toMember(raw: any): ResolvedMember | null {
  const id = raw?.user?.id;
  if (!id) return null;
  return {
    discordId: String(id),
    discordUsername: String(raw.user.username ?? ""),
    nickname: raw.nick ? String(raw.nick) : null,
  };
}

/**
 * Search the guild for one member.
 *
 * Discord matches on a *prefix* of the username or the nickname, so "leo" can legitimately come
 * back with several people. An exact hit on either name wins outright; otherwise a single
 * result is taken and anything more is reported as ambiguous rather than guessed at. Guessing
 * here sends one child's match call to another child.
 */
export async function resolveGuildMemberByName(input: string): Promise<ResolveResult> {
  if (!isDiscordResolveConfigured()) return { ok: false, reason: "not_configured" };

  const query = normalizeDiscordName(input);
  if (!query) return { ok: false, reason: "empty" };

  let raw: any[];
  const stub = stubbedDirectory();
  if (stub) {
    // Discord's own search matches a *prefix* of either name, case-insensitively. The stub has
    // to behave the same way or the ambiguity handling below is tested against a fiction.
    raw = stub.filter(
      (m: any) =>
        String(m?.user?.username ?? "").toLowerCase().startsWith(query.toLowerCase()) ||
        String(m?.nick ?? "").toLowerCase().startsWith(query.toLowerCase())
    );
  } else {
    try {
      raw = (await rest().get(Routes.guildMembersSearch(process.env.DISCORD_GUILD_ID!), {
        query: new URLSearchParams({ query, limit: "10" }),
      })) as any[];
    } catch (error) {
      console.error("[DiscordResolve] guild member search failed:", error);
      return { ok: false, reason: "lookup_failed" };
    }
  }

  const members = (Array.isArray(raw) ? raw : []).map(toMember).filter(Boolean) as ResolvedMember[];
  if (members.length === 0) return { ok: false, reason: "not_found" };

  const wanted = query.toLowerCase();
  const exact = members.filter(
    (m) =>
      m.discordUsername.toLowerCase() === wanted || (m.nickname || "").toLowerCase() === wanted
  );
  if (exact.length === 1) return { ok: true, member: exact[0] };
  // Two members cannot share a username, so >1 exact means one matched on a nickname. Ask.
  if (exact.length > 1) return { ok: false, reason: "ambiguous", candidates: exact };

  if (members.length === 1) return { ok: true, member: members[0] };
  return { ok: false, reason: "ambiguous", candidates: members.slice(0, 5) };
}
