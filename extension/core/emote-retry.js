// Obrázek emotu, který se nenačetl (krátký výpadek sítě / CDN), prohlížeč drží rozbitý až do
// znovunačtení stránky. Proto: chybu zachytit a načíst znovu (po 2 s a po 10 s, s parametrem
// proti cache). Addon i web — jeden posluchač na dokumentu (event `error` nebublá → capture).

export const EMOTE_RETRY_DELAYS_MS = [2000, 10000];

/** URL s parametrem proti cache pro n-tý pokus (zachová existující query). */
export function retryUrl(url, attempt) {
  const u = String(url).replace(/([?&])ucr=\d+(&|$)/, (_, a, b) => (b ? a : ''));
  return `${u}${u.includes('?') ? '&' : '?'}ucr=${attempt}`;
}

/**
 * @param {Document} doc
 * @param {{ log?: (text: string) => void, match?: (img: HTMLImageElement) => boolean }} [o]
 */
export function installEmoteRetry(doc, { log, match } = {}) {
  const isEmote = match || ((img) => img.classList.contains('emote') || !!img.closest('.es-item, .uc-ep, .emote-stack'));
  const win = doc.defaultView;
  doc.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG' || !isEmote(img)) return;
    const attempt = Number(img.dataset.ucRetry || 0);
    const orig = img.dataset.ucSrc || img.currentSrc || img.src;
    if (!orig) return;
    if (attempt >= EMOTE_RETRY_DELAYS_MS.length) { log?.(`vzdávám ${img.alt || '?'} ${orig}`); return; }
    img.dataset.ucSrc = orig;
    img.dataset.ucRetry = String(attempt + 1);
    log?.(`nenačteno ${img.alt || '?'} ${orig} → pokus ${attempt + 1}`);
    win.setTimeout(() => { if (img.isConnected) img.src = retryUrl(orig, attempt + 1); }, EMOTE_RETRY_DELAYS_MS[attempt]);
  }, true);
}
