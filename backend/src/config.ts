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
  // Public base URL the extension uses to reach this backend (for OAuth callback
  // URIs registered with providers). Example: https://api.jouki.cz
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  // Twitch OAuth app credentials (register at https://dev.twitch.tv/console/apps)
  TWITCH_CLIENT_ID: z.string().default(''),
  TWITCH_CLIENT_SECRET: z.string().default(''),
  // Google OAuth credentials for YouTube (https://console.cloud.google.com/apis/credentials)
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  // Kick OAuth credentials (https://kick.com/settings/developer)
  KICK_CLIENT_ID: z.string().default(''),
  KICK_CLIENT_SECRET: z.string().default(''),
  // Chrome Web Store API v2 - cte stav polozky pro /store/status (landing page
  // z nej kresli "nova verze ceka na schvaleni"). Cely JSON klic service
  // accountu; v Coolify secrets, NIKDY v gitu. Bez nej endpoint vraci 503.
  CWS_SERVICE_ACCOUNT: z.string().optional(),
  CWS_PUBLISHER_ID: z.string().default(''),
  CWS_ITEM_ID: z.string().default('picaeipbmkgcippknkpkbnbgjlkblbnp'),
  // Server-side chat log (spec 2026-09-19). Prázdné = ingest vypnutý.
  // Formát: "twitch:robdiesalot,kick:robdiesalot,youtube:robdiesalot"
  CHAT_INGEST_CHANNELS: z.string().default(''),
  // Retence zpráv v tabulce messages (dny). 0 = neomezeně (rozhodnutí usera
  // 2026-09-19: zprávy držet po neurčitou dobu, mazání na žádost).
  CHAT_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(0),
});

export const config = EnvSchema.parse(process.env);

export type Config = typeof config;
