// Cooldown jako pruh s odpočtem (pokyn usera 2026-09-30) — v panelu SFX i GIF pod stavem odměny a v tooltipu ikony.
// Místo prostého textu „Cooldown 10 s“: vlevo štítek, vpravo barevný odpočet, pod tím pruh, který plynule ubývá.
//   - osobní (kind 'user'): „Osobní cooldown“, fialový gradient (odlišný od oranžového pruhu odměny)
//   - globální (kind 'global'): „Globální cooldown“, modrý gradient (cooldown celého chatu po cizím zvuku)
// Pokus poslat další SFX / GIF během osobního cooldownu → štítek se zatřese a zčervená (jako zámek, shakeLock).
// Sdílené addonem i webem; bez chrome.*, DOM jen přes předané prvky. CSS v soundboard.css (.uc-cd).
import { formatRemaining } from './soundboard.js';

export const COOLDOWN_BAR_CLASS = 'uc-cd';
export const COOLDOWN_LABELS = { user: 'Osobní cooldown', global: 'Globální cooldown' };

/** Kostra řádku (HTML string), schovaná; hodnoty doplní updateCooldownBar. */
export function cooldownBarHtml(kind = 'user') {
  const k = kind === 'global' ? 'global' : 'user';
  return `<div class="${COOLDOWN_BAR_CLASS} ${COOLDOWN_BAR_CLASS}--${k}" data-cd="${k}" role="status" hidden><div class="uc-cd-row"><span class="uc-cd-l">${COOLDOWN_LABELS[k]}</span><span class="uc-cd-t"></span></div><i class="uc-cd-bar"></i></div>`;
}

/**
 * Nastavit zbývající čas a délku pruhu. `remainingMs <= 0` řádek schová. `totalMs` neznámé → pruh plný.
 * Pruh se posouvá přechodem CSS (1 s lineárně = mezi tiky plynule), první zobrazení bez přechodu.
 * @param {HTMLElement} el   kořen (.uc-cd)
 * @returns {boolean} viditelný
 */
export function updateCooldownBar(el, remainingMs, totalMs) {
  if (!el) return false;
  const rem = Math.max(0, Number(remainingMs) || 0);
  if (rem <= 0) { el.hidden = true; el._ucCdShown = false; return false; }
  const total = Number(totalMs) > 0 ? Number(totalMs) : null;
  const p = total ? Math.min(1, rem / total) : 1;
  const t = el.querySelector('.uc-cd-t');
  const bar = el.querySelector('.uc-cd-bar');
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
 * Cooldowny v tooltipu ikony (renderIconTip): `list` = [{ kind, remainingMs, totalMs }]; do `host` vloží / obnoví
 * pruhy podle druhu, ostatní schová. Prvky se drží, ať pruh mezi tiky plynule ubývá.
 */
export function renderCooldownBars(host, list) {
  if (!host) return;
  const want = new Map((list || []).filter((c) => c && c.remainingMs > 0).map((c) => [c.kind === 'global' ? 'global' : 'user', c]));
  for (const kind of ['global', 'user']) {
    let el = host.querySelector(`.${COOLDOWN_BAR_CLASS}[data-cd="${kind}"]`);
    const c = want.get(kind);
    if (!c) { if (el) updateCooldownBar(el, 0); continue; }
    if (!el) { host.insertAdjacentHTML('beforeend', cooldownBarHtml(kind)); el = host.querySelector(`.${COOLDOWN_BAR_CLASS}[data-cd="${kind}"]`); }
    updateCooldownBar(el, c.remainingMs, c.totalMs);
  }
}
