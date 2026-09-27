import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGifAccess, gifUsable, gifAccess, gifAccessSync, gifCooldownUntilSync, gifUsed, invalidateGifAccess, claimGifSlot, _resetGifAccessCache, type GifAccessQuery } from './gifAccess.js';

const Q: GifAccessQuery = { workspace: 'rob', platform: 'twitch', userId: '42', login: 'Divak', role: 'viewer' };
const quiet = { warn() {} };

test('normalizeGifAccess: čas Židolišty → lokální (serverNow), výchozí requestTtlSec 300, jen allowed === true', () => {
  const a = normalizeGifAccess({ ok: true, serverNow: 10_000, allowed: true, until: 70_000, cooldownUntil: 20_000, cooldownSec: 30, requestTtlSec: 120 }, 1_000_000);
  assert.deepEqual(a, { allowed: true, until: 1_060_000, cooldownUntil: 1_010_000, cooldownSec: 30, requestTtlSec: 120, mode: 'all', cooldownGlobalSec: 0 });
  const iso = normalizeGifAccess({ serverNow: '2026-09-25T10:00:00Z', allowed: true, until: '2026-09-25T10:01:00Z', cooldownUntil: null }, 5000);
  assert.equal(iso.until, 65_000);
  assert.equal(iso.requestTtlSec, 300);
  assert.equal(normalizeGifAccess({ allowed: 'true' }, 0).allowed, false);
});

test('normalizeGifAccess: mode all|approved (chybí / neznámé = all), cooldownGlobalSec', () => {
  assert.equal(normalizeGifAccess({ allowed: true, mode: 'approved' }, 0).mode, 'approved');
  assert.equal(normalizeGifAccess({ allowed: true, mode: 'cokoli' }, 0).mode, 'all');
  assert.equal(normalizeGifAccess({ allowed: true }, 0).mode, 'all');
  assert.equal(normalizeGifAccess({ allowed: false, mode: 'all', cooldownGlobalSec: 45 }, 0).cooldownGlobalSec, 45);
  assert.equal(normalizeGifAccess({ cooldownGlobalSec: -3 }, 0).cooldownGlobalSec, 0);
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

test('gifUsed: selhání → jeden opakovaný pokus; do potvrzení lokální cooldown podle cooldownSec (bod 7)', async () => {
  _resetGifAccessCache();
  let now = 1_000;
  let usedCalls = 0;
  const slept: number[] = [];
  const fetch = (async (url: string) => {
    if (url.endsWith('/gif-used')) { usedCalls++; return new Response('x', { status: 503 }); }
    return new Response(JSON.stringify({ ok: true, serverNow: now, allowed: true, until: null, cooldownUntil: null, cooldownSec: 30, requestTtlSec: 300 }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const deps = { fetch, apiKey: 'k', base: 'https://z.test', now: () => now, log: quiet, sleep: async (ms: number) => { slept.push(ms); } };
  await gifAccess(Q, deps);
  const p = gifUsed({ workspace: 'rob', platform: 'twitch', userId: '42' }, deps);
  assert.equal(gifAccessSync(Q, deps), 'denied', 'cooldown platí hned po schválení, ještě před odpovědí Židolišty');
  assert.equal(await p, null);
  assert.equal(usedCalls, 2);
  assert.deepEqual(slept, [2000]);
  assert.equal(gifAccessSync(Q, deps), 'denied');
  assert.ok((await gifAccess(Q, deps))!.cooldownUntil! >= now + 29_000);
  now += 31_000;
  assert.equal((await gifAccess(Q, deps))!.cooldownUntil, null, 'lokální cooldown vypršel');
});

test('SEC-8: globální cooldown chatu drží server sám — po zobrazeném GIFu ostatní z cache „allowed“ neprojdou', async () => {
  _resetGifAccessCache();
  let now = 1_000;
  const fetch = (async (url: string) => {
    if (url.endsWith('/gif-used')) return new Response(JSON.stringify({ ok: true, cooldownUntil: null, serverNow: now }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, serverNow: now, allowed: true, until: null, cooldownUntil: null, cooldownSec: 10, requestTtlSec: 300, cooldownGlobalSec: 30 }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const deps = { fetch, apiKey: 'k', base: 'https://z.test', now: () => now, log: quiet };
  const B: GifAccessQuery = { ...Q, userId: '43', login: 'jiny' };
  const M: GifAccessQuery = { ...Q, userId: '44', login: 'moda', role: 'moderator' };
  await gifAccess(Q, deps); await gifAccess(B, deps); await gifAccess(M, deps);
  assert.equal(gifAccessSync(B, deps), 'allowed');
  await gifUsed({ workspace: 'rob', platform: 'twitch', userId: '42' }, deps);
  assert.equal(gifAccessSync(B, deps), 'denied', 'jiný uživatel s cache allowed');
  assert.equal(gifAccessSync(M, deps), 'denied', 'mod bez výjimky');
  assert.equal(gifAccessSync({ ...B, workspace: 'jiny' }, deps), 'unknown', 'jiný workspace nedotčen');
  assert.ok((await gifAccess(B, deps))!.cooldownUntil! >= now + 29_000, 'i /gif/state a intercept vidí globální cooldown');
  now += 31_000;
  assert.equal(gifAccessSync(B, deps), 'allowed', 'po cooldownGlobalSec zase');
});

test('test2 bod 4.1: gifCooldownUntilSync — konec cooldownu (lokální / Židolišta / globální) jen u odemčeného; neodemčeno null', async () => {
  _resetGifAccessCache();
  let now = 1_000;
  let allowed = true;
  const fetch = (async (url: string) => {
    if (url.endsWith('/gif-used')) return new Response(JSON.stringify({ ok: true, cooldownUntil: 41_000, serverNow: now }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, serverNow: now, allowed, until: null, cooldownUntil: null, cooldownSec: 40, requestTtlSec: 300, cooldownGlobalSec: 20 }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const deps = { fetch, apiKey: 'k', base: 'https://z.test', now: () => now, log: quiet };
  assert.equal(gifCooldownUntilSync(Q, deps), null, 'nic v cache');
  await gifAccess(Q, deps);
  assert.equal(gifCooldownUntilSync(Q, deps), null, 'odemčeno bez cooldownu');
  await gifUsed({ workspace: 'rob', platform: 'twitch', userId: '42' }, deps);
  assert.equal(gifAccessSync(Q, deps), 'denied');
  assert.equal(gifCooldownUntilSync(Q, deps), 41_000, 'potvrzený cooldown Židolišty');
  const B: GifAccessQuery = { ...Q, userId: '43', login: 'jiny' };
  await gifAccess(B, deps);
  assert.equal(gifCooldownUntilSync(B, deps), 21_000, 'globální cooldown chatu');
  _resetGifAccessCache();
  allowed = false;
  now = 50_000;
  await gifAccess(Q, deps);
  assert.equal(gifCooldownUntilSync(Q, deps), null, 'neodemčeno → není to cooldown');
});

test('SEC-8: claimGifSlot — okamžité schválení si globální cooldown zarezervuje synchronně (souběh dvou GIFů z knihovny)', async () => {
  _resetGifAccessCache();
  const now = 1_000;
  const fetch = (async () => new Response(JSON.stringify({ ok: true, serverNow: now, allowed: true, until: null, cooldownUntil: null, cooldownSec: 10, requestTtlSec: 300, cooldownGlobalSec: 30 }), { status: 200 })) as unknown as typeof globalThis.fetch;
  const deps = { fetch, apiKey: 'k', base: 'https://z.test', now: () => now, log: quiet };
  assert.equal(typeof claimGifSlot('rob', now), 'function', 'bez známého cooldownGlobalSec nic neblokuje');
  await gifAccess(Q, deps);
  const release = claimGifSlot('rob', now);
  assert.equal(typeof release, 'function');
  assert.equal(claimGifSlot('ROB', now + 1), null, 'druhý GIF ve stejném okně ne');
  // Zobrazení selhalo → slot uvolnit, další GIF projde.
  release!();
  assert.equal(typeof claimGifSlot('rob', now + 2), 'function');
  assert.equal(claimGifSlot('rob', now + 3), null);
  assert.equal(typeof claimGifSlot('rob', now + 30_003), 'function');
});

test('SEC-8 review: zahození cache webhookem (invalidateGifAccess) globální cooldown neobejde — cooldownGlobalSec se pamatuje per workspace', async () => {
  _resetGifAccessCache();
  const now = 1_000;
  const fetch = (async (url: string) => {
    if (url.endsWith('/gif-used')) return new Response(JSON.stringify({ ok: true, cooldownUntil: null, serverNow: now }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, serverNow: now, allowed: true, until: null, cooldownUntil: null, cooldownSec: 10, requestTtlSec: 300, cooldownGlobalSec: 30 }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const deps = { fetch, apiKey: 'k', base: 'https://z.test', now: () => now, log: quiet };
  await gifAccess(Q, deps);
  invalidateGifAccess('rob');
  await gifUsed({ workspace: 'rob', platform: 'twitch', userId: '42' }, deps);
  assert.equal(claimGifSlot('rob', now + 1), null, 'globální cooldown platí i po zahození cache');
});
