// Podpis v2 mezi UnityChatem a Židolištou (kontrakt docs/superpowers/plans/2026-09-26-podpis-v2-kontrakt.md).
// Sdílené jádro pro oba směry: příchozí ověření (lib/inboundAuth.ts) i odchozí podpis (lib/zidolista.ts).
//
//   signed = METHOD + " " + PATH_AND_QUERY + "\n" + t + "\n" + nonce + "\n" + hex(sha256(rawBody))
//   X-UC-Signature: t=<unix s>,v2=<hex HMAC-SHA256(signingKey, signed)>
//   X-UC-Nonce:     <16–64 znaků [A-Za-z0-9_-]>
//
// Podpisový klíč je hex (≥ 64 znaků) a do HMAC jde jako bajty (hex → Buffer). Po síti nikdy nejde.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_WINDOW_S = 300;
export const NONCE_TTL_MS = 360_000;
export const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** Validace podpisového klíče z env: hex, sudá délka, ≥ 64 znaků (32 bajtů). */
export const SIGNING_KEY_RE = /^(?:[0-9a-fA-F]{2}){32,}$/;

export type Body = string | Buffer | Uint8Array | undefined | null;

const bodyBytes = (b: Body): Buffer => (b == null ? Buffer.alloc(0) : typeof b === 'string' ? Buffer.from(b, 'utf8') : Buffer.from(b));

/** Podepisovaný text v2. */
export function signedTextV2(method: string, pathAndQuery: string, t: number, nonce: string, rawBody: Body): string {
  const bodyHash = createHash('sha256').update(bodyBytes(rawBody)).digest('hex');
  return `${method.toUpperCase()} ${pathAndQuery}\n${t}\n${nonce}\n${bodyHash}`;
}

/** hex HMAC-SHA256 v2; `keyHex` = podpisový klíč v hex. */
export function hmacV2(keyHex: string, method: string, pathAndQuery: string, t: number, nonce: string, rawBody: Body): string {
  return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(signedTextV2(method, pathAndQuery, t, nonce, rawBody)).digest('hex');
}

export const newNonce = (): string => randomBytes(16).toString('hex');

/** Hlavičky v2 pro odchozí požadavek. */
export function signV2Headers(keyHex: string, method: string, pathAndQuery: string, rawBody: Body, opts: { nowS?: number; nonce?: string } = {}): { 'X-UC-Signature': string; 'X-UC-Nonce': string } {
  const t = opts.nowS ?? Math.floor(Date.now() / 1000);
  const nonce = opts.nonce ?? newNonce();
  return { 'X-UC-Signature': `t=${t},v2=${hmacV2(keyHex, method, pathAndQuery, t, nonce, rawBody)}`, 'X-UC-Nonce': nonce };
}

/** Rozpad `t=…,v1=…,v2=…`; null = prázdná hlavička. Neznámé části se ignorují. */
export function parseSignatureHeader(header: unknown): Record<string, string> | null {
  const h = String(Array.isArray(header) ? header[0] : header ?? '').trim();
  if (!h) return null;
  const out: Record<string, string> = {};
  for (const p of h.split(',')) {
    const i = p.indexOf('=');
    if (i <= 0) continue;
    out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  return out;
}

/** Porovnání dvou hex digestů v konstantním čase (délka digestu je veřejná). */
export function hexEqual(expectedHex: string, gotHex: string): boolean {
  const a = Buffer.from(expectedHex, 'hex');
  const b = Buffer.from(gotHex.toLowerCase(), 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export type V2Result = 'ok' | 'missing' | 'malformed' | 'expired' | 'mismatch';

/** Ověření v2 bez nonce cache (kroky 2–4 kontraktu). */
export function verifyV2(p: {
  header: unknown; nonce: unknown; method: string; pathAndQuery: string; rawBody: Body; keyHex: string; nowS?: number;
}): V2Result {
  const parts = parseSignatureHeader(p.header);
  const nonce = String(Array.isArray(p.nonce) ? p.nonce[0] : p.nonce ?? '').trim();
  if (!parts || !nonce) return 'missing';
  const t = Number(parts.t);
  const v2 = parts.v2 ?? '';
  if (!/^\d{1,12}$/.test(parts.t ?? '') || !Number.isSafeInteger(t) || !/^[0-9a-f]{64}$/i.test(v2) || !NONCE_RE.test(nonce)) return 'malformed';
  const nowS = p.nowS ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowS - t) > SIGNATURE_WINDOW_S) return 'expired';
  return hexEqual(hmacV2(p.keyHex, p.method, p.pathAndQuery, t, nonce, p.rawBody), v2) ? 'ok' : 'mismatch';
}

/** Paměťová cache viděných nonce (jedna instance; restart ji smaže — přijaté riziko max 300 s). */
export class NonceCache {
  private seen = new Map<string, number>();
  private lastSweep = 0;
  constructor(private ttlMs = NONCE_TTL_MS, private now: () => number = Date.now) {}
  has(nonce: string): boolean {
    const exp = this.seen.get(nonce);
    return exp !== undefined && exp > this.now();
  }
  add(nonce: string): void {
    const now = this.now();
    if (now - this.lastSweep > 30_000) {
      for (const [k, exp] of this.seen) if (exp <= now) this.seen.delete(k);
      this.lastSweep = now;
    }
    this.seen.set(nonce, now + this.ttlMs);
  }
  get size(): number { return this.seen.size; }
  clear(): void { this.seen.clear(); }
}
