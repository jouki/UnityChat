import { normalizeYoutubeAction } from './normalize.js';
import { noopLog, type Logger } from './twitch.js';
import type { IngestListener, IngestMessage, PlatformStatus } from './types.js';

interface Opts { fetchImpl?: typeof fetch; log?: Logger; liveCheckMs?: number; onlineCheckMs?: number; minPollMs?: number }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
// SOCS=CAI: bez něj YouTube ze serverové IP přesměruje na consent stránku
// (?cbrd=1&ucbcb=1) a vrátí okleštěný HTML.
const HEADERS = { 'User-Agent': UA, 'Accept-Language': 'cs,en;q=0.8', Cookie: 'SOCS=CAI' };

/**
 * videoId živého streamu z watch stránky. První "videoId" v HTML NENÍ
 * spolehlivý — ze serverové IP dostane stránka jiný layout a první výskyt
 * je klidně starší video (ověřeno 2026-09-19: chat „disabled", zatímco live
 * bylo jiné id). currentVideoEndpoint je id právě otevřeného videa.
 */
export function pickLiveVideoId(html: string): string | null {
  const isLive = html.includes('"isLive":true') || html.includes('"isLiveNow":true') || html.includes('"isLiveBroadcast":true');
  if (!isLive) return null;
  const cur = html.match(/"currentVideoEndpoint":\{[^{}]{0,200}\{[^{}]{0,200}"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/)
    || html.match(/"currentVideoEndpoint":\{[\s\S]{0,400}?"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/);
  if (cur) return cur[1];
  const first = html.match(/"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/);
  return first ? first[1] : null;
}

/** Brace-counting extrakce `var ytInitialData = {...}` — regex selže na vnořených objektech. */
export function extractJson(html: string, varName: string): unknown {
  const markers = [`var ${varName} = `, `window["${varName}"] = `, `window['${varName}'] = `];
  let start = -1;
  for (const m of markers) { const i = html.indexOf(m); if (i !== -1) { start = i + m.length; break; } }
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { try { return JSON.parse(html.substring(start, i + 1)); } catch { return null; } }
    }
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Lcr = any;
export function lcr(data: unknown): Lcr | null {
  const d = data as { contents?: { liveChatRenderer?: Lcr }; continuationContents?: { liveChatContinuation?: Lcr } };
  return d?.contents?.liveChatRenderer || d?.continuationContents?.liveChatContinuation || null;
}

/** Reload token režimu „Chat" (všechny zprávy); null když už v něm jsme / chybí. */
export function pickAllChatToken(l: Lcr): string | null {
  const items = l?.header?.liveChatHeaderRenderer?.viewSelector?.sortFilterSubMenuRenderer?.subMenuItems;
  if (!Array.isArray(items) || items.length < 2) return null;
  const all = items[items.length - 1];
  if (all?.selected) return null;
  return all?.continuation?.reloadContinuationData?.continuation || null;
}

export function pickTimedContinuation(l: Lcr): { continuation: string; timeoutMs: number } | null {
  for (const c of l?.continuations || []) {
    if (c?.timedContinuationData?.continuation) {
      return { continuation: c.timedContinuationData.continuation, timeoutMs: c.timedContinuationData.timeoutMs || 5000 };
    }
  }
  return null;
}

/**
 * Port YouTubeProvider z extension: findLiveVideoId → live_chat (popout,
 * přepnutí na režim „všechny zprávy") → get_live_chat polling, při ztrátě
 * timed continuation page-refresh. Bez cookies, vlastní UA.
 */
export class YouTubeListener implements IngestListener {
  private st: PlatformStatus = 'off';
  private last: Date | null = null;
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;
  /** Kontrola „pořád live / nový stream?" během připojení (vlastní timer vedle pollu). */
  private liveTimer: NodeJS.Timeout | null = null;
  private liveMisses = 0;
  private offlineLogged = false;
  /** Generace smyčky: connect() ji zvýší, naplánované kroky staré smyčky se pak zahodí. */
  private gen = 0;
  private videoId: string | null = null;
  private apiKey = '';
  private clientVersion = '2.20250401.00.00';
  private cont: string | null = null;
  private allCont: string | null = null;
  private usePageRefresh = false;
  private apiFails = 0;
  private seen = new Set<string>();
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;
  private readonly liveCheckMs: number;
  private readonly onlineCheckMs: number;
  private readonly minPollMs: number;

  constructor(
    private readonly handle: string,
    private readonly onMessage: (m: IngestMessage) => void,
    opts: Opts = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? noopLog;
    // Offline: kontrola každých 10 s (OBS s chatem běží dřív, než Rob pustí stream — pokyn usera
    // 2026-09-23); online: každých 30 s, jestli stream pořád běží / nezačal nový.
    this.liveCheckMs = opts.liveCheckMs ?? 10000;
    this.onlineCheckMs = opts.onlineCheckMs ?? 30000;
    this.minPollMs = opts.minPollMs ?? 1500;
  }

  status() { return this.st; }
  lastMessageAt() { return this.last; }
  /** videoId aktuálního živého streamu (web /chat/send → liveChatId). */
  currentVideoId() { return this.st === 'connected' ? this.videoId : null; }
  start() { this.stopped = false; void this.connect(); }
  stop() { this.stopped = true; this.gen++; if (this.timer) { clearTimeout(this.timer); this.timer = null; } this.clearLiveCheck(); this.st = 'off'; }

  /** Naplánovat další krok smyčky; `g` = generace, ve které vznikl (starý poll po reconnectu se zahodí). */
  private schedule(fn: () => Promise<void>, ms: number, g = this.gen) {
    if (this.stopped || g !== this.gen) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; if (g === this.gen) void fn(); }, Math.max(ms, this.minPollMs));
  }

  private clearLiveCheck() { if (this.liveTimer) { clearTimeout(this.liveTimer); this.liveTimer = null; } }

  /** Během připojení: pořád live? Jiné videoId = nový stream → přepojit; 2× nic = konec → zpět na hledání po 10 s. */
  private scheduleLiveCheck(g: number) {
    this.clearLiveCheck();
    if (this.stopped || g !== this.gen) return;
    this.liveTimer = setTimeout(async () => {
      this.liveTimer = null;
      if (this.stopped || g !== this.gen) return;
      const id = await this.findLiveVideoId();
      if (this.stopped || g !== this.gen) return;
      if (id && id === this.videoId) { this.liveMisses = 0; this.scheduleLiveCheck(g); return; }
      if (id) {
        this.log.info({ handle: this.handle, from: this.videoId, to: id }, 'youtube ingest: nový stream → přepojuji');
        void this.connect();
        return;
      }
      if (++this.liveMisses < 2) { this.scheduleLiveCheck(g); return; }
      this.log.info({ handle: this.handle, videoId: this.videoId }, 'youtube ingest: stream už není live → hledám po 10 s');
      void this.connect();
    }, Math.max(this.onlineCheckMs, this.minPollMs));
  }

  private async get(url: string): Promise<string> {
    const r = await this.fetchImpl(url, { headers: HEADERS, redirect: 'follow' });
    if (!r.ok) throw new Error(`${url.split('?')[0]} → ${r.status}`);
    return r.text();
  }

  private async findLiveVideoId(): Promise<string | null> {
    for (const url of [`https://www.youtube.com/${this.handle}/live`, `https://www.youtube.com/@${this.handle}/live`]) {
      try {
        const id = pickLiveVideoId(await this.get(url));
        if (id) return id;
      } catch (err) {
        this.log.warn({ err, url }, 'youtube ingest: findLive selhal');
      }
    }
    return null;
  }

  private chatPage(cont?: string | null): Promise<string> {
    const qs = cont ? `continuation=${encodeURIComponent(cont)}` : `v=${this.videoId}&is_popout=1`;
    return this.get(`https://www.youtube.com/live_chat?${qs}`);
  }

  private async connect() {
    if (this.stopped) return;
    const g = ++this.gen;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.clearLiveCheck();
    this.liveMisses = 0;
    this.st = 'connecting';
    this.cont = null; this.allCont = null; this.usePageRefresh = false; this.apiFails = 0;
    try {
      this.videoId = await this.findLiveVideoId();
      if (!this.videoId) {
        // Logovat jen přechod do offline — kontrola každých 10 s by jinak zaplavila log.
        if (!this.offlineLogged) { this.offlineLogged = true; this.log.info({ handle: this.handle, everyMs: this.liveCheckMs }, 'youtube ingest: není live, hlídám'); }
        this.schedule(() => this.connect(), this.liveCheckMs, g);
        return;
      }
      const html = await this.chatPage();
      let l = lcr(extractJson(html, 'ytInitialData'));
      if (!l) throw new Error('ytInitialData bez liveChatRenderer');
      const allTok = pickAllChatToken(l);
      if (allTok) {
        const allL = lcr(extractJson(await this.chatPage(allTok), 'ytInitialData'));
        if (allL) { l = allL; this.allCont = allTok; }
      }
      this.apiKey = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)?.[1] || '';
      this.clientVersion = html.match(/"clientVersion"\s*:\s*"([^"]+)"/)?.[1] || this.clientVersion;
      const timed = pickTimedContinuation(l);
      this.cont = timed?.continuation || null;
      this.usePageRefresh = !this.cont || !this.apiKey;
      this.processActions(l.actions || []);
      this.st = 'connected';
      this.offlineLogged = false;
      this.log.info({ handle: this.handle, videoId: this.videoId, mode: this.usePageRefresh ? 'page' : 'api', all: !!this.allCont }, 'youtube ingest: connected');
      this.schedule(() => this.poll(), timed?.timeoutMs || 5000, g);
      this.scheduleLiveCheck(g);
    } catch (err) {
      if (g !== this.gen) return;
      this.st = 'reconnecting';
      this.log.warn({ err, handle: this.handle }, 'youtube ingest: connect selhal');
      this.schedule(() => this.connect(), 15000, g);
    }
  }

  private async poll() {
    if (this.stopped) return;
    if (this.usePageRefresh) return this.pollPage();
    const g = this.gen;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const resp = await this.fetchImpl(`https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${this.apiKey}&prettyPrint=false`, {
        method: 'POST', signal: ctrl.signal,
        headers: { ...HEADERS, 'Content-Type': 'application/json', 'X-YouTube-Client-Name': '1', 'X-YouTube-Client-Version': this.clientVersion },
        body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: this.clientVersion, hl: 'cs', gl: 'CZ' } }, continuation: this.cont }),
      });
      clearTimeout(t);
      if (!resp.ok) throw new Error(`get_live_chat ${resp.status}`);
      const l = lcr(await resp.json());
      if (!l) {
        if (++this.apiFails >= 3) {
          this.log.info({ handle: this.handle }, 'youtube ingest: API bez obsahu 3×, stream skončil? → znovu hledám live');
          this.schedule(() => this.connect(), 5000, g);
          return;
        }
        this.schedule(() => this.poll(), 5000, g);
        return;
      }
      const timed = pickTimedContinuation(l);
      if (timed) this.cont = timed.continuation; else this.usePageRefresh = true;
      const actions = l.actions || [];
      if (actions.length) this.apiFails = 0; else if (++this.apiFails >= 5) this.usePageRefresh = true;
      this.processActions(actions);
      this.schedule(() => this.poll(), timed?.timeoutMs || 5000, g);
    } catch (err) {
      this.log.warn({ err, handle: this.handle }, 'youtube ingest: API poll selhal');
      if (++this.apiFails >= 3) this.usePageRefresh = true;
      this.schedule(() => this.poll(), 5000, g);
    }
  }

  private async pollPage() {
    const g = this.gen;
    try {
      const l = lcr(extractJson(await this.chatPage(this.allCont), 'ytInitialData'));
      if (!l) {
        this.allCont = null;
        if (++this.apiFails >= 3) { this.schedule(() => this.connect(), 5000, g); return; }
        this.schedule(() => this.pollPage(), 8000, g);
        return;
      }
      this.apiFails = 0;
      this.processActions(l.actions || []);
      this.schedule(() => this.pollPage(), 3000, g);
    } catch (err) {
      this.log.warn({ err, handle: this.handle }, 'youtube ingest: page poll selhal');
      this.schedule(() => this.pollPage(), 10000, g);
    }
  }

  private processActions(actions: unknown[]) {
    for (const a of actions) {
      const m = normalizeYoutubeAction(a, this.handle);
      if (!m || this.seen.has(m.platformMessageId)) continue;
      this.seen.add(m.platformMessageId);
      if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2500));
      this.last = m.sentAt;
      try { this.onMessage(m); } catch (err) { this.log.error({ err }, 'youtube ingest: onMessage threw'); }
    }
  }
}
