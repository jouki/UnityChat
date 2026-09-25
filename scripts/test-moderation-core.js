// Testy sdíleného core modulu pro zobrazení smazané/skryté zprávy
// (extension/core/moderation.js). Spuštění: node scripts/test-moderation-core.js
import('../extension/core/moderation.js').then((m) => {
  let fails = 0;
  const check = (n, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) fails++; };

  check('DELETED_STYLES obsahuje všechny 4 styly', JSON.stringify(m.DELETED_STYLES) === JSON.stringify(['label', 'dim', 'strike', 'hide']));
  check('DEFAULT_DELETED_STYLE = label', m.DEFAULT_DELETED_STYLE === 'label');

  check('MOD_DELETED_STYLES = 3 volby pro moda (bez „Skryté")', JSON.stringify(m.MOD_DELETED_STYLES.map((o) => o.id + ':' + o.label)) === JSON.stringify(['label:Zpráva smazána', 'dim:Zašedlé', 'strike:Přeškrtnuté']));

  // --- deletedView (rozhodnutí usera 2026-09-25 v2) -------------------------
  const V = (o) => JSON.stringify(m.deletedView(o));
  const view = (mode, dimmed, tag) => JSON.stringify({ mode, dimmed, tag });
  const cases = [
    // [popis, input, očekávaný view]
    ['divák: vždy zašedlé „Zpráva smazána" bez štítku (style ignorován: strike)', { style: 'strike' }, view('label', true, false)],
    ['divák: style dim ignorován', { style: 'dim' }, view('label', true, false)],
    ['divák: style hide ignorován', { style: 'hide' }, view('label', true, false)],
    ['divák bez style', {}, view('label', true, false)],
    ['divák: skrytá → hide', { hidden: true, style: 'strike' }, view('hide', false, false)],
    ['mod label → zašedlé, bez štítku', { isMod: true, style: 'label' }, view('label', true, false)],
    ['mod dim → zašedlý text + štítek', { isMod: true, style: 'dim' }, view('dim', true, true)],
    ['mod strike → přeškrtnutý + štítek', { isMod: true, style: 'strike' }, view('strike', true, true)],
    ['mod uložené hide → label', { isMod: true, style: 'hide' }, view('label', true, false)],
    ['mod neznámý style → label', { isMod: true, style: 'x' }, view('label', true, false)],
    ['mod skrytá + strike → strike (mod skrytou vidí)', { isMod: true, hidden: true, style: 'strike' }, view('strike', true, true)],
    ['mod skrytá výchozí → label', { isMod: true, hidden: true }, view('label', true, false)],
    ['OBS (raw) smazaná → hide', { raw: true }, view('hide', false, false)],
    ['OBS (raw) skrytá → hide', { raw: true, hidden: true }, view('hide', false, false)],
    ['OBS (raw) i s modem → hide', { raw: true, isMod: true, style: 'strike' }, view('hide', false, false)],
  ];
  for (const [desc, input, expected] of cases) check(`deletedView: ${desc} (got ${V(input)})`, V(input) === expected);
  check('deletedMode = deletedView().mode', m.deletedMode({ isMod: true, style: 'dim' }) === 'dim' && m.deletedMode({ style: 'dim' }) === 'label');

  // --- applyDeleted / clearDeleted: minimální fake DOM element ------------
  // Fake element/document dost bohaté na classList, querySelector, appendChild,
  // textContent/replaceChildren a remove() — bez jsdom závislosti.
  function makeFakeDoc() {
    return { createElement: (tag) => makeFakeEl(tag) };
  }
  function makeFakeEl(tag = 'div') {
    const classes = new Set();
    const el = {
      tag,
      children: [],
      _text: '',
      hidden: false,
      ownerDocument: null,
      classList: {
        add: (...names) => names.forEach((n) => classes.add(n)),
        remove: (...names) => names.forEach((n) => classes.delete(n)),
        contains: (n) => classes.has(n),
      },
      get className() { return [...classes].join(' '); },
      set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((n) => classes.add(n)); },
      appendChild(child) { if (child.parent) child.parent.children = child.parent.children.filter((c) => c !== child); child.parent = el; el.children.push(child); return child; },
      insertBefore(child, ref) { if (child.parent) child.parent.children = child.parent.children.filter((c) => c !== child); child.parent = el; const i = el.children.indexOf(ref); el.children.splice(i < 0 ? el.children.length : i, 0, child); return child; },
      get parentNode() { return el.parent || null; },
      querySelectorAll(sel) {
        // 'img.emote' (wrapStrikeEmotes) nebo '.třída' (unwrapStrikeEmotes)
        const out = [];
        const hit = sel === 'img.emote' ? (c) => c.tag === 'img' && c.classList.contains('emote') : (c) => c.classList.contains(sel.replace(/^\./, ''));
        const walk = (node) => { for (const c of node.children) { if (hit(c)) out.push(c); walk(c); } };
        walk(el);
        return out;
      },
      get firstChild() { return el.children[0] || null; },
      querySelector(sel) {
        const cls = sel.replace(/^\./, '');
        const walk = (node) => {
          for (const c of node.children) {
            if (c.classList.contains(cls)) return c;
            const found = walk(c);
            if (found) return found;
          }
          return null;
        };
        return walk(el);
      },
      remove() { if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el); },
      replaceChildren(...nodes) { el.children = []; nodes.forEach((n) => el.appendChild(n)); },
      get textContent() { return el._text; },
      set textContent(v) { el._text = v; el.children = []; },
    };
    return el;
  }
  function makeMsgEl() {
    const doc = makeFakeDoc();
    const el = makeFakeEl('div');
    el.ownerDocument = doc;
    const tx = makeFakeEl('span');
    tx.classList.add('tx');
    tx.textContent = 'původní text zprávy';
    el.appendChild(tx);
    return { el, tx };
  }

  // label mode: .tx obsah nahrazen .uc-deleted-label, žádný .uc-deleted-tag
  {
    const { el, tx } = makeMsgEl();
    m.applyDeleted(el, { mode: 'label' });
    check('applyDeleted label: přidá uc-deleted + uc-deleted--label', el.classList.contains('uc-deleted') && el.classList.contains('uc-deleted--label'));
    const lbl = el.querySelector('.uc-deleted-label');
    check('applyDeleted label: vloží .uc-deleted-label do .tx', !!lbl && lbl.textContent === 'Zpráva smazána');
    check('applyDeleted label: nevytváří .uc-deleted-tag', !el.querySelector('.uc-deleted-tag'));
    check('applyDeleted label: el zůstává viditelný', el.hidden === false);
  }

  // dim mode: text zůstává, přidá se štítek "Smazáno"
  {
    const { el, tx } = makeMsgEl();
    m.applyDeleted(el, { mode: 'dim' });
    check('applyDeleted dim: přidá uc-deleted--dim', el.classList.contains('uc-deleted--dim'));
    check('applyDeleted dim: text zprávy zůstává', tx.textContent === 'původní text zprávy');
    const tag = el.querySelector('.uc-deleted-tag');
    check('applyDeleted dim: štítek "Smazáno"', !!tag && tag.textContent === 'Smazáno');
  }

  // dim + hidden: štítek "Skryto v UnityChatu"
  {
    const { el } = makeMsgEl();
    m.applyDeleted(el, { mode: 'dim', hidden: true });
    const tag = el.querySelector('.uc-deleted-tag');
    check('applyDeleted dim+hidden: štítek "Skryto v UnityChatu"', !!tag && tag.textContent === 'Skryto v UnityChatu');
  }

  // hide mode: el.hidden = true
  {
    const { el } = makeMsgEl();
    m.applyDeleted(el, { mode: 'hide' });
    check('applyDeleted hide: el.hidden = true', el.hidden === true);
    check('applyDeleted hide: přidá uc-deleted--hide', el.classList.contains('uc-deleted--hide'));
  }

  // idempotence: dvojí volání label nezdvojí label span
  {
    const { el } = makeMsgEl();
    m.applyDeleted(el, { mode: 'label' });
    m.applyDeleted(el, { mode: 'label' });
    const tx = el.querySelector('.tx');
    check('applyDeleted label: idempotentní (jediný label span)', tx.children.length === 1);
  }

  // idempotence: dvojí volání dim nezdvojí tag
  {
    const { el } = makeMsgEl();
    m.applyDeleted(el, { mode: 'dim' });
    m.applyDeleted(el, { mode: 'dim' });
    let tagCount = 0;
    (function count(node) { for (const c of node.children) { if (c.classList.contains('uc-deleted-tag')) tagCount++; count(c); } })(el);
    check('applyDeleted dim: idempotentní (jediný tag)', tagCount === 1);
  }

  // clearDeleted: odstraní třídy/tag/hidden (obsah .tx je na hostu)
  {
    const { el } = makeMsgEl();
    m.applyDeleted(el, { mode: 'dim' });
    m.clearDeleted(el);
    check('clearDeleted: odstraní uc-deleted třídy', !el.classList.contains('uc-deleted') && !el.classList.contains('uc-deleted--dim'));
    check('clearDeleted: odstraní .uc-deleted-tag', !el.querySelector('.uc-deleted-tag'));
    check('clearDeleted: el.hidden = false', el.hidden === false);
  }
  {
    const { el } = makeMsgEl();
    m.applyDeleted(el, { mode: 'hide' });
    m.clearDeleted(el);
    check('clearDeleted: unhide po hide módu', el.hidden === false && !el.classList.contains('uc-deleted--hide'));
  }

  // mod label: „Zpráva smazána" zašedlé, bez štítku
  {
    const { el } = makeMsgEl();
    m.applyDeleted(el, { ...m.deletedView({ isMod: true, style: 'label' }), hasContent: true });
    check('applyDeleted mod label: label místo textu', el.querySelector('.uc-deleted-label')?.textContent === 'Zpráva smazána');
    check('applyDeleted mod label: bez štítku', !el.querySelector('.uc-deleted-tag'));
    check('applyDeleted mod label: zašedlé (uc-deleted--dimmed), nepřeškrtnuté', el.classList.contains('uc-deleted--dimmed') && !el.classList.contains('uc-deleted--strike'));
  }
  // mod skrytá (label): „Zpráva skryta" bez štítku; dim → štítek „Skryto v UnityChatu"
  {
    const { el } = makeMsgEl();
    m.applyDeleted(el, { ...m.deletedView({ isMod: true, hidden: true }), hidden: true });
    check('applyDeleted mod skrytá: label „Zpráva skryta"', el.querySelector('.uc-deleted-label')?.textContent === 'Zpráva skryta' && !el.querySelector('.uc-deleted-tag'));
    const b = makeMsgEl();
    m.applyDeleted(b.el, { ...m.deletedView({ isMod: true, hidden: true, style: 'dim' }), hidden: true });
    check('applyDeleted mod skrytá dim: štítek „Skryto v UnityChatu"', b.el.querySelector('.uc-deleted-tag')?.textContent === 'Skryto v UnityChatu');
  }
  // restorable: třída jen když ji chce volající (smazáno serverem), clearDeleted ji sundá
  {
    const { el } = makeMsgEl();
    m.applyDeleted(el, { ...m.deletedView({ isMod: true }), restorable: true });
    check('applyDeleted restorable → uc-deleted--restorable', el.classList.contains('uc-deleted--restorable'));
    m.applyDeleted(el, { ...m.deletedView({ isMod: true }) });
    check('applyDeleted bez restorable → třída pryč (ztlumení po timeoutu)', !el.classList.contains('uc-deleted--restorable'));
    m.applyDeleted(el, { ...m.deletedView({ isMod: true }), restorable: true });
    m.clearDeleted(el);
    check('clearDeleted sundá uc-deleted--restorable', !el.classList.contains('uc-deleted--restorable'));
  }
  // mod strike bez obsahu: label + štítek + ztlumení; pak s obsahem: strike + emote obalený
  {
    const { el, tx } = makeMsgEl();
    m.applyDeleted(el, { ...m.deletedView({ isMod: true, style: 'strike' }), hasContent: false });
    check('applyDeleted mod strike bez obsahu: label + štítek + dimmed', !!el.querySelector('.uc-deleted-label') && !!el.querySelector('.uc-deleted-tag') && el.classList.contains('uc-deleted--dimmed'));
    // host znovu vykreslí text s emoty (samostatný + ve stacku)
    tx.children = [];
    const img = makeFakeEl('img'); img.classList.add('emote'); tx.appendChild(img);
    const stack = makeFakeEl('span'); stack.classList.add('emote-stack'); const img2 = makeFakeEl('img'); img2.classList.add('emote'); stack.appendChild(img2); tx.appendChild(stack);
    m.applyDeleted(el, { ...m.deletedView({ isMod: true, style: 'strike' }), hasContent: true });
    check('applyDeleted mod strike: třída strike + dimmed + štítek', el.classList.contains('uc-deleted--strike') && el.classList.contains('uc-deleted--dimmed') && el.querySelector('.uc-deleted-tag')?.textContent === 'Smazáno');
    check('applyDeleted strike: samostatný emote obalený .uc-strike-emote', !!img.parentNode?.classList.contains('uc-strike-emote'));
    check('applyDeleted strike: emote ve stacku neobalený', img2.parentNode === stack);
    m.applyDeleted(el, { ...m.deletedView({ isMod: true, style: 'strike' }), hasContent: true });
    check('applyDeleted strike: obal idempotentní', img.parentNode.parentNode === tx);
    m.applyDeleted(el, { ...m.deletedView({ isMod: true, style: 'dim' }), hasContent: true });
    check('přepnutí strike → dim: obal .uc-strike-emote rozbalený', img.parentNode === tx && !tx.children.some((c) => c.classList.contains('uc-strike-emote')));
    m.applyDeleted(el, { ...m.deletedView({ isMod: true, style: 'strike' }), hasContent: true });
    check('zpátky strike → emote znovu obalený', !!img.parentNode?.classList.contains('uc-strike-emote'));
    m.clearDeleted(el);
    check('clearDeleted: sundá uc-deleted--dimmed', !el.classList.contains('uc-deleted--dimmed'));
    check('clearDeleted: rozbalí .uc-strike-emote (emote zpátky v .tx)', img.parentNode === tx && tx.children.filter((c) => c.tag === 'img').length === 1 && !tx.children.some((c) => c.classList.contains('uc-strike-emote')));
  }
  // divák: vždy zašedlé „Zpráva smazána", bez štítku, bez přeškrtnutí (i s textem a style strike)
  {
    const { el } = makeMsgEl();
    m.applyDeleted(el, { ...m.deletedView({ style: 'strike' }), hasContent: true });
    check('applyDeleted divák: label + zašedlé, bez štítku a bez přeškrtnutí', !!el.querySelector('.uc-deleted-label') && !el.querySelector('.uc-deleted-tag')
      && el.classList.contains('uc-deleted--dimmed') && el.classList.contains('uc-deleted--label') && !el.classList.contains('uc-deleted--strike'));
  }
  // bez textu (dev: „bez textu → label") — mod strike bez obsahu = label (štítek zůstává, mod zvolil strike)
  {
    const { el } = makeMsgEl();
    m.applyDeleted(el, { mode: 'strike', hasContent: false });
    check('applyDeleted strike bez obsahu → label, ne přeškrtnutý label', el.classList.contains('uc-deleted--label') && !el.classList.contains('uc-deleted--strike'));
  }

  // --- DeletedContentLoader ------------------------------------------------
  (async () => {
    const timers = [];
    const mk = (api) => {
      const got = [];
      const L = new m.DeletedContentLoader({ api, channel: () => 'RobDiesALot', onContent: (x) => got.push(x), setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {} });
      return { L, got };
    };
    const calls = [];
    const { L, got } = mk(async (path) => { calls.push(path); return { ok: true, messages: { 'twitch:a': { platform: 'twitch', id: 'a', message: 'tst', deleted: true } } }; });
    check('loader request: zařadí', L.request('twitch', 'a') === true);
    check('loader request: dedup', L.request('twitch', 'a') === false);
    L.request('kick', 'b');
    check('loader: jeden časovač na dávku', timers.length === 1);
    await L.flush();
    check('loader: jeden dotaz s kanálem lowercase a oběma klíči', calls.length === 1 && calls[0] === '/moderation/deleted-content?channel=robdiesalot&ids=' + encodeURIComponent('twitch:a,kick:b'), calls[0]);
    check('loader: onContent jen pro vrácené zprávy', got.length === 1 && got[0].message === 'tst');
    check('loader: už dotázané se neopakuje', L.request('twitch', 'a') === false);
    L.reset();
    check('loader reset: po přepnutí kanálu znovu', L.request('twitch', 'a') === true);

    const calls2 = [];
    const { L: L2 } = mk(async (path) => { calls2.push(path); return { ok: true, messages: {} }; });
    for (let i = 0; i < 150; i++) L2.request('twitch', 'id' + i);
    await L2.flush();
    check('loader: 150 klíčů = 2 dotazy (100 + 50)', calls2.length === 2 && decodeURIComponent(calls2[0].split('ids=')[1]).split(',').length === 100);

    const err = (status) => async () => { const e = new Error('x'); e.status = status; throw e; };
    const { L: L3 } = mk(err(500));
    L3.request('twitch', 'z'); await L3.flush();
    check('loader: chyba 500 → klíč půjde zkusit znovu', L3.request('twitch', 'z') === true);
    const { L: L4, got: got4 } = mk(err(403));
    L4.request('twitch', 'z'); await L4.flush();
    check('loader: 403 (není mod) → klíč se neopakuje, nic nepřijde', L4.request('twitch', 'z') === false && got4.length === 0);

    let release;
    const { L: L5, got: got5 } = mk(() => new Promise((r) => { release = () => r({ ok: true, messages: { 'twitch:q': { id: 'q' } } }); }));
    L5.request('twitch', 'q');
    const pr = L5.flush();
    L5.reset(); release(); await pr;
    check('loader: odpověď po reset() zahozena', got5.length === 0);

    process.exit(fails ? 1 : 0);
  })();
});
