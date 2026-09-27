import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { redactUrl, reqSerializer } from './logRedact.js';

const TOKEN = 'SECRETtokenABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

test('redactUrl: t, token, access_token, key (i velkými písmeny / zakódované) → ***; ostatní parametry zůstávají', () => {
  assert.equal(redactUrl(`/media/gif/abc?t=${TOKEN}`), '/media/gif/abc?t=***');
  assert.equal(redactUrl(`/x?a=1&token=${TOKEN}&b=2`), '/x?a=1&token=***&b=2');
  assert.equal(redactUrl(`/x?access_token=${TOKEN}&Key=${TOKEN}`), '/x?access_token=***&Key=***');
  assert.equal(redactUrl(`/x?%74=${TOKEN}`), '/x?%74=***');
  assert.equal(redactUrl('/x?channel=robdiesalot&before=1'), '/x?channel=robdiesalot&before=1');
  assert.equal(redactUrl('/bez-query'), '/bez-query');
  assert.equal(redactUrl(undefined), '');
  // Jednorázový ticket /account/stream (audit L2).
  assert.equal(redactUrl(`/account/stream?ticket=${TOKEN}`), '/account/stream?ticket=***');
});

test('reqSerializer ve Fastify loggeru: token se v logu požadavku neobjeví', async () => {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
  const app = Fastify({ logger: { level: 'info', stream, serializers: { req: reqSerializer } } });
  app.get('/media/gif/:id', async () => ({ ok: true }));
  await app.inject({ method: 'GET', url: `/media/gif/abc?t=${TOKEN}` });
  await app.close();
  const all = lines.join('');
  assert.ok(all.includes('/media/gif/abc?t=***'), all);
  assert.ok(!all.includes(TOKEN), 'token v logu');
});
