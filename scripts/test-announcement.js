// node scripts/test-announcement.js — normalizace payloadu a HTML announcementu (core, bez DOM)
const assert = require('node:assert/strict');

(async () => {
  const { normalizeAnnouncement, announcementHtml, ANNC_DEFAULT_WIDTH } = await import('../extension/core/announcement.js');
  let n = 0;
  const ok = (name) => { n++; console.log('PASS', name); };

  // 1. normalizace: https jen, ořez šířky, text limit, neznámá pole pryč
  const a = normalizeAnnouncement({ id: 'x1', channel: 'RobDiesALot', command: 'Brohemians', text: 'Ahoj <b>', media: { url: 'https://cdn/x.webm', kind: 'video', width: 9999, loop: 1, stillUrl: 'http://insecure/still.webp' }, triggeredBy: { user: 'Jouki728', platform: 'twitch' }, at: '2026-09-22T10:00:00Z', evil: 1 });
  assert.equal(a.channel, 'robdiesalot');
  assert.equal(a.media.width, 480);
  assert.equal(a.media.loop, true);
  assert.equal(a.media.stillUrl, null, 'http still se zahodí');
  assert.equal(a.at, Date.parse('2026-09-22T10:00:00Z'));
  assert.equal('evil' in a, false);
  ok('normalize');

  assert.equal(normalizeAnnouncement({ id: 'x', channel: 'c' }), null, 'bez média i textu = nic');
  assert.equal(normalizeAnnouncement({ id: 'x', channel: 'c', media: { url: 'javascript:alert(1)' } }), null);
  assert.equal(normalizeAnnouncement({ id: 'x', channel: 'c', media: { url: 'https://a/b.webm' } }).media.width, ANNC_DEFAULT_WIDTH);
  ok('normalize odmítá nebezpečné / prázdné');

  // 2. HTML: video s autoplay, bez smyčky, text escapovaný, klik replay title
  const html = announcementHtml(normalizeAnnouncement({ id: 'x2', channel: 'c', command: 'Brohemians', text: 'Ahoj <b>', media: { url: 'https://cdn/x.webm', width: 200, stillUrl: 'https://cdn/still.webp' }, triggeredBy: { user: 'Jouki728' } }), { timeText: '10:00' });
  assert.match(html, /^<div class="msg uc-annc" data-annc-id="x2" data-platform="unitychat" data-ts="\d+">/);
  assert.match(html, /<div class="ua-media" style="width:200px"[^>]*><span class="ua-spot"[^>]*><\/span><video class="ua-video" src="https:\/\/cdn\/x.webm" autoplay preload="auto" muted playsinline poster="https:\/\/cdn\/still.webp" aria-hidden="true"><\/video><\/div>/);
  const rmNoStill = announcementHtml(normalizeAnnouncement({ id: 'x5', channel: 'c', media: { url: 'https://cdn/x.webm', height: 160 } }), { reducedMotion: true });
  assert.match(rmNoStill, /style="width:192px;height:160px"/);
  assert.match(rmNoStill, /<video class="ua-video" src="https:\/\/cdn\/x.webm" preload="metadata" muted playsinline aria-hidden="true">/);
  assert.doesNotMatch(rmNoStill, /autoplay/);
  assert.doesNotMatch(html, / loop/);
  assert.match(html, /<div class="ua-text">Ahoj &lt;b&gt;<\/div>/);
  assert.match(html, /<span class="ua-cmd">Brohemians<\/span><span class="ua-ts">10:00<\/span>/);
  assert.match(html, /<div class="ua-by">spustil <b>Jouki728<\/b><\/div>/);
  ok('html video');

  // 3. reduced motion → still obrázek; image kind → img; textHtml má přednost
  const rm = announcementHtml(normalizeAnnouncement({ id: 'x3', channel: 'c', media: { url: 'https://cdn/x.webm', stillUrl: 'https://cdn/still.webp' }, text: 'x' }), { reducedMotion: true, textHtml: '<i>e</i>' });
  assert.match(rm, /<img class="ua-still" src="https:\/\/cdn\/still.webp" alt="">/);
  assert.doesNotMatch(rm, /<video/);
  assert.match(rm, /<div class="ua-text"><i>e<\/i><\/div>/);
  const im = announcementHtml(normalizeAnnouncement({ id: 'x4', channel: 'c', media: { url: 'https://cdn/x.webp', kind: 'image', loop: true } }));
  assert.match(im, /<img class="ua-img" src="https:\/\/cdn\/x.webp" alt="">/);
  assert.doesNotMatch(im, /ua-text/);
  ok('reduced motion / image / textHtml');

  console.log(`\n${n}/${n} PASS`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
