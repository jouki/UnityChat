import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { nicknames, seenUsers } from '../db/schema.js';

const SeenBody = z.object({
  platform: z.enum(['twitch', 'youtube', 'kick']),
  username: z.string().min(1).max(50).transform((s) => s.trim().replace(/^@/, '').toLowerCase()),
});

export default async function userRoutes(app: FastifyInstance) {
  // Register a seen user — insert if new, ignore if exists
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
      .onConflictDoNothing();

    return { ok: true };
  });

  // Get all unique users (from seen_users + nicknames)
  app.get('/users', async (_req, reply) => {
    // Merge both sources for complete picture
    const [seen, nicks] = await Promise.all([
      db.select({
        platform: seenUsers.platform,
        username: seenUsers.username,
        firstSeenAt: seenUsers.firstSeenAt,
      }).from(seenUsers),
      db.select({
        platform: nicknames.platform,
        username: nicknames.username,
        nickname: nicknames.nickname,
        color: nicknames.color,
      }).from(nicknames),
    ]);

    // Build nickname lookup
    const nickLookup = new Map<string, { nickname: string; color: string | null }>();
    for (const n of nicks) {
      nickLookup.set(`${n.platform}:${n.username}`, { nickname: n.nickname, color: n.color });
    }

    // Group by username
    const byUser = new Map<string, {
      nickname: string | null;
      color: string | null;
      platforms: string[];
      firstSeen: string | null;
    }>();

    // Add all seen users
    for (const row of seen) {
      const existing = byUser.get(row.username);
      const nick = nickLookup.get(`${row.platform}:${row.username}`);
      if (existing) {
        if (!existing.platforms.includes(row.platform)) existing.platforms.push(row.platform);
        if (nick?.nickname && !existing.nickname) existing.nickname = nick.nickname;
        if (nick?.color && !existing.color) existing.color = nick.color;
        if (row.firstSeenAt.toISOString() < (existing.firstSeen || '')) {
          existing.firstSeen = row.firstSeenAt.toISOString();
        }
      } else {
        byUser.set(row.username, {
          nickname: nick?.nickname || null,
          color: nick?.color || null,
          platforms: [row.platform],
          firstSeen: row.firstSeenAt.toISOString(),
        });
      }
    }

    // Add nickname-only users (who saved nickname but weren't in seen_users)
    for (const n of nicks) {
      if (!byUser.has(n.username)) {
        const existing = byUser.get(n.username);
        if (existing) {
          if (!existing.platforms.includes(n.platform)) existing.platforms.push(n.platform);
        } else {
          byUser.set(n.username, {
            nickname: n.nickname,
            color: n.color,
            platforms: [n.platform],
            firstSeen: null,
          });
        }
      } else {
        const existing = byUser.get(n.username)!;
        if (!existing.platforms.includes(n.platform)) existing.platforms.push(n.platform);
        if (!existing.nickname) existing.nickname = n.nickname;
        if (!existing.color) existing.color = n.color;
      }
    }

    reply.header('Cache-Control', 'no-cache');
    return {
      uniqueUsers: byUser.size,
      users: Object.fromEntries(byUser),
    };
  });
}
