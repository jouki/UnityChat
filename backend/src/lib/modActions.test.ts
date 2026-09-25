import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deletePlatformMessage, banPlatformUser, unbanUser, warnUser, kickMinutes, type ModDeps } from './modActions.js';
import { MOD_SCOPES } from './modScopes.js';
import type { WorkspaceInfo, Platform } from './zidolista.js';

type Call = { url: string; init: RequestInit };
function seqFetch(statuses: number[], calls: Call[]) {
  let i = 0;
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init || {} });
    const s = statuses[Math.min(i++, statuses.length - 1)];
    return new Response(s === 204 ? null : JSON.stringify({}), { status: s });
  }) as typeof fetch;
}

const future = new Date(Date.now() + 3600_000);
const ws: WorkspaceInfo = { slug: 'rob', channels: { twitch: 'robdiesalot', kick: 'robdiesalot', youtube: 'robdiesalot' }, bot: { mode: 'own', displayName: 'JoukiBOT' } };
function modIdent(platform: Platform, scopes: string[] = [...MOD_SCOPES[platform]]) {
  return { platform, login: 'modik', displayName: 'Modik', avatarUrl: null, platformUserId: 'm1', accessToken: 'modtok', refreshToken: 'modref', expiresAt: future, scopes };
}
function botIdent(platform: Platform) {
  return { workspace: 'rob', platform, platformUserId: 'b1', login: 'joukibot', displayName: 'JoukiBOT', accessToken: 'bottok', refreshToken: 'botref', expiresAt: future, state: 'online' as const, scopes: [...MOD_SCOPES[platform]] };
}
function deps(over: Partial<ModDeps> & { calls: Call[]; statuses?: number[] }): ModDeps {
  const { calls, statuses = [204], ...rest } = over;
  return {
    fetch: seqFetch(statuses, calls),
    workspace: async () => ws,
    broadcasterId: async () => 'b160',
    refresh: async () => ({ accessToken: 'newtok', refreshToken: 'newref', expiresIn: 3600, scopes: [] }),
    storeMod: async () => {},
    storeBot: async () => {},
    markBotExpired: async () => {},
    ...rest,
    identities: { mod: async () => null, bot: async () => null, role: async () => 'viewer', ...(rest.identities || {}) },
  };
}
const auth = (c: Call) => (c.init.headers as Record<string, string>).Authorization;

test('mod s oprávněními → Twitch DELETE jeho tokenem, výsledek ok', async () => {
  const calls: Call[] = [];
  const r = await deletePlatformMessage({ accountId: 1, channel: 'robdiesalot', platform: 'twitch', messageId: 'msg-1' },
    deps({ calls, identities: { mod: async () => modIdent('twitch'), bot: async () => botIdent('twitch'), role: async () => 'moderator' } }));
  assert.equal(r, 'ok');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'DELETE');
  assert.equal(calls[0].url, 'https://api.twitch.tv/helix/moderation/chat?broadcaster_id=b160&moderator_id=m1&message_id=msg-1');
  assert.equal(auth(calls[0]), 'Bearer modtok');
  assert.ok((calls[0].init.headers as Record<string, string>)['Client-Id'] !== undefined);
});

test('mod bez moderátorských scopes → bot, výsledek bot', async () => {
  const calls: Call[] = [];
  const r = await deletePlatformMessage({ accountId: 1, channel: 'robdiesalot', platform: 'twitch', messageId: 'msg-1' },
    deps({ calls, identities: { mod: async () => modIdent('twitch', ['user:write:chat']), bot: async () => botIdent('twitch'), role: async () => 'moderator' } }));
  assert.equal(r, 'bot');
  assert.equal(auth(calls[0]), 'Bearer bottok');
  assert.match(calls[0].url, /moderator_id=b1/);
});

test('YouTube: není mod → bot, DELETE s id=', async () => {
  const calls: Call[] = [];
  const r = await deletePlatformMessage({ accountId: 1, channel: 'robdiesalot', platform: 'youtube', messageId: 'yt/1' },
    deps({ calls, identities: { mod: async () => modIdent('youtube'), bot: async () => botIdent('youtube'), role: async () => 'viewer' } }));
  assert.equal(r, 'bot');
  assert.equal(calls[0].url, 'https://www.googleapis.com/youtube/v3/liveChat/messages?id=yt%2F1');
  assert.equal(calls[0].init.method, 'DELETE');
});

test('Kick: DELETE /public/v1/chat/{id}', async () => {
  const calls: Call[] = [];
  const r = await deletePlatformMessage({ accountId: 1, channel: 'robdiesalot', platform: 'kick', messageId: 'k-1' },
    deps({ calls, identities: { mod: async () => modIdent('kick'), bot: async () => null, role: async () => 'broadcaster' } }));
  assert.equal(r, 'ok');
  assert.equal(calls[0].url, 'https://api.kick.com/public/v1/chat/k-1');
});

test('401 → refresh → retry → ok, uloží tokeny moda', async () => {
  const calls: Call[] = [];
  let stored = 0;
  const r = await deletePlatformMessage({ accountId: 1, channel: 'robdiesalot', platform: 'twitch', messageId: 'msg-1' },
    deps({ calls, statuses: [401, 204], storeMod: async () => { stored++; }, identities: { mod: async () => modIdent('twitch'), bot: async () => null, role: async () => 'moderator' } }));
  assert.equal(r, 'ok');
  assert.equal(calls.length, 2);
  assert.equal(auth(calls[1]), 'Bearer newtok');
  assert.equal(stored, 1);
});

test('bot: 401 a refresh selže → markBotExpired + error:401', async () => {
  const calls: Call[] = [];
  let expired = 0;
  const r = await deletePlatformMessage({ accountId: 1, channel: 'robdiesalot', platform: 'twitch', messageId: 'msg-1' },
    deps({ calls, statuses: [401], refresh: async () => { throw Object.assign(new Error('bad'), { status: 401 }); }, markBotExpired: async () => { expired++; }, identities: { mod: async () => null, bot: async () => botIdent('twitch'), role: async () => 'viewer' } }));
  assert.equal(r, 'error:401');
  assert.equal(expired, 1);
});

test('žádný aktér → error:no_actor', async () => {
  const calls: Call[] = [];
  const r = await deletePlatformMessage({ accountId: 1, channel: 'robdiesalot', platform: 'twitch', messageId: 'msg-1' }, deps({ calls }));
  assert.equal(r, 'error:no_actor');
  assert.equal(calls.length, 0);
});

test('404 = už smazaná → ok; jiná chyba → error:<status>', async () => {
  const calls: Call[] = [];
  const idents = { mod: async () => modIdent('twitch'), bot: async () => null, role: async () => 'moderator' as const };
  assert.equal(await deletePlatformMessage({ accountId: 1, channel: 'robdiesalot', platform: 'twitch', messageId: 'x' }, deps({ calls, statuses: [404], identities: idents })), 'ok');
  assert.equal(await deletePlatformMessage({ accountId: 1, channel: 'robdiesalot', platform: 'twitch', messageId: 'x' }, deps({ calls, statuses: [403], identities: idents })), 'error:403');
});

test('proaktivní refresh s přechodnou chybou (503) → smazání současným tokenem', async () => {
  const calls: Call[] = [];
  const stale = { ...modIdent('twitch'), expiresAt: new Date(Date.now() - 1000) };
  const r = await deletePlatformMessage({ accountId: 1, channel: 'robdiesalot', platform: 'twitch', messageId: 'msg-1' },
    deps({ calls, refresh: async () => { throw new Error('Twitch token refresh failed: 503'); }, identities: { mod: async () => stale, bot: async () => null, role: async () => 'moderator' } }));
  assert.equal(r, 'ok');
  assert.equal(auth(calls[0]), 'Bearer modtok');
});

test('proaktivní refresh s neplatným refresh tokenem (400) → error:401 bez volání platformy', async () => {
  const calls: Call[] = [];
  const stale = { ...modIdent('twitch'), expiresAt: new Date(Date.now() - 1000) };
  const r = await deletePlatformMessage({ accountId: 1, channel: 'robdiesalot', platform: 'twitch', messageId: 'msg-1' },
    deps({ calls, refresh: async () => { throw new Error('Twitch token refresh failed: 400'); }, identities: { mod: async () => stale, bot: async () => null, role: async () => 'moderator' } }));
  assert.equal(r, 'error:401');
  assert.equal(calls.length, 0);
});

test('accountId null (jen bot, integrace Židolišty) → účet moda se vůbec nehledá, maže bot', async () => {
  const calls: Call[] = [];
  let modLookups = 0;
  const r = await deletePlatformMessage({ accountId: null, channel: 'robdiesalot', platform: 'twitch', messageId: 'msg-z' },
    deps({ calls, identities: { mod: async () => { modLookups++; return modIdent('twitch'); }, bot: async () => botIdent('twitch'), role: async () => 'moderator' } }));
  assert.equal(r, 'bot');
  assert.equal(modLookups, 0);
  assert.equal(auth(calls[0]), 'Bearer bottok');
});

test('accountId null a bot chybí → error:no_actor', async () => {
  const calls: Call[] = [];
  const r = await deletePlatformMessage({ accountId: null, channel: 'robdiesalot', platform: 'kick', messageId: 'k-z' },
    deps({ calls, identities: { mod: async () => modIdent('kick'), bot: async () => null, role: async () => 'broadcaster' } }));
  assert.equal(r, 'error:no_actor');
  assert.equal(calls.length, 0);
});

// ---- část 2: timeout / ban / unban / varování ----
function jsonFetch(responses: Array<{ status: number; body?: unknown }>, calls: Call[]) {
  let i = 0;
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init || {} });
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
}
const bodyOf = (c: Call) => JSON.parse(String(c.init.body));
const modTw = { mod: async () => modIdent('twitch'), bot: async () => null, role: async () => 'moderator' as const };

test('Twitch timeout: POST /moderation/bans s duration + reason, tokenem moda', async () => {
  const calls: Call[] = [];
  const r = await banPlatformUser({ accountId: 1, channel: 'robdiesalot', platform: 'twitch', userId: 'u9', durationSec: 300, reason: 'spam' },
    deps({ calls, identities: modTw }));
  assert.equal(r.result, 'ok');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].url, 'https://api.twitch.tv/helix/moderation/bans?broadcaster_id=b160&moderator_id=m1');
  assert.deepEqual(bodyOf(calls[0]), { data: { user_id: 'u9', duration: 300, reason: 'spam' } });
  assert.equal(auth(calls[0]), 'Bearer modtok');
});

test('Twitch ban (permanentní): bez duration', async () => {
  const calls: Call[] = [];
  const r = await banPlatformUser({ accountId: 1, channel: 'robdiesalot', platform: 'twitch', userId: 'u9', durationSec: null }, deps({ calls, identities: modTw }));
  assert.equal(r.result, 'ok');
  assert.deepEqual(bodyOf(calls[0]), { data: { user_id: 'u9' } });
});

test('Kick timeout 5 s → 1 minuta, broadcaster_user_id z kickBroadcasterId, botem', async () => {
  const calls: Call[] = [];
  const r = await banPlatformUser({ accountId: 1, channel: 'robdiesalot', platform: 'kick', userId: '77', durationSec: 5 },
    deps({ calls, kickBroadcasterId: async () => '555', identities: { mod: async () => null, bot: async () => botIdent('kick'), role: async () => 'viewer' } }));
  assert.equal(r.result, 'bot');
  assert.equal(calls[0].url, 'https://api.kick.com/public/v1/moderation/bans');
  assert.deepEqual(bodyOf(calls[0]), { broadcaster_user_id: 555, user_id: 77, duration: 1 });
  assert.equal(kickMinutes(30), 1);
  assert.equal(kickMinutes(61), 2);
  assert.equal(kickMinutes(7200), 120);
  assert.equal(kickMinutes(1_209_600), 10_080);
});

test('YouTube timeout: liveChatId z videos.list, liveChatBans.insert temporary, vrátí id banu', async () => {
  const calls: Call[] = [];
  const r = await banPlatformUser({ accountId: 1, channel: 'robdiesalot', platform: 'youtube', userId: 'UCx', durationSec: 60 },
    deps({ calls, youtubeVideoId: () => 'vid1', fetch: jsonFetch([
      { status: 200, body: { items: [{ liveStreamingDetails: { activeLiveChatId: 'LC1' } }] } },
      { status: 200, body: { id: 'BAN-1' } },
    ], calls), identities: { mod: async () => modIdent('youtube'), bot: async () => null, role: async () => 'moderator' } }));
  assert.equal(r.result, 'ok');
  assert.equal(r.youtubeBanId, 'BAN-1');
  assert.match(calls[0].url, /videos\?part=liveStreamingDetails&id=vid1/);
  assert.equal(calls[1].url, 'https://www.googleapis.com/youtube/v3/liveChat/bans?part=snippet');
  assert.deepEqual(bodyOf(calls[1]), { snippet: { liveChatId: 'LC1', type: 'temporary', bannedUserDetails: { channelId: 'UCx' }, banDurationSeconds: 60 } });
});

test('YouTube bez živého streamu → error:not_live, žádné volání platformy', async () => {
  const calls: Call[] = [];
  const r = await banPlatformUser({ accountId: 1, channel: 'robdiesalot', platform: 'youtube', userId: 'UCx', durationSec: null },
    deps({ calls, identities: { mod: async () => modIdent('youtube'), bot: async () => null, role: async () => 'moderator' } }));
  assert.equal(r.result, 'error:not_live');
  assert.equal(calls.length, 0);
});

test('ban: 401 → refresh → retry', async () => {
  const calls: Call[] = [];
  const r = await banPlatformUser({ accountId: 1, channel: 'robdiesalot', platform: 'twitch', userId: 'u9', durationSec: 60 },
    deps({ calls, statuses: [401, 200], identities: modTw }));
  assert.equal(r.result, 'ok');
  assert.equal(auth(calls[1]), 'Bearer newtok');
});

test('unban Twitch: DELETE s user_id; 400 (nebyl zabanovaný) = ok', async () => {
  const calls: Call[] = [];
  assert.equal(await unbanUser({ accountId: 1, channel: 'robdiesalot', platform: 'twitch', userId: 'u9' }, deps({ calls, statuses: [400], identities: modTw })), 'ok');
  assert.equal(calls[0].init.method, 'DELETE');
  assert.equal(calls[0].url, 'https://api.twitch.tv/helix/moderation/bans?broadcaster_id=b160&moderator_id=m1&user_id=u9');
});

test('unban Kick: DELETE s JSON tělem', async () => {
  const calls: Call[] = [];
  const r = await unbanUser({ accountId: 1, channel: 'robdiesalot', platform: 'kick', userId: '77' },
    deps({ calls, kickBroadcasterId: async () => '555', identities: { mod: async () => modIdent('kick'), bot: async () => null, role: async () => 'moderator' } }));
  assert.equal(r, 'ok');
  assert.equal(calls[0].init.method, 'DELETE');
  assert.deepEqual(bodyOf(calls[0]), { broadcaster_user_id: 555, user_id: 77 });
});

test('unban YouTube: bez id banu → error:no_ban_id; s id → DELETE liveChat/bans?id=', async () => {
  const calls: Call[] = [];
  const idents = { mod: async () => modIdent('youtube'), bot: async () => null, role: async () => 'moderator' as const };
  assert.equal(await unbanUser({ accountId: 1, channel: 'robdiesalot', platform: 'youtube', userId: 'UCx' }, deps({ calls, identities: idents })), 'error:no_ban_id');
  assert.equal(calls.length, 0);
  assert.equal(await unbanUser({ accountId: 1, channel: 'robdiesalot', platform: 'youtube', userId: 'UCx', youtubeBanId: 'BAN-1' }, deps({ calls, identities: idents })), 'ok');
  assert.equal(calls[0].url, 'https://www.googleapis.com/youtube/v3/liveChat/bans?id=BAN-1');
});

test('warn: Twitch POST /moderation/warnings; jiné platformy error:unsupported; prázdný důvod error:reason', async () => {
  const calls: Call[] = [];
  assert.equal(await warnUser({ accountId: 1, channel: 'robdiesalot', platform: 'twitch', userId: 'u9', reason: ' Nespamuj ' }, deps({ calls, identities: modTw })), 'ok');
  assert.equal(calls[0].url, 'https://api.twitch.tv/helix/moderation/warnings?broadcaster_id=b160&moderator_id=m1');
  assert.deepEqual(bodyOf(calls[0]), { data: { user_id: 'u9', reason: 'Nespamuj' } });
  assert.equal(await warnUser({ accountId: 1, channel: 'robdiesalot', platform: 'kick', userId: '1', reason: 'x' }, deps({ calls })), 'error:unsupported');
  assert.equal(await warnUser({ accountId: 1, channel: 'robdiesalot', platform: 'twitch', userId: '1', reason: '  ' }, deps({ calls })), 'error:reason');
  assert.equal(calls.length, 1);
});

test('ban bez aktéra → error:no_actor', async () => {
  const calls: Call[] = [];
  const r = await banPlatformUser({ accountId: null, channel: 'robdiesalot', platform: 'twitch', userId: 'u9', durationSec: 60 }, deps({ calls }));
  assert.equal(r.result, 'error:no_actor');
  assert.equal(calls.length, 0);
});
