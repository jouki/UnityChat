// Obsah náhledu emotu (hover / klik na emote v textu zprávy) — sdílené addonem i webem.
// U zero-width stacku (base + překryvy, `.emote-stack`) ukáže všechny vrstvy přes sebe
// a vypíše všechny použité emoty; detaily po kliknutí patří emotu, na kterém je myš.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Vrstvy pod kurzorem: všechny obrázky stacku (podklad první), u samostatného emotu jen on.
 * @param {HTMLImageElement} img  emote, na kterém je myš
 * @param {object} emotes         EmoteManager (_emoteSourceFromUrl)
 * @returns {{ name: string, url: string, hires: string, source: string, sourceClass: string, meta: object|null, active: boolean }[]}
 */
export function previewLayers(img, emotes) {
  const stack = img.closest?.('.emote-stack');
  const imgs = stack ? [...stack.querySelectorAll('img')] : [img];
  return imgs.map((el) => {
    const meta = emotes._emoteSourceFromUrl?.(el.src) || null;
    const source = meta?.source || 'Emote';
    return {
      name: el.alt || el.title || '',
      url: el.src,
      hires: meta?.hires || el.src,
      source,
      sourceClass: source.toLowerCase().replace(/[^a-z]/g, ''),
      meta,
      active: el === img,
    };
  });
}

/** HTML karty: obrázek (vrstvy přes sebe), řádek se jménem a zdrojem pro každý emote, patička. */
export function previewCardHtml(layers, { pinned = false } = {}) {
  const multi = layers.length > 1;
  const imgs = layers.map((l) => `<img class="ep-img" src="${esc(l.hires)}" alt="">`).join('');
  const names = layers.map((l, i) => `<div class="ep-name${multi && l.active ? ' active' : ''}">${multi && i > 0 ? '<span class="ep-plus">+</span>' : ''}<span class="ep-name-text">${esc(l.name)}</span><span class="ep-source ep-src-${esc(l.sourceClass)}">${esc(l.source)}</span></div>`).join('');
  const hint = pinned ? '<span class="ep-loading">Načítám detaily…</span>' : `<span class="ep-hint">Klikni pro detaily${multi ? ' (emote pod myší)' : ''}</span>`;
  return `<div class="ep-img-wrap${multi ? ' stack' : ''}">${imgs}</div><div class="ep-names">${names}</div><div class="ep-detail">${hint}</div>`;
}

/** Řádky detailu (autor, kdo přidal, kdy, odkaz) z EmoteManager.fetchEmoteDetails. */
export function previewDetailHtml(d, sourceLabel) {
  if (!d) return '<span class="ep-hint">Žádné další detaily</span>';
  const avatar = (u) => (u ? `<img class="ep-avatar" src="${esc(u)}" alt="">` : '<span class="ep-avatar ep-avatar-blank"></span>');
  const rows = [];
  if (d.owner) rows.push(`<div class="ep-row"><span class="ep-label">Made by</span>${avatar(d.ownerAvatar)}<span class="ep-owner">${esc(d.owner)}</span></div>`);
  if (d.addedBy) rows.push(`<div class="ep-row"><span class="ep-label">Added by</span>${avatar(d.addedByAvatar)}<span class="ep-owner">${esc(d.addedBy)}</span></div>`);
  if (d.addedAt instanceof Date && !isNaN(d.addedAt)) rows.push(`<div class="ep-row"><span class="ep-label">Added on</span><span>${d.addedAt.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' })}</span></div>`);
  if (d.externalUrl) rows.push(`<a class="ep-extlink" href="${esc(d.externalUrl)}" target="_blank" rel="noopener">Otevřít na ${esc(sourceLabel)} ↗</a>`);
  return rows.length ? rows.join('') : '<span class="ep-hint">Žádné další detaily</span>';
}
