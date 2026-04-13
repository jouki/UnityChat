import type { FastifyInstance } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { nicknames } from '../db/schema.js';
import { addClient, broadcast, replaySince } from '../sse/bus.js';
import { config } from '../config.js';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const PutBody = z.object({
  platform: z.enum(['twitch', 'youtube', 'kick']),
  username: z.string().min(1).max(50).transform((s) => s.trim().replace(/^@/, '').toLowerCase()),
  nickname: z.string().min(1).max(30).transform((s) => s.trim()),
  color: z.string().regex(HEX_COLOR).nullable().optional(),
});

export default async function nicknameRoutes(app: FastifyInstance) {
  // Bulk fetch all nicknames
  app.get('/nicknames', async (_req, reply) => {
    const rows = await db
      .select({
        platform: nicknames.platform,
        username: nicknames.username,
        nickname: nicknames.nickname,
        color: nicknames.color,
      })
      .from(nicknames);

    reply.header('Cache-Control', 'public, max-age=30');
    return { nicknames: rows };
  });

  // Set/update nickname (rate-limited per user: 1 change per 5 min)
  app.put('/nicknames', async (req, reply) => {
    const parsed = PutBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: 'Invalid body', details: parsed.error.flatten() };
    }

    const { platform, username, nickname, color } = parsed.data;
    const rateLimitSecs = config.NICKNAME_RATE_LIMIT_SECS;

    // Check rate limit via updated_at
    const existing = await db
      .select({ updatedAt: nicknames.updatedAt })
      .from(nicknames)
      .where(and(eq(nicknames.platform, platform), eq(nicknames.username, username)))
      .limit(1);

    if (existing.length > 0) {
      const elapsed = (Date.now() - existing[0].updatedAt.getTime()) / 1000;
      if (elapsed < rateLimitSecs) {
        const retryAfter = Math.ceil(rateLimitSecs - elapsed);
        reply.code(429).header('Retry-After', String(retryAfter));
        return { ok: false, error: 'Rate limited', retryAfter };
      }
    }

    // Upsert
    const colorValue = color ?? null;
    await db
      .insert(nicknames)
      .values({ platform, username, nickname, color: colorValue })
      .onConflictDoUpdate({
        target: [nicknames.platform, nicknames.username],
        set: { nickname, color: colorValue, updatedAt: sql`NOW()` },
      });

    // Broadcast to all SSE clients
    broadcast('nickname-change', { platform, username, nickname, color: colorValue });

    return { ok: true };
  });

  // Delete nickname
  app.delete('/nicknames', async (req, reply) => {
    const parsed = z.object({
      platform: z.enum(['twitch', 'youtube', 'kick']),
      username: z.string().min(1).max(50).transform((s) => s.trim().replace(/^@/, '').toLowerCase()),
    }).safeParse(req.body);

    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: 'Missing platform or username' };
    }

    const { platform, username } = parsed.data;
    await db
      .delete(nicknames)
      .where(and(eq(nicknames.platform, platform), eq(nicknames.username, username)));

    broadcast('nickname-delete', { platform, username });
    return { ok: true };
  });

  // SSE stream
  app.get('/nicknames/stream', async (req, reply) => {
    reply.hijack();

    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no', // disable nginx buffering
    });

    // Replay missed events if reconnecting
    const lastId = req.headers['last-event-id'];
    if (lastId) {
      const parsed = parseInt(lastId as string, 10);
      if (!isNaN(parsed)) {
        replaySince(parsed, reply);
      }
    }

    // Initial comment to confirm connection
    raw.write(': connected\n\n');

    // Register client
    const removeClient = addClient(reply);

    // Cleanup on disconnect
    req.raw.on('close', () => {
      removeClient();
    });
  });
}
