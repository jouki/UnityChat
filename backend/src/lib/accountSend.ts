// Odeslání zprávy do chatu platformy účtem uživatele UnityChatu (tokenem jeho propojené identity).
// Vytažené z POST /chat/send (routes/webAuth.ts), aby ho mohla použít i moderace (`!permit <login>`
// účtem moda, lib moderace část 2) — jeden zdroj pravdy pro Twitch/Kick/YouTube send + refresh.
// NIKDY nelogovat tokeny.
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { streamers } from '../db/schema.js';
import { getDecryptedIdentity, storeRefreshedTokens, needsRefresh, type DecryptedIdentity, type Platform } from './webAuth.js';
import { refreshTokens } from './platformTokens.js';
import { sendTwitch, sendKick, sendYoutube, youtubeLiveChatId, SendError } from './webSend.js';
import type { Ingest } from '../ingest/index.js';

type Log = { warn: (o: object, m: string) => void; info: (o: object, m: string) => void };

export interface AccountSendInput {
  accountId: number;
  platform: Platform;
  /** UC kanál (streamerův Twitch login), lowercase. */
  channel: string;
  /** Hotový text (outgoingText: marker, limit). */
  text: string;
  replyTo?: string | null;
  /** Login autora zprávy, na kterou se odpovídá — pro záložní „@login text", když Kick odpověď odmítne. */
  replyToUser?: string | null;
  ingest?: Ingest | null;
  log?: Log;
  /** Po načtení identity, před odesláním (hlášení odpovědi napříč platformami potřebuje platformUserId). */
  beforeSend?: (ident: DecryptedIdentity) => Promise<void> | void;
}

export interface AccountSendResult {
  id: string | null;
  /** Skutečně odeslaný text, když se liší (Kick záložní „@login text"). */
  sentText?: string;
  fallback?: 'mention';
  /** platformUserId odesílatele (párování echa v ingestu). */
  platformUserId: string;
}

/** Chyby jako SendError se statusem (404 unknown channel, 403 not linked, 401 token, 409 YouTube neběží, …). */
export async function sendAsAccount(p: AccountSendInput): Promise<AccountSendResult> {
  const { accountId, platform, channel, text } = p;
  const dir = await db
    .select({ twitchUserId: streamers.twitchUserId, kickUserId: streamers.kickUserId, youtubeHandle: streamers.youtubeHandle })
    .from(streamers)
    .where(eq(streamers.twitchLogin, channel))
    .limit(1);
  if (!dir.length) throw new SendError('unknown channel', 404);

  let ident = await getDecryptedIdentity(accountId, platform);
  if (!ident) throw new SendError(`not linked: ${platform}`, 403);

  const refresh = async () => {
    if (!ident?.refreshToken) throw new SendError(`${platform}: token expired, login again`, 401);
    const t = await refreshTokens(platform, ident.refreshToken);
    await storeRefreshedTokens(accountId, platform, t);
    ident = { ...ident!, accessToken: t.accessToken, refreshToken: t.refreshToken || null, expiresAt: new Date(Date.now() + t.expiresIn * 1000) };
  };

  const doSend = async (): Promise<Omit<AccountSendResult, 'platformUserId'>> => {
    if (platform === 'twitch') {
      if (!dir[0].twitchUserId) throw new SendError('channel has no twitch id', 404);
      return sendTwitch({ accessToken: ident!.accessToken, senderId: ident!.platformUserId, broadcasterId: dir[0].twitchUserId, text, replyTo: p.replyTo });
    }
    if (platform === 'kick') {
      if (!dir[0].kickUserId) throw new SendError('channel has no kick id', 404);
      try {
        return await sendKick({ accessToken: ident!.accessToken, broadcasterUserId: dir[0].kickUserId, text, replyTo: p.replyTo });
      } catch (e) {
        // Kick public API vrací na odpověď 404 „Not found" (2026-09-23, i se správným
        // broadcaster_user_id). Zpráva nesmí propadnout → znovu jako obyčejná „@login text"
        // (jako odpověď napříč platformami). Log rozliší, jestli padá jen odpověď.
        if (!(e instanceof SendError) || e.status !== 404 || !p.replyTo) throw e;
        const at = p.replyToUser ? `@${p.replyToUser.replace(/^@/, '')} ` : '';
        p.log?.warn({ accountId, replyTo: p.replyTo, err: e.message }, 'kick: odpověď odmítnuta → posílám jako zprávu s @');
        const sentText = text.startsWith(at) ? text : at + text;
        const res = await sendKick({ accessToken: ident!.accessToken, broadcasterUserId: dir[0].kickUserId, text: sentText, replyTo: null });
        p.log?.info({ accountId, id: res.id }, 'kick: záložní zpráva bez reply odeslána');
        // Klient podle toho zahodí optimistickou „odpověď" (echo přijde jako „@login text").
        return { ...res, sentText, fallback: 'mention' as const };
      }
    }
    const videoId = p.ingest?.videoIdFor('youtube', dir[0].youtubeHandle || channel) || null;
    if (!videoId) throw new SendError('youtube: stream not live (no video id)', 409);
    const liveChatId = await youtubeLiveChatId({ accessToken: ident!.accessToken, videoId });
    if (!liveChatId) throw new SendError('youtube: live chat not active', 409);
    return sendYoutube({ accessToken: ident!.accessToken, liveChatId, text });
  };

  await p.beforeSend?.(ident);

  if (needsRefresh(ident.expiresAt)) await refresh();
  let res: Omit<AccountSendResult, 'platformUserId'>;
  try {
    res = await doSend();
  } catch (e) {
    if (e instanceof SendError && e.retryable) { await refresh(); res = await doSend(); } else throw e;
  }
  return { ...res, platformUserId: ident!.platformUserId };
}
