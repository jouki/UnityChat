import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qrSvg } from './donate.js';

test('qrSvg: SPD řetězec → SVG, prázdný/moc dlouhý → null', async () => {
  const svg = await qrSvg('SPD*1.0*ACC:CZ6508000000192000145399*AM:30.00*CC:CZK*X-VS:1234567890*MSG:RDAL1234567890');
  assert.match(svg!, /^<svg[^>]*viewBox/);
  assert.equal(await qrSvg(''), null);
  assert.equal(await qrSvg('x'.repeat(2001)), null);
});
