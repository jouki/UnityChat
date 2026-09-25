// Moderace — sdílený vzhled smazané/skryté zprávy napříč addonem, webem i OBS.
// „Smazáno" = moderátorská akce na platformě (timeout/ban/delete/CLEARCHAT
// nebo CLEARMSG), „skryto" = UnityChat zprávu jen lokálně schová bez zásahu
// na platformě („Jen UC skrýt" — divák jinde v chatu zprávu dál vidí).
//
// Styly pro smazané zprávy (konfigurovatelné, `style` param):
//   'label'  — text zmizí, zůstane kurzívní poznámka (výchozí)
//   'dim'    — text zůstane, jen ztlumený + malý štítek
//   'strike' — text zůstane přeškrtnutý + štítek
//   'hide'   — zpráva úplně zmizí z DOM
//
// Divák: styl podle nastavení; skrytou zprávu nevidí vůbec ('hide'); bez obsahu (historie a stream
// obsah smazané zprávy neposílají) vždy „Zpráva smazána".
// Moderátor (rozhodnutí usera 2026-09-25): smazaná i skrytá zpráva je VŽDY ztlumená a VŽDY má štítek
// („Smazáno" / „Skryto v UnityChatu"); nastavení volí jen přeškrtnutý text ('strike'), ztlumený text
// ('dim') nebo „Zpráva smazána" místo textu ('label'; 'hide' se u moda chová jako 'label' — mod zprávu
// vždy vidí). Text smazané zprávy si mod dotáhne přes `GET /moderation/deleted-content` (DeletedContentLoader).
// `raw` (neanonymizovaný log/audit pohled) = u smazané zprávy vždy 'label' bez ohledu na roli.
//
// Žádné chrome.*, žádný globální DOM — vše se předává přes parametry.

export const DELETED_STYLES = ['label', 'dim', 'strike', 'hide'];
export const DEFAULT_DELETED_STYLE = 'label';

/**
 * Vzhled smazané/skryté zprávy pro daného diváka.
 * @param {{style?: string, isMod?: boolean, raw?: boolean, hidden?: boolean}} opts
 * @returns {{mode: 'label'|'dim'|'strike'|'hide', dimmed: boolean, tag: boolean}}
 *   dimmed = ztlumit zprávu i v režimu 'label', tag = štítek i v režimu 'label' (obojí jen mod)
 */
export function deletedView({ style, isMod, raw, hidden } = {}) {
  if (isMod && (hidden || !raw)) {
    const mode = style === 'strike' || style === 'dim' ? style : 'label';
    return { mode, dimmed: true, tag: true };
  }
  if (hidden) return { mode: 'hide', dimmed: false, tag: false };
  if (raw) return { mode: 'label', dimmed: false, tag: false };
  return { mode: DELETED_STYLES.includes(style) ? style : DEFAULT_DELETED_STYLE, dimmed: false, tag: false };
}

/**
 * Režim zobrazení (jen `mode` z deletedView — pro volající, kteří řeší jen „je text vidět?").
 * @returns {'label'|'dim'|'strike'|'hide'}
 */
export function deletedMode(opts = {}) {
  return deletedView(opts).mode;
}

/**
 * Aplikuje vizuální stav smazané/skryté zprávy na DOM element. Idempotentní —
 * opakované volání se stejnými (nebo jinými) opts nezdvojí štítky ani labely.
 * Nikdy nepoužívá innerHTML s nedůvěryhodným textem (jen textContent).
 * @param {HTMLElement} el       kořenový element zprávy (`.msg`)
 * @param {{mode: string, label?: string, hasContent?: boolean, hidden?: boolean, dimmed?: boolean, tag?: boolean}} opts
 *   dimmed/tag = z deletedView (mod: ztlumení + štítek i u „Zpráva smazána")
 */
export function applyDeleted(el, opts = {}) {
  if (!el) return;
  const { mode: rawMode, hasContent = true, hidden = false, dimmed = false, tag: forceTag = false } = opts;
  const label = opts.label || (hidden ? 'Zpráva skryta' : 'Zpráva smazána');
  const mode = DELETED_STYLES.includes(rawMode) ? rawMode : DEFAULT_DELETED_STYLE;

  if (mode === 'hide') {
    // Nejdřív smazat případný předchozí stav (tag/jiné mode třídy, obal emotů), pak schovat.
    clearDeleted(el);
    el.classList.add('uc-deleted', 'uc-deleted--hide');
    el.hidden = true;
    return;
  }

  el.hidden = false;
  for (const m of DELETED_STYLES) el.classList.remove(`uc-deleted--${m}`);
  el.classList.add('uc-deleted', `uc-deleted--${mode}`);
  if (dimmed) el.classList.add('uc-deleted--dimmed');
  else el.classList.remove('uc-deleted--dimmed');

  const doc = el.ownerDocument || (typeof document !== 'undefined' ? document : null);
  const q = (sel) => (typeof el.querySelector === 'function' ? el.querySelector(sel) : null);
  const showLabel = mode === 'label' || !hasContent;
  // Štítek: vždy u dim/strike s textem; u „Zpráva smazána" jen když ho chce volající (mod).
  const showTag = forceTag || !showLabel;

  if (showLabel) {
    const tx = q('.tx');
    if (tx && doc) {
      const span = doc.createElement('span');
      span.className = 'uc-deleted-label';
      span.textContent = label;
      if (typeof tx.replaceChildren === 'function') tx.replaceChildren(span);
      else { tx.textContent = ''; tx.appendChild(span); }
    }
  } else if (mode === 'strike') {
    wrapStrikeEmotes(q('.tx'), doc);
  } else {
    // Přepnutí stylu ze „strike“ na „dim“: obal emotů už není potřeba.
    unwrapStrikeEmotes(q('.tx'));
  }

  let tagEl = q('.uc-deleted-tag');
  if (!showTag) {
    // „Zpráva smazána" u diváka nahrazuje text — samostatný štítek by byl nadbytečný.
    if (tagEl && typeof tagEl.remove === 'function') tagEl.remove();
  } else {
    if (!tagEl && doc) {
      tagEl = doc.createElement('span');
      tagEl.className = 'uc-deleted-tag';
      el.appendChild(tagEl);
    }
    if (tagEl) tagEl.textContent = hidden ? 'Skryto v UnityChatu' : 'Smazáno';
  }
}

/**
 * Přeškrtnutí přes emoty: `text-decoration` se přes obrázky (atomické inline prvky) nekreslí, proto se
 * samostatný emote obalí do `.uc-strike-emote` (vrstvený `.emote-stack` obal už má) a čáru kreslí
 * CSS pseudo-element. Idempotentní; obal po změně režimu nevadí (CSS platí jen pod `uc-deleted--strike`).
 */
function wrapStrikeEmotes(tx, doc) {
  if (!tx || !doc || typeof tx.querySelectorAll !== 'function') return;
  for (const img of tx.querySelectorAll('img.emote')) {
    const parent = img.parentNode;
    if (!parent || parent.classList?.contains('emote-stack') || parent.classList?.contains('uc-strike-emote')) continue;
    const wrap = doc.createElement('span');
    wrap.className = 'uc-strike-emote';
    parent.insertBefore(wrap, img);
    wrap.appendChild(img);
  }
}

/** Opak wrapStrikeEmotes: emote zpátky na místo obalu `.uc-strike-emote`, obal pryč. Idempotentní. */
function unwrapStrikeEmotes(tx) {
  if (!tx || typeof tx.querySelectorAll !== 'function') return;
  for (const wrap of tx.querySelectorAll('.uc-strike-emote')) {
    const parent = wrap.parentNode;
    if (!parent) continue;
    while (wrap.firstChild) parent.insertBefore(wrap.firstChild, wrap);
    wrap.remove();
  }
}

/**
 * Vrátí element do stavu před `applyDeleted` — odstraní `uc-deleted*` třídy, obal emotů `.uc-strike-emote`,
 * štítek a `hidden`. Obnovu původního obsahu `.tx` (odstraněného v 'label'
 * režimu) NEDĚLÁ — to je na hostu, který zprávu znovu vykreslí z dat (stejný
 * princip jako u ChatStore: DOM se nepatchuje, znovu se vyrenderuje).
 * @param {HTMLElement} el
 */
export function clearDeleted(el) {
  if (!el) return;
  el.classList.remove('uc-deleted', 'uc-deleted--dimmed');
  for (const m of DELETED_STYLES) el.classList.remove(`uc-deleted--${m}`);
  const tag = typeof el.querySelector === 'function' ? el.querySelector('.uc-deleted-tag') : null;
  if (tag && typeof tag.remove === 'function') tag.remove();
  unwrapStrikeEmotes(typeof el.querySelector === 'function' ? el.querySelector('.tx') : null);
  el.hidden = false;
}

/** Max klíčů v jednom `GET /moderation/deleted-content` (stejný limit jako server). */
export const DELETED_CONTENT_BATCH = 100;

/**
 * Dávkové dotažení obsahu smazaných/skrytých zpráv pro moda (`GET /moderation/deleted-content`).
 * Požadavky se sbírají `delayMs` (250 ms), na klíč se ptá jen jednou (dedup), max DELETED_CONTENT_BATCH
 * klíčů na dotaz. `onContent(msg)` dostane plný tvar zprávy (jako /chat/history + deleted/hidden).
 * Chyba sítě/serveru klíče uvolní pro další pokus; 403 (už není mod) ne. `reset()` = přepnutí kanálu.
 *
 * @param {{ api: (path: string) => Promise<any>, channel: () => string, onContent: (msg: object) => void,
 *           delayMs?: number, log?: (tag: string, text: string) => void,
 *           setTimeout?: Function, clearTimeout?: Function }} opts
 *   api = GET na backend s Bearer tokenem, vrací JSON, chybu hází s `.status`
 */
export class DeletedContentLoader {
  constructor(opts) {
    this.api = opts.api;
    this.channel = opts.channel;
    this.onContent = opts.onContent;
    this.delayMs = opts.delayMs ?? 250;
    this.log = opts.log || (() => {});
    this._setTimeout = opts.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = opts.clearTimeout || ((t) => clearTimeout(t));
    this._asked = new Set();
    this._queue = [];
    this._timer = null;
    this._gen = 0;
  }

  /** Zařadí zprávu k dotažení (jednou za kanál). Vrací true, když se opravdu zařadila. */
  request(platform, id) {
    if (!platform || id == null || id === '') return false;
    const key = `${platform}:${id}`;
    if (this._asked.has(key)) return false;
    this._asked.add(key);
    this._queue.push(key);
    if (!this._timer) this._timer = this._setTimeout(() => { this._timer = null; this.flush(); }, this.delayMs);
    return true;
  }

  /** Odešle frontu hned (po dávkách). Vrací počet dotažených zpráv. */
  async flush() {
    if (this._timer) { this._clearTimeout(this._timer); this._timer = null; }
    const gen = this._gen;
    let got = 0;
    while (this._queue.length) {
      const keys = this._queue.splice(0, DELETED_CONTENT_BATCH);
      const channel = String(this.channel() || '').toLowerCase();
      let res;
      try {
        res = await this.api(`/moderation/deleted-content?channel=${encodeURIComponent(channel)}&ids=${encodeURIComponent(keys.join(','))}`);
      } catch (e) {
        if (gen !== this._gen) return got;
        // 403 = už není mod → neopakovat; jinak klíče uvolnit (další vykreslení to zkusí znovu).
        if (e?.status !== 403) for (const k of keys) this._asked.delete(k);
        this.log('Mod', `deleted-content FAIL ${e?.status || 0} ${e?.error || e?.message || e} (${keys.length} zpráv)`);
        continue;
      }
      if (gen !== this._gen) return got;   // mezitím přepnutý kanál — odpověď patří starému
      const msgs = res?.messages && typeof res.messages === 'object' ? res.messages : {};
      let n = 0;
      for (const k of keys) {
        const m = msgs[k];
        if (!m || typeof m !== 'object') continue;
        n++;
        try { this.onContent(m); } catch (e) { this.log('Mod', `deleted-content onContent ${k}: ${e?.message || e}`); }
      }
      got += n;
      this.log('Mod', `deleted-content ${channel}: ${n}/${keys.length} s obsahem`);
    }
    return got;
  }

  /** Nový kanál / odhlášení / ztráta role: zapomenout dotazy i frontu, rozpracovaná odpověď se zahodí. */
  reset() {
    this._gen++;
    if (this._timer) { this._clearTimeout(this._timer); this._timer = null; }
    this._queue = [];
    this._asked.clear();
  }
}

// ---- Část 2: timeout / ban uživatele (SSE user-moderated, Twitch CLEARCHAT) ----

/** Délka v sekundách → „5 s", „1 min", „2 h", „3 dny" (hlášky a štítky moderace). */
export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s} s`;
  // Vlastní délky z nabídky moda (90 s, 150 min…): dvě nejvyšší nenulové jednotky, přesně.
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const parts = [];
  if (d) parts.push(`${d} ${d === 1 ? 'den' : d < 5 ? 'dny' : 'dní'}`);
  if (h) parts.push(`${h} h`);
  if (m) parts.push(`${m} min`);
  if (r) parts.push(`${r} s`);
  return parts.slice(0, 2).join(' ');
}

/**
 * Text štítku u zpráv moderovaného uživatele: „Timeout (5 min)" / „Zabanován" / null (unban).
 * Délka timeoutu: `durationSec`, jinak `until - at` (SSE user-moderated), jinak `until - now`.
 * @param {{action: string, until?: number|null, at?: number|string|null, durationSec?: number|null, now?: number}} o
 */
export function modTagText({ action, until = null, at = null, durationSec = null, now = Date.now() } = {}) {
  if (action === 'ban') return 'Zabanován';
  if (action !== 'timeout') return null;
  let sec = Number(durationSec);
  if (!(sec > 0) && until) {
    const from = at ? (typeof at === 'number' ? at : Date.parse(at)) : now;
    sec = (Number(until) - (Number.isFinite(from) ? from : now)) / 1000;
  }
  return sec > 0 ? `Timeout (${fmtDuration(sec)})` : 'Timeout';
}

/**
 * Normalizace SSE `user-moderated` (a lokálního Twitch CLEARCHAT) — null = neplatná / cizí kanál.
 * @param {object} d  { channel, platform, userId, login, action, until, by, at }
 * @param {string} [channel]  aktuální UC kanál (Twitch login streamera); bez něj se kanál nekontroluje
 */
export function normalizeUserModerated(d, channel) {
  if (!d || typeof d !== 'object') return null;
  if (!['timeout', 'ban', 'unban'].includes(d.action)) return null;
  if (!['twitch', 'kick', 'youtube'].includes(d.platform)) return null;
  if (channel != null && String(d.channel || '').toLowerCase() !== String(channel).toLowerCase()) return null;
  const userId = d.userId != null && d.userId !== '' ? String(d.userId) : null;
  const login = d.login ? String(d.login).toLowerCase().replace(/^@/, '') : null;
  if (!userId && !login) return null;
  return { platform: d.platform, userId, login, action: d.action, until: Number(d.until) || null, at: d.at ?? null, by: d.by ?? null, tag: modTagText(d) };
}

/**
 * Štítek moderace uživatele na zprávě (`.uc-mod-tag`). `text` null = štítek pryč (unban).
 * Idempotentní; se štítkem se schová obecné „Smazáno" (`.uc-mod-tagged`), ať nejsou dva.
 */
export function applyModTag(el, text) {
  if (!el) return;
  const q = typeof el.querySelector === 'function' ? el.querySelector('.uc-mod-tag') : null;
  if (!text) {
    if (q && typeof q.remove === 'function') q.remove();
    el.classList.remove('uc-mod-tagged');
    return;
  }
  let tag = q;
  if (!tag) {
    const doc = el.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) return;
    tag = doc.createElement('span');
    tag.className = 'uc-mod-tag';
    el.appendChild(tag);
  }
  tag.textContent = text;
  el.classList.add('uc-mod-tagged');
}
