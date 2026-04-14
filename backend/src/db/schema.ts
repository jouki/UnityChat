import {
  pgTable,
  bigserial,
  text,
  timestamp,
  boolean,
  jsonb,
  bigint,
  integer,
  customType,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return 'bytea';
  },
});

export const users = pgTable('users', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  displayName: text('display_name'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const platformIdentities = pgTable(
  'platform_identities',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform', { enum: ['twitch', 'youtube', 'kick'] }).notNull(),
    platformUserId: text('platform_user_id').notNull(),
    platformUsername: text('platform_username').notNull(),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    platformUserUnique: uniqueIndex('platform_user_unique').on(t.platform, t.platformUserId),
    userIdx: index('platform_identities_user_idx').on(t.userId),
  }),
);

export const messages = pgTable(
  'messages',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    platform: text('platform').notNull(),
    platformMessageId: text('platform_message_id').notNull(),
    platformUserId: text('platform_user_id').notNull(),
    platformUsername: text('platform_username').notNull(),
    userId: bigint('user_id', { mode: 'number' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    content: text('content').notNull(),
    contentRaw: jsonb('content_raw'),
    channel: text('channel').notNull(),
    isUnitychatUser: boolean('is_unitychat_user').notNull().default(false),
    isReply: boolean('is_reply').notNull().default(false),
    replyToMessageId: text('reply_to_message_id'),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    platformMessageUnique: uniqueIndex('messages_platform_message_unique').on(
      t.platform,
      t.platformMessageId,
    ),
    channelSentIdx: index('messages_channel_sent_idx').on(t.channel, t.sentAt),
    platformUsernameIdx: index('messages_platform_username_idx').on(t.platform, t.platformUsername),
    userIdIdx: index('messages_user_id_idx').on(t.userId),
  }),
);

export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    platform: text('platform').notNull(),
    eventType: text('event_type').notNull(),
    channel: text('channel').notNull(),
    actorUsername: text('actor_username'),
    targetUsername: text('target_username'),
    data: jsonb('data'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    channelCreatedIdx: index('events_channel_created_idx').on(t.channel, t.createdAt),
  }),
);

export const nicknames = pgTable(
  'nicknames',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    platform: text('platform', { enum: ['twitch', 'youtube', 'kick'] }).notNull(),
    username: text('username').notNull(),
    nickname: text('nickname').notNull(),
    color: text('color'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    platformUsernameUnique: uniqueIndex('nicknames_platform_username_unique').on(t.platform, t.username),
  }),
);

export type Nickname = typeof nicknames.$inferSelect;
export type NewNickname = typeof nicknames.$inferInsert;

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type PlatformIdentity = typeof platformIdentities.$inferSelect;
export type NewPlatformIdentity = typeof platformIdentities.$inferInsert;

export const seenUsers = pgTable(
  'seen_users',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    platform: text('platform', { enum: ['twitch', 'youtube', 'kick'] }).notNull(),
    username: text('username').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    seenCount: bigint('seen_count', { mode: 'number' }).notNull().default(1),
  },
  (t) => ({
    platformUsernameUnique: uniqueIndex('seen_users_platform_username_unique').on(t.platform, t.username),
  }),
);

export type SeenUser = typeof seenUsers.$inferSelect;

// --- Streamer directory (public lookup data) -----------------------------
// Channel identifiers across platforms. Viewers query this for auto-mapping.
// All platform unique fields enforce single-row-per-streamer-per-platform.
export const streamers = pgTable(
  'streamers',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    canonicalHandle: text('canonical_handle').notNull(),

    twitchLogin: text('twitch_login').unique(),
    twitchUserId: text('twitch_user_id').unique(),
    twitchDisplayName: text('twitch_display_name'),
    twitchAvatarUrl: text('twitch_avatar_url'),

    youtubeHandle: text('youtube_handle').unique(),
    youtubeChannelId: text('youtube_channel_id').unique(),
    youtubeTitle: text('youtube_title'),
    youtubeAvatarUrl: text('youtube_avatar_url'),

    kickSlug: text('kick_slug').unique(),
    kickUserId: text('kick_user_id').unique(),
    kickDisplayName: text('kick_display_name'),
    kickAvatarUrl: text('kick_avatar_url'),

    // True once any platform has completed OAuth. Stubs (viewer-seeded) stay
    // false until the owner registers.
    verified: boolean('verified').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    twitchLoginIdx: index('streamers_twitch_login_idx').on(t.twitchLogin),
    youtubeHandleIdx: index('streamers_youtube_handle_idx').on(t.youtubeHandle),
    kickSlugIdx: index('streamers_kick_slug_idx').on(t.kickSlug),
  }),
);

// --- Streamer OAuth tokens (PRIVATE — NEVER RETURN VIA API) --------------
// Encrypted at rest using AES-256-GCM with master key from Coolify secrets.
// See security_streamer_tokens.md (internal doc, NEVER commit to git) for the
// full threat model and incident response plan.
export const streamerTokens = pgTable(
  'streamer_tokens',
  {
    streamerId: bigint('streamer_id', { mode: 'number' })
      .notNull()
      .references(() => streamers.id, { onDelete: 'cascade' }),
    platform: text('platform', { enum: ['twitch', 'youtube', 'kick'] }).notNull(),
    accessTokenEncrypted: bytea('access_token_encrypted').notNull(),
    refreshTokenEncrypted: bytea('refresh_token_encrypted'),
    tokenIv: bytea('token_iv').notNull(),
    tokenAuthTag: bytea('token_auth_tag').notNull(),
    refreshIv: bytea('refresh_iv'),
    refreshAuthTag: bytea('refresh_auth_tag'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    scopes: text('scopes').array(),
    keyVersion: integer('key_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: uniqueIndex('streamer_tokens_pk').on(t.streamerId, t.platform),
  }),
);

// Streamer persistent session (90-day) — lets returning streamer link more
// platforms without re-OAuthing the first one.
export const streamerSessions = pgTable(
  'streamer_sessions',
  {
    sessionId: text('session_id').primaryKey(), // random 32 bytes hex
    streamerId: bigint('streamer_id', { mode: 'number' })
      .notNull()
      .references(() => streamers.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    streamerIdx: index('streamer_sessions_streamer_idx').on(t.streamerId),
    expiresIdx: index('streamer_sessions_expires_idx').on(t.expiresAt),
  }),
);

export type Streamer = typeof streamers.$inferSelect;
export type NewStreamer = typeof streamers.$inferInsert;
export type StreamerToken = typeof streamerTokens.$inferSelect;
export type NewStreamerToken = typeof streamerTokens.$inferInsert;
export type StreamerSession = typeof streamerSessions.$inferSelect;
export type NewStreamerSession = typeof streamerSessions.$inferInsert;
