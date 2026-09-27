// Odměna „Posílání GIFů" — bublina cooldownu nad polem pro psaní (UX 2026-09-25). Sdílené addonem i webem.
//
//  - V poli je odkaz na GIF (core/gif-links.js, stejný detektor jako server) a uživatel má běžící cooldown
//    odměny → nad polem bublina s kolečkem a počtem sekund (vzhled = odpočet QR dona, `.uc-qd-ring`
//    z qr-dono.css). Po doběhnutí zmizí.
//  - Odeslání GIFu během cooldownu: zpráva se neodešle (checkSend → false), pole zčervená a bublina
//    červeně „Můžeš až za:". Bez GIF odkazu posílání normálně funguje.
//  - Stav: GET /gif/state?channel=&platform=[&review=1] (Bearer) při prvním GIF odkazu v poli, cache do konce
//    cooldownu (jinak 60 s). Po odeslání GIFu se cooldown nastaví lokálně z `cooldownSec`; zamítnutí /
//    propadnutí vlastní žádosti (gif-decided own) ho zruší, schválení ho obnoví od teď.
//  - Mod / broadcaster bez výjimky (spec 2026-09-27-gif-review-upravy §5): odměnu i cooldown má ze Židolišty jako divák;
//    `review` (Dev mód) se dál posílá jen kvůli schvalování jako divák.
//
// Bez chrome.*: DOM přes injektovaný `doc`, síť přes injektované `api(path)` (hostitel přidá Bearer).
import { hasGifLink } from './gif-links.js';
import { normalizeGifDecided } from './gif.js';

/** Jak dlouho platí stav bez cooldownu (pak se při dalším GIF odkazu zeptá znovu). */
export const GIF_STATE_TTL_MS = 60_000;
export const GIF_COOLDOWN_TICK_MS = 100;
/**
 * SSE `gif-access-change` (webhook Židolišty `gif-access`, bod 3 testu 2026-09-27): klienti se ptají rozprostřeně
 * v 0–2 s, ať GET /gif/state (a za ním gif-access Židolišty) nedostane všechny otevřené panely najednou.
 */
export const GIF_ACCESS_REFETCH_SPREAD_MS = 2000;

/** Text bubliny: běžně „GIF můžeš poslat za", po pokusu o odeslání červeně „Můžeš až za:". */
export function gifCooldownText(blocked) {
  return blocked ? 'Můžeš až za:' : 'GIF můžeš poslat za';
}

/** Kolečko: `deg` (uplynulá část cooldownu, 0–360) a číslo sekund uvnitř (nahoru, nejméně 1). */
export function gifCooldownRing(remainingMs, totalMs) {
  const rem = Math.max(0, Number(remainingMs) || 0);
  const total = Math.max(rem, Number(totalMs) || 0, 1);
  return { deg: Math.round((1 - rem / total) * 36000) / 100, sec: Math.max(1, Math.ceil(rem / 1000)) };
}

/** Odpověď GET /gif/state → stav v lokálním čase (posun hodin přes serverNow). */
export function normalizeGifState(j, localNow) {
  if (!j || typeof j !== 'object' || j.ok === false) return null;
  const serverNow = Number(j.serverNow);
  const shift = Number.isFinite(serverNow) ? localNow - serverNow : 0;
  const cd = Number(j.cooldownUntil);
  const sec = Number(j.cooldownSec);
  // Konec odměny (indikátor — časový pásek jako u soundboardu): server posílá `rewardUntil`; délku odměny
  // (`rewardTotalMs` / `rewardSec`) zatím ne → GifCooldown._rewardTotalFallback.
  const ru = Number(j.rewardUntil ?? j.until);
  const rTotal = Number(j.rewardTotalMs ?? (Number(j.rewardSec) * 1000));
  return {
    allowed: j.allowed === true,
    until: j.cooldownUntil != null && Number.isFinite(cd) ? cd + shift : null,
    sec: Number.isFinite(sec) && sec > 0 ? Math.min(sec, 86_400) : 0,
    mode: j.mode === 'approved' ? 'approved' : 'all',
    rewardUntil: (j.rewardUntil ?? j.until) != null && Number.isFinite(ru) ? ru + shift : null,
    rewardTotalMs: Number.isFinite(rTotal) && rTotal > 0 ? rTotal : null,
    at: localNow,
  };
}

export class GifCooldown {
  /**
   * @param {object} o
   * @param {Document} [o.doc]
   * @param {HTMLElement} o.host      kotva bubliny (position: relative), např. #input-area
   * @param {HTMLElement} [o.input]   pole pro psaní (dostane `uc-gif-input-blocked`)
   * @param {(path: string) => Promise<any>} o.api  backend s Bearer; chyba = throw
   * @param {() => string} o.channel  UC kanál (Twitch login streamera)
   * @param {() => string} o.platform platforma, kam uživatel píše
   * @param {() => boolean} [o.review] Dev mód moda → počítat jako divák
   * @param {() => boolean} [o.enabled] přihlášený (bez účtu se neptá)
   * @param {() => number} [o.now]
   * @param {(tag: string, text: string) => void} [o.log]
   */
  constructor({ doc = globalThis.document, host, input = null, api, channel, platform, review, enabled, now, log, onState, setInterval: si, clearInterval: ci, setTimeout: sto, clearTimeout: cto } = {}) {
    /** Nový stav odměny (GIF záložka, indikátor). */
    this.onState = onState || (() => {});
    this.doc = doc;
    this.host = host;
    this.input = input;
    this.api = api;
    this.channel = channel || (() => '');
    this.platform = platform || (() => '');
    this.review = review || (() => false);
    this.enabled = enabled || (() => true);
    this.now = now || (() => Date.now());
    this.log = log || (() => {});
    const w = doc?.defaultView || globalThis;
    this._si = si || w.setInterval.bind(w);
    this._ci = ci || w.clearInterval.bind(w);
    this._sto = sto || w.setTimeout.bind(w);
    this._cto = cto || w.clearTimeout.bind(w);
    this._accessT = null;   // naplánované načtení po SSE gif-access-change
    this._state = null;     // { key, allowed, until, sec, at, total }
    this._inflight = null;
    this._text = '';
    this._blocked = false;
    this._timer = null;
    this.el = null;
  }

  _L(t) { this.log('Gif', `cooldown: ${t}`); }
  _key() { return `${String(this.channel() || '').toLowerCase()}|${this.platform() || ''}|${this.review() ? 1 : 0}`; }

  /** Stav pro aktuální kanál / platformu / režim, pokud ještě platí. */
  _fresh() {
    const s = this._state;
    if (!s || s.key !== this._key()) return null;
    const now = this.now();
    if (s.until !== null && s.until > now) return s;
    return now - s.at < GIF_STATE_TTL_MS ? s : null;
  }

  /** Zbývá do konce cooldownu (ms), 0 = bez cooldownu / neznámé. */
  remainingMs() {
    const s = this._fresh();
    if (!s || s.until === null) return 0;
    return Math.max(0, s.until - this.now());
  }

  /**
   * Stav odměny pro GIF záložku / indikátor (core/gif-library.js gifRewardView): { allowed, until, sec, mode,
   * rewardUntil, rewardTotalMs } v lokálním čase, nebo null (neznámý / jiný kanál / propadlý).
   */
  snapshot() {
    // Jen shoda kanálu / platformy (ne 60s čerstvost): časy (cooldown, konec odměny) se počítají proti hodinám.
    const s = this._state && this._state.key === this._key() ? this._state : null;
    if (!s) return null;
    return { allowed: s.allowed, until: s.until, sec: s.sec, mode: s.mode, rewardUntil: s.rewardUntil, rewardTotalMs: s.rewardTotalMs || this._rewardTotalFallback(s) };
  }

  /**
   * Židolišta posílá jen konec odměny, ne její délku → délka = od chvíle, kdy jsme tento konec poprvé viděli
   * (pásek začne plný a ubývá). Nový konec (> 2 s rozdíl, nová odměna) = nový začátek.
   */
  _rewardTotalFallback(s) {
    if (!Number.isFinite(s.rewardUntil)) { this._rewardSeen = null; return null; }
    const seen = this._rewardSeen;
    if (!seen || Math.abs(seen.until - s.rewardUntil) > 2000) this._rewardSeen = { until: s.rewardUntil, start: Math.min(s.at, this.now()) };
    const total = s.rewardUntil - this._rewardSeen.start;
    return total > 0 ? total : null;
  }

  get visible() { return !!this.el && !this.el.hidden; }
  get blocked() { return this._blocked && this.visible; }

  /**
   * Posun hodin klienta vůči serveru (lokální − serverový, ms) z posledního GET /gif/state; 0 = neznámý.
   * Karty modů a štítky odesílatele jím převádějí `expiresAt` serveru, když událost nenese `serverNow` (audit F1).
   */
  serverOffset() { return Number.isFinite(this._shift) ? this._shift : 0; }

  /** Zeptat se na stav jen když není čerstvý (GET /gif/state má rate limit) — pro hostitele místo `_fresh()`. */
  refreshIfStale() { return this._fresh() ? Promise.resolve(this._state) : this.fetchState(); }

  /** GET /gif/state (jeden souběžný dotaz). */
  fetchState() {
    if (this._inflight) return this._inflight;
    const ch = String(this.channel() || '').toLowerCase();
    const pl = this.platform();
    if (!ch || !pl || !this.api || !this.enabled()) return Promise.resolve(null);
    const key = this._key();
    const review = this.review();
    const qs = `channel=${encodeURIComponent(ch)}&platform=${encodeURIComponent(pl)}${review ? '&review=1' : ''}`;
    this._inflight = Promise.resolve()
      .then(() => this.api(`/gif/state?${qs}`))
      .then((j) => {
        const sn = Number(j?.serverNow);
        if (Number.isFinite(sn) && sn > 0) this._shift = this.now() - sn;
        const st = normalizeGifState(j, this.now());
        if (!st || key !== this._key()) return null;
        this._state = { ...st, key, total: st.until !== null ? Math.max(st.sec * 1000, st.until - this.now()) : 0 };
        this._L(`stav ${pl} allowed=${st.allowed} zbývá=${Math.ceil(this.remainingMs() / 1000)} s (cd ${st.sec} s)${review ? ' review' : ''}`);
        this._update();
        try { this.onState(this.snapshot()); } catch { /* ignore */ }
        return this._state;
      })
      .catch((e) => { this._L(`stav FAIL ${e?.status || 0} ${e?.error || e?.message || e}`); return null; })
      .finally(() => { this._inflight = null; });
    return this._inflight;
  }

  /**
   * SSE `gif-access-change { channel }` — odemčení GIFů se v Židolištce změnilo (aktivace / konec odměny, časovač).
   * Stav se jinak ptá jen na akci uživatele (otevření záložky, GIF v poli) → pásek a tooltip u ikony emotů by se
   * ukázaly až po proklikání. Načte GET /gif/state znovu (i čerstvý) se zpožděním `delayMs` (výchozí náhodně 0–2 s);
   * víc událostí za sebou = jeden dotaz. Cizí kanál / nepřihlášený nic.
   */
  onAccessChange(d, { delayMs = Math.random() * GIF_ACCESS_REFETCH_SPREAD_MS } = {}) {
    const ch = String(d?.channel || '').toLowerCase();
    if (!ch || ch !== String(this.channel() || '').toLowerCase() || !this.enabled()) return false;
    if (this._accessT) return true;
    this._L(`gif-access-change → stav znovu za ${Math.round(delayMs)} ms`);
    this._accessT = this._sto(() => { this._accessT = null; void this.fetchState(); }, Math.max(0, delayMs));
    return true;
  }

  /** Změna textu v poli (input / paste). */
  onInput(text) {
    this._text = String(text || '');
    if (!this.enabled() || !hasGifLink(this._text)) { this._blocked = false; this._hide(); return; }
    if (!this._fresh()) { this.fetchState(); return; }
    this._update();
  }

  /**
   * Před odesláním (Enter / tlačítko): true = odeslat. GIF odkaz během cooldownu → false, pole zčervená
   * a bublina napíše „Můžeš až za:". Neznámý stav neblokuje (rozhodne server), jen se na něj zeptá.
   */
  checkSend(text) {
    const t = String(text || '');
    if (!this.enabled() || !hasGifLink(t)) return true;
    const rem = this.remainingMs();
    if (rem <= 0) { if (!this._fresh()) this.fetchState(); return true; }
    this._text = t;
    this._blocked = true;
    this._L(`odeslání zablokováno, zbývá ${Math.ceil(rem / 1000)} s`);
    this._update();
    return false;
  }

  /** Zpráva s GIF odkazem odešla → cooldown lokálně z cooldownSec (i mod). */
  onSent(text) {
    if (!hasGifLink(text)) return;
    const s = this._fresh();
    if (!s || !s.allowed || !s.sec) return;
    s.until = this.now() + s.sec * 1000;
    s.total = s.sec * 1000;
    this._L(`GIF odeslán → cooldown ${s.sec} s lokálně`);
    try { this.onState(this.snapshot()); } catch { /* ignore */ }
  }

  /** gif-decided (vlastní žádost): schváleno = cooldown od teď; zamítnuto / propadlo = cooldown pryč (znovu se zeptá). */
  onDecided(d) {
    const x = normalizeGifDecided(d);
    if (!x || !x.own) return;
    if (String(x.channel) !== String(this.channel() || '').toLowerCase()) return;
    if (x.approved) {
      const s = this._state;
      if (s && s.sec) { s.until = this.now() + s.sec * 1000; s.total = s.sec * 1000; s.at = this.now(); }
    } else {
      this._state = null;
      this._blocked = false;
      this._hide();
    }
    this._L(`vlastní GIF ${x.status}`);
    try { this.onState(this.snapshot()); } catch { /* ignore */ }
  }

  /**
   * Konec cooldownu ze serveru (čas SERVERU + `serverNow`): `done` approved u tichého schválení (mod / GIF z knihovny —
   * gif-decided nejde) a gif-notice cooldown (test2 bod 4.1). Přebíjí lokální odhad z cooldownSec (mod ho má často 0,
   * globální cooldown chatu klient z cooldownSec nezná). null = server cooldown nehlásí → beze změny.
   */
  onServerCooldown(until, serverNow) {
    const u = Number(until);
    if (until == null || !Number.isFinite(u)) return;
    const sn = Number(serverNow);
    const local = u + (Number.isFinite(sn) && sn > 0 ? this.now() - sn : this.serverOffset());
    const now = this.now();
    if (local <= now) return;
    let s = this._state && this._state.key === this._key() ? this._state : null;
    // Stav ještě neznámý (GIF z jiného zařízení / bez GET /gif/state): cooldown platí, zbytek se načte později (at 0).
    if (!s) s = this._state = { key: this._key(), allowed: true, until: null, sec: 0, mode: 'all', rewardUntil: null, rewardTotalMs: null, at: 0, total: 0 };
    s.until = local;
    s.total = Math.max(local - now, (s.sec || 0) * 1000);
    this._L(`cooldown ze serveru → zbývá ${Math.ceil((local - now) / 1000)} s`);
    this._update();
    try { this.onState(this.snapshot()); } catch { /* ignore */ }
  }

  /** Přepnutí kanálu / platformy / odhlášení. */
  reset() {
    this._state = null;
    this._inflight = null;
    this._blocked = false;
    this._hide();
  }

  destroy() { this.reset(); this.el?.remove(); this.el = null; }

  // ---- DOM ----

  _update() {
    const rem = this.remainingMs();
    if (!this.enabled() || !hasGifLink(this._text) || rem <= 0) { this._blocked = false; this._hide(); return; }
    this._show();
  }

  _root() {
    if (this.el && this.el.isConnected) return this.el;
    const el = this.doc.createElement('div');
    el.className = 'uc-gif-cd';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.hidden = true;
    const text = this.doc.createElement('span');
    text.className = 'uc-gif-cd-text';
    // Kolečko = stejná komponenta jako odpočet QR dona (qr-dono.css .uc-qd-ring).
    const ring = this.doc.createElement('span');
    ring.className = 'uc-qd-ring uc-gif-cd-ring';
    ring.append(this.doc.createElement('i'), this.doc.createElement('em'));
    el.append(text, ring);
    this.host?.appendChild(el);
    this.el = el;
    return el;
  }

  _show() {
    const el = this._root();
    el.hidden = false;
    el.classList.toggle('uc-gif-cd--blocked', this._blocked);
    el.querySelector('.uc-gif-cd-text').textContent = gifCooldownText(this._blocked);
    this.input?.classList.toggle('uc-gif-input-blocked', this._blocked);
    this._paintRing();
    if (!this._timer) this._timer = this._si(() => this._tick(), GIF_COOLDOWN_TICK_MS);
  }

  _hide() {
    if (this._timer) { this._ci(this._timer); this._timer = null; }
    if (this.el) this.el.hidden = true;
    this.input?.classList.remove('uc-gif-input-blocked');
  }

  _tick() {
    if (this.remainingMs() <= 0) { this._L('cooldown doběhl'); this._blocked = false; this._hide(); return; }
    this._paintRing();
  }

  _paintRing() {
    const el = this.el;
    if (!el) return;
    const s = this._fresh();
    const { deg, sec } = gifCooldownRing(this.remainingMs(), s?.total || (s?.sec || 0) * 1000);
    el.querySelector('.uc-gif-cd-ring i')?.style.setProperty('--deg', `${deg}deg`);
    const em = el.querySelector('.uc-gif-cd-ring em');
    if (em) em.textContent = String(sec);
    el.classList.toggle('uc-gif-cd--long', sec >= 100);
    el.setAttribute('aria-label', `${gifCooldownText(this._blocked)} ${sec} s`);
  }
}
