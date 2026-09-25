// „Profil“ uživatele (2026-09-25; dřív „Chat historie“ jen pro moda) — sdílený addonem i webem.
// Panel přes chat (overlay v kontejneru chatu, Esc / × zavře, na úzké obrazovce celá šířka).
// Obsah podle toho, co vrátí server (výběr polí dělá backend, `view`):
//   - všichni: jméno v barvě uživatele (+ 7TV paint), přezdívka, badge z poslední zprávy, statistika,
//     suma darů, tlačítko na původní kartu platformy (Twitch / 7TV karta),
//   - mod (`view: 'mod'`): navíc propojené platformy, moderace v kanálu, záložky kanálů a stránkovaný
//     log zpráv s oddělovači dnů, citacemi odpovědí, řádky QR donů a ikonami akcí moda u zpráv.
// Kontrakt backendu: docs/superpowers/plans/2026-09-25-moderace-cast-2-kontrakt.md („Profil“).
//
// Host dodá DOM (`doc`), `api(path, { method })` → JSON (throw { error, status }), kontejner chatu a funkce
// chatu pro vykreslení (tělo zprávy, badge, citace odpovědi, barva jména) — panel nemá vlastní kopie.
// Cizí text (jména, důvody, zprávy donů) jen přes textContent. Žádné chrome.*, žádné globální stavy.

import { fmtDuration, deletedView, applyDeleted, applyModTag, modTagText, EYE_ICON_SVG, RESTORE_TITLE } from './moderation.js';
import { PLATFORM_NAMES } from './soundboard.js';
import { escapeHtml } from './html.js';
import { modErrorText, openModDialog, PLATFORM_LOC } from './mod-menu.js';
import { CURRENCIES } from './qr-dono.js';

export const HISTORY_PAGE = 50;
const enc = encodeURIComponent;
const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i;
const NBSP = ' ';

/** Český plurál: 1 → one, 2–4 → few, jinak many (0, 5+, zlomky). */
export function czPlural(n, one, few, many) {
  const a = Math.abs(Number(n) || 0);
  if (a === 1) return one;
  if (Number.isInteger(a) && a >= 2 && a <= 4) return few;
  return many;
}

/** Celé číslo / částka s mezerou po tisících (nezlomitelnou) a desetinnou čárkou: 1 250 · 12,5. */
export function fmtNumber(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const [int, frac] = Math.abs(v).toFixed(2).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  const dec = frac === '00' ? '' : `,${frac.replace(/0$/, '')}`;
  return `${v < 0 ? '−' : ''}${grouped}${dec}`;
}

/** 1 zpráva / 3 zprávy / 12 zpráv (tisíce s mezerou). */
export function fmtMsgCount(n) {
  const v = Number(n) || 0;
  return `${fmtNumber(v)} ${czPlural(v, 'zpráva', 'zprávy', 'zpráv')}`;
}

const pad = (n) => String(n).padStart(2, '0');

/** ms → „25. 9. 2026 14:05“ (místní čas). `withTime: false` → jen datum. */
export function fmtDateTime(ms, { withTime = true } = {}) {
  if (ms == null || !Number.isFinite(Number(ms))) return '';
  const d = new Date(Number(ms));
  const date = `${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()}`;
  return withTime ? `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}` : date;
}

/** ms → „14:05“. */
export function fmtTime(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '';
  const d = new Date(Number(ms));
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const WEEKDAYS = ['neděle', 'pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota'];

/** Oddělovač dnů: „čtvrtek 25. 9. 2026“. */
export function fmtDay(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '';
  const d = new Date(Number(ms));
  return `${WEEKDAYS[d.getDay()]} ${fmtDateTime(ms, { withTime: false })}`;
}

/** Klíč dne (místní čas) pro oddělovače. */
export function dayKey(ms) {
  const d = new Date(Number(ms));
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// Kč / € ze stejné tabulky jako formulář QR dona (core/qr-dono.js), ostatní měny jen pro jistotu.
const CURRENCY_SIGN = { USD: '$', GBP: '£', PLN: 'zł', ...Object.fromEntries(Object.values(CURRENCIES).map((c) => [c.code, c.sym])) };

/** 1250, 'CZK' → „1 250 Kč“; 20, 'EUR' → „20 €“. */
export function fmtAmount(n, currency = 'CZK') {
  const c = String(currency || 'CZK').toUpperCase();
  return `${fmtNumber(n)}${NBSP}${CURRENCY_SIGN[c] || c}`;
}

/** { czk, byCurrency: { CZK: 1250, EUR: 20 } } → „1 250 Kč + 20 €“ (Kč první; bez měn → czk). */
export function fmtMoney(total) {
  const by = Object.entries(total?.byCurrency || {}).filter(([, v]) => Number(v) > 0)
    .sort(([a], [b]) => (a === 'CZK' ? -1 : b === 'CZK' ? 1 : a.localeCompare(b)));
  if (!by.length) return fmtAmount(total?.czk || 0, 'CZK');
  return by.map(([c, v]) => fmtAmount(v, c)).join(' + ');
}

/**
 * Suma darů do hlavičky podle tvaru ze serveru. Mod: celkem (+ „z toho … jen podle jména“), divák: jen
 * veřejné `ucNamed` (dona, u kterých se dárce neskrýval). null = nic k zobrazení (Židolišta mlčí / 0 donů).
 * @returns {{main: string, sub: string|null}|null}
 */
export function donationsSummary(don) {
  if (!don || typeof don !== 'object') return null;
  if (don.ucNamed) return don.ucNamed.count > 0 ? { main: `Celkem darováno ${fmtAmount(don.ucNamed.czk, 'CZK')}`, sub: null } : null;
  if (!(don.count > 0) || !don.total) return null;
  const sub = don.guess?.count > 0 ? `z toho ${fmtMoney(don.guess)} jen podle jména` : null;
  return { main: `Celkem darováno ${fmtMoney(don.total)}`, sub };
}

/** Řádek dona v logu: „poslal QR dono 150 Kč“ / „poslal dono přes Fourthwall 20 €“. */
export function donationLine(it) {
  const amt = fmtAmount(it?.amount, it?.currency);
  return it?.via === 'fourthwall' ? `poslal dono přes Fourthwall ${amt}` : `poslal QR dono ${amt}`;
}

/** „twitch:modik“ → „modik (Twitch)“, „zidolista:…“ → „Židolišta“. */
export function actorLabel(by) {
  const s = String(by || '');
  const i = s.indexOf(':');
  if (i < 0) return s || 'neznámý mod';
  const kind = s.slice(0, i), who = s.slice(i + 1);
  if (kind === 'zidolista') return 'Židolišta';
  return PLATFORM_NAMES[kind] ? `${who} (${PLATFORM_NAMES[kind]})` : s;
}

/** Položka moderace → „Timeout 10 min“ / „Ban“ / „Přezdívka „X““ … */
export function modActionLabel(item) {
  const p = item?.params || {};
  switch (item?.action) {
    case 'timeout': return p.durationSec ? `Timeout ${fmtDuration(p.durationSec)}` : 'Timeout';
    case 'ban': return 'Ban';
    case 'unban': return 'Unban';
    case 'warn': return 'Varování';
    case 'permit': return p.durationSec ? `Permit ${fmtDuration(p.durationSec)}` : 'Permit';
    case 'rename': return p.nickname ? `Přezdívka „${p.nickname}“` : 'Přezdívka smazána';
    default: return String(item?.action || '');
  }
}

/**
 * Požadavek na backend (čistá funkce). Cíl podle `userId`, nebo jen podle `login` (citace v odpovědi).
 * @param {'summary'|'messages'|'donations'} kind
 * @param {{channel?: string, platform: string, userId?: string|null, login?: string}} t
 * @param {{inChannel?: string, before?: string|null, limit?: number}} [x]
 */
export function buildHistoryRequest(kind, t, x = {}) {
  const q = [];
  if (t.channel) q.push(`channel=${enc(String(t.channel).toLowerCase())}`);
  q.push(`platform=${enc(t.platform)}`);
  if (t.userId != null && t.userId !== '') q.push(`userId=${enc(String(t.userId))}`);
  if (t.login) q.push(`login=${enc(t.login)}`);
  if (kind === 'summary') return { path: `/moderation/user-history/summary?${q.join('&')}`, method: 'GET' };
  if (kind === 'donations') return { path: `/moderation/user-history/donations?${q.join('&')}`, method: 'GET' };
  if (kind === 'messages') {
    if (x.inChannel) q.push(`inChannel=${enc(String(x.inChannel).toLowerCase())}`);
    if (x.before) q.push(`before=${enc(x.before)}`);
    q.push(`limit=${Number(x.limit) || HISTORY_PAGE}`);
    return { path: `/moderation/user-history/messages?${q.join('&')}`, method: 'GET' };
  }
  throw new Error(`neznámý požadavek ${kind}`);
}

const UC_MARKER = '⠀';
const stripMarker = (s) => String(s).replace(` ${UC_MARKER}`, '').replaceAll(UC_MARKER, '');

/** Zpráva z historie → kopie bez markeru UnityChatu (U+2800) + příznak `uc` (zlaté logo), jako v chatu. */
export function stripUcMarker(m) {
  const has = typeof m?.message === 'string' && m.message.includes(UC_MARKER);
  if (!has) return { msg: m, uc: !!m?.uc };
  const msg = { ...m, message: stripMarker(m.message) };
  if (typeof m.kickContent === 'string') msg.kickContent = stripMarker(m.kickContent);
  return { msg, uc: true };
}

/**
 * Statistika do hlavičky: „Poprvé viděn 20. 9. 2026 · naposledy 25. 9. 2026 14:05 · celkem 11 zpráv“.
 * `channelOnly` (veřejný Profil — jen aktuální kanál) → „V tomto kanálu: poprvé viděn …“.
 */
export function statsText(user, { channelOnly = false } = {}) {
  if (!user) return '';
  const parts = [];
  if (user.firstSeen) parts.push(`${channelOnly ? 'poprvé' : 'Poprvé'} viděn ${fmtDateTime(user.firstSeen, { withTime: false })}`);
  if (user.lastSeen) parts.push(`naposledy ${fmtDateTime(user.lastSeen)}`);
  parts.push(`celkem ${fmtMsgCount(user.total || 0)}`);
  return `${channelOnly ? 'V tomto kanálu: ' : ''}${parts.join(' · ')}`;
}

/** Zpráva jako cíl akce moda (ModMenu) — z řádku Profilu. */
export function messageTarget(m, t) {
  return { channel: t.channel, platform: m.platform, userId: m.userId != null ? String(m.userId) : null, login: m.username || t.login, displayName: m.username || t.displayName || t.login, messageId: m.id != null ? String(m.id) : null };
}

const ICONS = {
  delete: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>',
  timeout: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/></svg>',
  ban: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>',
  permit: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7"/></svg>',
  restore: EYE_ICON_SVG.replace(/width="14" height="14"/, 'width="13" height="13"'),
};
const ACTION_TITLES = { delete: 'Smazat zprávu', restore: RESTORE_TITLE, timeout: 'Timeout…', ban: 'Zabanovat…', permit: 'Permit…' };

const toNode = (doc, v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'object' && v.nodeType) return v;
  const s = doc.createElement('span');
  s.innerHTML = String(v);
  return s;
};

export class UserHistoryPanel {
  /**
   * @param {object} o
   * @param {Document} [o.doc]
   * @param {(path: string, opts: {method?: string}) => Promise<any>} o.api
   * @param {HTMLElement} [o.container]  kontejner chatu (position: relative); jinak body
   * @param {(msg: object) => string} [o.renderMessage]  HTML těla zprávy (render chatu); jinak escapovaný text
   * @param {(msg: object) => string|Node|null} [o.renderBadges]  badge z poslední zprávy (render chatu vč. 7TV)
   * @param {(el: HTMLElement, info: {platform: string, login: string, color: string|null, msg: object|null}) => void} [o.paintName]
   *   barva / 7TV paint jména jako v chatu
   * @param {(msg: object) => string|Node|null} [o.renderReply]  citace odpovědi jako v chatu (bez vlastních handlerů)
   * @param {import('./mod-menu.js').ModMenu} [o.modMenu]  ikony akcí u zpráv (mod) + aktualizace řádků po akci
   * @param {() => string} [o.deletedStyle]  nastavení vzhledu smazaných zpráv (deletedView)
   * @param {(target: object) => void} [o.onPlatformCard]  původní karta uživatele na platformě (Twitch / 7TV)
   * @param {(platform: string, uc?: boolean) => string|null} [o.platformIcon]  URL loga platformy; jinak text
   * @param {(channel: string) => string} [o.channelLabel]  název záložky
   * @param {(tag: string, text: string) => void} [o.log]
   * @param {number} [o.pageSize]
   * @param {(ms: number) => Promise<void>} [o.sleep]  čekání před opakováním po 429 (testy)
   */
  constructor({ doc = globalThis.document, api, container, renderMessage, renderBadges, paintName, renderReply, modMenu, deletedStyle, onPlatformCard, platformIcon, channelLabel, log, pageSize = HISTORY_PAGE, sleep } = {}) {
    this.doc = doc;
    this.api = api;
    this.container = container || null;
    this.renderMessage = renderMessage || ((m) => escapeHtml(m?.message || ''));
    this.renderBadges = renderBadges || null;
    this.paintName = paintName || null;
    this.renderReply = renderReply || null;
    this.modMenu = modMenu || null;
    this.deletedStyle = deletedStyle || (() => 'label');
    this.onPlatformCard = onPlatformCard || null;
    this.platformIcon = platformIcon || (() => null);
    this.channelLabel = channelLabel || ((c) => c);
    this.log = log || (() => {});
    this.pageSize = pageSize;
    this._sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.el = null;
    this.target = null;
    this.summary = null;
    this._serial = 0;
    this._tab = null;
    this._dons = null;
    /** Předchozí profily při přepnutí z citace (tlačítko ‹ zpět, pokyn usera 2026-09-25). */
    this._history = [];
    this._onKey = (e) => {
      if (e.key !== 'Escape' || !this.el) return;
      // Esc jinde (pole pro psaní, našeptávač, …) patří tamtomu prvku, ne panelu.
      if (!(e.target && this.el.contains(e.target))) return;
      // Otevřený dialog / nabídka moda má Esc přednostně.
      if (this.doc.querySelector('.uc-mod-shade, .uc-mod-menu')) return;
      e.preventDefault(); e.stopPropagation(); this.close();
    };
    // Akce moda (i z chatu) → přebarvit řádky v otevřeném Profilu.
    this._unsubResult = this.modMenu?.onResult?.((kind, t, res, x) => this._onModResult(kind, t, res, x)) || null;
  }

  get isOpen() { return !!this.el; }

  /** Pohled ze serveru: 'mod' (plný) / 'public' (divák, nepřihlášený). */
  get view() { return this.summary?.view === 'mod' ? 'mod' : 'public'; }

  /**
   * @param {{channel: string, platform: string, userId?: string|null, login: string, displayName?: string,
   *          nameColor?: string|null, nickname?: string|null}} target  bez userId = cíl podle loginu
   * @param {{keepHistory?: boolean}} [opts]  true = přepnutí uvnitř panelu (historie ‹ zpět zůstává)
   */
  open(target, opts = {}) {
    const keep = !!opts.keepHistory && this.isOpen;
    const history = keep ? this._history : [];
    const prevFocus = keep ? this._returnFocus : null;
    this.close();
    this._history = history;
    const doc = this.doc;
    // Kam vrátit fokus po zavření (nabídka moda už je zavřená → typicky prvek chatu / body).
    const back = doc.activeElement;
    this._returnFocus = keep ? prevFocus : (back && back !== doc.body ? back : null);
    this.target = { ...target };
    this.summary = null;
    this._dons = null;
    const serial = ++this._serial;
    const who = target.displayName || target.login;

    const el = doc.createElement('section');
    el.className = 'uc-uh';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', `Profil: ${who}`);
    el.tabIndex = -1;

    const head = doc.createElement('header');
    head.className = 'uc-uh-head';
    const top = doc.createElement('div');
    top.className = 'uc-uh-top';
    const titles = doc.createElement('div');
    titles.className = 'uc-uh-titles';
    const cap = doc.createElement('span');
    cap.className = 'uc-uh-cap';
    cap.textContent = 'Profil';
    const nameRow = doc.createElement('div');
    nameRow.className = 'uc-uh-namerow';
    const name = doc.createElement('h2');
    name.className = 'uc-uh-name';
    name.textContent = who;
    if (target.nameColor && COLOR_RE.test(String(target.nameColor))) name.style.color = target.nameColor;
    const badges = doc.createElement('span');
    badges.className = 'uc-uh-badges';
    nameRow.append(name, badges);
    const sub = doc.createElement('span');
    sub.className = 'uc-uh-sub';
    titles.append(cap, nameRow, sub);
    const x = doc.createElement('button');
    x.type = 'button';
    x.className = 'uc-uh-close';
    x.setAttribute('aria-label', 'Zavřít');
    x.title = 'Zavřít (Esc)';
    x.textContent = '×';
    x.addEventListener('click', () => this.close());
    const prev = this._history[this._history.length - 1];
    if (prev) {
      const bk = doc.createElement('button');
      bk.type = 'button';
      bk.className = 'uc-uh-back';
      const prevWho = prev.displayName || prev.login;
      bk.setAttribute('aria-label', `Zpět na profil ${prevWho}`);
      bk.title = `Zpět na profil ${prevWho}`;
      bk.textContent = '‹';
      bk.addEventListener('click', () => this.goBack());
      top.append(bk, titles, x);
    } else {
      top.append(titles, x);
    }
    const donSum = doc.createElement('div');
    donSum.className = 'uc-uh-donsum';
    donSum.hidden = true;
    const ids = doc.createElement('div');
    ids.className = 'uc-uh-ids';
    const stats = doc.createElement('div');
    stats.className = 'uc-uh-stats';
    stats.textContent = 'Načítám…';
    const links = doc.createElement('div');
    links.className = 'uc-uh-links';
    if (this.onPlatformCard) {
      const card = doc.createElement('button');
      card.type = 'button';
      card.className = 'uc-uh-card';
      card.textContent = `Karta na ${PLATFORM_LOC[target.platform] || target.platform}`;
      card.title = 'Původní karta uživatele na platformě (Twitch / 7TV)';
      card.addEventListener('click', () => this.onPlatformCard({ ...this.target }));
      links.appendChild(card);
    }
    links.hidden = !links.childElementCount;
    const mod = doc.createElement('div');
    mod.className = 'uc-uh-mod';
    mod.hidden = true;
    head.append(top, donSum, ids, stats, links, mod);

    const tabs = doc.createElement('div');
    tabs.className = 'uc-uh-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Kanály');
    tabs.hidden = true;
    tabs.addEventListener('keydown', (e) => this._tabKey(e));

    const list = doc.createElement('div');
    list.className = 'uc-uh-list';
    list.setAttribute('role', 'tabpanel');
    list.addEventListener('scroll', () => { if (list.scrollTop < 80) this._loadOlder(); });
    list.addEventListener('click', (e) => this._listClick(e));

    el.append(head, tabs, list);
    Object.assign(this, { el, _name: name, _badges: badges, _sub: sub, _donSum: donSum, _ids: ids, _stats: stats, _links: links, _mod: mod, _tabs: tabs, _list: list });
    (this.container || doc.body).appendChild(el);
    if (!this.container) el.classList.add('uc-uh--fixed');
    doc.addEventListener('keydown', this._onKey, true);
    try { el.focus({ preventScroll: true }); } catch {}
    this.log('Profile', `open ${target.platform}:${target.userId || '?'} ${target.login} kanál=${target.channel}`);
    this._status('Načítám…');
    this._loadSummary(serial);
    return el;
  }

  /** ‹ zpět na předchozí profil (po přepnutí z citace). */
  goBack() {
    const prev = this._history.pop();
    if (!prev || !this.isOpen) return;
    this.log('Profile', `zpět na ${prev.platform}:${prev.login}`);
    this.open(prev, { keepHistory: true });
  }

  close() {
    this._history = [];
    if (!this.el) return;
    this._serial++;
    this.el.remove();
    this.el = null;
    this._tab = null;
    this._dons = null;
    this.doc.removeEventListener('keydown', this._onKey, true);
    const back = this._returnFocus;
    this._returnFocus = null;
    if (back?.isConnected) { try { back.focus({ preventScroll: true }); } catch {} }
  }

  async _loadSummary(serial) {
    const t = this.target;
    try {
      const r = buildHistoryRequest('summary', t);
      const j = await this.api(r.path, { method: r.method });
      if (serial !== this._serial) return;
      this.summary = j;
      // Otevřeno podle loginu → další dotazy už s userId ze serveru.
      if (j?.user?.userId) this.target = { ...t, userId: String(j.user.userId), login: t.login || j.user.login };
      this._renderHeader(j);
      this.log('Profile', `summary view=${this.view} total=${j?.user?.total ?? '?'} kanály=${(j.channels || []).map((c) => `${c.channel}:${c.count}`).join(',') || '-'} moderace=${(j.moderation || []).length} badge=${Object.keys(j.latest || {}).join(',') || '-'} dona=${j.donations ? 'ano' : 'ne'}`);
      if (this.view !== 'mod') {
        // Divák: jen hlavička (chat log, záložky, identity a moderace nejsou — server je ani nepošle).
        this._tabs.hidden = true;
        this._list.hidden = true;
        this.el.classList.add('uc-uh--public');
        return;
      }
      this._renderTabs(j.channels || []);
      if (j.donations) this._loadDonations(serial);
      this.selectTab((j.channels?.[0]?.channel) || t.channel);
    } catch (e) {
      if (serial !== this._serial) return;
      this.log('Profile', `summary FAIL ${e?.status || 0} ${e?.error || e?.message || e}`);
      this._stats.textContent = '';
      this._status(modErrorText(e), 'error');
    }
  }

  /** Řádky donů (jen mod, jen záložka aktuálního kanálu). Chyba / nedostupné = žádné řádky, žádná hláška. */
  async _loadDonations(serial) {
    try {
      const r = buildHistoryRequest('donations', this.target);
      const j = await this.api(r.path, { method: r.method });
      if (serial !== this._serial) return;
      const items = j?.available && Array.isArray(j.items) ? j.items.filter((it) => it && it.id != null && Number.isFinite(Number(it.paidAt))) : [];
      this._dons = items.map((it) => ({ ...it, _placed: false })).sort((a, b) => a.paidAt - b.paidAt);
      this.log('Profile', `dona ${this._dons.length}${j?.available ? '' : ' (Židolišta nedostupná)'}`);
      this._placeDonations();
    } catch (e) {
      if (serial !== this._serial) return;
      this.log('Profile', `dona FAIL ${e?.status || 0} ${e?.error || e?.message || e}`);
      this._dons = [];
    }
  }

  _platformMark(platform, uc = false) {
    const doc = this.doc;
    const url = this.platformIcon(platform, uc);
    const s = doc.createElement('span');
    s.className = `uc-uh-pi uc-uh-pi--${platform}`;
    s.title = PLATFORM_NAMES[platform] || platform;
    if (url) {
      const img = doc.createElement('img');
      img.src = url;
      img.alt = PLATFORM_NAMES[platform] || platform;
      s.appendChild(img);
    } else {
      s.classList.add('uc-uh-pi--text');
      s.textContent = PLATFORM_NAMES[platform] || platform;
    }
    return s;
  }

  /** Badge + barva/paint jména z poslední zprávy (hostitel volá i po dotažení 7TV kosmetiky). */
  refreshBadges() {
    if (!this.el || !this.summary) return;
    const doc = this.doc;
    const j = this.summary;
    const u = j.user || {};
    const latest = j.latest || {};
    const primary = u.platform || this.target.platform;
    const order = [primary, ...Object.keys(latest).filter((p) => p !== primary)].filter((p) => latest[p]);
    this._badges.replaceChildren();
    for (const p of order) {
      let node = null;
      try { node = this.renderBadges ? toNode(doc, this.renderBadges(latest[p])) : null; } catch (e) { this.log('Profile', `badge ${p}: ${e?.message || e}`); }
      if (!node || !(node.childElementCount || node.textContent)) continue;
      const g = doc.createElement('span');
      g.className = 'uc-uh-badge-group';
      g.dataset.platform = p;
      if (order.length > 1) g.appendChild(this._platformMark(p));
      g.appendChild(node);
      this._badges.appendChild(g);
    }
    if (this.paintName) {
      try { this.paintName(this._name, { platform: primary, login: u.login || this.target.login, color: u.color || null, msg: latest[primary] || null }); } catch (e) { this.log('Profile', `paintName: ${e?.message || e}`); }
    } else if (u.color && COLOR_RE.test(String(u.color))) this._name.style.color = u.color;
  }

  _renderHeader(j) {
    const doc = this.doc;
    const u = j?.user || {};
    const t = this.target;
    if (u.nickname) {
      this._name.textContent = u.nickname;
      this._sub.textContent = u.displayName || t.login;
    } else {
      this._name.textContent = t.displayName || u.displayName || t.login;
      const shown = this._name.textContent.toLowerCase();
      this._sub.textContent = u.login && u.login !== shown ? u.login : '';
    }
    this.el.setAttribute('aria-label', `Profil: ${this._name.textContent}`);
    this.refreshBadges();

    const don = donationsSummary(j?.donations);
    this._donSum.replaceChildren();
    this._donSum.hidden = !don;
    if (don) {
      const main = doc.createElement('div');
      main.className = 'uc-uh-donsum-main';
      main.textContent = don.main;
      this._donSum.appendChild(main);
      if (don.sub) {
        const s = doc.createElement('div');
        s.className = 'uc-uh-donsum-sub';
        s.textContent = don.sub;
        this._donSum.appendChild(s);
      }
    }

    // Propojené platformy (jen mod — divákovi je server nepošle).
    this._ids.replaceChildren();
    for (const i of u.identities || []) {
      const chip = doc.createElement('span');
      chip.className = 'uc-uh-id';
      chip.title = `${PLATFORM_NAMES[i.platform] || i.platform}: ${i.login}`;
      const login = doc.createElement('span');
      login.textContent = i.displayName || i.login;
      chip.append(this._platformMark(i.platform), login);
      this._ids.appendChild(chip);
    }
    this._stats.textContent = statsText(u, { channelOnly: j?.view !== 'mod' });

    const items = j?.moderation || [];
    this._mod.replaceChildren();
    this._mod.hidden = !items.length;
    if (!items.length) return;
    const det = doc.createElement('details');
    const sum = doc.createElement('summary');
    sum.textContent = `Moderace v tomto kanálu (${items.length})`;
    const ul = doc.createElement('ul');
    for (const it of items) {
      const li = doc.createElement('li');
      li.className = `uc-uh-mod-item uc-uh-mod-item--${it.action}`;
      const what = doc.createElement('span');
      what.className = 'uc-uh-mod-what';
      what.textContent = modActionLabel(it);
      li.appendChild(what);
      if (it.params?.reason) {
        const why = doc.createElement('span');
        why.className = 'uc-uh-mod-why';
        why.textContent = it.params.reason;
        li.appendChild(why);
      }
      const meta = doc.createElement('span');
      meta.className = 'uc-uh-mod-meta';
      meta.textContent = `${fmtDateTime(it.at)} · ${actorLabel(it.by)}`;
      li.appendChild(meta);
      ul.appendChild(li);
    }
    det.append(sum, ul);
    this._mod.appendChild(det);
  }

  _renderTabs(channels) {
    const doc = this.doc;
    this._tabs.replaceChildren();
    for (const c of channels) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'uc-uh-tab';
      b.setAttribute('role', 'tab');
      b.dataset.channel = c.channel;
      b.title = `${this.channelLabel(c.channel)}: ${fmtMsgCount(c.count)}`;
      const n = doc.createElement('span');
      n.className = 'uc-uh-tab-name';
      n.textContent = this.channelLabel(c.channel);
      const cnt = doc.createElement('span');
      cnt.className = 'uc-uh-tab-count';
      cnt.textContent = fmtNumber(c.count || 0);
      b.append(n, cnt);
      b.addEventListener('click', () => this.selectTab(c.channel));
      this._tabs.appendChild(b);
    }
    this._tabs.hidden = channels.length < 1;
  }

  _tabKey(e) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const tabs = [...this._tabs.querySelectorAll('.uc-uh-tab')];
    const i = tabs.indexOf(this.doc.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    next.focus();
    this.selectTab(next.dataset.channel);
  }

  /** Přepne záložku a načte nejnovější stránku zpráv kanálu. */
  selectTab(channel) {
    if (!this.el || !channel || this.view !== 'mod') return;
    for (const b of this._tabs.querySelectorAll('.uc-uh-tab')) {
      const on = b.dataset.channel === channel;
      b.classList.toggle('uc-uh-tab--on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
    this._tab = { channel, token: {}, nextBefore: null, loading: false, done: false, count: 0, oldestTs: null };
    for (const d of this._dons || []) d._placed = false;
    this._list.replaceChildren();
    this._list.dataset.channel = channel;
    this._status('Načítám zprávy…');
    this._loadPage(this._tab, null);
  }

  /** Je vybraná záložka aktuálního kanálu (kanál, kde je Profil otevřený)? */
  _isCurrentTab() {
    return !!this._tab && this._tab.channel === String(this.target?.channel || '').toLowerCase();
  }

  /** Dona patří jen záložce aktuálního kanálu (workspace kanálu, kde je Profil otevřený). */
  _donsHere() {
    return this._isCurrentTab() && this._dons ? this._dons : [];
  }

  /** Další (starší) stránka. Po chybě nic — až „Zkusit znovu“ (`tab.failed`), jinak by scroll / doplnění výšky točily požadavky dokola. */
  async _loadOlder() {
    const tab = this._tab;
    if (!tab || tab.loading || tab.done || tab.failed || !tab.nextBefore) return;
    await this._loadPage(tab, tab.nextBefore);
  }

  /** „Zkusit znovu“ u starších zpráv. */
  retryOlder() {
    const tab = this._tab;
    if (!tab) return;
    tab.failed = false;
    this._list?.querySelector('.uc-uh-older-fail')?.remove();
    this._loadOlder();
  }

  /** Nahoře v seznamu: „Starší zprávy se nepodařilo načíst“ + „Zkusit znovu“. */
  _olderFailed() {
    const doc = this.doc;
    const list = this._list;
    list.querySelector('.uc-uh-older-fail')?.remove();
    const box = doc.createElement('div');
    box.className = 'uc-uh-older-fail';
    box.setAttribute('role', 'alert');
    const txt = doc.createElement('span');
    txt.textContent = 'Starší zprávy se nepodařilo načíst';
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'uc-uh-retry';
    btn.textContent = 'Zkusit znovu';
    btn.addEventListener('click', () => this.retryOlder());
    box.append(txt, btn);
    list.insertBefore(box, list.firstChild);
  }

  /** Řádky zpráv i donů v pořadí seznamu. */
  _rows() { return [...this._list.querySelectorAll(':scope > .uc-uh-msg, :scope > .uc-uh-don')]; }

  async _loadPage(tab, before, retried = false) {
    tab.loading = true;
    const t = this.target;
    let retry = false;
    try {
      const r = buildHistoryRequest('messages', t, { inChannel: tab.channel, before, limit: this.pageSize });
      const j = await this.api(r.path, { method: r.method });
      if (tab !== this._tab || !this.el) return;
      const msgs = Array.isArray(j?.messages) ? j.messages : [];
      tab.nextBefore = j?.nextBefore || null;
      tab.done = !tab.nextBefore;
      tab.count += msgs.length;
      this.log('Profile', `zprávy ${tab.channel} before=${before || '-'} n=${msgs.length} další=${tab.nextBefore ? 'ano' : 'ne'}`);
      this._status(null);
      const list = this._list;
      const prevH = list.scrollHeight, prevTop = list.scrollTop;
      if (msgs.length) {
        const frag = this.doc.createDocumentFragment();
        for (const m of msgs) frag.appendChild(this._row(m));
        const firstRow = this._rows()[0];
        if (before && firstRow) list.insertBefore(frag, firstRow);
        else list.appendChild(frag);
        const ts = Number(msgs[0].timestamp);
        if (Number.isFinite(ts) && (tab.oldestTs == null || ts < tab.oldestTs)) tab.oldestTs = ts;
      }
      this._placeDonations({ keepScroll: false });
      if (!tab.count && !this._rows().length) this._status('V tomto kanálu nic nenapsal.', 'empty');
      this._refreshDays();
      this._edge(tab);
      if (before) list.scrollTop = prevTop + (list.scrollHeight - prevH);
      else list.scrollTop = list.scrollHeight;
    } catch (e) {
      if (tab !== this._tab || !this.el) return;
      this.log('Profile', `zprávy FAIL ${e?.status || 0} ${e?.error || e?.message || e}${retried ? ' (po opakování)' : ''}`);
      // 429: backend má limit 5 + 2/s — jedno opakování za 1 s, pak už chyba.
      if (e?.status === 429 && !retried) retry = true;
      else if (before) { tab.failed = true; this._olderFailed(); }
      else { tab.failed = true; this._status(modErrorText(e), 'error'); }
    } finally {
      tab.loading = false;
    }
    if (retry) {
      await this._sleep(1000);
      if (tab === this._tab && this.el) await this._loadPage(tab, before, true);
      return;
    }
    // Stránka nezaplnila výšku panelu → dotáhnout starší hned (scroll by nikdy nenastal).
    if (tab === this._tab && this.el && !tab.failed && tab.nextBefore && this._list.scrollHeight <= this._list.clientHeight + 80) this._loadOlder();
  }

  /**
   * Zařadí dona mezi zprávy podle času: jen ta, která spadají do načteného rozsahu (novější než nejstarší
   * načtená zpráva), po konci historie všechna. Idempotentní (každé dono jednou).
   */
  _placeDonations({ keepScroll = true } = {}) {
    const tab = this._tab;
    const dons = this._donsHere();
    if (!tab || !this.el || !dons.length) return 0;
    const list = this._list;
    const prevH = list.scrollHeight, prevTop = list.scrollTop;
    const atBottom = prevH - prevTop - list.clientHeight < 40;
    let n = 0;
    for (const d of dons) {
      if (d._placed) continue;
      if (!tab.done && (tab.oldestTs == null || d.paidAt < tab.oldestTs)) continue;
      const next = this._rows().find((r) => Number(r.dataset.ts) > d.paidAt);
      const row = this._donRow(d);
      if (next) list.insertBefore(row, next);
      else list.insertBefore(row, list.querySelector(':scope > .uc-uh-status') || null);
      d._placed = true;
      n++;
    }
    if (!n) return 0;
    list.querySelector(':scope > .uc-uh-status[data-kind="empty"]')?.remove();
    if (keepScroll) {
      this._refreshDays();
      this._edge(tab);
      if (atBottom) list.scrollTop = list.scrollHeight;
      else list.scrollTop = prevTop + (list.scrollHeight - prevH);
    }
    return n;
  }

  /** Oddělovače dnů znovu podle pořadí řádků (zpráva i dono). */
  _refreshDays() {
    const list = this._list;
    for (const d of list.querySelectorAll(':scope > .uc-uh-day')) d.remove();
    let prev = null;
    for (const r of this._rows()) {
      const ts = Number(r.dataset.ts);
      if (!Number.isFinite(ts)) continue;
      const k = dayKey(ts);
      if (k !== prev) {
        const sep = this.doc.createElement('div');
        sep.className = 'uc-uh-day';
        sep.setAttribute('role', 'separator');
        sep.textContent = fmtDay(ts);
        list.insertBefore(sep, r);
        prev = k;
      }
    }
  }

  /** Horní okraj seznamu: „Začátek historie v tomto kanálu“ / nic. */
  _edge(tab) {
    const old = this._list.querySelector('.uc-uh-edge');
    if (old) old.remove();
    if (!tab.done) return;
    const e = this.doc.createElement('div');
    e.className = 'uc-uh-edge';
    e.textContent = 'Začátek historie v tomto kanálu';
    this._list.insertBefore(e, this._list.firstChild);
  }

  _time(ms) {
    const time = this.doc.createElement('time');
    time.className = 'uc-uh-time';
    time.textContent = fmtTime(ms);
    time.title = fmtDateTime(ms);
    try { time.dateTime = new Date(ms).toISOString(); } catch {}
    return time;
  }

  _row(m) {
    const doc = this.doc;
    const row = doc.createElement('div');
    row.className = 'uc-uh-msg';
    row.dataset.id = m.id;
    row.dataset.platform = m.platform;
    row.dataset.ts = String(Number(m.timestamp) || 0);
    if (m.userId != null) row.dataset.userId = String(m.userId);
    row._uhMsg = m;
    const tx = doc.createElement('span');
    tx.className = 'uc-uh-tx tx';
    const { msg, uc } = stripUcMarker(m);
    const gone = !!(m.deleted || m.hidden);
    if (!gone) {
      let html;
      try { html = this.renderMessage(msg); } catch { html = escapeHtml(msg.message || ''); }
      tx.innerHTML = html;
    }
    if (!gone && m.replyTo && (m.replyTo.username || m.replyTo.message)) row.appendChild(this._replyEl(msg));
    row.append(this._time(Number(m.timestamp)), this._platformMark(m.platform, uc), tx);
    if (gone) this._paintGone(row, { deleted: !!m.deleted, hidden: !m.deleted && !!m.hidden, hasContent: false });
    // Akce moda jen v záložce aktuálního kanálu (v cizím kanálu mod práva nemá).
    if (this.view === 'mod' && this.modMenu && this._isCurrentTab()) row.appendChild(this._actions(m, gone));
    return row;
  }

  /** Smazaná / skrytá zpráva stejně jako v chatu (core deletedView + applyDeleted; Profil vidí jen mod). */
  _paintGone(row, { deleted = true, hidden = false, hasContent = true } = {}) {
    let style = 'label';
    try { style = this.deletedStyle() || 'label'; } catch {}
    const view = deletedView({ style, isMod: true, hidden: !deleted && hidden });
    applyDeleted(row, { ...view, hidden: !deleted && hidden, hasContent });
    row.classList.add('uc-uh-msg--gone');
    // Koš → oko (Odkrýt zprávu jen v UnityChatu).
    const del = row.querySelector('.uc-uh-act[data-act="delete"]');
    if (del && row._uhMsg) del.replaceWith(this._actBtn('restore', row._uhMsg));
    else del?.remove();
  }

  /** Citace odpovědi (render chatu) na jeden řádek; klik = celý text, klik na jméno = Profil autora. */
  _replyEl(msg) {
    const doc = this.doc;
    const wrap = doc.createElement('div');
    wrap.className = 'uc-uh-reply';
    wrap.title = 'Klik zobrazí celou citaci';
    let node = null;
    try { node = this.renderReply ? toNode(doc, this.renderReply(msg)) : null; } catch (e) { this.log('Profile', `citace: ${e?.message || e}`); }
    if (!node) {
      node = doc.createElement('span');
      const user = doc.createElement('span');
      user.className = 'rctx-user';
      user.textContent = `@${String(msg.replyTo.username || '').replace(/^@/, '')}`;
      const body = doc.createElement('span');
      body.className = 'rctx-body';
      body.textContent = msg.replyTo.message ? ` ${msg.replyTo.message}` : '';
      node.append('↩ ', user, body);
    }
    wrap.appendChild(node);
    const rt = msg.replyTo;
    // Login autora (Twitch reply-parent-user-login), jinak zobrazované jméno z citace.
    wrap._uhReply = { platform: rt.platform || msg.platform, login: String(rt.login || rt.username || '').replace(/^@/, ''), authorUc: !!rt.authorUc };
    return wrap;
  }

  /** Klik v seznamu: citace (jméno autora → potvrzení a jeho Profil; jinde → zalomení) a ikony akcí. */
  _listClick(e) {
    const act = e.target?.closest?.('.uc-uh-act');
    if (act) return;   // vlastní handler tlačítka
    const wrap = e.target?.closest?.('.uc-uh-reply');
    if (!wrap || !this._list.contains(wrap)) return;
    e.preventDefault();
    e.stopPropagation();
    const info = wrap._uhReply;
    if (e.target.closest('.rctx-user') && info?.login) { this._confirmOpen(info); return; }
    const on = wrap.classList.toggle('uc-uh-reply--wrap');
    wrap.title = on ? 'Klik zobrazí citaci na jeden řádek' : 'Klik zobrazí celou citaci';
  }

  /** „Otevřít profil uživatele X?“ → Ano = panel přepne na jeho Profil (cíl podle loginu). */
  _confirmOpen(info) {
    this.log('Profile', `citace → potvrzení profilu ${info.platform}:${info.login}`);
    openModDialog({
      doc: this.doc,
      title: `Otevřít profil uživatele ${info.login}?`,
      submitLabel: 'Ano',
      onSubmit: async () => {
        // Bez displayName: hlavička vezme jméno ze serveru (login z citace může mít jiný tvar).
        // Aktuální profil (i se jménem ze serveru) jde do historie → v novém se ukáže ‹ zpět.
        const cur = { ...this.target };
        const u = this.summary?.user;
        if (u && !cur.displayName) cur.displayName = u.nickname || u.displayName || cur.login;
        const hist = this._history.concat([cur]).slice(-20);
        this._history = hist;
        this.open({ channel: this.target.channel, platform: info.platform, userId: null, login: info.login }, { keepHistory: true });
      },
    });
  }

  _actions(m, gone) {
    const box = this.doc.createElement('div');
    box.className = 'uc-uh-acts';
    // Smazaná / skrytá zpráva: místo koše oko (Odkrýt zprávu jen v UnityChatu).
    for (const kind of [gone ? 'restore' : 'delete', 'timeout', 'ban', 'permit']) box.appendChild(this._actBtn(kind, m));
    return box;
  }

  _actBtn(kind, m) {
    const b = this.doc.createElement('button');
    b.type = 'button';
    b.className = `uc-uh-act uc-uh-act--${kind}`;
    b.dataset.act = kind;
    b.title = ACTION_TITLES[kind];
    b.setAttribute('aria-label', ACTION_TITLES[kind]);
    b.innerHTML = ICONS[kind];
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = b.getBoundingClientRect?.() || { left: 0, bottom: 0 };
      this.modMenu.openAction(kind, messageTarget(m, this.target), { x: r.left, y: r.bottom });
    });
    return b;
  }

  /** Akce moda proběhla → smazaná zpráva / zprávy uživatele po timeoutu či banu jako v chatu. */
  _onModResult(kind, t, res, x = {}) {
    if (!this.el || !this._list) return;
    let n = 0;
    if (kind === 'delete' && t.messageId) {
      for (const row of this._rows()) {
        if (row.dataset.id !== String(t.messageId) || row.dataset.platform !== t.platform) continue;
        this._paintGone(row, { deleted: true, hasContent: !!row.querySelector('.tx')?.textContent });
        n++;
      }
    } else if (kind === 'restore' && t.messageId && res?.result === 'ok') {
      // Odkrytá zpráva: řádek znovu z odpovědi serveru (celá zpráva s textem), koš místo oka.
      for (const row of this._rows()) {
        if (row.dataset.id !== String(t.messageId) || row.dataset.platform !== t.platform) continue;
        const fresh = res.message && typeof res.message === 'object' ? res.message : null;
        if (!fresh) continue;
        const { deleted, deletedReason, hidden, ...rest } = row._uhMsg || {};
        row.replaceWith(this._row({ ...rest, ...fresh, deleted: false, hidden: false }));
        n++;
      }
    } else if ((kind === 'timeout' || kind === 'ban') && t.userId) {
      const tag = modTagText({ action: kind, durationSec: x.durationSec ?? null });
      for (const row of this._rows()) {
        if (!row.classList.contains('uc-uh-msg') || row.dataset.platform !== t.platform || row.dataset.userId !== String(t.userId)) continue;
        this._paintGone(row, { deleted: true, hasContent: !!row.querySelector('.tx')?.textContent });
        applyModTag(row, tag);
        n++;
      }
    }
    if (n) this.log('Profile', `po akci ${kind} → ${n} řádků`);
  }

  _donRow(d) {
    const doc = this.doc;
    const row = doc.createElement('div');
    row.className = `uc-uh-don${d.matchedBy === 'nickname' ? ' uc-uh-don--guess' : ''}`;
    row.dataset.id = String(d.id);
    row.dataset.ts = String(d.paidAt);
    const icon = doc.createElement('span');
    icon.className = 'uc-uh-don-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '💸';
    const body = doc.createElement('span');
    body.className = 'uc-uh-don-body';
    const line = doc.createElement('span');
    line.className = 'uc-uh-don-line';
    line.textContent = donationLine(d);
    body.appendChild(line);
    if (d.matchedBy === 'nickname') {
      const g = doc.createElement('span');
      g.className = 'uc-uh-don-guess';
      g.textContent = 'podle jména';
      g.title = d.nickname ? `Spárováno jen podle přezdívky dona „${d.nickname}“` : 'Spárováno jen podle přezdívky dona';
      body.appendChild(g);
    }
    if (d.message) {
      const msg = doc.createElement('span');
      msg.className = 'uc-uh-don-msg';
      msg.textContent = d.message;
      body.appendChild(msg);
    }
    row.append(this._time(d.paidAt), icon, body);
    return row;
  }

  _status(text, kind = 'info') {
    let s = this._list?.querySelector('.uc-uh-status');
    if (!text) { s?.remove(); return; }
    if (!s) {
      s = this.doc.createElement('div');
      s.className = 'uc-uh-status';
      s.setAttribute('role', 'status');
      this._list.appendChild(s);
    }
    this._list.hidden = false;
    s.dataset.kind = kind;
    s.textContent = text;
  }
}
