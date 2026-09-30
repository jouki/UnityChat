// Nová verze UnityChatu (addon i web, pokyn usera 2026-09-27): tlačítko obnovení v hlavičce se rozsvítí s výrazným
// animovaným glow a hover textem. Addon: Chrome stáhl novou verzi z obchodu (runtime.onUpdateAvailable) → klik ji
// nainstaluje (runtime.reload). Web: nasazený index.html odkazuje na jiný hlavní bundle, než běží → klik = reload.
// Vzhled: třída `uc-update-ready` (sidepanel.css), `prefers-reduced-motion` → glow bez pulzování.

export const UPDATE_READY_CLASS = 'uc-update-ready';

/** Hover text podle varianty. */
export const UPDATE_TEXT = {
  web: 'Nová verze UnityChatu. Aktualizuj web!',
  addon: 'Nová verze UnityChatu. Aktualizuj addon!',
};

/**
 * Rozsvítit tlačítko obnovení (idempotentní). Původní title / aria-label si pamatuje pro `clearUpdateReady`.
 * @param {HTMLElement|null} button
 * @param {'web'|'addon'} kind
 * @returns {boolean} true = právě se rozsvítilo (dřív nesvítilo)
 */
export function markUpdateReady(button, kind) {
  if (!button) return false;
  const text = UPDATE_TEXT[kind] || UPDATE_TEXT.web;
  const was = button.classList.contains(UPDATE_READY_CLASS);
  if (!was) {
    button.dataset.ucTitle = button.getAttribute('title') || '';
    button.dataset.ucLabel = button.getAttribute('aria-label') || '';
  }
  button.classList.add(UPDATE_READY_CLASS);
  button.setAttribute('title', text);
  button.setAttribute('aria-label', text);
  return !was;
}

/** Vrátit tlačítko do běžného stavu. */
export function clearUpdateReady(button) {
  if (!button?.classList.contains(UPDATE_READY_CLASS)) return;
  button.classList.remove(UPDATE_READY_CLASS);
  const t = button.dataset.ucTitle, l = button.dataset.ucLabel;
  if (t) button.setAttribute('title', t); else button.removeAttribute('title');
  if (l) button.setAttribute('aria-label', l); else button.removeAttribute('aria-label');
}

/** Cesta hlavního bundle webu z HTML (`…/assets/main-<hash>.js`), jinak null. */
export function mainBundleOf(html) {
  const m = /<script\b[^>]*\bsrc="([^"]*\/assets\/main-[\w-]+\.js)"/.exec(String(html || ''));
  return m ? m[1] : null;
}

/**
 * Je nasazená jiná verze webu? `currentSrc` = src hlavního bundle, který běží (atribut script), `html` = čerstvě
 * stažený index.html. Neznámé (nejde přečíst / chybí bundle) = false — radši nesvítit, než svítit naprázdno.
 */
export function isNewWebVersion(currentSrc, html) {
  const next = mainBundleOf(html);
  if (!next || !currentSrc) return false;
  const norm = (s) => String(s).replace(/^https?:\/\/[^/]+/, '');
  return norm(next) !== norm(currentSrc);
}
