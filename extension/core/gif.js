// Odměna „Posílání GIFů" (moderace část 4, spec docs/superpowers/specs/2026-09-25-moderace-odkazy-gify-design.md,
// kontrakt docs/superpowers/plans/2026-09-25-moderace-cast-2-kontrakt.md §Část 4). Sdílené addonem i webem.
//
//  - render schváleného GIFu ve zprávě (createGifMedia): <img> nebo <video autoplay loop muted playsinline>,
//    max 400 × 250 px se zachovaným poměrem, lazy load, při chybě odkaz;
//  - karty ke schválení pro mody + stav pro odesílatele (GifRequests): SSE `gif-pending` / `gif-decided`
//    z /account/stream, POST /moderation/gif/:id/decide, GET /moderation/gif/pending.
//
// Bez chrome.*: DOM přes injektovaný `doc`, síť přes injektované `api(path, opts)` (hostitel přidá Bearer).
// Cizí text jde do DOM jen přes textContent / escapeAttr.
import { escapeAttr } from './html.js';
import { PLATFORM_NAMES } from './soundboard.js';
import { actorLabel } from './user-history.js';

export const GIF_MAX_W = 400;
export const GIF_MAX_H = 250;
/** Jak dlouho zůstane rozhodnutá / propadlá karta vidět (zelená / červená + kdo rozhodl). */
export const GIF_DECIDED_LINGER_MS = 4000;
const MEDIA_PATH_RE = /^\/media\/gif\/[0-9a-f]{32}$/;
const KINDS = new Set(['gif', 'webp', 'mp4']);

/**
 * Médium smí jen z našeho serveru (`/media/gif/<32 hex>`), https; http jen pro localhost (vývoj).
 * `origins` (volitelně) = povolené originy, např. ['https://api.jouki.cz'].
 */
export function isGifMediaUrl(url, origins = null) {
  let u;
  try { u = new URL(String(url ?? '')); } catch { return false; }
  if (u.username || u.password || u.search || u.hash) return false;
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return false;
  if (!MEDIA_PATH_RE.test(u.pathname)) return false;
  if (Array.isArray(origins) && origins.length && !origins.includes(u.origin)) return false;
  return true;
}

const dim = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 && n <= 20000 ? Math.round(n) : null; };

/** `{ url, kind, width, height }` ze serveru → ověřené médium, nebo null. */
export function normalizeGifMedia(g, { origins = null } = {}) {
  if (!g || typeof g !== 'object' || !isGifMediaUrl(g.url, origins)) return null;
  const kind = String(g.kind || '').toLowerCase();
  return { url: String(g.url), kind: KINDS.has(kind) ? kind : 'gif', width: dim(g.width), height: dim(g.height) };
}

export const isGifVideo = (g) => g?.kind === 'mp4';

/** Velikost v chatu: 100 %, nejvýš 400 × 250 px, poměr zachován, nikdy nezvětšovat. Neznámé rozměry = null. */
export function gifFitSize(width, height, maxW = GIF_MAX_W, maxH = GIF_MAX_H) {
  const w = dim(width), h = dim(height);
  if (!w || !h) return null;
  const k = Math.min(1, maxW / w, maxH / h);
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

const sameChannel = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

/** SSE `gif-pending` (nebo položka GET /moderation/gif/pending) → žádost, nebo null. */
export function normalizeGifPending(d, opts = {}) {
  if (!d || typeof d !== 'object') return null;
  const requestId = d.requestId != null && /^\d+$/.test(String(d.requestId)) ? String(d.requestId) : null;
  const media = normalizeGifMedia(d.media, opts);
  const expiresAt = Number(d.expiresAt);
  if (!requestId || !media || !d.channel || !Number.isFinite(expiresAt)) return null;
  return {
    requestId,
    channel: String(d.channel).toLowerCase(),
    platform: String(d.platform || ''),
    login: String(d.login || ''),
    userId: d.userId != null ? String(d.userId) : null,
    messageId: d.messageId != null ? String(d.messageId) : null,
    text: String(d.text || ''),
    media,
    createdAt: Number(d.createdAt) || null,
    expiresAt,
    own: d.own === true,
  };
}

/** SSE `gif-decided` → `{ requestId, channel, status, approved, by }`, nebo null. */
export function normalizeGifDecided(d) {
  if (!d || typeof d !== 'object' || d.requestId == null || !d.channel) return null;
  const status = ['approved', 'rejected', 'expired'].includes(d.status) ? d.status : (d.approved ? 'approved' : 'rejected');
  return { requestId: String(d.requestId), channel: String(d.channel).toLowerCase(), status, approved: status === 'approved', by: d.by ? String(d.by) : null, own: d.own === true };
}

/**
 * SSE `gif-message` (/nicknames/stream) → zpráva pro chat (s ověřeným `gif`), nebo null (jiný kanál, chybná data).
 * Zpráva má id `gif-<requestId>` → dedup s /chat/stream a /chat/history přes platform:id.
 */
export function gifMessageFromEvent(d, channel, opts = {}) {
  if (!d || !sameChannel(d.channel, channel)) return null;
  const m = d.message;
  if (!m || typeof m !== 'object' || !m.id || !m.platform) return null;
  const gif = normalizeGifMedia(m.gif, opts);
  if (!gif) return null;
  return { ...m, gif };
}

/** Zbývající čas „4:05“ (nejméně 0:00). */
export function formatCountdown(ms) {
  const s = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Stav rozhodnutí pro kartu moda: „Schváleno · modik (Twitch)“. `by` = 'me' → „tebou“. */
export function gifDecisionText(status, by) {
  const who = by === 'me' ? 'tebou' : by ? actorLabel(by) : '';
  if (status === 'approved') return who ? `Schváleno · ${who}` : 'Schváleno';
  if (status === 'rejected') return who ? `Zamítnuto · ${who}` : 'Zamítnuto';
  if (status === 'expired') return 'Propadlo — nikdo nerozhodl včas';
  if (status === 'deleted') return 'Smazáno';
  return '';
}

/** Stav pro odesílatele. */
export function gifOwnStatusText(status) {
  switch (status) {
    case 'pending': return 'GIF čeká na schválení';
    case 'approved': return 'GIF byl schválen';
    case 'rejected': return 'GIF byl zamítnut';
    case 'expired': return 'O GIFu nikdo nerozhodl včas';
    default: return '';
  }
}

/** Chyba POST /moderation/gif/:id/decide → česky. */
export function gifDecideErrorText(err) {
  const code = typeof err === 'string' ? err : err?.error;
  const status = typeof err === 'object' ? err?.status : undefined;
  switch (code) {
    case 'already_decided': return 'O GIFu už rozhodl jiný mod.';
    case 'not_mod': return 'Rozhodovat můžou jen modi.';
    case 'not_found': return 'Žádost už neexistuje.';
    case 'rate_limited': return 'Moc rychle za sebou, chvíli počkej.';
    case 'no session': case 'invalid session': return 'Přihlášení vypršelo, přihlas se znovu.';
    default: return status === 401 ? 'Přihlášení vypršelo, přihlas se znovu.' : 'Rozhodnutí se nepodařilo odeslat, zkus to znovu.';
  }
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

/**
 * Médium GIFu jako prvek `<div class="uc-gif">` (do zprávy pod text, nebo do karty).
 * `lazy`: obrázek `loading="lazy"`, video dostane src, až je vidět (IntersectionObserver, jinak hned).
 * Chyba načtení → odkaz „GIF se nepodařilo načíst“ (otevře médium v nové kartě).
 */
export function createGifMedia(doc, gif, { lazy = true, log } = {}) {
  const g = gif && gif.url && isGifMediaUrl(gif.url) ? gif : null;
  const wrap = doc.createElement('div');
  wrap.className = 'uc-gif';
  if (!g) return wrap;
  const fit = gifFitSize(g.width, g.height);
  const video = isGifVideo(g);
  const m = doc.createElement(video ? 'video' : 'img');
  m.className = 'uc-gif-media';
  if (fit) {
    m.setAttribute('width', String(fit.width));
    m.setAttribute('height', String(fit.height));
    m.style.width = `${fit.width}px`;
    m.style.aspectRatio = `${g.width} / ${g.height}`;
  } else {
    wrap.classList.add('uc-gif--nosize');
  }
  const fail = () => {
    if (!m.isConnected && !wrap.contains(m)) return;
    log?.('Gif', `médium se nenačetlo ${g.url}`);
    const a = doc.createElement('a');
    a.className = 'uc-gif-fallback';
    a.href = g.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'GIF se nepodařilo načíst — otevřít';
    wrap.replaceChildren(a);
    wrap.classList.add('uc-gif--failed');
  };
  m.addEventListener('error', fail);
  if (video) {
    m.muted = true;
    m.defaultMuted = true;
    m.loop = true;
    m.autoplay = true;
    m.playsInline = true;
    for (const a of ['muted', 'loop', 'autoplay', 'playsinline']) m.setAttribute(a, '');
    m.preload = lazy ? 'none' : 'auto';
    m.setAttribute('aria-label', 'GIF');
    const load = () => {
      if (m.getAttribute('src')) return;
      m.src = g.url;
      try { const p = m.play?.(); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch { /* autoplay odmítnut */ }
    };
    const IO = doc.defaultView?.IntersectionObserver;
    if (lazy && typeof IO === 'function') {
      const io = new IO((entries) => {
        if (entries.some((e) => e.isIntersecting)) { io.disconnect(); load(); }
      }, { rootMargin: '200px 0px' });
      io.observe(m);
      wrap._ucGifIo = io;
    } else load();
  } else {
    m.alt = 'GIF';
    m.decoding = 'async';
    if (lazy) m.loading = 'lazy';
    m.src = g.url;
  }
  wrap.appendChild(m);
  return wrap;
}

/** GIF ve zprávě pryč (smazáno modem — server médium přestane servírovat). Vrací počet odebraných. */
export function removeGifMedia(el) {
  if (!el || typeof el.querySelectorAll !== 'function') return 0;
  const list = [...el.querySelectorAll('.uc-gif')];
  for (const w of list) {
    try { w._ucGifIo?.disconnect(); } catch { /* ignore */ }
    const v = w.querySelector('video');
    if (v) { try { v.pause(); v.removeAttribute('src'); v.load?.(); } catch { /* ignore */ } }
    w.remove();
  }
  return list.length;
}

// ---------------------------------------------------------------------------
// Karty ke schválení (mod) + stav pro odesílatele
// ---------------------------------------------------------------------------

/**
 * Seznam čekajících GIFů nad chatem.
 *
 *   const gifs = new GifRequests({ doc, container, api, channel: () => 'robdiesalot', canModerate: () => true });
 *   accountStream: 'gif-pending' → gifs.onPending(data), 'gif-decided' → gifs.onDecided(data)
 *   mod na kanálu / přepnutí kanálu → gifs.clear(); gifs.loadPending()
 */
export class GifRequests {
  /**
   * @param {object} o
   * @param {Document} [o.doc]
   * @param {HTMLElement} [o.container]  kontejner chatu (position: relative); karty se skládají u jeho spodku
   * @param {(path: string, opts?: {method?: string, body?: object}) => Promise<any>} o.api  backend s Bearer; chyba = throw {error, status}
   * @param {() => string} o.channel      aktuální kanál UnityChatu (Twitch login streamera)
   * @param {() => boolean} [o.canModerate]  jsem mod kanálu (tlačítka i u vlastního GIFu)
   * @param {(platform: string) => string|null} [o.platformIcon]  URL loga platformy
   * @param {(tag: string, text: string) => void} [o.log]
   * @param {() => number} [o.now]
   * @param {(n: number) => void} [o.onChange]  počet karet (hostitel může přizpůsobit layout)
   * @param {number} [o.lingerMs]  jak dlouho zůstane rozhodnutá karta
   * @param {string[]} [o.origins]  povolené originy médií
   */
  constructor({ doc = globalThis.document, container, api, channel, canModerate, platformIcon, log, now, onChange, lingerMs = GIF_DECIDED_LINGER_MS, origins = null, setInterval: si, clearInterval: ci, setTimeout: st, clearTimeout: ctm } = {}) {
    this.doc = doc;
    this.container = container || doc.body;
    this.api = api;
    this.channel = channel || (() => '');
    this.canModerate = canModerate || (() => false);
    this.platformIcon = platformIcon || (() => null);
    this.log = log || (() => {});
    this.now = now || (() => Date.now());
    this.onChange = onChange || (() => {});
    this.lingerMs = lingerMs;
    this.origins = origins;
    const w = doc.defaultView || globalThis;
    this._si = si || w.setInterval.bind(w);
    this._ci = ci || w.clearInterval.bind(w);
    this._st = st || w.setTimeout.bind(w);
    this._ct = ctm || w.clearTimeout.bind(w);
    this._cards = new Map();   // requestId → { req, el, state }
    this._decided = new Map(); // requestId → status (rozhodnutí přišlo dřív než žádost / opakované gif-pending)
    this._timer = null;
    this.el = null;
  }

  get size() { return [...this._cards.values()].filter((c) => c.state === 'pending').length; }
  get requests() { return [...this._cards.values()].map((c) => ({ ...c.req, state: c.state })); }
  has(requestId) { return this._cards.has(String(requestId)); }

  _L(t) { this.log('Gif', t); }

  _root() {
    if (this.el && this.el.isConnected) return this.el;
    const el = this.doc.createElement('div');
    el.className = 'uc-gif-stack';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'GIFy ke schválení');
    el.addEventListener('click', (e) => {
      const b = e.target.closest?.('[data-act]');
      if (!b || !el.contains(b)) return;
      const card = b.closest('.uc-gif-card');
      if (!card) return;
      e.stopPropagation();
      if (b.dataset.act === 'approve') this.decide(card.dataset.requestId, true);
      else if (b.dataset.act === 'reject') this.decide(card.dataset.requestId, false);
      else if (b.dataset.act === 'dismiss') this._remove(card.dataset.requestId);
    });
    this.container.appendChild(el);
    this.el = el;
    return el;
  }

  /** SSE `gif-pending` (i po připojení streamu). Vrací true, když karta vznikla / se obnovila. */
  onPending(d) {
    const req = normalizeGifPending(d, { origins: this.origins });
    if (!req) { this._L(`gif-pending ignorováno (chybná data ${d?.requestId ?? '?'})`); return false; }
    if (!sameChannel(req.channel, this.channel())) { this._L(`gif-pending ${req.requestId} z jiného kanálu (${req.channel})`); return false; }
    if (this._decided.has(req.requestId)) { this._L(`gif-pending ${req.requestId} už rozhodnutý (${this._decided.get(req.requestId)})`); return false; }
    if (req.expiresAt <= this.now()) { this._L(`gif-pending ${req.requestId} už propadlý`); return false; }
    const prev = this._cards.get(req.requestId);
    if (prev) {
      if (prev.state !== 'pending') return false;
      // Opakovaně (reconnect streamu, GET pending) — `own` se jen doplní.
      if (req.own && !prev.req.own) { prev.req.own = true; this._paint(prev); }
      return false;
    }
    const card = { req, el: null, state: 'pending', error: '' };
    this._cards.set(req.requestId, card);
    card.el = this._build(card);
    this._root().appendChild(card.el);
    this._startTimer();
    this._L(`gif-pending ${req.requestId} ${req.platform}:${req.login}${req.own ? ' (můj)' : ''} ${req.media.kind} ${req.media.width || '?'}×${req.media.height || '?'} zbývá ${formatCountdown(req.expiresAt - this.now())}`);
    this.onChange(this.size);
    return true;
  }

  /** SSE `gif-decided`. */
  onDecided(d) {
    const x = normalizeGifDecided(d);
    if (!x || !sameChannel(x.channel, this.channel())) return false;
    this._rememberDecided(x.requestId, x.status);
    const card = this._cards.get(x.requestId);
    this._L(`gif-decided ${x.requestId} ${x.status} by=${x.by || '-'}${card ? '' : ' (bez karty)'}`);
    if (!card) return false;
    // Vlastní rozhodnutí už karta ukazuje („tebou“) — SSE ho jen potvrdí.
    if (card.state === x.status && card.by === 'me') return true;
    this._finish(card, x.status, x.by);
    return true;
  }

  /** Mod: čekající žádosti kanálu (GET /moderation/gif/pending). Divák dostane 403 → nic. */
  async loadPending() {
    const ch = String(this.channel() || '').toLowerCase();
    if (!ch || !this.api) return 0;
    let j;
    try { j = await this.api(`/moderation/gif/pending?channel=${encodeURIComponent(ch)}`); }
    catch (e) { this._L(`pending FAIL ${e?.status || 0} ${e?.error || e?.message || e}`); return 0; }
    if (!sameChannel(ch, this.channel())) return 0;   // mezitím přepnutý kanál
    let n = 0;
    for (const r of Array.isArray(j?.requests) ? j.requests : []) if (this.onPending(r)) n++;
    this._L(`pending ${ch}: ${Array.isArray(j?.requests) ? j.requests.length : 0} žádostí, ${n} nových karet`);
    return n;
  }

  /** Klik na Schválit / Zamítnout. */
  async decide(requestId, approve) {
    const card = this._cards.get(String(requestId));
    if (!card || card.state !== 'pending' || card.busy) return null;
    card.busy = true; card.error = '';
    this._paint(card);
    this._L(`decide ${card.req.requestId} ${approve ? 'approve' : 'reject'}`);
    try {
      const r = await this.api(`/moderation/gif/${encodeURIComponent(card.req.requestId)}/decide`, { method: 'POST', body: { approve: !!approve } });
      card.busy = false;
      const status = ['approved', 'rejected'].includes(r?.status) ? r.status : (approve ? 'approved' : 'rejected');
      this._rememberDecided(card.req.requestId, status);
      if (card.state === 'pending') this._finish(card, status, 'me');
      if (r?.published === false) this._L(`decide ${card.req.requestId}: schváleno, ale zpráva se nezapsala (published:false)`);
      this._L(`decide ${card.req.requestId} → ${status}`);
      return status;
    } catch (e) {
      card.busy = false;
      this._L(`decide ${card.req.requestId} FAIL ${e?.status || 0} ${e?.error || e?.message || e}${e?.status ? ` status=${e.status}` : ''}`);
      if (e?.error === 'already_decided') {
        // Hostitel vrací HTTP status v `status`; stav žádosti z těla 409 je v `body.status` (nebo řetězcový `status`).
        const raw = e.body?.status ?? (typeof e.status === 'string' ? e.status : null);
        const st = ['approved', 'rejected', 'expired'].includes(raw) ? raw : 'closed';
        this._rememberDecided(card.req.requestId, st);
        if (card.state === 'pending') this._finish(card, st, null, gifDecideErrorText(e));
        return st;
      }
      if (e?.error === 'not_found') { this._finish(card, 'expired', null, gifDecideErrorText(e)); return null; }
      card.error = gifDecideErrorText(e);
      this._paint(card);
      return null;
    }
  }

  /** Role se změnila (mod ↔ divák) → tlačítka a texty karet znovu. */
  repaint() {
    for (const c of this._cards.values()) this._paint(c);
  }

  /** Přepnutí kanálu / odhlášení: všechny karty pryč. */
  clear() {
    for (const c of this._cards.values()) { if (c.lingerT) this._ct(c.lingerT); this._disposeCard(c); }
    this._cards.clear();
    this._decided.clear();
    this._stopTimer();
    if (this.el) { this.el.remove(); this.el = null; }
    this.onChange(0);
  }

  destroy() { this.clear(); }

  // ---- interní ----

  _rememberDecided(id, status) {
    this._decided.set(String(id), status);
    if (this._decided.size > 300) this._decided.delete(this._decided.values().next().value);
  }

  _finish(card, status, by, note = '') {
    card.state = status;
    card.by = by;
    card.note = note;
    card.error = '';
    this._paint(card);
    // Náhled čekajícího média už server nevrátí (zamítnuto / propadlo) → zastavit video.
    const v = card.el?.querySelector('video');
    if (v) { try { v.pause(); } catch { /* ignore */ } }
    if (card.lingerT) this._ct(card.lingerT);
    card.lingerT = this._st(() => this._remove(card.req.requestId), this.lingerMs);
    this.onChange(this.size);
    if (!this.size) this._stopTimer();
  }

  _remove(id) {
    const card = this._cards.get(String(id));
    if (!card) return;
    this._cards.delete(String(id));
    this._disposeCard(card);
    card.el?.remove();
    if (!this._cards.size && this.el) { this.el.remove(); this.el = null; }
    this.onChange(this.size);
  }

  _disposeCard(card) {
    if (card.el) removeGifMedia(card.el);
  }

  _startTimer() {
    if (this._timer) return;
    this._timer = this._si(() => this._tick(), 1000);
  }

  _stopTimer() {
    if (this._timer) { this._ci(this._timer); this._timer = null; }
  }

  _tick() {
    const now = this.now();
    for (const card of this._cards.values()) {
      if (card.state !== 'pending') continue;
      if (now >= card.req.expiresAt) {
        // Server propadnutí ohlásí do 10 s (gif-decided expired) — lokálně hned, ať mod neklikne naprázdno.
        this._rememberDecided(card.req.requestId, 'expired');
        this._L(`gif ${card.req.requestId} propadl (lokálně)`);
        this._finish(card, 'expired', null);
      } else {
        const t = card.el?.querySelector('.uc-gif-timer');
        if (t) t.textContent = formatCountdown(card.req.expiresAt - now);
      }
    }
    if (!this.size) this._stopTimer();
  }

  _build(card) {
    const doc = this.doc;
    const { req } = card;
    const el = doc.createElement('div');
    el.className = 'uc-gif-card';
    el.dataset.requestId = req.requestId;
    el.innerHTML = `
      <div class="uc-gif-card-head">
        <span class="uc-gif-card-pi"></span>
        <span class="uc-gif-card-who"></span>
        <span class="uc-gif-card-kind"></span>
        <span class="uc-gif-timer" title="Zbývá do propadnutí"></span>
      </div>
      <div class="uc-gif-card-text"></div>
      <div class="uc-gif-card-media"></div>
      <div class="uc-gif-card-status" role="status"></div>
      <div class="uc-gif-card-err" role="alert" hidden></div>
      <div class="uc-gif-card-actions">
        <button type="button" class="uc-gif-btn uc-gif-btn--reject" data-act="reject">Zamítnout</button>
        <button type="button" class="uc-gif-btn uc-gif-btn--approve" data-act="approve">Schválit</button>
      </div>`;
    const pi = el.querySelector('.uc-gif-card-pi');
    const icon = this.platformIcon(req.platform);
    pi.title = PLATFORM_NAMES[req.platform] || req.platform;
    if (icon) {
      const img = doc.createElement('img');
      img.src = icon;
      img.alt = PLATFORM_NAMES[req.platform] || req.platform;
      pi.appendChild(img);
    } else pi.textContent = PLATFORM_NAMES[req.platform] || req.platform;
    el.querySelector('.uc-gif-card-who').textContent = req.login || 'neznámý';
    el.querySelector('.uc-gif-card-text').textContent = req.text;
    el.querySelector('.uc-gif-card-text').hidden = !req.text;
    el.querySelector('.uc-gif-card-media').appendChild(createGifMedia(doc, req.media, { lazy: false, log: this.log }));
    el.querySelector('.uc-gif-timer').textContent = formatCountdown(req.expiresAt - this.now());
    this._paint({ ...card, el });
    return el;
  }

  _paint(card) {
    const el = card.el;
    if (!el) return;
    const { req, state } = card;
    const mod = !!this.canModerate();
    el.classList.toggle('uc-gif-card--own', req.own);
    el.classList.toggle('uc-gif-card--mod', mod);
    for (const s of ['pending', 'approved', 'rejected', 'expired', 'closed']) el.classList.toggle(`uc-gif-card--${s}`, state === s);
    el.classList.toggle('uc-gif-card--busy', !!card.busy);
    el.querySelector('.uc-gif-card-kind').textContent = req.own ? 'Tvůj GIF' : 'Chce poslat GIF';
    const status = el.querySelector('.uc-gif-card-status');
    if (state === 'pending') status.textContent = req.own ? gifOwnStatusText('pending') : '';
    else status.textContent = card.note || (req.own && !mod ? gifOwnStatusText(state) : gifDecisionText(state, card.by));
    status.hidden = !status.textContent;
    const err = el.querySelector('.uc-gif-card-err');
    err.textContent = card.error || '';
    err.hidden = !card.error;
    const actions = el.querySelector('.uc-gif-card-actions');
    actions.hidden = !(mod && state === 'pending');
    for (const b of actions.querySelectorAll('button')) b.disabled = !!card.busy;
    el.querySelector('.uc-gif-timer').hidden = state !== 'pending';
    el.setAttribute('aria-label', `${req.own ? 'Tvůj GIF' : `GIF od ${req.login}`}${status.textContent ? `: ${status.textContent}` : ''}`);
  }
}

/** Atribut-bezpečné HTML média pro hostitele, který skládá zprávu jako řetězec (OBS / raw režim webu). */
export function gifMediaHtml(gif) {
  const g = gif && isGifMediaUrl(gif.url) ? gif : null;
  if (!g) return '';
  const fit = gifFitSize(g.width, g.height);
  const size = fit ? ` width="${fit.width}" height="${fit.height}" style="width:${fit.width}px;aspect-ratio:${g.width} / ${g.height}"` : '';
  const cls = `uc-gif${fit ? '' : ' uc-gif--nosize'}`;
  return isGifVideo(g)
    ? `<div class="${cls}"><video class="uc-gif-media" src="${escapeAttr(g.url)}" autoplay loop muted playsinline preload="auto" aria-label="GIF"${size}></video></div>`
    : `<div class="${cls}"><img class="uc-gif-media" src="${escapeAttr(g.url)}" alt="GIF" loading="lazy" decoding="async"${size}></div>`;
}
