// „Jen UC skrýt“ (moderace část 1, Task 6b — Chat Log v dashboardu Židolišty): zpráva zůstává
// na platformě, UnityChat (addon, web, OBS) ji nevykreslí. V /chat/history jde bez obsahu
// (toClientMessage → hidden: true), živí klienti se dozví přes SSE `message-hidden` na
// /nicknames/stream; `message-unhidden` nese celou zprávu v klientském tvaru, ať ji klient
// vykreslí zpět. Židolišta dostane `chat.hidden` / `chat.unhidden` v integračním streamu.
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { messages, type Message } from '../db/schema.js';
import { broadcast } from '../sse/bus.js';
import { publishModIntegration } from '../sse/integrationStream.js';
import { toClientMessage, type ClientMessage } from '../routes/chat.js';
import type { Platform } from './zidolista.js';

export type HideResult = 'ok' | 'not_found';

export interface HideParams {
  /** UC kanál (Twitch login streamera) pro SSE — ne platformní kanál z DB. */
  channel: string;
  platform: Platform;
  messageId: string;
  by: string;
}

export interface HiddenEvent { channel: string; platform: Platform; messageId: string; by: string; at: number }
export interface UnhiddenEvent extends HiddenEvent { message: ClientMessage | Record<string, unknown> }

export function hiddenEvent(p: HiddenEvent): HiddenEvent {
  return { channel: p.channel, platform: p.platform, messageId: p.messageId, by: p.by, at: p.at };
}

export function unhiddenEvent(p: UnhiddenEvent): UnhiddenEvent {
  return { ...hiddenEvent(p), message: p.message };
}

/** Skryje zprávu (idempotentně — první hidden_at/hidden_by zůstává). true = zpráva existuje. */
export async function markHidden(p: { platform: Platform; messageId: string; by: string }): Promise<boolean> {
  const rows = await db
    .update(messages)
    .set({ hiddenAt: sql`coalesce(${messages.hiddenAt}, now())`, hiddenBy: sql`coalesce(${messages.hiddenBy}, ${p.by})` })
    .where(and(eq(messages.platform, p.platform), eq(messages.platformMessageId, p.messageId)))
    .returning({ id: messages.id });
  return rows.length > 0;
}

/** Zruší skrytí; vrací celý řádek (pro message-unhidden) nebo null, když zpráva neexistuje. */
export async function markUnhidden(p: { platform: Platform; messageId: string }): Promise<Message | null> {
  const rows = await db
    .update(messages)
    .set({ hiddenAt: null, hiddenBy: null })
    .where(and(eq(messages.platform, p.platform), eq(messages.platformMessageId, p.messageId)))
    .returning();
  return rows[0] ?? null;
}

type Integration = (type: 'chat.hidden' | 'chat.unhidden', ev: HiddenEvent) => Promise<unknown> | unknown;
const defaultIntegration: Integration = (type, ev) => publishModIntegration(ev.channel, type, ev);

export interface PublishHiddenDeps {
  markHidden: typeof markHidden;
  broadcast: (event: string, data: object) => void;
  now: () => number;
  /** Integrační stream Židolišty; chybí-li v deps, nic se neposílá (testy). */
  integration?: (ev: HiddenEvent) => Promise<unknown> | unknown;
}

export interface PublishUnhiddenDeps {
  markUnhidden: typeof markUnhidden;
  broadcast: (event: string, data: object) => void;
  now: () => number;
  integration?: (ev: HiddenEvent) => Promise<unknown> | unknown;
}

const hiddenDeps: PublishHiddenDeps = { markHidden, broadcast, now: Date.now, integration: (ev) => defaultIntegration('chat.hidden', ev) };
const unhiddenDeps: PublishUnhiddenDeps = { markUnhidden, broadcast, now: Date.now, integration: (ev) => defaultIntegration('chat.unhidden', ev) };

/** markHidden → SSE message-hidden (UC kanál) → chat.hidden pro Židolištu. Neznámá zpráva = not_found, nic se neposílá. */
export async function publishHidden(p: HideParams, deps: PublishHiddenDeps = hiddenDeps): Promise<HideResult> {
  if (!(await deps.markHidden({ platform: p.platform, messageId: p.messageId, by: p.by }))) return 'not_found';
  const ev = hiddenEvent({ ...p, at: deps.now() });
  deps.broadcast('message-hidden', ev);
  try { await deps.integration?.(ev); } catch { /* integrace nesmí shodit moderaci */ }
  return 'ok';
}

/** markUnhidden → SSE message-unhidden s celou zprávou (toClientMessage, historical) → chat.unhidden. */
export async function publishUnhidden(p: HideParams, deps: PublishUnhiddenDeps = unhiddenDeps): Promise<HideResult> {
  const row = await deps.markUnhidden({ platform: p.platform, messageId: p.messageId });
  if (!row) return 'not_found';
  const ev = hiddenEvent({ ...p, at: deps.now() });
  deps.broadcast('message-unhidden', unhiddenEvent({ ...ev, message: toClientMessage(row, true) }));
  try { await deps.integration?.(ev); } catch { /* integrace nesmí shodit moderaci */ }
  return 'ok';
}
