import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { pingDb, closeDb } from './db/index.js';
import nicknameRoutes from './routes/nicknames.js';
import userRoutes from './routes/users.js';
import devDownloadRoutes from './routes/dev-download.js';
import streamerRoutes from './routes/streamers.js';
import oauthRoutes from './routes/oauth.js';
import { disconnectAll as disconnectSSE, clientCount } from './sse/bus.js';

const startedAt = Date.now();

const app = Fastify({
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

await app.register(cors, {
  origin: true,
  credentials: true,
});

app.get('/', async () => ({
  service: 'unitychat-backend',
  version: '0.1.0',
  docs: '/health',
}));

app.get('/health', async () => ({
  ok: true,
  service: 'unitychat-backend',
  version: '0.2.0',
  uptimeMs: Date.now() - startedAt,
  timestamp: new Date().toISOString(),
  sseClients: clientCount(),
}));

await app.register(nicknameRoutes);
await app.register(userRoutes);
await app.register(streamerRoutes);
await app.register(oauthRoutes);

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
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
