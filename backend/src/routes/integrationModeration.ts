// Moderace z Chat Logu v dashboardu Židolišty (rozhodnutí usera 2026-09-25): Židolišta volá API
// UnityChatu, UnityChat maže botem workspace / skrývá jen v UC a rozešle události všem klientům
// (SSE /nicknames/stream) i zpět do integračního streamu (chat.deleted / chat.hidden / chat.unhidden).
//
//   POST /integrations/:slug/moderation/delete { platform, messageId, actor }
//   POST /integrations/:slug/moderation/hide   { platform, messageId, actor }
//   POST /integrations/:slug/moderation/unhide { platform, messageId, actor }
//   POST /integrations/:slug/moderation/timeout { platform, userId, durationSec, reason?, actor }   (část 2)
//   POST /integrations/:slug/moderation/ban     { platform, userId, reason?, actor }
//   POST /integrations/:slug/moderation/unban   { platform, userId, actor }
//   (timeout/ban/unban jen botem workspace, na všech platformách workspace, kde uživatele známe)
//
// Auth: inboundAuthorized (X-Api-Key + HMAC, lib/inboundAuth.ts). Kanál se odvozuje JEN ze slugu
// (ws.channels.twitch = UC kanál) a zpráva musí patřit kanálu workspace na své platformě —
// workspace nesmí moderovat cizí kanál ani s platným klíčem.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { moderationActions, type NewModerationAction } from '../db/schema.js';
import { inboundAuthorized } from '../lib/inboundAuth.js';
import { workspaceBySlug, type Platform, type WorkspaceInfo } from '../lib/zidolista.js';
import { publishDeleted, archivedMessageChannel, channelMatches, type PublishDeletedParams } from '../lib/messageDeletes.js';
import { publishHidden, publishUnhidden, type HideParams, type HideResult } from '../lib/messageHides.js';
import { deletePlatformMessage, banPlatformUser, unbanUser, type ModResult, type ModDeps } from '../lib/modActions.js';
import { resultRecord } from './moderation.js';
import { runUserAction, type UserActionDeps } from '../lib/userModActions.js';
import { resolveUserTargets, dbTargetDeps, makeTargetRole } from '../lib/moderationTargets.js';
import { publishUserModerated, recordBan, clearBan, activeBan, expectEcho, forgetEcho } from '../lib/userModeration.js';
import type { Ingest } from '../ingest/index.js';
import { RateLimiter } from './chat.js';

export const ActorSchema = z.object({
  source: z.literal('zidolista'),
  userId: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  role: z.string().min(1).max(40),
});

export const IntegrationModBody = z.object({
  platform: z.enum(['twitch', 'kick', 'youtube']),
  messageId: z.string().min(1).max(128),
  actor: ActorSchema,
});

/** Max délka timeoutu z Chat Logu = Twitch limit 14 dní (Kick se zaokrouhlí na minuty). */
export const MAX_TIMEOUT_SEC = 1_209_600;

export const IntegrationUserModBody = z.object({
  platform: z.enum(['twitch', 'kick', 'youtube']),
  userId: z.string().min(1).max(64),
  login: z.string().max(60).optional(),
  durationSec: z.number().int().min(1).max(MAX_TIMEOUT_SEC).optional(),
  reason: z.string().trim().max(500).optional(),
  actor: ActorSchema,
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
  if (!channelMatches(got, want)) {
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
    await deps.publishDeleted({ channel, platform, messageId, by, reason: 'mod', expectedChannel: got! });
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

export type IntegrationUserModAction = 'timeout' | 'ban' | 'unban';

/** Aktér Židolišty v roli majitele workspace = streamer (smí i na mody). Role ověřuje Židolišta (HMAC). */
export const isOwnerRole = (role: string): boolean => ['owner', 'broadcaster', 'streamer'].includes(role.toLowerCase());

export interface IntegrationUserModDeps {
  workspaceBySlug: (slug: string) => Promise<WorkspaceInfo | null>;
  /** Deps akce vázané na workspace (kanály platforem i bot JEN z tohoto workspace). */
  userActionDeps: (ws: WorkspaceInfo) => UserActionDeps;
}

/**
 * Timeout / ban / unban z Chat Logu Židolišty. Kanál JEN ze slugu (ws.channels.twitch = UC kanál),
 * cíl musí být v archivu platformního kanálu workspace, akce jen botem workspace (accountId null).
 */
export async function runIntegrationUserModeration(action: IntegrationUserModAction, slug: string, rawBody: unknown, deps: IntegrationUserModDeps): Promise<Out> {
  const parsed = IntegrationUserModBody.safeParse(rawBody);
  if (!parsed.success) return { status: 400, body: { ok: false, error: 'body' } };
  const b = parsed.data;
  if (action === 'timeout' && !b.durationSec) return { status: 400, body: { ok: false, error: 'durationSec' } };

  const ws = await deps.workspaceBySlug(slug.toLowerCase());
  if (!ws) return { status: 404, body: { ok: false, error: 'unknown_workspace' } };
  const channel = ws.channels.twitch;
  if (!channel) return { status: 404, body: { ok: false, error: 'no_channel' } };

  const out = await runUserAction({
    channel, accountId: null, by: `zidolista:${b.actor.userId}`, callerIsBroadcaster: isOwnerRole(b.actor.role), platform: b.platform, userId: b.userId,
    action, durationSec: action === 'timeout' ? b.durationSec! : null, reason: b.reason || null,
  }, deps.userActionDeps(ws));
  // Stejně jako mazání (část 1): uživatel mimo kanál workspace = 200 s výsledkem, ne chyba.
  if (out.status === 404) return { status: 200, body: { ok: true, result: 'not_found' } };
  return out;
}

export default async function integrationModerationRoutes(app: FastifyInstance, opts: { ingest?: Ingest } = {}) {
  const limiter = new RateLimiter(20, 5); // per workspace — Chat Log může mazat dávkou, ale ne bez konce
  const deps: IntegrationModDeps = {
    workspaceBySlug,
    messageChannel: archivedMessageChannel,
    publishDeleted: (p) => publishDeleted(p),
    deleteAsBot: (p) => deletePlatformMessage({ accountId: null, ...p }, { log: app.log }),
    publishHidden: (p) => publishHidden(p),
    publishUnhidden: (p) => publishUnhidden(p),
    recordAction: async (v) => { await db.insert(moderationActions).values(v); },
    log: app.log,
  };

  const recordAction = async (v: NewModerationAction) => { await db.insert(moderationActions).values(v); };
  const userDeps: IntegrationUserModDeps = {
    workspaceBySlug,
    userActionDeps: (ws) => {
      // Workspace pevně ze slugu: kanály (cíl, akce) i bot — nikdy podle kanálu z požadavku.
      const modDeps: ModDeps = { log: app.log, workspace: async () => ws, youtubeVideoId: (pch) => opts.ingest?.videoIdFor('youtube', pch) ?? null };
      const targets = dbTargetDeps(async (_channel, platform) => ws.channels[platform]);
      return {
        resolveTargets: (channel, platform, userId) => resolveUserTargets(channel, platform, userId, targets),
        targetRole: makeTargetRole(targets.platformChannel),
        publish: (p) => publishUserModerated(p),
        expectEcho: (k) => expectEcho(k),
        forgetEcho,
        ban: (p) => banPlatformUser({ ...p, accountId: null }, modDeps),
        unban: (p) => unbanUser({ ...p, accountId: null }, modDeps),
        activeBan: (channel, platform, userId) => activeBan(channel, platform, userId),
        recordBan, clearBan, recordAction,
        now: Date.now,
        log: app.log,
      };
    },
  };

  for (const action of ['timeout', 'ban', 'unban'] as const) {
    app.post<{ Params: { slug: string } }>(`/integrations/:slug/moderation/${action}`, async (req, reply) => {
      if (!inboundAuthorized(req, reply)) return reply;
      const slug = String(req.params.slug || '').toLowerCase();
      if (!limiter.allow(slug)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
      const out = await runIntegrationUserModeration(action, slug, req.body, userDeps);
      if (out.status === 200) req.log.info({ workspace: slug, action, platform: (req.body as { platform?: string })?.platform, results: out.body.results ?? out.body.result }, 'integration user moderation');
      return reply.code(out.status).send(out.body);
    });
  }

  // Stav trestu uživatele pro Chat Log (Unban jen u potrestaných). GET = podpis nad prázdným tělem.
  app.get<{ Params: { slug: string }; Querystring: { platform?: string; userId?: string } }>('/integrations/:slug/moderation/user-state', async (req, reply) => {
    if (!inboundAuthorized(req, reply)) return reply;
    reply.header('Cache-Control', 'no-store');
    const slug = String(req.params.slug || '').toLowerCase();
    if (!limiter.allow(slug)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const platform = String(req.query.platform || '');
    const userId = String(req.query.userId || '').slice(0, 64);
    if (!['twitch', 'kick', 'youtube'].includes(platform) || !userId) return reply.code(400).send({ ok: false, error: 'query' });
    const ws = await workspaceBySlug(slug);
    const channel = ws?.channels.twitch?.toLowerCase();
    if (!ws) return reply.code(404).send({ ok: false, error: 'unknown_workspace' });
    if (!channel) return reply.code(404).send({ ok: false, error: 'no_channel' });
    let ban: Awaited<ReturnType<typeof activeBan>> = null;
    try { ban = await activeBan(channel, platform as Platform, userId); }
    catch (e) { req.log.warn({ err: (e as Error).message }, 'integration user-state: dotaz selhal'); }
    return { ok: true, banned: !!ban, until: ban?.until ? ban.until.getTime() : null };
  });

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
