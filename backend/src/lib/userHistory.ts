// „Chat historie“ z nabídky moda (2026-09-25): detail uživatele pro moda aktuálního kanálu —
// propojené identity, počty zpráv po kanálech (záložky), moderace v aktuálním kanálu a stránkované
// zprávy. Jádro bez HTTP a auth: ověření moda dělá VOLAJÍCÍ (routes/moderation.ts, modGate).
//
// Zprávy uživatele = messages, kde (platform, platform_user_id) ∈ identity uživatele (index
// messages_platform_user_sent_idx, backend/sql/2026-09-25-user-history-index.sql). Kanál záložky
// = UC kanál (Twitch login streamera); Kick/YouTube kanál se na něj převádí registrem Židolišty,
// jinak adresářem streamers (ucChannelFor), jinak zůstává platformní kanál.
//
// Bezpečnost: cíl MUSÍ mít zprávu v archivu aktuálního kanálu (resolveUserTargets, stejně jako
// timeout/ban) — mod kanálu A si tak nevyhledá libovolné userId z celého archivu.
import { and, desc, eq, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/index.js';
import { messages, moderationActions, nicknames, type Message } from '../db/schema.js';
import { encodeCursor, type decodeCursor } from './cursor.js';
import { toClientMessage, type ClientMessage } from '../routes/chat.js';
import { workspaceForChannel, type Platform } from './zidolista.js';
import { ucChannelFor } from './ucChannel.js';
import type { ResolvedTargets, UserTarget } from './moderationTargets.js';
import type { Out } from './userModActions.js';

export const HISTORY_PAGE_DEFAULT = 50;
export const HISTORY_PAGE_MAX = 100;
export const HISTORY_MODERATION_LIMIT = 20;
/** Akce z moderation_actions, které se týkají uživatele (delete nese jen id zprávy). */
export const HISTORY_MOD_ACTIONS = ['timeout', 'ban', 'unban', 'warn', 'permit', 'rename'] as const;

type Cursor = NonNullable<ReturnType<typeof decodeCursor>>;

/** Počty zpráv jedné identity v jednom platformním kanálu (messages.channel přesně). */
export interface ChannelGroup { platform: Platform; channel: string; count: number; firstAt: Date; lastAt: Date }
export interface HistoryChannel { channel: string; count: number; firstAt: number | null; lastAt: number | null }
export interface HistoryModItem { action: string; at: number; by: string; platform: string; params: { durationSec?: number | null; reason?: string | null; nickname?: string | null } }

export interface HistoryDeps {
  resolveTargets: (channel: string, platform: Platform, userId: string) => Promise<ResolvedTargets | null>;
  accountIdentities: (accountId: number) => Promise<UserTarget[]>;
  /** GROUP BY (platform, channel) přes všechny identity. */
  channelGroups: (ids: UserTarget[]) => Promise<ChannelGroup[]>;
  /** Platformní kanál → UC kanál (záložka). */
  ucChannelOf: (platform: Platform, platformChannel: string) => Promise<string>;
  /** Zobrazované jméno z poslední zprávy identity. */
  latestName: (platform: Platform, userId: string) => Promise<string | null>;
  nickname: (platform: Platform, login: string) => Promise<{ nickname: string; color: string | null } | null>;
  moderation: (channel: string, ids: UserTarget[], limit: number) => Promise<HistoryModItem[]>;
  /** Zprávy identit v daných platformních kanálech, od nejnovější, limit+1 řádků. */
  messagesPage: (scope: Array<{ platform: Platform; userId: string; channels: string[] }>, cursor: Cursor | null, limit: number) => Promise<Message[]>;
}

const sameId = (a: UserTarget, b: UserTarget) => a.platform === b.platform && a.userId === b.userId;

/** Všechny identity člověka: cíl z archivu kanálu + všechny identity jeho UC účtu (i na platformách mimo kanál). */
export async function historyIdentities(targets: ResolvedTargets, deps: Pick<HistoryDeps, 'accountIdentities'>): Promise<UserTarget[]> {
  const out: UserTarget[] = [...targets.all];
  if (targets.accountId !== null) {
    for (const i of await deps.accountIdentities(targets.accountId)) {
      const t = { platform: i.platform, userId: i.userId, login: i.login.toLowerCase() };
      if (!out.some((o) => sameId(o, t))) out.push(t);
    }
  }
  return out;
}

/** Skupiny (platforma, kanál) → záložky podle UC kanálu. Aktuální kanál vždy první (i s 0), ostatní jen s count>0, od posledně aktivního. */
export async function mergeChannels(groups: ChannelGroup[], current: string, ucChannelOf: HistoryDeps['ucChannelOf']): Promise<{ channels: HistoryChannel[]; byUc: Map<string, ChannelGroup[]> }> {
  const byUc = new Map<string, ChannelGroup[]>();
  for (const g of groups) {
    if (g.count <= 0) continue;
    const uc = (await ucChannelOf(g.platform, g.channel)).toLowerCase();
    byUc.set(uc, [...(byUc.get(uc) ?? []), g]);
  }
  const tab = (channel: string, list: ChannelGroup[]): HistoryChannel => ({
    channel,
    count: list.reduce((s, g) => s + g.count, 0),
    firstAt: list.length ? Math.min(...list.map((g) => g.firstAt.getTime())) : null,
    lastAt: list.length ? Math.max(...list.map((g) => g.lastAt.getTime())) : null,
  });
  const others = [...byUc.entries()].filter(([c]) => c !== current).map(([c, l]) => tab(c, l))
    .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
  return { channels: [tab(current, byUc.get(current) ?? []), ...others], byUc };
}

export interface SummaryInput { channel: string; platform: Platform; userId: string }

export async function buildSummary(input: SummaryInput, deps: HistoryDeps): Promise<Out> {
  const targets = await deps.resolveTargets(input.channel, input.platform, input.userId);
  if (!targets) return { status: 404, body: { ok: false, error: 'not_found' } };
  const ids = await historyIdentities(targets, deps);
  const [groups, name, moderation] = await Promise.all([
    deps.channelGroups(ids),
    deps.latestName(targets.primary.platform, targets.primary.userId),
    deps.moderation(input.channel, ids, HISTORY_MODERATION_LIMIT),
  ]);
  let nick: { nickname: string; color: string | null } | null = null;
  for (const i of [targets.primary, ...ids]) { nick = await deps.nickname(i.platform, i.login); if (nick) break; }
  const { channels } = await mergeChannels(groups, input.channel, deps.ucChannelOf);
  const all = groups.filter((g) => g.count > 0);
  return {
    status: 200,
    body: {
      ok: true,
      user: {
        platform: targets.primary.platform,
        userId: targets.primary.userId,
        login: targets.primary.login,
        displayName: name || targets.primary.login,
        nickname: nick?.nickname ?? null,
        color: nick?.color ?? null,
        identities: ids.map((i) => ({ platform: i.platform, login: i.login, userId: i.userId })),
        firstSeen: all.length ? Math.min(...all.map((g) => g.firstAt.getTime())) : null,
        lastSeen: all.length ? Math.max(...all.map((g) => g.lastAt.getTime())) : null,
        total: all.reduce((s, g) => s + g.count, 0),
      },
      channels,
      moderation,
    },
  };
}

export interface MessagesInput extends SummaryInput { inChannel: string; cursor: Cursor | null; limit: number }

/** Stránka zpráv v záložce `inChannel`: jako /chat/history — nejstarší → nejnovější, `nextBefore` = starší stránka. */
export async function buildMessages(input: MessagesInput, deps: HistoryDeps): Promise<Out> {
  const targets = await deps.resolveTargets(input.channel, input.platform, input.userId);
  if (!targets) return { status: 404, body: { ok: false, error: 'not_found' } };
  const ids = await historyIdentities(targets, deps);
  const { byUc } = await mergeChannels(await deps.channelGroups(ids), input.channel, deps.ucChannelOf);
  const groups = byUc.get(input.inChannel) ?? [];
  const scope = ids
    .map((i) => ({ platform: i.platform, userId: i.userId, channels: [...new Set(groups.filter((g) => g.platform === i.platform).map((g) => g.channel))] }))
    .filter((s) => s.channels.length > 0);
  if (!scope.length) return { status: 200, body: { ok: true, messages: [] as ClientMessage[], nextBefore: null } };
  const rows = await deps.messagesPage(scope, input.cursor, input.limit);
  const page = rows.slice(0, input.limit);
  const oldest = page[page.length - 1];
  return {
    status: 200,
    body: {
      ok: true,
      messages: page.reverse().map((r) => toClientMessage(r)),
      nextBefore: rows.length > input.limit && oldest ? encodeCursor(oldest.sentAt.getTime(), oldest.id) : null,
    },
  };
}

/** limit z query: celé číslo 1–100, jinak výchozích 50. */
export function clampHistoryLimit(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? Math.min(n, HISTORY_PAGE_MAX) : HISTORY_PAGE_DEFAULT;
}

/** moderation_actions → položka panelu (jen délka, důvod, přezdívka — žádné interní výsledky platforem). */
export function toModItem(r: { action: string; createdAt: Date; actor: string; platform: string; params: unknown }): HistoryModItem {
  const p = (r.params && typeof r.params === 'object' ? r.params : {}) as Record<string, unknown>;
  const params: HistoryModItem['params'] = {};
  if (typeof p.durationSec === 'number') params.durationSec = p.durationSec;
  if (typeof p.reason === 'string' && p.reason) params.reason = p.reason;
  if (r.action === 'rename') params.nickname = typeof p.nickname === 'string' ? p.nickname : null;
  return { action: r.action, at: r.createdAt.getTime(), by: r.actor, platform: r.platform, params };
}

// ---- DB implementace ----
const identityCond = (ids: UserTarget[]): SQL =>
  or(...ids.map((i) => and(eq(messages.platform, i.platform), eq(messages.platformUserId, i.userId))!))!;

async function dbChannelGroups(ids: UserTarget[]): Promise<ChannelGroup[]> {
  if (!ids.length) return [];
  const rows = await db.select({
    platform: messages.platform, channel: messages.channel,
    count: sql<number>`count(*)::int`, firstAt: sql<Date>`min(${messages.sentAt})`, lastAt: sql<Date>`max(${messages.sentAt})`,
  }).from(messages).where(identityCond(ids)).groupBy(messages.platform, messages.channel);
  return rows.map((r) => ({ platform: r.platform as Platform, channel: r.channel, count: Number(r.count), firstAt: new Date(r.firstAt), lastAt: new Date(r.lastAt) }));
}

/** Platformní kanál → UC kanál: Twitch = týž; Kick/YouTube registr Židolišty (Twitch kanál workspace), jinak adresář streamers. */
export async function dbUcChannelOf(platform: Platform, platformChannel: string): Promise<string> {
  const norm = platformChannel.trim().toLowerCase().replace(/^@/, '');
  if (platform === 'twitch') return norm;
  const ws = await workspaceForChannel(platform, norm).catch(() => null);
  if (ws?.channels.twitch) return ws.channels.twitch;
  return ucChannelFor(platform, norm);
}

async function dbLatestName(platform: Platform, userId: string): Promise<string | null> {
  const rows = await db.select({ name: messages.platformUsername }).from(messages)
    .where(and(eq(messages.platform, platform), eq(messages.platformUserId, userId)))
    .orderBy(desc(messages.sentAt)).limit(1);
  return rows[0]?.name ?? null;
}

async function dbNickname(platform: Platform, login: string) {
  const rows = await db.select({ nickname: nicknames.nickname, color: nicknames.color }).from(nicknames)
    .where(and(eq(nicknames.platform, platform), eq(nicknames.username, login.toLowerCase()))).limit(1);
  return rows[0] ?? null;
}

async function dbModeration(channel: string, ids: UserTarget[], limit: number): Promise<HistoryModItem[]> {
  if (!ids.length) return [];
  // params.userId = identita, na kterou mod klikl (platforma akce); params.targets = všechny zasažené identity.
  const who = or(...ids.flatMap((i) => [
    and(eq(moderationActions.platform, i.platform), sql`${moderationActions.params}->>'userId' = ${i.userId}`)!,
    sql`${moderationActions.params}->'targets' @> ${JSON.stringify([{ platform: i.platform, userId: i.userId }])}::jsonb`,
  ]))!;
  const rows = await db.select({
    action: moderationActions.action, createdAt: moderationActions.createdAt, actor: moderationActions.actor,
    platform: moderationActions.platform, params: moderationActions.params,
  }).from(moderationActions)
    .where(and(eq(moderationActions.channel, channel), inArray(moderationActions.action, [...HISTORY_MOD_ACTIONS]), who))
    .orderBy(desc(moderationActions.createdAt)).limit(limit);
  return rows.map(toModItem);
}

async function dbMessagesPage(scope: Array<{ platform: Platform; userId: string; channels: string[] }>, cursor: Cursor | null, limit: number): Promise<Message[]> {
  const conds: SQL[] = [or(...scope.map((s) => and(eq(messages.platform, s.platform), eq(messages.platformUserId, s.userId), inArray(messages.channel, s.channels))!))!];
  if (cursor) {
    const at = new Date(cursor.sentAtMs);
    conds.push(or(lt(messages.sentAt, at), and(eq(messages.sentAt, at), lt(messages.id, cursor.id)))!);
  }
  return db.select().from(messages).where(and(...conds)).orderBy(desc(messages.sentAt), desc(messages.id)).limit(limit + 1);
}

export const dbHistoryDeps = (resolveTargets: HistoryDeps['resolveTargets'], accountIdentities: HistoryDeps['accountIdentities']): HistoryDeps => ({
  resolveTargets,
  accountIdentities,
  channelGroups: dbChannelGroups,
  ucChannelOf: dbUcChannelOf,
  latestName: dbLatestName,
  nickname: dbNickname,
  moderation: dbModeration,
  messagesPage: dbMessagesPage,
});
