// /webhook/deploy (audit I5): podpis povinný, nad raw tělem, bez secretu route neexistuje.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import devDownloadRoutes, { verifyGithubSignature } from './dev-download.js';

const SECRET = 'test-secret';
const sign = (body: string, secret = SECRET) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

async function app(secret: string): Promise<FastifyInstance> {
  const a = Fastify();
  const defaultJson = a.getDefaultJsonParser('error', 'error');
  a.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = typeof body === 'string' ? body : body.toString('utf8');
    defaultJson(req, req.rawBody, done);
  });
  await a.register(devDownloadRoutes, { webhookSecret: secret });
  return a;
}

test('verifyGithubSignature: jen platný sha256 podpis nad raw tělem', () => {
  const body = '{"ref": "refs/heads/dev"}';
  assert.equal(verifyGithubSignature(sign(body), body, SECRET), true);
  assert.equal(verifyGithubSignature(sign(body), JSON.stringify(JSON.parse(body)), SECRET), false, 'přeformátované tělo');
  assert.equal(verifyGithubSignature(sign(body, 'jiny'), body, SECRET), false);
  assert.equal(verifyGithubSignature(undefined, body, SECRET), false, 'bez hlavičky');
  assert.equal(verifyGithubSignature('sha256=zz', body, SECRET), false);
  assert.equal(verifyGithubSignature(sign(body), undefined, SECRET), false, 'bez raw těla');
  assert.equal(verifyGithubSignature(sign(body, ''), body, ''), false, 'bez secretu');
});

test('/webhook/deploy: bez secretu se neregistruje (404)', async () => {
  const a = await app('');
  const r = await a.inject({ method: 'POST', url: '/webhook/deploy', payload: { ref: 'refs/heads/dev' } });
  assert.equal(r.statusCode, 404);
  await a.close();
});

test('/webhook/deploy: bez podpisu / špatný podpis → 403, platný → projde', async () => {
  const a = await app(SECRET);
  // ref master → route skončí „skipped" dřív, než by spustila git pull.
  const body = '{"ref":"refs/heads/master"}';
  const headers = { 'content-type': 'application/json' };
  const none = await a.inject({ method: 'POST', url: '/webhook/deploy', payload: body, headers });
  assert.equal(none.statusCode, 403);
  const bad = await a.inject({ method: 'POST', url: '/webhook/deploy', payload: body, headers: { ...headers, 'x-hub-signature-256': sign(body, 'jiny') } });
  assert.equal(bad.statusCode, 403);
  const ok = await a.inject({ method: 'POST', url: '/webhook/deploy', payload: body, headers: { ...headers, 'x-hub-signature-256': sign(body) } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().skipped, true);
  await a.close();
});
