// Odměna „Posílání GIFů" (moderace část 4, spec docs/superpowers/specs/2026-09-25-moderace-odkazy-gify-design.md):
// rozpoznání odkazu na GIF a jeho převod na médium, které server stáhne a uloží u sebe (lib/gifRequests.ts).
//
//   gifCandidate(text)  → první odkaz ve zprávě, který vede na GIF (Tenor/Giphy/Imgur/7TV stránka nebo přímý soubor)
//   resolveGif(url)     → { bytes, kind, contentType, width, height } nebo GifError
//
// Bezpečnost (server stahuje z URL, kterou zadal divák = SSRF):
//   - jen http(s), jen porty 80/443, bez jména/hesla v URL;
//   - každý host (i po přesměrování, max 3) se přeloží v DNS a VŠECHNY adresy musí být veřejné
//     (loopback, privátní, link-local, CGNAT, multicast, dokumentační, IPv4-mapped IPv6 … = blocked);
//   - výchozí transport (node:http/https) používá ověřující `lookup` i při samotném připojení
//     → DNS rebinding mezi kontrolou a spojením nepomůže; IP literál se ověří přímo;
//   - limit 10 MB (Content-Length i počítání při čtení), stránka max 1 MB, celkový časový limit 10 s;
//   - Content-Type (image/* | video/* | octet-stream) + magic bytes (GIF87a/89a, RIFF…WEBP, MP4 ftyp).
//
// Fallback (lib/gifUnlocker.ts): přímý pokus skončil Cloudflare challenge (403/503 + cf-mitigated: challenge,
// nebo 403 s HTML „Just a moment“ a cf- hlavičkami) → stejná URL (už ověřená assertPublicUrl) přes Bright Data
// Web Unlocker. Na odpověď platí stejné kontroly; přesměrování z ní se ověřuje jako každé jiné. Celkový limit
// se po zapnutí fallbacku prodlouží na UNLOCKER_TIMEOUT_MS (25 s od začátku), víc ne.
import { lookup as dnsLookup } from 'node:dns';
import { isIP, BlockList } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { findLinks } from './links.js';
import { config } from '../config.js';
import type { Unlocker, UnlockEstimator } from './gifUnlocker.js';

export type GifKind = 'gif' | 'webp' | 'mp4';

export const GIF_MAX_BYTES = 10 * 1024 * 1024;
export const PAGE_MAX_BYTES = 1024 * 1024;
export const GIF_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 3;
const UA = 'Mozilla/5.0 (compatible; UnityChatBot/1.0; +https://jouki.cz/UnityChat)';

export class GifError extends Error {
  constructor(public code: string) { super(code); }
}

// ---------------------------------------------------------------------------
// Detekce
// ---------------------------------------------------------------------------

export interface GifSource {
  /** URL, kterou server stáhne. */
  url: string;
  /** direct = soubor média; page = HTML stránka s og:video / og:image; own = odkaz na naše médium (nestahuje se). */
  mode: 'direct' | 'page' | 'own';
  /** mode own: id média v gif_media (32 hex). */
  mediaId?: string;
}

const TRAIL = /[)\]}>,.!?;:'"]+$/;

/** Hosty našeho serveru: odkaz `<host>/media/gif/<id>` (výběr z knihovny) = známé médium, ne stahování. */
export function defaultOwnHosts(): string[] {
  const out = ['api.jouki.cz'];
  try { const h = new URL(config.PUBLIC_BASE_URL).hostname.toLowerCase(); if (!out.includes(h)) out.push(h); } catch { /* ignore */ }
  return out;
}

const OWN_PATH = /^\/media\/gif\/([a-f0-9]{32})\/?$/;

/**
 * Odkaz (URL z textu, i bez schématu) → zdroj GIFu, nebo null. Stránky Tenor / Giphy / Imgur / 7TV, přímé
 * soubory .gif/.webp/.mp4 z libovolného hostu (každý GIF schvaluje mod), Imgur .gifv → .mp4, odkaz na naše
 * médium (`ownHosts` + `/media/gif/<32 hex>`) → mode own.
 */
export function classifyGifUrl(raw: string, ownHosts: string[] = defaultOwnHosts()): GifSource | null {
  let u: URL;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) return null;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const bare = host.replace(/^www\./, '');
  const path = u.pathname.toLowerCase();
  const href = u.toString();

  const own = ownHosts.includes(host) && OWN_PATH.exec(u.pathname);
  if (own) return { url: `${u.origin}${u.pathname}`, mode: 'own', mediaId: own[1] };

  // 7TV emote stránka → animované WebP z CDN (stránka je SPA bez og tagů).
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
function tokenUrl(token: string, host: string): string | null {
  const t = token.replace(TRAIL, '');
  const s = t.search(/https?:\/\//i);
  if (s >= 0) return t.slice(s);
  const i = t.toLowerCase().indexOf(host);
  return i >= 0 ? t.slice(i) : null;
}

export interface GifCandidate extends GifSource {
  /** Token zprávy s odkazem (odstraní se z textu žádosti). */
  token: string;
}

/** První odkaz ve zprávě, který vede na GIF; null = žádný. Detekce odkazů = sdílený detektor (lib/links.ts). */
export function gifCandidate(text: string, ownHosts: string[] = defaultOwnHosts()): GifCandidate | null {
  for (const l of findLinks(text)) {
    const raw = tokenUrl(l.text, l.host);
    const src = raw ? classifyGifUrl(raw, ownHosts) : null;
    if (src) return { ...src, token: l.text };
  }
  return null;
}

/** Sledovací parametry, které nemění médium (dedup podle URL). */
const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'igshid', 'mc_cid', 'mc_eid']);

/**
 * URL zdroje pro dedup před stažením: bez `utm_*` a sledovacích parametrů, bez fragmentu, schéma a host
 * malými písmeny (URL to dělá sama), výchozí port pryč, zbylé parametry seřazené. Neplatná / ne-http(s) → null.
 */
export function normalizeSourceUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/\.$/, '');
  const keep = [...u.searchParams].filter(([k]) => !/^utm_/i.test(k) && !TRACKING_PARAMS.has(k.toLowerCase()))
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  u.search = keep.length ? new URLSearchParams(keep).toString() : '';
  return u.toString();
}

/**
 * Text zprávy bez odkazu na GIF (zobrazí se nad GIFem). `blocked(host)` = filtr odkazů by host zablokoval →
 * takový token se z publikovaného textu vyřadí taky (jinak by schválený GIF propašoval zakázaný odkaz).
 */
export function textWithoutLink(text: string, token: string, blocked?: (host: string) => boolean): string {
  return String(text || '').split(/\s+/)
    .filter((t) => t && t !== token && !(blocked && findLinks(t).some((l) => blocked(l.host))))
    .join(' ').trim().slice(0, 500);
}

// ---------------------------------------------------------------------------
// SSRF: veřejné adresy
// ---------------------------------------------------------------------------

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64], ['2001::', 32], ['2002::', 16],
] as const) blocked.addSubnet(net, bits, 'ipv6');

/** IPv6 → 8 skupin (16 bit), null = neplatná. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const p = v4[1].split('.').map(Number);
    s = s.slice(0, -v4[1].length) + `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = s.includes('::') ? 8 - h.length - t.length : 0;
  const all = [...h, ...Array(Math.max(0, fill)).fill('0'), ...t];
  if (all.length !== 8) return null;
  const nums = all.map((g) => parseInt(g, 16));
  return nums.every((n) => Number.isFinite(n) && n >= 0 && n <= 0xffff) ? nums : null;
}

/** true = adresa není veřejná (loopback, privátní, link-local, …) nebo neplatná → nestahovat. */
export function isBlockedIp(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return blocked.check(ip, 'ipv4');
  if (fam !== 6) return true;
  const g = ipv6Groups(ip);
  if (!g) return true;
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) a NAT64 (64:ff9b::/96) → ověřit vloženou IPv4.
  const embedded = (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0))
    || (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0));
  if (embedded) {
    const v4 = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
    if (g[5] === 0 && g[6] === 0 && g[7] <= 1) return true; // :: a ::1
    return blocked.check(v4, 'ipv4');
  }
  return blocked.check(g.map((x) => x.toString(16)).join(':'), 'ipv6');
}

export type LookupAll = (host: string) => Promise<Array<{ address: string; family: number }>>;

export const defaultLookupAll: LookupAll = (host) => new Promise((resolve, reject) => {
  dnsLookup(host, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs)));
});

/** Ověří URL: schéma, port, bez přihlašovacích údajů, všechny DNS adresy veřejné. Jinak GifError('blocked' | 'bad_url'). */
export async function assertPublicUrl(u: URL, lookupAll: LookupAll = defaultLookupAll): Promise<void> {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new GifError('bad_url');
  if (u.username || u.password) throw new GifError('bad_url');
  if (u.port && u.port !== '80' && u.port !== '443') throw new GifError('blocked');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new GifError('bad_url');
  if (isIP(host)) { if (isBlockedIp(host)) throw new GifError('blocked'); return; }
  let addrs: Array<{ address: string }>;
  try { addrs = await lookupAll(host); } catch { throw new GifError('dns'); }
  if (!addrs.length || addrs.some((a) => isBlockedIp(a.address))) throw new GifError('blocked');
}

// ---------------------------------------------------------------------------
// Transport (injektovatelný kvůli testům)
// ---------------------------------------------------------------------------

export interface TransportResponse {
  status: number;
  /** Hlavičky s malými písmeny. */
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  /** Zahodit zbytek těla (přesměrování, chyba). */
  dispose(): void;
}
export type Transport = (url: URL, headers: Record<string, string>, signal: AbortSignal) => Promise<TransportResponse>;

/** `lookup` pro net.connect: ověří každou adresu i při samotném připojení (proti DNS rebindingu). */
function safeConnectLookup(hostname: string, options: { all?: boolean } | number, cb: (...a: unknown[]) => void): void {
  const all = typeof options === 'object' && !!options?.all;
  dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => isBlockedIp(a.address))) return cb(new GifError('blocked'));
    if (all) cb(null, addrs);
    else cb(null, addrs[0].address, addrs[0].family);
  });
}

/** Výchozí transport: node:http/https bez automatických přesměrování, s ověřujícím lookupem. */
export const nodeTransport: Transport = (url, headers, signal) => new Promise((resolve, reject) => {
  const mod = url.protocol === 'https:' ? https : http;
  const req = mod.request(url, { method: 'GET', headers, signal, lookup: safeConnectLookup as never }, (res) => {
    const h: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(res.headers)) h[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
    resolve({ status: res.statusCode ?? 0, headers: h, body: res, dispose: () => res.destroy() });
  });
  req.on('error', reject);
  req.end();
});

// ---------------------------------------------------------------------------
// Stahování
// ---------------------------------------------------------------------------

export interface FetchDeps {
  transport?: Transport;
  lookupAll?: LookupAll;
  /** Fallback přes Bright Data Web Unlocker; null/undefined = vypnutý. */
  unlocker?: Unlocker | null;
  /** Odhad doby fallbacku (průběh u odesílatele); doby úspěšných stažení přes unlocker se do něj zapisují. */
  estimator?: UnlockEstimator | null;
  /** Průběh stahování média (fáze download = bajty; unlock = odhad doby Bright Data). */
  onProgress?: (e: GifFetchProgress) => void;
  /** Sonda rozměrů a počtu snímků bez dekódování (lib/gifPhash.ts probeMedia); chybí = jen rozměry z hlavičky. */
  probe?: MediaProber;
}

/**
 * Strop rozměru (px na stranu) a počtu snímků média (audit SEC-7): GIF 16384×16384 nebo tisíce snímků má pár set kB,
 * ale dekódování v prohlížeči modů / v OBS / ve worker hashi = stovky MB až GB RAM. Nad limit → GifError('too_large').
 */
export const GIF_MAX_DIM = 2048;
export const GIF_MAX_FRAMES = 600;
export interface MediaProbe { width: number | null; height: number | null; frames: number | null }
/** Sonda média: null = nástroj chybí (jen hlavička); výjimka = poškozené médium (odmítnout). */
export type MediaProber = (bytes: Buffer, kind: GifKind) => Promise<MediaProbe | null>;

export type GifFetchProgress =
  | { phase: 'download'; loaded: number; total: number | null }
  | { phase: 'unlock'; estimateMs: number; elapsedMs: number };

/** Výchozí odhad doby Bright Data, dokud nejsou vzorky. */
export const UNLOCK_DEFAULT_ESTIMATE_MS = 8000;

/** Běh jednoho převodu: společný signál + prodloužení limitu při fallbacku + URL, které šly přes unlocker. */
interface Ctx {
  signal: AbortSignal;
  /** Prodlouží celkový limit na `totalMs` od začátku převodu (jen směrem nahoru). */
  extend(totalMs: number): void;
  unlocked: URL[];
  /** Začátek posledního stažení přes unlocker (ms). */
  unlockStart: number;
}

const safeProgress = (deps: FetchDeps, e: GifFetchProgress): void => { try { deps.onProgress?.(e); } catch { /* ignore */ } };

const CHALLENGE_SNIFF_BYTES = 64 * 1024;

/** Odpověď je Cloudflare challenge? (403/503 + cf-mitigated: challenge; 403 + HTML „Just a moment“ s cf- hlavičkami) */
export async function isCloudflareChallenge(res: TransportResponse, signal: AbortSignal): Promise<boolean> {
  if (res.status !== 403 && res.status !== 503) return false;
  if (/\bchallenge\b/i.test(String(res.headers['cf-mitigated'] || ''))) return true;
  if (res.status !== 403) return false;
  const cf = /cloudflare/i.test(String(res.headers.server || '')) || Object.keys(res.headers).some((k) => k.startsWith('cf-'));
  if (!cf || !/html/i.test(String(res.headers['content-type'] || ''))) return false;
  let html: string;
  try { html = (await readLimited(res, CHALLENGE_SNIFF_BYTES, signal, true)).toString('utf8'); } catch { return false; }
  return /just a moment|challenge-platform|cf-chl-|cf_chl_/i.test(html);
}

/** GET s ručními přesměrováními (max 3, každé znovu ověřené) → odpověď se statusem 2xx. */
async function safeGet(start: string, accept: string, ctx: Ctx, deps: FetchDeps): Promise<{ res: TransportResponse; url: URL }> {
  const transport = deps.transport ?? nodeTransport;
  const signal = ctx.signal;
  let url: URL;
  try { url = new URL(start); } catch { throw new GifError('bad_url'); }
  for (let hop = 0; ; hop++) {
    // Veřejná adresa se ověří VŽDY před jakýmkoli stažením — i před předáním URL do Bright Data.
    await assertPublicUrl(url, deps.lookupAll);
    let res: TransportResponse;
    try { res = await transport(url, { Accept: accept, 'User-Agent': UA, 'Accept-Encoding': 'identity' }, signal); }
    catch (e) { throw e instanceof GifError ? e : new GifError(signal.aborted ? 'timeout' : 'network'); }
    // Ochrana proti botům (Cloudflare challenge) = jediný případ pro Bright Data; jiné chyby (404, HTML místo
    // média, velikost…) jdou rovnou ven bez placeného pokusu. Bez možnosti obejít → vlastní kód bot_protection.
    if ((res.status === 403 || res.status === 503) && await isCloudflareChallenge(res, signal)) {
      res.dispose();
      const original = new GifError('bot_protection');
      if (!deps.unlocker) throw original;
      ctx.extend(deps.unlocker.timeoutMs);
      // Zapsat předem: i chyba samotného API jde do reportu (log + negativní cache).
      ctx.unlocked.push(url);
      ctx.unlockStart = Date.now();
      safeProgress(deps, { phase: 'unlock', estimateMs: deps.estimator?.estimate(null) ?? UNLOCK_DEFAULT_ESTIMATE_MS, elapsedMs: 0 });
      const via = await deps.unlocker.fetch(url, signal);
      if (!via) { ctx.unlocked.pop(); throw original; } // strop / negativní cache → původní chyba, nic nereportovat
      res = via;
      // Bright Data přesměrování sleduje u sebe; kdyby odpověď nesla cílovou adresu, musí být veřejná.
      for (const k of ['x-brd-final-url', 'x-final-url', 'content-location']) {
        const v = res.headers[k];
        if (!v) continue;
        let fin: URL;
        try { fin = new URL(v, url); } catch { res.dispose(); throw new GifError('bad_url'); }
        try { await assertPublicUrl(fin, deps.lookupAll); } catch (e) { res.dispose(); throw e; }
      }
    }
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      res.dispose();
      if (hop >= MAX_REDIRECTS) throw new GifError('too_many_redirects');
      try { url = new URL(res.headers.location, url); } catch { throw new GifError('bad_url'); }
      continue;
    }
    if (res.status < 200 || res.status >= 300) { res.dispose(); throw new GifError(`http_${res.status}`); }
    return { res, url };
  }
}

/** Tělo s limitem velikosti (Content-Length předem, pak počítání). */
async function readLimited(res: TransportResponse, max: number, signal: AbortSignal, truncate = false, onChunk?: (loaded: number, total: number | null) => void): Promise<Buffer> {
  const len = Number(res.headers['content-length']);
  if (!truncate && Number.isFinite(len) && len > max) { res.dispose(); throw new GifError('too_large'); }
  const expected = Number.isFinite(len) && len > 0 ? len : null;
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const c of res.body) {
      total += c.byteLength;
      if (total > max) {
        // Stránka: stačí začátek (og tagy jsou v <head>), zbytek zahodit.
        if (truncate) { chunks.push(Buffer.from(c).subarray(0, c.byteLength - (total - max))); res.dispose(); break; }
        throw new GifError('too_large');
      }
      chunks.push(Buffer.from(c));
      onChunk?.(total, expected);
    }
  } catch (e) {
    res.dispose();
    throw e instanceof GifError ? e : new GifError(signal.aborted ? 'timeout' : 'network');
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Rozpoznání média
// ---------------------------------------------------------------------------

/** Magic bytes → druh média; null = není GIF/WebP/MP4. */
export function sniffKind(b: Buffer): GifKind | null {
  if (b.length >= 6 && (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (b.length >= 12 && b.subarray(4, 8).toString('latin1') === 'ftyp') return 'mp4';
  return null;
}

export const CONTENT_TYPES: Record<GifKind, string> = { gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4' };

/** Content-Type odpovědi odpovídá druhu média? (octet-stream projde, magic bytes rozhodnou) */
export function contentTypeOk(ct: string | undefined, kind: GifKind): boolean {
  const t = String(ct || '').split(';')[0].trim().toLowerCase();
  if (t === 'application/octet-stream' || t === 'binary/octet-stream') return true;
  return kind === 'mp4' ? t.startsWith('video/') : t.startsWith('image/');
}

// Bez horního stropu: rozměr nad GIF_MAX_DIM médium odmítne (withinLimits), ne že by se tvářilo jako neznámý.
const okDim = (n: number): number | null => (Number.isFinite(n) && n > 0 ? n : null);

/** Rozměry z hlavičky (GIF, WebP VP8/VP8L/VP8X, MP4 tkhd); neznámé → null. */
export function mediaSize(b: Buffer, kind: GifKind): { width: number | null; height: number | null } {
  try {
    if (kind === 'gif' && b.length >= 10) return { width: okDim(b.readUInt16LE(6)), height: okDim(b.readUInt16LE(8)) };
    if (kind === 'webp' && b.length >= 30) {
      const chunk = b.subarray(12, 16).toString('latin1');
      if (chunk === 'VP8X') return { width: okDim(1 + b.readUIntLE(24, 3)), height: okDim(1 + b.readUIntLE(27, 3)) };
      if (chunk === 'VP8 ') return { width: okDim(b.readUInt16LE(26) & 0x3fff), height: okDim(b.readUInt16LE(28) & 0x3fff) };
      if (chunk === 'VP8L' && b[20] === 0x2f) {
        const b1 = b[22], b2 = b[23], b3 = b[24];
        return { width: okDim(1 + (((b1 & 0x3f) << 8) | b[21])), height: okDim(1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))) };
      }
    }
    if (kind === 'mp4') {
      // První tkhd s nenulovými rozměry (video stopa); šířka/výška = posledních 8 bajtů boxu, fixed 16.16.
      for (let i = b.indexOf('tkhd', 0, 'latin1'); i >= 4; i = b.indexOf('tkhd', i + 4, 'latin1')) {
        const size = b.readUInt32BE(i - 4);
        const end = i - 4 + size;
        if (size < 84 || end > b.length) continue;
        const w = b.readUInt32BE(end - 8) >>> 16, h = b.readUInt32BE(end - 4) >>> 16;
        if (w && h) return { width: okDim(w), height: okDim(h) };
      }
    }
  } catch { /* poškozená hlavička → bez rozměrů */ }
  return { width: null, height: null };
}

const decodeEntities = (s: string): string => s.replace(/&amp;/g, '&').replace(/&#x2F;/gi, '/').replace(/&#47;/g, '/').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/gi, "'");

/** `<meta property|name="…" content="…">` stránky → klíč (malými) → hodnoty v pořadí výskytu. */
function metaTags(html: string): Record<string, string[]> {
  const meta: Record<string, string[]> = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const value = content ? (content[1] ?? content[2]) : undefined;
    if (!key || value === undefined) continue;
    (meta[key] ??= []).push(decodeEntities(value.trim()));
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Tagy ze zdroje (GIF knihovna 2026-09-26): z HTML stránky Tenor / Giphy, které se stahuje kvůli og:video —
// žádný požadavek navíc. Přímý odkaz na soubor tagy nemá (správa v dashboardu Židolišty).
// ---------------------------------------------------------------------------

export const MAX_TAGS = 20;
export const MAX_TAG_LEN = 40;
/** Obecná slova, která k hledání nic nepřidají. */
const GENERIC_TAGS = new Set(['gif', 'gifs', 'animated gif', 'animated gifs', 'animated', 'sticker', 'stickers', 'tenor', 'giphy', 'tenor gif', 'giphy gif', 'reaction gif']);

/** Titulek / klíčové slovo bez přípony zdroje („X GIF - … - Discover & Share GIFs“, „X GIF by Y - Find & Share on GIPHY“). */
function cleanTitle(s: string): string {
  return s.split(/\s+[-–|]\s+/)[0].replace(/\s+(?:gif|sticker)(?:\s+by\s+.*)?$/i, '').trim();
}

/**
 * Tagy → malá písmena, bez `#` a přebytečných mezer, bez obecných slov a duplicit, každý nejvýš MAX_TAG_LEN
 * znaků, celkem nejvýš MAX_TAGS. Ne-řetězce se zahodí.
 */
export function normalizeTags(raw: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const t = v.normalize('NFKC').toLowerCase().replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LEN).trim();
    if (!t || GENERIC_TAGS.has(t) || out.includes(t)) continue;
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** `keywords` z JSON-LD bloků (řetězec s čárkami nebo pole), rekurzivně. */
function jsonLdKeywords(html: string): string[] {
  const out: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 6 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'keywords') {
        if (typeof x === 'string') out.push(...x.split(','));
        else if (Array.isArray(x)) out.push(...x.filter((s): s is string => typeof s === 'string'));
      } else walk(x, depth + 1);
    }
  };
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(m[1]), 0); } catch { /* neplatný JSON-LD → nic */ }
  }
  return out;
}

/** Tagy ze stránky zdroje: titulek (og:title / twitter:title bez přípony), `keywords`, JSON-LD keywords. */
export function pageTags(html: string): string[] {
  const meta = metaTags(html);
  const title = meta['og:title']?.[0] ?? meta['twitter:title']?.[0] ?? '';
  const keywords = (meta.keywords ?? []).flatMap((k) => k.split(','));
  return normalizeTags([title, ...keywords, ...jsonLdKeywords(html)].map((s) => cleanTitle(decodeEntities(String(s)))));
}

/** og:video (MP4) přednostně, jinak og:image; URL relativně ke stránce. */
export function pickOgMedia(html: string, base: URL): string | null {
  const meta = metaTags(html);
  const first = (keys: string[], filter?: (u: string) => boolean): string | null => {
    for (const k of keys) for (const v of meta[k] ?? []) if (v && (!filter || filter(v))) return v;
    return null;
  };
  const video = first(['og:video:secure_url', 'og:video:url', 'og:video'], (v) => /\.mp4(\?|$)/i.test(v))
    ?? ((meta['og:video:type'] ?? []).some((t) => /video\/mp4/i.test(t)) ? first(['og:video:secure_url', 'og:video:url', 'og:video']) : null);
  const pick = video ?? first(['og:image:secure_url', 'og:image:url', 'og:image']);
  if (!pick) return null;
  try { return new URL(pick, base).toString(); } catch { return null; }
}

export interface ResolvedGif {
  bytes: Buffer;
  kind: GifKind;
  contentType: string;
  width: number | null;
  height: number | null;
  /** URL, ze které se médium nakonec stáhlo (log). */
  sourceUrl: string;
  /** Tagy ze stránky zdroje (jen mode page — Tenor/Giphy/Imgur stránka); přímý soubor tagy nemá. */
  tags?: string[];
}

async function fetchMedia(url: string, ctx: Ctx, deps: FetchDeps): Promise<ResolvedGif> {
  const signal = ctx.signal;
  // Accept image/*,video/* — media*.tenor.com posílá prohlížeči při navigaci HTML obal, čisté médium jen s ním.
  const n = ctx.unlocked.length;
  const { res, url: final } = await safeGet(url, 'image/*,video/*', ctx, deps);
  // Unlocker nemusí předat Content-Type cíle → bez něj rozhodnou magic bytes (jako u octet-stream).
  const viaUnlock = ctx.unlocked.length > n;
  const ct = res.headers['content-type'] ?? (viaUnlock ? 'application/octet-stream' : undefined);
  if (/^\s*text\//i.test(String(ct || ''))) { res.dispose(); throw new GifError('bad_type'); }
  if (viaUnlock) {
    // Velikost z odpovědi Bright Data → odhad doby přepočítaný podle ní.
    const len = Number(res.headers['content-length']);
    if (Number.isFinite(len) && len > 0 && deps.estimator) safeProgress(deps, { phase: 'unlock', estimateMs: deps.estimator.estimate(len), elapsedMs: Date.now() - ctx.unlockStart });
  }
  // Přes unlocker se bajty nehlásí (klient animuje lineárně podle odhadu), jinak skutečné bajty.
  const bytes = await readLimited(res, GIF_MAX_BYTES, signal, false, viaUnlock ? undefined : (loaded, total) => safeProgress(deps, { phase: 'download', loaded, total }));
  const kind = sniffKind(bytes);
  if (!kind) throw new GifError('bad_magic');
  if (!contentTypeOk(ct, kind)) throw new GifError('bad_type');
  if (viaUnlock) deps.estimator?.record(Math.max(1, Date.now() - ctx.unlockStart), bytes.length);
  return { bytes, kind, contentType: CONTENT_TYPES[kind], ...mediaSize(bytes, kind), sourceUrl: final.toString() };
}

/**
 * Zdroj → stažené a ověřené médium. Stránka: og:video (MP4), jinak og:image. Celý převod (stránka + médium +
 * přesměrování) má jeden časový limit 10 s. Chyba = GifError s kódem (zpráva se pak bere jako běžný odkaz).
 */
export async function resolveGif(src: GifSource, deps: FetchDeps & { timeoutMs?: number } = {}): Promise<ResolvedGif> {
  const started = Date.now();
  const ctl = new AbortController();
  let limit = deps.timeoutMs ?? GIF_TIMEOUT_MS;
  const arm = (): ReturnType<typeof setTimeout> => {
    const t = setTimeout(() => ctl.abort(), Math.max(0, limit - (Date.now() - started)));
    t.unref?.();
    return t;
  };
  let timer = arm();
  const ctx: Ctx = {
    signal: ctl.signal,
    extend(totalMs) { if (totalMs > limit && !ctl.signal.aborted) { limit = totalMs; clearTimeout(timer); timer = arm(); } },
    unlocked: [],
    unlockStart: 0,
  };
  // Odkaz na naše médium se nestahuje (lib/gifRequests.ts ho dohledá podle id).
  if (src.mode === 'own') { clearTimeout(timer); throw new GifError('own_media'); }
  try {
    const r = await resolveWith(src, ctx, deps);
    for (const u of ctx.unlocked) deps.unlocker?.report(u, null);
    return r;
  } catch (e) {
    const code = e instanceof GifError ? e.code : (ctl.signal.aborted ? 'timeout' : 'exception');
    for (const u of ctx.unlocked) deps.unlocker?.report(u, code);
    throw e instanceof GifError ? e : new GifError(code);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Limity média (audit SEC-7) ještě před uložením: rozměr z hlavičky, pak sonda (sharp metadata / ffprobe — snímky
 * se nedekódují). Sonda bez nástroje → jen hlavička; poškozené médium → bad_media.
 */
export async function withinLimits(r: ResolvedGif, deps: Pick<FetchDeps, 'probe'>): Promise<ResolvedGif> {
  const over = (n: number | null | undefined) => n != null && n > GIF_MAX_DIM;
  if (over(r.width) || over(r.height)) throw new GifError('too_large');
  if (!deps.probe) return r;
  let p: MediaProbe | null;
  try { p = await deps.probe(r.bytes, r.kind); }
  catch (e) { throw e instanceof GifError ? e : new GifError('bad_media'); }
  if (!p) return r;
  if (over(p.width) || over(p.height) || (p.frames ?? 0) > GIF_MAX_FRAMES) throw new GifError('too_large');
  return { ...r, width: r.width ?? p.width, height: r.height ?? p.height };
}

async function resolveWith(src: GifSource, ctx: Ctx, deps: FetchDeps): Promise<ResolvedGif> {
  const signal = ctx.signal;
  if (src.mode === 'direct') return withinLimits(await fetchMedia(src.url, ctx, deps), deps);
  const { res, url } = await safeGet(src.url, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', ctx, deps);
  const ct = String(res.headers['content-type'] || (ctx.unlocked.length ? 'application/octet-stream' : ''));
  if (!/html/i.test(ct)) {
    // Stránka vrátila rovnou médium (např. imgur přesměruje na i.imgur.com) — ověřit jako médium.
    const bytes = await readLimited(res, GIF_MAX_BYTES, signal);
    const kind = sniffKind(bytes);
    if (!kind || !contentTypeOk(ct, kind)) throw new GifError('no_media');
    return withinLimits({ bytes, kind, contentType: CONTENT_TYPES[kind], ...mediaSize(bytes, kind), sourceUrl: url.toString() }, deps);
  }
  const html = (await readLimited(res, PAGE_MAX_BYTES, signal, true)).toString('utf8');
  const media = pickOgMedia(html, url);
  if (!media) throw new GifError('no_media');
  const tags = pageTags(html);
  const r = await withinLimits(await fetchMedia(media, ctx, deps), deps);
  return tags.length ? { ...r, tags } : r;
}
