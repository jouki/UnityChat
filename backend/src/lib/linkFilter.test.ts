import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeLinkFilter, shouldFilter, parsePermitCommand, PermitStore, isKnownBot, createLinkFilter,
  refreshLinkFilter, linkFilterSync, _resetLinkFilterCache, _expireLinkFilterForTest, LINK_FILTER_OFF,
  type LinkFilterDeps, type LinkFilterSettings, type PermitRow,
} from './linkFilter.js';
import type { IngestMessage } from '../ingest/types.js';
import type { WorkspaceInfo } from './zidolista.js';
import { toRow } from '../ingest/normalize.js';
import { toClientMessage } from '../routes/chat.js';

const noRoles = { isSub: false, isMod: false, isVip: false, isBroadcaster: false };
const ALLOW = ['youtube.com', 'youtu.be', 'open.spotify.com'];
const quietLog = { info() {}, warn() {} };

test('shouldFilter: nepovolený host → host, povolené/subdomény projdou', () => {
  assert.equal(shouldFilter({ roles: noRoles, hosts: ['neco.cz'], allow: ALLOW, permit: false, bot: false }), 'neco.cz');
  assert.equal(shouldFilter({ roles: noRoles, hosts: ['www.youtube.com', 'youtu.be'], allow: ALLOW, permit: false, bot: false }), null);
  assert.equal(shouldFilter({ roles: noRoles, hosts: ['youtu.be', 'evil.cz'], allow: ALLOW, permit: false, bot: false }), 'evil.cz');
  assert.equal(shouldFilter({ roles: noRoles, hosts: ['spotify.com'], allow: ALLOW, permit: false, bot: false }), 'spotify.com');
  assert.equal(shouldFilter({ roles: noRoles, hosts: [], allow: ALLOW, permit: false, bot: false }), null);
});

test('shouldFilter: výjimky — broadcaster, mod, VIP, bot, permit; sub výjimku nemá', () => {
  const base = { hosts: ['neco.cz'], allow: [] as string[], permit: false, bot: false };
  assert.equal(shouldFilter({ ...base, roles: { ...noRoles, isBroadcaster: true } }), null);
  assert.equal(shouldFilter({ ...base, roles: { ...noRoles, isMod: true } }), null);
  assert.equal(shouldFilter({ ...base, roles: { ...noRoles, isVip: true } }), null);
  assert.equal(shouldFilter({ ...base, roles: noRoles, bot: true }), null);
  assert.equal(shouldFilter({ ...base, roles: noRoles, permit: true }), null);
  assert.equal(shouldFilter({ ...base, roles: { ...noRoles, isSub: true } }), 'neco.cz');
});

test('normalizeLinkFilter: jen enabled === true zapíná, domény a boti normalizované', () => {
  assert.deepEqual(normalizeLinkFilter(null), LINK_FILTER_OFF);
  assert.equal(normalizeLinkFilter({ enabled: 'true' }).enabled, false);
  const s = normalizeLinkFilter({ ok: true, enabled: true, allowDomains: ['https://www.YouTube.com/', 'youtu.be', 'youtu.be', '', 42], extraBots: ['@Moobot', 'Fossabot', 'bad login'], version: '2026-09-25T10:00:00Z' });
  assert.deepEqual(s, { enabled: true, allowDomains: ['youtube.com', 'youtu.be'], extraBots: ['moobot', 'fossabot'], version: '2026-09-25T10:00:00Z' });
});

test('parsePermitCommand: login, výchozí 60 s, sekundy/minuty, ořez 30–600', () => {
  assert.deepEqual(parsePermitCommand('!permit Spammer'), { login: 'spammer', durationSec: 60 });
  assert.deepEqual(parsePermitCommand('!permit @spammer'), { login: 'spammer', durationSec: 60 });
  assert.deepEqual(parsePermitCommand('  !PERMIT spammer 120'), { login: 'spammer', durationSec: 120 });
  assert.deepEqual(parsePermitCommand('!permit spammer 90s'), { login: 'spammer', durationSec: 90 });
  assert.deepEqual(parsePermitCommand('!permit spammer 2m'), { login: 'spammer', durationSec: 120 });
  assert.deepEqual(parsePermitCommand('!permit spammer 5min'), { login: 'spammer', durationSec: 300 });
  assert.deepEqual(parsePermitCommand('!permit spammer 5'), { login: 'spammer', durationSec: 30 });
  assert.deepEqual(parsePermitCommand('!permit spammer 60m'), { login: 'spammer', durationSec: 600 });
  assert.deepEqual(parsePermitCommand('!permit spammer blbost'), { login: 'spammer', durationSec: 60 });
  assert.equal(parsePermitCommand('!permit'), null);
  assert.equal(parsePermitCommand('!permitx spammer'), null);
  assert.equal(parsePermitCommand('ahoj !permit spammer'), null);
});

test('PermitStore: podle id i loginu, delší platnost vyhrává, kanál a platforma oddělené', () => {
  const s = new PermitStore();
  s.grant({ channel: 'Rob', platform: 'twitch', userId: '1', login: 'Spam', until: 2000 });
  assert.equal(s.active({ channel: 'rob', platform: 'twitch', userId: '1', login: 'x' }, 1000), true);
  assert.equal(s.active({ channel: 'rob', platform: 'twitch', userId: '9', login: 'spam' }, 1000), true);
  assert.equal(s.active({ channel: 'rob', platform: 'kick', userId: '1', login: 'spam' }, 1000), false);
  assert.equal(s.active({ channel: 'jiny', platform: 'twitch', userId: '1', login: 'spam' }, 1000), false);
  assert.equal(s.active({ channel: 'rob', platform: 'twitch', userId: '1' }, 2000), false, 'until je exkluzivní');
  s.grant({ channel: 'rob', platform: 'twitch', userId: '1', until: 1500 });
  assert.equal(s.active({ channel: 'rob', platform: 'twitch', userId: '1' }, 1800), true, 'kratší permit nepřepíše delší');
  s.prune(3000);
  assert.equal(s.size, 0);
});

const WS: WorkspaceInfo = { slug: 'rob', channels: { twitch: 'robdiesalot', kick: 'robdiesalot', youtube: 'robdiesalot' }, bot: { mode: 'shared', displayName: 'JoukiBOT', ownLogins: { kick: 'jouki-bot' } } };

test('isKnownBot: SE/Nightbot/Streamlabs, extraBots, vlastní login bota, bot identity', () => {
  const base = { platform: 'twitch' as const, userId: '5', ws: WS, extraBots: ['moobot'], isBotAccount: () => false };
  assert.equal(isKnownBot({ ...base, login: 'StreamElements' }), true);
  assert.equal(isKnownBot({ ...base, login: 'nightbot' }), true);
  assert.equal(isKnownBot({ ...base, login: 'streamlabs' }), true);
  assert.equal(isKnownBot({ ...base, login: 'moobot' }), true);
  assert.equal(isKnownBot({ ...base, platform: 'kick', login: 'jouki-bot' }), true);
  assert.equal(isKnownBot({ ...base, login: 'joukibot', isBotAccount: (_p, w, id) => id === '5' && w === 'rob' }), true);
  assert.equal(isKnownBot({ ...base, login: 'divak' }), false);
  assert.equal(isKnownBot({ ...base, platform: 'kick', login: 'nightbot' }), false, 'SE/Nightbot jen na Twitchi');
  assert.equal(isKnownBot({ ...base, platform: 'youtube', login: 'StreamElements' }), false);
  assert.equal(isKnownBot({ ...base, platform: 'kick', login: 'moobot' }), true, 'extraBots platí všude');
});

// ---- createLinkFilter (ingest onLive) ----
function msg(over: Partial<IngestMessage> = {}): IngestMessage {
  return {
    platform: 'twitch', platformMessageId: 'm1', platformUserId: '42', username: 'divak', channel: 'robdiesalot',
    content: 'koukni na neco.cz/x', contentRaw: { badges: '' }, sentAt: new Date(1_000), isUnitychatUser: false, isReply: false, replyToMessageId: null,
    ...over,
  };
}

function harness(settings: LinkFilterSettings = { enabled: true, allowDomains: ALLOW, extraBots: [], version: 'v1' }, over: Partial<LinkFilterDeps> = {}) {
  const calls = { published: [] as unknown[], deleted: [] as unknown[], stored: [] as PermitRow[][], actions: [] as unknown[] };
  const store = new PermitStore();
  let resolveDone!: () => void;
  const settled = new Promise<void>((r) => { resolveDone = r; });
  const deps: LinkFilterDeps = {
    workspaceFor: (platform, channel) => (WS.channels[platform] === channel ? WS : null),
    settingsFor: () => settings,
    isBotAccount: () => false,
    permits: store,
    publishDeleted: async (p) => { calls.published.push(p); },
    deletePlatform: async (p) => { calls.deleted.push(p); return 'bot'; },
    resolvePermitTarget: async () => [{ platform: 'twitch', userId: '42', login: 'divak' }, { platform: 'kick', userId: '77', login: 'divak_k' }],
    storePermits: async (rows) => { calls.stored.push(rows); for (const r of rows) store.grant({ channel: r.channel, platform: r.platform, userId: r.targetUserId || null, login: r.targetLogin, until: r.until.getTime() }, 0); },
    recordAction: async (v) => { calls.actions.push(v); if (calls.actions.length >= 1) resolveDone(); },
    now: () => 10_000,
    log: quietLog,
    ...over,
  };
  return { f: createLinkFilter(deps), calls, store, settled };
}

test('filtr: odkaz od diváka → m.deleted, SSE, smazání botem, audit; archiv i stream bez obsahu', async () => {
  const { f, calls, settled } = harness();
  const m = msg();
  const v = f.check(m);
  assert.deepEqual(v, { host: 'neco.cz', channel: 'robdiesalot' });
  assert.deepEqual(m.deleted, { by: 'filter', reason: 'link_filter' });
  await settled;
  assert.deepEqual(calls.published, [{ channel: 'robdiesalot', platform: 'twitch', messageId: 'm1', by: 'filter', reason: 'link_filter' }]);
  assert.deepEqual(calls.deleted, [{ accountId: null, channel: 'robdiesalot', platform: 'twitch', messageId: 'm1' }]);
  const row = toRow(m);
  assert.equal(row.deletedReason, 'link_filter');
  assert.equal(row.content, 'koukni na neco.cz/x', 'obsah zůstává v DB (obnovení permitem)');
  const client = toClientMessage({ ...row, deletedAt: row.deletedAt ?? null } as Parameters<typeof toClientMessage>[0], false);
  assert.equal(client.message, '');
  assert.equal((client as { deleted?: boolean }).deleted, true);
});

test('filtr: vypnutý / povolená doména / mod / VIP / bot / nenamapovaný kanál / bez odkazu → nic', () => {
  assert.equal(harness({ ...LINK_FILTER_OFF }).f.check(msg()), null);
  const { f, calls } = harness();
  assert.equal(f.check(msg({ content: 'https://youtu.be/abc' })), null);
  assert.equal(f.check(msg({ contentRaw: { badges: 'moderator/1' } })), null);
  assert.equal(f.check(msg({ contentRaw: { badges: 'vip/1' } })), null);
  assert.equal(f.check(msg({ username: 'robdiesalot' })), null, 'broadcaster podle loginu');
  assert.equal(f.check(msg({ username: 'StreamElements' })), null);
  assert.equal(f.check(msg({ channel: 'cizikanal' })), null);
  assert.equal(f.check(msg({ content: 'verze v1.2 ve 12:30' })), null);
  assert.equal(f.check(msg({ platform: 'kick', contentRaw: { badges: [{ type: 'og' }] } })), null, 'Kick OG = VIP');
  assert.equal(calls.published.length, 0);
});

test('filtr: extraBots ze Židolišty mají výjimku', () => {
  const { f } = harness({ enabled: true, allowDomains: [], extraBots: ['moobot'], version: null });
  assert.equal(f.check(msg({ username: 'Moobot' })), null);
});

test('filtr: aktivní permit (i na jiné platformě stejného účtu) → projde; propadlý → smaže', () => {
  const { f, store } = harness();
  store.grant({ channel: 'robdiesalot', platform: 'kick', userId: '77', until: 20_000 });
  assert.equal(f.check(msg({ platform: 'kick', platformUserId: '77' })), null);
  store.grant({ channel: 'robdiesalot', platform: 'twitch', login: 'divak', until: 5_000 });
  assert.notEqual(f.check(msg()), null, 'permit vypršel (now 10 000)');
});

test('!permit od moda → permit pro všechny identity cíle, pak odkaz projde', async () => {
  const { f, calls, store, settled } = harness();
  assert.equal(f.check(msg({ username: 'modik', platformUserId: '9', content: '!permit @Divak 2m', contentRaw: { badges: 'moderator/1' } })), null);
  await settled;
  assert.equal(calls.stored.length, 1);
  assert.deepEqual(calls.stored[0].map((r) => [r.platform, r.targetUserId, r.until.getTime(), r.by]), [
    ['twitch', '42', 130_000, 'twitch:modik'], ['kick', '77', 130_000, 'twitch:modik'],
  ]);
  assert.equal(store.active({ channel: 'robdiesalot', platform: 'kick', userId: '77' }, 10_000), true);
  assert.equal(f.check(msg()), null);
});

test('!permit na neznámého uživatele → permit podle loginu; od diváka / od našeho bota se ignoruje', async () => {
  const unknown = harness(undefined, { resolvePermitTarget: async () => [] });
  unknown.f.check(msg({ username: 'modik', content: '!permit novacek', contentRaw: { badges: 'moderator/1' } }));
  await unknown.settled;
  assert.deepEqual(unknown.calls.stored[0].map((r) => [r.platform, r.targetUserId, r.targetLogin]), [['twitch', '', 'novacek']]);
  assert.equal(unknown.f.check(msg({ username: 'Novacek', platformUserId: '500' })), null);

  const { f, calls } = harness(undefined, { isBotAccount: (_p, _w, _id, l) => l === 'joukibot' });
  f.check(msg({ content: '!permit divak' }));
  f.check(msg({ username: 'joukibot', content: '!permit divak', contentRaw: { badges: 'moderator/1' } }));
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.stored.length, 0);
});

test('!permit od diváka nepřeskočí filtr (s odkazem se smaže)', () => {
  const { f } = harness();
  assert.deepEqual(f.check(msg({ content: '!permit divak neco.cz/x' })), { host: 'neco.cz', channel: 'robdiesalot' });
});

test('echo vlastního !permit (udělen před < 10 s) se neukládá znovu; později ano', async () => {
  const { f, calls, store } = harness();
  store.grant({ channel: 'robdiesalot', platform: 'twitch', userId: '42', login: 'divak', until: 70_000 }, 5_000);
  f.check(msg({ username: 'modik', content: '!permit divak', contentRaw: { badges: 'moderator/1' } }));
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.stored.length, 0);
  const late = harness();
  late.store.grant({ channel: 'robdiesalot', platform: 'twitch', login: 'divak', until: 70_000 }, -5_000);
  late.f.check(msg({ username: 'modik', content: '!permit divak', contentRaw: { badges: 'moderator/1' } }));
  await late.settled;
  assert.equal(late.calls.stored.length, 1);
});

test('stará zpráva (> 60 s, replay po reconnectu) se nefiltruje', () => {
  const { f } = harness(undefined, { now: () => 200_000 });
  assert.equal(f.check(msg({ sentAt: new Date(100_000) })), null);
  assert.notEqual(f.check(msg({ sentAt: new Date(150_000) })), null);
});

test('filtr nikdy nevyhodí do ingestu', () => {
  const { f } = harness(undefined, { settingsFor: () => { throw new Error('boom'); } });
  assert.equal(f.check(msg()), null);
});

// ---- nastavení ze Židolišty (ETag/304, výpadek) ----
test('refreshLinkFilter: načte, pak If-None-Match → 304 drží stav; výpadek drží poslední; bez klíče vypnuto', async () => {
  _resetLinkFilterCache();
  const seen: Array<Record<string, string>> = [];
  let mode: 'ok' | '304' | 'fail' = 'ok';
  const fakeFetch = (async (_url: string, init: { headers: Record<string, string> }) => {
    seen.push(init.headers);
    if (mode === 'fail') throw new Error('ECONNREFUSED');
    if (mode === '304') return new Response(null, { status: 304 });
    return new Response(JSON.stringify({ ok: true, workspace: 'rob', enabled: true, allowDomains: ['youtube.com'], extraBots: [], version: 'v1' }), { status: 200, headers: { ETag: '"e1"' } });
  }) as unknown as typeof fetch;
  const opts = { fetch: fakeFetch, apiKey: 'k', base: 'https://z.example', force: true };

  assert.equal(linkFilterSync('rob').enabled, false, 'nic v cache = vypnuto');
  _resetLinkFilterCache();
  const a = await refreshLinkFilter('rob', opts);
  assert.equal(a.enabled, true);
  assert.equal(seen[0]['X-Api-Key'], 'k');
  mode = '304';
  const b = await refreshLinkFilter('rob', { ...opts, force: false });
  assert.equal(b.enabled, true, 'čerstvá cache se nenačítá znovu');
  assert.equal(seen.length, 1);
  mode = 'fail';
  const c = await refreshLinkFilter('rob', opts);
  assert.equal(c.enabled, true, 'výpadek drží poslední známý stav');
  assert.equal(linkFilterSync('rob').allowDomains[0], 'youtube.com');

  _resetLinkFilterCache();
  const d = await refreshLinkFilter('rob', { ...opts, apiKey: '' });
  assert.equal(d.enabled, false);
  _resetLinkFilterCache();
  const e = await refreshLinkFilter('rob', { ...opts });
  assert.equal(e.enabled, false, 'Židolišta nikdy neodpověděla → vypnuto (fail-open)');
  _resetLinkFilterCache();
});

test('refreshLinkFilter: prošlá cache → If-None-Match s ETagem, 304 drží stav', async () => {
  _resetLinkFilterCache();
  const seen: Array<Record<string, string>> = [];
  const fakeFetch = (async (_u: string, init: { headers: Record<string, string> }) => {
    seen.push(init.headers);
    if (seen.length === 1) return new Response(JSON.stringify({ ok: true, enabled: true, allowDomains: [], extraBots: [], version: 'v1' }), { status: 200, headers: { ETag: '"e1"' } });
    return new Response(null, { status: 304 });
  }) as unknown as typeof fetch;
  const opts = { fetch: fakeFetch, apiKey: 'k', base: 'https://z.example' };
  await refreshLinkFilter('rob2', opts);
  assert.equal(seen[0]['If-None-Match'], undefined);
  _expireLinkFilterForTest('rob2');
  const again = await refreshLinkFilter('rob2', opts);
  assert.equal(seen[1]['If-None-Match'], '"e1"');
  assert.equal(again.enabled, true);
  _resetLinkFilterCache();
});

test('refreshLinkFilter(force) během běžného načtení spustí nové načtení', async () => {
  _resetLinkFilterCache();
  let n = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const fakeFetch = (async () => {
    n++;
    if (n === 1) { await gate; return new Response(JSON.stringify({ ok: true, enabled: false, version: 'old' }), { status: 200 }); }
    return new Response(JSON.stringify({ ok: true, enabled: true, version: 'new' }), { status: 200 });
  }) as unknown as typeof fetch;
  const opts = { fetch: fakeFetch, apiKey: 'k', base: 'https://z.example' };
  const first = refreshLinkFilter('rob3', opts);
  const forced = refreshLinkFilter('rob3', { ...opts, force: true });
  release();
  assert.equal((await first).version, 'old');
  const r = await forced;
  assert.equal(n, 2);
  assert.equal(r.version, 'new');
  assert.equal(r.enabled, true);
  _resetLinkFilterCache();
});

// ---- část 4: odkaz na GIF od uživatele s odemčenými GIFy ----
function gifHook(access: 'allowed' | 'denied' | 'unknown', reserve = true) {
  const intercepts: Array<Record<string, unknown>> = [];
  const queries: unknown[] = [];
  return {
    intercepts, queries,
    hook: {
      accessSync: (q: unknown) => { queries.push(q); return access; },
      tryReserve: () => reserve,
      intercept: async (p: unknown) => { intercepts.push(p as Record<string, unknown>); },
    },
  };
}
const GIF_TEXT = 'hele https://tenor.com/view/cat-gif-1';

test('GIF: odemčeno (cache) → schovat hned jako gif_request, převod na pozadí; i s vypnutým filtrem', () => {
  for (const settings of [undefined, { ...LINK_FILTER_OFF }]) {
    const g = gifHook('allowed');
    const { f, calls } = harness(settings, { gif: g.hook });
    const m = msg({ content: GIF_TEXT, contentRaw: { badges: 'subscriber/1' } });
    const v = f.check(m);
    assert.deepEqual(v, { host: 'tenor.com', channel: 'robdiesalot', gif: true });
    assert.deepEqual(m.deleted, { by: 'filter', reason: 'gif_request' });
    assert.equal(g.intercepts.length, 1);
    const p = g.intercepts[0];
    assert.equal(p.preDeleted, 'gif_request');
    assert.equal(p.needAccess, false);
    assert.equal(typeof p.filterAct, settings ? 'object' : 'function', 'akce filtru jen když by filtr mazal');
    assert.deepEqual(g.queries[0], { workspace: 'rob', platform: 'twitch', userId: '42', login: 'divak', role: 'sub' });
    assert.equal(calls.published.length, 0, 'filtr sám nemaže');
  }
});

test('GIF: neodemčeno → běžný filtr; neznámé → filtr + ověření na pozadí; bot a běžný odkaz bez GIF cesty', () => {
  const denied = gifHook('denied');
  const a = harness(undefined, { gif: denied.hook });
  const m1 = msg({ content: GIF_TEXT });
  assert.deepEqual(a.f.check(m1), { host: 'tenor.com', channel: 'robdiesalot' });
  assert.deepEqual(m1.deleted, { by: 'filter', reason: 'link_filter' });
  assert.equal(denied.intercepts.length, 0);

  const unknown = gifHook('unknown');
  const b = harness(undefined, { gif: unknown.hook });
  const m2 = msg({ content: GIF_TEXT });
  assert.deepEqual(b.f.check(m2), { host: 'tenor.com', channel: 'robdiesalot' });
  assert.deepEqual(m2.deleted, { by: 'filter', reason: 'link_filter' });
  assert.equal(unknown.intercepts[0].preDeleted, 'link_filter');
  assert.equal(unknown.intercepts[0].needAccess, true);
  // Mod (filtr ho pouští) s neznámým přístupem: zpráva zůstane, GIF se ověří zpětně.
  const m3 = msg({ content: GIF_TEXT, contentRaw: { badges: 'moderator/1' } });
  assert.equal(b.f.check(m3), null);
  assert.equal(m3.deleted, undefined);
  assert.equal(unknown.intercepts[1].preDeleted, null);

  const bot = gifHook('allowed');
  const c = harness(undefined, { gif: bot.hook });
  assert.equal(c.f.check(msg({ content: GIF_TEXT, username: 'StreamElements' })), null);
  assert.equal(c.f.check(msg({ content: 'koukni na neco.cz/x' }))?.gif, undefined);
  assert.equal(bot.intercepts.length, 0);

  // Čekající žádost téhož uživatele → druhý GIF je běžný odkaz.
  const busy = gifHook('allowed', false);
  const d = harness(undefined, { gif: busy.hook });
  assert.deepEqual(d.f.check(msg({ content: GIF_TEXT })), { host: 'tenor.com', channel: 'robdiesalot' });
  assert.equal(busy.intercepts.length, 0);
});
