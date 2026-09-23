import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { webAccounts, webIdentities, webSessions } from '../db/schema.js';
import { encryptToken, decryptToken } from './crypto.js';
import { config } from './../config.js';

/**
 * Web verze (robdiesalot.com/chat): účty návštěvníků + platformní identity
 * s OAuth tokeny (šifrované jako streamer_tokens) + session přes Bearer token.
 *
 * Proč Bearer a ne cookie: web (robdiesalot.com) a API (api.jouki.cz) jsou
 * cross-site, cookie by byla third-party. Session = 32 B random, klient drží
 * raw (localStorage), DB jen SHA-256 hash. Po OAuth callbacku se raw token
 * nepředává v redirectu přímo — jde jednorázový kód (60 s), který web vymění
 * přes POST /auth/exchange (kód v URL fragmentu se nikdy neloguje na serveru).
 */

export type Platform = 'twitch' | 'youtube' | 'kick';
export const PLATFORMS: readonly Platform[] = ['twitch', 'youtube', 'kick'] as const;

export const WEB_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 60 * 1000;

declare module 'fastify' {
  interface FastifyRequest {
    webAccountId?: number;
  }
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function allowedOrigins(): string[] {
  return config.WEB_ORIGINS.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

/** returnTo musí být https/http URL s originem z WEB_ORIGINS (bez open redirectu). */
export function isAllowedReturnTo(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.username || u.password) return false;
    // Addon: chrome.identity.launchWebAuthFlow vrací na https://<id>.chromiumapp.org/ (id = 32× a–p).
    if (/^https:\/\/[a-p]{32}\.chromiumapp\.org$/.test(u.origin)) return true;
    // Firefox: identity.getRedirectURL() = https://<sha1 hash ID doplňku, 40 hex>.extensions.allizom.org/.
    if (/^https:\/\/[0-9a-f]{40}\.extensions\.allizom\.org$/.test(u.origin)) return true;
    return allowedOrigins().includes(u.origin);
  } catch {
    return false;
  }
}

// ---- one-time codes (in-memory; jeden proces) ------------------------------
const codes = new Map<string, { token: string; exp: number }>();

export function issueCode(sessionToken: string, now = Date.now()): string {
  for (const [k, v] of codes) if (v.exp < now) codes.delete(k);
  const code = randomBytes(24).toString('base64url');
  codes.set(code, { token: sessionToken, exp: now + CODE_TTL_MS });
  return code;
}

export function consumeCode(code: string, now = Date.now()): string | null {
  const hit = codes.get(code);
  if (!hit) return null;
  codes.delete(code);
  return hit.exp >= now ? hit.token : null;
}

// ---- sessions ------------------------------------------------------------
export async function createWebSession(accountId: number): Promise<string> {
  const raw = randomBytes(32).toString('hex');
  await db.insert(webSessions).values({
    tokenHash: hashToken(raw),
    accountId,
    expiresAt: new Date(Date.now() + WEB_SESSION_TTL_MS),
  });
  return raw;
}

export async function validateWebSession(raw: string): Promise<number | null> {
  if (!/^[0-9a-f]{64}$/.test(raw)) return null;
  const h = hashToken(raw);
  const rows = await db
    .select({ accountId: webSessions.accountId, expiresAt: webSessions.expiresAt })
    .from(webSessions)
    .where(eq(webSessions.tokenHash, h))
    .limit(1);
  if (!rows.length) return null;
  if (rows[0].expiresAt.getTime() < Date.now()) {
    await db.delete(webSessions).where(eq(webSessions.tokenHash, h));
    return null;
  }
  const now = new Date();
  await db
    .update(webSessions)
    .set({ lastUsedAt: now, expiresAt: new Date(Date.now() + WEB_SESSION_TTL_MS) })
    .where(eq(webSessions.tokenHash, h));
  await db.update(webAccounts).set({ lastSeenAt: now }).where(eq(webAccounts.id, rows[0].accountId));
  return rows[0].accountId;
}

export async function deleteWebSession(raw: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(raw)) return;
  await db.delete(webSessions).where(eq(webSessions.tokenHash, hashToken(raw)));
}

export function bearerToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+([0-9a-f]{64})$/i);
  return m ? m[1].toLowerCase() : null;
}

export async function requireWebSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const raw = bearerToken(req);
  if (!raw) { reply.code(401); return reply.send({ ok: false, error: 'no session' }); }
  const accountId = await validateWebSession(raw);
  if (accountId === null) { reply.code(401); return reply.send({ ok: false, error: 'invalid session' }); }
  req.webAccountId = accountId;
}

// ---- identity + tokens ----------------------------------------------------
export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scopes: string[];
}

export interface IdentityInfo {
  platformUserId: string;
  login: string;
  displayName?: string;
  avatarUrl?: string;
}

export function encryptedColumns(tokens: TokenSet) {
  const accessEnc = encryptToken(tokens.accessToken);
  const refreshEnc = tokens.refreshToken ? encryptToken(tokens.refreshToken) : null;
  return {
    accessTokenEncrypted: accessEnc.ciphertext,
    refreshTokenEncrypted: refreshEnc?.ciphertext || null,
    tokenIv: accessEnc.iv,
    tokenAuthTag: accessEnc.authTag,
    refreshIv: refreshEnc?.iv || null,
    refreshAuthTag: refreshEnc?.authTag || null,
    expiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
    scopes: tokens.scopes,
    keyVersion: accessEnc.keyVersion,
    updatedAt: new Date(),
  };
}

/**
 * Dokončení OAuth přihlášení na webu: identita (platform, platformUserId) →
 * existující účet; jinak účet ze session (napojení další platformy); jinak nový.
 * Vrací raw session token (klient si ho uloží).
 */
export async function completeWebLogin(
  platform: Platform,
  identity: IdentityInfo,
  tokens: TokenSet,
  existingAccountId: number | null,
): Promise<{ accountId: number; sessionToken: string }> {
  let accountId: number | null = null;
  const known = await db
    .select({ accountId: webIdentities.accountId })
    .from(webIdentities)
    .where(and(eq(webIdentities.platform, platform), eq(webIdentities.platformUserId, identity.platformUserId)))
    .limit(1);
  if (known.length) accountId = known[0].accountId;
  else if (existingAccountId !== null) accountId = existingAccountId;
  if (accountId === null) {
    const ins = await db.insert(webAccounts).values({}).returning({ id: webAccounts.id });
    accountId = ins[0].id;
  }

  const cols = encryptedColumns(tokens);
  await db
    .insert(webIdentities)
    .values({
      accountId,
      platform,
      platformUserId: identity.platformUserId,
      login: identity.login.toLowerCase(),
      displayName: identity.displayName || null,
      avatarUrl: identity.avatarUrl || null,
      ...cols,
    })
    .onConflictDoUpdate({
      target: [webIdentities.accountId, webIdentities.platform],
      set: {
        platformUserId: identity.platformUserId,
        login: identity.login.toLowerCase(),
        displayName: identity.displayName || null,
        avatarUrl: identity.avatarUrl || null,
        ...cols,
      },
    });

  const sessionToken = await createWebSession(accountId);
  return { accountId, sessionToken };
}

export interface PublicIdentity {
  platform: Platform;
  login: string;
  displayName: string | null;
  avatarUrl: string | null;
  platformUserId: string;
}

export async function listIdentities(accountId: number): Promise<PublicIdentity[]> {
  const rows = await db
    .select({
      platform: webIdentities.platform,
      login: webIdentities.login,
      displayName: webIdentities.displayName,
      avatarUrl: webIdentities.avatarUrl,
      platformUserId: webIdentities.platformUserId,
    })
    .from(webIdentities)
    .where(eq(webIdentities.accountId, accountId));
  return rows as PublicIdentity[];
}

export interface DecryptedIdentity extends PublicIdentity {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
}

export async function getDecryptedIdentity(accountId: number, platform: Platform): Promise<DecryptedIdentity | null> {
  const rows = await db
    .select()
    .from(webIdentities)
    .where(and(eq(webIdentities.accountId, accountId), eq(webIdentities.platform, platform)))
    .limit(1);
  if (!rows.length) return null;
  const r = rows[0];
  const accessToken = decryptToken({ ciphertext: r.accessTokenEncrypted, iv: r.tokenIv, authTag: r.tokenAuthTag, keyVersion: r.keyVersion });
  const refreshToken = r.refreshTokenEncrypted && r.refreshIv && r.refreshAuthTag
    ? decryptToken({ ciphertext: r.refreshTokenEncrypted, iv: r.refreshIv, authTag: r.refreshAuthTag, keyVersion: r.keyVersion })
    : null;
  return {
    platform: r.platform as Platform,
    login: r.login,
    displayName: r.displayName,
    avatarUrl: r.avatarUrl,
    platformUserId: r.platformUserId,
    accessToken,
    refreshToken,
    expiresAt: r.expiresAt,
    scopes: r.scopes || [],
  };
}

export async function storeRefreshedTokens(accountId: number, platform: Platform, tokens: TokenSet): Promise<void> {
  await db
    .update(webIdentities)
    .set(encryptedColumns(tokens))
    .where(and(eq(webIdentities.accountId, accountId), eq(webIdentities.platform, platform)));
}

export async function unlinkIdentity(accountId: number, platform: Platform): Promise<void> {
  await db.delete(webIdentities).where(and(eq(webIdentities.accountId, accountId), eq(webIdentities.platform, platform)));
}

/** Token obnovit, když chybí expirace (nevíme) nebo vyprší do minuty. */
export function needsRefresh(expiresAt: Date | null, now = Date.now(), skewMs = 60_000): boolean {
  if (!expiresAt) return true;
  return expiresAt.getTime() - skewMs <= now;
}
