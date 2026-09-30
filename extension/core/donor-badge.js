// Odznak dárce (pokyn usera 2026-09-30, podklady artifacts/donor-badges-v2/unitychat-donor-motion-v4): čtyři varianty,
// zatím jedna společná pro celý kanál — vybírá mod / streamer v nastavení (sekce Účet → Odznaky), uloženo na serveru
// (routes/channelPrefs.ts `donorBadge`), změna jde všem SSE `channel-prefs`. Individuální volba přijde, až user rozhodne.
// Soubory: extension/icons/badges/donor/<id>/{animated,static}.svg (20×20, 3s smyčka). Sdílené addonem i webem —
// cestu k souboru dodá hostitel (`assetUrl(relPath)`), DOM jen přes HTML string / předané prvky.
import { escapeAttr, escapeHtml } from './html.js';

export const DONOR_BADGE_VARIANTS = [
  { id: 'qr-patron', name: 'QR Patron', tagline: 'QR kód s tepajícím srdcem.' },
  { id: 'donor-coin', name: 'Mince', tagline: 'Zlatá mince se otočí přes hranu.' },
  { id: 'money-bag', name: 'Váček', tagline: 'Váček s mincemi poskočí.' },
  { id: 'support-card', name: 'Karta', tagline: 'Karta podpory se překlopí.' },
];
export const DONOR_BADGE_DEFAULT = 'donor-coin';
export const DONOR_BADGE_TITLE = 'Dárce';

/** Platná varianta, jinak výchozí. */
export function donorBadgeVariant(id) {
  return DONOR_BADGE_VARIANTS.some((v) => v.id === id) ? id : DONOR_BADGE_DEFAULT;
}

/** Relativní cesta souboru odznaku (pod `icons/`). */
export function donorBadgePath(id, { still = false } = {}) {
  return `badges/donor/${donorBadgeVariant(id)}/${still ? 'static' : 'animated'}.svg`;
}

/**
 * Odznak do chatu / náhledu: <picture> s animovaným SVG a statickou variantou při „omezit animace“.
 * @param {string} id          varianta
 * @param {(rel: string) => string} assetUrl  cesta pod icons/ → URL
 */
export function donorBadgeHtml(id, assetUrl, { size = 20, className = 'bdg-img uc-donor-badge', title = DONOR_BADGE_TITLE } = {}) {
  const v = donorBadgeVariant(id);
  return `<picture class="uc-donor-pic"><source media="(prefers-reduced-motion: reduce)" srcset="${escapeAttr(assetUrl(donorBadgePath(v, { still: true })))}">`
    + `<img class="${escapeAttr(className)}" src="${escapeAttr(assetUrl(donorBadgePath(v)))}" width="${size}" height="${size}" alt="${escapeAttr(title)}" data-tooltip="${escapeAttr(title)}" data-donor-badge="${escapeAttr(v)}"></picture>`;
}

/**
 * Výběr varianty v nastavení (mod): čtyři karty s animovaným náhledem, název a popis; vybraná má třídu `on`.
 * Hostitel poslouchá `change` na `input[name="uc-donor-badge"]`.
 */
export function donorBadgePickerHtml(selected, assetUrl, { disabled = false } = {}) {
  const sel = donorBadgeVariant(selected);
  return `<div class="uc-dbp" role="radiogroup" aria-label="Odznak dárce">${DONOR_BADGE_VARIANTS.map((v) => `
    <label class="uc-dbp-item${v.id === sel ? ' on' : ''}" title="${escapeAttr(v.tagline)}">
      <input type="radio" name="uc-donor-badge" value="${v.id}"${v.id === sel ? ' checked' : ''}${disabled ? ' disabled' : ''}>
      <span class="uc-dbp-pic">${donorBadgeHtml(v.id, assetUrl, { size: 28, className: 'uc-dbp-img', title: v.name })}</span>
      <span class="uc-dbp-name">${escapeHtml(v.name)}</span>
    </label>`).join('')}</div>`;
}

/** Po změně: přeznačit vybranou kartu (bez překreslení celého výběru — animace náhledů běží dál). */
export function markDonorBadgePicker(root, selected) {
  const sel = donorBadgeVariant(selected);
  for (const item of root?.querySelectorAll?.('.uc-dbp-item') || []) {
    const input = item.querySelector('input');
    const on = input?.value === sel;
    item.classList.toggle('on', on);
    if (input) input.checked = on;
  }
}
