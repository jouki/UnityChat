// Odměna „Posílání GIFů" (moderace část 4): má uživatel GIFy odemčené? Zdroj pravdy = Židolišta (typ akce
// v labelu, časovač, cooldown). Kontrakt (2026-09-25, session robjewsalot):
//   GET  <ZIDOLISTA_API_BASE>/integrations/:slug/gif-access?platform=&userId=&login=&role=
//        → { ok, serverNow, allowed, until|null, cooldownUntil|null, cooldownSec, requestTtlSec }
//   POST <ZIDOLISTA_API_BASE>/integrations/:slug/gif-used { platform, userId } → { ok, cooldownUntil }
//   Webhook POST /commands/invalidate { workspace, reason: "gif-access", data: { etag } } → cache workspace pryč.
// Cache 60 s per (workspace, platforma, uživatel, role). Čas Židolišty se převádí na lokální přes serverNow
// (posun hodin mezi servery nevadí). Chyba / chybějící klíč = odemčené není (zpráva je běžný odkaz).
import { config } from '../config.js';
import { zidolistaBase, type Platform } from './zidolista.js';

export type GifRole = 'broadcaster' | 'moderator' | 'vip' | 'sub' | 'viewer';

export interface GifAccessQuery {
  workspace: string;
  platform: Platform;
  userId: string;
  login: string;
  role: GifRole;
}

export interface GifAccess {
  allowed: boolean;
  /** Konec odemčení (lokální ms), null = bez konce / neodemčeno. */
  until: number | null;
  /** Konec cooldownu (lokální ms), null = bez cooldownu. */
  cooldownUntil: number | null;
  cooldownSec: number;
  /** Jak dlouho čeká žádost na schválení (s), výchozí 300. */
  requestTtlSec: number;
}

export const DEFAULT_REQUEST_TTL_SEC = 300;
const CACHE_MS = 60_000;

const toMs = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
};

/** Odpověď Židolišty → GifAccess (lokální čas: posun o serverNow). Čistá funkce. */
export function normalizeGifAccess(raw: unknown, localNow: number): GifAccess {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const serverNow = toMs(r.serverNow) ?? localNow;
  const shift = (v: unknown): number | null => { const t = toMs(v); return t === null ? null : t - serverNow + localNow; };
  const ttl = Number(r.requestTtlSec);
  const cd = Number(r.cooldownSec);
  return {
    allowed: r.allowed === true,
    until: shift(r.until),
    cooldownUntil: shift(r.cooldownUntil),
    cooldownSec: Number.isFinite(cd) && cd >= 0 ? Math.min(cd, 86_400) : 0,
    requestTtlSec: Number.isFinite(ttl) && ttl >= 30 ? Math.min(ttl, 3600) : DEFAULT_REQUEST_TTL_SEC,
  };
}

/** Smí teď poslat GIF? (odemčeno, nevypršelo, není v cooldownu) */
export function gifUsable(a: GifAccess | null | undefined, now: number): boolean {
  return !!a && a.allowed && (a.until === null || a.until > now) && !(a.cooldownUntil !== null && a.cooldownUntil > now);
}

interface Entry { at: number; value: GifAccess | null; inflight: Promise<GifAccess | null> | null }
const cache = new Map<string, Entry>();
const keyOf = (q: GifAccessQuery): string => `${q.workspace.toLowerCase()}|${q.platform}|${q.userId || `login:${q.login.toLowerCase()}`}|${q.role}`;

type Log = { warn: (o: object, m: string) => void };
export interface GifAccessDeps { fetch?: typeof fetch; apiKey?: string; base?: string; now?: () => number; log?: Log; sleep?: (ms: number) => Promise<void> }

/**
 * Lokální cooldown (uživatel bez role): od schválení GIFu, dokud Židolišta `gif-used` nepotvrdí (a když ho
 * nepotvrdí vůbec, po dobu cooldownSec). Jinak by mezi schválením a odpovědí Židolišty prošel další GIF.
 */
const localCooldown = new Map<string, number>();
const userPrefix = (workspace: string, platform: string, userId: string) => `${workspace.toLowerCase()}|${platform}|${userId}|`;
const DEFAULT_COOLDOWN_SEC = 60;

function localUntil(q: GifAccessQuery, now: number): number | null {
  const k = userPrefix(q.workspace, q.platform, q.userId);
  const u = localCooldown.get(k);
  if (u === undefined) return null;
  if (u <= now) { localCooldown.delete(k); return null; }
  return u;
}

function applyLocal(q: GifAccessQuery, a: GifAccess | null, now: number): GifAccess | null {
  const u = localUntil(q, now);
  if (!a || u === null) return a;
  return { ...a, cooldownUntil: Math.max(a.cooldownUntil ?? 0, u) };
}

/** Načte stav odemčení (cache 60 s); chyba → null (= neodemčeno). Lokální cooldown má přednost. */
export async function gifAccess(q: GifAccessQuery, deps: GifAccessDeps = {}): Promise<GifAccess | null> {
  return applyLocal(q, await fetchAccess(q, deps), (deps.now ?? Date.now)());
}

async function fetchAccess(q: GifAccessQuery, deps: GifAccessDeps): Promise<GifAccess | null> {
  const now = deps.now ?? Date.now;
  const k = keyOf(q);
  const hit = cache.get(k);
  if (hit?.inflight) return hit.inflight;
  if (hit && now() - hit.at < CACHE_MS) return hit.value;
  const apiKey = deps.apiKey ?? config.ZIDOLISTA_API_KEY;
  if (!apiKey) return null;
  const entry: Entry = hit ?? { at: 0, value: null, inflight: null };
  cache.set(k, entry);
  const f = deps.fetch ?? fetch;
  entry.inflight = (async () => {
    try {
      const qs = new URLSearchParams({ platform: q.platform, userId: q.userId, login: q.login.toLowerCase(), role: q.role });
      const r = await f(`${(deps.base ?? zidolistaBase()).replace(/\/$/, '')}/integrations/${encodeURIComponent(q.workspace.toLowerCase())}/gif-access?${qs}`, {
        headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { ok?: boolean };
      if (!j || j.ok === false) throw new Error('not ok');
      entry.value = normalizeGifAccess(j, now());
    } catch (e) {
      deps.log?.warn({ workspace: q.workspace, platform: q.platform, err: (e as Error).message }, 'gif: gif-access selhalo (bere se jako neodemčené)');
      entry.value = null;
    } finally {
      entry.at = now();
      entry.inflight = null;
    }
    return entry.value;
  })();
  return entry.inflight;
}

/**
 * Synchronně z cache (ingest onLive): 'allowed' | 'denied' | 'unknown'. Neznámé nebo prošlé spustí načtení
 * na pozadí; prošlá hodnota se ještě použije (změnu v Židolištce hlásí webhook, který cache maže).
 */
export function gifAccessSync(q: GifAccessQuery, deps: GifAccessDeps = {}): 'allowed' | 'denied' | 'unknown' {
  const now = (deps.now ?? Date.now)();
  const hit = cache.get(keyOf(q));
  if (!hit || (!hit.inflight && now - hit.at >= CACHE_MS)) void gifAccess(q, deps).catch(() => {});
  if (localUntil(q, now) !== null) return 'denied';
  if (!hit || (hit.inflight && hit.at === 0)) return 'unknown';
  return gifUsable(hit.value, now) ? 'allowed' : 'denied';
}

export const GIF_USED_RETRY_MS = 2000;

/**
 * Po schválení GIFu: Židolišta zapne cooldown. Hned (synchronně) lokální cooldown podle cooldownSec z cache
 * (výchozí 60 s), pak `gif-used`; selhání = jeden opakovaný pokus po 2 s. Potvrzení Židolišty lokální
 * cooldown nahradí jejím; bez potvrzení platí lokální do vypršení. Vrací potvrzený konec cooldownu nebo null.
 */
export async function gifUsed(p: { workspace: string; platform: Platform; userId: string }, deps: GifAccessDeps = {}): Promise<number | null> {
  const now = deps.now ?? Date.now;
  const apiKey = deps.apiKey ?? config.ZIDOLISTA_API_KEY;
  const prefix = userPrefix(p.workspace, p.platform, p.userId);
  let cdSec = 0;
  for (const [k, e] of cache) if (k.startsWith(prefix) && e.value) cdSec = Math.max(cdSec, e.value.cooldownSec);
  localCooldown.set(prefix, now() + (cdSec || DEFAULT_COOLDOWN_SEC) * 1000);
  if (localCooldown.size > 5000) for (const [k, u] of localCooldown) if (u <= now()) localCooldown.delete(k);
  let until: number | null = null;
  let confirmed = false;
  for (let attempt = 0; apiKey && attempt < 2 && !confirmed; attempt++) {
    if (attempt) await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(GIF_USED_RETRY_MS);
    try {
      const r = await (deps.fetch ?? fetch)(`${(deps.base ?? zidolistaBase()).replace(/\/$/, '')}/integrations/${encodeURIComponent(p.workspace.toLowerCase())}/gif-used`, {
        method: 'POST',
        headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ platform: p.platform, userId: p.userId }),
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { cooldownUntil?: unknown; serverNow?: unknown };
      const cd = toMs(j?.cooldownUntil);
      const sn = toMs(j?.serverNow);
      until = cd === null ? null : cd - (sn ?? now()) + now();
      confirmed = true;
    } catch (e) {
      deps.log?.warn({ workspace: p.workspace, platform: p.platform, attempt: attempt + 1, err: (e as Error).message }, 'gif: gif-used selhalo');
    }
  }
  if (!confirmed) return null; // lokální cooldown zůstává do vypršení
  localCooldown.delete(prefix);
  // Potvrzeno: cooldown Židolišty do cache všech rolí uživatele; bez cooldownu cache zahodit (načte se znovu).
  for (const [k, e] of cache) {
    if (!k.startsWith(prefix)) continue;
    if (until !== null && e.value) e.value = { ...e.value, cooldownUntil: until };
    else cache.delete(k);
  }
  return until;
}

/** Webhook `reason: "gif-access"` → zahodit cache workspace (další zpráva načte znovu). Vrací počet zahozených. */
export function invalidateGifAccess(workspace: string): number {
  const prefix = `${workspace.toLowerCase()}|`;
  let n = 0;
  for (const k of cache.keys()) if (k.startsWith(prefix)) { cache.delete(k); n++; }
  return n;
}

/** Jen pro testy. */
export function _resetGifAccessCache(): void { cache.clear(); localCooldown.clear(); }
