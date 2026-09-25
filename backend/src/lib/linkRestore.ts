// Obnovení zprávy permitem (moderace část 3): mod udělí permit z nabídky NA KONKRÉTNÍ zprávě, kterou
// smazal filtr odkazů → zpráva se v UnityChatu (addon, web, OBS) zobrazí, jako by nikdy nebyla smazaná.
// Na platformě zůstává smazaná (platformy obnovení neumí). Jen deleted_reason = 'link_filter' —
// smazání modem ani platformou se permitem neobnovuje.
//   SSE `message-restored { channel, platform, messageId, by, at, message }` (message = klientský tvar)
//   + `chat.restored` do integračního streamu Židolišty.
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { messages, type Message } from '../db/schema.js';
import { broadcast } from '../sse/bus.js';
import { publishModIntegration } from '../sse/integrationStream.js';
import { toClientMessage, type ClientMessage } from '../routes/chat.js';
import { forgetPublished } from './messageDeletes.js';
import { normPlatformChannel } from './ucChannel.js';
import type { Platform } from './zidolista.js';

export interface RestoreParams {
  /** UC kanál (Twitch login streamera) pro SSE. */
  channel: string;
  platform: Platform;
  messageId: string;
  /** Autor zprávy (cíl permitu) — obnoví se jen jeho zpráva. */
  userId: string;
  /** Platformní kanál (registr) — zpráva musí patřit kanálu moda. */
  platformChannel: string;
  by: string;
  /** Důvod smazání, který se ruší: výchozí link_filter (permit); gif_request = převod GIFu selhal (část 4). */
  reason?: 'link_filter' | 'gif_request';
}

export type RestoreResult = 'ok' | 'not_found';

export interface RestoredEvent { channel: string; platform: Platform; messageId: string; by: string; at: number; message: ClientMessage | Record<string, unknown> }

/** Zruší smazání filtrem odkazů; vrací celý řádek, nebo null (jiná zpráva / jiný důvod / není smazaná). */
export async function markRestored(p: { platform: Platform; messageId: string; userId: string; platformChannel: string; reason?: 'link_filter' | 'gif_request' }): Promise<Message | null> {
  const n = normPlatformChannel(p.platformChannel);
  const rows = await db
    .update(messages)
    .set({ deletedAt: null, deletedBy: null, deletedReason: null })
    .where(and(
      eq(messages.platform, p.platform),
      eq(messages.platformMessageId, p.messageId),
      eq(messages.platformUserId, p.userId),
      eq(messages.deletedReason, p.reason ?? 'link_filter'),
      inArray(messages.channel, [n, `@${n}`]),
    ))
    .returning();
  return rows[0] ?? null;
}

export interface PublishRestoredDeps {
  markRestored: typeof markRestored;
  broadcast: (event: string, data: object) => void;
  now: () => number;
  forget: (platform: Platform, messageId: string) => void;
  integration?: (ev: RestoredEvent) => Promise<unknown> | unknown;
}

const defaultDeps: PublishRestoredDeps = {
  markRestored,
  broadcast,
  now: Date.now,
  forget: forgetPublished,
  integration: (ev) => publishModIntegration(ev.channel, 'chat.restored', { platform: ev.platform, messageId: ev.messageId, by: ev.by }),
};

/** markRestored → SSE message-restored s celou zprávou → chat.restored. Nic k obnovení = not_found, nic se neposílá. */
export async function publishRestored(p: RestoreParams, deps: PublishRestoredDeps = defaultDeps): Promise<RestoreResult> {
  const row = await deps.markRestored({ platform: p.platform, messageId: p.messageId, userId: p.userId, platformChannel: p.platformChannel, ...(p.reason ? { reason: p.reason } : {}) });
  if (!row) return 'not_found';
  deps.forget(p.platform, p.messageId);
  const ev: RestoredEvent = { channel: p.channel, platform: p.platform, messageId: p.messageId, by: p.by, at: deps.now(), message: toClientMessage(row, true) };
  deps.broadcast('message-restored', ev);
  try { await deps.integration?.(ev); } catch { /* integrace nesmí shodit moderaci */ }
  return 'ok';
}

export interface RestoreOnPermitDeps {
  platformChannel: (channel: string, platform: Platform) => Promise<string | null>;
  publishRestored: (p: RestoreParams) => Promise<RestoreResult>;
  log: { warn: (o: object, m: string) => void };
}

/**
 * Po úspěšném permitu (POST /moderation/permit s messageId): obnovit zprávu, pokud ji smazal filtr odkazů.
 * Vrací výsledek pro `results.restore`: 'ok' | 'not_found' | 'error:<kód>'; bez messageId null (nic se nedělá).
 */
export async function restoreOnPermit(
  p: { channel: string; platform: Platform; userId: string; messageId?: string | null; by: string },
  deps: RestoreOnPermitDeps,
): Promise<RestoreResult | `error:${string}` | null> {
  if (!p.messageId) return null;
  try {
    const pch = await deps.platformChannel(p.channel, p.platform);
    if (!pch) return 'error:no_channel';
    return await deps.publishRestored({ channel: p.channel, platform: p.platform, messageId: p.messageId, userId: p.userId, platformChannel: pch, by: p.by });
  } catch (e) {
    deps.log.warn({ platform: p.platform, err: (e as Error).message }, 'permit: obnovení zprávy selhalo');
    return 'error:db';
  }
}
