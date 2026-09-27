// Výběr emotů (tlačítko v poli pro psaní) — sdílené addonem i webem.
// Data bere z EmoteManageru (core/emotes.js), DOM dostává zvenku (host + dokument),
// úložiště „naposledy použitých" je injektované (addon i web: localStorage).
import { escapeAttr } from './html.js';
import { createIconTip } from './soundboard.js';
import { registerPanel, canAutoFocus, panelShown } from './panel-morph.js';
import { createSlideIndicator } from './slide-indicator.js';

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
 * @param {Array<{ key: string, label: string, icon?: string, button?: HTMLElement, buttonIndicator?: boolean,
 *          mount(pane: HTMLElement): { show?(): void, hide?(): void } }>} [o.tabs]
 *        další záložky vlevo (svislé, pod „Emoty“) — např. GIFy (core/gif-library.js createGifPanel), SFX (soundboard).
 *        `button` = vlastní ikona v poli (nota → SFX): otevírá panel na té záložce a dokud je záložka otevřená, je
 *        aktivní ona, ne smajlík. `buttonIndicator: false` = pásek / tooltip odměny záložky jen na záložce (a na její
 *        ikoně), ne na smajlíku.
 * @returns {{ open(tab?: string): void, close(): void, toggle(tab?: string): void, isOpen(): boolean, selectTab(key: string): void,
 *             setTabHidden(key: string, hidden: boolean): void,
 *             activeTab(): string, setIndicator(key: string, v: { progress: number|null, title?: string, tip?: object|null }|null): void }}
 *          `tip` = stav vlastního tooltipu ikony emotů a záložky (core/soundboard.js renderIconTip)
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
        <button type="button" class="uc-ep-tab on" role="tab" data-tab="emotes" aria-selected="true" aria-label="Emoty">${EMOTE_TAB_SVG}<span>Emoty</span></button>
        ${tabs.map((t) => `<button type="button" class="uc-ep-tab" role="tab" data-tab="${esc(t.key)}" aria-selected="false" aria-label="${esc(t.label)}">${t.icon || ''}<span>${esc(t.label)}</span><i class="uc-ep-tab-bar" hidden></i></button>`).join('')}
      </div>
      <div class="uc-ep-pane uc-ep-main" data-pane="emotes">${main}</div>
      ${tabs.map((t) => `<div class="uc-ep-pane" data-pane="${esc(t.key)}" hidden></div>`).join('')}`
    : main;
  host.appendChild(panel);
  // Posuvný výběr bočních záložek (Emoty | GIFy): zvýraznění přejede z jedné na druhou (spec 2026-09-27 §1).
  const side = panel.querySelector('.uc-ep-side');
  const slide = side ? createSlideIndicator({ container: side, getActive: () => side.querySelector('.uc-ep-tab.on') }) : null;
  const search = panel.querySelector('input');
  const body = panel.querySelector('.uc-ep-body');
  const hoverEl = panel.querySelector('.uc-ep-hover');
  let active = 'emotes';
  const mounted = new Map();   // key → { show, hide }
  // Záložky s vlastní ikonou v poli (nota → SFX). Ikona sbalená / skrytá (odměna neaktivní) aktivní být nemůže.
  const tabButtons = tabs.map((t) => t.button).filter(Boolean);
  const shownBtn = (b) => !!b && !b.hidden && !b.classList.contains('hidden') && !b.classList.contains('uc-tool-collapsed');
  const activeButton = () => { const b = tabs.find((t) => t.key === active)?.button; return shownBtn(b) ? b : button; };
  function syncButtons(open = isOpen()) {
    const cur = activeButton();
    for (const b of [button, ...tabButtons]) {
      const on = open && b === cur;
      b.classList.toggle('active', on);
      b.setAttribute('aria-expanded', String(on));
    }
  }
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
    slide?.update();
    if (isOpen()) syncButtons(true);
    if (prev !== next && mounted.has(prev)) mounted.get(prev).hide?.();
    if (def && isOpen()) mounted.get(key)?.show?.();
    if (prev !== next) log?.('EmotePicker', `záložka ${next}`);
  }

  function open(tab) {
    // Rozběhnuté zavírání (duch) dokončit, ať ho doběhnutí neschová po otevření.
    morph.settle();
    if (tab) selectTab(tab);
    if (active === 'emotes') render();
    panel.classList.remove('hidden');
    slide?.update({ animate: false });
    btnTip?.hide();
    syncButtons(true);
    // Z nuly vyroste z tlačítka; jiný otevřený panel u pole (soundboard, QR dono) se do tohohle přetvoří (test2 bod 5).
    morph.opened();
    if (active !== 'emotes') { mounted.get(active)?.show?.(); return; }
    // Na dotyku hledání neaktivovat: vyskočila by klávesnice a zakryla emoty (spec 2026-09-27 §4).
    if (canAutoFocus(doc)) { search.focus(); search.select(); }
  }
  /** `instant` = bez animace (přetvoření do jiného panelu ho volá po doběhnutí). */
  function close({ instant = false } = {}) {
    if (!isOpen()) return;
    tabTip?.hide();
    syncButtons(false);
    mounted.get(active)?.hide?.();
    morph.hide(() => panel.classList.add('hidden'), { instant });
  }
  // Duch (zavírání / přetvoření do jiného panelu) není otevřený → klik ho znovu otevře (review I1).
  const isOpen = () => panelShown(panel);
  /**
   * Bez `tab` = smajlík: otevřený panel zavře, jen když je na záložce smajlíku (z SFX přepne na Emoty), zavřený otevře
   * na poslední záložce smajlíku. S `tab` (nota): otevřený na té záložce zavře, jinak na ni přepne / otevře.
   */
  const toggle = (tab) => {
    morph.settle();
    const ownTab = (k) => !tabs.find((t) => t.key === k)?.button;
    if (tab) {
      if (isOpen() && active === tab) return close();
      if (isOpen()) { selectTab(tab); return undefined; }
      return open(tab);
    }
    if (isOpen() && ownTab(active)) return close();
    if (isOpen()) { selectTab('emotes'); render(); return undefined; }
    return open(ownTab(active) ? undefined : 'emotes');
  };
  const morph = registerPanel({ panel, button: activeButton, extraButtons: [button, ...tabButtons], isOpen, close: () => close({ instant: true }), log: (t) => log?.('EmotePicker', t) });

  /** Záložku schovat (kanál nemá zvuky) — otevřený panel na ní přejde na Emoty. */
  function setTabHidden(key, hidden) {
    const b = panel.querySelector(`.uc-ep-tab[data-tab="${CSS_ESC(key)}"]`);
    if (!b || b.hidden === !!hidden) return;
    b.hidden = !!hidden;
    if (hidden && active === key) selectTab('emotes');
    slide?.update({ animate: false });
  }

  /**
   * Časový pásek (jako u soundboardu): pod tlačítkem emotů a na boční záložce. `progress` 0–1 (ubývá s časem),
   * null = bez pásku. Víc záložek s páskem → tlačítko ukáže ten nejdelší.
   */
  function setIndicator(key, v) {
    if (v && Number.isFinite(v.progress)) indicators.set(key, { progress: Math.min(1, Math.max(0, v.progress)), title: v.title || '' });
    else indicators.delete(key);
    // Stav pro vlastní tooltip (ikona emotů + záložka): i bez pásku (zamčeno, cooldown bez konce odměny).
    if (v?.tip) tipStates.set(key, v.tip); else tipStates.delete(key);
    const tab = panel.querySelector(`.uc-ep-tab[data-tab="${CSS_ESC(key)}"]`);
    const bar = tab?.querySelector('.uc-ep-tab-bar');
    const cur = indicators.get(key);
    if (bar) { bar.hidden = !cur; if (cur) bar.style.setProperty('--p', cur.progress.toFixed(4)); }
    // Nativní title ani aria-label se každou sekundu nepřepisují (blikal, test2 bod 3; review M4) — odpočet je jen
    // ve vlastním tooltipu, aria-label záložky zůstává její název.
    const onSmiley = (k) => tabs.find((t) => t.key === k)?.buttonIndicator !== false;
    const best = [...indicators].filter(([k]) => onSmiley(k)).map(([, x]) => x).reduce((a, x) => (!a || x.progress > a.progress ? x : a), null);
    let bb = button.querySelector(':scope > .uc-ep-btn-bar');
    if (best && !bb) { bb = doc.createElement('span'); bb.className = 'uc-ep-btn-bar'; button.appendChild(bb); }
    button.classList.toggle('uc-ep-timed', !!best);
    if (bb) { bb.hidden = !best; if (best) button.style.setProperty('--uc-ep-p', best.progress.toFixed(4)); }
    // Otevřený tooltip: jen nový text / pásek (prvek zůstává).
    if (btnTip?.open) btnTip.update(buttonTip());
    if (tabTip?.open && tabTipKey === key) tabTip.update(tabTipState(key));
  }

  // ---- vlastní tooltipy (stejné jako u noty soundboardu, core/soundboard.js createIconTip) — test2 body 1 a 3 ----
  const tipStates = new Map();   // key záložky → stav tooltipu (gifRewardTip)
  const plainTip = (title) => ({ mode: 'plain', title });
  /**
   * Ikona emotů: tooltip jen s aktivní odměnou záložky (GIFy — aktivní / cooldown). Zamčená nebo neznámá odměna
   * u ikony nic neukazuje, jinak by to působilo jako zamčené emoty (bod 2 testu 2026-09-27); záložka GIFy ji ukáže dál.
   */
  const TIP_ACTIVE = new Set(['active', 'cooldown']);
  const buttonTip = () => [...tipStates].find(([k, s]) => tabs.find((t) => t.key === k)?.buttonIndicator !== false && TIP_ACTIVE.has(s?.mode))?.[1] || null;
  const tabTipState = (key) => tipStates.get(key) || plainTip(key === 'emotes' ? 'Emoty' : (tabs.find((t) => t.key === key)?.label || key));
  const btnTip = tabs.length ? createIconTip({ host }) : null;
  const tabTip = tabs.length ? createIconTip({ host: panel, placement: 'side' }) : null;
  let tabTipKey = null;
  if (btnTip) {
    button.removeAttribute('title');
    if (!button.getAttribute('aria-label')) button.setAttribute('aria-label', 'Emoty');
    const showBtn = () => { if (!isOpen()) btnTip.show(button, buttonTip()); };
    button.addEventListener('mouseenter', showBtn);
    button.addEventListener('focus', showBtn);
    button.addEventListener('mouseleave', () => btnTip.hide());
    button.addEventListener('blur', () => btnTip.hide());
    for (const b of panel.querySelectorAll('.uc-ep-tab')) {
      const key = b.dataset.tab;
      b.addEventListener('mouseenter', () => { tabTipKey = key; tabTip.show(b, tabTipState(key)); });
      b.addEventListener('mouseleave', () => { tabTipKey = null; tabTip.hide(); });
    }
  }

  // Záložky se připojí hned (indikátor odměny na záložce musí běžet i před prvním otevřením).
  for (const t of tabs) {
    // Druhý argument = ovládání vlastní záložky (volatelné hned při připojení, kdy hostitel picker ještě nemá).
    const ctl = { setIndicator: (v) => setIndicator(t.key, v), setHidden: (h) => setTabHidden(t.key, h) };
    try { mounted.set(t.key, t.mount(panel.querySelector(`.uc-ep-pane[data-pane="${CSS_ESC(t.key)}"]`), ctl) || {}); }
    catch (e) { log?.('EmotePicker', `záložka ${t.key} se nepřipojila: ${e?.message || e}`); }
  }

  panel.querySelector('.uc-ep-side')?.addEventListener('click', (e) => {
    const b = e.target.closest('.uc-ep-tab');
    // Fokus do hledání jen bez dotyku — tenhle klik ho dřív dával vždy a na mobilu vyskočila klávesnice (regrese
    // z v3.41.39, spec 2026-09-27 §4).
    if (b) { selectTab(b.dataset.tab); if (b.dataset.tab === 'emotes') { render(); if (canAutoFocus(doc)) search.focus(); } }
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
  // Ikona záložky v poli (nota) — otevřít / přepnout / zavřít panel na její záložce.
  for (const t of tabs) {
    if (!t.button) continue;
    t.button.setAttribute('aria-haspopup', 'dialog');
    t.button.setAttribute('aria-expanded', 'false');
    t.button.addEventListener('mousedown', (e) => e.preventDefault());
  }
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
  // Klik na tlačítko jiného panelu u pole nezavírá — nový panel tenhle přetvoří (core/panel-morph.js).
  doc.addEventListener('mousedown', (e) => { if (isOpen() && !panel.contains(e.target) && !button.contains(e.target) && !tabButtons.some((b) => b.contains(e.target)) && !morph.isSwitch(e.target)) close(); });
  doc.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close(); });

  return { open, close, toggle, isOpen, selectTab, setTabHidden, activeTab: () => active, setIndicator, panel };
}

const CSS_ESC = (s) => String(s).replace(/["\\]/g, '\\$&');

/** Ikona záložky Emoty (menší smajlík). */
const EMOTE_TAB_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5c.9 1.2 2.1 1.8 3.5 1.8s2.6-.6 3.5-1.8"/><circle cx="9" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1" fill="currentColor" stroke="none"/></svg>';

/** SVG smajlíku pro tlačítko (stejné v addonu i na webu). */
export const EMOTE_BUTTON_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5c.9 1.2 2.1 1.8 3.5 1.8s2.6-.6 3.5-1.8"/><circle cx="9" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1" fill="currentColor" stroke="none"/></svg>';
