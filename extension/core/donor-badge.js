// Odznak dárce / podporovatele (pokyn usera 2026-09-30, podklady artifacts/donor-badges-v2/unitychat-donor-motion-v4).
// Čtyři varianty (QR Patron, Mince, Váček, Karta); jedna společná pro celý kanál — vybírá mod / streamer v nastavení
// (Účet → Odznak podporovatele, jen v dev módu), uloženo na serveru (routes/channelPrefs.ts), změna jde všem SSE
// `channel-prefs`. Tam se nastavuje i tempo animace, intenzita a odstup mezi animacemi.
// Individuální volba každého účtu s propojeným Twitchem (lib/badgePrefs.ts, `PUT /account/badge-prefs`): odznak UC
// u vlastních zpráv má vlastní slot, nebo nahradí globální odznak Twitche (role / sub zůstávají). Server ji dává
// zprávě jako `donorReplace`; klient podle toho vynechá globální odznaky (stripGlobalTwitchBadges). Pod volbou je
// náhled vlastní zprávy (badgePreviewHtml) — bez vlastního globálního odznaku ukáže ukázkový (GlitchCon 2020).
// Vykreslení: <img data-donor-badge> se statickým SVG (data URL); animaci řídí DonorMotion (installDonorMotion):
// jen viditelné odznaky, každý zvlášť — přehraje jeden cyklus (core/donor-motion.js), pak náhodná pauza
// v rozmezí gapMin–gapMax s. `prefers-reduced-motion` = jen statický. Sdílené addonem i webem.
import { escapeAttr, escapeHtml } from './html.js';
import { motionSvg } from './donor-motion.js';

export const DONOR_BADGE_VARIANTS = [
  { id: 'qr-patron', name: 'QR Patron', tagline: 'QR kód s tepajícím srdcem.' },
  { id: 'donor-coin', name: 'Mince', tagline: 'Zlatá mince se otočí přes hranu.' },
  { id: 'money-bag', name: 'Váček', tagline: 'Váček s mincemi poskočí.' },
  { id: 'support-card', name: 'Karta', tagline: 'Karta podpory se překlopí.' },
];
export const DONOR_BADGE_DEFAULT = 'donor-coin';
export const DONOR_BADGE_TITLE = 'Podporovatel';
/** Tempo = délka jednoho cyklu animace (s). */
export const DONOR_SPEEDS = [{ id: 1.5, label: 'Rychlé' }, { id: 2.2, label: 'Střední' }, { id: 3, label: 'Klidné' }];
/** Intenzita = rozsah pohybu (násobek). */
export const DONOR_STRENGTHS = [{ id: 0.6, label: 'Menší gesta' }, { id: 1, label: 'Plný pohyb' }, { id: 1.3, label: 'Výrazný' }];
export const DONOR_GAP_MAX_S = 120;
export const DONOR_PREFS_DEFAULT = Object.freeze({ donorBadge: DONOR_BADGE_DEFAULT, donorSpeed: 3, donorStrength: 1, donorGapMin: 2, donorGapMax: 6 });
/** Ukázkový globální odznak Twitche pro náhled, když uživatel žádný nemá (IVR: set glitchcon2020). */
export const SAMPLE_GLOBAL_BADGE = Object.freeze({ url: 'https://static-cdn.jtvnw.net/badges/v1/1d4b03b9-51ea-42c9-8f29-698e3c85be3d/1', title: 'GlitchCon 2020 (ukázka)' });

/** Platná varianta, jinak výchozí. */
export function donorBadgeVariant(id) {
  return DONOR_BADGE_VARIANTS.some((v) => v.id === id) ? id : DONOR_BADGE_DEFAULT;
}

/** Nastavení odznaku ze serveru → úplný objekt s platnými hodnotami (čistá funkce). */
export function normalizeDonorPrefs(p) {
  const r = p && typeof p === 'object' ? p : {};
  const num = (v, min, max, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
  const gapMin = num(r.donorGapMin, 0, DONOR_GAP_MAX_S, DONOR_PREFS_DEFAULT.donorGapMin);
  return {
    donorBadge: donorBadgeVariant(r.donorBadge),
    donorSpeed: DONOR_SPEEDS.some((s) => s.id === Number(r.donorSpeed)) ? Number(r.donorSpeed) : DONOR_PREFS_DEFAULT.donorSpeed,
    donorStrength: DONOR_STRENGTHS.some((s) => s.id === Number(r.donorStrength)) ? Number(r.donorStrength) : DONOR_PREFS_DEFAULT.donorStrength,
    donorGapMin: gapMin,
    donorGapMax: Math.max(gapMin, num(r.donorGapMax, 0, DONOR_GAP_MAX_S, DONOR_PREFS_DEFAULT.donorGapMax)),
  };
}

const svgUrl = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
const staticCache = new Map();
/** Statický snímek varianty (data URL, cache). */
export function donorBadgeStaticUrl(id) {
  const v = donorBadgeVariant(id);
  if (!staticCache.has(v)) staticCache.set(v, svgUrl(motionSvg(v, { phase: 0 })));
  return staticCache.get(v);
}
/** Jeden cyklus animace (data URL). */
export function donorBadgeMotionUrl(id, { speed = 3, strength = 1, uid = 'b' } = {}) {
  return svgUrl(motionSvg(donorBadgeVariant(id), { duration: speed, strength, once: true, uid }));
}

/** Tooltip: „Podporovatel“, s částkou „Podporovatel · 1 130 Kč (za 30 dní)“. */
export function donorBadgeTitle(amountCzk = null, days = 30) {
  const n = Number(amountCzk);
  if (!Number.isFinite(n) || n <= 0) return DONOR_BADGE_TITLE;
  return `${DONOR_BADGE_TITLE} · ${Math.round(n).toLocaleString('cs-CZ')} Kč (za ${days} dní)`;
}

/**
 * Odznak do chatu / profilu: statický obrázek; animaci mu dá DonorMotion. `amountCzk` ze zprávy (`donorCzk`).
 * `assetUrl` se už nepoužívá (SVG je vložené), parametr zůstal kvůli volajícím.
 */
export function donorBadgeHtml(id, _assetUrl = null, { size = 20, className = 'bdg-img uc-donor-badge', title = null, amountCzk = null } = {}) {
  const v = donorBadgeVariant(id);
  const t = title || donorBadgeTitle(amountCzk);
  return `<img class="${escapeAttr(className)}" src="${escapeAttr(donorBadgeStaticUrl(v))}" width="${size}" height="${size}" alt="${escapeAttr(t)}" data-tooltip="${escapeAttr(t)}" data-donor-badge="${escapeAttr(v)}">`;
}

/** Odznaky Twitche, které při „místo globálního odznaku“ zůstávají (role, sub); ostatní sety = globální → pryč. */
export const TWITCH_KEEP_BADGE_SETS = new Set(['subscriber', 'founder', 'moderator', 'vip', 'broadcaster', 'staff', 'admin', 'global_mod', 'partner', 'verified', 'bot', 'sub-gifter', 'sub-gift-leader', 'bits-leader', 'hype-train', 'predictions']);
/** Je set odznaku Twitche globální (ne role / sub)? */
export const isGlobalTwitchBadge = (badge) => !TWITCH_KEEP_BADGE_SETS.has(String(badge || '').split('/')[0]);
/** `badgesRaw` Twitche bez globálních odznaků (jen sety z TWITCH_KEEP_BADGE_SETS). */
export function stripGlobalTwitchBadges(badgesRaw) {
  return String(badgesRaw || '').split(',').filter((b) => b && !isGlobalTwitchBadge(b)).join(',');
}

/**
 * Individuální volba účtu (jen s propojeným Twitchem): zaškrtávátko + místo pro náhled vlastní zprávy.
 * Hostitel poslouchá `change` na `[name="uc-badge-replace"]`, PUT /account/badge-prefs, náhled překreslí přes badgePreviewHtml.
 */
export function badgeReplaceHtml({ checked = false, disabled = false } = {}) {
  return `<label class="uc-dbr"><input type="checkbox" name="uc-badge-replace"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}> Odznak podporovatele místo globálního odznaku Twitche</label>
  <div class="uc-dbr-preview" aria-label="Náhled vlastní zprávy"></div>`;
}

/**
 * Náhled vlastní zprávy jako v chatu (stejné třídy .msg / .pi / .ts / .bdg / .un / .tx → sidepanel.css):
 * `badges` = [{ url, title, global }] z vlastních odznaků Twitche (hostitel podle badgesRaw a své mapy odznaků);
 * bez globálního odznaku se přidá ukázkový (SAMPLE_GLOBAL_BADGE). `replace` = volba účtu; odznak UC se kreslí vždy
 * (ať je vidět chování), ve vlastním slotu první, jinak na místě globálního odznaku.
 */
export function badgePreviewHtml({ displayName = '', color = '', badges = [], replace = false, donorBadge = DONOR_BADGE_DEFAULT, amountCzk = null, text = 'Takhle bude vypadat moje zpráva.' } = {}) {
  const list = badges.filter((b) => b?.url);
  if (!list.some((b) => b.global)) list.push({ ...SAMPLE_GLOBAL_BADGE, global: true });
  const uc = donorBadgeHtml(donorBadge, null, { amountCzk });
  const img = (b) => `<img class="bdg-img" src="${escapeAttr(b.url)}" alt="${escapeAttr(b.title || '')}" data-tooltip="${escapeAttr(b.title || '')}">`;
  let bdg = '';
  if (replace) {
    // Globální odznaky pryč, odznak UC na místě prvního z nich.
    let placed = false;
    for (const b of list) { if (b.global) { if (!placed) { bdg += uc; placed = true; } } else bdg += img(b); }
    if (!placed) bdg = uc + bdg;
  } else {
    bdg = uc + list.map(img).join('');
  }
  const name = displayName || 'Já';
  return `<div class="msg uc-badge-preview"><span class="pi tw" data-tooltip="Twitch">TW</span><span class="ts">12:34</span><span class="bdg">${bdg}</span><span class="un"${color ? ` style="color:${escapeAttr(color)}"` : ''}>${escapeHtml(name)}</span> <span class="tx">${escapeHtml(text)}</span></div>`;
}

/**
 * Náhled vykreslit do `box` s animací změny (FLIP): odznaky, které zůstávají, přejedou na nové místo (odznak UC na
 * místo globálního), odebrané vyblednou na svém místě, nové se prolnou; jméno a text se posunou plynule. Bez
 * předchozího obsahu / reduced motion / bez Web Animations jen přepíše HTML.
 */
export function renderBadgePreviewInto(box, opts, { duration = 220, easing = 'cubic-bezier(.2, .8, .2, 1)' } = {}) {
  const html = badgePreviewHtml(opts);
  const doc = box?.ownerDocument;
  const win = doc?.defaultView;
  let reduced = false;
  try { reduced = !!win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { /* ignore */ }
  const keyOf = (el) => (el.matches('img') ? (el.dataset.donorBadge ? 'uc' : el.getAttribute('src')) : (el.classList.contains('un') ? 'un' : 'tx'));
  const SEL = '.bdg img, .un, .tx';
  const before = new Map();
  for (const el of box?.querySelectorAll?.(SEL) || []) before.set(keyOf(el), { rect: el.getBoundingClientRect(), html: el.outerHTML });
  box.innerHTML = html;
  if (!before.size || reduced || typeof win?.Element?.prototype?.animate !== 'function') return false;
  const br = box.getBoundingClientRect();
  const savedPos = box.style.position;
  if (win.getComputedStyle(box).position === 'static') box.style.position = 'relative';
  const anims = [];
  const after = new Map();
  for (const el of box.querySelectorAll(SEL)) after.set(keyOf(el), el);
  for (const [k, el] of after) {
    const prev = before.get(k);
    const r = el.getBoundingClientRect();
    if (prev) {
      const dx = prev.rect.left - r.left, dy = prev.rect.top - r.top;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) anims.push(el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration, easing }));
    } else {
      anims.push(el.animate([{ opacity: 0, transform: 'scale(0.6)' }, { opacity: 1, transform: 'none' }], { duration, easing }));
    }
  }
  for (const [k, prev] of before) {
    if (after.has(k) || !prev.html.startsWith('<img')) continue;
    // Odebraný odznak: kopie na původním místě vybledne a zmenší se.
    const tpl = doc.createElement('template');
    tpl.innerHTML = prev.html;
    const ghost = tpl.content.firstElementChild;
    if (!ghost) continue;
    ghost.removeAttribute('id');
    ghost.setAttribute('aria-hidden', 'true');
    Object.assign(ghost.style, { position: 'absolute', left: `${prev.rect.left - br.left - (box.clientLeft || 0)}px`, top: `${prev.rect.top - br.top - (box.clientTop || 0)}px`, width: `${prev.rect.width}px`, height: `${prev.rect.height}px`, margin: '0', pointerEvents: 'none' });
    box.appendChild(ghost);
    const a = ghost.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.6)' }], { duration, easing, fill: 'forwards' });
    a.finished.catch(() => {}).then(() => ghost.remove());
    anims.push(a);
  }
  Promise.all(anims.map((a) => a.finished.catch(() => {}))).then(() => { box.style.position = savedPos; });
  return anims.length > 0;
}

/**
 * Výběr v nastavení (mod): varianty s náhledem + tempo, intenzita, odstupy, nahrazení globálního odznaku.
 * Hostitel poslouchá `change` na `[name^="uc-donor-"]` a čte hodnoty přes readDonorPickerPrefs.
 */
export function donorBadgePickerHtml(prefs, _assetUrl = null, { disabled = false } = {}) {
  const p = normalizeDonorPrefs(prefs);
  const dis = disabled ? ' disabled' : '';
  const opts = (list, cur) => list.map((o) => `<option value="${o.id}"${o.id === cur ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
  return `<div class="uc-dbp" role="radiogroup" aria-label="Odznak dárce">${DONOR_BADGE_VARIANTS.map((v) => `
    <label class="uc-dbp-item${v.id === p.donorBadge ? ' on' : ''}" title="${escapeAttr(v.tagline)}">
      <input type="radio" name="uc-donor-badge" value="${v.id}"${v.id === p.donorBadge ? ' checked' : ''}${dis}>
      <span class="uc-dbp-pic">${donorBadgeHtml(v.id, null, { size: 28, className: 'uc-dbp-img', title: v.name })}</span>
      <span class="uc-dbp-name">${escapeHtml(v.name)}</span>
    </label>`).join('')}</div>
  <div class="uc-dbp-opts">
    <label class="uc-dbp-opt"><span>Tempo</span><select name="uc-donor-speed"${dis}>${opts(DONOR_SPEEDS, p.donorSpeed)}</select></label>
    <label class="uc-dbp-opt"><span>Intenzita</span><select name="uc-donor-strength"${dis}>${opts(DONOR_STRENGTHS, p.donorStrength)}</select></label>
    <label class="uc-dbp-opt"><span>Odstup od (s)</span><input type="number" name="uc-donor-gapmin" min="0" max="${DONOR_GAP_MAX_S}" step="0.5" value="${p.donorGapMin}"${dis}></label>
    <label class="uc-dbp-opt"><span>Odstup do (s)</span><input type="number" name="uc-donor-gapmax" min="0" max="${DONOR_GAP_MAX_S}" step="0.5" value="${p.donorGapMax}"${dis}></label>
  </div>`;
}

/** Hodnoty z výběru (po `change`). */
export function readDonorPickerPrefs(root) {
  const q = (n) => root?.querySelector?.(`[name="${n}"]`);
  return normalizeDonorPrefs({
    donorBadge: root?.querySelector?.('input[name="uc-donor-badge"]:checked')?.value,
    donorSpeed: q('uc-donor-speed')?.value,
    donorStrength: q('uc-donor-strength')?.value,
    donorGapMin: q('uc-donor-gapmin')?.value,
    donorGapMax: q('uc-donor-gapmax')?.value,
  });
}

/** Po změně ze serveru: přeznačit výběr bez překreslení (náhledy běží dál). */
export function markDonorBadgePicker(root, prefs) {
  if (!root) return;
  const p = normalizeDonorPrefs(prefs);
  for (const item of root.querySelectorAll('.uc-dbp-item')) {
    const input = item.querySelector('input');
    const on = input?.value === p.donorBadge;
    item.classList.toggle('on', on);
    if (input) input.checked = on;
  }
  const set = (n, v) => { const el = root.querySelector(`[name="${n}"]`); if (el && el.type === 'checkbox') el.checked = !!v; else if (el) el.value = String(v); };
  set('uc-donor-speed', p.donorSpeed); set('uc-donor-strength', p.donorStrength); set('uc-donor-gapmin', p.donorGapMin); set('uc-donor-gapmax', p.donorGapMax);
}

/** Už vykreslené odznaky (chat, profil) → nová varianta; náhledy ve výběru (`.uc-dbp`) se nemění. */
export function repaintDonorBadges(root, prefs) {
  const p = normalizeDonorPrefs(prefs);
  for (const img of root?.querySelectorAll?.('img[data-donor-badge]') || []) {
    if (img.closest('.uc-dbp')) continue;
    img.dataset.donorBadge = p.donorBadge;
    img.src = donorBadgeStaticUrl(p.donorBadge);
    delete img._ucMotion;
  }
}

/**
 * Animace odznaků: sleduje `img[data-donor-badge]` pod `root` (MutationObserver), animuje jen viditelné
 * (IntersectionObserver): cyklus (tempo, intenzita) → statický snímek → náhodná pauza gapMin–gapMax → znovu.
 * @param {{ root: HTMLElement, prefs: () => object, win?: Window }} o
 */
export function installDonorMotion({ root, prefs, win = globalThis }) {
  if (!root || root._ucDonorMotion) return root?._ucDonorMotion;
  const doc = root.ownerDocument || win.document;
  const reduced = () => { try { return !!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
  const timers = new Map();   // img → timer
  let seq = 0;
  const stop = (img) => { const t = timers.get(img); if (t) { win.clearTimeout(t); timers.delete(img); } };
  const still = (img) => { img.src = donorBadgeStaticUrl(img.dataset.donorBadge); };
  const schedule = (img, ms) => { stop(img); timers.set(img, win.setTimeout(() => play(img), ms)); };
  function play(img) {
    stop(img);
    if (!img.isConnected || reduced() || !img._ucVisible) { still(img); return; }
    const p = normalizeDonorPrefs(prefs?.());
    // Náhled ve výběru animuje svou variantu, odznak v chatu variantu kanálu.
    const id = img.closest('.uc-dbp') ? img.dataset.donorBadge : p.donorBadge;
    img.src = donorBadgeMotionUrl(id, { speed: p.donorSpeed, strength: p.donorStrength, uid: `m${++seq}` });
    const gap = p.donorGapMin + Math.random() * Math.max(0, p.donorGapMax - p.donorGapMin);
    timers.set(img, win.setTimeout(() => { still(img); schedule(img, gap * 1000); }, p.donorSpeed * 1000 + 60));
  }
  const io = win.IntersectionObserver ? new win.IntersectionObserver((entries) => {
    for (const e of entries) {
      const img = e.target;
      img._ucVisible = e.isIntersecting;
      if (e.isIntersecting) { if (!timers.has(img)) schedule(img, Math.random() * 1200); } else { stop(img); still(img); }
    }
  }, { root: null, threshold: 0.1 }) : null;
  const watch = (img) => { if (img._ucMotionWatched) return; img._ucMotionWatched = true; if (io) io.observe(img); else { img._ucVisible = true; schedule(img, Math.random() * 1200); } };
  const scan = (node) => { if (node?.querySelectorAll) for (const img of node.querySelectorAll('img[data-donor-badge]')) watch(img); if (node?.matches?.('img[data-donor-badge]')) watch(node); };
  scan(root);
  const mo = new win.MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes) scan(n); });
  mo.observe(root, { childList: true, subtree: true });
  const api = {
    /** Změna nastavení: běžící cykly doběhnou, další už s novými hodnotami; varianta se přepíše hned. */
    refresh() { repaintDonorBadges(root, prefs?.()); for (const img of [...timers.keys()]) schedule(img, 300 + Math.random() * 600); },
    destroy() { mo.disconnect(); io?.disconnect(); for (const img of [...timers.keys()]) stop(img); root._ucDonorMotion = null; },
  };
  root._ucDonorMotion = api;
  return api;
}
