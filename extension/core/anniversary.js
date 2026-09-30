// Výročí na Twitchi — sdílené addonem, webem i OBS (podklad docs/superpowers/specs/2026-09-27-twitch-vyroci-research.md).
//
//  - Zobrazení cizích výročí: USERNOTICE `modiversary` (moderátorské výročí) jako zelená událost s mečem,
//    „{jméno} je už {N} {měsíc/měsíce/měsíců | rok/roky/let} moderátorem!“ + text uživatele. Převod na roky jako
//    Twitch (ModiversaryLine): months % 12 == 0 → roky, jinak měsíce. Sdílený resub (`resub` USERNOTICE) = sub karta,
//    tady jen její česká věta (subLineParts); řádek výročí v Profilu (annivProfileLabel).
//  - Sdílení vlastního výročí (jen addon — potřebuje first-party cookie Twitche, GQL v background.js): texty výzvy,
//    výběr výzvy (resub má přednost), pamatované zavření výročí předplatného (jen dané id, jako Twitch
//    `shareResubNotificationIDs`), chybové hlášky a banner nad polem pro psaní (AnniversaryBanner).
// Bez chrome.*; DOM jen přes předaný dokument. Cizí text (jméno dárce) jen přes textContent.

import { czPlural } from './plural.js';
import { escapeHtml } from './html.js';
import { findLinks } from './links.js';

/** Hláška nad polem, když zpráva ke sdílení obsahuje odkaz (sdílí se jen bez odkazů). */
export const ANNIV_LINK_TEXT = 'Odkazy nejsou ve zprávě povolené.';
/** Obsahuje zpráva ke sdílení odkaz? (stejná detekce jako filtr odkazů, core/links.js) */
export const annivHasLink = (text) => findLinks(text).length > 0;

/** Limit textu sdílení — podklad: odhad, běžný limit chatové zprávy Twitche. */
export const ANNIV_MAX_LEN = 500;
/** Zelená Twitche pro ModiversaryLine. */
export const MODIVERSARY_COLOR = '#00AD03';
/** Za kolik ms zmizí potvrzení „Sdíleno v chatu!“. */
export const ANNIV_SUCCESS_MS = 2600;
/** Zavřená výročí předplatného se pamatují 400 dní (pak jen úklid mapy). */
export const ANNIV_DISMISS_KEEP_MS = 400 * 864e5;

export const ANNIV_SWORD_SVG = '<svg viewBox="0 0 20 20" width="20" height="20" fill="currentColor" aria-hidden="true">'
  + '<path d="M17.5 2.5h-4.2l-7 7-1.5-1.5-1.4 1.4 2.2 2.2-3.1 3.1 1.4 1.4 3.1-3.1 2.2 2.2 1.4-1.4-1.5-1.5 7-7V2.5Zm-2 3.4-6.3 6.3-1.4-1.4 6.3-6.3h1.4v1.4Z"/></svg>';
export const ANNIV_STAR_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">'
  + '<path d="M12 2l2.9 6.9L22 10l-5.5 4.8L18 22l-6-3.5L6 22l1.5-7.2L2 10l7.1-1.1z"/></svg>';

const int = (n) => { const v = Number(n); return Number.isInteger(v) && v > 0 ? v : 0; };

export const annivMonths = (n) => `${n} ${czPlural(n, 'měsíc', 'měsíce', 'měsíců')}`;
export const annivYears = (n) => `${n} ${czPlural(n, 'rok', 'roky', 'let')}`;

/** Délka moderátorského výročí jako Twitch: celé roky, když months % 12 == 0, jinak měsíce. */
export function modiversaryDuration(months) {
  const m = int(months);
  return m >= 12 && m % 12 === 0 ? annivYears(m / 12) : annivMonths(m);
}

/** Věta události v chatu po částech (addon staví DOM, web HTML): lead + <strong> + tail. */
export function modiversaryParts(months) {
  if (!int(months)) return { lead: 'slaví moderátorské výročí!', strong: '', tail: '' };
  return { lead: 'je už ', strong: modiversaryDuration(months), tail: ' moderátorem!' };
}

export function modiversaryText(name, months) {
  const p = modiversaryParts(months);
  return `${name} ${p.lead}${p.strong}${p.tail}`;
}

/**
 * Tělo události modiversary (web / OBS): meč + „{jméno} je už …“ + text uživatele. `nameHtml` a `bodyHtml` jsou už
 * bezpečné HTML hostitele (jméno s barvou, text s emoty).
 */
export function modiversaryEventHtml(msg, { nameHtml = '', bodyHtml = '' } = {}) {
  const p = modiversaryParts(msg?.modMonths);
  const strong = p.strong ? `<strong>${escapeHtml(p.strong)}</strong>` : '';
  return `<span class="modiv-icon" aria-hidden="true">${ANNIV_SWORD_SVG}</span>`
    + `<div class="modiv-body"><div class="modiv-line">${nameHtml} ${escapeHtml(p.lead)}${strong}${escapeHtml(p.tail)}</div>`
    + `${bodyHtml ? `<div class="modiv-text tx">${bodyHtml}</div>` : ''}</div>`;
}

// ---- karta sub / resub v chatu (česky, tři tvary) ----

const SUB_TIERS = { 1000: 'Tier 1', 2000: 'Tier 2', 3000: 'Tier 3' };

/**
 * Řádek karty sub / resub po částech: „Předplatné Tier 1. Celkem 7 měsíců, 3 měsíce v řadě.“ — `{ text, strong?, cls? }`
 * (addon staví DOM, web HTML přes subLineHtml). Měsíce a série jen nad 1 (jako dosud).
 */
export function subLineParts(msg) {
  const isPrime = String(msg?.subPlan || '').toLowerCase() === 'prime';
  const out = [{ text: 'Předplatné', strong: true }, { text: ' ' }, { text: isPrime ? 'Prime' : (SUB_TIERS[msg?.subPlan] || 'Tier 1'), strong: true, cls: isPrime ? 'sub-tier-prime' : 'sub-tier' }, { text: '.' }];
  const months = int(msg?.subMonths);
  if (months > 1) {
    out.push({ text: ' Celkem ' }, { text: annivMonths(months), strong: true });
    const streak = int(msg?.subStreak);
    if (streak > 1) out.push({ text: ', ' }, { text: `${annivMonths(streak)} v řadě`, strong: true });
    out.push({ text: '.' });
  }
  return out;
}

export function subLineHtml(msg) {
  return subLineParts(msg).map((p) => (p.strong ? `<strong${p.cls ? ` class="${p.cls}"` : ''}>${escapeHtml(p.text)}</strong>` : escapeHtml(p.text))).join('');
}

/**
 * Výročí v seznamu zpráv Profilu (jako událost, ne prázdný řádek): „Výročí předplatného: 7 měsíců (série 3)“ /
 * „Moderátorské výročí: 2 roky“ / „Nové předplatné“. Běžná zpráva → null.
 */
export function annivProfileLabel(m) {
  if (m?.isModiversary) return int(m.modMonths) ? `Moderátorské výročí: ${modiversaryDuration(m.modMonths)}` : 'Moderátorské výročí';
  if (m?.isSubEvent) {
    const months = int(m.subMonths);
    if (months <= 1) return 'Nové předplatné';
    const streak = int(m.subStreak);
    return `Výročí předplatného: ${annivMonths(months)}${streak > 1 ? ` (série ${streak})` : ''}`;
  }
  return null;
}

// ---- výzva nad polem pro psaní ----

/** „Blahopřejeme k 1letému moderátorskému výročí!“; zbytek po roce → „… výročí: 1 rok a 2 měsíce!“. */
export function modiversaryCalloutTitle(months) {
  const m = int(months);
  const y = Math.floor(m / 12), rest = m % 12;
  if (y && !rest) return `Blahopřejeme k ${y}letému moderátorskému výročí!`;
  if (y) return `Blahopřejeme k moderátorskému výročí: ${annivYears(y)} a ${annivMonths(rest)}!`;
  return `Blahopřejeme k moderátorskému výročí: ${annivMonths(m)}!`;
}

/** Předvyplněná zpráva sdílení (Twitch: „Oslavuji #leté moderátorské výročí!“). */
export function modiversarySharePrefill(months) {
  const m = int(months);
  return m >= 12 && m % 12 === 0 ? `Oslavuji ${m / 12}leté moderátorské výročí!` : `Oslavuji moderátorské výročí: ${annivMonths(m)}!`;
}

export const MODIVERSARY_CALLOUT_SUB = 'Pochlub se v chatu';
export const resubCalloutTitle = (months) => `Předplatné: ${annivMonths(int(months))}!`;
export const RESUB_CALLOUT_SUB = 'Sdílej to v chatu';
export const resubStreakLabel = (streak) => `Zobrazit v chatové zprávě mou ${int(streak)}měsíční sérii`;
/** Darované předplatné → poděkování dárci (Twitch: „Děkuji za dárek, @{gifter}!“). */
export const resubSharePrefill = (item) => (item?.isGift && item.gifter ? `Děkuji za dárek, @${item.gifter}!` : '');

export const ANNIV_INTEGRITY_TEXT = 'Sdílet se teď nepovedlo, zkus to přímo na Twitchi.';
const ERRORS = {
  ALREADY_SENT: 'Tohle výročí už je v tomto kanálu sdílené.',
  NOT_USER_MODIVERSARY: 'Teď tu nemáš moderátorské výročí, které by šlo sdílet.',
  UNKNOWN: 'Twitch sdílení odmítl, zkus to znovu.',
  resub_failed: 'Twitch výročí předplatného nepřijal (možná už je sdílené).',
  not_logged_in: 'Tenhle prohlížeč není přihlášený k Twitchi.',
  empty: 'Napiš zprávu, kterou chceš sdílet.',
  integrity: ANNIV_INTEGRITY_TEXT,
};
/** Kód chyby z background (GQL `error`, `integrity`, …) → česká hláška. */
export const annivErrorText = (code) => ERRORS[code] || 'Sdílení se nepovedlo, zkus to znovu.';

/**
 * Stav z background ANNIV_STATUS → výzva k zobrazení, nebo null. Resub (měsíční výročí předplatného) má přednost;
 * zavření se pamatuje podle klíče (`resub:<id notifikace>` — nové výročí má nové id a ukáže se znovu;
 * `mod:<Twitch účet>:<kanál>:<měsíce>` — jiný přihlášený účet má vlastní výzvu). `dismissed` = mapa klíč → { at, type }.
 */
export function pickAnniversary(status, dismissed = {}) {
  if (!status?.ok || !status.loggedIn) return null;
  const gone = (k) => !!dismissed && Object.prototype.hasOwnProperty.call(dismissed, k);
  const r = status.resub;
  if (r?.id) {
    const item = { kind: 'resub', key: `resub:${r.id}`, id: String(r.id), months: int(r.months), streak: int(r.streak), isGift: !!r.isGift, gifter: r.gifter || null };
    if (!gone(item.key)) return item;
  }
  const mm = int(status.modiversary?.months);
  if (mm) {
    const key = `mod:${status.userId || ''}:${status.channelId || ''}:${mm}`;
    if (!gone(key)) return { kind: 'mod', key, months: mm };
  }
  return null;
}

/** Úklid mapy zavřených výročí (starší než 400 dní a rozbité záznamy pryč). */
export function annivPruneDismissed(map, now = Date.now()) {
  const out = {};
  for (const [k, v] of Object.entries(map || {})) {
    if (v && typeof v === 'object' && Number(v.at) > now - ANNIV_DISMISS_KEEP_MS) out[k] = v;
  }
  return out;
}

// ---- banner ----

const reducedMotion = (win) => { try { return !!win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

/**
 * Banner výročí nad polem pro psaní (jako výzva Twitche): ikona, text, „Sdílet“ a ×. „Sdílet“ rozbalí zprávu
 * (limit, počítadlo, u resubu volba série) s Odeslat / Zrušit.
 *   onShare(item, { text, includeStreak }) → Promise<{ ok, error? }>  (error = česká hláška)
 *   onDismiss(item)                         → volá se po × (host si zavření pamatuje / volá Twitch)
 *   attachInput(input, { onApply })         → volitelné: host napojí na pole zprávy našeptávač emotů
 *                                             (core/emote-autocomplete.js attachEmoteAutocomplete) a vrátí
 *                                             { close, destroy }; volá se před vlastními listenery banneru,
 *                                             klávesu obslouženou našeptávačem (defaultPrevented) banner ignoruje
 * Po úspěchu krátce „Sdíleno v chatu!“ a banner zmizí. `prefers-reduced-motion` → bez animací.
 */
export class AnniversaryBanner {
  constructor({ doc, host, onShare, onDismiss, onHide = null, attachInput = null, log = () => {} }) {
    this.doc = doc; this.host = host; this.onShare = onShare; this.onDismiss = onDismiss; this.onHide = onHide; this.attachInput = attachInput; this.log = log;
    this.item = null; this.el = null; this._busy = false; this._t = null; this._ac = null;
  }

  get current() { return this.item; }
  get expanded() { return !!this.el?.classList.contains('uc-anniv--open'); }

  show(item) {
    if (!item) { this.hide(); return; }
    if (this.item?.key === item.key && this.el) return;
    this._clear();
    this.item = item;
    this.el = this._build(item);
    this.host.replaceChildren(this.el);
    this.host.classList.remove('hidden');
    if (!reducedMotion(this.doc.defaultView)) this.el.classList.add('uc-anniv--enter');
    this.log('Anniversary', `banner ${item.kind} ${item.kind === 'mod' ? `months=${item.months}` : `months=${item.months} streak=${item.streak} gift=${item.isGift}`}`);
  }

  hide({ instant = false } = {}) {
    const el = this.el;
    this._clear();
    this.item = null; this.el = null;
    const done = () => { if (!this.el) { this.host.replaceChildren(); this.host.classList.add('hidden'); } this.onHide?.(); };
    if (!el || instant || reducedMotion(this.doc.defaultView) || typeof el.animate !== 'function') { done(); return; }
    el.classList.add('uc-anniv--leaving');
    const a = el.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(8px)' }], { duration: 180, easing: 'ease-in', fill: 'forwards' });
    a.finished.catch(() => {}).then(done);
  }

  _clear() {
    if (this._t) { clearTimeout(this._t); this._t = null; }
    this._busy = false;
    try { this._ac?.destroy(); } catch { /* ignore */ }
    this._ac = null;
  }

  _build(item) {
    const d = this.doc;
    const mk = (tag, cls, text) => { const e = d.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const root = mk('div', `uc-anniv uc-anniv--${item.kind}`);
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Výročí');
    const row = mk('div', 'uc-anniv-row');
    const icon = mk('span', 'uc-anniv-icon');
    icon.innerHTML = item.kind === 'mod' ? ANNIV_SWORD_SVG : ANNIV_STAR_SVG;
    const txt = mk('div', 'uc-anniv-text');
    const title = mk('div', 'uc-anniv-title', item.kind === 'mod' ? modiversaryCalloutTitle(item.months) : resubCalloutTitle(item.months));
    const sub = mk('div', 'uc-anniv-sub', item.kind === 'mod' ? MODIVERSARY_CALLOUT_SUB : RESUB_CALLOUT_SUB);
    txt.append(title, sub);
    const share = mk('button', 'uc-anniv-share', 'Sdílet');
    share.type = 'button';
    const close = mk('button', 'uc-anniv-close', '×');
    close.type = 'button';
    close.title = 'Zavřít';
    close.setAttribute('aria-label', 'Zavřít');
    row.append(icon, txt, share, close);

    const form = mk('div', 'uc-anniv-form');
    const inner = mk('div', 'uc-anniv-form-inner');
    const input = mk('textarea', 'uc-anniv-input');
    input.rows = 2;
    input.maxLength = ANNIV_MAX_LEN;
    input.placeholder = item.kind === 'mod' ? 'Zpráva ke sdílení' : 'Zpráva ke sdílení (nepovinná)';
    input.value = item.kind === 'mod' ? modiversarySharePrefill(item.months) : resubSharePrefill(item);
    const meta = mk('div', 'uc-anniv-meta');
    let streakBox = null;
    if (item.kind === 'resub' && item.streak > 0) {
      const lab = mk('label', 'uc-anniv-streak');
      streakBox = mk('input');
      streakBox.type = 'checkbox';
      streakBox.checked = true;
      lab.append(streakBox, d.createTextNode(' ' + resubStreakLabel(item.streak)));
      meta.append(lab);
    }
    const count = mk('span', 'uc-anniv-count');
    meta.append(count);
    const actions = mk('div', 'uc-anniv-actions');
    const cancel = mk('button', 'uc-anniv-cancel', 'Zrušit');
    cancel.type = 'button';
    const send = mk('button', 'uc-anniv-send', 'Odeslat');
    send.type = 'button';
    actions.append(cancel, send);
    const note = mk('div', 'uc-anniv-msg');
    note.setAttribute('role', 'alert');
    const linkWarn = mk('div', 'uc-anniv-linkwarn', ANNIV_LINK_TEXT);
    linkWarn.setAttribute('role', 'alert');
    linkWarn.hidden = true;
    inner.append(linkWarn, input, meta, actions, note);
    form.append(inner);
    root.append(row, form);

    const allowEmpty = item.kind === 'resub'; // Twitch: resub tray allowEmptyMessage, mod ne
    const sync = () => {
      const len = input.value.length;
      count.textContent = `${len}/${ANNIV_MAX_LEN}`;
      count.classList.toggle('uc-anniv-count--full', len >= ANNIV_MAX_LEN);
      const hasLink = annivHasLink(input.value);
      linkWarn.hidden = !hasLink;
      send.disabled = this._busy || hasLink || (!allowEmpty && !input.value.trim());
    };
    const setOpen = (open) => {
      root.classList.toggle('uc-anniv--open', open);
      share.hidden = open;
      if (!open) this._ac?.close();
      note.textContent = '';
      if (open) { sync(); try { input.focus({ preventScroll: true }); input.setSelectionRange(input.value.length, input.value.length); } catch { /* ignore */ } }
    };
    const submit = async () => {
      if (this._busy || (send.disabled && !annivHasLink(input.value))) return;
      const text = input.value.trim().slice(0, ANNIV_MAX_LEN);
      if (!allowEmpty && !text) { note.textContent = annivErrorText('empty'); return; }
      if (annivHasLink(text)) { linkWarn.hidden = false; return; } // odkaz se nesdílí (i Enter)
      this._busy = true;
      root.classList.add('uc-anniv--busy');
      send.textContent = 'Odesílám…';
      input.disabled = true; cancel.disabled = true; sync();
      if (streakBox) streakBox.disabled = true;
      let res;
      try { res = await this.onShare(item, { text, includeStreak: !!streakBox?.checked }); } catch (e) { res = { ok: false, error: annivErrorText(e?.message) }; }
      if (this.item !== item) return; // mezitím zavřeno / nahrazeno
      this._busy = false;
      root.classList.remove('uc-anniv--busy');
      send.textContent = 'Odeslat';
      input.disabled = false; cancel.disabled = false;
      if (streakBox) streakBox.disabled = false;
      if (res?.ok) {
        root.classList.remove('uc-anniv--open');
        root.classList.add('uc-anniv--done');
        title.textContent = 'Sdíleno v chatu!';
        sub.textContent = item.kind === 'mod' ? 'Moderátorské výročí uvidí celý chat.' : 'Výročí předplatného uvidí celý chat.';
        share.hidden = true;
        this._t = setTimeout(() => { if (this.item === item) this.hide(); }, ANNIV_SUCCESS_MS);
        return;
      }
      sync();
      note.textContent = res?.error || annivErrorText();
    };

    // Našeptávač emotů hostitele — před vlastním keydown, ať Enter / Esc při otevřeném seznamu nejdřív obslouží on.
    if (this.attachInput) { try { this._ac = this.attachInput(input, { onApply: sync }) || null; } catch { this._ac = null; } }
    share.addEventListener('click', () => setOpen(true));
    cancel.addEventListener('click', () => { if (!this._busy) setOpen(false); });
    send.addEventListener('click', submit);
    input.addEventListener('input', sync);
    input.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return; // obslouženo našeptávačem emotů
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!this._busy) setOpen(false); }
    });
    close.addEventListener('click', () => {
      if (this._busy || this.item !== item) return;
      this.log('Anniversary', `zavřeno ${item.kind}`);
      try { this.onDismiss?.(item); } catch { /* ignore */ }
      this.hide();
    });
    root.addEventListener('animationend', () => root.classList.remove('uc-anniv--enter'));
    sync();
    return root;
  }
}
