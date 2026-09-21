// EmoteManager z extension/core/emotes.js — rendering bez DOM, Kick parser,
// autocomplete, injektovaný log/fetch/assetUrl. Spuštění: node scripts/test-emotes.js
import('../extension/core/emotes.js').then(async ({ EmoteManager }) => {
  let fails = 0;
  const check = (n, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) fails++; };
  const logs = [];
  const em = new EmoteManager({
    log: (tag, text) => logs.push(tag + ' ' + text),
    fetch: async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); },
    assetUrl: (p) => 'asset://' + p,
  });

  check('CaneBear přes assetUrl', em.ucEmotes.get('CaneBear') === 'asset://emotes/canebear.webp');

  check('renderPlain bez emotů = escapovaný text (HTML string)', em.renderPlain('hi <there>') === 'hi &lt;there&gt;');

  em.learnKick('[emote:1:Kappa]');
  check('learnKick uloží URL', em.kickNative.get('Kappa') === 'https://files.kick.com/emotes/1/fullsize');
  const kickHtml = em.renderKick('a [emote:1:Kappa] b', {});
  check('renderKick [emote:] → HTML s <img class="emote">', /^a <span class="emote-stack"><img class="emote" src="https:\/\/files\.kick\.com\/emotes\/1\/fullsize" alt="Kappa"><\/span> b$/.test(kickHtml));

  const frag = em._parseKickHtmlFragment('x &amp; <img src="https://files.kick.com/emotes/2/fullsize" alt="Pog"> y <b>z</b>');
  check('_parseKickHtmlFragment bez DOM', JSON.stringify(frag) === JSON.stringify([
    { type: 'text', value: 'x & ' }, { type: 'emote', value: 'Pog', url: 'https://files.kick.com/emotes/2/fullsize' }, { type: 'text', value: ' y ' }, { type: 'text', value: 'z' },
  ]));
  const fragNoHttp = em._parseKickHtmlFragment('<img src="data:x" alt=":)">');
  check('img bez http src = text alt', fragNoHttp.length === 1 && fragNoHttp[0].type === 'text' && fragNoHttp[0].value === ':)');
  const fragEmpty = em._parseKickHtmlFragment('<span></span>');
  check('jen prázdné tagy → text fallback', fragEmpty.length === 1 && fragEmpty[0].type === 'text');

  const html = em._toHtml([{ type: 'text', value: '<b>&' }, { type: 'emote', value: 'Kappa', url: 'https://files.kick.com/emotes/1/fullsize' }]);
  check('_toHtml escapuje text', html.includes('&lt;b&gt;&amp;'));
  check('_toHtml emote img', /<img[^>]*class="emote[^"]*"[^>]*src="https:\/\/files\.kick\.com\/emotes\/1\/fullsize"/.test(html) || /<img[^>]*src="https:\/\/files\.kick\.com\/emotes\/1\/fullsize"/.test(html));

  const comp = em.findCompletions('ka', { fulltext: false });
  check('findCompletions prefix', comp.some((c) => (c.name || c) === 'Kappa'));
  const compFull = em.findCompletions('app', { fulltext: true });
  check('findCompletions fulltext', compFull.some((c) => (c.name || c) === 'Kappa'));

  let threw = false;
  try { await em._fetch('https://example.invalid/x'); } catch { threw = true; }
  check('_fetch injektovaný + EmoteFetch log', threw && logs.some((l) => l.startsWith('EmoteFetch timeout')));

  process.exit(fails ? 1 : 0);
});
