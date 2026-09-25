import Fastify from 'fastify';
import { startNicknameNotify } from './lib/nicknameNotify.js';
import cors from '@fastify/cors';
import { config } from './config.js';
import { pingDb, closeDb } from './db/index.js';
import nicknameRoutes from './routes/nicknames.js';
import userRoutes from './routes/users.js';
import devDownloadRoutes from './routes/dev-download.js';
import streamerRoutes from './routes/streamers.js';
import oauthRoutes from './routes/oauth.js';
import storeRoutes from './routes/store.js';
import chatRoutes from './routes/chat.js';
import commandRoutes from './routes/commands.js';
import announcementRoutes from './routes/announcements.js';
import { ucSends, markUc, ucReplies, attachUcReply, gifReviews } from './lib/ucSends.js';
import blacklistRoutes from './routes/blacklist.js';
import webAuthRoutes from './routes/webAuth.js';
import integrationRoutes from './routes/integrations.js';
import rawProfileRoutes from './routes/rawProfiles.js';
import soundboardRoutes from './routes/soundboard.js';
import sfxRequestRoutes from './routes/sfxRequests.js';
import donateRoutes from './routes/donate.js';
import accountRoutes from './routes/account.js';
import chatLogRoutes from './routes/chatLog.js';
import reactionRoutes from './routes/reactions.js';
import moderationRoutes from './routes/moderation.js';
import integrationModerationRoutes from './routes/integrationModeration.js';
import accountWarningRoutes from './routes/accountWarnings.js';
import { disconnectAllAccountStreams } from './lib/accountWarnings.js';
import { publishUserModerated, recordBan } from './lib/userModeration.js';
import { publishIntegration, integrationStreamStats, disconnectAllIntegrationStreams } from './sse/integrationStream.js';
import { startWorkspaceRefresh, stopWorkspaceRefresh, onWorkspaces, PLATFORMS as WS_PLATFORMS } from './lib/zidolista.js';
import { loadBotLogins } from './lib/botIdentities.js';
import { isConfigured as cwsConfigured } from './lib/cwsApi.js';
import { disconnectAll as disconnectSSE, clientCount } from './sse/bus.js';
import { publishChat, chatStreamClientCount, disconnectAllChatStreams } from './sse/chatBus.js';
import { toClientMessage } from './routes/chat.js';
import { toRow } from './ingest/normalize.js';
import { parseIngestChannels } from './ingest/channels.js';
import { createIngest } from './ingest/index.js';
import { startMailKeepalive } from './lib/mailKeepalive.js';
import { publishDeleted } from './lib/messageDeletes.js';
import { ucChannelFor } from './lib/ucChannel.js';
import { createLinkFilter, linkFilterSync, refreshLinkFilter, permits, storePermits, loadActivePermits } from './lib/linkFilter.js';
import { isBotAccount } from './lib/botIdentities.js';
import { workspaceForChannelSync } from './lib/zidolista.js';
import { deletePlatformMessage } from './lib/modActions.js';
import { archivedUserByLogin, resolveUserTargets, dbTargetDeps } from './lib/moderationTargets.js';
import { registryPlatformChannel } from './lib/platformChannels.js';
import { db } from './db/index.js';
import { moderationActions } from './db/schema.js';
import gifRoutes, { MediaServer } from './routes/gif.js';
import { createGifFlow, createGifNotifier, dbGifStore, senderAccount, servableMedia } from './lib/gifRequests.js';
import { gifAccess, gifAccessSync, gifUsed } from './lib/gifAccess.js';
import { resolveGif } from './lib/gifMedia.js';
import { isGifMessageId } from './lib/gifIds.js';
import { accountModIdentities } from './lib/chatRole.js';
import { connectedAccountIds, sendToAccount } from './lib/accountWarnings.js';
import { publishRestored } from './lib/linkRestore.js';
import { onMessageDeleted } from './lib/messageDeletes.js';
import { broadcast } from './sse/bus.js';
import { publishIntegrationEvent } from './sse/integrationStream.js';

const startedAt = Date.now();

const app = Fastify({
  // Za Coolify/Traefik: bez trustProxy je req.ip = IP proxy (10.0.1.2) pro
  // všechny klienty → per-IP limity (/chat/stream, /chat/history) platily
  // globálně (2026-09-21: 5 streamů = 429 pro celý web).
  trustProxy: true,
  logger: {
    level: config.LOG_LEVEL,
    ...(config.NODE_ENV === 'development' && {
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l' },
      },
    }),
  },
});

// JSON parser, který si nechá i surové tělo: HMAC podpis požadavků ze Židolišty
// (lib/inboundAuth.ts) se počítá z přesně odeslaných bajtů, ne z přeparsovaného JSON.
const defaultJson = app.getDefaultJsonParser('error', 'error');   // ochrana proti __proto__ / constructor poisoning zůstává
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  req.rawBody = typeof body === 'string' ? body : body.toString('utf8');
  defaultJson(req, req.rawBody, done);
});

await app.register(cors, {
  origin: true,
  credentials: true,
});

// Odměna „Posílání GIFů" (moderace část 4, lib/gifRequests.ts): žádosti čekají na mody, soukromě přes /account/stream.
const gifNotifier = createGifNotifier({
  connected: connectedAccountIds,
  isMod: async (accountId, channel) => (await accountModIdentities(accountId, channel)).length > 0,
  senderAccount: (platform, userId) => senderAccount(platform, userId),
  send: sendToAccount,
});
const gifMedia = new MediaServer(servableMedia);
const gifFlow = createGifFlow({
  store: dbGifStore,
  resolve: (src) => resolveGif(src),
  access: (q) => gifAccess(q, { log: app.log }),
  used: (p) => gifUsed(p, { log: app.log }),
  publishDeleted: (p) => publishDeleted(p),
  deletePlatform: (p) => deletePlatformMessage(p, { log: app.log }),
  restore: (p) => publishRestored({ ...p, by: 'filter', reason: 'gif_request' }),
  broadcast,
  publishChat: (platformChannel, platform, msg) => publishChat(platformChannel, platform, msg),
  notify: (r, event, data) => gifNotifier.notify(r, event, data),
  integration: (ev) => { publishIntegrationEvent(ev); },
  recordAction: async (v) => { await db.insert(moderationActions).values(v); },
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  mediaDeleted: (id) => gifMedia.forget(id),
  mediaApproved: (id) => gifMedia.prewarm(id),
  log: app.log,
});
// Smazání schváleného GIFu modem (část 1, id `gif-…`) → žádost `deleted`, médium se přestane servírovat.
onMessageDeleted(async ({ messageId }) => {
  if (!isGifMessageId(messageId)) return;
  const r = await dbGifStore.get(Number(messageId.slice(4)));
  await gifFlow.onMessageDeleted(messageId);
  if (r?.mediaId) gifMedia.forget(r.mediaId);
});

// Filtr odkazů + `!permit` z chatu (moderace část 3, lib/linkFilter.ts). Zapíná ho jen Židolišta
// (`enabled` v nastavení workspace, výchozí vypnuto); bez odpovědi Židolišty se nic nemaže.
const linkTargets = dbTargetDeps((channel, platform) => registryPlatformChannel(channel, platform));
const linkFilter = createLinkFilter({
  workspaceFor: workspaceForChannelSync,
  settingsFor: (slug) => linkFilterSync(slug, app.log),
  isBotAccount,
  permits,
  publishDeleted: (p) => publishDeleted(p),
  deletePlatform: (p) => deletePlatformMessage(p, { log: app.log }),
  resolvePermitTarget: async (ucChannel, platform, platformChannel, login) => {
    const u = await archivedUserByLogin(platform, platformChannel, login);
    if (!u) return [];
    return (await resolveUserTargets(ucChannel, platform, u.userId, linkTargets))?.all ?? [u];
  },
  storePermits: (rows) => storePermits(rows),
  recordAction: async (v) => { await db.insert(moderationActions).values(v); },
  now: Date.now,
  log: app.log,
  gif: {
    accessSync: (q) => gifAccessSync(q, { log: app.log }),
    tryReserve: (channel, platform, userId) => gifFlow.tryReserve(channel, platform, userId),
    intercept: (p) => gifFlow.intercept(p),
    reviewRequested: (m) => gifReviews.requested(m),
    lateReview: (m) => gifReviews.lateRequested(m),
  },
});

// Server-side chat log: poslouchá platformy podle CHAT_INGEST_CHANNELS a
// plní tabulku messages; /chat/history z ní čte. Prázdná konfigurace =
// vše 'off', start() nic nespustí.
const ingest = createIngest({
  channels: parseIngestChannels(config.CHAT_INGEST_CHANNELS),
  retentionDays: config.CHAT_RETENTION_DAYS,
  log: app.log,
  // GET /chat/stream: rozeslat hned po přijetí (před DB dávkou), stejný tvar jako /chat/history.
  onLive: (m) => {
    // Filtr odkazů PŘED rozesláním i zápisem: smazaná zpráva jde dál jen jako `deleted` (bez obsahu).
    linkFilter.check(m);
    // Command odeslaný z UnityChatu (bez markeru) — klient ho předem nahlásil (lib/ucSends.ts).
    if (ucSends.match(m)) markUc(m, app.log);
    // Odpověď napříč platformami nahlášená klientem (content_raw.ucReply → replyTo v /chat/stream).
    const rep = ucReplies.take(m);
    if (rep?.data) attachUcReply(m, rep.data, app.log);
    publishChat(m.channel, m.platform, toClientMessage(toRow(m), false));
    // Chat bot Židolišty: stejná zpráva i do integračního streamu (jen namapované kanály).
    publishIntegration(m);
  },
  // Smazání na platformě (Twitch CLEARMSG, Kick, YouTube) — moderace §mazání. `d.channel`
  // je platformní (Kick slug / YT handle), publishDeleted potřebuje UC kanál (ucChannelFor).
  onDelete: (d) => {
    ucChannelFor(d.platform, d.channel)
      .then((channel) => publishDeleted({ channel, platform: d.platform, messageId: d.messageId, by: null, reason: 'platform' }))
      .catch((err) => app.log.warn({ err: (err as Error)?.message, platform: d.platform }, 'chat ingest: onDelete (mazání z platformy) selhalo'));
  },
  // Timeout/ban odjinud (Twitch CLEARCHAT) — moderace část 2: stejné SSE user-moderated (by null)
  // + evidence banu (Unban v nabídce). Echo vlastní akce z UnityChatu publishUserModerated přeskočí.
  onUserModerated: (d) => {
    ucChannelFor(d.platform, d.channel)
      .then(async (channel) => {
        const action = d.durationSec ? 'timeout' as const : 'ban' as const;
        const ev = await publishUserModerated({ channel, platform: d.platform, userId: d.userId, login: d.login, action, durationSec: d.durationSec, by: null, source: 'platform' });
        if (!ev) return;
        await recordBan({ channel, platform: d.platform, userId: d.userId, login: d.login, until: ev.until ? new Date(ev.until) : null });
      })
      .catch((err) => app.log.warn({ err: (err as Error)?.message, platform: d.platform }, 'chat ingest: onUserModerated (CLEARCHAT) selhalo'));
  },
});
app.addHook('onReady', async () => {
  ingest.start();
  startMailKeepalive(app.log);
  // Registr workspaců Židolišty (mapování kanálů pro stream) + loginy botů pro isBot.
  // Kanály workspaců se přidávají do ingestu automaticky (env CHAT_INGEST_CHANNELS je jen základ).
  onWorkspaces((list) => {
    for (const w of list) for (const p of WS_PLATFORMS) {
      const ch = w.channels[p];
      if (ch && ingest.ensureChannel({ platform: p, channel: ch })) app.log.info({ workspace: w.slug, platform: p, channel: ch }, 'chat ingest: kanál přidán z registru Židolišty');
    }
    // Nastavení filtru odkazů workspaců dopředu (onLive čte jen cache).
    for (const w of list) void refreshLinkFilter(w.slug, { log: app.log });
  });
  startWorkspaceRefresh(app.log);
  gifFlow.loadPending().then((n) => app.log.info({ n }, 'gif: čekající žádosti načteny')).catch((err) => app.log.warn({ err: (err as Error).message }, 'gif: načtení žádostí selhalo (tabulka chybí?)'));
  gifExpiryTimer = setInterval(() => { void gifFlow.expireTick(); }, 10_000);
  gifExpiryTimer.unref?.();
  loadActivePermits().then((n) => app.log.info({ n }, 'link filter: aktivní permity načteny')).catch((err) => app.log.warn({ err: (err as Error).message }, 'link filter: načtení permitů selhalo'));
  loadBotLogins().then((n) => app.log.info({ n }, 'bot identities loaded')).catch((err) => app.log.warn({ err: (err as Error).message }, 'bot identities: load failed (tabulka chybí?)'));
});
let gifExpiryTimer: ReturnType<typeof setInterval> | null = null;
app.addHook('onClose', async () => { if (gifExpiryTimer) clearInterval(gifExpiryTimer); await ingest.stop(); stopWorkspaceRefresh(); disconnectAllIntegrationStreams(); disconnectAllAccountStreams(); });

app.get('/', async () => ({
  service: 'unitychat-backend',
  version: '0.5.0',
  docs: '/health',
}));

app.get('/health', async () => ({
  ok: true,
  service: 'unitychat-backend',
  version: '0.5.0',
  uptimeMs: Date.now() - startedAt,
  timestamp: new Date().toISOString(),
  sseClients: clientCount(),
  chatStreamClients: chatStreamClientCount(),
  integrationStream: integrationStreamStats(),
  // Diagnostika: bez klice vraci /store/status 503 a landing page nezobrazi
  // radek o verzi cekajici na schvaleni. Snazsi zjistit odsud nez z kontejneru.
  cwsConfigured: cwsConfigured(),
  // Stav chat ingestu per platforma + poslední přijatá zpráva (čas platformy).
  ingest: ingest.status(),
}));

await app.register(nicknameRoutes);
await app.register(userRoutes);
await app.register(streamerRoutes);
await app.register(oauthRoutes);
await app.register(storeRoutes);
await app.register(chatRoutes);
await app.register(commandRoutes);
await app.register(announcementRoutes);
await app.register(blacklistRoutes);
await app.register(webAuthRoutes, { ingest });
await app.register(integrationRoutes, { ingest });
await app.register(rawProfileRoutes);
await app.register(reactionRoutes);
await app.register(moderationRoutes, { ingest });
await app.register(integrationModerationRoutes, { ingest });
await app.register(accountWarningRoutes, {
  // Čekající žádosti o GIF, které účet smí vidět (mod kanálu / odesílatel), hned po připojení.
  onOpen: async (accountId: number) => (await gifNotifier.visibleTo(accountId, await dbGifStore.listPending(new Date()))).map((data) => ({ event: 'gif-pending', data })),
});
await app.register(gifRoutes, { flow: gifFlow, store: dbGifStore, media: gifMedia });
await app.register(soundboardRoutes);
await app.register(sfxRequestRoutes);
await app.register(donateRoutes);
await app.register(accountRoutes);
await app.register(chatLogRoutes);

if (config.NODE_ENV === 'development') {
  await app.register(devDownloadRoutes);
}

app.get('/health/db', async (_request, reply) => {
  const ok = await pingDb();
  if (!ok) {
    reply.code(503);
    return { ok: false, database: 'unreachable' };
  }
  return { ok: true, database: 'reachable' };
});

const shutdown = async (signal: string): Promise<void> => {
  app.log.info(`${signal} received, shutting down gracefully`);
  try {
    disconnectSSE();
  disconnectAllChatStreams();
    await app.close();
    await closeDb();
    process.exit(0);
  } catch (err) {
    app.log.error(err, 'shutdown failed');
    process.exit(1);
  }
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port: config.PORT, host: config.HOST });
  // Změny přezdívek z DB (trigger) → SSE; selhání poslechu nesmí shodit server.
  startNicknameNotify(app.log).catch((e) => app.log.error({ err: (e as Error).message }, 'nicknames: LISTEN selhal'));
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
