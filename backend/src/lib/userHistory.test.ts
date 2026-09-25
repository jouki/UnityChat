import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary, buildMessages, HistoryTabsCache, historyIdentities, mergeChannels, clampHistoryLimit, toModItem, type HistoryDeps, type ChannelGroup } from './userHistory.js';
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
    accountIdentities: async () => [{ platform: 'kick', userId: '7', login: 'Spammer' }, { platform: 'youtube', userId: 'UCx', login: 'Spammer_YT' }],
    channelGroups: async () => groups,
    ucChannelOf: async (platform, ch) => (platform === 'kick' && ch === 'robdiesalot-kick' ? 'robdiesalot' : ch === '@tensterakdary' ? 'tensterakdary' : ch),
    latestName: async () => 'SpAmMeR',
    nickname: async (platform, login) => (platform === 'youtube' && login === 'spammer_yt' ? { nickname: 'Pan S', color: '#ff0000' } : null),
    moderation: async (channel, ids, limit) => { calls.moderation.push({ channel, ids, limit }); return [{ action: 'timeout', at: 1, by: 'twitch:modik', platform: 'twitch', params: { durationSec: 600 } }]; },
    messagesPage: async (scope, cursor, limit) => {
      calls.messagesPage.push({ scope, cursor, limit });
      return [row(9, 'twitch', '1', 'robdiesalot', '2026-09-25T10:00:00Z'), row(8, 'kick', '7', 'robdiesalot-kick', '2026-09-24T10:00:00Z', { deletedAt: d('2026-09-24T10:01:00Z'), deletedReason: 'mod' }), row(7, 'twitch', '1', 'robdiesalot', '2026-09-23T10:00:00Z')].slice(0, limit + 1);
    },
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
    const dd = dbHistoryDeps(async () => null, async () => []);
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
