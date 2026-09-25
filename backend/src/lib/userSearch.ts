// `/user <text>` — vyhledání uživatele kanálu pro moda (2026-09-25). Našeptávač v poli pro psaní
// nabízí všechny, kdo v kanálu kdy psali (archiv messages), výběr otevře Profil. Kontrakt:
// docs/superpowers/plans/2026-09-25-moderace-cast-2-kontrakt.md, sekce „Vyhledání uživatele“.
//
// Jádro bez HTTP a auth: ověření moda dělá VOLAJÍCÍ (routes/userSearch.ts) PŘED voláním čehokoli odsud.
//
// Kanál = UC kanál; Kick/YouTube kanál z registru Židolišty (registryPlatformChannel, stejně jako Profil
// a timeout/ban). Hledá se v zobrazovaném jménu (messages.platform_username, i starší jména po přejmenování)
// a v UC přezdívkách (nicknames). Bez diakritiky a velikosti písmen přes uc_fold() (sql/2026-09-25-chat-log-search.sql).
// Indexy: prefix = messages_channel_username_fold_prefix_idx, fulltext = messages_username_fold_trgm
// (sql/2026-09-25-user-search-index.sql).
import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/index.js';
import { messages, nicknames } from '../db/schema.js';
import { likePattern } from '../routes/chatLog.js';
import type { Platform } from './zidolista.js';

export const USER_SEARCH_LIMIT_DEFAULT = 20;
export const USER_SEARCH_LIMIT_MAX = 50;
/** Kolik kandidátů (distinct identit) se vezme z DB před seřazením — přesné shody jdou v SQL první. */
export const USER_SEARCH_CANDIDATES = 100;
export const USER_SEARCH_Q_MAX = 40;

export interface UserSearchScope { platform: Platform; channels: string[] }

export interface UserSearchHit {
  platform: Platform;
  userId: string;
  login: string;
  displayName: string;
  nickname?: string;
  color?: string;
  lastSeen: number;
  count: number;
}

export interface UserSearchDeps {
  /** Platformní kanál UC kanálu (registr); null = platforma kanál nemá. */
  platformChannel: (channel: string, platform: Platform) => Promise<string | null>;
  /** Identity (distinct platform + userId) v rozsahu, jejichž jméno odpovídá vzoru, nebo jsou v `extra` (přezdívky). */
  /** `pattern` = LIKE vzor (escapovaný), `exact` = hledaný text beze změny (přesná shoda jde první). */
  candidates: (scope: UserSearchScope[], q: { pattern: string; exact: string; extra: Array<{ platform: Platform; login: string }> }, limit: number) => Promise<Array<{ platform: Platform; userId: string }>>;
  /** Statistika kandidátů v rozsahu: počet zpráv, poslední čas, poslední jméno a barva. */
  stats: (scope: UserSearchScope[], ids: Array<{ platform: Platform; userId: string }>) => Promise<Array<{ platform: Platform; userId: string; count: number; lastSeen: Date; name: string; color: string | null }>>;
  /** Přezdívky podle vzoru (hledání) — max pár desítek. */
  nicknamesMatching: (pattern: string) => Promise<Array<{ platform: Platform; login: string }>>;
  /** Přezdívky pro dané loginy. */
  nicknamesFor: (keys: Array<{ platform: Platform; login: string }>) => Promise<Array<{ platform: Platform; login: string; nickname: string; color: string | null }>>;
}

/**
 * Bez diakritiky a malými písmeny (JS protějšek uc_fold pro řazení v JS; SQL porovnává přes uc_fold na obou stranách).
 */
export function foldName(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Text z pole (`/user @Zigi`) → hledaný text; null = neplatný (prázdný / moc dlouhý). */
export function normalizeQuery(raw: unknown): string | null {
  const q = String(raw ?? '').trim().replace(/^@/, '').trim();
  if (!q || q.length > USER_SEARCH_Q_MAX) return null;
  return q;
}

export function clampSearchLimit(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? Math.min(n, USER_SEARCH_LIMIT_MAX) : USER_SEARCH_LIMIT_DEFAULT;
}

/** 0 = přesná shoda (login, jméno nebo přezdívka), 1 = začátek některého z nich, 2 = jinde. */
export function matchRank(h: Pick<UserSearchHit, 'login' | 'displayName' | 'nickname'>, q: string): 0 | 1 | 2 {
  const f = foldName(q);
  const names = [h.login, h.displayName, h.nickname].filter((x): x is string => !!x).map(foldName);
  if (names.some((n) => n === f)) return 0;
  if (names.some((n) => n.startsWith(f))) return 1;
  return 2;
}

/** Řazení: přesná shoda → začátek jména → podle poslední aktivity (pak počet zpráv, jméno). */
export function rankHits(hits: UserSearchHit[], q: string): UserSearchHit[] {
  return hits
    .map((h) => ({ h, r: matchRank(h, q) }))
    .sort((a, b) => a.r - b.r || b.h.lastSeen - a.h.lastSeen || b.h.count - a.h.count || a.h.login.localeCompare(b.h.login))
    .map((x) => x.h);
}

const PLATFORMS: Platform[] = ['twitch', 'kick', 'youtube'];
const channelValues = (pch: string) => { const n = pch.trim().toLowerCase().replace(/^@/, ''); return [n, `@${n}`]; };

/**
 * Hledání (mod už ověřený). Fulltext vypnutý = jméno / přezdívka ZAČÍNÁ textem, zapnutý = obsahuje text kdekoli.
 */
export async function searchUsers(
  input: { channel: string; q: string; fulltext: boolean; limit: number },
  deps: UserSearchDeps,
): Promise<UserSearchHit[]> {
  const scope: UserSearchScope[] = [];
  for (const p of PLATFORMS) {
    const pch = await deps.platformChannel(input.channel, p).catch(() => null);
    if (pch) scope.push({ platform: p, channels: channelValues(pch) });
  }
  if (!scope.length) return [];
  const pattern = likePattern(input.q, { prefix: !input.fulltext });
  const scoped = new Set(scope.map((s) => s.platform));
  const extra = (await deps.nicknamesMatching(pattern)).filter((n) => scoped.has(n.platform));
  const cands = await deps.candidates(scope, { pattern, exact: input.q, extra }, USER_SEARCH_CANDIDATES);
  if (!cands.length) return [];
  const stats = await deps.stats(scope, cands);
  const logins = stats.map((s) => ({ platform: s.platform, login: s.name.toLowerCase() }));
  const nicks = new Map((await deps.nicknamesFor(logins)).map((n) => [`${n.platform}:${n.login}`, n]));
  const hits: UserSearchHit[] = stats.map((s) => {
    const login = s.name.toLowerCase();
    const n = nicks.get(`${s.platform}:${login}`);
    const color = n?.color || s.color || undefined;
    return {
      platform: s.platform, userId: s.userId, login, displayName: s.name,
      ...(n ? { nickname: n.nickname } : {}), ...(color ? { color } : {}),
      lastSeen: s.lastSeen.getTime(), count: s.count,
    };
  });
  return rankHits(hits, input.q).slice(0, input.limit);
}

// ---- DB ----
const scopeCond = (scope: UserSearchScope[]): SQL => {
  const parts = scope.map((s) => and(eq(messages.platform, s.platform), inArray(messages.channel, s.channels))!);
  return parts.length === 1 ? parts[0] : or(...parts)!;
};

async function dbCandidates(scope: UserSearchScope[], q: { pattern: string; exact: string; extra: Array<{ platform: Platform; login: string }> }, limit: number) {
  const nameCond = [sql`uc_fold(${messages.platformUsername}) LIKE uc_fold(${q.pattern})`];
  for (const e of q.extra) nameCond.push(and(eq(messages.platform, e.platform), sql`lower(${messages.platformUsername}) = ${e.login}`)!);
  const rows = await db.select({ platform: messages.platform, userId: messages.platformUserId })
    .from(messages)
    .where(and(scopeCond(scope), nameCond.length === 1 ? nameCond[0] : or(...nameCond)!))
    .groupBy(messages.platform, messages.platformUserId)
    // Přesná shoda jména první (jinak by ji u krátkého textu vytlačily aktivnější prefixy), pak aktivita.
    .orderBy(sql`bool_or(uc_fold(${messages.platformUsername}) = uc_fold(${q.exact})) DESC`, sql`max(${messages.sentAt}) DESC`)
    .limit(limit);
  return rows.map((r) => ({ platform: r.platform as Platform, userId: r.userId }));
}

async function dbStats(scope: UserSearchScope[], ids: Array<{ platform: Platform; userId: string }>) {
  const who = or(...ids.map((i) => and(eq(messages.platform, i.platform), eq(messages.platformUserId, i.userId))!))!;
  const rows = await db.select({
    platform: messages.platform, userId: messages.platformUserId,
    count: sql<number>`count(*)::int`, lastSeen: sql<Date>`max(${messages.sentAt})`,
    name: sql<string>`(array_agg(${messages.platformUsername} ORDER BY ${messages.sentAt} DESC))[1]`,
    color: sql<string | null>`(array_agg(${messages.contentRaw}->>'color' ORDER BY ${messages.sentAt} DESC))[1]`,
  }).from(messages).where(and(scopeCond(scope), who)).groupBy(messages.platform, messages.platformUserId);
  return rows.map((r) => ({ platform: r.platform as Platform, userId: r.userId, count: Number(r.count), lastSeen: new Date(r.lastSeen), name: r.name, color: r.color || null }));
}

async function dbNicknamesMatching(pattern: string) {
  const rows = await db.select({ platform: nicknames.platform, login: nicknames.username }).from(nicknames)
    .where(sql`uc_fold(${nicknames.nickname}) LIKE uc_fold(${pattern})`).limit(30);
  return rows.map((r) => ({ platform: r.platform as Platform, login: r.login.toLowerCase() }));
}

async function dbNicknamesFor(keys: Array<{ platform: Platform; login: string }>) {
  if (!keys.length) return [];
  const rows = await db.select({ platform: nicknames.platform, login: nicknames.username, nickname: nicknames.nickname, color: nicknames.color }).from(nicknames)
    .where(or(...keys.map((k) => and(eq(nicknames.platform, k.platform), eq(nicknames.username, k.login))!))!);
  return rows.map((r) => ({ platform: r.platform as Platform, login: r.login.toLowerCase(), nickname: r.nickname, color: r.color }));
}

export const dbUserSearchDeps = (platformChannel: UserSearchDeps['platformChannel']): UserSearchDeps => ({
  platformChannel,
  candidates: dbCandidates,
  stats: dbStats,
  nicknamesMatching: dbNicknamesMatching,
  nicknamesFor: dbNicknamesFor,
});
