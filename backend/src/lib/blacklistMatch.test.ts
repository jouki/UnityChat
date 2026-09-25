import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containsBlacklisted } from './blacklistMatch.js';

test('containsBlacklisted: celé slovo / fráze bez ohledu na velikost, ne podřetězec (stejně jako core/censor.js)', () => {
  const terms = ['qr', 'zlé slovo'];
  assert.equal(containsBlacklisted('Pan QR', terms), true);
  assert.equal(containsBlacklisted('QR!', terms), true);
  assert.equal(containsBlacklisted('runeqrove', terms), false);
  assert.equal(containsBlacklisted('Tohle je ZLÉ SLOVO', terms), true);
  assert.equal(containsBlacklisted('zle slovo', terms), false, 'diakritika přesně podle položky');
  assert.equal(containsBlacklisted('cokoli', []), false);
});
