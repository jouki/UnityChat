// Cenzura podle blacklistu slov (sdílený seznam ze Židolišty, GET /blacklist na backendu).
// Addon i web: text zpráv (EmoteManager._toHtml → textové segmenty) a zobrazovaná jména.
//
// Přesné slovo (pokyn usera 2026-09-23, po zkoušce podřetězců jako QR Dono, které chytaly
// i nevinná slova typu „runegrove"): položka musí být CELÉ slovo, fráze s mezerou celá
// fráze; bez ohledu na velikost písmen, diakritika přesně podle položky (seznam má varianty
// s ní i bez ní). Nalezená písmena a číslice → *; interpunkce a délka textu zůstanou
// (pozice Twitch emotů v IRC tagu dál sedí).

const WORD = /[\p{L}\p{N}]/u;

/** Malá písmena znak po znaku se zachovanou délkou (znak, který by se lowercase rozpadl, zůstane). */
function lowerKeepLength(chars) {
  return chars.map((ch) => { const l = ch.toLowerCase(); return Array.from(l).length === 1 ? l : ch; });
}

/**
 * Předzpracovat seznam (jednou po načtení): lowercase, bez prázdných a duplicit.
 * @param {string[]} terms
 * @returns {{ terms: string[][], size: number }}  položky jako pole znaků (kódových bodů)
 */
export function compileBlacklist(terms) {
  const set = new Set();
  for (const raw of Array.isArray(terms) ? terms : []) {
    const t = String(raw || '').trim().toLowerCase();
    if (t) set.add(t);
  }
  const list = [...set].map((t) => Array.from(t));
  return { terms: list, size: list.length };
}

/**
 * Nahradit slova (a fráze) z blacklistu hvězdičkami. Vrací TENTÝŽ řetězec, když
 * není co cenzurovat. Prázdný / chybějící seznam = text beze změny.
 */
export function censorText(text, bl) {
  if (!bl || !bl.size || !text) return text;
  const chars = Array.from(String(text));
  const lower = lowerKeepLength(chars);
  const n = chars.length;
  const hide = new Array(n).fill(false);
  let hit = false;
  for (const term of bl.terms) {
    const m = term.length;
    if (m > n) continue;
    for (let i = 0; i <= n - m; i++) {
      if (lower[i] !== term[0]) continue;
      let k = 1;
      while (k < m && lower[i + k] === term[k]) k++;
      if (k < m) continue;
      // Jen celé slovo: před a za nálezem nesmí pokračovat písmeno ani číslice.
      if ((i > 0 && WORD.test(chars[i - 1])) || (i + m < n && WORD.test(chars[i + m]))) continue;
      hit = true;
      for (let j = i; j < i + m; j++) hide[j] = true;
    }
  }
  if (!hit) return text;
  return chars.map((ch, i) => (hide[i] && WORD.test(ch) ? '*' : ch)).join('');
}
