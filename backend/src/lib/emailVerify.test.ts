import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newCode, codeHash, nextAllowedAt, cleanCode, EMAIL_RE, normEmail } from './emailVerify.js';
import { verificationMail, sendMail } from './mailer.js';

test('kód: 6 číslic, hash vázaný na účet i adresu', () => {
  for (let i = 0; i < 50; i++) assert.match(newCode(), /^\d{6}$/);
  assert.notEqual(codeHash('123456', 1, 'a@b.cz'), codeHash('123456', 2, 'a@b.cz'));
  assert.notEqual(codeHash('123456', 1, 'a@b.cz'), codeHash('123456', 1, 'c@b.cz'));
  assert.equal(codeHash('123456', 1, ' A@B.cz '), codeHash('123456', 1, 'a@b.cz'));
});

test('cooldown „poslat znovu“: 2 → 5 → 15 → 15 min', () => {
  const t = 1_000_000;
  assert.equal(nextAllowedAt(0, t), 0);
  assert.equal(nextAllowedAt(1, t), t + 120_000);
  assert.equal(nextAllowedAt(2, t), t + 300_000);
  assert.equal(nextAllowedAt(3, t), t + 900_000);
  assert.equal(nextAllowedAt(9, t), t + 900_000);
});

test('cleanCode + e-mail', () => {
  assert.equal(cleanCode(' 123 456 '), '123456');
  assert.equal(cleanCode('12345'), null);
  assert.equal(cleanCode('12345a'), null);
  assert.ok(EMAIL_RE.test('jouki@seznam.cz'));
  assert.ok(!EMAIL_RE.test('jouki@seznam'));
  assert.equal(normEmail(' Jouki@Seznam.CZ '), 'jouki@seznam.cz');
});

test('mailer: předmět s kódem, text i HTML; bez služeb = no_provider', async () => {
  const m = verificationMail('a@b.cz', '042917');
  assert.equal(m.subject, 'Tvůj ověřovací kód: 042917');
  assert.match(m.text, /042917/);
  assert.match(m.html, /042917/);
  assert.doesNotMatch(m.html, /<img|href=/i, 'bez obrázků a odkazů');
  assert.deepEqual(await sendMail(m, undefined, []), { ok: false, error: 'no_provider' });
});
