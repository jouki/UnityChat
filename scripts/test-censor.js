// node scripts/test-censor.js — cenzura podle blacklistu (core/censor.js): přesné slovo, bez ohledu na velikost
const assert = require('node:assert/strict');

(async () => {
  const { compileBlacklist, censorText } = await import('../extension/core/censor.js');
  const bl = compileBlacklist(['kokot', 'Debil', 'heil hitler', 'negr', '  ', 'blbeček', 'kokot']);
  const t = (s) => censorText(s, bl);
  assert.equal(bl.size, 5, 'prázdné a duplicitní položky pryč');
  assert.equal(t('ty kokot!'), 'ty *****!', 'celé slovo, interpunkce zůstane');
  assert.equal(t('KOKOT'), '*****', 'velikost písmen');
  assert.equal(t('KOKOTE'), 'KOKOTE', 'jiný tvar (není v seznamu) projde');
  assert.equal(t('runegrove'), 'runegrove', 'uvnitř jiného slova ne');
  assert.equal(t('negr.'), '****.', 'slovo před interpunkcí');
  assert.equal(t('dEbIl'), '*****');
  assert.equal(t('blbeček'), '*******', 'položka s diakritikou');
  assert.equal(t('blbecek'), 'blbecek', 'diakritika přesně podle položky');
  assert.equal(t('Heil hitler!'), '**** ******!', 'fráze');
  assert.equal(t('heil hitlerovi'), 'heil hitlerovi', 'fráze jen celá');
  const s = 'ahoj všem';
  assert.equal(t(s), s, 'beze změny = tentýž řetězec');
  assert.equal(censorText('kokot', compileBlacklist([])), 'kokot', 'prázdný seznam');
  assert.equal(censorText('kokot', null), 'kokot');
  assert.equal(t('kokot 😀 kokot'), '***** 😀 *****', 'délka zachovaná i s emoji');
  console.log('censor: PASS');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
