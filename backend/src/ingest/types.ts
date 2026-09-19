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
}

export type PlatformStatus = 'off' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface IngestListener {
  start(): void;
  stop(): void;
  status(): PlatformStatus;
  lastMessageAt(): Date | null;
}
