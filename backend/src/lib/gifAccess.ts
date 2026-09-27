// Odměna „Posílání GIFů" (moderace část 4): má uživatel GIFy odemčené? Zdroj pravdy = Židolišta (typ akce
// v labelu, časovač, cooldown). Kontrakt (2026-09-25, session robjewsalot):
//   GET  <ZIDOLISTA_API_BASE>/integrations/:slug/gif-access?platform=&userId=&login=&role=
//        → { ok, serverNow, allowed, until|null, cooldownUntil|null, cooldownSec, requestTtlSec, mode, cooldownGlobalSec }
//          (mode 'all'|'approved' a cooldownGlobalSec od 2026-09-26; cooldownUntil = pozdější z globálního a osobního)
//   POST <ZIDOLISTA_API_BASE>/integrations/:slug/gif-used { platform, userId, role } → { ok, cooldownUntil|null, cooldownSec, cooldownGlobalSec }
//        (cooldownUntil null = bez cooldownu). Výchozí cooldown UnityChat nemá — platí jen hodnoty Židolišty.
//   Webhook POST /commands/invalidate { workspace, reason: "gif-access", data: { etag } } → cache workspace pryč
//        + SSE `gif-access-change { channel }` (gifAccessChanged).
// Cache 60 s per (workspace, platforma, uživatel, role). Čas Židolišty se převádí na lokální přes serverNow
// (posun hodin mezi servery nevadí). Chyba / chybějící klíč = odemčené není (zpráva je běžný odkaz).
import { config } from '../config.js';
import { zidolistaBase, zidolistaFetch, type Platform } from './zidolista.js';

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
  /**
   * Režim odměny (GIF knihovna 2026-09-26): `all` = nové GIFy přes schvalování + knihovna, `approved` = jen
   * schválené (knihovna, známé duplikáty) — platí i pro mody. Chybí = `all`.
   */
  mode?: GifMode;
  /** Cooldown celého chatu (s) — jen pro zobrazení v /gif/state; `cooldownUntil` už je pozdější z obou. */
  cooldownGlobalSec?: number;
}

export type GifMode = 'all' | 'approved';

export const DEFAULT_REQUEST_TTL_SEC = 300;
const CACHE_MS = 60_000;
/** Chyba Židolišty (429, 5xx, timeout) se drží jen krátce — čerstvě aktivovaná odměna nesmí minutu vypadat jako neodemčená. */
export const ERROR_CACHE_MS = 5_000;

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
  const gcd = Number(r.cooldownGlobalSec);
  const allowed = r.allowed === true;
  return {
    allowed,
    until: shift(r.until),
    // Neodemčený: cooldown ze Židolišty je jen její výchozí hodnota pro roli bez oprávnění → ignorovat (bod 5 testu 2026-09-27).
    cooldownUntil: allowed ? shift(r.cooldownUntil) : null,
    cooldownSec: allowed && Number.isFinite(cd) && cd >= 0 ? Math.min(cd, 86_400) : 0,
    requestTtlSec: Number.isFinite(ttl) && ttl >= 30 ? Math.min(ttl, 3600) : DEFAULT_REQUEST_TTL_SEC,
    mode: r.mode === 'approved' ? 'approved' : 'all',
    cooldownGlobalSec: Number.isFinite(gcd) && gcd >= 0 ? Math.min(gcd, 86_400) : 0,
  };
}

/** Smí teď poslat GIF? (odemčeno, nevypršelo, není v cooldownu) */
export function gifUsable(a: GifAccess | null | undefined, now: number): boolean {
  return !!a && a.allowed && (a.until === null || a.until > now) && !(a.cooldownUntil !== null && a.cooldownUntil > now);
}

interface Entry { at: number; value: GifAccess | null; inflight: Promise<GifAccess | null> | null; err?: boolean }
const ttlOf = (e: Entry): number => (e.err ? ERROR_CACHE_MS : CACHE_MS);
/**
 * Poslední skutečně nastavené cooldownSec per (workspace, role) — jen z úspěšných odpovědí s `allowed: true`, mimo cache
 * přístupu (webhook ji zahodí). gifUsed ho použije, když cache záznam uživatele nemá. Není to výchozí hodnota:
 * neznámá role = žádný cooldown, 0 = žádný.
 */
const lastCooldownSec = new Map<string, number>();
const cache = new Map<string, Entry>();
const keyOf = (q: GifAccessQuery): string => `${q.workspace.toLowerCase()}|${q.platform}|${q.userId || `login:${q.login.toLowerCase()}`}|${q.role}`;

type Log = { warn: (o: object, m: string) => void };
export interface GifAccessDeps { fetch?: typeof fetch; apiKey?: string; base?: string; now?: () => number; log?: Log; sleep?: (ms: number) => Promise<void>; /** Podpisový klíč v2 — testy. */ signingKey?: string }

/**
 * Lokální cooldown (každý uživatel včetně modů, od 2026-09-27): od schválení GIFu, dokud Židolišta `gif-used`
 * nepotvrdí (a když ho nepotvrdí vůbec, po dobu cooldownSec). Jinak by mezi schválením a odpovědí Židolišty prošel další GIF.
 */
const localCooldown = new Map<string, number>();
const userPrefix = (workspace: string, platform: string, userId: string) => `${workspace.toLowerCase()}|${platform}|${userId}|`;

function localUntil(q: GifAccessQuery, now: number): number | null {
  const k = userPrefix(q.workspace, q.platform, q.userId);
  const u = localCooldown.get(k);
  if (u === undefined) return null;
  if (u <= now) { localCooldown.delete(k); return null; }
  return u;
}

/**
 * Globální cooldown chatu per workspace (audit SEC-8): po každém GIFu zobrazeném v chatu (schválení modem, auto,
 * okamžité schválení z knihovny) ho server nastaví sám podle `cooldownGlobalSec` ze Židolišty. Jinak by uživatelé
 * s „allowed“ v cache (60 s i déle) prošli, než Židolišta cache zneplatní. Mody bez výjimky.
 */
const globalCooldown = new Map<string, number>();
/**
 * Poslední známý `cooldownGlobalSec` workspace (z každé úspěšné odpovědi Židolišty). Drží se mimo cache přístupu:
 * webhook `gif-access` cache zahodí, a globální cooldown se tím nesmí obejít (review SEC-8).
 */
const lastGlobalSec = new Map<string, number>();

function globalSecFor(workspace: string): number {
  return lastGlobalSec.get(workspace.toLowerCase()) ?? 0;
}

function globalUntil(workspace: string, now: number): number | null {
  const k = workspace.toLowerCase();
  const u = globalCooldown.get(k);
  if (u === undefined) return null;
  if (u <= now) { globalCooldown.delete(k); return null; }
  return u;
}

function noteGlobal(workspace: string, now: number): void {
  const sec = globalSecFor(workspace);
  if (!sec) return;
  const k = workspace.toLowerCase();
  globalCooldown.set(k, Math.max(globalCooldown.get(k) ?? 0, now + sec * 1000));
  if (globalCooldown.size > 1000) for (const [w, u] of globalCooldown) if (u <= now) globalCooldown.delete(w);
}

/**
 * Okamžité zobrazení GIFu (auto / z knihovny) si globální cooldown zarezervuje synchronně: běží → null (GIF teď
 * neprojde), jinak ho hned nastaví (souběh dvou GIFů naráz, audit SEC-8) a vrátí uvolnění — volající ho zavolá,
 * když se GIF nakonec nezobrazí (odebráno z knihovny, zahozeno, chyba zápisu). Bez známého cooldownGlobalSec →
 * uvolnění, které nic nedělá.
 */
export function claimGifSlot(workspace: string, now: number = Date.now()): (() => void) | null {
  if (globalUntil(workspace, now) !== null) return null;
  const k = workspace.toLowerCase();
  const prev = globalCooldown.get(k);
  noteGlobal(workspace, now);
  const mine = globalCooldown.get(k);
  return () => {
    // Jen když ho mezitím nic nepřepsalo (gif-used jiného GIFu = skutečně zobrazený).
    if (mine === undefined || globalCooldown.get(k) !== mine) return;
    if (prev === undefined) globalCooldown.delete(k); else globalCooldown.set(k, prev);
  };
}

function applyLocal(q: GifAccessQuery, a: GifAccess | null, now: number): GifAccess | null {
  const u = Math.max(localUntil(q, now) ?? 0, globalUntil(q.workspace, now) ?? 0);
  if (!a || !u) return a;
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
  if (hit && now() - hit.at < ttlOf(hit)) return hit.value;
  const apiKey = deps.apiKey ?? config.ZIDOLISTA_API_KEY;
  if (!apiKey) return null;
  const entry: Entry = hit ?? { at: 0, value: null, inflight: null };
  cache.set(k, entry);
  const f = deps.fetch ?? fetch;
  entry.inflight = (async () => {
    try {
      const qs = new URLSearchParams({ platform: q.platform, userId: q.userId, login: q.login.toLowerCase(), role: q.role });
      const r = await zidolistaFetch(`${(deps.base ?? zidolistaBase()).replace(/\/$/, '')}/integrations/${encodeURIComponent(q.workspace.toLowerCase())}/gif-access?${qs}`,
        { signal: AbortSignal.timeout(5000) }, { fetch: f, apiKey, signingKey: deps.signingKey });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { ok?: boolean };
      if (!j || j.ok === false) throw new Error('not ok');
      entry.value = normalizeGifAccess(j, now());
      entry.err = false;
      if (entry.value.allowed) { lastCooldownSec.set(`${q.workspace.toLowerCase()}|${q.role}`, entry.value.cooldownSec); if (lastCooldownSec.size > 1000) lastCooldownSec.clear(); }
      // Globální cooldown jen z odpovědi odemčeného (u neodemčeného je to výchozí hodnota Židolišty, bod 5).
      if (entry.value.allowed) lastGlobalSec.set(q.workspace.toLowerCase(), entry.value.cooldownGlobalSec ?? 0);
      if (lastGlobalSec.size > 1000) lastGlobalSec.clear();
    } catch (e) {
      deps.log?.warn({ workspace: q.workspace, platform: q.platform, err: (e as Error).message }, 'gif: gif-access selhalo (bere se jako neodemčené)');
      entry.value = null;
      entry.err = true;
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
  if (!hit || (!hit.inflight && now - hit.at >= ttlOf(hit))) void gifAccess(q, deps).catch(() => {});
  if (localUntil(q, now) !== null) return 'denied';
  if (!hit || (hit.inflight && hit.at === 0)) return 'unknown';
  if (globalUntil(q.workspace, now) !== null) return 'denied';
  return gifUsable(hit.value, now) ? 'allowed' : 'denied';
}

/**
 * Synchronně z cache: konec cooldownu, kvůli kterému gifAccessSync vrací 'denied' (lokální po schválení, potvrzený
 * Židolištou, globální cooldown chatu); null = neodemčeno / bez cooldownu / neznámé. Filtr odkazů podle toho pošle
 * odesílateli hlášku (test2 bod 4.1). Nespouští načtení.
 */
export function gifCooldownUntilSync(q: GifAccessQuery, deps: Pick<GifAccessDeps, 'now'> = {}): number | null {
  const now = (deps.now ?? Date.now)();
  const hit = cache.get(keyOf(q));
  // Neodemčeno (Židolišta řekla ne) = důvod odmítnutí není cooldown.
  if (hit && hit.at !== 0 && !hit.value?.allowed) return null;
  if (hit?.value && hit.value.until !== null && hit.value.until <= now) return null;
  const u = Math.max(localUntil(q, now) ?? 0, globalUntil(q.workspace, now) ?? 0, hit?.value?.cooldownUntil ?? 0);
  return u > now ? u : null;
}

export const GIF_USED_RETRY_MS = 2000;

/**
 * Po schválení GIFu: Židolišta zapne cooldown. Hned (synchronně) lokální cooldown podle cooldownSec odemčeného
 * uživatele z cache, jinak podle posledního skutečně nastaveného cooldownSec jeho role (lastCooldownSec); neznámé
 * nebo 0 = žádný lokální cooldown (výchozí hodnota neexistuje). Pak `gif-used` s rolí; selhání = jeden opakovaný
 * pokus po 2 s. Potvrzení Židolišty lokální cooldown nahradí jejím (`cooldownUntil: null` = bez cooldownu); bez
 * potvrzení platí lokální do vypršení. Vrací potvrzený konec cooldownu nebo null.
 */
export async function gifUsed(p: { workspace: string; platform: Platform; userId: string; role?: GifRole }, deps: GifAccessDeps = {}): Promise<number | null> {
  const now = deps.now ?? Date.now;
  const apiKey = deps.apiKey ?? config.ZIDOLISTA_API_KEY;
  const prefix = userPrefix(p.workspace, p.platform, p.userId);
  // Lokální cooldown jen podle cooldownSec, které Židolišta skutečně nastavila odemčenému uživateli (bod 5 testu 2026-09-27):
  // žádná výchozí hodnota — neznámé (prázdná cache) ani 0 cooldown nezakládá. Známá role má přednost.
  const own = p.role ? cache.get(`${prefix}${p.role}`)?.value : null;
  let cdSec = own?.allowed ? own.cooldownSec : 0;
  let known = !!own?.allowed;
  if (!known) for (const [k, e] of cache) if (k.startsWith(prefix) && e.value?.allowed) { known = true; cdSec = Math.max(cdSec, e.value.cooldownSec); }
  // Cache bez záznamu (zahodil ji webhook) → poslední skutečně nastavené cooldownSec role; neznámé = žádný cooldown.
  if (!known && p.role) cdSec = lastCooldownSec.get(`${p.workspace.toLowerCase()}|${p.role}`) ?? 0;
  if (cdSec > 0) localCooldown.set(prefix, now() + cdSec * 1000);
  // GIF je v chatu → globální cooldown chatu hned i lokálně (audit SEC-8).
  noteGlobal(p.workspace, now());
  if (localCooldown.size > 5000) for (const [k, u] of localCooldown) if (u <= now()) localCooldown.delete(k);
  let until: number | null = null;
  let confirmed = false;
  for (let attempt = 0; apiKey && attempt < 2 && !confirmed; attempt++) {
    if (attempt) await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(GIF_USED_RETRY_MS);
    try {
      const r = await zidolistaFetch(`${(deps.base ?? zidolistaBase()).replace(/\/$/, '')}/integrations/${encodeURIComponent(p.workspace.toLowerCase())}/gif-used`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Role jako v gif-access (Židolišta jinak počítala cooldown pro viewer — po restartu nemá paměť).
        body: JSON.stringify({ platform: p.platform, userId: p.userId, ...(p.role ? { role: p.role } : {}) }),
        signal: AbortSignal.timeout(5000),
      }, { fetch: deps.fetch, apiKey, signingKey: deps.signingKey });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      // { ok, cooldownUntil | null, cooldownSec, cooldownGlobalSec }; cooldownUntil null = BEZ cooldownu (ne neznámo).
      const j = (await r.json()) as { cooldownUntil?: unknown; serverNow?: unknown; cooldownGlobalSec?: unknown };
      const cd = toMs(j?.cooldownUntil);
      const sn = toMs(j?.serverNow);
      until = cd === null ? null : cd - (sn ?? now()) + now();
      const gsec = j?.cooldownGlobalSec === undefined || j?.cooldownGlobalSec === null ? NaN : Number(j.cooldownGlobalSec);
      if (Number.isFinite(gsec) && gsec >= 0) {
        const w = p.workspace.toLowerCase();
        lastGlobalSec.set(w, Math.min(gsec, 86_400));
        // Židolišta hlásí globální cooldown 0 → žádný (lokálně nastavený z dřívější hodnoty pryč); jinak podle ní.
        if (gsec === 0) globalCooldown.delete(w); else noteGlobal(p.workspace, now());
      }
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

/**
 * Webhook `gif-access` (odemčení se v Židolištce změnilo): cache pryč + veřejné SSE `gif-access-change { channel }`
 * (bez osobních dat) pro každý kanál workspace — otevřené klienty si stav přenačtou sami (GET /gif/state,
 * rozprostřeně 0–2 s, core GifCooldown.onAccessChange), jinak by pásek u ikony emotů naskočil až po proklikání
 * (bod 3 testu 2026-09-27). Vrací počet zahozených záznamů cache.
 */
export function gifAccessChanged(workspace: string, channels: string[], emit: (event: string, data: object) => void): number {
  const n = invalidateGifAccess(workspace);
  for (const channel of channels) emit('gif-access-change', { channel });
  return n;
}

/** Jen pro testy. */
export function _resetGifAccessCache(): void { cache.clear(); localCooldown.clear(); globalCooldown.clear(); lastGlobalSec.clear(); lastCooldownSec.clear(); }
