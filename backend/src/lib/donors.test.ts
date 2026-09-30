import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDonors, refreshDonors, isDonor, _resetDonorsForTest } from './donors.js';
import { _setWorkspacesForTest } from './zidolista.js';

test('parseDonors: jen známé platformy s id', () => {
  const s = parseDonors({ ok: true, donors: [{ platform: 'twitch', userId: '1' }, { platform: 'Kick', userId: ' 2 ' }, { platform: 'x', userId: '3' }, { platform: 'youtube', userId: '' }] });
  assert.deepEqual([...s].sort(), ['kick:2', 'twitch:1']);
  assert.equal(parseDonors(null).size, 0);
});

test('refreshDonors + isDonor: cache per workspace, 404 = prázdno bez chyby, výpadek nechá poslední stav', async () => {
  _resetDonorsForTest();
  _setWorkspacesForTest([{ slug: 'rob', channels: { twitch: 'robdiesalot', kick: 'robdiesalot', youtube: null }, bot: { mode: 'shared', displayName: 'JoukiBOT' } }]);
  let status = 200; let body: unknown = { ok: true, donors: [{ platform: 'twitch', userId: '30645675' }] };
  const fetch = (async () => ({ ok: status < 400, status, type: 'basic', json: async () => body })) as unknown as typeof globalThis.fetch;
  const deps = { fetch, apiKey: 'k', base: 'https://z.test', signingKey: 'ab'.repeat(32), log: { warn: () => {} } };
  assert.equal(await refreshDonors('rob', deps), true);
  assert.equal(isDonor('twitch', 'robdiesalot', '30645675'), true);
  assert.equal(isDonor('twitch', 'robdiesalot', '999'), false);
  assert.equal(isDonor('kick', 'robdiesalot', '30645675'), false, 'jiná platforma = jiné id');
  assert.equal(isDonor('twitch', 'jinykanal', '30645675'), false, 'kanál mimo registr');
  status = 500;
  assert.equal(await refreshDonors('rob', deps), false);
  assert.equal(isDonor('twitch', 'robdiesalot', '30645675'), true, 'výpadek → poslední stav');
  status = 404;
  assert.equal(await refreshDonors('rob', deps), false);
  assert.equal(isDonor('twitch', 'robdiesalot', '30645675'), true, '404 (endpoint ještě není) nechá stav');
});
