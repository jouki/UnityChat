import { z } from 'zod';

// Podpisový klíč v2: prázdný (vypnuto) nebo hex se sudou délkou ≥ 64 znaků. Hodnota se do chyby nevypisuje.
const signingKey = z.string().trim().default('').refine((v) => v === '' || /^(?:[0-9a-fA-F]{2}){32,}$/.test(v), { message: 'musí být hex, alespoň 64 znaků (32 bajtů)' });

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
  // Web verze: originy, na které smí OAuth callback vrátit uživatele (#uc_code)
  // a které dostanou CORS pro /auth/* + /chat/send. Čárkou oddělené.
  // `www.` je tu záměrně: hosting Roba www nepřesměrovává a Chrome ho v adresním řádku
  // skrývá — diváci na www dostávali 400 a přihlašovací okno se hned zavřelo (2026-09-22).
  WEB_ORIGINS: z.string().default('https://robdiesalot.com,https://www.robdiesalot.com,http://localhost:5173,http://127.0.0.1:5173'),
  // Rozšíření, která smí OAuth přihlášení vrátit na https://<id>.chromiumapp.org/ (lib/webAuth.ts
  // isAllowedReturnTo). Čárkami. Výchozí = ID v Chrome Web Store. Vývojová (unpacked) instalace má
  // ID podle cesty ke složce → přidat ho sem, jinak její přihlášení skončí 400 „returnTo origin not allowed".
  ALLOWED_AUTH_EXTENSION_IDS: z.string().default('picaeipbmkgcippknkpkbnbgjlkblbnp'),
  // Firefox: gecko ID doplňku (scripts/build-firefox.mjs GECKO_ID); origin = sha1(ID).extensions.allizom.org.
  ALLOWED_AUTH_FIREFOX_ADDON_IDS: z.string().default('unitychat@jouki.cz'),
  // GitHub webhook /webhook/deploy (jen NODE_ENV=development, routes/dev-download.ts). Bez něj se route
  // vůbec nezaregistruje. NIKDY v gitu.
  WEBHOOK_SECRET: z.string().default(''),
  // Židolišta (RobJewsALot server): chat commandy streamera pro našeptávání „!".
  // Klíč = env INTEGRATION_API_KEYS na straně Židolišty; NIKDY v gitu. Prázdný
  // klíč = GET /commands vrací prázdný seznam. Mapování kanál → workspace slug.
  ZIDOLISTA_API_BASE: z.string().url().default('https://api-zidolista.jouki.cz'),
  ZIDOLISTA_API_KEY: z.string().default(''),
  // Klíč Židolišta → UnityChat (X-Api-Key + HMAC podpis X-UC-Signature), lib/inboundAuth.ts.
  ZIDOLISTA_INBOUND_KEY: z.string().default(''),
  // "1" = jen nový klíč a platný podpis; jinak přechod (projde i ZIDOLISTA_API_KEY, podpis se jen loguje).
  ZIDOLISTA_INBOUND_STRICT: z.string().default(''),
  // Podpis v2 (docs/superpowers/plans/2026-09-26-podpis-v2-kontrakt.md, lib/signatureV2.ts). Klíče jsou hex ≥ 64 znaků,
  // jeden pro každý směr, po síti nikdy nejdou; jen v Coolify secrets, NIKDY v gitu ani v logu.
  // Příchozí režim: v1 (výchozí, dosavadní chování vč. ZIDOLISTA_INBOUND_STRICT) | any (v1 i v2) | v2.
  ZIDOLISTA_INBOUND_SIGNATURE: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['v1', 'any', 'v2']).default('v1')),
  // Židolišta → UnityChat: ověření příchozích v2 (lib/inboundAuth.ts).
  ZIDOLISTA_TO_UC_SIGNING_KEY: signingKey,
  // UnityChat → Židolišta: když je nastavený, všechna odchozí volání jdou podepsaná v2 (lib/zidolista.ts zidolistaFetch).
  UC_TO_ZIDOLISTA_SIGNING_KEY: signingKey,
  // E-maily (ověřovací kód QR dona, lib/mailer.ts): Brevo primárně, Resend záloha. Bez klíčů = ověření vypnuté.
  BREVO_API_KEY: z.string().default(''),
  RESEND_API_KEY: z.string().default(''),
  MAIL_FROM: z.string().email().default('noreply-unitychat@jouki.cz'),
  // Celkový denní strop odeslaných e-mailů (Brevo 300 + Resend 100 − rezerva).
  MAIL_DAILY_BUDGET: z.coerce.number().int().positive().default(380),
  // Kam jde měsíční udržovací e-mail (lib/mailKeepalive.ts; Brevo klíč vyprší po 90 dnech nečinnosti). Prázdné = vypnuto.
  MAIL_KEEPALIVE_TO: z.string().default('m.joukal+unitychat@gmail.com'),
  // GIFy (lib/gifUnlocker.ts): záložní stažení přes Bright Data Web Unlocker, když přímé narazí na Cloudflare
  // challenge. Bez klíče nebo zóny = vypnuto. Klíč jen v Coolify secrets, NIKDY v gitu ani v logu.
  BRIGHTDATA_API_KEY: z.string().default(''),
  BRIGHTDATA_ZONE: z.string().default(''),
  // Denní strop volání (reset o půlnoci UTC); free tier = 5000 požadavků / měsíc.
  // Prázdná hodnota = výchozí (z.coerce by z '' udělal 0 = vypnuto).
  BRIGHTDATA_DAILY_CAP: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().nonnegative().default(100)),
  ZIDOLISTA_WORKSPACES:z.string().default('robdiesalot=rob'),
  // Kam smí vracet OAuth napojení bota (returnTo z POST /integrations/bot/link-token): dashboard Židolišty.
  ZIDOLISTA_RETURN_ORIGINS: z.string().default('https://jouki.cz'),
}).superRefine((env, ctx) => {
  // Režim v2 bez klíčů = všechno ze Židolišty by padalo na 401 → radši nenastartovat (Coolify nechá běžet starou verzi).
  if (env.ZIDOLISTA_INBOUND_SIGNATURE === 'v2' && (!env.ZIDOLISTA_TO_UC_SIGNING_KEY || !env.ZIDOLISTA_INBOUND_KEY)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ZIDOLISTA_INBOUND_SIGNATURE'], message: 'v2 vyžaduje ZIDOLISTA_TO_UC_SIGNING_KEY i ZIDOLISTA_INBOUND_KEY' });
  }
});

export const config = EnvSchema.parse(process.env);

export type Config = typeof config;
