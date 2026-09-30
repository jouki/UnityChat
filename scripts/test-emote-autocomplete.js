// node scripts/test-emote-autocomplete.js — sdílený našeptávač emotů (core/emote-autocomplete.js):
// stav Tab / cyklování, vložení, rozhodnutí o klávesách (pravidla hlavního pole v3.38.50), okno 4 položek, HTML řádků.
const assert = require('node:assert/strict');

(async () => {
  const ac = await import('../extension/core/emote-autocomplete.js');
  const { EmoteManager } = await import('../extension/core/emotes.js');

  const em = new EmoteManager({ log: () => {} });
  em.channel7tv.set('peepoHappy', 'https://cdn.7tv.app/emote/a/2x.webp');
  em.global7tv.set('peepoSad', 'https://cdn.7tv.app/emote/b/2x.webp');
  em.bttvEmotes.set('peepoClap', 'https://cdn.betterttv.net/emote/c/1x');
  em.twitchNative.set('Kappa', 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0');
  const find = (p) => ({ matches: em.findCompletions(p), kind: 'emote' });

  // acWordStart
  assert.equal(ac.acWordStart('ahoj peep', 9), 5);
  assert.equal(ac.acWordStart('peep', 4), 0);

  // acTabStep: nový dotaz
  let st = ac.acTabStep(null, 'ahoj peep', 9, 1, find);
  assert.deepEqual(st.matches, ['peepoClap', 'peepoHappy', 'peepoSad'], 'řazení abecedně (všechny prefix, exact case)');
  assert.equal(st.start, 5); assert.equal(st.kind, 'emote'); assert.equal(st.prefix, 'peep');
  // prázdné slovo → undefined, nic nenalezeno → null
  assert.equal(ac.acTabStep(null, 'ahoj ', 5, 1, find), undefined);
  assert.equal(ac.acTabStep(null, 'ahoj xyz', 8, 1, find), null);

  // acApplyMatch na fake input
  const input = { value: 'ahoj peep', setSelectionRange(a, b) { this.sel = [a, b]; } };
  ac.acApplyMatch(input, st);
  assert.equal(input.value, 'ahoj peepoClap ');
  assert.deepEqual(input.sel, [15, 15]);
  assert.equal(st.applied, true);
  // cyklování (kurzor na konci doplnění)
  st = ac.acTabStep(st, input.value, 15, 1, find);
  assert.equal(st.index, 1);
  ac.acApplyMatch(input, st);
  assert.equal(input.value, 'ahoj peepoHappy ');
  st = ac.acTabStep(st, input.value, input.sel[0], -1, find);
  st = ac.acTabStep(st, input.value, input.sel[0], -1, find);
  assert.equal(st.index, 2, 'Shift+Tab z první položky → poslední (dokola)');
  // seznam otevřený psaním (applied=false): první Tab jen potvrdí vybranou položku
  const colon = { start: 0, end: 5, index: 1, matches: ['peepoClap', 'peepoHappy'], kind: 'emote', trigger: 'colon' };
  assert.equal(ac.acTabStep(colon, ':peep', 5, 1, find).index, 1);

  // acKeyAction (pravidla hlavního pole)
  const emoteTab = { matches: ['peepoClap'], kind: 'emote' };
  assert.equal(ac.acKeyAction(emoteTab, 'ArrowDown'), 'next');
  assert.equal(ac.acKeyAction(emoteTab, 'ArrowUp'), 'prev');
  assert.equal(ac.acKeyAction(emoteTab, 'ArrowRight'), 'close');
  assert.equal(ac.acKeyAction(emoteTab, 'Enter'), null, 'Tabem vložený emote: Enter propadne na odeslání');
  assert.equal(ac.acKeyAction({ ...emoteTab, trigger: 'colon' }, 'Enter'), 'apply-close', '„:jméno": Enter vloží');
  assert.equal(ac.acKeyAction({ matches: ['/user'], _type: 'usercmd' }, 'Enter'), 'apply-close');
  assert.equal(ac.acKeyAction({ matches: ['@Pepa'], kind: 'user' }, 'Enter'), 'close');
  assert.equal(ac.acKeyAction({ matches: ['@Pepa'] }, 'Enter'), 'close', 'auto @ seznam');
  assert.equal(ac.acKeyAction({ matches: ['!hug'] }, 'Enter'), null);
  assert.equal(ac.acKeyAction({ matches: [] }, 'ArrowDown'), null);
  assert.equal(ac.acKeyAction(null, 'ArrowDown'), null);
  assert.equal(ac.acKeyAction(emoteTab, 'a'), null);

  // acWindowRange: okno 4 kolem vybrané
  const w = { matches: ['a', 'b', 'c', 'd', 'e', 'f'], index: 0 };
  assert.deepEqual(ac.acWindowRange(w), [0, 4]);
  w.index = 4; assert.deepEqual(ac.acWindowRange(w), [1, 5]);
  w.index = 2; assert.deepEqual(ac.acWindowRange(w), [1, 5], 'okno se neposune, dokud vybraná nevypadne');
  w.index = 0; assert.deepEqual(ac.acWindowRange(w), [0, 4]);
  assert.deepEqual(ac.acWindowRange({ matches: ['a', 'b'], index: 1 }), [0, 2]);

  // zdroje
  assert.equal(ac.emoteSourceLabel(em, 'peepoHappy'), '7TV');
  assert.equal(ac.emoteSourceLabel(em, 'peepoSad'), '7TV');
  assert.equal(ac.emoteSourceLabel(em, 'peepoClap'), 'BTTV');
  assert.equal(ac.emoteSourceLabel(em, 'Kappa'), 'Twitch');
  assert.equal(ac.emoteSourceLabel(em, 'nic'), '');

  // HTML řádku (stejné třídy jako #emote-suggest: .es-item / .es-name-inner / .es-src)
  const row = ac.suggestRowHtml({ i: 3, selected: true, iconHtml: '<img>', name: 'a<b', src: '7TV', esc: (t) => em._eh(t) });
  assert.equal(row, '<div class="es-item selected" data-idx="3"><img><span class="es-name"><span class="es-name-inner">a&lt;b</span></span><span class="es-src">7TV</span></div>');
  assert.equal(ac.suggestCounterHtml(0, 4), '');
  assert.equal(ac.suggestCounterHtml(4, 6), '<div class="es-counter">5 / 6</div>');
  const list = ac.emoteSuggestHtml({ matches: ['peepoClap', 'peepoHappy'], index: 1 }, { emotes: em, fulltext: true });
  assert.ok(list.startsWith('<label class="es-toggle"><input type="checkbox" id="es-fulltext" checked>Fulltext</label>'));
  assert.ok(list.includes('<div class="es-item selected" data-idx="1"><img src="https://cdn.7tv.app/emote/a/2x.webp" alt="peepoHappy">'));
  assert.ok(list.includes('<span class="es-src">BTTV</span>'));

  console.log('test-emote-autocomplete: OK');
})().catch((e) => { console.error(e); process.exit(1); });
