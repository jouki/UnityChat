import type { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { nicknames } from '../db/schema.js';

export default async function userRoutes(app: FastifyInstance) {
  // Derive unique UnityChat users from nicknames table
  // Anyone who saved a nickname/color is a confirmed UC user
  app.get('/users', async (_req, reply) => {
    const rows = await db
      .select({
        platform: nicknames.platform,
        username: nicknames.username,
        nickname: nicknames.nickname,
        color: nicknames.color,
        updatedAt: nicknames.updatedAt,
      })
      .from(nicknames);

    // Group by username across platforms
    const byUser = new Map<string, {
      nickname: string;
      color: string | null;
      platforms: string[];
      lastSeen: string;
    }>();

    for (const row of rows) {
      const existing = byUser.get(row.username);
      if (existing) {
        if (!existing.platforms.includes(row.platform)) {
          existing.platforms.push(row.platform);
        }
        if (row.updatedAt.toISOString() > existing.lastSeen) {
          existing.lastSeen = row.updatedAt.toISOString();
          existing.nickname = row.nickname;
          if (row.color) existing.color = row.color;
        }
      } else {
        byUser.set(row.username, {
          nickname: row.nickname,
          color: row.color,
          platforms: [row.platform],
          lastSeen: row.updatedAt.toISOString(),
        });
      }
    }

    reply.header('Cache-Control', 'no-cache');
    return {
      uniqueUsers: byUser.size,
      users: Object.fromEntries(byUser),
    };
  });
}
