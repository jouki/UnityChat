// Soundboard sound efektů (spec docs/superpowers/specs/2026-09-24-soundboard-se-tiers-design.md)
// — sdílené addonem i webem. Data: backend GET /soundboard (katalog + stav diváka ze
// Židolišty), živé změny přes SSE soundboard-*. DOM dostává zvenku (host + tlačítko),
// odeslání commandu, oblíbené a přihlášení řeší hostitel přes callbacky.
//
// UnityChat NIKDY nepřehrává SE jako reakci na command (zvuk je slyšet ze streamu);
// jediné přehrávání tady je lokální náhled po kliku na repráček.

export const PLATFORM_NAMES = { twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ms = (iso) => { const t = Date.parse(iso ?? ''); return Number.isNaN(t) ? null : t; };

/**
 * Odpověď GET /soundboard → stav pro UI. `offsetMs` = posun serverových hodin proti
 * klientovým (serverNow − teď), všechny časové výpočty ho přičítají k Date.now().
 */
export function normalizeSoundboard(raw, clientNow = Date.now()) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const sounds = (Array.isArray(r.sounds) ? r.sounds : []).filter((s) => s && Number.isInteger(s.id) && s.name && s.url);
  const ids = new Set(sounds.map((s) => s.id));
  const server = ms(r.serverNow);
  const me = r.me && typeof r.me === 'object' ? {
    platform: r.me.platform,
    userId: String(r.me.userId ?? ''),
    login: r.me.login || '',
    role: r.me.role || 'viewer',
    // Kontrakt v1.1: zmrazená odměna má paused + remainingMs (zamrzlý čas), expiresAt pak null;
    // available = smí se přehrát (zmrazená ne). Bez polí = v1 (běží, přehrát jde).
    tiers: (Array.isArray(r.me.tiers) ? r.me.tiers : []).map((t) => {
      const paused = t.paused === true;
      const num = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
      return { tier: t.tier, startedAt: ms(t.startedAt), expiresAt: paused ? null : ms(t.expiresAt), paused, remainingMs: paused ? num(t.remainingMs) : null, totalMs: num(t.totalMs), available: !paused && t.available !== false };
    }),
    cooldown: { globalReadyAt: ms(r.me.cooldown?.globalReadyAt), userReadyAt: ms(r.me.cooldown?.userReadyAt) },
  } : null;
  return {
    channel: r.channel || '',
    platform: r.platform || me?.platform || 'twitch',
    loggedIn: !!r.loggedIn,
    offsetMs: server === null ? 0 : server - clientNow,
    tiers: Array.isArray(r.tiers) ? r.tiers : [],
    sounds,
    me,
    favorites: (Array.isArray(r.favorites) ? r.favorites : []).filter((id) => ids.has(id)),
    recent: (Array.isArray(r.recent) ? r.recent : []).filter((id) => ids.has(id)),
    denied: null,
  };
}

/**
 * Čas tieru: { remainingMs|null, progress|null, paused }. null remaining = bez omezení.
 * Zmrazený tier má zamrzlý remainingMs; progress z totalMs (když ho server pošle), jinak ze startedAt→expiresAt.
 */
export function tierTime(t, now) {
  if (t.paused) {
    const rem = t.remainingMs;
    return { paused: true, remainingMs: rem, progress: rem !== null && t.totalMs ? Math.min(1, Math.max(0, rem / t.totalMs)) : null };
  }
  if (t.expiresAt === null) return { paused: false, remainingMs: null, progress: null };
  const rem = t.expiresAt - now;
  const total = t.totalMs || (t.startedAt !== null ? t.expiresAt - t.startedAt : null);
  return { paused: false, remainingMs: rem, progress: !total || total <= 0 ? 1 : Math.min(1, Math.max(0, rem / total)) };
}

const rank = (t, now) => (t.available ? 2 : 1) * 1e15 + (t.paused ? (t.remainingMs ?? 0) : t.expiresAt === null ? 1e14 : t.expiresAt - now);

/** Tiery odemčené v čase `now` (serverové ms), včetně zmrazených → Map tier → záznam. */
export function unlockedTiers(state, now) {
  const out = new Map();
  for (const t of state?.me?.tiers || []) {
    if (!t.paused && t.expiresAt !== null && t.expiresAt <= now) continue;
    const prev = out.get(t.tier);
    // Stejný tier víckrát (Židolišta slučuje, ale pro jistotu): hratelný před zmrazeným, pak ten delší.
    if (!prev || rank(t, now) > rank(prev, now)) out.set(t.tier, t);
  }
  return out;
}

/** Tiery, ze kterých se teď smí přehrávat (odemčené, nezmrazené). */
export function playableTiers(state, now) {
  return new Set([...unlockedTiers(state, now)].filter(([, t]) => t.available !== false && !t.paused).map(([tier]) => tier));
}

/** Zbývající cooldown v ms (globální nebo můj, co je delší); 0 = lze hned. */
export function cooldownLeft(state, now) {
  const c = state?.me?.cooldown;
  if (!c) return 0;
  return Math.max(0, (c.globalReadyAt ?? 0) - now, (c.userReadyAt ?? 0) - now);
}

/** „4:32“, „1:02:10“, pod minutu „12 s“. */
export function formatRemaining(msLeft) {
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/**
 * Stav tlačítka noty:
 *   hidden — kanál nemá žádné zvuky;
 *   login  — divák není přihlášený k UnityChatu;
 *   link   — přihlášený, ale na aktivní platformě nemá napojený účet;
 *   locked — odměna není aktivní;
 *   active — aspoň jeden tier odemčený.
 * `progress` (0–1) a `remainingMs` podle tieru, který vyprší nejpozději; null = bez omezení.
 */
export function soundboardIconState(state, now) {
  if (!state || !state.sounds.length) return { mode: 'hidden' };
  if (!state.loggedIn) return { mode: 'login', title: 'Soundboard', lines: ['Přihlas se k UnityChatu, ať vidíš, jestli máš sound efekty odemčené.'] };
  // Sound efekty fungují stejně ze všech platforem — výzva je obecná, ne „připoj Twitch" (pokyn usera 2026-09-24).
  if (!state.me) return { mode: 'link', title: 'Soundboard', lines: ['Přihlas se k UnityChatu, ať vidíš, jestli máš sound efekty odemčené.'] };
  const unlocked = unlockedTiers(state, now);
  if (!unlocked.size) return { mode: 'locked', title: 'Odměna není aktivována', lines: ['Sound efekty se odemykají milestony Židolišty.'] };
  const rows = sortTiers(state, [...unlocked.keys()]).map((tier) => [tier, unlocked.get(tier)]).map(([tier, t]) => ({ tier, name: tierLabel(state, tier), nameHtml: tierLabelHtml(state, tier), ...tierTime(t, now) }));
  // Všechno zmrazené: ikona neaktivní jako u zamčené odměny, tooltip ukáže zastavený čas.
  if (!playableTiers(state, now).size) return { mode: 'paused', title: 'Odměna je pozastavená', lines: ['Streamer časovač zastavil, sound efekty teď nejdou pustit.'], rows, cooldownMs: 0, remainingMs: null, progress: null };
  const timed = rows.filter((r) => r.remainingMs !== null);
  const unlimited = rows.some((r) => r.remainingMs === null);
  const longest = timed.reduce((a, r) => (!a || r.remainingMs > a.remainingMs ? r : a), null);
  const cd = cooldownLeft(state, now);
  return {
    mode: 'active',
    title: 'Sound efekty aktivní',
    rows,
    cooldownMs: cd,
    remainingMs: unlimited ? null : longest.remainingMs,
    progress: unlimited ? null : longest.progress,
  };
}


/** Pořadí tieru (v1.2 position z dashboardu; bez něj číslo tieru). */
export function tierPosition(state, tier) {
  const t = state?.tiers?.find((x) => x.tier === tier);
  return Number.isInteger(t?.position) && t.position > 0 ? t.position : tier;
}

/** Tiery v pořadí z dashboardu (sekce soundboardu, řádky tooltipu). */
export function sortTiers(state, tiers) {
  return [...tiers].sort((a, b) => tierPosition(state, a) - tierPosition(state, b) || a - b);
}

function tierParts(state, tier) {
  const t = state?.tiers?.find((x) => x.tier === tier);
  const n = tierPosition(state, tier);
  const name = String(t?.name || '').trim();
  // Název, který jen opakuje číslo („Tier 1“), nezdvojovat.
  return { n, name: name && name.toLowerCase() !== `tier ${n}` ? name : '' };
}

/** Popisek tieru jako text: „BASIC (Tier 1)“, bez jména „Tier 1“ (stejně jako dashboard Židolišty). */
export function tierLabel(state, tier) {
  const { n, name } = tierParts(state, tier);
  return name ? `${name} (Tier ${n})` : `Tier ${n}`;
}

/** Totéž jako HTML: „(Tier 1)“ menším a nevýrazným písmem. */
export function tierLabelHtml(state, tier) {
  const { n, name } = tierParts(state, tier);
  return name ? `${esc(name)} <span class="uc-sb-tiern">(Tier ${n})</span>` : `Tier ${n}`;
}

/** Popisek zvuku v tlačítku: srozumitelný název, když ho mod v Židolišti nastavil, jinak jméno pro !se. */
export const soundLabel = (s) => (s?.displayName && String(s.displayName).trim()) || s?.name || '';

/** Ikona zvuku → HTML: 7TV obrázek (jen z cdn.7tv.app, backend to hlídá i tady), emoji, nebo nic. */
export function soundIconHtml(s) {
  const i = s?.icon;
  if (i?.kind === '7tv' && /^https:\/\/cdn\.7tv\.app\/emote\/[A-Za-z0-9]+\/[1-4]x\.(webp|avif|png|gif)$/.test(i.url || '')) {
    return `<img class="uc-sb-img" src="${esc(i.url)}" alt="${esc(i.name || '')}" loading="lazy" decoding="async">`;
  }
  const emoji = i?.kind === 'emoji' ? i.value : s?.emoji;
  return emoji ? `<span class="uc-sb-em">${esc(emoji)}</span>` : '';
}

/** Hledání: bez diakritiky a velikosti písmen, začátek jména má přednost. */
export function searchSounds(sounds, query) {
  const norm = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const q = norm(query).trim();
  if (!q) return [];
  const starts = [], inside = [];
  for (const s of sounds) {
    // Hledá se podle jména pro !se i podle srozumitelného názvu (displayName).
    const names = [norm(s.name), norm(s.displayName)].filter(Boolean);
    if (names.some((n) => n.startsWith(q))) starts.push(s); else if (names.some((n) => n.includes(q))) inside.push(s);
  }
  return [...starts, ...inside];
}

/**
 * SSE soundboard-played / soundboard-denied → nový stav (bez refetch). Played posune
 * globální cooldown všem a osobní tomu, kdo přehrával; denied si pamatuje jen můj
 * (UI ho ukáže v patičce). soundboard-change řeší hostitel refetchem.
 */
export function applySoundboardEvent(state, type, data) {
  if (!state?.me || !data) return state;
  const mine = data.platform === state.me.platform && String(data.userId) === state.me.userId;
  if (type === 'soundboard-played') {
    const cooldown = { ...state.me.cooldown };
    const g = ms(data.globalReadyAt);
    if (g !== null) cooldown.globalReadyAt = Math.max(cooldown.globalReadyAt ?? 0, g);
    if (mine) { const u = ms(data.userReadyAt); if (u !== null) cooldown.userReadyAt = u; }
    const recent = mine && Number.isInteger(data.soundId) ? [data.soundId, ...state.recent.filter((id) => id !== data.soundId)].slice(0, 8) : state.recent;
    return { ...state, me: { ...state.me, cooldown }, recent, denied: mine ? null : state.denied };
  }
  if (type === 'soundboard-denied' && mine) {
    return { ...state, denied: { name: data.name, reason: data.reason, retryAt: ms(data.retryAt), at: Date.now() } };
  }
  return state;
}

const DENIED_TEXT = { cooldown: 'Cooldown', locked: 'Zvuk je zamčený', unknown: 'Zvuk nenalezen' };
const DENIED_SHOW_MS = 8000;

/** SVG osminové noty pro tlačítko (stejné v addonu i na webu). */
export const SOUNDBOARD_BUTTON_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M13 3.2a1 1 0 0 1 1.45-.9c2.9 1.45 4.55 3.4 4.55 6.2 0 1.02-.23 2.03-.66 2.93a1 1 0 1 1-1.8-.86c.3-.63.46-1.36.46-2.07 0-1.53-.72-2.73-2-3.73V16.5a3.5 3.5 0 1 1-2-3.16V3.2Z"/></svg>';
const SPEAKER_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M11 5 6.5 8.5H3v7h3.5L11 19V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.3 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const STAR_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
const LOCK_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M7 10V8a5 5 0 0 1 10 0v2h1a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h1Zm2 0h6V8a3 3 0 0 0-6 0v2Z"/></svg>';

/**
 * Soundboard: tlačítko `button` (nota) otevírá panel vložený do `host` (#input-area).
 * @param {object} o
 * @param {HTMLElement} o.host
 * @param {HTMLElement} o.button
 * @param {(sound: {id:number,name:string}) => void} o.onSend       napsat `!se <jméno>` do chatu
 * @param {(soundId: number, on: boolean) => (Promise<unknown>|void)} [o.onFavorite]
 * @param {(platform?: string) => void} [o.onLogin]                přihlásit / připojit platformu
 * @param {{ load(): number|null, save(v: number): void }} [o.volume]   hlasitost náhledu 0–1
 * @param {(tag: string, text: string) => void} [o.log]
 */
export function createSoundboard({ host, button, onSend, onFavorite, onLogin, volume, log }) {
  const doc = host.ownerDocument;
  const win = doc.defaultView;
  let state = null;
  let vol = 0.6;
  try { const v = Number(volume?.load?.()); if (v >= 0 && v <= 1) vol = v; } catch { /* ignore */ }

  const panel = doc.createElement('div');
  panel.className = 'uc-sb hidden';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Soundboard');
  panel.innerHTML = `
    <div class="uc-sb-top">
      <input type="search" placeholder="Najdi zvuk…" autocomplete="off" spellcheck="false" aria-label="Hledat zvuk">
      <label class="uc-sb-vol" title="Hlasitost náhledu (jen pro tebe)">${SPEAKER_SVG}<input type="range" min="0" max="100" step="1" aria-label="Hlasitost náhledu"></label>
    </div>
    <div class="uc-sb-status"></div>
    <div class="uc-sb-body"></div>
    <div class="uc-sb-foot"></div>`;
  host.appendChild(panel);
  const search = panel.querySelector('input[type="search"]');
  const volInput = panel.querySelector('.uc-sb-vol input');
  const statusEl = panel.querySelector('.uc-sb-status');
  const body = panel.querySelector('.uc-sb-body');
  const foot = panel.querySelector('.uc-sb-foot');
  volInput.value = String(Math.round(vol * 100));

  const tip = doc.createElement('div');
  tip.className = 'uc-sb-tip hidden';
  tip.setAttribute('role', 'tooltip');
  host.appendChild(tip);

  button.innerHTML = `${SOUNDBOARD_BUTTON_SVG}<span class="uc-sb-bar"></span>`;
  button.classList.add('uc-sb-btn');
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.removeAttribute('title');   // vlastní tooltip

  const now = () => Date.now() + (state?.offsetMs || 0);
  const audio = new win.Audio();
  audio.preload = 'none';

  // ---- tlačítko + tooltip ----
  let tipOpen = false;
  function renderButton() {
    const s = soundboardIconState(state, now());
    button.classList.toggle('hidden', s.mode === 'hidden');
    button.classList.toggle('uc-sb-off', s.mode !== 'active');
    button.classList.toggle('uc-sb-cd', s.mode === 'active' && s.cooldownMs > 0);
    button.setAttribute('aria-label', s.mode === 'active' ? 'Soundboard' : `Soundboard: ${s.title}`);
    button.style.setProperty('--uc-sb-p', s.mode === 'active' && s.progress !== null ? String(s.progress) : '1');
    button.classList.toggle('uc-sb-timed', s.mode === 'active' && s.progress !== null);
    // Ikona je aktivní jen s odemčeným tierem; vypršení během otevřeného panelu ho zavře.
    if (s.mode !== 'active' && isOpen()) close();
    if (tipOpen) renderTip(s);
    return s;
  }
  function renderTip(s = soundboardIconState(state, now())) {
    if (s.mode === 'hidden') { hideTip(); return; }
    const lines = (s.lines || []).map((l) => `<div class="uc-sb-tip-l">${esc(l)}</div>`).join('');
    const rows = (s.rows || []).map((r) => `<div class="uc-sb-tip-r"><span>${r.nameHtml || esc(r.name)}</span><b>${r.paused ? '⏸ ' : ''}${r.remainingMs === null ? (r.paused ? 'pozastaveno' : 'bez omezení') : esc(formatRemaining(r.remainingMs))}</b>${r.progress === null ? '' : `<i style="--p:${r.progress.toFixed(4)}"></i>`}</div>`).join('');
    const cd = s.cooldownMs > 0 ? `<div class="uc-sb-tip-cd">Cooldown ${esc(formatRemaining(s.cooldownMs))}</div>` : '';
    tip.className = `uc-sb-tip uc-sb-tip-${s.mode}`;
    tip.innerHTML = `<div class="uc-sb-tip-t">${esc(s.title)}</div>${lines}${rows}${cd}`;
  }
  function showTip() { if (isOpen()) return; tipOpen = true; renderTip(); }
  function hideTip() { tipOpen = false; tip.classList.add('hidden'); }

  // ---- panel ----
  const favSet = () => new Set(state?.favorites || []);
  function soundBtn(s, { playable, unlocked, cd, favs }) {
    const locked = !playable.has(s.tier);
    const cls = ['uc-sb-s', locked ? 'locked' : '', cd > 0 && !locked ? 'cd' : ''].filter(Boolean).join(' ');
    const label = soundLabel(s);
    const why = unlocked.get(s.tier)?.paused ? 'je pozastavený' : 'není odemčený';
    const title = locked ? `${label} — ${tierLabel(state, s.tier)} ${why}` : `!se ${s.name}`;
    return `<div class="${cls}" data-id="${s.id}" title="${esc(title)}">
      <button type="button" class="uc-sb-play" data-act="send"${locked ? ' aria-disabled="true"' : ''}>${soundIconHtml(s)}<span class="uc-sb-n">${esc(label)}</span></button>
      <button type="button" class="uc-sb-pv" data-act="preview" title="Přehrát jen pro sebe" aria-label="Náhled ${esc(label)}">${SPEAKER_SVG}</button>
      <button type="button" class="uc-sb-fav${favs.has(s.id) ? ' on' : ''}" data-act="fav" title="${favs.has(s.id) ? 'Odebrat z oblíbených' : 'Přidat do oblíbených'}" aria-label="Oblíbené ${esc(label)}">${STAR_SVG}</button>
    </div>`;
  }
  function section(key, head, list, ctx, extra = '') {
    if (!list.length) return '';
    return `<div class="uc-sb-sec" data-sec="${esc(key)}"><div class="uc-sb-h">${head}${extra}</div><div class="uc-sb-grid">${list.map((s) => soundBtn(s, ctx)).join('')}</div></div>`;
  }

  /** Hlavička sekce tieru: zamčeno / pozastaveno se zamrzlým časem / bez omezení / odpočet + pruh. */
  function tierBadge(u, t) {
    if (!u) return `<span class="uc-sb-lock">${LOCK_SVG} zamčeno</span>`;
    const tt = tierTime(u, t);
    const bar = tt.progress === null ? '' : `<i class="uc-sb-hbar${tt.paused ? ' paused' : ''}" style="--p:${tt.progress.toFixed(4)}"></i>`;
    if (tt.paused) return `<span class="uc-sb-time paused">⏸ ${tt.remainingMs === null ? 'pozastaveno' : esc(formatRemaining(tt.remainingMs))}</span>${bar}`;
    if (tt.remainingMs === null) return '<span class="uc-sb-time">bez omezení</span>';
    return `<span class="uc-sb-time" data-exp="${u.expiresAt}">${esc(formatRemaining(tt.remainingMs))}</span>${bar}`;
  }

  function renderPanel() {
    if (!state) return;
    const t = now();
    const unlocked = unlockedTiers(state, t);
    const ctx = { unlocked, playable: playableTiers(state, t), cd: cooldownLeft(state, t), favs: favSet() };
    const byId = new Map(state.sounds.map((s) => [s.id, s]));
    const q = search.value.trim();
    const top = body.scrollTop;
    if (q) {
      const hits = searchSounds(state.sounds, q);
      body.innerHTML = hits.length ? section('search', `Výsledky pro „${esc(q)}“`, hits, ctx) : `<div class="uc-sb-empty">Žádný zvuk neodpovídá „${esc(q)}“.</div>`;
    } else {
      const parts = [
        section('fav', 'Oblíbené', state.favorites.map((id) => byId.get(id)).filter(Boolean), ctx),
        section('recent', 'Často používané', state.recent.map((id) => byId.get(id)).filter(Boolean), ctx),
      ];
      const tiers = sortTiers(state, [...new Set(state.sounds.map((s) => s.tier))]);
      for (const tier of tiers) {
        parts.push(section(`t${tier}`, tierLabelHtml(state, tier), state.sounds.filter((s) => s.tier === tier), ctx, tierBadge(unlocked.get(tier), t)));
      }
      body.innerHTML = parts.join('');
    }
    body.scrollTop = top;
    renderStatus();
  }

  function renderStatus() {
    const s = soundboardIconState(state, now());
    let html = '';
    if (s.mode === 'active' && s.cooldownMs > 0) html = `<span class="uc-sb-cdtxt">Cooldown ${esc(formatRemaining(s.cooldownMs))}</span>`;
    statusEl.innerHTML = html;
    statusEl.classList.toggle('hidden', !html);
    const d = state?.denied;
    if (d && Date.now() - d.at < DENIED_SHOW_MS) {
      const retry = d.retryAt ? ` · znovu za ${formatRemaining(d.retryAt - now())}` : '';
      foot.textContent = `!se ${d.name || ''}: ${DENIED_TEXT[d.reason] || 'Nepřehráno'}${retry}`;
      foot.classList.add('err');
    } else if (foot.classList.contains('err')) { foot.textContent = ''; foot.classList.remove('err'); }
  }

  function open() {
    if (soundboardIconState(state, now()).mode !== 'active') return;
    hideTip();
    renderPanel();
    panel.classList.remove('hidden');
    button.classList.add('active');
    button.setAttribute('aria-expanded', 'true');
    const touch = typeof win.matchMedia === 'function' && win.matchMedia('(pointer: coarse)').matches;
    if (!touch) { search.focus(); search.select(); }
  }
  function close() {
    if (panel.classList.contains('hidden')) return;
    panel.classList.add('hidden');
    button.classList.remove('active');
    button.setAttribute('aria-expanded', 'false');
    audio.pause();
  }
  const isOpen = () => !panel.classList.contains('hidden');
  const toggle = () => (isOpen() ? close() : open());

  function preview(sound) {
    try {
      if (audio.dataset.id === String(sound.id) && !audio.paused) { audio.pause(); audio.currentTime = 0; return; }
      audio.dataset.id = String(sound.id);
      audio.src = sound.url;
      audio.volume = vol;
      audio.currentTime = 0;
      audio.play().catch((e) => log?.('Soundboard', `náhled ${sound.name} selhal: ${e?.message || e}`));
    } catch (e) { log?.('Soundboard', `náhled ${sound.name} selhal: ${e?.message || e}`); }
  }

  function send(sound) {
    const t = now();
    if (!playableTiers(state, t).has(sound.tier)) return;
    if (cooldownLeft(state, t) > 0) return;
    log?.('Soundboard', `!se ${sound.name}`);
    onSend?.(sound);
  }

  async function toggleFav(sound) {
    const on = !state.favorites.includes(sound.id);
    const prev = state.favorites;
    state = { ...state, favorites: on ? [...prev, sound.id] : prev.filter((id) => id !== sound.id) };
    renderPanel();
    try { await onFavorite?.(sound.id, on); }
    catch (e) {
      log?.('Soundboard', `oblíbené ${sound.name} selhalo: ${e?.message || e}`);
      state = { ...state, favorites: prev };
      renderPanel();
    }
  }

  // ---- události ----
  button.addEventListener('mousedown', (e) => e.preventDefault());   // neukrást fokus textarea
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    const s = soundboardIconState(state, now());
    if (s.mode === 'login' || s.mode === 'link') { hideTip(); onLogin?.(); return; }
    if (s.mode !== 'active') return;   // odměna není aktivní: ikona je deaktivovaná, vysvětlí to tooltip
    toggle();
  });
  button.addEventListener('mouseenter', showTip);
  button.addEventListener('mouseleave', hideTip);
  button.addEventListener('focus', showTip);
  button.addEventListener('blur', hideTip);

  search.addEventListener('input', renderPanel);
  search.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
    else if (e.key === 'Enter') {
      // Enter = první odemčený zvuk ve výsledcích.
      e.preventDefault();
      const first = body.querySelector('.uc-sb-s:not(.locked)');
      const sound = first && state.sounds.find((s) => s.id === Number(first.dataset.id));
      if (sound) send(sound);
    }
  });
  volInput.addEventListener('input', () => {
    vol = Math.min(1, Math.max(0, Number(volInput.value) / 100));
    audio.volume = vol;
    try { volume?.save?.(vol); } catch { /* ignore */ }
  });
  panel.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const card = b.closest('.uc-sb-s');
    const sound = card && state.sounds.find((s) => s.id === Number(card.dataset.id));
    if (!sound) return;
    if (b.dataset.act === 'preview') preview(sound);
    else if (b.dataset.act === 'fav') toggleFav(sound);
    else if (b.dataset.act === 'send') send(sound);
  });
  const onDocDown = (e) => { if (isOpen() && !panel.contains(e.target) && !button.contains(e.target)) close(); };
  const onDocKey = (e) => { if (e.key === 'Escape' && isOpen()) close(); };
  doc.addEventListener('mousedown', onDocDown);
  doc.addEventListener('keydown', onDocKey);

  // Tik 1 s: odpočty, progress, vypršení tieru a cooldownu. Jen když je co počítat.
  let lastSig = '';
  const timer = win.setInterval(() => {
    if (!state?.me) return;
    renderButton();
    if (!isOpen()) return;
    // Mimo změnu odemčení/cooldownu stačí přepsat čísla, ne celý panel (neblikat pod myší).
    const sig = `${[...unlockedTiers(state, now()).keys()].join(',')}|${[...playableTiers(state, now())].join(',')}|${cooldownLeft(state, now()) > 0}`;
    if (sig !== lastSig) { lastSig = sig; renderPanel(); return; }
    const t = now();
    for (const el of body.querySelectorAll('.uc-sb-time[data-exp]')) el.textContent = formatRemaining(Number(el.dataset.exp) - t);
    for (const sec of body.querySelectorAll('.uc-sb-sec')) {
      const tier = Number(sec.dataset.sec?.slice(1));
      const u = unlockedTiers(state, t).get(tier);
      const bar = sec.querySelector('.uc-sb-hbar');
      const p = u ? tierTime(u, t).progress : null;
      if (bar && p !== null) bar.style.setProperty('--p', p.toFixed(4));
    }
    renderStatus();
  }, 1000);

  return {
    /** Nová odpověď GET /soundboard. */
    update(raw) {
      state = normalizeSoundboard(raw);
      lastSig = '';
      renderButton();
      if (isOpen()) renderPanel();
    },
    /** SSE soundboard-played / soundboard-denied (soundboard-change = refetch u hostitele). */
    onSse(type, data) {
      if (!state || (data?.channel && state.channel && data.channel !== state.channel)) return;
      state = applySoundboardEvent(state, type, data);
      renderButton();
      if (isOpen()) renderPanel();
    },
    open, close, toggle, isOpen,
    destroy() {
      win.clearInterval(timer);
      doc.removeEventListener('mousedown', onDocDown);
      doc.removeEventListener('keydown', onDocKey);
      audio.pause();
      panel.remove();
      tip.remove();
    },
  };
}
