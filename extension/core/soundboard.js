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
    tiers: (Array.isArray(r.me.tiers) ? r.me.tiers : []).map((t) => ({ tier: t.tier, startedAt: ms(t.startedAt), expiresAt: ms(t.expiresAt) })),
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

/** Tiery odemčené v čase `now` (serverové ms) → Map tier → { startedAt, expiresAt|null }. */
export function unlockedTiers(state, now) {
  const out = new Map();
  for (const t of state?.me?.tiers || []) {
    if (t.expiresAt !== null && t.expiresAt <= now) continue;
    const prev = out.get(t.tier);
    // Stejný tier víckrát (nemělo by nastat, Židolišta slučuje): drží ten, co vyprší později.
    if (!prev || (prev.expiresAt !== null && (t.expiresAt === null || t.expiresAt > prev.expiresAt))) out.set(t.tier, t);
  }
  return out;
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
  if (!state.me) return { mode: 'link', title: 'Soundboard', lines: [`Připoj účet ${PLATFORM_NAMES[state.platform] || state.platform} k UnityChatu.`] };
  const unlocked = unlockedTiers(state, now);
  if (!unlocked.size) return { mode: 'locked', title: 'Odměna není aktivována', lines: ['Sound efekty se odemykají milestony Židolišty.'] };
  const rows = [...unlocked.entries()].sort((a, b) => a[0] - b[0]).map(([tier, t]) => ({
    tier,
    name: tierLabel(state, tier),
    remainingMs: t.expiresAt === null ? null : t.expiresAt - now,
    progress: t.expiresAt === null ? null : progressOf(t, now),
  }));
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

function progressOf(t, now) {
  if (t.expiresAt === null) return null;
  const total = t.startedAt !== null ? t.expiresAt - t.startedAt : null;
  if (!total || total <= 0) return 1;
  return Math.min(1, Math.max(0, (t.expiresAt - now) / total));
}

export function tierLabel(state, tier) {
  const t = state?.tiers?.find((x) => x.tier === tier);
  const name = String(t?.name || '').trim();
  // Název, který jen opakuje číslo („Tier 1“), nezdvojovat.
  return name && name.toLowerCase() !== `tier ${tier}` ? `Tier ${tier} · ${name}` : `Tier ${tier}`;
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
    const rows = (s.rows || []).map((r) => `<div class="uc-sb-tip-r"><span>${esc(r.name)}</span><b>${r.remainingMs === null ? 'bez omezení' : esc(formatRemaining(r.remainingMs))}</b>${r.progress === null ? '' : `<i style="--p:${r.progress.toFixed(4)}"></i>`}</div>`).join('');
    const cd = s.cooldownMs > 0 ? `<div class="uc-sb-tip-cd">Cooldown ${esc(formatRemaining(s.cooldownMs))}</div>` : '';
    tip.className = `uc-sb-tip uc-sb-tip-${s.mode}`;
    tip.innerHTML = `<div class="uc-sb-tip-t">${esc(s.title)}</div>${lines}${rows}${cd}`;
  }
  function showTip() { if (isOpen()) return; tipOpen = true; renderTip(); }
  function hideTip() { tipOpen = false; tip.classList.add('hidden'); }

  // ---- panel ----
  const favSet = () => new Set(state?.favorites || []);
  function soundBtn(s, unlocked, cd, favs) {
    const locked = !unlocked.has(s.tier);
    const cls = ['uc-sb-s', locked ? 'locked' : '', cd > 0 && !locked ? 'cd' : ''].filter(Boolean).join(' ');
    const label = soundLabel(s);
    const title = locked ? `${label} — ${tierLabel(state, s.tier)} není odemčený` : `!se ${s.name}`;
    return `<div class="${cls}" data-id="${s.id}" title="${esc(title)}">
      <button type="button" class="uc-sb-play" data-act="send"${locked ? ' aria-disabled="true"' : ''}>${soundIconHtml(s)}<span class="uc-sb-n">${esc(label)}</span></button>
      <button type="button" class="uc-sb-pv" data-act="preview" title="Přehrát jen pro sebe" aria-label="Náhled ${esc(label)}">${SPEAKER_SVG}</button>
      <button type="button" class="uc-sb-fav${favs.has(s.id) ? ' on' : ''}" data-act="fav" title="${favs.has(s.id) ? 'Odebrat z oblíbených' : 'Přidat do oblíbených'}" aria-label="Oblíbené ${esc(label)}">${STAR_SVG}</button>
    </div>`;
  }
  function section(key, head, list, unlocked, cd, favs, extra = '') {
    if (!list.length) return '';
    return `<div class="uc-sb-sec" data-sec="${esc(key)}"><div class="uc-sb-h">${head}${extra}</div><div class="uc-sb-grid">${list.map((s) => soundBtn(s, unlocked, cd, favs)).join('')}</div></div>`;
  }

  function renderPanel() {
    if (!state) return;
    const t = now();
    const unlocked = unlockedTiers(state, t);
    const cd = cooldownLeft(state, t);
    const favs = favSet();
    const byId = new Map(state.sounds.map((s) => [s.id, s]));
    const q = search.value.trim();
    const top = body.scrollTop;
    if (q) {
      const hits = searchSounds(state.sounds, q);
      body.innerHTML = hits.length ? section('search', `Výsledky pro „${esc(q)}“`, hits, unlocked, cd, favs) : `<div class="uc-sb-empty">Žádný zvuk neodpovídá „${esc(q)}“.</div>`;
    } else {
      const parts = [
        section('fav', 'Oblíbené', state.favorites.map((id) => byId.get(id)).filter(Boolean), unlocked, cd, favs),
        section('recent', 'Často používané', state.recent.map((id) => byId.get(id)).filter(Boolean), unlocked, cd, favs),
      ];
      const tiers = [...new Set(state.sounds.map((s) => s.tier))].sort((a, b) => a - b);
      for (const tier of tiers) {
        const u = unlocked.get(tier);
        const badge = !u ? `<span class="uc-sb-lock">${LOCK_SVG} zamčeno</span>`
          : u.expiresAt === null ? '<span class="uc-sb-time">bez omezení</span>'
          : `<span class="uc-sb-time" data-exp="${u.expiresAt}">${esc(formatRemaining(u.expiresAt - t))}</span><i class="uc-sb-hbar" style="--p:${progressOf(u, t).toFixed(4)}"></i>`;
        parts.push(section(`t${tier}`, esc(tierLabel(state, tier)), state.sounds.filter((s) => s.tier === tier), unlocked, cd, favs, badge));
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
    if (!unlockedTiers(state, t).has(sound.tier)) return;
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
    if (s.mode === 'login' || s.mode === 'link') { hideTip(); onLogin?.(s.mode === 'link' ? state.platform : undefined); return; }
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
    const sig = `${[...unlockedTiers(state, now()).keys()].join(',')}|${cooldownLeft(state, now()) > 0}`;
    if (sig !== lastSig) { lastSig = sig; renderPanel(); return; }
    const t = now();
    for (const el of body.querySelectorAll('.uc-sb-time[data-exp]')) el.textContent = formatRemaining(Number(el.dataset.exp) - t);
    for (const sec of body.querySelectorAll('.uc-sb-sec')) {
      const tier = Number(sec.dataset.sec?.slice(1));
      const u = unlockedTiers(state, t).get(tier);
      const bar = sec.querySelector('.uc-sb-hbar');
      if (bar && u) bar.style.setProperty('--p', progressOf(u, t).toFixed(4));
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
