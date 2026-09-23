// UnityChat Announcement — honosná zpráva s videem/animací a textem, kterou
// spouští command v Židolištce (RobJewsALot). Židolišta pošle payload na
// backend (POST /announcements), ten ho rozešle přes SSE `announcement`
// (/nicknames/stream) a addon i web ho vykreslí tímhle rendererem.
//
// Sdílený core: žádný DOM, jen HTML string (testovatelné v Node). Klient
// dodá `textHtml` (text už s emoty) a `reducedMotion`; klik na médium = replay.
import { escapeHtml, escapeAttr } from './html.js';

export const ANNC_MIN_WIDTH = 48;
export const ANNC_MAX_WIDTH = 480;
export const ANNC_DEFAULT_WIDTH = 192;
/** Jak dlouho po announcementu se schovává jeho běžná chatová odpověď. */
export const ANNC_REPLY_HIDE_MS = 15_000;

const normText = (s) => String(s || '').replace(/\u2800/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Je tahle chatová zpráva běžná odpověď commandu, kterou má UnityChat skrýt?
 * `pending` = seznam { text, until } z announcementů s hideInUnityChat.
 */
export function matchesChatReply(pending, messageText, now = Date.now()) {
  const t = normText(messageText);
  if (!t) return false;
  return pending.some((p) => p.until > now && normText(p.text) === t);
}

/**
 * Odpověď cizího bota (StreamElements…) na command s announcementem: uživatel UnityChatu
 * místo ní vidí announcement. Skryje se první zpráva toho bota do AHEAD ms po announcementu,
 * nebo (bot byl rychlejší) poslední jeho zpráva nejvýš BEHIND ms před ním. Podle odesílatele,
 * ne textu — odpověď bota může obsahovat proměnné.
 */
export const ANNC_BOT_AHEAD_MS = 10_000;
export const ANNC_BOT_BEHIND_MS = 5_000;

/** Loginy botů z payloadu: lowercase, jen platný login, max 5, bez duplicit. */
export function normBotLogins(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((x) => String(x || '').trim().toLowerCase()).filter((x) => /^[a-z0-9_]{2,25}$/.test(x)))].slice(0, 5);
}

/** Je zpráva od bota, jehož odpověď se čeká ke skrytí? `pending` = [{ login, until }]; shodu spotřebuje (skryje jen jednu zprávu). */
export function takeBotReply(pending, username, now = Date.now()) {
  const u = String(username || '').toLowerCase();
  const i = pending.findIndex((p) => p.until > now && p.login === u);
  if (i < 0) return false;
  pending.splice(i, 1);
  return true;
}

/**
 * Po příchodu announcementu: odpovědi botů, které už v chatu jsou (přišly dřív), skrýt třídou
 * `uc-annc-hidden`; vrací loginy, jejichž odpověď ještě nepřišla (ty čekají v `pending`).
 * chatEl = kontejner zpráv (`.msg[data-ts]` + `.un[data-username]`).
 */
export function hideRecentBotReplies(chatEl, logins, now = Date.now()) {
  const waiting = [];
  for (const login of logins) {
    const hit = [...chatEl.querySelectorAll('.msg[data-ts]')].reverse().find((el) => {
      if (el.classList.contains('uc-annc-hidden') || now - Number(el.dataset.ts) > ANNC_BOT_BEHIND_MS) return false;
      return el.querySelector('.un')?.dataset.username === login;
    });
    if (hit) hit.classList.add('uc-annc-hidden');
    else waiting.push(login);
  }
  return waiting;
}

const isHttps = (u) => typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(u);

/**
 * Obrana do hloubky pro `textHtml` ze Židolišty: projde jen <b> <i> <u> <br>
 * <h1>–<h3> a <a href="http(s)…"> (vždy target=_blank + rel noopener), vše
 * ostatní se escapuje jako text. Bez DOM (regex nad tagy), testovatelné v Node.
 */
export function sanitizeAnnouncementHtml(html) {
  const src = String(html || '');
  if (!src) return '';
  return src.replace(/<\/?([a-zA-Z0-9]+)((?:\s+[^<>]*?)?)\s*\/?>|[&<>"]/g, (m, tag, attrs, offset) => {
    // Už escapované entity (&amp; &lt; &#39; …) nechat, holé & escapovat.
    if (!tag) return m === '&' ? (/^&(?:[a-z]+|#\d+|#x[0-9a-f]+);/i.test(src.slice(offset)) ? '&' : '&amp;') : escapeHtml(m);
    const t = tag.toLowerCase();
    const closing = m.startsWith('</');
    if (['b', 'i', 'u', 'br', 'h1', 'h2', 'h3'].includes(t)) return closing ? `</${t}>` : (t === 'br' ? '<br>' : `<${t}>`);
    if (t === 'a') {
      if (closing) return '</a>';
      const href = /href\s*=\s*"([^"]*)"/i.exec(attrs || '')?.[1] || /href\s*=\s*'([^']*)'/i.exec(attrs || '')?.[1] || '';
      if (!/^https?:\/\/[^\s"'<>]+$/i.test(href)) return '';
      return `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer nofollow">`;
    }
    return escapeHtml(m);
  });
}

/**
 * Markdown-podmnožina Židolišty → HTML (stejná pravidla jako jejich server):
 * **tučný**, *kurzíva*, __podtržený__, [text](https://…), #/##/### na začátku
 * řádku, Enter = <br>. Fallback, když payload nenese `textHtml` (starší
 * server, mock). Vstup se nejdřív escapuje, výsledek ještě prochází sanitizerem.
 */
export function richTextToHtml(md) {
  const src = String(md || '');
  if (!src.trim()) return '';
  const lines = src.split(/\r?\n/).map((line) => {
    let l = escapeHtml(line);
    const h = /^(#{1,3})\s+(.*)$/.exec(l);
    if (h) return `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
    return inline(l);
  });
  return sanitizeAnnouncementHtml(lines.join('<br>'));
  function inline(l) {
    l = l.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, t, u) => `<a href="${u.replace(/&amp;/g, '&')}">${t}</a>`);
    l = l.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    l = l.replace(/__(.+?)__/g, '<u>$1</u>');
    l = l.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<i>$2</i>');
    return l;
  }
}

/**
 * Ověří a ořeže payload z backendu. Vrací null, když chybí to podstatné
 * (id, channel, médium nebo text). Neznámá pole se zahazují.
 */
export function normalizeAnnouncement(a) {
  if (!a || typeof a !== 'object') return null;
  const id = String(a.id || '').slice(0, 80);
  const channel = String(a.channel || '').toLowerCase().slice(0, 40);
  const text = String(a.text || '').slice(0, 500).trim();
  const textHtml = (String(a.textHtml || '').trim() ? sanitizeAnnouncementHtml(String(a.textHtml).slice(0, 4000)) : richTextToHtml(text)).trim();
  const m = a.media && typeof a.media === 'object' ? a.media : null;
  const media = m && isHttps(m.url) ? {
    url: m.url,
    kind: m.kind === 'image' ? 'image' : 'video',
    width: Math.max(ANNC_MIN_WIDTH, Math.min(ANNC_MAX_WIDTH, Number(m.width) || ANNC_DEFAULT_WIDTH)),
    height: Number(m.height) > 0 ? Math.round(Number(m.height)) : null,
    loop: m.loop !== false && m.loop !== 0 && m.loop !== 'false',   // volba v editoru Židolišty, výchozí zapnuto
    loopDelayMs: Math.max(0, Math.min(60_000, Math.round(Number(m.loopDelayMs) || 0))),   // pauza mezi přehráními (jen video + loop)
    stillUrl: isHttps(m.stillUrl) ? m.stillUrl : null,
  } : null;
  if (!id || !channel || (!media && !text && !textHtml)) return null;
  const by = a.triggeredBy && typeof a.triggeredBy === 'object' ? a.triggeredBy : null;
  const cr = a.chatReply && typeof a.chatReply === 'object' && String(a.chatReply.text || '').trim() ? a.chatReply : null;
  return {
    id, channel, text,
    textHtml,   // rich text (Markdown → HTML na serveru Židolišty), už sanitizovaný
    // Běžná odpověď, kterou SB pošle do chatu všem; při hideInUnityChat ji klient skryje (viz matchesChatReply).
    chatReply: cr ? { text: String(cr.text).slice(0, 500), hideInUnityChat: !!cr.hideInUnityChat } : null,
    // Odpovědi cizích botů (StreamElements…) na tentýž command — klient je skryje (takeBotReply / hideRecentBotReplies).
    hideBotReplies: normBotLogins(a.hideBotReplies),
    // true = v browser source pro OBS (/chat/raw/) se announcement nevykreslí (a nic se kvůli němu neskrývá).
    hideInBrowserSource: !!a.hideInBrowserSource,
    command: String(a.command || '').slice(0, 80),
    media,
    triggeredBy: by && by.user ? { user: String(by.user).slice(0, 60), platform: String(by.platform || '').slice(0, 20) } : null,
    at: Number.isFinite(Date.parse(a.at)) ? Date.parse(a.at) : Date.now(),
  };
}

/**
 * Po vložení do stránky: video z <template> se samo nenačte (inertní dokument),
 * a smyčka s pauzou (`data-loop-delay`) se řídí ručně: ended → čekat → od začátku.
 * Vrací funkci pro replay (klik na médium).
 */
export function wireAnnouncementVideo(el, { autoplay = true } = {}) {
  const v = el?.querySelector?.('video');
  if (!v) return () => { const img = el?.querySelector?.('.ua-media img'); if (img) { const src = img.src; img.src = ''; img.src = src; } };
  const delay = Number(v.dataset.loopDelay) || 0;
  let timer = null;
  const replay = () => { clearTimeout(timer); timer = null; v.currentTime = 0; v.play().catch(() => {}); };
  if (delay > 0) v.addEventListener('ended', () => { clearTimeout(timer); timer = setTimeout(() => { if (v.isConnected) replay(); }, delay); });
  v.load();
  if (autoplay) v.play().catch(() => {});
  return replay;
}

/**
 * @param {ReturnType<typeof normalizeAnnouncement>} a
 * @param {object} [o]
 * @param {string} [o.textHtml]        text už vyrenderovaný (emoty, odkazy); jinak escapovaný `a.text`
 * @param {boolean} [o.reducedMotion]  prefers-reduced-motion → nehybná varianta, když je
 * @param {string} [o.timeText]        „HH:MM" pro časovou značku
 */
export function announcementHtml(a, o = {}) {
  if (!a) return '';
  // Přednost: klientem dodané HTML → rich text (ze Židolišty, nebo z Markdownu v `text`) → escapovaný text.
  const textHtml = o.textHtml != null ? o.textHtml : (a.textHtml || escapeHtml(a.text));
  let mediaHtml = '';
  if (a.media) {
    const m = a.media;
    // Šířka jako strop; CSS ji omezí na část desky (min(--ua-w, 38%)), výška podle poměru stran.
    const size = `--ua-w:${m.width}px${m.height ? `;--ua-ar:${m.width} / ${m.height}` : ''}`;
    let inner;
    if (o.reducedMotion && m.stillUrl) {
      inner = `<img class="ua-still" src="${escapeAttr(m.stillUrl)}" alt="">`;
    } else if (m.kind === 'image') {
      inner = `<img class="ua-img" src="${escapeAttr(m.url)}" alt="">`;
    } else {
      // Bez still varianty při omezeném pohybu: video bez autoplay (první snímek), klik přehraje.
      const play = o.reducedMotion ? ' preload="metadata"' : ' autoplay preload="auto"';
      // Smyčka s pauzou: bez nativního `loop`, klient po `ended` počká data-loop-delay ms a pustí znovu (viz wireAnnouncementVideo).
      const delayed = m.loop && m.loopDelayMs > 0;
      inner = `<video class="ua-video" src="${escapeAttr(m.url)}"${play} muted playsinline${m.loop && !delayed ? ' loop' : ''}${delayed ? ` data-loop-delay="${m.loopDelayMs}"` : ''}${m.stillUrl ? ` poster="${escapeAttr(m.stillUrl)}"` : ''} aria-hidden="true"></video>`;
    }
    mediaHtml = `<div class="ua-media" style="${size}" title="Klik = přehrát znovu"><span class="ua-spot" aria-hidden="true"></span>${inner}</div>`;
  }
  const cmd = a.command ? `<span class="ua-cmd">${escapeHtml(a.command)}</span>` : '';
  const ts = o.timeText ? `<span class="ua-ts">${escapeHtml(o.timeText)}</span>` : '';
  return `<div class="msg uc-annc" data-annc-id="${escapeAttr(a.id)}" data-platform="unitychat" data-ts="${a.at}">`
    + `<div class="ua-frame">${mediaHtml}<div class="ua-body">`
    + `<div class="ua-kicker"><span class="ua-kicker-icon" aria-hidden="true">✦</span> UnityChat${cmd ? ' · ' + cmd : ''}${ts}</div>`
    + (textHtml ? `<div class="ua-text">${textHtml}</div>` : '')
    + `</div></div></div>`;
}
