// Testy čistých core helperů (extension/core/colors.js, html.js, log.js).
// Spuštění: node scripts/test-core-helpers.js
Promise.all([
  import('../extension/core/colors.js'),
  import('../extension/core/html.js'),
  import('../extension/core/log.js'),
]).then(([c, h, l]) => {
  let fails = 0;
  const check = (n, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) fails++; };

  check('twitchDefaultColor stabilní', c.twitchDefaultColor('jouki728') === c.twitchDefaultColor('jouki728'));
  check('twitchDefaultColor v paletě', c.TWITCH_DEFAULT_COLORS.includes(c.twitchDefaultColor('jouki728')));
  check('twitchDefaultColor bez jména = brand purple', c.twitchDefaultColor('') === '#9146ff');
  check('ytNameColor včetně @', c.ytNameColor('@nekdo') !== c.ytNameColor('nekdo'));
  check('ytNameColor tvar #rrggbb', /^#[0-9a-f]{6}$/.test(c.ytNameColor('@Neytuss')));
  check('readableColor černou zesvětlí', c.readableColor('#000000') !== '#000000');
  check('readableColor světlou nechá', c.readableColor('#ff8800') === '#ff8800');
  check('readableColor ne-hex vrací beze změny', c.readableColor('red') === 'red');
  check('isTwitchOgFaceName', c.isTwitchOgFaceName(':)') && !c.isTwitchOgFaceName('Kappa'));

  check('escapeHtml', h.escapeHtml('<a href="x">&') === '&lt;a href="x"&gt;&amp;');
  check('escapeAttr', h.escapeAttr('<a href="x">&') === '&lt;a href=&quot;x&quot;&gt;&amp;');
  check('decodeEntities numeric', h.decodeEntities('&#39;x&#x41;&amp;') === "'xA&");
  check('decodeEntities neznámou nechá', h.decodeEntities('&bogus;') === '&bogus;');
  check('stripTags', h.stripTags('a <b>b</b> &amp; <img src=x> c') === 'a b &  c'); // dvě mezery = shodné s textContent
  check('stripTags bez tagů je identita', h.stripTags('plain') === 'plain');
  const at = h.tagAttrs('<img src="https://u/x.png" alt=\'K&amp;o\' data-emote-name=Kappa>');
  check('tagAttrs', at.src === 'https://u/x.png' && at.alt === 'K&o' && at['data-emote-name'] === 'Kappa');

  let got = null;
  const log = l.makeLog((tag, text) => { got = tag + ':' + text; });
  log('T', 'x');
  check('makeLog volá fn', got === 'T:x');
  const boom = l.makeLog(() => { throw new Error('boom'); });
  let threw = false; try { boom('a', 'b'); } catch { threw = true; }
  check('makeLog polyká chyby', !threw);
  check('makeLog bez fn = noop', l.makeLog(null) === l.noopLog);

  process.exit(fails ? 1 : 0);
});
