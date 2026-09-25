// Odměna „Posílání GIFů" (moderace část 4), kontrakt docs/superpowers/plans/2026-09-25-moderace-cast-2-kontrakt.md §Část 4.
//
//   GET  /media/gif/:id                           médium z našeho serveru (jen čekající/schválené žádosti)
//   POST /moderation/gif/:requestId/decide        (Bearer, mod kanálu žádosti) { approve: boolean }
//   GET  /moderation/gif/pending?channel=         (Bearer, mod) čekající žádosti kanálu
//
// Médium: Content-Type podle ověřeného druhu, CSP default-src 'none', nosniff; čekající `private, no-store`,
// schválené `public, max-age=3600`. Paměťová cache se sdílenými načteními — schválený GIF si stáhnou všichni naráz.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireWebSession } from '../lib/webAuth.js';
import { accountModIdentities } from '../lib/chatRole.js';
import { MEDIA_ID_RE } from '../lib/gifIds.js';
import { pendingView, type GifFlow, type GifStore } from '../lib/gifRequests.js';
import { parseChannel } from './moderation.js';
import { RateLimiter } from './chat.js';
import { config } from '../config.js';

export type MediaEntry = { bytes: Buffer; contentType: string; status: 'pending' | 'approved' };

export interface GifRouteOpts {
  flow: GifFlow;
  store: GifStore;
  /** Sdílené médium (server ho čistí při zamítnutí/propadnutí/smazání a předehřívá při schválení). */
  media: MediaServer;
}

const DecideBody = z.object({ approve: z.boolean() });
const IdParam = z.object({ requestId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) });

/**
 * Cache-Control podle stavu: čekající médium vidí jen modi a odesílatel a může být zamítnuté → nikam neukládat;
 * schválené se může později smazat modem → hodina, bez `immutable`.
 */
export function mediaCacheControl(status: MediaEntry['status']): string {
  return status === 'approved' ? 'public, max-age=3600' : 'private, no-store';
}

/**
 * Médium z DB pro GET /media/gif/:id:
 * - LRU cache v paměti (strop v bajtech) se stavem žádosti;
 * - souběžná čtení téhož id sdílí jedno rozpracované načtení (bytea jde z Postgresu v hexu = 2× velikost;
 *   stovky diváků hned po schválení by jinak držely stovky kopií naráz);
 * - tombstone: id smazané/zamítnuté/propadlé se už nevrátí, ani když načtení z DB běželo souběžně se smazáním.
 */
export class MediaServer {
  private m = new Map<string, MediaEntry>();
  private size = 0;
  private inflight = new Map<string, Promise<MediaEntry | null>>();
  private tombstones = new Set<string>();
  constructor(private readonly load: (id: string) => Promise<MediaEntry | null>, private readonly maxBytes = 64 * 1024 * 1024) {}

  async get(id: string): Promise<MediaEntry | null> {
    if (this.tombstones.has(id)) return null;
    const hit = this.m.get(id);
    if (hit) { this.m.delete(id); this.m.set(id, hit); return hit; }
    let p = this.inflight.get(id);
    if (!p) {
      p = this.load(id).then((v) => {
        // Smazáno během načítání → nevracet a necachovat.
        if (!v || this.tombstones.has(id)) return null;
        this.put(id, v);
        return v;
      }).finally(() => { this.inflight.delete(id); });
      this.inflight.set(id, p);
    }
    return p;
  }

  /** Schváleno: načíst znovu (stav approved) do cache před rozesláním zprávy. */
  async prewarm(id: string): Promise<void> {
    const cur = this.m.get(id);
    if (cur) { cur.status = 'approved'; return; }
    await this.inflight.get(id)?.catch(() => null);
    const again = this.m.get(id);
    if (again) { again.status = 'approved'; return; }
    await this.get(id);
  }

  /** Médium smazané / zamítnuté / propadlé / GIF smazaný modem → pryč a už nikdy nevracet. */
  forget(id: string): void {
    this.tombstones.add(id);
    if (this.tombstones.size > 10_000) this.tombstones.delete(this.tombstones.values().next().value!);
    const v = this.m.get(id);
    if (v) { this.size -= v.bytes.length; this.m.delete(id); }
  }

  private put(id: string, v: MediaEntry): void {
    if (v.bytes.length > this.maxBytes) return;
    const old = this.m.get(id);
    if (old) { this.size -= old.bytes.length; this.m.delete(id); }
    this.m.set(id, v); this.size += v.bytes.length;
    for (const [k, e] of this.m) { if (this.size <= this.maxBytes) break; this.m.delete(k); this.size -= e.bytes.length; }
  }

  get _inflightSize(): number { return this.inflight.size; }
}

export default async function gifRoutes(app: FastifyInstance, opts: GifRouteOpts) {
  const mediaLimiter = new RateLimiter(60, 10);
  const modLimiter = new RateLimiter(20, 4);
  const DEFAULT_CHANNEL = (config.CHAT_INGEST_CHANNELS.split(',').find((c) => c.startsWith('twitch:'))?.split(':')[1] || 'robdiesalot').toLowerCase();

  app.get<{ Params: { id: string } }>('/media/gif/:id', async (req, reply) => {
    const id = String(req.params.id || '');
    if (!MEDIA_ID_RE.test(id)) return reply.code(404).send({ ok: false, error: 'not_found' });
    if (!mediaLimiter.allow(req.ip)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const m = await opts.media.get(id);
    if (!m) return reply.code(404).send({ ok: false, error: 'not_found' });
    return reply
      .header('Content-Type', m.contentType)
      .header('Content-Length', String(m.bytes.length))
      .header('Cache-Control', mediaCacheControl(m.status))
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
    const rows = await opts.store.listPending(new Date(), channel);
    return { ok: true, requests: rows.map(pendingView) };
  });
}
