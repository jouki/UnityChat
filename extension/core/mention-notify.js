// Upozornění prohlížeče na @zmínku nebo odpověď na moji zprávu (addon i web).
//
// Jen čistá logika: rozpoznání zmínky, rozhodnutí „upozornit / neupozornit",
// text oznámení a throttle s deduplikací. Samotné zobrazení (chrome.notifications
// v addonu, Notification API na webu) dělá konzument přes injektovaný `emit`.

const PLATFORM_NAMES = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick' };
const WORD_CHAR = /[\p{L}\p{N}_]/u;
const BRAILLE_BLANK = /⠀/g; // UC marker (U+2800) — v oznámení nemá co dělat

/** „@jméno" jako celé slovo (ne @joukibot pro jouki). Text i jméno malými písmeny. */
export function hasMention(text, name) {
  if (!text || !name) return false;
  const needle = '@' + name;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
    const before = text[i - 1];
    const after = text[i + needle.length];
    if ((!before || !WORD_CHAR.test(before)) && (!after || !WORD_CHAR.test(after))) return true;
  }
  return false;
}

/**
 * Druh zmínky pro zprávu: 'reply' (odpověď na mou zprávu) > 'mention' (@jméno v textu) > null.
 * @param {{ text?: string, replyTarget?: string|null, myNames: Set<string>|string[] }} p
 *   `replyTarget` = jméno autora citované zprávy, `myNames` = moje jména malými písmeny bez „@".
 */
export function mentionKind({ text, replyTarget, myNames }) {
  const names = myNames instanceof Set ? myNames : new Set(myNames || []);
  if (!names.size) return null;
  const target = String(replyTarget || '').toLowerCase().replace(/^@/, '');
  if (target && names.has(target)) return 'reply';
  const lower = String(text || '').toLowerCase();
  for (const n of names) if (hasMention(lower, n)) return 'mention';
  return null;
}

/**
 * Upozornit na zprávu? Vrací { ok, reason } — reason pro log, když ok = false.
 * @param {object} p
 * @param {boolean} p.enabled     nastavení zapnuté (a oprávnění povolené)
 * @param {'reply'|'mention'|null} p.kind
 * @param {boolean} [p.historical] historie / starší stránka / znovuvykreslení
 * @param {boolean} [p.own]        moje vlastní zpráva (i optimistická)
 * @param {boolean} [p.moderated]  smazaná / skrytá moderátorem
 * @param {boolean} [p.watching]   uživatel se na chat právě dívá (viditelný + fokus)
 */
export function shouldNotify({ enabled, kind, historical, own, moderated, watching }) {
  if (!enabled) return { ok: false, reason: 'off' };
  if (!kind) return { ok: false, reason: 'none' };
  if (historical) return { ok: false, reason: 'history' };
  if (own) return { ok: false, reason: 'own' };
  if (moderated) return { ok: false, reason: 'moderated' };
  if (watching) return { ok: false, reason: 'watching' };
  return { ok: true, reason: kind };
}

/** Čistý text zprávy pro oznámení: bez UC markeru, Kick emote tagů a zdvojených mezer, zkrácený. */
export function notificationText(text, max = 140) {
  const clean = String(text || '')
    .replace(BRAILLE_BLANK, '')
    .replace(/\[emote:\d+:([^\]]*)\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...clean]; // bez rozpůlení emoji (surrogate pairs)
  return chars.length > max ? chars.slice(0, max - 1).join('').trimEnd() + '…' : clean;
}

/**
 * Text oznámení. Rodově neutrální titulek („Zmínka od …", „Odpověď od …").
 * @param {object} msg  zpráva (username, message, platform)
 * @param {'reply'|'mention'} kind
 * @param {{ displayName?: string, channel?: string, max?: number }} [opts]
 * @returns {{ title: string, message: string, contextMessage: string }}
 */
export function formatNotification(msg, kind, opts = {}) {
  const name = String(opts.displayName || msg?.username || '?').replace(/^@/, '');
  const title = kind === 'reply' ? `Odpověď od ${name}` : `Zmínka od ${name}`;
  const platform = PLATFORM_NAMES[msg?.platform] || msg?.platform || '';
  const channel = String(opts.channel || '').replace(/^@/, '');
  return {
    title,
    message: notificationText(msg?.message, opts.max || 140),
    contextMessage: [platform, channel].filter(Boolean).join(' · '),
  };
}

/** „a 1 další zpráva" / „a 3 další zprávy" / „a 5 dalších zpráv". */
export function moreLabel(n) {
  if (n === 1) return 'a 1 další zpráva';
  if (n >= 2 && n <= 4) return `a ${n} další zprávy`;
  return `a ${n} dalších zpráv`;
}

/** Oznámení s dovětkem o dalších zprávách sloučených throttlem (do contextMessage). */
export function withMore(note, more) {
  if (!more) return note;
  const tail = `(${moreLabel(more)})`;
  return { ...note, contextMessage: note.contextMessage ? `${note.contextMessage} ${tail}` : tail };
}

/**
 * Deduplikace podle id zprávy + throttle: nejvýš jedno oznámení za `intervalMs`.
 * Zprávy v okně se sloučí — po jeho uplynutí přijde poslední z nich s dovětkem
 * „a N dalších zpráv" (emit(note, more)).
 * @param {object} p
 * @param {(note: object, more: number) => void} p.emit
 * @param {number} [p.intervalMs=5000]
 * @param {number} [p.maxSeen=500]
 * @param {() => number} [p.now]
 * @param {Function} [p.setTimer]  (fn, ms) => handle
 * @param {Function} [p.clearTimer]
 */
export function createMentionNotifier({ emit, intervalMs = 5000, maxSeen = 500, now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (h) => clearTimeout(h) } = {}) {
  const seen = new Set();
  let last = -Infinity;
  let pending = null;
  let queued = 0;
  let timer = null;

  function flush() {
    timer = null;
    if (!pending) return;
    const note = pending;
    const more = queued - 1;
    pending = null;
    queued = 0;
    last = now();
    emit(note, more);
  }

  return {
    /** @returns {'shown'|'queued'|'dup'} */
    offer(id, note) {
      const key = id == null ? null : String(id);
      if (key) {
        if (seen.has(key)) return 'dup';
        seen.add(key);
        if (seen.size > maxSeen) seen.delete(seen.values().next().value);
      }
      const t = now();
      if (!pending && t - last >= intervalMs) {
        last = t;
        emit(note, 0);
        return 'shown';
      }
      pending = note;
      queued++;
      if (!timer) timer = setTimer(flush, Math.max(0, last + intervalMs - t));
      return 'queued';
    },
    /** Zahodit čekající oznámení (např. uživatel se vrátil do chatu). */
    reset() {
      if (timer) clearTimer(timer);
      timer = null;
      pending = null;
      queued = 0;
    },
    get pending() { return queued; },
  };
}

// ---- Zvýraznění dodatečně (2026-09-30) ----
// Historie se po obnovení vykreslí dřív, než se načte přihlášený účet (moje jména). Zprávy vykreslené bez jmen
// by zůstaly bez „Replying to you“ / „Mentions you“, dokud nepřijde nová. Host po načtení jmen projde zprávy
// a zvýraznění doplní. Jen přidává — odhlášení už vykreslené zvýraznění nebere.

const TAGS = { reply: ['tag-reply', 'Replying to you'], mention: ['tag-mention', 'Mentions you'] };

/**
 * Druh zvýraznění zprávy pro vykreslení: odpověď > @zmínka > jméno bez zavináče (ne ve vlastní zprávě).
 * @param {{ text?: string, replyTarget?: string|null, myNames: Set<string>|string[], own?: boolean, hasBare?: (text: string, name: string) => boolean }} p
 */
export function highlightKind({ text, replyTarget, myNames, own = false, hasBare = null }) {
  const kind = mentionKind({ text, replyTarget, myNames });
  if (kind || own || !hasBare) return kind;
  const lower = String(text || '').toLowerCase();
  for (const n of myNames) if (hasBare(lower, n)) return 'mention';
  return null;
}

/** Doplnit zvýraznění a štítek na už vykreslenou zprávu. Vrací true, když se něco změnilo. */
export function applyMentionTag(el, kind) {
  const tag = TAGS[kind];
  if (!el || !tag) return false;
  const line = el.querySelector(':scope > .msg-tag-line');
  const cur = line?.querySelector('.msg-tag');
  if (el.classList.contains('mentioned') && cur?.classList.contains(tag[0])) return false;
  // „Mentions you“ nepřepíše „Replying to you“ (vyšší priorita).
  if (kind === 'mention' && cur?.classList.contains('tag-reply')) { el.classList.add('mentioned'); return false; }
  el.classList.add('mentioned');
  const doc = el.ownerDocument;
  const span = doc.createElement('span');
  span.className = `msg-tag ${tag[0]}`;
  span.textContent = tag[1];
  if (line) { line.replaceChildren(span); return true; }
  const nl = doc.createElement('div');
  nl.className = 'msg-tag-line';
  nl.appendChild(span);
  const after = el.querySelector(':scope > .reply-ctx');
  if (after) after.after(nl); else el.insertBefore(nl, el.firstChild);
  return true;
}
