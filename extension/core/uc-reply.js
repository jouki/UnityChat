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
  };
}
