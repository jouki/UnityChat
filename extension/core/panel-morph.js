// Přepnutí mezi panely u pole pro psaní (emoty / GIFy, soundboard, QR dono) — sdílené addonem i webem (test2 bod 5).
//
// Dřív: klik na tlačítko druhého panelu = mousedown mimo první panel ho zavřel, klik druhý otevřel → problikne.
// Teď: otevřený panel se plynule přetvoří do druhého — rámeček nového panelu jede z rozměru a pozice starého na
// svoje (šířka, výška, levý i horní okraj; ~220 ms), starý panel jede stejně a přitom se rozplyne (leží nad novým,
// takže je vidět vždy aspoň jeden, žádná díra). Otevření z nuly a zavření zůstávají okamžité.
// `prefers-reduced-motion` / bez Web Animations API → okamžitá výměna.
//
// Každý panel se zaregistruje (registerPanel) a:
//   - v handleru „klik mimo“ nejdřív `if (entry.isSwitch(target)) return;` (klik na tlačítko jiného panelu starý
//     panel nezavírá — převezme ho nový),
//   - v open() po zobrazení `entry.opened()` (zavře / přetvoří jiný otevřený panel).
// Bez chrome.*; DOM jen přes předané prvky.

export const MORPH_MS = 220;
export const MORPH_EASING = 'cubic-bezier(.2, .8, .2, 1)';

const registries = new WeakMap();   // document → Set<entry>

function reducedMotion(win) {
  try { return !!win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/** Obdélník `r` (viewport) v souřadnicích offsetParent prvku `el` (pro left / top absolutně umístěného panelu). */
export function rectInParent(el, r) {
  const p = el.offsetParent;
  const pr = p ? p.getBoundingClientRect() : { left: 0, top: 0 };
  return { left: r.left - pr.left - (p?.clientLeft || 0), top: r.top - pr.top - (p?.clientTop || 0), width: r.width, height: r.height };
}

const px = (b) => ({ left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
/** Pevná geometrie během animace (panely jsou kotvené bottom / right a mají max-* a marginy). */
const PIN = { right: 'auto', bottom: 'auto', margin: '0', boxSizing: 'border-box', maxWidth: 'none', maxHeight: 'none', minWidth: '0', minHeight: '0' };

/**
 * Přetvoření `from` (otevřený) → `to` (právě zobrazený). Po doběhnutí `done()` (zavře starý panel). Vrací Promise.
 * Bez animace (reduced motion, chybí rozměry / API) zavolá `done()` hned.
 */
export function morphPanels(from, to, { duration = MORPH_MS, easing = MORPH_EASING, done = () => {}, log } = {}) {
  const win = to.ownerDocument?.defaultView;
  const ra = from.getBoundingClientRect?.();
  const rb = to.getBoundingClientRect?.();
  if (reducedMotion(win) || typeof to.animate !== 'function' || typeof from.animate !== 'function' || !ra?.width || !rb?.width) {
    done();
    return Promise.resolve(false);
  }
  const saved = [from, to].map((el) => el.style.cssText);
  const aFrom = rectInParent(from, ra), aTo = rectInParent(from, rb);
  const bFrom = rectInParent(to, ra), bTo = rectInParent(to, rb);
  Object.assign(from.style, PIN, px(aFrom), { zIndex: '60', pointerEvents: 'none' });
  // Odcházející panel je jen „duch“ nad novým (rozplývá se) — pro čtečky i testy už není panel.
  from.classList.add('uc-morph-ghost');
  from.setAttribute('aria-hidden', 'true');
  Object.assign(to.style, PIN, px(bTo));
  log?.(`morph ${Math.round(ra.width)}×${Math.round(ra.height)} → ${Math.round(rb.width)}×${Math.round(rb.height)}`);
  const opts = { duration, easing, fill: 'forwards' };
  const anims = [
    to.animate([px(bFrom), px(bTo)], opts),
    from.animate([{ ...px(aFrom), opacity: 1 }, { ...px(aTo), opacity: 0 }], opts),
  ];
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    for (const a of anims) { try { a.cancel(); } catch { /* ignore */ } }
    from.style.cssText = saved[0];
    to.style.cssText = saved[1];
    from.classList.remove('uc-morph-ghost');
    from.removeAttribute('aria-hidden');
    done();
  };
  // Pojistka: kdyby `finished` nepřišel (skrytý dokument), dokončit po duration + rezerva.
  const t = win.setTimeout(finish, duration + 150);
  return Promise.all(anims.map((a) => a.finished)).catch(() => {}).then(() => { win.clearTimeout(t); finish(); return true; });
}

/**
 * Zaregistrovat panel. `panel` = kontejner panelu, `button` = jeho tlačítko, `isOpen()`, `close()` (okamžité zavření).
 * Vrací { isSwitch(target), opened(), unregister(), morphing }.
 */
export function registerPanel({ panel, button, isOpen, close, log }) {
  const doc = panel.ownerDocument;
  let reg = registries.get(doc);
  if (!reg) { reg = new Set(); registries.set(doc, reg); }
  const entry = {
    panel, button, isOpen, close,
    /** Klik (mousedown) na tlačítko jiného panelu → nezavírat, nový panel tenhle přetvoří. */
    isSwitch(target) {
      for (const o of reg) if (o !== entry && o.button && target && o.button.contains?.(target)) return true;
      return false;
    },
    /** Právě jsem se zobrazil → jiné otevřené panely přetvořit do mě (první) / zavřít (ostatní). */
    opened() {
      const others = [...reg].filter((o) => o !== entry && o.panel.isConnected && safeOpen(o));
      if (!others.length) return null;
      const [first, ...rest] = others;
      for (const o of rest) safeClose(o);
      return morphPanels(first.panel, panel, { done: () => safeClose(first), log });
    },
    unregister() { reg.delete(entry); },
  };
  reg.add(entry);
  return entry;
}

const safeOpen = (o) => { try { return !!o.isOpen(); } catch { return false; } };
const safeClose = (o) => { try { o.close(); } catch { /* ignore */ } };
