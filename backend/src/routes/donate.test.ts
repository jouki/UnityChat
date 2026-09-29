import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qrSvg, modTestFields } from './donate.js';

test('modTestFields: jen mod / streamer kanálu; role identity, kterou píše, má přednost', () => {
  assert.equal(modTestFields([], 'twitch'), null, 'účet bez role moda → nic');
  assert.deepEqual(modTestFields([{ platform: 'twitch', login: 'jouki728', role: 'moderator' }], 'twitch'), { ucModTest: true, ucModRole: 'moderator' });
  assert.deepEqual(modTestFields([{ platform: 'twitch', login: 'a', role: 'moderator' }, { platform: 'kick', login: 'a', role: 'broadcaster' }], 'kick'), { ucModTest: true, ucModRole: 'broadcaster' });
  assert.deepEqual(modTestFields([{ platform: 'twitch', login: 'a', role: 'moderator' }, { platform: 'kick', login: 'a', role: 'broadcaster' }], 'youtube'), { ucModTest: true, ucModRole: 'broadcaster' }, 'jiná platforma → nejvyšší role účtu');
});

test('qrSvg: SPD řetězec → SVG, prázdný/moc dlouhý → null', async () => {
  const svg = await qrSvg('SPD*1.0*ACC:CZ6508000000192000145399*AM:30.00*CC:CZK*X-VS:1234567890*MSG:RDAL1234567890');
  assert.match(svg!, /^<svg[^>]*viewBox/);
  assert.equal(await qrSvg(''), null);
  assert.equal(await qrSvg('x'.repeat(2001)), null);
});
