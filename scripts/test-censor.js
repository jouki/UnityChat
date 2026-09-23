// node scripts/test-censor.js — cenzura podle blacklistu (core/censor.js), sémantika jako QR Dono
const assert = require('node:assert/strict');

(async () => {
  const { compileBlacklist, censorText } = await import('../extension/core/censor.js');
  const bl = compileBlacklist(['kokot', 'Debil', 'heil hitler', 'negr', '  ', 'blbeč', 'kokot']);
  const t = (s) => censorText(s, bl);
  assert.equal(bl.size, 5, 'prázdné a duplicitní položky pryč');
  assert.equal(t('ty kokot!'), 'ty *****!', 'celé slovo, interpunkce zůstane');
  assert.equal(t('KOKOTE'), '******', 'velikost písmen + kmen chytí tvar');
  assert.equal(t('ty debile'), 'ty ******', 'kmen „debil" chytí „debile"');
  assert.equal(t('negríkovi'), '*********', 'kmen „negr" je podřetězcem → celé slovo');
  assert.equal(t('negrovi taky'), '******* taky', 'celé slovo s nálezem');
  assert.equal(t('blbeček'), '*******', 'položka s diakritikou');
  assert.equal(t('blbecek'), 'blbecek', 'bez diakritiky položku s diakritikou nechytí (jako QR Dono)');
  assert.equal(t('Heil hitler'), '**** ******', 'fráze');
  assert.equal(t('heil  hitler'), 'heil  hitler', 'fráze jen s jednou mezerou (Contains)');
  assert.equal(t('xkokotx jo'), '******* jo', 'podřetězec uvnitř slova → celé slovo');
  const s = 'ahoj všem';
  assert.equal(t(s), s, 'beze změny = tentýž řetězec');
  assert.equal(censorText('kokot', compileBlacklist([])), 'kokot', 'prázdný seznam');
  assert.equal(censorText('kokot', null), 'kokot');
  assert.equal(t('kokot 😀 kokot'), '***** 😀 *****', 'délka zachovaná i s emoji');
  console.log('censor: PASS');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
