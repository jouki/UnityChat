// Rezervovaná jména (pokyn usera 2026-09-30): přezdívku „RobDiesALot“ si nesmí nastavit nikdo kromě Roba.
// Rezervované = loginy kanálů streamerů z registru Židolišty (všechny platformy) + jména UnityChatu a bota.
// Porovnání po zjednodušení (malá písmena, bez mezer, teček, podtržítek a pomlček), ať neprojde „Rob Dies A Lot“
// ani „rob_dies_a_lot“. Jména jsou ve SKUPINÁCH po workspacu: výjimku má účet, jehož vlastní login (na kterékoli
// platformě) je kterékoli jméno té skupiny — streamer si smí dát jméno svého kanálu i z jiné platformy (živě 2026-09-30:
// user jouki728 vs. YouTube handle @Jouki téhož workspace). Pevná jména (UnityChat, bot) jsou vlastní skupina.
// Platí pro vlastní přezdívku (PUT /nicknames) i přejmenování modem (PUT /moderation/nickname).
import { getWorkspaces } from './zidolista.js';

const ALWAYS_RESERVED = ['unitychat', 'joukibot'];

/** Zjednodušený tvar jména pro porovnání. */
export function simplifyName(s: string | null | undefined): string {
  return String(s ?? '').toLowerCase().replace(/[\s._\-@]+/g, '');
}

/** Skupina rezervovaných jmen (kanály jednoho workspace, nebo pevná jména); plochý seznam = každé jméno vlastní skupina. */
export type ReservedGroup = string[];

/**
 * Je přezdívka rezervovaná pro někoho jiného? (čistá funkce)
 * @param nickname   přezdívka, kterou chce někdo nastavit
 * @param ownLogins  loginy účtu, kterému se přezdívka nastavuje (všechny platformy)
 * @param reserved   skupiny rezervovaných jmen (kanály workspace); plochý seznam jmen = každé zvlášť
 * @returns jméno, které koliduje, nebo null
 */
export function reservedNicknameClash(nickname: string, ownLogins: string[], reserved: Array<string | ReservedGroup>): string | null {
  const n = simplifyName(nickname);
  if (!n) return null;
  const own = new Set(ownLogins.map(simplifyName).filter(Boolean));
  for (const g of reserved) {
    const names = Array.isArray(g) ? g : [g];
    const hit = names.find((r) => simplifyName(r) === n);
    if (!hit) continue;
    // Účet vlastní některé jméno skupiny (kanál téhož workspace na kterékoli platformě) → smí.
    if (names.some((r) => own.has(simplifyName(r)))) continue;
    return hit;
  }
  return null;
}

/** Rezervovaná jména z registru (kanály po workspacech) + pevná. Při výpadku registru jen pevná. */
export async function reservedNames(): Promise<ReservedGroup[]> {
  const out: ReservedGroup[] = [[...ALWAYS_RESERVED]];
  try {
    for (const ws of await getWorkspaces()) { const g = Object.values(ws.channels).filter((c): c is string => !!c); if (g.length) out.push(g); }
  } catch { /* registr nedostupný → aspoň pevná jména */ }
  return out;
}
