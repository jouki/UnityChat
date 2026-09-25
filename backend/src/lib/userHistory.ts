// „Profil“ uživatele z nabídky moda (2026-09-25, dřív „Chat historie“): detail uživatele pro moda
// aktuálního kanálu — propojené identity, poslední zpráva na každé platformě (badge), počty zpráv po
// kanálech (záložky), moderace v aktuálním kanálu, dona (Židolišta) a stránkované zprávy. Jádro bez HTTP
// a auth: ověření moda dělá VOLAJÍCÍ (routes/userHistory.ts, modGate) PŘED voláním čehokoli odsud.
//
// Zprávy uživatele = messages, kde (platform, platform_user_id) ∈ identity uživatele (index
// messages_platform_user_sent_idx, backend/sql/2026-09-25-user-history-index.sql). Kanál záložky
// = UC kanál (Twitch login streamera); Kick/YouTube kanál se na něj převádí registrem Židolišty,
// jinak adresářem streamers (ucChannelFor), jinak zůstává platformní kanál.
//
// Bezpečnost: cíl MUSÍ mít zprávu v archivu aktuálního kanálu (resolveUserTargets, stejně jako
// timeout/ban) — mod kanálu A si tak nevyhledá libovolné userId z celého archivu.
import { and, desc, eq, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { unionAll } from 'drizzle-orm/pg-core';
import { db } from '../db/index.js';
import { messages, moderationActions, nicknames, type Message } from '../db/schema.js';
import { encodeCursor, type decodeCursor } from './cursor.js';
import { toClientMessage, toClientContent, type ClientMessage } from '../routes/chat.js';
import { workspaceForChannel, zidolistaDonations, type Platform, type DonationItem } from './zidolista.js';
import { defaultWorkspace } from './platformChannels.js';
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
  /**
   * Otevření profilu jen podle loginu (citace v odpovědi): userId v archivu PLATFORMNÍHO kanálu aktuálního
   * kanálu, null = v kanálu nepsal → 404 (nejde tím procházet celý archiv).
   */
  userIdByLogin: (channel: string, platform: Platform, login: string) => Promise<string | null>;
  /**
   * Dona identit ve workspace kanálu `channel` (registr, nikdy od klienta); null = Židolišta nedostupná.
   * `public` = veřejný Profil: necachovaná volání Židolišty jdou přes globální strop (PUBLIC_DONATIONS_PER_MIN).
   */
  donations: (channel: string, ids: UserTarget[], opts?: { public?: boolean }) => Promise<DonationItem[] | null>;
}

const sameId = (a: UserTarget, b: UserTarget) => a.platform === b.platform && a.userId === b.userId;

/** Všechny identity člověka: cíl z archivu kanálu + všechny identity jeho UC účtu (i na platformách mimo kanál). */
export async function historyIdentities(targets: ResolvedTargets, deps: Pick<HistoryDeps, 'accountIdentities'>): Promise<UserTarget[]> {
  const out: UserTarget[] = targets.all.map((t) => ({ ...t }));
  if (targets.accountId !== null) {
    for (const i of await deps.accountIdentities(targets.accountId)) {
      const t = { platform: i.platform, userId: i.userId, login: i.login.toLowerCase(), displayName: i.displayName ?? null };
      const known = out.find((o) => sameId(o, t));
      if (known) { if (!known.displayName) known.displayName = t.displayName; } else out.push(t);
    }
  }
  return out;
}

// ---- Dona (Židolišta) ----
export interface MoneyTotal { czk: number; byCurrency: Record<string, number> }
export interface DonationTotals {
  total: MoneyTotal;
  count: number;
  /** Jistá dona z UnityChatu (matchedBy 'uc' — QR vytvořil tentýž divák v UC). */
  uc: { czk: number; count: number };
  /** Část spárovaná jen podle jména (matchedBy 'nickname') — odhad. */
  guess: MoneyTotal & { count: number };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Seznamy don po identitách → jeden seznam bez duplicit (stejné dono přes víc identit), od nejnovějšího. null = vše nedostupné. */
export function mergeDonations(lists: Array<DonationItem[] | null>): DonationItem[] | null {
  if (!lists.length || lists.every((l) => l === null)) return null;
  const byId = new Map<string, DonationItem>();
  for (const l of lists) for (const it of l ?? []) {
    const prev = byId.get(it.id);
    // Jistá shoda má přednost před odhadem podle jména (jedna identita ho spárovala přes UC).
    if (!prev || (prev.matchedBy === 'nickname' && it.matchedBy !== 'nickname')) byId.set(it.id, it);
  }
  return [...byId.values()].sort((a, b) => b.paidAt - a.paidAt);
}

/** Součty z položek: celkem v Kč, po měnách a zvlášť část „jen podle jména“. */
export function donationTotals(items: DonationItem[]): DonationTotals {
  const add = (t: MoneyTotal, it: DonationItem) => {
    t.czk = round2(t.czk + it.amountCzk);
    t.byCurrency[it.currency] = round2((t.byCurrency[it.currency] ?? 0) + it.amount);
  };
  const total: MoneyTotal = { czk: 0, byCurrency: {} };
  const uc = { czk: 0, count: 0 };
  const guess = { czk: 0, byCurrency: {} as Record<string, number>, count: 0 };
  for (const it of items) {
    add(total, it);
    if (it.matchedBy === 'uc') { uc.czk = round2(uc.czk + it.amountCzk); uc.count++; }
    if (it.matchedBy === 'nickname') { add(guess, it); guess.count++; }
  }
  return { total, count: items.length, uc, guess };
}

const normName = (s: unknown) => String(s ?? '').trim().replace(/^@/, '').toLowerCase();

/**
 * Veřejná suma („ucNamed“): jen jistá dona z UC (matchedBy 'uc'), u kterých se dárce neskrýval — přezdívka
 * dona = login (nebo zobrazované jméno) identity, na kterou divák klikl. Kdo donatoval pod jinou přezdívkou,
 * chtěl zůstat anonymní → do veřejné sumy se nepočítá.
 */
export function publicDonationSum(items: DonationItem[], names: Array<string | null | undefined>): { czk: number; count: number } {
  const want = new Set(names.map(normName).filter(Boolean));
  let czk = 0, count = 0;
  for (const it of items) {
    if (it.matchedBy !== 'uc' || !want.has(normName(it.nickname))) continue;
    czk = round2(czk + it.amountCzk); count++;
  }
  return { czk, count };
}

/** Poslední zpráva identity → jen to, co hlavička potřebuje na badge (žádný text — ani u smazané zprávy). */
export function latestView(row: Message): Pick<ClientMessage, 'platform' | 'id' | 'username' | 'userId' | 'timestamp' | 'color' | 'badgesRaw'> {
  const c = toClientContent(row, true);
  return { platform: c.platform, id: c.id, username: c.username, userId: c.userId, timestamp: c.timestamp, color: c.color ?? null, badgesRaw: c.badgesRaw ?? '' };
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

/**
 * `accountId` = účet moda (klíč cache záložek). Cíl = `userId`, nebo jen `login` (otevření z citace
 * v odpovědi — userId se dohledá v archivu aktuálního kanálu).
 */
export interface SummaryInput { accountId: number; channel: string; platform: Platform; userId: string | null; login?: string | null }

/** Cíl + identity + skupiny kanálů + mapování na záložky — to, co summary i každá stránka zpráv potřebují. */
export interface HistoryTabs { targets: ResolvedTargets; ids: UserTarget[]; groups: ChannelGroup[]; channels: HistoryChannel[]; byUc: Map<string, ChannelGroup[]> }

export const HISTORY_TABS_TTL_MS = 10_000;
const TABS_CACHE_MAX = 1000;

/**
 * Krátká cache záložek per (účet moda, kanál, cíl): scroll zpráv dělá stránku za stránkou a GROUP BY
 * přes všechny zprávy uživatele + převod kanálů by se jinak opakoval u každé. Summary ji vždy obnoví.
 */
export class HistoryTabsCache {
  private map = new Map<string, { at: number; value: HistoryTabs }>();
  constructor(private readonly ttlMs = HISTORY_TABS_TTL_MS, private readonly now: () => number = Date.now) {}
  static key(i: SummaryInput): string { return `${i.accountId}|${i.channel}|${i.platform}|${i.userId ?? `login:${String(i.login || '').toLowerCase()}`}`; }
  get(i: SummaryInput): HistoryTabs | null {
    const hit = this.map.get(HistoryTabsCache.key(i));
    if (!hit) return null;
    if (this.now() - hit.at > this.ttlMs) { this.map.delete(HistoryTabsCache.key(i)); return null; }
    return hit.value;
  }
  set(i: SummaryInput, value: HistoryTabs): void {
    if (this.map.size >= TABS_CACHE_MAX) this.map.clear();
    this.map.set(HistoryTabsCache.key(i), { at: this.now(), value });
  }
}

async function computeTabs(input: SummaryInput, deps: HistoryDeps): Promise<HistoryTabs | null> {
  let userId = input.userId;
  if (!userId) {
    const login = String(input.login || '').trim().replace(/^@/, '');
    if (!login) return null;
    userId = await deps.userIdByLogin(input.channel, input.platform, login);
    if (!userId) return null;
  }
  const targets = await deps.resolveTargets(input.channel, input.platform, userId);
  if (!targets) return null;
  const ids = await historyIdentities(targets, deps);
  const groups = await deps.channelGroups(ids);
  const { channels, byUc } = await mergeChannels(groups, input.channel, deps.ucChannelOf);
  return { targets, ids, groups, channels, byUc };
}

/** Záložky z cache (≤ 10 s), jinak spočítat a uložit; `fresh` = vždy spočítat (summary). */
export async function historyTabs(input: SummaryInput, deps: HistoryDeps, cache: HistoryTabsCache | null, { fresh = false } = {}): Promise<HistoryTabs | null> {
  const hit = !fresh && cache ? cache.get(input) : null;
  if (hit) return hit;
  const tabs = await computeTabs(input, deps);
  if (tabs && cache) cache.set(input, tabs);
  return tabs;
}

export async function buildSummary(input: SummaryInput, deps: HistoryDeps, cache: HistoryTabsCache | null = null): Promise<Out> {
  const tabs = await historyTabs(input, deps, cache, { fresh: true });
  if (!tabs) return { status: 404, body: { ok: false, error: 'not_found' } };
  const { targets, ids, groups, channels, byUc } = tabs;
  const [name, moderation, latest, donationItems] = await Promise.all([
    deps.latestName(targets.primary.platform, targets.primary.userId),
    deps.moderation(input.channel, ids, HISTORY_MODERATION_LIMIT),
    latestInChannel(ids, byUc.get(input.channel) ?? [], deps),
    deps.donations(input.channel, ids).catch(() => null),
  ]);
  let nick: { nickname: string; color: string | null } | null = null;
  for (const i of [targets.primary, ...ids]) { nick = await deps.nickname(i.platform, i.login); if (nick) break; }
  const all = groups.filter((g) => g.count > 0);
  const body: Record<string, unknown> = {
    ok: true,
    view: 'mod',
    user: {
      platform: targets.primary.platform,
      userId: targets.primary.userId,
      login: targets.primary.login,
      displayName: name || targets.primary.login,
      nickname: nick?.nickname ?? null,
      color: nick?.color ?? null,
      // Chip identity = zobrazované jméno (web_identities), u cíle bez účtu jméno z jeho poslední zprávy.
      identities: ids.map((i) => ({ platform: i.platform, login: i.login, userId: i.userId, displayName: i.displayName || (sameId(i, targets.primary) ? name : null) || null })),
      firstSeen: all.length ? Math.min(...all.map((g) => g.firstAt.getTime())) : null,
      lastSeen: all.length ? Math.max(...all.map((g) => g.lastAt.getTime())) : null,
      total: all.reduce((s, g) => s + g.count, 0),
    },
    channels,
    moderation,
    latest,
  };
  // Výpadek Židolišty / chybějící endpoint → pole chybí, panel sumu ani řádky neukáže.
  if (donationItems) body.donations = donationTotals(donationItems);
  return { status: 200, body };
}

/** Pole veřejného profilu (divák / nepřihlášený) — cokoli jiného se do odpovědi nedostane. */
export const PUBLIC_USER_FIELDS = ['platform', 'userId', 'login', 'displayName', 'nickname', 'color', 'firstSeen', 'lastSeen', 'total'] as const;

/**
 * Veřejný Profil (rozhodnutí usera 2026-09-25: levý klik na jméno otevře Profil všem). Divák vidí jen to,
 * co ví i z chatu: jméno, přezdívku, badge a statistiku **jen v aktuálním kanálu** a **jen za identitu, na
 * kterou klikl** (jiné identity by prozradily propojené účty), a sumu QR donů spárovaných jistě (`matchedBy: 'uc'`).
 * Žádné identity, záložky kanálů, moderace, zprávy, dona podle jména ani jednotlivá dona. Stejná ochrana
 * proti procházení archivu: cíl musí mít zprávu v archivu aktuálního kanálu, jinak 404.
 */
export async function buildPublicSummary(input: Omit<SummaryInput, 'accountId'>, deps: HistoryDeps): Promise<Out> {
  let userId = input.userId;
  if (!userId) {
    const login = String(input.login || '').trim().replace(/^@/, '');
    userId = login ? await deps.userIdByLogin(input.channel, input.platform, login) : null;
    if (!userId) return { status: 404, body: { ok: false, error: 'not_found' } };
  }
  const targets = await deps.resolveTargets(input.channel, input.platform, userId);
  if (!targets) return { status: 404, body: { ok: false, error: 'not_found' } };
  const primary = targets.primary;
  const { byUc } = await mergeChannels(await deps.channelGroups([primary]), input.channel, deps.ucChannelOf);
  const here = byUc.get(input.channel) ?? [];
  // Bez UC účtu nemůže mít dono spárované přes UC (matchedBy 'uc') → ucNamed je vždy 0, Židolišta se neptá.
  const ids = targets.accountId !== null ? await historyIdentities(targets, deps) : [];
  const [name, latest, nick, donationItems] = await Promise.all([
    deps.latestName(primary.platform, primary.userId),
    latestInChannel([primary], here, deps),
    deps.nickname(primary.platform, primary.login),
    ids.length ? deps.donations(input.channel, ids, { public: true }).catch(() => null) : Promise.resolve(null),
  ]);
  const user = {
    platform: primary.platform,
    userId: primary.userId,
    login: primary.login,
    displayName: name || primary.login,
    nickname: nick?.nickname ?? null,
    color: nick?.color ?? null,
    firstSeen: here.length ? Math.min(...here.map((g) => g.firstAt.getTime())) : null,
    lastSeen: here.length ? Math.max(...here.map((g) => g.lastAt.getTime())) : null,
    total: here.reduce((s, g) => s + g.count, 0),
  };
  const body: Record<string, unknown> = { ok: true, view: 'public', user, latest };
  // Divák dostane JEN ucNamed (žádné czk celkem, uc, odhady ani položky).
  if (donationItems) body.donations = { ucNamed: publicDonationSum(donationItems, [primary.login, name]) };
  return { status: 200, body };
}

/** Poslední zpráva každé identity v aktuálním kanálu → { twitch: {...}, kick: {...} } (badge do hlavičky). */
async function latestInChannel(ids: UserTarget[], groups: ChannelGroup[], deps: Pick<HistoryDeps, 'messagesPage'>): Promise<Record<string, ReturnType<typeof latestView>>> {
  const out: Record<string, ReturnType<typeof latestView>> = {};
  await Promise.all(ids.map(async (i) => {
    const channels = [...new Set(groups.filter((g) => g.platform === i.platform).map((g) => g.channel))];
    if (!channels.length || out[i.platform]) return;
    const [row] = await deps.messagesPage([{ platform: i.platform, userId: i.userId, channels }], null, 1);
    if (row && (!out[i.platform] || out[i.platform].timestamp < row.sentAt.getTime())) out[i.platform] = latestView(row);
  }));
  return out;
}

/**
 * Dona uživatele ve workspace aktuálního kanálu (řádky v Profilu). Stejné ověření cíle jako summary
 * (zpráva v archivu kanálu, jinak 404). `available: false` = Židolišta nedostupná → panel nic neukáže.
 */
export async function buildDonations(input: SummaryInput, deps: HistoryDeps, cache: HistoryTabsCache | null = null): Promise<Out> {
  const tabs = await historyTabs(input, deps, cache);
  if (!tabs) return { status: 404, body: { ok: false, error: 'not_found' } };
  const items = await deps.donations(input.channel, tabs.ids).catch(() => null);
  if (!items) return { status: 200, body: { ok: true, available: false, items: [] } };
  return {
    status: 200,
    body: {
      ok: true,
      available: true,
      items: items.map((it) => ({ id: it.id, amount: it.amount, currency: it.currency, amountCzk: it.amountCzk, paidAt: it.paidAt, via: it.via, matchedBy: it.matchedBy, nickname: it.nickname, message: it.message })),
    },
  };
}

export interface MessagesInput extends SummaryInput { inChannel: string; cursor: Cursor | null; limit: number }

/** Stránka zpráv v záložce `inChannel`: jako /chat/history — nejstarší → nejnovější, `nextBefore` = starší stránka. */
export async function buildMessages(input: MessagesInput, deps: HistoryDeps, cache: HistoryTabsCache | null = null): Promise<Out> {
  const tabs = await historyTabs(input, deps, cache);
  if (!tabs) return { status: 404, body: { ok: false, error: 'not_found' } };
  const { ids, byUc } = tabs;
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

/**
 * Víc identit = UNION ALL: každá identita má vlastní dotaz s LIMIT (index (platform, platform_user_id,
 * sent_at DESC) se projde jen o stránku), teprve výsledek se seřadí a ořízne. OR přes identity by
 * plánovač musel řadit všechny zprávy uživatele.
 */
async function dbMessagesPage(scope: Array<{ platform: Platform; userId: string; channels: string[] }>, cursor: Cursor | null, limit: number): Promise<Message[]> {
  const n = limit + 1;
  const one = (s: { platform: Platform; userId: string; channels: string[] }) => {
    const conds: SQL[] = [eq(messages.platform, s.platform), eq(messages.platformUserId, s.userId), inArray(messages.channel, s.channels)];
    if (cursor) {
      const at = new Date(cursor.sentAtMs);
      conds.push(or(lt(messages.sentAt, at), and(eq(messages.sentAt, at), lt(messages.id, cursor.id)))!);
    }
    return db.select().from(messages).where(and(...conds)).orderBy(desc(messages.sentAt), desc(messages.id)).limit(n);
  };
  if (!scope.length) return [];
  if (scope.length === 1) return one(scope[0]);
  const [a, b, ...rest] = scope.map(one);
  return unionAll(a, b, ...rest).orderBy(desc(messages.sentAt), desc(messages.id)).limit(n);
}

/** Globální strop necachovaných volání Židolišty z veřejného Profilu (limit Židolišty je 300/min na klíč). */
export const PUBLIC_DONATIONS_PER_MIN = 60;

/** Klouzavé okno: max `max` povolení za `windowMs` (celkem, ne per klient). */
export function makeWindowBudget(max: number, windowMs = 60_000, now: () => number = Date.now): () => boolean {
  const hits: number[] = [];
  return () => {
    const t = now();
    while (hits.length && t - hits[0] >= windowMs) hits.shift();
    if (hits.length >= max) return false;
    hits.push(t);
    return true;
  };
}

const publicDonationsBudget = makeWindowBudget(PUBLIC_DONATIONS_PER_MIN);

/** Dona identit: workspace JEN z registru podle kanálu (slug od klienta se nebere), dotaz per identita, dedup. */
export async function registryDonations(channel: string, ids: UserTarget[], log?: { warn: (o: object, m: string) => void }, allowFetch?: () => boolean): Promise<DonationItem[] | null> {
  const ws = await defaultWorkspace(channel).catch(() => null);
  if (!ws || !ids.length) return null;
  const lists = await Promise.all(ids.map((i) => zidolistaDonations({ workspace: ws.slug, platform: i.platform, userId: i.userId, login: i.login }, { log, allowFetch })));
  return mergeDonations(lists);
}

export const dbHistoryDeps = (
  resolveTargets: HistoryDeps['resolveTargets'],
  accountIdentities: HistoryDeps['accountIdentities'],
  userIdByLogin: HistoryDeps['userIdByLogin'],
  log?: { warn: (o: object, m: string) => void },
): HistoryDeps => ({
  resolveTargets,
  accountIdentities,
  channelGroups: dbChannelGroups,
  ucChannelOf: dbUcChannelOf,
  latestName: dbLatestName,
  nickname: dbNickname,
  moderation: dbModeration,
  messagesPage: dbMessagesPage,
  userIdByLogin,
  donations: (channel, ids, opts) => registryDonations(channel, ids, log, opts?.public ? publicDonationsBudget : undefined),
});
