// Moderace z UnityChatu: smazání zprávy, timeout/ban/unban a varování na platformě. Aktér = vlastní
// účet moda (je mod v kanálu + má moderátorské scopes), jinak bot workspace. NIKDY nelogovat tokeny.
import { config } from '../config.js';
import { getDecryptedIdentity, storeRefreshedTokens, needsRefresh, type TokenSet } from './webAuth.js';
import { getBotIdentity, storeBotTokens, markBotExpired } from './botIdentities.js';
import type { Platform, WorkspaceInfo } from './zidolista.js';
import { defaultWorkspace, registryPlatformChannel } from './platformChannels.js';
import { chatRole, type ChatRole } from './chatRole.js';
import { missingModScopes } from './modScopes.js';
import { refreshTokens } from './platformTokens.js';
import { twitchUserId, kickUserId } from './botSend.js';
import { youtubeLiveChatId } from './webSend.js';
import { isGifMessageId } from './gifIds.js';

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
  /** Kick: user_id kanálu (broadcaster_user_id) podle slugu. */
  kickBroadcasterId?: (slug: string) => Promise<string | null>;
  /** YouTube: videoId živého streamu platformního kanálu (ingest). Bez něj YouTube bany = error:not_live. */
  youtubeVideoId?: (platformChannel: string) => string | null;
}

// registryPlatformChannel + defaultWorkspace: viz lib/platformChannels.ts (vytažené odsud, aby
// chatRole.ts mohlo importovat registryPlatformChannel bez cyklu — modActions.ts importuje chatRole).

class HttpFail extends Error { constructor(public status: number, public detail = '') { super(`HTTP ${status}`); } }
/** Selhání s vlastním kódem → ModResult `error:<code>` (no_channel, not_live, …). */
class ModFail extends Error { constructor(public code: string) { super(code); } }

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

/**
 * Volání moderátorského API platformy. `okStatuses` = stavy, které znamenají splněný cíl
 * (404 u mazání = zpráva už neexistuje, 400 u Twitch unbanu = uživatel není zabanovaný).
 * Vrací JSON těla (nebo {}), jinak HttpFail se statusem.
 */
async function platformCall(
  platform: Platform, token: string, url: string, f: typeof fetch,
  opts: { method: 'DELETE' | 'POST'; body?: unknown; okStatuses?: number[] },
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (platform === 'twitch') headers['Client-Id'] = config.TWITCH_CLIENT_ID;
  if (platform === 'kick') headers.Accept = 'application/json';
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await f(url, {
    method: opts.method, headers, signal: AbortSignal.timeout(10_000),
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  if (r.ok || (opts.okStatuses ?? []).includes(r.status)) {
    try { return ((await r.json()) as Record<string, unknown>) ?? {}; } catch { return {}; }
  }
  // Důvod odmítnutí z těla odpovědi platformy (Twitch/Kick `message`) — jen do logu, bez tokenů (tělo je odpověď API).
  let detail = '';
  try { const j = (await r.json()) as Record<string, unknown>; detail = String(j?.message ?? j?.error ?? '').slice(0, 200); } catch {}
  throw new HttpFail(r.status, detail);
}

/** Kontext pro operaci na platformě: aktér (už s čerstvým tokenem), platformní kanál, fetch. */
export interface ActorCtx { actor: ModIdent; platformChannel: string; fetch: typeof fetch }

/**
 * Společné jádro všech moderačních akcí: vybere aktéra (účet moda, je-li na platformě mod
 * a má MOD_SCOPES, jinak bot workspace), proaktivně / při 401 obnoví token a spustí `op`.
 * Chyby balí do ModResult (`error:<status|code>`), kvůli platformě nikdy nevyhazuje.
 * PŘEDPOKLAD: volající MUSÍ předem ověřit, že UC účet smí v kanálu moderovat
 * (accountModIdentities) — tahle funkce to nekontroluje; bez toho by kterýkoli přihlášený
 * divák mohl nechat bota moderovat. `accountId: null` = jen bot workspace (integrace
 * Židolišty — autorizaci tam dělá inbound klíč + HMAC a mapování slug → kanál).
 */
export async function withModActor<T>(
  p: { accountId: number | null; channel: string; platform: Platform },
  deps: ModDeps,
  label: string,
  op: (ctx: ActorCtx) => Promise<T>,
): Promise<{ result: ModResult; value?: T }> {
  const f = deps.fetch ?? fetch;
  const ids = deps.identities ?? {};
  const getMod = ids.mod ?? getDecryptedIdentity;
  const getBot = ids.bot ?? getBotIdentity;
  const getRole = ids.role ?? chatRole;
  const refresh = deps.refresh ?? refreshTokens;
  const storeMod = deps.storeMod ?? storeRefreshedTokens;
  const storeBot = deps.storeBot ?? storeBotTokens;
  const expireBot = deps.markBotExpired ?? markBotExpired;

  const ucChannel = p.channel.toLowerCase();
  const ws = await (deps.workspace ?? defaultWorkspace)(ucChannel);
  const pch = await registryPlatformChannel(ucChannel, p.platform, ws);
  if (!pch) return { result: 'error:no_channel' };

  // 1) vlastní účet moda
  let actor: ModIdent | null = null;
  let kind: 'mod' | 'bot' = 'mod';
  const mod = p.accountId === null ? null : await getMod(p.accountId, p.platform);
  if (mod && missingModScopes(p.platform, mod.scopes).length === 0) {
    const role = await getRole(p.platform, mod.login, pch);
    if (role === 'moderator' || role === 'broadcaster') actor = mod;
  }
  // 2) bot workspace
  if (!actor && ws) {
    const bot = await getBot(ws.slug, p.platform, ws.bot.mode !== 'shared');
    if (bot && bot.state !== 'expired' && missingModScopes(p.platform, bot.scopes).length === 0) { actor = bot; kind = 'bot'; }
  }
  if (!actor) return { result: 'error:no_actor' };
  let a: ModIdent = actor;

  const doRefresh = async () => {
    if (!a.refreshToken) throw new HttpFail(401);
    let t: TokenSet;
    try { t = await refresh(p.platform, a.refreshToken); }
    catch (e) { throw new HttpFail(refreshStatus(e)); }
    if (kind === 'mod') await storeMod(p.accountId!, p.platform, t);
    else await storeBot(a.workspace!, p.platform, t);
    a = { ...a, accessToken: t.accessToken, refreshToken: t.refreshToken || null, expiresAt: new Date(Date.now() + t.expiresIn * 1000) };
  };
  const run = () => op({ actor: a, platformChannel: pch, fetch: f });

  try {
    if (a.refreshToken && needsRefresh(a.expiresAt)) {
      // Přechodná chyba proaktivního refreshe (5xx, síť) nevadí — zkusit současný token, 401 cestu řeší retry níže.
      try { await doRefresh(); } catch (e) { if (statusOf(e) === 401) throw e; }
    }
    let value: T;
    try { value = await run(); }
    catch (e) {
      if (statusOf(e) !== 401) throw e;
      await doRefresh();
      value = await run();
    }
    deps.log?.info?.({ platform: p.platform, actor: kind }, `${label}: ok`);
    return { result: kind === 'mod' ? 'ok' : 'bot', value };
  } catch (e) {
    if (e instanceof ModFail) {
      deps.log?.warn({ platform: p.platform, actor: kind, code: e.code }, `${label}: selhalo`);
      return { result: `error:${e.code}` };
    }
    const status = statusOf(e);
    if (kind === 'bot' && status === 401) await expireBot(a.workspace!, p.platform).catch(() => {});
    deps.log?.warn({ platform: p.platform, actor: kind, status, detail: (e as HttpFail)?.detail || undefined }, `${label}: selhalo`);
    return { result: `error:${status || 'failed'}` };
  }
}

/** Twitch broadcaster_id kanálu (tokenem aktéra); chybí → error:no_channel. */
async function twitchBroadcaster(ctx: ActorCtx, deps: ModDeps): Promise<string> {
  const bid = deps.broadcasterId ?? ((login: string, token: string) => twitchUserId(login, token, ctx.fetch));
  const b = await bid(ctx.platformChannel, ctx.actor.accessToken);
  if (!b) throw new ModFail('no_channel');
  return b;
}

/** Kick broadcaster_user_id kanálu; chybí → error:no_channel. */
async function kickBroadcaster(ctx: ActorCtx, deps: ModDeps): Promise<number> {
  const id = await (deps.kickBroadcasterId ?? ((slug: string) => kickUserId(slug, ctx.fetch)))(ctx.platformChannel);
  if (!id) throw new ModFail('no_channel');
  return Number(id);
}

/** YouTube liveChatId živého streamu (existující helper youtubeLiveChatId); stream neběží → error:not_live. */
async function youtubeChat(ctx: ActorCtx, deps: ModDeps): Promise<string> {
  const videoId = deps.youtubeVideoId?.(ctx.platformChannel) ?? null;
  if (!videoId) throw new ModFail('not_live');
  // SendError 401 z youtubeLiveChatId nese status → withModActor obnoví token a zkusí znovu.
  const lc = await youtubeLiveChatId({ accessToken: ctx.actor.accessToken, videoId }, ctx.fetch);
  if (!lc) throw new ModFail('not_live');
  return lc;
}

const helix = (path: string, q: Record<string, string>) =>
  `https://api.twitch.tv/helix/${path}?${new URLSearchParams(q).toString()}`;

/**
 * Smaže zprávu na platformě účtem moda, jinak botem workspace.
 * PŘEDPOKLAD: volající MUSÍ předem ověřit, že UC účet smí v kanálu moderovat
 * (accountModPlatforms / isModOrBroadcaster). Tahle funkce to nekontroluje — bez
 * toho by kterýkoli přihlášený divák mohl nechat bota mazat zprávy.
 * `accountId: null` = jen bot workspace (integrace Židolišty — UC účet moda tam není;
 * autorizaci tam dělá inbound klíč + HMAC a mapování slug → kanál).
 */
export async function deletePlatformMessage(
  p: { accountId: number | null; channel: string; platform: Platform; messageId: string },
  deps: ModDeps = {},
): Promise<ModResult> {
  // Schválený GIF (část 4) je syntetická zpráva jen v UnityChatu — na platformě není co mazat.
  if (isGifMessageId(p.messageId)) return 'ok';
  const { result } = await withModActor(p, deps, 'mod delete', async (ctx) => {
    let url: string;
    if (p.platform === 'twitch') {
      const b = await twitchBroadcaster(ctx, deps);
      url = `https://api.twitch.tv/helix/moderation/chat?broadcaster_id=${encodeURIComponent(b)}&moderator_id=${encodeURIComponent(ctx.actor.platformUserId)}&message_id=${encodeURIComponent(p.messageId)}`;
    } else if (p.platform === 'kick') {
      url = `https://api.kick.com/public/v1/chat/${encodeURIComponent(p.messageId)}`;
    } else {
      url = `https://www.googleapis.com/youtube/v3/liveChat/messages?id=${encodeURIComponent(p.messageId)}`;
    }
    // 404 = zpráva už neexistuje (smazal ji někdo jiný) → cíl splněn
    await platformCall(p.platform, ctx.actor.accessToken, url, ctx.fetch, { method: 'DELETE', okStatuses: [404] });
  });
  return result;
}

/** Předvolby timeoutu (s) v nabídce moda; ban = permanentní (durationSec null). */
export const TIMEOUT_DURATIONS = [5, 30, 60, 300, 600, 1800, 3600, 7200] as const;
/** Vlastní délka timeoutu (nabídka moda i Chat Log): 1 s až Twitch limit 14 dní. */
export const MAX_TIMEOUT_SEC = 1_209_600;
/** Kick bere timeout v minutách, nejvýš 7 dní. */
export const KICK_MAX_TIMEOUT_MIN = 10_080;

/** Kick má timeout v celých minutách (min. 1, max. 7 dní) → 5 s a 30 s = 1 min. */
export function kickMinutes(sec: number): number {
  return Math.min(KICK_MAX_TIMEOUT_MIN, Math.max(1, Math.ceil(sec / 60)));
}

export interface BanParams {
  accountId: number | null;
  channel: string;
  platform: Platform;
  /** ID uživatele na platformě (Twitch user id / Kick user id / YouTube channel id). */
  userId: string;
  /** null = permanentní ban, číslo = timeout v sekundách. */
  durationSec: number | null;
  reason?: string | null;
}

export interface BanOutcome {
  result: ModResult;
  /** YouTube: id banu z liveChatBans.insert (unban ho potřebuje). */
  youtubeBanId?: string | null;
}

/**
 * Timeout (durationSec) nebo permanentní ban (null) na platformě: Twitch Helix POST /moderation/bans,
 * Kick POST /public/v1/moderation/bans (duration v minutách), YouTube liveChatBans.insert
 * (temporary + banDurationSeconds / permanent). PŘEDPOKLAD jako deletePlatformMessage: mod ověřený volajícím.
 */
export async function banPlatformUser(p: BanParams, deps: ModDeps = {}): Promise<BanOutcome> {
  const reason = p.reason ? p.reason.trim().slice(0, 500) : '';
  const label = p.durationSec === null ? 'mod ban' : 'mod timeout';
  const { result, value } = await withModActor(p, deps, label, async (ctx): Promise<string | null> => {
    if (p.platform === 'twitch') {
      const b = await twitchBroadcaster(ctx, deps);
      const data: Record<string, unknown> = { user_id: p.userId };
      if (p.durationSec !== null) data.duration = p.durationSec;
      if (reason) data.reason = reason;
      await platformCall('twitch', ctx.actor.accessToken, helix('moderation/bans', { broadcaster_id: b, moderator_id: ctx.actor.platformUserId }), ctx.fetch, { method: 'POST', body: { data } });
      return null;
    }
    if (p.platform === 'kick') {
      const body: Record<string, unknown> = { broadcaster_user_id: await kickBroadcaster(ctx, deps), user_id: Number(p.userId) };
      if (p.durationSec !== null) body.duration = kickMinutes(p.durationSec);
      if (reason) body.reason = reason;
      await platformCall('kick', ctx.actor.accessToken, 'https://api.kick.com/public/v1/moderation/bans', ctx.fetch, { method: 'POST', body });
      return null;
    }
    const liveChatId = await youtubeChat(ctx, deps);
    const snippet: Record<string, unknown> = {
      liveChatId,
      type: p.durationSec === null ? 'permanent' : 'temporary',
      bannedUserDetails: { channelId: p.userId },
    };
    if (p.durationSec !== null) snippet.banDurationSeconds = p.durationSec;
    const j = await platformCall('youtube', ctx.actor.accessToken, 'https://www.googleapis.com/youtube/v3/liveChat/bans?part=snippet', ctx.fetch, { method: 'POST', body: { snippet } });
    return typeof j.id === 'string' ? j.id : null;
  });
  return p.platform === 'youtube' ? { result, youtubeBanId: value ?? null } : { result };
}

export const timeoutUser = (p: Omit<BanParams, 'durationSec'> & { durationSec: number }, deps?: ModDeps) => banPlatformUser(p, deps);
export const banUser = (p: Omit<BanParams, 'durationSec'>, deps?: ModDeps) => banPlatformUser({ ...p, durationSec: null }, deps);

/**
 * Zruší ban/timeout. Twitch DELETE /moderation/bans (400 = nebyl zabanovaný → cíl splněn),
 * Kick DELETE /public/v1/moderation/bans (404 = cíl splněn), YouTube liveChatBans.delete
 * (potřebuje id banu → bez něj `error:no_ban_id`, nic se nevolá).
 */
export async function unbanUser(
  p: { accountId: number | null; channel: string; platform: Platform; userId: string; youtubeBanId?: string | null },
  deps: ModDeps = {},
): Promise<ModResult> {
  if (p.platform === 'youtube' && !p.youtubeBanId) return 'error:no_ban_id';
  const { result } = await withModActor(p, deps, 'mod unban', async (ctx) => {
    if (p.platform === 'twitch') {
      const b = await twitchBroadcaster(ctx, deps);
      await platformCall('twitch', ctx.actor.accessToken, helix('moderation/bans', { broadcaster_id: b, moderator_id: ctx.actor.platformUserId, user_id: p.userId }), ctx.fetch, { method: 'DELETE', okStatuses: [400] });
      return;
    }
    if (p.platform === 'kick') {
      const body = { broadcaster_user_id: await kickBroadcaster(ctx, deps), user_id: Number(p.userId) };
      await platformCall('kick', ctx.actor.accessToken, 'https://api.kick.com/public/v1/moderation/bans', ctx.fetch, { method: 'DELETE', body, okStatuses: [404] });
      return;
    }
    await platformCall('youtube', ctx.actor.accessToken, `https://www.googleapis.com/youtube/v3/liveChat/bans?id=${encodeURIComponent(p.youtubeBanId!)}`, ctx.fetch, { method: 'DELETE', okStatuses: [404] });
  });
  return result;
}

/** Nativní varování — jen Twitch (Helix POST /moderation/warnings, důvod povinný). Jiné platformy → error:unsupported. */
export async function warnUser(
  p: { accountId: number | null; channel: string; platform: Platform; userId: string; reason: string },
  deps: ModDeps = {},
): Promise<ModResult> {
  if (p.platform !== 'twitch') return 'error:unsupported';
  const reason = p.reason.trim().slice(0, 500);
  if (!reason) return 'error:reason';
  const { result } = await withModActor(p, deps, 'mod warn', async (ctx) => {
    const b = await twitchBroadcaster(ctx, deps);
    await platformCall('twitch', ctx.actor.accessToken, helix('moderation/warnings', { broadcaster_id: b, moderator_id: ctx.actor.platformUserId }), ctx.fetch, { method: 'POST', body: { data: { user_id: p.userId, reason } } });
  });
  return result;
}
