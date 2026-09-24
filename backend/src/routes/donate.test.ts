import { test } from 'node:test';
import assert from 'node:assert/strict';
import { donorNickname, qrSvg } from './donate.js';

test('donorNickname: display name platformy, jinak login, max 40 znaků', () => {
  assert.equal(donorNickname({ displayName: ' Jouki728 ', login: 'jouki728' }), 'Jouki728');
  assert.equal(donorNickname({ displayName: null, login: 'jouki728' }), 'jouki728');
  assert.equal(donorNickname({ displayName: 'x'.repeat(60), login: 'a' }).length, 40);
});

test('qrSvg: SPD řetězec → SVG, prázdný/moc dlouhý → null', async () => {
  const svg = await qrSvg('SPD*1.0*ACC:CZ6508000000192000145399*AM:30.00*CC:CZK*X-VS:1234567890*MSG:RDAL1234567890');
  assert.match(svg!, /^<svg[^>]*viewBox/);
  assert.equal(await qrSvg(''), null);
  assert.equal(await qrSvg('x'.repeat(2001)), null);
});
