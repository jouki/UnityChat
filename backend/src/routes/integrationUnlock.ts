// Záložní stažení souboru přes Bright Data Web Unlocker pro Židolištu (2026-10-02, pokyn usera).
// Některé weby (myinstants.com) blokují IP datacentra (403 od Cloudflare) — návrh zvuku z takového odkazu na
// serveru Židolišty selže. Klíč Bright Data zůstává jen tady; Židolišta při 403 / Cloudflare zavolá:
//   POST /integrations/unlock-fetch { url }   (X-Api-Key / podpis jako ostatní integrační routy)
//   → 200 tělo souboru (Content-Type z cíle, X-Unlock-Status = stav cíle) | 4xx/5xx { ok:false, error }
// Chyby: bad_url (jen http(s), bez přihlašovacích údajů), unavailable (bez klíče / denní strop vyčerpán /
// negativní cache), too_large (> UNLOCK_MAX_BYTES), upstream_<kód> (cíl vrátil chybu), unlocker_<kód>.
// Sdílí denní strop s GIFy (BRIGHTDATA_DAILY_CAP) — stejná instance unlockeru.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { inboundAuthorized } from '../lib/inboundAuth.js';
import type { Unlocker } from '../lib/gifUnlocker.js';

export const UNLOCK_MAX_BYTES = 10 * 1024 * 1024;
const Body = z.object({ url: z.string().trim().min(8).max(2000) }).strict();

export function parseUnlockUrl(raw: string): URL | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  return u;
}

/** `auth` jen pro testy (výchozí ověření integračního klíče / podpisu Židolišty). */
export default async function integrationUnlockRoutes(app: FastifyInstance, opts: { unlocker: Unlocker | null; auth?: (req: FastifyRequest, reply: FastifyReply) => boolean }) {
  const auth = opts.auth ?? ((req: FastifyRequest, reply: FastifyReply) => inboundAuthorized(req, reply));
  app.post('/integrations/unlock-fetch', async (req, reply) => {
    if (!auth(req, reply)) return reply;
    const b = Body.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'bad_body' });
    const url = parseUnlockUrl(b.data.url);
    if (!url) return reply.code(400).send({ ok: false, error: 'bad_url' });
    if (!opts.unlocker) return reply.code(503).send({ ok: false, error: 'unavailable' });
    let r;
    try { r = await opts.unlocker.fetch(url, AbortSignal.timeout(60_000)); }
    catch (e) {
      const code = String((e as Error)?.message || 'unlocker_error').replace(/[^a-z0-9_-]/gi, '').slice(0, 60);
      req.log.warn({ host: url.hostname, code }, 'unlock-fetch: selhalo');
      return reply.code(502).send({ ok: false, error: code });
    }
    if (!r) return reply.code(503).send({ ok: false, error: 'unavailable' });
    if (r.status < 200 || r.status >= 300) {
      r.dispose();
      req.log.info({ host: url.hostname, status: r.status }, 'unlock-fetch: cíl vrátil chybu');
      return reply.code(502).send({ ok: false, error: `upstream_${r.status}` });
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of r.body) {
      size += c.length;
      if (size > UNLOCK_MAX_BYTES) { r.dispose(); return reply.code(413).send({ ok: false, error: 'too_large' }); }
      chunks.push(Buffer.from(c));
    }
    const type = String(r.headers['content-type'] || 'application/octet-stream').slice(0, 100);
    req.log.info({ host: url.hostname, bytes: size, type }, 'unlock-fetch: staženo');
    return reply.code(200).header('Content-Type', type).header('X-Unlock-Status', String(r.status)).header('Cache-Control', 'no-store').send(Buffer.concat(chunks));
  });
}
