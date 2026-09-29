// Granty pro stažení GIFu prohlížečem odesílatele (spec docs/superpowers/specs/2026-09-29-gif-stazeni-prohlizecem-design.md §3, §6):
// server médium stáhnout nemůže (host blokuje IP), ale zná jeho adresu, typ a rozměry. Vydá jednorázový token
// (jen odesílateli přes /account/stream), intercept čeká na `result`; POST /gif/client-upload bajty ověří proti
// grantu (typ, limity, rozměry ±1 px) a `result` splní. Token nikdy do logu. V paměti procesu.
import { createHash, randomBytes } from 'node:crypto';
import { GIF_MAX_BYTES, GifError, sniffKind, mediaSize, withinLimits, CONTENT_TYPES, type GifKind, type ResolvedGif, type MediaProber } from './gifMedia.js';

export const CLIENT_FETCH_TTL_MS = 90_000;
export const CLIENT_FETCH_DIM_TOLERANCE = 1;
export interface ClientFetchGrant { requestKey: string; channel: string; accountId: number; mediaUrl: string; host: string; kind: GifKind | null; width: number | null; height: number | null; maxBytes: number; expiresAt: number }
export type ClientUploadError = 'bad_token' | 'empty' | 'bad_type' | 'too_large' | 'size_mismatch' | 'bad_media';
export interface ClientFetchGrants {
  issue(g: Omit<ClientFetchGrant, 'expiresAt' | 'maxBytes'>): { token: string; grant: ClientFetchGrant; result: Promise<ResolvedGif | null> };
  /** Upload: ověří token+účet, typ, limity (probe), rozměry; při úspěchu splní `result` a vrátí { ok: true }. Grant je po volání vždy pryč. */
  complete(token: string, accountId: number, bytes: Buffer, probe?: MediaProber): Promise<{ ok: true } | { ok: false; error: ClientUploadError }>;
  /** Odmítnutí odesílatelem: splní `result` null; neznámý token = tiše true. */
  decline(token: string, accountId: number): boolean;
  /** Vypršelé granty → result null. */
  sweep(): number;
  /** Zrušit grant bez ohledu na účet (413 z parseru těla ještě před preHandlerem): result null; neznámý = false. */
  expire(token: string): boolean;
  readonly size: number;
}
const hash = (t: string) => createHash('sha256').update(t).digest('hex');

export function createClientFetchGrants({ now = Date.now, ttlMs = CLIENT_FETCH_TTL_MS, max = 500, random = () => randomBytes(32).toString('base64url') }: { now?: () => number; ttlMs?: number; max?: number; random?: () => string } = {}): ClientFetchGrants {
  type Row = { grant: ClientFetchGrant; resolve: (v: ResolvedGif | null) => void };
  const rows = new Map<string, Row>();
  const drop = (k: string, v: ResolvedGif | null) => { const r = rows.get(k); if (!r) return false; rows.delete(k); r.resolve(v); return true; };
  return {
    issue(g) {
      const token = random();
      const grant: ClientFetchGrant = { ...g, maxBytes: GIF_MAX_BYTES, expiresAt: now() + ttlMs };
      let resolve!: (v: ResolvedGif | null) => void;
      const result = new Promise<ResolvedGif | null>((r) => { resolve = r; });
      rows.set(hash(token), { grant, resolve });
      while (rows.size > max) drop(rows.keys().next().value!, null);
      return { token, grant, result };
    },
    async complete(token, accountId, bytes, probe) {
      const k = hash(String(token || ''));
      const r = rows.get(k);
      if (!r || r.grant.accountId !== accountId || r.grant.expiresAt <= now()) { if (r) drop(k, null); return { ok: false, error: 'bad_token' }; }
      const fail = (error: ClientUploadError) => { drop(k, null); return { ok: false as const, error }; };
      if (!bytes?.length) return fail('empty');
      if (bytes.length > r.grant.maxBytes) return fail('too_large');
      const kind = sniffKind(bytes);
      if (!kind || (r.grant.kind && kind !== r.grant.kind)) return fail('bad_type');
      let v: ResolvedGif = { bytes, kind, contentType: CONTENT_TYPES[kind], ...mediaSize(bytes, kind), sourceUrl: r.grant.mediaUrl };
      try { v = await withinLimits(v, { probe }); }
      catch (e) { return fail(e instanceof GifError && e.code === 'too_large' ? 'too_large' : 'bad_media'); }
      const off = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) > CLIENT_FETCH_DIM_TOLERANCE;
      if (off(r.grant.width, v.width) || off(r.grant.height, v.height)) return fail('size_mismatch');
      drop(k, v);
      return { ok: true };
    },
    decline(token, accountId) {
      const k = hash(String(token || ''));
      const r = rows.get(k);
      if (r && r.grant.accountId === accountId) drop(k, null);
      return true;
    },
    sweep() { let n = 0; const t = now(); for (const [k, r] of rows) if (r.grant.expiresAt <= t) { drop(k, null); n++; } return n; },
    expire(token) { return drop(hash(String(token || '')), null); },
    get size() { return rows.size; },
  };
}
