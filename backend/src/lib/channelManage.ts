// Správa kanálu streamera z Židolišty (2026-09-30): přepnutí kategorie streamu na Twitchi a Kicku
// — jako `!g <kategorie>` u StreamElements. Platformy to dovolí JEN tokenem majitele kanálu
// (Twitch PATCH /channels s channel:manage:broadcast, Kick PATCH /channels s channel:write), proto
// se použije identita streamera z web_identities (přihlášení „Povolit správu kanálu“ v UnityChatu,
// lib/broadcasterScopes.ts) — stejné úložiště a obnova tokenů jako u posílání zpráv účtem.
// Hledání kategorií jde app tokenem (Twitch search/categories, Kick categories?q=).
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { webIdentities } from '../db/schema.js';
import { getDecryptedIdentity, storeRefreshedTokens, needsRefresh, type DecryptedIdentity } from './webAuth.js';
import { refreshTokens } from './platformTokens.js';
import { CATEGORY_SCOPE } from './broadcasterScopes.js';
import * as twitch from './oauthTwitch.js';
import * as kick from './oauthKick.js';
import { config } from '../config.js';
import type { Platform } from './zidolista.js';

export type CategoryPlatform = 'twitch' | 'kick';
export interface Category { id: string; name: string; imageUrl: string | null }

export class ChannelError extends Error {
  constructor(public code: 'not_linked' | 'missing_scope' | 'token' | 'not_found' | 'platform' | 'unsupported', message: string, public status = 400) { super(message); }
}

/** Identita majitele kanálu (login = kanál) s obnovou tokenu; ChannelError not_linked / missing_scope. */
export async function broadcasterIdentity(platform: CategoryPlatform, channelLogin: string): Promise<{ accountId: number; ident: DecryptedIdentity }> {
  const rows = await db.select({ accountId: webIdentities.accountId })
    .from(webIdentities)
    .where(and(eq(webIdentities.platform, platform), eq(webIdentities.login, channelLogin.toLowerCase()), isNull(webIdentities.signedOutAt)))
    .limit(1);
  if (!rows.length) throw new ChannelError('not_linked', `${platform}: streamer není přihlášený v UnityChatu`, 403);
  const accountId = rows[0].accountId;
  let ident = await getDecryptedIdentity(accountId, platform);
  if (!ident) throw new ChannelError('not_linked', `${platform}: streamer není přihlášený v UnityChatu`, 403);
  const need = CATEGORY_SCOPE[platform];
  if (need && !ident.scopes.includes(need)) throw new ChannelError('missing_scope', `${platform}: chybí oprávnění ${need} (Povolit správu kanálu)`, 403);
  if (needsRefresh(ident.expiresAt)) {
    if (!ident.refreshToken) throw new ChannelError('token', `${platform}: token vypršel, streamer se musí přihlásit znovu`, 401);
    const t = await refreshTokens(platform, ident.refreshToken);
    await storeRefreshedTokens(accountId, platform, t);
    ident = { ...ident, accessToken: t.accessToken, refreshToken: t.refreshToken || null, expiresAt: new Date(Date.now() + t.expiresIn * 1000), scopes: t.scopes.length ? t.scopes : ident.scopes };
  }
  return { accountId, ident };
}

/** Stav pro dashboard Židolišty: je streamer přihlášený a má scope na kategorii? */
export async function channelStatus(channels: Partial<Record<Platform, string | null | undefined>>): Promise<Record<CategoryPlatform, { linked: boolean; canSetCategory: boolean; login: string | null }>> {
  const out = {} as Record<CategoryPlatform, { linked: boolean; canSetCategory: boolean; login: string | null }>;
  for (const platform of ['twitch', 'kick'] as const) {
    const login = channels[platform]?.toLowerCase() || null;
    if (!login) { out[platform] = { linked: false, canSetCategory: false, login: null }; continue; }
    const rows = await db.select({ scopes: webIdentities.scopes })
      .from(webIdentities)
      .where(and(eq(webIdentities.platform, platform), eq(webIdentities.login, login), isNull(webIdentities.signedOutAt)))
      .limit(1);
    const need = CATEGORY_SCOPE[platform];
    out[platform] = { linked: rows.length > 0, canSetCategory: rows.length > 0 && (!need || (rows[0].scopes ?? []).includes(need)), login };
  }
  return out;
}

const TWITCH_HELIX = 'https://api.twitch.tv/helix';
const KICK_API = 'https://api.kick.com/public/v1';

/** Hledání kategorií (app token). Twitch vrací až 10, Kick podle dotazu. */
export async function searchCategories(platform: CategoryPlatform, q: string, fetchImpl: typeof fetch = fetch): Promise<Category[]> {
  const query = q.trim().slice(0, 100);
  if (!query) return [];
  if (platform === 'twitch') {
    const token = await twitch.getAppAccessToken(fetchImpl);
    const resp = await fetchImpl(`${TWITCH_HELIX}/search/categories?query=${encodeURIComponent(query)}&first=10`, {
      headers: { Authorization: `Bearer ${token}`, 'Client-Id': config.TWITCH_CLIENT_ID }, signal: AbortSignal.timeout(10_000),
    });
    if (resp.status === 401) twitch.invalidateAppAccessToken();
    if (!resp.ok) throw new ChannelError('platform', `Twitch search/categories ${resp.status}`, 502);
    const j = (await resp.json()) as { data?: Array<{ id: string; name: string; box_art_url?: string }> };
    return (j.data ?? []).map((c) => ({ id: String(c.id), name: c.name, imageUrl: c.box_art_url ? c.box_art_url.replace('{width}', '52').replace('{height}', '72') : null }));
  }
  const token = await kick.getAppAccessToken(fetchImpl);
  const resp = await fetchImpl(`${KICK_API}/categories?q=${encodeURIComponent(query)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000),
  });
  if (resp.status === 401) kick.invalidateAppAccessToken();
  if (!resp.ok) throw new ChannelError('platform', `Kick categories ${resp.status}`, 502);
  const j = (await resp.json()) as { data?: Array<{ id: number | string; name: string; thumbnail?: string }> };
  return (j.data ?? []).slice(0, 10).map((c) => ({ id: String(c.id), name: c.name, imageUrl: c.thumbnail ?? null }));
}

/** Nejlepší shoda pro text z chatu: přesný název (bez ohledu na velikost), jinak první výsledek. */
export function pickCategory(list: Category[], q: string): Category | null {
  const want = q.trim().toLowerCase();
  return list.find((c) => c.name.toLowerCase() === want) ?? list[0] ?? null;
}

/** Nastaví kategorii kanálu tokenem majitele. Vrací nastavenou kategorii. */
export async function setCategory(platform: CategoryPlatform, channelLogin: string, category: Category, fetchImpl: typeof fetch = fetch): Promise<Category> {
  const { ident } = await broadcasterIdentity(platform, channelLogin);
  if (platform === 'twitch') {
    const resp = await fetchImpl(`${TWITCH_HELIX}/channels?broadcaster_id=${encodeURIComponent(ident.platformUserId)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${ident.accessToken}`, 'Client-Id': config.TWITCH_CLIENT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({ game_id: category.id }), signal: AbortSignal.timeout(10_000),
    });
    if (resp.status === 401) throw new ChannelError('token', 'Twitch: token odmítnut, streamer se musí přihlásit znovu', 401);
    if (!resp.ok) throw new ChannelError('platform', `Twitch PATCH channels ${resp.status}: ${(await resp.text()).slice(0, 200)}`, 502);
    return category;
  }
  const resp = await fetchImpl(`${KICK_API}/channels`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${ident.accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ category_id: Number(category.id) }), signal: AbortSignal.timeout(10_000),
  });
  if (resp.status === 401) throw new ChannelError('token', 'Kick: token odmítnut, streamer se musí přihlásit znovu', 401);
  if (!resp.ok) throw new ChannelError('platform', `Kick PATCH channels ${resp.status}: ${(await resp.text()).slice(0, 200)}`, 502);
  return category;
}

/** Kategorie z textu (`!g Age of Empires II`): najít a nastavit. not_found, když hledání nic nevrátí. */
export async function setCategoryByQuery(platform: CategoryPlatform, channelLogin: string, q: string, fetchImpl: typeof fetch = fetch): Promise<Category> {
  const found = pickCategory(await searchCategories(platform, q, fetchImpl), q);
  if (!found) throw new ChannelError('not_found', `${platform}: kategorie „${q.trim().slice(0, 60)}“ nenalezena`, 404);
  return setCategory(platform, channelLogin, found, fetchImpl);
}
