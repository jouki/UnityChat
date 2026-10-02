import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDonors, parseDonorAmounts, refreshDonors, isDonor, donorAmount, donorNameKey, _resetDonorsForTest } from './donors.js';
import { _setWorkspacesForTest } from './zidolista.js';
import { _setReplaceForTest, authorReplacesGlobal } from './badgePrefs.js';
import { donorFields } from '../routes/chat.js';

test('parseDonors: jen známé platformy s id', () => {
  const s = parseDonors({ ok: true, donors: [{ platform: 'twitch', userId: '1' }, { platform: 'Kick', userId: ' 2 ' }, { platform: 'x', userId: '3' }, { platform: 'youtube', userId: '' }] });
  assert.deepEqual([...s].sort(), ['kick:2', 'twitch:1']);
  assert.equal(parseDonors(null).size, 0);
  const am = parseDonorAmounts({ donors: [{ platform: 'twitch', userId: '1', amountCzk: 1130.4, nickname: 'Brix' }, { platform: 'twitch', userId: '2' }, { platform: 'twitch', userId: '1', amountCzk: 50 }, { platform: null, userId: null, nickname: 'Spaja X', amountCzk: 199 }] });
  assert.deepEqual([...am], [['twitch:1', 1130], ['nick:brix', 1130], ['twitch:2', 0], ['nick:spajax', 199]], 'částka zaokrouhlená, bez částky 0, duplicitní klíč = větší, přezdívka jako nick:<zjednodušené jméno>');
});

test('refreshDonors + isDonor: cache per workspace, 404 = prázdno bez chyby, výpadek nechá poslední stav', async () => {
  _resetDonorsForTest();
  _setWorkspacesForTest([{ slug: 'rob', channels: { twitch: 'robdiesalot', kick: 'robdiesalot', youtube: null }, bot: { mode: 'shared', displayName: 'JoukiBOT' } }]);
  let status = 200; let body: unknown = { ok: true, donors: [{ platform: 'twitch', userId: '30645675', amountCzk: 1130 }, { platform: null, userId: null, nickname: 'SpajaX', amountCzk: 199 }, { platform: null, userId: null, nickname: 'W1nter Ian', amountCzk: 476 }] };
  const fetch = (async () => ({ ok: status < 400, status, type: 'basic', json: async () => body })) as unknown as typeof globalThis.fetch;
  const deps = { fetch, apiKey: 'k', base: 'https://z.test', signingKey: 'ab'.repeat(32), log: { warn: () => {} } };
  assert.equal(await refreshDonors('rob', deps), true);
  assert.equal(isDonor('twitch', 'robdiesalot', '30645675'), true);
  assert.equal(isDonor('twitch', 'robdiesalot', '999'), false);
  assert.equal(donorAmount('twitch', 'robdiesalot', '30645675'), 1130);
  assert.equal(donorAmount('twitch', 'robdiesalot', '999'), null);
  // Dárce bez identity (donate z webu) → podle jména autora (bez ohledu na velikost písmen / mezery), na každé platformě.
  assert.equal(isDonor('twitch', 'robdiesalot', '550788633', 'spajax'), true);
  assert.equal(isDonor('kick', 'robdiesalot', 'k9', 'Spaja_X'), true);
  assert.equal(donorAmount('twitch', 'robdiesalot', '550788633', 'SpajaX'), 199);
  assert.equal(isDonor('twitch', 'robdiesalot', 'u9', 'Winter_Ian'), true, 'W1nter Ian ↔ Winter_Ian');
  assert.equal(donorAmount('twitch', 'robdiesalot', 'u9', 'Winter_Ian'), 476);
  assert.equal(isDonor('twitch', 'robdiesalot', '777', 'nekdojiny'), false);
  // Leetspeak v přezdívce donatu (živě 2026-10-01: „W1nter Ian“ v HoF vs. „Winter_Ian“ na YouTube).
  assert.equal(donorNameKey('W1nter Ian'), 'winterian');
  assert.equal(donorNameKey('Winter_Ian'), 'winterian');
  assert.equal(donorNameKey('T0nner'), 'tonner');
  // Volba účtu „místo globálního odznaku Twitche“ (lib/badgePrefs.ts) → donorReplace jen u Twitche a jen dárci.
  _setReplaceForTest([['twitch', '30645675', 42], ['twitch', '777', 43]]);
  assert.equal(authorReplacesGlobal('twitch', '30645675'), true);
  assert.equal(authorReplacesGlobal('kick', '30645675'), false);
  assert.deepEqual(donorFields('twitch', 'robdiesalot', '30645675', 'jouki728'), { donor: true, donorCzk: 1130, donorReplace: true });
  assert.deepEqual(donorFields('twitch', 'robdiesalot', '550788633', 'spajax'), { donor: true, donorCzk: 199 });
  assert.deepEqual(donorFields('twitch', 'robdiesalot', '777', 'nekdojiny'), {}, 'volba bez donatu odznak nedá');
  _setReplaceForTest([]);
  assert.equal(isDonor('kick', 'robdiesalot', '30645675'), false, 'jiná platforma = jiné id');
  assert.equal(isDonor('twitch', 'jinykanal', '30645675'), false, 'kanál mimo registr');
  status = 500;
  assert.equal(await refreshDonors('rob', deps), false);
  assert.equal(isDonor('twitch', 'robdiesalot', '30645675'), true, 'výpadek → poslední stav');
  status = 404;
  assert.equal(await refreshDonors('rob', deps), false);
  assert.equal(isDonor('twitch', 'robdiesalot', '30645675'), true, '404 (endpoint ještě není) nechá stav');
});
