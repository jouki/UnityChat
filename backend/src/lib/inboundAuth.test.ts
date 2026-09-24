import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { verifySignature, checkInbound } from './inboundAuth.js';

const KEY = 'k'.repeat(40);
const sign = (t: number, body: string, key = KEY) => `t=${t},v1=${createHmac('sha256', key).update(`${t}.${body}`).digest('hex')}`;
const NOW = 1_790_000_000;

test('verifySignature: platný, prošlý, podvržený, chybějící', () => {
  const body = '{"workspace":"rob","reason":"sfx-played"}';
  assert.equal(verifySignature(sign(NOW, body), body, KEY, NOW), 'ok');
  assert.equal(verifySignature(sign(NOW - 301, body), body, KEY, NOW), 'expired', 'replay po 5 min neprojde');
  assert.equal(verifySignature(sign(NOW, body), body + ' ', KEY, NOW), 'mismatch', 'změněné tělo');
  assert.equal(verifySignature(sign(NOW, body, 'jiny-klic'), body, KEY, NOW), 'mismatch', 'jiný klíč');
  assert.equal(verifySignature('', body, KEY, NOW), 'missing');
  assert.equal(verifySignature('t=abc,v1=zz', body, KEY, NOW), 'bad_format');
  assert.equal(verifySignature(sign(NOW, ''), '', KEY, NOW), 'ok', 'GET = prázdné tělo');
});

const req = (headers: Record<string, string>, rawBody = '') => ({ headers, rawBody } as unknown as FastifyRequest);
const env = (o: Partial<{ ZIDOLISTA_API_KEY: string; ZIDOLISTA_INBOUND_KEY: string; ZIDOLISTA_INBOUND_STRICT: string }>) =>
  ({ ZIDOLISTA_API_KEY: 'legacy', ZIDOLISTA_INBOUND_KEY: '', ZIDOLISTA_INBOUND_STRICT: '', ...o }) as never;

test('checkInbound: přechod pustí starý klíč, strict jen nový klíč + podpis', () => {
  const body = '{"a":1}';
  const t = Math.floor(Date.now() / 1000);
  // dnešní stav: jen společný klíč
  assert.equal(checkInbound(req({ 'x-api-key': 'legacy' }), env({})).ok, true);
  assert.equal(checkInbound(req({ 'x-api-key': 'spatny' }), env({})).ok, false);
  // přechod: nový klíč nastavený, starý pořád projde, podpis se jen hlásí
  const tr = env({ ZIDOLISTA_INBOUND_KEY: KEY });
  assert.deepEqual(checkInbound(req({ 'x-api-key': 'legacy' }, body), tr), { ok: true, legacyKey: true, signature: 'missing' });
  assert.equal(checkInbound(req({ 'x-api-key': KEY, 'x-uc-signature': sign(t, body) }, body), tr).signature, 'ok');
  // strict: starý klíč ne, bez podpisu ne, s podpisem ano
  const st = env({ ZIDOLISTA_INBOUND_KEY: KEY, ZIDOLISTA_INBOUND_STRICT: '1' });
  assert.equal(checkInbound(req({ 'x-api-key': 'legacy', 'x-uc-signature': sign(t, body) }, body), st).ok, false);
  assert.equal(checkInbound(req({ 'x-api-key': KEY }, body), st).ok, false);
  assert.equal(checkInbound(req({ 'x-api-key': KEY, 'x-uc-signature': sign(t, body) }, body), st).ok, true);
  assert.equal(checkInbound(req({ 'x-api-key': KEY, 'x-uc-signature': sign(t, '{"a":2}') }, body), st).ok, false, 'podvržené tělo');
});
