// Cooldown jako pruh s odpočtem (pokyn usera 2026-09-30) — v panelu SFX i GIF pod stavem odměny a v tooltipu ikony.
// Místo prostého textu „Cooldown 10 s“: vlevo štítek, vpravo barevný odpočet, pod tím fialový pruh (odlišný od
// oranžového pruhu odměny), který plynule ubývá. Vždy JEDEN pruh = delší z osobního a globálního cooldownu
// (upřesnění usera 2026-09-30): kdo má delší osobní, na globální nečeká; kdo má kratší, čeká stejně na globální;
// pozorovatel bez vlastního vidí globální. Štítek říká, který to je („Osobní cooldown“ / „Globální cooldown“).
// Pokus poslat další SFX / GIF během cooldownu → štítek se zatřese a zčervená (jako zámek, shakeLock).
// Sdílené addonem i webem; bez chrome.*, DOM jen přes předané prvky. CSS v soundboard.css (.uc-cd).
import { formatRemaining } from './soundboard.js';

export const COOLDOWN_BAR_CLASS = 'uc-cd';
export const COOLDOWN_LABELS = { user: 'Osobní cooldown', global: 'Globální cooldown' };

/** Delší z cooldownů (`list` = [{ kind, remainingMs, totalMs }]); při shodě globální. null = žádný. */
export function pickCooldown(list) {
  let best = null;
  for (const c of list || []) {
    if (!c || !(c.remainingMs > 0)) continue;
    if (!best || c.remainingMs > best.remainingMs || (c.remainingMs === best.remainingMs && c.kind === 'global')) best = c;
  }
  return best;
}

/** Podíl zbývajícího času (0–1) pro pásek na ikoně; bez známé délky 1. */
export function cooldownProgress(c) {
  if (!c || !(c.remainingMs > 0)) return null;
  return c.totalMs > 0 ? Math.min(1, c.remainingMs / c.totalMs) : 1;
}

/** Kostra řádku (HTML string), schovaná; hodnoty (i druh) doplní updateCooldownBar. */
export function cooldownBarHtml(kind = 'user') {
  const k = kind === 'global' ? 'global' : 'user';
  return `<div class="${COOLDOWN_BAR_CLASS}" data-cd="${k}" role="status" hidden><div class="uc-cd-row"><span class="uc-cd-l">${COOLDOWN_LABELS[k]}</span><span class="uc-cd-t"></span></div><i class="uc-cd-bar"></i></div>`;
}

/**
 * Nastavit zbývající čas a délku pruhu. `remainingMs <= 0` řádek schová. `totalMs` neznámé → pruh plný.
 * Pruh se posouvá přechodem CSS (1 s lineárně = mezi tiky plynule), první zobrazení bez přechodu.
 * @param {HTMLElement} el   kořen (.uc-cd)
 * @returns {boolean} viditelný
 */
export function updateCooldownBar(el, remainingMs, totalMs, kind = null) {
  if (!el) return false;
  const rem = Math.max(0, Number(remainingMs) || 0);
  if (rem <= 0) { el.hidden = true; el._ucCdShown = false; return false; }
  const total = Number(totalMs) > 0 ? Number(totalMs) : null;
  const p = total ? Math.min(1, rem / total) : 1;
  const t = el.querySelector('.uc-cd-t');
  const bar = el.querySelector('.uc-cd-bar');
  if (kind && el.dataset.cd !== kind) { el.dataset.cd = kind; const l = el.querySelector('.uc-cd-l'); if (l) l.textContent = COOLDOWN_LABELS[kind] || COOLDOWN_LABELS.user; }
  if (t) t.textContent = formatRemaining(rem);
  if (bar) {
    if (!el._ucCdShown) { bar.classList.add('uc-cd-jump'); void bar.offsetWidth; }
    bar.style.setProperty('--p', p.toFixed(4));
    if (!el._ucCdShown) { void bar.offsetWidth; bar.classList.remove('uc-cd-jump'); }
  }
  el.hidden = false;
  el._ucCdShown = true;
  return true;
}

/** Pokus během cooldownu: štítek se zatřese a zčervená, pak se vrátí (restart animace při opakování). */
export function shakeCooldownLabel(el) {
  const l = el?.querySelector?.('.uc-cd-l');
  if (!l) return;
  l.classList.remove('uc-cd-shake');
  void l.offsetWidth;
  l.classList.add('uc-cd-shake');
  if (!l._ucShakeEnd) {
    l._ucShakeEnd = () => l.classList.remove('uc-cd-shake');
    l.addEventListener('animationend', l._ucShakeEnd);
  }
}

/**
 * Délka cooldownu pro pruh, když ji server neposílá: zapamatovat si konec, když se poprvé objeví
 * (nebo posune), a měřit od té chvíle. `mem` = objekt hostitele ({ until, start }).
 */
export function cooldownTotal(mem, untilMs, now) {
  if (!Number.isFinite(untilMs) || untilMs <= now) { mem.until = null; return null; }
  if (mem.until === null || mem.until === undefined || Math.abs(mem.until - untilMs) > 1500) { mem.until = untilMs; mem.start = now; }
  return Math.max(1000, untilMs - mem.start);
}

/**
 * Cooldown v tooltipu ikony (renderIconTip): `list` = [{ kind, remainingMs, totalMs }] → jeden pruh (pickCooldown)
 * v `host`; prvek se drží, ať pruh mezi tiky plynule ubývá.
 */
export function renderCooldownBars(host, list) {
  if (!host) return;
  const c = pickCooldown(list);
  let el = host.querySelector(`.${COOLDOWN_BAR_CLASS}`);
  if (!c) { if (el) updateCooldownBar(el, 0); return; }
  if (!el) { host.insertAdjacentHTML('beforeend', cooldownBarHtml(c.kind)); el = host.querySelector(`.${COOLDOWN_BAR_CLASS}`); }
  updateCooldownBar(el, c.remainingMs, c.totalMs, c.kind === 'global' ? 'global' : 'user');
}
