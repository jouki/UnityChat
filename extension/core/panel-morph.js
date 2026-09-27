// Přepnutí mezi panely u pole pro psaní (emoty / GIFy, soundboard, QR dono) — sdílené addonem i webem (test2 bod 5).
//
// Dřív: klik na tlačítko druhého panelu = mousedown mimo první panel ho zavřel, klik druhý otevřel → problikne.
// Teď: otevřený panel se plynule přetvoří do druhého — rámeček nového panelu jede z rozměru a pozice starého na
// svoje (šířka, výška, levý i horní okraj; ~220 ms), starý panel jede stejně a přitom se rozplyne (leží nad novým,
// takže je vidět vždy aspoň jeden, žádná díra).
// Otevření z nuly (spec 2026-09-27-composer-animace-ikony §1): panel vyroste ze svého tlačítka (transform-origin
// = pravý spodní roh / tlačítko, scale 0 → 1 + fade, ~200 ms); zavření obráceně (zmenší se do tlačítka a zmizí).
// Během zavírání je panel „duch“ (uc-morph-ghost): už zavřený (isOpen false), neklikatelný, jen doznívá.
// `prefers-reduced-motion` / bez Web Animations API → vše okamžitě.
//
// Každý panel se zaregistruje (registerPanel) a:
//   - v handleru „klik mimo“ nejdřív `if (entry.isSwitch(target)) return;` (klik na tlačítko jiného panelu starý
//     panel nezavírá — převezme ho nový),
//   - na začátku open() `entry.settle()` (dokončit rozběhnuté zavírání), po zobrazení `entry.opened()` (animace
//     otevření, nebo zavře / přetvoří jiný otevřený panel),
//   - v close() po úklidu `entry.hide(() => panel.classList.add('hidden'), { instant })` (animace zavření);
//     registerPanel dostává `close` bez animace (volá ho přetvoření po doběhnutí).
// Bez chrome.*; DOM jen přes předané prvky.

export const MORPH_MS = 220;
export const MORPH_EASING = 'cubic-bezier(.2, .8, .2, 1)';
export const OPEN_MS = 200;
export const CLOSE_MS = 160;
const OPEN_EASING = 'cubic-bezier(.2, .9, .3, 1.05)';
const CLOSE_EASING = 'cubic-bezier(.4, 0, .9, .6)';

const registries = new WeakMap();   // document → Set<entry>
/** Běžící přetvoření podle prvku (odcházející i příchozí panel) → dokončení. Nové přetvoření / klik ho nejdřív dokončí. */
const running = new WeakMap();

/** Dokončit běžící přetvoření, kterého se prvek účastní (obnoví původní inline styl, zavře odcházející panel). */
export function settleMorph(el) {
  const f = el && running.get(el);
  if (f) f();
}
/** Prvek je právě odcházející „duch“ přetvoření (vizuálně ještě vidět, ale už zavřený). */
export const isMorphGhost = (el) => !!el?.classList?.contains('uc-morph-ghost');

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
  // Rychlé přepínání (A → B → C do 220 ms): předchozí přetvoření nejdřív dokončit — jinak by se jako „původní“ uložil
  // inline stav rozběhnuté animace (pevná geometrie, z-index, pointer-events) a panel by v něm zůstal (review C1).
  settleMorph(from);
  settleMorph(to);
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
    if (running.get(from) === finish) running.delete(from);
    if (running.get(to) === finish) running.delete(to);
    win.clearTimeout(t);
    for (const a of anims) { try { a.cancel(); } catch { /* ignore */ } }
    from.style.cssText = saved[0];
    to.style.cssText = saved[1];
    from.classList.remove('uc-morph-ghost');
    from.removeAttribute('aria-hidden');
    done();
  };
  // Pojistka: kdyby `finished` nepřišel (skrytý dokument), dokončit po duration + rezerva.
  const t = win.setTimeout(finish, duration + 150);
  running.set(from, finish);
  running.set(to, finish);
  return Promise.all(anims.map((a) => a.finished)).catch(() => {}).then(() => { finish(); return true; });
}

/** Bod, ze kterého panel vyrůstá / do kterého se zavře: tlačítko (jeho pravý spodní roh) v souřadnicích panelu. */
function growOrigin(panel, button) {
  const p = panel.getBoundingClientRect();
  const b = button?.getBoundingClientRect?.();
  if (!b?.width || !p.width) return 'right bottom';
  const x = Math.min(p.width, Math.max(0, b.right - p.left));
  const y = Math.min(p.height, Math.max(0, b.bottom - p.top));
  return `${Math.round(x)}px ${Math.round(y)}px`;
}

/**
 * Otevření z nuly: panel (už zobrazený) vyroste z tlačítka — scale 0 → 1 + fade. Inline styl se po doběhnutí vrátí.
 * Vrací Promise<boolean> (false = bez animace).
 */
export function animatePanelIn(panel, { button, duration = OPEN_MS, easing = OPEN_EASING } = {}) {
  settleMorph(panel);
  const win = panel.ownerDocument?.defaultView;
  if (reducedMotion(win) || typeof panel.animate !== 'function' || !panel.getBoundingClientRect?.().width) return Promise.resolve(false);
  const saved = panel.style.transformOrigin;
  panel.style.transformOrigin = growOrigin(panel, button);
  const a = panel.animate([{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration, easing });
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (running.get(panel) === finish) running.delete(panel);
    win.clearTimeout(t);
    try { a.cancel(); } catch { /* ignore */ }
    panel.style.transformOrigin = saved;
  };
  const t = win.setTimeout(finish, duration + 150);
  running.set(panel, finish);
  return a.finished.catch(() => {}).then(() => { finish(); return true; });
}

/**
 * Zavření: panel se zmenší do tlačítka a zmizí, pak `done()` (skrýt). Během animace je „duch“ (zavřený, neklikatelný).
 * `instant` / reduced motion / skrytý panel → `done()` hned.
 */
export function animatePanelOut(panel, { button, done = () => {}, instant = false, duration = CLOSE_MS, easing = CLOSE_EASING } = {}) {
  settleMorph(panel);
  const win = panel.ownerDocument?.defaultView;
  if (instant || reducedMotion(win) || typeof panel.animate !== 'function' || !panel.getBoundingClientRect?.().width) { done(); return Promise.resolve(false); }
  const saved = panel.style.cssText;
  Object.assign(panel.style, { transformOrigin: growOrigin(panel, button), pointerEvents: 'none' });
  // Fokus nesmí zůstat v zavírajícím se panelu (psaní by během animace šlo do jeho hledání) — jako okamžité skrytí.
  const active = panel.ownerDocument.activeElement;
  if (active && active !== panel.ownerDocument.body && panel.contains(active)) active.blur?.();
  panel.classList.add('uc-morph-ghost');
  panel.setAttribute('aria-hidden', 'true');
  const a = panel.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0)', opacity: 0 }], { duration, easing, fill: 'forwards' });
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (running.get(panel) === finish) running.delete(panel);
    win.clearTimeout(t);
    // Nejdřív skrýt (pořád průhledný díky fill), pak zrušit animaci — jinak by panel na snímek problikl.
    panel.classList.remove('uc-morph-ghost');
    panel.removeAttribute('aria-hidden');
    done();
    try { a.cancel(); } catch { /* ignore */ }
    panel.style.cssText = saved;
  };
  const t = win.setTimeout(finish, duration + 150);
  running.set(panel, finish);
  return a.finished.catch(() => {}).then(() => { finish(); return true; });
}

// ---- fokus hledání jen bez dotyku (spec §4) ----
const lastPointer = new WeakMap();   // document → pointerType posledního stisku ('mouse' | 'touch' | 'pen')
function trackPointer(doc) {
  if (!doc || lastPointer.has(doc)) return;
  lastPointer.set(doc, '');
  doc.addEventListener('pointerdown', (e) => { lastPointer.set(doc, e.pointerType || ''); }, { capture: true, passive: true });
}

/**
 * Smí panel po otevření dát fokus do hledání? Na dotyku ne — vyskočila by klávesnice a zakryla panel (regrese proti
 * v3.40.1–4). Rozhoduje skutečný poslední stisk (dotyk / pero = ne, myš = ano — i na notebooku s dotykovou
 * obrazovkou), bez stisku (klávesnice) primární ukazatel zařízení (`pointer: coarse` = ne).
 */
export function canAutoFocus(doc) {
  trackPointer(doc);
  const t = lastPointer.get(doc);
  if (t === 'touch' || t === 'pen') return false;
  if (t === 'mouse') return true;
  const win = doc?.defaultView;
  try { return !win?.matchMedia?.('(pointer: coarse)').matches; } catch { return true; }
}

/**
 * Po zavření panelu Escem vrátit fokus do pole pro psaní (jako emoty) — pole najde podle tlačítka panelu
 * (tlačítka jsou v .msg-input-wrap) nebo dostane `field`. Na dotyku ne: vyskočila by klávesnice.
 */
export function refocusField(button, field = null) {
  const doc = button?.ownerDocument;
  const f = field || button?.closest?.('.msg-input-wrap')?.querySelector('textarea');
  if (!doc || !f || f.disabled || f.classList.contains('hidden') || !canAutoFocus(doc)) return false;
  try { f.focus({ preventScroll: true }); } catch { return false; }
  return doc.activeElement === f;
}

/** Panel je otevřený: zobrazený (bez `hidden`) a ne odcházející duch (zavírání / přetvoření). */
export const panelShown = (panel) => !!panel && !panel.classList.contains('hidden') && !isMorphGhost(panel);

/**
 * Zaregistrovat panel. `panel` = kontejner panelu, `button` = jeho tlačítko (nebo funkce, která vrací to právě platné —
 * panel emotů otevřený na záložce SFX patří notě), `isOpen()`, `close()` (okamžité zavření). `extraButtons` = další
 * tlačítka, která panel otevírají (nota → záložka SFX): klik na ně jiný otevřený panel nezavře, ale přetvoří.
 * Vrací { isSwitch(target), settle(), opened(), hide(done, { instant }), unregister() }.
 */
export function registerPanel({ panel, button, extraButtons = [], isOpen, close, log }) {
  const doc = panel.ownerDocument;
  trackPointer(doc);
  let reg = registries.get(doc);
  if (!reg) { reg = new Set(); registries.set(doc, reg); }
  const btnOf = () => (typeof button === 'function' ? button() : button);
  const entry = {
    panel, close,
    get button() { return btnOf(); },
    buttons: () => [btnOf(), ...extraButtons].filter(Boolean),
    /** Otevřený = viditelný a ne odcházející duch přetvoření (review I1: klik na A během A → B ho má otevřít). */
    isOpen: () => !isMorphGhost(panel) && isOpen(),
    /** Před přepnutím / otevřením: dokončit přetvoření nebo zavírání, kterého se panel účastní. */
    settle() { settleMorph(panel); },
    /** Klik (mousedown) na tlačítko jiného panelu → nezavírat, nový panel tenhle přetvoří. */
    isSwitch(target) {
      for (const o of reg) if (o !== entry && target && o.buttons().some((b) => b.contains?.(target))) return true;
      return false;
    },
    /** Právě jsem se zobrazil → jiné otevřené panely přetvořit do mě (první) / zavřít (ostatní); jinak vyrůst z tlačítka. */
    opened() {
      // Rozběhnutá přetvoření / zavírání dokončit dřív, než se změří (duchové se zavřou, styly vrátí).
      for (const o of reg) if (o !== entry) settleMorph(o.panel);
      const others = [...reg].filter((o) => o !== entry && o.panel.isConnected && safeOpen(o));
      if (!others.length) return animatePanelIn(panel, { button: btnOf() });
      const [first, ...rest] = others;
      for (const o of rest) safeClose(o);
      // Aktivní tlačítko (a posuvný indikátor u ikon) přejde na nový panel hned, ne až po doběhnutí přetvoření.
      first.button?.classList?.remove('active');
      first.button?.setAttribute?.('aria-expanded', 'false');
      return morphPanels(first.panel, panel, { done: () => safeClose(first), log });
    },
    /** Zavřít s animací do tlačítka; `done` = skutečné skrytí (třída hidden). */
    hide(done, { instant = false } = {}) { return animatePanelOut(panel, { button: btnOf(), done, instant }); },
    unregister() { reg.delete(entry); },
  };
  reg.add(entry);
  return entry;
}

const safeOpen = (o) => { try { return !!o.isOpen(); } catch { return false; } };
const safeClose = (o) => { try { o.close(); } catch { /* ignore */ } };
