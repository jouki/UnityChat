// Odměna „Posílání GIFů" (moderace část 4, spec docs/superpowers/specs/2026-09-25-moderace-odkazy-gify-design.md,
// kontrakt docs/superpowers/plans/2026-09-25-moderace-cast-2-kontrakt.md §Část 4). Sdílené addonem i webem.
//
//  - render schváleného GIFu ve zprávě (createGifMedia): <img> nebo <video autoplay loop muted playsinline>,
//    max 400 × 250 px se zachovaným poměrem, lazy load, při chybě štítek „GIF odebrán“;
//  - fronta ke schválení pro mody (GifRequests, GIF knihovna 2026-09-26): FIFO — jedna karta = nejstarší čekající +
//    „+N čeká“, SSE `gif-pending` / `gif-decided` / `gif-queue` z /account/stream, zámek tlačítek 1 s / 0,3 s,
//    POST /moderation/gif/:id/decide (409 → „Už rozhodl X“), GET /moderation/gif/pending, ban12h;
//    split „Zamítnout ▾“: Zamítnout + timeout (výběr délky jako custom timeout v core/mod-menu.js, výchozí 10 min)
//    / Zamítnout + permaban (modální potvrzení) → po zamítnutí POST /moderation/user (spec 2026-09-27-gif-review-upravy §2).
//    Stav pro odesílatele ukazuje štítek u zprávy (core/gif-library.js GifOutbox), ne karta.
//
// Bez chrome.*: DOM přes injektovaný `doc`, síť přes injektované `api(path, opts)` (hostitel přidá Bearer).
// Cizí text jde do DOM jen přes textContent.
import { PLATFORM_NAMES } from './soundboard.js';
import { actorLabel } from './user-history.js';
import { buildModRequest, createDurationNumber, CUSTOM_UNITS, customDurationSec, MAX_TIMEOUT_SEC, modErrorText, openModDialog, PLATFORM_LOC, summarizeModResult } from './mod-menu.js';

export const GIF_MAX_W = 400;
export const GIF_MAX_H = 250;
/** GIF užší než tenhle poměr (šířka / výška) dostane ve zprávě rám 4:3 s ambientem (rozmazaná kopie po stranách). */
export const GIF_AMBIENT_RATIO = 0.8;
/** Jak dlouho zůstane rozhodnutá / propadlá karta vidět (zelená / červená + kdo rozhodl). */
export const GIF_DECIDED_LINGER_MS = 4000;
/** Náhled v kartě ke schválení je nižší než GIF v chatu. */
export const GIF_CARD_MAX_H = 160;
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

/**
 * `{ url, kind, width, height, unavailable? }` ze serveru → ověřené médium, nebo null. `unavailable` = soubor byl
 * smazán ze serveru (stažený GIF „Odstranit ze serveru“) → místo média štítek „[GIF nedostupný]“.
 */
export function normalizeGifMedia(g, { origins = null } = {}) {
  if (!g || typeof g !== 'object' || !isGifMediaUrl(g.url, origins)) return null;
  const kind = String(g.kind || '').toLowerCase();
  return { url: String(g.url), kind: KINDS.has(kind) ? kind : 'gif', width: dim(g.width), height: dim(g.height),
    ...(g.unavailable === true ? { unavailable: true } : {}), ...(g.removed === true && g.unavailable !== true ? { removed: true } : {}) };
}

export const isGifVideo = (g) => g?.kind === 'mp4';

/** Syntetická zpráva schváleného GIFu (`gif-<requestId>`) — na platformě neexistuje (nativní odpověď / pin nejde). */
export const isGifMessageId = (id) => /^gif-\d+$/.test(String(id ?? ''));

/**
 * Původní zpráva s GIF odkazem čeká na schválení (smazaná s důvodem `gif_request`): ostatním (divák, mod, OBS) se
 * NEvykresluje vůbec. Odesílatel ji vidí dál se štítkem (core/gif-library.js GifOutbox, gif-host.js). Po schválení
 * přijde GIF jako nová zpráva na konci chatu, po zamítnutí / propadnutí message-deleted s `gif_rejected` → ostatním
 * běžně smazaná, odesílateli červený štítek.
 */
export const GIF_HELD_REASON = 'gif_request';
export const GIF_REJECTED_REASON = 'gif_rejected';
/**
 * Nový GIF v režimu odměny „jen schválené“ (backend GIF_NOT_ALLOWED_REASON): všem v UnityChatu (odesílatel, divák,
 * mod) smazaná zpráva se štítkem „Nové GIFy teď nejsou povolené“ místo „Smazáno“, v OBS nic (core gif-host).
 */
export const GIF_NOT_ALLOWED_REASON = 'gif_not_allowed';
/**
 * GIF od někoho bez odemčené odměny (backend GIF_DENIED_REASON, pokyn usera 2026-09-28): stejně jako gif_not_allowed
 * — všem smazaná zpráva se štítkem „GIF teď není možné poslat“, bez odkazu, v OBS nic, na platformě smazaná.
 */
export const GIF_DENIED_REASON = 'gif_denied';
/** Zablokovaný GIF (nepovolený nový / bez odměny): všem smazaná zpráva se štítkem. */
export const isGifBlockedReason = (reason) => reason === GIF_NOT_ALLOWED_REASON || reason === GIF_DENIED_REASON;
export const isGifHeldReason = (reason) => reason === GIF_HELD_REASON;

/**
 * Důvod, který si hostitel pamatuje pro zprávu podle id, i když ji ještě nemá (SSE message-deleted předběhlo zprávu
 * z IRC / echo): schovaná (gif_request) i nový nepovolený GIF (gif_not_allowed) se pak vykreslí rovnou schovaně.
 * `prev` = zapamatovaný důvod, `next` = nový důvod (gifHeldAfter). null = nepamatovat. Ozvěna smazání z platformy
 * (`next` prázdné / `platform`) zapamatovaný gif_not_allowed nechá.
 */
export function gifEarlyReason(prev, next) {
  if (isGifHeldReason(next) || isGifBlockedReason(next)) return next;
  if ((!next || next === 'platform') && isGifBlockedReason(prev)) return prev;
  return null;
}

/**
 * Nový důvod smazání u zprávy, která je zrovna schovaná jako gif_request: `platform` (bot ji smazal i na
 * platformě — ozvěna) ji nechá schovanou; gif_rejected / mod / cokoli jiného ji ukáže jako smazanou.
 * Stejně u gif_not_allowed (nový GIF nepovolený, bot ho smazal na platformě): ozvěna `platform` / bez důvodu ho nechá.
 */
export function gifHeldAfter(prevReason, nextReason) {
  if (isGifBlockedReason(prevReason) && (!nextReason || nextReason === 'platform')) return prevReason;
  if (!isGifHeldReason(prevReason)) return isGifHeldReason(nextReason) ? GIF_HELD_REASON : nextReason ?? null;
  return !nextReason || nextReason === 'platform' || isGifHeldReason(nextReason) ? GIF_HELD_REASON : nextReason;
}

/** Za jak dlouho se klient zeptá serveru na zprávu schovanou jako gif_request bez rozhodnutí. */
export const GIF_HOLD_CHECK_MS = 30_000;
/** Kolikrát nejvýš (žádost diváka čeká na moda až requestTtlSec = 300 s → 12 × 30 s pokryje i s rezervou). */
export const GIF_HOLD_MAX_CHECKS = 12;
/** Max klíčů v jednom GET /gif/held (stejně jako server). */
export const GIF_HOLD_BATCH = 50;

/**
 * Pojistka: zpráva schovaná jako gif_request nesmí zůstat schovaná navždy, když rozhodnutí serveru
 * (message-restored / message-deleted / gif-message) nedorazí — výpadek SSE, restart serveru, chyba.
 * Po `delayMs` od schování se zeptá `GET /gif/held?channel=&ids=<platform>:<id>,…` (veřejné, i pro diváka):
 *   held → zeptat se znovu (nejvýš maxChecks krát), visible → `onResult` (klient zprávu odkryje s daty ze serveru),
 *   deleted → běžně smazaná s důvodem, replaced / unknown → nechat schovanou a přestat.
 * Neptá se po každém vykreslení: `hold` je idempotentní, `release` ruší (rozhodnutí přišlo samo).
 * Server se ptá, NE čas → čekající žádost diváka (až 5 min) se nikdy neodkryje předčasně.
 */
export class GifHoldWatch {
  constructor({ api, channel, onResult, log = () => {}, delayMs = GIF_HOLD_CHECK_MS, maxChecks = GIF_HOLD_MAX_CHECKS, setTimeout: st = globalThis.setTimeout.bind(globalThis), clearTimeout: ct = globalThis.clearTimeout.bind(globalThis), now = Date.now } = {}) {
    Object.assign(this, { api, channel, onResult, log, delayMs, maxChecks, _st: st, _ct: ct, _now: now });
    this._items = new Map();   // "platform:id" → { platform, id, due, checks }
    this._timer = null;
    this._busy = false;
  }

  /** Zpráva je (znovu) schovaná jako gif_request — hlídat. Opakované volání termín neposouvá. */
  hold(platform, id) {
    if (!platform || id == null || isGifMessageId(id) || String(id).startsWith('sent-')) return;
    const k = `${platform}:${id}`;
    if (this._items.has(k)) return;
    this._items.set(k, { platform, id: String(id), due: this._now() + this.delayMs, checks: 0 });
    if (this._items.size > 300) this._items.delete(this._items.keys().next().value);
    this._arm();
  }

  /** Rozhodnutí přišlo (odkryta, smazána jinak, nahrazena) — nehlídat. */
  release(platform, id) {
    this._items.delete(`${platform}:${id}`);
    if (!this._items.size && this._timer) { this._ct(this._timer); this._timer = null; }
  }

  has(platform, id) { return this._items.has(`${platform}:${id}`); }
  get size() { return this._items.size; }

  /** Přepnutí kanálu / odhlášení. */
  clear() { this._items.clear(); if (this._timer) this._ct(this._timer); this._timer = null; }

  _arm() {
    if (!this._items.size) return;
    const next = Math.min(...[...this._items.values()].map((x) => x.due));
    // Běžící časovač na dřívější (nebo stejný) termín stačí; na pozdější se přeplánuje.
    if (this._timer && this._timerAt <= next) return;
    if (this._timer) this._ct(this._timer);
    this._timerAt = next;
    this._timer = this._st(() => { this._timer = null; void this._check(); }, Math.max(0, next - this._now()));
  }

  async _check() {
    if (this._busy) return;
    const now = this._now();
    const due = [...this._items.values()].filter((x) => x.due <= now).slice(0, GIF_HOLD_BATCH);
    if (!due.length) { this._arm(); return; }
    this._busy = true;
    const ch = typeof this.channel === 'function' ? this.channel() : this.channel;
    const ids = due.map((x) => `${x.platform}:${x.id}`).join(',');
    let res = null;
    try { res = await this.api(`/gif/held?channel=${encodeURIComponent(String(ch || '').toLowerCase())}&ids=${encodeURIComponent(ids)}`); }
    catch (e) { this.log('Gif', `hold: /gif/held selhalo (${e?.error || e?.message || e})`); }
    const got = new Map((Array.isArray(res?.messages) ? res.messages : []).map((r) => [`${r.platform}:${r.messageId}`, r]));
    for (const x of due) {
      const k = `${x.platform}:${x.id}`;
      if (!this._items.has(k)) continue;   // mezitím rozhodnuto
      const r = got.get(k);
      if (!r || r.state === 'held') {
        // Čeká (nebo server neodpověděl) → znovu později; po maxChecks vzdát (zůstane schovaná).
        if (++x.checks >= this.maxChecks) { this._items.delete(k); this.log('Gif', `hold ${k}: bez rozhodnutí po ${x.checks} dotazech`); continue; }
        x.due = this._now() + this.delayMs;
        continue;
      }
      this._items.delete(k);
      this.log('Gif', `hold ${k} → ${r.state}${r.reason ? ` (${r.reason})` : ''}`);
      try { this.onResult?.(r); } catch { /* ignore */ }
    }
    this._busy = false;
    this._arm();
  }
}

/** Schválený GIF → `{ platform, id }` původní zprávy, kterou nahrazuje (`replaces: "<platform>:<id>"`), nebo null. */
export function gifReplacedTarget(msg) {
  const m = /^(twitch|kick|youtube):(.{1,200})$/.exec(String(msg?.replaces ?? ''));
  return m ? { platform: m[1], id: m[2] } : null;
}

/** Velikost v chatu: 100 %, nejvýš 400 × 250 px, poměr zachován, nikdy nezvětšovat. Neznámé rozměry = null. */
export function gifFitSize(width, height, maxW = GIF_MAX_W, maxH = GIF_MAX_H) {
  const w = dim(width), h = dim(height);
  if (!w || !h) return null;
  const k = Math.min(1, maxW / w, maxH / h);
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** Stejný kanál (bez ohledu na velikost písmen), prázdný nikdy. */
export const sameChannel = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

/**
 * Čas serveru → lokální hodiny klienta (audit F1: karta moda / štítek odesílatele nesmí záviset na posunu hodin).
 * Přednost: `serverNow` v datech (posun přesně pro tuto odpověď), jinak `offset` hostitele (lokální − serverový,
 * z posledního GET /gif/state), jinak beze změny.
 */
export function gifLocalTime(serverTs, { serverNow = null, now = Date.now(), offset = 0 } = {}) {
  const t = Number(serverTs);
  if (!Number.isFinite(t)) return t;
  const sn = Number(serverNow);
  if (serverNow != null && Number.isFinite(sn) && sn > 0) return t - sn + now;
  return Number.isFinite(offset) ? t + offset : t;
}

/**
 * SSE `gif-pending` (nebo položka GET /moderation/gif/pending) → žádost, nebo null. `expiresAt` je v lokálním čase
 * (`opts.now`, `opts.offset`, `d.serverNow` → gifLocalTime); `createdAt` zůstává serverový (jen pořadí FIFO).
 */
export function normalizeGifPending(d, opts = {}) {
  if (!d || typeof d !== 'object') return null;
  const requestId = d.requestId != null && /^\d+$/.test(String(d.requestId)) ? String(d.requestId) : null;
  const media = normalizeGifMedia(d.media, opts);
  const expiresAt = gifLocalTime(d.expiresAt, { serverNow: d.serverNow ?? null, now: opts.now ?? Date.now(), offset: opts.offset || 0 });
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
    // Dříve zamítnuté médium: server ho servíruje jen s tokenem moda (`?t=`), karta ho tak načte.
    tokenRequired: d.media?.tokenRequired === true,
    createdAt: Number(d.createdAt) || null,
    expiresAt,
    own: d.own === true,
    // Dříve zamítnutý GIF: mod dostane { at, by }, odesílatel jen { at } (⚠ „tento GIF byl už dříve zamítnut“).
    previouslyRejected: d.previouslyRejected && typeof d.previouslyRejected === 'object'
      ? { at: Number(d.previouslyRejected.at) || null, by: d.previouslyRejected.by ? String(d.previouslyRejected.by) : null }
      : null,
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

/** Zásobník ukazuje nejvýš tolik karet, zbytek schová za řádek „+N dalších GIFů“. */
export const GIF_STACK_VISIBLE = 3;

/** „+1 další GIF“ / „+3 další GIFy“ / „+5 dalších GIFů“. */
export function gifMoreText(n) {
  const a = Math.abs(Math.trunc(Number(n) || 0));
  if (a === 1) return '+1 další GIF';
  if (a >= 2 && a <= 4) return `+${a} další GIFy`;
  return `+${a} dalších GIFů`;
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
 * Sdílený IntersectionObserver pro videa GIFů (jeden na okno): video dostane src, až je poprvé vidět,
 * hraje jen když je vidět a mimo záběr se zastaví. Pozorování přežije odpojení uzlu (parkování zpráv
 * mimo DOM) — po vrácení uzlu do chatu přijde nové protnutí a video se znovu spustí.
 */
const videoIo = new WeakMap();   // window → IntersectionObserver
/**
 * Odložený zdroj líného videa (element → URL). Jen v paměti: URL může nést token moda (`?t=`, zamítnuté GIFy),
 * do DOM atributu (dřív data-uc-src) nesmí.
 */
const lazyVideoSrc = new WeakMap();
function playSafe(v) {
  try { const p = v.play?.(); if (p && typeof p.catch === 'function') p.catch(() => {}); } catch { /* autoplay odmítnut */ }
}
function gifVideoObserver(win) {
  const IO = win?.IntersectionObserver;
  if (typeof IO !== 'function') return null;
  let io = videoIo.get(win);
  if (!io) {
    io = new IO((entries) => {
      for (const e of entries) {
        const v = e.target;
        if (e.isIntersecting) {
          const src = lazyVideoSrc.get(v);
          if (!v.getAttribute('src') && src) v.src = src;
          playSafe(v);
        } else {
          try { v.pause(); } catch { /* ignore */ }
        }
      }
    }, { rootMargin: '200px 0px' });
    videoIo.set(win, io);
  }
  return io;
}

/** Štítek místo média, které se nenačetlo (odebráno z knihovny / trvale zahozeno). */
export const GIF_REMOVED_TEXT = 'GIF odebrán';
/** Štítek místo média staženého GIFu, jehož soubor mod odstranil ze serveru (zpráva zůstává). */
export const GIF_UNAVAILABLE_TEXT = '[GIF nedostupný]';

/**
 * Třída zprávy, jejíž GIF je pryč (štítek „GIF odebrán“ / „[GIF nedostupný]“ místo média): OBS takovou zprávu
 * nevykreslí vůbec, stejně jako smazanou (gif.css `body.uc-raw`, kolo 4 bod 4c — dřív tam zbylo jen „jméno:“).
 */
export const GIF_GONE_CLASS = 'uc-gif-gone';

/** Za jak dlouho zkusit médium po přechodné chybě (síť, 5xx) načíst znovu — jednou. */
export const GIF_RETRY_MS = 5000;

/**
 * HTTP stav média po chybě načtení (HEAD, bez cache); 0 = síť / CORS / bez fetch. Jen 404 / 410 je definitivní
 * (odebráno / zahozeno) — review kola 4 M4: přechodná chyba nesmí zprávu v OBS schovat natrvalo.
 */
async function gifMediaStatus(win, src) {
  try { return (await win.fetch(src, { method: 'HEAD', cache: 'no-store' })).status || 0; } catch { return 0; }
}
const isDefinitiveGone = (status) => status === 404 || status === 410;

/**
 * Obsah prvku `.uc-gif` → štítek místo média (video zastavit a odpojit od IO). `gone` = definitivní stav
 * (unavailable / removed / 404) → zpráva dostane GIF_GONE_CLASS (OBS ji skryje); přechodná chyba ne.
 */
function gifFallback(doc, wrap, text, extraClass = '', { gone = true } = {}) {
  const v = wrap.querySelector('video');
  if (v) {
    try { gifVideoObserver(doc.defaultView)?.unobserve(v); } catch { /* ignore */ }
    try { v.pause(); v.removeAttribute('src'); v.load?.(); } catch { /* ignore */ }
  }
  const a = doc.createElement('span');
  a.className = 'uc-gif-fallback';
  a.textContent = text;
  wrap.replaceChildren(a);
  wrap.classList.remove('uc-gif--card');
  wrap.classList.add('uc-gif--failed');
  if (extraClass) wrap.classList.add(extraClass);
  wrap.classList.remove('uc-gif--nosize');
  // Už ve zprávě (chyba načtení, SSE unavailable) → označit zprávu; nové médium značí hostitel (appendGifMedia).
  wrap.classList.toggle('uc-gif--gone', !!gone);
  if (gone) wrap.closest?.('.msg')?.classList.add(GIF_GONE_CLASS);
}

/** Max klíčů zpráv v `gif-media` / GET /chat/messages (stejně jako server). */
export const GIF_MEDIA_MESSAGES_MAX = 200;
const MSG_KEY_RE = /^(twitch|kick|youtube):[\w.:-]{1,200}$/;

/**
 * SSE `gif-media` (/nicknames/stream) → { mediaId, state: visible|removed|unavailable|library, messageIds } pro aktuální
 * kanál, nebo null. `messageIds` (jen u visible) = klíče `<platform>:<id>` zpráv, které se znovu ukážou — obsah si
 * hostitel dotáhne přes GET /chat/messages (gifMessagesPath). `library` = jen obnovit otevřený panel GIFů.
 */
export function normalizeGifMediaEvent(d, channel) {
  if (!d || typeof d !== 'object' || !sameChannel(d.channel, channel)) return null;
  const mediaId = /^[0-9a-f]{32}$/.test(String(d.mediaId || '')) ? String(d.mediaId) : null;
  const state = ['visible', 'removed', 'unavailable', 'library'].includes(d.state) ? d.state : null;
  if (!mediaId || !state) return null;
  const messageIds = state === 'visible' && Array.isArray(d.messageIds)
    ? [...new Set(d.messageIds.map((k) => String(k ?? '')).filter((k) => MSG_KEY_RE.test(k)))].slice(0, GIF_MEDIA_MESSAGES_MAX)
    : [];
  return { mediaId, state, messageIds };
}

/** Cesta GET /chat/messages pro klíče zpráv (nejvýš GIF_MEDIA_MESSAGES_MAX), nebo null bez klíčů. */
export function gifMessagesPath(channel, keys) {
  const list = (Array.isArray(keys) ? keys : []).filter((k) => MSG_KEY_RE.test(String(k))).slice(0, GIF_MEDIA_MESSAGES_MAX);
  if (!list.length) return null;
  return `/chat/messages?channel=${encodeURIComponent(String(channel || '').toLowerCase())}&ids=${encodeURIComponent(list.join(','))}`;
}

/** Id média GIFu ve zprávě (`msg.gif.url`), nebo null. */
export const gifMsgMediaId = (msg) => (msg?.gif?.url ? gifMediaIdOf(msg.gif.url) : null);

/** Zpráva s GIFem ve zprávě `el` → štítek „[GIF nedostupný]“ (soubor smazán ze serveru). Vrací počet. */
export function setGifUnavailable(doc, el) {
  if (!el || typeof el.querySelectorAll !== 'function') return 0;
  const list = [...el.querySelectorAll('.uc-gif')];
  for (const w of list) gifFallback(doc, w, GIF_UNAVAILABLE_TEXT, 'uc-gif--unavailable');
  return list.length;
}

/**
 * Médium GIFu jako prvek `<div class="uc-gif">` (do zprávy pod text, nebo do karty).
 * Velikost: 100 %, nejvýš `maxW` × `maxH` (výchozí 400 × 250), poměr zachován (inline width + aspect-ratio,
 * aby CSS nemuselo nic ořezávat a obraz se nedeformoval).
 * `lazy`: obrázek `loading="lazy"`; video se spouští / zastavuje podle viditelnosti (sdílený IO).
 * Chyba načtení → štítek „GIF odebrán“ (médium je vždy z našeho serveru a 404 znamená odebráno z knihovny / zahozeno;
 * odkaz „otevřít“ by vedl jen na tutéž 404 — závěrečná review 2026-09-26, I2).
 */
export function createGifMedia(doc, gif, { lazy = true, log, maxW = GIF_MAX_W, maxH = GIF_MAX_H, token = null, onError = null, ambient = false } = {}) {
  const g = gif && gif.url && isGifMediaUrl(gif.url) ? gif : null;
  // Zamítnuté médium jen s tokenem moda (`?t=`); URL se ověřuje BEZ tokenu, token se do logu nepíše.
  const src = g && token ? `${g.url}?t=${encodeURIComponent(token)}` : g?.url;
  const wrap = doc.createElement('div');
  wrap.className = 'uc-gif';
  if (!g) return wrap;
  // Soubor smazán ze serveru (stažený GIF) → štítek, nic nenačítat.
  if (g.unavailable) { gifFallback(doc, wrap, GIF_UNAVAILABLE_TEXT, 'uc-gif--unavailable'); return wrap; }
  // Odkrytá zpráva s GIFem odebraným z knihovny / zahozeným (server `removed`, routes/chat.ts toRestoredMessage)
  // → stejný štítek jako po 404 (kolo 4 bod 3), nic nenačítat.
  if (g.removed) { gifFallback(doc, wrap, GIF_REMOVED_TEXT, 'uc-gif--removed'); return wrap; }
  const fit = gifFitSize(g.width, g.height, maxW, maxH);
  const video = isGifVideo(g);
  const m = doc.createElement(video ? 'video' : 'img');
  m.className = 'uc-gif-media';
  // Karta s rámečkem ve zprávě (gif.css) — třída místo :has(), OBS má starší Chromium bez :has() (2026-09-28).
  wrap.classList.add('uc-gif--card');
  // Rozměry originálu (náhled v plné velikosti, core/gif-lightbox.js).
  if (g.width && g.height) { m.setAttribute('data-w', String(g.width)); m.setAttribute('data-h', String(g.height)); }
  if (fit) {
    m.setAttribute('width', String(fit.width));
    m.setAttribute('height', String(fit.height));
    m.style.width = `${fit.width}px`;
    m.style.aspectRatio = `${g.width} / ${g.height}`;
  } else {
    wrap.classList.add('uc-gif--nosize');
    m.style.maxWidth = `min(100%, ${maxW}px)`;
    m.style.maxHeight = `${maxH}px`;
  }
  let retried = false;
  const fail = async () => {
    if (!wrap.contains(m)) return;
    log?.('Gif', `médium se nenačetlo ${g.url}${token ? ' (s tokenem)' : ''}`);
    // Hostitel si může říct o nový token a médium vykreslit znovu (zamítnuté GIFy moda) → true = vyřízeno.
    if (onError && onError({ wrap, url: g.url, token }) === true) return;
    // 404 / 410 = odebráno / zahozeno → štítek (OBS zprávu skryje). Přechodná chyba (síť, 5xx) → jednou znovu,
    // pak jen štítek bez skrytí zprávy (review kola 4 M4).
    const win = doc.defaultView;
    const status = win?.fetch ? await gifMediaStatus(win, src) : 404;
    if (!wrap.contains(m)) return;
    if (isDefinitiveGone(status)) { gifFallback(doc, wrap, GIF_REMOVED_TEXT, 'uc-gif--removed'); return; }
    if (!retried && win?.setTimeout) {
      retried = true;
      log?.('Gif', `médium ${g.url}: přechodná chyba (${status || 'síť'}) → znovu za ${GIF_RETRY_MS / 1000} s`);
      win.setTimeout(() => { if (!wrap.contains(m)) return; m.src = src; if (video) { m.load?.(); playSafe(m); } }, GIF_RETRY_MS);
      return;
    }
    gifFallback(doc, wrap, GIF_REMOVED_TEXT, 'uc-gif--removed', { gone: false });
  };
  m.addEventListener('error', fail);
  if (video) {
    m.muted = true;
    m.defaultMuted = true;
    m.loop = true;
    m.autoplay = true;
    m.playsInline = true;
    for (const a of ['muted', 'loop', 'autoplay', 'playsinline']) m.setAttribute(a, '');
    m.setAttribute('aria-label', 'GIF');
    const io = lazy ? gifVideoObserver(doc.defaultView) : null;
    if (io) {
      m.preload = 'none';
      lazyVideoSrc.set(m, src);   // ne do atributu (token moda)
      io.observe(m);
    } else {
      m.preload = 'auto';
      m.src = src;
      playSafe(m);
    }
  } else {
    m.alt = 'GIF';
    m.decoding = 'async';
    if (lazy) m.loading = 'lazy';
    m.src = src;
  }
  // GIF na výšku ve zprávě (pokyn usera 2026-09-28): rám 4:3, po stranách rozmazaná ztmavená kopie (ambient).
  // Video v pozadí jen stojí na prvním snímku (druhé dekódování naplno by stálo výkon, hlavně v OBS).
  if (ambient && fit && g.width && g.height && g.width / g.height < GIF_AMBIENT_RATIO) {
    const stage = doc.createElement('div');
    stage.className = 'uc-gif-stage';
    stage.style.setProperty('--uc-gif-stage-w', `${Math.round(fit.height * 4 / 3)}px`);
    const bg = doc.createElement(video ? 'video' : 'img');
    bg.className = 'uc-gif-amb';
    bg.setAttribute('aria-hidden', 'true');
    if (video) { bg.muted = true; bg.setAttribute('muted', ''); bg.preload = 'metadata'; bg.src = `${src}#t=0.1`; }
    else { bg.alt = ''; bg.decoding = 'async'; if (lazy) bg.loading = 'lazy'; bg.src = src; }
    wrap.classList.add('uc-gif--ambient');
    stage.append(bg, m);
    wrap.appendChild(stage);
    return wrap;
  }
  wrap.appendChild(m);
  return wrap;
}

/** GIF ve zprávě pryč (smazáno modem — server médium přestane servírovat). Vrací počet odebraných. */
export function removeGifMedia(el) {
  if (!el || typeof el.querySelectorAll !== 'function') return 0;
  const list = [...el.querySelectorAll('.uc-gif')];
  for (const w of list) {
    const v = w.querySelector('video');
    if (v) {
      try { gifVideoObserver(v.ownerDocument?.defaultView)?.unobserve(v); } catch { /* ignore */ }
      try { v.pause(); v.removeAttribute('src'); v.load?.(); } catch { /* ignore */ }
    }
    w.remove();
  }
  return list.length;
}

// ---------------------------------------------------------------------------
// Fronta ke schválení (mod) — FIFO, jedna karta (GIF knihovna 2026-09-26)
// ---------------------------------------------------------------------------

/** Zámek tlačítek po aktualizaci fronty od jiného moda (proti omylem schválenému dalšímu GIFu). */
export const GIF_LOCK_OTHER_MS = 1000;
/** Zámek po vlastním kliku (proti dvojkliku). */
export const GIF_LOCK_OWN_MS = 300;
/** Jak dlouho zůstane hláška „Už rozhodl X“ / „Schváleno · X“ nad kartou. */
export const GIF_NOTICE_MS = 2500;

/** Výchozí trest u „Zamítnout + timeout“ (spec 2026-09-27-gif-review-upravy §2): 10 min. */
export const GIF_PENALTY_DEFAULT = { value: 10, unit: 'm' };

/** Délka trestu z pole + jednotky (s / m / h) → sekundy (1 s … 14 dní), jinak null. */
export function gifPenaltySec(value, unitId) {
  const u = CUSTOM_UNITS.find((x) => x.id === unitId);
  return u ? customDurationSec(value, u.sec, MAX_TIMEOUT_SEC) : null;
}

/** Nadpis potvrzení permabanu z karty: „Trvale zabanovat divak na Twitchi?“. */
export function gifBanConfirmTitle(req) {
  const where = PLATFORM_LOC[req?.platform] || PLATFORM_NAMES[req?.platform] || req?.platform || '';
  return `Trvale zabanovat ${req?.login || 'uživatele'}${where ? ` na ${where}` : ''}?`;
}

/**
 * Hláška po „Zamítnout + trest“: úspěch = „Zamítnuto · Timeout 10 min pro divak: …“; chyba moderace = zamítnutí platí,
 * „Zamítnuto, ale timeout se nepovedl: …“.
 */
export function gifPenaltyNotice(penalty, req, res, err) {
  const target = { platform: req.platform, login: req.login };
  if (err) return `Zamítnuto, ale ${penalty.kind === 'ban' ? 'ban' : 'timeout'} se nepovedl: ${modErrorText(err)}`;
  return `Zamítnuto · ${summarizeModResult(penalty.kind, target, res || {}, { durationSec: penalty.durationSec })}`;
}

/** „+3 čeká“ (počet dalších čekajících za kartou). */
export const gifWaitingText = (n) => `+${Math.max(0, Math.trunc(Number(n) || 0))} čeká`;

/** „1 GIF“ / „2 GIFy“ / „5 GIFů“. */
export function gifCountText(n) {
  const a = Math.abs(Math.trunc(Number(n) || 0));
  if (a === 1) return '1 GIF';
  if (a >= 2 && a <= 4) return `${a} GIFy`;
  return `${a} GIFů`;
}

/** 409 already_decided `{ status, decidedBy }` → „Už rozhodl modik (Twitch)“. */
export function gifAlreadyDecidedText(status, decidedBy) {
  if (decidedBy === 'library') return 'Už schváleno z knihovny';
  if (decidedBy) return `Už rozhodl ${actorLabel(decidedBy)}`;
  if (status === 'expired') return 'Propadlo — nikdo nerozhodl včas';
  return 'Už rozhodl jiný mod';
}

/** Dříve zamítnuto (karta moda): „Dříve zamítnuto 25. 9. 14:05 · modik (Twitch)“. */
export function gifPrevRejectedText(pr) {
  if (!pr || typeof pr !== 'object') return '';
  const when = gifShortDate(pr.at);
  const by = pr.by ? ` · ${actorLabel(pr.by)}` : '';
  return `Dříve zamítnuto${when ? ` ${when}` : ''}${by}`;
}

/** Čas (ms) → „25. 9. 14:05“ (místní čas); neplatný → ''. */
export function gifShortDate(ms) {
  const at = Number(ms);
  if (!Number.isFinite(at) || at <= 0) return '';
  const d = new Date(at);
  return `${d.getDate()}. ${d.getMonth() + 1}. ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Id média z URL `…/media/gif/<32 hex>` (nebo null). */
export function gifMediaIdOf(url) {
  const m = /\/media\/gif\/([0-9a-f]{32})(?:[/?#]|$)/.exec(String(url || ''));
  return m ? m[1] : null;
}

/**
 * Zámek tlačítek karty (čisté hodiny `now` → testy s falešným časem).
 * lock(ms) prodlužuje, nikdy nezkracuje běžící zámek.
 */
export class GifCardLock {
  constructor(now = Date.now) { this.now = now; this.until = 0; }
  lock(ms) { this.until = Math.max(this.until, this.now() + Math.max(0, Number(ms) || 0)); return this.until; }
  locked() { return this.now() < this.until; }
  remaining() { return Math.max(0, this.until - this.now()); }
  reset() { this.until = 0; }
}

/** Pořadí FIFO: nejstarší první (createdAt, pak requestId). */
const fifoCmp = (a, b) => ((a.createdAt ?? 0) - (b.createdAt ?? 0)) || (Number(a.requestId) - Number(b.requestId));

/**
 * Fronta GIFů ke schválení nad chatem — jen mod, jen JEDNA karta = nejstarší čekající + „+N čeká“.
 * Synchronizace napříč mody: SSE `gif-queue` (pendingCount, headId), `gif-pending`, `gif-decided`.
 * Po změně karty jsou Schválit / Zamítnout chvíli zamčené: 1 s po aktualizaci od jiného moda, 0,3 s po
 * vlastním kliku. 409 already_decided → hláška „Už rozhodl X“ a další karta.
 * Odesílatel (divák) kartu nemá — jeho stav ukazuje štítek u zprávy (core/gif-library.js GifOutbox).
 *
 *   const gifs = new GifRequests({ doc, container, api, channel: () => 'robdiesalot', canModerate: () => true });
 *   accountStream: 'gif-pending' → gifs.onPending(d), 'gif-decided' → gifs.onDecided(d), 'gif-queue' → gifs.onQueue(d)
 *   mod na kanálu / přepnutí kanálu → gifs.clear(); gifs.loadPending()
 */
/** Dvojitá šipka nahoru (záložka karty ke schválení u streamera; rozbalená = otočená dolů). */
const GIF_TOGGLE_SVG = '<svg class="uc-gif-toggle-ico" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 12.5l6-6 6 6"/><path d="M6 18.5l6-6 6 6"/></svg>';

export class GifRequests {
  /**
   * @param {object} o
   * @param {Document} [o.doc]
   * @param {HTMLElement} [o.container]  kontejner chatu (position: relative); karta u jeho spodku
   * @param {(path: string, opts?: {method?: string, body?: object}) => Promise<any>} o.api  backend s Bearer; chyba = throw {error, status, body}
   * @param {() => string} o.channel      aktuální kanál UnityChatu (Twitch login streamera)
   * @param {() => boolean} [o.canModerate]  jsem mod kanálu
   * @param {(platform: string) => string|null} [o.platformIcon]  URL loga platformy
   * @param {(tag: string, text: string) => void} [o.log]
   * @param {() => number} [o.now]
   * @param {(n: number) => void} [o.onChange]  počet čekajících (hostitel může přizpůsobit layout)
   * @param {string[]} [o.origins]  povolené originy médií
   * @param {() => boolean} [o.streamer]  jsem streamer kanálu → karta zabalená do záložky ⌃⌃ (rozbalí si ji sám) a GIF
   *        v kartě rozmazaný (klik zaostří / znovu rozmaže); modi mají kartu jako dosud (pokyn usera 2026-09-28)
   * @param {number} [o.lockOtherMs] / [o.lockOwnMs] / [o.noticeMs]  (testy)
   */
  constructor({ doc = globalThis.document, container, api, channel, canModerate, streamer, platformIcon, log, now, onChange, origins = null, serverOffset, tokens = null, lockOtherMs = GIF_LOCK_OTHER_MS, lockOwnMs = GIF_LOCK_OWN_MS, noticeMs = GIF_NOTICE_MS, setInterval: si, clearInterval: ci, setTimeout: st, clearTimeout: ctm } = {}) {
    this.doc = doc;
    /** Posun hodin (lokální − serverový) z GET /gif/state, když událost nenese `serverNow` (audit F1). */
    this.serverOffset = serverOffset || (() => 0);
    /** Token moda (core/gif-library.js GifAccessToken) pro náhled dříve zamítnutého média v kartě. */
    this.tokens = tokens;
    this.container = container || doc.body;
    this.api = api;
    this.channel = channel || (() => '');
    this.canModerate = canModerate || (() => false);
    this.streamer = streamer || (() => false);
    /** Streamer rozbalil kartu (záložka ⌃⌃); když fronta dojde, zase zabaleno. */
    this._expanded = false;
    this.platformIcon = platformIcon || (() => null);
    this.log = log || (() => {});
    this.now = now || (() => Date.now());
    this.onChange = onChange || (() => {});
    this.origins = origins;
    this.lockOtherMs = lockOtherMs;
    this.lockOwnMs = lockOwnMs;
    this.noticeMs = noticeMs;
    const w = doc.defaultView || globalThis;
    this._si = si || w.setInterval.bind(w);
    this._ci = ci || w.clearInterval.bind(w);
    this._st = st || w.setTimeout.bind(w);
    this._ct = ctm || w.clearTimeout.bind(w);
    this._cards = new Map();   // requestId → { req, busy, error }
    this._decided = new Map(); // requestId → status (rozhodnutí přišlo dřív než žádost / opakované gif-pending)
    this._queue = null;        // { pendingCount, headId } z gif-queue
    this._shownId = null;      // karta, která je právě vidět
    this._ownDecidedId = null; // karta, o které jsem rozhodl já (další karta → zámek 0,3 s)
    this._lock = new GifCardLock(() => this.now());
    this._lockT = null;
    this._notice = null;       // { text, kind }
    this._noticeT = null;
    this._timer = null;
    this._loadingPending = null;
    this.el = null;
  }

  /** Počet čekajících (lokálně známé žádosti). */
  get size() { return this._cards.size; }
  get requests() { return [...this._cards.values()].map((c) => ({ ...c.req, state: 'pending' })); }
  has(requestId) { return this._cards.has(String(requestId)); }
  /** Id karty, která je vidět (nejstarší čekající), nebo null. */
  get headId() { return this._shownId; }
  /** Tlačítka karty jsou zamčená (zámek po změně karty). */
  get locked() { return this._lock.locked(); }
  /** Zbývající zámek karty v ms (ladění / e2e). */
  get lockMs() { return this._lock.remaining(); }

  _L(t) { this.log('Gif', t); }

  /** Počet čekajících pro „+N čeká“: server (gif-queue), jinak lokální. */
  pendingCount() {
    const local = this._cards.size;
    const q = this._queue;
    return q && Number.isFinite(q.pendingCount) ? Math.max(q.pendingCount, q.headId && this._cards.has(String(q.headId)) ? 1 : 0) : local;
  }

  /** Nejstarší čekající, kterou smím vidět (mod), nebo null. */
  _head() {
    if (!this.canModerate()) return null;
    const qh = this._queue?.headId != null ? String(this._queue.headId) : null;
    if (qh && this._cards.has(qh)) return this._cards.get(qh);
    const list = [...this._cards.values()].sort((a, b) => fifoCmp(a.req, b.req));
    return list[0] || null;
  }

  /** SSE `gif-pending` (i po připojení streamu). Vrací true, když přibyla nová žádost. */
  onPending(d) {
    const req = normalizeGifPending(d, { origins: this.origins, now: this.now(), offset: this.serverOffset() });
    if (!req) { this._L(`gif-pending ignorováno (chybná data ${d?.requestId ?? '?'})`); return false; }
    if (!sameChannel(req.channel, this.channel())) { this._L(`gif-pending ${req.requestId} z jiného kanálu (${req.channel})`); return false; }
    if (this._decided.has(req.requestId)) { this._L(`gif-pending ${req.requestId} už rozhodnutý (${this._decided.get(req.requestId)})`); return false; }
    if (req.expiresAt <= this.now()) { this._L(`gif-pending ${req.requestId} už propadlý`); return false; }
    // Cizí žádost vidí jen mod (server ji jinému neposílá; pojistka pro ztrátu role mezi událostmi).
    if (!req.own && !this.canModerate()) { this._L(`gif-pending ${req.requestId} cizí, nejsem mod → bez karty`); return false; }
    const prev = this._cards.get(req.requestId);
    if (prev) {
      // Opakovaně (reconnect streamu, GET pending) — `own` / previouslyRejected se jen doplní.
      if (req.own && !prev.req.own) prev.req.own = true;
      if (req.previouslyRejected && !prev.req.previouslyRejected) prev.req.previouslyRejected = req.previouslyRejected;
      if (this._shownId === req.requestId) this._paint();
      return false;
    }
    this._cards.set(req.requestId, { req, busy: false, error: '' });
    this._L(`gif-pending ${req.requestId} ${req.platform}:${req.login}${req.own ? ' (můj)' : ''}${req.previouslyRejected ? ' (dříve zamítnutý)' : ''} ${req.media.kind} ${req.media.width || '?'}×${req.media.height || '?'} zbývá ${formatCountdown(req.expiresAt - this.now())}`);
    this._render();
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
    const wasHead = this._shownId === x.requestId;
    // Karta, na kterou jsem právě klikl (busy): server pošle gif-decided DŘÍV než HTTP odpověď → moje rozhodnutí.
    const mine = this._dropCard(x.requestId, 'gif-decided');
    // Rozhodl jiný mod o kartě, kterou mám před sebou → řeknout kdo (vlastní rozhodnutí už hláška nepotřebuje).
    if (wasHead && !mine && this._ownDecidedId !== x.requestId) this._setNotice(gifDecisionText(x.status, x.by), x.status);
    this._render();
    return true;
  }

  /** SSE `gif-queue` { channel, pendingCount, headId } — stav fronty kanálu po každé změně (jen modům). */
  onQueue(d) {
    if (!d || typeof d !== 'object' || !sameChannel(d.channel, this.channel())) return false;
    const pendingCount = Math.max(0, Math.trunc(Number(d.pendingCount) || 0));
    const headId = d.headId != null && /^\d+$/.test(String(d.headId)) ? String(d.headId) : null;
    this._queue = { pendingCount, headId };
    this._L(`gif-queue ${pendingCount} čeká, první ${headId ?? '-'}`);
    if (!headId) {
      // Fronta je prázdná → všechno lokální je rozhodnuté (případné gif-decided mohlo chybět).
      for (const id of [...this._cards.keys()]) this._dropCard(id, 'gif-queue prázdná');
    } else if (this._cards.has(headId)) {
      // FIFO: co je starší než první čekající, už nečeká.
      const head = this._cards.get(headId).req;
      for (const [id, c] of [...this._cards]) if (fifoCmp(c.req, head) < 0) { this._dropCard(id, 'gif-queue'); this._L(`gif ${id}: podle gif-queue už nečeká`); }
    } else if (this.canModerate()) {
      // Server zná žádost, kterou klient nemá (výpadek SSE) → dotáhnout.
      void this.loadPending();
    }
    this._render();
    return true;
  }

  /** Mod: čekající žádosti kanálu (GET /moderation/gif/pending, FIFO). Divák dostane 403 → nic. */
  loadPending() {
    if (this._loadingPending) return this._loadingPending;
    const ch = String(this.channel() || '').toLowerCase();
    if (!ch || !this.api) return Promise.resolve(0);
    this._loadingPending = (async () => {
      // Karty známé před dotazem: které server nevrátí, už nečekají (audit F5 — gif-queue s neznámou hlavou).
      const before = new Set(this._cards.keys());
      let j;
      try { j = await this.api(`/moderation/gif/pending?channel=${encodeURIComponent(ch)}`); }
      catch (e) { this._L(`pending FAIL ${e?.status || 0} ${e?.error || e?.message || e}`); return 0; }
      if (!sameChannel(ch, this.channel())) return 0;   // mezitím přepnutý kanál
      const list = Array.isArray(j?.requests) ? j.requests : [];
      const listed = new Set(list.map((r) => String(r?.requestId ?? '')));
      let gone = 0;
      for (const id of before) {
        const c = this._cards.get(id);
        if (!c || c.busy || listed.has(id)) continue;
        this._cards.delete(id);
        this._queueDrop(id);
        gone++;
      }
      let n = 0;
      for (const r of list) if (this.onPending(r)) n++;
      this._L(`pending ${ch}: ${list.length} žádostí, ${n} nových${gone ? `, ${gone} už nečeká` : ''}`);
      if (gone && !n) this._render();
      return n;
    })().finally(() => { this._loadingPending = null; });
    return this._loadingPending;
  }

  /**
   * Klik na Schválit / Zamítnout (jen karta, která je vidět, a ne během zámku). `penalty` ({ kind: 'timeout',
   * durationSec } | { kind: 'ban' }) = „Zamítnout + trest“: po MÉM zamítnutí POST /moderation/user pro odesílatele
   * (chyba moderace = hláška, zamítnutí platí; když rozhodl někdo jiný, trest se neprovede).
   */
  async decide(requestId, approve, penalty = null) {
    const id = String(requestId);
    const card = this._cards.get(id);
    if (!card || card.busy) return null;
    if (this._shownId === id && this._lock.locked()) { this._L(`decide ${id}: zamčeno ještě ${this._lock.remaining()} ms`); return null; }
    card.busy = true; card.error = '';
    this._paint();
    this._L(`decide ${id} ${approve ? 'approve' : 'reject'}${penalty ? ` + ${penalty.kind}${penalty.durationSec ? ` ${penalty.durationSec} s` : ''}` : ''}`);
    const req = card.req;
    try {
      const r = await this.api(`/moderation/gif/${encodeURIComponent(id)}/decide`, { method: 'POST', body: { approve: !!approve } });
      card.busy = false;
      const status = ['approved', 'rejected'].includes(r?.status) ? r.status : (approve ? 'approved' : 'rejected');
      // SSE (gif-decided / gif-queue) předběhlo HTTP odpověď → karta už je pryč jako moje rozhodnutí, jen potvrdit.
      if (card.resolvedBySse) {
        this._rememberDecided(id, status);
        this._L(`decide ${id} → ${status} (SSE bylo rychlejší)`);
        if (penalty && !approve && status === 'rejected') await this._penalize(req, penalty);
        return status;
      }
      // Mezitím karta zmizela (clear po přepnutí kanálu) → nic nevykreslovat; trest se už neprovede (jiný kanál).
      if (this._cards.get(id) !== card) {
        if (penalty && status === 'rejected') this._L(`decide ${id}: zamítnuto, ale karta mezitím zmizela (přepnutí kanálu) → ${penalty.kind} se neprovedl`);
        return null;
      }
      if (r?.published === false) this._L(`decide ${id}: schváleno, ale zpráva se nezapsala (published:false)`);
      this._L(`decide ${id} → ${status}`);
      this._rememberDecided(id, status);
      this._ownDecidedId = id;
      this._cards.delete(id);
      this._queueDrop(id);
      this._render();
      if (penalty && !approve && status === 'rejected') await this._penalize(req, penalty);
      return status;
    } catch (e) {
      card.busy = false;
      // 409 already_decided: hostitel vrací HTTP status v `status`; stav žádosti z těla 409 je v `body.status`
      // (nebo řetězcový `status`) → hláška „Už rozhodl X“ (trest se neprovede).
      const already = (why) => {
        const raw = e.body?.status ?? (typeof e.status === 'string' ? e.status : null);
        const st = ['approved', 'rejected', 'expired'].includes(raw) ? raw : 'closed';
        const by = e.body?.decidedBy ?? e.decidedBy ?? null;
        this._L(`decide ${id}: 409 ${why} (${st}, ${by ?? '-'})${penalty ? ' → trest se neprovede' : ''}`);
        return { st, text: `${gifAlreadyDecidedText(st, by)}${penalty ? ' — trest se neprovedl' : ''}` };
      };
      // Karta zmizela přes SSE jako „moje“, ale server vrátil 409 → rozhodl někdo jiný: doplnit hlášku.
      if (card.resolvedBySse && e?.error === 'already_decided') {
        const { st, text } = already('po SSE');
        this._setNotice(text, st);
        this._render();
        return st;
      }
      if (this._cards.get(id) !== card) return null;
      this._L(`decide ${id} FAIL ${e?.status || 0} ${e?.error || e?.message || e}`);
      if (e?.error === 'already_decided') {
        const { st, text } = already('už rozhodnuto');
        this._rememberDecided(id, st);
        this._cards.delete(id);
        this._queueDrop(id);
        this._setNotice(text, st);
        this._render();
        return st;
      }
      if (e?.error === 'not_found') {
        this._cards.delete(id);
        this._queueDrop(id);
        this._setNotice(gifDecideErrorText(e), 'closed');
        this._render();
        return null;
      }
      card.error = gifDecideErrorText(e);
      this._paint();
      return null;
    }
  }

  /** Trest odesílateli po mém zamítnutí (POST /moderation/user, stejný požadavek jako nabídka moda). */
  async _penalize(req, penalty) {
    const target = { channel: req.channel, platform: req.platform, userId: req.userId, login: req.login };
    this._setNotice(`Zamítnuto · ${penalty.kind === 'ban' ? 'ban' : 'timeout'} pro ${req.login}…`, 'rejected', this.noticeMs * 4);
    this._render();
    const r = buildModRequest(penalty.kind, target, { durationSec: penalty.durationSec });
    let res = null, err = null;
    try { res = await this.api(r.path, { method: r.method, body: r.body }); }
    catch (e) { err = e; }
    this._L(`trest ${penalty.kind} ${req.platform}:${req.userId} → ${err ? `FAIL ${err?.status || 0} ${err?.error || err?.message || err}` : JSON.stringify(res?.results || 'ok').slice(0, 200)}`);
    // Mezitím přepnutý kanál (audit F6): hláška o trestu patří starému kanálu → jen do logu.
    if (!sameChannel(req.channel, this.channel())) { this._L(`trest ${penalty.kind}: kanál se mezitím přepnul → bez hlášky`); return !err; }
    this._setNotice(gifPenaltyNotice(penalty, req, res, err), err ? 'error' : 'rejected', err ? this.noticeMs * 2 : Math.round(this.noticeMs * 1.6));
    this._render();
    return !err;
  }

  /** „Zamítnout + timeout“ z nabídky ▾ karty (délka z pole + jednotky). */
  rejectWithTimeout(requestId) {
    const id = String(requestId);
    const el = [...(this.el?.querySelectorAll('.uc-gif-card') || [])].find((c) => c.dataset.requestId === id);
    if (!el || !this._cards.has(id)) return null;
    const input = el.querySelector('.uc-gif-rmenu-num');
    const unit = el.querySelector('.uc-gif-rmenu .uc-mm-unit[aria-pressed="true"]')?.dataset.unit || GIF_PENALTY_DEFAULT.unit;
    const sec = gifPenaltySec(input?.value, unit);
    if (sec == null) {
      const row = el.querySelector('.uc-gif-rmenu-row');
      row?.classList.add('uc-mm-custom--bad');
      this._st(() => row?.classList.remove('uc-mm-custom--bad'), 600);
      this._L(`karta ${id}: neplatná délka timeoutu (${input?.value} ${unit})`);
      return null;
    }
    return this.decide(id, false, { kind: 'timeout', durationSec: sec });
  }

  /** „Zamítnout + permaban…“ → modální potvrzení (openModDialog z core/mod-menu.js). */
  confirmRejectBan(requestId) {
    const id = String(requestId);
    const card = this._cards.get(id);
    if (!card || card.busy) return null;
    this._L(`permaban ${id}: potvrzení`);
    return openModDialog({
      doc: this.doc,
      title: gifBanConfirmTitle(card.req),
      subtitle: 'GIF se zamítne a uživatel dostane trvalý ban (i na propojených platformách účtu UnityChatu). Zrušíš ho přes Unban.',
      submitLabel: 'Zamítnout + ban',
      danger: true,
      onSubmit: async () => {
        if (!this._cards.has(id)) throw new Error('O GIFu už je rozhodnuto.');
        if (this._shownId === id && this._lock.locked()) throw new Error('Tlačítka jsou ještě chvíli zamčená, zkus to znovu.');
        const st = await this.decide(id, false, { kind: 'ban' });
        if (st === null && this._cards.has(id)) throw new Error(this._cards.get(id).error || 'Zamítnutí se nepovedlo.');
      },
    });
  }

  /** „Automaticky zahazovat 12 h“ (dříve zamítnutý GIF, od všech) → POST /moderation/gif/:mediaId/ban12h. */
  async ban12h(requestId) {
    const id = String(requestId);
    const card = this._cards.get(id);
    const mediaId = card ? gifMediaIdOf(card.req.media.url) : null;
    if (!card || card.busy || !mediaId) return null;
    if (this._shownId === id && this._lock.locked()) return null;
    card.busy = true; card.error = '';
    this._paint();
    try {
      const r = await this.api(`/moderation/gif/${mediaId}/ban12h`, { method: 'POST', body: {} });
      card.busy = false;
      this._L(`ban12h ${mediaId} (žádost ${id}) → zamítnuto ${r?.rejected ?? '?'} čekajících`);
      if (this._cards.get(id) === card) {
        this._rememberDecided(id, 'rejected');
        this._ownDecidedId = id;
        this._cards.delete(id);
        this._queueDrop(id);
        this._render();
      }
      return r;
    } catch (e) {
      card.busy = false;
      this._L(`ban12h ${mediaId} FAIL ${e?.status || 0} ${e?.error || e?.message || e}`);
      if (this._cards.get(id) === card) { card.error = gifDecideErrorText(e); this._paint(); }
      return null;
    }
  }

  /** Role se změnila (mod ↔ divák) → cizí žádosti pryč (vlastní zůstávají v datech), karta znovu. */
  repaint() {
    if (!this.canModerate()) {
      for (const [id, c] of [...this._cards]) if (!c.req.own) { this._L(`gif ${id}: nejsem mod → žádost pryč`); this._cards.delete(id); }
    }
    this._render();
  }

  /** Přepnutí kanálu / odhlášení: všechno pryč. */
  clear() {
    this._cards.clear();
    this._decided.clear();
    this._queue = null;
    this._shownId = null;
    this._ownDecidedId = null;
    this._lock.reset();
    if (this._lockT) { this._ct(this._lockT); this._lockT = null; }
    if (this._noticeT) { this._ct(this._noticeT); this._noticeT = null; }
    this._notice = null;
    this._stopTimer();
    if (this.el) { removeGifMedia(this.el); this.el.remove(); this.el = null; }
    this.onChange(0);
  }

  destroy() { this.clear(); }

  // ---- interní ----

  _rememberDecided(id, status) {
    this._decided.set(String(id), status);
    if (this._decided.size > 300) this._decided.delete(this._decided.keys().next().value);
  }

  /**
   * Žádost pryč ze SSE (gif-decided / gif-queue). Když na ni právě běží můj klik (busy), je to moje rozhodnutí:
   * backend rozešle SSE dřív, než odpoví na HTTP → další karta se zámkem 0,3 s a bez hlášky. Vrací true = moje.
   */
  _dropCard(id, why) {
    const card = this._cards.get(String(id));
    if (!card) return false;
    this._cards.delete(String(id));
    this._queueDrop(id);
    if (!card.busy) return false;
    card.resolvedBySse = true;
    this._ownDecidedId = String(id);
    this._L(`gif ${id}: ${why} před HTTP odpovědí na můj klik → moje rozhodnutí (zámek ${this.lockOwnMs} ms)`);
    return true;
  }

  /** Žádost zmizela lokálně → odhad fronty do příští gif-queue (počet − 1, první = neznámá). */
  _queueDrop(id) {
    const q = this._queue;
    if (!q) return;
    if (q.headId === String(id) || this._cards.size < q.pendingCount) {
      q.pendingCount = Math.max(0, q.pendingCount - 1);
      if (q.headId === String(id)) q.headId = null;
    }
  }

  _setNotice(text, kind, ms = this.noticeMs) {
    if (!text) return;
    this._notice = { text, kind };
    if (this._noticeT) this._ct(this._noticeT);
    this._noticeT = this._st(() => { this._noticeT = null; this._notice = null; this._render(); }, ms);
  }

  _root() {
    if (this.el && this.el.isConnected) return this.el;
    const el = this.doc.createElement('div');
    el.className = 'uc-gif-stack';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'GIFy ke schválení');
    el.innerHTML = `<button type="button" class="uc-gif-toggle" data-act="toggle" aria-expanded="false" hidden>${GIF_TOGGLE_SVG}<span class="uc-gif-toggle-n"></span></button>`
      + '<div class="uc-gif-notice" role="status" hidden></div><div class="uc-gif-slot"></div><div class="uc-gif-more" hidden></div>';
    el.addEventListener('click', (e) => {
      const b = e.target.closest?.('[data-act]');
      if (!b || !el.contains(b)) return;
      if (b.dataset.act === 'toggle') { e.stopPropagation(); this.setExpanded(!this._expanded); return; }
      const card = b.closest('.uc-gif-card');
      if (!card) return;
      e.stopPropagation();
      const act = b.dataset.act;
      if (act === 'approve') this.decide(card.dataset.requestId, true);
      else if (act === 'reject') this.decide(card.dataset.requestId, false);
      else if (act === 'ban12h') this.ban12h(card.dataset.requestId);
      else if (act === 'reject-more') this._toggleRejectMenu(card);
      else if (act === 'unit') {
        for (const u of card.querySelectorAll('.uc-gif-rmenu .uc-mm-unit')) u.setAttribute('aria-pressed', String(u === b));
      } else if (act === 'reject-timeout') this.rejectWithTimeout(card.dataset.requestId);
      else if (act === 'focus') {
        // Streamer: rozmazaný GIF klikem zaostří, dalším klikem zase rozmaže.
        const on = card.classList.toggle('uc-gif-focused');
        b.setAttribute('aria-pressed', String(on));
        this._L(`karta ${card.dataset.requestId}: GIF ${on ? 'zaostřen' : 'rozmazán'}`);
      }
      else if (act === 'reject-ban') this.confirmRejectBan(card.dataset.requestId);
    });
    // Esc v nabídce ▾ ji zavře (ne celý panel).
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const card = e.target.closest?.('.uc-gif-card');
      const menu = card?.querySelector('.uc-gif-rmenu');
      if (!menu || menu.hidden) return;
      e.preventDefault(); e.stopPropagation();
      this._toggleRejectMenu(card, false);
      card.querySelector('.uc-gif-split-more')?.focus();
    });
    this.container.appendChild(el);
    this.el = el;
    return el;
  }

  /** Nabídka ▾ u Zamítnout (Zamítnout + timeout / + permaban). */
  _toggleRejectMenu(cardEl, open) {
    const menu = cardEl.querySelector('.uc-gif-rmenu');
    const btn = cardEl.querySelector('.uc-gif-split-more');
    if (!menu || !btn) return;
    const show = open ?? menu.hidden;
    menu.hidden = !show;
    btn.setAttribute('aria-expanded', String(show));
    this._L(`karta ${cardEl.dataset.requestId}: nabídka trestu ${show ? 'otevřena' : 'zavřena'}`);
    if (show) cardEl.querySelector('.uc-gif-rmenu-num')?.focus();
  }

  /** Streamer: rozbalit / zabalit kartu ke schválení (záložka ⌃⌃). */
  setExpanded(on) {
    this._expanded = !!on;
    this._L(`karta ke schválení ${this._expanded ? 'rozbalena' : 'zabalena'} (streamer)`);
    this._render();
  }

  /** Streamer se zabalenou kartou: vidí jen záložku ⌃⌃ s počtem (karta, hlášky i „+N čeká“ schované). */
  _paintCollapse(headId) {
    const root = this.el;
    if (!root) return;
    const streamer = !!headId && this.streamer();
    const collapsed = streamer && !this._expanded;
    root.classList.toggle('uc-gif-stack--collapsed', collapsed);
    const t = root.querySelector('.uc-gif-toggle');
    if (!t) return;
    t.hidden = !streamer;
    t.setAttribute('aria-expanded', String(streamer && this._expanded));
    t.classList.toggle('open', streamer && this._expanded);
    // Server (gif-queue) může být o krok pozadu za novou žádostí → aspoň lokálně známé.
    const n = Math.max(this.pendingCount(), this._cards.size);
    t.querySelector('.uc-gif-toggle-n').textContent = n > 0 ? String(n) : '';
    t.title = collapsed ? `GIFy ke schválení (${n}) — rozbalit` : 'Zabalit';
    t.setAttribute('aria-label', t.title);
  }

  /** Karta = nejstarší čekající; při změně karty zámek (0,3 s po mém rozhodnutí, jinak 1 s). */
  _render() {
    const head = this._head();
    const headId = head?.req.requestId ?? null;
    if (headId !== this._shownId) {
      const prev = this._shownId;
      this._shownId = headId;
      if (headId) {
        const own = prev !== null && prev === this._ownDecidedId;
        const ms = own ? this.lockOwnMs : this.lockOtherMs;
        this._lock.reset();
        this._lock.lock(ms);
        if (this._lockT) this._ct(this._lockT);
        this._lockT = this._st(() => { this._lockT = null; this._paint(); }, ms + 5);
        this._L(`karta ${headId} (před ní ${prev ?? '-'}) → zámek ${ms} ms${own ? ' (moje rozhodnutí)' : ''}`);
      }
      this._ownDecidedId = null;
    }
    // Fronta došla → příště zase zabaleno (streamer).
    if (!headId) this._expanded = false;
    if (!headId && !this._notice) {
      if (this.el) { removeGifMedia(this.el); this.el.remove(); this.el = null; }
      this._stopTimer();
      this.onChange(this._cards.size);
      return;
    }
    const root = this._root();
    const slot = root.querySelector('.uc-gif-slot');
    const cur = slot.querySelector('.uc-gif-card');
    if (!headId) { if (cur) { removeGifMedia(cur); cur.remove(); } }
    else if (!cur || cur.dataset.requestId !== headId) {
      if (cur) { removeGifMedia(cur); cur.remove(); }
      slot.appendChild(this._build(head));
    }
    this._paint();
    this._paintCollapse(headId);
    if (headId) this._startTimer(); else this._stopTimer();
    this.onChange(this._cards.size);
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
    let changed = false;
    for (const [id, c] of [...this._cards]) {
      if (now < c.req.expiresAt) continue;
      // Server propadnutí ohlásí do 10 s (gif-decided expired) — lokálně hned, ať mod neklikne naprázdno.
      this._rememberDecided(id, 'expired');
      this._cards.delete(id);
      this._queueDrop(id);
      this._L(`gif ${id} propadl (lokálně)`);
      if (id === this._shownId) this._setNotice(gifDecisionText('expired'), 'expired');
      changed = true;
    }
    if (changed) { this._render(); return; }
    const head = this._shownId ? this._cards.get(this._shownId) : null;
    const t = this.el?.querySelector('.uc-gif-timer');
    if (head && t) t.textContent = formatCountdown(head.req.expiresAt - now);
    if (!this._cards.size) this._stopTimer();
  }

  _build(card) {
    const doc = this.doc;
    const { req } = card;
    const el = doc.createElement('div');
    el.className = `uc-gif-card uc-gif-card--pending${this.streamer() ? ' uc-gif-card--blur' : ''}`;
    el.dataset.requestId = req.requestId;
    el.innerHTML = `
      <div class="uc-gif-card-head">
        <span class="uc-gif-card-pi"></span>
        <span class="uc-gif-card-who"></span>
        <span class="uc-gif-card-kind"></span>
        <span class="uc-gif-timer" title="Zbývá do propadnutí"></span>
      </div>
      <div class="uc-gif-card-text"></div>
      <div class="uc-gif-card-prev" hidden></div>
      <div class="uc-gif-card-media"></div>
      <div class="uc-gif-card-err" role="alert" hidden></div>
      <div class="uc-gif-card-actions">
        <button type="button" class="uc-gif-btn uc-gif-btn--ban" data-act="ban12h" hidden title="Tento GIF bude 12 hodin automaticky zamítnut u všech">Automaticky zahazovat 12 h</button>
        <span class="uc-gif-split">
          <button type="button" class="uc-gif-btn uc-gif-btn--reject" data-act="reject">Zamítnout</button><button type="button" class="uc-gif-btn uc-gif-btn--reject uc-gif-split-more" data-act="reject-more" aria-haspopup="true" aria-expanded="false" aria-label="Zamítnout a potrestat" title="Zamítnout a potrestat">▾</button>
        </span>
        <button type="button" class="uc-gif-btn uc-gif-btn--approve" data-act="approve">Schválit</button>
      </div>
      <div class="uc-gif-rmenu" role="group" aria-label="Zamítnout a potrestat" hidden>
        <div class="uc-gif-rmenu-row uc-mm-custom">
          <span class="uc-gif-rmenu-label">Zamítnout + timeout</span>
          <span class="uc-gif-rmenu-dur"></span>
          <button type="button" class="uc-gif-btn uc-gif-btn--reject" data-act="reject-timeout">Potvrdit</button>
        </div>
        <button type="button" class="uc-gif-btn uc-gif-btn--danger uc-gif-rmenu-ban" data-act="reject-ban">Zamítnout + permaban…</button>
      </div>`;
    // Výběr délky jako custom timeout v nabídce moda (číslo + s / m / h), výchozí 10 min.
    const dur = el.querySelector('.uc-gif-rmenu-dur');
    const { input } = createDurationNumber(doc, { value: GIF_PENALTY_DEFAULT.value, label: 'Délka timeoutu', className: 'uc-mm-custom-num uc-gif-rmenu-num', onEnter: () => this.rejectWithTimeout(req.requestId) });
    dur.appendChild(input);
    for (const u of CUSTOM_UNITS) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'uc-mm-unit';
      b.dataset.act = 'unit';
      b.dataset.unit = u.id;
      b.textContent = u.id;
      b.title = { s: 'sekundy', m: 'minuty', h: 'hodiny' }[u.id];
      b.setAttribute('aria-pressed', String(u.id === GIF_PENALTY_DEFAULT.unit));
      dur.appendChild(b);
    }
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
    const media = el.querySelector('.uc-gif-card-media');
    this._cardMedia(media, req);
    if (this.streamer()) {
      // Streamer: GIF rozmazaný, klik zaostří / znovu rozmaže (data-act focus v obsluze kořene).
      media.dataset.act = 'focus';
      media.setAttribute('role', 'button');
      media.setAttribute('tabindex', '0');
      media.setAttribute('aria-pressed', 'false');
      media.title = 'Klikni pro zaostření / rozmazání';
    }
    el.querySelector('.uc-gif-timer').textContent = formatCountdown(req.expiresAt - this.now());
    return el;
  }

  /**
   * Náhled GIFu v kartě. S tokenem moda, když ho máme (dříve zamítnuté médium — `tokenRequired` — server bez tokenu
   * nevydá: počkat na vydání tokenu). Chyba načtení s tokenem → jednou nový token a znovu. Token jen v `src`.
   */
  _cardMedia(box, req, { waited = false, retried = false } = {}) {
    if (!box) return;
    const tok = this.tokens?.current?.() || null;
    if (req.tokenRequired && !tok && this.tokens && !waited) {
      this._L(`karta ${req.requestId}: médium jen s tokenem → čekám na token`);
      void Promise.resolve(this.tokens.get()).catch(() => null).then(() => this._cardMedia(box, req, { waited: true, retried }));
      return;
    }
    removeGifMedia(box);
    box.replaceChildren(createGifMedia(this.doc, req.media, {
      lazy: false, log: this.log, maxW: GIF_MAX_W, maxH: GIF_CARD_MAX_H, token: tok,
      onError: this.tokens && (tok || req.tokenRequired) && !retried ? () => {
        this._L(`karta ${req.requestId}: médium s tokenem se nenačetlo → nový token`);
        void Promise.resolve(this.tokens.refresh()).catch(() => null).then(() => this._cardMedia(box, req, { waited: true, retried: true }));
        return true;
      } : null,
    }));
  }

  /** Stav karty (zámek, busy, chyba, dříve zamítnuto) + hláška + „+N čeká“. */
  _paint() {
    const root = this.el;
    if (!root) return;
    const notice = root.querySelector('.uc-gif-notice');
    notice.textContent = this._notice?.text || '';
    notice.hidden = !this._notice;
    notice.className = `uc-gif-notice${this._notice?.kind ? ` uc-gif-notice--${this._notice.kind}` : ''}`;
    const more = root.querySelector('.uc-gif-more');
    const extra = this._shownId ? Math.max(0, this.pendingCount() - 1) : 0;
    more.hidden = !extra;
    more.textContent = extra ? gifWaitingText(extra) : '';
    const el = root.querySelector('.uc-gif-card');
    const card = el ? this._cards.get(el.dataset.requestId) : null;
    if (!el || !card) return;
    const { req } = card;
    const locked = this._lock.locked();
    el.classList.toggle('uc-gif-card--own', !!req.own);
    el.classList.toggle('uc-gif-card--mod', true);
    el.classList.toggle('uc-gif-card--busy', !!card.busy);
    el.classList.toggle('uc-gif-card--locked', locked);
    el.querySelector('.uc-gif-card-kind').textContent = req.own ? 'Tvůj GIF' : 'Chce poslat GIF';
    const prevEl = el.querySelector('.uc-gif-card-prev');
    prevEl.textContent = req.previouslyRejected ? gifPrevRejectedText(req.previouslyRejected) : '';
    prevEl.hidden = !req.previouslyRejected;
    const err = el.querySelector('.uc-gif-card-err');
    err.textContent = card.error || '';
    err.hidden = !card.error;
    el.querySelector('.uc-gif-btn--ban').hidden = !req.previouslyRejected;
    // Vlastní GIF (mod v Dev módu) sám sebe trestat nemůže → bez ▾.
    el.querySelector('.uc-gif-split-more').hidden = !!req.own;
    if (req.own) el.querySelector('.uc-gif-rmenu').hidden = true;
    for (const b of el.querySelectorAll('.uc-gif-card-actions button, .uc-gif-rmenu button, .uc-gif-rmenu input')) b.disabled = !!card.busy || locked;
    el.setAttribute('aria-label', `${req.own ? 'Tvůj GIF' : `GIF od ${req.login}`}${extra ? `, ${gifWaitingText(extra)}` : ''}`);
  }
}

