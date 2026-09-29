import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createHash } from 'node:crypto';
import { zidolistaDonations, normalizeDonationsPage, _resetDonationsCache, DONATIONS_MAX_PAGES, zidolistaSignature, signedGetPath, emailProof } from './zidolista.js';
import { verifySignature } from './inboundAuth.js';

test('podpis UC → Židolišta: t=<s>,v1=<hex HMAC(klíč, t + "." + "GET /cesta?query")>, query přesně jak se posílá', () => {
  const url = 'https://api-zidolista.jouki.cz/integrations/rob/donations?platform=twitch&userId=123&login=abc&limit=100';
  assert.equal(signedGetPath(url), 'GET /integrations/rob/donations?platform=twitch&userId=123&login=abc&limit=100');
  assert.equal(signedGetPath('https://h.test/prefix/integrations/rob/donations?before=2026-01-01T00%3A00%3A00Z'), 'GET /prefix/integrations/rob/donations?before=2026-01-01T00%3A00%3A00Z', 'prefix z base i zakódovaná query beze změny');
  const sig = zidolistaSignature('tajny', signedGetPath(url), 1_790_000_000);
  const expected = createHmac('sha256', 'tajny').update('1790000000.GET /integrations/rob/donations?platform=twitch&userId=123&login=abc&limit=100').digest('hex');
  assert.equal(sig, `t=1790000000,v1=${expected}`);
  // Stejný formát, jaký ověřuje naše příchozí strana (okno ±300 s).
  assert.equal(verifySignature(sig, signedGetPath(url), 'tajny', 1_790_000_100), 'ok');
  assert.equal(verifySignature(sig, signedGetPath(url).replace('limit=100', 'limit=200'), 'tajny', 1_790_000_100), 'mismatch', 'podpis kryje query');
  assert.equal(verifySignature(sig, signedGetPath(url), 'tajny', 1_790_000_400), 'expired');
});

const quiet = { warn: () => {} };
const Q = { workspace: 'Rob', platform: 'twitch' as const, userId: '42', login: 'Divak' };
const res = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

test('ověřený e-mail účtu: hlavička X-UC-Email + otisk emailHash v podepsané adrese, vlastní cache', async () => {
  _resetDonationsCache();
  const hash = createHash('sha256').update('tonner@example.com', 'utf8').digest('hex');
  assert.deepEqual(emailProof('  Tonner@Example.COM '), { email: 'tonner@example.com', hash }, 'malá písmena, po trimu');
  assert.equal(emailProof(''), null);
  assert.equal(emailProof('nesmysl'), null);
  const seen: Array<{ u: string; email: string | undefined }> = [];
  const fetch = (async (u: string, init: { headers: Record<string, string> }) => {
    seen.push({ u, email: init.headers['X-UC-Email'] });
    assert.equal(verifySignature(init.headers['X-UC-Signature'], signedGetPath(u), 'k', Math.floor(Date.now() / 1000)), 'ok', 'otisk je v podepsané adrese');
    return res({ ok: true, items: u.includes('emailHash=') ? [{ id: 'e1', amount: 100, currency: 'CZK', amountCzk: 100, paidAt: '2026-02-01T00:00:00Z', matchedBy: 'email' }] : [], nextBefore: null });
  }) as unknown as typeof globalThis.fetch;
  const deps = { fetch, apiKey: 'k', base: 'https://z.test/', now: () => 0, log: quiet };
  assert.deepEqual(await zidolistaDonations(Q, deps), [], 'bez e-mailu jako dosud');
  const items = await zidolistaDonations({ ...Q, email: ' Tonner@Example.com' }, deps);
  assert.deepEqual(items!.map((i) => `${i.id}:${i.matchedBy}`), ['e1:email'], 'dotaz s e-mailem nebere cache dotazu bez něj');
  assert.equal(seen[0].email, undefined);
  assert.ok(!seen[0].u.includes('emailHash'));
  assert.equal(seen[1].email, 'tonner@example.com');
  assert.ok(seen[1].u.endsWith(`&emailHash=${hash}`), seen[1].u);
  assert.ok(!seen[1].u.includes('tonner'), 'samotný e-mail v adrese není');
});

test('normalizeDonationsPage: čas → ms, bez id / času pryč, message a matchedBy', () => {
  const p = normalizeDonationsPage({ items: [
    { id: 1, amount: 150, currency: 'czk', amountCzk: 150, paidAt: '2026-09-25T10:00:00Z', via: 'qr', matchedBy: 'nickname', nickname: 'Divák', message: 'díky' },
    { id: '', paidAt: '2026-09-25T10:00:00Z' }, { id: 'x', paidAt: 'nesmysl' },
    { id: 'e', amount: 20, currency: 'EUR', amountCzk: 500, paidAt: '2026-09-24T10:00:00Z', via: 'fourthwall', matchedBy: 'uc' },
  ], nextBefore: '2026-09-24T10:00:00Z' });
  assert.equal(p.items.length, 2);
  assert.deepEqual(p.items[0], { id: '1', amount: 150, currency: 'CZK', amountCzk: 150, paidAt: Date.parse('2026-09-25T10:00:00Z'), via: 'qr', matchedBy: 'nickname', nickname: 'Divák', message: 'díky' });
  assert.equal(p.items[1].message, null);
  assert.equal(p.nextBefore, '2026-09-24T10:00:00Z');
  assert.equal(normalizeDonationsPage({ nextBefore: 'x' }).nextBefore, null);
});

test('zidolistaDonations: X-Api-Key, stránkování přes nextBefore → before, cache 60 s', async () => {
  _resetDonationsCache();
  const urls: string[] = [];
  const keys: string[] = [];
  let t = 0;
  const fetch = (async (u: string, init: { headers: Record<string, string> }) => {
    urls.push(u); keys.push(init.headers['X-Api-Key']);
    assert.equal(verifySignature(init.headers['X-UC-Signature'], signedGetPath(u), 'k', Math.floor(Date.now() / 1000)), 'ok', 'každý dotaz podepsaný nad svou URL');
    return u.includes('before=') ? res({ ok: true, items: [{ id: 'b', amount: 1, currency: 'CZK', paidAt: '2026-01-01T00:00:00Z' }], nextBefore: null })
      : res({ ok: true, total: { czk: 999 }, count: 9, items: [{ id: 'a', amount: 2, currency: 'CZK', paidAt: '2026-02-01T00:00:00Z' }], nextBefore: '2026-02-01T00:00:00Z' });
  }) as unknown as typeof globalThis.fetch;
  const deps = { fetch, apiKey: 'k', base: 'https://z.test/', now: () => t, log: quiet };
  const items = await zidolistaDonations(Q, deps);
  assert.deepEqual(items!.map((i) => i.id), ['a', 'b']);
  assert.match(urls[0], /^https:\/\/z\.test\/integrations\/rob\/donations\?platform=twitch&userId=42&login=divak&limit=200$/);
  assert.match(urls[1], /&before=2026-02-01T00%3A00%3A00Z$/);
  assert.deepEqual(keys, ['k', 'k']);
  await zidolistaDonations(Q, deps);
  assert.equal(urls.length, 2, 'cache');
  t = 60_001;
  await zidolistaDonations(Q, deps);
  assert.equal(urls.length, 4, 'po 60 s znovu');
});

test('zidolistaDonations: strop (allowFetch) jen u necachovaného dotazu; prázdný výsledek i chyba se cachují', async () => {
  _resetDonationsCache();
  let n = 0, budget = 0;
  const fetch = (async (u: string) => { n++; return u.includes('userId=err') ? res({ ok: false }, 500) : res({ ok: true, items: [], nextBefore: null }); }) as unknown as typeof globalThis.fetch;
  const allowFetch = () => { budget++; return budget <= 2; };
  const d = { fetch, apiKey: 'k', base: 'https://z.test', now: () => 0, log: quiet, allowFetch };
  assert.deepEqual(await zidolistaDonations(Q, d), [], 'prázdný seznam');
  assert.deepEqual(await zidolistaDonations(Q, d), [], 'z cache');
  assert.equal(budget, 1, 'cache strop nečerpá');
  assert.equal(await zidolistaDonations({ ...Q, userId: 'err' }, d), null);
  assert.equal(await zidolistaDonations({ ...Q, userId: 'err' }, d), null, 'chyba z cache');
  assert.equal(n, 2);
  assert.equal(budget, 2);
  assert.equal(await zidolistaDonations({ ...Q, userId: 'jiny' }, d), null, 'strop vyčerpaný → bez dotazu');
  assert.equal(n, 2);
  assert.equal(await zidolistaDonations({ ...Q, userId: 'jiny' }, { ...d, allowFetch: () => true }), await zidolistaDonations({ ...Q, userId: 'jiny' }, d), 'odmítnutí se necachuje');
  assert.equal(n, 3);
});

test('zidolistaDonations: 404 / výpadek / bez klíče → null (žádná chyba); strop stránek', async () => {
  _resetDonationsCache();
  assert.equal(await zidolistaDonations(Q, { fetch: (async () => res({ ok: false }, 404)) as unknown as typeof fetch, apiKey: 'k', base: 'https://z.test', log: quiet }), null);
  _resetDonationsCache();
  assert.equal(await zidolistaDonations(Q, { fetch: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch, apiKey: 'k', base: 'https://z.test', log: quiet }), null);
  _resetDonationsCache();
  assert.equal(await zidolistaDonations(Q, { apiKey: '' }), null);
  _resetDonationsCache();
  let n = 0;
  const endless = (async () => { n++; return res({ ok: true, items: [{ id: `i${n}`, amount: 1, currency: 'CZK', paidAt: '2026-01-01T00:00:00Z' }], nextBefore: '2025-01-01T00:00:00Z' }); }) as unknown as typeof fetch;
  const all = await zidolistaDonations(Q, { fetch: endless, apiKey: 'k', base: 'https://z.test', log: quiet });
  assert.equal(n, DONATIONS_MAX_PAGES);
  assert.equal(all!.length, DONATIONS_MAX_PAGES);
});
