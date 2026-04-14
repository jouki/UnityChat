import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { streamers, streamerTokens } from '../db/schema.js';
import { requireExtensionOrigin, parseAllowedExtensionIds } from '../lib/extensionOrigin.js';
import { signState, verifyState, createSession, validateSession, type StateInput } from '../lib/session.js';
import { encryptToken, isCryptoReady } from '../lib/crypto.js';
import * as twitch from '../lib/oauthTwitch.js';
import * as youtube from '../lib/oauthYoutube.js';
import * as kick from '../lib/oauthKick.js';

const StartParams = z.object({ platform: z.enum(['twitch', 'youtube', 'kick']) });

// Build chrome-extension:// return URL. Validates extension ID against allowlist.
function extensionRedirectUrl(extId: string, query: Record<string, string>): string | null {
  const allowed = parseAllowedExtensionIds();
  if (allowed.size > 0 && !allowed.has(extId)) return null;
  if (!/^[a-p]{32}$/.test(extId)) return null;
  const qs = new URLSearchParams(query).toString();
  return `chrome-extension://${extId}/streamer.html?${qs}`;
}

function errorPage(message: string): string {
  const safe = message.replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c] || c),
  );
  return `<!doctype html><meta charset="utf-8"><title>UnityChat — OAuth</title>
<style>body{font-family:system-ui;padding:40px;max-width:600px;margin:auto;color:#eee;background:#1a1a1a}
h1{color:#ff8c00}</style>
<h1>UnityChat — přihlášení se nezdařilo</h1>
<p>${safe}</p>
<p>Vraťte se zpátky do extension a zkuste to znovu.</p>`;
}

// Composite state token: "{extensionId}.{signedState}". Callback parses apart.
function wrapState(extensionId: string, signed: string): string {
  return encodeURIComponent(`${extensionId}.${signed}`);
}
function unwrapState(composite: string): { extensionId: string; signed: string } | null {
  const dot = composite.indexOf('.');
  if (dot === -1) return null;
  return { extensionId: composite.substring(0, dot), signed: composite.substring(dot + 1) };
}

// Per-platform field updates when completing OAuth. Column name → value.
type Platform = 'twitch' | 'youtube' | 'kick';

interface IdentityResult {
  /** stable platform user id */
  userId: string;
  /** handle used for lookup by viewer (lowercase, no @) */
  handle: string;
  displayName?: string;
  avatarUrl?: string;
}

function buildStreamerUpdates(platform: Platform, id: IdentityResult): Record<string, unknown> {
  const base: Record<string, unknown> = { verified: true, updatedAt: new Date() };
  // Handles are nullable — empty (e.g. old YouTube channel without @handle)
  // would collide on UNIQUE. user_id is always set.
  const handle = id.handle?.trim() || null;
  if (platform === 'twitch') {
    base.twitchLogin = handle;
    base.twitchUserId = id.userId;
    base.twitchDisplayName = id.displayName || null;
    base.twitchAvatarUrl = id.avatarUrl || null;
  } else if (platform === 'youtube') {
    base.youtubeHandle = handle;
    base.youtubeChannelId = id.userId;
    base.youtubeTitle = id.displayName || null;
    base.youtubeAvatarUrl = id.avatarUrl || null;
  } else {
    base.kickSlug = handle;
    base.kickUserId = id.userId;
    base.kickDisplayName = id.displayName || null;
    base.kickAvatarUrl = id.avatarUrl || null;
  }
  return base;
}

function userIdCol(platform: Platform) {
  if (platform === 'twitch') return streamers.twitchUserId;
  if (platform === 'youtube') return streamers.youtubeChannelId;
  return streamers.kickUserId;
}
function handleCol(platform: Platform) {
  if (platform === 'twitch') return streamers.twitchLogin;
  if (platform === 'youtube') return streamers.youtubeHandle;
  return streamers.kickSlug;
}

// Shared callback body: given platform + identity + raw tokens, upsert streamer,
// encrypt and store tokens, create/reuse session, and redirect back to extension.
async function completeCallback(
  req: FastifyRequest,
  reply: FastifyReply,
  platform: Platform,
  extensionId: string,
  payloadSessionId: string | undefined,
  identity: IdentityResult,
  tokens: { accessToken: string; refreshToken?: string; expiresIn: number; scopes: string[] },
) {
  // Resolve target streamer id: session > existing by user_id > existing by handle > new.
  let streamerId: number | null = null;

  if (payloadSessionId) {
    streamerId = await validateSession(payloadSessionId);
  }

  if (streamerId === null) {
    const byUserId = await db
      .select({ id: streamers.id })
      .from(streamers)
      .where(eq(userIdCol(platform), identity.userId))
      .limit(1);
    if (byUserId.length > 0) streamerId = byUserId[0].id;
  }

  if (streamerId === null && identity.handle) {
    const byHandle = await db
      .select({ id: streamers.id })
      .from(streamers)
      .where(eq(handleCol(platform), identity.handle))
      .limit(1);
    if (byHandle.length > 0) streamerId = byHandle[0].id;
  }

  const updates = buildStreamerUpdates(platform, identity);

  if (streamerId !== null) {
    await db.update(streamers).set(updates).where(eq(streamers.id, streamerId));
  } else {
    const inserted = await db.insert(streamers).values(updates).returning({ id: streamers.id });
    streamerId = inserted[0].id;
  }

  const accessEnc = encryptToken(tokens.accessToken);
  const refreshEnc = tokens.refreshToken ? encryptToken(tokens.refreshToken) : null;
  const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000);

  await db
    .insert(streamerTokens)
    .values({
      streamerId,
      platform,
      accessTokenEncrypted: accessEnc.ciphertext,
      refreshTokenEncrypted: refreshEnc?.ciphertext || null,
      tokenIv: accessEnc.iv,
      tokenAuthTag: accessEnc.authTag,
      refreshIv: refreshEnc?.iv || null,
      refreshAuthTag: refreshEnc?.authTag || null,
      expiresAt,
      scopes: tokens.scopes,
      keyVersion: accessEnc.keyVersion,
    })
    .onConflictDoUpdate({
      target: [streamerTokens.streamerId, streamerTokens.platform],
      set: {
        accessTokenEncrypted: accessEnc.ciphertext,
        refreshTokenEncrypted: refreshEnc?.ciphertext || null,
        tokenIv: accessEnc.iv,
        tokenAuthTag: accessEnc.authTag,
        refreshIv: refreshEnc?.iv || null,
        refreshAuthTag: refreshEnc?.authTag || null,
        expiresAt,
        scopes: tokens.scopes,
        keyVersion: accessEnc.keyVersion,
        updatedAt: new Date(),
      },
    });

  const sessionId = payloadSessionId || (await createSession(streamerId!));
  req.log.info(
    { platform, streamerId, handle: identity.handle, linked: !!payloadSessionId },
    'streamer OAuth completed',
  );

  const returnUrl = extensionRedirectUrl(extensionId, { success: platform, handle: identity.handle });
  if (!returnUrl) {
    reply.type('text/html');
    return errorPage('Extension ID není v allowlistu.');
  }
  // Some ad-blockers and Chrome security policies drop HTTP 302 redirects to
  // chrome-extension://. Render a tiny HTML page that performs a JS navigation
  // + provides a manual fallback link in case that's blocked too.
  const target = `${returnUrl}#session=${encodeURIComponent(sessionId)}`;
  const safeTarget = target.replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c] || c),
  );
  reply.type('text/html');
  return `<!doctype html><meta charset="utf-8"><title>UnityChat — hotovo</title>
<style>body{font-family:system-ui;padding:40px;max-width:600px;margin:auto;color:#eee;background:#1a1a1a;text-align:center}
h1{color:#ff8c00}a{color:#ffc800}</style>
<h1>UnityChat — přihlášení proběhlo</h1>
<p>Vracíme vás zpátky do extension…</p>
<p>Pokud se stránka neotevře automaticky, <a id="lnk" href="${safeTarget}">klikněte sem</a>.</p>
<script>
try { location.replace(${JSON.stringify(target)}); } catch (e) { document.getElementById('lnk').click(); }
</script>`;
}

export default async function oauthRoutes(app: FastifyInstance) {
  // ---- START endpoint (all platforms) ----
  app.post<{ Params: { platform: string } }>(
    '/streamers/oauth/:platform/start',
    { preHandler: requireExtensionOrigin },
    async (req, reply) => {
      const parsed = StartParams.safeParse(req.params);
      if (!parsed.success) {
        reply.code(400);
        return { ok: false, error: 'Invalid platform' };
      }
      const { platform } = parsed.data;
      if (!isCryptoReady()) {
        reply.code(503);
        return { ok: false, error: 'OAuth not configured on server' };
      }

      const originMatch = (req.headers.origin || '').match(/^chrome-extension:\/\/([a-p]{32})/);
      const extensionId = originMatch?.[1];
      if (!extensionId) {
        reply.code(400);
        return { ok: false, error: 'Cannot determine extension ID' };
      }

      let existingSessionId: string | undefined;
      const sessHdr = req.headers['x-uc-session'];
      if (typeof sessHdr === 'string' && sessHdr.trim()) {
        const streamerId = await validateSession(sessHdr.trim());
        if (streamerId !== null) existingSessionId = sessHdr.trim();
      }

      const stateInput: StateInput = { platform, sessionId: existingSessionId };

      if (platform === 'twitch') {
        if (!twitch.twitchConfigured()) {
          reply.code(503);
          return { ok: false, error: 'Twitch OAuth not configured' };
        }
        const state = wrapState(extensionId, signState(stateInput));
        return { ok: true, url: twitch.buildAuthorizeUrl(state) };
      }

      if (platform === 'youtube') {
        if (!youtube.youtubeConfigured()) {
          reply.code(503);
          return { ok: false, error: 'YouTube OAuth not configured' };
        }
        const state = wrapState(extensionId, signState(stateInput));
        return { ok: true, url: youtube.buildAuthorizeUrl(state) };
      }

      // Kick (PKCE required)
      if (!kick.kickConfigured()) {
        reply.code(503);
        return { ok: false, error: 'Kick OAuth not configured' };
      }
      const pkce = kick.generatePkcePair();
      const state = wrapState(extensionId, signState({ ...stateInput, codeVerifier: pkce.verifier }));
      return { ok: true, url: kick.buildAuthorizeUrl(state, pkce.challenge) };
    },
  );

  // ---- Platform-specific callbacks ----
  const makeCallback = (platform: Platform) =>
    async (
      req: FastifyRequest<{
        Querystring: { code?: string; state?: string; error?: string; error_description?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { code, state, error, error_description } = req.query;
      if (error) {
        reply.type('text/html');
        return errorPage(`${platform}: ${error_description || error}`);
      }
      if (!code || !state) {
        reply.type('text/html');
        return errorPage('Chybí code nebo state parametr.');
      }
      const unwrapped = unwrapState(state);
      if (!unwrapped) {
        reply.type('text/html');
        return errorPage('Neplatný state parametr.');
      }
      const payload = verifyState(unwrapped.signed);
      if (!payload || payload.platform !== platform) {
        reply.type('text/html');
        return errorPage('State je neplatný nebo expiroval. Zkuste přihlášení znovu.');
      }

      try {
        let identity: IdentityResult;
        let tokens: { accessToken: string; refreshToken?: string; expiresIn: number; scopes: string[] };

        if (platform === 'twitch') {
          const tr = await twitch.exchangeCode(code);
          const u = await twitch.fetchUser(tr.access_token);
          identity = {
            userId: u.id,
            handle: u.login,
            displayName: u.display_name,
            avatarUrl: u.profile_image_url,
          };
          tokens = {
            accessToken: tr.access_token,
            refreshToken: tr.refresh_token,
            expiresIn: tr.expires_in,
            scopes: tr.scope,
          };
        } else if (platform === 'youtube') {
          const tr = await youtube.exchangeCode(code);
          const ch = await youtube.fetchChannel(tr.access_token);
          identity = {
            userId: ch.channelId,
            handle: ch.handle,
            displayName: ch.title,
            avatarUrl: ch.avatarUrl,
          };
          tokens = {
            accessToken: tr.access_token,
            refreshToken: tr.refresh_token,
            expiresIn: tr.expires_in,
            scopes: tr.scope.split(' ').filter(Boolean),
          };
        } else {
          if (!payload.codeVerifier) {
            reply.type('text/html');
            return errorPage('Kick: chybí PKCE verifier ve state.');
          }
          const tr = await kick.exchangeCode(code, payload.codeVerifier);
          const u = await kick.fetchUser(tr.access_token);
          identity = {
            userId: u.userId,
            handle: u.name.toLowerCase(),
            displayName: u.name,
            avatarUrl: u.avatarUrl,
          };
          tokens = {
            accessToken: tr.access_token,
            refreshToken: tr.refresh_token,
            expiresIn: tr.expires_in,
            scopes: tr.scope.split(' ').filter(Boolean),
          };
        }

        return completeCallback(req, reply, platform, unwrapped.extensionId, payload.sessionId, identity, tokens);
      } catch (err) {
        req.log.error({ err: (err as Error).message, platform }, 'OAuth callback failed');
        reply.type('text/html');
        return errorPage(`${platform}: autentizace selhala. Zkuste to znovu.`);
      }
    };

  app.get('/streamers/oauth/twitch/callback', makeCallback('twitch'));
  app.get('/streamers/oauth/youtube/callback', makeCallback('youtube'));
  app.get('/streamers/oauth/kick/callback', makeCallback('kick'));
}
