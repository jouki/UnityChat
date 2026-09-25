// Obnova OAuth tokenu platformy — jediné místo pro /chat/send, bota i moderaci.
// Twitch vrací scope jako pole, Kick/YouTube jako řetězec; YouTube nový refresh token neposílá.
import * as twitch from './oauthTwitch.js';
import * as youtube from './oauthYoutube.js';
import * as kick from './oauthKick.js';
import type { TokenSet } from './webAuth.js';
import type { Platform } from './zidolista.js';

export async function refreshTokens(platform: Platform, refreshToken: string): Promise<TokenSet> {
  if (platform === 'twitch') {
    const r = await twitch.refreshAccessToken(refreshToken);
    return { accessToken: r.access_token, refreshToken: r.refresh_token || refreshToken, expiresIn: r.expires_in, scopes: r.scope };
  }
  if (platform === 'kick') {
    const r = await kick.refreshAccessToken(refreshToken);
    return { accessToken: r.access_token, refreshToken: r.refresh_token || refreshToken, expiresIn: r.expires_in, scopes: r.scope.split(' ').filter(Boolean) };
  }
  const r = await youtube.refreshAccessToken(refreshToken);
  return { accessToken: r.access_token, refreshToken, expiresIn: r.expires_in, scopes: r.scope.split(' ').filter(Boolean) };
}
