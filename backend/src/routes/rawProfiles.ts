// Profily browser source (/chat/raw/?p=<id>): nastavení z konfigurátoru
// /chat/settings/ žije na serveru, otevřené raw stránky (OBS, prohlížeč) si ho
// stáhnou při startu a změny dostanou živě přes SSE `raw-settings` na
// /nicknames/stream — bez refreshe zdroje (pokyn usera 2026-09-22).
// Id je náhodné (≥ 12 znaků) a funguje jako tajemství: kdo ho zná, může číst i psát.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { rawProfiles } from '../db/schema.js';
import { RateLimiter } from './chat.js';
import { broadcast } from '../sse/bus.js';
import { bearerToken, requireWebSession, validateWebSession } from '../lib/webAuth.js';
import { accountModIdentities } from '../lib/chatRole.js';
import { canEditProfile, canManageChannel, CHANNEL_RE, type ProfileAccessDeps } from '../lib/rawProfileAccess.js';
import { randomBytes } from 'node:crypto';

/** Účet z Bearer session (bez něj null). */
async function sessionAccount(req: FastifyRequest): Promise<number | null> {
  const tok = bearerToken(req);
  return tok ? validateWebSession(tok) : null;
}

// Streamer / mod kanálu (stejné ověření jako moderace) — seznam a úpravy instancí připojených ke kanálu.
const accessDeps: ProfileAccessDeps = { isEditor: async (accountId, channel) => (await accountModIdentities(accountId, channel)).length > 0 };

const Id = z.string().regex(/^[A-Za-z0-9_-]{12,64}$/);
export const RawSettings = z.object({
  // Rodina písma z katalogu konfigurátoru (web/src/fonts.js). Server jen hlídá tvar —
  // seznam je na klientovi, který hodnotu ověřuje proti katalogu před zápisem do CSS.
  fontFamily: z.string().max(60).regex(/^[A-Za-z0-9 ,'’\-]*$/).optional(),
  font: z.number().min(2).max(100).optional(),
  scale: z.number().min(0.5).max(3).optional(),
  width: z.number().min(200).max(4000).optional(),
  height: z.number().min(200).max(4000).optional(),
  bg: z.string().regex(/^(|transparent|#[0-9a-fA-F]{3,8}|[a-z]{3,20})$/).optional(),
  timestamps: z.union([z.literal('0'), z.literal('1'), z.boolean()]).optional(),
  reply: z.union([z.literal(''), z.literal('oneline'), z.boolean()]).optional(),
  // Zvuky (reakce se zvukem): '0' = vypnuté; chybí = zapnuté.
  sound: z.union([z.literal('0'), z.literal('1'), z.boolean()]).optional(),
  // Nejnovější zprávy nahoře (obrácené pořadí, nové přijíždějí shora): '1' = zapnuto; chybí = klasicky dole.
  reverse: z.union([z.literal('0'), z.literal('1'), z.boolean()]).optional(),
  // GIFy v chatu: '0' = vůbec nezobrazovat; chybí = zobrazovat.
  gifs: z.union([z.literal('0'), z.literal('1'), z.boolean()]).optional(),
  // Announcementy UnityChatu: '0' = žádné (běžná odpověď commandu / bota se pak ukáže); chybí = zobrazovat.
  annc: z.union([z.literal('0'), z.literal('1'), z.boolean()]).optional(),
  platforms: z.array(z.enum(['twitch', 'youtube', 'kick'])).max(3).optional(),
  // Název instance (víc OBS chatů pro různé scény) — jen pro konfigurátor, raw stránka ho nepoužívá.
  name: z.string().max(40).optional(),
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

  // Úprava instance: jen přihlášený streamer / mod kanálu, ke kterému instance patří (lib/rawProfileAccess.ts).
  app.put<{ Params: { id: string }; Body: unknown }>('/raw-profiles/:id', async (req, reply) => {
    if (!writeLimiter.allow(req.ip)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const id = Id.safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ ok: false, error: 'bad_id' });
    const body = RawSettings.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: 'settings', issues: body.error.issues.map((i) => i.path.join('.')) });
    const cur = await db.select({ channel: rawProfiles.channel }).from(rawProfiles).where(eq(rawProfiles.id, id.data)).limit(1);
    const can = await canEditProfile(cur[0] ?? null, await sessionAccount(req), accessDeps);
    if (!can.ok) { req.log.info({ id: id.data, channel: cur[0]?.channel }, `raw profile PUT: ${can.error}`); return reply.code(can.status).send({ ok: false, error: can.error }); }
    const now = new Date();
    await db.update(rawProfiles).set({ settings: body.data, updatedAt: now }).where(eq(rawProfiles.id, id.data));
    // Otevřené raw stránky s tímto profilem si změnu aplikují hned.
    broadcast('raw-settings', { id: id.data, settings: body.data, updatedAt: now.toISOString() });
    req.log.info({ id: id.data, keys: Object.keys(body.data) }, 'raw profile saved');
    return { ok: true, id: id.data, updatedAt: now.toISOString() };
  });

  const Channel = z.string().regex(CHANNEL_RE);

  /** Seznam instancí kanálu: [{ id, name, updatedAt }] (od nejstarší) — jen streamer / mod. */
  app.get<{ Querystring: { channel?: string } }>('/raw-profiles', { preHandler: requireWebSession }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const ch = Channel.safeParse(String(req.query.channel || '').toLowerCase());
    if (!ch.success) return reply.code(400).send({ ok: false, error: 'channel' });
    const can = await canManageChannel(ch.data, req.webAccountId!, accessDeps);
    if (!can.ok) return reply.code(can.status).send({ ok: false, error: can.error });
    const rows = await db.select({ id: rawProfiles.id, settings: rawProfiles.settings, updatedAt: rawProfiles.updatedAt }).from(rawProfiles)
      .where(eq(rawProfiles.channel, ch.data)).orderBy(asc(rawProfiles.createdAt));
    return { ok: true, channel: ch.data, instances: rows.map((r) => ({ id: r.id, name: typeof r.settings?.name === 'string' ? r.settings.name : '', updatedAt: r.updatedAt })) };
  });

  /** Nová instance kanálu (id vygeneruje server) s volitelným nastavením (kopie) — jen streamer / mod. */
  app.post<{ Body: unknown }>('/raw-profiles', { preHandler: requireWebSession }, async (req, reply) => {
    if (!writeLimiter.allow(req.ip)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const b = (req.body && typeof req.body === 'object' ? req.body : {}) as { channel?: unknown; settings?: unknown };
    const ch = Channel.safeParse(String(b.channel || '').toLowerCase());
    const settings = RawSettings.safeParse(b.settings ?? {});
    if (!ch.success || !settings.success) return reply.code(400).send({ ok: false, error: 'bad_request' });
    const can = await canManageChannel(ch.data, req.webAccountId!, accessDeps);
    if (!can.ok) return reply.code(can.status).send({ ok: false, error: can.error });
    const id = randomBytes(16).toString('hex');
    const now = new Date();
    await db.insert(rawProfiles).values({ id, settings: settings.data, channel: ch.data, claimedBy: req.webAccountId!, createdAt: now, updatedAt: now });
    req.log.info({ id, channel: ch.data, accountId: req.webAccountId }, 'raw profile created');
    return { ok: true, id, channel: ch.data };
  });

  /** Smazat instanci (OBS zdroj s její adresou pak ukazuje výchozí vzhled) — jen streamer / mod. */
  app.delete<{ Params: { id: string } }>('/raw-profiles/:id', { preHandler: requireWebSession }, async (req, reply) => {
    if (!writeLimiter.allow(req.ip)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const id = Id.safeParse(req.params.id);
    if (!id.success) return reply.code(400).send({ ok: false, error: 'bad_id' });
    const cur = await db.select({ channel: rawProfiles.channel }).from(rawProfiles).where(eq(rawProfiles.id, id.data)).limit(1);
    const can = await canEditProfile(cur[0] ?? null, req.webAccountId!, accessDeps);
    if (!can.ok) return reply.code(can.status).send({ ok: false, error: can.error });
    await db.delete(rawProfiles).where(eq(rawProfiles.id, id.data));
    req.log.info({ id: id.data, channel: cur[0]!.channel, accountId: req.webAccountId }, 'raw profile deleted');
    return { ok: true, id: id.data };
  });
}
