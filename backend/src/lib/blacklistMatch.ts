// Shoda s blacklistem slov na serveru (přejmenování modem, moderace část 2).
// VĚDOMÁ DUPLIKACE pravidla z extension/core/censor.js (censorText): backend image se staví
// z base dir `backend/` (Coolify), soubory z `extension/` v něm nejsou, takže sdílený modul
// importovat nejde. Pravidlo musí zůstat stejné: celé slovo / celá fráze, bez ohledu na velikost
// písmen, diakritika přesně podle položky; hranice slova = písmeno nebo číslice (\p{L}\p{N}); mezera ve frázi
// = libovolný počet bílých znaků („do prdele“ chytí „jdi DO  prdele“) — sémantika Židolišty (blacklistHit, 2026-10-01).
// Při změně censor.js upravit i tady (test blacklistMatch.test.ts drží shodné případy).

const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/u;

/** Délka shody položky na pozici i (0 = neshoda); mezera v položce sedí na 1+ bílých znaků. */
function matchTermAt(lower: string[], i: number, term: string[]): number {
  let j = i;
  for (let k = 0; k < term.length; k++) {
    if (term[k] === ' ') {
      if (j >= lower.length || !SPACE.test(lower[j])) return 0;
      while (j < lower.length && SPACE.test(lower[j])) j++;
    } else {
      if (lower[j] !== term[k]) return 0;
      j++;
    }
  }
  return j - i;
}

/** Obsahuje text některou položku blacklistu jako celé slovo/frázi? */
export function containsBlacklisted(text: string, terms: string[]): boolean {
  if (!text || !terms.length) return false;
  const chars = Array.from(text);
  const lower = chars.map((ch) => { const l = ch.toLowerCase(); return Array.from(l).length === 1 ? l : ch; });
  const n = chars.length;
  for (const raw of terms) {
    const term = Array.from(String(raw || '').trim().toLowerCase().replace(/\s+/g, ' '));
    if (!term.length || term.length > n) continue;
    for (let i = 0; i <= n - term.length; i++) {
      if (lower[i] !== term[0]) continue;
      const m = matchTermAt(lower, i, term);
      if (!m) continue;
      if ((i > 0 && WORD.test(chars[i - 1])) || (i + m < n && WORD.test(chars[i + m]))) continue;
      return true;
    }
  }
  return false;
}
