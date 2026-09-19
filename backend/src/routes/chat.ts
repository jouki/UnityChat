import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
import { db } from '../db/index.js';
import { messages, streamers, type Message } from '../db/schema.js';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';

/**
 * Historie chatu pro panel (spec 2026-09-19 §3.2). Zprávy plní ingest
 * (src/ingest), tady se jen čtou: kurzorová paginace odzadu, mapování na
 * tvar, který panel dostává od živých providerů, ať má renderer jednu cestu.
 */

export interface ClientMessage {
  platform: string;
  id: string;
  username: string;
  userId: string;
  message: string;
  timestamp: number;
  color?: string | null;
  badgesRaw?: string;
  twitchEmotes?: string | null;
  twitchEmotesOffset?: number;
  firstMsg?: boolean;
  isAction?: boolean;
  replyTo?: { username: string; message: string; id: string } | null;
  kickContent?: string;
  ytRuns?: unknown[];
  superChat?: boolean;
  historical: true;
}

/** Řádek z DB → tvar, který panel dostává od providerů (renderer má jednu cestu). */
export function toClientMessage(row: Message): ClientMessage {
  const raw = (row.contentRaw || {}) as Record<string, unknown>;
  const base = {
    platform: row.platform,
    id: row.platformMessageId,
    username: row.platformUsername,
    userId: row.platformUserId,
    message: row.content,
    timestamp: row.sentAt.getTime(),
    historical: true as const,
  };
  if (row.platform === 'twitch') {
    return {
      ...base,
      color: (raw.color as string) || null,
      badgesRaw: (raw.badges as string) || '',
      twitchEmotes: (raw.emotes as string) || null,
      twitchEmotesOffset: (raw.emotesOffset as number) || 0,
      firstMsg: !!raw.firstMsg,
      isAction: !!raw.action,
      replyTo: row.isReply && row.replyToMessageId
        ? { username: (raw.replyParentDisplayName as string) || '', message: (raw.replyParentBody as string) || '', id: row.replyToMessageId }
        : null,
    };
  }
  if (row.platform === 'kick') {
    const badges = Array.isArray(raw.badges) ? (raw.badges as { type: string; count?: number }[]) : [];
    return {
      ...base,
      color: (raw.color as string) || '#53fc18',
      kickContent: (raw.content as string) || row.content,
      badgesRaw: badges.filter((b) => b && b.type).map((b) => (b.count ? `${b.type}/${b.count}` : b.type)).join(','),
      replyTo: row.isReply && row.replyToMessageId
        ? { username: (raw.replyParentUsername as string) || '', message: (raw.replyParentBody as string) || '', id: row.replyToMessageId }
        : null,
    };
  }
  return {
    ...base,
    ytRuns: Array.isArray(raw.runs) ? (raw.runs as unknown[]) : [],
    superChat: !!raw.superChat,
    color: raw.superChat ? '#ffd600' : null,
  };
}

/** Token bucket per klíč; capacity tokenů, refill tokenů/s. Ochrana proti scroll-spamu, ne proti útoku. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly capacity: number,
    private readonly perSec: number,
    private readonly now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.perSec);
    b.at = t;
    if (b.tokens < 1) { this.buckets.set(key, b); return false; }
    b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 5000) this.buckets.clear();
    return true;
  }
}

export default async function chatRoutes(app: FastifyInstance) {
  const limiter = new RateLimiter(10, 10);

  app.get<{ Querystring: { channel?: string; limit?: string; before?: string } }>('/chat/history', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!limiter.allow(req.ip)) { reply.code(429); return { ok: false, error: 'too many requests' }; }

    const channel = (req.query.channel || '').trim().toLowerCase();
    if (!/^[a-z0-9_]{1,40}$/.test(channel)) { reply.code(400); return { ok: false, error: 'channel' }; }
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '100', 10) || 100));
    const cursor = req.query.before ? decodeCursor(req.query.before) : null;
    if (req.query.before && !cursor) { reply.code(400); return { ok: false, error: 'before' }; }

    // Kanál je Twitch login; YouTube/Kick jména podle streamers directory.
    // Když mapování chybí, vrací se jen zprávy uložené pod stejným jménem.
    const dir = await db
      .select({ yt: streamers.youtubeHandle, kick: streamers.kickSlug })
      .from(streamers)
      .where(eq(streamers.twitchLogin, channel))
      .limit(1);
    const channels = [...new Set([channel, dir[0]?.yt?.toLowerCase(), dir[0]?.kick?.toLowerCase()].filter((c): c is string => !!c))];

    const conds = [inArray(messages.channel, channels)];
    if (cursor) {
      const at = new Date(cursor.sentAtMs);
      conds.push(or(lt(messages.sentAt, at), and(eq(messages.sentAt, at), lt(messages.id, cursor.id)))!);
    }
    const rows = await db
      .select()
      .from(messages)
      .where(and(...conds))
      .orderBy(desc(messages.sentAt), desc(messages.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const oldest = page[page.length - 1];
    return {
      ok: true,
      messages: page.reverse().map(toClientMessage),
      nextBefore: hasMore && oldest ? encodeCursor(oldest.sentAt.getTime(), oldest.id) : null,
    };
  });
}
