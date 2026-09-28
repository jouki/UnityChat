// Plynulá změna výšky zprávy (smazání / schování / odkrytí, pokyn usera 2026-09-28): host změní DOM
// (např. applyDeleted → štítek „Zpráva smazána“, OBS `hidden`, čekající GIF `uc-gif-held`, médium pryč)
// a element se místo skoku sbalí / roztáhne z původní výšky na novou. Cíl 0 (display: none) se dohraje
// s dočasně vynuceným zobrazením (`.uc-h-anim`, moderation.css) a průhledností. Bez rozdílu výšky nic.
// Sdílené OBS chatem, webem i addonem. Bez chrome.*, DOM jen přes předaný element.

export const HEIGHT_ANIM_MS = 160;
const EASE = 'cubic-bezier(0.45, 0, 0.25, 1)';
const BOX = ['paddingTop', 'paddingBottom', 'marginTop', 'marginBottom'];

const reduced = (win) => { try { return !!win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

/** Zrušit běžící animaci výšky (element zůstane ve stavu, který mu dal host — např. po odkrytí). */
export function cancelHeightAnim(el) {
  const a = el?._ucHeightAnim;
  if (a) { try { a.cancel(); } catch { /* ignore */ } }
}

/**
 * Provede `mutate()` a rozdíl výšky elementu zvíře (Web Animations API). Element odpojený z DOM, bez podpory
 * animací nebo při „omezit animace“ → jen `mutate()`. Opakované volání během animace naváže z aktuální výšky.
 * @param {HTMLElement} el
 * @param {() => void} mutate
 * @param {{durationMs?: number, reducedMotion?: boolean}} [o]
 */
export function animateHeightChange(el, mutate, { durationMs = HEIGHT_ANIM_MS, reducedMotion } = {}) {
  if (!el || typeof el.animate !== 'function' || !el.isConnected) { mutate(); return; }
  const win = el.ownerDocument.defaultView;
  if (reducedMotion ?? reduced(win)) { mutate(); return; }
  // Běžící animace → výchozí výška je ta právě vykreslená.
  const h0 = el.getBoundingClientRect().height;
  cancelHeightAnim(el);
  mutate();
  const goneAfter = win.getComputedStyle(el).display === 'none';
  el.classList.add('uc-h-anim');
  const h1 = goneAfter ? 0 : el.getBoundingClientRect().height;
  if (Math.abs(h1 - h0) < 1) { el.classList.remove('uc-h-anim'); return; }
  const cs = win.getComputedStyle(el);
  const box = Object.fromEntries(BOX.map((k) => [k, cs[k]]));
  const zero = Object.fromEntries(BOX.map((k) => [k, '0px']));
  const from = { height: `${h0}px`, opacity: h0 === 0 ? 0 : 1, ...(h0 === 0 ? zero : box) };
  const to = { height: `${h1}px`, opacity: h1 === 0 ? 0 : 1, ...(h1 === 0 ? zero : box) };
  // Výška z getBoundingClientRect je border-box; `.msg` má padding → po dobu animace border-box.
  el.style.boxSizing = 'border-box';
  const anim = el.animate([from, to], { duration: durationMs, easing: EASE, fill: 'none' });
  el._ucHeightAnim = anim;
  const done = () => {
    if (el._ucHeightAnim !== anim) return;
    el._ucHeightAnim = null;
    el.classList.remove('uc-h-anim');
    el.style.boxSizing = '';
  };
  anim.onfinish = done;
  anim.oncancel = done;
}
