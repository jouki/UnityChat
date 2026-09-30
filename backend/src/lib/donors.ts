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
const cache = new Map<string, { at: number; keys: Set<string>; ok: boolean }>();   // slug → dárci (platform:userId)
const key = (platform: string, userId: string) => `${platform}:${userId}`;

/** Odpověď Židolišty → množina klíčů (čistá funkce; neznámé platformy / prázdná id se zahodí). */
export function parseDonors(raw: unknown): Set<string> {
  const out = new Set<string>();
  const list = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>).donors : null);
  if (!Array.isArray(list)) return out;
  for (const d of list) {
    const p = String((d as Record<string, unknown>)?.platform ?? '').toLowerCase();
    const id = String((d as Record<string, unknown>)?.userId ?? '').trim();
    if (PLATFORMS.has(p) && id) out.add(key(p, id));
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
    if (r.status === 404) { cache.set(slug, { at: now(), keys: cache.get(slug)?.keys ?? new Set(), ok: false }); return false; }   // endpoint ještě není
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as { ok?: boolean };
    if (!j || j.ok === false) throw new Error('not ok');
    const keys = parseDonors(j);
    const prev = cache.get(slug)?.keys;
    cache.set(slug, { at: now(), keys, ok: true });
    if (!prev || prev.size !== keys.size || [...keys].some((k) => !prev.has(k))) deps.log?.info?.({ workspace: slug, donors: keys.size }, 'donors: seznam dárců obnoven');
    return true;
  } catch (e) {
    deps.log?.warn({ workspace: slug, err: (e as Error).message }, 'donors: Židolišta nedostupná (odznaky z posledního stavu)');
    if (!cache.has(slug)) cache.set(slug, { at: now(), keys: new Set(), ok: false });
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

/** Jen pro testy. */
export function _setDonorsForTest(slug: string, keys: string[]): void { cache.set(slug, { at: Date.now(), keys: new Set(keys), ok: true }); }
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
