// Test core/update-notice.js: rozpoznání nové verze webu z index.html + rozsvícení tlačítka obnovení.
// Spuštění: node scripts/test-update-notice.js
const assert = require('node:assert/strict');

(async () => {
  const m = await import('../extension/core/update-notice.js');
  const html = (hash) => `<!doctype html><script type="module" crossorigin src="/chat/assets/fonts-D4RVXXoG.js"></script>
<script type="module" crossorigin src="/chat/assets/main-${hash}.js"></script>`;

  assert.equal(m.mainBundleOf(html('DQKMLP9l')), '/chat/assets/main-DQKMLP9l.js');
  assert.equal(m.mainBundleOf('<html>bez skriptu</html>'), null);
  assert.equal(m.isNewWebVersion('/chat/assets/main-AAA.js', html('AAA')), false, 'stejný bundle');
  assert.equal(m.isNewWebVersion('/chat/assets/main-AAA.js', html('BBB')), true, 'jiný bundle = nová verze');
  assert.equal(m.isNewWebVersion('https://robdiesalot.com/chat/assets/main-AAA.js', html('AAA')), false, 'absolutní src');
  assert.equal(m.isNewWebVersion('/chat/assets/main-AAA.js', ''), false, 'nepřečtené HTML nesvítí');
  assert.equal(m.isNewWebVersion(null, html('BBB')), false, 'neznámý běžící bundle nesvítí');

  // Tlačítko (bez DOM: minimální náhrada)
  const attrs = new Map([['title', 'Znovu načíst chat']]);
  const cls = new Set();
  const btn = {
    dataset: {},
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    setAttribute: (k, v) => attrs.set(k, String(v)),
    removeAttribute: (k) => attrs.delete(k),
  };
  assert.equal(m.markUpdateReady(btn, 'addon'), true);
  assert.ok(cls.has(m.UPDATE_READY_CLASS));
  assert.equal(attrs.get('title'), 'Nová verze UnityChatu. Aktualizuj addon!');
  assert.equal(m.markUpdateReady(btn, 'addon'), false, 'podruhé už svítí');
  m.clearUpdateReady(btn);
  assert.ok(!cls.has(m.UPDATE_READY_CLASS));
  assert.equal(attrs.get('title'), 'Znovu načíst chat', 'původní title zpět');
  assert.equal(attrs.has('aria-label'), false);
  m.markUpdateReady(btn, 'web');
  assert.equal(attrs.get('title'), 'Nová verze UnityChatu. Aktualizuj web!');
  console.log('test-update-notice: OK');
})().catch((e) => { console.error(e); process.exit(1); });
