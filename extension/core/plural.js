// Český plurál — malý modul bez závislostí, sdílený core moduly (Profil, výročí) i webem.

/** Český plurál: 1 → one, 2–4 → few, jinak many (0, 5+, zlomky). */
export function czPlural(n, one, few, many) {
  const a = Math.abs(Number(n) || 0);
  if (a === 1) return one;
  if (Number.isInteger(a) && a >= 2 && a <= 4) return few;
  return many;
}
