// Ověření požadavků ze Židolišty (webhook /commands/invalidate, /announcements,
// /integrations/*). Bezpečnostní audit 2026-09-24: oddělené klíče pro každý směr
// + HMAC podpis s časem, aby šel požadavek podvrhnout jen se znalostí klíče a nešel
// zopakovat.
//
//   X-Api-Key:      ZIDOLISTA_INBOUND_KEY  (klíč Židolišta → UnityChat; u nich UNITYCHAT_OUTBOUND_KEY)
//   X-UC-Signature: t=<unix s>,v1=<hex HMAC-SHA256(ZIDOLISTA_INBOUND_KEY, t + "." + rawBody)>
//
// Přechod: dokud ZIDOLISTA_INBOUND_STRICT není "1", projde i dnešní společný klíč
// (ZIDOLISTA_API_KEY) a chybějící / špatný podpis se jen zaloguje. Po ověření, že
// podpisy chodí, se zapne STRICT: jen nový klíč a platný podpis.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';

export const SIGNATURE_WINDOW_S = 300;

declare module 'fastify' {
  interface FastifyRequest { rawBody?: string }
}

const eq = (a: string, b: string): boolean => {
  if (!a || !b) return false;
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
};

/** Podpis `t=<unix s>,v1=<hex>` nad `t + "." + rawBody`, v okně ±SIGNATURE_WINDOW_S. */
export function verifySignature(header: unknown, rawBody: string, key: string, nowS = Math.floor(Date.now() / 1000)): 'ok' | 'missing' | 'bad_format' | 'expired' | 'mismatch' {
  const h = String(Array.isArray(header) ? header[0] : header ?? '').trim();
  if (!h) return 'missing';
  const parts = Object.fromEntries(h.split(',').map((p) => { const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
  const t = Number(parts.t);
  const v1 = String(parts.v1 || '');
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/i.test(v1)) return 'bad_format';
  if (Math.abs(nowS - t) > SIGNATURE_WINDOW_S) return 'expired';
  const expected = createHmac('sha256', key).update(`${t}.${rawBody}`).digest('hex');
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(v1.toLowerCase(), 'hex')) ? 'ok' : 'mismatch';
}

export interface InboundResult { ok: boolean; reason?: string; legacyKey?: boolean; signature?: string }

/** Smí tenhle požadavek ze Židolišty projít? (klíč + podpis podle režimu) */
export function checkInbound(req: FastifyRequest, env = config): InboundResult {
  const got = String(Array.isArray(req.headers['x-api-key']) ? req.headers['x-api-key'][0] : req.headers['x-api-key'] ?? '').trim();
  const inbound = env.ZIDOLISTA_INBOUND_KEY;
  const strict = env.ZIDOLISTA_INBOUND_STRICT === '1' && !!inbound;
  const newKey = !!inbound && eq(got, inbound);
  const legacy = !strict && !newKey && eq(got, env.ZIDOLISTA_API_KEY);
  if (!newKey && !legacy) return { ok: false, reason: 'unauthorized' };
  const sig = inbound ? verifySignature(req.headers['x-uc-signature'], req.rawBody ?? '', inbound) : 'missing';
  if (strict && sig !== 'ok') return { ok: false, reason: `signature_${sig}`, signature: sig };
  return { ok: true, legacyKey: legacy, signature: sig };
}

/** Pro routy: true = pustit; jinak 401 odeslaná. Nesedící podpis v přechodu jen do logu. */
export function inboundAuthorized(req: FastifyRequest, reply: { code(n: number): { send(b: unknown): unknown } }): boolean {
  const r = checkInbound(req);
  if (!r.ok) {
    req.log.warn({ url: req.url.split('?')[0], reason: r.reason }, 'zidolista inbound: rejected');
    reply.code(401).send({ ok: false, error: 'unauthorized' });
    return false;
  }
  if (config.ZIDOLISTA_INBOUND_KEY && r.signature !== 'ok') req.log.warn({ url: req.url.split('?')[0], signature: r.signature, legacyKey: r.legacyKey }, 'zidolista inbound: signature not ok (transition)');
  return true;
}
