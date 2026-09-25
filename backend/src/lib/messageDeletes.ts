// Smazání zprávy v archivu (spec 2026-09-25 moderace §mazání): mod, platforma (CLEARMSG/DELETE)
// nebo link filter smaže zprávu retroaktivně — obsah zůstává v DB pro audit (moderationActions +
// samotný řádek messages), ale klienti (toClientMessage) ho nikdy nedostanou. Ostatní klienti se
// dozví přes SSE `message-deleted` na /nicknames/stream.
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { messages } from '../db/schema.js';
import { broadcast } from '../sse/bus.js';
import { publishModIntegration } from '../sse/integrationStream.js';
import type { Platform } from './zidolista.js';
import { normPlatformChannel } from './ucChannel.js';

export type DeleteReason = 'mod' | 'platform' | 'link_filter';

export interface MarkDeletedParams {
  platform: Platform;
  messageId: string;
  by: string | null;
  reason: DeleteReason;
  /** Kanál zprávy přesně jak je v messages.channel — když je zadán, jiný kanál se needituje (pojistka pro moderaci). */
  expectedChannel?: string;
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
    .where(and(
      eq(messages.platform, p.platform),
      eq(messages.platformMessageId, p.messageId),
      isNull(messages.deletedAt),
      p.expectedChannel !== undefined ? eq(messages.channel, p.expectedChannel) : undefined,
    ))
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
  /**
   * UC kanál pro SSE broadcast — volající (route/ingest, viz `ucChannelFor`) ho
   * musí dodat jako UC kanál (streamerův Twitch login), ne platformní. DB řádek
   * v `messages.channel` může nést platformní kanál (Kick slug / YT handle) —
   * proto se broadcast řídí vždy tímhle parametrem, nikdy DB hodnotou.
   */
  channel: string;
  platform: Platform;
  messageId: string;
  by: string | null;
  reason: DeleteReason;
  /** Předá se do markDeleted (viz MarkDeletedParams.expectedChannel); ingest ho nedává. */
  expectedChannel?: string;
}

export interface PublishDeletedDeps {
  markDeleted: (p: MarkDeletedParams) => Promise<MarkDeletedResult>;
  broadcast: (event: string, data: object) => void;
  now: () => number;
  /** Integrační stream Židolišty (`chat.deleted`); chybí-li v deps, nic se neposílá (testy). */
  integration?: (ev: DeletedEvent) => Promise<unknown> | unknown;
}

const defaultDeps: PublishDeletedDeps = {
  markDeleted,
  broadcast,
  now: Date.now,
  integration: (ev) => publishModIntegration(ev.channel, 'chat.deleted', ev),
};

const DEDUP_MS = 60_000;
// Modul-level: jeden proces, jeden zdroj pravdy. Klíč platform:messageId — Twitch CLEARMSG
// z ingestu dorazí i po vlastním /moderation/delete, druhý broadcast by jen zbytečně mihnul UI.
const recentlyPublished = new Map<string, number>();

/**
 * markDeleted + broadcast('message-deleted', …) s p.channel (UC kanál) + `chat.deleted` do integračního
 * streamu Židolišty — jediné místo pro všechna smazání (UC route, ingest, integrace), dedup 60 s per platform:messageId.
 */
export async function publishDeleted(p: PublishDeletedParams, deps: PublishDeletedDeps = defaultDeps): Promise<void> {
  const key = `${p.platform}:${p.messageId}`;
  const t = deps.now();
  const last = recentlyPublished.get(key);
  if (last !== undefined && t - last < DEDUP_MS) return;
  // Dedup se zapíše až po úspěšném zápisu — když DB selže, opakování do 60 s musí projít.
  await deps.markDeleted({ platform: p.platform, messageId: p.messageId, by: p.by, reason: p.reason, expectedChannel: p.expectedChannel });
  recentlyPublished.set(key, t);
  if (recentlyPublished.size > 1000) {
    for (const [k, at] of recentlyPublished) if (t - at >= DEDUP_MS) recentlyPublished.delete(k);
  }
  const ev = deletedEvent({ channel: p.channel, platform: p.platform, messageId: p.messageId, by: p.by, reason: p.reason, at: t });
  deps.broadcast('message-deleted', ev);
  // Výpadek registru workspaců nesmí shodit mazání (route už poslala SSE, ingest jede dál).
  try { await deps.integration?.(ev); } catch { /* ignore */ }
}

/** messages.channel zprávy (platformní kanál, jak ho uložil ingest); null = v archivu není. */
export async function archivedMessageChannel(platform: Platform, messageId: string): Promise<string | null> {
  const rows = await db
    .select({ channel: messages.channel })
    .from(messages)
    .where(and(eq(messages.platform, platform), eq(messages.platformMessageId, messageId)))
    .limit(1);
  return rows[0]?.channel ?? null;
}

/** Patří zpráva (kanál z archivu) do očekávaného platformního kanálu? Normalizace jako ingest/registr. */
export function channelMatches(got: string | null | undefined, want: string | null | undefined): boolean {
  return !!got && !!want && normPlatformChannel(got) === normPlatformChannel(want);
}
