import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { verifyState } from '../lib/session.js';
import * as twitch from '../lib/oauthTwitch.js';
import * as youtube from '../lib/oauthYoutube.js';
import * as kick from '../lib/oauthKick.js';
import { completeWebCallback, webErrorRedirect } from './webAuth.js';
import { completeBotCallback, botErrorRedirect, verifyBotBinding, clearBotBinding } from './integrations.js';

const StartParams = z.object({ platform: z.enum(['twitch', 'youtube', 'kick']) });

// Streamer OAuth flow (state "{extensionId}.{signed}", X-UC-Session) je VYPNUTÝ (2026-09-26):
// měl stejnou díru jako web flow (login CSRF, audit C1) — state nesl session toho, kdo flow
// spustil, a callback připojil identitu + tokeny oběti ke streameru útočníka (verified záznam
// v directory, /streamers/me/*). Žádný klient ho nepoužívá (addon od v3.38.67 bez streamer.html,
// web ho nevolá). Callback URL zůstávají — sdílí je web (kind 'web') a bot Židolišty (kind 'bot').
// Obnovení = git history před tímto commitem + vázat state na prohlížeč (viz lib/webAuth.ts).
export const STREAMER_FLOW_GONE = 'Přihlášení streamera přes rozšíření bylo zrušeno. Použijte přihlášení v UnityChatu.';

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

type Platform = 'twitch' | 'youtube' | 'kick';

interface IdentityResult {
  /** stable platform user id */
  userId: string;
  /** handle used for lookup by viewer (lowercase, no @) */
  handle: string;
  displayName?: string;
  avatarUrl?: string;
}

export default async function oauthRoutes(app: FastifyInstance) {
  // ---- START endpoint (streamer flow) — vypnuto, viz STREAMER_FLOW_GONE ----
  app.post<{ Params: { platform: string } }>('/streamers/oauth/:platform/start', async (req, reply) => {
    if (!StartParams.safeParse(req.params).success) {
      reply.code(400);
      return { ok: false, error: 'Invalid platform' };
    }
    reply.code(410);
    return { ok: false, error: 'gone', message: STREAMER_FLOW_GONE };
  });

  // ---- Platform-specific callbacks (web + bot) ----
  const makeCallback = (platform: Platform) =>
    async (
      req: FastifyRequest<{
        Querystring: { code?: string; state?: string; error?: string; error_description?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { code, state, error, error_description } = req.query;
      if (error) {
        const wp = state ? verifyState(decodeURIComponent(state)) : null;
        if (wp && wp.kind === 'web') return webErrorRedirect(reply, wp.returnTo, `${platform}: ${error_description || error}`);
        if (wp && wp.kind === 'bot') {
          clearBotBinding(reply, wp);
          return botErrorRedirect(reply, wp.returnTo, `${platform}: ${error_description || error}`);
        }
        reply.type('text/html');
        return errorPage(`${platform}: ${error_description || error}`);
      }
      if (!code || !state) {
        reply.type('text/html');
        return errorPage('Chybí code nebo state parametr.');
      }
      // Web verze i bot Židolišty podepisují state bez prefixu (kind:'web' / 'bot' v payloadu).
      // Cokoli jiného (vypnutý streamer flow "{extensionId}.{signed}", neplatný podpis) → chyba.
      const payload = verifyState(decodeURIComponent(state));
      const isWeb = !!payload && payload.kind === 'web';
      const isBot = !!payload && payload.kind === 'bot';
      if (!payload || (!isWeb && !isBot)) {
        const streamerState = !payload && /^[a-p]{32}\./.test(decodeURIComponent(state));
        reply.code(streamerState ? 410 : 400).type('text/html');
        return errorPage(streamerState ? STREAMER_FLOW_GONE : 'State je neplatný nebo expiroval. Zkuste přihlášení znovu.');
      }
      if (payload.platform !== platform) {
        if (isWeb) return webErrorRedirect(reply, payload.returnTo, 'state expiroval, zkus to znovu');
        return botErrorRedirect(reply, payload.returnTo, 'state expiroval, zkus to znovu');
      }
      // Bot: state musí patřit prohlížeči, který otevřel jednorázový /bot/link/:token (cookie).
      // Jinak by někdo s odkazem mohl autorizační URL poslat cizímu člověku a jeho účet by se
      // stal botem workspace (stejná třída chyby jako C1). Ověřit PŘED výměnou code u providera.
      if (isBot && !verifyBotBinding(req, payload)) {
        req.log.warn({ platform, workspace: payload.workspace }, 'bot link callback: state not bound to this browser');
        return botErrorRedirect(reply, payload.returnTo, `link_not_bound:${platform}`);
      }
      if (isBot) clearBotBinding(reply, payload);

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

        const info = { platformUserId: identity.userId, login: identity.handle, displayName: identity.displayName, avatarUrl: identity.avatarUrl };
        if (isWeb) return completeWebCallback(req, reply, platform, payload, info, tokens);
        return completeBotCallback(req, reply, platform, payload, info, tokens);
      } catch (err) {
        req.log.error({ err: (err as Error).message, platform, web: isWeb, bot: isBot }, 'OAuth callback failed');
        if (isWeb) return webErrorRedirect(reply, payload.returnTo, `${platform}: přihlášení selhalo`);
        // Konkrétní důvod do #bot_error, ať Židolišta umí poradit (typicky Google účet bez YouTube kanálu).
        const m = (err as Error).message || '';
        const why = /no channel/i.test(m) ? 'no_youtube_channel' : /token exchange/i.test(m) ? 'token_exchange_failed' : 'link_failed';
        return botErrorRedirect(reply, payload.returnTo, `${why}:${platform}`);
      }
    };

  app.get('/streamers/oauth/twitch/callback', makeCallback('twitch'));
  app.get('/streamers/oauth/youtube/callback', makeCallback('youtube'));
  app.get('/streamers/oauth/kick/callback', makeCallback('kick'));
}
