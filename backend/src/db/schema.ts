import {
  pgTable,
  bigserial,
  text,
  timestamp,
  boolean,
  jsonb,
  bigint,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

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
