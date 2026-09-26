// Záložní stažení GIFu přes Bright Data Web Unlocker (moderace část 4, lib/gifMedia.ts).
//
// Kdy: přímé stažení narazilo na Cloudflare challenge (blokuje se IP našeho VPS, ne otisk prohlížeče —
// ověřeno na i.4pcdn.org). Volá se AŽ po úspěšném assertPublicUrl cílové URL (safeGet v gifMedia.ts), takže
// Bright Data dostane jen veřejnou URL z chatu. Odpověď prochází stejnými kontrolami jako přímé stažení
// (10 MB streamem, MIME + magic bytes, přesměrování znovu ověřené).
//
// API (docs.brightdata.com, ověřeno 2026-09-26):
//   POST https://api.brightdata.com/request, Authorization: Bearer <klíč>, { zone, url, format: "raw" }
//   - vnější 200 + chybí x-brd-error → tělo je odpověď cílového webu, její status je v `x-brd-status-code`;
//   - vnější 400 (zóna / parametry), 401 (klíč), 429 (throttling), 502 (odemčení selhalo, důvod
//     v `x-brd-error-code`) → chyba.
//
// Bez úniků: klíč jde jen do hlavičky Authorization, nikdy do logu ani do chyby (GifError nese jen kód).
// Log: jen host a výsledek. Denní strop v paměti (reset o půlnoci UTC) a negativní cache 10 min per URL.
import { GifError, type TransportResponse } from './gifMedia.js';

export const UNLOCKER_ENDPOINT = 'https://api.brightdata.com/request';
/** Celkový limit převodu, když se použije fallback (měřeno od začátku resolveGif). */
export const UNLOCKER_TIMEOUT_MS = 25_000;
export const UNLOCKER_NEGATIVE_TTL_MS = 10 * 60_000;
const NEGATIVE_MAX = 1000;

export type UnlockerLog = (obj: { host: string; code?: string }, msg: string) => void;

export interface Unlocker {
  /** Celkový časový limit převodu s fallbackem (ms od začátku). */
  readonly timeoutMs: number;
  /**
   * Stáhne URL přes Web Unlocker. null = fallback se nezkouší (strop, negativní cache) → volající vrátí
   * původní chybu. Chyba API = GifError('unlocker_<důvod>'), vypršení = GifError('timeout').
   * Status odpovědi = status cílového webu (x-brd-status-code).
   */
  fetch(url: URL, signal: AbortSignal): Promise<TransportResponse | null>;
  /** Výsledek celého převodu po fallbacku (včetně kontrol média): log + negativní cache při chybě. */
  report(url: URL, code: string | null): void;
}

export interface UnlockerOptions {
  apiKey: string;
  zone: string;
  dailyCap: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  log?: UnlockerLog;
}

/** Bez klíče nebo zóny (nebo se stropem 0) → null = fallback vypnutý. */
export function createUnlocker(opts: UnlockerOptions): Unlocker | null {
  const apiKey = String(opts.apiKey || '').trim();
  const zone = String(opts.zone || '').trim();
  if (!apiKey || !zone || !(opts.dailyCap > 0)) return null;
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const log: UnlockerLog = opts.log ?? (() => {});
  const negative = new Map<string, number>();
  let day = '';
  let used = 0;

  const utcDay = (): string => new Date(now()).toISOString().slice(0, 10);

  return {
    timeoutMs: opts.timeoutMs ?? UNLOCKER_TIMEOUT_MS,

    async fetch(url, signal) {
      const key = url.toString();
      const host = url.hostname;
      const until = negative.get(key);
      if (until !== undefined) {
        if (until > now()) { log({ host, code: 'negative_cache' }, 'gif: unlocker skip'); return null; }
        negative.delete(key);
      }
      const today = utcDay();
      if (today !== day) { day = today; used = 0; }
      if (used >= opts.dailyCap) { log({ host, code: 'daily_cap' }, 'gif: unlocker skip'); return null; }
      used++;

      let res: Response;
      try {
        res = await doFetch(UNLOCKER_ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ zone, url: key, format: 'raw' }),
          redirect: 'manual',
          signal,
        });
      } catch {
        // Zprávu výjimky nepropouštět (fetch ji může skládat z požadavku).
        throw new GifError(signal.aborted ? 'timeout' : 'unlocker_network');
      }
      const dispose = (): void => { res.body?.cancel().catch(() => {}); };
      const h: Record<string, string | undefined> = {};
      res.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
      if (res.status !== 200 || h['x-brd-error'] || h['x-brd-error-code']) {
        dispose();
        let reason = String(h['x-brd-error-code'] || res.status).replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || 'error';
        // Klíč (i jeho useknutý kus) nikdy do kódu chyby.
        if (reason.includes(apiKey) || (reason.length > 8 && apiKey.includes(reason))) reason = 'error';
        throw new GifError(`unlocker_${reason}`);
      }
      const target = Number(h['x-brd-status-code']);
      const body = (res.body ?? (async function* () {})()) as unknown as AsyncIterable<Uint8Array>;
      return { status: Number.isInteger(target) && target > 0 ? target : res.status, headers: h, body, dispose };
    },

    report(url, code) {
      const host = url.hostname;
      if (code === null) { log({ host }, 'gif: unlocker ok'); return; }
      log({ host, code }, 'gif: unlocker err');
      if (negative.size >= NEGATIVE_MAX) {
        const t = now();
        for (const [k, v] of negative) if (v <= t) negative.delete(k);
        if (negative.size >= NEGATIVE_MAX) negative.delete(negative.keys().next().value as string);
      }
      negative.set(url.toString(), now() + UNLOCKER_NEGATIVE_TTL_MS);
    },
  };
}
