// Shoda s blacklistem slov na serveru (přejmenování modem, moderace část 2).
// VĚDOMÁ DUPLIKACE pravidla z extension/core/censor.js (censorText): backend image se staví
// z base dir `backend/` (Coolify), soubory z `extension/` v něm nejsou, takže sdílený modul
// importovat nejde. Pravidlo musí zůstat stejné: celé slovo / celá fráze, bez ohledu na velikost
// písmen, diakritika přesně podle položky; hranice slova = písmeno nebo číslice (\p{L}\p{N}).
// Při změně censor.js upravit i tady (test blacklistMatch.test.ts drží shodné případy).

const WORD = /[\p{L}\p{N}]/u;

/** Obsahuje text některou položku blacklistu jako celé slovo/frázi? */
export function containsBlacklisted(text: string, terms: string[]): boolean {
  if (!text || !terms.length) return false;
  const chars = Array.from(text);
  const lower = chars.map((ch) => { const l = ch.toLowerCase(); return Array.from(l).length === 1 ? l : ch; });
  const n = chars.length;
  for (const raw of terms) {
    const term = Array.from(String(raw || '').trim().toLowerCase());
    const m = term.length;
    if (!m || m > n) continue;
    for (let i = 0; i <= n - m; i++) {
      let k = 0;
      while (k < m && lower[i + k] === term[k]) k++;
      if (k < m) continue;
      if ((i > 0 && WORD.test(chars[i - 1])) || (i + m < n && WORD.test(chars[i + m]))) continue;
      return true;
    }
  }
  return false;
}
