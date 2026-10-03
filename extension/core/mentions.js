// @zmínky přezdívkou → login (addon i web, před odesláním zprávy).
// Autocomplete vkládá UC přezdívku, do chatu ale musí odejít login — jinak zmíněný
// nedostane upozornění a lidé mimo UnityChat nepoznají, o koho jde. Přezdívka může mít
// víc slov („Naprostej Kokot"), proto se za „@" zkoušejí celé přezdívky, ne jedno slovo.

const NAME_CHAR = /[\p{L}\p{N}_]/u;

/**
 * Přezdívky jedné platformy z mapy `platform:login → { nickname }` (NicknameManager v addonu,
 * Nicknames na webu), seřazené od nejdelší — delší přezdívka má přednost před svým začátkem.
 * Stejnou přezdívku může mít na platformě víc loginů (starý handle téhož kanálu) → přednost má login, který
 * v chatu opravdu píše (`isKnown`), jinak by zmínka odešla na mrtvé jméno a zmíněný o ní nevěděl.
 * @param {(login: string) => boolean} [isKnown]
 * @returns {{ nickname: string, login: string }[]}
 */
export function nicknameEntries(map, platform, isKnown = null) {
  const out = [];
  const prefix = `${platform}:`;
  for (const [key, val] of map) {
    const nick = String(val?.nickname || '').trim();
    if (!nick || !key.startsWith(prefix)) continue;
    out.push({ nickname: nick, login: key.slice(prefix.length) });
  }
  const known = (e) => (isKnown && isKnown(e.login) ? 0 : 1);
  return out.sort((a, b) => (b.nickname.length - a.nickname.length) || (known(a) - known(b)));
}

/**
 * Regex @zmínky ve vykresleném textu: skupina 1 = znak před „@“ (nebo začátek), skupina 2 = jméno. Jméno smí
 * mít uvnitř „-“ a „.“ (handle YouTube `@vaok-cze3464`, 2026-10-03 se zvýraznilo jen „@vaok“), ne na konci
 * (tečka / pomlčka za jménem patří větě). Nová instance (flag g) pro každé použití.
 */
export const mentionRegex = () => /(^|[^A-Za-z0-9_])@([A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,28}[A-Za-z0-9_]))/g;

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

// ---- Jména bez zavináče (zvýraznění v textu, 2026-09-29) ----
// Jen CELÁ slova: „kamo“ uvnitř „kamošem“ zmínka není (dřív hranici slova dělalo jen ASCII, takže písmeno
// s diakritikou slovo ukončilo). A ne uvnitř adresy: „robdiesalot“ v „www.robdiesalot.com/chat“ zmínka není.

const URL_TOKEN = /^(?:https?:\/\/|www\.)|[\p{L}\p{N}]\.[\p{L}]{2,}(?:[/:?#]|$)/iu;
const TRAILING_PUNCT = /[.,;:!?)\]"'“”]+$/u;

/** Úsek bez mezer kolem pozice `i` (adresa je vždy jeden takový úsek). */
function tokenAround(text, start, end) {
  let a = start;
  let b = end;
  while (a > 0 && !/\s/.test(text[a - 1])) a--;
  while (b < text.length && !/\s/.test(text[b])) b++;
  return text.slice(a, b);
}

/** Je úsek textu adresa (URL / doména)? Koncová interpunkce věty se nepočítá („Jouki.“ adresa není). */
export function isUrlToken(token) {
  return URL_TOKEN.test(String(token || '').replace(TRAILING_PUNCT, ''));
}

/**
 * Celá slova v textu (písmena, číslice, „_“ — i s diakritikou), která nejsou součástí adresy a nezačínají „@“.
 * @param {string} text
 * @param {{min?: number, max?: number}} [o]
 * @returns {{ index: number, word: string }[]}
 */
export function bareWords(text, { min = 3, max = 25 } = {}) {
  const out = [];
  if (!text) return out;
  const re = /[\p{L}\p{N}_]+/gu;
  let m;
  while ((m = re.exec(text)) !== null) {
    const word = m[0];
    if (word.length < min || word.length > max) continue;
    if (text[m.index - 1] === '@') continue;
    if (isUrlToken(tokenAround(text, m.index, m.index + word.length))) continue;
    out.push({ index: m.index, word });
  }
  return out;
}

/** Jméno bez zavináče jako celé slovo mimo adresu. Text i jméno malými písmeny. */
export function hasBareMention(text, name) {
  const n = String(name || '').toLowerCase();
  if (!text || n.length < 3) return false;
  return bareWords(String(text).toLowerCase(), { min: n.length, max: n.length }).some((w) => w.word === n);
}
