/**
 * Ověřuje tři věci na SKUTEČNÉM kódu z extension/sidepanel.js:
 *  1) ytNameColor — port YouTube hashe jména (computeAuthorNameColor → LUb)
 *     + readableColor, tj. přesně to, co panel zobrazí.
 *  2) NicknameManager.resolveNickname — reverzní lookup přezdívka → login.
 *  3) _resolveNicknameMentions — @přezdívka v odchozím textu → @login.
 *
 * Spuštění: node scripts/test-names-colors.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'extension', 'sidepanel.js');
const src = fs.readFileSync(SRC, 'utf8');
const lines = src.split(/\r?\n/);

function slice(startPred, endPred) {
  const a = lines.findIndex(startPred);
  if (a < 0) throw new Error('start nenalezen');
  const b = lines.findIndex((l, i) => i > a && endPred(l));
  if (b < 0) throw new Error('konec nenalezen');
  return lines.slice(a, b).join('\n');
}

// --- vytáhnout funkce beze změny ze zdroje ---
const ytColorFn = slice((l) => l.startsWith('function ytNameColor('), (l) => l === '}');
const readableFn = slice((l) => l.startsWith('function readableColor('), (l) => l === '}');
const resolveMentions = slice(
  (l) => l.includes('_resolveNicknameMentions(text, platform) {'),
  (l) => l === '  }'
);
const resolveNick = slice(
  (l) => l.includes('resolveNickname(nickname, platform) {'),
  (l) => l === '  }'
);

const sandbox = { console, _READABLE_CACHE: new Map() };
vm.createContext(sandbox);
vm.runInContext(`${ytColorFn}}\n${readableFn}}`, sandbox);
sandbox.NicknameManager = vm.runInContext(
  `(class NicknameManager { constructor(m){ this._map = m; }\n${resolveNick}}\n})`, sandbox);
sandbox.Panel = vm.runInContext(
  `(class Panel { constructor(n){ this.nicknames = n; }\n${resolveMentions}}\n})`, sandbox);

let fails = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

// ---------- 1) YouTube barvy ----------
console.log('=== YouTube barvy jmen (hash + readableColor) ===');
const names = ['@supernaturalcz3256', '@JamesKyd', '@lukasvlk6370', '@ezechiel194',
  '@R4D0_P', '@JakeAaronsPrivate', '@Neytuss', '@AZMIR', '@MC_RoFi-youtube'];
const shown = names.map((n) => sandbox.readableColor(sandbox.ytNameColor(n)));
names.forEach((n, i) => console.log('  %s %s -> %s', n.padEnd(22), sandbox.ytNameColor(n), shown[i]));

check('barvy jsou deterministické', sandbox.ytNameColor('@Neytuss'), sandbox.ytNameColor('@Neytuss'));
check('různá jména = různé barvy', new Set(shown).size, names.length);
check('žádná není původní červená', shown.some((c) => c === '#ff0000'), false);
// hash bere jméno VČETNĚ '@' (jinak by nesouhlasil s YouTube)
check('hash rozlišuje @ prefix',
  sandbox.ytNameColor('@Neytuss') === sandbox.ytNameColor('Neytuss'), false);
// čitelnost na tmavém pozadí: readableColor zvedne lightness u tmavých barev
const dark = sandbox.readableColor(sandbox.ytNameColor('@JamesKyd'));
const lum = (h) => {
  const v = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.05) / 1.05, 2.4)));
  return v[0] * 0.2126 + v[1] * 0.7152 + v[2] * 0.0722;
};
check('tmavá barva se zesvětlí na čitelnou', lum(dark) > lum(sandbox.ytNameColor('@JamesKyd')), true);

// ---------- 2 + 3) přezdívky ----------
console.log('\n=== Překlad @přezdívky na login při odeslání ===');
const map = new Map([
  ['twitch:trokner', { nickname: 'Tonner', color: '#ff8c00' }],
  ['twitch:xxdarkslayer99', { nickname: 'Pepa', color: '#00ccff' }],
  ['youtube:nekdojiny', { nickname: 'Řehoř', color: '#88ff88' }]
]);
const panel = new sandbox.Panel(new sandbox.NicknameManager(map));
// _chatUsers drží jména tak, jak dorazila z chatu — odtud se bere casing.
panel._chatUsers = new Map([
  ['trokner', { name: 'Trokner', platform: 'twitch' }],
  ['xxdarkslayer99', { name: 'xxDarkSlayer99', platform: 'twitch' }]
]);
const R = (t, p) => panel._resolveNicknameMentions(t, p || 'twitch');

check('základní překlad', R('@Tonner ahoj'), '@Trokner ahoj');
check('case-insensitive', R('@tonner ahoj'), '@Trokner ahoj');
check('uprostřed věty', R('hele @Pepa co ty na to'), 'hele @xxDarkSlayer99 co ty na to');
check('koncová interpunkce zůstane', R('@Tonner, dík!'), '@Trokner, dík!');
check('diakritika v přezdívce', R('@Řehoř zdar', 'youtube'), '@nekdojiny zdar');
check('víc mentionů najednou', R('@Tonner a @Pepa'), '@Trokner a @xxDarkSlayer99');
check('neznámá přezdívka beze změny', R('@Nikdo ahoj'), '@Nikdo ahoj');
check('login se nepřekládá', R('@Trokner ahoj'), '@Trokner ahoj');
check('jiná platforma nematchuje', R('@Tonner ahoj', 'kick'), '@Tonner ahoj');
check('e-mail se nechytne', R('napis na a@b.cz'), 'napis na a@b.cz');
check('text bez @ beze změny', R('normalni zprava'), 'normalni zprava');

console.log('\n=== VÝSLEDEK ===');
console.log(fails === 0 ? 'PASS' : `FAIL (${fails} kontrol selhalo)`);
process.exit(fails === 0 ? 0 : 1);
