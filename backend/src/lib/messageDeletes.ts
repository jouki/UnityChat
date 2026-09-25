// Smazání zprávy v archivu (spec 2026-09-25 moderace §mazání): mod, platforma (CLEARMSG/DELETE)
// nebo link filter smaže zprávu retroaktivně — obsah zůstává v DB pro audit (moderationActions +
// samotný řádek messages), ale klienti (toClientMessage) ho nikdy nedostanou. Ostatní klienti se
// dozví přes SSE `message-deleted` na /nicknames/stream.
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { messages } from '../db/schema.js';
import { broadcast } from '../sse/bus.js';
import type { Platform } from './zidolista.js';

export type DeleteReason = 'mod' | 'platform' | 'link_filter';

export interface MarkDeletedParams {
  platform: Platform;
  messageId: string;
  by: string | null;
  reason: DeleteReason;
}

export interface MarkDeletedResult {
  channel: string | null;
  login: string | null;
}

/**
 * Nastaví deleted_* jen když zpráva ještě není smazaná (WHERE deleted_at IS NULL) — idempotentní
 * vůči druhému zásahu (mod smaže → o chvíli později dorazí Twitch CLEARMSG na stejnou zprávu).
 * Neznámé ID nebo už smazaná zpráva → { channel: null, login: null } (žádný řádek se needituje).
 */
export async function markDeleted(p: MarkDeletedParams): Promise<MarkDeletedResult> {
  const rows = await db
    .update(messages)
    .set({ deletedAt: new Date(), deletedBy: p.by, deletedReason: p.reason })
    .where(and(eq(messages.platform, p.platform), eq(messages.platformMessageId, p.messageId), isNull(messages.deletedAt)))
    .returning({ channel: messages.channel, login: messages.platformUsername });
  const hit = rows[0];
  return { channel: hit?.channel ?? null, login: hit?.login ?? null };
}

export interface DeletedEvent {
  channel: string;
  platform: Platform;
  messageId: string;
  by: string | null;
  reason: DeleteReason;
  at: number;
}

/** Tvar SSE `message-deleted` (bus.ts broadcast je jen JSON.stringify — pořadí polí tu nezáleží). */
export function deletedEvent(p: { channel: string; platform: Platform; messageId: string; by: string | null; reason: DeleteReason; at: number }): DeletedEvent {
  return { channel: p.channel, platform: p.platform, messageId: p.messageId, by: p.by, reason: p.reason, at: p.at };
}

export interface PublishDeletedParams {
  /** Fallback kanál — volající (route/ingest) ho vždy zná; DB kanál z markDeleted má přednost. */
  channel: string;
  platform: Platform;
  messageId: string;
  by: string | null;
  reason: DeleteReason;
}

export interface PublishDeletedDeps {
  markDeleted: (p: MarkDeletedParams) => Promise<MarkDeletedResult>;
  broadcast: (event: string, data: object) => void;
  now: () => number;
}

const defaultDeps: PublishDeletedDeps = { markDeleted, broadcast, now: Date.now };

const DEDUP_MS = 60_000;
// Modul-level: jeden proces, jeden zdroj pravdy. Klíč platform:messageId — Twitch CLEARMSG
// z ingestu dorazí i po vlastním /moderation/delete, druhý broadcast by jen zbytečně mihnul UI.
const recentlyPublished = new Map<string, number>();

/** markDeleted + broadcast('message-deleted', …), s dedup 60 s per platform:messageId. */
export async function publishDeleted(p: PublishDeletedParams, deps: PublishDeletedDeps = defaultDeps): Promise<void> {
  const key = `${p.platform}:${p.messageId}`;
  const t = deps.now();
  const last = recentlyPublished.get(key);
  if (last !== undefined && t - last < DEDUP_MS) return;
  recentlyPublished.set(key, t);
  if (recentlyPublished.size > 1000) {
    for (const [k, at] of recentlyPublished) if (t - at >= DEDUP_MS) recentlyPublished.delete(k);
  }
  const { channel } = await deps.markDeleted({ platform: p.platform, messageId: p.messageId, by: p.by, reason: p.reason });
  deps.broadcast('message-deleted', deletedEvent({ channel: channel ?? p.channel, platform: p.platform, messageId: p.messageId, by: p.by, reason: p.reason, at: t }));
}
