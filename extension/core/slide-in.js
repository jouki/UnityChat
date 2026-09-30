// Plynulý příjezd nové zprávy zespodu: po doscrollování na konec se obsah chatu
// posune o výšku nové zprávy dolů a rychle vyjede zpátky (transition registrované
// CSS proměnné --uc-slide, CSS v sidepanel.css). Víc zpráv rychle za sebou na sebe
// navazuje: nový posun se přičte k právě běžícímu. Sdílené OBS chatem, webem i addonem.

export const SLIDE_IN_MS = 160;

/** Aktuální posun běžící animace v px (0 mimo animaci). */
export function slideOffset(chatEl) {
  if (!chatEl?.classList.contains('uc-sliding')) return 0;
  const win = chatEl.ownerDocument.defaultView;
  return parseFloat(win.getComputedStyle(chatEl).getPropertyValue('--uc-slide')) || 0;
}

/**
 * O kolik px je scrollHeight během animace větší než bez ní: transformovaný rámeček poslední zprávy přečnívá
 * o posun dolů, ale nepočítá se mu spodní margin ani spodní padding chatu (ty už v overflow jsou). Měřeno 2026-09-28:
 * posun 29,5 px, padding 2 px → scrollHeight +27,5 px.
 */
export function slideInflation(chatEl) {
  const off = slideOffset(chatEl);
  if (!off) return 0;
  const win = chatEl.ownerDocument.defaultView;
  const last = chatEl.lastElementChild;
  const pb = parseFloat(win.getComputedStyle(chatEl).paddingBottom) || 0;
  const mb = last ? (parseFloat(win.getComputedStyle(last).marginBottom) || 0) : 0;
  return Math.max(0, off - pb - mb);
}

/**
 * Posun na skutečný konec chatu. Během animace odečte její nafouknutí scrollHeight — holé `scrollTop = scrollHeight`
 * skočilo rovnou na konec animace (dočtení badge / emotu nové zprávy, další zpráva v řadě) a z příjezdu zbylo jen
 * bliknutí (OBS chat, měřeno 2026-09-28). Používat všude místo `scrollTop = scrollHeight`.
 */
export function scrollToBottom(chatEl) {
  chatEl.scrollTop = chatEl.scrollHeight - chatEl.clientHeight - slideInflation(chatEl);
}

/**
 * Zavolat hned po nastavení scrollTop na konec (ve stejném snímku), jinak by obsah
 * na jeden snímek poskočil.
 * @param {HTMLElement} chatEl  scroll kontejner (#chat)
 * @param {HTMLElement} msgEl   právě přidaná zpráva na konci
 */
export function slideInMessage(chatEl, msgEl, { durationMs = SLIDE_IN_MS, reducedMotion } = {}) {
  if (!chatEl || !msgEl || !msgEl.isConnected) return;
  const win = chatEl.ownerDocument.defaultView;
  const reduce = reducedMotion ?? !!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduce) return;
  const cs = win.getComputedStyle(msgEl);
  const h = msgEl.getBoundingClientRect().height + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
  if (!(h > 0)) return;
  // Navázat na rozběhnutý posun (registrovaná proměnná vrací aktuální mezihodnotu).
  const running = chatEl.classList.contains('uc-sliding')
    ? parseFloat(win.getComputedStyle(chatEl).getPropertyValue('--uc-slide')) || 0
    : 0;
  const from = Math.min(running + h, chatEl.clientHeight || running + h);
  chatEl.style.setProperty('--uc-slide-ms', `${durationMs}ms`);
  chatEl.classList.add('uc-sliding', 'uc-slide-jump');
  chatEl.style.setProperty('--uc-slide', `${from}px`);
  void chatEl.offsetHeight;   // start bez přechodu
  chatEl.classList.remove('uc-slide-jump');
  chatEl.style.setProperty('--uc-slide', '0px');
  clearTimeout(chatEl._ucSlideTimer);
  // Transform jen během animace: trvalý transform na zprávách by rozbil position:fixed potomků.
  chatEl._ucSlideTimer = setTimeout(() => chatEl.classList.remove('uc-sliding'), durationMs + 60);
}
