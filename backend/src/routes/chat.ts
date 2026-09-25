import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
import { db } from '../db/index.js';
import { messages, streamers, type Message } from '../db/schema.js';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';
import { subscribeChatStream, chatStreamClientsForIp } from '../sse/chatBus.js';
import { ucSends, markUc, ucReplies, attachUcReply, parseUcReply } from '../lib/ucSends.js';

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
  /** platform + uc: odpověď napříč platformami nahlášená UnityChatem (content_raw.ucReply). */
  replyTo?: { username: string; message: string; id: string; platform?: string; uc?: boolean; authorUc?: boolean } | null;
  kickContent?: string;
  ytRuns?: unknown[];
  superChat?: boolean;
  /** true = z /chat/history (DB), false = živě z /chat/stream (ingest, před zápisem). */
  historical: boolean;
  /** Odesláno z UnityChatu bez markeru (command) — server to ví z hlášení odeslání (lib/ucSends.ts). */
  uc?: boolean;
  /** Smazáno modem/platformou/link filtrem (lib/messageDeletes.ts) — obsah pod tímto se nikdy neposílá. */
  deleted?: boolean;
  deletedReason?: string | null;
  /** „Jen UC skrýt“ (lib/messageHides.ts) — na platformě zpráva zůstává, UC ji nevykreslí; obsah se neposílá. */
  hidden?: boolean;
  segments?: unknown[];
}

/**
 * Pole, která mapování potřebuje — DB řádek (Message) i čerstvý řádek z ingestu (toRow) je mají.
 * deletedAt/deletedReason jsou tu volitelné: živé zprávy z ingestu nikdy nejsou smazané v okamžiku
 * emitu (viz server.ts onLive), takže NewMessage je vůbec nenese.
 */
export type ClientRow = Pick<Message, 'platform' | 'platformMessageId' | 'platformUserId' | 'platformUsername' | 'content' | 'sentAt'> & {
  contentRaw?: unknown;
  isReply?: boolean | null;
  replyToMessageId?: string | null;
  isUnitychatUser?: boolean | null;
  deletedAt?: Date | null;
  deletedReason?: string | null;
  hiddenAt?: Date | null;
};

/** Řádek z DB (nebo z ingestu) → tvar, který panel dostává od providerů (renderer má jednu cestu). */
export function toClientMessage(row: ClientRow, historical = true): ClientMessage {
  // Smazaná / skrytá zpráva: text, emoty i reply-to zůstávají jen v DB (audit) — klient nikdy nedostane obsah.
  const meta = {
    platform: row.platform,
    id: row.platformMessageId,
    username: row.platformUsername,
    userId: row.platformUserId,
    message: '',
    timestamp: row.sentAt.getTime(),
    historical,
  };
  if (row.deletedAt) return { ...meta, deleted: true, deletedReason: row.deletedReason };
  if (row.hiddenAt) return { ...meta, hidden: true, segments: [] };
  const out = toClientMessageBase(row, historical);
  // Odpověď napříč platformami (UnityChat) — jen když platforma sama odpověď nenese.
  const ur = ((row.contentRaw || {}) as Record<string, unknown>).ucReply as Record<string, unknown> | undefined;
  if (ur && ur.id && !out.replyTo) {
    out.replyTo = { username: String(ur.username || ''), message: String(ur.message || ''), id: String(ur.id), platform: String(ur.platform || ''), uc: true, ...(ur.authorUc ? { authorUc: true } : {}) };
  }
  return out;
}

function toClientMessageBase(row: ClientRow, historical: boolean): ClientMessage {
  const raw = (row.contentRaw || {}) as Record<string, unknown>;
  const base = {
    platform: row.platform,
    id: row.platformMessageId,
    username: row.platformUsername,
    userId: row.platformUserId,
    message: row.content,
    timestamp: row.sentAt.getTime(),
    historical,
    ...(row.isUnitychatUser ? { uc: true } : {}),
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

const CHANNEL_RE = /^[a-z0-9_]{1,40}$/;
const PLATFORMS = ['twitch', 'kick', 'youtube'] as const;
const MAX_STREAMS_PER_IP = 10; // domácnost za NAT, víc tabů

/**
 * Kanál je Twitch login; YouTube/Kick jména podle streamers directory.
 * Když mapování chybí, vrací se jen jméno samotné (zprávy uložené pod ním).
 */
export async function resolveChannels(channel: string): Promise<string[]> {
  const dir = await db
    .select({ yt: streamers.youtubeHandle, kick: streamers.kickSlug })
    .from(streamers)
    .where(eq(streamers.twitchLogin, channel))
    .limit(1);
  return [...new Set([channel, dir[0]?.yt?.toLowerCase(), dir[0]?.kick?.toLowerCase()].filter((c): c is string => !!c))];
}

/**
 * Kanál zprávy v ingestu pro danou platformu (YouTube handle / Kick slug podle streamers directory).
 * Zdroj: adresář `streamers` (fallback UC kanál). Moderace používá lib/platformChannels `registryPlatformChannel` (registr Židolišty).
 */
export async function platformChannel(platform: string, channel: string): Promise<string> {
  if (platform === 'twitch') return channel;
  const dir = await db.select({ yt: streamers.youtubeHandle, kick: streamers.kickSlug }).from(streamers).where(eq(streamers.twitchLogin, channel)).limit(1);
  return ((platform === 'youtube' ? dir[0]?.yt : dir[0]?.kick) || channel).toLowerCase();
}

export default async function chatRoutes(app: FastifyInstance) {
  const limiter = new RateLimiter(10, 10);
  const ucLimiter = new RateLimiter(5, 1);

  /**
   * POST /chat/uc-sent {platform, channel, username, text} — addon po odeslání commandu
   * (`!…`, bez markeru) nahlásí, že ho poslal z UnityChatu; ingest pak zprávu označí
   * (lib/ucSends.ts) a klienti dostanou SSE `uc-mark` → zlaté logo. Jen commandy.
   */
  app.post<{ Body: { platform?: string; channel?: string; username?: string; text?: string; replyTo?: unknown } }>('/chat/uc-sent', async (req, reply) => {
    if (!ucLimiter.allow(req.ip)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const platform = String(req.body?.platform || '');
    const channel = String(req.body?.channel || '').toLowerCase().replace(/^@/, '');
    const username = String(req.body?.username || '').slice(0, 60);
    const text = String(req.body?.text || '').slice(0, 500);
    // Odpověď napříč platformami (záložní odesílání přes kartu): i zpráva, která není command.
    const ucReply = parseUcReply(req.body?.replyTo);
    const isCmd = text.trim().startsWith('!');
    if (!(PLATFORMS as readonly string[]).includes(platform) || !CHANNEL_RE.test(channel) || !username || (!isCmd && !ucReply)) {
      return reply.code(400).send({ ok: false, error: 'bad_request' });
    }
    const ch = await platformChannel(platform, channel);
    let hit = null;
    if (isCmd) {
      hit = ucSends.report({ platform, channel: ch, username, text });
      if (hit) markUc(hit, app.log, { late: true });
    }
    if (ucReply) {
      const rh = ucReplies.report({ platform, channel: ch, username, text, data: ucReply });
      if (rh) attachUcReply(rh, ucReply, app.log, { late: true });
      hit = hit || rh;
    }
    return { ok: true, matched: !!hit };
  });

  // Živé zprávy z ingestu (spec web verze §3.3): SSE, event `message` = stejný
  // tvar jako /chat/history s historical:false; `hello` po připojení;
  // keepalive komentář každých 15 s. Bez replay — klient po reconnectu
  // dorovná přes /chat/history.
  app.get<{ Querystring: { channel?: string; platforms?: string } }>('/chat/stream', async (req, reply) => {
    const channel = (req.query.channel || '').trim().toLowerCase();
    if (!CHANNEL_RE.test(channel)) { reply.code(400); return { ok: false, error: 'channel' }; }
    const wanted = (req.query.platforms || PLATFORMS.join(','))
      .split(',').map((p) => p.trim().toLowerCase()).filter((p): p is typeof PLATFORMS[number] => (PLATFORMS as readonly string[]).includes(p));
    if (!wanted.length) { reply.code(400); return { ok: false, error: 'platforms' }; }
    if (chatStreamClientsForIp(req.ip) >= MAX_STREAMS_PER_IP) { reply.code(429); return { ok: false, error: 'too many streams' }; }

    const channels = await resolveChannels(channel);

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    const unsubscribe = subscribeChatStream(reply, { ip: req.ip, channels, platforms: wanted });
    req.raw.on('close', unsubscribe);
    return undefined; // hijacknuto — odpověď drží SSE, Fastify nic neposílá
  });

  app.get<{ Querystring: { channel?: string; limit?: string; before?: string } }>('/chat/history', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!limiter.allow(req.ip)) { reply.code(429); return { ok: false, error: 'too many requests' }; }

    const channel = (req.query.channel || '').trim().toLowerCase();
    if (!CHANNEL_RE.test(channel)) { reply.code(400); return { ok: false, error: 'channel' }; }
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '100', 10) || 100));
    const cursor = req.query.before ? decodeCursor(req.query.before) : null;
    if (req.query.before && !cursor) { reply.code(400); return { ok: false, error: 'before' }; }

    const channels = await resolveChannels(channel);

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
      messages: page.reverse().map((r) => toClientMessage(r)),
      nextBefore: hasMore && oldest ? encodeCursor(oldest.sentAt.getTime(), oldest.id) : null,
    };
  });
}
