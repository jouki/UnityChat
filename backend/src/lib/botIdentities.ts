// Identity chat bota Židolišty: tabulka bot_identities (workspace slug nebo
// '_shared' × platforma). Tokeny šifrované jako u web_identities, nikdy ven.
// `isBotAuthor` drží loginy botů v paměti (ingest onLive je synchronní).
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { botIdentities, botChannelGrants } from '../db/schema.js';
import { decryptToken } from './crypto.js';
import { encryptedColumns, type IdentityInfo, type TokenSet } from './webAuth.js';
import type { Platform } from './zidolista.js';

export const SHARED = '_shared';

export interface BotIdentity {
  workspace: string;
  platform: Platform;
  platformUserId: string;
  login: string;
  displayName: string | null;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  state: string;
}

export type BotState = 'online' | 'expired' | 'missing';

// platform:login → množina workspaců, které tímto účtem mluví ('_shared' = všechny)
const botLogins = new Map<string, Set<string>>();

function remember(platform: string, login: string, workspace: string): void {
  const k = `${platform}:${login.toLowerCase()}`;
  const s = botLogins.get(k) ?? new Set<string>();
  s.add(workspace);
  botLogins.set(k, s);
}

/** Načíst loginy botů do paměti (boot). */
export async function loadBotLogins(): Promise<number> {
  const rows = await db.select({ workspace: botIdentities.workspace, platform: botIdentities.platform, login: botIdentities.login }).from(botIdentities);
  botLogins.clear();
  for (const r of rows) remember(r.platform, r.login, r.workspace);
  return rows.length;
}

/** Píše tuhle zprávu bot daného workspace (sdílený nebo vlastní)? */
export function isBotAuthor(platform: string, login: string, workspace: string): boolean {
  const s = botLogins.get(`${platform}:${String(login).toLowerCase()}`);
  return !!s && (s.has(SHARED) || s.has(workspace));
}

export async function upsertBotIdentity(workspace: string, platform: Platform, identity: IdentityInfo, tokens: TokenSet): Promise<void> {
  const cols = encryptedColumns(tokens);
  await db
    .insert(botIdentities)
    .values({ workspace, platform, platformUserId: identity.platformUserId, login: identity.login.toLowerCase(), displayName: identity.displayName || null, avatarUrl: identity.avatarUrl || null, state: 'online', ...cols })
    .onConflictDoUpdate({
      target: [botIdentities.workspace, botIdentities.platform],
      set: { platformUserId: identity.platformUserId, login: identity.login.toLowerCase(), displayName: identity.displayName || null, avatarUrl: identity.avatarUrl || null, state: 'online', ...cols },
    });
  remember(platform, identity.login, workspace);
}

export async function storeBotTokens(workspace: string, platform: Platform, tokens: TokenSet): Promise<void> {
  await db.update(botIdentities).set({ ...encryptedColumns(tokens), state: 'online' }).where(and(eq(botIdentities.workspace, workspace), eq(botIdentities.platform, platform)));
}

export async function markBotExpired(workspace: string, platform: Platform): Promise<void> {
  await db.update(botIdentities).set({ state: 'expired', updatedAt: new Date() }).where(and(eq(botIdentities.workspace, workspace), eq(botIdentities.platform, platform)));
}

export async function deleteBotIdentity(workspace: string, platform: Platform): Promise<boolean> {
  const rows = await db.delete(botIdentities).where(and(eq(botIdentities.workspace, workspace), eq(botIdentities.platform, platform))).returning({ login: botIdentities.login });
  for (const r of rows) botLogins.get(`${platform}:${r.login}`)?.delete(workspace);
  return rows.length > 0;
}

async function readIdentity(workspace: string, platform: Platform): Promise<BotIdentity | null> {
  const rows = await db.select().from(botIdentities).where(and(eq(botIdentities.workspace, workspace), eq(botIdentities.platform, platform))).limit(1);
  if (!rows.length) return null;
  const r = rows[0];
  const accessToken = decryptToken({ ciphertext: r.accessTokenEncrypted, iv: r.tokenIv, authTag: r.tokenAuthTag, keyVersion: r.keyVersion });
  const refreshToken = r.refreshTokenEncrypted && r.refreshIv && r.refreshAuthTag
    ? decryptToken({ ciphertext: r.refreshTokenEncrypted, iv: r.refreshIv, authTag: r.refreshAuthTag, keyVersion: r.keyVersion })
    : null;
  return { workspace: r.workspace, platform: r.platform as Platform, platformUserId: r.platformUserId, login: r.login, displayName: r.displayName, accessToken, refreshToken, expiresAt: r.expiresAt, state: r.state };
}

/** Identita, kterou workspace na platformě mluví: vlastní, jinak sdílená. */
export async function getBotIdentity(workspace: string, platform: Platform, preferOwn = true): Promise<BotIdentity | null> {
  if (preferOwn) { const own = await readIdentity(workspace, platform); if (own) return own; }
  return readIdentity(SHARED, platform);
}

// ---- souhlas broadcastera s botem v kanálu (Twitch channel:bot → odznak) ----
export async function upsertChannelGrant(workspace: string, platform: Platform, identity: IdentityInfo): Promise<void> {
  await db
    .insert(botChannelGrants)
    .values({ workspace, platform, login: identity.login.toLowerCase(), platformUserId: identity.platformUserId, grantedAt: new Date() })
    .onConflictDoUpdate({ target: [botChannelGrants.workspace, botChannelGrants.platform], set: { login: identity.login.toLowerCase(), platformUserId: identity.platformUserId, grantedAt: new Date() } });
}

export async function deleteChannelGrant(workspace: string, platform: Platform): Promise<boolean> {
  const rows = await db.delete(botChannelGrants).where(and(eq(botChannelGrants.workspace, workspace), eq(botChannelGrants.platform, platform))).returning({ login: botChannelGrants.login });
  return rows.length > 0;
}

export async function botStatus(workspace: string): Promise<{
  shared: Record<Platform, { state: BotState; login?: string }>;
  own: Record<Platform, { state: BotState; login?: string }>;
  channelGrant: Record<Platform, { granted: boolean; login?: string; grantedAt?: string }>;
}> {
  const rows = await db.select({ workspace: botIdentities.workspace, platform: botIdentities.platform, login: botIdentities.login, state: botIdentities.state }).from(botIdentities);
  const empty = (): Record<Platform, { state: BotState; login?: string }> => ({ twitch: { state: 'missing' }, kick: { state: 'missing' }, youtube: { state: 'missing' } });
  const out = { shared: empty(), own: empty(), channelGrant: { twitch: { granted: false }, kick: { granted: false }, youtube: { granted: false } } as Record<Platform, { granted: boolean; login?: string; grantedAt?: string }> };
  for (const r of rows) {
    const bucket = r.workspace === SHARED ? out.shared : r.workspace === workspace ? out.own : null;
    if (!bucket) continue;
    bucket[r.platform as Platform] = { state: r.state === 'expired' ? 'expired' : 'online', login: r.login };
  }
  const grants = await db.select().from(botChannelGrants).where(eq(botChannelGrants.workspace, workspace));
  for (const g of grants) out.channelGrant[g.platform as Platform] = { granted: true, login: g.login, grantedAt: g.grantedAt.toISOString() };
  return out;
}
