// Správa kanálu streamera pro Židolištu (2026-09-30, lib/channelManage.ts):
//   GET  /integrations/:slug/channel/status                          { twitch: {linked, canSetCategory, login}, kick: {…} }
//   GET  /integrations/:slug/channel/categories?platform=&q=          hledání kategorií (app token)
//   POST /integrations/:slug/channel/category { platform, categoryId?, name?, query? }
//        → { ok, category:{id,name} } | 4xx { ok:false, error: not_linked|missing_scope|token|not_found|… }
//   POST /integrations/:slug/channel/title { platform, title (1–140) }  → { ok, title } (náhrada SE !settitle; chyby jako u kategorie)
//   GET  /integrations/:slug/channel/subs?platform=twitch|kick          { ok, count:number|null, points?:number|null }
//        (%subs_twitch% v Židolištce, dotaz 1× / 10 min; Kick → count:null; chyby jako u kategorií)
//   GET  /integrations/:slug/channel/followage?platform=twitch|kick&userId=&login=
//        { ok, following:boolean, followedAt:ISO|null }  (!followage; Twitch userId nebo login, Kick login; chyby jako u kategorií + bad_user / not_found)
// Auth: inboundAuthorized (X-Api-Key + podpis). Kanál JEN ze slugu (registr Židolišty).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inboundAuthorized } from '../lib/inboundAuth.js';
import { workspaceBySlug } from '../lib/zidolista.js';
import { ChannelError, channelStatus, followage, searchCategories, setCategory, setCategoryByQuery, setTitle, subCount, TITLE_MAX, type CategoryPlatform } from '../lib/channelManage.js';

const PlatformQ = z.enum(['twitch', 'kick']);
const SetBody = z.object({
  platform: PlatformQ,
  categoryId: z.string().min(1).max(64).optional(),
  name: z.string().max(200).optional(),
  query: z.string().min(1).max(100).optional(),
}).refine((b) => !!b.categoryId || !!b.query, { message: 'categoryId or query' });
const TitleBody = z.object({ platform: PlatformQ, title: z.string().trim().min(1).max(TITLE_MAX) });

export default async function integrationChannelRoutes(app: FastifyInstance) {
  app.get<{ Params: { slug: string } }>('/integrations/:slug/channel/status', async (req, reply) => {
    if (!inboundAuthorized(req, reply)) return reply;
    const ws = await workspaceBySlug(req.params.slug);
    if (!ws) return reply.code(404).send({ ok: false, error: 'workspace_not_found' });
    return { ok: true, ...(await channelStatus(ws.channels)) };
  });

  app.get<{ Params: { slug: string }; Querystring: { platform?: string; q?: string } }>('/integrations/:slug/channel/categories', async (req, reply) => {
    if (!inboundAuthorized(req, reply)) return reply;
    const p = PlatformQ.safeParse(req.query.platform);
    if (!p.success) return reply.code(400).send({ ok: false, error: 'platform' });
    const ws = await workspaceBySlug(req.params.slug);
    if (!ws) return reply.code(404).send({ ok: false, error: 'workspace_not_found' });
    try {
      return { ok: true, categories: await searchCategories(p.data, String(req.query.q ?? '')) };
    } catch (err) {
      req.log.warn({ slug: ws.slug, platform: p.data, err: String((err as Error)?.message ?? err) }, '[channel] hledání kategorií selhalo');
      return reply.code(502).send({ ok: false, error: 'platform' });
    }
  });

  app.post<{ Params: { slug: string } }>('/integrations/:slug/channel/title', async (req, reply) => {
    if (!inboundAuthorized(req, reply)) return reply;
    const b = TitleBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'invalid_body' });
    const ws = await workspaceBySlug(req.params.slug);
    if (!ws) return reply.code(404).send({ ok: false, error: 'workspace_not_found' });
    const login = ws.channels[b.data.platform];
    if (!login) return reply.code(404).send({ ok: false, error: 'no_channel' });
    try {
      const title = await setTitle(b.data.platform, login, b.data.title);
      req.log.info({ slug: ws.slug, platform: b.data.platform, login, title }, '[channel] název streamu nastaven');
      return { ok: true, title };
    } catch (err) {
      if (err instanceof ChannelError) {
        req.log.warn({ slug: ws.slug, platform: b.data.platform, code: err.code, msg: err.message }, '[channel] název nenastaven');
        return reply.code(err.status).send({ ok: false, error: err.code, message: err.message });
      }
      req.log.warn({ slug: ws.slug, platform: b.data.platform, err: String((err as Error)?.message ?? err) }, '[channel] název — chyba');
      return reply.code(502).send({ ok: false, error: 'platform' });
    }
  });

  app.get<{ Params: { slug: string }; Querystring: { platform?: string; userId?: string; login?: string } }>('/integrations/:slug/channel/followage', async (req, reply) => {
    if (!inboundAuthorized(req, reply)) return reply;
    const p = PlatformQ.safeParse(req.query.platform);
    if (!p.success) return reply.code(400).send({ ok: false, error: 'platform' });
    const ws = await workspaceBySlug(req.params.slug);
    if (!ws) return reply.code(404).send({ ok: false, error: 'workspace_not_found' });
    const channelLogin = ws.channels[p.data];
    if (!channelLogin) return reply.code(404).send({ ok: false, error: 'no_channel' });
    reply.header('Cache-Control', 'no-store');
    try {
      const r = await followage(p.data, channelLogin, { userId: req.query.userId, login: req.query.login });
      return { ok: true, following: r.following, followedAt: r.followedAt };
    } catch (err) {
      if (err instanceof ChannelError) {
        req.log.warn({ slug: ws.slug, platform: p.data, code: err.code, msg: err.message }, '[channel] followage nedostupný');
        return reply.code(err.status).send({ ok: false, error: err.code, message: err.message });
      }
      req.log.warn({ slug: ws.slug, platform: p.data, err: String((err as Error)?.message ?? err) }, '[channel] followage — chyba');
      return reply.code(502).send({ ok: false, error: 'platform' });
    }
  });

  app.get<{ Params: { slug: string }; Querystring: { platform?: string } }>('/integrations/:slug/channel/subs', async (req, reply) => {
    if (!inboundAuthorized(req, reply)) return reply;
    const p = PlatformQ.safeParse(req.query.platform);
    if (!p.success) return reply.code(400).send({ ok: false, error: 'platform' });
    const ws = await workspaceBySlug(req.params.slug);
    if (!ws) return reply.code(404).send({ ok: false, error: 'workspace_not_found' });
    const login = ws.channels[p.data];
    if (!login) return reply.code(404).send({ ok: false, error: 'no_channel' });
    reply.header('Cache-Control', 'no-store');
    try {
      const r = await subCount(p.data, login);
      return { ok: true, count: r.count, points: r.points };
    } catch (err) {
      if (err instanceof ChannelError) {
        req.log.warn({ slug: ws.slug, platform: p.data, code: err.code, msg: err.message }, '[channel] počet subů nedostupný');
        return reply.code(err.status).send({ ok: false, error: err.code, message: err.message });
      }
      req.log.warn({ slug: ws.slug, platform: p.data, err: String((err as Error)?.message ?? err) }, '[channel] počet subů — chyba');
      return reply.code(502).send({ ok: false, error: 'platform' });
    }
  });

  app.post<{ Params: { slug: string } }>('/integrations/:slug/channel/category', async (req, reply) => {
    if (!inboundAuthorized(req, reply)) return reply;
    const b = SetBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'invalid_body' });
    const ws = await workspaceBySlug(req.params.slug);
    if (!ws) return reply.code(404).send({ ok: false, error: 'workspace_not_found' });
    const platform: CategoryPlatform = b.data.platform;
    const login = ws.channels[platform];
    if (!login) return reply.code(404).send({ ok: false, error: 'no_channel' });
    try {
      const cat = b.data.categoryId
        ? await setCategory(platform, login, { id: b.data.categoryId, name: b.data.name ?? '', imageUrl: null })
        : await setCategoryByQuery(platform, login, b.data.query!);
      req.log.info({ slug: ws.slug, platform, login, category: cat.name || cat.id }, '[channel] kategorie nastavena');
      return { ok: true, category: { id: cat.id, name: cat.name } };
    } catch (err) {
      if (err instanceof ChannelError) {
        req.log.warn({ slug: ws.slug, platform, code: err.code, msg: err.message }, '[channel] kategorie nenastavena');
        return reply.code(err.status).send({ ok: false, error: err.code, message: err.message });
      }
      req.log.warn({ slug: ws.slug, platform, err: String((err as Error)?.message ?? err) }, '[channel] kategorie — chyba');
      return reply.code(502).send({ ok: false, error: 'platform' });
    }
  });
}
