// Barvy jmen — sdílené addonem i webem (extension/core/, bez DOM a chrome.*).
// Těla funkcí jsou 1:1 z původního sidepanel.js (v3.39.17), jen exportovaná.

// Twitch's default username-color palette — used by the vanilla web client
// when a user hasn't picked a custom color. Order + algorithm RE'd from
// Twitch source (matches what Chatty and tmi.js ship). Without this, every
// colorless user renders in the same brand purple fallback.
export const TWITCH_DEFAULT_COLORS = [
  '#FF0000', '#0000FF', '#008000', '#B22222', '#FF7F50',
  '#9ACD32', '#FF4500', '#2E8B57', '#DAA520', '#D2691E',
  '#5F9EA0', '#1E90FF', '#FF69B4', '#8A2BE2', '#00FF7F',
];
export function twitchDefaultColor(username) {
  if (!username) return '#9146ff';
  const n = username.toLowerCase();
  const sum = n.charCodeAt(0) + n.charCodeAt(n.length - 1);
  return TWITCH_DEFAULT_COLORS[sum % TWITCH_DEFAULT_COLORS.length];
}

// Twitch's "Global Emotes" panel ships these legacy face emotes at a tiny
// native resolution — upscaling makes them blurry. We render them smaller
// to match vanilla chat. Stable across ID renumbering (e.g. <3 = 555555584).
const TWITCH_OG_FACE_NAMES = new Set([
  ':)', ':(', ':D', ':P', ':p', ':o', ':O', ';)', ';P', ';p',
  'B)', 'b)', ':|', ':/', ':\\', ':7', ':S', ':s', ':z', ':Z',
  'R)', 'r)', '<3', 'O_o', 'o_O', 'O_O', '8)',
  ':-)', ':-(', ':-D', ':-P', ':-p', ':-O', ':-o',
  '#/', ':?',
]);
export function isTwitchOgFaceName(name) {
  return TWITCH_OG_FACE_NAMES.has(name);
}

// Twitch's vanilla chat lightens dark user colors on dark backgrounds so they
// stay legible (DarkRed #8B0000 → a visible red, etc.). We mirror that: lift
// the HSL Lightness floor to 0.5 and ceiling to 0.85 so both extremes read well.
const READABLE_CACHE = new Map();

// YouTube barvu jména v datech NEPOSÍLÁ (ověřeno na live streamu: renderer
// nese jen authorName/authorPhoto/authorExternalChannelId). Web klient si ji
// počítá sám — live_chat_polymer.js: computeAuthorNameColor → hash z textu
// jména. Tohle je port toho hashe; čitelnost na tmavém pozadí pak dořeší
// readableColor() při renderu, takže kontrastní část jejich algoritmu
// neduplikujeme. Hash se počítá z původního jména VČETNĚ '@', jinak by
// barvy nesouhlasily s tím, co uživatel vidí na YouTube.
export function ytNameColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  let out = '#';
  for (let i = 0; i < 3; i++) out += ('00' + ((h >> (i * 8)) & 255).toString(16)).slice(-2);
  return out;
}

export function readableColor(input) {
  if (!input) return input;
  if (READABLE_CACHE.has(input)) return READABLE_CACHE.get(input);
  const hex = /^#[0-9a-fA-F]{6}$/.test(input) ? input : null;
  if (!hex) { READABLE_CACHE.set(input, input); return input; }
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0, s = 0;
  if (d) {
    s = l < 0.5 ? d / (max + min) : d / (2 - max - min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  // WCAG relative luminance — accounts for hue: pure blue is much harder
  // to read on dark bg than pure red even at the same HSL Lightness, so
  // we boost L extra when perceived luminance is very low. Twitch's vanilla
  // chat does the same — pure #0000FF renders at ~#9999FF (HSL L≈0.8).
  const wcagL = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  let minL = 0.5;
  if (wcagL < 0.10) minL = 0.78;       // very dark (pure blue, dark navy)
  else if (wcagL < 0.20) minL = 0.65;  // dark (e.g. dark red, navy variants)
  const maxL = 0.88;
  let nL = l;
  if (l < minL) nL = minL;
  else if (l > maxL) nL = maxL;
  if (nL === l) { READABLE_CACHE.set(input, hex); return hex; }
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = nL < 0.5 ? nL * (1 + s) : nL + s - nL * s;
  const p = 2 * nL - q;
  const nr = Math.round(hue2rgb(p, q, h + 1 / 3) * 255);
  const ng = Math.round(hue2rgb(p, q, h) * 255);
  const nb = Math.round(hue2rgb(p, q, h - 1 / 3) * 255);
  const out = '#' + [nr, ng, nb].map(x => x.toString(16).padStart(2, '0')).join('');
  READABLE_CACHE.set(input, out);
  return out;
}
