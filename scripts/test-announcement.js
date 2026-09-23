// node scripts/test-announcement.js — normalizace payloadu a HTML announcementu (core, bez DOM)
const assert = require('node:assert/strict');

(async () => {
  const { normalizeAnnouncement, announcementHtml, sanitizeAnnouncementHtml, richTextToHtml, ANNC_DEFAULT_WIDTH } = await import('../extension/core/announcement.js');
  const { ytRunFullText } = await import('../extension/core/emotes.js');
  let n = 0;
  const ok = (name) => { n++; console.log('PASS', name); };

  // 1. normalizace: https jen, ořez šířky, text limit, neznámá pole pryč
  const a = normalizeAnnouncement({ id: 'x1', channel: 'RobDiesALot', command: 'Brohemians', text: 'Ahoj <b>', media: { url: 'https://cdn/x.webm', kind: 'video', width: 9999, loop: 1, stillUrl: 'http://insecure/still.webp' }, triggeredBy: { user: 'Jouki728', platform: 'twitch' }, at: '2026-09-22T10:00:00Z', evil: 1 });
  assert.equal(a.channel, 'robdiesalot');
  assert.equal(a.media.width, 480);
  assert.equal(a.media.loop, true);
  assert.equal(normalizeAnnouncement({ id: 'x', channel: 'c', media: { url: 'https://a/b.webm', loop: false } }).media.loop, false, 'loop false = jedno přehrání');
  assert.equal(normalizeAnnouncement({ id: 'x', channel: 'c', media: { url: 'https://a/b.webm' } }).media.loop, true, 'bez loop = smyčka');
  assert.equal(a.media.stillUrl, null, 'http still se zahodí');
  assert.equal(a.at, Date.parse('2026-09-22T10:00:00Z'));
  assert.equal('evil' in a, false);
  ok('normalize');

  assert.equal(normalizeAnnouncement({ id: 'x', channel: 'c' }), null, 'bez média i textu = nic');
  assert.equal(normalizeAnnouncement({ id: 'x', channel: 'c', media: { url: 'javascript:alert(1)' } }), null);
  assert.equal(normalizeAnnouncement({ id: 'x', channel: 'c', media: { url: 'https://a/b.webm' } }).media.width, ANNC_DEFAULT_WIDTH);
  ok('normalize odmítá nebezpečné / prázdné');

  // 2. HTML: video s autoplay, bez smyčky, text escapovaný, klik replay title
  const html = announcementHtml(normalizeAnnouncement({ id: 'x2', channel: 'c', command: 'Brohemians', text: 'Ahoj <b>', media: { url: 'https://cdn/x.webm', width: 200, loop: false, stillUrl: 'https://cdn/still.webp' }, triggeredBy: { user: 'Jouki728' } }), { timeText: '10:00' });
  assert.match(html, /^<div class="msg uc-annc" data-annc-id="x2" data-platform="unitychat" data-ts="\d+">/);
  assert.match(html, /<div class="ua-media" style="--ua-w:200px"[^>]*><span class="ua-spot"[^>]*><\/span><video class="ua-video" src="https:\/\/cdn\/x.webm" autoplay preload="auto" muted playsinline poster="https:\/\/cdn\/still.webp" aria-hidden="true"><\/video><\/div>/);
  assert.doesNotMatch(html, / loop/, 'loop:false = bez smyčky');
  const rmNoStill = announcementHtml(normalizeAnnouncement({ id: 'x5', channel: 'c', media: { url: 'https://cdn/x.webm', height: 160 } }), { reducedMotion: true });
  assert.match(rmNoStill, /style="--ua-w:192px;--ua-ar:192 \/ 160"/);
  assert.match(rmNoStill, /<video class="ua-video" src="https:\/\/cdn\/x.webm" preload="metadata" muted playsinline loop aria-hidden="true">/, 'bez loop v payloadu = smyčka');
  assert.doesNotMatch(rmNoStill, /autoplay/);
  assert.match(html, /<div class="ua-text">Ahoj &lt;b&gt;<\/div>/);
  assert.match(html, /<span class="ua-cmd">Brohemians<\/span><span class="ua-ts">10:00<\/span>/);
  assert.doesNotMatch(html, /ua-by/, 'bez řádku „spustil"');
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

  // 4. rich text: whitelist tagů, odkazy jen http(s), zbytek escapovaný; XSS ven
  const rich = sanitizeAnnouncementHtml('<h1>Brohemians</h1><b>Povstaňte!</b> Víc na <a href="https://chromewebstore.google.com/x" target="_blank" rel="noopener">UnityChatu</a><br><script>alert(1)</script><a href="javascript:alert(1)">zle</a><img src=x onerror=alert(1)> 1 &lt; 2 &amp; A&B');
  assert.equal(rich, '<h1>Brohemians</h1><b>Povstaňte!</b> Víc na <a href="https://chromewebstore.google.com/x" target="_blank" rel="noopener noreferrer nofollow">UnityChatu</a><br>&lt;script&gt;alert(1)&lt;/script&gt;zle</a>&lt;img src=x onerror=alert(1)&gt; 1 &lt; 2 &amp; A&amp;B');
  const withRich = announcementHtml(normalizeAnnouncement({ id: 'x6', channel: 'c', text: '# T', textHtml: '<h2>T</h2><i>k</i>' }));
  assert.match(withRich, /<div class="ua-text"><h2>T<\/h2><i>k<\/i><\/div>/);
  assert.equal(normalizeAnnouncement({ id: 'x7', channel: 'c', textHtml: '<b>jen html</b>' })?.textHtml, '<b>jen html</b>');
  ok('rich text sanitizer');

  // 5. Markdown fallback + YouTube odkaz z runu
  assert.equal(richTextToHtml('# Brohemians\nOdebírej **__Brohemians__** kanál [TADY](https://youtu.be/x?si=a&b=1)! *i* <b>ne</b>'),
    '<h1>Brohemians</h1><br>Odebírej <b><u>Brohemians</u></b> kanál <a href="https://youtu.be/x?si=a&amp;b=1" target="_blank" rel="noopener noreferrer nofollow">TADY</a>! <i>i</i> &lt;b&gt;ne&lt;/b&gt;');
  assert.equal(normalizeAnnouncement({ id: 'x8', channel: 'c', text: '**b**' }).textHtml, '<b>b</b>', 'bez textHtml se převede text');
  const run = { text: 'https://youtu.be/cISb60sXpFU?si=5kVik...', navigationEndpoint: { urlEndpoint: { url: 'https://www.youtube.com/redirect?event=live_chat&redir_token=abc&q=https%3A%2F%2Fyoutu.be%2FcISb60sXpFU%3Fsi%3D5kVikD3t4w50MliE' } } };
  assert.equal(ytRunFullText(run), 'https://youtu.be/cISb60sXpFU?si=5kVikD3t4w50MliE');
  assert.equal(ytRunFullText({ text: 'ahoj' }), 'ahoj');
  assert.equal(ytRunFullText({ text: 'x', navigationEndpoint: { urlEndpoint: { url: 'https://www.youtube.com/redirect?q=javascript:alert(1)' } } }), 'x');
  ok('markdown fallback + youtube plná URL');

  // 6. smyčka s pauzou: bez nativního loop, s data-loop-delay
  const dl = announcementHtml(normalizeAnnouncement({ id: 'x9', channel: 'c', media: { url: 'https://cdn/x.webm', loop: true, loopDelayMs: 2500 } }));
  assert.match(dl, /<video class="ua-video" src="https:\/\/cdn\/x.webm" autoplay preload="auto" muted playsinline data-loop-delay="2500" aria-hidden="true">/);
  assert.doesNotMatch(dl, / loop/);
  assert.equal(normalizeAnnouncement({ id: 'x', channel: 'c', media: { url: 'https://a/b.webm', loopDelayMs: 999999 } }).media.loopDelayMs, 60000, 'strop 60 s');
  assert.equal(normalizeAnnouncement({ id: 'x', channel: 'c', media: { url: 'https://a/b.webm', loop: false, loopDelayMs: 500 } }).media.loop, false);
  ok('loopDelayMs');

  // Odpověď cizího bota (StreamElements) — skrytí podle odesílatele
  const { normBotLogins, takeBotReply, hideRecentBotReplies, ANNC_BOT_BEHIND_MS } = await import('../extension/core/announcement.js');
  assert.deepEqual(normBotLogins(['StreamElements', 'streamelements', 'x', 'bad login', 'Nightbot']), ['streamelements', 'nightbot']);
  assert.deepEqual(normBotLogins('streamelements'), []);
  assert.deepEqual(normalizeAnnouncement({ id: 'x', channel: 'c', text: 't', hideBotReplies: ['StreamElements'] }).hideBotReplies, ['streamelements']);
  assert.deepEqual(normalizeAnnouncement({ id: 'x', channel: 'c', text: 't' }).hideBotReplies, []);
  assert.equal(normalizeAnnouncement({ id: 'x', channel: 'c', text: 't', hideInBrowserSource: 1 }).hideInBrowserSource, true);
  assert.equal(normalizeAnnouncement({ id: 'x', channel: 'c', text: 't' }).hideInBrowserSource, false, 'výchozí = v OBS se ukazuje');
  const pend = [{ login: 'streamelements', until: 2000 }];
  assert.equal(takeBotReply(pend, 'Jouki', 1000), false, 'jiný odesílatel');
  assert.equal(takeBotReply(pend, 'StreamElements', 1000), true, 'bot v okně (case-insensitive)');
  assert.equal(takeBotReply(pend, 'StreamElements', 1000), false, 'skryje se jen jedna zpráva');
  assert.equal(takeBotReply([{ login: 'streamelements', until: 500 }], 'streamelements', 1000), false, 'po okně už ne');
  const fakeMsg = (user, ts) => { const cls = new Set(); return { dataset: { ts: String(ts) }, classList: { contains: (c) => cls.has(c), add: (c) => cls.add(c) }, querySelector: () => ({ dataset: { username: user } }), cls }; };
  const now = 100000;
  const old = fakeMsg('streamelements', now - ANNC_BOT_BEHIND_MS - 1), fresh = fakeMsg('streamelements', now - 800), other = fakeMsg('jouki', now - 100);
  assert.deepEqual(hideRecentBotReplies({ querySelectorAll: () => [old, fresh, other] }, ['streamelements', 'nightbot'], now), ['nightbot'], 'SE už přišla → nečeká; nightbot čeká');
  assert.equal(fresh.cls.has('uc-annc-hidden'), true, 'čerstvá SE zpráva skrytá');
  assert.equal(old.cls.has('uc-annc-hidden'), false, 'starší než okno zůstane');
  assert.equal(other.cls.has('uc-annc-hidden'), false);
  assert.deepEqual(hideRecentBotReplies({ querySelectorAll: () => [old] }, ['streamelements'], now), ['streamelements'], 'jen stará zpráva → čekat na novou');
  ok('hideBotReplies + hideInBrowserSource');

  console.log(`\n${n}/${n} PASS`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
