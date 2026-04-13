import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { seenUsers } from '../db/schema.js';

const SeenBody = z.object({
  platform: z.enum(['twitch', 'youtube', 'kick']),
  username: z.string().min(1).max(50).transform((s) => s.trim().replace(/^@/, '').toLowerCase()),
});

export default async function userRoutes(app: FastifyInstance) {
  // Record a seen user (upsert: increment count + update last_seen)
  app.post('/users/seen', async (req, reply) => {
    const parsed = SeenBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: 'Invalid body' };
    }

    const { platform, username } = parsed.data;

    await db
      .insert(seenUsers)
      .values({ platform, username })
      .onConflictDoUpdate({
        target: [seenUsers.platform, seenUsers.username],
        set: {
          lastSeenAt: sql`now()`,
          seenCount: sql`${seenUsers.seenCount} + 1`,
        },
      });

    return { ok: true };
  });

  // Get all seen users
  app.get('/users', async (_req, reply) => {
    const rows = await db
      .select({
        platform: seenUsers.platform,
        username: seenUsers.username,
        firstSeenAt: seenUsers.firstSeenAt,
        lastSeenAt: seenUsers.lastSeenAt,
        seenCount: seenUsers.seenCount,
      })
      .from(seenUsers);

    // Group by username across platforms
    const byUser = new Map<string, { platforms: Record<string, { firstSeen: string; lastSeen: string; count: number }>}>();
    for (const row of rows) {
      const key = row.username;
      if (!byUser.has(key)) byUser.set(key, { platforms: {} });
      byUser.get(key)!.platforms[row.platform] = {
        firstSeen: row.firstSeenAt.toISOString(),
        lastSeen: row.lastSeenAt.toISOString(),
        count: row.seenCount,
      };
    }

    reply.header('Cache-Control', 'no-cache');
    return {
      uniqueUsers: byUser.size,
      totalRecords: rows.length,
      users: Object.fromEntries(byUser),
    };
  });
}
