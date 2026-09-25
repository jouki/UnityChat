// Moderace z UnityChatu: smazání zprávy na platformě. Aktér = vlastní účet moda
// (je mod v kanálu + má moderátorské scopes), jinak bot workspace. NIKDY nelogovat tokeny.
import { config } from '../config.js';
import { getDecryptedIdentity, storeRefreshedTokens, needsRefresh, type TokenSet } from './webAuth.js';
import { getBotIdentity, storeBotTokens, markBotExpired } from './botIdentities.js';
import type { Platform, WorkspaceInfo } from './zidolista.js';
import { defaultWorkspace, registryPlatformChannel } from './platformChannels.js';
import { chatRole, type ChatRole } from './chatRole.js';
import { missingModScopes } from './modScopes.js';
import { refreshTokens } from './platformTokens.js';
import { twitchUserId } from './botSend.js';

export type ModResult = 'ok' | 'bot' | `error:${string}`;

/** Minimum identity, které moderace potřebuje (web identita moda i bot). */
export interface ModIdent {
  login: string;
  platformUserId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
  workspace?: string;
  state?: string;
}

type Log = { warn: (o: object, m: string) => void; info?: (o: object, m: string) => void };

export interface ModDeps {
  fetch?: typeof fetch;
  log?: Log;
  identities?: {
    mod?: (accountId: number, platform: Platform) => Promise<ModIdent | null>;
    bot?: (workspace: string, platform: Platform, preferOwn: boolean) => Promise<ModIdent | null>;
    role?: (platform: Platform, login: string, channel: string) => Promise<ChatRole>;
  };
  workspace?: (ucChannel: string) => Promise<WorkspaceInfo | null>;
  broadcasterId?: (login: string, accessToken: string) => Promise<string | null>;
  refresh?: (platform: Platform, refreshToken: string) => Promise<TokenSet>;
  storeMod?: (accountId: number, platform: Platform, t: TokenSet) => Promise<void>;
  storeBot?: (workspace: string, platform: Platform, t: TokenSet) => Promise<void>;
  markBotExpired?: (workspace: string, platform: Platform) => Promise<void>;
}

// registryPlatformChannel + defaultWorkspace: viz lib/platformChannels.ts (vytažené odsud, aby
// chatRole.ts mohlo importovat registryPlatformChannel bez cyklu — modActions.ts importuje chatRole).

class HttpFail extends Error { constructor(public status: number) { super(`HTTP ${status}`); } }
class NoChannel extends Error {}

/** HTTP status z chyby: HttpFail, SendError (twitchUserId) nebo `{status}`; jinak 0. */
function statusOf(e: unknown): number {
  const s = (e as { status?: unknown })?.status;
  return typeof s === 'number' ? s : 0;
}

/** Selhaný refresh: 400/401 od OAuth serveru = neplatný refresh token → 401; jinak status nebo 0. */
function refreshStatus(e: unknown): number {
  const s = statusOf(e) || Number(/(\d{3})\s*$/.exec((e as Error)?.message || '')?.[1] || 0);
  return s === 400 || s === 401 ? 401 : s;
}

async function callDelete(platform: Platform, token: string, url: string, f: typeof fetch): Promise<void> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (platform === 'twitch') headers['Client-Id'] = config.TWITCH_CLIENT_ID;
  if (platform === 'kick') headers.Accept = 'application/json';
  const r = await f(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(10_000) });
  // 404 = zpráva už neexistuje (smazal ji někdo jiný) → cíl splněn
  if (r.ok || r.status === 404) return;
  throw new HttpFail(r.status);
}

/**
 * Smaže zprávu na platformě účtem moda, jinak botem workspace.
 * PŘEDPOKLAD: volající MUSÍ předem ověřit, že UC účet smí v kanálu moderovat
 * (accountModPlatforms / isModOrBroadcaster). Tahle funkce to nekontroluje — bez
 * toho by kterýkoli přihlášený divák mohl nechat bota mazat zprávy.
 */
export async function deletePlatformMessage(
  p: { accountId: number; channel: string; platform: Platform; messageId: string },
  deps: ModDeps = {},
): Promise<ModResult> {
  const f = deps.fetch ?? fetch;
  const ids = deps.identities ?? {};
  const getMod = ids.mod ?? getDecryptedIdentity;
  const getBot = ids.bot ?? getBotIdentity;
  const getRole = ids.role ?? chatRole;
  const refresh = deps.refresh ?? refreshTokens;
  const storeMod = deps.storeMod ?? storeRefreshedTokens;
  const storeBot = deps.storeBot ?? storeBotTokens;
  const expireBot = deps.markBotExpired ?? markBotExpired;
  const bid = deps.broadcasterId ?? ((login: string, token: string) => twitchUserId(login, token, f));

  const ucChannel = p.channel.toLowerCase();
  const ws = await (deps.workspace ?? defaultWorkspace)(ucChannel);
  const pch = await registryPlatformChannel(ucChannel, p.platform, ws);
  if (!pch) return 'error:no_channel';

  // 1) vlastní účet moda
  let actor: ModIdent | null = null;
  let kind: 'mod' | 'bot' = 'mod';
  const mod = await getMod(p.accountId, p.platform);
  if (mod && missingModScopes(p.platform, mod.scopes).length === 0) {
    const role = await getRole(p.platform, mod.login, pch);
    if (role === 'moderator' || role === 'broadcaster') actor = mod;
  }
  // 2) bot workspace
  if (!actor && ws) {
    const bot = await getBot(ws.slug, p.platform, ws.bot.mode !== 'shared');
    if (bot && bot.state !== 'expired' && missingModScopes(p.platform, bot.scopes).length === 0) { actor = bot; kind = 'bot'; }
  }
  if (!actor) return 'error:no_actor';
  let a: ModIdent = actor;

  const doRefresh = async () => {
    if (!a.refreshToken) throw new HttpFail(401);
    let t: TokenSet;
    try { t = await refresh(p.platform, a.refreshToken); }
    catch (e) { throw new HttpFail(refreshStatus(e)); }
    if (kind === 'mod') await storeMod(p.accountId, p.platform, t);
    else await storeBot(a.workspace!, p.platform, t);
    a = { ...a, accessToken: t.accessToken, refreshToken: t.refreshToken || null, expiresAt: new Date(Date.now() + t.expiresIn * 1000) };
  };

  const doDelete = async () => {
    let url: string;
    if (p.platform === 'twitch') {
      const b = await bid(pch, a.accessToken);
      if (!b) throw new NoChannel('twitch channel not found');
      url = `https://api.twitch.tv/helix/moderation/chat?broadcaster_id=${encodeURIComponent(b)}&moderator_id=${encodeURIComponent(a.platformUserId)}&message_id=${encodeURIComponent(p.messageId)}`;
    } else if (p.platform === 'kick') {
      url = `https://api.kick.com/public/v1/chat/${encodeURIComponent(p.messageId)}`;
    } else {
      url = `https://www.googleapis.com/youtube/v3/liveChat/messages?id=${encodeURIComponent(p.messageId)}`;
    }
    await callDelete(p.platform, a.accessToken, url, f);
  };

  try {
    if (a.refreshToken && needsRefresh(a.expiresAt)) {
      // Přechodná chyba proaktivního refreshe (5xx, síť) nevadí — zkusit současný token, 401 cestu řeší retry níže.
      try { await doRefresh(); } catch (e) { if (statusOf(e) === 401) throw e; }
    }
    try { await doDelete(); }
    catch (e) {
      if (statusOf(e) !== 401) throw e;
      await doRefresh();
      await doDelete();
    }
    deps.log?.info?.({ platform: p.platform, actor: kind }, 'mod delete: ok');
    return kind === 'mod' ? 'ok' : 'bot';
  } catch (e) {
    if (e instanceof NoChannel) return 'error:no_channel';
    const status = statusOf(e);
    if (kind === 'bot' && status === 401) await expireBot(a.workspace!, p.platform).catch(() => {});
    deps.log?.warn({ platform: p.platform, actor: kind, status }, 'mod delete: selhalo');
    return `error:${status || 'failed'}`;
  }
}
