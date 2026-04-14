import { config } from '../config.js';

// Google OAuth 2.0 for YouTube identity.
// Docs: https://developers.google.com/identity/protocols/oauth2/web-server
//       https://developers.google.com/youtube/v3/docs/channels/list

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels';

// Minimal — just enough to read the user's own channel id + handle.
// youtube.readonly gives access to channels.list?mine=true.
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
] as const;

export function redirectUri(): string {
  return `${config.PUBLIC_BASE_URL}/streamers/oauth/youtube/callback`;
}

export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
    access_type: 'offline',   // include refresh_token
    prompt: 'consent',        // force refresh_token on repeat auths
    include_granted_scopes: 'true',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
  id_token?: string;
}

export async function exchangeCode(code: string): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    client_secret: config.GOOGLE_CLIENT_SECRET,
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
    throw new Error(`Google token exchange failed: ${resp.status}`);
  }
  return (await resp.json()) as GoogleTokenResponse;
}

export interface YoutubeChannelInfo {
  channelId: string;          // UCxxx
  handle: string;             // @robdiesalot (lowercased, with @ stripped)
  title: string;              // Channel title for display
  avatarUrl?: string;
}

export async function fetchChannel(accessToken: string): Promise<YoutubeChannelInfo> {
  // channels.list?part=id,snippet&mine=true returns the caller's own channel
  const params = new URLSearchParams({ part: 'id,snippet', mine: 'true' });
  const resp = await fetch(`${CHANNELS_URL}?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    throw new Error(`YouTube channels.list failed: ${resp.status}`);
  }
  const data = (await resp.json()) as {
    items?: Array<{
      id?: string;
      snippet?: {
        title?: string;
        customUrl?: string;
        thumbnails?: { default?: { url?: string }; medium?: { url?: string }; high?: { url?: string } };
      };
    }>;
  };
  const item = data.items?.[0];
  if (!item?.id) {
    throw new Error('YouTube channels.list returned no channel');
  }
  // customUrl on channels.list is the @handle (with leading @), or sometimes
  // a legacy custom URL without @. Normalize to handle without @.
  const rawHandle = (item.snippet?.customUrl || '').replace(/^@/, '').toLowerCase();
  return {
    channelId: item.id,
    handle: rawHandle,
    title: item.snippet?.title || '',
    avatarUrl:
      item.snippet?.thumbnails?.medium?.url ||
      item.snippet?.thumbnails?.high?.url ||
      item.snippet?.thumbnails?.default?.url,
  };
}

export function youtubeConfigured(): boolean {
  return Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);
}
