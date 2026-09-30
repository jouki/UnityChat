// GIF knihovna pro dashboard Židolišty (Task 2, spec docs/superpowers/specs/2026-09-26-gif-knihovna-design.md,
// kontrakt docs/superpowers/plans/2026-09-25-moderace-cast-2-kontrakt.md §Část 4 „GIF knihovna — integrace").
//
//   GET  /integrations/:slug/gifs?q=&cursor=&limit=                         schválené GIFy kanálu + tagy (jako /gifs/library)
//   PUT  /integrations/:slug/gifs/:mediaId/tags { tags, actor? }            úprava tagů (normalizace)
//   GET  /integrations/:slug/gifs/rejected?before=<ms>:<mediaId>            zamítnuté GIFy (jako /moderation/gif/rejected)
//   GET  /integrations/:slug/gifs/{withdrawn|purging}?before=<ms>:<mediaId> zahozené (Stažené / Ke smazání)
//   POST /integrations/:slug/gifs/:mediaId/{approve|vault|purge|ban12h|unapprove|restore|remove-file} { actor?, keepMessages? }
//        purge bez keepMessages = „Zahodit i se zprávami“ (7 dní, restore); keepMessages:true = stažený (remove-file)
//   GET  /integrations/:slug/gifs/duplicates                                návrhy duplikátů (čekající)
//   POST /integrations/:slug/gifs/duplicates/:id/{keep-first|keep-second|keep-both} { actor? }
//   POST /integrations/:slug/gifs/access-token                              integrační token pro zamítnutá média (jen jednou)
//
// Auth: inboundAuthorized (X-Api-Key + podpis, lib/inboundAuth.ts). Kanál JEN ze slugu (registr Židolišty,
// ws.channels.twitch = UC kanál); médium i návrh musí patřit kanálu workspace, jinak 404 (neprozradit existenci).
// Token se vrací jen v odpovědi na vydání, v DB jen hash (lib/gifTokens.ts), nikdy do logu.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { moderationActions } from '../db/schema.js';
import { inboundAuthorized } from '../lib/inboundAuth.js';
import { workspaceBySlug as registryBySlug, type WorkspaceInfo } from '../lib/zidolista.js';
import { MEDIA_ID_RE } from '../lib/gifIds.js';
import { dbGifStore, GIF_MEDIA_ACTIONS, type GifFlow, type GifStore } from '../lib/gifRequests.js';
import { issueIntegrationToken } from '../lib/gifTokens.js';
import {
  dbGifLibraryStore, duplicateView, libraryErrorReply, libraryPage, resolveDuplicate, updateTags, DUPLICATE_ACTIONS, DUPLICATES_PAGE,
  type DuplicateDeps, type GifLibraryStore,
} from '../lib/gifLibrary.js';
import { ActorSchema } from './integrationModeration.js';
import { parseRejectedCursor, rejectedView, discardedPage, parseMediaActionBody, DISCARDED_STATUSES, type MediaServer } from './gif.js';
import { RateLimiter } from './chat.js';

export interface IntegrationGifOpts {
  flow: Pick<GifFlow, 'mediaAction'>;
  media: MediaServer;
  /** Testy; chybí = DB. */
  store?: Pick<GifStore, 'getMedia' | 'listRejected' | 'listDiscarded'>;
  library?: GifLibraryStore;
  workspaceBySlug?: (slug: string) => Promise<WorkspaceInfo | null>;
  /** Ověření požadavku (testy); chybí = inboundAuthorized. true = pustit, jinak odpověď už odešla. */
  authorize?: (req: FastifyRequest, reply: FastifyReply) => boolean;
  issueToken?: (slug: string) => Promise<string>;
  recordAction?: DuplicateDeps['recordAction'];
}

const ActorBody = z.object({ actor: ActorSchema.optional() }).passthrough();
const REJECTED_PAGE = 50;

export default async function integrationGifRoutes(app: FastifyInstance, opts: IntegrationGifOpts) {
  const authorize = opts.authorize ?? ((req: FastifyRequest, reply: FastifyReply) => inboundAuthorized(req, reply));
  const bySlug = opts.workspaceBySlug ?? registryBySlug;
  const store = opts.store ?? dbGifStore;
  const library = opts.library ?? dbGifLibraryStore;
  const issueToken = opts.issueToken ?? ((slug: string) => issueIntegrationToken(slug));
  const limiter = new RateLimiter(30, 10);      // per workspace — dashboard stránkuje a klikne dávkou
  const tokenLimiter = new RateLimiter(5, 0.1); // vydání tokenu (starý se zneplatní)
  const dupDeps: DuplicateDeps = {
    store: library,
    mediaDeleted: (id) => opts.media.forget(id),
    mediaChanged: (id) => opts.media.invalidate(id),
    recordAction: opts.recordAction ?? (async (v) => { await db.insert(moderationActions).values(v); }),
    now: Date.now,
    log: app.log,
  };

  /** Auth + rate limit + slug → UC kanál. null = odpověď už odešla. */
  const gate = async (req: FastifyRequest<{ Params: { slug: string } }>, reply: FastifyReply, lim = limiter): Promise<{ slug: string; channel: string } | null> => {
    if (!authorize(req, reply)) return null;
    reply.header('Cache-Control', 'no-store');
    const slug = String(req.params.slug || '').toLowerCase();
    if (!lim.allow(slug)) { reply.code(429).send({ ok: false, error: 'rate_limited' }); return null; }
    const ws = await bySlug(slug);
    if (!ws) { reply.code(404).send({ ok: false, error: 'unknown_workspace' }); return null; }
    const channel = ws.channels.twitch?.toLowerCase();
    if (!channel) { reply.code(404).send({ ok: false, error: 'no_channel' }); return null; }
    return { slug, channel };
  };
  /** `zidolista:<userId>` z těla (aktér je volitelný); neplatný aktér → null (400). */
  const actorOf = (body: unknown): string | null => {
    const b = ActorBody.safeParse(body ?? {});
    if (!b.success) return null;
    return b.data.actor ? `zidolista:${b.data.actor.userId}` : 'zidolista';
  };
  /** Chybí tabulka / sloupec (SQL ještě neběželo) → 503 not_ready, jiná chyba → 500. */
  const fail = (reply: FastifyReply, e: unknown, what: string) => {
    const out = libraryErrorReply(e);
    app.log.warn({ err: (e as Error).message, error: out.body.error }, `integration gif: ${what} selhalo`);
    return reply.code(out.status).send(out.body);
  };

  app.get<{ Params: { slug: string }; Querystring: { q?: string; cursor?: string; limit?: string } }>('/integrations/:slug/gifs', async (req, reply) => {
    const g = await gate(req, reply);
    if (!g) return reply;
    try { const out = await libraryPage(library, g.channel, req.query); return reply.code(out.status).send(out.body); }
    catch (e) { return fail(reply, e, 'knihovna'); }
  });

  app.put<{ Params: { slug: string; mediaId: string } }>('/integrations/:slug/gifs/:mediaId/tags', async (req, reply) => {
    const g = await gate(req, reply);
    if (!g) return reply;
    if (actorOf(req.body) === null) return reply.code(400).send({ ok: false, error: 'body' });
    try {
      const out = await updateTags(library, g.channel, String(req.params.mediaId || ''), req.body);
      if (out.status === 200) req.log.info({ workspace: g.slug, n: (out.body.tags as string[]).length }, 'integration gif: tagy upraveny');
      return reply.code(out.status).send(out.body);
    } catch (e) { return fail(reply, e, 'tagy'); }
  });

  app.get<{ Params: { slug: string }; Querystring: { before?: string } }>('/integrations/:slug/gifs/rejected', async (req, reply) => {
    const g = await gate(req, reply);
    if (!g) return reply;
    const before = parseRejectedCursor(req.query.before);
    if (before === false) return reply.code(400).send({ ok: false, error: 'before' });
    try {
      const rows = await store.listRejected(g.channel, before, REJECTED_PAGE);
      const items = rows.map(rejectedView);
      const last = items[items.length - 1];
      return reply.send({ ok: true, items, nextBefore: rows.length === REJECTED_PAGE && last?.rejectedAt != null ? `${last.rejectedAt}:${last.mediaId}` : null });
    } catch (e) { return fail(reply, e, 'zamítnuté'); }
  });

  // Zahozené GIFy (Stažené = withdrawn, Ke smazání = purging) jako /moderation/gif/withdrawn|purging.
  for (const status of DISCARDED_STATUSES) {
    app.get<{ Params: { slug: string }; Querystring: { before?: string } }>(`/integrations/:slug/gifs/${status}`, async (req, reply) => {
      const g = await gate(req, reply);
      if (!g) return reply;
      const before = parseRejectedCursor(req.query.before);
      if (before === false) return reply.code(400).send({ ok: false, error: 'before' });
      try { return reply.send(await discardedPage(store, g.channel, status, before)); }
      catch (e) { return fail(reply, e, status === 'withdrawn' ? 'stažené' : 'ke smazání'); }
    });
  }

  app.get<{ Params: { slug: string } }>('/integrations/:slug/gifs/duplicates', async (req, reply) => {
    const g = await gate(req, reply);
    if (!g) return reply;
    try { return reply.send({ ok: true, items: (await library.listDuplicates(g.channel, DUPLICATES_PAGE)).map(duplicateView) }); }
    catch (e) { return fail(reply, e, 'duplicity'); }
  });

  app.post<{ Params: { slug: string; id: string; action: string } }>('/integrations/:slug/gifs/duplicates/:id/:action', async (req, reply) => {
    const g = await gate(req, reply);
    if (!g) return reply;
    const id = Number(req.params.id);
    const action = DUPLICATE_ACTIONS.find((a) => a === req.params.action);
    if (!action || !Number.isSafeInteger(id) || id <= 0) return reply.code(404).send({ ok: false, error: 'not_found' });
    const by = actorOf(req.body);
    if (by === null) return reply.code(400).send({ ok: false, error: 'body' });
    try {
      const out = await resolveDuplicate(dupDeps, { id, action, by, accountId: null, channel: g.channel });
      return reply.code(out.status).send(out.body);
    } catch (e) { return fail(reply, e, 'rozhodnutí o duplikátu'); }
  });

  // Integrační token pro zamítnutá média (`/media/gif/:id?t=`), platí pro kanál workspace; nový zneplatní starý.
  app.post<{ Params: { slug: string } }>('/integrations/:slug/gifs/access-token', async (req, reply) => {
    const g = await gate(req, reply, tokenLimiter);
    if (!g) return reply;
    try {
      const token = await issueToken(g.slug);
      req.log.info({ workspace: g.slug }, 'integration gif: token vydán');
      return reply.send({ ok: true, token });
    } catch (e) { return fail(reply, e, 'vydání tokenu'); }
  });

  app.post<{ Params: { slug: string; mediaId: string; action: string } }>('/integrations/:slug/gifs/:mediaId/:action', async (req, reply) => {
    const g = await gate(req, reply);
    if (!g) return reply;
    const action = GIF_MEDIA_ACTIONS.find((a) => a === req.params.action);
    const mediaId = String(req.params.mediaId || '');
    if (!action || !MEDIA_ID_RE.test(mediaId)) return reply.code(404).send({ ok: false, error: 'not_found' });
    const by = actorOf(req.body);
    // purge: `keepMessages` (boolean); chybí = „Zahodit i se zprávami“ (dnešní dashboard, 7 dní na obnovu).
    const body = parseMediaActionBody(req.body);
    if (by === null || !body) return reply.code(400).send({ ok: false, error: 'body' });
    try {
      // Médium musí patřit kanálu workspace (izolace workspaců).
      const md = await store.getMedia(mediaId);
      if (!md || md.channel !== g.channel) return reply.code(404).send({ ok: false, error: 'not_found' });
      const out = await opts.flow.mediaAction({ mediaId, action, by, accountId: null, keepMessages: body.keepMessages });
      if (out.status === 200) req.log.info({ workspace: g.slug, action }, 'integration gif: akce nad médiem');
      return reply.code(out.status).send(out.body);
    } catch (e) { return fail(reply, e, 'akce nad médiem'); }
  });
}
