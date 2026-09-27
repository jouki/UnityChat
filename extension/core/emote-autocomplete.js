// Našeptávač emotů (Tab / Shift+Tab, šipky, → potvrdí, Esc zruší, volitelně „:jméno") — jeden zdroj pravdy
// pro hlavní pole pro psaní (sidepanel.js, navíc @uživatelé, !commandy, /uc, /user) i další pole (banner výročí).
//
//  - čisté funkce: stav našeptávače `ac` = { start, end, index, matches, prefix, kind, trigger?, applied?, _winStart? }
//    (acTabStep, acApplyMatch, acKeyAction, acWindowRange);
//  - HTML seznamu (.es-toggle Fulltext, .es-item s ikonou / .es-name-inner / .es-src, .es-counter) a zapojení řádků
//    (přetečení jména → animace, klik) — stejný vzhled jako #emote-suggest;
//  - attachEmoteAutocomplete(input, opts): kompletní našeptávač emotů pro libovolné <textarea>/<input> (seznam jako
//    plovoucí .emote-suggest nad / pod polem, aby se neuřízl v kontejneru s overflow: hidden).
// Bez chrome.*; DOM jen přes předané pole / element. Zdroje a řazení dává EmoteManager.findCompletions (core/emotes.js).

import { colonQuery } from './colon-emotes.js';

/** Kolik položek je v seznamu vidět naráz (okno kolem vybrané). */
export const AC_VISIBLE = 4;

/** Začátek slova, ve kterém je kurzor (zpětně po mezeru). */
export function acWordStart(text, pos) {
  let ws = pos;
  while (ws > 0 && text[ws - 1] !== ' ') ws--;
  return ws;
}

/**
 * Tab / Shift+Tab (i šipky při otevřeném seznamu). Kurzor na konci posledního doplnění → cyklování (první Tab po
 * seznamu otevřeném psaním jen potvrdí vybranou položku), jinak nový dotaz ze slova před kurzorem.
 * `find(partial)` → { matches, kind }. Vrací stav k aplikaci (acApplyMatch), `null` = nic nenalezeno (skrýt),
 * `undefined` = před kurzorem není slovo (nic nedělat).
 */
export function acTabStep(ac, text, pos, dir, find) {
  if (ac && ac.end === pos && ac.matches?.length) {
    if (ac.applied) {
      const len = ac.matches.length;
      ac.index = (ac.index + dir + len) % len;
    }
    return ac;
  }
  const ws = acWordStart(text, pos);
  const partial = text.substring(ws, pos);
  if (!partial) return undefined;
  const found = find(partial) || {};
  if (!found.matches?.length) return null;
  return { start: ws, end: pos, index: 0, matches: found.matches, prefix: partial, kind: found.kind || 'emote' };
}

/** Vloží vybranou položku + mezeru místo rozepsaného slova, kurzor za mezeru. Mění `ac` (end, applied). */
export function acApplyMatch(input, ac) {
  const match = ac.matches[ac.index];
  const text = input.value;
  input.value = text.substring(0, ac.start) + match + ' ' + text.substring(ac.end);
  ac.end = ac.start + match.length + 1;
  ac.applied = true;
  input.setSelectionRange(ac.end, ac.end);
}

/**
 * Klávesa při otevřeném seznamu (pravidla hlavního pole, v3.38.50): ↓/↑ = 'next'/'prev', → = 'close' (výběr je už
 * vložený), Enter: „:jméno" seznam a `/user` nápověda = 'apply-close' (vloží, neodešle), @uživatelé = 'close',
 * jinak null (Tabem vložený emote / !command / /uc → Enter odešle zprávu). Esc řeší volající (u /user ruší hledání).
 */
export function acKeyAction(ac, key) {
  if (!ac?.matches?.length) return null;
  if (key === 'ArrowDown') return 'next';
  if (key === 'ArrowUp') return 'prev';
  if (key === 'ArrowRight') return 'close';
  if (key === 'Enter') {
    if (ac.trigger === 'colon' || ac._type === 'usercmd') return 'apply-close';
    if (ac.kind === 'user' || ac.matches[0]?.startsWith?.('@')) return 'close';
  }
  return null;
}

/** Okno viditelných položek kolem vybrané (posune se jen, když by vybraná vypadla). Ukládá ac._winStart. */
export function acWindowRange(ac, visible = AC_VISIBLE) {
  const total = ac.matches.length;
  let winStart = ac._winStart || 0;
  if (ac.index < winStart) winStart = ac.index;
  if (ac.index >= winStart + visible) winStart = ac.index - visible + 1;
  winStart = Math.max(0, Math.min(winStart, total - visible));
  ac._winStart = winStart;
  return [winStart, Math.min(winStart + visible, total)];
}

/** Štítek zdroje emotu vpravo v řádku (pořadí jako findCompletions). */
export function emoteSourceLabel(emotes, name) {
  if (emotes.channel7tv.has(name)) return '7TV';
  if (emotes.global7tv.has(name)) return '7TV';
  if (emotes.bttvEmotes.has(name)) return 'BTTV';
  if (emotes.ffzEmotes.has(name)) return 'FFZ';
  if (emotes.twitchNative.has(name)) return 'Twitch';
  if (emotes.kickNative.has(name)) return 'Kick';
  if (emotes.ucEmotes.has(name)) return 'UChat';
  return '';
}

/** Náhled emotu v řádku (prázdné, když emote URL nemá). */
export function emoteIconHtml(emotes, name) {
  const url = emotes.getAnyUrl(name);
  return url ? `<img src="${emotes._ea(url)}" alt="${emotes._ea(name)}">` : '';
}

/** Přepínač Fulltext v hlavičce seznamu. */
export const fulltextToggleHtml = (checked) => `<label class="es-toggle"><input type="checkbox" id="es-fulltext"${checked ? ' checked' : ''}>Fulltext</label>`;

/** Řádek seznamu: ikona (hotové HTML) + jméno (animace přetečení přes .es-name-inner) + štítek zdroje. */
export function suggestRowHtml({ i, selected, iconHtml = '', name, src = '', esc, cls = '' }) {
  return `<div class="es-item${cls ? ' ' + cls : ''}${selected ? ' selected' : ''}" data-idx="${i}">${iconHtml}`
    + `<span class="es-name"><span class="es-name-inner">${esc(name)}</span></span>`
    + `${src ? `<span class="es-src">${src}</span>` : ''}</div>`;
}

/** Počítadlo „3 / 12" pod seznamem, jen když je položek víc, než je vidět. */
export const suggestCounterHtml = (index, total, visible = AC_VISIBLE) => (total > visible ? `<div class="es-counter">${index + 1} / ${total}</div>` : '');

/** Celý seznam emotů (Fulltext + okno řádků + počítadlo) — vzhled shodný s emote větví hlavního pole. */
export function emoteSuggestHtml(ac, { emotes, fulltext = false, visible = AC_VISIBLE }) {
  const [from, to] = acWindowRange(ac, visible);
  let html = fulltextToggleHtml(fulltext);
  for (let i = from; i < to; i++) {
    const name = ac.matches[i];
    html += suggestRowHtml({ i, selected: i === ac.index, iconHtml: emoteIconHtml(emotes, name), name, src: emoteSourceLabel(emotes, name), esc: (t) => emotes._eh(t) });
  }
  return html + suggestCounterHtml(ac.index, ac.matches.length, visible);
}

/**
 * Po vložení HTML do (viditelného) seznamu: jméno delší než řádek → .overflowing + --scroll-dist (animace jen
 * u vybrané položky, CSS), klik na řádek → onPick(index).
 */
export function wireSuggestRows(el, onPick) {
  el.querySelectorAll('.es-item').forEach((item) => {
    const outer = item.querySelector('.es-name');
    const inner = item.querySelector('.es-name-inner');
    if (outer && inner) {
      const overflow = inner.scrollWidth - outer.clientWidth;
      if (overflow > 0) {
        item.classList.add('overflowing');
        item.style.setProperty('--scroll-dist', `-${overflow + 8}px`);
      }
    }
    item.addEventListener('click', () => onPick(parseInt(item.dataset.idx, 10)));
  });
}

/** Přepínač Fulltext v seznamu: změna → onToggle(checked); klik na label nebere fokus poli. */
export function wireFulltextToggle(el, onToggle) {
  const box = el.querySelector('#es-fulltext');
  if (!box) return;
  box.addEventListener('change', (e) => { e.stopPropagation(); onToggle(box.checked); });
  el.querySelector('.es-toggle')?.addEventListener('mousedown', (e) => e.preventDefault());
}

const MODIFIERS = ['Shift', 'Control', 'Alt', 'Meta'];

/**
 * Našeptávač emotů pro další pole (hlavní pole má vlastní orchestraci v sidepanel.js se stejnými stavebními kusy).
 *   emotes        EmoteManager (findCompletions, getAnyUrl, mapy zdrojů)
 *   options()     → { colon, fulltext } — aktuální nastavení („:jméno" spouštěč jen při colon === true)
 *   setFulltext(v)   přepínač Fulltext v seznamu (host uloží nastavení)
 *   onApply()     po vložení emotu (hodnota pole se mění bez události input — host přepočítá počítadlo apod.)
 *   enterConfirms Enter při otevřeném seznamu jen potvrdí výběr a zavře ho, nikdy neodešle (jinak pravidla
 *                 hlavního pole: Enter potvrdí jen „:jméno" seznam, po Tabu propadne dál)
 * Obsloužená klávesa dostane preventDefault → hostitelův keydown listener (registrovaný až po tomhle) má kontrolovat
 * `e.defaultPrevented`. Vrací { close, destroy, isOpen }.
 */
export function attachEmoteAutocomplete(input, { emotes, options = () => ({}), setFulltext = null, onApply = null, enterConfirms = false } = {}) {
  const doc = input.ownerDocument;
  const win = doc.defaultView;
  let ac = null;
  let el = null;
  const opts = () => options() || {};
  const find = (q) => emotes.findCompletions(q, { fulltext: opts().fulltext === true });

  const close = () => { ac = null; el?.classList.add('hidden'); };

  const position = () => {
    const r = input.getBoundingClientRect();
    const vh = win.innerHeight;
    el.style.left = `${Math.round(r.left)}px`;
    el.style.width = `${Math.round(r.width)}px`;
    el.style.maxHeight = '';
    const h = el.offsetHeight;
    const roomAbove = r.top - 4;
    const roomBelow = vh - r.bottom - 4;
    const above = h <= roomAbove || roomAbove >= roomBelow;
    el.classList.toggle('emote-suggest--below', !above);
    if (above) { el.style.top = ''; el.style.bottom = `${Math.round(vh - r.top)}px`; } else { el.style.bottom = ''; el.style.top = `${Math.round(r.bottom)}px`; }
    const room = above ? roomAbove : roomBelow;
    if (h > room) { el.style.maxHeight = `${Math.max(0, Math.floor(room))}px`; el.style.overflowY = 'auto'; } else el.style.overflowY = '';
  };

  const render = () => {
    if (!ac) { close(); return; }
    if (!el) {
      el = doc.createElement('div');
      el.className = 'emote-suggest emote-suggest--float hidden';
      el.addEventListener('mousedown', (e) => e.preventDefault()); // fokus zůstává v poli
      doc.body.appendChild(el);
    }
    el.innerHTML = emoteSuggestHtml(ac, { emotes, fulltext: opts().fulltext === true });
    el.classList.remove('hidden');
    position();
    wireFulltextToggle(el, (checked) => {
      setFulltext?.(checked);
      if (ac?.prefix) {
        const next = find(ac.prefix);
        if (!next.length) close(); else { ac.matches = next; ac.index = 0; ac._winStart = 0; render(); }
      }
      input.focus();
    });
    wireSuggestRows(el, (i) => { if (!ac) return; ac.index = i; apply(); input.focus(); });
  };

  const apply = () => { acApplyMatch(input, ac); render(); onApply?.(); };

  const tab = (dir) => {
    const r = acTabStep(ac, input.value, input.selectionStart, dir, (p) => ({ matches: find(p), kind: 'emote' }));
    if (r === undefined) return false;
    if (!r) { close(); return false; }
    ac = r;
    apply();
    return true;
  };

  const onKey = (e) => {
    if (e.isComposing || e.defaultPrevented) return;
    if (e.key === 'Tab') {
      if (tab(e.shiftKey ? -1 : 1)) e.preventDefault(); // nic k doplnění → Tab přesune fokus jako obvykle
      return;
    }
    if (!ac) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Enter' && enterConfirms && !e.shiftKey) {
      e.preventDefault();
      if (!ac.applied) apply();
      close();
      return;
    }
    const act = acKeyAction(ac, e.key);
    if (act === 'next' || act === 'prev') { e.preventDefault(); tab(act === 'next' ? 1 : -1); return; }
    if (act === 'close') { e.preventDefault(); close(); return; }
    if (act === 'apply-close') { e.preventDefault(); apply(); close(); return; }
    if (MODIFIERS.includes(e.key)) return;
    close(); // jakákoli jiná klávesa seznam zavře (jako hlavní pole)
  };

  const onInput = () => {
    if (opts().colon !== true) { if (ac?.trigger === 'colon') close(); return; }
    const pos = input.selectionStart;
    const cq = colonQuery(input.value, pos);
    const matches = cq ? find(cq.query) : [];
    if (cq && matches.length) {
      ac = { start: cq.start, end: pos, index: 0, matches, kind: 'emote', prefix: cq.query, trigger: 'colon' };
      render();
    } else if (ac) close();
  };

  const onBlur = () => close();
  const onResize = () => { if (ac && el) position(); };

  input.addEventListener('keydown', onKey);
  input.addEventListener('input', onInput);
  input.addEventListener('blur', onBlur);
  win.addEventListener('resize', onResize);

  return {
    close,
    get isOpen() { return !!ac; },
    destroy() {
      close();
      input.removeEventListener('keydown', onKey);
      input.removeEventListener('input', onInput);
      input.removeEventListener('blur', onBlur);
      win.removeEventListener('resize', onResize);
      el?.remove();
      el = null;
    },
  };
}
