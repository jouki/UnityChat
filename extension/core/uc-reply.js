// Odpovědi napříč platformami (2026-09-24): platforma sama odpověď na zprávu z jiné
// platformy neumí, do chatu jde jen „@jméno text". UnityChat při odeslání nahlásí
// serveru, na kterou zprávu odpovídá (platforma + id); server odpověď spáruje se zprávou
// z ingestu, uloží ji (content_raw.ucReply) a klientům ji dá v historii, v /chat/stream
// i přes SSE `uc-reply`. Klient pak ukáže ↩ s citací a „@jméno" z textu skryje
// (lidé mimo UnityChat ho v chatu platformy dál vidí). Sdílené addonem i webem.

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Regex úvodní zmínky „@jméno" (volitelně s čárkou/dvojtečkou) + mezery. */
export function replyMentionRe(username) {
  const name = String(username || '').replace(/^@/, '').trim();
  if (!name) return null;
  return new RegExp(`^\\s*@${escRe(name)}[,:]?(?:\\s+|$)`, 'i');
}

/**
 * Zpráva s cross-platform odpovědí → kopie bez úvodního „@jméno" v textu.
 * Twitch: posune emotesOffset (pozice emotů jsou v code pointech původního textu),
 * Kick: i v kickContent, YouTube: v prvním textovém runu.
 */
export function stripReplyMention(msg) {
  const re = replyMentionRe(msg?.replyTo?.username);
  if (!re) return msg;
  const m = String(msg.message || '').match(re);
  // Samotné „@jméno" bez textu nechat (prázdná zpráva by se nevykreslila).
  if (!m || !msg.message.slice(m[0].length).trim()) return msg;
  const out = { ...msg, message: msg.message.slice(m[0].length) };
  if (msg.platform === 'twitch' && msg.twitchEmotes) out.twitchEmotesOffset = (msg.twitchEmotesOffset || 0) + [...m[0]].length;
  if (typeof msg.kickContent === 'string') out.kickContent = msg.kickContent.replace(re, '');
  if (Array.isArray(msg.ytRuns) && msg.ytRuns.length && typeof msg.ytRuns[0]?.text === 'string') {
    const first = { ...msg.ytRuns[0], text: msg.ytRuns[0].text.replace(re, '') };
    out.ytRuns = first.text ? [first, ...msg.ytRuns.slice(1)] : msg.ytRuns.slice(1);
  }
  return out;
}

/** Tvar odpovědi pro server (/chat/send ucReplyTo, /chat/uc-sent replyTo). */
export function ucReplyPayload(reply) {
  if (!reply?.messageId && !reply?.id) return null;
  return {
    platform: reply.platform,
    id: String(reply.messageId || reply.id),
    username: String(reply.username || '').replace(/^@/, '').slice(0, 60),
    message: String(reply.message || '').slice(0, 300),
    // Autor citované zprávy je uživatel UnityChatu → v ↩ zlaté logo jeho platformy.
    ...(reply.authorUc ? { authorUc: true } : {}),
  };
}

// ---- Citace rodičovské zprávy (↩ @jméno text) — addon, web i OBS ----

/**
 * Odkazy v HTML z EmoteManageru (`<a href=… target=_blank rel=noopener>text</a>`, text je escapovaný) nahradí prostým
 * textem `.uc-link-off`: citace rodiče nikdy nenese živý odkaz (review 2026-09-27 I2 — odpověď bota na smazaný GIF
 * by jinak odkaz z `reply-parent-msg-body` znovu ukázala). Emoty zůstávají.
 */
export function stripLinksHtml(html) {
  return String(html ?? '').replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '<span class="uc-link-off">$1</span>');
}

/** Rodičovská zpráva je smazaná (moderace, GIF i schovaná gif_request) → citace jen „↩ @jméno“ bez textu. */
export function isReplyParentGone(parent) {
  return !!parent && !!(parent._deleted || parent.deleted);
}

/**
 * Tělo citace (` <span class="rctx-body">…</span>`) platformním renderem EmoteManageru bez živých odkazů, nebo ''
 * (bez textu / rodič smazaný).
 * @param {{ message?: string }} rt       msg.replyTo
 * @param {string} platform              platforma citované zprávy
 * @param {{ renderKick: Function, renderTwitch: Function, renderPlain: Function }} emotes
 */
export function replyBodyHtml(rt, platform, emotes, { parentGone = false } = {}) {
  if (!rt?.message || parentGone) return '';
  const b = platform === 'kick' ? emotes.renderKick(rt.message)
    : platform === 'twitch' ? emotes.renderTwitch(rt.message, null)
      : emotes.renderPlain(rt.message);
  return ` <span class="rctx-body">${stripLinksHtml(b)}</span>`;
}

/**
 * Rodič se smazal až po vykreslení odpovědi → text citací pryč (uzly `.reply-ctx[data-rctx-id="<id>"]` pod `roots`,
 * i samotné kořeny). Vrací počet upravených citací.
 */
export function dropReplyBodies(roots, id) {
  if (id == null || id === '') return 0;
  const esc = String(id).replace(/["\\]/g, '\\$&');
  const sel = `.reply-ctx[data-rctx-id="${esc}"] .rctx-body`;
  let n = 0;
  for (const r of roots || []) {
    if (!r) continue;
    for (const b of [...(r.querySelectorAll?.(sel) || [])]) { b.remove(); n++; }
  }
  return n;
}
