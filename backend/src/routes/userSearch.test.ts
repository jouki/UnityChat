import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { userSearchRoutes } from './userSearch.js';
import { requireWebSession } from '../lib/webAuth.js';
import { searchUsers, rankHits, matchRank, normalizeQuery, foldName, clampSearchLimit, type UserSearchDeps, type UserSearchHit } from '../lib/userSearch.js';
import { likePattern } from './chatLog.js';

async function fakeSession(req: FastifyRequest, reply: FastifyReply) {
  const h = String(req.headers.authorization || '');
  const acc = h === 'Bearer mod' ? 1 : h === 'Bearer divak' ? 2 : null;
  if (acc === null) { reply.code(401); return reply.send({ ok: false, error: 'no session' }); }
  req.webAccountId = acc;
}

function searchDeps(over: Partial<UserSearchDeps> = {}) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const spy = <T extends unknown[], R>(name: string, fn: (...a: T) => R) => (...a: T): R => { calls.push({ name, args: a }); return fn(...a); };
  const deps: UserSearchDeps = {
    platformChannel: spy('platformChannel', async (channel: string, platform: string) => (platform === 'twitch' ? channel : platform === 'kick' ? 'robdiesalot-kick' : null)),
    candidates: spy('candidates', async () => [{ platform: 'twitch' as const, userId: '1' }, { platform: 'kick' as const, userId: '7' }, { platform: 'twitch' as const, userId: '2' }]),
    stats: spy('stats', async () => [
      { platform: 'twitch' as const, userId: '1', count: 5, lastSeen: new Date(1000), name: 'zigi187', color: '#ff0000' },
      { platform: 'kick' as const, userId: '7', count: 50, lastSeen: new Date(9000), name: 'Zigmund', color: null },
      { platform: 'twitch' as const, userId: '2', count: 1, lastSeen: new Date(5000), name: 'Azig', color: null },
    ]),
    nicknamesMatching: spy('nicknamesMatching', async () => [{ platform: 'youtube' as const, login: 'mimo' }, { platform: 'twitch' as const, login: 'azig' }]),
    nicknamesFor: spy('nicknamesFor', async () => [{ platform: 'twitch' as const, login: 'azig', nickname: 'Zig', color: '#00ff00' }]),
    ...over,
  };
  return { deps, calls };
}

async function app(search = searchDeps(), session: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> = fakeSession) {
  const modCalls: string[] = [];
  const a = Fastify();
  await a.register(async (inst) => userSearchRoutes(inst, {
    requireSession: session,
    modIdentities: async (accountId: number, channel: string) => { modCalls.push(`${accountId}:${channel}`); return accountId === 1 ? [{ platform: 'twitch' as const, login: 'modik', role: 'moderator' as const }] : []; },
    search: search.deps,
    defaultChannel: 'robdiesalot',
  }));
  return { a, calls: search.calls, modCalls };
}

const URL = '/moderation/users/search?channel=robdiesalot&q=zig';

test('/users/search: bez tokenu 401 (skutečný requireWebSession), žádný dotaz ani ověření moda, no-store', async () => {
  const { a, calls, modCalls } = await app(searchDeps(), requireWebSession);
  const res = await a.inject({ method: 'GET', url: URL });
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(calls, []);
  assert.deepEqual(modCalls, []);
});

test('/users/search: nemod 403 not_mod, do DB se nesahá', async () => {
  const { a, calls, modCalls } = await app();
  const res = await a.inject({ method: 'GET', url: URL, headers: { authorization: 'Bearer divak' } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'not_mod');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(modCalls, ['2:robdiesalot']);
  assert.deepEqual(calls, []);
});

test('/users/search: neplatný dotaz 400 (prázdné, jen @, přes 40 znaků, fulltext mimo 0|1)', async () => {
  const { a, calls } = await app();
  for (const qs of ['q=', 'q=%40', `q=${'a'.repeat(41)}`, 'q=zig&fulltext=2', 'channel=robdiesalot']) {
    const res = await a.inject({ method: 'GET', url: `/moderation/users/search?${qs}`, headers: { authorization: 'Bearer mod' } });
    assert.equal(res.statusCode, 400, qs);
  }
  assert.deepEqual(calls, []);
});

test('/users/search: mod dostane seřazené uživatele, fulltext mění vzor, přezdívky jen z platforem kanálu', async () => {
  const s = searchDeps();
  const { a, calls } = await app(s);
  const res = await a.inject({ method: 'GET', url: `${URL}&fulltext=0`, headers: { authorization: 'Bearer mod' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  const body = res.json();
  assert.equal(body.ok, true);
  // Azig má přezdívku „Zig“ = přesná shoda → první; pak začátek jména podle aktivity (Zigmund 9000 > zigi187 1000).
  assert.deepEqual(body.users.map((u: UserSearchHit) => u.login), ['azig', 'zigmund', 'zigi187']);
  assert.deepEqual(body.users[0], { platform: 'twitch', userId: '2', login: 'azig', displayName: 'Azig', nickname: 'Zig', color: '#00ff00', lastSeen: 5000, count: 1 });
  assert.equal(body.users[2].color, '#ff0000');
  const cand = calls.find((c) => c.name === 'candidates')!;
  const [scope, q] = cand.args as [Array<{ platform: string; channels: string[] }>, { pattern: string; exact: string; extra: unknown[] }];
  assert.deepEqual(scope, [{ platform: 'twitch', channels: ['robdiesalot', '@robdiesalot'] }, { platform: 'kick', channels: ['robdiesalot-kick', '@robdiesalot-kick'] }]);
  assert.equal(q.pattern, 'zig%');
  assert.equal(q.exact, 'zig');
  assert.deepEqual(q.extra, [{ platform: 'twitch', login: 'azig' }], 'přezdívka z YouTube (kanál ho nemá) se nebere');

  const s2 = searchDeps();
  const { a: a2, calls: c2 } = await app(s2);
  await a2.inject({ method: 'GET', url: `${URL}&fulltext=1`, headers: { authorization: 'Bearer mod' } });
  assert.equal((c2.find((c) => c.name === 'candidates')!.args[1] as { pattern: string }).pattern, '%zig%');
});

test('/users/search: rate limit per účet 429', async () => {
  const { a } = await app();
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await a.inject({ method: 'GET', url: URL, headers: { authorization: 'Bearer mod' } })).statusCode;
  assert.equal(last, 429);
});

test('userSearch: escapování LIKE (% a _ doslovně), normalizace dotazu, limit', () => {
  assert.equal(likePattern('a_b%c', { prefix: true }), 'a\\_b\\%c%');
  assert.equal(likePattern('x\\y'), '%x\\\\y%');
  assert.equal(normalizeQuery('  @Zigi '), 'Zigi');
  assert.equal(normalizeQuery('@'), null);
  assert.equal(normalizeQuery('a'.repeat(41)), null);
  assert.equal(normalizeQuery('a'.repeat(40)), 'a'.repeat(40));
  assert.equal(clampSearchLimit('5'), 5);
  assert.equal(clampSearchLimit('999'), 50);
  assert.equal(clampSearchLimit('x'), 20);
  assert.equal(foldName('Žluťoučký'), 'zlutoucky');
});

test('userSearch: řazení přesná shoda → začátek → poslední aktivita, bez diakritiky', () => {
  const h = (login: string, lastSeen = 0, extra: Partial<UserSearchHit> = {}): UserSearchHit => ({ platform: 'twitch', userId: login, login, displayName: login, lastSeen, count: 1, ...extra });
  assert.equal(matchRank(h('zigi'), 'ZIGI'), 0);
  assert.equal(matchRank(h('zigi187'), 'zigi'), 1);
  assert.equal(matchRank(h('azigi'), 'zigi'), 2);
  assert.equal(matchRank(h('x', 0, { nickname: 'Žigi' }), 'zigi'), 0);
  const out = rankHits([h('azigi', 99), h('zigi187', 1), h('zigi2', 50), h('zigi', 0)], 'zigi').map((x) => x.login);
  assert.deepEqual(out, ['zigi', 'zigi2', 'zigi187', 'azigi']);
});

test('userSearch: kanál bez platforem / bez kandidátů = prázdno bez dalších dotazů', async () => {
  const s = searchDeps({ platformChannel: async () => null });
  assert.deepEqual(await searchUsers({ channel: 'x', q: 'a', fulltext: false, limit: 20 }, s.deps), []);
  assert.deepEqual(s.calls.map((c) => c.name), []);
  const s2 = searchDeps({ candidates: async () => [] });
  assert.deepEqual(await searchUsers({ channel: 'robdiesalot', q: 'a', fulltext: false, limit: 20 }, s2.deps), []);
  assert.ok(!s2.calls.some((c) => c.name === 'stats'));
});

test('userSearch: limit ořízne výsledky', async () => {
  const s = searchDeps();
  const out = await searchUsers({ channel: 'robdiesalot', q: 'zig', fulltext: false, limit: 2 }, s.deps);
  assert.equal(out.length, 2);
});
