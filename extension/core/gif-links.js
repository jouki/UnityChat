// Rozpoznání odkazu na GIF v textu (odměna „Posílání GIFů", moderace část 4) — klient ho potřebuje hned
// při psaní (bublina cooldownu nad polem, core/gif-cooldown.js).
// VĚDOMÁ KOPIE backend/src/lib/gifMedia.ts (classifyGifUrl, gifCandidate): backend image se staví jen z `backend/`,
// sdílený modul tam importovat nejde (stejně jako core/links.js ↔ lib/links.ts). Logika MUSÍ zůstat shodná —
// backend test gifMedia.test.ts pouští oba moduly na stejné případy. Při změně upravit oba soubory.
import { findLinks } from './links.js';

const TRAIL = /[)\]}>,.!?;:'"]+$/;

/**
 * Odkaz (URL z textu, i bez schématu) → { url, mode: 'direct'|'page' }, nebo null. Stránky Tenor / Giphy /
 * Imgur / 7TV, přímé soubory .gif/.webp/.mp4 z libovolného hostu, Imgur .gifv → .mp4.
 * @param {string} raw
 */
export function classifyGifUrl(raw) {
  let u;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) return null;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const bare = host.replace(/^www\./, '');
  const path = u.pathname.toLowerCase();
  const href = u.toString();

  const seven = bare === '7tv.app' && /^\/emotes\/([0-9a-z]{10,40})\/?$/i.exec(u.pathname);
  if (seven) return { url: `https://cdn.7tv.app/emote/${seven[1]}/4x.webp`, mode: 'direct' };
  if ((bare === 'i.imgur.com') && path.endsWith('.gifv')) {
    u.pathname = u.pathname.replace(/\.gifv$/i, '.mp4');
    return { url: u.toString(), mode: 'direct' };
  }
  if (/\.(gif|webp|mp4)$/.test(path)) return { url: href, mode: 'direct' };
  if (/^(media\d*|c)\.tenor\.com$/.test(host) || /^(media\d*|i)\.giphy\.com$/.test(host)) return path.length > 1 ? { url: href, mode: 'direct' } : null;
  if (bare === 'tenor.com' && /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?view\/[^/]+/.test(path)) return { url: href, mode: 'page' };
  if (bare === 'giphy.com' && /^\/gifs\/[^/]+/.test(path)) return { url: href, mode: 'page' };
  if ((bare === 'imgur.com' || bare === 'm.imgur.com') && /^\/(?:(?:a|gallery|t\/[^/]+)\/)?[a-z0-9]{5,10}\/?$/i.test(u.pathname)) return { url: href, mode: 'page' };
  return null;
}

/** Token zprávy → URL (od schématu, jinak od hostu), bez koncové interpunkce. */
function tokenUrl(token, host) {
  const t = token.replace(TRAIL, '');
  const s = t.search(/https?:\/\//i);
  if (s >= 0) return t.slice(s);
  const i = t.toLowerCase().indexOf(host);
  return i >= 0 ? t.slice(i) : null;
}

/**
 * První odkaz ve zprávě, který vede na GIF: { url, mode, token }, nebo null.
 * @param {string} text
 */
export function gifCandidate(text) {
  for (const l of findLinks(text)) {
    const raw = tokenUrl(l.text, l.host);
    const src = raw ? classifyGifUrl(raw) : null;
    if (src) return { ...src, token: l.text };
  }
  return null;
}

/** Je v textu odkaz na GIF? */
export const hasGifLink = (text) => !!gifCandidate(String(text || ''));
