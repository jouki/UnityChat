// Zvětšení GIFu ve zprávě (addon i web, v OBS ne — pokyn usera 2026-09-28): klik na médium ve zprávě = náhled
// v plné velikosti přes celé okno (panel), Esc / klik kamkoli zavře. Stejný soubor jako ve zprávě (už v cache).

/** Náhled pro médium `media` (img / video .uc-gif-media) → overlay; vrací zavírací funkci. */
export function openGifLightbox(doc, media, { log } = {}) {
  const src = media?.currentSrc || media?.getAttribute?.('src');
  if (!src) return () => {};
  const win = doc.defaultView;
  const ov = doc.createElement('div');
  ov.className = 'uc-gif-lb';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-label', 'GIF v plné velikosti');
  ov.tabIndex = -1;
  const video = media.tagName === 'VIDEO';
  const big = doc.createElement(video ? 'video' : 'img');
  big.className = 'uc-gif-lb-media';
  big.src = src;
  if (video) { big.muted = true; big.loop = true; big.autoplay = true; big.playsInline = true; big.setAttribute('playsinline', ''); }
  else big.alt = media.getAttribute('alt') || 'GIF';
  // Rozměry z originálu (nejvýš okno — CSS max-width / max-height), poměr zachová prohlížeč.
  const w = Number(media.getAttribute('data-w') || media.naturalWidth || media.videoWidth || 0);
  const h = Number(media.getAttribute('data-h') || media.naturalHeight || media.videoHeight || 0);
  if (w > 0 && h > 0) big.style.aspectRatio = `${w} / ${h}`;
  ov.appendChild(big);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    doc.removeEventListener('keydown', onKey, true);
    ov.classList.add('uc-gif-lb--out');
    const done = () => ov.remove();
    // Bez animace (reduced motion) / skrytý dokument → hned.
    if (win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches) done(); else win.setTimeout(done, 160);
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  ov.addEventListener('click', (e) => { e.stopPropagation(); close(); });
  doc.addEventListener('keydown', onKey, true);
  doc.body.appendChild(ov);
  if (video) big.play?.().catch(() => {});
  try { ov.focus({ preventScroll: true }); } catch { /* ignore */ }
  log?.('Gif', 'náhled GIFu otevřen');
  return close;
}

/**
 * Delegovaný klik na GIF ve zprávách chatu (`chatEl`) → náhled. `enabled()` = false (OBS) nic nedělá.
 * Zpráva smazaná / čekající / zamítnutá GIF zobrazený nemá, tak se nic neotevře.
 */
export function installGifLightbox(doc, chatEl, { enabled = () => true, log } = {}) {
  if (!chatEl) return () => {};
  const onClick = (e) => {
    const m = e.target?.closest?.('.msg .uc-gif .uc-gif-media');
    if (!m || !chatEl.contains(m) || !enabled()) return;
    e.preventDefault();
    e.stopPropagation();
    openGifLightbox(doc, m, { log });
  };
  chatEl.addEventListener('click', onClick);
  return () => chatEl.removeEventListener('click', onClick);
}
