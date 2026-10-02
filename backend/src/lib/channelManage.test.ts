import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickCategory, searchCategories, subCount, SUBS_SCOPE, clampTitle, TITLE_MAX, followage, parseKickFollowage, ChannelError } from './channelManage.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('channel: počet subů — Kick bez API → count null, bez volání; scope pro Twitch = channel:read:subscriptions', async () => {
  let called = false;
  const fetchImpl = (async () => { called = true; throw new Error('nemá se volat'); }) as unknown as typeof fetch;
  assert.deepEqual(await subCount('kick', 'robdiesalot', fetchImpl), { count: null, points: null });
  assert.equal(called, false);
  assert.equal(SUBS_SCOPE.twitch, 'channel:read:subscriptions');
});

test('channel: název streamu — ořez na 140 znaků, zúžené mezery', () => {
  assert.equal(clampTitle('  Ranked   AoE2  '), 'Ranked AoE2');
  assert.equal(clampTitle('a'.repeat(200)).length, TITLE_MAX);
  assert.equal(clampTitle('   '), '');
});

test('channel: výběr kategorie — přesný název před prvním výsledkem', () => {
  const list = [{ id: '1', name: 'Age of Empires II: Definitive Edition', imageUrl: null }, { id: '2', name: 'Age of Empires II', imageUrl: null }];
  assert.equal(pickCategory(list, 'age of empires ii')?.id, '2');
  assert.equal(pickCategory(list, 'age')?.id, '1');
  assert.equal(pickCategory([], 'x'), null);
});

test('channel: hledání kategorií — Twitch (app token + search) a Kick (app token + categories)', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url); calls.push(u);
    if (u.includes('id.twitch.tv')) return json({ access_token: 'app', expires_in: 3600 });
    if (u.includes('helix/search/categories')) {
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer app');
      return json({ data: [{ id: '10', name: 'Just Chatting', box_art_url: 'https://x/{width}x{height}.jpg' }] });
    }
    if (u.includes('id.kick.com')) return json({ access_token: 'kapp', expires_in: 3600 });
    if (u.includes('public/v1/categories')) return json({ data: [{ id: 15, name: 'Just Chatting', thumbnail: 'https://k/t.jpg' }] });
    throw new Error('unexpected ' + u);
  }) as unknown as typeof fetch;
  const tw = await searchCategories('twitch', 'just', fetchImpl);
  assert.deepEqual(tw, [{ id: '10', name: 'Just Chatting', imageUrl: 'https://x/52x72.jpg' }]);
  const ki = await searchCategories('kick', 'just', fetchImpl);
  assert.deepEqual(ki, [{ id: '15', name: 'Just Chatting', imageUrl: 'https://k/t.jpg' }]);
  assert.deepEqual(await searchCategories('twitch', '   ', fetchImpl), []);
  assert.ok(calls.some((c) => c.includes('query=just')));
});

test('channel: followage Kick — veřejná karta uživatele (following_since), nesleduje, neznámý, bez loginu', async () => {
  assert.deepEqual(parseKickFollowage({ following_since: '2026-01-29T09:34:58.000000Z' }), { following: true, followedAt: '2026-01-29T09:34:58.000Z' });
  assert.deepEqual(parseKickFollowage({ following_since: null }), { following: false, followedAt: null });
  const urls: string[] = [];
  const ok = (async (u: string) => { urls.push(u); return new Response(JSON.stringify({ following_since: '2026-01-29T09:34:58.000000Z' }), { status: 200 }); }) as unknown as typeof fetch;
  assert.deepEqual(await followage('kick', 'robdiesalot', { login: '@Jouki728' }, ok), { following: true, followedAt: '2026-01-29T09:34:58.000Z' });
  assert.equal(urls[0], 'https://kick.com/api/v2/channels/robdiesalot/users/jouki728');
  const nf = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(followage('kick', 'robdiesalot', { login: 'nikdo' }, nf), (e: ChannelError) => e.code === 'not_found');
  await assert.rejects(followage('kick', 'robdiesalot', { userId: '123' }, ok), (e: ChannelError) => e.code === 'bad_user');
});
