// Kontextová nabídka moderátora na jméno (moderace část 2) — sdílená addonem i webem.
// Pravé tlačítko na jméno (jen mod; divák má nativní menu prohlížeče) → Smazat zprávu,
// Timeout ▸, Zabanovat / Unban, Přejmenovat…, Profil, Varovat…, Permit ▸. Kontrakt backendu:
// docs/superpowers/plans/2026-09-25-moderace-cast-2-kontrakt.md.
//
// Host dodá DOM (`doc`) a `api(path, { method, body })` → JSON, při chybě throw { error, status }
// (addon `_ucApi`, web stejný tvar). Cizí text (jméno, přezdívka, důvod) jen přes textContent.
// Žádné chrome.*, žádné globální stavy.

import { fmtDuration } from './moderation.js';
import { PLATFORM_NAMES } from './soundboard.js';

export const TIMEOUT_OPTIONS = [5, 30, 60, 300, 600, 1800, 3600, 7200];
export const PERMIT_OPTIONS = [30, 60, 120, 300, 600];
/** Vlastní délka (pokyn usera 2026-09-25): stejné stropy jako server (Twitch 14 dní, permit 24 h). */
export const MAX_TIMEOUT_SEC = 1_209_600;
export const MAX_PERMIT_SEC = 86_400;
export const CUSTOM_UNITS = [{ id: 's', sec: 1 }, { id: 'm', sec: 60 }, { id: 'h', sec: 3600 }];

/** Vlastní délka z pole + jednotky → sekundy, nebo null (mimo 1…max). */
export function customDurationSec(value, unitSec, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return null;
  const sec = n * unitSec;
  return sec >= 1 && sec <= max ? sec : null;
}
export const NICKNAME_MAX = 30;
export const WARN_REASON_MAX = 500;

const enc = encodeURIComponent;

/** Chybové kódy HTTP odpovědí moderace → česká hláška. */
const MOD_ERRORS = {
  target_protected: 'Na streamera nebo moda to nejde.',
  not_mod: 'Tohle může jen mod kanálu.',
  no_actor: 'Není čím akci provést — tvůj účet ani bot tu nemá práva moda.',
  bad_login: 'Jméno uživatele nejde poslat do chatu (neplatný login).',
  nickname_blacklisted: 'Přezdívka obsahuje zakázané slovo.',
  rate_limited: 'Moc akcí za sebou, chvíli počkej.',
  not_found: 'Uživatel v archivu chatu není (zpráva je moc stará nebo ještě nedorazila).',
  self: 'Na sebe to nejde.',
  body: 'Neplatný požadavek.',
  channel: 'Neplatný kanál.',
  query: 'Neplatný požadavek.',
};

/** Chyba z api (throw { error, status }) → česká hláška. */
export function modErrorText(err) {
  const code = String(err?.error || err?.message || err || '');
  if (MOD_ERRORS[code]) return MOD_ERRORS[code];
  if (err?.status === 401) return 'Přihlášení vypršelo, přihlas se znovu.';
  if (err?.status === 429) return MOD_ERRORS.rate_limited;
  if (err?.status === 403) return MOD_ERRORS.not_mod;
  return `Akce selhala (${code || 'neznámá chyba'}).`;
}

/** Výsledek na jedné platformě (ModResult) → „✓" / „✗ bot není mod". */
export function platformResultText(r) {
  if (r === 'ok') return '✓';
  if (r === 'bot') return '✓ (bot)';
  const code = String(r || '').replace(/^error:/, '');
  const map = {
    no_actor: 'bot není mod', no_channel: 'kanál není napojený', not_live: 'stream neběží',
    no_ban_id: 'ban není v evidenci', unsupported: 'nepodporováno', exception: 'chyba',
    bot_unavailable: 'bot není dostupný', send_failed: 'nepodařilo se odeslat', db: 'chyba databáze',
    no_account: 'nemá účet UnityChatu',
  };
  if (map[code]) return `✗ ${map[code]}`;
  if (/^\d{3}$/.test(code)) return `✗ platforma odmítla (${code})`;
  return `✗ ${code || 'chyba'}`;
}

const RESULT_ORDER = ['twitch', 'kick', 'youtube', 'chat', 'unitychat', 'permit'];

/**
 * { twitch: 'ok', kick: 'bot', youtube: 'error:not_live' } → „Twitch ✓ · Kick ✓ (bot) · YouTube ✗ stream neběží".
 * @param {Record<string,string>} results
 * @param {{notes?: Record<string,string>, labels?: Record<string,string>}} [o]
 */
export function formatResults(results, { notes = {}, labels = {} } = {}) {
  const keys = Object.keys(results || {}).sort((a, b) => {
    const ia = RESULT_ORDER.indexOf(a), ib = RESULT_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return keys.map((k) => {
    const name = labels[k] || PLATFORM_NAMES[k] || (k === 'unitychat' || k === 'permit' ? 'UnityChat' : k === 'chat' ? 'Chat' : k);
    let text = `${name} ${platformResultText(results[k])}`;
    const note = notes?.[k];
    const m = typeof note === 'string' && note.match(/^rounded_to_minutes:(\d+)$/);
    if (m) text += ` (zaokrouhleno na ${m[1]} min)`;
    return text;
  }).join(' · ');
}

/** Přezdívka z dialogu → { nickname|null, error? }. Prázdná = smazat. */
export function validateNickname(value) {
  const nickname = String(value ?? '').trim();
  if (!nickname) return { nickname: null };
  if ([...nickname].length > NICKNAME_MAX) return { nickname, error: `Přezdívka může mít nejvýš ${NICKNAME_MAX} znaků.` };
  return { nickname };
}

/** Důvod varování → { reason, error? } (povinný, 1–500 znaků). */
export function validateWarnReason(value) {
  const reason = String(value ?? '').trim();
  if (!reason) return { reason, error: 'Napiš důvod varování.' };
  if ([...reason].length > WARN_REASON_MAX) return { reason, error: `Důvod může mít nejvýš ${WARN_REASON_MAX} znaků.` };
  return { reason };
}

/** Místo „na Twitchi / na Kicku / na YouTube“. */
export const PLATFORM_LOC = { twitch: 'Twitchi', kick: 'Kicku', youtube: 'YouTube' };

/**
 * Výsledek akce → platformy, kde akci neprovedl účet moda, protože mu chybí moderátorská oprávnění
 * (výsledek 'bot' = provedl bot místo něj, 'error:no_actor' = nikdo) a `/moderation/me` u té platformy hlásí
 * chybějící scopes. Jen tam má smysl nabídnout přihlášení s moderací (čistá funkce).
 * @param {Record<string,string>} results  { twitch: 'ok'|'bot'|'error:…' } (u mazání { [platform]: result })
 * @param {Record<string,string[]>} [missingScopes]  z /moderation/me
 */
export function modScopePlatforms(results, missingScopes = {}) {
  return Object.entries(results || {})
    .filter(([p, r]) => PLATFORM_LOC[p] && (r === 'bot' || r === 'error:no_actor') && Array.isArray(missingScopes?.[p]) && missingScopes[p].length > 0)
    .map(([p]) => p);
}

/**
 * Hláška + tlačítko pro platformu z modScopePlatforms. Twitch žádá mod scopes už při každém přihlášení
 * (backend 2026-09-25) → jde jen o jednorázové obnovení starého tokenu; Kick mod scopes jen na vyžádání.
 */
export function modScopePrompt(platform, result) {
  const where = PLATFORM_LOC[platform] || platform;
  const text = result === 'bot'
    ? `Na ${where} akci provedl bot — tvůj účet nemá oprávnění moderovat.`
    : `Na ${where} se akce nepovedla — tvůj účet nemá oprávnění moderovat.`;
  return { text, action: platform === 'twitch' ? 'Obnovit přihlášení (moderace)' : 'Povolit moderaci účtem' };
}

/**
 * Požadavek na backend pro akci z nabídky (čistá funkce, testovaná).
 * @param {'state'|'delete'|'timeout'|'ban'|'unban'|'warn'|'permit'|'rename'} kind
 * @param {{channel?: string, platform: string, userId?: string, login: string, messageId?: string|null}} t  cíl
 * @param {{durationSec?: number, reason?: string, nickname?: string|null, color?: string|null}} [x]
 * @returns {{path: string, method: string, body?: object}}
 */
export function buildModRequest(kind, t, x = {}) {
  const ch = t.channel ? { channel: String(t.channel).toLowerCase() } : {};
  const base = { ...ch, platform: t.platform, userId: t.userId != null ? String(t.userId) : undefined, login: t.login };
  switch (kind) {
    case 'state':
      return { path: `/moderation/user-state?${t.channel ? `channel=${enc(String(t.channel).toLowerCase())}&` : ''}platform=${enc(t.platform)}&userId=${enc(String(t.userId ?? ''))}`, method: 'GET' };
    case 'delete':
      return { path: '/moderation/delete', method: 'POST', body: { ...ch, platform: t.platform, messageId: String(t.messageId ?? '') } };
    case 'timeout':
      return { path: '/moderation/user', method: 'POST', body: { ...base, action: 'timeout', durationSec: x.durationSec } };
    case 'ban':
    case 'unban':
      return { path: '/moderation/user', method: 'POST', body: { ...base, action: kind } };
    case 'warn':
      return { path: '/moderation/warn', method: 'POST', body: { ...base, reason: x.reason } };
    case 'permit':
      // messageId: permit na zprávě smazané filtrem odkazů ji v UnityChatu obnoví (část 3).
      return { path: '/moderation/permit', method: 'POST', body: { ...base, durationSec: x.durationSec, ...(t.messageId ? { messageId: String(t.messageId) } : {}) } };
    case 'rename': {
      const nickname = x.nickname || null;
      return { path: '/moderation/nickname', method: 'PUT', body: { ...ch, platform: t.platform, login: t.login, nickname, color: nickname ? (x.color || null) : null } };
    }
    default:
      throw new Error(`neznámá akce ${kind}`);
  }
}

/**
 * Položky nabídky (čistá funkce). `banned` → Unban místo Timeout/Zabanovat.
 * Bez userId jde jen Přejmenovat (a Smazat zprávu, pokud je zpráva potvrzená).
 * `history` = hostitel umí otevřít Profil (core/user-history.js) → položka za Přejmenovat.
 */
export function menuModel({ banned = false, canDelete = true, hasUserId = true, history = false } = {}) {
  const noId = !hasUserId;
  const items = [];
  if (canDelete) items.push({ id: 'delete', label: 'Smazat zprávu' });
  if (banned) items.push({ id: 'unban', label: 'Unban', disabled: noId });
  else {
    items.push({ id: 'timeout', label: 'Timeout', disabled: noId, sub: TIMEOUT_OPTIONS.map((s) => ({ id: `timeout:${s}`, label: fmtDuration(s), durationSec: s })), custom: { max: MAX_TIMEOUT_SEC } });
    items.push({ id: 'ban', label: 'Zabanovat…', danger: true, disabled: noId });
  }
  items.push({ id: 'rename', label: 'Přejmenovat…' });
  if (history) items.push({ id: 'history', label: 'Profil', disabled: noId });
  items.push({ id: 'warn', label: 'Varovat…', disabled: noId });
  items.push({ id: 'permit', label: 'Permit', disabled: noId, sub: PERMIT_OPTIONS.map((s) => ({ id: `permit:${s}`, label: fmtDuration(s), durationSec: s })), custom: { max: MAX_PERMIT_SEC } });
  return items;
}

/** Hláška po úspěšné akci. */
export function summarizeModResult(kind, target, res = {}, x = {}) {
  const who = target.displayName || target.login;
  switch (kind) {
    case 'delete': return `Zpráva od ${who} smazána: ${formatResults({ [target.platform]: res.result })}`;
    case 'timeout': return `Timeout ${fmtDuration(x.durationSec)} pro ${who}: ${formatResults(res.results, { notes: res.notes })}`;
    case 'ban': return `Ban pro ${who}: ${formatResults(res.results, { notes: res.notes })}`;
    case 'unban': return `Unban pro ${who}: ${formatResults(res.results, { notes: res.notes })}`;
    case 'warn': return `Varování pro ${who}: ${formatResults(res.results)}`;
    case 'permit': {
      // results.restore (část 3): 'ok' = zpráva smazaná filtrem odkazů se v UnityChatu obnovila; jinak nic neříkat.
      const { restore, ...rest } = res.results || {};
      const text = `Permit ${fmtDuration(x.durationSec)} pro ${who}: ${formatResults(rest, { labels: { chat: `!permit v chatu (${PLATFORM_NAMES[target.platform] || target.platform})` } })}`;
      return restore === 'ok' ? `${text} · zpráva obnovena` : text;
    }
    case 'rename': return res.nickname ? `${who} má teď přezdívku „${res.nickname}".` : `Přezdívka uživatele ${who} smazána.`;
    default: return `${kind}: hotovo`;
  }
}

// ---------------------------------------------------------------------------
// DOM: dialog (přejmenování, varování, potvrzení banu)

/**
 * Modální dialog s poli. `onSubmit(values)` → Promise; throw Error(text) = chyba se ukáže v dialogu,
 * dialog zůstane otevřený. Esc / klik vedle / Zrušit zavře.
 * @returns {{el: HTMLElement, close: () => void}}
 */
export function openModDialog({ doc = globalThis.document, title, subtitle, fields = [], submitLabel = 'Uložit', danger = false, onSubmit, onClose }) {
  const shade = doc.createElement('div');
  shade.className = 'uc-mod-shade';
  const win = doc.createElement('form');
  win.className = 'uc-mod-dialog';
  win.setAttribute('role', 'dialog');
  win.setAttribute('aria-modal', 'true');
  win.noValidate = true;
  const h = doc.createElement('h2');
  h.textContent = title;
  win.setAttribute('aria-label', title);
  win.appendChild(h);
  if (subtitle) {
    const p = doc.createElement('p');
    p.className = 'uc-mod-dialog-sub';
    p.textContent = subtitle;
    win.appendChild(p);
  }
  const inputs = {};
  for (const f of fields) {
    const row = doc.createElement('label');
    row.className = `uc-mod-field uc-mod-field--${f.type || 'text'}`;
    const cap = doc.createElement('span');
    cap.className = 'uc-mod-field-label';
    cap.textContent = f.label;
    if (f.type === 'color') {
      // Volitelná barva: zaškrtávátko „Vlastní barva" + výběr barvy.
      const chk = doc.createElement('input');
      chk.type = 'checkbox';
      chk.checked = !!f.value;
      const pick = doc.createElement('input');
      pick.type = 'color';
      pick.value = /^#[0-9a-f]{6}$/i.test(f.value || '') ? f.value : '#ff8c00';
      pick.disabled = !chk.checked;
      chk.addEventListener('change', () => { pick.disabled = !chk.checked; });
      pick.addEventListener('input', () => { chk.checked = true; });
      row.append(chk, cap, pick);
      inputs[f.name] = { get value() { return chk.checked ? pick.value : null; }, focus: () => chk.focus(), chk, pick };
    } else {
      const inp = doc.createElement(f.type === 'textarea' ? 'textarea' : 'input');
      if (f.type !== 'textarea') inp.type = 'text';
      else inp.rows = 3;
      inp.value = f.value || '';
      if (f.placeholder) inp.placeholder = f.placeholder;
      if (f.maxLength) inp.maxLength = f.maxLength;
      inp.autocomplete = 'off';
      inp.name = f.name;
      row.append(cap, inp);
      inputs[f.name] = inp;
    }
    win.appendChild(row);
  }
  const err = doc.createElement('p');
  err.className = 'uc-mod-dialog-err';
  err.setAttribute('role', 'alert');
  err.hidden = true;
  win.appendChild(err);
  const btns = doc.createElement('div');
  btns.className = 'uc-mod-dialog-btns';
  const cancel = doc.createElement('button');
  cancel.type = 'button';
  cancel.className = 'uc-mod-btn';
  cancel.textContent = 'Zrušit';
  const ok = doc.createElement('button');
  ok.type = 'submit';
  ok.className = `uc-mod-btn uc-mod-btn--primary${danger ? ' uc-mod-btn--danger' : ''}`;
  ok.textContent = submitLabel;
  btns.append(cancel, ok);
  win.appendChild(btns);
  shade.appendChild(win);

  let closed = false;
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target?.tagName === 'TEXTAREA') { e.preventDefault(); submit(); }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    shade.remove();
    doc.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const submit = async () => {
    if (ok.disabled) return;
    const values = {};
    for (const [k, inp] of Object.entries(inputs)) values[k] = inp.value;
    ok.disabled = true;
    err.hidden = true;
    try {
      await onSubmit?.(values);
      close();
    } catch (e) {
      err.textContent = e?.message || String(e);
      err.hidden = false;
    } finally { ok.disabled = false; }
  };
  win.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  cancel.addEventListener('click', close);
  shade.addEventListener('mousedown', (e) => { if (e.target === shade) close(); });
  doc.addEventListener('keydown', onKey, true);
  doc.body.appendChild(shade);
  const first = fields.length ? inputs[fields[0].name] : ok;
  try { first?.focus?.(); } catch {}
  return { el: shade, close, submit };
}

// ---------------------------------------------------------------------------
// DOM: kontextová nabídka

export class ModMenu {
  /**
   * @param {object} o
   * @param {Document} [o.doc]
   * @param {(path: string, opts: {method?: string, body?: object}) => Promise<any>} o.api
   * @param {(target: object) => void} [o.onDelete]  „Smazat zprávu" (část 1, host)
   * @param {(target: object) => void} [o.onHistory]  „Profil" (host otevře UserHistoryPanel); bez něj položka není
   * @param {(text: string, info: {ok: boolean, kind: string, target: object, res?: object, error?: object}) => void} [o.notify]
   * @param {() => Record<string,string[]>} [o.missingScopes]  chybějící mod scopes účtu (/moderation/me)
   * @param {(platform: string, prompt: {text: string, action: string}, info: {kind: string, target: object, res: object}) => void} [o.onModScopes]
   *   akci provedl bot / neprovedl nikdo, protože účtu chybí mod scopes → host nabídne přihlášení s moderací
   * @param {(tag: string, text: string) => void} [o.log]
   */
  constructor({ doc = globalThis.document, api, onDelete, onHistory, notify, missingScopes, onModScopes, log } = {}) {
    this.doc = doc;
    this.api = api;
    this.onDelete = onDelete;
    this.onHistory = onHistory;
    this.notify = notify || (() => {});
    this.missingScopes = missingScopes || (() => ({}));
    this.onModScopes = onModScopes;
    this._resultFns = new Set();
    this.log = log || (() => {});
    this.el = null;
    this.target = null;
    this.dialog = null;
    this._view = 'root';
    this._state = { banned: false };
    this._onDocDown = (e) => { if (this.el && !this.el.contains(e.target)) this.close(); };
    this._onBlur = () => this.close();
    this._onKey = (e) => this._key(e);
  }

  get isOpen() { return !!this.el; }

  /**
   * Odběr úspěšných akcí (Profil si podle nich přebarví řádky). Vrací funkci pro odhlášení.
   * @param {(kind: string, target: object, res: object, x: object) => void} fn
   */
  onResult(fn) {
    this._resultFns.add(fn);
    return () => this._resultFns.delete(fn);
  }

  /**
   * Akce rovnou bez hlavní nabídky (ikony u zprávy v Profilu): delete = hned, ban = potvrzení,
   * timeout / permit = nabídka otevřená rovnou v podnabídce délek (u místa kliknutí).
   * @param {'delete'|'timeout'|'ban'|'permit'} kind
   */
  openAction(kind, target, at = {}) {
    this.log('ModMenu', `akce z Profilu ${kind} → ${target.platform}:${target.userId || '?'} ${target.login}`);
    if (kind === 'delete') return this.run('delete', target);
    if (kind === 'ban') return this._confirmBan(target);
    if (kind === 'timeout' || kind === 'permit') {
      this.open(target, at);
      if (!this.el) return;
      this._view = kind;
      this._render();
      this._focus(1);
    }
  }

  /**
   * @param {{channel?: string, platform: string, userId?: string|null, login: string, displayName?: string,
   *          messageId?: string|null, nickname?: string|null, color?: string|null}} target
   * @param {{x: number, y: number}} at  souřadnice kliknutí (clientX/Y)
   */
  open(target, { x = 0, y = 0 } = {}) {
    this.close();
    this.dialog?.close();
    const doc = this.doc;
    this.target = target;
    this._state = { banned: false };
    this._view = 'root';
    const el = doc.createElement('div');
    el.className = 'uc-mod-menu';
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', `Moderace: ${target.displayName || target.login}`);
    el.tabIndex = -1;
    const head = doc.createElement('div');
    head.className = 'uc-mm-head';
    const name = doc.createElement('span');
    name.className = 'uc-mm-name';
    name.textContent = target.displayName || target.login;
    // Jméno v barvě uživatele z chatu (hostitel pošle už čitelnou barvu jména z .un).
    if (target.nameColor && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i.test(String(target.nameColor))) name.style.color = target.nameColor;
    const plat = doc.createElement('span');
    plat.className = `uc-mm-plat uc-mm-plat--${target.platform}`;
    plat.textContent = PLATFORM_NAMES[target.platform] || target.platform;
    head.append(name, plat);
    if (target.displayName && target.login && target.displayName.toLowerCase() !== target.login.toLowerCase()) {
      const login = doc.createElement('span');
      login.className = 'uc-mm-login';
      login.textContent = target.login;
      head.appendChild(login);
    }
    const list = doc.createElement('div');
    list.className = 'uc-mm-list';
    el.append(head, list);
    this.el = el;
    this._list = list;
    this._render();
    doc.body.appendChild(el);
    this._place(x, y);
    doc.addEventListener('mousedown', this._onDocDown, true);
    doc.addEventListener('contextmenu', this._onDocDown, true);
    el.addEventListener('keydown', this._onKey);
    doc.defaultView?.addEventListener('blur', this._onBlur);
    doc.defaultView?.addEventListener('resize', this._onBlur);
    this._focus(0);
    this.log('ModMenu', `open ${target.platform}:${target.userId || '?'} ${target.login}`);
    if (target.userId) this._loadState(target);
    return el;
  }

  close() {
    if (!this.el) return;
    this._closeFlyout();
    const doc = this.doc;
    this.el.remove();
    this.el = null;
    doc.removeEventListener('mousedown', this._onDocDown, true);
    doc.removeEventListener('contextmenu', this._onDocDown, true);
    doc.defaultView?.removeEventListener('blur', this._onBlur);
    doc.defaultView?.removeEventListener('resize', this._onBlur);
  }

  async _loadState(target) {
    try {
      const r = buildModRequest('state', target);
      const j = await this.api(r.path, { method: r.method });
      if (this.target !== target || !this.el) return;
      const banned = !!j?.banned;
      this.log('ModMenu', `state ${target.platform}:${target.userId} banned=${banned} until=${j?.until ?? null}`);
      if (banned !== this._state.banned) {
        this._state = { banned, until: j?.until ?? null };
        if (this._view === 'root') {
          const focusedId = this.doc.activeElement?.dataset?.id;
          this._render();
          const items = this._items();
          const i = items.findIndex((b) => b.dataset.id === focusedId);
          this._focus(i >= 0 ? i : 0);
        }
      }
    } catch (e) {
      this.log('ModMenu', `state FAIL ${e?.status || 0} ${e?.error || e?.message || e}`);
    }
  }

  _model() {
    const t = this.target;
    return menuModel({ banned: this._state.banned, canDelete: !!t.messageId, hasUserId: !!t.userId, history: typeof this.onHistory === 'function' });
  }

  _render() {
    const doc = this.doc;
    const list = this._list;
    list.replaceChildren();
    const model = this._model();
    let items = model;
    if (this._view !== 'root') {
      const parent = model.find((i) => i.id === this._view);
      items = parent?.sub || [];
      const back = doc.createElement('button');
      back.type = 'button';
      back.className = 'uc-mm-item uc-mm-back';
      back.setAttribute('role', 'menuitem');
      back.tabIndex = -1;
      back.dataset.id = '__back';
      back.textContent = `‹ ${parent?.label || ''}`;
      back.addEventListener('click', (e) => { e.stopPropagation(); this._back(); });
      list.appendChild(back);
    }
    for (const it of items) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = `uc-mm-item${it.danger ? ' uc-mm-item--danger' : ''}`;
      b.setAttribute('role', 'menuitem');
      b.tabIndex = -1;
      b.dataset.id = it.id;
      if (it.disabled) { b.disabled = true; b.setAttribute('aria-disabled', 'true'); b.title = 'Uživatele nejde určit (chybí jeho ID na platformě).'; }
      const label = doc.createElement('span');
      label.textContent = it.label;
      b.appendChild(label);
      if (it.sub) {
        b.setAttribute('aria-haspopup', 'menu');
        const arrow = doc.createElement('span');
        arrow.className = 'uc-mm-arrow';
        arrow.textContent = '›';
        b.appendChild(arrow);
      }
      b.addEventListener('click', (e) => { e.stopPropagation(); this._activate(it, b); });
      // Počítač s myší: podnabídka vyjede vedle při najetí (pokyn usera 2026-09-25), jinak klik.
      if (this._view === 'root') {
        b.addEventListener('mouseenter', () => {
          clearTimeout(this._flyTimer);
          if (it.sub && !it.disabled && this._canFlyout()) this._flyTimer = setTimeout(() => this._openFlyout(it, b), 120);
          else if (!it.sub) this._flyTimer = setTimeout(() => this._closeFlyout(), 150);
        });
      }
      list.appendChild(b);
    }
    if (this._view !== 'root') {
      const parent = model.find((i) => i.id === this._view);
      if (parent?.custom) list.appendChild(this._customRow(parent));
    }
  }

  /**
   * Řádek vlastní délky pod předvolbami: číslo (kolečko myši ±1, nejméně 1) + tlačítka s / m / h,
   * klik na jednotku rovnou provede akci podnabídky (timeout / permit).
   */
  _customRow(parent) {
    const doc = this.doc;
    const row = doc.createElement('div');
    row.className = 'uc-mm-custom';
    const input = doc.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.step = '1';
    input.value = '1';
    input.inputMode = 'numeric';
    input.className = 'uc-mm-custom-num';
    input.setAttribute('aria-label', `Vlastní délka (${parent.label})`);
    const clamp = () => { const n = Math.floor(Number(input.value)); input.value = String(Number.isFinite(n) && n >= 1 ? n : 1); };
    input.addEventListener('wheel', (e) => {
      e.preventDefault();
      const n = Math.max(1, (Math.floor(Number(input.value)) || 1) + (e.deltaY < 0 ? 1 : -1));
      input.value = String(n);
    }, { passive: false });
    input.addEventListener('change', clamp);
    input.addEventListener('click', (e) => e.stopPropagation());
    // Šipky/Home/End patří poli, ne navigaci v nabídce; Enter = sekundy.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || e.key === 'Tab') return;
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); row.querySelector('.uc-mm-unit')?.click(); }
    });
    row.appendChild(input);
    for (const u of CUSTOM_UNITS) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'uc-mm-unit';
      b.textContent = u.id;
      b.title = { s: 'sekundy', m: 'minuty', h: 'hodiny' }[u.id];
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        clamp();
        const sec = customDurationSec(input.value, u.sec, parent.custom.max);
        if (sec == null) {
          row.classList.add('uc-mm-custom--bad');
          b.title = `Nejvýš ${fmtDuration(parent.custom.max)}`;
          setTimeout(() => row.classList.remove('uc-mm-custom--bad'), 600);
          return;
        }
        this._activate({ id: `${parent.id}:${sec}` });
      });
      row.appendChild(b);
    }
    return row;
  }

  /** Podnabídka vedle: jen jemný ukazatel s hoverem (ne mobil) a když se vedle menu vejde. */
  _canFlyout() {
    const win = this.doc.defaultView;
    if (!this.el || !win?.matchMedia?.('(hover: hover) and (pointer: fine)').matches) return false;
    const r = this.el.getBoundingClientRect();
    const need = 150;
    return r.right + need + 8 <= win.innerWidth || r.left - need - 8 >= 0;
  }

  _openFlyout(it, anchor) {
    if (!this.el) return;
    if (this._fly?.dataset.parent === it.id) return;
    this._closeFlyout();
    const doc = this.doc;
    const win = doc.defaultView;
    const fly = doc.createElement('div');
    fly.className = 'uc-mm-fly';
    fly.setAttribute('role', 'menu');
    fly.dataset.parent = it.id;
    for (const s of it.sub) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'uc-mm-item';
      b.setAttribute('role', 'menuitem');
      b.tabIndex = -1;
      b.dataset.id = s.id;
      b.textContent = s.label;
      b.addEventListener('click', (e) => { e.stopPropagation(); this._activate(s); });
      fly.appendChild(b);
    }
    if (it.custom) fly.appendChild(this._customRow(it));
    fly.addEventListener('mouseenter', () => clearTimeout(this._flyTimer));
    this.el.appendChild(fly);
    anchor.classList.add('uc-mm-item--open');
    const r = this.el.getBoundingClientRect();
    const fw = fly.getBoundingClientRect().width || 140;
    const right = r.right + fw + 8 <= (win?.innerWidth || 1000);
    fly.style[right ? 'left' : 'right'] = 'calc(100% + 4px)';
    const top = anchor.offsetTop - 4;
    const maxTop = (win?.innerHeight || 1000) - r.top - fly.getBoundingClientRect().height - 8;
    fly.style.top = `${Math.max(-r.top + 8, Math.min(top, maxTop))}px`;
    this._fly = fly;
    this._flyAnchor = anchor;
  }

  _closeFlyout() {
    clearTimeout(this._flyTimer);
    this._flyAnchor?.classList.remove('uc-mm-item--open');
    this._fly?.remove();
    this._fly = null;
    this._flyAnchor = null;
  }

  _items() {
    const inFly = this._fly && this._fly.contains(this.doc.activeElement);
    const root = inFly ? this._fly : this._list;
    return root ? [...root.querySelectorAll('.uc-mm-item:not([disabled])')] : [];
  }

  _focus(i) {
    const items = this._items();
    if (!items.length) { this.el?.focus(); return; }
    const n = ((i % items.length) + items.length) % items.length;
    items[n].focus();
  }

  _back() {
    const from = this._view;
    this._view = 'root';
    this._render();
    const i = this._items().findIndex((b) => b.dataset.id === from);
    this._focus(i >= 0 ? i : 0);
  }

  _key(e) {
    const items = this._items();
    const cur = items.indexOf(this.doc.activeElement);
    switch (e.key) {
      case 'Escape':
        e.preventDefault(); e.stopPropagation();
        if (this._fly) { const a = this._flyAnchor; this._closeFlyout(); a?.focus(); }
        else if (this._view !== 'root') this._back(); else this.close();
        break;
      case 'ArrowDown': e.preventDefault(); this._focus(cur + 1); break;
      case 'ArrowUp': e.preventDefault(); this._focus(cur < 0 ? -1 : cur - 1); break;
      case 'Home': e.preventDefault(); this._focus(0); break;
      case 'End': e.preventDefault(); this._focus(-1); break;
      case 'ArrowRight': {
        const it = this._model().find((m) => m.id === items[cur]?.dataset.id);
        if (it?.sub && !it.disabled) { e.preventDefault(); this._activate(it, items[cur]); }
        break;
      }
      case 'ArrowLeft':
        if (this._fly && this._fly.contains(this.doc.activeElement)) { e.preventDefault(); const a = this._flyAnchor; this._closeFlyout(); a?.focus(); }
        else if (this._view !== 'root') { e.preventDefault(); this._back(); }
        break;
      case 'Tab': e.preventDefault(); this.close(); break;
      default: break;
    }
  }

  _place(x, y) {
    const el = this.el;
    const win = this.doc.defaultView;
    const vw = win?.innerWidth || 1000, vh = win?.innerHeight || 1000;
    el.style.left = '0px'; el.style.top = '0px';
    const r = el.getBoundingClientRect?.() || { width: 0, height: 0 };
    const m = 8;
    el.style.left = `${Math.max(m, Math.min(x, vw - r.width - m))}px`;
    el.style.top = `${Math.max(m, y + r.height + m > vh ? y - r.height : y)}px`;
  }

  _activate(it, anchor) {
    if (it.disabled) return;
    const t = this.target;
    if (it.sub && anchor && this._view === 'root' && this._canFlyout()) {
      this._openFlyout(it, anchor);
      this._fly?.querySelector('.uc-mm-item')?.focus();
      return;
    }
    if (it.sub) { this._closeFlyout(); this._view = it.id; this._render(); this._focus(1); return; }
    const [kind, arg] = it.id.split(':');
    this.log('ModMenu', `akce ${it.id} → ${t.platform}:${t.userId || '?'} ${t.login}`);
    this.close();
    switch (kind) {
      case 'delete': this.onDelete?.(t); break;
      case 'timeout': this.run('timeout', t, { durationSec: Number(arg) }); break;
      case 'permit': this.run('permit', t, { durationSec: Number(arg) }); break;
      case 'unban': this.run('unban', t); break;
      case 'ban': this._confirmBan(t); break;
      case 'rename': this._renameDialog(t); break;
      case 'history': this.onHistory?.(t); break;
      case 'warn': this._warnDialog(t); break;
      default: break;
    }
  }

  /** Provede akci a ohlásí výsledek. Vrací odpověď; při chybě throw Error(česká hláška). */
  async call(kind, t, x = {}) {
    const r = buildModRequest(kind, t, x);
    try {
      const res = await this.api(r.path, { method: r.method, body: r.body });
      this.log('ModMenu', `${kind} ${t.platform}:${t.userId || '?'} → ${JSON.stringify(res?.results || res?.nickname || 'ok').slice(0, 200)}`);
      return res;
    } catch (e) {
      this.log('ModMenu', `${kind} ${t.platform}:${t.userId || '?'} FAIL ${e?.status || 0} ${e?.error || e?.message || e}`);
      const err = new Error(modErrorText(e));
      err.code = e?.error; err.status = e?.status;
      throw err;
    }
  }

  /** Akce bez dialogu: výsledek i chyba jdou do notify. */
  async run(kind, t, x = {}) {
    try {
      const res = await this.call(kind, t, x);
      this.notify(summarizeModResult(kind, t, res, x), { ok: true, kind, target: t, res });
      this._afterResult(kind, t, res, x);
      return res;
    } catch (e) {
      this.notify(e.message, { ok: false, kind, target: t, error: { error: e.code, status: e.status } });
      return null;
    }
  }

  /** Po úspěšné akci: odběratelé (Profil) + nabídka přihlášení s moderací, když akci neprovedl účet moda. */
  _afterResult(kind, t, res, x = {}) {
    for (const fn of this._resultFns) { try { fn(kind, t, res, x); } catch (e) { this.log('ModMenu', `onResult: ${e?.message || e}`); } }
    const results = kind === 'delete' ? { [t.platform]: res?.result } : (res?.results || {});
    let missing = {};
    try { missing = this.missingScopes() || {}; } catch {}
    for (const p of modScopePlatforms(results, missing)) {
      this.log('ModMenu', `${kind}: ${p} → ${results[p]}, účtu chybí mod scopes → nabídka přihlášení`);
      this.onModScopes?.(p, modScopePrompt(p, results[p]), { kind, target: t, res });
    }
  }

  _confirmBan(t) {
    const who = t.displayName || t.login;
    this.dialog = openModDialog({
      doc: this.doc,
      title: `Zabanovat ${who}?`,
      subtitle: 'Ban platí na všech platformách, kde ho známe (propojený účet UnityChatu), jinak jen na platformě zprávy. Zrušíš ho přes Unban.',
      submitLabel: 'Zabanovat',
      danger: true,
      onSubmit: async () => { await this.run('ban', t); },
      onClose: () => { this.dialog = null; },
    });
  }

  _renameDialog(t) {
    const who = t.displayName || t.login;
    this.dialog = openModDialog({
      doc: this.doc,
      title: `Přejmenovat ${t.login}`,
      subtitle: 'Přezdívka platí v celém UnityChatu. Prázdné pole přezdívku smaže.',
      fields: [
        { name: 'nickname', label: 'Přezdívka', value: t.nickname || '', maxLength: NICKNAME_MAX, placeholder: who },
        { name: 'color', type: 'color', label: 'Vlastní barva', value: t.nickname ? t.color : null },
      ],
      submitLabel: 'Uložit',
      onSubmit: async (v) => {
        const { nickname, error } = validateNickname(v.nickname);
        if (error) throw new Error(error);
        const x = { nickname, color: v.color };
        const res = await this.call('rename', t, x);
        this.notify(summarizeModResult('rename', t, res, x), { ok: true, kind: 'rename', target: t, res });
        this._afterResult('rename', t, res, x);
      },
      onClose: () => { this.dialog = null; },
    });
  }

  _warnDialog(t) {
    const who = t.displayName || t.login;
    this.dialog = openModDialog({
      doc: this.doc,
      title: `Varovat ${who}`,
      subtitle: 'Na Twitchi přijde nativní varování. Uživatel UnityChatu ho uvidí na všech platformách a musí ho potvrdit, než bude moct psát.',
      fields: [{ name: 'reason', type: 'textarea', label: 'Důvod', maxLength: WARN_REASON_MAX, placeholder: 'Např. Nespamuj odkazy' }],
      submitLabel: 'Varovat',
      onSubmit: async (v) => {
        const { reason, error } = validateWarnReason(v.reason);
        if (error) throw new Error(error);
        const res = await this.call('warn', t, { reason });
        this.notify(summarizeModResult('warn', t, res), { ok: true, kind: 'warn', target: t, res });
        this._afterResult('warn', t, res, { reason });
      },
      onClose: () => { this.dialog = null; },
    });
  }
}
