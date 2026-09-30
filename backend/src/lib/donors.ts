// Dárci kanálu za posledních 30 dní (pokyn usera 2026-09-30) → odznak dárce v chatu (core/donor-badge.js).
// Zdroj: Židolišta `GET <base>/integrations/:slug/donors?days=30` → { ok, donors: [{ platform, userId, login? }] }
// (kontrakt navržený 2026-09-30; dokud endpoint není, seznam je prázdný = žádné odznaky, žádná chyba).
// Cache per workspace, obnova každých 5 min (limit Židolišty 300/min se nedotkne); při výpadku poslední stav.
// Příznak `donor: true` doplní routes/chat.ts toClientMessage (historie i /chat/stream) podle platformního kanálu
// zprávy → workspace (registr). Synchronní dotaz jen z cache.
import { config } from '../config.js';
import { zidolistaFetch, zidolistaBase, getWorkspaces, workspaceForChannelSync, type Platform } from './zidolista.js';

export const DONORS_DAYS = 30;
export const DONORS_REFRESH_MS = 5 * 60_000;
const PLATFORMS = new Set(['twitch', 'kick', 'youtube']);

type Log = { info?: (o: object, m: string) => void; warn: (o: object, m: string) => void };
const cache = new Map<string, { at: number; keys: Set<string>; amounts: Map<string, number>; ok: boolean }>();   // slug → dárci (platform:userId), částky za okno (Kč)
const key = (platform: string, userId: string) => `${platform}:${userId}`;

/** Odpověď Židolišty → množina klíčů (čistá funkce; neznámé platformy / prázdná id se zahodí). */
export function parseDonors(raw: unknown): Set<string> {
  return new Set(parseDonorAmounts(raw).keys());
}

/** Odpověď Židolišty → klíč → částka za okno v Kč (`amountCzk`, 0 když ji Židolišta neposílá). */
export function parseDonorAmounts(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const list = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>).donors : null);
  if (!Array.isArray(list)) return out;
  for (const d of list) {
    const r = d as Record<string, unknown>;
    const p = String(r?.platform ?? '').toLowerCase();
    const id = String(r?.userId ?? '').trim();
    if (!PLATFORMS.has(p) || !id) continue;
    const czk = Number(r?.amountCzk);
    out.set(key(p, id), Math.max(out.get(key(p, id)) ?? 0, Number.isFinite(czk) && czk > 0 ? Math.round(czk) : 0));
  }
  return out;
}

export interface DonorsDeps { fetch?: typeof fetch; apiKey?: string; base?: string; signingKey?: string; log?: Log; now?: () => number }

/** Načíst dárce workspace (a uložit do cache). false = Židolišta nedostupná / endpoint chybí (cache zůstává). */
export async function refreshDonors(slug: string, deps: DonorsDeps = {}): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const apiKey = deps.apiKey ?? config.ZIDOLISTA_API_KEY;
  if (!apiKey) return false;
  const base = (deps.base ?? zidolistaBase()).replace(/\/$/, '');
  try {
    const r = await zidolistaFetch(`${base}/integrations/${encodeURIComponent(slug.toLowerCase())}/donors?days=${DONORS_DAYS}`, { signal: AbortSignal.timeout(8000) }, { fetch: deps.fetch, apiKey, signingKey: deps.signingKey });
    if (r.status === 404) { const c = cache.get(slug); cache.set(slug, { at: now(), keys: c?.keys ?? new Set(), amounts: c?.amounts ?? new Map(), ok: false }); return false; }   // endpoint ještě není
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as { ok?: boolean };
    if (!j || j.ok === false) throw new Error('not ok');
    const amounts = parseDonorAmounts(j);
    const keys = new Set(amounts.keys());
    const prev = cache.get(slug)?.keys;
    cache.set(slug, { at: now(), keys, amounts, ok: true });
    if (!prev || prev.size !== keys.size || [...keys].some((k) => !prev.has(k))) deps.log?.info?.({ workspace: slug, donors: keys.size }, 'donors: seznam dárců obnoven');
    return true;
  } catch (e) {
    deps.log?.warn({ workspace: slug, err: (e as Error).message }, 'donors: Židolišta nedostupná (odznaky z posledního stavu)');
    if (!cache.has(slug)) cache.set(slug, { at: now(), keys: new Set(), amounts: new Map(), ok: false });
    return false;
  }
}

/** Je autor zprávy dárce? Jen z cache (ingest onLive, historie). `channel` = platformní kanál zprávy. */
export function isDonor(platform: Platform | string, channel: string, userId: string | null | undefined): boolean {
  if (!userId) return false;
  const ws = workspaceForChannelSync(platform as Platform, channel);
  const c = ws ? cache.get(ws.slug) : null;
  return !!c && c.keys.has(key(platform, String(userId)));
}

/** Částka dárce za okno (Kč), null = není dárce / Židolišta částky neposílá (0). */
export function donorAmount(platform: Platform | string, channel: string, userId: string | null | undefined): number | null {
  if (!userId) return null;
  const ws = workspaceForChannelSync(platform as Platform, channel);
  const c = ws ? cache.get(ws.slug) : null;
  const a = c?.amounts.get(key(platform, String(userId)));
  return a && a > 0 ? a : null;
}

/** Jen pro testy. */
export function _setDonorsForTest(slug: string, keys: string[]): void { cache.set(slug, { at: Date.now(), keys: new Set(keys), amounts: new Map(keys.map((k) => [k, 0])), ok: true }); }
export function _resetDonorsForTest(): void { cache.clear(); }

let timer: ReturnType<typeof setInterval> | null = null;
/** Obnova všech workspaců z registru hned a pak každých 5 min. */
export function startDonorsRefresh(log?: Log): void {
  if (timer) return;
  const tick = async () => {
    try { for (const ws of await getWorkspaces({ log })) await refreshDonors(ws.slug, { log }); } catch (e) { log?.warn({ err: (e as Error).message }, 'donors: obnova selhala'); }
  };
  void tick();
  timer = setInterval(() => void tick(), DONORS_REFRESH_MS);
  timer.unref?.();
}
export function stopDonorsRefresh(): void { if (timer) { clearInterval(timer); timer = null; } }
