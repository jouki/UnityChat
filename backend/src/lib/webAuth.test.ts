import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashToken, issueCode, consumeCode, needsRefresh, isAllowedReturnTo, bearerToken, CODE_TTL_MS } from './webAuth.js';
import type { FastifyRequest } from 'fastify';

test('hashToken je SHA-256 hex, deterministický', () => {
  assert.equal(hashToken('a'), 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
  assert.equal(hashToken('a'), hashToken('a'));
});

test('jednorázový kód: jednou, do 60 s', () => {
  const code = issueCode('session-raw', 1000);
  assert.equal(consumeCode(code, 1000 + CODE_TTL_MS), 'session-raw');
  assert.equal(consumeCode(code, 1000), null, 'druhé použití selže');
  const late = issueCode('s2', 1000);
  assert.equal(consumeCode(late, 1000 + CODE_TTL_MS + 1), null, 'po expiraci selže');
  assert.equal(consumeCode('nonsense'), null);
});

test('needsRefresh: bez expirace / do minuty = true', () => {
  const now = 1_000_000_000_000;
  assert.equal(needsRefresh(null, now), true);
  assert.equal(needsRefresh(new Date(now + 30_000), now), true);
  assert.equal(needsRefresh(new Date(now + 120_000), now), false);
});

test('isAllowedReturnTo: jen originy z WEB_ORIGINS, bez credentials v URL', () => {
  assert.equal(isAllowedReturnTo('https://robdiesalot.com/chat/'), true);
  assert.equal(isAllowedReturnTo('http://localhost:5173/chat/?debug=1'), true);
  assert.equal(isAllowedReturnTo('https://evil.example/chat/'), false);
  assert.equal(isAllowedReturnTo('https://user:pw@robdiesalot.com/'), false);
  assert.equal(isAllowedReturnTo('not a url'), false);
});

test('bearerToken: jen 64 hex', () => {
  const tok = 'ab'.repeat(32);
  const req = (h?: string) => ({ headers: { authorization: h } }) as unknown as FastifyRequest;
  assert.equal(bearerToken(req(`Bearer ${tok.toUpperCase()}`)), tok);
  assert.equal(bearerToken(req('Bearer short')), null);
  assert.equal(bearerToken(req()), null);
});
