// Odměna „Posílání GIFů" (moderace část 4), kontrakt docs/superpowers/plans/2026-09-25-moderace-cast-2-kontrakt.md §Část 4.
//
//   GET  /media/gif/:id                           médium z našeho serveru (jen čekající/schválené žádosti)
//   POST /moderation/gif/:requestId/decide        (Bearer, mod kanálu žádosti) { approve: boolean }
//   GET  /moderation/gif/pending?channel=         (Bearer, mod) čekající žádosti kanálu
//
// Médium: Content-Type podle ověřeného druhu, CSP default-src 'none', nosniff, immutable cache (id je
// náhodné a obsah se nemění). Malá cache v paměti — schválený GIF si stáhnou všichni diváci naráz.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireWebSession } from '../lib/webAuth.js';
import { accountModIdentities } from '../lib/chatRole.js';
import { MEDIA_ID_RE } from '../lib/gifIds.js';
import { pendingView, type GifFlow, type GifStore } from '../lib/gifRequests.js';
import { parseChannel } from './moderation.js';
import { RateLimiter } from './chat.js';
import { config } from '../config.js';

export interface GifRouteOpts {
  flow: GifFlow;
  store: GifStore;
  media: (id: string) => Promise<{ bytes: Buffer; contentType: string } | null>;
  /** Sdílená cache (server ji čistí i při smazání schváleného GIFu modem). */
  cache?: MediaCache;
}

const DecideBody = z.object({ approve: z.boolean() });
const IdParam = z.object({ requestId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) });

/** LRU cache médií v paměti (strop v bajtech). */
export class MediaCache {
  private m = new Map<string, { bytes: Buffer; contentType: string }>();
  private size = 0;
  constructor(private readonly maxBytes = 64 * 1024 * 1024) {}
  get(id: string) {
    const v = this.m.get(id);
    if (v) { this.m.delete(id); this.m.set(id, v); }
    return v ?? null;
  }
  set(id: string, v: { bytes: Buffer; contentType: string }) {
    if (v.bytes.length > this.maxBytes) return;
    if (this.m.has(id)) { this.size -= this.m.get(id)!.bytes.length; this.m.delete(id); }
    this.m.set(id, v); this.size += v.bytes.length;
    for (const [k, old] of this.m) { if (this.size <= this.maxBytes) break; this.m.delete(k); this.size -= old.bytes.length; }
  }
  delete(id: string) { const v = this.m.get(id); if (v) { this.size -= v.bytes.length; this.m.delete(id); } }
}

export default async function gifRoutes(app: FastifyInstance, opts: GifRouteOpts) {
  const mediaLimiter = new RateLimiter(60, 10);
  const modLimiter = new RateLimiter(20, 4);
  const cache = opts.cache ?? new MediaCache();
  const DEFAULT_CHANNEL = (config.CHAT_INGEST_CHANNELS.split(',').find((c) => c.startsWith('twitch:'))?.split(':')[1] || 'robdiesalot').toLowerCase();

  app.get<{ Params: { id: string } }>('/media/gif/:id', async (req, reply) => {
    const id = String(req.params.id || '');
    if (!MEDIA_ID_RE.test(id)) return reply.code(404).send({ ok: false, error: 'not_found' });
    if (!mediaLimiter.allow(req.ip)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    let m = cache.get(id);
    if (!m) {
      m = await opts.media(id);
      if (!m) return reply.code(404).send({ ok: false, error: 'not_found' });
      cache.set(id, m);
    }
    return reply
      .header('Content-Type', m.contentType)
      .header('Content-Length', String(m.bytes.length))
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cross-Origin-Resource-Policy', 'cross-origin')
      .header('Content-Disposition', 'inline')
      .send(m.bytes);
  });

  app.post('/moderation/gif/:requestId/decide', { preHandler: requireWebSession }, async (req, reply) => {
    const p = IdParam.safeParse(req.params);
    const b = DecideBody.safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ ok: false, error: 'body' });
    const accountId = req.webAccountId!;
    if (!modLimiter.allow(String(accountId))) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const r = await opts.store.get(p.data.requestId);
    if (!r) return reply.code(404).send({ ok: false, error: 'not_found' });
    // Kanál VŽDY z žádosti (ne od klienta) — mod jiného kanálu nerozhoduje.
    const mods = await accountModIdentities(accountId, r.channel);
    if (!mods.length) return reply.code(403).send({ ok: false, error: 'not_mod' });
    const out = await opts.flow.decide({ requestId: r.id, approve: b.data.approve, by: `${mods[0].platform}:${mods[0].login}`, accountId });
    return reply.code(out.status).send(out.body);
  });

  app.get<{ Querystring: { channel?: string } }>('/moderation/gif/pending', { preHandler: requireWebSession }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const accountId = req.webAccountId!;
    if (!modLimiter.allow(String(accountId))) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const channel = parseChannel(req.query.channel, DEFAULT_CHANNEL);
    if (!channel) return reply.code(400).send({ ok: false, error: 'channel' });
    if (!(await accountModIdentities(accountId, channel)).length) return reply.code(403).send({ ok: false, error: 'not_mod' });
    const rows = await opts.store.listPending(new Date());
    return { ok: true, requests: rows.filter((r) => r.channel === channel).map(pendingView) };
  });
}
