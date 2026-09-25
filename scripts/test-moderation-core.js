// Testy sdíleného core modulu pro zobrazení smazané/skryté zprávy
// (extension/core/moderation.js). Spuštění: node scripts/test-moderation-core.js
import('../extension/core/moderation.js').then((m) => {
  let fails = 0;
  const check = (n, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) fails++; };

  check('DELETED_STYLES obsahuje všechny 4 styly', JSON.stringify(m.DELETED_STYLES) === JSON.stringify(['label', 'dim', 'strike', 'hide']));
  check('DEFAULT_DELETED_STYLE = label', m.DEFAULT_DELETED_STYLE === 'label');

  // --- deletedMode: tabulka případů ---------------------------------------
  const cases = [
    // [popis, input, expected]
    ['raw vyhrává nad isMod i style', { style: 'dim', isMod: true, raw: true }, 'label'],
    ['raw samotné → label', { raw: true }, 'label'],
    ['isMod vyhrává nad style (bez raw)', { style: 'strike', isMod: true }, 'dim'],
    ['isMod bez style → dim', { isMod: true }, 'dim'],
    ['obyčejný divák → style dim', { style: 'dim' }, 'dim'],
    ['obyčejný divák → style strike', { style: 'strike' }, 'strike'],
    ['obyčejný divák → style hide', { style: 'hide' }, 'hide'],
    ['obyčejný divák → style label', { style: 'label' }, 'label'],
    ['neznámý style → label (fallback)', { style: 'nonsense' }, 'label'],
    ['chybějící style → label (fallback)', {}, 'label'],
    // --- hidden ("Jen UC skrýt") — controller ruling ----------------------
    ['hidden + raw (ne mod) → hide', { hidden: true, raw: true }, 'hide'],
    ['hidden + obyčejný divák → hide', { hidden: true }, 'hide'],
    ['hidden + mod → dim', { hidden: true, isMod: true }, 'dim'],
    ['hidden + mod + raw → dim (mod má přednost)', { hidden: true, isMod: true, raw: true }, 'dim'],
    ['hidden + style ignorován (style by jinak dal strike)', { hidden: true, style: 'strike' }, 'hide'],
  ];
  for (const [desc, input, expected] of cases) {
    const got = m.deletedMode(input);
    check(`deletedMode: ${desc} (got ${got})`, got === expected);
  }

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
      appendChild(child) { child.parent = el; el.children.push(child); return child; },
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

  process.exit(fails ? 1 : 0);
});
