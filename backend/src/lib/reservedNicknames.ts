// Rezervovaná jména (pokyn usera 2026-09-30): přezdívku „RobDiesALot“ si nesmí nastavit nikdo kromě Roba.
// Rezervované = loginy kanálů streamerů z registru Židolišty (všechny platformy) + jména UnityChatu a bota.
// Porovnání po zjednodušení (malá písmena, bez mezer, teček, podtržítek a pomlček), ať neprojde „Rob Dies A Lot“
// ani „rob_dies_a_lot“. Výjimku má účet, jehož vlastní login (na kterékoli platformě) je to rezervované jméno.
// Platí pro vlastní přezdívku (PUT /nicknames) i přejmenování modem (PUT /moderation/nickname).
import { getWorkspaces } from './zidolista.js';

const ALWAYS_RESERVED = ['unitychat', 'joukibot'];

/** Zjednodušený tvar jména pro porovnání. */
export function simplifyName(s: string | null | undefined): string {
  return String(s ?? '').toLowerCase().replace(/[\s._\-@]+/g, '');
}

/**
 * Je přezdívka rezervovaná pro někoho jiného? (čistá funkce)
 * @param nickname   přezdívka, kterou chce někdo nastavit
 * @param ownLogins  loginy účtu, kterému se přezdívka nastavuje (všechny platformy)
 * @param reserved   rezervovaná jména (loginy kanálů)
 * @returns jméno, které koliduje, nebo null
 */
export function reservedNicknameClash(nickname: string, ownLogins: string[], reserved: string[]): string | null {
  const n = simplifyName(nickname);
  if (!n) return null;
  const own = new Set(ownLogins.map(simplifyName).filter(Boolean));
  for (const r of reserved) {
    const s = simplifyName(r);
    if (s && s === n && !own.has(s)) return r;
  }
  return null;
}

/** Rezervovaná jména z registru (kanály všech workspaců) + pevná. Při výpadku registru jen pevná. */
export async function reservedNames(): Promise<string[]> {
  const out = new Set(ALWAYS_RESERVED);
  try {
    for (const ws of await getWorkspaces()) for (const ch of Object.values(ws.channels)) if (ch) out.add(ch);
  } catch { /* registr nedostupný → aspoň pevná jména */ }
  return [...out];
}
