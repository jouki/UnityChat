// Ikony v poli pro psaní (QR dono, soundboard, emoty) — addon i web (spec 2026-09-27-composer-animace-ikony §3).
// Všechny tři ikony jsou VŽDY uvnitř pole pro psaní (samostatný řádek s ikonami zmizel; řádek bodů/bitů Twitche
// v addonu je jiný prvek a zůstává). Dock je skládá zprava doleva (smajlík, nota, QR), dopočítá jim `right`
// a poli rezervu vpravo (--uc-tools-w). Ikona s `minWidth` (QR) ustoupí psaní:
//   - dotykové zařízení (pointer: coarse): schová se, dokud je pole ve fokusu (klávesnice nahoře);
//   - jinak: jen když je v poli napsaný text A pole je užší než `minWidth` (práh QR 330 px).
// Schování je animované (šířka + průhlednost), ikony vlevo od ní plynule dojedou (transition na `right`).
// Aktivní ikonu otevřeného panelu (třída .active) zvýrazňuje posuvný indikátor (core/slide-indicator.js).
// `prefers-reduced-motion` → bez přechodů (CSS).

import { createSlideIndicator } from './slide-indicator.js';

/** Šířka jedné ikony + mezera (26 px + 2 px) a okraj od pravé hrany pole. */
export const TOOL_STEP = 28;
export const TOOL_EDGE = 4;

/**
 * Má ikona teď ustoupit psaní? `touch` = dotykové zařízení (schovat při fokusu pole),
 * jinak schovat, když je v poli text a pole je užší než `minWidth`.
 */
export function toolYields({ minWidth, width, hasText, focused, touch }) {
  if (!Number.isFinite(minWidth) || minWidth <= 0) return false;
  if (touch) return !!focused;
  return !!hasText && width < minWidth;
}

/**
 * Rozložení zprava doleva: `slots` = [{ shown, collapsed }] v pořadí zleva doprava. Vrací { rights: number[], used }
 * — `right` (px) každé ikony a počet míst, která ikony zabírají (schovaná / sbalená ikona místo nezabírá; sbalená
 * stojí tam, kde by byla, ať se sbalí na místě).
 */
export function layoutTools(slots) {
  const rights = new Array(slots.length).fill(TOOL_EDGE);
  let used = 0;
  for (let i = slots.length - 1; i >= 0; i--) {
    rights[i] = TOOL_EDGE + used * TOOL_STEP;
    if (slots[i].shown && !slots[i].collapsed) used++;
  }
  return { rights, used };
}

/** Rezerva vpravo v poli pro psaní (padding-right textarey) pro `used` ikon. */
export const toolsPadding = (used) => (used ? TOOL_EDGE + used * TOOL_STEP + 2 : 8);

/**
 * @param {object} o
 * @param {HTMLElement} o.inlineParent   kontejner pole pro psaní (.msg-input-wrap, position: relative)
 * @param {HTMLTextAreaElement} [o.input] pole pro psaní (výchozí: textarea v inlineParent)
 * @param {Array<{ button: HTMLElement, minWidth?: number | (() => number), available?: () => boolean, collapse?: () => boolean }>} o.items
 *        v pořadí zleva doprava. `available` = dock tlačítko i skrývá (atribut hidden); bez něj skrytí řeší
 *        hostitel (nota bez soundboardu má třídu hidden). `minWidth` = práh, pod kterým ikona ustoupí psaní.
 *        `collapse` = ikona se animovaně sbalí / objeví jako QR (nota jen s aktivní odměnou; hostitel mění třídu
 *        tlačítka, dock ji sleduje).
 * @param {() => boolean} [o.touch]      dotykové zařízení (výchozí: matchMedia('(pointer: coarse)'))
 * (Staré volby `row`, `rowHasOther`, `inlineVisible` se ignorují — řádek s ikonami už není.)
 */
export function createToolDock({ inlineParent, input, items, touch } = {}) {
  const doc = inlineParent.ownerDocument;
  const win = doc.defaultView;
  const field = input || inlineParent.querySelector('textarea');
  const isTouch = touch || (() => { try { return !!win.matchMedia?.('(pointer: coarse)').matches; } catch { return false; } });
  inlineParent.classList.add('uc-tools');
  let lastActive = null;
  const slide = createSlideIndicator({ container: inlineParent, getActive: () => lastActive, className: 'uc-slide-ind--tool' });

  const shownNow = (b) => !b.hidden && !b.classList.contains('hidden');
  function pickActive() {
    const act = items.map((it) => it.button).filter((b) => b.classList.contains('active') && shownNow(b));
    // Nově aktivní má přednost (přepnutí panelu: nový dostane .active dřív, než starý zmizí).
    if (!act.includes(lastActive)) lastActive = act.at(-1) || null;
    for (const b of act) if (!b._ucWasActive) lastActive = b;
    for (const it of items) it.button._ucWasActive = it.button.classList.contains('active');
  }

  let noAnim = true;
  function update() {
    const width = inlineParent.getBoundingClientRect().width;
    const hasText = !!field?.value?.trim();
    const focused = !!field && doc.activeElement === field;
    const t = isTouch();
    const slots = items.map((it) => {
      const b = it.button;
      if (it.available) {
        const want = !it.available();
        if (b.hidden !== want) b.hidden = want;
      }
      const shown = shownNow(b);
      const minWidth = typeof it.minWidth === 'function' ? it.minWidth() : it.minWidth;
      // Ikona otevřeného panelu neustupuje (zavřela by se pod rukama).
      const collapsed = shown && !b.classList.contains('active') && (!!it.collapse?.() || toolYields({ minWidth, width, hasText, focused, touch: t }));
      return { shown, collapsed };
    });
    const { rights, used } = layoutTools(slots);
    items.forEach((it, i) => {
      const b = it.button;
      b.classList.toggle('uc-dock-inline', true);
      b.classList.toggle('uc-tool-collapsed', slots[i].collapsed);
      if (slots[i].collapsed) b.setAttribute('aria-hidden', 'true'); else b.removeAttribute('aria-hidden');
      b.tabIndex = slots[i].collapsed ? -1 : 0;
      const r = `${rights[i]}px`;
      if (b.style.right !== r) b.style.right = r;
    });
    inlineParent.style.setProperty('--uc-tools-w', `${toolsPadding(used)}px`);
    pickActive();
    slide.update();
    if (noAnim) { noAnim = false; win.requestAnimationFrame(() => win.requestAnimationFrame(() => inlineParent.classList.remove('uc-tools-noanim'))); }
  }
  inlineParent.classList.add('uc-tools-noanim');

  const ro = new win.ResizeObserver(() => update());
  ro.observe(inlineParent);
  // Nota / QR se objeví nebo zmizí (hostitel), panel se otevře / zavře (.active) → přeskládat, posunout indikátor.
  const mo = new win.MutationObserver(() => update());
  for (const it of items) mo.observe(it.button, { attributes: true, attributeFilter: ['class', 'hidden'] });
  const onField = () => update();
  // keyup: odeslání Enterem pole vyprázdní bez události input.
  const FIELD_EVENTS = ['input', 'focus', 'blur', 'keyup', 'change'];
  for (const n of FIELD_EVENTS) field?.addEventListener(n, onField);
  // Ikona dojela na nové místo → indikátor za ní.
  const onEnd = (e) => { if (e.propertyName === 'right' && e.target === lastActive) slide.update(); };
  inlineParent.addEventListener('transitionend', onEnd);
  update();

  return {
    /** Po změně dostupnosti (přihlášení, dary v kanálu), textu nastaveného z kódu apod. zavolat update(). */
    update,
    destroy() {
      ro.disconnect(); mo.disconnect(); slide.destroy();
      for (const n of FIELD_EVENTS) field?.removeEventListener(n, onField);
      inlineParent.removeEventListener('transitionend', onEnd);
      inlineParent.classList.remove('uc-tools');
    },
  };
}
