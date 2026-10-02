import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import integrationUnlockRoutes, { parseUnlockUrl, UNLOCK_MAX_BYTES } from './integrationUnlock.js';
import type { Unlocker } from '../lib/gifUnlocker.js';

function fakeUnlocker(resp: { status: number; type?: string; body: Buffer } | Error | null) {
  const calls: string[] = [];
  const u = {
    timeoutMs: 1000,
    calls,
    async fetch(url: URL) {
      calls.push(url.toString());
      if (resp instanceof Error) throw resp;
      if (!resp) return null;
      return { status: resp.status, headers: { 'content-type': resp.type }, body: (async function* () { yield resp.body; })(), dispose() {} };
    },
  };
  return u as unknown as Unlocker & { calls: string[] };
}

async function app(unlocker: Unlocker | null) {
  const a = Fastify();
  // Ověření jako integrační klíč: 'spatny' = odmítnuto (401), jinak pustit.
  const auth = (req: { headers: Record<string, unknown> }, reply: { code(n: number): { send(b: unknown): unknown } }) => { if (req.headers['x-api-key'] === 'spatny') { reply.code(401).send({ ok: false, error: 'unauthorized' }); return false; } return true; };
  await a.register((inst) => integrationUnlockRoutes(inst, { unlocker, auth: auth as never }));
  return a;
}

test('unlock-fetch: jen http(s) bez přihlašovacích údajů', () => {
  assert.ok(parseUnlockUrl('https://www.myinstants.com/media/sounds/eh-co.mp3'));
  assert.equal(parseUnlockUrl('file:///etc/passwd'), null);
  assert.equal(parseUnlockUrl('https://user:pw@x.cz/a.mp3'), null);
  assert.equal(parseUnlockUrl('nesmysl'), null);
});

test('unlock-fetch: stáhne přes unlocker a vrátí tělo s typem; chyby cíle, unlockeru, bez klíče, velikost, špatný klíč', async () => {
  const mp3 = Buffer.from('ID3' + 'x'.repeat(100));
  const u = fakeUnlocker({ status: 200, type: 'audio/mpeg', body: mp3 });
  const a = await app(u);
  const ok = await a.inject({ method: 'POST', url: '/integrations/unlock-fetch', payload: { url: 'https://www.myinstants.com/media/sounds/eh-co.mp3' } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['content-type'], 'audio/mpeg');
  assert.equal(ok.headers['x-unlock-status'], '200');
  assert.deepEqual(ok.rawPayload, mp3);
  assert.deepEqual(u.calls, ['https://www.myinstants.com/media/sounds/eh-co.mp3']);

  assert.equal((await a.inject({ method: 'POST', url: '/integrations/unlock-fetch', payload: { url: 'ftp://x.cz/a.mp3' } })).json().error, 'bad_url');
  assert.equal((await a.inject({ method: 'POST', url: '/integrations/unlock-fetch', payload: { url: 'https://x.cz/a.mp3', extra: 1 } })).statusCode, 400);
  assert.equal((await a.inject({ method: 'POST', url: '/integrations/unlock-fetch', payload: { url: 'https://x.cz/a.mp3' }, headers: { 'x-api-key': 'spatny' } })).statusCode, 401);

  assert.equal((await (await app(fakeUnlocker({ status: 404, body: Buffer.from('nic') }))).inject({ method: 'POST', url: '/integrations/unlock-fetch', payload: { url: 'https://x.cz/a.mp3' } })).json().error, 'upstream_404');
  assert.equal((await (await app(fakeUnlocker(new Error('unlocker_timeout')))).inject({ method: 'POST', url: '/integrations/unlock-fetch', payload: { url: 'https://x.cz/a.mp3' } })).json().error, 'unlocker_timeout');
  assert.equal((await (await app(fakeUnlocker(null))).inject({ method: 'POST', url: '/integrations/unlock-fetch', payload: { url: 'https://x.cz/a.mp3' } })).json().error, 'unavailable', 'denní strop / negativní cache');
  assert.equal((await (await app(null)).inject({ method: 'POST', url: '/integrations/unlock-fetch', payload: { url: 'https://x.cz/a.mp3' } })).statusCode, 503, 'bez klíče');
  const big = await (await app(fakeUnlocker({ status: 200, type: 'audio/mpeg', body: Buffer.alloc(UNLOCK_MAX_BYTES + 1) }))).inject({ method: 'POST', url: '/integrations/unlock-fetch', payload: { url: 'https://x.cz/a.mp3' } });
  assert.equal(big.statusCode, 413);
});
