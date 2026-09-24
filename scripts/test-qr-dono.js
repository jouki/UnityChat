// node scripts/test-qr-dono.js — čisté funkce QR dona, zadání kódu a ověření e-mailu
const assert = require('node:assert/strict');

(async () => {
  const qd = await import('../extension/core/qr-dono.js');
  const ci = await import('../extension/core/code-input.js');
  const ev = await import('../extension/core/email-verify.js');

  const cfg = { currencies: { CZK: { minAmount: 30 }, EUR: { minAmount: 1.3 } }, rate: { eurToCzk: 23.53559 }, voices: [{ id: 'A', name: 'Robinda', isDefault: true }] };

  // měna: nový tvar currencies, starý jen EUR
  assert.deepEqual(qd.currencyConfig(cfg, 'CZK'), { minAmount: 30 });
  assert.deepEqual(qd.currencyConfig({ enabled: true, minAmount: 1, iban: 'SK' }, 'EUR'), { minAmount: 1, iban: 'SK' });
  assert.equal(qd.currencyConfig({ enabled: true, minAmount: 1 }, 'CZK'), null);

  // částka a přepočet (dolů na Kč jako server: 1,3 € → 30 Kč, ne 31)
  assert.equal(qd.parseAmount('1,5'), 1.5);
  assert.ok(Number.isNaN(qd.parseAmount('')));
  assert.equal(qd.czkPreview(1.3, cfg.rate), 30);
  assert.equal(qd.czkPreview(0, cfg.rate), null);
  assert.equal(qd.formatAmount(12, 'EUR'), '12.00');
  assert.equal(qd.formatAmount(30.4, 'CZK'), '30');

  // validace
  const ok = { amount: '50', message: 'ahoj', voice: 'A', nickname: 'Jouki', email: 'a@b.cz', needEmail: true };
  assert.deepEqual(qd.validateDono(ok, cfg, 'CZK'), []);
  assert.deepEqual(qd.validateDono({ ...ok, amount: '20' }, cfg, 'CZK').map((p) => p.msg), ['Minimum je 30 Kč.']);
  assert.deepEqual(qd.validateDono({ ...ok, amount: '30.5' }, cfg, 'CZK').map((p) => p.field), ['amount'], 'Kč celé');
  assert.deepEqual(qd.validateDono({ ...ok, amount: '1.2' }, cfg, 'EUR').map((p) => p.msg), ['Minimum je 1.3 €.']);
  assert.deepEqual(qd.validateDono({ ...ok, nickname: ' ' }, cfg, 'CZK').map((p) => p.field), ['nickname']);
  assert.deepEqual(qd.validateDono({ ...ok, email: 'nope' }, cfg, 'CZK').map((p) => p.field), ['email']);
  assert.deepEqual(qd.validateDono({ ...ok, email: '', needEmail: false }, cfg, 'CZK'), [], 'ověřený účet e-mail nepotřebuje');
  assert.deepEqual(qd.validateDono({ ...ok, voice: 'X' }, cfg, 'CZK').map((p) => p.field), ['voice']);

  // chyby serveru
  assert.equal(qd.donoErrorText({ error: 'below_minimum', minAmount: 30 }, 'CZK'), 'Minimum je 30 Kč.');
  assert.equal(qd.donoErrorText({ error: 'invalid_test_token' }, 'EUR'), 'Neplatný testovací token.');

  // tajné gesto „testmode“
  const det = qd.makeTestmodeDetector();
  const typed = [...'xxtestmod'].map(det);
  assert.ok(typed.every((x) => !x));
  assert.equal(det('e'), true);
  assert.equal(det('Shift'), false, 'nečíselné klávesy ignorovat');
  const det2 = qd.makeTestmodeDetector();
  assert.equal([...'TESTMODE'].map(det2).pop(), true, 'bez ohledu na velikost písmen');

  // předvyplnění přezdívky: UC přezdívka → poslední z dona → jméno z platformy
  assert.equal(qd.prefillNickname({ ucNickname: 'Jouki', lastNickname: 'J' }, 'jouki728'), 'Jouki');
  assert.equal(qd.prefillNickname({ ucNickname: null, lastNickname: 'Posledni' }, 'jouki728'), 'Posledni');
  assert.equal(qd.prefillNickname(null, 'Jouki728'), 'Jouki728');

  // kód: číslice z vloženého textu
  assert.equal(ci.digitsOf('Kód: 123 456'), '123456');
  assert.equal(ci.digitsOf('12345678'), '123456');

  // hlášky ověření (množné číslo pokusů)
  assert.equal(ev.emailErrorText({ error: 'bad_code', left: 1 }), 'Kód nesedí, zbývá 1 pokus.');
  assert.equal(ev.emailErrorText({ error: 'bad_code', left: 3 }), 'Kód nesedí, zbývá 3 pokusy.');
  assert.equal(ev.emailErrorText({ error: 'bad_code', left: 0 }), 'Kód nesedí.');
  assert.equal(ev.cannotSend({ error: 'mail_budget' }), true);
  assert.equal(ev.cannotSend({ error: 'cooldown' }), false, 'cooldown = kód už je poslaný, čekat');

  console.log('test-qr-dono: OK');
})().catch((e) => { console.error(e); process.exit(1); });
