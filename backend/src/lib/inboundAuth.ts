// Ověření požadavků ze Židolišty (webhook /commands/invalidate, /announcements,
// /integrations/*). Bezpečnostní audit 2026-09-24: oddělené klíče pro každý směr
// + HMAC podpis s časem. Audit 2026-09-26 (I2) → podpis v2
// (docs/superpowers/plans/2026-09-26-podpis-v2-kontrakt.md, jádro lib/signatureV2.ts).
//
//   X-Api-Key:      ZIDOLISTA_INBOUND_KEY  (identifikace, první brána; u nich UNITYCHAT_OUTBOUND_KEY)
//   v1: X-UC-Signature: t=<unix s>,v1=<hex HMAC-SHA256(ZIDOLISTA_INBOUND_KEY, t + "." + rawBody)>
//   v2: X-UC-Signature: t=<unix s>,v2=<hex HMAC-SHA256(ZIDOLISTA_TO_UC_SIGNING_KEY, METHOD path?query \n t \n nonce \n sha256(body))>
//       X-UC-Nonce:     <16–64 znaků [A-Za-z0-9_-]>, nonce jde jen jednou (cache 360 s)
//
// Režim ZIDOLISTA_INBOUND_SIGNATURE:
//   v1  (výchozí) = dosavadní chování: se ZIDOLISTA_INBOUND_STRICT=1 jen nový klíč + platný v1 podpis;
//                  bez STRICT přechod (projde i ZIDOLISTA_API_KEY, podpis se jen loguje).
//   any           = nový klíč + platný v1 NEBO v2 (vždy fail-closed, žádný legacy klíč).
//   v2            = nový klíč + platný v2 (fail-closed).
// Tělo = surové bajty (server.ts → req.rawBody), cesta = req.url (surová cesta+query, jak přišla).
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { SIGNATURE_WINDOW_S, NonceCache, hexEqual, parseSignatureHeader, verifyV2, type Body } from './signatureV2.js';

export { SIGNATURE_WINDOW_S };

declare module 'fastify' {
  interface FastifyRequest { rawBody?: Buffer }
}

const eq = (a: string, b: string): boolean => {
  if (!a || !b) return false;
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
};

export type SigResult = 'ok' | 'missing' | 'malformed' | 'expired' | 'mismatch';

const bytes = (b: Body): Buffer => (b == null ? Buffer.alloc(0) : typeof b === 'string' ? Buffer.from(b, 'utf8') : Buffer.from(b));

/** Podpis v1 `t=<unix s>,v1=<hex>` nad `t + "." + rawBody`, v okně ±SIGNATURE_WINDOW_S. */
export function verifySignature(header: unknown, rawBody: Body, key: string, nowS = Math.floor(Date.now() / 1000)): SigResult {
  const parts = parseSignatureHeader(header);
  if (!parts) return 'missing';
  const t = Number(parts.t);
  const v1 = String(parts.v1 || '');
  if (!/^\d{1,12}$/.test(parts.t ?? '') || !Number.isSafeInteger(t) || !/^[0-9a-f]{64}$/i.test(v1)) return 'malformed';
  if (Math.abs(nowS - t) > SIGNATURE_WINDOW_S) return 'expired';
  const expected = createHmac('sha256', key).update(Buffer.concat([Buffer.from(`${t}.`), bytes(rawBody)])).digest('hex');
  return hexEqual(expected, v1) ? 'ok' : 'mismatch';
}

export type InboundMode = 'v1' | 'any' | 'v2';
export interface InboundResult {
  ok: boolean;
  /** 401 kód podle kontraktu: unauthorized | bad_signature | replay. */
  error?: 'unauthorized' | 'bad_signature' | 'replay';
  /** U bad_signature: missing | malformed | expired | mismatch. */
  detail?: SigResult;
  legacyKey?: boolean;
  /** Výsledek ověření podpisu (i v přechodu, kde se jen loguje). */
  signature?: SigResult;
  version?: 'v1' | 'v2';
}

type InboundEnv = Pick<typeof config,
  'ZIDOLISTA_API_KEY' | 'ZIDOLISTA_INBOUND_KEY' | 'ZIDOLISTA_INBOUND_STRICT' | 'ZIDOLISTA_INBOUND_SIGNATURE' | 'ZIDOLISTA_TO_UC_SIGNING_KEY'>;

const inboundNonces = new NonceCache();
/** Jen pro testy. */
export function _resetInboundNonces(): void { inboundNonces.clear(); }

const header = (v: unknown): string => String(Array.isArray(v) ? v[0] : v ?? '').trim();
const fail = (error: InboundResult['error'], detail?: SigResult): InboundResult => ({ ok: false, error, ...(detail ? { detail, signature: detail } : {}) });

/** Smí tenhle požadavek ze Židolišty projít? (klíč + podpis podle režimu) */
export function checkInbound(req: FastifyRequest, env: InboundEnv = config, deps: { nowS?: number; nonces?: NonceCache } = {}): InboundResult {
  const got = header(req.headers['x-api-key']);
  const inbound = env.ZIDOLISTA_INBOUND_KEY;
  const mode: InboundMode = env.ZIDOLISTA_INBOUND_SIGNATURE ?? 'v1';
  const rawBody = req.rawBody ?? Buffer.alloc(0);

  if (mode === 'v1') {
    const strict = env.ZIDOLISTA_INBOUND_STRICT === '1' && !!inbound;
    const newKey = !!inbound && eq(got, inbound);
    const legacy = !strict && !newKey && eq(got, env.ZIDOLISTA_API_KEY);
    if (!newKey && !legacy) return fail('unauthorized');
    const sig = inbound ? verifySignature(req.headers['x-uc-signature'], rawBody, inbound, deps.nowS) : 'missing';
    if (strict && sig !== 'ok') return fail('bad_signature', sig);
    return { ok: true, legacyKey: legacy, signature: sig, version: 'v1' };
  }

  // any / v2: vždy fail-closed — jen nový klíč, bez platného podpisu nic.
  if (!inbound || !eq(got, inbound)) return fail('unauthorized');
  const parts = parseSignatureHeader(req.headers['x-uc-signature']);
  if (mode === 'v2' || (parts && parts.v2 !== undefined)) {
    const keyHex = env.ZIDOLISTA_TO_UC_SIGNING_KEY;
    if (!keyHex) return fail('bad_signature', 'mismatch'); // bez klíče nejde ověřit nic (config to v režimu v2 hlídá už při startu)
    const nonce = header(req.headers['x-uc-nonce']);
    const r = verifyV2({ header: req.headers['x-uc-signature'], nonce, method: req.method, pathAndQuery: req.url, rawBody, keyHex, nowS: deps.nowS });
    if (r !== 'ok') return fail('bad_signature', r);
    const nonces = deps.nonces ?? inboundNonces;
    if (nonces.has(nonce)) return fail('replay');
    nonces.add(nonce);   // až po úspěšném ověření podpisu
    return { ok: true, legacyKey: false, signature: 'ok', version: 'v2' };
  }
  const sig = verifySignature(req.headers['x-uc-signature'], rawBody, inbound, deps.nowS);
  if (sig !== 'ok') return fail('bad_signature', sig);
  return { ok: true, legacyKey: false, signature: 'ok', version: 'v1' };
}

/**
 * JSON parser, který si nechá surové tělo (req.rawBody = Buffer přesně jak přišel) pro podpis; parsování
 * je dál výchozí Fastify (ochrana proti __proto__ / constructor poisoning zůstává).
 */
export function registerRawJsonParser(app: FastifyInstance): void {
  const defaultJson = app.getDefaultJsonParser('error', 'error');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    defaultJson(req, req.rawBody.toString('utf8'), done);
  });
}

/** Pro routy: true = pustit; jinak 401 odeslaná. Nesedící podpis v přechodu (v1 bez STRICT) jen do logu. */
export function inboundAuthorized(req: FastifyRequest, reply: { code(n: number): { send(b: unknown): unknown } }, env: InboundEnv = config): boolean {
  const r = checkInbound(req, env);
  if (!r.ok) {
    req.log.warn({ url: req.url.split('?')[0], reason: r.error, detail: r.detail }, 'zidolista inbound: rejected');
    reply.code(401).send({ ok: false, error: r.error, ...(r.detail ? { detail: r.detail } : {}) });
    return false;
  }
  if (env.ZIDOLISTA_INBOUND_KEY && r.signature !== 'ok') req.log.warn({ url: req.url.split('?')[0], signature: r.signature, legacyKey: r.legacyKey }, 'zidolista inbound: signature not ok (transition)');
  return true;
}
