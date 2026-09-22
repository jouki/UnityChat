// Odeslání zprávy jako chat bot Židolišty (POST /bot/send). Kanál se odvozuje
// VÝHRADNĚ ze slugu workspace (registr Židolišty) — Židolišta kanál nikdy
// neadresuje, tady je jediné místo izolace mezi workspacy.
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { streamers } from '../db/schema.js';
import { config } from '../config.js';
import * as twitch from './oauthTwitch.js';
import * as youtube from './oauthYoutube.js';
import * as kick from './oauthKick.js';
import { needsRefresh, type TokenSet } from './webAuth.js';
import { SendError, sendTwitch, sendKick, sendYoutube, youtubeLiveChatId } from './webSend.js';
import { getBotIdentity, storeBotTokens, markBotExpired, type BotIdentity } from './botIdentities.js';
import { workspaceBySlug, type Platform } from './zidolista.js';
import type { Ingest } from '../ingest/index.js';

export class BotSendError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message); }
}

const PLATFORM_MAX: Record<Platform, number> = { twitch: 500, kick: 500, youtube: 200 };
const idCache = new Map<string, { id: string; at: number }>();
const ID_TTL = 6 * 60 * 60_000;

/** Text bota: trim, bez UC markeru (bot není uživatel UnityChatu), ořez na limit platformy. */
export function botText(raw: string, platform: Platform): string {
  const t = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!t) throw new BotSendError('empty text', 400, 'empty_text');
  const max = PLATFORM_MAX[platform];
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

async function twitchUserId(login: string, accessToken: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const k = `twitch:${login}`;
  const hit = idCache.get(k);
  if (hit && Date.now() - hit.at < ID_TTL) return hit.id;
  const dir = await db.select({ id: streamers.twitchUserId }).from(streamers).where(eq(streamers.twitchLogin, login)).limit(1);
  let id = dir[0]?.id || null;
  if (!id) {
    const r = await fetchImpl(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`, { headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': config.TWITCH_CLIENT_ID }, signal: AbortSignal.timeout(8000) });
    if (r.status === 401) throw new SendError('twitch: unauthorized', 401, true);
    const j = (await r.json().catch(() => ({}))) as { data?: Array<{ id?: string }> };
    id = j.data?.[0]?.id || null;
  }
  if (id) idCache.set(k, { id, at: Date.now() });
  return id;
}

async function kickUserId(slug: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const k = `kick:${slug}`;
  const hit = idCache.get(k);
  if (hit && Date.now() - hit.at < ID_TTL) return hit.id;
  const dir = await db.select({ id: streamers.kickUserId }).from(streamers).where(eq(streamers.twitchLogin, slug)).limit(1);
  let id = dir[0]?.id || null;
  if (!id) {
    const r = await fetchImpl(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 UnityChat' }, signal: AbortSignal.timeout(8000) });
    const j = (await r.json().catch(() => ({}))) as { user_id?: number | string };
    id = j.user_id != null ? String(j.user_id) : null;
  }
  if (id) idCache.set(k, { id, at: Date.now() });
  return id;
}

async function refreshBot(ident: BotIdentity): Promise<BotIdentity> {
  if (!ident.refreshToken) throw new SendError(`${ident.platform}: token expired`, 401);
  let t: TokenSet;
  if (ident.platform === 'twitch') { const r = await twitch.refreshAccessToken(ident.refreshToken); t = { accessToken: r.access_token, refreshToken: r.refresh_token || ident.refreshToken, expiresIn: r.expires_in, scopes: r.scope }; }
  else if (ident.platform === 'kick') { const r = await kick.refreshAccessToken(ident.refreshToken); t = { accessToken: r.access_token, refreshToken: r.refresh_token || ident.refreshToken, expiresIn: r.expires_in, scopes: r.scope.split(' ').filter(Boolean) }; }
  else { const r = await youtube.refreshAccessToken(ident.refreshToken); t = { accessToken: r.access_token, refreshToken: ident.refreshToken, expiresIn: r.expires_in, scopes: r.scope.split(' ').filter(Boolean) }; }
  await storeBotTokens(ident.workspace, ident.platform, t);
  return { ...ident, accessToken: t.accessToken, refreshToken: t.refreshToken || null, expiresAt: new Date(Date.now() + t.expiresIn * 1000), state: 'online' };
}

export interface BotSendInput { workspace: string; platform: Platform; text: string; replyTo?: string | null }
export interface BotSendResult { id: string | null; channel: string; login: string; identity: 'own' | 'shared'; text: string; badge: boolean }

export async function sendAsBot(input: BotSendInput, deps: { ingest?: Ingest; log?: { warn: (o: object, m: string) => void } } = {}): Promise<BotSendResult> {
  const ws = await workspaceBySlug(input.workspace);
  if (!ws) throw new BotSendError('unknown workspace', 404, 'unknown_workspace');
  const channel = ws.channels[input.platform];
  if (!channel) throw new BotSendError(`workspace has no ${input.platform} channel`, 404, 'no_channel');
  const text = botText(input.text, input.platform);

  let ident = await getBotIdentity(ws.slug, input.platform, ws.bot.mode !== 'shared');
  if (!ident || ident.state === 'expired') throw new BotSendError('no bot identity for platform', 503, 'bot_unavailable');
  const kind: 'own' | 'shared' = ident.workspace === ws.slug ? 'own' : 'shared';
  let badge = false;
  let appError: string | null = null;

  const doSend = async (): Promise<{ id: string | null }> => {
    if (input.platform === 'twitch') {
      const broadcasterId = await twitchUserId(channel, ident!.accessToken);
      if (!broadcasterId) throw new BotSendError('twitch channel not found', 404, 'no_channel');
      const p = { senderId: ident!.platformUserId, broadcasterId, text, replyTo: input.replyTo || null };
      // Odznak „Chat Bot": app access token + user:bot u bota + (channel:bot u broadcastera nebo mod).
      // Když Twitch app token odmítne (chybí scope/souhlas), pošle se user tokenem bota — bez odznaku.
      if (twitch.twitchConfigured()) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const r = await sendTwitch({ ...p, accessToken: await twitch.getAppAccessToken() });
            badge = true;
            return r;
          } catch (e) {
            const err = e as SendError;
            if (err instanceof SendError && err.status === 401 && attempt === 0) { twitch.invalidateAppAccessToken(); continue; }
            // Jakékoli odmítnutí app-token cesty (401/403 = scope/souhlas, 422 = Twitch zprávu zahodil) →
            // zkusit user token bota; 429 a 5xx nemá smysl opakovat jinou cestou.
            if (err instanceof SendError && err.status >= 400 && err.status < 500 && err.status !== 429) {
              deps.log?.warn({ workspace: ws.slug, path: 'app-token', status: err.status, err: err.message }, 'bot send: app token cesta selhala, fallback user token (bez odznaku)');
              appError = err.message;
              break;
            }
            throw e;
          }
        }
      }
      try {
        return await sendTwitch({ ...p, accessToken: ident!.accessToken });
      } catch (e) {
        if (e instanceof SendError && appError) e.message = `${e.message} (app-token: ${appError})`;
        throw e;
      }
    }
    if (input.platform === 'kick') {
      const broadcasterUserId = await kickUserId(channel);
      if (!broadcasterUserId) throw new BotSendError('kick channel not found', 404, 'no_channel');
      return sendKick({ accessToken: ident!.accessToken, broadcasterUserId, text, replyTo: input.replyTo || null });
    }
    const videoId = deps.ingest?.videoIdFor('youtube', channel) || null;
    if (!videoId) throw new BotSendError('youtube: stream not live', 409, 'not_live');
    const liveChatId = await youtubeLiveChatId({ accessToken: ident!.accessToken, videoId });
    if (!liveChatId) throw new BotSendError('youtube: live chat not active', 409, 'not_live');
    return sendYoutube({ accessToken: ident!.accessToken, liveChatId, text });
  };

  try {
    if (needsRefresh(ident.expiresAt)) ident = await refreshBot(ident);
    let res: { id: string | null };
    try { res = await doSend(); }
    catch (e) { if (e instanceof SendError && e.retryable) { ident = await refreshBot(ident); res = await doSend(); } else throw e; }
    return { id: res.id, channel, login: ident.login, identity: kind, text, badge };
  } catch (e) {
    if (e instanceof BotSendError) throw e;
    const err = e as SendError;
    if (err instanceof SendError && err.status === 401) {
      await markBotExpired(ident.workspace, ident.platform).catch(() => {});
      throw new BotSendError(`${input.platform}: token expired, relink bot`, 503, 'bot_unavailable');
    }
    const status = err instanceof SendError ? err.status : 502;
    throw new BotSendError(err.message || 'send failed', status >= 400 && status < 600 ? status : 502, 'send_failed');
  }
}
