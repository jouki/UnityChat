import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGifAccess, gifUsable, gifAccess, gifAccessSync, gifUsed, invalidateGifAccess, _resetGifAccessCache, type GifAccessQuery } from './gifAccess.js';

const Q: GifAccessQuery = { workspace: 'rob', platform: 'twitch', userId: '42', login: 'Divak', role: 'viewer' };
const quiet = { warn() {} };

test('normalizeGifAccess: čas Židolišty → lokální (serverNow), výchozí requestTtlSec 300, jen allowed === true', () => {
  const a = normalizeGifAccess({ ok: true, serverNow: 10_000, allowed: true, until: 70_000, cooldownUntil: 20_000, cooldownSec: 30, requestTtlSec: 120 }, 1_000_000);
  assert.deepEqual(a, { allowed: true, until: 1_060_000, cooldownUntil: 1_010_000, cooldownSec: 30, requestTtlSec: 120 });
  const iso = normalizeGifAccess({ serverNow: '2026-09-25T10:00:00Z', allowed: true, until: '2026-09-25T10:01:00Z', cooldownUntil: null }, 5000);
  assert.equal(iso.until, 65_000);
  assert.equal(iso.requestTtlSec, 300);
  assert.equal(normalizeGifAccess({ allowed: 'true' }, 0).allowed, false);
});

test('gifUsable: odemčeno, nevypršelo, bez cooldownu', () => {
  const base = { allowed: true, until: null, cooldownUntil: null, cooldownSec: 0, requestTtlSec: 300 };
  assert.equal(gifUsable(base, 100), true);
  assert.equal(gifUsable({ ...base, allowed: false }, 100), false);
  assert.equal(gifUsable({ ...base, until: 50 }, 100), false);
  assert.equal(gifUsable({ ...base, cooldownUntil: 150 }, 100), false);
  assert.equal(gifUsable(null, 100), false);
});

test('gifAccess: dotaz s parametry + klíčem, cache 60 s, sync unknown → allowed, webhook maže cache', async () => {
  _resetGifAccessCache();
  const calls: string[] = [];
  let now = 1_000;
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push(url);
    assert.equal((init.headers as Record<string, string>)['X-Api-Key'], 'k');
    return new Response(JSON.stringify({ ok: true, serverNow: now, allowed: true, until: null, cooldownUntil: null, cooldownSec: 60, requestTtlSec: 300 }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const deps = { fetch, apiKey: 'k', base: 'https://z.test', now: () => now, log: quiet };
  assert.equal(gifAccessSync(Q, deps), 'unknown');
  await gifAccess(Q, deps);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/z\.test\/integrations\/rob\/gif-access\?platform=twitch&userId=42&login=divak&role=viewer$/);
  assert.equal(gifAccessSync(Q, deps), 'allowed');
  await gifAccess(Q, deps);
  assert.equal(calls.length, 1, 'z cache');
  assert.equal(invalidateGifAccess('ROB'), 1);
  assert.equal(gifAccessSync(Q, deps), 'unknown');
  now += 1;
});

test('gifAccess: chyba Židolišty / bez klíče = neodemčeno', async () => {
  _resetGifAccessCache();
  const fetch = (async () => new Response('x', { status: 500 })) as unknown as typeof globalThis.fetch;
  assert.equal(await gifAccess(Q, { fetch, apiKey: 'k', base: 'https://z.test', log: quiet }), null);
  assert.equal(gifAccessSync(Q, { fetch, apiKey: 'k', base: 'https://z.test', log: quiet }), 'denied');
  _resetGifAccessCache();
  assert.equal(await gifAccess(Q, { apiKey: '' }), null);
});

test('gifUsed: POST {platform, userId}, cooldown se hned propíše do cache', async () => {
  _resetGifAccessCache();
  const now = 1_000;
  const bodies: unknown[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    if (url.endsWith('/gif-used')) { bodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ ok: true, cooldownUntil: 61_000, serverNow: 1_000 }), { status: 200 }); }
    return new Response(JSON.stringify({ ok: true, serverNow: now, allowed: true, until: null, cooldownUntil: null, cooldownSec: 60, requestTtlSec: 300 }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const deps = { fetch, apiKey: 'k', base: 'https://z.test', now: () => now, log: quiet };
  await gifAccess(Q, deps);
  assert.equal(gifAccessSync(Q, deps), 'allowed');
  assert.equal(await gifUsed({ workspace: 'rob', platform: 'twitch', userId: '42' }, deps), 61_000);
  assert.deepEqual(bodies, [{ platform: 'twitch', userId: '42' }]);
  assert.equal(gifAccessSync(Q, deps), 'denied');
});
