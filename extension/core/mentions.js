// @zmínky přezdívkou → login (addon i web, před odesláním zprávy).
// Autocomplete vkládá UC přezdívku, do chatu ale musí odejít login — jinak zmíněný
// nedostane upozornění a lidé mimo UnityChat nepoznají, o koho jde. Přezdívka může mít
// víc slov („Naprostej Kokot"), proto se za „@" zkoušejí celé přezdívky, ne jedno slovo.

const NAME_CHAR = /[\p{L}\p{N}_]/u;

/**
 * Přezdívky jedné platformy z mapy `platform:login → { nickname }` (NicknameManager v addonu,
 * Nicknames na webu), seřazené od nejdelší — delší přezdívka má přednost před svým začátkem.
 * @returns {{ nickname: string, login: string }[]}
 */
export function nicknameEntries(map, platform) {
  const out = [];
  const prefix = `${platform}:`;
  for (const [key, val] of map) {
    const nick = String(val?.nickname || '').trim();
    if (!nick || !key.startsWith(prefix)) continue;
    out.push({ nickname: nick, login: key.slice(prefix.length) });
  }
  return out.sort((a, b) => b.nickname.length - a.nickname.length);
}

/**
 * V textu nahradit „@Přezdívka" za „@login". Zmínka začíná na začátku textu nebo za znakem,
 * který není písmeno/číslice/_/@; přezdívka se porovná bez ohledu na velikost písmen a musí
 * končit hranicí slova (konec textu, mezera, interpunkce).
 * @param {string} text
 * @param {{ nickname: string, login: string }[]} entries  z nicknameEntries()
 * @param {(login: string) => string} [caseOf]  hezčí psaní loginu (jak dorazil z chatu)
 */
export function resolveNicknameMentions(text, entries, caseOf = (l) => l) {
  if (!text || !text.includes('@') || !entries?.length) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const atStart = ch === '@' && (i === 0 || !/[A-Za-z0-9_@]/.test(text[i - 1]));
    if (atStart) {
      const rest = text.slice(i + 1);
      const restLower = rest.toLowerCase();
      const hit = entries.find((e) => {
        const n = e.nickname.toLowerCase();
        if (!restLower.startsWith(n)) return false;
        const next = rest.slice(n.length, n.length + 2);
        return !next || !NAME_CHAR.test(Array.from(next)[0]);
      });
      if (hit) {
        out += '@' + caseOf(hit.login).replace(/^@/, '');
        i += 1 + hit.nickname.length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}
