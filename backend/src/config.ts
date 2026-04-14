import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().url(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  NICKNAME_RATE_LIMIT_SECS: z.coerce.number().int().positive().default(10),
  // Base64-encoded 32-byte key for AES-256-GCM. REQUIRED for streamer OAuth.
  // Generate: `openssl rand -base64 32`. Store in Coolify secrets, NEVER in git.
  TOKEN_ENCRYPTION_KEY: z.string().optional(),
  // Comma-separated list of Chrome extension IDs allowed to hit /streamers/*.
  // e.g. "jkmnofccpdedfjbkglldhenmedbhclhj,devextensionid..."
  ALLOWED_EXTENSION_IDS: z.string().default(''),
});

export const config = EnvSchema.parse(process.env);

export type Config = typeof config;
