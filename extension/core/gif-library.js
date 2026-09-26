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
import { createGifMedia, normalizeGifMedia, normalizeGifPending, normalizeGifDecided, gifCountText } from './gif.js';
import { actorLabel } from './user-history.js';
import { formatRemaining } from './soundboard.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sameChannel = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
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
/** Průběh bez další události ze serveru (typicky zaseknutá fáze unlock bez done) → po této době „Vypršelo“ a konec animace. */
export const GIF_PROGRESS_MAX_SILENT_MS = 60_000;

export const GIF_STATUS_TEXT = {
  pending: 'Schvalování moderátorem',
  rejected: 'Zamítnuto moderátorem',
  expired: 'Vypršelo',
  not_allowed: 'Nové GIFy teď nejdou',
};
export const GIF_PREV_REJECTED_TIP = 'tento GIF byl už dříve zamítnut';
export const GIF_APPROVED_ONLY_TEXT = 'Nové GIFy teď nejdou, vyber z GIFů v panelu';

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
 * Stav vlastních GIF zpráv (odesílatel). Klíč = `platform:messageId` (requestKey serveru). Optimistická zpráva
 * (`sent-…`) se na klíč napáruje přes `alias` (id z POST /chat/send, echo z platformy) nebo — když průběh přijde
 * dřív než echo — na poslední vlastní optimistickou GIF zprávu téže platformy (do GIF_OPTIMISTIC_PAIR_MS).
 *
 *   outbox.onProgress(d) / onNotice(d) / onOwnPending(d) / onDecided(d) / onGifMessage(msg)
 *   outbox.view(platform, id, now) → { kind, pct?, text?, warn? } | null
 *   host: onChange(keys) → překreslit štítky zpráv (paintGifStatus), onNotice(kind, entry) → hláška
 */
export class GifOutbox {
  constructor({ channel, now, log, onChange, onNotice, hasMessage, setInterval: si, clearInterval: ci } = {}) {
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
  noteOptimistic(optId, platform, { show = false } = {}) {
    if (!optId || !platform) return;
    this._opt.push({ optId: String(optId), platform, at: this.now() });
    if (this._opt.length > 20) this._opt.shift();
    if (show) {
      const e = this._entry(`${platform}:${optId}`, platform, String(optId));
      e.optimistic = true;
      this._L(`${optId} odeslán GIF odkaz → kolečko 0 %`);
      this._arm();
    }
  }

  /** Zpráva neodešla / zmizela → bez štítku. */
  drop(platform, id) {
    const key = this.keyOf(platform, id);
    if (this._e.delete(key)) this.onChange([key]);
    this._opt = this._opt.filter((o) => o.optId !== String(id));
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

  _entry(key, platform, messageId) {
    let e = this._e.get(key);
    if (!e) {
      e = { key, platform, messageId, state: 'progress', phase: 'detect', pct: 0, estimateMs: null, elapsedMs: 0, at: this.now(), floor: 0, warn: false, requestId: null };
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
    // Pozdní průběh po rozhodnutí (pending → progress by štítek vrátil zpět) ignorovat.
    if (e.state !== 'progress' && p.phase !== 'done') return e;
    e.floor = gifProgressPct(e, this.now(), e.floor);
    e.optimistic = false;
    Object.assign(e, { phase: p.phase, pct: p.pct, estimateMs: p.estimateMs, elapsedMs: p.elapsedMs, at: this.now() });
    if (p.phase === 'done') {
      e.state = gifOutcomeState(p.outcome);
      e.outcome = p.outcome;
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
    else { this._L(`gif-notice ${d.kind} neznámý`); return e; }
    this._L(`${key} gif-notice ${d.kind}${d.reason ? ` (${d.reason})` : ''}`);
    this._arm();
    this.onChange([key]);
    try { this.onNoticeCb(d.kind, e, d); } catch { /* ignore */ }
    return e;
  }

  /** Vlastní `gif-pending` (own: true) → čeká na moda (+ ⚠ u dříve zamítnutého), requestId → klíč. */
  onOwnPending(d) {
    const req = d && d.requestId != null && d.media ? normalizeGifPending(d) : null;
    if (!req || !req.own || !req.platform || !req.messageId) return null;
    if (!sameChannel(req.channel, this.channel())) return null;
    const key = `${req.platform}:${req.messageId}`;
    if (!this._e.has(key)) this._pairOrphan(req.platform, req.messageId);
    const e = this._entry(key, req.platform, req.messageId);
    e.requestId = req.requestId;
    this._req.set(req.requestId, key);
    if (e.state === 'progress' || e.state === 'none') e.state = 'pending';
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
      const pct = gifProgressPct(e, now, e.floor);
      return { kind: 'progress', pct, text: formatGifPct(pct) };
    }
    if (e.state === 'approved') return { kind: 'approved' };
    return { kind: e.state, text: GIF_STATUS_TEXT[e.state] || '', warn: e.state === 'pending' && e.warn };
  }

  /** Přepnutí kanálu / odhlášení. */
  clear() {
    this._e.clear(); this._alias.clear(); this._opt = []; this._req.clear();
    if (this._timer) { this._ci(this._timer); this._timer = null; }
  }

  /** Animace unlock fáze: překreslovat, dokud nějaký průběh běží. */
  _arm() {
    const live = (e) => e.state === 'progress' && (e.phase === 'unlock' || e.optimistic);
    if (![...this._e.values()].some(live)) { if (this._timer) { this._ci(this._timer); this._timer = null; } return; }
    if (this._timer) return;
    this._timer = this._si(() => {
      const now = this.now();
      const keys = [];
      for (const e of this._e.values()) {
        if (!live(e)) continue;
        if (e.optimistic && now - e.at > GIF_OPTIMISTIC_SILENT_MS) { e.state = 'none'; e.optimistic = false; this._L(`${e.key} bez odezvy serveru → kolečko pryč`); }
        else if (!e.optimistic && now - e.at > GIF_PROGRESS_MAX_SILENT_MS) { e.state = 'expired'; this._L(`${e.key} ${e.phase} bez další události ${Math.round((now - e.at) / 1000)} s → Vypršelo`); }
        keys.push(e.key);
      }
      if (!keys.length) { this._ci(this._timer); this._timer = null; return; }
      this.onChange(keys);
    }, GIF_PROGRESS_TICK_MS);
  }
}

const WARN_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M12 3 2 21h20L12 3Z" fill="#f5a524"/><path d="M12 10v5" stroke="#1a1a1d" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="18" r="1.3" fill="#1a1a1d"/></svg>';

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
  }

  _L(t) { this.log('Gif', `token: ${t}`); }

  async get() {
    if (this._token) return this._token;
    if (this._inflight) return this._inflight;
    this._inflight = (async () => {
      try {
        const saved = await this.store?.load?.();
        if (saved && typeof saved === 'string') { this._token = saved; this._L('ze session úložiště'); return saved; }
      } catch { /* ignore */ }
      return this._issue();
    })().finally(() => { this._inflight = null; });
    return this._inflight;
  }

  async _issue() {
    const ch = String(this.channel() || '').toLowerCase();
    this._lastIssue = this.now();
    try {
      const j = await this.api('/moderation/gif/access-token', { method: 'POST', body: ch ? { channel: ch } : {} });
      const t = typeof j?.token === 'string' && j.token ? j.token : null;
      if (!t) { this._L('odpověď bez tokenu'); return null; }
      this._token = t;
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
    try { await this.store?.clear?.(); } catch { /* ignore */ }
    this._L('obnova po chybě média');
    if (this._inflight) return this._inflight;
    this._inflight = this._issue().finally(() => { this._inflight = null; });
    return this._inflight;
  }

  clear() { this._token = null; try { this.store?.clear?.(); } catch { /* ignore */ } }
}

// ---------------------------------------------------------------------------
// Odměna — indikátor (pásek) a hlavička GIF záložky
// ---------------------------------------------------------------------------

/**
 * Stav odměny z GifCooldown.snapshot() ({ allowed, mod, until, sec, mode, rewardUntil, rewardTotalMs }) v čase `now`:
 * { mode: unknown|login|mod|locked|active|cooldown, canSend, cooldownMs, remainingMs|null, progress|null, text, approvedOnly }.
 * `progress` (0–1, ubývá) jen když server pošle konec odměny (`rewardUntil`); bez něj pásek není.
 */
export function gifRewardView(st, now, { loggedIn = true } = {}) {
  if (!loggedIn) return { mode: 'login', canSend: false, cooldownMs: 0, remainingMs: null, progress: null, approvedOnly: false, text: 'Přihlas se k UnityChatu, ať můžeš GIFy posílat.' };
  if (!st) return { mode: 'unknown', canSend: false, cooldownMs: 0, remainingMs: null, progress: null, approvedOnly: false, text: '' };
  const approvedOnly = st.mode === 'approved';
  if (st.mod) return { mode: 'mod', canSend: true, cooldownMs: 0, remainingMs: null, progress: null, approvedOnly, text: 'Jako mod posíláš GIFy bez odměny.' };
  const rem = Number.isFinite(st.rewardUntil) ? st.rewardUntil - now : null;
  if (!st.allowed || (rem !== null && rem <= 0)) {
    return { mode: 'locked', canSend: false, cooldownMs: 0, remainingMs: null, progress: null, approvedOnly, text: 'Odměna „Posílání GIFů“ není aktivní. Knihovnu vidíš, poslat GIF jde s odemčenou odměnou.' };
  }
  const cd = Number.isFinite(st.until) && st.until > now ? st.until - now : 0;
  const total = Number.isFinite(st.rewardTotalMs) && st.rewardTotalMs > 0 ? st.rewardTotalMs : null;
  const progress = rem !== null && total ? clamp(rem / total, 0, 1) : null;
  const text = cd > 0 ? `Další GIF můžeš poslat za ${formatRemaining(cd)}`
    : rem !== null ? `Odměna ještě ${formatRemaining(rem)}` : 'Odměna „Posílání GIFů“ je aktivní';
  return { mode: cd > 0 ? 'cooldown' : 'active', canSend: cd <= 0, cooldownMs: cd, remainingMs: rem, progress, approvedOnly, text };
}

// ---------------------------------------------------------------------------
// Knihovna — data
// ---------------------------------------------------------------------------

export const GIF_LIBRARY_PAGE = 50;
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

/** „Zamítl modik (Twitch) · smaže se za 3 dny“ / „Vault — nesmaže se“. */
export function rejectedMetaText(item, now) {
  const by = item?.rejectedBy ? `Zamítl ${actorLabel(item.rejectedBy)}` : 'Zamítnuto';
  if (item?.vault) return `${by} · Vault — nesmaže se`;
  if (!item?.deleteAt) return by;
  const days = Math.ceil((item.deleteAt - now) / 86_400_000);
  if (days <= 0) return `${by} · smaže se dnes`;
  const d = days === 1 ? '1 den' : days >= 2 && days <= 4 ? `${days} dny` : `${days} dní`;
  return `${by} · smaže se za ${d}`;
}

/** Chyba akce knihovny → česky. */
export function gifLibraryErrorText(e) {
  switch (e?.error) {
    case 'already_decided': return 'O návrhu už rozhodl jiný mod.';
    case 'gone': return 'GIF mezitím zmizel.';
    case 'not_found': return 'GIF už neexistuje.';
    case 'not_mod': return 'Tohle můžou jen modi.';
    case 'not_rejected': return 'GIF už není mezi zamítnutými.';
    case 'not_approved': return 'GIF už není v knihovně.';
    case 'rate_limited': return 'Moc rychle za sebou, chvíli počkej.';
    case 'not_ready': return 'Knihovna ještě není připravená, zkus to později.';
    default: return e?.status === 401 ? 'Přihlášení vypršelo, přihlas se znovu.' : 'Akce se nepovedla, zkus to znovu.';
  }
}

// ---------------------------------------------------------------------------
// Knihovna — záložka „GIFy“ v panelu emotů
// ---------------------------------------------------------------------------

export const GIF_TAB_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10.5 10H8.8c-.8 0-1.3.6-1.3 2s.5 2 1.3 2h1.2v-1.6H9M13 10v4M15.5 14v-4h2.2M15.5 12h1.8" stroke-linecap="round"/></svg>';
const LIB_THUMB_W = 140;
const LIB_THUMB_H = 96;

/**
 * Obsah záložky „GIFy“ (mount do panelu emotů). Divák bez odměny knihovnu vidí, poslat nemůže (hláška).
 * Mod / streamer: nahoře taby GIFy | Zamítnuté GIFy, v GIFech sekce „Možné duplikáty (N)“ a u GIFu menu
 * (Odebrat z knihovny / Trvale zahodit s potvrzením). Zamítnuté: Schválit / Vault / Trvale zahodit.
 *
 * @param {object} o
 * @param {HTMLElement} o.pane                     kontejner záložky
 * @param {(path: string, opts?: object) => Promise<any>} o.api
 * @param {() => string} o.channel
 * @param {() => boolean} [o.canModerate]
 * @param {() => object} [o.reward]               gifRewardView(…) — smí poslat? text hlavičky, pásek
 * @param {() => void} [o.refreshReward]           znovu se zeptat na stav odměny (GET /gif/state)
 * @param {(url: string, item: object) => void} o.onPick   poslat odkaz do chatu
 * @param {(v: { progress: number|null, title?: string }|null) => void} [o.onIndicator]  pásek na záložce a tlačítku
 * @param {GifAccessToken} [o.tokens]
 * @param {string[]} [o.origins]
 * @param {(tag: string, text: string) => void} [o.log]
 * @param {() => number} [o.now]
 */
export function createGifPanel({ pane, api, channel, canModerate, reward, refreshReward, onPick, onIndicator, tokens, origins = null, log, now } = {}) {
  const doc = pane.ownerDocument;
  const win = doc.defaultView || globalThis;
  const L = (t) => log?.('Gif', `knihovna: ${t}`);
  const clock = now || (() => Date.now());
  const isMod = () => !!canModerate?.();
  const rv = () => reward?.() || gifRewardView(null, clock());
  const opts = { origins };
  const st = {
    tab: 'lib', q: '', items: [], cursor: null, loaded: false, loading: false, error: '', channel: '',
    rej: [], rejBefore: null, rejLoaded: false, rejLoading: false, rejError: '',
    dups: [], dupsLoaded: false, token: null, tokenRetried: false, visible: false, flash: false, menu: null, confirm: null, msg: '',
  };

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
    <div class="uc-gl-confirm" role="alertdialog" hidden></div>`;
  const tabsEl = pane.querySelector('.uc-gl-tabs');
  const rewardEl = pane.querySelector('.uc-gl-reward');
  const search = pane.querySelector('.uc-gl-search input');
  const searchWrap = pane.querySelector('.uc-gl-search');
  const msgEl = pane.querySelector('.uc-gl-msg');
  const body = pane.querySelector('.uc-gl-body');
  const confirmEl = pane.querySelector('.uc-gl-confirm');

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
    rewardEl.innerHTML = `<span class="uc-gl-reward-t"></span>${v.progress !== null && st.tab === 'lib' ? `<i class="uc-gl-reward-bar" style="--p:${v.progress.toFixed(4)}"></i>` : ''}`;
    rewardEl.querySelector('.uc-gl-reward-t').textContent = txt;
    rewardEl.hidden = !txt;
    pane.classList.toggle('uc-gl--locked', !v.canSend);
    onIndicator?.(v.progress !== null ? { progress: v.progress, title: v.text } : null);
  }

  // ---- data ----
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
      st.items = more ? [...st.items, ...items.filter((x) => !st.items.some((y) => y.mediaId === x.mediaId))] : items;
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

  async function ensureToken() {
    if (st.token || !tokens) return st.token;
    st.token = await tokens.get();
    return st.token;
  }

  /** Náhled zamítnutého média s tokenem vrátil chybu → jednou nový token a znovu vykreslit. */
  function onTokenMediaError() {
    // Nejvýš jedna obnova za 30 s (médium může být opravdu pryč → bez smyčky obnov).
    if (!tokens || st.tokenRetried || clock() - (st.tokenAt || 0) < 30_000) return false;
    st.tokenRetried = true;
    L('náhled zamítnutého se nenačetl → nový token');
    // Po úspěšné obnově zase povolit další obnovu (token může vypadnout znovu); neúspěch = dál nezkoušet.
    tokens.refresh().then((t) => { st.token = t; if (t) { st.tokenRetried = false; st.tokenAt = clock(); } paintBody(); });
    return true;
  }

  // ---- vykreslení ----
  function thumb(item, { withToken = false } = {}) {
    const w = createGifMedia(doc, item, { lazy: true, log, maxW: LIB_THUMB_W, maxH: LIB_THUMB_H, token: withToken ? st.token : null, onError: withToken ? onTokenMediaError : null });
    w.classList.add('uc-gl-media');
    return w;
  }

  function libItem(item) {
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
    if (isMod()) {
      el.insertAdjacentHTML('beforeend', `<button type="button" class="uc-gl-more" data-act="menu" aria-label="Akce s GIFem" aria-haspopup="menu" title="Akce">⋯</button>
        <div class="uc-gl-menu" role="menu"${st.menu === item.mediaId ? '' : ' hidden'}>
          <button type="button" role="menuitem" data-act="unapprove">Odebrat z knihovny</button>
          <button type="button" role="menuitem" class="uc-gl-danger" data-act="purge-ask">Trvale zahodit…</button>
        </div>`);
    }
    return el;
  }

  function rejItem(item) {
    const el = doc.createElement('div');
    el.className = `uc-gl-i uc-gl-i--rej${item.vault ? ' uc-gl-i--vault' : ''}`;
    el.dataset.id = item.mediaId;
    const box = doc.createElement('div');
    box.className = 'uc-gl-pick uc-gl-pick--static';
    box.appendChild(thumb(item, { withToken: true }));
    el.appendChild(box);
    const meta = doc.createElement('div');
    meta.className = 'uc-gl-meta';
    meta.textContent = rejectedMetaText(item, clock());
    el.appendChild(meta);
    el.insertAdjacentHTML('beforeend', `<div class="uc-gl-acts">
      <button type="button" class="uc-gif-btn uc-gif-btn--approve" data-act="approve">Schválit</button>
      <button type="button" class="uc-gif-btn" data-act="vault"${item.vault ? ' disabled' : ''}>${item.vault ? 'Ve vaultu' : 'Vault'}</button>
      <button type="button" class="uc-gif-btn uc-gif-btn--reject" data-act="purge-ask">Trvale zahodit</button>
    </div>`);
    return el;
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
      const row = doc.createElement('div');
      row.className = 'uc-gl-dup';
      row.dataset.dup = d.id;
      const pair = doc.createElement('div');
      pair.className = 'uc-gl-pair';
      for (const [lbl, m] of [['První', d.first], ['Druhý', d.second]]) {
        const c = doc.createElement('div');
        c.className = `uc-gl-pair-i uc-gl-pair-i--${m.status}`;
        c.appendChild(thumb(m, { withToken: m.status === 'rejected' }));
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
      sec.appendChild(row);
    }
    return sec;
  }

  function paintTabs() {
    const mod = isMod();
    tabsEl.hidden = !mod;
    if (!mod && st.tab !== 'lib') st.tab = 'lib';
    for (const b of tabsEl.querySelectorAll('.uc-gl-tab')) b.classList.toggle('on', b.dataset.glTab === st.tab);
    searchWrap.hidden = st.tab !== 'lib';
  }

  function paintBody() {
    paintTabs();
    paintReward();
    const top = body.scrollTop;
    body.replaceChildren();
    if (st.tab === 'rej') {
      if (st.rejLoading && !st.rej.length) body.innerHTML = '<div class="uc-gl-empty">Načítám zamítnuté GIFy…</div>';
      else if (st.rejError) body.innerHTML = `<div class="uc-gl-empty">${esc(st.rejError)} <button type="button" class="uc-gl-retry" data-act="retry">Zkusit znovu</button></div>`;
      else if (!st.rej.length) body.innerHTML = '<div class="uc-gl-empty">Žádné zamítnuté GIFy.</div>';
      else {
        const h = doc.createElement('div');
        h.className = 'uc-gl-h';
        h.textContent = `Zamítnuté (${gifCountText(st.rej.length)}${st.rejBefore ? '+' : ''})`;
        body.appendChild(h);
        const grid = doc.createElement('div');
        grid.className = 'uc-gl-grid uc-gl-grid--rej';
        for (const it of st.rej) grid.appendChild(rejItem(it));
        body.appendChild(grid);
        if (st.rejBefore) body.insertAdjacentHTML('beforeend', '<button type="button" class="uc-gl-moreload" data-act="more-rej">Načíst další</button>');
      }
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
    body.scrollTop = top;
    paintConfirm();
  }

  function paintConfirm() {
    const c = st.confirm;
    confirmEl.hidden = !c;
    if (!c) { confirmEl.replaceChildren(); return; }
    confirmEl.innerHTML = `<div class="uc-gl-confirm-box"><b>Trvale zahodit GIF?</b><p></p>
      <div class="uc-gl-acts"><button type="button" class="uc-gif-btn" data-act="confirm-no">Zrušit</button>
      <button type="button" class="uc-gif-btn uc-gif-btn--reject" data-act="confirm-yes">Trvale zahodit</button></div></div>`;
    confirmEl.querySelector('p').textContent = c.from === 'lib' ? 'Zmizí i ze starých zpráv.' : 'GIF se smaže natrvalo, nejde vrátit.';
  }

  // ---- akce ----
  async function mediaAction(mediaId, action, from) {
    L(`${action} ${mediaId} (${from})`);
    try {
      const r = await api(`/moderation/gif/${encodeURIComponent(mediaId)}/${action}`, { method: 'POST', body: {} });
      L(`${action} ${mediaId} → ok${r?.requests ? ` (žádostí ${r.requests})` : ''}`);
      if (from === 'lib') st.items = st.items.filter((x) => x.mediaId !== mediaId);
      if (from === 'rej') {
        if (action === 'vault') st.rej = st.rej.map((x) => (x.mediaId === mediaId ? { ...x, vault: true } : x));
        else st.rej = st.rej.filter((x) => x.mediaId !== mediaId);
        if (action === 'approve') st.loaded = false;   // knihovna se při dalším zobrazení načte znovu
      }
      if (action === 'unapprove') st.rejLoaded = false;
      showMsg(action === 'unapprove' ? 'GIF odebrán z knihovny.' : action === 'purge' ? 'GIF trvale zahozen.' : action === 'approve' ? 'GIF schválen do knihovny.' : action === 'vault' ? 'GIF je ve vaultu.' : '');
    } catch (e) {
      L(`${action} ${mediaId} FAIL ${e?.status || 0} ${e?.error || e?.message || e}`);
      showMsg(gifLibraryErrorText(e));
      if (e?.status === 404 || e?.status === 409) {
        if (from === 'lib') st.items = st.items.filter((x) => x.mediaId !== mediaId);
        if (from === 'rej') st.rej = st.rej.filter((x) => x.mediaId !== mediaId);
      }
    }
    paintBody();
  }

  async function dupAction(id, action) {
    L(`duplikát ${id} ${action}`);
    try {
      await api(`/moderation/gif/duplicates/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: {} });
      st.dups = st.dups.filter((d) => d.id !== id);
      if (action !== 'keep-both') st.loaded = false;
      showMsg(action === 'keep-both' ? 'Oba GIFy zůstávají.' : 'GIFy sloučeny.');
      paintBody();
      if (action !== 'keep-both' && st.tab === 'lib') loadLibrary();
    } catch (e) {
      L(`duplikát ${id} ${action} FAIL ${e?.status || 0} ${e?.error || e?.message || e}${e?.status === 409 ? ' → obnovit seznam' : ''}`);
      if (e?.status === 409 || e?.error === 'already_decided' || e?.error === 'gone') {
        st.dups = st.dups.filter((d) => d.id !== id);
        showMsg(gifLibraryErrorText(e));
        paintBody();
        loadDuplicates();
        return;
      }
      showMsg(gifLibraryErrorText(e));
    }
  }

  function pick(item) {
    const v = rv();
    if (!v.canSend) {
      L(`výběr ${item.mediaId} zamčený (${v.mode})`);
      st.flash = true;
      paintReward();
      win.setTimeout(() => { st.flash = false; paintReward(); }, 1200);
      if (v.mode === 'unknown') refreshReward?.();
      return;
    }
    L(`výběr ${item.mediaId} → odkaz do chatu`);
    onPick?.(item.url, item);
  }

  pane.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  pane.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-gl-tab]');
    if (tab) {
      st.tab = tab.dataset.glTab;
      st.menu = null;
      L(`tab ${st.tab}`);
      paintBody();
      if (st.tab === 'rej' && !st.rejLoaded) loadRejected();
      if (st.tab === 'lib' && !st.loaded) loadLibrary();
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) { if (st.menu) { st.menu = null; paintBody(); } return; }
    const itemEl = b.closest('.uc-gl-i');
    const id = itemEl?.dataset.id;
    const act = b.dataset.act;
    if (act === 'retry') { if (st.tab === 'rej') loadRejected(); else loadLibrary(); return; }
    if (act === 'more') { loadLibrary({ more: true }); return; }
    if (act === 'more-rej') { loadRejected({ more: true }); return; }
    if (act === 'confirm-no') { st.confirm = null; paintConfirm(); return; }
    if (act === 'confirm-yes') { const c = st.confirm; st.confirm = null; paintConfirm(); if (c) mediaAction(c.mediaId, 'purge', c.from); return; }
    const dup = b.closest('.uc-gl-dup')?.dataset.dup;
    if (dup && /^keep-(first|second|both)$/.test(act)) { b.disabled = true; dupAction(dup, act); return; }
    if (!id) return;
    if (act === 'pick') { const it = st.items.find((x) => x.mediaId === id); if (it) pick(it); return; }
    if (act === 'menu') { st.menu = st.menu === id ? null : id; paintBody(); return; }
    if (act === 'unapprove') { st.menu = null; mediaAction(id, 'unapprove', 'lib'); return; }
    if (act === 'purge-ask') { st.menu = null; st.confirm = { mediaId: id, from: st.tab }; paintBody(); return; }
    if (act === 'approve' || act === 'vault') { b.disabled = true; mediaAction(id, act, 'rej'); }
  });
  let searchT = null;
  search.addEventListener('input', () => {
    if (searchT) win.clearTimeout(searchT);
    searchT = win.setTimeout(() => { st.q = search.value; st.cursor = null; loadLibrary(); }, 250);
  });
  search.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { if (search.value) { search.value = ''; st.q = ''; loadLibrary(); } else pane.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); } });
  body.addEventListener('scroll', () => {
    if (body.scrollTop + body.clientHeight < body.scrollHeight - 80) return;
    if (st.tab === 'lib' && st.cursor && !st.loading) loadLibrary({ more: true });
    if (st.tab === 'rej' && st.rejBefore && !st.rejLoading) loadRejected({ more: true });
  }, { passive: true });

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
      if (st.channel && st.channel !== ch()) { st.loaded = false; st.rejLoaded = false; st.dupsLoaded = false; st.items = []; st.rej = []; st.dups = []; st.token = null; }
      paintBody();
      if (!st.loaded) loadLibrary();
      if (isMod() && !st.dupsLoaded) loadDuplicates();
      if (st.tab === 'rej' && !st.rejLoaded) loadRejected();
      refreshReward?.();
      arm();
      if (!(typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) && st.tab === 'lib') search.focus();
    },
    hide() { st.visible = false; st.menu = null; st.confirm = null; arm(); },
    /** Stav odměny / role se změnil → hlavička, pásek, taby. */
    update() {
      if (!isMod() && (st.tab === 'rej' || st.dups.length)) { st.tab = 'lib'; st.dups = []; st.dupsLoaded = false; }
      if (st.visible) { paintBody(); if (isMod() && !st.dupsLoaded) loadDuplicates(); } else paintReward();
      arm();
    },
    /** Přepnutí kanálu: data pryč, při dalším zobrazení znovu. */
    reset() {
      Object.assign(st, { items: [], cursor: null, loaded: false, rej: [], rejBefore: null, rejLoaded: false, dups: [], dupsLoaded: false, token: null, tokenRetried: false, menu: null, confirm: null, tab: isMod() ? st.tab : 'lib' });
      if (st.visible) this.show(); else paintReward();
    },
    reload() { st.loaded = false; if (st.visible) loadLibrary(); },
    state: () => ({ tab: st.tab, items: st.items.length, rejected: st.rej.length, duplicates: st.dups.length }),
    destroy() { if (timer) win.clearInterval(timer); timer = null; pane.replaceChildren(); },
  };
}

