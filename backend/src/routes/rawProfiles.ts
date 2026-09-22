// Profily browser source (/chat/raw/?p=<id>): nastavení z konfigurátoru
// /chat/settings/ žije na serveru, otevřené raw stránky (OBS, prohlížeč) si ho
// stáhnou při startu a změny dostanou živě přes SSE `raw-settings` na
// /nicknames/stream — bez refreshe zdroje (pokyn usera 2026-09-22).
// Id je náhodné (≥ 12 znaků) a funguje jako tajemství: kdo ho zná, může číst i psát.
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { rawProfiles } from '../db/schema.js';
import { RateLimiter } from './chat.js';
import { broadcast } from '../sse/bus.js';

const Id = z.string().regex(/^[A-Za-z0-9_-]{12,64}$/);
export const RawSettings = z.object({
  font: z.number().min(2).max(100).optional(),
  scale: z.number().min(0.5).max(3).optional(),
  width: z.number().min(200).max(4000).optional(),
  height: z.number().min(200).max(4000).optional(),
  bg: z.string().regex(/^(|transparent|#[0-9a-fA-F]{3,8}|[a-z]{3,20})$/).optional(),
  timestamps: z.union([z.literal('0'), z.literal('1'), z.boolean()]).optional(),
  reply: z.union([z.literal(''), z.literal('oneline'), z.boolean()]).optional(),
  platforms: z.array(z.enum(['twitch', 'youtube', 'kick'])).max(3).optional(),
}).strict();
export type RawSettingsT = z.infer<typeof RawSettings>;

export default async function rawProfileRoutes(app: FastifyInstance) {
  const readLimiter = new RateLimiter(20, 5);
  const writeLimiter = new RateLimiter(20, 3);

  app.get<{ Params: { id: string } }>('/raw-profiles/:id', async (req, reply) => {
    if (!readLimiter.allow(req.ip)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const id = Id.safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ ok: false, error: 'bad_id' });
    reply.header('Cache-Control', 'no-store');
    const rows = await db.select({ settings: rawProfiles.settings, updatedAt: rawProfiles.updatedAt }).from(rawProfiles).where(eq(rawProfiles.id, id.data)).limit(1);
    if (!rows.length) return reply.code(404).send({ ok: false, error: 'not_found' });
    return { ok: true, id: id.data, settings: rows[0].settings, updatedAt: rows[0].updatedAt };
  });

  app.put<{ Params: { id: string }; Body: unknown }>('/raw-profiles/:id', async (req, reply) => {
    if (!writeLimiter.allow(req.ip)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const id = Id.safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ ok: false, error: 'bad_id' });
    const body = RawSettings.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: 'settings', issues: body.error.issues.map((i) => i.path.join('.')) });
    const now = new Date();
    await db
      .insert(rawProfiles)
      .values({ id: id.data, settings: body.data, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: rawProfiles.id, set: { settings: body.data, updatedAt: now } });
    // Otevřené raw stránky s tímto profilem si změnu aplikují hned.
    broadcast('raw-settings', { id: id.data, settings: body.data, updatedAt: now.toISOString() });
    req.log.info({ id: id.data, keys: Object.keys(body.data) }, 'raw profile saved');
    return { ok: true, id: id.data, updatedAt: now.toISOString() };
  });
}
