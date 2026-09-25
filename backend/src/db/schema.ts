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
  primaryKey,
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
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: text('deleted_by'),
    deletedReason: text('deleted_reason'),
    // „Jen UC skrýt“ — na platformě zpráva zůstává, klientům UC jde bez obsahu (hidden: true).
    hiddenAt: timestamp('hidden_at', { withTimezone: true }),
    hiddenBy: text('hidden_by'),
  },
  (t) => ({
    platformMessageUnique: uniqueIndex('messages_platform_message_unique').on(
      t.platform,
      t.platformMessageId,
    ),
    channelSentIdx: index('messages_channel_sent_idx').on(t.channel, t.sentAt),
    platformUsernameIdx: index('messages_platform_username_idx').on(t.platform, t.platformUsername),
    userIdIdx: index('messages_user_id_idx').on(t.userId),
    // Chat historie uživatele (lib/userHistory.ts) — ručně sql/2026-09-25-user-history-index.sql
    // (tam navíc INCLUDE (channel), které Drizzle neumí popsat; tabulky se spravují ručním SQL).
    platformUserSentIdx: index('messages_platform_user_sent_idx').on(t.platform, t.platformUserId, t.sentAt.desc()),
  }),
);

export const moderationActions = pgTable(
  'moderation_actions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    channel: text('channel').notNull(),
    accountId: bigint('account_id', { mode: 'number' }).references(() => webAccounts.id, {
      onDelete: 'set null',
    }),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    platform: text('platform').notNull(),
    targetLogin: text('target_login'),
    targetMessageId: text('target_message_id'),
    params: jsonb('params').notNull().default({}),
    result: jsonb('result').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    channelCreatedIdx: index('moderation_actions_channel_idx').on(t.channel, t.createdAt),
  }),
);

// Moderace část 2 (backend/sql/2026-09-25-moderation-2.sql, ručně SQL).
// Známé bany/timeouty: vlastní akce + Twitch CLEARCHAT. until null = permanentní; unban řádek maže.
export const moderationBans = pgTable(
  'moderation_bans',
  {
    channel: text('channel').notNull(),
    platform: text('platform').notNull(),
    targetUserId: text('target_user_id').notNull(),
    targetLogin: text('target_login').notNull(),
    until: timestamp('until', { withTimezone: true }),
    youtubeBanId: text('youtube_ban_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.channel, t.platform, t.targetUserId], name: 'moderation_bans_pkey' }) }),
);

// Permit odkazů (nabídka moda) — čte filtr odkazů v části 3.
export const linkPermits = pgTable(
  'link_permits',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    channel: text('channel').notNull(),
    platform: text('platform').notNull(),
    targetUserId: text('target_user_id').notNull(),
    targetLogin: text('target_login').notNull(),
    until: timestamp('until', { withTimezone: true }).notNull(),
    by: text('by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ targetIdx: index('link_permits_target_idx').on(t.channel, t.platform, t.targetUserId) }),
);

// Varování uživatele UnityChatu (napříč platformami), musí potvrdit.
export const accountWarnings = pgTable('account_warnings', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  accountId: bigint('account_id', { mode: 'number' }).notNull().references(() => webAccounts.id, { onDelete: 'cascade' }),
  channel: text('channel').notNull(),
  reason: text('reason').notNull(),
  by: text('by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
});

// Moderace část 4 — odměna „Posílání GIFů" (backend/sql/2026-09-25-gif-requests.sql, ručně SQL).
// Médium stažené serverem (≤ 10 MB) drží DB (bytea): kontejner backendu nemá trvalý svazek.
export const gifMedia = pgTable('gif_media', {
  id: text('id').primaryKey(),                       // náhodných 16 B hex (neuhodnutelné, /media/gif/:id)
  kind: text('kind').notNull(),                      // gif | webp | mp4
  contentType: text('content_type').notNull(),
  bytes: bytea('bytes').notNull(),
  size: integer('size').notNull(),
  sha256: text('sha256').notNull(),
  width: integer('width'),
  height: integer('height'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const gifRequests = pgTable(
  'gif_requests',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    channel: text('channel').notNull(),              // UC kanál (Twitch login streamera)
    workspace: text('workspace').notNull(),
    platform: text('platform').notNull(),
    platformChannel: text('platform_channel').notNull(), // messages.channel původní zprávy
    userId: text('user_id').notNull(),
    login: text('login').notNull(),
    messageId: text('message_id').notNull(),         // původní zpráva s odkazem (smazaná)
    textWithoutLink: text('text_without_link').notNull().default(''),
    mediaId: text('media_id'),
    kind: text('kind').notNull(),
    width: integer('width'),
    height: integer('height'),
    meta: jsonb('meta').notNull().default({}),       // { color, badges } z původní zprávy (vykreslení jména)
    status: text('status').notNull().default('pending'), // pending | approved | rejected | expired | deleted
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    pendingIdx: index('gif_requests_pending_idx').on(t.status, t.expiresAt),
    channelIdx: index('gif_requests_channel_idx').on(t.channel, t.createdAt),
    mediaIdx: index('gif_requests_media_idx').on(t.mediaId),
  }),
);
export type GifRequest = typeof gifRequests.$inferSelect;

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
export type ModerationAction = typeof moderationActions.$inferSelect;
export type NewModerationAction = typeof moderationActions.$inferInsert;
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
    pk: primaryKey({ columns: [t.streamerId, t.platform], name: 'streamer_tokens_pk' }),
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

// --- Web verze: účty návštěvníků, jejich platformní identity + tokeny, session ---
// (spec UnityChat-web 2026-09-21 §3.3). Tokeny šifrované stejně jako
// streamer_tokens (AES-256-GCM, TOKEN_ENCRYPTION_KEY) — NIKDY nevracet z API.
export const webAccounts = pgTable('web_accounts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
});

export const webIdentities = pgTable(
  'web_identities',
  {
    accountId: bigint('account_id', { mode: 'number' })
      .notNull()
      .references(() => webAccounts.id, { onDelete: 'cascade' }),
    platform: text('platform', { enum: ['twitch', 'youtube', 'kick'] }).notNull(),
    platformUserId: text('platform_user_id').notNull(),
    login: text('login').notNull(),          // lowercase handle (twitch login / kick slug / yt handle bez @)
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    accessTokenEncrypted: bytea('access_token_encrypted').notNull(),
    refreshTokenEncrypted: bytea('refresh_token_encrypted'),
    tokenIv: bytea('token_iv').notNull(),
    tokenAuthTag: bytea('token_auth_tag').notNull(),
    refreshIv: bytea('refresh_iv'),
    refreshAuthTag: bytea('refresh_auth_tag'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    scopes: text('scopes').array(),
    keyVersion: integer('key_version').notNull().default(1),
    // „Odhlásit se" (2026-09-24): identita zůstane kvůli návaznosti účtu (oblíbené zvuky apod.),
    // tokeny se zahodí a do dalšího přihlášení přes tuhle platformu se k účtu nepočítá.
    signedOutAt: timestamp('signed_out_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.accountId, t.platform], name: 'web_identities_pk' }),
    platformUserIdx: uniqueIndex('web_identities_platform_user_idx').on(t.platform, t.platformUserId),
  }),
);

// Identity chat bota Židolišty (spec docs/superpowers/specs/2026-09-22-zidolista-chat-bot-design.md):
// workspace = slug Židolišty nebo '_shared' (sdílený JoukiBOT). Tokeny šifrované
// stejně jako web_identities, nikdy ven z API. Tabulka vytvořena ručně SQL
// (backend/sql/2026-09-22-bot-identities.sql), drizzle-kit push přes tunel padá.
export const botIdentities = pgTable(
  'bot_identities',
  {
    workspace: text('workspace').notNull(),
    platform: text('platform', { enum: ['twitch', 'youtube', 'kick'] }).notNull(),
    platformUserId: text('platform_user_id').notNull(),
    login: text('login').notNull(),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    accessTokenEncrypted: bytea('access_token_encrypted').notNull(),
    refreshTokenEncrypted: bytea('refresh_token_encrypted'),
    tokenIv: bytea('token_iv').notNull(),
    tokenAuthTag: bytea('token_auth_tag').notNull(),
    refreshIv: bytea('refresh_iv'),
    refreshAuthTag: bytea('refresh_auth_tag'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    scopes: text('scopes').array(),
    keyVersion: integer('key_version').notNull().default(1),
    // 'expired' = refresh selhal, nutno znovu napojit (status endpoint).
    state: text('state').notNull().default('online'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspace, t.platform], name: 'bot_identities_pk' }),
  }),
);

// Souhlas broadcastera s botem v kanálu (Twitch `channel:bot` → odznak „Chat Bot" u zpráv
// bota posílaných app access tokenem). Bez tokenů, jen záznam pro stav. SQL ručně.
export const botChannelGrants = pgTable(
  'bot_channel_grants',
  {
    workspace: text('workspace').notNull(),
    platform: text('platform', { enum: ['twitch', 'youtube', 'kick'] }).notNull(),
    login: text('login').notNull(),
    platformUserId: text('platform_user_id').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.workspace, t.platform], name: 'bot_channel_grants_pk' }) }),
);

// Profily browser source (/chat/raw/?p=<id>): nastavení z /chat/settings/ na serveru,
// změny živě přes SSE `raw-settings`. Ručně SQL (backend/sql/2026-09-22-raw-profiles.sql).
export const rawProfiles = pgTable('raw_profiles', {
  id: text('id').primaryKey(),
  settings: jsonb('settings').notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// QR dono (spec 2026-09-25-qr-dono-v-unitychatu-design.md): e-mail zadaný uživatelem a ověřený
// kódem patří ÚČTU (všem propojeným identitám). Z loginů platforem se e-mail nečte (Twitch DA VI.C).
// Ručně SQL (backend/sql/2026-09-25-account-email.sql).
export const accountEmails = pgTable('account_emails', {
  accountId: bigint('account_id', { mode: 'number' }).primaryKey().references(() => webAccounts.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Rozpracované ověření: jeden aktivní kód na účet (SHA-256, nikdy v čistém tvaru).
export const emailVerifications = pgTable('email_verifications', {
  accountId: bigint('account_id', { mode: 'number' }).primaryKey().references(() => webAccounts.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  codeHash: text('code_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  sends: integer('sends').notNull().default(0),
  lastSentAt: timestamp('last_sent_at', { withTimezone: true }).notNull().defaultNow(),
});

// Každý odeslaný e-mail (limity na účet / adresu / IP / celkový denní rozpočet služeb, audit).
export const emailSendLog = pgTable('email_send_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  accountId: bigint('account_id', { mode: 'number' }),
  email: text('email').notNull(),
  ipHash: text('ip_hash').notNull(),
  provider: text('provider').notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ sentIdx: index('email_send_log_sent_idx').on(t.sentAt) }));

// Poslední přezdívka zadaná v QR donu (předvyplnění příště).
export const accountDonatePrefs = pgTable('account_donate_prefs', {
  accountId: bigint('account_id', { mode: 'number' }).primaryKey().references(() => webAccounts.id, { onDelete: 'cascade' }),
  lastNickname: text('last_nickname'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Soundboard (spec 2026-09-24-soundboard-se-tiers-design.md): oblíbené zvuky a počty
// přehrání per účet. Zvuky samotné žijí v Židolišti, sound_id = její stabilní id.
// Ručně SQL (backend/sql/2026-09-24-soundboard.sql).
export const soundboardFavorites = pgTable(
  'soundboard_favorites',
  {
    accountId: bigint('account_id', { mode: 'number' }).notNull().references(() => webAccounts.id, { onDelete: 'cascade' }),
    workspace: text('workspace').notNull(),
    soundId: integer('sound_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.accountId, t.workspace, t.soundId], name: 'soundboard_favorites_pk' }) }),
);

export const soundboardUsage = pgTable(
  'soundboard_usage',
  {
    accountId: bigint('account_id', { mode: 'number' }).notNull().references(() => webAccounts.id, { onDelete: 'cascade' }),
    workspace: text('workspace').notNull(),
    soundId: integer('sound_id').notNull(),
    count: integer('count').notNull().default(0),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.accountId, t.workspace, t.soundId], name: 'soundboard_usage_pk' }) }),
);

// Session = náhodných 32 B; v DB jen SHA-256 hash, klient drží raw token
// (localStorage, Authorization: Bearer). 30 dní klouzavě.
export const webSessions = pgTable(
  'web_sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    accountId: bigint('account_id', { mode: 'number' })
      .notNull()
      .references(() => webAccounts.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    accountIdx: index('web_sessions_account_idx').on(t.accountId),
    expiresIdx: index('web_sessions_expires_idx').on(t.expiresAt),
  }),
);

export type WebIdentity = typeof webIdentities.$inferSelect;
