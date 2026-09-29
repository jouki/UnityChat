// Plynulá změna výšky zprávy (smazání / schování / odkrytí, pokyn usera 2026-09-28): host změní DOM
// (např. applyDeleted → štítek „Zpráva smazána“, OBS `hidden`, čekající GIF `uc-gif-held`, médium pryč)
// a element se místo skoku sbalí / roztáhne z původní výšky na novou. Cíl 0 (display: none) se dohraje
// s dočasně vynuceným zobrazením (`.uc-h-anim`, moderation.css) a průhledností. Bez rozdílu výšky nic.
// Sdílené OBS chatem, webem i addonem. Bez chrome.*, DOM jen přes předaný element.

import { scrollToBottom } from './slide-in.js';

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
 * Držet chat na konci po dobu změny výšky zprávy uvnitř (obnovená zpráva se rozbalí → konec chatu by utekl pod
 * okraj, dokud nepřijde další zpráva — hlášení usera 2026-09-29). Dorovnává se před každým snímkem
 * (requestAnimationFrame) a navíc časovačem — OBS pouští snímky pozdě. `isPinned()` = host pořád drží konec (uživatel mezitím neodjel nahoru).
 * @param {HTMLElement} chatEl
 * @param {{ms?: number, isPinned?: () => boolean, onPin?: () => void}} [o]
 */
export function holdBottom(chatEl, { ms = HEIGHT_ANIM_MS + 80, isPinned = () => true, onPin } = {}) {
  if (!chatEl) return;
  const win = chatEl.ownerDocument.defaultView;
  const end = win.performance.now() + ms;
  clearTimeout(chatEl._ucHoldTimer);
  const run = (chatEl._ucHoldRun || 0) + 1;
  chatEl._ucHoldRun = run;
  const pin = () => {
    if (chatEl._ucHoldRun !== run || !chatEl.isConnected || !isPinned()) return false;
    onPin?.();
    scrollToBottom(chatEl);
    return win.performance.now() < end;
  };
  const tick = () => { if (pin()) chatEl._ucHoldTimer = setTimeout(tick, 16); };
  const frame = () => { if (pin()) win.requestAnimationFrame?.(frame); };
  tick();
  win.requestAnimationFrame?.(frame);
}

/**
 * `animateHeightChange` + držení konce chatu, když ho host držel před změnou (`pinned`).
 * @param {HTMLElement} chatEl
 * @param {HTMLElement} el
 * @param {() => void} mutate
 * @param {{pinned?: boolean, isPinned?: () => boolean, onPin?: () => void, durationMs?: number, reducedMotion?: boolean}} [o]
 */
export function changeHeightPinned(chatEl, el, mutate, { pinned = false, isPinned, onPin, ...anim } = {}) {
  animateHeightChange(el, mutate, anim);
  if (pinned) holdBottom(chatEl, { ms: (anim.durationMs ?? HEIGHT_ANIM_MS) + 80, isPinned, onPin });
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
