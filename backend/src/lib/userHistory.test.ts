import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary, buildPublicSummary, publicDonationSum, makeWindowBudget, buildMessages, buildDonations, HistoryTabsCache, historyIdentities, mergeChannels, mergeDonations, donationTotals, clampHistoryLimit, toModItem, type HistoryDeps, type ChannelGroup } from './userHistory.js';
import type { DonationItem } from './zidolista.js';
import type { Message } from '../db/schema.js';
import type { Platform } from './zidolista.js';

const d = (s: string) => new Date(s);

function row(id: number, platform: Platform, userId: string, channel: string, at: string, extra: Partial<Message> = {}): Message {
  return {
    id, platform, platformMessageId: `m${id}`, platformUserId: userId, platformUsername: 'Spammer', userId: null, content: `text ${id}`, contentRaw: {},
    channel, isUnitychatUser: false, isReply: false, replyToMessageId: null, sentAt: d(at), createdAt: d(at),
    deletedAt: null, deletedBy: null, deletedReason: null, hiddenAt: null, hiddenBy: null, ...extra,
  };
}

function deps(over: Partial<HistoryDeps> = {}): HistoryDeps & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { messagesPage: [], moderation: [] };
  const groups: ChannelGroup[] = [
    { platform: 'twitch', channel: 'robdiesalot', count: 5, firstAt: d('2026-09-20T10:00:00Z'), lastAt: d('2026-09-25T10:00:00Z') },
    { platform: 'kick', channel: 'robdiesalot-kick', count: 2, firstAt: d('2026-09-19T10:00:00Z'), lastAt: d('2026-09-24T10:00:00Z') },
    { platform: 'twitch', channel: 'arcadebulls', count: 3, firstAt: d('2026-09-21T10:00:00Z'), lastAt: d('2026-09-22T10:00:00Z') },
    { platform: 'youtube', channel: '@tensterakdary', count: 1, firstAt: d('2026-09-23T10:00:00Z'), lastAt: d('2026-09-23T10:00:00Z') },
    { platform: 'twitch', channel: 'nula', count: 0, firstAt: d('2026-09-23T10:00:00Z'), lastAt: d('2026-09-23T10:00:00Z') },
  ];
  return {
    calls,
    resolveTargets: async (channel, platform, userId) => (channel === 'robdiesalot' && platform === 'twitch' && userId === '1'
      ? { primary: { platform: 'twitch', userId: '1', login: 'spammer' }, all: [{ platform: 'twitch', userId: '1', login: 'spammer' }, { platform: 'kick', userId: '7', login: 'spammer' }], accountId: 42 }
      : null),
    accountIdentities: async () => [{ platform: 'kick', userId: '7', login: 'Spammer', displayName: 'Spammer K' }, { platform: 'youtube', userId: 'UCx', login: 'Spammer_YT', displayName: 'Pan Spammer' }],
    channelGroups: async () => groups,
    ucChannelOf: async (platform, ch) => (platform === 'kick' && ch === 'robdiesalot-kick' ? 'robdiesalot' : ch === '@tensterakdary' ? 'tensterakdary' : ch),
    latestName: async () => 'SpAmMeR',
    nickname: async (platform, login) => (platform === 'youtube' && login === 'spammer_yt' ? { nickname: 'Pan S', color: '#ff0000' } : null),
    moderation: async (channel, ids, limit) => { calls.moderation.push({ channel, ids, limit }); return [{ action: 'timeout', at: 1, by: 'twitch:modik', platform: 'twitch', params: { durationSec: 600 } }]; },
    messagesPage: async (scope, cursor, limit) => {
      calls.messagesPage.push({ scope, cursor, limit });
      return [row(9, 'twitch', '1', 'robdiesalot', '2026-09-25T10:00:00Z'), row(8, 'kick', '7', 'robdiesalot-kick', '2026-09-24T10:00:00Z', { deletedAt: d('2026-09-24T10:01:00Z'), deletedReason: 'mod' }), row(7, 'twitch', '1', 'robdiesalot', '2026-09-23T10:00:00Z')].slice(0, limit + 1);
    },
    userIdByLogin: async (channel, platform, login) => (channel === 'robdiesalot' && platform === 'twitch' && login === 'spammer' ? '1' : null),
    donations: async () => null,
    ...over,
  };
}

test('historyIdentities: cíl z archivu + všechny identity UC účtu, bez duplicit, login lowercase', async () => {
  const dd = deps();
  const t = (await dd.resolveTargets('robdiesalot', 'twitch', '1'))!;
  const ids = await historyIdentities(t, dd);
  assert.deepEqual(ids.map((i) => `${i.platform}:${i.userId}:${i.login}`), ['twitch:1:spammer', 'kick:7:spammer', 'youtube:UCx:spammer_yt']);
  assert.equal((await historyIdentities({ ...t, accountId: null }, dd)).length, 2, 'bez účtu jen resolveUserTargets');
});

test('mergeChannels: aktuální kanál první i s 0, ostatní jen s count>0 od posledně aktivního, Kick/YT sloučené pod UC kanál', async () => {
  const dd = deps();
  const { channels } = await mergeChannels(await dd.channelGroups([]), 'robdiesalot', dd.ucChannelOf);
  assert.deepEqual(channels.map((c) => [c.channel, c.count]), [['robdiesalot', 7], ['tensterakdary', 1], ['arcadebulls', 3]]);
  assert.equal(channels[0].firstAt, d('2026-09-19T10:00:00Z').getTime());
  const empty = await mergeChannels([], 'robdiesalot', dd.ucChannelOf);
  assert.deepEqual(empty.channels, [{ channel: 'robdiesalot', count: 0, firstAt: null, lastAt: null }]);
});

test('buildSummary: 404 bez zprávy v archivu kanálu; jinak identity, záložky, přezdívka z propojené identity, moderace aktuálního kanálu', async () => {
  const dd = deps();
  assert.equal((await buildSummary({ accountId: 1, channel: 'robdiesalot', platform: 'twitch', userId: '999' }, dd)).status, 404);
  assert.equal((await buildSummary({ accountId: 1, channel: 'arcadebulls', platform: 'twitch', userId: '1' }, dd)).status, 404, 'cizí kanál moda');
  const out = await buildSummary({ accountId: 1, channel: 'robdiesalot', platform: 'twitch', userId: '1' }, dd);
  assert.equal(out.status, 200);
  const b = out.body as { user: Record<string, unknown>; channels: Array<{ channel: string }>; moderation: unknown[] };
  assert.equal(b.user.displayName, 'SpAmMeR');
  assert.equal(b.user.nickname, 'Pan S');
  assert.equal(b.user.color, '#ff0000');
  assert.equal(b.user.total, 11);
  assert.equal(b.user.firstSeen, d('2026-09-19T10:00:00Z').getTime());
  assert.equal(b.user.lastSeen, d('2026-09-25T10:00:00Z').getTime());
  assert.equal((b.user.identities as unknown[]).length, 3);
  assert.deepEqual(b.channels.map((c) => c.channel), ['robdiesalot', 'tensterakdary', 'arcadebulls']);
  assert.equal(b.moderation.length, 1);
  assert.deepEqual((dd.calls.moderation[0] as { channel: string; limit: number }).channel, 'robdiesalot');
  assert.equal((dd.calls.moderation[0] as { limit: number }).limit, 20);
});

test('buildMessages: rozsah jen platformní kanály záložky, pořadí nejstarší → nejnovější, smazaná bez obsahu, nextBefore', async () => {
  const dd = deps();
  const out = await buildMessages({ accountId: 1, channel: 'robdiesalot', platform: 'twitch', userId: '1', inChannel: 'robdiesalot', cursor: null, limit: 2 }, dd);
  assert.equal(out.status, 200);
  const scope = (dd.calls.messagesPage[0] as { scope: Array<{ platform: string; channels: string[] }> }).scope;
  assert.deepEqual(scope.map((s) => `${s.platform}:${s.channels.join('|')}`), ['twitch:robdiesalot', 'kick:robdiesalot-kick']);
  const b = out.body as { messages: Array<{ id: string; message: string; deleted?: boolean }>; nextBefore: string | null };
  assert.deepEqual(b.messages.map((m) => m.id), ['m8', 'm9']);
  assert.equal(b.messages[0].deleted, true);
  assert.equal(b.messages[0].message, '');
  assert.equal(b.nextBefore, `${d('2026-09-24T10:00:00Z').getTime()}:8`);
});

test('buildMessages: záložka jiného kanálu → jen jeho kanály; kanál bez zpráv → prázdno bez dotazu', async () => {
  const dd = deps();
  await buildMessages({ accountId: 1, channel: 'robdiesalot', platform: 'twitch', userId: '1', inChannel: 'tensterakdary', cursor: { sentAtMs: 5, id: 3 }, limit: 50 }, dd);
  const call = dd.calls.messagesPage[0] as { scope: Array<{ platform: string; userId: string; channels: string[] }>; cursor: unknown };
  assert.deepEqual(call.scope, [{ platform: 'youtube', userId: 'UCx', channels: ['@tensterakdary'] }]);
  assert.deepEqual(call.cursor, { sentAtMs: 5, id: 3 });
  const empty = await buildMessages({ accountId: 1, channel: 'robdiesalot', platform: 'twitch', userId: '1', inChannel: 'nula', cursor: null, limit: 50 }, dd);
  assert.deepEqual(empty.body, { ok: true, messages: [], nextBefore: null });
  assert.equal(dd.calls.messagesPage.length, 1);
  assert.equal((await buildMessages({ accountId: 1, channel: 'robdiesalot', platform: 'kick', userId: '1', inChannel: 'robdiesalot', cursor: null, limit: 50 }, dd)).status, 404);
});

test('HistoryTabsCache: stránky zpráv do 10 s bez nového GROUP BY; summary vždy obnoví; klíč = účet + cíl', async () => {
  let t = 0;
  const cache = new HistoryTabsCache(10_000, () => t);
  let groupsCalls = 0;
  const dd = deps();
  const orig = dd.channelGroups;
  dd.channelGroups = async (ids) => { groupsCalls++; return orig(ids); };
  const inp = { accountId: 1, channel: 'robdiesalot', platform: 'twitch' as const, userId: '1' };
  await buildSummary(inp, dd, cache);
  assert.equal(groupsCalls, 1);
  await buildMessages({ ...inp, inChannel: 'robdiesalot', cursor: null, limit: 50 }, dd, cache);
  await buildMessages({ ...inp, inChannel: 'arcadebulls', cursor: null, limit: 50 }, dd, cache);
  assert.equal(groupsCalls, 1, 'stránky berou záložky z cache');
  await buildMessages({ ...inp, accountId: 2, inChannel: 'robdiesalot', cursor: null, limit: 50 }, dd, cache);
  assert.equal(groupsCalls, 2, 'jiný mod = jiný klíč');
  await buildSummary(inp, dd, cache);
  assert.equal(groupsCalls, 3, 'summary počítá znovu');
  t = 10_001;
  await buildMessages({ ...inp, inChannel: 'robdiesalot', cursor: null, limit: 50 }, dd, cache);
  assert.equal(groupsCalls, 4, 'po TTL znovu');
});

test('clampHistoryLimit / toModItem', () => {
  assert.equal(clampHistoryLimit(undefined), 50);
  assert.equal(clampHistoryLimit('500'), 100);
  assert.equal(clampHistoryLimit('0'), 50);
  assert.equal(clampHistoryLimit('20'), 20);
  const at = d('2026-09-25T10:00:00Z');
  assert.deepEqual(toModItem({ action: 'timeout', createdAt: at, actor: 'twitch:modik', platform: 'twitch', params: { userId: '1', durationSec: 600, reason: 'spam', targets: [] } }),
    { action: 'timeout', at: at.getTime(), by: 'twitch:modik', platform: 'twitch', params: { durationSec: 600, reason: 'spam' } });
  assert.deepEqual(toModItem({ action: 'rename', createdAt: at, actor: 'x', platform: 'kick', params: { nickname: null } }).params, { nickname: null });
});

const don = (id: string, amount: number, currency = 'CZK', matchedBy: string | null = 'uc', paidAt = 1, amountCzk = amount, nickname: string | null = null): DonationItem =>
  ({ id, amount, currency, amountCzk, paidAt, via: 'qr', matchedBy, nickname, message: null });

test('buildSummary: latest = poslední zpráva každé identity v aktuálním kanálu (badge, bez textu), displayName identit, dona jen když Židolišta odpoví', async () => {
  const dd = deps({
    messagesPage: async (scope) => [row(scope[0].platform === 'kick' ? 5 : 6, scope[0].platform, scope[0].userId, scope[0].channels[0], '2026-09-25T10:00:00Z', { contentRaw: { badges: 'vip/1', color: '#123456' } })],
  });
  const out = await buildSummary({ accountId: 1, channel: 'robdiesalot', platform: 'twitch', userId: '1' }, dd);
  const b = out.body as { latest: Record<string, { badgesRaw: string; message?: string; id: string }>; user: { identities: Array<{ platform: string; displayName: string | null }> }; donations?: unknown };
  assert.deepEqual(Object.keys(b.latest).sort(), ['kick', 'twitch'], 'YouTube v aktuálním kanálu nepsal');
  assert.equal(b.latest.twitch.badgesRaw, 'vip/1');
  assert.equal(b.latest.twitch.message, undefined);
  assert.deepEqual(b.user.identities.map((i) => `${i.platform}:${i.displayName}`), ['twitch:SpAmMeR', 'kick:Spammer K', 'youtube:Pan Spammer']);
  assert.equal(b.donations, undefined, 'výpadek Židolišty → pole chybí');
  const withDon = await buildSummary({ accountId: 1, channel: 'robdiesalot', platform: 'twitch', userId: '1' }, deps({ donations: async () => [don('a', 1000), don('b', 250, 'CZK', 'nickname'), don('c', 20, 'EUR', 'uc', 1, 500)] }));
  assert.deepEqual((withDon.body as { donations: unknown }).donations, { total: { czk: 1750, byCurrency: { CZK: 1250, EUR: 20 } }, count: 3, uc: { czk: 1500, count: 2 }, guess: { czk: 250, byCurrency: { CZK: 250 }, count: 1 } });
});

test('Profil podle loginu: userId z archivu aktuálního kanálu; neznámý login → 404 bez dalších dotazů', async () => {
  const dd = deps();
  const ok = await buildSummary({ accountId: 1, channel: 'robdiesalot', platform: 'twitch', userId: null, login: '@spammer' }, dd);
  assert.equal(ok.status, 200);
  assert.equal((ok.body as { user: { userId: string } }).user.userId, '1');
  let groups = 0;
  const miss = await buildSummary({ accountId: 1, channel: 'robdiesalot', platform: 'twitch', userId: null, login: 'cizi' }, deps({ channelGroups: async () => { groups++; return []; } }));
  assert.equal(miss.status, 404);
  assert.equal(groups, 0);
  assert.equal((await buildMessages({ accountId: 1, channel: 'robdiesalot', platform: 'twitch', userId: null, login: '', inChannel: 'robdiesalot', cursor: null, limit: 5 }, dd)).status, 404);
});

test('buildDonations: 404 bez cíle v archivu; nedostupná Židolišta = available false; položky od nejnovějšího', async () => {
  assert.equal((await buildDonations({ accountId: 1, channel: 'robdiesalot', platform: 'twitch', userId: '999' }, deps())).status, 404);
  assert.deepEqual((await buildDonations({ accountId: 1, channel: 'robdiesalot', platform: 'twitch', userId: '1' }, deps())).body, { ok: true, available: false, items: [] });
  let asked: string | null = null;
  const out = await buildDonations({ accountId: 1, channel: 'robdiesalot', platform: 'twitch', userId: '1' }, deps({ donations: async (ch) => { asked = ch; return [don('x', 5)]; } }));
  assert.equal(asked, 'robdiesalot');
  assert.deepEqual((out.body as { items: Array<{ id: string }> }).items.map((i) => i.id), ['x']);
});

test('mergeDonations / donationTotals: dedup podle id (jistá shoda má přednost), vše null → null', () => {
  assert.equal(mergeDonations([null, null]), null);
  const m = mergeDonations([[don('a', 100, 'CZK', 'nickname', 1), don('b', 5, 'CZK', 'uc', 3)], null, [don('a', 100, 'CZK', 'uc', 1)]])!;
  assert.deepEqual(m.map((i) => `${i.id}:${i.matchedBy}`), ['b:uc', 'a:uc']);
  assert.deepEqual(donationTotals([]), { total: { czk: 0, byCurrency: {} }, count: 0, uc: { czk: 0, count: 0 }, guess: { czk: 0, byCurrency: {}, count: 0 } });
});

test('buildPublicSummary: jen veřejná pole, statistika jen aktuálního kanálu a jen kliknuté identity, dona jen ucNamed', async () => {
  const all = await deps().channelGroups([]);
  const dd = deps({
    channelGroups: async (ids) => all.filter((g) => ids.some((i) => i.platform === g.platform)),
    messagesPage: async (scope) => [row(6, scope[0].platform, scope[0].userId, scope[0].channels[0], '2026-09-25T10:00:00Z', { contentRaw: { badges: 'vip/1' } })],
    donations: async () => [don('a', 1000, 'CZK', 'uc', 1, 1000, 'SpAmMeR'), don('b', 300, 'CZK', 'uc', 1, 300, 'anonym'), don('c', 250, 'CZK', 'nickname', 1, 250, 'spammer')],
  });
  const out = await buildPublicSummary({ channel: 'robdiesalot', platform: 'twitch', userId: '1' }, dd);
  assert.equal(out.status, 200);
  const b = out.body as Record<string, any>;
  assert.deepEqual(Object.keys(b).sort(), ['donations', 'latest', 'ok', 'user', 'view']);
  assert.equal(b.view, 'public');
  assert.deepEqual(Object.keys(b.user).sort(), ['color', 'displayName', 'firstSeen', 'lastSeen', 'login', 'nickname', 'platform', 'total', 'userId']);
  assert.equal(b.user.total, 5, 'jen Twitch identita v robdiesalot (Kick propojeného účtu se nepočítá)');
  assert.deepEqual(Object.keys(b.latest), ['twitch'], 'badge jen kliknuté identity');
  assert.deepEqual(b.donations, { ucNamed: { czk: 1000, count: 1 } }, 'bez czk celkem, uc, odhadů a položek');
  assert.equal((await buildPublicSummary({ channel: 'robdiesalot', platform: 'twitch', userId: '999' }, dd)).status, 404);
  assert.equal((await buildPublicSummary({ channel: 'robdiesalot', platform: 'twitch', userId: null, login: 'cizi' }, dd)).status, 404);
  const noDon = await buildPublicSummary({ channel: 'robdiesalot', platform: 'twitch', userId: '1' }, deps());
  assert.equal((noDon.body as Record<string, unknown>).donations, undefined);
});

test('buildPublicSummary: cíl bez UC účtu → Židolišta se vůbec neptá (ucNamed by byl 0); s účtem dotaz jako veřejný', async () => {
  let asked = 0;
  let opts: unknown = null;
  const noAcc = deps({
    resolveTargets: async () => ({ primary: { platform: 'twitch', userId: '1', login: 'spammer' }, all: [{ platform: 'twitch', userId: '1', login: 'spammer' }], accountId: null }),
    donations: async () => { asked++; return [don('a', 10, 'CZK', 'uc', 1, 10, 'spammer')]; },
  });
  const out = await buildPublicSummary({ channel: 'robdiesalot', platform: 'twitch', userId: '1' }, noAcc);
  assert.equal(out.status, 200);
  assert.equal(asked, 0);
  assert.equal((out.body as Record<string, unknown>).donations, undefined);
  await buildPublicSummary({ channel: 'robdiesalot', platform: 'twitch', userId: '1' }, deps({ donations: async (_c, _i, o) => { asked++; opts = o; return []; } }));
  assert.equal(asked, 1);
  assert.deepEqual(opts, { public: true }, 'veřejná volání jdou přes globální strop');
});

test('makeWindowBudget: max N za okno celkem, po okně znovu', () => {
  let t = 0;
  const b = makeWindowBudget(3, 60_000, () => t);
  assert.deepEqual([b(), b(), b(), b()], [true, true, true, false]);
  t = 59_999;
  assert.equal(b(), false);
  t = 60_000;
  assert.equal(b(), true);
});

test('publicDonationSum: jen matchedBy uc s přezdívkou = login / jméno (bez @, bez ohledu na velikost)', () => {
  assert.deepEqual(publicDonationSum([don('a', 10, 'CZK', 'uc', 1, 10, '@Jouki'), don('b', 5, 'EUR', 'uc', 1, 125, 'jouki728'), don('c', 7, 'CZK', 'uc', 1, 7, null), don('d', 9, 'CZK', 'nickname', 1, 9, 'jouki')], ['jouki728', 'Jouki']), { czk: 135, count: 2 });
});

test('DB: skupiny kanálů, stránka zpráv a moderace přes identity (platform, platform_user_id)', { skip: !process.env.TEST_DATABASE_URL && 'TEST_DATABASE_URL není nastavené' }, async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL!;
  const { dbHistoryDeps } = await import('./userHistory.js');
  const { db } = await import('../db/index.js');
  const { messages, moderationActions } = await import('../db/schema.js');
  const { like, eq } = await import('drizzle-orm');
  const pre = 'test-uh-' + Date.now();
  const ch = '__test_uh__';
  try {
    await db.insert(messages).values([
      { platform: 'twitch', platformMessageId: `${pre}-1`, platformUserId: `${pre}u`, platformUsername: 'A', content: 'x', contentRaw: {}, channel: ch, sentAt: new Date(Date.now() - 2000) },
      { platform: 'twitch', platformMessageId: `${pre}-2`, platformUserId: `${pre}u`, platformUsername: 'A', content: 'y', contentRaw: {}, channel: '__test_uh_jiny__', sentAt: new Date(Date.now() - 1000) },
      { platform: 'kick', platformMessageId: `${pre}-3`, platformUserId: `${pre}u`, platformUsername: 'cizi', content: 'z', contentRaw: {}, channel: ch, sentAt: new Date() },
    ]);
    await db.insert(moderationActions).values({ channel: ch, actor: 'twitch:m', action: 'timeout', platform: 'twitch', targetLogin: 'a', params: { userId: `${pre}u`, durationSec: 60 }, result: {} });
    const dd = dbHistoryDeps(async () => null, async () => [], async () => null);
    const ids = [{ platform: 'twitch' as const, userId: `${pre}u`, login: 'a' }];
    const groups = await dd.channelGroups(ids);
    assert.deepEqual(groups.map((g) => `${g.channel}:${g.count}`).sort(), ['__test_uh__:1', '__test_uh_jiny__:1'], 'Kick se stejným id je jiný člověk');
    const page = await dd.messagesPage([{ platform: 'twitch', userId: `${pre}u`, channels: [ch] }], null, 10);
    assert.deepEqual(page.map((r) => r.platformMessageId), [`${pre}-1`]);
    // Víc identit = UNION ALL s LIMIT per identita, pak společné řazení a ořez.
    const both = await dd.messagesPage([{ platform: 'twitch', userId: `${pre}u`, channels: [ch, '__test_uh_jiny__'] }, { platform: 'kick', userId: `${pre}u`, channels: [ch] }], null, 2);
    assert.deepEqual(both.map((r) => r.platformMessageId), [`${pre}-3`, `${pre}-2`, `${pre}-1`], 'limit+1 řádků, od nejnovější');
    const mod = await dd.moderation(ch, ids, 20);
    assert.equal(mod[0]?.params.durationSec, 60);
    assert.equal((await dd.moderation(ch, [{ platform: 'kick', userId: `${pre}u`, login: 'a' }], 20)).length, 0);
  } finally {
    await db.delete(messages).where(like(messages.platformMessageId, `${pre}%`));
    await db.delete(moderationActions).where(eq(moderationActions.channel, ch));
  }
});
