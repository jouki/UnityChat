import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { verifySignature, checkInbound, inboundAuthorized, registerRawJsonParser, _resetInboundNonces } from './inboundAuth.js';
import { NonceCache, signV2Headers } from './signatureV2.js';

const KEY = 'k'.repeat(40);
const sign = (t: number, body: string, key = KEY) => `t=${t},v1=${createHmac('sha256', key).update(`${t}.${body}`).digest('hex')}`;
const NOW = 1_790_000_000;

test('verifySignature (v1): platný, prošlý, podvržený, chybějící', () => {
  const body = '{"workspace":"rob","reason":"sfx-played"}';
  assert.equal(verifySignature(sign(NOW, body), body, KEY, NOW), 'ok');
  assert.equal(verifySignature(sign(NOW, body), Buffer.from(body), KEY, NOW), 'ok', 'surové bajty');
  assert.equal(verifySignature(sign(NOW - 301, body), body, KEY, NOW), 'expired', 'replay po 5 min neprojde');
  assert.equal(verifySignature(sign(NOW, body), body + ' ', KEY, NOW), 'mismatch', 'změněné tělo');
  assert.equal(verifySignature(sign(NOW, body, 'jiny-klic'), body, KEY, NOW), 'mismatch', 'jiný klíč');
  assert.equal(verifySignature('', body, KEY, NOW), 'missing');
  assert.equal(verifySignature('t=abc,v1=zz', body, KEY, NOW), 'malformed');
  assert.equal(verifySignature(sign(NOW, ''), '', KEY, NOW), 'ok', 'GET = prázdné tělo');
});

const req = (headers: Record<string, string>, rawBody = '', method = 'POST', url = '/commands/invalidate') =>
  ({ headers, rawBody: Buffer.from(rawBody), method, url } as unknown as FastifyRequest);
type Env = Parameters<typeof checkInbound>[1];
const env = (o: Partial<Record<'ZIDOLISTA_API_KEY' | 'ZIDOLISTA_INBOUND_KEY' | 'ZIDOLISTA_INBOUND_STRICT' | 'ZIDOLISTA_INBOUND_SIGNATURE' | 'ZIDOLISTA_TO_UC_SIGNING_KEY', string>>) =>
  ({ ZIDOLISTA_API_KEY: 'legacy', ZIDOLISTA_INBOUND_KEY: '', ZIDOLISTA_INBOUND_STRICT: '', ZIDOLISTA_INBOUND_SIGNATURE: 'v1', ZIDOLISTA_TO_UC_SIGNING_KEY: '', ...o }) as Env;

test('checkInbound v1: přechod pustí starý klíč, strict jen nový klíč + podpis', () => {
  const body = '{"a":1}';
  const t = Math.floor(Date.now() / 1000);
  // dnešní stav: jen společný klíč
  assert.equal(checkInbound(req({ 'x-api-key': 'legacy' }), env({})).ok, true);
  assert.deepEqual(checkInbound(req({ 'x-api-key': 'spatny' }), env({})), { ok: false, error: 'unauthorized' });
  // přechod: nový klíč nastavený, starý pořád projde, podpis se jen hlásí
  const tr = env({ ZIDOLISTA_INBOUND_KEY: KEY });
  assert.deepEqual(checkInbound(req({ 'x-api-key': 'legacy' }, body), tr), { ok: true, legacyKey: true, signature: 'missing', version: 'v1' });
  assert.equal(checkInbound(req({ 'x-api-key': KEY, 'x-uc-signature': sign(t, body) }, body), tr).signature, 'ok');
  // strict: starý klíč ne, bez podpisu ne, s podpisem ano
  const st = env({ ZIDOLISTA_INBOUND_KEY: KEY, ZIDOLISTA_INBOUND_STRICT: '1' });
  assert.deepEqual(checkInbound(req({ 'x-api-key': 'legacy', 'x-uc-signature': sign(t, body) }, body), st), { ok: false, error: 'unauthorized' });
  assert.deepEqual(checkInbound(req({ 'x-api-key': KEY }, body), st), { ok: false, error: 'bad_signature', detail: 'missing', signature: 'missing' });
  assert.equal(checkInbound(req({ 'x-api-key': KEY, 'x-uc-signature': sign(t, body) }, body), st).ok, true);
  assert.equal(checkInbound(req({ 'x-api-key': KEY, 'x-uc-signature': sign(t, '{"a":2}') }, body), st).detail, 'mismatch', 'podvržené tělo');
});

// ---- v2 ----
const SK = 'ab'.repeat(32);
const NONCE = 'abcdef0123456789abcdef0123456789';
const v2 = (method: string, url: string, body: string, o: { nowS?: number; nonce?: string; key?: string } = {}) =>
  signV2Headers(o.key ?? SK, method, url, body, { nowS: o.nowS ?? NOW, nonce: o.nonce ?? NONCE });
const hdr = (h: { 'X-UC-Signature': string; 'X-UC-Nonce': string }, apiKey = KEY) =>
  ({ 'x-api-key': apiKey, 'x-uc-signature': h['X-UC-Signature'], 'x-uc-nonce': h['X-UC-Nonce'] });
const V2 = env({ ZIDOLISTA_INBOUND_KEY: KEY, ZIDOLISTA_INBOUND_SIGNATURE: 'v2', ZIDOLISTA_TO_UC_SIGNING_KEY: SK });
const ANY = env({ ZIDOLISTA_INBOUND_KEY: KEY, ZIDOLISTA_INBOUND_SIGNATURE: 'any', ZIDOLISTA_TO_UC_SIGNING_KEY: SK });

test('checkInbound v2: správný podpis projde, metoda/cesta/query/tělo jsou krytá', () => {
  const nonces = new NonceCache();
  const url = '/integrations/rob/moderation/ban?x=1';
  const body = '{"platform":"twitch","userId":"1"}';
  const d = { nowS: NOW, nonces };
  assert.deepEqual(checkInbound(req(hdr(v2('POST', url, body)), body, 'POST', url), V2, d), { ok: true, legacyKey: false, signature: 'ok', version: 'v2' });
  const mm = (h: ReturnType<typeof v2>, b: string, m: string, u: string) => checkInbound(req(hdr(h), b, m, u), V2, { nowS: NOW, nonces: new NonceCache() });
  assert.equal(mm(v2('POST', url, body), body, 'DELETE', url).detail, 'mismatch', 'jiná metoda');
  assert.equal(mm(v2('POST', url, body), body, 'POST', '/integrations/jiny/moderation/ban?x=1').detail, 'mismatch', 'jiná cesta (slug)');
  assert.equal(mm(v2('POST', url, body), body, 'POST', '/integrations/rob/moderation/ban?x=2').detail, 'mismatch', 'jiná query');
  assert.equal(mm(v2('POST', url, body), body + ' ', 'POST', url).detail, 'mismatch', 'jiné tělo');
  assert.equal(mm(v2('POST', url, body, { key: 'cd'.repeat(32) }), body, 'POST', url).detail, 'mismatch', 'jiný klíč');
  // GET bez těla
  assert.equal(checkInbound(req(hdr(v2('GET', '/integrations/rob/chat-log?limit=5', '', { nonce: 'n'.repeat(16) })), '', 'GET', '/integrations/rob/chat-log?limit=5'), V2, d).ok, true);
});

test('checkInbound v2: missing, malformed, expired, mismatch, replay (401 kódy z kontraktu)', () => {
  const url = '/announcements';
  const body = '{"a":1}';
  const run = (h: Record<string, string>, nonces = new NonceCache(), nowS = NOW) => checkInbound(req(h, body, 'POST', url), V2, { nowS, nonces });
  const good = v2('POST', url, body);
  // klíč napřed: špatný X-Api-Key = unauthorized i s platným podpisem
  assert.deepEqual(run(hdr(good, 'spatny')), { ok: false, error: 'unauthorized' });
  assert.deepEqual(run(hdr(good, 'legacy')), { ok: false, error: 'unauthorized' }, 'legacy klíč ve v2 neprojde');
  // missing
  assert.equal(run({ 'x-api-key': KEY }).detail, 'missing');
  assert.equal(run({ 'x-api-key': KEY, 'x-uc-signature': good['X-UC-Signature'] }).detail, 'missing', 'bez nonce');
  assert.equal(run({ 'x-api-key': KEY, 'x-uc-nonce': NONCE }).detail, 'missing', 'bez podpisu');
  // malformed
  assert.equal(run({ ...hdr(good), 'x-uc-nonce': 'kratky' }).detail, 'malformed', 'nonce < 16');
  assert.equal(run({ ...hdr(good), 'x-uc-nonce': 'x'.repeat(65) }).detail, 'malformed', 'nonce > 64');
  assert.equal(run({ ...hdr(good), 'x-uc-nonce': 'abc def 0123456789' }).detail, 'malformed', 'nonce se mezerou');
  assert.equal(run({ ...hdr(good), 'x-uc-signature': `t=abc,v2=${'0'.repeat(64)}` }).detail, 'malformed');
  assert.equal(run({ ...hdr(good), 'x-uc-signature': `t=${NOW},v2=zz` }).detail, 'malformed');
  assert.equal(run({ ...hdr(good), 'x-uc-signature': sign(NOW, body) }).detail, 'malformed', 'v1 v režimu v2 neprojde');
  // expired (±300 s)
  assert.equal(run(hdr(v2('POST', url, body, { nowS: NOW - 301 }))).detail, 'expired');
  assert.equal(run(hdr(v2('POST', url, body, { nowS: NOW + 301 }))).detail, 'expired', 'budoucnost');
  assert.equal(run(hdr(v2('POST', url, body, { nowS: NOW - 300 }))).ok, true, 'hrana okna');
  // mismatch
  assert.equal(run({ ...hdr(good), 'x-uc-nonce': 'z'.repeat(32) }).detail, 'mismatch', 'nonce je součástí podpisu');
  // replay: stejná zpráva podruhé
  const nonces = new NonceCache();
  assert.equal(run(hdr(good), nonces).ok, true);
  assert.deepEqual(run(hdr(good), nonces), { ok: false, error: 'replay' });
  // nonce se zapíše až po úspěšném ověření: podvržený požadavek se stejným nonce ho „nespálí“
  const n2 = new NonceCache();
  assert.equal(run({ ...hdr(good), 'x-uc-signature': `t=${NOW},v2=${'0'.repeat(64)}` }, n2).detail, 'mismatch');
  assert.equal(n2.size, 0);
  assert.equal(run(hdr(good), n2).ok, true, 'legitimní požadavek se stejným nonce pak projde');
});

test('NonceCache: 360 s, pak nonce zase projde (za oknem podpisu stejně expired)', () => {
  let now = 0;
  const c = new NonceCache(360_000, () => now);
  c.add('a'.repeat(16));
  assert.equal(c.has('a'.repeat(16)), true);
  now = 359_999;
  assert.equal(c.has('a'.repeat(16)), true);
  now = 360_000;
  assert.equal(c.has('a'.repeat(16)), false);
});

test('checkInbound režimy: v1 odmítá v2, any bere v1 i v2, v2 bere jen v2', () => {
  const url = '/commands/invalidate';
  const body = '{"a":1}';
  const t = Math.floor(Date.now() / 1000);
  const h1 = { 'x-api-key': KEY, 'x-uc-signature': sign(t, body) };
  const h2 = hdr(v2('POST', url, body, { nowS: t, nonce: 'q'.repeat(20) }));
  const run = (h: Record<string, string>, e: Env) => checkInbound(req(h, body, 'POST', url), e, { nonces: new NonceCache() });
  const V1S = env({ ZIDOLISTA_INBOUND_KEY: KEY, ZIDOLISTA_INBOUND_STRICT: '1', ZIDOLISTA_TO_UC_SIGNING_KEY: SK });
  assert.equal(run(h1, V1S).ok, true, 'v1 strict + v1');
  assert.equal(run(h2, V1S).detail, 'malformed', 'v1 strict nezná v2');
  assert.deepEqual(run(h1, ANY), { ok: true, legacyKey: false, signature: 'ok', version: 'v1' });
  assert.deepEqual(run(h2, ANY), { ok: true, legacyKey: false, signature: 'ok', version: 'v2' });
  assert.equal(run({ 'x-api-key': KEY }, ANY).detail, 'missing', 'any je fail-closed');
  assert.equal(run({ 'x-api-key': 'legacy' }, ANY).error, 'unauthorized', 'any nebere legacy klíč ani bez STRICT');
  assert.equal(run(h1, V2).detail, 'missing', 'v1 bez nonce');
  assert.equal(run(h2, V2).version, 'v2');
  // any s v2 hlavičkou, ale špatným podpisem nespadne zpátky na v1
  assert.equal(run({ ...h2, 'x-uc-signature': `${h1['x-uc-signature']},v2=${'0'.repeat(64)}` }, ANY).detail, 'mismatch');
  // v2 bez podpisového klíče = nic neprojde
  assert.equal(run(h2, env({ ZIDOLISTA_INBOUND_KEY: KEY, ZIDOLISTA_INBOUND_SIGNATURE: 'v2' })).ok, false);
  assert.equal(run(h2, env({ ZIDOLISTA_INBOUND_SIGNATURE: 'v2', ZIDOLISTA_TO_UC_SIGNING_KEY: SK })).error, 'unauthorized', 'bez ZIDOLISTA_INBOUND_KEY');
});

test('inboundAuthorized: 401 s kódem z kontraktu, klíče se neobjeví v logu ani v odpovědi', () => {
  _resetInboundNonces();
  const logs: string[] = [];
  let status = 0; let sent: unknown = null;
  const log = { warn: (o: unknown, m: string) => logs.push(JSON.stringify(o) + m), info: () => {}, error: () => {} };
  const reply = { code(n: number) { status = n; return { send(b: unknown) { sent = b; return b; } }; } };
  const secretApiKey = 'SECRET-API-KEY-' + 'x'.repeat(20);
  const r = { headers: { 'x-api-key': secretApiKey, 'x-uc-signature': `t=${Math.floor(Date.now() / 1000)},v2=${'0'.repeat(64)}`, 'x-uc-nonce': NONCE }, rawBody: Buffer.from('{}'), method: 'POST', url: '/announcements?token=abc', log } as unknown as FastifyRequest;
  assert.equal(inboundAuthorized(r, reply), false);
  assert.equal(status, 401);
  assert.deepEqual(sent, { ok: false, error: 'unauthorized' });
  // správný X-Api-Key, špatný podpis (v2) → bad_signature
  const r2 = { ...r, headers: { ...r.headers, 'x-api-key': KEY } } as unknown as FastifyRequest;
  assert.equal(inboundAuthorized(r2, reply, V2), false);
  assert.deepEqual(sent, { ok: false, error: 'bad_signature', detail: 'mismatch' });
  // replay
  const url = '/announcements';
  const good = { headers: hdr(v2('POST', url, '{}', { nowS: Math.floor(Date.now() / 1000), nonce: 'r'.repeat(24) })), rawBody: Buffer.from('{}'), method: 'POST', url, log } as unknown as FastifyRequest;
  assert.equal(inboundAuthorized(good, reply, V2), true);
  assert.equal(inboundAuthorized(good, reply, V2), false);
  assert.deepEqual(sent, { ok: false, error: 'replay' });
  // přechod v1 (loguje „signature not ok“)
  assert.equal(inboundAuthorized({ ...r, headers: { 'x-api-key': 'legacy' } } as unknown as FastifyRequest, reply, env({ ZIDOLISTA_INBOUND_KEY: KEY })), true);
  assert.ok(logs.length >= 4);
  const all = logs.join('\n') + JSON.stringify(sent);
  for (const secret of [secretApiKey, KEY, SK, '"legacy"', 'token=abc', '0'.repeat(64), 'r'.repeat(24)]) {
    assert.ok(!all.includes(secret), `v logu nesmí být: ${secret.slice(0, 12)}`);
  }
});

test('Fastify end-to-end: podpis nad surovými bajty těla a surovou cestou+query (req.url)', async () => {
  const app = Fastify();
  registerRawJsonParser(app);
  let parsed: unknown = null;
  const handler = async (rq: FastifyRequest, reply: FastifyReply) => {
    if (!inboundAuthorized(rq, reply, V2)) return reply;
    parsed = rq.body;
    return { ok: true };
  };
  app.post('/integrations/:slug/moderation/ban', handler);
  app.get('/integrations/:slug/chat-log', handler);
  _resetInboundNonces();
  const now = Math.floor(Date.now() / 1000);
  // tělo s formátováním a ne-ASCII: přeparsovaný JSON by dal jiné bajty
  const body = '{ "reason" : "sprostý\\u0020text",  "user":"Žluťoučký" }\n';
  const url = '/integrations/rob/moderation/ban?b=%20x&a=1';
  const h = v2('POST', url, body, { nowS: now, nonce: 'e'.repeat(20) });
  const res = await app.inject({ method: 'POST', url, payload: Buffer.from(body, 'utf8'), headers: { ...hdr(h), 'content-type': 'application/json' } });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(parsed, { reason: 'sprostý text', user: 'Žluťoučký' });
  // podpis nad přeparsovaným JSON neprojde
  const h2 = v2('POST', url, JSON.stringify(JSON.parse(body)), { nowS: now, nonce: 'f'.repeat(20) });
  const res2 = await app.inject({ method: 'POST', url, payload: Buffer.from(body, 'utf8'), headers: { ...hdr(h2), 'content-type': 'application/json' } });
  assert.equal(res2.statusCode, 401);
  assert.deepEqual(res2.json(), { ok: false, error: 'bad_signature', detail: 'mismatch' });
  // GET bez těla, query v odeslaném pořadí
  const gurl = '/integrations/rob/chat-log?limit=5&before=2026-01-01T00%3A00%3A00Z';
  const g = await app.inject({ method: 'GET', url: gurl, headers: hdr(v2('GET', gurl, '', { nowS: now, nonce: 'g'.repeat(20) })) });
  assert.equal(g.statusCode, 200, g.body);
  const reordered = await app.inject({ method: 'GET', url: '/integrations/rob/chat-log?before=2026-01-01T00%3A00%3A00Z&limit=5', headers: hdr(v2('GET', gurl, '', { nowS: now, nonce: 'h'.repeat(20) })) });
  assert.equal(reordered.statusCode, 401, 'jiné pořadí query = jiná cesta');
  // replay stejného požadavku
  const again = await app.inject({ method: 'POST', url, payload: Buffer.from(body, 'utf8'), headers: { ...hdr(h), 'content-type': 'application/json' } });
  assert.deepEqual([again.statusCode, again.json()], [401, { ok: false, error: 'replay' }]);
  await app.close();
});
