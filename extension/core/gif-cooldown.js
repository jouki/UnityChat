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
//  - Mod / broadcaster (server vrátí `mod: true`) cooldown nemá — kromě Dev módu (`review`), kde se počítá jako divák.
//
// Bez chrome.*: DOM přes injektovaný `doc`, síť přes injektované `api(path)` (hostitel přidá Bearer).
import { hasGifLink } from './gif-links.js';
import { normalizeGifDecided } from './gif.js';

/** Jak dlouho platí stav bez cooldownu (pak se při dalším GIF odkazu zeptá znovu). */
export const GIF_STATE_TTL_MS = 60_000;
export const GIF_COOLDOWN_TICK_MS = 100;

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
  return {
    allowed: j.allowed === true,
    until: j.cooldownUntil != null && Number.isFinite(cd) ? cd + shift : null,
    sec: Number.isFinite(sec) && sec > 0 ? Math.min(sec, 86_400) : 0,
    mod: j.mod === true,
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
  constructor({ doc = globalThis.document, host, input = null, api, channel, platform, review, enabled, now, log, setInterval: si, clearInterval: ci } = {}) {
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
    this._state = null;     // { key, allowed, until, sec, mod, at, total }
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
    if (!s || s.mod || s.until === null) return 0;
    return Math.max(0, s.until - this.now());
  }

  get visible() { return !!this.el && !this.el.hidden; }
  get blocked() { return this._blocked && this.visible; }

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
        const st = normalizeGifState(j, this.now());
        if (!st || key !== this._key()) return null;
        this._state = { ...st, key, total: st.until !== null ? Math.max(st.sec * 1000, st.until - this.now()) : 0 };
        this._L(`stav ${pl} allowed=${st.allowed}${st.mod ? ' mod' : ''} zbývá=${Math.ceil(this.remainingMs() / 1000)} s (cd ${st.sec} s)${review ? ' review' : ''}`);
        this._update();
        return this._state;
      })
      .catch((e) => { this._L(`stav FAIL ${e?.status || 0} ${e?.error || e?.message || e}`); return null; })
      .finally(() => { this._inflight = null; });
    return this._inflight;
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

  /** Zpráva s GIF odkazem odešla → cooldown lokálně z cooldownSec (mod bez Dev módu ne). */
  onSent(text) {
    if (!hasGifLink(text)) return;
    const s = this._fresh();
    if (!s || !s.allowed || s.mod || !s.sec) return;
    s.until = this.now() + s.sec * 1000;
    s.total = s.sec * 1000;
    this._L(`GIF odeslán → cooldown ${s.sec} s lokálně`);
  }

  /** gif-decided (vlastní žádost): schváleno = cooldown od teď; zamítnuto / propadlo = cooldown pryč (znovu se zeptá). */
  onDecided(d) {
    const x = normalizeGifDecided(d);
    if (!x || !x.own) return;
    if (String(x.channel) !== String(this.channel() || '').toLowerCase()) return;
    if (x.approved) {
      const s = this._state;
      if (s && !s.mod && s.sec) { s.until = this.now() + s.sec * 1000; s.total = s.sec * 1000; s.at = this.now(); }
    } else {
      this._state = null;
      this._blocked = false;
      this._hide();
    }
    this._L(`vlastní GIF ${x.status}`);
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
