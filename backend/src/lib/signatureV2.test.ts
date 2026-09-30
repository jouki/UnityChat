import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hmacV2, signedTextV2, signV2Headers, verifyV2, parseSignatureHeader, SIGNING_KEY_RE } from './signatureV2.js';
import { gifAccess, gifUsed, _resetGifAccessCache } from './gifAccess.js';
import { zidolistaFetch, ZidolistaRedirectError, zidolistaSignature, signedGetPath } from './zidolista.js';
import { verifySignature } from './inboundAuth.js';

// Testovací vektor z kontraktu (docs/superpowers/plans/2026-09-26-podpis-v2-kontrakt.md) — Židolišta má stejný.
const VEC = {
  key: '00'.repeat(32), method: 'POST', path: '/integrations/rob/gif-used?x=1', t: 1790000000,
  nonce: 'abcdef0123456789abcdef0123456789', body: '{"a":1}',
  hmac: 'cb61b914ef408396607b33abdc35704be697298d9cce2b55bb1727012a237ecb',
};

test('v2 testovací vektor z kontraktu', () => {
  const bodyHash = createHash('sha256').update(VEC.body).digest('hex');
  assert.equal(signedTextV2(VEC.method, VEC.path, VEC.t, VEC.nonce, VEC.body), `POST /integrations/rob/gif-used?x=1\n1790000000\nabcdef0123456789abcdef0123456789\n${bodyHash}`);
  assert.equal(hmacV2(VEC.key, VEC.method, VEC.path, VEC.t, VEC.nonce, VEC.body), VEC.hmac);
  assert.equal(hmacV2(VEC.key, 'post', VEC.path, VEC.t, VEC.nonce, Buffer.from(VEC.body)), VEC.hmac, 'metoda velkými, tělo jako bajty');
  const h = signV2Headers(VEC.key, VEC.method, VEC.path, VEC.body, { nowS: VEC.t, nonce: VEC.nonce });
  assert.deepEqual(h, { 'X-UC-Signature': `t=1790000000,v2=${VEC.hmac}`, 'X-UC-Nonce': VEC.nonce });
  assert.equal(verifyV2({ header: h['X-UC-Signature'], nonce: h['X-UC-Nonce'], method: 'POST', pathAndQuery: VEC.path, rawBody: VEC.body, keyHex: VEC.key, nowS: VEC.t }), 'ok');
  // GET / bez těla = sha256 prázdného řetězce
  assert.ok(signedTextV2('GET', '/x', 1, 'n'.repeat(16), '').endsWith('\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'));
  assert.equal(signedTextV2('GET', '/x', 1, 'n'.repeat(16), undefined), signedTextV2('GET', '/x', 1, 'n'.repeat(16), ''));
});

test('parseSignatureHeader + validace klíče', () => {
  assert.equal(parseSignatureHeader(''), null);
  assert.deepEqual(parseSignatureHeader(' t=1 , v2=ab,junk '), { t: '1', v2: 'ab' });
  assert.equal(SIGNING_KEY_RE.test('ab'.repeat(32)), true);
  assert.equal(SIGNING_KEY_RE.test('ab'.repeat(31)), false, '< 64 znaků');
  assert.equal(SIGNING_KEY_RE.test('a'.repeat(65)), false, 'lichá délka');
  assert.equal(SIGNING_KEY_RE.test('zz'.repeat(32)), false, 'ne-hex');
});

// ---- Odchozí volání (zidolistaFetch) ----
type Call = { url: string; init: RequestInit & { headers: Record<string, string> } };
const recorder = (responses: Array<() => Response>) => {
  const calls: Call[] = [];
  const f = (async (url: string, init: Call['init']) => { calls.push({ url, init }); return (responses[calls.length - 1] ?? responses[responses.length - 1])(); }) as unknown as typeof fetch;
  return { calls, f };
};
const json = (b: unknown, status = 200) => () => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const SK = '11'.repeat(32);
const API = 'API-KEY-' + 'y'.repeat(24);

test('zidolistaFetch v2: podepsaná přesně odeslaná cesta+query vč. prefixu z base, POST tělo', async () => {
  const { calls, f } = recorder([json({ ok: true })]);
  const url = 'https://z.test/api/v9/integrations/rob/gif-used?x=1&y=%C3%A1';
  const body = '{"platform":"twitch","userId":"42"}';
  await zidolistaFetch(url, { method: 'post', headers: { 'Content-Type': 'application/json' }, body }, { fetch: f, apiKey: API, signingKey: SK, nowS: 1_790_000_000, nonce: 'n'.repeat(32) });
  const { init } = calls[0];
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.body, body);
  assert.equal(init.headers['X-Api-Key'], API);
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.headers['X-UC-Nonce'], 'n'.repeat(32));
  const expected = hmacV2(SK, 'POST', '/api/v9/integrations/rob/gif-used?x=1&y=%C3%A1', 1_790_000_000, 'n'.repeat(32), body);
  assert.equal(init.headers['X-UC-Signature'], `t=1790000000,v2=${expected}`);
  // druhá strana ověří s req.url = přesně to, co odešlo
  assert.equal(verifyV2({ header: init.headers['X-UC-Signature'], nonce: init.headers['X-UC-Nonce'], method: 'POST', pathAndQuery: '/api/v9/integrations/rob/gif-used?x=1&y=%C3%A1', rawBody: body, keyHex: SK, nowS: 1_790_000_000 }), 'ok');
  assert.ok(!JSON.stringify(init.headers).includes(SK), 'podpisový klíč nejde po síti');
});

test('zidolistaFetch v2: GET s prázdným tělem, každé volání vlastní nonce; v2 má přednost před v1 i u donations', async () => {
  const { calls, f } = recorder([json({ ok: true })]);
  const url = 'https://z.test/integrations/rob/donations?platform=twitch&limit=200';
  await zidolistaFetch(url, { legacyV1: true }, { fetch: f, apiKey: API, signingKey: SK, nowS: 1_790_000_000 });
  await zidolistaFetch(url, { legacyV1: true }, { fetch: f, apiKey: API, signingKey: SK, nowS: 1_790_000_000 });
  const [a, b] = calls.map((c) => c.init.headers);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.body, undefined);
  assert.match(a['X-UC-Nonce'], /^[0-9a-f]{32}$/);
  assert.notEqual(a['X-UC-Nonce'], b['X-UC-Nonce']);
  assert.match(a['X-UC-Signature'], /^t=1790000000,v2=[0-9a-f]{64}$/);
  assert.equal(verifyV2({ header: a['X-UC-Signature'], nonce: a['X-UC-Nonce'], method: 'GET', pathAndQuery: '/integrations/rob/donations?platform=twitch&limit=200', rawBody: '', keyHex: SK, nowS: 1_790_000_000 }), 'ok');
});

test('zidolistaFetch bez v2 klíče: v1 jen u donations (dosavadní chování), jinde bez podpisu', async () => {
  const { calls, f } = recorder([json({ ok: true })]);
  const url = 'https://z.test/prefix/integrations/rob/donations?limit=1';
  await zidolistaFetch(url, { legacyV1: true }, { fetch: f, apiKey: API, signingKey: '', nowS: 1_790_000_000 });
  await zidolistaFetch('https://z.test/integrations/rob/chat-commands', {}, { fetch: f, apiKey: API, signingKey: '' });
  assert.equal(calls[0].init.headers['X-UC-Signature'], zidolistaSignature(API, signedGetPath(url), 1_790_000_000));
  assert.equal(verifySignature(calls[0].init.headers['X-UC-Signature'], 'GET /prefix/integrations/rob/donations?limit=1', API, 1_790_000_000), 'ok');
  assert.equal(calls[0].init.headers['X-UC-Nonce'], undefined);
  assert.equal(calls[1].init.headers['X-UC-Signature'], undefined);
  assert.equal(calls[1].init.redirect, 'manual', 'redirect manual i bez podpisu');
});

test('zidolistaFetch: 3xx = chyba bez druhého požadavku, 304 projde, klíč není v chybě', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const { calls, f } = recorder([() => new Response(null, { status, headers: { location: 'https://evil.test/steal' } })]);
    await assert.rejects(zidolistaFetch('https://z.test/integrations/rob/blacklist', {}, { fetch: f, apiKey: API, signingKey: SK }), (e: unknown) => {
      assert.ok(e instanceof ZidolistaRedirectError);
      assert.equal((e as ZidolistaRedirectError).status, status);
      assert.ok(!String((e as Error).message).includes(API) && !String((e as Error).message).includes(SK));
      assert.ok(!String((e as Error).message).includes('evil.test'));
      return true;
    });
    assert.equal(calls.length, 1, `po ${status} žádný další požadavek`);
  }
  const { f } = recorder([() => new Response(null, { status: 304 })]);
  assert.equal((await zidolistaFetch('https://z.test/integrations/rob/blacklist', { headers: { 'If-None-Match': '"e"' } }, { fetch: f, apiKey: API })).status, 304);
});

test('zidolistaFetch se skutečným fetch: 302 na jiný host se nesleduje, cíl nedostane nic', async () => {
  const hits: Array<Record<string, unknown>> = [];
  const evil = createServer((req, res) => { hits.push(req.headers); res.end('{}'); });
  await new Promise<void>((r) => evil.listen(0, '127.0.0.1', r));
  const evilPort = (evil.address() as AddressInfo).port;
  const origin = createServer((_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${evilPort}/steal` }); res.end(); });
  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
  const port = (origin.address() as AddressInfo).port;
  try {
    await assert.rejects(zidolistaFetch(`http://localhost:${port}/integrations/rob/sfx-state?x=1`, {}, { apiKey: API, signingKey: SK }), ZidolistaRedirectError);
    await assert.rejects(zidolistaFetch(`http://localhost:${port}/donate/public/rob/intents`, { method: 'POST', body: '{}' }, { apiKey: API, signingKey: SK }), ZidolistaRedirectError);
    assert.equal(hits.length, 0, 'na cíl přesměrování nedošel žádný požadavek (ani X-Api-Key)');
  } finally {
    origin.close(); evil.close();
  }
});

test('volající Židolišty: přesměrování se loguje bez klíčů a nesleduje (gif-access / gif-used)', async () => {
  _resetGifAccessCache();
  const logs: string[] = [];
  const log = { warn: (o: object, m: string) => logs.push(JSON.stringify(o) + m), info: () => {} };
  const { calls, f } = recorder([() => new Response(null, { status: 302, headers: { location: 'https://evil.test/' } })]);
  const deps = { fetch: f, apiKey: API, signingKey: SK, base: 'https://z.test', log, sleep: async () => {} };
  assert.equal(await gifAccess({ workspace: 'rob', platform: 'twitch', userId: '1', login: 'a', role: 'viewer' }, deps), null);
  assert.equal(await gifUsed({ workspace: 'rob', platform: 'twitch', userId: '1' }, deps), null);
  assert.equal(calls.length, 3, 'gif-access 1× + gif-used 2 pokusy, nikdy na evil.test');
  assert.ok(calls.every((c) => c.url.startsWith('https://z.test/')));
  assert.ok(calls.every((c) => c.init.redirect === 'manual' && /v2=/.test(c.init.headers['X-UC-Signature'])));
  const all = logs.join('\n');
  assert.ok(logs.length >= 2 && /redirect HTTP 302/.test(all));
  assert.ok(!all.includes(API) && !all.includes(SK), 'klíče ne do logu');
});
