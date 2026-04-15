import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { streamers, streamerTokens } from '../db/schema.js';
import { requireExtensionOrigin } from '../lib/extensionOrigin.js';
import { resolvePlatformHandle, type Platform } from '../lib/platformApi.js';
import { requireSession } from '../lib/sessionAuth.js';
import { deleteSession } from '../lib/session.js';

const LookupQuery = z.object({
  platform: z.enum(['twitch', 'youtube', 'kick']),
  handle: z.string().min(1).max(100).transform((s) => s.trim().replace(/^@/, '').toLowerCase()),
});

const SeenBody = z.object({
  platform: z.enum(['twitch', 'youtube', 'kick']),
  handle: z.string().min(1).max(100).transform((s) => s.trim().replace(/^@/, '').toLowerCase()),
});

// Columns in streamers table that are safe to return via public API.
// Explicit whitelist — never accidentally include encrypted token fields
// (they live in streamer_tokens, but defense in depth).
function publicFields() {
  return {
    id: streamers.id,
    twitchLogin: streamers.twitchLogin,
    twitchUserId: streamers.twitchUserId,
    twitchDisplayName: streamers.twitchDisplayName,
    twitchAvatarUrl: streamers.twitchAvatarUrl,
    youtubeHandle: streamers.youtubeHandle,
    youtubeChannelId: streamers.youtubeChannelId,
    youtubeTitle: streamers.youtubeTitle,
    youtubeAvatarUrl: streamers.youtubeAvatarUrl,
    kickSlug: streamers.kickSlug,
    kickUserId: streamers.kickUserId,
    kickDisplayName: streamers.kickDisplayName,
    kickAvatarUrl: streamers.kickAvatarUrl,
    verified: streamers.verified,
  };
}

function handleColumn(platform: Platform) {
  if (platform === 'twitch') return streamers.twitchLogin;
  if (platform === 'youtube') return streamers.youtubeHandle;
  return streamers.kickSlug;
}

function userIdColumn(platform: Platform) {
  if (platform === 'twitch') return streamers.twitchUserId;
  if (platform === 'youtube') return streamers.youtubeChannelId;
  return streamers.kickUserId;
}

export default async function streamerRoutes(app: FastifyInstance) {
  // Extension-origin guard for everything in this route file.
  app.addHook('preHandler', requireExtensionOrigin);

  // Public lookup — returns only safe fields. Never tokens.
  app.get('/streamers/lookup', async (req, reply) => {
    const parsed = LookupQuery.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: 'Invalid query' };
    }
    const { platform, handle } = parsed.data;

    const handleCol = handleColumn(platform);
    const hit = await db.select(publicFields()).from(streamers).where(eq(handleCol, handle)).limit(1);

    if (hit.length > 0) {
      return { ok: true, found: true, streamer: hit[0] };
    }

    // Miss — try to self-heal: resolve handle → user_id, see if we know that user_id
    // under a different handle (rename detection).
    const resolved = await resolvePlatformHandle(platform, handle);
    if (resolved) {
      const userIdCol = userIdColumn(platform);
      const byUserId = await db
        .select(publicFields())
        .from(streamers)
        .where(eq(userIdCol, resolved.userId))
        .limit(1);

      if (byUserId.length > 0) {
        // Rename detected — update handle (+ display_name/avatar if newer data).
        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (platform === 'twitch') {
          updates.twitchLogin = resolved.handleCanonical;
          if (resolved.displayName) updates.twitchDisplayName = resolved.displayName;
          if (resolved.avatarUrl) updates.twitchAvatarUrl = resolved.avatarUrl;
        } else if (platform === 'youtube') {
          updates.youtubeHandle = resolved.handleCanonical;
          if (resolved.displayName) updates.youtubeTitle = resolved.displayName;
          if (resolved.avatarUrl) updates.youtubeAvatarUrl = resolved.avatarUrl;
        } else {
          updates.kickSlug = resolved.handleCanonical;
          if (resolved.displayName) updates.kickDisplayName = resolved.displayName;
          if (resolved.avatarUrl) updates.kickAvatarUrl = resolved.avatarUrl;
        }
        await db.update(streamers).set(updates).where(eq(streamers.id, byUserId[0].id));
        req.log.info(
          { platform, newHandle: resolved.handleCanonical, streamerId: byUserId[0].id },
          'streamer handle rename detected — self-healed',
        );
        const refreshed = await db
          .select(publicFields())
          .from(streamers)
          .where(eq(streamers.id, byUserId[0].id))
          .limit(1);
        return { ok: true, found: true, streamer: refreshed[0], selfHealed: true };
      }
    }

    reply.code(404);
    return { ok: false, found: false };
  });

  // Viewer ping when activating chat on a channel. Creates a stub record if
  // the streamer is unknown so we can merge when they later OAuth. This is
  // the ONLY non-OAuth path that can insert into streamers.
  app.post('/streamers/seen', async (req, reply) => {
    const parsed = SeenBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: 'Invalid body' };
    }
    const { platform, handle } = parsed.data;
    const handleCol = handleColumn(platform);

    // Fast path: already exists by handle. If the stub is missing user_id /
    // display_name / avatar, try to backfill (resolver may have started
    // failing earlier, e.g. Kick CF block, and now works).
    const existing = await db.select(publicFields()).from(streamers).where(eq(handleCol, handle)).limit(1);
    if (existing.length > 0) {
      const row = existing[0];
      const needsBackfill =
        (platform === 'twitch' && (!row.twitchUserId || !row.twitchDisplayName || !row.twitchAvatarUrl)) ||
        (platform === 'youtube' && (!row.youtubeChannelId || !row.youtubeTitle || !row.youtubeAvatarUrl)) ||
        (platform === 'kick' && (!row.kickUserId || !row.kickDisplayName || !row.kickAvatarUrl));
      if (needsBackfill) {
        const resolved = await resolvePlatformHandle(platform, handle);
        if (resolved) {
          const updates: Record<string, unknown> = { updatedAt: new Date() };
          if (platform === 'twitch') {
            if (!row.twitchUserId && resolved.userId) updates.twitchUserId = resolved.userId;
            if (!row.twitchDisplayName && resolved.displayName) updates.twitchDisplayName = resolved.displayName;
            if (!row.twitchAvatarUrl && resolved.avatarUrl) updates.twitchAvatarUrl = resolved.avatarUrl;
          } else if (platform === 'youtube') {
            if (!row.youtubeChannelId && resolved.userId) updates.youtubeChannelId = resolved.userId;
            if (!row.youtubeTitle && resolved.displayName) updates.youtubeTitle = resolved.displayName;
            if (!row.youtubeAvatarUrl && resolved.avatarUrl) updates.youtubeAvatarUrl = resolved.avatarUrl;
          } else {
            if (!row.kickUserId && resolved.userId) updates.kickUserId = resolved.userId;
            if (!row.kickDisplayName && resolved.displayName) updates.kickDisplayName = resolved.displayName;
            if (!row.kickAvatarUrl && resolved.avatarUrl) updates.kickAvatarUrl = resolved.avatarUrl;
          }
          if (Object.keys(updates).length > 1) {
            await db.update(streamers).set(updates).where(eq(streamers.id, row.id));
          }
        }
      }
      return { ok: true, created: false };
    }

    // Try to resolve handle → user_id and see if it matches an existing row (rename).
    const resolved = await resolvePlatformHandle(platform, handle);
    if (resolved) {
      const userIdCol = userIdColumn(platform);
      const byUserId = await db.select({ id: streamers.id }).from(streamers).where(eq(userIdCol, resolved.userId)).limit(1);
      if (byUserId.length > 0) {
        // Existing record with old handle — self-heal (same logic as lookup).
        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (platform === 'twitch') updates.twitchLogin = resolved.handleCanonical;
        else if (platform === 'youtube') updates.youtubeHandle = resolved.handleCanonical;
        else updates.kickSlug = resolved.handleCanonical;
        await db.update(streamers).set(updates).where(eq(streamers.id, byUserId[0].id));
        return { ok: true, created: false, selfHealed: true };
      }
    }

    // Create a stub (unverified).
    const fields: Record<string, unknown> = {
      verified: false,
    };
    if (platform === 'twitch') {
      fields.twitchLogin = handle;
      if (resolved?.userId) fields.twitchUserId = resolved.userId;
      if (resolved?.displayName) fields.twitchDisplayName = resolved.displayName;
      if (resolved?.avatarUrl) fields.twitchAvatarUrl = resolved.avatarUrl;
    } else if (platform === 'youtube') {
      fields.youtubeHandle = handle;
      if (resolved?.userId) fields.youtubeChannelId = resolved.userId;
      if (resolved?.displayName) fields.youtubeTitle = resolved.displayName;
      if (resolved?.avatarUrl) fields.youtubeAvatarUrl = resolved.avatarUrl;
    } else {
      fields.kickSlug = handle;
      if (resolved?.userId) fields.kickUserId = resolved.userId;
      if (resolved?.displayName) fields.kickDisplayName = resolved.displayName;
      if (resolved?.avatarUrl) fields.kickAvatarUrl = resolved.avatarUrl;
    }

    try {
      await db.insert(streamers).values(fields as typeof streamers.$inferInsert);
      return { ok: true, created: true };
    } catch (err) {
      // Race: another request inserted in the meantime. Not fatal.
      req.log.warn({ err }, 'streamer stub insert race — ignored');
      return { ok: true, created: false };
    }
  });

  // --- Session-authenticated account endpoints --------------------------
  // All /streamers/me/* require a valid X-UC-Session header.

  // GET /streamers/me — returns the authed streamer's public profile.
  app.get('/streamers/me', { preHandler: requireSession }, async (req, reply) => {
    const streamerId = req.streamerId!;
    const rows = await db.select(publicFields()).from(streamers).where(eq(streamers.id, streamerId)).limit(1);
    if (rows.length === 0) {
      reply.code(404);
      return { ok: false, error: 'Streamer not found' };
    }
    return { ok: true, streamer: rows[0] };
  });

  // DELETE /streamers/me/platforms/:platform — unlink a platform.
  // Clears platform-specific columns on the streamer row and deletes the
  // encrypted token row.
  app.delete<{ Params: { platform: string } }>(
    '/streamers/me/platforms/:platform',
    { preHandler: requireSession },
    async (req, reply) => {
      const platform = req.params.platform;
      if (platform !== 'twitch' && platform !== 'youtube' && platform !== 'kick') {
        reply.code(400);
        return { ok: false, error: 'Invalid platform' };
      }
      const streamerId = req.streamerId!;
      const clearFields: Record<string, unknown> = { updatedAt: new Date() };
      if (platform === 'twitch') {
        clearFields.twitchLogin = null;
        clearFields.twitchUserId = null;
        clearFields.twitchDisplayName = null;
        clearFields.twitchAvatarUrl = null;
      } else if (platform === 'youtube') {
        clearFields.youtubeHandle = null;
        clearFields.youtubeChannelId = null;
        clearFields.youtubeTitle = null;
        clearFields.youtubeAvatarUrl = null;
      } else {
        clearFields.kickSlug = null;
        clearFields.kickUserId = null;
        clearFields.kickDisplayName = null;
        clearFields.kickAvatarUrl = null;
      }
      await db.update(streamers).set(clearFields).where(eq(streamers.id, streamerId));
      await db
        .delete(streamerTokens)
        .where(and(eq(streamerTokens.streamerId, streamerId), eq(streamerTokens.platform, platform)));
      return { ok: true };
    },
  );

  // POST /streamers/me/logout — invalidate the session.
  app.post('/streamers/me/logout', { preHandler: requireSession }, async (req) => {
    const raw = req.headers['x-uc-session'];
    if (typeof raw === 'string') await deleteSession(raw.trim());
    return { ok: true };
  });
}

