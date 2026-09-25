import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deletePlatformMessage, type ModDeps } from './modActions.js';
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
