// GIF logika hostitele chatu — sdílená addonem (extension/sidepanel.js) a webem (web/src). Dřív byla v obou
// zvlášť a verze se rozešly (závěrečný audit GIF knihovny 2026-09-27, nález D1). Hostitel dodá jen své
// přístupy k datům a DOM (store, uzly zprávy, parky mimo okno, smazání / odkrytí zprávy, odeslání) a volá tyhle funkce.
//
//  - vykreslení: appendGifMedia (médium pod text), takeGifReplacedSlot (starý GIF s `replaces` na místě původní),
//  - SSE: gifMessageForChat (gif-message), loadGifMediaMessages + applyGifMediaEvent (gif-media),
//    gifAccountHandlers (/account/stream: gif-pending / -decided / -queue / -progress / -notice + resync),
//  - smazané / schované zprávy: paintGifDeleted (GIF větve vzhledu smazané zprávy), gifOwnView (štítek odesílatele,
//    i z historie), applyGifHeldResult (odpověď GET /gif/held pro schovanou zprávu),
//  - štítky odesílatele: applyGifOwn, paintGifOwnKeys (GifOutbox onChange),
//  - odeslání: watchYoutubeSend (YouTube bez echa), pairGifEcho (echo vlastní GIF zprávy přes id).
//
// Bez chrome.*. DOM jen přes předané uzly / `doc`, síť přes injektované `api`.
import { GIF_GONE_CLASS, createGifMedia, removeGifMedia, normalizeGifMedia, normalizeGifMediaEvent, gifMessagesPath, gifMessageFromEvent, gifMsgMediaId, setGifUnavailable, gifReplacedTarget, isGifHeldReason, GIF_NOT_ALLOWED_REASON } from './gif.js';
import { paintGifStatus, gifEchoPatch, gifOwnHistoryView, isGifOwnFinal, gifOwnFinalReason, MEDIA_REFETCH_SPREAD_MS } from './gif-library.js';
import { clearDeleted, disableTextLinks } from './moderation.js';

const isGifReason = (reason) => String(reason || '').startsWith('gif_');
const noop = () => {};

// ---------------------------------------------------------------------------
// Vykreslení
// ---------------------------------------------------------------------------

/**
 * Médium GIFu do zprávy `el` hned za text (nové vykreslení i obnova zprávy); předchozí `.uc-gif` pryč.
 * `gif` musí být ověřené (normalizeGifMedia s originy). `onSized` = výška se ustálila po načtení média bez známých
 * rozměrů (hostitel dorovná konec chatu).
 */
export function appendGifMedia(doc, el, gif, { log, onSized } = {}) {
  removeGifMedia(el);
  el.classList.add('has-gif');
  const media = createGifMedia(doc, gif, { lazy: true, log });
  if (onSized && media.classList.contains('uc-gif--nosize')) {
    media.firstChild?.addEventListener?.(gif.kind === 'mp4' ? 'loadedmetadata' : 'load', () => onSized(), { once: true });
  }
  const tx = el.querySelector(':scope > .tx');
  if (tx) tx.after(media); else el.appendChild(media);
  // GIF pryč (removed / unavailable) → OBS zprávu skryje; obnovený viditelný GIF značku sundá.
  el.classList.toggle(GIF_GONE_CLASS, media.classList.contains('uc-gif--gone'));
  return media;
}

/**
 * GIF zpráva s `replaces` (core gifReplacedTarget, jen staré GIFy): uzel původní zprávy (schovaný gif_request)
 * nahradit novým uzlem na stejném místě — v DOM i v parku mimo okno. Vrací true (v DOM), 'parked' (v parku),
 * false (původní uzel tu není → hostitel vloží zprávu běžnou cestou podle času).
 *
 * @param {object} o
 * @param {HTMLElement} o.chatEl
 * @param {HTMLElement[][]} o.parks  [parkedTop, parkedBottom] (pole se mění na místě)
 * @param {(id: string, platform: string) => HTMLElement[]} o.msgEls
 * @param {{ get(id: string): any }} o.store
 */
export function takeGifReplacedSlot(msg, el, { chatEl, parks = [], msgEls, store, log = noop } = {}) {
  const t = gifReplacedTarget(msg);
  if (!t) return false;
  const orig = store?.get(t.id);
  if (orig && orig.platform === t.platform) orig._gifReplaced = true;
  const lists = parks.filter(Boolean);
  let where = false;
  for (const old of msgEls(t.id, t.platform)) {
    if (old === el) continue;
    if (!where && old.parentNode === chatEl) { chatEl.insertBefore(el, old); where = true; }
    else if (!where) {
      for (const park of lists) {
        const i = park.indexOf(old);
        if (i >= 0) { park[i] = el; where = 'parked'; break; }
      }
      if (where) continue;
    }
    if (old.parentNode) old.remove();
    else for (const park of lists) { const i = park.indexOf(old); if (i >= 0) park.splice(i, 1); }
  }
  if (where) log('Gif', `${msg.id} nahradil ${t.platform}:${t.id} na jejím místě${where === 'parked' ? ' (v parku)' : ''}`);
  return where;
}

// ---------------------------------------------------------------------------
// SSE /nicknames/stream: gif-message, gif-media
// ---------------------------------------------------------------------------

/**
 * SSE `gif-message` → zpráva k vykreslení (hostitel ji přidá běžnou cestou), nebo null (jiný kanál, chybná data,
 * už v chatu). Můj GIF (`gifOrigin`) → štítek odesílatele pryč (GifOutbox.onGifMessage).
 */
export function gifMessageForChat(d, { channel, origins = null, has, outbox = null, log = noop } = {}) {
  const m = gifMessageFromEvent(d, channel, { origins });
  if (!m) { log('Gif', `gif-message ignorováno (${d?.channel || '?'} ${d?.message?.id || '?'})`); return null; }
  if (has?.(String(m.id))) { log('Gif', `gif-message ${m.id} už v chatu`); return null; }
  // Pořadí podle času schválení (message.timestamp) — gifOrigin je jen k párování (GIF knihovna 2026-09-26).
  if (m.gifOrigin) outbox?.onGifMessage(m);
  log('Gif', `gif-message ${m.id} čas ${m.timestamp}${m.gifOrigin ? ` origin ${m.gifOrigin}` : ''}${m.replaces ? ` replaces ${m.replaces}` : ''}`);
  return { ...m, historical: false };
}

/**
 * SSE `gif-media` visible: obsah zpráv, které chat má, z GET /chat/messages. Dotaz se rozprostře náhodně do 0–2 s
 * (všichni otevření klienti i OBS naráz = špička, audit F13). Vrací { n, list } (n = normalizovaná událost, nebo null).
 *
 * @param {object} o
 * @param {string} o.channel
 * @param {(path: string) => Promise<any>} o.api
 * @param {(key: string) => boolean} o.has   chat zprávu `<platform>:<id>` má
 * @param {number} [o.delayMs]
 */
export async function loadGifMediaMessages(d, { channel, api, has, log = noop, delayMs = Math.random() * MEDIA_REFETCH_SPREAD_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const n = normalizeGifMediaEvent(d, channel);
  if (!n) { log('Gif', `gif-media ignorováno (${d?.channel || '?'} ${d?.mediaId || '?'} ${d?.state || '?'})`); return { n: null, list: [] }; }
  if (n.state !== 'visible') return { n, list: [] };
  const path = gifMessagesPath(channel, n.messageIds.filter((k) => has?.(k)));
  if (!path) return { n, list: [] };
  if (delayMs > 0) await sleep(delayMs);
  try {
    const list = (await api(path))?.messages;
    return { n, list: Array.isArray(list) ? list : [] };
  } catch (e) {
    log('Gif', `gif-media visible: /chat/messages FAIL ${e?.status || 0} ${e?.error || e?.message || e}`);
    return { n, list: [] };
  }
}

/** Klíč `<platform>:<id>` odpovídá zprávě ve store? (pro loadGifMediaMessages `has`) */
export function storeHasKey(store, key) {
  const i = String(key).indexOf(':');
  const m = i > 0 ? store.get(String(key).slice(i + 1)) : null;
  return !!m && m.platform === String(key).slice(0, i);
}

/**
 * SSE `gif-media` na zprávy v chatu (spec 2026-09-27-gif-nahled-zahozeni-design.md): removed → zprávy s médiem
 * „smazané“ (gif_removed; OBS je skryje), unavailable → štítek „[GIF nedostupný]“, visible → `fetched`
 * (GET /chat/messages) obnovené na místě s GIFem, library → nic (jen panel GIFů). Vrací počet zpráv v chatu.
 *
 * @param {object} o
 * @param {{ get(id: string): any, slice(): any[] }} o.store
 * @param {(id: string, platform: string) => HTMLElement[]} o.msgEls
 * @param {(platform: string, id: string, o: { reason: string }) => any} o.applyDeleted
 * @param {(d: { platform: string, messageId: string, message: object }) => any} o.unhide  obnovení (restore)
 */
export function applyGifMediaEvent(n, fetched, { doc, store, msgEls, applyDeleted, unhide, origins = null } = {}) {
  if (!n) return 0;
  let hit = 0;
  if (n.state === 'library') return 0;   // viditelnost zpráv beze změny
  if (n.state === 'visible') {
    for (const m of Array.isArray(fetched) ? fetched : []) {
      if (!m || typeof m !== 'object') continue;
      const g = normalizeGifMedia(m.gif, { origins });
      if (!g || !store.get(String(m.id))) continue;
      unhide({ platform: m.platform, messageId: m.id, message: { ...m, gif: g } });
      hit++;
    }
    return hit;
  }
  for (const msg of store.slice()) {
    if (gifMsgMediaId(msg) !== n.mediaId) continue;
    hit++;
    if (n.state === 'removed') applyDeleted(msg.platform, msg.id, { reason: 'gif_removed' });
    else {
      msg.gif = { ...msg.gif, unavailable: true };
      for (const el of msgEls(msg.id, msg.platform)) setGifUnavailable(doc, el);
    }
  }
  return hit;
}

// ---------------------------------------------------------------------------
// /account/stream
// ---------------------------------------------------------------------------

/**
 * Handlery GIF událostí pro connectAccountStream (core/account-warnings.js) + `onOpen` (po (znovu)připojení stav
 * vlastních štítků dotazem — události mohly propadnout). Getry vracejí instance líně (fronta vzniká až při použití).
 */
export function gifAccountHandlers({ requests, outbox = () => null, cooldown = () => null, log = noop } = {}) {
  return {
    handlers: {
      'gif-pending': (d) => { requests().onPending(d); if (d?.own) outbox()?.onOwnPending(d); },
      'gif-decided': (d) => { requests().onDecided(d); cooldown()?.onDecided(d); if (d?.own) outbox()?.onDecided(d); },
      // GIF knihovna: fronta (FIFO karta modům), průběh stahování a hlášky odesílateli.
      'gif-queue': (d) => requests().onQueue(d),
      // Tiché schválení (mod / knihovna) nemá gif-decided → konec cooldownu nese `done` (test2 bod 4.1); GIF odkaz
      // během cooldownu → gif-notice cooldown. Obojí nastaví bublinu / zámek výběru (GifCooldown.onServerCooldown).
      'gif-progress': (d) => {
        outbox()?.onProgress(d);
        if (d?.phase === 'done' && d.outcome === 'approved' && d && 'cooldownUntil' in d) cooldown()?.onServerCooldown?.(d.cooldownUntil ?? null, d.serverNow);
      },
      'gif-notice': (d) => {
        outbox()?.onNotice(d);
        if (d?.kind === 'cooldown') cooldown()?.onServerCooldown?.(d.until ?? null, d.serverNow);
      },
    },
    onOpen: ({ reconnect } = {}) => {
      const n = outbox()?.resync() || 0;
      if (n || reconnect) log('Gif', `account stream ${reconnect ? 'znovu ' : ''}připojen → resync ${n} štítků`);
      return n;
    },
  };
}

// ---------------------------------------------------------------------------
// Smazané / schované zprávy
// ---------------------------------------------------------------------------

/**
 * Štítek vlastní GIF zprávy pro uzel `el`: živý stav z GifOutbox, jinak (reload, jiné zařízení) ze smazání serverem
 * u zprávy přihlášeného účtu (`identity` = { login } na platformě zprávy, audit A10). null = žádný štítek.
 */
export function gifOwnView(outbox, el, msg, identity = null) {
  if (!outbox) return null;
  const platform = msg?.platform || el?.dataset?.platform;
  const id = el?.dataset?.msgId || (msg?.id != null ? String(msg.id) : '');
  const live = outbox.size ? outbox.view(platform, id) : null;
  if (live) return live;
  return identity ? gifOwnHistoryView(outbox, { ...msg, platform, id: msg?.id ?? id }, identity) : null;
}

/**
 * Konečný stav vlastního GIFu (zamítnuto / vypršelo / nové GIFy nejsou povolené) i v datech zprávy (review kola 4 M2):
 * `_gifOwnFinal` + `_deleted` + důvod, takže překreslení `.tx`, kopírování i citace (hostitel `_isModerated`,
 * `textSuppressed`) berou zprávu jako smazanou. Když se štítek později vrátí z konečného stavu (soft „Vypršelo“ →
 * resync → čeká), předchozí stav smazání se obnoví. Vrací true, když je zpráva v konečném stavu.
 */
export function syncGifOwnFinal(msg, view) {
  if (!msg || typeof msg !== 'object') return false;
  if (isGifOwnFinal(view)) {
    if (!msg._gifOwnFinal) {
      msg._gifOwnFinalPrev = { deleted: !!msg._deleted, reason: msg.deletedReason ?? null };
      msg._gifOwnFinal = true;
    }
    msg._deleted = true;
    if (!msg.deletedReason || isGifHeldReason(msg.deletedReason) || msg.deletedReason === msg._gifOwnFinalReason) {
      msg.deletedReason = gifOwnFinalReason(view);
      msg._gifOwnFinalReason = msg.deletedReason;
    }
    return true;
  }
  if (msg._gifOwnFinal) {
    const prev = msg._gifOwnFinalPrev || { deleted: false, reason: null };
    // Smazání potvrzené serverem mezitím (_srvDeleted, message-deleted) zůstává.
    msg._deleted = prev.deleted || msg.deleted === true || !!msg._srvDeleted;
    if (msg.deletedReason === msg._gifOwnFinalReason) { if (prev.reason) msg.deletedReason = prev.reason; else delete msg.deletedReason; }
    delete msg._gifOwnFinal; delete msg._gifOwnFinalPrev; delete msg._gifOwnFinalReason;
  }
  return false;
}

/**
 * GIF větve vzhledu smazané / skryté zprávy (sdílené addonem i webem). Vrací true = vyřízeno (hostitel dál
 * nemaluje), false = běžná smazaná zpráva (hostitel pokračuje; médium smazaného GIFu už je pryč).
 *
 *  - vlastní GIF (`own` = gifOwnView): rozpracovaný / čekající zůstává vidět s textem a štítkem (kolečko %,
 *    „Schvalování moderátorem“); konečný červený stav („Zamítnuto moderátorem“, „Vypršelo“, „Nové GIFy teď nejsou
 *    povolené“) = text mírně ztlumený, odkaz neživý, jen štítek — bez vzhledu smazané zprávy a bez „Smazáno“, i pro
 *    moda (user 2026-09-27); schválení = štítek pryč, zpráva se schová jako u ostatních,
 *  - gif_request (čeká): ostatním schovaná úplně (`uc-gif-held`) + pojistka `hold` (GET /gif/held),
 *  - gif_not_allowed cizí zprávy: schovaná úplně všem (divák, mod, OBS; živě i z historie) — ani „Zpráva smazána“,
 *  - OBS (`raw`): zamítnutý / nepovolený GIF se neukáže ani jako „Smazáno“ (čekající GIF v OBS nikdy),
 *  - smazaný GIF: server médium přestane servírovat → pryč z dat i z DOM.
 *
 * @param {object} o
 * @param {object|null} o.own                              gifOwnView(…)
 * @param {boolean} [o.raw]                                OBS
 * @param {(msg: object) => boolean} o.hasContent
 * @param {(el: HTMLElement, tx: HTMLElement, msg: object) => void} o.rerender  text zprávy znovu z dat
 * @param {(platform: string, id: string) => void} o.hold / o.release          pojistka GifHoldWatch
 */
export function paintGifDeleted(doc, el, msg, { own = null, raw = false, hasContent, rerender, hold = noop, release = noop, log = noop } = {}) {
  const deleted = !!(msg._deleted || msg.deleted);
  const held = deleted && isGifHeldReason(msg.deletedReason);
  const pl = msg.platform || el.dataset?.platform;
  const id = msg.id != null ? String(msg.id) : el.dataset?.msgId;
  if (own && own.kind !== 'approved' && (held || (deleted && isGifReason(msg.deletedReason)))) {
    el.classList.remove('uc-gif-held');
    if (isGifOwnFinal(own)) {
      syncGifOwnFinal(msg, own);
      release(pl, id);
      // Rozhodnuto (zamítnuto / vypršelo / nové GIFy nejsou povolené): vlastní text (bez obsahu z historie prázdný)
      // mírně ztlumený, odkaz neživý + červený štítek; bez vzhledu smazané zprávy a bez „Smazáno“, i pro moda
      // (user 2026-09-27, sjednoceno se specem).
      clearDeleted(el);
      const tx = el.querySelector('.tx');
      if (tx && tx.querySelector('.uc-deleted-label')) {
        if (hasContent(msg)) rerender(el, tx, msg); else tx.replaceChildren();
      }
      paintGifStatus(doc, el, own);
      disableTextLinks(el);
      return true;
    }
    clearDeleted(el);
    const tx = el.querySelector('.tx');
    if (tx && tx.querySelector('.uc-deleted-label') && hasContent(msg)) rerender(el, tx, msg);
    paintGifStatus(doc, el, own);
    if (held) hold(pl, id);
    return true;
  }
  paintGifStatus(doc, el, null);
  if (deleted && !held && (msg.deletedReason === GIF_NOT_ALLOWED_REASON || (raw && isGifReason(msg.deletedReason)))) {
    el.classList.add('uc-gif-held');
    release(pl, id);
    return true;
  }
  el.classList.toggle('uc-gif-held', !!held);
  if (held) { hold(pl, id); return true; }
  release(pl, id);
  if (deleted) {
    if (msg.gif) delete msg.gif;
    if (removeGifMedia(el)) { el.classList.remove('has-gif'); log('Gif', `smazaný GIF ${pl}:${el.dataset?.msgId} → médium pryč`); }
  }
  return false;
}

/**
 * Odpověď GET /gif/held (core GifHoldWatch) pro schovanou zprávu: visible → odkrýt s daty ze serveru, deleted →
 * běžně smazaná s důvodem, jinak nechat schovanou. Vrací výsledek volaného hostitele (počet uzlů), jinak 0.
 */
export function applyGifHeldResult(r, { store, unhide, applyDeleted, forgetHeld = noop } = {}) {
  if (!r?.messageId) return 0;
  const id = String(r.messageId);
  if (r.state === 'visible' && r.message) return unhide({ platform: r.platform, messageId: id, message: r.message }) || 0;
  if (r.state === 'deleted') {
    forgetHeld(id);
    const msg = store?.get(id);
    if (msg && msg.platform === r.platform) delete msg.deletedReason;
    return applyDeleted(r.platform, id, { reason: r.reason || null }) || 0;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Štítky odesílatele
// ---------------------------------------------------------------------------

const isOptimisticEl = (el, msg) => !!(msg?.optimistic || msg?._optimistic) || /^sent-/.test(String(el?.dataset?.msgId || ''));

/**
 * Štítek vlastní GIF zprávy v uzlu `el`. Schváleno a echo pořád nedorazilo (YouTube: bot zprávu smazal dřív, než ji
 * poller viděl) → optimistická zpráva s odkazem pryč (`dropOptimistic` vrací true = odebráno), schválený GIF je nová
 * zpráva na konci chatu. Smazaná / schovaná zpráva jde přes `paintDeleted` (štítek řeší sám).
 * Vrací 'dropped' | 'deleted' | 'painted'.
 */
export function applyGifOwn(doc, el, msg, { view, outbox = null, isModerated, paintDeleted, dropOptimistic, log = noop } = {}) {
  const platform = el.dataset?.platform || msg?.platform;
  if (view?.kind === 'approved' && isOptimisticEl(el, msg) && dropOptimistic?.(el.dataset.msgId, platform, el) === true) {
    log('Gif', `${el.dataset.msgId} schváleno bez echa → optimistická zpráva pryč`);
    outbox?.drop(platform, el.dataset.msgId);
    return 'dropped';
  }
  // Konečný červený stav i bez message-deleted ze serveru (optimistická zpráva, gif-notice approved_only) →
  // odesílatel ji vidí jako smazanou hned (kolo 4 bod 4a), i v datech zprávy (M2, syncGifOwnFinal).
  syncGifOwnFinal(msg, view);
  if (msg && isModerated(msg)) { paintDeleted(el, msg); return 'deleted'; }
  if (isGifOwnFinal(view)) {
    const base = { platform, id: el.dataset?.msgId, message: el.querySelector?.('.tx')?.textContent || '' };
    paintDeleted(el, { ...base, _deleted: true, deletedReason: gifOwnFinalReason(view) });
    return 'deleted';
  }
  paintGifStatus(doc, el, view || null);
  return 'painted';
}

/**
 * GifOutbox onChange: překreslit štítky zpráv s klíči `platform:id` (`outbox.idsFor(key)` = skutečné id +
 * optimistické aliasy). Vrací počet uzlů.
 */
export function paintGifOwnKeys(doc, keys, outbox, { msgEls, getMsg, isModerated, paintDeleted, dropOptimistic, log = noop } = {}) {
  if (!outbox) return 0;
  let n = 0;
  for (const key of keys || []) {
    const platform = key.slice(0, key.indexOf(':'));
    for (const id of outbox.idsFor(key)) {
      for (const el of msgEls(id, platform)) {
        const msg = getMsg(el.dataset.msgId) || getMsg(String(id));
        applyGifOwn(doc, el, msg, { view: outbox.view(platform, el.dataset.msgId), outbox, isModerated, paintDeleted, dropOptimistic, log });
        n++;
      }
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Odeslání
// ---------------------------------------------------------------------------

/** Kontrola YouTube zprávy bez echa: první po 20 s, GIF ještě jednou po dalších 25 s. */
export const YT_SEND_CHECK_MS = 20_000;
export const YT_SEND_GIF_RECHECK_MS = 25_000;
export const YT_SEND_FAIL_TEXT = 'YouTube zprávu přijal, ale v chatu ji nezobrazil — nejspíš blokuje odkazy nebo ji zadržel filtr';

/**
 * YouTube API vrátí 200 i pro zprávu, kterou chat tiše zahodí (odkaz od nemoderátora). Když do 20 s nepřijde echo,
 * optimistickou zprávu označit jako neodeslanou. GIF zprávu ale řídí štítek (gif-progress / gif-decided): server ji
 * schoval a bot ji mohl smazat dřív, než ji poller viděl → echo nepřijde, přesto odešla. GIF bez štítku (server o ní
 * zatím neví) → ještě jednou po 25 s, pak neodesláno.
 * `pending()` = zpráva je pořád optimistická (echo ji nespárovalo) — ze stavu chatu, ne z fronty párování (audit F3).
 * Vrací funkci pro zrušení.
 */
export function watchYoutubeSend({ optId, platform, isGif = false, outbox = null, pending, markFailed, log = noop, setTimeout: st = globalThis.setTimeout.bind(globalThis), clearTimeout: ct = globalThis.clearTimeout.bind(globalThis), firstMs = YT_SEND_CHECK_MS, againMs = YT_SEND_GIF_RECHECK_MS } = {}) {
  let t = null;
  const check = (last) => {
    t = null;
    if (!pending()) return;
    if (isGif && outbox?.governs(platform, optId)) { log('Send', 'youtube: GIF bez echa — stav řídí štítek, ne neodesláno'); return; }
    if (isGif && !last) { t = st(() => check(true), againMs); return; }
    markFailed(YT_SEND_FAIL_TEXT);
    log('Send', `youtube: bez echa ${last ? Math.round((firstMs + againMs) / 1000) : Math.round(firstMs / 1000)} s → označeno`);
  };
  t = st(() => check(false), firstMs);
  return () => { if (t) ct(t); t = null; };
}

/**
 * Echo vlastní GIF zprávy spárované přes id (POST /chat/send → id, gif-progress requestKey), ne podle textu: server ji
 * schoval (gif_request) a /chat/stream ji pošle BEZ obsahu → optimistická si nechá svůj text (gifEchoPatch), echo
 * dodá id, čas a smazání. Vrací { optId, patch } nebo null (není to echo mé GIF zprávy / optimistická už není).
 */
export function pairGifEcho(msg, outbox, hasOptimistic) {
  if (!outbox || !msg || msg._optimistic || msg.optimistic || msg.id == null) return null;
  const optId = outbox.optIdFor(msg.platform, String(msg.id));
  if (!optId || !hasOptimistic(optId)) return null;
  return { optId, patch: gifEchoPatch(msg) };
}
