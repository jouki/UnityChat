import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { streamers, streamerTokens } from '../db/schema.js';
import { requireExtensionOrigin, parseAllowedExtensionIds } from '../lib/extensionOrigin.js';
import { signState, verifyState, createSession, validateSession } from '../lib/session.js';
import { encryptToken, isCryptoReady } from '../lib/crypto.js';
import {
  buildAuthorizeUrl as twitchAuthUrl,
  exchangeCode as twitchExchange,
  fetchUser as twitchFetchUser,
  twitchConfigured,
} from '../lib/oauthTwitch.js';

// POST /streamers/oauth/:platform/start
// Requires extension origin. Optional X-UC-Session to link a platform to an
// existing streamer. Returns { url } that extension opens in a new tab.
const StartParams = z.object({ platform: z.enum(['twitch', 'youtube', 'kick']) });

// Build a redirect URL back into the extension after successful OAuth.
// Validates the requested extension ID against allowlist (defense in depth).
function extensionRedirectUrl(extId: string, query: Record<string, string>): string | null {
  const allowed = parseAllowedExtensionIds();
  // Dev mode: no allowlist → accept any chrome-extension id format.
  if (allowed.size > 0 && !allowed.has(extId)) return null;
  if (!/^[a-p]{32}$/.test(extId)) return null;
  const qs = new URLSearchParams(query).toString();
  return `chrome-extension://${extId}/streamer.html?${qs}`;
}

// HTML page that renders an error-only view when OAuth fails or we can't
// reach the extension. Plain text, no sensitive data.
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

export default async function oauthRoutes(app: FastifyInstance) {
  // START endpoint — requires extension origin.
  app.post<{ Params: { platform: string }; Body: { extensionId?: string } }>(
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

      // Pick up extension ID from Origin header to include in return URL.
      const originMatch = (req.headers.origin || '').match(/^chrome-extension:\/\/([a-p]{32})/);
      const extensionId = originMatch?.[1];
      if (!extensionId) {
        reply.code(400);
        return { ok: false, error: 'Cannot determine extension ID' };
      }

      // If caller is already authed, propagate sessionId so callback links
      // new platform to existing streamer instead of creating a new record.
      let existingSessionId: string | undefined;
      const sessHdr = req.headers['x-uc-session'];
      if (typeof sessHdr === 'string' && sessHdr.trim()) {
        const streamerId = await validateSession(sessHdr.trim());
        if (streamerId !== null) existingSessionId = sessHdr.trim();
      }

      if (platform === 'twitch') {
        if (!twitchConfigured()) {
          reply.code(503);
          return { ok: false, error: 'Twitch OAuth not configured' };
        }
        const state = signState({ platform: 'twitch', sessionId: existingSessionId });
        // Encode extension ID + state into a single state token for the callback.
        const composedState = encodeURIComponent(`${extensionId}.${state}`);
        return { ok: true, url: twitchAuthUrl(composedState) };
      }

      reply.code(501);
      return { ok: false, error: `${platform} OAuth not implemented yet` };
    },
  );

  // CALLBACK endpoint for Twitch — NOT behind extension origin check
  // (the provider redirects here, not the extension). Origin is whatever
  // the provider's browser sent (usually no Origin header at all for
  // top-level navigations).
  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    '/streamers/oauth/twitch/callback',
    async (req, reply) => {
      const { code, state, error, error_description } = req.query;

      if (error) {
        reply.type('text/html');
        return errorPage(`Twitch: ${error_description || error}`);
      }
      if (!code || !state) {
        reply.type('text/html');
        return errorPage('Chybí code nebo state parametr.');
      }

      // Parse composed state: "{extensionId}.{signedState}"
      const dot = state.indexOf('.');
      if (dot === -1) {
        reply.type('text/html');
        return errorPage('Neplatný state parametr.');
      }
      const extensionId = state.substring(0, dot);
      const signedState = state.substring(dot + 1);

      const payload = verifyState(signedState);
      if (!payload || payload.platform !== 'twitch') {
        reply.type('text/html');
        return errorPage('State je neplatný nebo expiroval. Zkuste přihlášení znovu.');
      }

      // Exchange code → token
      let tokenResp;
      try {
        tokenResp = await twitchExchange(code);
      } catch (err) {
        req.log.error({ err: (err as Error).message }, 'Twitch token exchange failed');
        reply.type('text/html');
        return errorPage('Výměna code za token selhala. Zkuste přihlášení znovu.');
      }

      // Fetch user info
      let user;
      try {
        user = await twitchFetchUser(tokenResp.access_token);
      } catch (err) {
        req.log.error({ err: (err as Error).message }, 'Twitch /users failed');
        reply.type('text/html');
        return errorPage('Nelze načíst uživatele z Twitche.');
      }

      // Determine target streamer:
      // 1. If session from state → use that streamerId (linking platform to existing streamer)
      // 2. Else if row with twitch_user_id exists → reuse it (re-auth)
      // 3. Else if row with twitch_login exists → upgrade stub
      // 4. Else → create new row
      let streamerId: number | null = null;

      if (payload.sessionId) {
        streamerId = await validateSession(payload.sessionId);
      }

      if (streamerId === null) {
        const byUserId = await db
          .select({ id: streamers.id })
          .from(streamers)
          .where(eq(streamers.twitchUserId, user.id))
          .limit(1);
        if (byUserId.length > 0) streamerId = byUserId[0].id;
      }

      if (streamerId === null) {
        const byLogin = await db
          .select({ id: streamers.id })
          .from(streamers)
          .where(eq(streamers.twitchLogin, user.login))
          .limit(1);
        if (byLogin.length > 0) streamerId = byLogin[0].id;
      }

      // Build updates for streamers row
      const updates = {
        twitchLogin: user.login,
        twitchUserId: user.id,
        twitchDisplayName: user.display_name,
        twitchAvatarUrl: user.profile_image_url || null,
        verified: true,
        updatedAt: new Date(),
      };

      if (streamerId !== null) {
        await db.update(streamers).set(updates).where(eq(streamers.id, streamerId));
      } else {
        const inserted = await db
          .insert(streamers)
          .values(updates)
          .returning({ id: streamers.id });
        streamerId = inserted[0].id;
      }

      // Encrypt + store token
      const accessEnc = encryptToken(tokenResp.access_token);
      const refreshEnc = tokenResp.refresh_token ? encryptToken(tokenResp.refresh_token) : null;
      const expiresAt = new Date(Date.now() + tokenResp.expires_in * 1000);

      await db
        .insert(streamerTokens)
        .values({
          streamerId: streamerId!,
          platform: 'twitch',
          accessTokenEncrypted: accessEnc.ciphertext,
          refreshTokenEncrypted: refreshEnc?.ciphertext || null,
          tokenIv: accessEnc.iv,
          tokenAuthTag: accessEnc.authTag,
          refreshIv: refreshEnc?.iv || null,
          refreshAuthTag: refreshEnc?.authTag || null,
          expiresAt,
          scopes: tokenResp.scope,
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
            scopes: tokenResp.scope,
            keyVersion: accessEnc.keyVersion,
            updatedAt: new Date(),
          },
        });

      // Create (or reuse) session. If state had sessionId we keep it, else new.
      const sessionId = payload.sessionId || (await createSession(streamerId!));
      req.log.info(
        { platform: 'twitch', streamerId, twitchLogin: user.login, linked: !!payload.sessionId },
        'streamer OAuth completed',
      );

      // Redirect back to extension with success. Session goes via URL fragment
      // so it's not sent to server logs / referer headers.
      const returnUrl = extensionRedirectUrl(extensionId, { success: 'twitch', handle: user.login });
      if (!returnUrl) {
        reply.type('text/html');
        return errorPage('Extension ID není v allowlistu.');
      }
      // Fragment carries the session (not sent to any server afterward).
      const redirectTarget = `${returnUrl}#session=${encodeURIComponent(sessionId)}`;
      return reply.redirect(redirectTarget);
    },
  );
}
