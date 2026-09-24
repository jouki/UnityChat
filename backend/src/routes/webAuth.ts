import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { streamers } from '../db/schema.js';
import { config } from '../config.js';
import { signState, type StateInput } from '../lib/session.js';
import { isCryptoReady } from '../lib/crypto.js';
import * as twitch from '../lib/oauthTwitch.js';
import * as youtube from '../lib/oauthYoutube.js';
import * as kick from '../lib/oauthKick.js';
import {
  allowedOrigins, isAllowedReturnTo, issueCode, consumeCode, bearerToken, validateWebSession, deleteWebSession,
  requireWebSession, completeWebLogin, listIdentities, getDecryptedIdentity, storeRefreshedTokens, unlinkIdentity, signOutAccount,
  needsRefresh, type Platform, type IdentityInfo, type TokenSet,
} from '../lib/webAuth.js';
import { outgoingText, sendTwitch, sendKick, sendYoutube, youtubeLiveChatId, SendError } from '../lib/webSend.js';
import { ucSends, markUc, ucReplies, attachUcReply, parseUcReply } from '../lib/ucSends.js';
import { platformChannel } from './chat.js';
import { RateLimiter } from './chat.js';
import type { Ingest } from '../ingest/index.js';

/**
 * Web verze (robdiesalot.com/chat): přihlášení uživatele na Twitch / Kick /
 * YouTube + posílání zpráv jeho tokenem. OAuth callbacky sdílí s streamer
 * flow (/streamers/oauth/:platform/callback — stejné redirect URI registrované
 * u providerů); větvení dělá `kind: 'web'` ve state (routes/oauth.ts →
 * completeWebCallback níže).
 */

const PlatformParam = z.object({ platform: z.enum(['twitch', 'youtube', 'kick']) });
const StartBody = z.object({ returnTo: z.string().url().optional() }).optional();
const ExchangeBody = z.object({ code: z.string().min(8).max(200) });
const SendBody = z.object({
  platform: z.enum(['twitch', 'youtube', 'kick']),
  channel: z.string().regex(/^[a-z0-9_]{1,40}$/i).optional(),
  text: z.string().min(1).max(2000),
  replyTo: z.string().max(200).optional().nullable(),
  /** Login autora zprávy, na kterou se odpovídá — pro záložní „@login text", když platforma odpověď odmítne. */
  replyToUser: z.string().max(60).optional().nullable(),
  /** Odpověď napříč platformami (UnityChat): na kterou zprávu se odpovídá — server ji spáruje s echem. */
  ucReplyTo: z.object({ platform: z.string(), id: z.string(), username: z.string().optional(), message: z.string().optional() }).optional().nullable(),
});

const DEFAULT_CHANNEL = 'robdiesalot';

/** Po OAuth callbacku (kind:'web'): účet + session → jednorázový kód → redirect na web (#uc_code). */
export async function completeWebCallback(
  req: FastifyRequest,
  reply: FastifyReply,
  platform: Platform,
  payload: { returnTo?: string; webAccountId?: number },
  identity: IdentityInfo,
  tokens: TokenSet,
) {
  const returnTo = payload.returnTo && isAllowedReturnTo(payload.returnTo) ? payload.returnTo : `${allowedOrigins()[0]}/chat/`;
  const { accountId, sessionToken } = await completeWebLogin(platform, identity, tokens, payload.webAccountId ?? null);
  const code = issueCode(sessionToken);
  req.log.info({ platform, accountId, login: identity.login, linked: payload.webAccountId != null }, 'web OAuth completed');
  return reply.redirect(`${returnTo}#uc_code=${encodeURIComponent(code)}&uc_platform=${platform}`, 302);
}

/** Chyba ve web flow → zpátky na web s #uc_error (ne HTML stránka jako u streamerů). */
export function webErrorRedirect(reply: FastifyReply, returnTo: string | undefined, message: string) {
  const target = returnTo && isAllowedReturnTo(returnTo) ? returnTo : `${allowedOrigins()[0]}/chat/`;
  return reply.redirect(`${target}#uc_error=${encodeURIComponent(message)}`, 302);
}

export default async function webAuthRoutes(app: FastifyInstance, opts: { ingest?: Ingest }) {
  const sendLimiter = new RateLimiter(5, 1);   // per účet: 5 najednou, doplňuje 1/s
  const startLimiter = new RateLimiter(10, 0.2); // per IP: 10 startů, doplňuje 1 za 5 s

  // ---- start OAuth (web) ----
  app.post<{ Params: { platform: string }; Body: { returnTo?: string } }>('/auth/:platform/start', async (req, reply) => {
    const params = PlatformParam.safeParse(req.params);
    if (!params.success) { reply.code(400); return { ok: false, error: 'platform' }; }
    const body = StartBody.safeParse(req.body ?? {});
    if (!body.success) { reply.code(400); return { ok: false, error: 'returnTo' }; }
    if (!startLimiter.allow(req.ip)) { reply.code(429); return { ok: false, error: 'too many requests' }; }
    if (!isCryptoReady()) { reply.code(503); return { ok: false, error: 'OAuth not configured on server' }; }
    const { platform } = params.data;
    const returnTo = body.data?.returnTo;
    if (returnTo && !isAllowedReturnTo(returnTo)) {
      let origin = '?';
      try { origin = new URL(returnTo).origin; } catch { /* nevalidní URL */ }
      req.log.warn({ origin, platform, ip: req.ip }, 'web auth start: returnTo origin not allowed');
      reply.code(400); return { ok: false, error: 'returnTo origin not allowed' };
    }

    // Přihlášený uživatel napojuje další platformu na svůj účet.
    let webAccountId: number | undefined;
    const raw = bearerToken(req);
    if (raw) { const id = await validateWebSession(raw); if (id !== null) webAccountId = id; }

    const stateInput: StateInput = { platform, kind: 'web', returnTo, webAccountId };
    if (platform === 'twitch') {
      if (!twitch.twitchConfigured()) { reply.code(503); return { ok: false, error: 'Twitch OAuth not configured' }; }
      return { ok: true, url: twitch.buildAuthorizeUrl(signState(stateInput), twitch.WEB_SCOPES) };
    }
    if (platform === 'youtube') {
      if (!youtube.youtubeConfigured()) { reply.code(503); return { ok: false, error: 'YouTube OAuth not configured' }; }
      return { ok: true, url: youtube.buildAuthorizeUrl(signState(stateInput), youtube.WEB_SCOPES) };
    }
    if (!kick.kickConfigured()) { reply.code(503); return { ok: false, error: 'Kick OAuth not configured' }; }
    const pkce = kick.generatePkcePair();
    return { ok: true, url: kick.buildAuthorizeUrl(signState({ ...stateInput, codeVerifier: pkce.verifier }), pkce.challenge, kick.WEB_SCOPES) };
  });

  // ---- jednorázový kód → session token ----
  app.post<{ Body: { code: string } }>('/auth/exchange', async (req, reply) => {
    const body = ExchangeBody.safeParse(req.body);
    if (!body.success) { reply.code(400); return { ok: false, error: 'code' }; }
    const token = consumeCode(body.data.code);
    if (!token) { reply.code(400); return { ok: false, error: 'code invalid or expired' }; }
    return { ok: true, token, expiresInMs: 30 * 24 * 60 * 60 * 1000 };
  });

  // ---- kdo jsem ----
  app.get('/auth/me', { preHandler: requireWebSession }, async (req) => {
    const ids = await listIdentities(req.webAccountId!);
    const platforms: Record<string, unknown> = { twitch: null, youtube: null, kick: null };
    for (const i of ids) platforms[i.platform] = { login: i.login, displayName: i.displayName, avatarUrl: i.avatarUrl };
    return { ok: true, accountId: req.webAccountId, platforms };
  });

  // Odhlásit se = všechny platformy účtu (signOutAccount), ne jen tahle session.
  app.post('/auth/logout', async (req) => {
    const raw = bearerToken(req);
    if (!raw) return { ok: true };
    const accountId = await validateWebSession(raw);
    if (accountId !== null) await signOutAccount(accountId);
    else await deleteWebSession(raw);
    return { ok: true };
  });

  app.delete<{ Params: { platform: string } }>('/auth/:platform', { preHandler: requireWebSession }, async (req, reply) => {
    const params = PlatformParam.safeParse(req.params);
    if (!params.success) { reply.code(400); return { ok: false, error: 'platform' }; }
    await unlinkIdentity(req.webAccountId!, params.data.platform);
    return { ok: true };
  });

  // ---- odeslání zprávy tokenem uživatele ----
  app.post<{ Body: z.infer<typeof SendBody> }>('/chat/send', { preHandler: requireWebSession }, async (req, reply) => {
    const body = SendBody.safeParse(req.body);
    if (!body.success) { reply.code(400); return { ok: false, error: 'body' }; }
    const accountId = req.webAccountId!;
    if (!sendLimiter.allow(String(accountId))) { reply.code(429); return { ok: false, error: 'slow down' }; }
    const { platform } = body.data;
    const channel = (body.data.channel || DEFAULT_CHANNEL).toLowerCase();

    let text: string;
    try { text = outgoingText(body.data.text); } catch (e) { reply.code(400); return { ok: false, error: (e as Error).message }; }

    const dir = await db
      .select({ twitchUserId: streamers.twitchUserId, kickUserId: streamers.kickUserId, youtubeHandle: streamers.youtubeHandle })
      .from(streamers)
      .where(eq(streamers.twitchLogin, channel))
      .limit(1);
    if (!dir.length) { reply.code(404); return { ok: false, error: 'unknown channel' }; }

    let ident = await getDecryptedIdentity(accountId, platform);
    if (!ident) { reply.code(403); return { ok: false, error: `not linked: ${platform}` }; }

    const refresh = async () => {
      if (!ident?.refreshToken) throw new SendError(`${platform}: token expired, login again`, 401);
      let t: TokenSet;
      if (platform === 'twitch') { const r = await twitch.refreshAccessToken(ident.refreshToken); t = { accessToken: r.access_token, refreshToken: r.refresh_token || ident.refreshToken, expiresIn: r.expires_in, scopes: r.scope }; }
      else if (platform === 'kick') { const r = await kick.refreshAccessToken(ident.refreshToken); t = { accessToken: r.access_token, refreshToken: r.refresh_token || ident.refreshToken, expiresIn: r.expires_in, scopes: r.scope.split(' ').filter(Boolean) }; }
      else { const r = await youtube.refreshAccessToken(ident.refreshToken); t = { accessToken: r.access_token, refreshToken: ident.refreshToken, expiresIn: r.expires_in, scopes: r.scope.split(' ').filter(Boolean) }; }
      await storeRefreshedTokens(accountId, platform, t);
      ident = { ...ident!, accessToken: t.accessToken, refreshToken: t.refreshToken || null, expiresAt: new Date(Date.now() + t.expiresIn * 1000) };
    };

    const doSend = async (): Promise<{ id: string | null; sentText?: string; fallback?: 'mention' }> => {
      if (platform === 'twitch') {
        if (!dir[0].twitchUserId) throw new SendError('channel has no twitch id', 404);
        return sendTwitch({ accessToken: ident!.accessToken, senderId: ident!.platformUserId, broadcasterId: dir[0].twitchUserId, text, replyTo: body.data.replyTo });
      }
      if (platform === 'kick') {
        if (!dir[0].kickUserId) throw new SendError('channel has no kick id', 404);
        try {
          return await sendKick({ accessToken: ident!.accessToken, broadcasterUserId: dir[0].kickUserId, text, replyTo: body.data.replyTo });
        } catch (e) {
          // Kick public API vrací na odpověď 404 „Not found" (2026-09-23, i se správným
          // broadcaster_user_id). Zpráva nesmí propadnout → znovu jako obyčejná „@login text"
          // (jako odpověď napříč platformami). Log rozliší, jestli padá jen odpověď.
          if (!(e instanceof SendError) || e.status !== 404 || !body.data.replyTo) throw e;
          const at = body.data.replyToUser ? `@${body.data.replyToUser.replace(/^@/, '')} ` : '';
          req.log.warn({ accountId, replyTo: body.data.replyTo, err: e.message }, 'kick: odpověď odmítnuta → posílám jako zprávu s @');
          const sentText = text.startsWith(at) ? text : at + text;
          const res = await sendKick({ accessToken: ident!.accessToken, broadcasterUserId: dir[0].kickUserId, text: sentText, replyTo: null });
          req.log.info({ accountId, id: res.id }, 'kick: záložní zpráva bez reply odeslána');
          // Klient podle toho zahodí optimistickou „odpověď" (echo přijde jako „@login text").
          return { ...res, sentText, fallback: 'mention' as const };
        }
      }
      const videoId = opts.ingest?.videoIdFor('youtube', dir[0].youtubeHandle || channel) || null;
      if (!videoId) throw new SendError('youtube: stream not live (no video id)', 409);
      const liveChatId = await youtubeLiveChatId({ accessToken: ident!.accessToken, videoId });
      if (!liveChatId) throw new SendError('youtube: live chat not active', 409);
      return sendYoutube({ accessToken: ident!.accessToken, liveChatId, text });
    };

    // Odpověď napříč platformami: nahlásit PŘED odesláním, echo z ingestu ji pak rovnou ponese.
    const ucReply = body.data.replyTo ? null : parseUcReply(body.data.ucReplyTo);
    if (ucReply) {
      const rh = ucReplies.report({ platform, channel: await platformChannel(platform, channel), userId: ident!.platformUserId, text, data: ucReply });
      if (rh) attachUcReply(rh, ucReply, req.log, { late: true });
    }

    try {
      if (needsRefresh(ident.expiresAt)) await refresh();
      let res: { id: string | null; sentText?: string; fallback?: 'mention' };
      try {
        res = await doSend();
      } catch (e) {
        if (e instanceof SendError && e.retryable) { await refresh(); res = await doSend(); } else throw e;
      }
      req.log.info({ accountId, platform, channel, id: res.id, len: text.length }, 'web chat send');
      // Command (bez markeru): ingest ho podle hlášení označí jako UnityChat (zlaté logo, lib/ucSends.ts).
      if (text.startsWith('!')) {
        const hit = ucSends.report({ platform, channel: await platformChannel(platform, channel), userId: ident!.platformUserId, text });
        if (hit) markUc(hit, req.log, { late: true });
      }
      return { ok: true, id: res.id, text: res.sentText ?? text, ...(res.fallback ? { fallback: res.fallback } : {}) };
    } catch (e) {
      const err = e as SendError;
      const status = err instanceof SendError ? err.status : 502;
      req.log.warn({ accountId, platform, channel, status, err: err.message }, 'web chat send failed');
      reply.code(status >= 400 && status < 600 ? status : 502);
      return { ok: false, error: err.message };
    }
  });

  // ---- je streamer live? (web: tečky ve filtrech) ----
  // Twitch přes IVR (veřejné, `stream` != null), Kick přes channels API
  // (`livestream` != null), YouTube = ingest listener má videoId živého streamu.
  // Cache 30 s per kanál, ať se veřejná API nemlátí za každého návštěvníka.
  const liveCache = new Map<string, { at: number; value: Record<string, boolean> }>();
  app.get<{ Querystring: { channel?: string } }>('/chat/live', async (req, reply) => {
    reply.header('Cache-Control', 'public, max-age=20');
    const channel = (req.query.channel || DEFAULT_CHANNEL).trim().toLowerCase();
    if (!/^[a-z0-9_]{1,40}$/.test(channel)) { reply.code(400); return { ok: false, error: 'channel' }; }
    const hit = liveCache.get(channel);
    if (hit && Date.now() - hit.at < 30_000) return { ok: true, channel, cached: true, ...hit.value };
    const dir = await db
      .select({ kickSlug: streamers.kickSlug, youtubeHandle: streamers.youtubeHandle })
      .from(streamers).where(eq(streamers.twitchLogin, channel)).limit(1);
    const kickSlug = dir[0]?.kickSlug || channel;
    const ytHandle = dir[0]?.youtubeHandle || channel;
    const [tw, ki] = await Promise.all([
      fetch(`https://api.ivr.fi/v2/twitch/user?login=${encodeURIComponent(channel)}`, { signal: AbortSignal.timeout(6000) })
        .then(async (r) => { if (!r.ok) return false; const d = await r.json() as Array<{ stream?: unknown }> | { stream?: unknown }; const u = Array.isArray(d) ? d[0] : d; return !!u?.stream; })
        .catch(() => false),
      fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(kickSlug)}`, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 UnityChat' }, signal: AbortSignal.timeout(6000) })
        .then(async (r) => { if (!r.ok) return false; const d = await r.json() as { livestream?: unknown }; return !!d?.livestream; })
        .catch(() => false),
    ]);
    const yt = !!opts.ingest?.videoIdFor('youtube', ytHandle);
    const value = { twitch: tw, kick: ki, youtube: yt };
    liveCache.set(channel, { at: Date.now(), value });
    return { ok: true, channel, cached: false, ...value };
  });

  app.get('/auth/config', async () => ({
    ok: true,
    platforms: { twitch: twitch.twitchConfigured(), youtube: youtube.youtubeConfigured(), kick: kick.kickConfigured() },
    origins: allowedOrigins(),
    publicBaseUrl: config.PUBLIC_BASE_URL,
  }));
}
