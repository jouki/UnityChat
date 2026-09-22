import type { NewMessage } from '../db/schema.js';
import type { IngestMessage } from './types.js';

// Braille Pattern Blank — marker zpráv odeslaných z UnityChatu (viz CLAUDE.md).
export const UC_MARKER = '\u2800';

// ---------------------------------------------------------------- Twitch --

export interface IrcLine {
  tags: Record<string, string>;
  prefix: string;
  command: string;
  params: string;
  trailing: string;
}

/** IRC tag value unescaping (IRCv3): \s→space, \n→space, \r→'', \:→';', \\→'\'. */
export function unescapeTag(v: string): string {
  return v.replace(/\\s/g, ' ').replace(/\\n/g, ' ').replace(/\\r/g, '').replace(/\\:/g, ';').replace(/\\\\/g, '\\');
}

export function parseIrcLine(line: string): IrcLine | null {
  let rest = line.trim();
  if (!rest) return null;
  const tags: Record<string, string> = {};
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    if (sp === -1) return null;
    for (const t of rest.substring(1, sp).split(';')) {
      const eq = t.indexOf('=');
      if (eq !== -1) tags[t.substring(0, eq)] = unescapeTag(t.substring(eq + 1));
      else if (t) tags[t] = '';
    }
    rest = rest.substring(sp + 1);
  }
  let prefix = '';
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    if (sp === -1) return null;
    prefix = rest.substring(1, sp);
    rest = rest.substring(sp + 1);
  }
  let trailing = '';
  const ti = rest.indexOf(' :');
  let head = rest;
  if (ti !== -1) { trailing = rest.substring(ti + 2); head = rest.substring(0, ti); }
  const [command, ...params] = head.split(' ');
  if (!command) return null;
  return { tags, prefix, command, params: params.join(' '), trailing };
}

export function normalizeTwitchPrivmsg(line: string, channel: string): IngestMessage | null {
  const p = parseIrcLine(line);
  if (!p || p.command !== 'PRIVMSG') return null;
  const id = p.tags['id'];
  if (!id) return null;

  let message = p.trailing;
  let action = false;
  if (message.startsWith('\u0001ACTION ') && message.endsWith('\u0001')) {
    message = message.substring(8, message.length - 1);
    action = true;
  }
  const login = p.prefix.match(/^(\w+)!/)?.[1] || '';
  const username = p.tags['display-name'] || login || 'Unknown';

  const replyParentId = p.tags['reply-parent-msg-id'] || null;
  let emotesOffset = 0;
  if (replyParentId && message.startsWith('@')) {
    // Twitch přidává "@user " na začátek reply — panel ho stripuje, emote
    // pozice v tagu ale počítají s původním textem → offset pro klienta.
    const sp = message.indexOf(' ');
    if (sp !== -1) { emotesOffset = sp + 1; message = message.substring(sp + 1); }
  }

  const ts = Number(p.tags['tmi-sent-ts']);
  return {
    platform: 'twitch',
    platformMessageId: id,
    platformUserId: p.tags['user-id'] || '',
    username,
    channel: channel.toLowerCase(),
    content: message,
    contentRaw: {
      login,
      displayName: p.tags['display-name'] || null,
      color: p.tags['color'] || null,
      badges: p.tags['badges'] || '',
      emotes: p.tags['emotes'] || null,
      emotesOffset,
      firstMsg: p.tags['first-msg'] === '1',
      action,
      replyParentDisplayName: p.tags['reply-parent-display-name'] || null,
      replyParentBody: p.tags['reply-parent-msg-body'] || null,
    },
    sentAt: Number.isFinite(ts) && ts > 0 ? new Date(ts) : new Date(),
    isUnitychatUser: message.includes(UC_MARKER),
    isReply: !!replyParentId,
    replyToMessageId: replyParentId,
  };
}

// ------------------------------------------------------------------ Kick --

interface KickPayload {
  id?: string; type?: string; content?: string; created_at?: string;
  sender?: { id?: number | string; username?: string; slug?: string; identity?: { color?: string; badges?: unknown[] } };
  metadata?: { original_message?: { id?: string; content?: string }; original_sender?: { id?: number | string; username?: string } };
}

export function normalizeKickMessage(raw: unknown, channel: string): IngestMessage | null {
  const data = (typeof raw === 'string' ? JSON.parse(raw) : raw) as KickPayload;
  if (!data || (data.type !== 'message' && data.type !== 'reply')) return null;
  if (!data.id) return null;
  let content = data.content || '';
  const orig = data.type === 'reply' ? data.metadata?.original_message : undefined;
  const origSender = data.type === 'reply' ? data.metadata?.original_sender : undefined;
  if (orig?.id && origSender?.username) {
    const at = `@${origSender.username}`;
    if (content.startsWith(at + ' ')) content = content.substring(at.length + 1);
    else if (content.startsWith(at)) content = content.substring(at.length);
  }
  const ts = data.created_at ? Date.parse(data.created_at) : NaN;
  const badges = Array.isArray(data.sender?.identity?.badges) ? data.sender!.identity!.badges : [];
  return {
    platform: 'kick',
    platformMessageId: String(data.id),
    platformUserId: data.sender?.id != null ? String(data.sender.id) : '',
    username: data.sender?.username || 'Unknown',
    channel: channel.toLowerCase(),
    content,
    contentRaw: {
      content: data.content || '',
      color: data.sender?.identity?.color || null,
      badges,
      senderSlug: data.sender?.slug || null,
      replyParentUsername: origSender?.username || null,
      replyParentBody: orig?.content || null,
    },
    sentAt: Number.isFinite(ts) ? new Date(ts) : new Date(),
    isUnitychatUser: content.includes(UC_MARKER),
    isReply: !!orig?.id,
    replyToMessageId: orig?.id ? String(orig.id) : null,
  };
}

// --------------------------------------------------------------- YouTube --

interface YtRun {
  text?: string;
  emoji?: { emojiId?: string; shortcuts?: string[] };
  navigationEndpoint?: { urlEndpoint?: { url?: string }; commandMetadata?: { webCommandMetadata?: { url?: string } } };
}

/**
 * Plná URL odkazu v runu. YouTube v `text` odkaz zkracuje („https://youtu.be/…?si=5kVik…"),
 * celý je v navigationEndpoint jako youtube.com/redirect?…&q=<url> (nebo přímo).
 */
export function ytRunUrl(run: YtRun): string | null {
  const raw = run.navigationEndpoint?.urlEndpoint?.url || run.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || '';
  if (!raw) return null;
  try {
    const u = new URL(raw, 'https://www.youtube.com');
    if (u.hostname.endsWith('youtube.com') && u.pathname === '/redirect') {
      const q = u.searchParams.get('q');
      return q && /^https?:\/\//i.test(q) ? q : null;
    }
    return /^https?:$/.test(u.protocol) ? u.toString() : null;
  } catch { return null; }
}

/** Text runu pro `content`: u zkráceného odkazu plná URL. */
export function ytRunText(run: YtRun): string {
  if (run.text) {
    const full = ytRunUrl(run);
    if (full && (run.text.endsWith('…') || run.text.endsWith('...') || full.startsWith(run.text) || run.text.startsWith(full.slice(0, 12)))) return full;
    return run.text;
  }
  return run.emoji?.shortcuts?.[0] || run.emoji?.emojiId || '';
}
interface YtRenderer {
  id?: string; timestampUsec?: string;
  authorName?: { simpleText?: string }; authorExternalChannelId?: string;
  authorPhoto?: { thumbnails?: { url?: string }[] };
  message?: { runs?: YtRun[] };
  authorBadges?: { liveChatAuthorBadgeRenderer?: { tooltip?: string } }[];
  purchaseAmountText?: { simpleText?: string };
}

export function normalizeYoutubeAction(action: unknown, channel: string): IngestMessage | null {
  const item = (action as { addChatItemAction?: { item?: Record<string, YtRenderer> } })?.addChatItemAction?.item;
  if (!item) return null;
  const paid = item.liveChatPaidMessageRenderer;
  const r = item.liveChatTextMessageRenderer || paid;
  if (!r?.id) return null;
  const rawName = r.authorName?.simpleText || 'Unknown';
  const username = rawName.replace(/^@/, '') || rawName;
  // Odkazy: v runs nechat plnou URL i pro renderer (core renderYouTube bere run.text).
  const runs = (r.message?.runs || []).map((x) => (x.text && ytRunUrl(x) && ytRunText(x) !== x.text) ? { ...x, text: ytRunText(x) } : x);
  const content = runs.map((x) => ytRunText(x)).join('');
  const usec = Number(r.timestampUsec);
  return {
    platform: 'youtube',
    platformMessageId: r.id,
    platformUserId: r.authorExternalChannelId || '',
    username,
    channel: channel.toLowerCase(),
    content,
    contentRaw: {
      runs,
      authorPhoto: r.authorPhoto?.thumbnails?.[0]?.url || null,
      badges: (r.authorBadges || []).map((b) => b.liveChatAuthorBadgeRenderer?.tooltip || '').filter(Boolean),
      superChat: !!paid,
      purchaseAmount: paid?.purchaseAmountText?.simpleText || null,
    },
    sentAt: Number.isFinite(usec) && usec > 0 ? new Date(Math.floor(usec / 1000)) : new Date(),
    isUnitychatUser: content.includes(UC_MARKER),
    isReply: false,
    replyToMessageId: null,
  };
}

// ------------------------------------------------------------------- Row --

export function toRow(m: IngestMessage): NewMessage {
  return {
    platform: m.platform,
    platformMessageId: m.platformMessageId,
    platformUserId: m.platformUserId,
    platformUsername: m.username,
    content: m.content,
    contentRaw: m.contentRaw,
    channel: m.channel,
    isUnitychatUser: m.isUnitychatUser,
    isReply: m.isReply,
    replyToMessageId: m.replyToMessageId,
    sentAt: m.sentAt,
  };
}
