// Posuvný indikátor výběru — sdílené addonem i webem (spec 2026-09-27-composer-animace-ikony §1).
// Jeden prvek (.uc-slide-ind) v kontejneru, který kreslí zvýraznění aktivní položky (pozadí + rámeček) a při změně
// výběru PŘEJEDE (transform + rozměr) z předchozí položky na novou, místo okamžitého přepnutí. Použití: boční
// záložky panelu emotů (Emoty | GIFy), horní taby GIF panelu (GIFy | Zamítnuté GIFy) a ikony v poli pro psaní
// (aktivní ikona otevřeného panelu). Kontejner dostane třídu uc-slide-host (položky pak vlastní pozadí nekreslí).
// Změna velikosti kontejneru / položky (resize, skrytý → zobrazený) = přesun bez animace. Bez aktivní položky
// indikátor zmizí (fade). `prefers-reduced-motion` → bez přechodů (CSS).
// Bez chrome.*; DOM jen přes předané prvky.

/**
 * @param {object} o
 * @param {HTMLElement} o.container          kontejner položek (position: relative / absolute)
 * @param {() => HTMLElement|null} o.getActive  právě vybraná položka (null = nic)
 * @param {string} [o.className]            další třída indikátoru (vzhled podle místa)
 * @returns {{ el: HTMLElement, update(o?: { animate?: boolean }): void, destroy(): void }}
 */
export function createSlideIndicator({ container, getActive, className = '' }) {
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  const el = doc.createElement('span');
  el.className = `uc-slide-ind uc-slide-noanim${className ? ` ${className}` : ''}`;
  el.setAttribute('aria-hidden', 'true');
  container.insertBefore(el, container.firstChild);
  container.classList.add('uc-slide-host');
  let last = null;       // naposledy vybraná položka
  let lastBox = '';      // poslední geometrie (beze změny = nic nepsat)
  let frame = 0;

  /**
   * Poloha položky v kontejneru z offset* (ne z getBoundingClientRect — to by během animace otevření panelu
   * (scale) vrátilo zmenšené souřadnice). Null = nevykreslená nebo mimo kontejner.
   */
  function boxOf(a) {
    if (!a || !a.isConnected || !a.offsetWidth) return null;
    let x = 0, y = 0, n = a;
    while (n && n !== container) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
    if (n !== container) return null;
    return { x, y, w: a.offsetWidth, h: a.offsetHeight };
  }

  function place(animate) {
    const a = getActive?.() || null;
    const b = boxOf(a);
    // Kontejner nebo položka nevykreslené (zavřený panel, skrytá záložka) → počkat na další update (ResizeObserver).
    if (!b || !container.offsetWidth) {
      el.classList.toggle('uc-slide-off', !a);
      if (!a) last = null;
      return;
    }
    const { x, y, w, h } = b;
    const box = `${x}|${y}|${w}|${h}`;
    // První umístění / návrat z „nic vybráno“ = bez jízdy (jinak by indikátor přijel z rohu).
    const slide = animate && last !== null && el.classList.contains('uc-slide-off') === false;
    el.classList.toggle('uc-slide-noanim', !slide);
    if (box !== lastBox) {
      lastBox = box;
      el.style.transform = `translate(${x}px, ${y}px)`;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
    }
    el.classList.remove('uc-slide-off');
    last = a;
    if (!slide) { win.cancelAnimationFrame(frame); frame = win.requestAnimationFrame(() => { frame = 0; el.classList.remove('uc-slide-noanim'); }); }
  }

  // Resize kontejneru i položek (šířka panelu, mobil na šířku, otevření zavřeného panelu) → dorovnat bez jízdy.
  // Jen když se cílová geometrie opravdu změnila: ResizeObserver hlásí i první pozorování nové položky (právě
  // vybrané záložky) — to by jinak rozjetý přejezd utnulo skokem.
  const ro = win.ResizeObserver ? new win.ResizeObserver(() => {
    const b = boxOf(getActive?.() || null);
    if (b && `${b.x}|${b.y}|${b.w}|${b.h}` === lastBox && !el.classList.contains('uc-slide-off')) return;
    place(false);
  }) : null;
  ro?.observe(container);
  const watch = new Set();
  const observeItem = (a) => { if (ro && a && !watch.has(a)) { watch.add(a); ro.observe(a); } };

  function update({ animate = true } = {}) {
    const a = getActive?.() || null;
    observeItem(a);
    place(animate);
  }
  update({ animate: false });

  return {
    el,
    update,
    destroy() { ro?.disconnect(); win.cancelAnimationFrame(frame); el.remove(); container.classList.remove('uc-slide-host'); },
  };
}
