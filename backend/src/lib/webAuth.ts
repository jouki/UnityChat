import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
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
 * nepředává v redirectu přímo — jde jednorázový kód (5 min), který web vymění
 * přes POST /auth/exchange (kód v URL fragmentu se nikdy neloguje na serveru).
 * Účet a session vznikají až při výměně, viz „čekající přihlášení" níže.
 */

export type Platform = 'twitch' | 'youtube' | 'kick';
export const PLATFORMS: readonly Platform[] = ['twitch', 'youtube', 'kick'] as const;

export const WEB_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Kód z #uc_code: v paměti čeká identita + tokeny, dokud ho klient nevymění (POST /auth/exchange).
export const CODE_TTL_MS = 5 * 60 * 1000;

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

function csv(s: string): string[] {
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

/**
 * Originy rozšíření, na které smí OAuth vrátit #uc_code (I1, 2026-09-26): jen NAŠE rozšíření.
 * Chrome: chrome.identity.getRedirectURL() = https://<ID rozšíření>.chromiumapp.org/.
 * Firefox: identity.getRedirectURL() = https://<sha1(ID doplňku) hex>.extensions.allizom.org/
 * (Firefox ext-identity computeHash: SHA-1 nad UTF-8 ID doplňku) — hash se počítá z gecko ID.
 * Dřív prošlo libovolné rozšíření → cizí addon mohl pustit náš login a dostat session uživatele.
 */
export function allowedExtensionReturnOrigins(): Set<string> {
  const out = new Set<string>();
  for (const id of csv(config.ALLOWED_AUTH_EXTENSION_IDS)) {
    if (/^[a-p]{32}$/.test(id)) out.add(`https://${id}.chromiumapp.org`);
  }
  for (const id of csv(config.ALLOWED_AUTH_FIREFOX_ADDON_IDS)) {
    out.add(`https://${createHash('sha1').update(id, 'utf8').digest('hex')}.extensions.allizom.org`);
  }
  return out;
}

/** returnTo musí být URL s originem z WEB_ORIGINS nebo našeho rozšíření (bez open redirectu). */
export function isAllowedReturnTo(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.username || u.password) return false;
    if (allowedExtensionReturnOrigins().has(u.origin)) return true;
    return allowedOrigins().includes(u.origin);
  } catch {
    return false;
  }
}

// ---- čekající přihlášení pod jednorázovým kódem (in-memory; jeden proces) ----
//
// Login CSRF (C1, 2026-09-26): callback dřív rovnou připojil identitu k účtu ze state
// (`webAccountId` = kdo flow SPUSTIL). Útočník si pustil start se svou session a autorizační
// URL poslal oběti → identita i tokeny oběti skončily na jeho účtu. Teď callback do DB nesahá:
// tokeny + identita čekají pod jednorázovým kódem, který jde jen do prohlížeče, co dokončil
// souhlas (fragment returnTo). K účtu ze state se připojí až v POST /auth/exchange, a jen když
// požadavek nese Bearer session TÉHOŽ účtu (resolveLinkTarget). Jinak běžné přihlášení.
// ⚠ Paměť jednoho procesu: při více instancích backendu přesunout do DB (sticky nestačí,
// callback a exchange jsou dva nezávislé požadavky).

export interface PendingLogin {
  platform: Platform;
  identity: IdentityInfo;
  tokens: TokenSet;
  /** Záměr napojit na tento účet (Bearer při /auth/:platform/start). Splní se jen s Bearerem téhož účtu. */
  linkAccountId: number | null;
}

const pendingLogins = new Map<string, PendingLogin & { exp: number }>();

export function issuePendingCode(p: PendingLogin, now = Date.now()): string {
  for (const [k, v] of pendingLogins) if (v.exp < now) pendingLogins.delete(k);
  const code = randomBytes(24).toString('base64url');
  pendingLogins.set(code, { ...p, exp: now + CODE_TTL_MS });
  return code;
}

/** Jednorázové: po prvním pokusu (i po expiraci) je kód pryč. */
export function consumePendingCode(code: string, now = Date.now()): PendingLogin | null {
  const hit = pendingLogins.get(code);
  if (!hit) return null;
  pendingLogins.delete(code);
  if (hit.exp < now) return null;
  const { exp: _exp, ...rest } = hit;
  return rest;
}

/** Napojit na účet ze state jen tehdy, když ho výměnu posílá session téhož účtu. */
export function resolveLinkTarget(linkAccountId: number | null, bearerAccountId: number | null): number | null {
  return linkAccountId !== null && bearerAccountId !== null && linkAccountId === bearerAccountId ? linkAccountId : null;
}

export interface ExchangeDeps {
  validateSession: (raw: string) => Promise<number | null>;
  completeLogin: typeof completeWebLogin;
}

/**
 * POST /auth/exchange: kód → session. `bearerRaw` = session, kterou klient poslal (nebo null).
 * null = kód neplatný / vypršel / už použitý.
 */
export async function exchangePendingCode(
  code: string,
  bearerRaw: string | null,
  deps: ExchangeDeps = { validateSession: validateWebSession, completeLogin: completeWebLogin },
  now = Date.now(),
): Promise<{ accountId: number; sessionToken: string; linked: boolean; linkRefused: boolean } | null> {
  const p = consumePendingCode(code, now);
  if (!p) return null;
  const bearerAccountId = p.linkAccountId !== null && bearerRaw ? await deps.validateSession(bearerRaw) : null;
  const target = resolveLinkTarget(p.linkAccountId, bearerAccountId);
  const { accountId, sessionToken } = await deps.completeLogin(p.platform, p.identity, p.tokens, target);
  return { accountId, sessionToken, linked: target !== null, linkRefused: p.linkAccountId !== null && target === null };
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

/**
 * „Odhlásit se" = odhlásit všechny platformy účtu (pokyn usera 2026-09-24, web i addon):
 * identity se označí jako odhlášené a tokeny se zahodí, všechny session účtu končí.
 * Identita v DB zůstává, aby další přihlášení vrátilo stejný účet (oblíbené zvuky…),
 * ale počítá se jen platforma, přes kterou se člověk přihlásí znovu.
 */
export async function signOutAccount(accountId: number, now = new Date()): Promise<void> {
  const empty = Buffer.alloc(0);
  await db
    .update(webIdentities)
    .set({
      signedOutAt: now,
      accessTokenEncrypted: empty, tokenIv: empty, tokenAuthTag: empty,
      refreshTokenEncrypted: null, refreshIv: null, refreshAuthTag: null,
      expiresAt: null, updatedAt: now,
    })
    .where(eq(webIdentities.accountId, accountId));
  await db.delete(webSessions).where(eq(webSessions.accountId, accountId));
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
 * existující účet; jinak `existingAccountId` (napojení další platformy — volá se jen
 * s účtem ověřeným Bearerem při výměně kódu, exchangePendingCode); jinak nový.
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
        signedOutAt: null,
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
    .where(and(eq(webIdentities.accountId, accountId), isNull(webIdentities.signedOutAt)));
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
    .where(and(eq(webIdentities.accountId, accountId), eq(webIdentities.platform, platform), isNull(webIdentities.signedOutAt)))
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
