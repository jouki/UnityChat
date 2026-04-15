import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';

// Kick OAuth 2.1 — PKCE is MANDATORY (even for confidential clients).
// Docs: https://docs.kick.com/getting-started/generating-tokens-oauth2-flow
//       https://docs.kick.com/apis/users

const AUTHORIZE_URL = 'https://id.kick.com/oauth/authorize';
const TOKEN_URL = 'https://id.kick.com/oauth/token';
const USERS_URL = 'https://api.kick.com/public/v1/users';

// Minimal scope — reads username + streamer ID.
const SCOPES = ['user:read'] as const;

export function redirectUri(): string {
  return `${config.PUBLIC_BASE_URL}/streamers/oauth/kick/callback`;
}

// PKCE: generate a random code_verifier (43–128 chars of URL-safe alphabet).
// code_challenge = base64url(SHA256(code_verifier)).
export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthorizeUrl(state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    client_id: config.KICK_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export interface KickTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

export async function exchangeCode(code: string, codeVerifier: string): Promise<KickTokenResponse> {
  const body = new URLSearchParams({
    client_id: config.KICK_CLIENT_ID,
    client_secret: config.KICK_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(),
    code_verifier: codeVerifier,
  });
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!resp.ok) {
    throw new Error(`Kick token exchange failed: ${resp.status}`);
  }
  return (await resp.json()) as KickTokenResponse;
}

export interface KickUserInfo {
  userId: string;        // numeric user_id as string
  name: string;          // username (Kick usernames are case-insensitive, slug-like)
  avatarUrl?: string;
}

export async function fetchUser(accessToken: string): Promise<KickUserInfo> {
  const resp = await fetch(USERS_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!resp.ok) {
    throw new Error(`Kick /users failed: ${resp.status}`);
  }
  const data = (await resp.json()) as {
    data?: Array<{
      user_id?: number | string;
      name?: string;
      profile_picture?: string;
    }>;
  };
  const u = data.data?.[0];
  if (!u?.user_id || !u.name) {
    throw new Error('Kick /users returned no user');
  }
  return {
    userId: String(u.user_id),
    name: u.name,
    avatarUrl: u.profile_picture,
  };
}

export function kickConfigured(): boolean {
  return Boolean(config.KICK_CLIENT_ID && config.KICK_CLIENT_SECRET);
}
