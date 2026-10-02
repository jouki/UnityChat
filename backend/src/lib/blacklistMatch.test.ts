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
  // Sémantika Židolišty (2026-10-01): mezera ve frázi = 1+ bílých znaků; podřetězec nikdy.
  const t2 = ['negr', 'do prdele'];
  assert.equal(containsBlacklisted('jdi DO  prdele', t2), true, 'fráze přes dvě mezery');
  assert.equal(containsBlacklisted('do	prdele', t2), true, 'tabulátor');
  assert.equal(containsBlacklisted('doprdele', t2), false);
  assert.equal(containsBlacklisted('negramotný', t2), false);
  assert.equal(containsBlacklisted('ty NEGR!', t2), true);
  assert.equal(containsBlacklisted('negr,jo', t2), true);
  assert.equal(containsBlacklisted('xnegrx', t2), false);
});
