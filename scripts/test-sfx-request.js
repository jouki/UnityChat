// node scripts/test-sfx-request.js — čisté funkce návrhu zvuku (core/sfx-request.js) + gainFactor soundboardu
const assert = require('node:assert/strict');

(async () => {
  const sr = await import('../extension/core/sfx-request.js');
  const sb = await import('../extension/core/soundboard.js');

  // formát času m:ss,s a délky
  assert.equal(sr.formatClipTime(0), '0:00,0');
  assert.equal(sr.formatClipTime(3440), '0:03,4');
  assert.equal(sr.formatClipTime(3460), '0:03,5', 'zaokrouhlení na desetiny');
  assert.equal(sr.formatClipTime(65_000), '1:05,0');
  assert.equal(sr.formatClipTime(599_990), '10:00,0');
  assert.equal(sr.formatClipTime(-5), '0:00,0');
  assert.equal(sr.formatClipTime(NaN), '0:00,0');
  assert.equal(sr.formatClipLength(30_000), '30,0 s');
  assert.equal(sr.formatClipLength(3_449), '3,4 s');

  // výchozí výběr: min(délka, 30 s) od začátku
  assert.deepEqual(sr.defaultSelection(12_345), { startMs: 0, endMs: 12_345 }, 'kratší mp3 = celá délka');
  assert.deepEqual(sr.defaultSelection(180_000), { startMs: 0, endMs: 30_000 });

  // moveHandle: max 30 s, značky se nepřekříží, mimo zdroj ne
  const D = 180_000;
  let sel = sr.defaultSelection(D);
  assert.deepEqual(sr.moveHandle(sel, 'end', 45_000, D), { startMs: 0, endMs: 30_000 }, 'konec se nepustí za 30 s');
  sel = sr.moveHandle(sel, 'start', 10_000, D);
  assert.deepEqual(sel, { startMs: 10_000, endMs: 30_000 });
  assert.deepEqual(sr.moveHandle(sel, 'end', 50_000, D), { startMs: 10_000, endMs: 40_000 }, 'konec max start + 30 s');
  assert.deepEqual(sr.moveHandle({ startMs: 10_000, endMs: 40_000 }, 'start', 0, D), { startMs: 10_000, endMs: 40_000 }, 'začátek se nepustí dál než konec − 30 s');
  assert.deepEqual(sr.moveHandle(sel, 'start', 35_000, D), { startMs: 29_800, endMs: 30_000 }, 'začátek zůstane min. 200 ms před koncem');
  assert.deepEqual(sr.moveHandle(sel, 'end', 1_000, D), { startMs: 10_000, endMs: 10_200 }, 'konec min. 200 ms za začátkem');
  assert.deepEqual(sr.moveHandle({ startMs: 0, endMs: 5_000 }, 'end', 9_999, 5_000), { startMs: 0, endMs: 5_000 }, 'konec ne za délku zdroje');
  assert.deepEqual(sr.moveHandle({ startMs: 0, endMs: 5_000 }, 'start', -300, 5_000), { startMs: 0, endMs: 5_000 }, 'začátek ne před 0');
  assert.deepEqual(sr.moveHandle({ startMs: 0, endMs: 100 }, 'end', 50, 100), { startMs: 0, endMs: 100 }, 'zdroj kratší než min. mezera');

  // název jako !se add (Židolišta normalizeSfxName)
  assert.equal(sr.normalizeRequestName('  ah shit '), 'ah_shit');
  assert.equal(sr.normalizeRequestName('!boom'), 'boom');
  assert.equal(sr.normalizeRequestName('Čau-lidi_2'), 'Čau-lidi_2');
  assert.equal(sr.normalizeRequestName('a.b'), null);
  assert.equal(sr.normalizeRequestName('x'.repeat(41)), null);
  assert.equal(sr.normalizeRequestName(''), null);

  // návrh názvu z titulku
  assert.equal(sr.suggestRequestName('Rick Astley - Never Gonna Give You Up (Official Video)'), 'Rick_Astley_-_Never_Gonna_Give_You_Up');
  assert.equal(sr.suggestRequestName('Čau! Lidi…'), 'Čau_Lidi');
  assert.equal(sr.suggestRequestName('x'.repeat(50)), 'x'.repeat(40));
  assert.equal(sr.suggestRequestName('!!!'), '');
  assert.equal(sr.suggestRequestName(null), '');

  // chyby → česky
  assert.match(sr.sfxRequestErrorText({ error: 'youtube_blocked' }), /YouTube .*mp3/);
  assert.equal(sr.sfxRequestErrorText({ error: 'too_long' }, 'prepare'), 'Zdroj je delší než 10 minut.');
  assert.equal(sr.sfxRequestErrorText({ error: 'too_long' }, 'submit'), 'Úsek je delší než 30 s.');
  assert.match(sr.sfxRequestErrorText('limit_day'), /10 návrhů/);
  assert.match(sr.sfxRequestErrorText('limit_month'), /30 návrhů/);
  assert.match(sr.sfxRequestErrorText({ error: 'HTTP 401', status: 401 }), /Přihlášení vypršelo/);
  assert.match(sr.sfxRequestErrorText({ error: 'zidolista_unavailable' }), /nedostupný/);
  for (const code of ['bad_url', 'unsupported', 'too_large', 'download_failed', 'busy', 'rate_limited', 'expired', 'bad_range', 'bad_name', 'name_taken']) {
    assert.doesNotMatch(sr.sfxRequestErrorText({ error: code }), /nedostupný/, `${code} má vlastní hlášku`);
  }

  // limity
  assert.equal(sr.limitsText({ dayUsed: 3, dayMax: 10, monthUsed: 5, monthMax: 30 }), 'Dnes zbývá 7 z 10 · tento měsíc 25 z 30');
  assert.equal(sr.limitsText({ dayUsed: 12, dayMax: 10, monthUsed: 31, monthMax: 30 }), 'Dnes zbývá 0 z 10 · tento měsíc 0 z 30');
  assert.equal(sr.limitReached({ dayUsed: 10, dayMax: 10, monthUsed: 10, monthMax: 30 }), 'limit_day');
  assert.equal(sr.limitReached({ dayUsed: 1, dayMax: 10, monthUsed: 30, monthMax: 30 }), 'limit_month');
  assert.equal(sr.limitReached({ dayUsed: 1, dayMax: 10, monthUsed: 1, monthMax: 30 }), null);
  assert.equal(sr.limitReached(null), null);

  // embed režim YouTube: ruční časy, URL přehrávače, origin zpráv
  assert.equal(sr.parseClipTime('1:05'), 65_000);
  assert.equal(sr.parseClipTime('1:05,5'), 65_500);
  assert.equal(sr.parseClipTime(' 0:07.25 '), 7_250);
  assert.equal(sr.parseClipTime('42'), 42_000);
  assert.equal(sr.parseClipTime('1:75'), null, 'sekundy za minutou max 59');
  assert.equal(sr.parseClipTime('abc'), null);
  assert.equal(sr.parseClipTime(''), null);
  assert.equal(sr.manualRangeError(0, 30_000, 0), null);
  assert.equal(sr.manualRangeError(0, 30_001, 0), 'too_long');
  assert.equal(sr.manualRangeError(5_000, 5_000, 0), 'bad_range');
  assert.equal(sr.manualRangeError(10_000, 20_000, 15_000), 'bad_range', 'konec za délkou videa');
  assert.equal(sr.manualRangeError(null, 20_000, 0), 'bad_time');
  assert.equal(sr.youtubeEmbedUrl('dQw4w9WgXcQ', 'chrome-extension://abc'),
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?enablejsapi=1&controls=0&playsinline=1&origin=chrome-extension%3A%2F%2Fabc');
  assert.equal(sr.youtubeEmbedUrl('bad"id'), null);
  assert.equal(sr.isYoutubeOrigin('https://www.youtube-nocookie.com'), true);
  assert.equal(sr.isYoutubeOrigin('https://www.youtube.com'), true);
  assert.equal(sr.isYoutubeOrigin('https://evil.com'), false);
  assert.equal(sr.isYoutubeOrigin('https://www.youtube.com.evil.com'), false);
  assert.equal(sr.REQUEST_STATUS_TEXT.pending, 'čeká na schválení');

  // gainDb náhledu v soundboardu
  assert.equal(sb.gainFactor(0), 1);
  assert.equal(sb.gainFactor(undefined), 1);
  assert.ok(Math.abs(sb.gainFactor(6) - 1.995) < 0.01);
  assert.ok(Math.abs(sb.gainFactor(-6) - 0.501) < 0.01);
  assert.equal(sb.gainFactor(99), sb.gainFactor(20), 'strop ±20 dB');

  console.log('test-sfx-request: OK');
})().catch((e) => { console.error(e); process.exit(1); });
