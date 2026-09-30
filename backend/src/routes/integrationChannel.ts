// Správa kanálu streamera pro Židolištu (2026-09-30, lib/channelManage.ts):
//   GET  /integrations/:slug/channel/status                          { twitch: {linked, canSetCategory, login}, kick: {…} }
//   GET  /integrations/:slug/channel/categories?platform=&q=          hledání kategorií (app token)
//   POST /integrations/:slug/channel/category { platform, categoryId?, name?, query? }
//        → { ok, category:{id,name} } | 4xx { ok:false, error: not_linked|missing_scope|token|not_found|… }
// Auth: inboundAuthorized (X-Api-Key + podpis). Kanál JEN ze slugu (registr Židolišty).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { inboundAuthorized } from '../lib/inboundAuth.js';
import { workspaceBySlug } from '../lib/zidolista.js';
import { ChannelError, channelStatus, searchCategories, setCategory, setCategoryByQuery, type CategoryPlatform } from '../lib/channelManage.js';

const PlatformQ = z.enum(['twitch', 'kick']);
const SetBody = z.object({
  platform: PlatformQ,
  categoryId: z.string().min(1).max(64).optional(),
  name: z.string().max(200).optional(),
  query: z.string().min(1).max(100).optional(),
}).refine((b) => !!b.categoryId || !!b.query, { message: 'categoryId or query' });

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
