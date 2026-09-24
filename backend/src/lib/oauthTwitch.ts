import { config } from '../config.js';

// Twitch OAuth 2.0 code flow.
// Docs: https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/

const AUTHORIZE_URL = 'https://id.twitch.tv/oauth2/authorize';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const USER_URL = 'https://api.twitch.tv/helix/users';

// Minimal scope — just identify the user. No moderation / chat write here;
// those can be requested separately if future features need them.
const SCOPES = ['user:read:email'] as const;
// Web verze: posílání zpráv jako uživatel (Helix POST /chat/messages).
// Bez user:read:email: e-mail z Twitche nečteme (Developer Agreement VI.C, spec 2026-09-25-qr-dono) → minimální scopes.
export const WEB_SCOPES = ['user:write:chat'] as const;
// Účet chat bota Židolišty: user:bot navíc, aby zprávy poslané app access tokenem
// nesly odznak „Chat Bot" (Helix Send Chat Message: app token + user:bot u bota +
// channel:bot u broadcastera nebo mod). Bez toho jde fallback user tokenem (bez odznaku).
export const BOT_SCOPES = ['user:write:chat', 'user:bot'] as const;
// Souhlas broadcastera s botem v jeho kanálu (jen kvůli odznaku; token se neukládá).
export const BROADCASTER_BOT_SCOPES = ['channel:bot'] as const;

// App access token (client credentials) — cache do expirace, invalidace při 401.
let appToken: { token: string; exp: number } | null = null;
export async function getAppAccessToken(fetchImpl: typeof fetch = fetch): Promise<string> {
  if (appToken && appToken.exp - 60_000 > Date.now()) return appToken.token;
  const body = new URLSearchParams({ client_id: config.TWITCH_CLIENT_ID, client_secret: config.TWITCH_CLIENT_SECRET, grant_type: 'client_credentials' });
  const resp = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`Twitch app token failed: ${resp.status}`);
  const j = (await resp.json()) as { access_token: string; expires_in: number };
  appToken = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return appToken.token;
}
export function invalidateAppAccessToken(): void { appToken = null; }

export function redirectUri(): string {
  return `${config.PUBLIC_BASE_URL}/streamers/oauth/twitch/callback`;
}

export function buildAuthorizeUrl(state: string, scopes: readonly string[] = SCOPES): string {
  const params = new URLSearchParams({
    client_id: config.TWITCH_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: scopes.join(' '),
    state,
    force_verify: 'true',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export interface TwitchTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string[];
  token_type: string;
}

export async function exchangeCode(code: string): Promise<TwitchTokenResponse> {
  const body = new URLSearchParams({
    client_id: config.TWITCH_CLIENT_ID,
    client_secret: config.TWITCH_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(),
  });
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!resp.ok) {
    // Do NOT include body in error if it could contain token fragments.
    throw new Error(`Twitch token exchange failed: ${resp.status}`);
  }
  return (await resp.json()) as TwitchTokenResponse;
}

export async function refreshAccessToken(refreshToken: string): Promise<TwitchTokenResponse> {
  const body = new URLSearchParams({
    client_id: config.TWITCH_CLIENT_ID,
    client_secret: config.TWITCH_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const resp = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  if (!resp.ok) throw new Error(`Twitch token refresh failed: ${resp.status}`);
  return (await resp.json()) as TwitchTokenResponse;
}

export interface TwitchUserInfo {
  id: string;            // numeric user_id as string
  login: string;         // lowercase handle
  display_name: string;  // cased display name
  profile_image_url?: string;
}

export async function fetchUser(accessToken: string): Promise<TwitchUserInfo> {
  const resp = await fetch(USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Client-Id': config.TWITCH_CLIENT_ID,
    },
  });
  if (!resp.ok) {
    throw new Error(`Twitch /users failed: ${resp.status}`);
  }
  const data = (await resp.json()) as { data?: Array<Partial<TwitchUserInfo>> };
  const u = data.data?.[0];
  if (!u?.id || !u.login) {
    throw new Error('Twitch /users returned no user');
  }
  return {
    id: u.id,
    login: u.login,
    display_name: u.display_name || u.login,
    profile_image_url: u.profile_image_url,
  };
}

export function twitchConfigured(): boolean {
  return Boolean(config.TWITCH_CLIENT_ID && config.TWITCH_CLIENT_SECRET);
}
