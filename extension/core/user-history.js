// „Chat historie“ uživatele z nabídky moda (2026-09-25) — sdílená addonem i webem.
// Panel přes chat (overlay v kontejneru chatu, Esc / × zavře, na úzké obrazovce celá šířka):
// hlavička se jménem v barvě uživatele, přezdívkou, propojenými platformami a statistikou, moderace
// v aktuálním kanálu, záložky kanálů (jen kde uživatel psal) a stránkovaný seznam zpráv.
// Kontrakt backendu: docs/superpowers/plans/2026-09-25-moderace-cast-2-kontrakt.md („Chat historie“).
//
// Host dodá DOM (`doc`), `api(path, { method })` → JSON (throw { error, status }), kontejner chatu
// a `renderMessage(msg)` → HTML těla zprávy (emoty, odkazy; msg = tvar /chat/history). Cizí text
// (jména, důvody) jen přes textContent. Žádné chrome.*, žádné globální stavy.

import { fmtDuration } from './moderation.js';
import { PLATFORM_NAMES } from './soundboard.js';
import { escapeHtml } from './html.js';
import { modErrorText } from './mod-menu.js';

export const HISTORY_PAGE = 50;
const enc = encodeURIComponent;
const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i;

/** Český plurál: 1 → one, 2–4 → few, jinak many (0, 5+, zlomky). */
export function czPlural(n, one, few, many) {
  const a = Math.abs(Number(n) || 0);
  if (a === 1) return one;
  if (Number.isInteger(a) && a >= 2 && a <= 4) return few;
  return many;
}

/** 1 zpráva / 3 zprávy / 12 zpráv (tisíce s mezerou). */
export function fmtMsgCount(n) {
  const v = Number(n) || 0;
  return `${v.toLocaleString('cs-CZ')} ${czPlural(v, 'zpráva', 'zprávy', 'zpráv')}`;
}

const pad = (n) => String(n).padStart(2, '0');

/** ms → „25. 9. 2026 14:05“ (místní čas). `withTime: false` → jen datum. */
export function fmtDateTime(ms, { withTime = true } = {}) {
  if (ms == null || !Number.isFinite(Number(ms))) return '';
  const d = new Date(Number(ms));
  const date = `${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()}`;
  return withTime ? `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}` : date;
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
 * Požadavek na backend (čistá funkce).
 * @param {'summary'|'messages'} kind
 * @param {{channel?: string, platform: string, userId: string, login?: string}} t
 * @param {{inChannel?: string, before?: string|null, limit?: number}} [x]
 */
export function buildHistoryRequest(kind, t, x = {}) {
  const q = [];
  if (t.channel) q.push(`channel=${enc(String(t.channel).toLowerCase())}`);
  q.push(`platform=${enc(t.platform)}`, `userId=${enc(String(t.userId ?? ''))}`);
  if (t.login) q.push(`login=${enc(t.login)}`);
  if (kind === 'summary') return { path: `/moderation/user-history/summary?${q.join('&')}`, method: 'GET' };
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

/** Statistika do hlavičky: „Poprvé viděn 20. 9. 2026 · naposledy 25. 9. 2026 14:05 · celkem 11 zpráv“. */
export function statsText(user) {
  if (!user) return '';
  const parts = [];
  if (user.firstSeen) parts.push(`Poprvé viděn ${fmtDateTime(user.firstSeen, { withTime: false })}`);
  if (user.lastSeen) parts.push(`naposledy ${fmtDateTime(user.lastSeen)}`);
  parts.push(`celkem ${fmtMsgCount(user.total || 0)}`);
  return parts.join(' · ');
}

export class UserHistoryPanel {
  /**
   * @param {object} o
   * @param {Document} [o.doc]
   * @param {(path: string, opts: {method?: string}) => Promise<any>} o.api
   * @param {HTMLElement} [o.container]  kontejner chatu (position: relative); jinak body
   * @param {(msg: object) => string} [o.renderMessage]  HTML těla zprávy; jinak escapovaný text
   * @param {(platform: string, uc?: boolean) => string|null} [o.platformIcon]  URL loga platformy; jinak text
   * @param {(channel: string) => string} [o.channelLabel]  název záložky
   * @param {(tag: string, text: string) => void} [o.log]
   * @param {number} [o.pageSize]
   * @param {(ms: number) => Promise<void>} [o.sleep]  čekání před opakováním po 429 (testy)
   */
  constructor({ doc = globalThis.document, api, container, renderMessage, platformIcon, channelLabel, log, pageSize = HISTORY_PAGE, sleep } = {}) {
    this.doc = doc;
    this.api = api;
    this.container = container || null;
    this.renderMessage = renderMessage || ((m) => escapeHtml(m?.message || ''));
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
    this._onKey = (e) => {
      if (e.key !== 'Escape' || !this.el) return;
      // Esc jinde (pole pro psaní, našeptávač, …) patří tamtomu prvku, ne panelu.
      if (!(e.target && this.el.contains(e.target))) return;
      // Otevřený dialog / nabídka moda má Esc přednostně.
      if (this.doc.querySelector('.uc-mod-shade, .uc-mod-menu')) return;
      e.preventDefault(); e.stopPropagation(); this.close();
    };
  }

  get isOpen() { return !!this.el; }

  /** @param {{channel: string, platform: string, userId: string, login: string, displayName?: string, nameColor?: string|null, nickname?: string|null}} target */
  open(target) {
    this.close();
    const doc = this.doc;
    // Kam vrátit fokus po zavření (nabídka moda už je zavřená → typicky prvek chatu / body).
    const back = doc.activeElement;
    this._returnFocus = back && back !== doc.body ? back : null;
    this.target = target;
    this.summary = null;
    const serial = ++this._serial;
    const who = target.displayName || target.login;

    const el = doc.createElement('section');
    el.className = 'uc-uh';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', `Chat historie: ${who}`);
    el.tabIndex = -1;

    const head = doc.createElement('header');
    head.className = 'uc-uh-head';
    const top = doc.createElement('div');
    top.className = 'uc-uh-top';
    const titles = doc.createElement('div');
    titles.className = 'uc-uh-titles';
    const cap = doc.createElement('span');
    cap.className = 'uc-uh-cap';
    cap.textContent = 'Chat historie';
    const name = doc.createElement('h2');
    name.className = 'uc-uh-name';
    name.textContent = who;
    if (target.nameColor && COLOR_RE.test(String(target.nameColor))) name.style.color = target.nameColor;
    const sub = doc.createElement('span');
    sub.className = 'uc-uh-sub';
    titles.append(cap, name, sub);
    const x = doc.createElement('button');
    x.type = 'button';
    x.className = 'uc-uh-close';
    x.setAttribute('aria-label', 'Zavřít');
    x.title = 'Zavřít (Esc)';
    x.textContent = '×';
    x.addEventListener('click', () => this.close());
    top.append(titles, x);
    const ids = doc.createElement('div');
    ids.className = 'uc-uh-ids';
    const stats = doc.createElement('div');
    stats.className = 'uc-uh-stats';
    stats.textContent = 'Načítám…';
    const mod = doc.createElement('div');
    mod.className = 'uc-uh-mod';
    mod.hidden = true;
    head.append(top, ids, stats, mod);

    const tabs = doc.createElement('div');
    tabs.className = 'uc-uh-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Kanály');
    tabs.addEventListener('keydown', (e) => this._tabKey(e));

    const list = doc.createElement('div');
    list.className = 'uc-uh-list';
    list.setAttribute('role', 'tabpanel');
    list.addEventListener('scroll', () => { if (list.scrollTop < 80) this._loadOlder(); });

    el.append(head, tabs, list);
    Object.assign(this, { el, _name: name, _sub: sub, _ids: ids, _stats: stats, _mod: mod, _tabs: tabs, _list: list });
    (this.container || doc.body).appendChild(el);
    if (!this.container) el.classList.add('uc-uh--fixed');
    doc.addEventListener('keydown', this._onKey, true);
    try { el.focus({ preventScroll: true }); } catch {}
    this.log('History', `open ${target.platform}:${target.userId} ${target.login} kanál=${target.channel}`);
    this._status('Načítám…');
    this._loadSummary(serial);
    return el;
  }

  close() {
    if (!this.el) return;
    this._serial++;
    this.el.remove();
    this.el = null;
    this._tab = null;
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
      this._renderHeader(j);
      this._renderTabs(j.channels || []);
      this.log('History', `summary total=${j?.user?.total ?? '?'} kanály=${(j.channels || []).map((c) => `${c.channel}:${c.count}`).join(',')} moderace=${(j.moderation || []).length}`);
      this.selectTab((j.channels?.[0]?.channel) || t.channel);
    } catch (e) {
      if (serial !== this._serial) return;
      this.log('History', `summary FAIL ${e?.status || 0} ${e?.error || e?.message || e}`);
      this._stats.textContent = '';
      this._status(modErrorText(e), 'error');
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
    this._ids.replaceChildren();
    for (const i of u.identities || []) {
      const chip = doc.createElement('span');
      chip.className = 'uc-uh-id';
      const login = doc.createElement('span');
      login.textContent = i.login;
      chip.append(this._platformMark(i.platform), login);
      this._ids.appendChild(chip);
    }
    this._stats.textContent = statsText(u);

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
      cnt.textContent = Number(c.count || 0).toLocaleString('cs-CZ');
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
    if (!this.el || !channel) return;
    for (const b of this._tabs.querySelectorAll('.uc-uh-tab')) {
      const on = b.dataset.channel === channel;
      b.classList.toggle('uc-uh-tab--on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
    this._tab = { channel, token: {}, nextBefore: null, loading: false, done: false, count: 0 };
    this._list.replaceChildren();
    this._list.dataset.channel = channel;
    this._status('Načítám zprávy…');
    this._loadPage(this._tab, null);
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
      this.log('History', `zprávy ${tab.channel} before=${before || '-'} n=${msgs.length} další=${tab.nextBefore ? 'ano' : 'ne'}`);
      this._status(null);
      if (!tab.count) { this._status('V tomto kanálu nic nenapsal.', 'empty'); return; }
      const list = this._list;
      const prevH = list.scrollHeight, prevTop = list.scrollTop;
      const frag = this.doc.createDocumentFragment();
      for (const m of msgs) frag.appendChild(this._row(m));
      if (before) {
        list.insertBefore(frag, list.firstChild);
        list.scrollTop = prevTop + (list.scrollHeight - prevH);
      } else {
        list.appendChild(frag);
        list.scrollTop = list.scrollHeight;
      }
      this._edge(tab);
    } catch (e) {
      if (tab !== this._tab || !this.el) return;
      this.log('History', `zprávy FAIL ${e?.status || 0} ${e?.error || e?.message || e}${retried ? ' (po opakování)' : ''}`);
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

  /** Horní okraj seznamu: „Starší zprávy už nejsou“ / nic. */
  _edge(tab) {
    const old = this._list.querySelector('.uc-uh-edge');
    if (old) old.remove();
    if (!tab.done) return;
    const e = this.doc.createElement('div');
    e.className = 'uc-uh-edge';
    e.textContent = 'Začátek historie v tomto kanálu';
    this._list.insertBefore(e, this._list.firstChild);
  }

  _row(m) {
    const doc = this.doc;
    const row = doc.createElement('div');
    row.className = 'uc-uh-msg';
    row.dataset.id = m.id;
    row.dataset.platform = m.platform;
    const time = doc.createElement('time');
    time.className = 'uc-uh-time';
    time.textContent = fmtDateTime(m.timestamp);
    try { time.dateTime = new Date(m.timestamp).toISOString(); } catch {}
    const tx = doc.createElement('span');
    tx.className = 'uc-uh-tx';
    const { msg, uc } = stripUcMarker(m);
    if (m.deleted || m.hidden) {
      row.classList.add('uc-uh-msg--gone');
      tx.textContent = m.deleted ? 'Zpráva smazána' : 'Zpráva skrytá v UnityChatu';
    } else {
      let html;
      try { html = this.renderMessage(msg); } catch { html = escapeHtml(msg.message || ''); }
      tx.innerHTML = html;
    }
    row.append(time, this._platformMark(m.platform, uc), tx);
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
    s.dataset.kind = kind;
    s.textContent = text;
  }
}
