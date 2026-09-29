// Stažení přes proxy Bright Data (Web Unlocker v „native proxy“ režimu) pro weby, které blokují IP našeho serveru
// úplně — stránky i CDN (Imgur, 2026-09-28: 429 „over capacity“ pro imgur.com i i.imgur.com; API režim
// /request médium nedá, imgur mu vrací HTML stránku). Přes proxy jde požadavek s našimi hlavičkami, takže
// médium dorazí jako médium.
//
// Proxy: brd.superproxy.io:44445, uživatel brd-customer-<customer id>-zone-<zóna>, heslo zóny (docs.brightdata.com,
// ověřeno 2026-09-29). HTTPS: proxy spojení rozbaluje (MITM) a podepisuje vlastní CA — bez ní (BRIGHTDATA_PROXY_CA)
// se u proxovaných hostů certifikát neověřuje; přihlášení k proxy jde stejně v prostém HTTP CONNECT (jejich design).
// Bez úniků: heslo jen do hlavičky Proxy-Authorization, nikdy do logu ani do chyby.
//
// Před každým požadavkem dál platí assertPublicUrl (gifMedia safeGet / fetchMedia) — proxy nic neobchází.

import http from 'node:http';
import tls from 'node:tls';
import type { Transport, TransportResponse } from './gifMedia.js';
import { GifError } from './gifMedia.js';

export const PROXY_HOST = 'brd.superproxy.io';
export const PROXY_PORT = 44445;
/** Hosty, které blokují IP serveru (subdomény včetně). */
export const PROXY_HOSTS = ['imgur.com'];

export type ProxyLog = (obj: { host: string; code?: string }, msg: string) => void;

export interface GifProxyOptions {
  customerId: string;
  zone: string;
  password: string;
  /** PEM certifikát CA Bright Data (i base64 PEM). Prázdné = u proxovaných hostů bez ověření certifikátu. */
  ca?: string;
  /** Denní strop požadavků (reset o půlnoci UTC); 0 = vypnuto. */
  dailyCap: number;
  hosts?: string[];
  /** Adresa proxy (testy). */
  proxyHost?: string;
  proxyPort?: number;
  now?: () => number;
  log?: ProxyLog;
}

export interface GifProxy {
  /** Transport pro host, který jde přes proxy; null = přímé stažení. Při vyčerpaném stropu GifError('proxy_cap'). */
  transportFor(host: string): Transport | null;
  readonly usedToday: number;
}

/** Host (malými písmeny) patří pod některý z blokujících hostů? */
export function isProxiedHost(host: string, hosts: readonly string[] = PROXY_HOSTS): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return hosts.some((p) => h === p || h.endsWith(`.${p}`));
}

/** PEM z envu: prázdné → undefined; base64 (Coolify neumí víceřádkové hodnoty) → dekódovat. */
export function parseCa(raw: string | undefined): string | undefined {
  const v = String(raw || '').trim();
  if (!v) return undefined;
  if (/-----BEGIN/.test(v)) return v;
  try {
    const dec = Buffer.from(v, 'base64').toString('utf8');
    return /-----BEGIN/.test(dec) ? dec : undefined;
  } catch { return undefined; }
}

/** Bez customer id, zóny, hesla nebo se stropem 0 → null = proxy vypnutá. */
export function createGifProxy(opts: GifProxyOptions): GifProxy | null {
  const customerId = String(opts.customerId || '').trim();
  const zone = String(opts.zone || '').trim();
  const password = String(opts.password || '');
  if (!customerId || !zone || !password || !(opts.dailyCap > 0)) return null;
  const hosts = opts.hosts ?? PROXY_HOSTS;
  const proxyHost = opts.proxyHost ?? PROXY_HOST;
  const proxyPort = opts.proxyPort ?? PROXY_PORT;
  const ca = parseCa(opts.ca);
  const now = opts.now ?? Date.now;
  const log: ProxyLog = opts.log ?? (() => {});
  const auth = 'Basic ' + Buffer.from(`brd-customer-${customerId}-zone-${zone}:${password}`).toString('base64');
  let day = '';
  let used = 0;
  let warnedCa = false;
  const utcDay = (): string => new Date(now()).toISOString().slice(0, 10);
  const take = (host: string): void => {
    const d = utcDay();
    if (d !== day) { day = d; used = 0; }
    if (used >= opts.dailyCap) { log({ host, code: 'proxy_cap' }, 'gif proxy: denní strop vyčerpán'); throw new GifError('proxy_cap'); }
    used++;
  };

  const transport: Transport = (url, headers, signal) => new Promise((resolve, reject) => {
    try { take(url.hostname); } catch (e) { reject(e); return; }
    if (!ca && !warnedCa) { warnedCa = true; log({ host: url.hostname }, 'gif proxy: bez BRIGHTDATA_PROXY_CA — certifikát proxovaných hostů se neověřuje'); }
    const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
    const connect = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: `${url.hostname}:${port}`,
      headers: { 'Proxy-Authorization': auth, Host: `${url.hostname}:${port}` },
      signal,
    });
    connect.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        log({ host: url.hostname, code: `proxy_${res.statusCode}` }, 'gif proxy: CONNECT odmítnut');
        reject(new GifError(`proxy_${res.statusCode}`));
        return;
      }
      const stream = url.protocol === 'https:'
        ? tls.connect({ socket, servername: url.hostname, ...(ca ? { ca } : { rejectUnauthorized: false }) })
        : socket;
      const req = http.request({
        createConnection: () => stream,
        host: url.hostname,
        port,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        headers: { ...headers, Host: url.host },
        signal,
      }, (r) => {
        const h: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(r.headers)) h[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
        const out: TransportResponse = { status: r.statusCode ?? 0, headers: h, body: r, dispose: () => { r.destroy(); stream.destroy(); } };
        resolve(out);
      });
      req.on('error', (e) => { stream.destroy(); reject(signal.aborted ? new GifError('timeout') : e); });
      stream.on('error', (e) => reject(e));
      req.end();
    });
    connect.on('error', (e) => { log({ host: url.hostname, code: 'proxy_connect' }, 'gif proxy: spojení s proxy selhalo'); reject(signal.aborted ? new GifError('timeout') : e); });
    connect.end();
  });

  return {
    transportFor(host) { return isProxiedHost(host, hosts) ? transport : null; },
    get usedToday() { return utcDay() === day ? used : 0; },
  };
}
