// Plynulý příjezd nové zprávy zespodu: po doscrollování na konec se obsah chatu
// posune o výšku nové zprávy dolů a rychle vyjede zpátky (transition registrované
// CSS proměnné --uc-slide, CSS v sidepanel.css). Víc zpráv rychle za sebou na sebe
// navazuje: nový posun se přičte k právě běžícímu. Sdílené OBS chatem, webem i addonem.

export const SLIDE_IN_MS = 160;

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
