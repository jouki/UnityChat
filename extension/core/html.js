// Čisté HTML helpery bez DOM — sdílené addonem i webem (extension/core/).
// Kick posílá obsah zpráv jako HTML s <img> emoty; v core se z něj musí dát
// vytáhnout text bez document.createElement (Node testy, web workery).

/** Escapování textu do HTML (shodné s EmoteManager._eh: jen & < >). */
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escapování do hodnoty atributu (shodné s EmoteManager._ea). */
export function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Dekódování HTML entit (&amp; &lt; &gt; &quot; &apos; &nbsp; &#NN; &#xHH;). */
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED, ent) ? NAMED[ent] : m;
  });
}

/** textContent bez DOM: odstraní tagy a dekóduje entity. */
export function stripTags(html) {
  const s = String(html);
  if (!s.includes('<') && !s.includes('&')) return s;
  return decodeEntities(s.replace(/<[^>]*>/g, ''));
}

/**
 * Atributy z jednoho HTML tagu (`<img src="u" alt='E' data-x=y>`) → objekt.
 * Stačí pro Kick fragmenty; není to obecný parser.
 */
export function tagAttrs(tag) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(tag)) !== null) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}
