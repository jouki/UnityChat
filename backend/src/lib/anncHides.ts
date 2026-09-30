// Potlačení běžné odpovědi na command, místo které uživatel UnityChatu vidí announcement — na SERVERU
// (2026-09-30). Klient to dělal jen živě (core/announcement.js matchesChatReply / takeBotReply), takže po
// obnovení stránky se v historii ukázala odpověď StreamElements a announcement chyběl. Teď si server po
// POST /announcements zapamatuje, co má skrýt, a zprávu z ingestu označí `content_raw.anncHidden = <id>`;
// /chat/history i /chat/stream ji pak posílají s `anncHidden: true` a klienti ji nevykreslí.
//   - chatReply.hideInUnityChat: zpráva se stejným textem (bez markeru, mezery sjednocené) do REPLY_MS po announcementu
//   - hideBotReplies: PRVNÍ zpráva každého z botů do BOT_AHEAD_MS po announcementu (spotřebuje se); bot rychlejší
//     než announcement → poslední jeho zpráva nejvýš BOT_BEHIND_MS před ním (UPDATE v DB, dělá volající)
// Stejné časy jako klient (ANNC_REPLY_HIDE_MS 15 s, ANNC_BOT_AHEAD_MS 10 s, ANNC_BOT_BEHIND_MS 5 s).
import { normText } from './ucSends.js';

export const ANNC_REPLY_MS = 15_000;
export const ANNC_BOT_AHEAD_MS = 10_000;
export const ANNC_BOT_BEHIND_MS = 5_000;

export interface AnncHide {
  id: string;
  /** UC kanál (twitch login). */
  channel: string;
  atMs: number;
  replyText: string | null;
  botLogins: string[];
}

export interface LiveMessageLike { channel: string; username: string; content: string; sentAt: Date }

export class AnncHideRegistry {
  private pending = new Map<string, AnncHide[]>();   // UC kanál → čekající
  constructor(private now: () => number = Date.now) {}

  remember(a: { id: string; channel: string; at: string | number; chatReply?: { text: string; hideInUnityChat: boolean } | null; hideBotReplies?: string[] }): AnncHide | null {
    const atMs = typeof a.at === 'number' ? a.at : Date.parse(a.at);
    const replyText = a.chatReply?.hideInUnityChat && a.chatReply.text ? normText(a.chatReply.text).toLowerCase() : null;
    const botLogins = [...new Set((a.hideBotReplies || []).map((l) => String(l || '').toLowerCase()).filter(Boolean))];
    if (!replyText && !botLogins.length) return null;
    const h: AnncHide = { id: a.id, channel: a.channel.toLowerCase(), atMs: Number.isFinite(atMs) ? atMs : this.now(), replyText, botLogins };
    const list = this.prune(h.channel);
    list.push(h);
    this.pending.set(h.channel, list.slice(-50));
    return h;
  }

  /**
   * Živá zpráva → id announcementu, kvůli kterému se má skrýt, nebo null. `ucChannel` = UC kanál zprávy
   * (platformní kanál přes registr). Shoda podle bota se spotřebuje (skryje jen jednu zprávu bota).
   */
  match(m: LiveMessageLike, ucChannel: string): string | null {
    const list = this.prune(ucChannel.toLowerCase());
    if (!list.length) return null;
    const t = m.sentAt.getTime();
    const text = normText(m.content).toLowerCase();
    const user = String(m.username || '').toLowerCase();
    for (const h of list) {
      if (t < h.atMs - ANNC_BOT_BEHIND_MS) continue;
      if (h.replyText && text === h.replyText && t <= h.atMs + ANNC_REPLY_MS) return h.id;
      const i = h.botLogins.indexOf(user);
      if (i >= 0 && t <= h.atMs + ANNC_BOT_AHEAD_MS) { h.botLogins.splice(i, 1); return h.id; }
    }
    return null;
  }

  private prune(channel: string): AnncHide[] {
    const t = this.now();
    const list = (this.pending.get(channel) || []).filter((h) => t - h.atMs < Math.max(ANNC_REPLY_MS, ANNC_BOT_AHEAD_MS) + 5_000);
    this.pending.set(channel, list);
    return list;
  }

  /** Jen pro testy. */
  _reset(): void { this.pending.clear(); }
}

export const anncHides = new AnncHideRegistry();
