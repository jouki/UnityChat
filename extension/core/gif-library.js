// GIF knihovna (spec docs/superpowers/specs/2026-09-26-gif-knihovna-design.md, kontrakt
// docs/superpowers/plans/2026-09-25-moderace-cast-2-kontrakt.md §„GIF knihovna“). Sdílené addonem i webem.
//
//  - GifOutbox: stav vlastní zprávy s GIF odkazem u odesílatele — kolečko s % (SSE `gif-progress`),
//    peach štítek „Schvalování moderátorem ( )“ (+ ⚠ u dříve zamítnutého), červený „Zamítnuto moderátorem“ /
//    „Vypršelo“ natrvalo; `gif-notice` (approved_only, auto_rejected). paintGifStatus = DOM štítku ve zprávě.
//  - GifAccessToken: token moda pro náhledy zamítnutých médií (`?t=`), jen v paměti + session úložišti hostitele.
//  - gifRewardView: stav odměny pro indikátor (časový pásek jako u soundboardu) a hlavičku GIF záložky.
//  - createGifPanel: záložka „GIFy“ v panelu emotů — knihovna (podle použití, hledání v tazích), výběr = odkaz
//    `api.jouki.cz/media/gif/<id>` do chatu; mod: záložky GIFy | Zamítnuté GIFy, návrhy duplikátů, akce.
//
// Bez chrome.*: DOM přes injektovaný `doc`, síť přes injektované `api(path, opts)` (hostitel přidá Bearer; chyba =
// throw { error, status, body }). Cizí text jde do DOM jen přes textContent / esc. Token se nikdy neloguje.
import { createGifMedia, removeGifMedia, normalizeGifMedia, normalizeGifPending, normalizeGifDecided, gifCountText, gifShortDate, sameChannel, isGifHeldReason, gifLocalTime, GIF_HOLD_BATCH, GIF_REJECTED_REASON } from './gif.js';
import { escapeAttr } from './html.js';
import { actorLabel } from './user-history.js';
import { formatRemaining, LOCK_ICON_SVG, shakeLock } from './soundboard.js';
import { createSlideIndicator } from './slide-indicator.js';
import { canAutoFocus } from './panel-morph.js';
import { gifCooldownText } from './gif-cooldown.js';

// Všechny atributy v šablonách jsou v uvozovkách → escapeAttr stačí i na text.
const esc = (s) => escapeAttr(s ?? '');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------------------
// Průběh stahování (gif-progress) a štítky u vlastní zprávy
// ---------------------------------------------------------------------------

/** Bright Data fáze se zasekne na 95 %, dokud nepřijde další fáze. */
export const GIF_PROGRESS_STUCK = 95;
/** Jak dlouho po odeslání se `gif-progress` bez známého id páruje s poslední vlastní optimistickou GIF zprávou. */
export const GIF_OPTIMISTIC_PAIR_MS = 60_000;
/** Animace fáze `unlock` (50 → 95 podle odhadu) — krok překreslení. */
export const GIF_PROGRESS_TICK_MS = 250;
/** Optimistické kolečko bez jediné události ze serveru zmizí po této době. */
export const GIF_OPTIMISTIC_SILENT_MS = 15_000;
/**
 * Průběh (jakákoli fáze) bez další události ze serveru — ztracené `done`, výpadek SSE, zaseknutý unlock → po této
 * době dotaz na stav (GET /gif/held), bez něj / když selže „Vypršelo“ a konec animace.
 */
export const GIF_PROGRESS_MAX_SILENT_MS = 60_000;
/** Čekání na moda bez rozhodnutí (ztracené `gif-decided`): po `expiresAt` + rezerva → dotaz na stav. */
export const GIF_PENDING_GRACE_MS = 15_000;
/** Doba žádosti, když `expiresAt` chybí (ztracený vlastní `gif-pending`) — výchozí `requestTtlSec` serveru. */
export const GIF_PENDING_DEFAULT_TTL_MS = 300_000;
/** Server říká „pořád čeká / převádí“ → další dotaz za tuto dobu. */
export const GIF_HELD_RECHECK_MS = 30_000;
/** Kolikrát nejvýš se na jednu zprávu ptát, pak „Vypršelo“. */
export const GIF_OWN_MAX_CHECKS = 6;
/**
 * Dotaz /gif/held selhal (síť, 5xx, rate limit) → zeptat se znovu s odstupem (30 s, 60 s, … nejvýš 5 min), štítek
 * zůstává (audit E1: „Vypršelo“ jen z odpovědi serveru). Po GIF_HELD_MAX_FAILS neúspěších se přestane ptát, štítek
 * zůstane a doptá se ho resync po znovupřipojení /account/stream.
 */
export const GIF_HELD_BACKOFF_MAX_MS = 300_000;
export const GIF_HELD_MAX_FAILS = 12;
/** Token moda platí 30 dní (backend) — nový se vydá den před koncem. */
export const GIF_TOKEN_RENEW_MS = 86_400_000;
/** Výběr z knihovny, když vlastní GIF ještě čeká (server pustí jen jednu žádost na uživatele, audit X1). */
export const GIF_WAIT_OWN_TEXT = 'Počkej, až mod rozhodne o tvém GIFu.';
const HELD_BATCH = GIF_HOLD_BATCH;

export const GIF_STATUS_TEXT = {
  pending: 'Schvalování moderátorem',
  rejected: 'Zamítnuto moderátorem',
  expired: 'Vypršelo',
  not_allowed: 'Nové GIFy teď nejdou',
};
export const GIF_PREV_REJECTED_TIP = 'tento GIF byl už dříve zamítnut';
export const GIF_APPROVED_ONLY_TEXT = 'Nové GIFy teď nejdou, vyber z GIFů v panelu';
/** Náš odkaz (id) na GIF z knihovny: krátký stav bez procent, dokud server nezačne stahovat (test2 bod 4). */
export const GIF_SENDING_TEXT = 'Odesílám…';
/** Fáze, od které se u zprávy ukazuje kolečko s procenty. */
const DOWNLOAD_PHASES = new Set(['download', 'unlock']);

/**
 * Hláška po `gif-notice` cooldown (test2 bod 4.1): GIF odkaz během cooldownu zůstal běžnou zprávou, nebo ho (removed)
 * hned smazal běžný filtr odkazů (review M2).
 */
export function gifCooldownNoticeText(ms, { removed = false } = {}) {
  return `GIF můžeš poslat až za ${formatRemaining(ms)} — ${removed ? 'zprávu s odkazem smazal filtr odkazů.' : 'odkaz zůstal jako běžná zpráva.'}`;
}

const PHASES = new Set(['detect', 'access', 'download', 'unlock', 'verify', 'done']);

/** SSE `gif-progress` → { key, channel, platform, messageId, phase, pct, estimateMs, elapsedMs, outcome }, nebo null. */
export function normalizeGifProgress(d) {
  if (!d || typeof d !== 'object' || !PHASES.has(d.phase)) return null;
  const platform = String(d.platform || '');
  const messageId = d.messageId != null ? String(d.messageId) : '';
  const key = d.requestKey ? String(d.requestKey) : (platform && messageId ? `${platform}:${messageId}` : '');
  if (!key || !/^[a-z]+:.+/.test(key)) return null;
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
  return {
    key,
    channel: String(d.channel || '').toLowerCase(),
    platform: platform || key.split(':')[0],
    messageId: messageId || key.slice(key.indexOf(':') + 1),
    phase: d.phase,
    pct: clamp(Number(d.pct) || 0, 0, 100),
    estimateMs: num(d.estimateMs),
    elapsedMs: num(d.elapsedMs) ?? 0,
    outcome: d.phase === 'done' ? String(d.outcome || '') : null,
  };
}

/**
 * Procenta k zobrazení v čase `now`. Fáze `unlock` (Bright Data): lineárně 50 → 95 podle `estimateMs`
 * (od `elapsedMs` + čas od příchodu události), zasekne se na 95. Ostatní fáze = `pct` ze serveru.
 * `floor` = dosud ukázané maximum (procenta nikdy nejdou zpět).
 */
export function gifProgressPct(p, now, floor = 0) {
  if (!p) return floor;
  let v = p.pct;
  if (p.phase === 'unlock' && p.estimateMs > 0) {
    const el = (p.elapsedMs || 0) + Math.max(0, now - (p.at ?? now));
    v = 50 + (GIF_PROGRESS_STUCK - 50) * Math.min(1, el / p.estimateMs);
  } else if (p.phase === 'unlock') v = 50;
  if (p.phase === 'done') v = 100;
  return clamp(Math.max(floor, v), 0, p.phase === 'done' ? 100 : GIF_PROGRESS_STUCK);
}

/** „42 %“ (celá čísla dolů, 0–100). */
export const formatGifPct = (p) => `${Math.floor(clamp(Number(p) || 0, 0, 100))} %`;

/** Výsledek `done.outcome` → stav štítku. */
export function gifOutcomeState(outcome) {
  switch (outcome) {
    case 'pending': return 'pending';
    case 'approved': return 'approved';
    case 'rejected': return 'rejected';
    case 'not_allowed': return 'not_allowed';
    default: return 'none';   // failed / denied / cancelled = běžná zpráva
  }
}

/**
 * Položka `GET /gif/held` → stav štítku vlastní zprávy: `status` žádosti (server od 2026-09-26) má přednost;
 * starší odpověď bez něj podle `state`. `progress` = zachycení ještě běží, `pending` = čeká na moda,
 * `none` = běžná zpráva (převod selhal / smazána jinak).
 */
export function gifHeldOwnState(r) {
  switch (r?.status) {
    case 'approved': case 'deleted': return 'approved';
    case 'rejected': return 'rejected';
    case 'expired': return 'expired';
    case 'pending': return 'pending';
    default: break;
  }
  switch (r?.state) {
    case 'replaced': return 'approved';
    case 'deleted': return r.reason === 'gif_rejected' ? 'rejected' : 'none';
    case 'visible': return 'none';
    case 'held': return 'progress';
    default: return 'expired';
  }
}

/**
 * Echo vlastní GIF zprávy spárované přes id (ne text): server ji schoval (`gif_request`) a `/chat/stream` ji pošle
 * BEZ obsahu → optimistická zpráva si nechá svůj text, echo dodá jen id, čas a stav smazání.
 */
export function gifEchoPatch(msg) {
  if (!msg || typeof msg !== 'object') return msg;
  const text = String(msg.message || '').replace(/\u2800/g, '').trim();
  const has = !!text || (Array.isArray(msg.ytRuns) && msg.ytRuns.length > 0) || (typeof msg.kickContent === 'string' && msg.kickContent.trim().length > 0) || !!msg.gif;
  if (has) return msg;
  const { message: _m, ytRuns: _y, kickContent: _k, segments: _s, twitchEmotes: _t, twitchEmotesOffset: _o, badgesRaw: _b, color: _c, ...rest } = msg;
  return rest;
}

/**
 * Stav vlastních GIF zpráv (odesílatel). Klíč = `platform:messageId` (requestKey serveru). Optimistická zpráva
 * (`sent-…`) se na klíč napáruje přes `alias` (id z POST /chat/send, echo z platformy) nebo — když průběh přijde
 * dřív než echo — na poslední vlastní optimistickou GIF zprávu téže platformy (do GIF_OPTIMISTIC_PAIR_MS).
 *
 *   outbox.onProgress(d) / onNotice(d) / onOwnPending(d) / onDecided(d) / onGifMessage(msg)
 *   outbox.view(platform, id, now) → { kind, pct?, text?, warn? } | null
 *   outbox.governs(platform, optId) → stav zprávy řídí GIF (host ji nesmí po 20 s označit jako neodeslanou)
 *   outbox.optIdFor(platform, realId) → optimistická zpráva spárovaná s tímto id (echo schovaného GIFu bez textu)
 *   outbox.resync() → po znovupřipojení SSE dotaz na stav čekajících štítků
 *   host: onChange(keys) → překreslit štítky zpráv (paintGifStatus), onNotice(kind, entry) → hláška
 *
 * Pojistka po ztrátě SSE (`api` = GET /gif/held): průběh bez události GIF_PROGRESS_MAX_SILENT_MS, čekání na moda
 * po `expiresAt` + GIF_PENDING_GRACE_MS → dotaz; server „čeká“ → znovu za GIF_HELD_RECHECK_MS (nejvýš
 * GIF_OWN_MAX_CHECKS×); bez `api` / chyba dotazu → „Vypršelo“.
 */
export class GifOutbox {
  constructor({ channel, now, log, onChange, onNotice, hasMessage, api, serverOffset, setInterval: si, clearInterval: ci } = {}) {
    this.api = typeof api === 'function' ? api : null;
    /** Posun hodin (lokální − serverový) z GET /gif/state pro `expiresAt` bez `serverNow` (audit F1). */
    this.serverOffset = serverOffset || (() => 0);
    this.channel = channel || (() => '');
    this.now = now || (() => Date.now());
    this.log = log || (() => {});
    this.onChange = onChange || (() => {});
    this.onNoticeCb = onNotice || (() => {});
    this.hasMessage = hasMessage || (() => true);
    this._si = si || globalThis.setInterval.bind(globalThis);
    this._ci = ci || globalThis.clearInterval.bind(globalThis);
    this._e = new Map();       // key → entry
    this._alias = new Map();   // optId → key
    this._opt = [];            // [{ optId, platform, at }] vlastní optimistické GIF zprávy bez klíče
    this._req = new Map();     // requestId → key
    this._timer = null;
  }

  _L(t) { this.log('Gif', `průběh: ${t}`); }

  /** Klíč zprávy (optimistická → skutečný klíč, když je spárovaná). */
  keyOf(platform, id) {
    const sid = String(id ?? '');
    return this._alias.get(sid) || `${platform}:${sid}`;
  }

  /** Vlastní GIF zpráva (optimistická nebo spárovaná)? */
  has(platform, id) { return this._e.has(this.keyOf(platform, id)); }
  get(platform, id) { return this._e.get(this.keyOf(platform, id)) || null; }
  get size() { return this._e.size; }

  /**
   * Odeslal jsem zprávu s GIF odkazem (optimistická `optId`). `show` = kolečko 0 % hned (odměnu mám / jsem mod);
   * když do GIF_OPTIMISTIC_SILENT_MS nepřijde nic ze serveru (bez účtu, neodemčeno), kolečko zmizí.
   */
  noteOptimistic(optId, platform, { show = false, own = false } = {}) {
    if (!optId || !platform) return;
    this._opt.push({ optId: String(optId), platform, at: this.now() });
    if (this._opt.length > 20) this._opt.shift();
    // Náš odkaz (api.jouki.cz/media/gif/<id>, výběr z knihovny): server ho nestahuje → „Odesílám…“ bez procent.
    if (own) {
      (this._ownOpt ||= new Set()).add(String(optId));
      if (this._ownOpt.size > 50) this._ownOpt.delete(this._ownOpt.values().next().value);
    }
    if (show) {
      const e = this._entry(`${platform}:${optId}`, platform, String(optId));
      e.optimistic = true;
      e.ownLink = !!own;
      this._L(`${optId} odeslán GIF odkaz → ${own ? GIF_SENDING_TEXT : 'kolečko 0 %'}`);
      this._arm();
    }
  }

  /** Klíč patří zprávě s naším odkazem (optimistická označená `own`)? */
  _isOwnLink(key) { return !!this._ownOpt?.size && this.idsFor(key).some((id) => this._ownOpt.has(id)); }

  /** Zpráva neodešla / zmizela → bez štítku. */
  drop(platform, id) {
    const key = this.keyOf(platform, id);
    if (this._e.delete(key)) this.onChange([key]);
    this._opt = this._opt.filter((o) => o.optId !== String(id));
  }

  /**
   * Řídí stav této (optimistické) zprávy GIF štítek? Pak ji host po 20 s bez echa NESMÍ označit jako neodeslanou
   * (server ji schoval / bot smazal dřív, než ji poller viděl) — výsledek dá gif-progress / gif-decided / štítek.
   */
  governs(platform, id) { return this.view(platform, id) !== null; }

  /** Optimistická zpráva spárovaná (alias) se skutečným id `realId`, nebo null. */
  optIdFor(platform, realId) {
    const key = `${platform}:${realId}`;
    for (const [opt, k] of this._alias) if (k === key) return opt;
    return null;
  }

  /** Všechna id zpráv s tímto klíčem (skutečné + optimistické aliasy). */
  idsFor(key) {
    const out = [key.slice(key.indexOf(':') + 1)];
    for (const [opt, k] of this._alias) if (k === key) out.push(opt);
    return out;
  }

  /** Optimistická zpráva má skutečné id (POST /chat/send → id, nebo echo z platformy). */
  alias(optId, platform, realId) {
    if (!optId || !platform || realId == null) return;
    const key = `${platform}:${realId}`;
    const sid = String(optId);
    this._opt = this._opt.filter((o) => o.optId !== sid);
    const prevKey = this._alias.get(sid);
    this._alias.set(sid, key);
    // Průběh se mezitím přiřadil přes optimistickou → přesunout pod skutečný klíč.
    const tmp = this._e.get(`${platform}:${sid}`) || (prevKey && prevKey !== key ? this._e.get(prevKey) : null);
    if (tmp && !this._e.has(key)) { this._e.delete(tmp.key); tmp.key = key; this._e.set(key, tmp); }
    if (this._alias.size > 200) this._alias.delete(this._alias.keys().next().value);
    this._L(`${sid} = ${key}`);
    this.onChange([key]);
  }

  /**
   * Vlastní rozpracovaný nebo čekající GIF (kolečko / „Schvalování moderátorem“)? Server pustí jen jednu žádost na
   * uživatele → výběr z knihovny se zatím nepošle (audit X1).
   */
  busy(now = this.now()) {
    for (const e of this._e.values()) {
      const v = this.view(e.platform, e.messageId, now);
      if (v && (v.kind === 'progress' || v.kind === 'sending' || v.kind === 'pending')) return true;
    }
    return false;
  }

  /**
   * Vlastní zpráva z historie (po reloadu panelu), kterou server smazal kvůli GIFu → štítek jako živě (audit A10):
   * gif_rejected = „Zamítnuto moderátorem“ (dotaz /gif/held ho upřesní na „Vypršelo“), gif_not_allowed = „Nové GIFy
   * teď nejdou“, gif_request = „Schvalování moderátorem“ (stav se hned doptá). Známý záznam se nemění.
   */
  adoptHistory(platform, messageId, reason) {
    const id = String(messageId ?? '');
    if (!platform || !id || /^sent-/.test(id)) return null;
    const key = `${platform}:${id}`;
    if (this._e.has(key)) return this._e.get(key);
    const state = reason === GIF_REJECTED_REASON ? 'rejected' : reason === 'gif_not_allowed' ? 'not_allowed' : isGifHeldReason(reason) ? 'pending' : null;
    if (!state) return null;
    const e = this._entry(key, platform, id);
    e.state = state;
    e.history = true;
    if (state === 'pending') { e.pendingAt = this.now(); e.nextCheck = this.now(); }
    else e.final = state !== 'rejected';   // rejected se ještě upřesní (vypršelo × zamítnuto)
    this._L(`${key} z historie (${reason}) → ${state}`);
    if (state === 'rejected' && this.api) this._queueRefine(e);
    else this._arm();
    return e;
  }

  /**
   * Upřesnění zamítnutých zpráv z historie sbírat a poslat jedním GET /gif/held (po dávkách HELD_BATCH klíčů, _check)
   * — historie jich vykreslí víc najednou, dotaz na každou zvlášť by narazil na rate limit.
   */
  _queueRefine(e) {
    (this._refineQ ||= []).push(e);
    if (this._refineQ.length > 1) return;
    Promise.resolve().then(() => {
      const list = this._refineQ || [];
      this._refineQ = [];
      const live = list.filter((x) => this._e.get(x.key) === x);
      if (live.length) void this._check(live, { refine: true });
    });
  }

  _entry(key, platform, messageId) {
    let e = this._e.get(key);
    if (!e) {
      e = { key, platform, messageId, state: 'progress', phase: 'detect', pct: 0, estimateMs: null, elapsedMs: 0, at: this.now(), floor: 0, warn: false, requestId: null, checks: 0, checking: false, nextCheck: null, expiresAt: null, pendingAt: null, final: false, fails: 0 };
      this._e.set(key, e);
      if (this._e.size > 200) this._e.delete(this._e.keys().next().value);
    }
    return e;
  }

  /** Neznámé id zprávy → spárovat s poslední vlastní optimistickou GIF zprávou téže platformy. */
  _pairOrphan(platform, messageId) {
    if (this.hasMessage(platform, messageId)) return;
    const now = this.now();
    for (let i = this._opt.length - 1; i >= 0; i--) {
      const o = this._opt[i];
      if (o.platform !== platform || now - o.at > GIF_OPTIMISTIC_PAIR_MS) continue;
      this._L(`${platform}:${messageId} bez zprávy → spárováno s ${o.optId}`);
      this.alias(o.optId, platform, messageId);
      return;
    }
  }

  /** SSE `gif-progress` (jen odesílateli). */
  onProgress(d) {
    const p = normalizeGifProgress(d);
    if (!p) { this._L('gif-progress ignorováno (chybná data)'); return null; }
    if (p.channel && !sameChannel(p.channel, this.channel())) return null;
    if (!this._e.has(p.key)) this._pairOrphan(p.platform, p.messageId);
    const e = this._entry(p.key, p.platform, p.messageId);
    // Rozhodnuto serverem (gif-decided, gif-message, /gif/held, gif-notice) → pozdní průběh ani `done` štítek
    // nevrátí (audit F8). Tiché optimistické kolečko (state none) skutečný průběh zase oživí.
    if (e.final) { this._L(`${p.key} ${p.phase} po rozhodnutí (${e.state}) → ignorováno`); return e; }
    if (e.state === 'none' && p.phase !== 'done') e.state = 'progress';
    // Pozdní průběh po čekání (pending → progress by štítek vrátil zpět) ignorovat.
    if (e.state !== 'progress' && p.phase !== 'done') return e;
    if (!e.ownLink && this._isOwnLink(p.key)) e.ownLink = true;
    if (DOWNLOAD_PHASES.has(p.phase)) e.dl = true;
    e.floor = gifProgressPct(e, this.now(), e.floor);
    e.optimistic = false;
    Object.assign(e, { phase: p.phase, pct: p.pct, estimateMs: p.estimateMs, elapsedMs: p.elapsedMs, at: this.now() });
    if (p.phase === 'done') {
      e.state = gifOutcomeState(p.outcome);
      e.outcome = p.outcome;
      e.final = ['approved', 'rejected', 'not_allowed'].includes(e.state);
      if (e.state === 'pending') e.pendingAt = e.pendingAt ?? this.now();
      this._L(`${p.key} hotovo → ${p.outcome}`);
    } else if (p.phase === 'unlock') {
      this._L(`${p.key} unlock (odhad ${p.estimateMs ?? '?'} ms, uplynulo ${p.elapsedMs} ms)`);
    } else {
      this._L(`${p.key} ${p.phase} ${p.pct} %`);
    }
    this._arm();
    this.onChange([p.key]);
    return e;
  }

  /** SSE `gif-notice` (jen odesílateli): approved_only = hláška + štítek, auto_rejected = „Zamítnuto moderátorem“. */
  onNotice(d) {
    if (!d || typeof d !== 'object') return null;
    if (d.channel && !sameChannel(d.channel, this.channel())) return null;
    const platform = String(d.platform || '');
    const messageId = d.messageId != null ? String(d.messageId) : '';
    const key = d.requestKey ? String(d.requestKey) : `${platform}:${messageId}`;
    if (!/^[a-z]+:.+/.test(key)) return null;
    if (!this._e.has(key)) this._pairOrphan(platform || key.split(':')[0], messageId || key.slice(key.indexOf(':') + 1));
    const e = this._entry(key, platform, messageId);
    if (d.kind === 'approved_only') e.state = 'not_allowed';
    else if (d.kind === 'auto_rejected') e.state = 'rejected';
    // Cooldown: odkaz zůstal běžnou zprávou → bez kolečka i štítku (test2 bod 4.1), hlášku ukáže hostitel.
    else if (d.kind === 'cooldown') { e.state = 'none'; e.optimistic = false; }
    else { this._L(`gif-notice ${d.kind} neznámý`); return e; }
    e.final = true;
    this._L(`${key} gif-notice ${d.kind}${d.reason ? ` (${d.reason})` : ''}`);
    this._arm();
    this.onChange([key]);
    try { this.onNoticeCb(d.kind, e, d); } catch { /* ignore */ }
    return e;
  }

  /** Vlastní `gif-pending` (own: true) → čeká na moda (+ ⚠ u dříve zamítnutého), requestId → klíč. */
  onOwnPending(d) {
    const req = d && d.requestId != null && d.media ? normalizeGifPending(d, { now: this.now(), offset: this.serverOffset() }) : null;
    if (!req || !req.own || !req.platform || !req.messageId) return null;
    if (!sameChannel(req.channel, this.channel())) return null;
    const key = `${req.platform}:${req.messageId}`;
    if (!this._e.has(key)) this._pairOrphan(req.platform, req.messageId);
    const e = this._entry(key, req.platform, req.messageId);
    if (e.final) { this._L(`${key} gif-pending po rozhodnutí (${e.state}) → ignorováno`); return e; }
    e.requestId = req.requestId;
    this._req.set(req.requestId, key);
    if (this._req.size > 200) this._req.delete(this._req.keys().next().value);
    if (e.state === 'progress' || e.state === 'none') e.state = 'pending';
    e.pendingAt = e.pendingAt ?? this.now();
    // Konec čekání (čas serveru) → po něm + rezerva se štítek usadí dotazem, když gif-decided nepřijde.
    e.expiresAt = Number.isFinite(req.expiresAt) ? req.expiresAt : null;
    e.warn = !!req.previouslyRejected;
    this._L(`${key} čeká na moda (žádost ${req.requestId})${e.warn ? ' ⚠ dříve zamítnutý' : ''}`);
    this._arm();
    this.onChange([key]);
    return e;
  }

  /** Vlastní `gif-decided` → schváleno (štítek pryč) / zamítnuto / vypršelo (natrvalo). */
  onDecided(d) {
    const x = normalizeGifDecided(d);
    if (!x || !sameChannel(x.channel, this.channel())) return null;
    const key = this._req.get(x.requestId);
    const e = key ? this._e.get(key) : null;
    if (!e) return null;
    e.state = x.status;
    e.final = true;
    this._L(`${key} rozhodnuto ${x.status}`);
    this.onChange([key]);
    return e;
  }

  /** `gif-message` s `gifOrigin` = můj klíč → schváleno (štítek pryč, GIF je na konci chatu). */
  onGifMessage(msg) {
    const key = msg?.gifOrigin ? String(msg.gifOrigin) : null;
    const e = key ? this._e.get(key) : null;
    if (!e) return null;
    e.state = 'approved';
    e.final = true;
    this._L(`${key} schválený GIF dorazil (${msg.id})`);
    this.onChange([key]);
    return e;
  }

  /** Štítek pro zprávu: { kind: progress|pending|rejected|expired|not_allowed|approved, pct?, text?, warn? } | null. */
  view(platform, id, now = this.now()) {
    const e = this.get(platform, id);
    if (!e || e.state === 'none') return null;
    // Kolečko jen z optimistické zprávy a ze serveru nic → po chvíli pryč (GIF nejde přes odměnu / bez účtu).
    if (e.state === 'progress' && e.optimistic && now - e.at > GIF_OPTIMISTIC_SILENT_MS) return null;
    if (e.state === 'progress') {
      // Náš odkaz: bez procent, dokud server nestahuje (u známého média nestahuje nikdy).
      if (e.ownLink && !e.dl) return { kind: 'sending', text: GIF_SENDING_TEXT };
      const pct = gifProgressPct(e, now, e.floor);
      return { kind: 'progress', pct, text: formatGifPct(pct) };
    }
    if (e.state === 'approved') return { kind: 'approved' };
    return { kind: e.state, text: GIF_STATUS_TEXT[e.state] || '', warn: e.state === 'pending' && e.warn };
  }

  /** Přepnutí kanálu / odhlášení. */
  clear() {
    this._e.clear(); this._alias.clear(); this._opt = []; this._req.clear(); this._refineQ = [];
    if (this._timer) { this._ci(this._timer); this._timer = null; }
  }

  /** Po znovupřipojení SSE (`/account/stream`): stav rozpracovaných a čekajících štítků hned dotazem (události mohly propadnout). */
  resync() {
    // Rozpracované, čekající a „Vypršelo“ bez odpovědi serveru (soft — strop bez dotazu / vyčerpané pokusy).
    const list = [...this._e.values()].filter((e) => !e.checking && !e.optimistic && !/^sent-/.test(e.messageId)
      && (e.state === 'progress' || e.state === 'pending' || (e.state === 'expired' && e.soft)));
    if (!list.length || !this.api) return 0;
    for (const e of list) { e.fails = 0; e.stalled = false; if (e.state === 'expired') { e.state = 'pending'; e.soft = false; } }
    this._L(`znovupřipojení → dotaz na ${list.length} štítků`);
    void this._check(list, { resync: true });
    return list.length;
  }

  /** Čekání na moda: kdy se zeptat (čas `expiresAt` je serverový; bez něj výchozí doba žádosti od začátku čekání). */
  _pendingDue(e) {
    if (e.nextCheck) return e.nextCheck;
    if (Number.isFinite(e.expiresAt)) return e.expiresAt + GIF_PENDING_GRACE_MS;
    return (e.pendingAt ?? e.at) + GIF_PENDING_DEFAULT_TTL_MS + GIF_PENDING_GRACE_MS;
  }

  /** „Vypršelo“ bez odpovědi serveru (soft): resync po znovupřipojení se na štítek zeptá znovu. */
  _giveUp(e, why, { soft = false } = {}) {
    e.state = 'expired';
    e.nextCheck = null;
    e.soft = soft;
    this._L(`${e.key} ${why} → Vypršelo`);
  }

  /** Dotaz selhal (síť, 5xx, 429 …) → zeptat se znovu s rostoucím odstupem; štítek beze změny (audit E1). */
  _retryLater(e) {
    const now = this.now();
    e.fails = (e.fails || 0) + 1;
    const wait = Math.min(GIF_HELD_BACKOFF_MAX_MS, GIF_HELD_RECHECK_MS * 2 ** Math.min(e.fails - 1, 10));
    if (e.fails >= GIF_HELD_MAX_FAILS) {
      // Dál se neptat (štítek zůstane, doptá se resync po znovupřipojení /account/stream).
      e.stalled = true;
      this._L(`${e.key} /gif/held selhalo ${e.fails}× → dál se neptám, štítek beze změny`);
      return;
    }
    if (e.state === 'progress') e.at = now - GIF_PROGRESS_MAX_SILENT_MS + wait;
    else e.nextCheck = now + wait;
    this._L(`${e.key} /gif/held selhalo (${e.fails}×) → znovu za ${Math.round(wait / 1000)} s`);
  }

  /**
   * Dotaz GET /gif/held na stav štítků `list` (skutečná id). Bez `api` / optimistická bez id → „Vypršelo“ (soft).
   * Chyba dotazu štítek nemění — jen se zeptá znovu později (_retryLater). Chybějící položka v odpovědi serveru
   * = server zprávu nezná → „Vypršelo“.
   * `resync`: po znovupřipojení — chybějící položka štítek nemění (usadí ho pak strop).
   * `refine`: zamítnutá zpráva z historie → server řekne, jestli zamítnuta, nebo propadla (adoptHistory).
   */
  async _check(list, { resync = false, refine = false } = {}) {
    const ask = [];
    const keys = [];
    for (const e of list) {
      if (this.api && !/^sent-/.test(e.messageId)) ask.push(e);
      else if (!resync && !refine) { this._giveUp(e, `${e.state === 'pending' ? 'čekání' : e.phase} bez rozhodnutí (bez dotazu)`, { soft: true }); keys.push(e.key); }
    }
    for (let i = 0; i < ask.length; i += HELD_BATCH) {
      const chunk = ask.slice(i, i + HELD_BATCH);
      for (const e of chunk) e.checking = true;
      let res = null, failed = false;
      const ids = chunk.map((e) => e.key).join(',');
      try { res = await this.api(`/gif/held?channel=${encodeURIComponent(String(this.channel() || '').toLowerCase())}&ids=${encodeURIComponent(ids)}`); }
      catch (err) { failed = true; this._L(`/gif/held selhalo (${err?.status || 0} ${err?.error || err?.message || err})`); }
      const got = new Map((Array.isArray(res?.messages) ? res.messages : []).map((r) => [`${r.platform}:${r.messageId}`, r]));
      for (const e of chunk) {
        e.checking = false;
        if (this._e.get(e.key) !== e) continue;                           // mezitím zahozeno
        if (refine) {
          const st = failed ? null : gifHeldOwnState(got.get(e.key));
          if (e.state === 'rejected' && !e.final && st === 'expired') { e.state = 'expired'; keys.push(e.key); }
          if (!failed) e.final = true;
          continue;
        }
        if (e.state !== 'progress' && e.state !== 'pending') continue;    // mezitím rozhodnuto událostí
        if (failed) { if (!resync) this._retryLater(e); continue; }
        e.fails = 0;
        const r = got.get(e.key);
        if (!r) { if (!resync) { this._giveUp(e, 'stav nezjištěn (server zprávu nezná)'); keys.push(e.key); } continue; }
        this._applyHeld(e, r);
        keys.push(e.key);
      }
    }
    this._arm();
    if (keys.length) this.onChange(keys);
  }

  /** Výsledek /gif/held → štítek (approved / replaced / deleted / rejected / expired); „čeká“ → zeptat se znovu. */
  _applyHeld(e, r) {
    const next = gifHeldOwnState(r);
    const now = this.now();
    if (next === 'pending' || next === 'progress') {
      if (++e.checks >= GIF_OWN_MAX_CHECKS) { this._giveUp(e, `pořád bez rozhodnutí po ${e.checks} dotazech`); return; }
      if (next === 'pending' && e.state === 'progress') { e.state = 'pending'; e.pendingAt = e.pendingAt ?? now; }
      // Průběh: strop znovu za GIF_HELD_RECHECK_MS; čekání: další dotaz za GIF_HELD_RECHECK_MS.
      if (e.state === 'progress') e.at = now - GIF_PROGRESS_MAX_SILENT_MS + GIF_HELD_RECHECK_MS;
      else e.nextCheck = now + GIF_HELD_RECHECK_MS;
      this._L(`${e.key} /gif/held → ${r.state}${r.status ? `/${r.status}` : ''} (čeká, znovu za ${GIF_HELD_RECHECK_MS / 1000} s)`);
      return;
    }
    e.state = next;
    e.nextCheck = null;
    e.final = next !== 'none';
    this._L(`${e.key} /gif/held → ${r.state}${r.status ? `/${r.status}` : ''} → ${next}`);
  }

  /**
   * Časovač: animace unlock + optimistického kolečka (překreslit) a strop pro vše rozpracované / čekající
   * (průběh bez události 60 s, čekání na moda po expiresAt) → dotaz na stav.
   */
  _arm() {
    const watched = (e) => !e.checking && !e.stalled && (e.state === 'progress' || e.state === 'pending');
    if (![...this._e.values()].some(watched)) { if (this._timer) { this._ci(this._timer); this._timer = null; } return; }
    if (this._timer) return;
    this._timer = this._si(() => {
      const now = this.now();
      const keys = [];
      const due = [];
      for (const e of this._e.values()) {
        if (e.checking || e.stalled) continue;
        if (e.state === 'progress') {
          if (e.optimistic) {
            if (now - e.at > GIF_OPTIMISTIC_SILENT_MS) { e.state = 'none'; e.optimistic = false; this._L(`${e.key} bez odezvy serveru → kolečko pryč`); }
            keys.push(e.key);
          } else if (now - e.at > GIF_PROGRESS_MAX_SILENT_MS) {
            this._L(`${e.key} ${e.phase} bez další události ${Math.round((now - e.at) / 1000)} s → dotaz na stav`);
            due.push(e);
          } else if (e.phase === 'unlock') keys.push(e.key);
        } else if (e.state === 'pending' && now >= this._pendingDue(e)) {
          this._L(`${e.key} čeká na moda i po konci žádosti → dotaz na stav`);
          due.push(e);
        }
      }
      if (keys.length) this.onChange(keys);
      if (due.length) void this._check(due);
      if (this._timer && ![...this._e.values()].some(watched)) { this._ci(this._timer); this._timer = null; }
    }, GIF_PROGRESS_TICK_MS);
  }
}

/** Zpráva patří přihlášenému účtu (identita `{ login }` na platformě zprávy)? Porovnává login bez „@“. */
export function isOwnGifMsg(msg, identity) {
  const norm = (s) => String(s ?? '').replace(/^@/, '').trim().toLowerCase();
  const me = norm(identity?.login);
  if (!me || !msg) return false;
  return norm(msg.username) === me || norm(msg.login) === me;
}

const HISTORY_REASONS = new Set([GIF_REJECTED_REASON, 'gif_not_allowed', 'gif_request']);

/**
 * Štítek vlastní GIF zprávy, kterou GifOutbox nezná (reload panelu, jiné zařízení): zpráva smazaná serverem kvůli
 * GIFu (gif_rejected / gif_not_allowed / gif_request) od přihlášeného účtu → záznam v outboxu (adoptHistory) a jeho
 * štítek; ostatním se dál ukazuje jako smazaná (audit A10). Jinak null.
 */
export function gifOwnHistoryView(outbox, msg, identity) {
  if (!outbox || !msg || !(msg._deleted || msg.deleted) || !HISTORY_REASONS.has(msg.deletedReason)) return null;
  if (msg.id == null || /^sent-/.test(String(msg.id)) || !isOwnGifMsg(msg, identity)) return null;
  const e = outbox.adoptHistory(msg.platform, msg.id, msg.deletedReason);
  return e ? outbox.view(msg.platform, String(msg.id)) : null;
}

const WARN_SVG ='<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M12 3 2 21h20L12 3Z" fill="#f5a524"/><path d="M12 10v5" stroke="#1a1a1d" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="18" r="1.3" fill="#1a1a1d"/></svg>';

/**
 * Štítek stavu vlastního GIFu ve zprávě (`.uc-gif-st`, za textem). `view` z GifOutbox.view; null / approved = pryč.
 * Vrací prvek štítku (nebo null).
 */
export function paintGifStatus(doc, msgEl, view) {
  if (!msgEl) return null;
  let st = msgEl.querySelector(':scope > .uc-gif-st');
  if (!view || view.kind === 'approved') { st?.remove(); msgEl.classList.remove('uc-gif-own'); return null; }
  msgEl.classList.add('uc-gif-own');
  if (!st) {
    st = doc.createElement('div');
    st.className = 'uc-gif-st';
    st.setAttribute('role', 'status');
    const tx = msgEl.querySelector(':scope > .tx');
    if (tx) tx.after(st); else msgEl.appendChild(st);
  }
  const kind = view.kind;
  if (st.dataset.kind !== kind) {
    st.dataset.kind = kind;
    st.className = `uc-gif-st uc-gif-st--${kind}`;
    if (kind === 'progress') {
      st.innerHTML = '<span class="uc-qd-ring uc-gif-st-ring"><i></i></span><span class="uc-gif-st-pct"></span>';
    } else if (kind === 'pending') {
      st.innerHTML = `<span class="uc-gif-st-txt"></span> <span class="uc-gif-st-wait" aria-hidden="true">(<i class="uc-gif-st-spin"></i>)</span><span class="uc-gif-st-warn" hidden title="${esc(GIF_PREV_REJECTED_TIP)}" data-tooltip="${esc(GIF_PREV_REJECTED_TIP)}">${WARN_SVG}</span>`;
    } else {
      st.innerHTML = '<span class="uc-gif-st-txt"></span>';
    }
  }
  if (kind === 'progress') {
    const p = clamp(Number(view.pct) || 0, 0, 100);
    st.querySelector('.uc-gif-st-ring i')?.style.setProperty('--deg', `${Math.round((1 - p / 100) * 36000) / 100}deg`);
    st.querySelector('.uc-gif-st-pct').textContent = view.text || formatGifPct(p);
    st.setAttribute('aria-label', `Stahování GIFu ${formatGifPct(p)}`);
  } else {
    st.querySelector('.uc-gif-st-txt').textContent = view.text || '';
    const w = st.querySelector('.uc-gif-st-warn');
    if (w) w.hidden = !view.warn;
    st.setAttribute('aria-label', `${view.text || ''}${view.warn ? ` (${GIF_PREV_REJECTED_TIP})` : ''}`);
  }
  return st;
}

// ---------------------------------------------------------------------------
// Token pro zamítnutá média (mod)
// ---------------------------------------------------------------------------

/**
 * Token moda pro `…/media/gif/<id>?t=<token>` (zamítnutá média). Drží se jen v paměti a v session úložišti
 * hostitele (addon chrome.storage.session, web sessionStorage) — nikdy v logu ani v localStorage.
 * get() = paměť → úložiště → POST /moderation/gif/access-token; refresh() po 401/403/404 média (nejvýš 1× za 10 s).
 */
export class GifAccessToken {
  constructor({ api, channel, store, log, now } = {}) {
    this.api = api;
    this.channel = channel || (() => '');
    this.store = store || null;
    this.log = log || (() => {});
    this.now = now || (() => Date.now());
    this._token = null;
    this._inflight = null;
    this._lastIssue = 0;
    // Epocha: clear() (odhlášení, jiný účet) zneplatní rozběhnuté vydání / načtení (audit F9).
    this._epoch = 0;
  }

  _L(t) { this.log('Gif', `token: ${t}`); }

  /** Propadlý (známá expirace minula). */
  _expired() { return Number.isFinite(this._exp) && this.now() >= this._exp; }
  /** Obnovit: den před koncem platnosti, nebo token ze sessionStorage bez známé expirace („obnovit brzy“). */
  _renewDue() { return !!this._token && (this._expUnknown || (Number.isFinite(this._exp) && this.now() >= this._exp - GIF_TOKEN_RENEW_MS)); }
  /** Nový token na pozadí; dosavadní platný zůstává v použití, dokud nový nepřijde. Jeden pokus na okno obnovy. */
  _renewInBackground() {
    if (this._inflight || !this._renewDue()) return this._inflight;
    this._expUnknown = false;
    this._L('token brzy vyprší / expirace neznámá → nový na pozadí');
    const p = this._issue(this._epoch).finally(() => { if (this._inflight === p) this._inflight = null; });
    this._inflight = p;
    return p;
  }

  /**
   * Token v paměti (bez čekání na síť), nebo null (i propadlý). V okně obnovy spustí vydání nového na pozadí.
   * Panel ani karta si ho nedrží — po odhlášení je hned pryč.
   */
  current() {
    if (!this._token) return null;
    if (this._expired()) { void this._renewInBackground(); return null; }
    if (this._renewDue()) void this._renewInBackground();
    return this._token;
  }

  async get() {
    // Token platí 30 dní (server posílá expiresAt + serverNow) → den před koncem nový na pozadí, platný se vrací dál.
    if (this._token && !this._expired()) {
      if (this._renewDue()) void this._renewInBackground();
      return this._token;
    }
    if (this._token) {
      // Propadlý → čekat na nový.
      this._L('token propadl → nový');
      this._token = null;
      this._exp = null;
      try { await this.store?.clear?.(); } catch { /* ignore */ }
    }
    if (this._inflight) return this._inflight;
    const ep = this._epoch;
    const p = (async () => {
      try {
        const saved = await this.store?.load?.();
        if (ep !== this._epoch) return null;
        if (saved && typeof saved === 'string') {
          // Session úložiště drží jen hodnotu → expirace neznámá → po prvním použití obnovit na pozadí.
          this._token = saved;
          this._exp = null;
          this._expUnknown = true;
          this._L('ze session úložiště (expirace neznámá)');
          return saved;
        }
      } catch { /* ignore */ }
      return this._issue(ep);
    })().finally(() => {
      if (this._inflight === p) this._inflight = null;
      if (ep === this._epoch && this._expUnknown) void this._renewInBackground();
    });
    this._inflight = p;
    return p;
  }

  async _issue(ep = this._epoch) {
    const ch = String(this.channel() || '').toLowerCase();
    this._lastIssue = this.now();
    try {
      const j = await this.api('/moderation/gif/access-token', { method: 'POST', body: ch ? { channel: ch } : {} });
      if (ep !== this._epoch) { this._L('odhlášení během vydání → token zahozen'); return null; }
      const t = typeof j?.token === 'string' && j.token ? j.token : null;
      if (!t) { this._L('odpověď bez tokenu'); return null; }
      this._token = t;
      const exp = j?.expiresAt != null ? gifLocalTime(j.expiresAt, { serverNow: j.serverNow ?? null, now: this.now() }) : NaN;
      this._exp = Number.isFinite(exp) ? exp : null;
      this._expUnknown = false;
      try { await this.store?.save?.(t); } catch { /* ignore */ }
      this._L('nový token vydán');
      return t;
    } catch (e) {
      this._L(`vydání FAIL ${e?.status || 0} ${e?.error || e?.message || e}`);
      return null;
    }
  }

  /**
   * Médium s tokenem vrátilo chybu → vyžádat nový (token mohl vypadnout jako nejstarší z 5, účet přestal být modem).
   * Souběžná volání sdílí jedno vydání; smyčku hlídá volající (záložka GIFy obnovuje jen jednou).
   */
  async refresh() {
    if (this._inflight) return this._inflight;
    this._token = null;
    const ep = this._epoch;
    try { await this.store?.clear?.(); } catch { /* ignore */ }
    if (ep !== this._epoch) return null;
    this._L('obnova po chybě média');
    if (this._inflight) return this._inflight;
    const p = this._issue(ep).finally(() => { if (this._inflight === p) this._inflight = null; });
    this._inflight = p;
    return p;
  }

  clear() { this._epoch++; this._token = null; this._exp = null; this._expUnknown = false; this._inflight = null; try { this.store?.clear?.(); } catch { /* ignore */ } }
}

// ---------------------------------------------------------------------------
// Odměna — indikátor (pásek) a hlavička GIF záložky
// ---------------------------------------------------------------------------

/**
 * Stav odměny z GifCooldown.snapshot() ({ allowed, until, sec, mode, rewardUntil, rewardTotalMs }) v čase `now`:
 * { mode: unknown|login|locked|active|cooldown, canSend, cooldownMs, remainingMs|null, progress|null, text, approvedOnly }.
 * `progress` (0–1, ubývá) jen když server pošle konec odměny (`rewardUntil`); bez něj pásek není.
 */
export const GIF_REWARD_LOCKED_TEXT = 'Odměna není aktivována';

export function gifRewardView(st, now, { loggedIn = true } = {}) {
  if (!loggedIn) return { mode: 'login', canSend: false, cooldownMs: 0, remainingMs: null, progress: null, approvedOnly: false, text: 'Přihlas se k UnityChatu, ať můžeš GIFy posílat.' };
  if (!st) return { mode: 'unknown', canSend: false, cooldownMs: 0, remainingMs: null, progress: null, approvedOnly: false, text: '' };
  const approvedOnly = st.mode === 'approved';
  // Mod / broadcaster bez výjimky: zámek, pásek i cooldown jako ostatní (spec 2026-09-27-gif-review-upravy §5).
  const rem = Number.isFinite(st.rewardUntil) ? st.rewardUntil - now : null;
  if (!st.allowed || (rem !== null && rem <= 0)) {
    // Stejná hláška jako soundboard (spec 2026-09-27 §2): jen první věta, v panelu se zámkem.
    return { mode: 'locked', canSend: false, cooldownMs: 0, remainingMs: null, progress: null, approvedOnly, text: GIF_REWARD_LOCKED_TEXT };
  }
  const cd = Number.isFinite(st.until) && st.until > now ? st.until - now : 0;
  const total = Number.isFinite(st.rewardTotalMs) && st.rewardTotalMs > 0 ? st.rewardTotalMs : null;
  const progress = rem !== null && total ? clamp(rem / total, 0, 1) : null;
  const text = cd > 0 ? `Další GIF můžeš poslat za ${formatRemaining(cd)}`
    : rem !== null ? `Odměna ještě ${formatRemaining(rem)}` : 'Odměna „Posílání GIFů“ je aktivní';
  return { mode: cd > 0 ? 'cooldown' : 'active', canSend: cd <= 0, cooldownMs: cd, remainingMs: rem, progress, approvedOnly, text };
}

/**
 * Vlastní tooltip (stejný jako u noty soundboardu, core/soundboard.js IconTip) nad ikonou emotů a boční záložkou GIFy
 * z gifRewardView: { mode, title, lines, rows: [{ name, remainingMs|null, progress|null }], cooldownMs }, nebo null
 * (stav neznámý → hostitel ukáže jen název). Mod i divák stejně (bez výjimky).
 */
export function gifRewardTip(v) {
  if (!v || v.mode === 'unknown') return null;
  const lines = v.approvedOnly && v.mode !== 'locked' && v.mode !== 'login' ? ['Teď jdou jen GIFy z knihovny.'] : [];
  if (v.mode === 'login') return { mode: 'locked', title: 'GIFy', lines: [v.text] };
  if (v.mode === 'locked') return { mode: 'locked', title: 'GIF odměna není aktivní', lines };
  const rows = [{ name: 'Posílání GIFů', remainingMs: v.remainingMs ?? null, progress: v.progress ?? null }];
  if (v.mode === 'cooldown') return { mode: 'cooldown', title: 'GIF odměna — cooldown', lines, rows, cooldownMs: v.cooldownMs };
  return { mode: 'active', title: 'GIF odměna aktivní', lines, rows, cooldownMs: 0 };
}

/** Okraj nabídky ⋯ od hrany panelu a od tlačítka (px). */
export const GIF_MENU_MARGIN = 4;
/** Nabídka ⋯ pod tlačítkem: posun od horní hrany dlaždice (tlačítko 22 px + 3 px odsazení + 2 px mezera). */
export const GIF_MENU_BELOW = 27;

/**
 * Poloha nabídky ⋯ dlaždice uvnitř panelu (čistá funkce nad obdélníky getBoundingClientRect):
 * vodorovně zarovnat k pravé hraně dlaždice, a když se tam nevejde, posunout tak, aby celá byla v `box`
 * (u levého okraje panelu tedy zarovnání vlevo); svisle pod ⋯, a když se dolů nevejde a nad dlaždici ano, nad ni.
 * Vrací { left, top } relativně k dlaždici (px) a `up`.
 */
export function gifMenuPlacement(tile, menu, box, { margin = GIF_MENU_MARGIN, below = GIF_MENU_BELOW } = {}) {
  const w = menu.width || 0, h = menu.height || 0;
  const minX = box.left + margin, maxX = box.right - margin - w;
  const x = Math.max(minX, Math.min(tile.right - 3 - w, maxX));
  const downTop = tile.top + below;
  const fitsDown = downTop + h <= box.bottom - margin;
  const upTop = tile.top - h - 2;
  const up = !fitsDown && upTop >= box.top + margin;
  return { left: x - tile.left, top: (up ? upTop : downTop) - tile.top, up };
}

// ---------------------------------------------------------------------------
// Knihovna — data
// ---------------------------------------------------------------------------

export const GIF_LIBRARY_PAGE = 50;
/** Načtení panelu po SSE gif-media se rozprostře náhodně do 0–2 s. */
export const MEDIA_REFETCH_SPREAD_MS = 2000;
/** Retence zamítnutých (server maže po 14 dnech, kromě vaultu). */
export const GIF_REJECTED_RETENTION_DAYS = 14;

/** Položka `/gifs/library` → { mediaId, url, kind, width, height, tags, useCount, lastUsedAt }, nebo null. */
export function normalizeLibraryItem(x, opts = {}) {
  if (!x || typeof x !== 'object' || !/^[0-9a-f]{32}$/.test(String(x.mediaId || ''))) return null;
  const m = normalizeGifMedia(x, opts);
  if (!m) return null;
  return {
    ...m,
    mediaId: String(x.mediaId),
    tags: (Array.isArray(x.tags) ? x.tags : []).map((t) => String(t)).filter(Boolean).slice(0, 20),
    useCount: Math.max(0, Number(x.useCount) || 0),
    lastUsedAt: Number(x.lastUsedAt) || null,
  };
}

/** Položka `/moderation/gif/rejected` → { …médium, rejectedAt, rejectedBy, vault, deleteAt }, nebo null. */
export function normalizeRejectedItem(x, opts = {}) {
  const base = normalizeLibraryItem({ ...x, tags: x?.tags || [] }, opts);
  if (!base) return null;
  return { ...base, rejectedAt: Number(x.rejectedAt) || null, rejectedBy: x.rejectedBy ? String(x.rejectedBy) : null, vault: x.vault === true, deleteAt: Number(x.deleteAt) || null };
}

/** Návrh duplikátu → { id, score, first, second } (média s `status`), nebo null. */
export function normalizeDuplicate(x, opts = {}) {
  if (!x || typeof x !== 'object' || x.id == null) return null;
  const med = (m) => {
    const b = normalizeLibraryItem(m, opts);
    return b ? { ...b, status: ['approved', 'rejected', 'pending'].includes(m.status) ? m.status : 'pending' } : null;
  };
  const first = med(x.first), second = med(x.second);
  if (!first || !second) return null;
  return { id: String(x.id), score: clamp(Number(x.score) || 0, 0, 1), first, second };
}

/** „1 den“ / „2 dny“ / „5 dní“ (tři tvary množného čísla). */
export function gifDaysText(n) {
  const a = Math.abs(Math.trunc(Number(n) || 0));
  if (a === 1) return '1 den';
  if (a >= 2 && a <= 4) return `${a} dny`;
  return `${a} dní`;
}

/** Odpočet smazání: „smaže se za 6 dní“ / „smaže se dnes“ (zbytek dne se počítá jako celý den). */
export function gifDeleteInText(at, now) {
  const days = Math.ceil((Number(at) - now) / 86_400_000);
  return days <= 0 ? 'smaže se dnes' : `smaže se za ${gifDaysText(days)}`;
}

/** „Zamítl modik (Twitch) · smaže se za 3 dny“ / „Vault — nesmaže se“. */
export function rejectedMetaText(item, now) {
  const by = item?.rejectedBy ? `Zamítl ${actorLabel(item.rejectedBy)}` : 'Zamítnuto';
  if (item?.vault) return `${by} · Vault — nesmaže se`;
  if (!item?.deleteAt) return by;
  return `${by} · ${gifDeleteInText(item.deleteAt, now)}`;
}

/**
 * Položka `/moderation/gif/withdrawn|purging` → { …médium, status: withdrawn|purging, purgedAt, purgedBy, purgeAt,
 * restoreTo: approved|rejected }, nebo null.
 */
export function normalizeDiscardedItem(x, opts = {}) {
  const base = normalizeLibraryItem({ ...x, tags: x?.tags || [] }, opts);
  if (!base || !['withdrawn', 'purging'].includes(x.status)) return null;
  return {
    ...base, status: x.status, purgedAt: Number(x.purgedAt) || null, purgedBy: x.purgedBy ? String(x.purgedBy) : null,
    purgeAt: Number(x.purgeAt) || null, restoreTo: x.restoreTo === 'approved' ? 'approved' : 'rejected',
  };
}

/** „Zahodil modik (Twitch) · zprávy zůstaly“ (stažený) / „Zahodil modik (Twitch) · smaže se za 6 dní“ (ke smazání). */
export function discardedMetaText(item, now) {
  const by = item?.purgedBy ? `Zahodil ${actorLabel(item.purgedBy)}` : 'Zahozeno';
  if (item?.status === 'withdrawn') return `${by} · zprávy zůstaly`;
  if (!item?.purgeAt) return by;
  return `${by} · ${gifDeleteInText(item.purgeAt, now)}`;
}

/** Rozměry a druh pro náhled: „498 × 280 px · GIF“ (bez rozměrů jen druh). */
export function gifDimText(item) {
  const kind = { gif: 'GIF', webp: 'WebP', mp4: 'MP4' }[item?.kind] || 'GIF';
  return item?.width && item?.height ? `${item.width} × ${item.height} px · ${kind}` : kind;
}

/** „Použito 1×“. */
const usedText = (n) => `Použito ${Math.max(0, Number(n) || 0)}×`;

/**
 * Řádek „kdo / kdy“ v náhledu podle sekce: knihovna (použití), zamítnuté (kdo, kdy, vault), duplikát (stav),
 * stažené / ke smazání (kdo zahodil, kdy, co dál).
 */
export function gifPreviewMeta(item, sec, now) {
  if (!item) return '';
  const when = (ms) => (gifShortDate(ms) ? ` · ${gifShortDate(ms)}` : '');
  switch (sec) {
    case 'rej': {
      const by = item.rejectedBy ? `Zamítl ${actorLabel(item.rejectedBy)}` : 'Zamítnuto';
      return `${by}${when(item.rejectedAt)}${item.vault ? ' · Vault' : ''}`;
    }
    case 'dup': return `${item.status === 'approved' ? 'V knihovně' : item.status === 'rejected' ? 'Zamítnutý' : 'Čeká na schválení'} · ${usedText(item.useCount).toLowerCase()}`;
    case 'wd': case 'pg': {
      const by = item.purgedBy ? `Zahodil ${actorLabel(item.purgedBy)}` : 'Zahozeno';
      return `${by}${when(item.purgedAt)} · ${item.status === 'withdrawn' ? 'zprávy zůstaly' : gifDeleteInText(item.purgeAt, now)}`;
    }
    default: return usedText(item.useCount);
  }
}

/** Texty potvrzovacích dialogů (Trvale zahodit / Odstranit ze serveru). */
export const GIF_CONFIRM_TEXT = {
  purge: {
    title: 'Trvale zahodit GIF?',
    lines: [
      'Zahodit, zprávy nechat: GIF zmizí z knihovny i ze zamítnutých, staré zprávy ho dál ukazují. Nový odkaz na něj se do chatu nepustí.',
      'Zahodit i se zprávami: zprávy s GIFem se hned schovají a za 7 dní se GIF smaže ze serveru. Do té doby ho jde obnovit v Zamítnutých (Ke smazání).',
    ],
  },
  'remove-file': {
    title: 'Odstranit GIF ze serveru?',
    lines: ['Staré zprávy ukážou [GIF nedostupný]. Nejde vrátit.'],
  },
};

/** Chyba akce knihovny → česky. */
export function gifLibraryErrorText(e) {
  switch (e?.error) {
    case 'already_decided': return 'O návrhu už rozhodl jiný mod.';
    case 'gone': return 'GIF mezitím zmizel.';
    case 'not_found': return 'GIF už neexistuje.';
    case 'not_mod': return 'Tohle můžou jen modi.';
    case 'not_rejected': return 'GIF už není mezi zamítnutými.';
    case 'not_approved': return 'GIF už není v knihovně.';
    case 'already_purged': return 'GIF už je zahozený.';
    case 'not_purging': return 'GIF už není ke smazání.';
    case 'not_withdrawn': return 'GIF už není mezi staženými.';
    case 'rate_limited': return 'Moc rychle za sebou, chvíli počkej.';
    case 'not_ready': return 'Knihovna ještě není připravená, zkus to později.';
    default: return e?.status === 401 ? 'Přihlášení vypršelo, přihlas se znovu.' : 'Akce se nepovedla, zkus to znovu.';
  }
}

// ---------------------------------------------------------------------------
// Knihovna — záložka „GIFy“ v panelu emotů
// ---------------------------------------------------------------------------

const EYE_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A9.8 9.8 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
export const GIF_TAB_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10.5 10H8.8c-.8 0-1.3.6-1.3 2s.5 2 1.3 2h1.2v-1.6H9M13 10v4M15.5 14v-4h2.2M15.5 12h1.8" stroke-linecap="round"/></svg>';
const LIB_THUMB_W = 140;
const LIB_THUMB_H = 96;

/**
 * Obsah záložky „GIFy“ (mount do panelu emotů). Divák bez odměny knihovnu vidí, poslat nemůže (hláška).
 * Každá dlaždice má nabídku ⋯ s „Náhled“ (i divák v knihovně); náhled = překryv nad panelem (větší GIF, rozměry,
 * tagy, u zamítnutých kdo / kdy; zavření ×, klik mimo, Esc). V knihovně klik posílá GIF, v Zamítnutých a
 * duplikátech otevře náhled.
 * Mod / streamer: nahoře taby GIFy | Zamítnuté GIFy, v GIFech sekce „Možné duplikáty (N)“ a v nabídce GIFu
 * Odebrat z knihovny / Trvale zahodit… Zamítnuté: Schválit / Vault / Trvale zahodit, pod nimi sekce „Stažené GIFy“
 * (Odstranit ze serveru s potvrzením) a „Ke smazání“ (odpočet, Obnovit). „Trvale zahodit“ = dialog se dvěma
 * variantami (zprávy nechat / i se zprávami, spec 2026-09-27-gif-nahled-zahozeni-design.md).
 *
 * @param {object} o
 * @param {HTMLElement} o.pane                     kontejner záložky
 * @param {(path: string, opts?: object) => Promise<any>} o.api
 * @param {() => string} o.channel
 * @param {() => boolean} [o.canModerate]
 * @param {() => object} [o.reward]               gifRewardView(…) — smí poslat? text hlavičky, pásek
 * @param {() => void} [o.refreshReward]           znovu se zeptat na stav odměny (GET /gif/state)
 * @param {(url: string, item: object) => void} o.onPick   poslat odkaz do chatu
 * @param {(v: { progress: number|null, title?: string, tip?: object|null }|null) => void} [o.onIndicator]  pásek na záložce a tlačítku + stav tooltipu (gifRewardTip)
 * @param {GifAccessToken} [o.tokens]
 * @param {string[]} [o.origins]
 * @param {(tag: string, text: string) => void} [o.log]
 * @param {() => number} [o.now]
 * @param {() => boolean} [o.ownPending]          vlastní GIF ještě čeká / převádí se (GifOutbox.busy) → výběr blokovat
 * @param {() => boolean} [o.isBroadcaster]       streamer (vlastní kanál) → Zamítnuté / Stažené / Ke smazání rozmazané, oko zaostří
 */
export function createGifPanel({ pane, api, channel, canModerate, reward, refreshReward, onPick, onIndicator, tokens, origins = null, log, now, ownPending, isBroadcaster } = {}) {
  const doc = pane.ownerDocument;
  const win = doc.defaultView || globalThis;
  const L = (t) => log?.('Gif', `knihovna: ${t}`);
  const clock = now || (() => Date.now());
  const isMod = () => !!canModerate?.();
  // Streamer nechce mít zamítnuté GIFy (často nevhodné) ostře na obrazovce streamu — test2 bod 2.
  const isStreamer = () => { try { return !!isBroadcaster?.(); } catch { return false; } };
  const rv = () => reward?.() || gifRewardView(null, clock());
  const opts = { origins };
  const st = {
    tab: 'lib', q: '', items: [], cursor: null, loaded: false, loading: false, error: '', channel: '',
    rej: [], rejBefore: null, rejLoaded: false, rejLoading: false, rejError: '',
    // Zahozené: wd = Stažené GIFy (withdrawn), pg = Ke smazání (purging).
    wd: [], wdBefore: null, pg: [], pgBefore: null, discLoaded: false, discLoading: false, discError: '',
    dups: [], dupsLoaded: false, tokenRetried: false, visible: false, flash: false,
    // menu = klíč dlaždice `<sekce>:<mediaId>` (stejné médium může být v knihovně i v duplikátech);
    // confirm = { kind: purge|remove-file, mediaId, from }; preview = { sec, id }.
    menu: null, confirm: null, preview: null, msg: '',
    // Dlaždice / řádky duplikátů s rozběhnutou akcí (klíč dlaždice) → tlačítka vypnutá, po odpovědi zase zapnutá.
    busy: new Set(),
    // Streamer: zaostřené dlaždice (klíč `<sekce>:<mediaId>`), ostatní rozmazané.
    sharp: new Set(),
  };
  // Token moda vždy z GifAccessToken (po odhlášení je pryč, panel si ho nedrží — audit F9).
  const tok = () => tokens?.current?.() ?? null;

  pane.classList.add('uc-gl');
  pane.innerHTML = `
    <div class="uc-gl-tabs" role="tablist" hidden>
      <button type="button" class="uc-gl-tab on" data-gl-tab="lib" role="tab">GIFy</button>
      <button type="button" class="uc-gl-tab" data-gl-tab="rej" role="tab">Zamítnuté GIFy</button>
    </div>
    <div class="uc-gl-reward" role="status"></div>
    <div class="uc-gl-search"><input type="search" placeholder="Hledat GIF podle tagů…" autocomplete="off" spellcheck="false" aria-label="Hledat GIF"></div>
    <div class="uc-gl-msg" role="alert" hidden></div>
    <div class="uc-gl-body"></div>
    <div class="uc-gl-preview" role="dialog" aria-modal="true" aria-label="Náhled GIFu" hidden></div>
    <div class="uc-gl-confirm" role="alertdialog" hidden></div>`;
  const tabsEl = pane.querySelector('.uc-gl-tabs');
  // Posuvný výběr tabů GIFy | Zamítnuté GIFy (sdílený helper jako boční záložky a ikony v poli, spec 2026-09-27 §1).
  const tabSlide = createSlideIndicator({ container: tabsEl, getActive: () => tabsEl.querySelector('.uc-gl-tab.on') });
  const rewardEl = pane.querySelector('.uc-gl-reward');
  const search = pane.querySelector('.uc-gl-search input');
  const searchWrap = pane.querySelector('.uc-gl-search');
  const msgEl = pane.querySelector('.uc-gl-msg');
  const body = pane.querySelector('.uc-gl-body');
  const confirmEl = pane.querySelector('.uc-gl-confirm');
  const previewEl = pane.querySelector('.uc-gl-preview');

  const ch = () => String(channel?.() || '').toLowerCase();

  function showMsg(text) {
    st.msg = text || '';
    msgEl.textContent = st.msg;
    msgEl.hidden = !st.msg;
    if (st.msg) win.setTimeout(() => { if (st.msg === text) showMsg(''); }, 4000);
  }

  // ---- hlavička (odměna) + pásek ----
  function paintReward() {
    const v = rv();
    rewardEl.className = `uc-gl-reward uc-gl-reward--${v.mode}${st.flash ? ' uc-gl-reward--flash' : ''}`;
    const txt = st.tab === 'rej' ? 'Zamítnuté GIFy se po 14 dnech mažou (kromě vaultu).' : [v.text, v.approvedOnly && v.mode !== 'locked' ? 'Teď jdou jen GIFy z knihovny.' : ''].filter(Boolean).join(' ');
    // Zamčeno: ikona zámku jako soundboard (klik na GIF ji zatřese — shakeLock). Kostra se přestaví jen při změně,
    // jinak by tik (1 s) zámek během zatřesení nahradil novým prvkem.
    const lock = st.tab !== 'rej' && v.mode === 'locked';
    const bar = v.progress !== null && st.tab === 'lib';
    const sig = `${lock}|${bar}`;
    if (rewardEl._ucSig !== sig) {
      rewardEl._ucSig = sig;
      rewardEl.innerHTML = `${lock ? `<span class="uc-lock">${LOCK_ICON_SVG}</span>` : ''}<span class="uc-gl-reward-t"></span>${bar ? '<i class="uc-gl-reward-bar"></i>' : ''}`;
    }
    rewardEl.querySelector('.uc-gl-reward-bar')?.style.setProperty('--p', v.progress?.toFixed(4) ?? '1');
    rewardEl.querySelector('.uc-gl-reward-t').textContent = txt;
    rewardEl.hidden = !txt;
    pane.classList.toggle('uc-gl--locked', !v.canSend);
    // Pásek (jen se známým koncem odměny) + stav pro vlastní tooltip ikony emotů a záložky (test2 body 1 a 3).
    onIndicator?.({ progress: v.progress, title: v.text, tip: gifRewardTip(v) });
  }

  // ---- data ----
  /** Další stránka bez duplicit (Set id, audit F14). */
  const mergePage = (list, more) => { const seen = new Set(list.map((x) => x.mediaId)); return [...list, ...more.filter((x) => !seen.has(x.mediaId))]; };
  // Pořadová čísla dotazů: platí jen výsledek posledního (hledání / přepnutí kanálu během načítání se nezahodí).
  let libSeq = 0, rejSeq = 0;
  const libKey = () => `${ch()}|${st.q.trim().toLowerCase()}`;

  async function loadLibrary({ more = false } = {}) {
    // Další stránka jen nad hotovým seznamem; nový dotaz (hledání, kanál) vždy — starší výsledek se zahodí.
    if (more && (st.loading || !st.cursor)) return;
    const c = ch();
    if (!c) return;
    const seq = ++libSeq;
    const key = libKey();
    st.loading = true;
    st.error = '';
    if (!more) paintBody();
    const q = st.q.trim().toLowerCase();
    const qs = `channel=${encodeURIComponent(c)}${q ? `&q=${encodeURIComponent(q)}` : ''}${more && st.cursor ? `&cursor=${encodeURIComponent(st.cursor)}` : ''}&limit=${GIF_LIBRARY_PAGE}`;
    try {
      const j = await api(`/gifs/library?${qs}`);
      if (seq !== libSeq) { L(`knihovna: zahozen starší výsledek (${key})`); return; }
      if (key !== libKey()) return;   // mezitím jiný kanál / hledání bez nového dotazu → finally načte znovu
      const items = (Array.isArray(j?.items) ? j.items : []).map((x) => normalizeLibraryItem(x, opts)).filter(Boolean);
      st.items = more ? mergePage(st.items, items) : items;
      st.cursor = j?.nextCursor || null;
      st.loaded = true;
      st.channel = c;
      L(`${c}${q ? ` „${q}“` : ''}: ${items.length} GIFů${more ? ' (další stránka)' : ''}${st.cursor ? ', další stránka existuje' : ''}`);
    } catch (e) {
      if (seq !== libSeq) return;
      st.error = e?.error === 'not_ready' ? gifLibraryErrorText(e) : 'GIFy se nepodařilo načíst.';
      L(`načtení FAIL ${e?.status || 0} ${e?.error || e?.message || e}`);
    } finally {
      if (seq === libSeq) {
        st.loading = false;
        // Kanál / hledání se změnily, ale nikdo nový dotaz nespustil → načíst znovu (panel otevřený).
        if (key !== libKey() && st.visible) { L(`knihovna: dotaz se změnil (${key} → ${libKey()}) → znovu`); void loadLibrary(); }
        else paintBody();
      }
    }
  }

  async function loadDuplicates() {
    if (!isMod()) { st.dups = []; st.dupsLoaded = false; return; }
    const c = ch();
    try {
      const j = await api(`/moderation/gif/duplicates?channel=${encodeURIComponent(c)}`);
      if (c !== ch()) return;
      st.dups = (Array.isArray(j?.items) ? j.items : []).map((x) => normalizeDuplicate(x, opts)).filter(Boolean);
      st.dupsLoaded = true;
      L(`duplikáty ${c}: ${st.dups.length}`);
      if (st.dups.some((d) => d.first.status === 'rejected' || d.second.status === 'rejected')) await ensureToken();
    } catch (e) {
      L(`duplikáty FAIL ${e?.status || 0} ${e?.error || e?.message || e}`);
      st.dups = [];
    }
    paintBody();
  }

  async function loadRejected({ more = false } = {}) {
    if (!isMod() || (more && (st.rejLoading || !st.rejBefore))) return;
    const c = ch();
    const seq = ++rejSeq;
    st.rejLoading = true;
    st.rejError = '';
    if (!more) paintBody();
    try {
      await ensureToken();
      const j = await api(`/moderation/gif/rejected?channel=${encodeURIComponent(c)}${more && st.rejBefore ? `&before=${encodeURIComponent(st.rejBefore)}` : ''}`);
      if (seq !== rejSeq || c !== ch()) return;
      const items = (Array.isArray(j?.items) ? j.items : []).map((x) => normalizeRejectedItem(x, opts)).filter(Boolean);
      st.rej = more ? [...st.rej, ...items] : items;
      st.rejBefore = j?.nextBefore || null;
      st.rejLoaded = true;
      L(`zamítnuté ${c}: ${items.length}${more ? ' (další stránka)' : ''}`);
    } catch (e) {
      if (seq !== rejSeq) return;
      st.rejError = gifLibraryErrorText(e);
      L(`zamítnuté FAIL ${e?.status || 0} ${e?.error || e?.message || e}`);
    } finally {
      if (seq === rejSeq) {
        st.rejLoading = false;
        if (c !== ch() && st.visible && st.tab === 'rej') void loadRejected(); else paintBody();
      }
    }
  }

  /**
   * Zahozené GIFy kanálu (Stažené = withdrawn, Ke smazání = purging) do záložky Zamítnuté. `which` = jen jedna sekce
   * (další stránka), jinak obě. Ke smazání se ukazuje s tokenem (purging jen s tokenem).
   */
  let discSeq = 0;
  async function loadDiscarded({ which = null, more = false } = {}) {
    // Nové načtení (po akci, přepnutí záložky) vždy — platí výsledek posledního; další stránka jen nad hotovým.
    if (!isMod() || (more && st.discLoading)) return;
    const c = ch();
    const seq = ++discSeq;
    st.discLoading = true;
    const kinds = which ? [which] : ['withdrawn', 'purging'];
    const key = (k) => (k === 'withdrawn' ? 'wd' : 'pg');
    try {
      await ensureToken();
      const res = await Promise.all(kinds.map((k) => {
        const before = more ? st[`${key(k)}Before`] : null;
        return api(`/moderation/gif/${k}?channel=${encodeURIComponent(c)}${before ? `&before=${encodeURIComponent(before)}` : ''}`)
          .then((j) => ({ k, j }), (e) => ({ k, e }));
      }));
      if (seq !== discSeq || c !== ch()) return;
      let failed = 0;
      for (const { k, j, e } of res) {
        if (e) { failed++; L(`${k} FAIL ${e?.status || 0} ${e?.error || e?.message || e}`); continue; }
        const items = (Array.isArray(j?.items) ? j.items : []).map((x) => normalizeDiscardedItem(x, opts)).filter(Boolean);
        st[key(k)] = more ? mergePage(st[key(k)], items) : items;
        st[`${key(k)}Before`] = j?.nextBefore || null;
        L(`${k === 'withdrawn' ? 'stažené' : 'ke smazání'} ${c}: ${items.length}${more ? ' (další stránka)' : ''}`);
      }
      // Selhání není neviditelné (audit E2): hláška + „Zkusit znovu“ pod zamítnutými.
      st.discError = failed ? 'Stažené GIFy a GIFy ke smazání se nepodařilo načíst.' : '';
      if (!which && !failed) st.discLoaded = true;
    } catch (e) {
      if (seq === discSeq) { st.discError = 'Stažené GIFy a GIFy ke smazání se nepodařilo načíst.'; L(`zahozené FAIL ${e?.status || 0} ${e?.error || e?.message || e}`); }
    } finally {
      if (seq === discSeq) { st.discLoading = false; paintBody(); }
    }
  }

  async function ensureToken() {
    if (!tokens) return null;
    return tok() || tokens.get();
  }

  /** Náhled zamítnutého média s tokenem vrátil chybu → jednou nový token a znovu vykreslit. */
  function onTokenMediaError() {
    // Nejvýš jedna obnova za 30 s (médium může být opravdu pryč → bez smyčky obnov).
    if (!tokens || st.tokenRetried || clock() - (st.tokenAt || 0) < 30_000) return false;
    st.tokenRetried = true;
    L('náhled zamítnutého se nenačetl → nový token');
    // Po úspěšné obnově zase povolit další obnovu (token může vypadnout znovu); neúspěch = dál nezkoušet.
    tokens.refresh().then((t) => { if (t) { st.tokenRetried = false; st.tokenAt = clock(); } paintBody(); });
    return true;
  }

  // ---- vykreslení ----
  /**
   * Dlaždice se při překreslení znovu používají (klíč dlaždice + podpis dat): média se nenačítají znovu, videa
   * nerestartují a scroll nebliká (audit F2). Dlaždice, které v novém stavu nejsou, se uklidí i ze sdíleného
   * IntersectionObserveru (audit F11).
   */
  const tileCache = new Map();   // klíč → { el, sig }
  let tileUsed = null;           // klíče použité v právě běžícím paintBody
  // Generace tokenu: jiný token = dlaždice s tokenem znovu (URL média se liší), hodnota tokenu se nikam neukládá.
  let tokGen = 0, tokLast = null;
  const tokSig = () => { const t = tok(); if (t !== tokLast) { tokLast = t; tokGen++; } return tokGen; };
  function cachedTile(key, sig, build) {
    tileUsed?.add(key);
    const hit = tileCache.get(key);
    if (hit && hit.sig === sig) return hit.el;
    if (hit) removeGifMedia(hit.el);
    const el = build();
    tileCache.set(key, { el, sig });
    return el;
  }
  function sweepTiles() {
    for (const [k, v] of tileCache) if (!tileUsed?.has(k)) { removeGifMedia(v.el); tileCache.delete(k); }
    tileUsed = null;
  }

  function thumb(item, { withToken = false } = {}) {
    const w = createGifMedia(doc, item, { lazy: true, log, maxW: LIB_THUMB_W, maxH: LIB_THUMB_H, token: withToken ? tok() : null, onError: withToken ? onTokenMediaError : null });
    w.classList.add('uc-gl-media');
    return w;
  }

  function libItem(item) {
    return cachedTile(`lib:${item.mediaId}`, `${isMod() ? 1 : 0}|${item.tags.join(',')}`, () => buildLibItem(item));
  }
  function buildLibItem(item) {
    const el = doc.createElement('div');
    el.className = 'uc-gl-i';
    el.dataset.id = item.mediaId;
    const pick = doc.createElement('button');
    pick.type = 'button';
    pick.className = 'uc-gl-pick';
    pick.dataset.act = 'pick';
    pick.title = item.tags.length ? item.tags.join(', ') : 'GIF';
    pick.setAttribute('aria-label', `Poslat GIF${item.tags.length ? `: ${item.tags.slice(0, 3).join(', ')}` : ''}`);
    pick.appendChild(thumb(item));
    el.appendChild(pick);
    // Nabídka ⋯ pro všechny (Náhled), mod navíc Odebrat z knihovny / Trvale zahodit.
    tileMenu(el, 'lib', item.mediaId, isMod() ? [['unapprove', 'Odebrat z knihovny'], ['purge-ask', 'Trvale zahodit…', true]] : []);
    return el;
  }

  /** Dlaždice sekce `sec` (lib | rej | dup | wd | pg) — klíč nabídky a náhledu. */
  function tileKey(el, sec, mediaId, extra = '') {
    el.dataset.id = mediaId;
    el.dataset.sec = sec;
    el.dataset.mkey = `${sec}:${extra ? `${extra}:` : ''}${mediaId}`;
    return el.dataset.mkey;
  }

  /** Tlačítko ⋯ + nabídka (první položka vždy „Náhled“). `items` = [[act, text, danger?]]. */
  function tileMenu(el, sec, mediaId, items = [], extra = '') {
    const key = tileKey(el, sec, mediaId, extra);
    const btns = [['preview', 'Náhled'], ...items].map(([act, text, danger]) => `<button type="button" role="menuitem"${danger ? ' class="uc-gl-danger"' : ''} data-act="${act}">${esc(text)}</button>`).join('');
    el.insertAdjacentHTML('beforeend', `<button type="button" class="uc-gl-more" data-act="menu" aria-label="Akce s GIFem" aria-haspopup="menu" title="Akce">⋯</button>
      <div class="uc-gl-menu" role="menu"${st.menu === key ? '' : ' hidden'}>${btns}</div>`);
  }

  /**
   * Streamer: dlaždice sekce Zamítnuté / Stažené / Ke smazání rozmazaná, oko v rohu ji zaostří a znovu rozmaže
   * (stav drží st.sharp i přes překreslení). Mod (ne streamer) je vidí ostře.
   */
  function blurTile(el, sec, mediaId) {
    if (!isStreamer()) return;
    const sharp = st.sharp.has(`${sec}:${mediaId}`);
    el.classList.add('uc-gl-i--blurable');
    el.classList.toggle('uc-gl-i--blur', !sharp);
    const eye = doc.createElement('button');
    eye.type = 'button';
    eye.className = 'uc-gl-eye';
    eye.dataset.act = 'eye';
    paintEye(eye, sharp);
    el.appendChild(eye);
  }
  function paintEye(eye, sharp) {
    eye.innerHTML = sharp ? EYE_OFF_SVG : EYE_SVG;
    eye.setAttribute('aria-pressed', String(sharp));
    // Bez nativního title (review M3) — popis jen v aria-label.
    eye.setAttribute('aria-label', sharp ? 'Rozmazat GIF' : 'Zobrazit GIF');
  }
  function toggleEye(tile) {
    const key = `${tile.dataset.sec}:${tile.dataset.id}`;
    const sharp = !st.sharp.has(key);
    if (sharp) st.sharp.add(key); else st.sharp.delete(key);
    tile.classList.toggle('uc-gl-i--blur', !sharp);
    const eye = tile.querySelector(':scope > .uc-gl-eye');
    if (eye) paintEye(eye, sharp);
    L(`${key} ${sharp ? 'zaostřen' : 'rozmazán'} (streamer)`);
  }

  /** Náhled dlaždice (Zamítnuté, duplikáty, zahozené): klik otevře náhled. */
  function previewBox(item, withToken) {
    const box = doc.createElement('button');
    box.type = 'button';
    box.className = 'uc-gl-pick uc-gl-pick--preview';
    box.dataset.act = 'preview';
    box.title = 'Náhled';
    box.setAttribute('aria-label', `Náhled GIFu${item.tags?.length ? `: ${item.tags.slice(0, 3).join(', ')}` : ''}`);
    box.appendChild(thumb(item, { withToken }));
    return box;
  }

  function rejItem(item) {
    return cachedTile(`rej:${item.mediaId}`, `${tokSig()}|${item.vault ? 1 : 0}|${rejectedMetaText(item, clock())}|${isStreamer() ? 1 : 0}`, () => buildRejItem(item));
  }
  function buildRejItem(item) {
    const el = doc.createElement('div');
    el.className = `uc-gl-i uc-gl-i--rej${item.vault ? ' uc-gl-i--vault' : ''}`;
    el.appendChild(previewBox(item, true));
    tileMenu(el, 'rej', item.mediaId);
    blurTile(el, 'rej', item.mediaId);
    const meta = doc.createElement('div');
    meta.className = 'uc-gl-meta';
    meta.textContent = rejectedMetaText(item, clock());
    el.appendChild(meta);
    el.insertAdjacentHTML('beforeend', `<div class="uc-gl-acts">
      <button type="button" class="uc-gif-btn uc-gif-btn--approve" data-act="approve">Schválit</button>
      <button type="button" class="uc-gif-btn" data-act="vault"${item.vault ? ' disabled data-off="1"' : ''}>${item.vault ? 'Ve vaultu' : 'Vault'}</button>
      <button type="button" class="uc-gif-btn uc-gif-btn--reject" data-act="purge-ask">Trvale zahodit</button>
    </div>`);
    return el;
  }

  /** Stažený GIF (withdrawn): Odstranit ze serveru. Ke smazání (purging): odpočet + Obnovit (náhled s tokenem). */
  function discItem(item) {
    const wd = item.status === 'withdrawn';
    return cachedTile(`${wd ? 'wd' : 'pg'}:${item.mediaId}`, `${wd ? 0 : tokSig()}|${item.restoreTo}|${discardedMetaText(item, clock())}|${isStreamer() ? 1 : 0}`, () => buildDiscItem(item));
  }
  function buildDiscItem(item) {
    const wd = item.status === 'withdrawn';
    const el = doc.createElement('div');
    el.className = `uc-gl-i uc-gl-i--${item.status}`;
    el.appendChild(previewBox(item, !wd));
    tileMenu(el, wd ? 'wd' : 'pg', item.mediaId);
    blurTile(el, wd ? 'wd' : 'pg', item.mediaId);
    const meta = doc.createElement('div');
    meta.className = 'uc-gl-meta';
    meta.textContent = discardedMetaText(item, clock());
    el.appendChild(meta);
    el.insertAdjacentHTML('beforeend', wd
      ? '<div class="uc-gl-acts"><button type="button" class="uc-gif-btn uc-gif-btn--reject" data-act="remove-ask">Odstranit ze serveru</button></div>'
      : `<div class="uc-gl-acts"><button type="button" class="uc-gif-btn uc-gif-btn--approve" data-act="restore" title="${esc(item.restoreTo === 'approved' ? 'Vrátit do knihovny' : 'Vrátit mezi zamítnuté')}">Obnovit</button></div>`);
    return el;
  }

  /** Sekce záložky Zamítnuté: nadpis + mřížka + „Načíst další“. */
  function section(title, items, render, moreAct, cls) {
    const h = doc.createElement('div');
    h.className = 'uc-gl-h';
    h.textContent = title;
    body.appendChild(h);
    const grid = doc.createElement('div');
    grid.className = `uc-gl-grid ${cls}`;
    for (const it of items) grid.appendChild(render(it));
    body.appendChild(grid);
    if (moreAct) body.insertAdjacentHTML('beforeend', `<button type="button" class="uc-gl-moreload" data-act="${moreAct}">Načíst další</button>`);
  }

  function dupSection() {
    if (!isMod() || !st.dups.length) return null;
    const sec = doc.createElement('div');
    sec.className = 'uc-gl-dups';
    const h = doc.createElement('div');
    h.className = 'uc-gl-h';
    h.textContent = `Možné duplikáty (${st.dups.length})`;
    sec.appendChild(h);
    for (const d of st.dups) {
      const sig = `${[d.first, d.second].some((m) => m.status === 'rejected') ? tokSig() : 0}|${d.score}|${[d.first, d.second].map((m) => `${m.mediaId}:${m.status}:${m.useCount}`).join('|')}`;
      sec.appendChild(cachedTile(`duprow:${d.id}`, sig, () => dupRow(d)));
    }
    return sec;
  }

  function dupRow(d) {
    const row = doc.createElement('div');
    row.className = 'uc-gl-dup';
    row.dataset.dup = d.id;
    const pair = doc.createElement('div');
    pair.className = 'uc-gl-pair';
    for (const [lbl, m] of [['První', d.first], ['Druhý', d.second]]) {
      const c = doc.createElement('div');
      c.className = `uc-gl-pair-i uc-gl-pair-i--${m.status}`;
      c.appendChild(previewBox(m, m.status === 'rejected'));
      tileMenu(c, 'dup', m.mediaId, [], d.id);
      const cap = doc.createElement('div');
      cap.className = 'uc-gl-pair-cap';
      cap.textContent = `${lbl} · ${m.status === 'approved' ? 'v knihovně' : m.status === 'rejected' ? 'zamítnutý' : 'čeká'} · použito ${m.useCount}×`;
      c.appendChild(cap);
      pair.appendChild(c);
    }
    row.appendChild(pair);
    row.insertAdjacentHTML('beforeend', `<div class="uc-gl-dup-score">Shoda ${Math.round(d.score * 100)} %</div>
      <div class="uc-gl-acts">
        <button type="button" class="uc-gif-btn" data-act="keep-first">Nechat první</button>
        <button type="button" class="uc-gif-btn" data-act="keep-second">Nechat druhý</button>
        <button type="button" class="uc-gif-btn" data-act="keep-both">Nechat oba</button>
      </div>`);
    return row;
  }

  function paintTabs() {
    const mod = isMod();
    tabsEl.hidden = !mod;
    if (!mod && st.tab !== 'lib') st.tab = 'lib';
    for (const b of tabsEl.querySelectorAll('.uc-gl-tab')) b.classList.toggle('on', b.dataset.glTab === st.tab);
    searchWrap.hidden = st.tab !== 'lib';
    tabSlide.update();
  }

  function paintBody() {
    paintTabs();
    paintReward();
    const top = body.scrollTop;
    tileUsed = new Set();
    body.replaceChildren();
    if (st.tab === 'rej') {
      if (st.rejLoading && !st.rej.length) body.innerHTML = '<div class="uc-gl-empty">Načítám zamítnuté GIFy…</div>';
      else if (st.rejError) body.innerHTML = `<div class="uc-gl-empty">${esc(st.rejError)} <button type="button" class="uc-gl-retry" data-act="retry">Zkusit znovu</button></div>`;
      else if (!st.rej.length) body.innerHTML = '<div class="uc-gl-empty">Žádné zamítnuté GIFy.</div>';
      else section(`Zamítnuté (${gifCountText(st.rej.length)}${st.rejBefore ? '+' : ''})`, st.rej, rejItem, st.rejBefore ? 'more-rej' : null, 'uc-gl-grid--rej');
      // Zahozené: jen když nějaké jsou (divák / mod bez nich je nevidí).
      if (st.wd.length) section(`Stažené GIFy (${st.wd.length}${st.wdBefore ? '+' : ''})`, st.wd, discItem, st.wdBefore ? 'more-wd' : null, 'uc-gl-grid--disc uc-gl-grid--wd');
      if (st.pg.length) section(`Ke smazání (${st.pg.length}${st.pgBefore ? '+' : ''})`, st.pg, discItem, st.pgBefore ? 'more-pg' : null, 'uc-gl-grid--disc uc-gl-grid--pg');
      if (st.discError) body.insertAdjacentHTML('beforeend', `<div class="uc-gl-empty uc-gl-disc-err">${esc(st.discError)} <button type="button" class="uc-gl-retry" data-act="retry-disc">Zkusit znovu</button></div>`);
    } else {
      const dups = dupSection();
      if (dups) body.appendChild(dups);
      if (st.loading && !st.items.length) body.insertAdjacentHTML('beforeend', '<div class="uc-gl-empty">Načítám GIFy…</div>');
      else if (st.error) body.insertAdjacentHTML('beforeend', `<div class="uc-gl-empty">${esc(st.error)} <button type="button" class="uc-gl-retry" data-act="retry">Zkusit znovu</button></div>`);
      else if (!st.items.length) body.insertAdjacentHTML('beforeend', `<div class="uc-gl-empty">${st.q.trim() ? `Žádný GIF neodpovídá „${esc(st.q.trim())}“.` : 'Zatím tu nejsou žádné schválené GIFy.'}</div>`);
      else {
        if (dups) { const h = doc.createElement('div'); h.className = 'uc-gl-h'; h.textContent = 'GIFy'; body.appendChild(h); }
        const grid = doc.createElement('div');
        grid.className = 'uc-gl-grid';
        for (const it of st.items) grid.appendChild(libItem(it));
        body.appendChild(grid);
        if (st.cursor) body.insertAdjacentHTML('beforeend', '<button type="button" class="uc-gl-moreload" data-act="more">Načíst další</button>');
      }
    }
    sweepTiles();
    body.scrollTop = top;
    paintBusy();
    paintMenus();
    paintConfirm();
    paintPreview();
  }

  /** Otevřená nabídka ⋯ = jen přepnout `hidden` u nabídek (bez překreslení mřížky, audit F2). */
  function paintMenus() {
    for (const m of body.querySelectorAll('.uc-gl-menu')) {
      const open = !!st.menu && m.parentElement?.dataset.mkey === st.menu;
      if (m.hidden === open) m.hidden = !open;
    }
    placeMenu();
  }

  /** Tlačítka dlaždic s rozběhnutou akcí vypnout, ostatní zapnout (po chybě se zase dá kliknout — audit E3). */
  function paintBusy() {
    for (const el of body.querySelectorAll('.uc-gl-i, .uc-gl-dup')) {
      const key = el.classList.contains('uc-gl-dup') ? `duprow:${el.dataset.dup}` : el.dataset.mkey;
      const busy = st.busy.has(key);
      for (const b of el.querySelectorAll(':scope > .uc-gl-acts button')) b.disabled = busy || b.dataset.off === '1';
    }
  }

  /** Otevřená nabídka ⋯ uvnitř panelu (neusekne se o okraj — spec 2026-09-27-gif-review-upravy §4). */
  function placeMenu() {
    armMenuResize();
    const menu = st.menu ? body.querySelector('.uc-gl-menu:not([hidden])') : null;
    const tile = menu?.parentElement;
    if (!menu || !tile) return;
    const box = body.getBoundingClientRect();
    // Nabídka širší než panel → zúžit na šířku panelu (text položek se zalomí).
    const avail = Math.max(0, Math.floor(box.width - 2 * GIF_MENU_MARGIN));
    menu.style.maxWidth = `${avail}px`;
    menu.style.minWidth = `${Math.min(150, avail)}px`;
    menu.style.left = ''; menu.style.right = ''; menu.style.top = '';
    const p = gifMenuPlacement(tile.getBoundingClientRect(), menu.getBoundingClientRect(), box);
    menu.style.right = 'auto';
    menu.style.left = `${p.left}px`;
    menu.style.top = `${p.top}px`;
    menu.dataset.place = p.up ? 'up' : 'down';
    L(`nabídka ${st.menu}: ${p.up ? 'nad' : 'pod'} ⋯, left ${Math.round(p.left)} px, max ${avail} px`);
  }

  /** Otevřená nabídka ⋯ sleduje změnu velikosti panelu (ResizeObserver, jinak resize okna); zavřená listener odpojí. */
  let menuResize = null;
  function armMenuResize() {
    if (st.menu && !menuResize) {
      const on = () => { if (st.menu) placeMenu(); };
      const RO = win.ResizeObserver;
      if (typeof RO === 'function') { const ro = new RO(on); ro.observe(body); menuResize = () => ro.disconnect(); }
      else { win.addEventListener('resize', on); menuResize = () => win.removeEventListener('resize', on); }
    } else if (!st.menu && menuResize) { menuResize(); menuResize = null; }
  }

  /**
   * Potvrzení: Trvale zahodit = dvě varianty („Zahodit, zprávy nechat“ / „Zahodit i se zprávami“) + Zrušit
   * s vysvětlením; Odstranit ze serveru (stažený) = jedno tlačítko + Zrušit.
   */
  function paintConfirm() {
    const c = st.confirm;
    confirmEl.hidden = !c;
    if (!c) { confirmEl.replaceChildren(); delete confirmEl.dataset.kind; return; }
    const t = GIF_CONFIRM_TEXT[c.kind] || GIF_CONFIRM_TEXT.purge;
    confirmEl.dataset.kind = c.kind;
    const btns = c.kind === 'remove-file'
      ? '<button type="button" class="uc-gif-btn uc-gif-btn--reject" data-act="confirm-remove">Odstranit ze serveru</button>'
      : '<button type="button" class="uc-gif-btn" data-act="confirm-keep">Zahodit, zprávy nechat</button><button type="button" class="uc-gif-btn uc-gif-btn--reject" data-act="confirm-purge">Zahodit i se zprávami</button>';
    confirmEl.innerHTML = `<div class="uc-gl-confirm-box"><b></b>${t.lines.map(() => '<p></p>').join('')}
      <div class="uc-gl-acts uc-gl-confirm-acts"><button type="button" class="uc-gif-btn" data-act="confirm-no">Zrušit</button>${btns}</div></div>`;
    confirmEl.querySelector('b').textContent = t.title;
    confirmEl.querySelectorAll('p').forEach((p, i) => { p.textContent = t.lines[i]; });
  }

  /** Položka náhledu podle sekce a id (data se mohly mezitím změnit → null = náhled zavřít). */
  function previewItem(p) {
    if (!p) return null;
    const find = (list) => list.find((x) => x.mediaId === p.id) || null;
    switch (p.sec) {
      case 'lib': return find(st.items);
      case 'rej': return find(st.rej);
      case 'wd': return find(st.wd);
      case 'pg': return find(st.pg);
      case 'dup': { for (const d of st.dups) for (const m of [d.first, d.second]) if (m.mediaId === p.id) return m; return null; }
      default: return null;
    }
  }
  /** Token, se kterým je vykreslený aktuální náhled (jen v paměti). */
  let previewTok = null;
  /** Náhled potřebuje token (zamítnuté, ke smazání, zamítnutý v duplikátu). */
  const previewNeedsToken = (p, item) => p.sec === 'rej' || p.sec === 'pg' || (p.sec === 'dup' && item?.status === 'rejected');

  /** Překryv náhledu nad GIF panelem: GIF ve větší velikosti (fit do panelu), rozměry, tagy, kdo / kdy. */
  function paintPreview() {
    const p = st.preview;
    const item = previewItem(p);
    if (p && !item) { st.preview = null; L(`náhled ${p.sec}:${p.id} zavřen — GIF už v seznamu není`); }
    previewEl.hidden = !st.preview;
    if (!st.preview) { if (previewEl.firstChild) { previewEl.replaceChildren(); delete previewEl.dataset.key; previewTok = null; } return; }
    const needTok = previewNeedsToken(p, item);
    const key = `${p.sec}:${p.id}`;
    const t = needTok ? tok() : null;
    // Stejný náhled se stejným tokenem — média znovu nenačítat. Token jen v paměti (ne v DOM atributu).
    if (previewEl.dataset.key === key && previewTok === t) return;
    previewEl.dataset.key = key;
    previewTok = t;
    previewEl.innerHTML = `<div class="uc-gl-preview-box">
        <button type="button" class="uc-gl-preview-x" data-act="preview-close" aria-label="Zavřít náhled" title="Zavřít (Esc)">×</button>
        <div class="uc-gl-preview-media"></div>
        <div class="uc-gl-preview-info"><div class="uc-gl-preview-dim"></div><div class="uc-gl-preview-tags"></div><div class="uc-gl-preview-meta"></div></div>
      </div>`;
    const maxW = Math.max(160, (pane.clientWidth || 360) - 44);
    const maxH = Math.max(120, (pane.clientHeight || 360) - 150);
    const m = createGifMedia(doc, item, { lazy: false, log, maxW, maxH, token: t, onError: needTok ? onTokenMediaError : null });
    m.classList.add('uc-gl-preview-gif');
    previewEl.querySelector('.uc-gl-preview-media').appendChild(m);
    previewEl.querySelector('.uc-gl-preview-dim').textContent = gifDimText(item);
    const tags = previewEl.querySelector('.uc-gl-preview-tags');
    if (item.tags?.length) for (const t of item.tags) { const s = doc.createElement('span'); s.className = 'uc-gl-tag'; s.textContent = t; tags.appendChild(s); }
    else { tags.textContent = 'Bez tagů'; tags.classList.add('uc-gl-preview-tags--none'); }
    previewEl.querySelector('.uc-gl-preview-meta').textContent = gifPreviewMeta(item, p.sec, clock());
  }

  function openPreview(sec, id) {
    st.menu = null;
    st.preview = { sec, id };
    L(`náhled ${sec}:${id}`);
    paintMenus();
    paintPreview();
    previewEl.querySelector('.uc-gl-preview-x')?.focus({ preventScroll: true });
  }
  function closePreview(why) {
    if (!st.preview) return false;
    L(`náhled zavřen (${why})`);
    st.preview = null;
    paintPreview();
    return true;
  }

  // ---- akce ----
  /** Seznam dlaždic sekce (lib | rej | wd | pg). */
  const LIST = { lib: 'items', rej: 'rej', wd: 'wd', pg: 'pg' };
  const dropFrom = (from, mediaId) => { const k = LIST[from]; if (k) st[k] = st[k].filter((x) => x.mediaId !== mediaId); };

  /** Hláška po akci. */
  function actionMsg(action, r, body) {
    switch (action) {
      case 'unapprove': return 'GIF odebrán z knihovny.';
      case 'purge': return body.keepMessages ? 'GIF zahozen, staré zprávy ho dál ukazují.' : 'GIF zahozen i se zprávami. Do 7 dní ho jde obnovit v sekci Ke smazání.';
      case 'restore': return r?.status === 'approved' ? 'GIF obnoven zpět do knihovny.' : 'GIF obnoven zpět mezi zamítnuté.';
      case 'remove-file': return 'Soubor GIFu je smazaný ze serveru.';
      case 'approve': return 'GIF schválen do knihovny.';
      case 'vault': return 'GIF je ve vaultu.';
      default: return '';
    }
  }

  /**
   * Akce nad médiem (mod): POST /moderation/gif/:id/<action> { keepMessages? }. `from` = sekce dlaždice.
   * Po zahození / obnově / odstranění souboru se dotčené seznamy načtou znovu (hned, když je záložka vidět).
   */
  async function mediaAction(mediaId, action, from, body = {}) {
    L(`${action} ${mediaId} (${from})${action === 'purge' ? ` keepMessages=${!!body.keepMessages}` : ''}`);
    const busyKey = `${from}:${mediaId}`;
    st.busy.add(busyKey);
    paintBusy();
    try {
      const r = await api(`/moderation/gif/${encodeURIComponent(mediaId)}/${action}`, { method: 'POST', body });
      L(`${action} ${mediaId} → ok${r?.status ? ` (${r.status})` : ''}${r?.requests ? ` (žádostí ${r.requests})` : ''}`);
      if (action === 'vault') st.rej = st.rej.map((x) => (x.mediaId === mediaId ? { ...x, vault: true } : x));
      else dropFrom(from, mediaId);
      if (action === 'approve' || (action === 'restore' && r?.status === 'approved')) st.loaded = false;   // knihovna znovu
      if (action === 'unapprove' || (action === 'restore' && r?.status !== 'approved')) st.rejLoaded = false;
      if (action === 'purge' || action === 'restore' || action === 'remove-file') st.discLoaded = false;
      if (st.preview?.id === mediaId && action !== 'vault') st.preview = null;
      showMsg(actionMsg(action, r, body));
      if (st.visible && st.tab === 'rej') {
        if (!st.rejLoaded) loadRejected();
        if (!st.discLoaded) loadDiscarded();
      }
    } catch (e) {
      L(`${action} ${mediaId} FAIL ${e?.status || 0} ${e?.error || e?.message || e}`);
      showMsg(gifLibraryErrorText(e));
      if (e?.status === 404 || e?.status === 409) {
        dropFrom(from, mediaId);
        if (from === 'wd' || from === 'pg') st.discLoaded = false;
      }
    } finally {
      st.busy.delete(busyKey);
    }
    paintBody();
  }

  async function dupAction(id, action) {
    L(`duplikát ${id} ${action}`);
    const busyKey = `duprow:${id}`;
    st.busy.add(busyKey);
    paintBusy();
    try {
      await api(`/moderation/gif/duplicates/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: {} });
      st.busy.delete(busyKey);
      st.dups = st.dups.filter((d) => d.id !== id);
      if (action !== 'keep-both') st.loaded = false;
      showMsg(action === 'keep-both' ? 'Oba GIFy zůstávají.' : 'GIFy sloučeny.');
      paintBody();
      if (action !== 'keep-both' && st.tab === 'lib') loadLibrary();
    } catch (e) {
      st.busy.delete(busyKey);
      const reload = e?.status === 409 || e?.error === 'already_decided' || e?.error === 'gone' || Number(e?.status) >= 500;
      L(`duplikát ${id} ${action} FAIL ${e?.status || 0} ${e?.error || e?.message || e}${reload ? ' → obnovit seznam' : ''}`);
      showMsg(gifLibraryErrorText(e));
      if (e?.status === 409 || e?.error === 'already_decided' || e?.error === 'gone') st.dups = st.dups.filter((d) => d.id !== id);
      // Tlačítka zase zapnout (audit E3); 409 / 5xx (souběh modů, deadlock při slučování) → seznam znovu (audit E4).
      paintBody();
      if (reload) loadDuplicates();
    }
  }

  let picking = false;
  async function pick(item) {
    if (picking) return;
    picking = true;
    try {
      // Stav odměny ne starší než 60 s: cooldown může být i globální (jiný GIF v chatu) — server by jinak nechal
      // v chatu holý odkaz. Čerstvý stav = bez dotazu.
      const r = refreshReward?.();
      if (r && typeof r.then === 'function') await r.catch(() => null);
    } finally { picking = false; }
    const v = rv();
    if (!v.canSend) {
      L(`výběr ${item.mediaId} zamčený (${v.mode})`);
      // Bez odměny: zámek se zatřese a zčervená, pak zešedne (stejně jako zamčený zvuk v soundboardu, spec §2).
      if (v.mode === 'locked') { paintReward(); shakeLock(rewardEl.querySelector('.uc-lock')); return; }
      st.flash = true;
      paintReward();
      win.setTimeout(() => { st.flash = false; paintReward(); }, 1200);
      // Cooldown (i globální cooldown chatu) → stejná hláška jako při odeslání z pole.
      if (v.mode === 'cooldown') showMsg(`${gifCooldownText(true)} ${formatRemaining(v.cooldownMs)}`);
      if (v.mode === 'unknown') refreshReward?.();
      return;
    }
    // Vlastní GIF ještě čeká na moda / převádí se → server by druhý nepustil (1 žádost na uživatele, audit X1).
    if (ownPending?.()) {
      L(`výběr ${item.mediaId} blokován — vlastní GIF ještě čeká`);
      showMsg(GIF_WAIT_OWN_TEXT);
      return;
    }
    L(`výběr ${item.mediaId} → odkaz do chatu`);
    onPick?.(item.url, item);
  }

  pane.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  pane.addEventListener('click', (e) => {
    // Klik mimo rámeček náhledu (na ztmavené pozadí) = zavřít.
    if (e.target === previewEl) { closePreview('klik mimo'); return; }
    if (e.target === confirmEl) { st.confirm = null; paintConfirm(); return; }
    const tab = e.target.closest('[data-gl-tab]');
    if (tab) {
      st.tab = tab.dataset.glTab;
      st.menu = null;
      L(`tab ${st.tab}`);
      paintBody();
      if (st.tab === 'rej' && !st.rejLoaded) loadRejected();
      if (st.tab === 'rej' && !st.discLoaded) loadDiscarded();
      if (st.tab === 'lib' && !st.loaded) loadLibrary();
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) { if (st.menu) { st.menu = null; paintMenus(); } return; }
    const tile = b.closest('[data-sec]');
    const id = tile?.dataset.id;
    const sec = tile?.dataset.sec;
    const act = b.dataset.act;
    if (act === 'preview-close') { closePreview('×'); return; }
    if (act === 'retry') { if (st.tab === 'rej') loadRejected(); else loadLibrary(); return; }
    if (act === 'retry-disc') { st.discError = ''; loadDiscarded(); return; }
    if (act === 'more') { loadLibrary({ more: true }); return; }
    if (act === 'more-rej') { loadRejected({ more: true }); return; }
    if (act === 'more-wd') { loadDiscarded({ which: 'withdrawn', more: true }); return; }
    if (act === 'more-pg') { loadDiscarded({ which: 'purging', more: true }); return; }
    if (act === 'confirm-no') { st.confirm = null; paintConfirm(); return; }
    if (act === 'confirm-keep' || act === 'confirm-purge' || act === 'confirm-remove') {
      const c = st.confirm;
      st.confirm = null;
      paintConfirm();
      if (!c) return;
      if (act === 'confirm-remove') mediaAction(c.mediaId, 'remove-file', c.from);
      else mediaAction(c.mediaId, 'purge', c.from, { keepMessages: act === 'confirm-keep' });
      return;
    }
    const dup = b.closest('.uc-gl-dup')?.dataset.dup;
    if (dup && /^keep-(first|second|both)$/.test(act)) { if (!st.busy.has(`duprow:${dup}`)) dupAction(dup, act); return; }
    if (!id) return;
    if (act === 'pick') { const it = st.items.find((x) => x.mediaId === id); if (it) pick(it); return; }
    if (act === 'menu') { const k = tile.dataset.mkey; st.menu = st.menu === k ? null : k; paintMenus(); return; }
    if (act === 'eye') { toggleEye(tile); return; }
    if (act === 'preview') { openPreview(sec, id); return; }
    if (act === 'unapprove') { st.menu = null; mediaAction(id, 'unapprove', 'lib'); return; }
    if (act === 'purge-ask') { st.menu = null; st.confirm = { kind: 'purge', mediaId: id, from: sec }; L(`potvrzení trvale zahodit ${id} (${sec})`); paintMenus(); paintConfirm(); return; }
    if (act === 'remove-ask') { st.menu = null; st.confirm = { kind: 'remove-file', mediaId: id, from: sec }; L(`potvrzení odstranit ze serveru ${id}`); paintMenus(); paintConfirm(); return; }
    if (st.busy.has(tile.dataset.mkey)) return;
    if (act === 'restore') { mediaAction(id, 'restore', sec); return; }
    if (act === 'approve' || act === 'vault') { mediaAction(id, act, 'rej'); }
  });
  // Esc zavře náhled / potvrzení dřív, než zavře celý panel emotů (ten poslouchá keydown na dokumentu).
  const onKey = (e) => {
    if (e.key !== 'Escape' || !st.visible || (!st.preview && !st.confirm)) return;
    e.stopPropagation();
    e.stopImmediatePropagation?.();
    e.preventDefault();
    if (st.preview) closePreview('Esc');
    else { st.confirm = null; paintConfirm(); }
  };
  doc.addEventListener('keydown', onKey, true);
  let searchT = null;
  search.addEventListener('input', () => {
    if (searchT) win.clearTimeout(searchT);
    searchT = win.setTimeout(() => { st.q = search.value; st.cursor = null; loadLibrary(); }, 250);
  });
  search.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { if (search.value) { search.value = ''; st.q = ''; loadLibrary(); } else pane.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } });
  body.addEventListener('scroll', () => {
    if (body.scrollTop + body.clientHeight < body.scrollHeight - 80) return;
    if (st.tab === 'lib' && st.cursor && !st.loading) loadLibrary({ more: true });
    if (st.tab !== 'rej') return;
    // Sekce v pořadí jako v DOM: Zamítnuté → Stažené GIFy → Ke smazání; další až po dotažení předchozí.
    if (st.rejBefore) { if (!st.rejLoading) loadRejected({ more: true }); return; }
    if (st.discLoading) return;
    if (st.wdBefore) loadDiscarded({ which: 'withdrawn', more: true });
    else if (st.pgBefore) loadDiscarded({ which: 'purging', more: true });
  }, { passive: true });

  // Rozprostřené načtení po SSE gif-media (mediaChanged).
  let refetchT = null;
  // Odpočet odměny v hlavičce + pásek na záložce (1 s), jen když je co počítat.
  let timer = null;
  function arm() {
    const v = rv();
    const need = st.visible || v.progress !== null || v.cooldownMs > 0;
    if (need && !timer) timer = win.setInterval(tick, 1000);
    if (!need && timer) { win.clearInterval(timer); timer = null; }
  }
  function tick() { paintReward(); arm(); }

  return {
    pane,
    show() {
      st.visible = true;
      if (st.channel && st.channel !== ch()) { st.loaded = false; st.rejLoaded = false; st.dupsLoaded = false; st.discLoaded = false; st.items = []; st.rej = []; st.wd = []; st.pg = []; st.dups = []; st.preview = null; }
      paintBody();
      if (!st.loaded) loadLibrary();
      if (isMod() && !st.dupsLoaded) loadDuplicates();
      if (st.tab === 'rej' && !st.rejLoaded) loadRejected();
      if (st.tab === 'rej' && !st.discLoaded) loadDiscarded();
      refreshReward?.();
      arm();
      // Na dotyku bez fokusu (klávesnice by zakryla knihovnu) — spec 2026-09-27 §4.
      if (canAutoFocus(doc) && st.tab === 'lib') search.focus();
    },
    hide() { st.visible = false; st.menu = null; armMenuResize(); st.confirm = null; st.preview = null; paintConfirm(); paintPreview(); arm(); },
    /** Stav odměny / role se změnil → hlavička, pásek, taby. */
    update() {
      if (!isMod() && (st.tab === 'rej' || st.dups.length)) {
        st.tab = 'lib'; st.dups = []; st.dupsLoaded = false; st.wd = []; st.pg = []; st.discLoaded = false;
        if (st.preview && st.preview.sec !== 'lib') st.preview = null;
      }
      if (st.visible) { paintBody(); if (isMod() && !st.dupsLoaded) loadDuplicates(); } else paintReward();
      arm();
    },
    /** Přepnutí kanálu: data pryč, při dalším zobrazení znovu. */
    reset() {
      Object.assign(st, { items: [], cursor: null, loaded: false, rej: [], rejBefore: null, rejLoaded: false, wd: [], wdBefore: null, pg: [], pgBefore: null, discLoaded: false, dups: [], dupsLoaded: false, discError: '', tokenRetried: false, menu: null, confirm: null, preview: null, tab: isMod() ? st.tab : 'lib' });
      if (st.visible) this.show(); else paintReward();
    },
    reload() { st.loaded = false; if (st.visible) loadLibrary(); },
    /**
     * SSE `gif-media` (stav média se změnil jinde — jiný mod, Židolišta): seznamy knihovny / zamítnutých / zahozených
     * načíst znovu — při zobrazené záložce s náhodným zpožděním 0–2 s (všichni otevření klienti naráz = špička
     * na /gifs/library), víc událostí za sebou = jedno načtení; skrytý panel až při dalším zobrazení.
     */
    mediaChanged({ delayMs = Math.random() * MEDIA_REFETCH_SPREAD_MS } = {}) {
      // Návrhy duplikátů se mohly změnit taky (sloučení, zahození — audit F7).
      st.loaded = false; st.rejLoaded = false; st.discLoaded = false; st.dupsLoaded = false;
      if (!st.visible || refetchT) return;
      L(`gif-media → načíst znovu za ${Math.round(delayMs)} ms`);
      refetchT = win.setTimeout(() => {
        refetchT = null;
        if (!st.visible) return;
        if (st.tab === 'lib') { if (!st.loaded) loadLibrary(); if (isMod() && !st.dupsLoaded) loadDuplicates(); }
        else { if (!st.rejLoaded) loadRejected(); if (!st.discLoaded) loadDiscarded(); }
      }, Math.max(0, delayMs));
    },
    state: () => ({ tab: st.tab, items: st.items.length, rejected: st.rej.length, withdrawn: st.wd.length, purging: st.pg.length, duplicates: st.dups.length, preview: st.preview ? `${st.preview.sec}:${st.preview.id}` : null }),
    destroy() { st.menu = null; armMenuResize(); for (const v of tileCache.values()) removeGifMedia(v.el); tileCache.clear(); if (timer) win.clearInterval(timer); timer = null; if (refetchT) win.clearTimeout(refetchT); refetchT = null; doc.removeEventListener('keydown', onKey, true); pane.replaceChildren(); },
  };
}

