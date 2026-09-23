// Výběr emotů (tlačítko v poli pro psaní) — sdílené addonem i webem.
// Data bere z EmoteManageru (core/emotes.js), DOM dostává zvenku (host + dokument),
// úložiště „naposledy použitých" je injektované (addon i web: localStorage).

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

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Picker: tlačítko `button` otevírá/zavírá panel vložený do `host` (#input-area).
 * @param {object} o
 * @param {HTMLElement} o.host        kontejner (position: relative), panel se kotví nad něj
 * @param {HTMLElement} o.button      tlačítko se smajlíkem
 * @param {HTMLTextAreaElement} o.textarea
 * @param {object} o.emotes           EmoteManager
 * @param {{ load(): string[], save(list: string[]): void }} [o.recent]
 * @param {(tag: string, text: string) => void} [o.log]
 * @returns {{ open(): void, close(): void, toggle(): void, isOpen(): boolean }}
 */
export function createEmotePicker({ host, button, textarea, emotes, recent, log }) {
  const doc = host.ownerDocument;
  const panel = doc.createElement('div');
  panel.className = 'uc-ep hidden';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Emoty');
  panel.innerHTML = `
    <div class="uc-ep-search"><input type="search" placeholder="Hledat emote…" autocomplete="off" spellcheck="false" aria-label="Hledat emote"></div>
    <div class="uc-ep-body"></div>
    <div class="uc-ep-foot"><span class="uc-ep-hover">&nbsp;</span></div>`;
  host.appendChild(panel);
  const search = panel.querySelector('input');
  const body = panel.querySelector('.uc-ep-body');
  const hoverEl = panel.querySelector('.uc-ep-hover');
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

  function open() {
    render();
    panel.classList.remove('hidden');
    button.classList.add('active');
    button.setAttribute('aria-expanded', 'true');
    search.focus();
    search.select();
  }
  function close() {
    if (panel.classList.contains('hidden')) return;
    panel.classList.add('hidden');
    button.classList.remove('active');
    button.setAttribute('aria-expanded', 'false');
  }
  const isOpen = () => !panel.classList.contains('hidden');
  const toggle = () => (isOpen() ? close() : open());

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

  return { open, close, toggle, isOpen };
}

/** SVG smajlíku pro tlačítko (stejné v addonu i na webu). */
export const EMOTE_BUTTON_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5c.9 1.2 2.1 1.8 3.5 1.8s2.6-.6 3.5-1.8"/><circle cx="9" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1" fill="currentColor" stroke="none"/></svg>';
