// Integrace pro Židolištu — chat bot (spec docs/superpowers/specs/2026-09-22-zidolista-chat-bot-design.md).
//
//   GET    /integrations/chat/stream          SSE zpráv pro namapované workspacy (Last-Event-ID replay)
//   POST   /bot/send                          poslat zprávu jako bot workspace (kanál ze slugu = izolace)
//   POST   /integrations/bot/link-token       jednorázový odkaz pro napojení účtu bota (OAuth kind:'bot')
//   GET    /bot/link/:token                   → 302 na consent providera (bez klíče, token je tajemství)
//   GET    /integrations/bot/status?workspace=
//   DELETE /integrations/bot/identity         { workspace, platform }
//
// Vše kromě /bot/link/:token chce X-Api-Key = ZIDOLISTA_API_KEY (stejný klíč jako /commands/invalidate).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { keyMatches } from './commands.js';
import { RateLimiter } from './chat.js';
import { signState, type StateInput } from '../lib/session.js';
import * as twitch from '../lib/oauthTwitch.js';
import * as youtube from '../lib/oauthYoutube.js';
import * as kick from '../lib/oauthKick.js';
import type { IdentityInfo, TokenSet } from '../lib/webAuth.js';
import { SHARED, upsertBotIdentity, deleteBotIdentity, botStatus, upsertChannelGrant, deleteChannelGrant } from '../lib/botIdentities.js';
import { workspaceBySlug, workspacesSource, type Platform } from '../lib/zidolista.js';
import { sendAsBot, BotSendError } from '../lib/botSend.js';
import { subscribeIntegration, integrationStreamStats } from '../sse/integrationStream.js';
import type { Ingest } from '../ingest/index.js';

const PlatformEnum = z.enum(['twitch', 'kick', 'youtube']);
const Slug = z.string().regex(/^[a-z0-9_-]{1,40}$/i);
const SendBody = z.object({
  workspace: Slug,
  platform: PlatformEnum,
  text: z.string().min(1).max(480),
  replyTo: z.string().max(200).optional().nullable(),
  idempotencyKey: z.string().min(8).max(100),
});
const LinkTokenBody = z.object({
  workspace: Slug,
  platform: PlatformEnum,
  returnTo: z.string().url(),
  // Očekávaný login bota (např. "joukibot"): naváže-li se jiný účet, neuloží se (ochrana proti
  // omylu — uživatel v popupu odklikne Authorize u svého osobního účtu, 2026-09-22).
  expectLogin: z.string().regex(/^@?[A-Za-z0-9_.-]{1,60}$/).optional(),
  // 'broadcaster' = streamer povoluje bota ve svém kanálu (Twitch channel:bot → odznak „Chat Bot");
  // účet se musí shodovat s Twitch kanálem workspace, token se neukládá.
  kind: z.enum(['bot', 'broadcaster']).optional(),
});
const IdentityBody = z.object({ workspace: Slug, platform: PlatformEnum });

function allowedReturnOrigins(): string[] {
  return config.ZIDOLISTA_RETURN_ORIGINS.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}
export function isAllowedBotReturnTo(url: string): boolean {
  try { const u = new URL(url); return !u.username && !u.password && allowedReturnOrigins().includes(u.origin); } catch { return false; }
}

// ---- jednorázové link tokeny (in-memory; jeden proces) ----
interface LinkToken { workspace: string; platform: Platform; returnTo: string; expectLogin?: string; kind: 'bot' | 'broadcaster'; exp: number }
const linkTokens = new Map<string, LinkToken>();
const LINK_TTL_MS = 10 * 60_000;
function sweepLinkTokens(): void { const now = Date.now(); for (const [k, v] of linkTokens) if (v.exp < now) linkTokens.delete(k); }

// ---- idempotence /bot/send ----
interface SentEntry { status: number; body: object; at: number }
const sent = new Map<string, SentEntry>();
const SENT_TTL_MS = 10 * 60_000;
function sweepSent(): void { const now = Date.now(); for (const [k, v] of sent) if (now - v.at > SENT_TTL_MS) sent.delete(k); }

/** Po OAuth callbacku (kind:'bot'): uložit identitu bota workspace a vrátit se do Židolišty. */
export async function completeBotCallback(req: FastifyRequest, reply: FastifyReply, platform: Platform, payload: { returnTo?: string; workspace?: string; expectLogin?: string; botKind?: 'bot' | 'broadcaster' }, identity: IdentityInfo, tokens: TokenSet) {
  const workspace = String(payload.workspace || '').toLowerCase();
  const returnTo = payload.returnTo && isAllowedBotReturnTo(payload.returnTo) ? payload.returnTo : allowedReturnOrigins()[0];
  if (!workspace) return reply.redirect(`${returnTo}#bot_error=${encodeURIComponent('missing workspace')}`, 302);
  if (payload.botKind === 'broadcaster') {
    // Souhlas broadcastera: musí to být účet kanálu workspace; token zahodit (Twitch si souhlas pamatuje).
    const ws = await workspaceBySlug(workspace);
    const expected = ws?.channels[platform] || '';
    if (!expected || expected !== identity.login.toLowerCase()) {
      req.log.warn({ platform, workspace, expected, got: identity.login }, 'bot channel grant: wrong account, not saved');
      return reply.redirect(`${returnTo}#bot_error=${encodeURIComponent(`wrong_account:${identity.login}`)}`, 302);
    }
    await upsertChannelGrant(workspace, platform, identity);
    req.log.info({ platform, workspace, login: identity.login }, 'bot channel grant saved');
    return reply.redirect(`${returnTo}#bot_channel_granted=${platform}:${encodeURIComponent(identity.login)}`, 302);
  }
  const expect = String(payload.expectLogin || '').replace(/^@/, '').toLowerCase();
  if (expect && expect !== identity.login.toLowerCase()) {
    req.log.warn({ platform, workspace, expect, got: identity.login }, 'bot link: wrong account, not saved');
    return reply.redirect(`${returnTo}#bot_error=${encodeURIComponent(`wrong_account:${identity.login}`)}`, 302);
  }
  await upsertBotIdentity(workspace, platform, identity, tokens);
  req.log.info({ platform, workspace, login: identity.login }, 'bot identity linked');
  return reply.redirect(`${returnTo}#bot_linked=${platform}:${encodeURIComponent(identity.login)}`, 302);
}

export function botErrorRedirect(reply: FastifyReply, returnTo: string | undefined, message: string) {
  const target = returnTo && isAllowedBotReturnTo(returnTo) ? returnTo : allowedReturnOrigins()[0];
  return reply.redirect(`${target}#bot_error=${encodeURIComponent(message)}`, 302);
}

export default async function integrationRoutes(app: FastifyInstance, opts: { ingest?: Ingest }) {
  const sendLimiter = new RateLimiter(5, 1); // per workspace: 5 najednou, doplňuje 1/s
  const auth = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (keyMatches(req.headers['x-api-key'])) return true;
    void reply.code(401).send({ ok: false, error: 'unauthorized' });
    return false;
  };

  // ---- SSE stream zpráv ----
  app.get<{ Querystring: { lastEventId?: string } }>('/integrations/chat/stream', async (req, reply) => {
    if (!auth(req, reply)) return reply;
    const hdr = req.headers['last-event-id'];
    const rawLast = (Array.isArray(hdr) ? hdr[0] : hdr) ?? req.query.lastEventId;
    const last = rawLast != null && /^\d+$/.test(String(rawLast)) ? Number(rawLast) : null;
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    subscribeIntegration(reply, last);
    req.log.info({ ip: req.ip, last, ...integrationStreamStats(), workspaces: workspacesSource() }, 'integration chat stream: connected');
    return reply;
  });

  // ---- poslat jako bot ----
  app.post<{ Body: z.infer<typeof SendBody> }>('/bot/send', async (req, reply) => {
    if (!auth(req, reply)) return reply;
    const body = SendBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: 'body', issues: body.error.issues.map((i) => i.path.join('.')) });
    const { workspace, platform, text, replyTo, idempotencyKey } = body.data;
    const slug = workspace.toLowerCase();
    sweepSent();
    const key = `${slug}:${idempotencyKey}`;
    const dup = sent.get(key);
    if (dup) return reply.code(409).send({ ok: false, error: 'duplicate', first: dup.body });
    if (!sendLimiter.allow(slug)) return reply.code(429).send({ ok: false, error: 'rate_limited', retryAfterMs: 1000 });
    try {
      const r = await sendAsBot({ workspace: slug, platform, text, replyTo: replyTo || null }, { ingest: opts.ingest, log: req.log });
      const out = { ok: true, id: r.id, channel: r.channel, login: r.login, identity: r.identity, badge: r.badge };
      sent.set(key, { status: 202, body: out, at: Date.now() });
      req.log.info({ workspace: slug, platform, channel: r.channel, login: r.login, identity: r.identity, badge: r.badge, id: r.id, len: r.text.length }, 'bot send');
      return reply.code(202).send(out);
    } catch (e) {
      const err = e instanceof BotSendError ? e : new BotSendError((e as Error).message, 502, 'send_failed');
      req.log.warn({ workspace: slug, platform, status: err.status, code: err.code, err: err.message }, 'bot send failed');
      // `detail` = surový důvod platformy (Twitch drop_reason code/message, HTTP tělo), ať Židolišta nemusí chodit do logu.
      return reply.code(err.status).send({ ok: false, error: err.code, message: err.message, detail: err.message });
    }
  });

  // ---- napojení účtu bota: jednorázový odkaz → OAuth ----
  app.post<{ Body: z.infer<typeof LinkTokenBody> }>('/integrations/bot/link-token', async (req, reply) => {
    if (!auth(req, reply)) return reply;
    const body = LinkTokenBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: 'body' });
    const workspace = body.data.workspace.toLowerCase();
    const kind = body.data.kind || 'bot';
    if (!isAllowedBotReturnTo(body.data.returnTo)) return reply.code(400).send({ ok: false, error: 'returnTo origin not allowed' });
    if (workspace !== SHARED && !(await workspaceBySlug(workspace))) return reply.code(404).send({ ok: false, error: 'unknown_workspace' });
    if (kind === 'broadcaster') {
      if (workspace === SHARED) return reply.code(400).send({ ok: false, error: 'broadcaster grant needs a workspace' });
      if (body.data.platform !== 'twitch') return reply.code(400).send({ ok: false, error: 'broadcaster grant is twitch only' });
      if (!(await workspaceBySlug(workspace))?.channels.twitch) return reply.code(400).send({ ok: false, error: 'workspace has no twitch channel' });
    }
    sweepLinkTokens();
    const token = randomBytes(24).toString('base64url');
    const exp = Date.now() + LINK_TTL_MS;
    linkTokens.set(token, { workspace, platform: body.data.platform, returnTo: body.data.returnTo, expectLogin: body.data.expectLogin, kind, exp });
    return { ok: true, url: `${config.PUBLIC_BASE_URL.replace(/\/$/, '')}/bot/link/${token}`, expiresAt: new Date(exp).toISOString() };
  });

  app.get<{ Params: { token: string } }>('/bot/link/:token', async (req, reply) => {
    sweepLinkTokens();
    const t = linkTokens.get(req.params.token);
    if (t) linkTokens.delete(req.params.token);
    if (!t) { reply.type('text/html'); return '<!doctype html><meta charset="utf-8"><p style="font-family:system-ui;padding:40px">Odkaz pro napojení bota je neplatný nebo vypršel. Vygeneruj v Židolištce nový.</p>'; }
    const state: StateInput = { platform: t.platform, kind: 'bot', workspace: t.workspace, returnTo: t.returnTo, expectLogin: t.expectLogin, botKind: t.kind };
    if (t.platform === 'twitch') {
      if (!twitch.twitchConfigured()) return botErrorRedirect(reply, t.returnTo, 'Twitch OAuth not configured');
      const scopes = t.kind === 'broadcaster' ? twitch.BROADCASTER_BOT_SCOPES : twitch.BOT_SCOPES;
      return reply.redirect(twitch.buildAuthorizeUrl(signState(state), scopes), 302);
    }
    if (t.platform === 'youtube') {
      if (!youtube.youtubeConfigured()) return botErrorRedirect(reply, t.returnTo, 'YouTube OAuth not configured');
      // Bot = jiný Google účet než ten přihlášený → nechat vybrat účet (select_account).
      const url = youtube.buildAuthorizeUrl(signState(state), youtube.WEB_SCOPES).replace('prompt=consent', 'prompt=consent%20select_account');
      return reply.redirect(url, 302);
    }
    if (!kick.kickConfigured()) return botErrorRedirect(reply, t.returnTo, 'Kick OAuth not configured');
    const pkce = kick.generatePkcePair();
    return reply.redirect(kick.buildAuthorizeUrl(signState({ ...state, codeVerifier: pkce.verifier }), pkce.challenge, kick.WEB_SCOPES), 302);
  });

  // ---- stav + odpojení ----
  app.get<{ Querystring: { workspace?: string } }>('/integrations/bot/status', async (req, reply) => {
    if (!auth(req, reply)) return reply;
    const ws = Slug.safeParse(req.query.workspace || '');
    if (!ws.success) return reply.code(400).send({ ok: false, error: 'workspace' });
    const s = await botStatus(ws.data.toLowerCase());
    return { ok: true, workspace: ws.data.toLowerCase(), ...s };
  });

  app.delete<{ Body: z.infer<typeof IdentityBody> & { kind?: string } }>('/integrations/bot/identity', async (req, reply) => {
    if (!auth(req, reply)) return reply;
    const body = IdentityBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: 'body' });
    const ws = body.data.workspace.toLowerCase();
    // kind: 'broadcaster' = zrušit jen záznam souhlasu s botem v kanálu (odvolání práv dělá streamer u Twitche).
    const removed = req.body?.kind === 'broadcaster' ? await deleteChannelGrant(ws, body.data.platform) : await deleteBotIdentity(ws, body.data.platform);
    req.log.info({ workspace: ws, platform: body.data.platform, kind: req.body?.kind || 'bot', removed }, 'bot identity unlinked');
    return { ok: true, removed };
  });
}
