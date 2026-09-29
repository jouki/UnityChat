// Registr workspaců Židolišty (RobJewsALot server): jediný zdroj pravdy pro
// mapování workspace ↔ kanály platforem + nastavení bota. Čte se z
// `GET <ZIDOLISTA_API_BASE>/integrations/workspaces` (X-Api-Key), cache 60 s,
// při výpadku poslední známý stav; když Židolišta nikdy neodpověděla, platí
// env `ZIDOLISTA_WORKSPACES` ("robdiesalot=rob,…", jen Twitch). Změna v
// Židolištce → webhook `POST /commands/invalidate` s `reason: "workspaces"`.
//
// Stream pro integraci (sse/integrationStream.ts) potřebuje mapování synchronně
// (volá se z ingest onLive), proto `workspaceForChannelSync` čte jen cache,
// kterou drží čerstvou `startWorkspaceRefresh()` ze serveru.
import { createHmac } from 'node:crypto';
import { config } from '../config.js';
import { signV2Headers } from './signatureV2.js';

// ---- Volání UnityChat → Židolišta: jediná cesta = zidolistaFetch ----
// Podpis v2 (docs/superpowers/plans/2026-09-26-podpis-v2-kontrakt.md, lib/signatureV2.ts): když je nastavený
// UC_TO_ZIDOLISTA_SIGNING_KEY, jde podepsané KAŽDÉ volání (METHOD + cesta?query přesně jak odchází, vč. prefixu
// z ZIDOLISTA_API_BASE + t + nonce + sha256 těla). Bez klíče zůstává dosavadní v1 jen u /donations:
//   X-UC-Signature: t=<unix s>,v1=<hex HMAC-SHA256(ZIDOLISTA_API_KEY, t + "." + "GET /cesta?query")>
// Přesměrování se NEsleduje (redirect: 'manual', 3xx kromě 304 = chyba) — X-Api-Key ani podpis nesmí odejít na jiný host.

/** Hodnota hlavičky X-UC-Signature v1 nad libovolným podepisovaným řetězcem. */
export function zidolistaSignature(key: string, signed: string, nowS = Math.floor(Date.now() / 1000)): string {
  return `t=${nowS},v1=${createHmac('sha256', key).update(`${nowS}.${signed}`).digest('hex')}`;
}

/** Cesta+query přesně tak, jak fetch pošle (bez schématu a hostu, s prefixem z base). */
export function pathAndQueryOf(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

/** Podepisovaný řetězec v1 GET požadavku: "GET /cesta?query" z plné URL. */
export function signedGetPath(url: string): string {
  return `GET ${pathAndQueryOf(url)}`;
}

export interface ZidolistaInit {
  method?: string;
  /** Doplňkové hlavičky (If-None-Match, X-UC-Client-Ip, Content-Type…); X-Api-Key a podpis doplní helper. */
  headers?: Record<string, string>;
  /** Tělo jako řetězec — podepisují se přesně tyhle bajty (UTF-8). */
  body?: string;
  signal?: AbortSignal;
  /** Bez v2 klíče podepsat v1 (dosavadní chování /donations). */
  legacyV1?: boolean;
}
export interface ZidolistaFetchDeps {
  fetch?: typeof fetch;
  apiKey?: string;
  /** Podpisový klíč v2 (hex); výchozí config.UC_TO_ZIDOLISTA_SIGNING_KEY, '' = bez v2. */
  signingKey?: string;
  /** Čas podpisu (unix s) — testy. */
  nowS?: number;
  /** Nonce — testy. */
  nonce?: string;
}

/** Přesměrování od Židolišty se nesleduje (3xx kromě 304 Not Modified). */
export class ZidolistaRedirectError extends Error {
  constructor(public status: number) { super(`zidolista redirect HTTP ${status} (nesleduje se)`); this.name = 'ZidolistaRedirectError'; }
}

/**
 * Jediný způsob, jak volat Židolištu: X-Api-Key + podpis (v2, jinak v1 u legacyV1) + bez sledování přesměrování.
 * Klíče se nikam nelogují a nejsou ani v chybách.
 */
export async function zidolistaFetch(url: string, init: ZidolistaInit = {}, deps: ZidolistaFetchDeps = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const apiKey = deps.apiKey ?? config.ZIDOLISTA_API_KEY;
  const signingKey = deps.signingKey ?? config.UC_TO_ZIDOLISTA_SIGNING_KEY;
  const path = pathAndQueryOf(url);
  const headers: Record<string, string> = { Accept: 'application/json', ...(init.headers ?? {}), 'X-Api-Key': apiKey };
  if (signingKey) Object.assign(headers, signV2Headers(signingKey, method, path, init.body ?? '', { nowS: deps.nowS, nonce: deps.nonce }));
  else if (init.legacyV1) headers['X-UC-Signature'] = zidolistaSignature(apiKey, `${method} ${path}`, deps.nowS);
  const r = await (deps.fetch ?? fetch)(url, { method, headers, body: init.body, signal: init.signal, redirect: 'manual' });
  if (r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400 && r.status !== 304)) {
    try { await r.body?.cancel(); } catch { /* tělo přesměrování nás nezajímá */ }
    throw new ZidolistaRedirectError(r.status);
  }
  return r;
}

export type Platform = 'twitch' | 'kick' | 'youtube';
export const PLATFORMS: Platform[] = ['twitch', 'kick', 'youtube'];

export interface WorkspaceInfo {
  slug: string;
  channels: Record<Platform, string | null>;
  bot: {
    mode: 'sb' | 'shared' | 'own';
    displayName: string;
    ownLogins?: Partial<Record<Platform, string>>;
  };
}

const CACHE_MS = 60_000;
/** Základ URL API Židolišty (bez koncového lomítka). */
export const zidolistaBase = (): string => config.ZIDOLISTA_API_BASE.replace(/\/$/, '');
let cache: { at: number; list: WorkspaceInfo[]; source: 'zidolista' | 'env' } | null = null;
let inflight: Promise<WorkspaceInfo[]> | null = null;
// Po každém úspěšném načtení registru (server si podle něj přidává kanály do ingestu).
let onWorkspacesCb: ((list: WorkspaceInfo[]) => void) | null = null;
export function onWorkspaces(cb: (list: WorkspaceInfo[]) => void): void { onWorkspacesCb = cb; if (cache) cb(cache.list); }

const normChannel = (v: unknown): string | null => {
  const s = String(v ?? '').trim().toLowerCase().replace(/^@/, '');
  return /^[a-z0-9_.-]{1,60}$/.test(s) ? s : null;
};

/** Čistý převod odpovědi Židolišty na WorkspaceInfo[] (testovatelné bez sítě). */
export function normalizeWorkspaces(raw: unknown): WorkspaceInfo[] {
  const list = (raw && typeof raw === 'object' && Array.isArray((raw as { workspaces?: unknown }).workspaces))
    ? ((raw as { workspaces: unknown[] }).workspaces)
    : Array.isArray(raw) ? raw : [];
  const out: WorkspaceInfo[] = [];
  for (const item of list as Array<Record<string, unknown>>) {
    const slug = String(item?.slug ?? '').trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,40}$/.test(slug)) continue;
    const ch = (item.channels && typeof item.channels === 'object' ? item.channels : {}) as Record<string, unknown>;
    const bot = (item.bot && typeof item.bot === 'object' ? item.bot : {}) as Record<string, unknown>;
    const mode = bot.mode === 'own' || bot.mode === 'shared' ? bot.mode : 'sb';
    const own = (bot.ownLogins && typeof bot.ownLogins === 'object' ? bot.ownLogins : {}) as Record<string, unknown>;
    const ownLogins: Partial<Record<Platform, string>> = {};
    for (const p of PLATFORMS) { const l = normChannel(own[p]); if (l) ownLogins[p] = l; }
    out.push({
      slug,
      channels: { twitch: normChannel(ch.twitch), kick: normChannel(ch.kick), youtube: normChannel(ch.youtube) },
      bot: { mode, displayName: String(bot.displayName ?? '').trim().slice(0, 40) || 'JoukiBOT', ...(Object.keys(ownLogins).length ? { ownLogins } : {}) },
    });
  }
  return out;
}

/** Fallback z env "kanál=slug,…" (jen Twitch, sdílený bot). */
export function workspacesFromEnv(csv: string): WorkspaceInfo[] {
  const bySlug = new Map<string, WorkspaceInfo>();
  for (const part of String(csv || '').split(',')) {
    const [ch, slug] = part.split('=').map((s) => s.trim().toLowerCase());
    if (!ch || !slug) continue;
    const ws = bySlug.get(slug) ?? { slug, channels: { twitch: null, kick: null, youtube: null }, bot: { mode: 'shared' as const, displayName: 'JoukiBOT' } };
    if (!ws.channels.twitch) ws.channels.twitch = ch;
    bySlug.set(slug, ws);
  }
  return [...bySlug.values()];
}

async function fetchWorkspaces(): Promise<WorkspaceInfo[]> {
  const r = await zidolistaFetch(`${zidolistaBase()}/integrations/workspaces`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`zidolista workspaces HTTP ${r.status}`);
  const j = (await r.json()) as { ok?: boolean };
  if (!j.ok) throw new Error('zidolista workspaces not ok');
  return normalizeWorkspaces(j);
}

/** Aktuální seznam: čerstvá cache, jinak fetch; při chybě poslední známý stav nebo env. */
export async function getWorkspaces(opts: { force?: boolean; log?: { warn: (o: object, m: string) => void } } = {}): Promise<WorkspaceInfo[]> {
  if (!opts.force && cache && Date.now() - cache.at < CACHE_MS) return cache.list;
  if (!config.ZIDOLISTA_API_KEY) return cache?.list ?? (cache = { at: Date.now(), list: workspacesFromEnv(config.ZIDOLISTA_WORKSPACES), source: 'env' }).list;
  if (!inflight) {
    inflight = fetchWorkspaces()
      .then((list) => { cache = { at: Date.now(), list, source: 'zidolista' }; try { onWorkspacesCb?.(list); } catch { /* hook nesmí shodit fetch */ } return list; })
      .catch((e) => {
        opts.log?.warn({ err: (e as Error).message }, 'zidolista workspaces: fetch failed');
        if (cache) { cache.at = Date.now(); return cache.list; }
        cache = { at: Date.now(), list: workspacesFromEnv(config.ZIDOLISTA_WORKSPACES), source: 'env' };
        return cache.list;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

export function invalidateWorkspaces(): void { if (cache) cache.at = 0; }
export function workspacesSource(): 'zidolista' | 'env' | 'none' { return cache?.source ?? 'none'; }

/** Synchronní varianta z cache (ingest onLive). */
export function workspaceForChannelSync(platform: Platform, channel: string): WorkspaceInfo | null {
  const c = channel.toLowerCase().replace(/^@/, '');
  return cache?.list.find((w) => w.channels[platform] === c) ?? null;
}

export async function workspaceForChannel(platform: Platform, channel: string): Promise<WorkspaceInfo | null> {
  await getWorkspaces();
  return workspaceForChannelSync(platform, channel);
}

export async function workspaceBySlug(slug: string): Promise<WorkspaceInfo | null> {
  const list = await getWorkspaces();
  const s = slug.toLowerCase();
  return list.find((w) => w.slug === s) ?? null;
}

/** Twitch kanály workspace (commandy/announcementy jsou per Twitch login kanálu). */
export async function twitchChannelsOf(slug: string): Promise<string[]> {
  const ws = await workspaceBySlug(slug);
  return ws?.channels.twitch ? [ws.channels.twitch] : [];
}

// ---- Dona diváka (Profil v nabídce moda, 2026-09-25) ----
// GET <ZIDOLISTA_API_BASE>/integrations/:slug/donations?platform=&userId=&login=&limit=1..200&before=<ISO>
//   → { ok, workspace, total: { czk, byCurrency }, count, items: [{ id, amount, currency, amountCzk, paidAt, via,
//       matchedBy: 'uc'|'nickname', nickname, message? }], nextBefore: ISO|null }
// Hlavičky X-Api-Key + X-UC-Signature (zidolistaFetch: v2, bez klíče v2 dosavadní v1); limit Židolišty 300/min na klíč → cache 60 s na identitu nutná.
// `total`/`count` jsou za všechna dona diváka, ale jistou a odhadnutou (matchedBy 'nickname') část nerozlišují
// a víc identit téhož člověka by se sečetlo dvakrát → UnityChat stáhne položky (max DONATIONS_MAX_PAGES stránek)
// a součty počítá sám po dedupu podle id (lib/userHistory.ts donationTotals).

export interface DonationItem {
  id: string;
  amount: number;
  currency: string;
  amountCzk: number;
  /** Čas platby (ms). */
  paidAt: number;
  via: string;
  /** 'uc' = jistá shoda (QR vytvořil tentýž divák v UC), 'nickname' = jen odhad podle jména. */
  matchedBy: string | null;
  nickname: string | null;
  message: string | null;
}

export const DONATIONS_PAGE = 200;
export const DONATIONS_MAX_PAGES = 5;
const DONATIONS_CACHE_MS = 60_000;

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v: unknown, max: number): string | null => { const s = typeof v === 'string' ? v.trim() : ''; return s ? s.slice(0, max) : null; };

/** Jedna stránka odpovědi Židolišty → položky + kurzor (čistá funkce). Položka bez id / času se zahodí. */
export function normalizeDonationsPage(raw: unknown): { items: DonationItem[]; nextBefore: string | null } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const items: DonationItem[] = [];
  for (const it of Array.isArray(r.items) ? (r.items as Array<Record<string, unknown>>) : []) {
    if (!it || typeof it !== 'object') continue;
    const id = it.id != null ? String(it.id).slice(0, 80) : '';
    const paidAt = Date.parse(String(it.paidAt ?? ''));
    if (!id || !Number.isFinite(paidAt)) continue;
    const currency = (str(it.currency, 8) || 'CZK').toUpperCase();
    items.push({
      id, paidAt, currency,
      amount: num(it.amount),
      amountCzk: it.amountCzk != null ? num(it.amountCzk) : currency === 'CZK' ? num(it.amount) : 0,
      via: str(it.via, 20) || 'qr',
      matchedBy: str(it.matchedBy, 20),
      nickname: str(it.nickname, 60),
      message: str(it.message, 500),
    });
  }
  const nb = typeof r.nextBefore === 'string' && Number.isFinite(Date.parse(r.nextBefore)) ? r.nextBefore : null;
  return { items, nextBefore: nb };
}

export interface DonationsQuery { workspace: string; platform: Platform; userId: string; login: string }
type WarnLog = { warn: (o: object, m: string) => void };
export interface DonationsDeps {
  fetch?: typeof fetch; apiKey?: string; base?: string; now?: () => number; /** Čas podpisu (unix s) — testy. */ nowS?: () => number; log?: WarnLog;
  /** Podpisový klíč v2 — testy (výchozí z configu). */
  signingKey?: string;
  /**
   * Strop necachovaných volání (veřejný Profil): zavolá se jen při skutečném dotazu na Židolištu (cache miss),
   * false = dotaz se neudělá a vrátí se null (nic se necachuje, další volání to zkusí znovu).
   */
  allowFetch?: () => boolean;
}

const donationsCache = new Map<string, { at: number; value: DonationItem[] | null; inflight: Promise<DonationItem[] | null> | null }>();

/**
 * Všechna dona jedné identity v workspace (cache 60 s — i prázdný seznam a chyba, ať se Židolišta při
 * výpadku nebo u diváků bez donů neptá pořád dokola). null = Židolišta nedostupná / endpoint chybí (404) /
 * bez klíče / vyčerpaný strop — volající pak dona vůbec neukazuje (žádná chyba).
 */
export async function zidolistaDonations(q: DonationsQuery, deps: DonationsDeps = {}): Promise<DonationItem[] | null> {
  const now = deps.now ?? Date.now;
  const key = `${q.workspace.toLowerCase()}|${q.platform}|${q.userId}|${q.login.toLowerCase()}`;
  const hit = donationsCache.get(key);
  if (hit?.inflight) return hit.inflight;
  if (hit && now() - hit.at < DONATIONS_CACHE_MS) return hit.value;
  const apiKey = deps.apiKey ?? config.ZIDOLISTA_API_KEY;
  if (!apiKey) return null;
  if (deps.allowFetch && !deps.allowFetch()) {
    deps.log?.warn({ workspace: q.workspace, platform: q.platform }, 'donations: veřejný strop volání Židolišty vyčerpán (bez sumy)');
    return null;
  }
  if (donationsCache.size > 2000) donationsCache.clear();
  const entry = hit ?? { at: 0, value: null, inflight: null };
  donationsCache.set(key, entry);
  const f = deps.fetch ?? fetch;
  const base = (deps.base ?? zidolistaBase()).replace(/\/$/, '');
  entry.inflight = (async () => {
    try {
      const all: DonationItem[] = [];
      let before: string | null = null;
      for (let page = 0; page < DONATIONS_MAX_PAGES; page++) {
        const qs = new URLSearchParams({ platform: q.platform, userId: q.userId, login: q.login.toLowerCase(), limit: String(DONATIONS_PAGE) });
        if (before) qs.set('before', before);
        const url = `${base}/integrations/${encodeURIComponent(q.workspace.toLowerCase())}/donations?${qs}`;
        const r = await zidolistaFetch(url, { signal: AbortSignal.timeout(5000), legacyV1: true }, { fetch: f, apiKey, signingKey: deps.signingKey, nowS: deps.nowS?.() });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { ok?: boolean };
        if (!j || j.ok === false) throw new Error('not ok');
        const p = normalizeDonationsPage(j);
        all.push(...p.items);
        before = p.nextBefore;
        if (!before) break;
        if (page === DONATIONS_MAX_PAGES - 1) deps.log?.warn({ workspace: q.workspace, platform: q.platform, n: all.length }, 'donations: víc stránek, než se stahuje (součet je jen z načtených)');
      }
      entry.value = all;
    } catch (e) {
      deps.log?.warn({ workspace: q.workspace, platform: q.platform, err: (e as Error).message }, 'donations: Židolišta nedostupná (dona se neukážou)');
      entry.value = null;
    } finally {
      entry.at = now();
      entry.inflight = null;
    }
    return entry.value;
  })();
  return entry.inflight;
}

/** Jen pro testy. */
export function _resetDonationsCache(): void { donationsCache.clear(); }

let refreshTimer: ReturnType<typeof setInterval> | null = null;
/** Držet cache čerstvou pro synchronní použití (server boot). */
export function startWorkspaceRefresh(log?: { warn: (o: object, m: string) => void }): void {
  void getWorkspaces({ log });
  if (refreshTimer) return;
  refreshTimer = setInterval(() => { void getWorkspaces({ log }); }, CACHE_MS);
  refreshTimer.unref?.();
}
export function stopWorkspaceRefresh(): void { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } }
