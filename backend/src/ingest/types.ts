import type { IngestPlatform } from './channels.js';

export interface IngestMessage {
  platform: IngestPlatform;
  platformMessageId: string;
  platformUserId: string;
  username: string;
  channel: string;
  content: string;
  contentRaw: Record<string, unknown>;
  sentAt: Date;
  isUnitychatUser: boolean;
  isReply: boolean;
  replyToMessageId: string | null;
  /**
   * Smazaná už při příjmu (filtr odkazů, lib/linkFilter.ts): toRow uloží deleted_* rovnou
   * s řádkem, /chat/stream ji dostane bez obsahu. Obsah zůstává v DB (obnovení permitem).
   */
  deleted?: { by: string; reason: 'link_filter' };
}

export type PlatformStatus = 'off' | 'connecting' | 'connected' | 'reconnecting' | 'error';

/** Smazání zprávy na platformě (Twitch CLEARMSG, Kick MessageDeletedEvent, YouTube markChatItemAsDeletedAction/removeChatItemAction). */
export interface IngestDelete {
  platform: IngestPlatform;
  /** Platformní kanál (twitch login / kick slug / youtube handle) — ne nutně UC kanál. */
  channel: string;
  messageId: string;
}

/** Timeout / ban uživatele na platformě (zatím Twitch CLEARCHAT s target-user-id). */
export interface IngestUserModeration {
  platform: IngestPlatform;
  /** Platformní kanál (twitch login) — ne nutně UC kanál. */
  channel: string;
  userId: string;
  login: string;
  /** Timeout v sekundách; null = permanentní ban. */
  durationSec: number | null;
}

export interface IngestListener {
  start(): void;
  stop(): void;
  status(): PlatformStatus;
  lastMessageAt(): Date | null;
  /** YouTube: videoId živého streamu, jinak null / neimplementováno. */
  currentVideoId?(): string | null;
}
