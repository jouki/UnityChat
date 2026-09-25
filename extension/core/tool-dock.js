// Umístění tlačítka nástroje (QR dono) podle šířky chatu — addon i web.
// Široký chat (> breakpoint): tlačítko v poli pro psaní vlevo od noty soundboardu (fade in),
// řádek nad polem zajede dolů. Úzký chat: tlačítko v řádku nad polem, řádek vyjede zespodu.
// Řádek s jiným obsahem (addon: body/bity Twitche) se nezavírá, jen se z něj tlačítko přesune.

/** Široký chat = šířka kontejneru nad breakpointem. */
export function isWide(width, breakpoint = 500) {
  return width > breakpoint;
}

/** Kam patří tlačítko a jestli má být řádek zavřený. */
export function dockState({ available, wide, rowHasOther }) {
  const place = !available ? 'none' : wide ? 'inline' : 'row';
  return { place, rowShut: place !== 'row' && !rowHasOther };
}

/**
 * @param {object} o
 * @param {HTMLElement} o.button        tlačítko nástroje
 * @param {HTMLElement} o.row           řádek nad polem pro psaní (dostane třídu uc-dock-row)
 * @param {HTMLElement} o.inlineParent  kontejner pole pro psaní (.msg-input-wrap)
 * @param {HTMLElement} [o.inlineBefore] prvek, před který se tlačítko vloží (nota soundboardu)
 * @param {HTMLElement} o.container     měřený kontejner (šířka chatu)
 * @param {number} [o.breakpoint=500]
 * @param {() => boolean} [o.rowHasOther] řádek má i jiný viditelný obsah
 * @param {() => boolean} [o.inlineVisible] pole pro psaní je vidět (výchozí: inlineParent má rozměry)
 */
export function createToolDock({ button, row, inlineParent, inlineBefore = null, container, breakpoint = 500, rowHasOther = () => false,
  inlineVisible = () => inlineParent.getClientRects().length > 0 }) {
  const win = container.ownerDocument.defaultView;
  let available = false;
  let lastPlace = null;
  row.classList.add('uc-dock-row', 'uc-dock-noanim');

  function update() {
    // Skryté pole pro psaní (nepřihlášený → výzva k přihlášení) = tlačítko zůstává v řádku.
    const wide = inlineVisible() && isWide(container.getBoundingClientRect().width, breakpoint);
    const s = dockState({ available, wide, rowHasOther: rowHasOther() });
    button.hidden = s.place === 'none';
    if (s.place === 'inline' && button.parentNode !== inlineParent) {
      inlineParent.insertBefore(button, inlineBefore && inlineBefore.parentNode === inlineParent ? inlineBefore : null);
    } else if (s.place === 'row' && button.parentNode !== row) {
      row.appendChild(button);
    }
    button.classList.toggle('uc-dock-inline', s.place === 'inline');
    // Fade in jen při přesunu do pole (ne při prvním umístění).
    if (s.place === 'inline' && lastPlace && lastPlace !== 'inline') {
      button.classList.remove('uc-dock-fade');
      void button.offsetWidth;
      button.classList.add('uc-dock-fade');
    }
    row.classList.toggle('uc-dock-shut', s.rowShut);
    lastPlace = s.place;
  }

  const ro = new win.ResizeObserver(() => update());
  ro.observe(container);
  update();
  // První umístění bez animace, další změny animované.
  win.requestAnimationFrame(() => win.requestAnimationFrame(() => row.classList.remove('uc-dock-noanim')));

  return {
    /** Po změně přihlášení (pole pro psaní se ukáže/skryje) zavolat update(). */
    setAvailable(on) { available = !!on; update(); },
    update,
    destroy() { ro.disconnect(); },
  };
}
