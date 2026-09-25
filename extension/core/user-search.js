// `/user <text>` v poli pro psaní — našeptávač uživatelů kanálu pro moda (2026-09-25).
// Sdílené s webem: bez chrome.*, DOM dodá host jen pro render položky (HTML string).
//
// Tok: host při psaní zavolá `search.query(text, fulltext)` → hned dostane lokální uživatele ze session
// (onResults), po debounce se zeptá serveru `GET /moderation/users/search` (starý požadavek se zruší,
// odpovědi se cachují) a výsledek sloučí s lokálními (dedup podle platforma + userId / login).
// Výběr položky = otevřít Profil (UserHistoryPanel.open), nic se neodesílá. Jen pro moda — host
// `/user` divákům vůbec nenabízí (a server nemodovi vrací 403).
//
// Kontrakt: docs/superpowers/plans/2026-09-25-moderace-cast-2-kontrakt.md, sekce „Vyhledání uživatele“.

export const USER_CMD = '/user';
export const USER_SEARCH_Q_MAX = 40;
export const USER_SEARCH_DEBOUNCE_MS = 200;
export const USER_SEARCH_CACHE = 30;

/** Bez diakritiky a malými písmeny (stejně jako backend foldName / uc_fold). */
export function foldName(s) {
  return String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * Text pole → hledaný text `/user <text>`. `{ query: '' }` = napsané jen `/user` (nebo `/user `),
 * null = pole není příkaz /user. Úvodní @ se zahodí (`/user @zigi`), text se ořízne na 40 znaků.
 */
export function parseUserCommand(text) {
  const t = String(text || '');
  if (!/^\/user(\s|$)/i.test(t)) return null;
  const q = t.slice(USER_CMD.length).trim().replace(/^@/, '').trim();
  return { query: q.slice(0, USER_SEARCH_Q_MAX) };
}

/** 0 = přesná shoda (login, jméno, přezdívka), 1 = začátek, 2 = jinde. */
export function userMatchRank(h, q) {
  const f = foldName(q);
  const names = [h.login, h.displayName, h.nickname].filter(Boolean).map(foldName);
  if (names.some((n) => n === f)) return 0;
  if (names.some((n) => n.startsWith(f))) return 1;
  return 2;
}

/** Odpovídá uživatel dotazu? Fulltext = kdekoli ve jménu / přezdívce, jinak začátek. */
export function userMatches(h, q, fulltext) {
  const f = foldName(q);
  if (!f) return false;
  return [h.login, h.displayName, h.nickname].filter(Boolean).map(foldName).some((n) => (fulltext ? n.includes(f) : n.startsWith(f)));
}

/** Řazení jako backend: přesná shoda → začátek → poslední aktivita (pak počet zpráv, login). */
export function rankUserHits(hits, q) {
  return hits
    .map((h) => ({ h, r: userMatchRank(h, q) }))
    .sort((a, b) => a.r - b.r || (b.h.lastSeen || 0) - (a.h.lastSeen || 0) || (b.h.count || 0) - (a.h.count || 0) || String(a.h.login).localeCompare(String(b.h.login)))
    .map((x) => x.h);
}

const keyOf = (h) => `${h.platform}:${String(h.login || '').toLowerCase()}`;

/**
 * Sloučí lokální (session) a serverové výsledky: server vyhrává (má userId, počet, lastSeen), lokální
 * doplní barvu; dedup podle platforma + userId, jinak platforma + login.
 */
export function mergeUserHits(local, server, q, limit = 20) {
  const out = [];
  const byKey = new Map();
  const byId = new Map();
  const add = (h, fromServer) => {
    const k = keyOf(h);
    const idk = h.userId ? `${h.platform}#${h.userId}` : null;
    const prev = (idk && byId.get(idk)) || byKey.get(k);
    if (prev) {
      if (fromServer) {
        const color = h.color || prev.color;
        Object.assign(prev, h, color ? { color } : {});
      } else if (!prev.color && h.color) prev.color = h.color;
      if (prev.userId) byId.set(`${prev.platform}#${prev.userId}`, prev);
      byKey.set(keyOf(prev), prev);
      return;
    }
    const copy = { ...h };
    out.push(copy);
    byKey.set(k, copy);
    if (idk) byId.set(idk, copy);
  };
  for (const h of server || []) add(h, true);
  for (const h of local || []) add(h, false);
  return rankUserHits(out, q).slice(0, limit);
}

/**
 * Uživatelé ze session (host: záznamy { platform, login, displayName?, userId?, color?, lastSeen? })
 * odpovídající dotazu; `nickname(platform, login)` doplní UC přezdívku.
 */
export function localUserHits(entries, q, { fulltext = false, nickname = () => null } = {}) {
  const seen = new Set();
  const out = [];
  for (const e of entries || []) {
    if (!e?.platform || !e.login) continue;
    const login = String(e.login).replace(/^@/, '').toLowerCase();
    const k = `${e.platform}:${login}`;
    if (seen.has(k)) continue;
    const nick = nickname(e.platform, login) || undefined;
    const h = { platform: e.platform, userId: e.userId || null, login, displayName: e.displayName || e.login, ...(nick ? { nickname: nick } : {}), ...(e.color ? { color: e.color } : {}), lastSeen: e.lastSeen || 0, count: 0, local: true };
    if (!userMatches(h, q, fulltext)) continue;
    seen.add(k);
    out.push(h);
  }
  return out;
}

/**
 * Položka našeptávače (vnitřek `.es-item`): barevná tečka, logo platformy, přezdívka (nebo jméno) a šedě login.
 * `esc` = escapeHtml, `escAttr` = escape atributu, `platformIcon(p)` → URL loga, `color(hit)` → bezpečná barva.
 */
export function userSearchItemHtml(h, { esc, escAttr = esc, platformIcon = () => null, color = (x) => x.color || null } = {}) {
  const col = color(h) || '#ccc';
  const icon = platformIcon(h.platform);
  const main = h.nickname || h.displayName || h.login;
  const sub = h.nickname ? (h.displayName || h.login) : (String(h.displayName || '').toLowerCase() !== h.login ? h.login : '');
  return `<span class="es-dot" style="background:${escAttr(col)}"></span>`
    + (icon ? `<img class="es-plat" src="${escAttr(icon)}" alt="${escAttr(h.platform)}">` : '')
    + `<span class="es-name"><span class="es-name-inner">${esc(main)}${sub ? ` <span class="es-login">${esc(sub)}</span>` : ''}</span></span>`;
}

/**
 * Dotazy na server s debounce, zrušením starého požadavku a cache posledních dotazů.
 * `api(path, { signal })` → JSON (throw { error, status }); `channel()` = UC kanál;
 * `local(q, fulltext)` → lokální hity; `onResults({ query, fulltext, users, loading, error })`.
 */
export class UserSearch {
  constructor({ api, channel, local = () => [], onResults, debounceMs = USER_SEARCH_DEBOUNCE_MS, cacheSize = USER_SEARCH_CACHE, limit = 20, log = () => {}, setTimeout: st = globalThis.setTimeout.bind(globalThis), clearTimeout: ct = globalThis.clearTimeout.bind(globalThis) }) {
    Object.assign(this, { api, channel, local, onResults, debounceMs, cacheSize, limit, log, _st: st, _ct: ct });
    this._cache = new Map();
    this._timer = null;
    this._ctrl = null;
    this._seq = 0;
  }

  static cacheKey(channel, q, fulltext) { return `${channel}|${fulltext ? 1 : 0}|${foldName(q)}`; }

  /** Nový dotaz (každý znak v poli). Prázdný dotaz = zrušit a vrátit prázdný seznam. */
  query(q, fulltext = false) {
    const seq = ++this._seq;
    this._abort();
    const query = String(q || '').trim();
    if (!query) { this.onResults?.({ query, fulltext, users: [], loading: false }); return; }
    const local = this.local(query, fulltext) || [];
    const ch = this.channel();
    const key = UserSearch.cacheKey(ch, query, fulltext);
    const cached = this._cache.get(key);
    if (cached) {
      this.onResults?.({ query, fulltext, users: mergeUserHits(local, cached, query, this.limit), loading: false });
      return;
    }
    this.onResults?.({ query, fulltext, users: mergeUserHits(local, [], query, this.limit), loading: true });
    this._timer = this._st(() => this._fetch(seq, ch, query, fulltext, key), this.debounceMs);
  }

  cancel() { this._seq++; this._abort(); }

  _abort() {
    if (this._timer) { this._ct(this._timer); this._timer = null; }
    if (this._ctrl) { try { this._ctrl.abort(); } catch {} this._ctrl = null; }
  }

  async _fetch(seq, ch, query, fulltext, key) {
    this._timer = null;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    this._ctrl = ctrl;
    const path = `/moderation/users/search?channel=${encodeURIComponent(ch)}&q=${encodeURIComponent(query)}&fulltext=${fulltext ? 1 : 0}&limit=${this.limit}`;
    let users = null;
    let error = null;
    try {
      const j = await this.api(path, { signal: ctrl?.signal });
      users = Array.isArray(j?.users) ? j.users : [];
    } catch (e) {
      error = e;
    }
    if (seq !== this._seq) return;   // mezitím novější dotaz (nebo zrušeno)
    this._ctrl = null;
    const local = this.local(query, fulltext) || [];
    if (users) {
      this._cache.set(key, users);
      while (this._cache.size > this.cacheSize) this._cache.delete(this._cache.keys().next().value);
      this.log('UserSearch', `„${query.length} zn.“ ft=${fulltext ? 1 : 0} → ${users.length} ze serveru`);
    } else {
      this.log('UserSearch', `chyba ${error?.status || ''} ${error?.error || error?.message || ''}`.trim());
    }
    this.onResults?.({ query, fulltext, users: mergeUserHits(local, users || [], query, this.limit), loading: false, ...(error ? { error } : {}) });
  }
}
