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
  requireWebSession, completeWebLogin, listIdentities, unlinkIdentity, signOutAccount,
  type Platform, type IdentityInfo, type TokenSet,
} from '../lib/webAuth.js';
import { outgoingText, SendError } from '../lib/webSend.js';
import { sendAsAccount, sendUcReply } from '../lib/accountSend.js';
import { pendingWarnings } from '../lib/accountWarnings.js';
import { ucSends, markUc, ucReplies, attachUcReply } from '../lib/ucSends.js';
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
// `mod: true` = navíc žádat moderátorské scopes (mazání zpráv, bany) — mod se přihlašuje
// vlastním účtem, aby mohl mazat/banovat z UnityChatu na platformách, kde to podporují.
const StartBody = z.object({ returnTo: z.string().url().optional(), mod: z.boolean().optional() }).optional();
const ExchangeBody = z.object({ code: z.string().min(8).max(200) });
const SendBody = z.object({
  platform: z.enum(['twitch', 'youtube', 'kick']),
  channel: z.string().regex(/^[a-z0-9_]{1,40}$/i).optional(),
  text: z.string().min(1).max(2000),
  replyTo: z.string().max(200).optional().nullable(),
  /** Login autora zprávy, na kterou se odpovídá — pro záložní „@login text", když platforma odpověď odmítne. */
  replyToUser: z.string().max(60).optional().nullable(),
  /** Odpověď napříč platformami (UnityChat): na kterou zprávu se odpovídá — server ji spáruje s echem. */
  ucReplyTo: z.object({ platform: z.string(), id: z.string(), username: z.string().optional(), message: z.string().optional(), authorUc: z.boolean().optional() }).optional().nullable(),
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
  app.post<{ Params: { platform: string }; Body: { returnTo?: string; mod?: boolean } }>('/auth/:platform/start', async (req, reply) => {
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
    const wantMod = body.data?.mod === true;
    if (platform === 'twitch') {
      if (!twitch.twitchConfigured()) { reply.code(503); return { ok: false, error: 'Twitch OAuth not configured' }; }
      // Twitch: jedno přihlášení žádá rovnou i moderátorské scopes (pokyn usera 2026-09-25 — žádné druhé
      // přihlášení pro mody). Kick zatím jen s `mod: true`, dokud nejsou scopes povolené v Kick dev app.
      const scopes = [...twitch.WEB_SCOPES, ...twitch.MOD_SCOPES];
      return { ok: true, url: twitch.buildAuthorizeUrl(signState(stateInput), scopes) };
    }
    if (platform === 'youtube') {
      if (!youtube.youtubeConfigured()) { reply.code(503); return { ok: false, error: 'YouTube OAuth not configured' }; }
      const scopes = wantMod ? [...youtube.WEB_SCOPES, ...youtube.MOD_SCOPES] : youtube.WEB_SCOPES;
      return { ok: true, url: youtube.buildAuthorizeUrl(signState(stateInput), scopes) };
    }
    if (!kick.kickConfigured()) { reply.code(503); return { ok: false, error: 'Kick OAuth not configured' }; }
    const pkce = kick.generatePkcePair();
    // Kick: moderátorské scopes jsou v Kick dev app povolené (2026-09-25) → rovnou při každém přihlášení.
    const kickScopes = [...kick.WEB_SCOPES, ...kick.MOD_SCOPES];
    return { ok: true, url: kick.buildAuthorizeUrl(signState({ ...stateInput, codeVerifier: pkce.verifier }), pkce.challenge, kickScopes) };
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
    // Nepotvrzená varování od moda (moderace část 2) — klient je ukáže hned po přihlášení.
    let warnings: Awaited<ReturnType<typeof pendingWarnings>> = [];
    try { warnings = await pendingWarnings(req.webAccountId!); } catch (e) { req.log.warn({ err: (e as Error).message }, 'auth/me: varování nenačtena'); }
    return { ok: true, accountId: req.webAccountId, platforms, warnings };
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

    // Nepotvrzené varování od moda (moderace část 2): psát se nesmí, dokud ho uživatel nepotvrdí.
    // Chybějící tabulka (SQL ještě neproběhlo) / výpadek DB psaní neblokuje.
    try {
      if ((await pendingWarnings(accountId)).length) { reply.code(403); return { ok: false, error: 'warning_pending' }; }
    } catch (e) { req.log.warn({ err: (e as Error).message }, 'chat send: kontrola varování selhala'); }

    // Odpověď napříč platformami: nahlásit PŘED odesláním, echo z ingestu ji pak rovnou ponese.
    // Citace z archivu, ne od klienta (podvržené citace, 2026-09-25) — sendUcReply → verifyUcReply.
    const ucReply = await sendUcReply(body.data);

    try {
      const res = await sendAsAccount({
        accountId, platform, channel, text,
        replyTo: body.data.replyTo, replyToUser: body.data.replyToUser,
        ingest: opts.ingest, log: req.log,
        beforeSend: async (ident) => {
          if (!ucReply) return;
          const rh = ucReplies.report({ platform, channel: await platformChannel(platform, channel), userId: ident.platformUserId, text, data: ucReply });
          if (rh) attachUcReply(rh, ucReply, req.log, { late: true });
        },
      });
      req.log.info({ accountId, platform, channel, id: res.id, len: text.length }, 'web chat send');
      // Command (bez markeru): ingest ho podle hlášení označí jako UnityChat (zlaté logo, lib/ucSends.ts).
      if (text.startsWith('!')) {
        const hit = ucSends.report({ platform, channel: await platformChannel(platform, channel), userId: res.platformUserId, text });
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
