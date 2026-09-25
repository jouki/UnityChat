// Chat Log pro dashboard Židolišty (Logy → Chat Log): čtení a hledání v celém archivu zpráv
// (ingest, messages). Moderační akce jsou zvlášť (integrační moderace, routes/moderation*).
// Auth jako ostatní /integrations/*: X-Api-Key + HMAC podpis (lib/inboundAuth.ts, strict).
//
//   GET /integrations/:slug/chat-log?q=&user=&userId=&platform=&before=&limit=   zprávy od nejnovějších
//   GET /integrations/:slug/chat-log/users?q=                                     našeptávač jmen
//   GET /integrations/:slug/chat-log/context?platform=&messageId=&around=         zprávy kolem jedné
//
// Kanály workspace jsou per platforma jiné (Twitch login, Kick slug, YouTube handle) → filtr
// na dvojice (platform, channel) z registru Židolišty. Fulltext: ILIKE + trigramový index.
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gt, lt, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/index.js';
import { messages } from '../db/schema.js';
import { inboundAuthorized } from '../lib/inboundAuth.js';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';
import { workspaceBySlug, type Platform } from '../lib/zidolista.js';
import { rolesFromBadges } from '../sse/integrationStream.js';
import { highestRole } from '../lib/chatRole.js';

const PLATFORMS: Platform[] = ['twitch', 'kick', 'youtube'];
const MAX_LIMIT = 200;

/** ILIKE vzor z uživatelského textu: % a _ doslovně. */
export function likePattern(q: string, { prefix = false } = {}): string {
  const esc = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  return prefix ? `${esc}%` : `%${esc}%`;
}

// Bez diakritiky a velikosti písmen: uc_fold() = lower(unaccent()) + trigramový index (sql/2026-09-25-chat-log-search.sql).
const folded = (col: unknown, pattern: string) => sql`uc_fold(${col}) LIKE uc_fold(${pattern})`;

export function clampLimit(v: unknown, dflt = 100): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_LIMIT) : dflt;
}

type Row = { id: number; platform: string; platformMessageId: string; platformUserId: string; platformUsername: string; content: string; contentRaw: unknown; channel: string; sentAt: Date; isReply: boolean; replyToMessageId: string | null; isUnitychatUser: boolean };

/** Řádek → tvar pro dashboard (role z badge, text, odpověď). */
export function toLogMessage(r: Row) {
  const raw = (r.contentRaw && typeof r.contentRaw === 'object' ? r.contentRaw : {}) as Record<string, unknown>;
  const roles = rolesFromBadges(r.platform as Platform, raw.badges, r.platformUsername, r.channel);
  return {
    platform: r.platform,
    channel: r.channel,
    messageId: r.platformMessageId,
    user: r.platformUsername,      // zobrazované jméno (jak ho ingest uložil)
    login: String(raw.login ?? raw.senderSlug ?? r.platformUsername).toLowerCase(),
    userId: r.platformUserId,
    role: highestRole(roles),
    text: r.content,
    sentAt: r.sentAt.toISOString(),
    replyTo: r.isReply ? { messageId: r.replyToMessageId, user: (raw.replyParentUsername ?? raw.replyParentDisplayName ?? null) as string | null } : null,
    viaUnityChat: r.isUnitychatUser,
    cursor: encodeCursor(r.sentAt.getTime(), r.id),
  };
}

const cols = {
  id: messages.id, platform: messages.platform, platformMessageId: messages.platformMessageId, platformUserId: messages.platformUserId,
  platformUsername: messages.platformUsername, content: messages.content, contentRaw: messages.contentRaw, channel: messages.channel,
  sentAt: messages.sentAt, isReply: messages.isReply, replyToMessageId: messages.replyToMessageId, isUnitychatUser: messages.isUnitychatUser,
};

/** Podmínka „zprávy kanálu workspace“ (jen platformy, které workspace má), volitelně jedna platforma. */
async function channelScope(slug: string, platform?: string): Promise<SQL | null> {
  const ws = await workspaceBySlug(slug);
  if (!ws) return null;
  const pairs = PLATFORMS.filter((p) => ws.channels[p] && (!platform || p === platform))
    .map((p) => and(eq(messages.platform, p), eq(messages.channel, String(ws.channels[p]).toLowerCase()))!);
  if (!pairs.length) return sql`false`;
  return pairs.length === 1 ? pairs[0] : or(...pairs)!;
}

export default async function chatLogRoutes(app: FastifyInstance) {
  app.get<{ Params: { slug: string }; Querystring: Record<string, string | undefined> }>('/integrations/:slug/chat-log', async (req, reply) => {
    if (!inboundAuthorized(req, reply)) return reply;
    const qs = req.query;
    const platform = PLATFORMS.includes(qs.platform as Platform) ? qs.platform : undefined;
    const scope = await channelScope(req.params.slug, platform);
    if (!scope) return reply.code(404).send({ ok: false, error: 'workspace_not_found' });
    const where: SQL[] = [scope];
    const q = String(qs.q ?? '').trim().slice(0, 200);
    if (q) where.push(folded(messages.content, likePattern(q)));
    // Uživatel přesně podle zobrazovaného jména nebo loginu (Twitch login, Kick slug), bez ohledu na velikost.
    const user = String(qs.user ?? '').trim().replace(/^@/, '').slice(0, 60);
    if (user) {
      const u = user.toLowerCase();
      where.push(or(sql`lower(${messages.platformUsername}) = ${u}`, sql`lower(${messages.contentRaw}->>'login') = ${u}`, sql`lower(${messages.contentRaw}->>'senderSlug') = ${u}`)!);
    }
    const userId = String(qs.userId ?? '').trim().slice(0, 80);
    if (userId) where.push(eq(messages.platformUserId, userId));
    const cur = qs.before ? decodeCursor(qs.before) : null;
    if (cur) where.push(or(lt(messages.sentAt, new Date(cur.sentAtMs)), and(eq(messages.sentAt, new Date(cur.sentAtMs)), lt(messages.id, cur.id)))!);
    const limit = clampLimit(qs.limit);
    const rows = await db.select(cols).from(messages).where(and(...where)).orderBy(desc(messages.sentAt), desc(messages.id)).limit(limit + 1);
    const page = rows.slice(0, limit).map((r) => toLogMessage(r as Row));
    reply.header('Cache-Control', 'no-store');
    return { ok: true, messages: page, nextBefore: rows.length > limit ? page[page.length - 1].cursor : null };
  });

  app.get<{ Params: { slug: string }; Querystring: { q?: string } }>('/integrations/:slug/chat-log/users', async (req, reply) => {
    if (!inboundAuthorized(req, reply)) return reply;
    const scope = await channelScope(req.params.slug);
    if (!scope) return reply.code(404).send({ ok: false, error: 'workspace_not_found' });
    const q = String(req.query.q ?? '').trim().replace(/^@/, '').slice(0, 60);
    if (!q) return { ok: true, users: [] };
    const rows = await db.select({
      platform: messages.platform, user: messages.platformUsername, userId: messages.platformUserId,
      count: sql<number>`count(*)::int`, lastAt: sql<Date>`max(${messages.sentAt})`,
    }).from(messages).where(and(scope, folded(messages.platformUsername, likePattern(q, { prefix: true }))))
      .groupBy(messages.platform, messages.platformUsername, messages.platformUserId)
      .orderBy(sql`count(*) desc`).limit(20);
    return { ok: true, users: rows.map((r) => ({ ...r, lastAt: new Date(r.lastAt).toISOString() })) };
  });

  app.get<{ Params: { slug: string }; Querystring: { platform?: string; messageId?: string; around?: string } }>('/integrations/:slug/chat-log/context', async (req, reply) => {
    if (!inboundAuthorized(req, reply)) return reply;
    const platform = PLATFORMS.includes(req.query.platform as Platform) ? req.query.platform! : null;
    const messageId = String(req.query.messageId ?? '').slice(0, 200);
    if (!platform || !messageId) return reply.code(400).send({ ok: false, error: 'bad_request' });
    const scope = await channelScope(req.params.slug);
    if (!scope) return reply.code(404).send({ ok: false, error: 'workspace_not_found' });
    const [target] = await db.select(cols).from(messages).where(and(scope, eq(messages.platform, platform), eq(messages.platformMessageId, messageId))).limit(1);
    if (!target) return reply.code(404).send({ ok: false, error: 'not_found' });
    const n = Math.min(clampLimit(req.query.around, 20), 50);
    // Kolem zprávy v celém kanálu workspace (všechny platformy), ať je vidět konverzace.
    const [before, after] = await Promise.all([
      db.select(cols).from(messages).where(and(scope, or(lt(messages.sentAt, target.sentAt), and(eq(messages.sentAt, target.sentAt), lt(messages.id, target.id))))).orderBy(desc(messages.sentAt), desc(messages.id)).limit(n),
      db.select(cols).from(messages).where(and(scope, or(gt(messages.sentAt, target.sentAt), and(eq(messages.sentAt, target.sentAt), gt(messages.id, target.id))))).orderBy(messages.sentAt, messages.id).limit(n),
    ]);
    const list = [...before.reverse(), target, ...after].map((r) => toLogMessage(r as Row));
    return { ok: true, target: toLogMessage(target as Row).cursor, messages: list };
  });
}
