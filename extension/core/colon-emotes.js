// Twitch-style „:jméno" spouštěč pro emote autocomplete (addon i web).
// Uživatel chce našeptávač otevřít bez Tabu — stačí napsat dvojtečku a
// aspoň 2 znaky jména. Aby to nekolidovalo s URL („http://…") nebo časem
// („12:30"), dvojtečka musí být na začátku „slova" (začátek zprávy nebo
// hned za mezerou) — token se hledá stejně jako u @/!/`/uc` spouštěčů
// (zpětné hledání po mezeru), takže dvojtečka uprostřed slova se nikdy
// nepočítá jako začátek dotazu.

/**
 * Rozpozná „:dotaz" token, který má být otevřen jako emote autocomplete.
 * @param {string} text  celý obsah textového pole
 * @param {number} caret  pozice kurzoru (selectionStart)
 * @returns {{ start: number, query: string } | null}  `start` = index dvojtečky,
 *   `query` = text za ní (bez dvojtečky); null když se nemá nic nabízet
 */
export function colonQuery(text, caret) {
  if (typeof text !== 'string' || !Number.isInteger(caret)) return null;
  let ws = caret;
  while (ws > 0 && text[ws - 1] !== ' ') ws--;
  const token = text.slice(ws, caret);
  if (!token.startsWith(':')) return null;
  const query = token.slice(1);
  if (query.length < 2) return null;
  return { start: ws, query };
}
