// Tlačítka u pole pro psaní podle šířky POLE PRO PSANÍ — addon i web (pokyn usera 2026-09-25).
// Každé tlačítko má práh šířky pole: od něj výš zůstává v poli, pod ním se přesune do
// řádku nad polem (řádek vyjede zespodu). Prahy hostitelů: QR dono 330 px, nota 310 px,
// smajlík 290 px — v řádku stojí zleva doprava v pořadí položek. Tlačítka, která už v řádku
// jsou, se při příchodu dalšího plynule posunou (FLIP), přesunuté se objeví fade inem.
// Řádek s jiným obsahem (addon: body/bity Twitche) se nezavírá, jen se z něj tlačítka přesunou.

/** Kam patří položka: 'none' (nedostupná), 'inline' (v poli) nebo 'row' (řádek nad polem). */
export function placeItem({ available, width, minWidth, inlineVisible }) {
  if (!available) return 'none';
  // Skryté pole (nepřihlášený) = tlačítka nechat v poli, kde je má hostitel.
  if (!inlineVisible) return 'inline';
  return width >= minWidth ? 'inline' : 'row';
}

/** Řádek zavřít, když v něm žádná položka není a nemá jiný obsah. */
export function rowShut(places, rowHasOther) {
  return !rowHasOther && !places.includes('row');
}

/**
 * @param {object} o
 * @param {HTMLElement} o.row            řádek nad polem pro psaní (dostane třídu uc-dock-row)
 * @param {HTMLElement} o.inlineParent   kontejner pole pro psaní (.msg-input-wrap) — jeho šířka
 *        rozhoduje (tlačítka v něm jsou absolutně, šířku pole nemění)
 * @param {Array<{ button: HTMLElement, minWidth: number, available?: () => boolean }>} o.items
 *        v pořadí zleva doprava v řádku. S `available` dock tlačítko i skrývá (atribut hidden);
 *        bez něj je vždy dostupné a skrytí řeší hostitel (nota bez soundboardu má třídu hidden).
 * @param {() => boolean} [o.rowHasOther] řádek má i jiný viditelný obsah
 * @param {() => boolean} [o.inlineVisible] pole pro psaní je vidět (výchozí: inlineParent má rozměry)
 */
export function createToolDock({ row, inlineParent, items, rowHasOther = () => false,
  inlineVisible = () => inlineParent.getClientRects().length > 0 }) {
  const win = inlineParent.ownerDocument.defaultView;
  // Návrat do pole na původní místo: před původního souseda zprava (smajlík je v poli poslední).
  // Položka, která začíná mimo pole (QR v řádku), se vrací před další položku.
  const home = items.map((it, i) => ({
    ...it, last: null,
    next: it.button.parentNode === inlineParent ? it.button.nextElementSibling : (items[i + 1]?.button ?? null),
  }));
  row.classList.add('uc-dock-row', 'uc-dock-noanim');

  function update() {
    const width = inlineParent.getBoundingClientRect().width;
    const vis = inlineVisible();
    const before = new Map();
    for (const it of home) if (it.button.parentNode === row) before.set(it.button, it.button.getBoundingClientRect().left);
    const places = home.map((it) => placeItem({ available: it.available ? it.available() : true, width, minWidth: it.minWidth, inlineVisible: vis }));

    // Do pole zprava doleva, ať soused zprava už stojí na svém místě.
    for (let i = home.length - 1; i >= 0; i--) {
      const it = home[i];
      if (places[i] !== 'row' && it.button.parentNode !== inlineParent) {
        inlineParent.insertBefore(it.button, it.next && it.next.parentNode === inlineParent ? it.next : null);
      }
    }
    // Do řádku zleva doprava v pořadí položek — přeskládat jen při změně (znovuvložení by
    // restartovalo animace a shodilo hover).
    const want = home.filter((_, i) => places[i] === 'row').map((it) => it.button);
    const cur = [...row.children].filter((c) => want.includes(c));
    if (cur.length !== want.length || cur.some((c, i) => c !== want[i])) for (const b of want) row.appendChild(b);
    let first = true;
    home.forEach((it, i) => {
      const b = it.button;
      if (it.available) b.hidden = places[i] === 'none';
      b.classList.toggle('uc-dock-in-row', places[i] === 'row');
      b.classList.toggle('uc-dock-inline', places[i] === 'inline' && !!it.available);
      const lead = places[i] === 'row' && first && !b.hidden && !b.classList.contains('hidden');
      if (lead) first = false;
      b.style.marginLeft = lead ? 'auto' : '';
    });

    // Přesunuté → fade in; v řádku zůstalé → plynulý posun na nové místo (FLIP).
    home.forEach((it, i) => {
      const b = it.button;
      if (it.last !== null && it.last !== places[i] && places[i] !== 'none') {
        b.classList.remove('uc-dock-fade'); void b.offsetWidth; b.classList.add('uc-dock-fade');
      } else if (places[i] === 'row' && before.has(b) && b.animate) {
        const dx = before.get(b) - b.getBoundingClientRect().left;
        if (Math.abs(dx) > 0.5) b.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 250, easing: 'ease' });
      }
      it.last = places[i];
    });
    // Položka skrytá hostitelem (nota bez soundboardu) řádek neotvírá.
    const visible = places.map((pl, i) => (pl === 'row' && home[i].button.classList.contains('hidden') ? 'none' : pl));
    row.classList.toggle('uc-dock-shut', rowShut(visible, rowHasOther()));
  }

  const ro = new win.ResizeObserver(() => update());
  ro.observe(inlineParent);
  update();
  // První umístění bez animace, další změny animované.
  win.requestAnimationFrame(() => win.requestAnimationFrame(() => row.classList.remove('uc-dock-noanim')));

  return {
    /** Po změně dostupnosti (přihlášení, dary v kanálu) nebo viditelnosti pole zavolat update(). */
    update,
    destroy() { ro.disconnect(); },
  };
}
