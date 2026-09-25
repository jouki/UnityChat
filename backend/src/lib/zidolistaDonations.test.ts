import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { zidolistaDonations, normalizeDonationsPage, _resetDonationsCache, DONATIONS_MAX_PAGES, zidolistaSignature, signedGetPath, zidolistaGetHeaders } from './zidolista.js';
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
  const h = zidolistaGetHeaders(url, 'tajny', 1_790_000_000);
  assert.deepEqual(Object.keys(h).sort(), ['Accept', 'X-Api-Key', 'X-UC-Signature']);
  assert.equal(h['X-UC-Signature'], sig);
});

const quiet = { warn: () => {} };
const Q = { workspace: 'Rob', platform: 'twitch' as const, userId: '42', login: 'Divak' };
const res = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

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
