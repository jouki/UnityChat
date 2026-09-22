// Reakce v chatu (2026-09-22): mod/broadcaster spustí na zprávě animaci „Peepo poop",
// kterou přehrají všichni klienti (addon i web) přes SSE `reaction` na /nicknames/stream.
//
//   POST /reactions { kind: 'poop', platform, messageId, channel? }   (Bearer web session)
//   GET  /reactions/active?channel=                                    (stav pro tlačítko po startu)
//
// Kdo smí: přihlášený účet, jehož některá identita je broadcaster kanálu, nebo má
// v serverovém logu zpráv (posledních 24 h v kanálu) badge moderator/broadcaster.
// Zámek per kanál: dokud animace běží, další pokusy dostanou 409 `busy`.
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gt, ilike } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { messages } from '../db/schema.js';
import { requireWebSession, listIdentities } from '../lib/webAuth.js';
import { broadcast } from '../sse/bus.js';
import { rolesFromBadges } from '../sse/integrationStream.js';
import { RateLimiter } from './chat.js';
import { config } from '../config.js';

const DURATION_MS = 15_000;
const LOCK_MS = DURATION_MS + 1500;   // video + odtmívání

const Body = z.object({
  kind: z.literal('poop'),
  platform: z.enum(['twitch', 'kick', 'youtube']),
  messageId: z.string().min(1).max(200),
  channel: z.string().regex(/^[a-z0-9_]{1,40}$/i).optional(),
});

export interface ReactionEvent {
  id: string;
  kind: 'poop';
  channel: string;
  target: { platform: string; messageId: string; username: string | null };
  by: { platform: string; login: string };
  startedAt: string;
  durationMs: number;
}

const active = new Map<string, ReactionEvent>();

export function activeReaction(channel: string, now = Date.now()): ReactionEvent | null {
  const ev = active.get(channel);
  if (!ev) return null;
  if (now - Date.parse(ev.startedAt) >= LOCK_MS) { active.delete(channel); return null; }
  return ev;
}

/** Je login v kanálu mod/broadcaster? Broadcaster = login kanálu; jinak badge z posledních zpráv. */
export async function isModOrBroadcaster(platform: 'twitch' | 'kick' | 'youtube', login: string, channel: string): Promise<boolean> {
  const l = login.toLowerCase();
  // Broadcaster: login/slug/handle shodný s kanálem (u Roba i Joukiho je stejný na všech platformách).
  if (l === channel.toLowerCase()) return true;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ raw: messages.contentRaw, username: messages.platformUsername })
    .from(messages)
    .where(and(eq(messages.channel, channel.toLowerCase()), eq(messages.platform, platform), ilike(messages.platformUsername, l), gt(messages.sentAt, since)))
    .orderBy(desc(messages.sentAt))
    .limit(5);
  for (const r of rows) {
    const roles = rolesFromBadges(platform, (r.raw as Record<string, unknown> | null)?.badges, r.username, channel);
    if (roles.isMod || roles.isBroadcaster) return true;
  }
  return false;
}

export default async function reactionRoutes(app: FastifyInstance) {
  const limiter = new RateLimiter(5, 0.5);
  const DEFAULT_CHANNEL = (config.CHAT_INGEST_CHANNELS.split(',').find((c) => c.startsWith('twitch:'))?.split(':')[1] || 'robdiesalot').toLowerCase();

  app.get<{ Querystring: { channel?: string } }>('/reactions/active', async (req, reply) => {
    const channel = String(req.query.channel || DEFAULT_CHANNEL).toLowerCase();
    reply.header('Cache-Control', 'no-store');
    return { ok: true, channel, active: activeReaction(channel) };
  });

  app.post<{ Body: z.infer<typeof Body> }>('/reactions', { preHandler: requireWebSession }, async (req, reply) => {
    const body = Body.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: 'body' });
    const accountId = req.webAccountId!;
    if (!limiter.allow(String(accountId))) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const channel = (body.data.channel || DEFAULT_CHANNEL).toLowerCase();

    const ids = await listIdentities(accountId);
    let by: { platform: string; login: string } | null = null;
    for (const i of ids) {
      if (await isModOrBroadcaster(i.platform, i.login, channel)) { by = { platform: i.platform, login: i.login }; break; }
    }
    if (!by) { req.log.info({ accountId, channel, identities: ids.map((i) => `${i.platform}:${i.login}`) }, 'reaction: not a mod'); return reply.code(403).send({ ok: false, error: 'not_mod' }); }

    const running = activeReaction(channel);
    if (running) return reply.code(409).send({ ok: false, error: 'busy', active: running });

    // Jméno autora cílové zprávy (jen pro log / klienty), když ji server log má.
    const target = await db
      .select({ username: messages.platformUsername })
      .from(messages)
      .where(and(eq(messages.platform, body.data.platform), eq(messages.platformMessageId, body.data.messageId)))
      .limit(1);

    const ev: ReactionEvent = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'poop',
      channel,
      target: { platform: body.data.platform, messageId: body.data.messageId, username: target[0]?.username ?? null },
      by,
      startedAt: new Date().toISOString(),
      durationMs: DURATION_MS,
    };
    active.set(channel, ev);
    broadcast('reaction', ev);
    req.log.info({ channel, by, target: ev.target }, 'reaction: poop');
    return reply.code(202).send({ ok: true, reaction: ev });
  });
}
