// Detektor odkazů pro filtr odkazů (moderace část 3).
// VĚDOMÁ KOPIE extension/core/links.js: backend image se staví z base dir `backend/`
// (Coolify), soubory z `extension/` v něm nejsou, takže sdílený modul importovat nejde.
// Logika MUSÍ zůstat shodná — test links.test.ts pouští oba moduly na stejné případy
// a porovnává výstupy. Při změně upravit oba soubory (pravidla viz hlavička core souboru).

// Generické TLD, které se v chatu reálně objevují (spam i běžné odkazy).
const GENERIC_TLDS = [
  'com', 'net', 'org', 'info', 'biz', 'io', 'co', 'me', 'tv', 'gg', 'app', 'dev', 'xyz', 'online', 'site',
  'shop', 'store', 'live', 'stream', 'link', 'click', 'top', 'fun', 'club', 'vip', 'pro', 'win', 'bet',
  'casino', 'game', 'games', 'art', 'blog', 'news', 'tech', 'space', 'website', 'page', 'icu', 'cc', 'ly',
  'ai', 'gl', 'gd', 'to', 'sh', 'fm', 'am', 'im', 'is', 'it', 'lol', 'wtf', 'ink', 'one', 'world', 'today',
  'email', 'cloud', 'host', 'digital', 'media', 'social', 'group', 'agency', 'company', 'money', 'cash',
  'finance', 'crypto', 'market', 'sale', 'deals', 'gift', 'gifts', 'free', 'work', 'zone', 'rocks', 'run',
  'party', 'porn', 'sex', 'xxx', 'adult', 'dating', 'tube', 'video', 'movie', 'music', 'download', 'edu',
  'gov', 'mil', 'int', 'mobi', 'name', 'travel', 'asia', 'eu', 'moe', 'wiki', 'land', 'network', 'systems',
  'bio', 'chat', 'center', 'studio', 'design', 'tools', 'codes', 'support', 'help', 'global', 'best',
];
// Národní TLD (ISO 3166-1 alpha-2 + uk/eu).
const COUNTRY_TLDS = (
  'ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bw by bz ca cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz ' +
  'de dj dk dm do dz ec ee eg er es et eu fi fj fk fm fo fr ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it ' +
  'je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz ' +
  'om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sk sl sm sn so sr ss st su sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ' +
  'ua ug uk us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw'
).split(' ');
const TLDS = new Set([...GENERIC_TLDS, ...COUNTRY_TLDS]);
// TLD, které stačí i holé (bez www a bez cesty). Záměrně BEZ českých a běžných anglických slov (co, to, se,
// si, na, je, ne, no, by, do, za, me, my, ty, on, ta, te, ze, od, po, ve, ke, ku, ji, mi, ti, ho, mu, jo,
// at, be, es, it, is, us, …) a bez přípon souborů (md, py, sh, js, ts, rs, go, pl, …).
const BARE_TLDS = new Set([
  'com', 'net', 'org', 'info', 'biz', 'io', 'gg', 'tv', 'fm', 'ly', 'cc', 'xyz', 'app', 'dev', 'online', 'site',
  'shop', 'store', 'live', 'stream', 'link', 'click', 'top', 'club', 'vip', 'win', 'bet', 'casino', 'icu',
  'gift', 'gifts', 'free', 'money', 'cash', 'crypto', 'finance', 'market', 'sale', 'deals', 'porn', 'xxx',
  'tube', 'website', 'space', 'blog', 'news', 'tech', 'cloud', 'email', 'social', 'wiki', 'games',
  'cz', 'sk', 'eu', 'de', 'uk', 'ru', 'ua', 'fr', 'nl', 'ch', 'hu', 'ca', 'jp', 'cn', 'br', 'ai',
]);

const SCHEME_RE = /^(?:https?|ftp):\/\//i;
// Všechna schémata v tokenu (vždy nový RegExp — globální stav lastIndex).
const SCHEME_ALL_SRC = '(?:https?|ftp):\\/\\/';
// Host za schématem: volitelné userinfo, pak znaky hostu; končí prvním jiným znakem (`,`, `/`, `:`…).
const HOST_AFTER_SCHEME = /^(?:[^\s/?#@]*@)?([\p{L}\p{N}.-]+)/u;
// Uvnitř tokenu: `www.` nepředcházené písmenem/číslicí/tečkou/pomlčkou (`🔥www.x.cz`, `x:www.x.cz`).
const WWW_ANY_RE = /(?<![\p{L}\p{N}.-])www\./iu;
// Oddělovače uvnitř tokenu, které v hostu být nemůžou (`ahoj,evil.com`, `(viz neco.cz)`, `x:evil.com`).
// Dvojtečka jen když za ní není port (`neco.cz:8080`). Apostrof NENÍ oddělovač (`it's.com`).
const SEGMENT_SEP = /[,;!(){}[\]<>"„“”‚«»|…]+|:(?!\d{1,5}(?:[/?#]|$))/;
// Znaky, které obalují odkaz ve větě („(viz neco.cz)", "<https://x>", „neco.cz!").
const LEAD_PUNCT = /^[(\[{<"'„“‚‘«»]+/;
const TRAIL_PUNCT = /[)\]}>"'“”‘’«».,;:!?…]+$/;
// Cokoli před prvním písmenem/číslicí (emoji, interpunkce) — doména přilepená za tím.
const LEAD_NON_WORD = /^[^\p{L}\p{N}]+/u;
const LABEL_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Host bez portu, userinfo a koncové tečky, malými písmeny; null = neplatný. */
function cleanHost(raw: string): string | null {
  let h = String(raw || '');
  const at = h.lastIndexOf('@');
  if (at >= 0) h = h.slice(at + 1);
  if (h.startsWith('[')) return null; // IPv6 literál — v chatu nereálné, neřešíme
  h = h.replace(/:\d{0,5}$/, '').replace(/\.$/, '').toLowerCase();
  return h || null;
}

/** Jsou všechny štítky hostu platné (písmena/číslice/pomlčka, ne na krajích)? */
function validLabels(host: string): boolean {
  const labels = host.split('.');
  return labels.length >= 2 && labels.every((l) => LABEL_RE.test(l));
}

/** Kandidát se schématem na začátku → host, nebo null. */
function schemeHost(c: string): string | null {
  const m = HOST_AFTER_SCHEME.exec(c.replace(SCHEME_RE, ''));
  const host = m ? m[1].replace(/\.+$/, '').toLowerCase() : '';
  if (!host) return null;
  if (IPV4_RE.test(host) || host === 'localhost') return host;
  return validLabels(host) ? host : null;
}

/** Kandidát bez schématu → host, nebo null (pravidla viz hlavička). */
function bareHost(c: string): string | null {
  let t = c.replace(LEAD_PUNCT, '').replace(TRAIL_PUNCT, '');
  // E-mail / @zmínka / cokoli s @ není odkaz (kontrola PŘED odříznutím úvodních znaků — `@neco.cz`).
  if (!t || t.includes('@')) return null;
  const w = t.search(WWW_ANY_RE);
  if (w > 0) t = t.slice(w);
  t = t.replace(LEAD_NON_WORD, '');
  if (!t) return null;
  const cut = t.search(/[/?#]/);
  const hostPart = cut < 0 ? t : t.slice(0, cut);
  // Cesta = `/…`, dotaz/kotva jen s obsahem (koncové `?` odřízl TRAIL_PUNCT).
  const hasPath = cut >= 0 && (t[cut] === '/' || t.length > cut + 1);
  // Dvojtečka jen jako port (`neco.cz:8080`); „12:30", „a:b.cz", „D:" odkazy nejsou.
  if (hostPart.includes(':') && !/^[^:]+:\d{1,5}$/.test(hostPart)) return null;
  const host = cleanHost(hostPart);
  if (!host) return null;
  if (IPV4_RE.test(host)) return null; // holá IP (i verze 1.2.3.4) jen se schématem
  if (!validLabels(host)) return null;
  const tld = host.slice(host.lastIndexOf('.') + 1);
  if (!/^\p{L}{2,24}$/u.test(tld) || !TLDS.has(tld)) return null;
  if (host.startsWith('www.') || hasPath || BARE_TLDS.has(tld)) return host;
  return null;
}

/** Všechny hosty v jednom tokenu (bez bílých znaků); schéma i uprostřed tokenu. */
function tokenHosts(token: string): string[] {
  const t = String(token || '');
  if (!t) return [];
  const out: string[] = [];
  const starts: number[] = [];
  const re = new RegExp(SCHEME_ALL_SRC, 'gi');
  for (let m = re.exec(t); m; m = re.exec(t)) starts.push(m.index);
  const plain = starts.length ? t.slice(0, starts[0]) : t;
  for (const seg of plain.split(SEGMENT_SEP)) {
    const h = seg ? bareHost(seg) : null;
    if (h) out.push(h);
  }
  for (let i = 0; i < starts.length; i++) {
    const h = schemeHost(t.slice(starts[i], starts[i + 1] ?? t.length));
    if (h) out.push(h);
  }
  return out;
}

/**
 * Jeden token (bez bílých znaků) → první host odkazu, nebo null.
 * @param {string} token
 * @returns {string|null}
 */
export function tokenHost(token: string): string | null {
  return tokenHosts(token)[0] ?? null;
}

/**
 * Všechny odkazy v textu.
 * @param {string} text
 * @param {{ ignore?: Iterable<string> }} [opts] ignore = tokeny, které odkazem nejsou (např. jména emotů)
 * @returns {Array<{ text: string, host: string }>}
 */
export function findLinks(text: string, opts: { ignore?: Iterable<string> } = {}): Array<{ text: string; host: string }> {
  const ignore = opts.ignore ? new Set(opts.ignore) : null;
  const out: Array<{ text: string; host: string }> = [];
  for (const token of String(text || '').split(/\s+/)) {
    if (!token || (ignore && ignore.has(token))) continue;
    for (const host of tokenHosts(token)) out.push({ text: token, host });
  }
  return out;
}

/** Unikátní hosty odkazů v textu (pořadí výskytu). */
export function linkHosts(text: string, opts: { ignore?: Iterable<string> } = {}): string[] {
  return [...new Set(findLinks(text, opts).map((l) => l.host))];
}

/** Normalizovaná položka seznamu povolených domén: bez schématu, cesty, `*.` a `www.`. */
export function normalizeDomain(d: string): string {
  let s = String(d || '').trim().toLowerCase().replace(SCHEME_RE, '');
  s = s.split(/[/?#]/)[0].replace(/:\d{0,5}$/, '').replace(/\.$/, '').replace(/^\*\./, '').replace(/^www\./, '');
  return s && validLabels(s) ? s : '';
}

/**
 * Je host povolený? Shoda s doménou nebo její subdoménou (`m.youtube.com` ⊂ `youtube.com`).
 * @param {string} host
 * @param {Iterable<string>} allowDomains
 */
export function hostAllowed(host: string, allowDomains: Iterable<string> | null | undefined): boolean {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  for (const raw of allowDomains || []) {
    const d = normalizeDomain(raw);
    if (d && (h === d || h.endsWith('.' + d))) return true;
  }
  return false;
}
