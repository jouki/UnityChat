// Moderace z Chat Logu v dashboardu Židolišty (rozhodnutí usera 2026-09-25): Židolišta volá API
// UnityChatu, UnityChat maže botem workspace / skrývá jen v UC a rozešle události všem klientům
// (SSE /nicknames/stream) i zpět do integračního streamu (chat.deleted / chat.hidden / chat.unhidden).
//
//   POST /integrations/:slug/moderation/delete { platform, messageId, actor }
//   POST /integrations/:slug/moderation/hide   { platform, messageId, actor }
//   POST /integrations/:slug/moderation/unhide { platform, messageId, actor }
//
// Auth: inboundAuthorized (X-Api-Key + HMAC, lib/inboundAuth.ts). Kanál se odvozuje JEN ze slugu
// (ws.channels.twitch = UC kanál) a zpráva musí patřit kanálu workspace na své platformě —
// workspace nesmí moderovat cizí kanál ani s platným klíčem.
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { messages, moderationActions, type NewModerationAction } from '../db/schema.js';
import { inboundAuthorized } from '../lib/inboundAuth.js';
import { workspaceBySlug, type Platform, type WorkspaceInfo } from '../lib/zidolista.js';
import { publishDeleted, type PublishDeletedParams } from '../lib/messageDeletes.js';
import { publishHidden, publishUnhidden, type HideParams, type HideResult } from '../lib/messageHides.js';
import { deletePlatformMessage, type ModResult } from '../lib/modActions.js';
import { normPlatformChannel } from '../lib/ucChannel.js';
import { resultRecord } from './moderation.js';
import { RateLimiter } from './chat.js';

export const IntegrationModBody = z.object({
  platform: z.enum(['twitch', 'kick', 'youtube']),
  messageId: z.string().min(1).max(128),
  actor: z.object({
    source: z.literal('zidolista'),
    userId: z.string().min(1).max(64),
    name: z.string().min(1).max(80),
    role: z.string().min(1).max(40),
  }),
});

export type IntegrationModAction = 'delete' | 'hide' | 'unhide';

type Log = { warn: (o: object, m: string) => void; info: (o: object, m: string) => void };

export interface IntegrationModDeps {
  workspaceBySlug: (slug: string) => Promise<WorkspaceInfo | null>;
  /** messages.channel zprávy (platformní kanál), null = v archivu není. */
  messageChannel: (platform: Platform, messageId: string) => Promise<string | null>;
  publishDeleted: (p: PublishDeletedParams) => Promise<void>;
  deleteAsBot: (p: { channel: string; platform: Platform; messageId: string }) => Promise<ModResult>;
  publishHidden: (p: HideParams) => Promise<HideResult>;
  publishUnhidden: (p: HideParams) => Promise<HideResult>;
  recordAction: (v: NewModerationAction) => Promise<void>;
  log: Log;
}

type Out = { status: number; body: Record<string, unknown> };

/** Jádro tří endpointů (bez HTTP/auth) — testovatelné s injektovanými deps. */
export async function runIntegrationModeration(action: IntegrationModAction, slug: string, rawBody: unknown, deps: IntegrationModDeps): Promise<Out> {
  const parsed = IntegrationModBody.safeParse(rawBody);
  if (!parsed.success) return { status: 400, body: { ok: false, error: 'body' } };
  const { platform, messageId, actor } = parsed.data;

  const ws = await deps.workspaceBySlug(slug.toLowerCase());
  if (!ws) return { status: 404, body: { ok: false, error: 'unknown_workspace' } };
  const channel = ws.channels.twitch;
  if (!channel) return { status: 404, body: { ok: false, error: 'no_channel' } };

  // Zpráva musí být v archivu kanálu workspace na své platformě (registr = to, co ingest ukládá).
  const want = ws.channels[platform];
  const got = await deps.messageChannel(platform, messageId);
  if (!want || !got || normPlatformChannel(got) !== normPlatformChannel(want)) {
    deps.log.info({ workspace: ws.slug, platform, action }, 'integration moderation: zpráva mimo workspace');
    return { status: 200, body: { ok: true, result: action === 'delete' ? 'error:not_found' : 'not_found' } };
  }

  const by = `zidolista:${actor.userId}`;
  const record = async (result: Record<string, unknown>) => {
    try {
      await deps.recordAction({ channel, accountId: null, actor: by, action, platform, targetMessageId: messageId, params: { actor }, result });
    } catch (e) {
      deps.log.warn({ err: (e as Error).message }, 'integration moderation: zápis do moderation_actions selhal');
    }
  };

  if (action === 'delete') {
    // SSE hned — klienti skryjí zprávu okamžitě, nečekají na platformu.
    await deps.publishDeleted({ channel, platform, messageId, by, reason: 'mod' });
    // Chyba platformy po SSE nesmí být 500 — deletePlatformMessage chyby balí do ModResult, catch je pojistka.
    let result: ModResult;
    try { result = await deps.deleteAsBot({ channel, platform, messageId }); }
    catch (e) {
      deps.log.warn({ platform, err: (e as Error).message }, 'integration moderation: mazání botem vyhodilo výjimku');
      result = 'error:exception';
    }
    await record(resultRecord(platform, result));
    return { status: 200, body: { ok: true, result } };
  }

  const p = { channel, platform, messageId, by };
  const result = action === 'hide' ? await deps.publishHidden(p) : await deps.publishUnhidden(p);
  await record({});
  return { status: 200, body: { ok: true, result } };
}

async function messageChannel(platform: Platform, messageId: string): Promise<string | null> {
  const rows = await db
    .select({ channel: messages.channel })
    .from(messages)
    .where(and(eq(messages.platform, platform), eq(messages.platformMessageId, messageId)))
    .limit(1);
  return rows[0]?.channel ?? null;
}

export default async function integrationModerationRoutes(app: FastifyInstance) {
  const limiter = new RateLimiter(20, 5); // per workspace — Chat Log může mazat dávkou, ale ne bez konce
  const deps: IntegrationModDeps = {
    workspaceBySlug,
    messageChannel,
    publishDeleted: (p) => publishDeleted(p),
    deleteAsBot: (p) => deletePlatformMessage({ accountId: null, ...p }, { log: app.log }),
    publishHidden: (p) => publishHidden(p),
    publishUnhidden: (p) => publishUnhidden(p),
    recordAction: async (v) => { await db.insert(moderationActions).values(v); },
    log: app.log,
  };

  for (const action of ['delete', 'hide', 'unhide'] as const) {
    app.post<{ Params: { slug: string } }>(`/integrations/:slug/moderation/${action}`, async (req, reply) => {
      if (!inboundAuthorized(req, reply)) return reply;
      const slug = String(req.params.slug || '').toLowerCase();
      if (!limiter.allow(slug)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
      const out = await runIntegrationModeration(action, slug, req.body, deps);
      if (out.status === 200) req.log.info({ workspace: slug, action, platform: (req.body as { platform?: string })?.platform, result: out.body.result }, 'integration moderation');
      return reply.code(out.status).send(out.body);
    });
  }
}
