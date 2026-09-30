import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickCategory, searchCategories } from './channelManage.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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
