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

// Účet bota → množina workspaců, které jím mluví ('_shared' = všechny). Klíč je id účtu
// na platformě (`platform#id`) i login (`platform:login`): id se nemění a ingest ho má
// vždy, login je záloha. Kick: ingest nese sender.username, identita slug — liší se
// (Jouki_BOT vs jouki-bot), takže jen podle loginu by zpráva bota nedostala isBot a
// Židolišta by ji vyhodnotila jako command (bezpečnostní audit 2026-09-24).
const botLogins = new Map<string, Set<string>>();

const loginKey = (platform: string, login: string) => `${platform}:${String(login).toLowerCase()}`;
const idKey = (platform: string, id: string) => `${platform}#${id}`;

export function rememberBot(platform: string, login: string, workspace: string, platformUserId?: string | null): void {
  const keys = [loginKey(platform, login)];
  if (platformUserId) keys.push(idKey(platform, String(platformUserId)));
  for (const k of keys) {
    const s = botLogins.get(k) ?? new Set<string>();
    s.add(workspace);
    botLogins.set(k, s);
  }
}

/** Jen pro testy. */
export function _resetBotsForTest(): void { botLogins.clear(); }

/** Načíst loginy botů do paměti (boot). */
export async function loadBotLogins(): Promise<number> {
  const rows = await db.select({ workspace: botIdentities.workspace, platform: botIdentities.platform, login: botIdentities.login, platformUserId: botIdentities.platformUserId }).from(botIdentities);
  botLogins.clear();
  for (const r of rows) rememberBot(r.platform, r.login, r.workspace, r.platformUserId);
  return rows.length;
}

/** Píše tuhle zprávu bot daného workspace (sdílený nebo vlastní)? Shoda podle id účtu nebo loginu. */
export function isBotAuthor(platform: string, login: string, workspace: string, platformUserId?: string | null): boolean {
  const sets = [botLogins.get(loginKey(platform, login))];
  if (platformUserId) sets.push(botLogins.get(idKey(platform, String(platformUserId))));
  return sets.some((s) => !!s && (s.has(SHARED) || s.has(workspace)));
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
  rememberBot(platform, identity.login, workspace, identity.platformUserId);
}

export async function storeBotTokens(workspace: string, platform: Platform, tokens: TokenSet): Promise<void> {
  await db.update(botIdentities).set({ ...encryptedColumns(tokens), state: 'online' }).where(and(eq(botIdentities.workspace, workspace), eq(botIdentities.platform, platform)));
}

export async function markBotExpired(workspace: string, platform: Platform): Promise<void> {
  await db.update(botIdentities).set({ state: 'expired', updatedAt: new Date() }).where(and(eq(botIdentities.workspace, workspace), eq(botIdentities.platform, platform)));
}

export async function deleteBotIdentity(workspace: string, platform: Platform): Promise<boolean> {
  const rows = await db.delete(botIdentities).where(and(eq(botIdentities.workspace, workspace), eq(botIdentities.platform, platform))).returning({ login: botIdentities.login, platformUserId: botIdentities.platformUserId });
  for (const r of rows) {
    botLogins.get(loginKey(platform, r.login))?.delete(workspace);
    botLogins.get(idKey(platform, r.platformUserId))?.delete(workspace);
  }
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
