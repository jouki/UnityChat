// Výběr emotů (tlačítko v poli pro psaní) — sdílené addonem i webem.
// Data bere z EmoteManageru (core/emotes.js), DOM dostává zvenku (host + dokument),
// úložiště „naposledy použitých" je injektované (addon i web: localStorage).
import { escapeAttr } from './html.js';

const RECENT_MAX = 24;

/** Sekce: UnityChat úplně nahoře (pokyn usera 2026-09-23), pak kanálové, pak globální. */
export function pickerSections(em) {
  return [
    { key: 'uc', label: 'UnityChat', map: em.ucEmotes },
    { key: 'channel7tv', label: '7TV kanál', map: em.channel7tv },
    { key: 'bttv', label: 'BTTV', map: em.bttvEmotes },
    { key: 'ffz', label: 'FFZ', map: em.ffzEmotes },
    { key: 'global7tv', label: '7TV globální', map: em.global7tv },
    { key: 'twitch', label: 'Twitch', map: em.twitchNative },
    { key: 'kick', label: 'Kick', map: em.kickNative },
  ].filter((s) => s.map && s.map.size);
}

/** Hledání: bez rozlišení velikosti písmen, začátek jména má přednost před výskytem uvnitř. */
export function searchEmotes(em, query, limit = 300) {
  const q = String(query || '').trim();
  if (!q) return [];
  return em.findCompletions(q, { fulltext: true }).slice(0, limit);
}

/** Přidat do „naposledy použitých" (nejnovější první, bez duplicit, strop RECENT_MAX). */
export function pushRecent(list, name) {
  return [name, ...list.filter((x) => x !== name)].slice(0, RECENT_MAX);
}

/**
 * Vložit emote do textarea za kurzor (mezera před, pokud tam není, a mezera za).
 * Pošle `input` event, ať se chytí autoresize a stav tlačítka Odeslat.
 */
export function insertEmote(textarea, name) {
  const v = textarea.value;
  const start = textarea.selectionStart ?? v.length;
  const end = textarea.selectionEnd ?? v.length;
  const before = v.slice(0, start);
  const pre = before && !/\s$/.test(before) ? ' ' : '';
  const ins = `${pre}${name} `;
  textarea.value = before + ins + v.slice(end);
  const pos = start + ins.length;
  textarea.setSelectionRange(pos, pos);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

// Všechny atributy v šablonách jsou v uvozovkách → escapeAttr (core/html.js) stačí i na text.
const esc = (s) => escapeAttr(s);

/**
 * Picker: tlačítko `button` otevírá/zavírá panel vložený do `host` (#input-area).
 * @param {object} o
 * @param {HTMLElement} o.host        kontejner (position: relative), panel se kotví nad něj
 * @param {HTMLElement} o.button      tlačítko se smajlíkem
 * @param {HTMLTextAreaElement} o.textarea
 * @param {object} o.emotes           EmoteManager
 * @param {{ load(): string[], save(list: string[]): void }} [o.recent]
 * @param {(tag: string, text: string) => void} [o.log]
 * @param {Array<{ key: string, label: string, icon?: string, mount(pane: HTMLElement): { show?(): void, hide?(): void } }>} [o.tabs]
 *        další záložky vlevo (svislé, pod „Emoty“) — např. GIFy (core/gif-library.js createGifPanel)
 * @returns {{ open(tab?: string): void, close(): void, toggle(): void, isOpen(): boolean, selectTab(key: string): void,
 *             activeTab(): string, setIndicator(key: string, v: { progress: number|null, title?: string }|null): void }}
 */
export function createEmotePicker({ host, button, textarea, emotes, recent, log, tabs = [] }) {
  const doc = host.ownerDocument;
  const panel = doc.createElement('div');
  panel.className = `uc-ep hidden${tabs.length ? ' uc-ep--tabs' : ''}`;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Emoty');
  const main = `
    <div class="uc-ep-search"><input type="search" placeholder="Hledat emote…" autocomplete="off" spellcheck="false" aria-label="Hledat emote"></div>
    <div class="uc-ep-body"></div>
    <div class="uc-ep-foot"><span class="uc-ep-hover">&nbsp;</span></div>`;
  // Záložky: svislý sloupec vlevo (Emoty | GIFy | …), každá záložka má vlastní panel (pane).
  panel.innerHTML = tabs.length
    ? `<div class="uc-ep-side" role="tablist" aria-orientation="vertical">
        <button type="button" class="uc-ep-tab on" role="tab" data-tab="emotes" aria-selected="true" title="Emoty">${EMOTE_TAB_SVG}<span>Emoty</span></button>
        ${tabs.map((t) => `<button type="button" class="uc-ep-tab" role="tab" data-tab="${esc(t.key)}" aria-selected="false" title="${esc(t.label)}">${t.icon || ''}<span>${esc(t.label)}</span><i class="uc-ep-tab-bar" hidden></i></button>`).join('')}
      </div>
      <div class="uc-ep-pane uc-ep-main" data-pane="emotes">${main}</div>
      ${tabs.map((t) => `<div class="uc-ep-pane" data-pane="${esc(t.key)}" hidden></div>`).join('')}`
    : main;
  host.appendChild(panel);
  const search = panel.querySelector('input');
  const body = panel.querySelector('.uc-ep-body');
  const hoverEl = panel.querySelector('.uc-ep-hover');
  let active = 'emotes';
  const mounted = new Map();   // key → { show, hide }
  const indicators = new Map(); // key → { progress, title }
  let recentList = [];
  try { recentList = (recent?.load?.() || []).filter((x) => typeof x === 'string'); } catch { /* ignore */ }

  const cell = (name, url) => url
    ? `<button type="button" class="uc-ep-e${emotes.zeroWidth?.has(name) ? ' zw' : ''}" data-name="${esc(name)}" title="${esc(name)}"><img src="${esc(url)}" alt="${esc(name)}" loading="lazy" decoding="async"></button>`
    : '';
  const section = (label, names, urlOf) => {
    const cells = names.map((n) => cell(n, urlOf(n))).join('');
    return cells ? `<div class="uc-ep-sec"><div class="uc-ep-h">${esc(label)} <span>${names.length}</span></div><div class="uc-ep-grid">${cells}</div></div>` : '';
  };
  const byName = (map) => [...map.keys()].sort((a, b) => a.localeCompare(b, 'cs', { sensitivity: 'base' }));

  function render() {
    const q = search.value.trim();
    if (q) {
      const hits = searchEmotes(emotes, q);
      body.innerHTML = hits.length
        ? section(`Výsledky pro „${q}“`, hits, (n) => emotes.getAnyUrl(n))
        : `<div class="uc-ep-empty">Žádný emote neodpovídá „${esc(q)}“.</div>`;
      return;
    }
    const recentNames = recentList.filter((n) => emotes.getAnyUrl(n));
    const [first, ...rest] = pickerSections(emotes);
    const parts = [];
    // UnityChat první, hned pod ním naposledy použité, pak ostatní zdroje.
    if (first?.key === 'uc') parts.push(section(first.label, byName(first.map), (n) => first.map.get(n)));
    if (recentNames.length) parts.push(section('Naposledy použité', recentNames, (n) => emotes.getAnyUrl(n)));
    for (const s of first?.key === 'uc' ? rest : [first, ...rest].filter(Boolean)) parts.push(section(s.label, byName(s.map), (n) => s.map.get(n)));
    body.innerHTML = parts.join('') || '<div class="uc-ep-empty">Emoty se ještě načítají…</div>';
  }

  /** Přepnout záložku (Emoty | GIFy | …); cizí záložka se připojí při prvním zobrazení. */
  function selectTab(key) {
    if (!tabs.length) return;
    const def = tabs.find((t) => t.key === key);
    const next = def ? key : 'emotes';
    const prev = active;
    active = next;
    for (const b of panel.querySelectorAll('.uc-ep-tab')) {
      const on = b.dataset.tab === next;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    }
    for (const p of panel.querySelectorAll('.uc-ep-pane')) p.hidden = p.dataset.pane !== next;
    if (prev !== next && mounted.has(prev)) mounted.get(prev).hide?.();
    if (def && isOpen()) mounted.get(key)?.show?.();
    if (prev !== next) log?.('EmotePicker', `záložka ${next}`);
  }

  function open(tab) {
    if (tab) selectTab(tab);
    if (active === 'emotes') render();
    panel.classList.remove('hidden');
    button.classList.add('active');
    button.setAttribute('aria-expanded', 'true');
    if (active !== 'emotes') { mounted.get(active)?.show?.(); return; }
    // Na dotykovém zařízení hledání neaktivovat: vyskočila by klávesnice a zakryla emoty.
    const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    if (!touch) { search.focus(); search.select(); }
  }
  function close() {
    if (panel.classList.contains('hidden')) return;
    panel.classList.add('hidden');
    button.classList.remove('active');
    button.setAttribute('aria-expanded', 'false');
    mounted.get(active)?.hide?.();
  }
  const isOpen = () => !panel.classList.contains('hidden');
  const toggle = () => (isOpen() ? close() : open());

  /**
   * Časový pásek (jako u soundboardu): pod tlačítkem emotů a na boční záložce. `progress` 0–1 (ubývá s časem),
   * null = bez pásku. Víc záložek s páskem → tlačítko ukáže ten nejdelší.
   */
  function setIndicator(key, v) {
    if (v && Number.isFinite(v.progress)) indicators.set(key, { progress: Math.min(1, Math.max(0, v.progress)), title: v.title || '' });
    else indicators.delete(key);
    const tab = panel.querySelector(`.uc-ep-tab[data-tab="${CSS_ESC(key)}"]`);
    const bar = tab?.querySelector('.uc-ep-tab-bar');
    const cur = indicators.get(key);
    if (bar) { bar.hidden = !cur; if (cur) bar.style.setProperty('--p', cur.progress.toFixed(4)); }
    if (tab) tab.title = cur?.title ? `${tabs.find((t) => t.key === key)?.label || key} — ${cur.title}` : (tabs.find((t) => t.key === key)?.label || key);
    const best = [...indicators.values()].reduce((a, x) => (!a || x.progress > a.progress ? x : a), null);
    let bb = button.querySelector(':scope > .uc-ep-btn-bar');
    if (best && !bb) { bb = doc.createElement('span'); bb.className = 'uc-ep-btn-bar'; button.appendChild(bb); }
    button.classList.toggle('uc-ep-timed', !!best);
    if (bb) { bb.hidden = !best; if (best) button.style.setProperty('--uc-ep-p', best.progress.toFixed(4)); }
  }

  // Záložky se připojí hned (indikátor odměny na záložce musí běžet i před prvním otevřením).
  for (const t of tabs) {
    try { mounted.set(t.key, t.mount(panel.querySelector(`.uc-ep-pane[data-pane="${CSS_ESC(t.key)}"]`)) || {}); }
    catch (e) { log?.('EmotePicker', `záložka ${t.key} se nepřipojila: ${e?.message || e}`); }
  }

  panel.querySelector('.uc-ep-side')?.addEventListener('click', (e) => {
    const b = e.target.closest('.uc-ep-tab');
    if (b) { selectTab(b.dataset.tab); if (b.dataset.tab === 'emotes') { render(); search.focus(); } }
  });
  panel.querySelector('.uc-ep-side')?.addEventListener('mousedown', (e) => e.preventDefault());

  function pick(name) {
    insertEmote(textarea, name);
    recentList = pushRecent(recentList, name);
    try { recent?.save?.(recentList); } catch { /* ignore */ }
    log?.('EmotePicker', `vložen ${name}`);
  }

  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('mousedown', (e) => e.preventDefault());   // neukrást fokus textarea
  button.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  search.addEventListener('input', render);
  search.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { close(); textarea.focus(); }
    else if (e.key === 'Enter') {
      // Enter = první výsledek (bez hledání první v seznamu) a zavřít.
      e.preventDefault();
      const first = body.querySelector('.uc-ep-e');
      if (first) { pick(first.dataset.name); close(); textarea.focus(); }
    }
  });
  // Klik na emote: vložit, panel nechat otevřený (víc emotů za sebou jako na Twitchi).
  body.addEventListener('mousedown', (e) => { if (e.target.closest('.uc-ep-e')) e.preventDefault(); });
  body.addEventListener('click', (e) => {
    const b = e.target.closest('.uc-ep-e');
    if (b) pick(b.dataset.name);
  });
  body.addEventListener('mouseover', (e) => {
    const b = e.target.closest('.uc-ep-e');
    hoverEl.textContent = b ? b.dataset.name : ' ';
  });
  doc.addEventListener('mousedown', (e) => { if (isOpen() && !panel.contains(e.target) && !button.contains(e.target)) close(); });
  doc.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close(); });

  return { open, close, toggle, isOpen, selectTab, activeTab: () => active, setIndicator, panel };
}

const CSS_ESC = (s) => String(s).replace(/["\\]/g, '\\$&');

/** Ikona záložky Emoty (menší smajlík). */
const EMOTE_TAB_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5c.9 1.2 2.1 1.8 3.5 1.8s2.6-.6 3.5-1.8"/><circle cx="9" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1" fill="currentColor" stroke="none"/></svg>';

/** SVG smajlíku pro tlačítko (stejné v addonu i na webu). */
export const EMOTE_BUTTON_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5c.9 1.2 2.1 1.8 3.5 1.8s2.6-.6 3.5-1.8"/><circle cx="9" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1" fill="currentColor" stroke="none"/></svg>';
