// Tokeny pro zamítnuté GIFy (spec docs/superpowers/specs/2026-09-26-gif-knihovna-design.md §5).
//
// Zamítnuté médium není veřejné: GET /media/gif/:id?t=<token> ho vydá jen s platným tokenem.
//   - token moda: POST /moderation/gif/access-token vydá nový token účtu (vrací ho jen jednou; jeden na zařízení /
//     session, nejvýš 5 aktivních — šestý zneplatní nejstarší); ověření = hash v DB + účet je STÁLE mod kanálu média (accountModIdentities);
//   - integrační token Židolišty (dashboard): platí pro kanál workspace `integration_slug`.
// V DB jen SHA-256 hash (tabulka gif_access_tokens). Token nikdy do logu ani do jiné odpovědi než při vydání.
// Bezpečnost stojí na tajemství na serveru — to, že klienti token do odkazů přidávají, nevadí.
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { gifAccessTokens } from '../db/schema.js';

/** `createdAt`: kdy byl token vydán (TTL tokenu moda, audit L1); chybí = bez TTL. */
export interface GifTokenRow { accountId: number | null; integrationSlug: string | null; createdAt?: Date }

export interface GifTokenStore {
  /** Zneplatní aktivní tokeny vlastníka (účet nebo integrace) kromě `keep` nejnovějších. */
  revokeExcess(owner: { accountId?: number; integrationSlug?: string }, keep: number, at: Date): Promise<void>;
  insert(v: GifTokenRow & { tokenHash: string }): Promise<void>;
  /** Aktivní (nezneplatněný) token podle hashe. */
  findActive(tokenHash: string): Promise<GifTokenRow | null>;
  /** Zneplatní jeden token podle hashe (vyzrazený v chatu, audit L13). */
  revokeHash(tokenHash: string, at: Date): Promise<void>;
}

export const dbGifTokenStore: GifTokenStore = {
  async revokeExcess(owner, keep, at) {
    const who = owner.accountId !== undefined ? eq(gifAccessTokens.accountId, owner.accountId) : eq(gifAccessTokens.integrationSlug, String(owner.integrationSlug));
    const excess = db.select({ id: gifAccessTokens.id }).from(gifAccessTokens)
      .where(and(who, isNull(gifAccessTokens.revokedAt)))
      .orderBy(desc(gifAccessTokens.createdAt), desc(gifAccessTokens.id)).offset(keep);
    await db.update(gifAccessTokens).set({ revokedAt: at }).where(inArray(gifAccessTokens.id, excess));
  },
  async insert(v) { await db.insert(gifAccessTokens).values(v); },
  async revokeHash(tokenHash, at) {
    await db.update(gifAccessTokens).set({ revokedAt: at }).where(and(eq(gifAccessTokens.tokenHash, tokenHash), isNull(gifAccessTokens.revokedAt)));
  },
  async findActive(tokenHash) {
    const rows = await db.select({ accountId: gifAccessTokens.accountId, integrationSlug: gifAccessTokens.integrationSlug, createdAt: gifAccessTokens.createdAt })
      .from(gifAccessTokens).where(and(eq(gifAccessTokens.tokenHash, tokenHash), isNull(gifAccessTokens.revokedAt))).limit(1);
    return rows[0] ?? null;
  },
};

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const newToken = (): string => randomBytes(32).toString('base64url');
const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;

/** Aktivních tokenů na účet (jeden na zařízení / session); nový nad limit zneplatní nejstarší. */
export const MAX_ACCOUNT_TOKENS = 5;
/**
 * Token moda platí 30 dní od vydání (audit L1): kdo ho ukradne (DOM / session úložiště webu), nemá ho napořád.
 * Klient si po vypršení vydá nový (POST /moderation/gif/access-token vrací `expiresAt`; médium s neplatným
 * tokenem = 404 → onError v core/gif.js si řekne o nový). Integrační token Židolišty TTL nemá (zpětná kompatibilita).
 */
export const ACCOUNT_TOKEN_TTL_MS = 30 * 86_400_000;

/** Vydá nový token moda; nad MAX_ACCOUNT_TOKENS zneplatní nejstarší. Vrací token — jediné místo, kde odchází ven. */
export async function issueAccountToken(accountId: number, store: GifTokenStore = dbGifTokenStore, now: () => number = Date.now): Promise<string> {
  const token = newToken();
  await store.insert({ accountId, integrationSlug: null, tokenHash: hashToken(token), createdAt: new Date(now()) });
  await store.revokeExcess({ accountId }, MAX_ACCOUNT_TOKENS, new Date(now()));
  return token;
}

/**
 * Token vložený do veřejného chatu (odkaz `/media/gif/<id>?t=`, audit L13) → zneplatnit; klient si vydá nový.
 * Nesmysl (ne-token) se ignoruje.
 */
export async function revokeTokenValue(token: string, at: Date = new Date(), store: GifTokenStore = dbGifTokenStore): Promise<void> {
  if (!TOKEN_RE.test(token)) return;
  await store.revokeHash(hashToken(token), at);
}

/** Odhlášení účtu (lib/webAuth.ts signOutAccount): všechny jeho tokeny pro zamítnuté GIFy neplatí (audit L1). */
export async function revokeAccountTokens(accountId: number, at: Date = new Date(), store: GifTokenStore = dbGifTokenStore): Promise<void> {
  await store.revokeExcess({ accountId }, 0, at);
}

/** Vydá nový integrační token workspace Židolišty (jeden aktivní — starý zneplatní). */
export async function issueIntegrationToken(slug: string, store: GifTokenStore = dbGifTokenStore, now: () => number = Date.now): Promise<string> {
  const token = newToken();
  const integrationSlug = slug.toLowerCase();
  await store.insert({ accountId: null, integrationSlug, tokenHash: hashToken(token) });
  await store.revokeExcess({ integrationSlug }, 1, new Date(now()));
  return token;
}

export interface GifTokenVerifierDeps {
  store: GifTokenStore;
  /** Je účet mod / broadcaster kanálu (accountModIdentities)? */
  isMod: (accountId: number, channel: string) => Promise<boolean>;
  /** Slug workspace Židolišty pro UC kanál; null = kanál nemá workspace. */
  slugForChannel: (channel: string) => Promise<string | null>;
  now: () => number;
  cacheMs?: number;
}

/**
 * Ověření tokenu pro médium kanálu `channel`. Výsledek (i záporný) se drží 60 s per (hash, kanál) —
 * médium se načítá opakovaně; odebraný mod / zneplatněný token přestane platit nejpozději po minutě.
 */
export function createGifTokenVerifier(deps: GifTokenVerifierDeps) {
  const ttl = deps.cacheMs ?? 60_000;
  const cache = new Map<string, { at: number; ok: boolean }>();
  return async (token: string | undefined | null, channel: string): Promise<boolean> => {
    if (!token || !TOKEN_RE.test(token)) return false;
    const h = hashToken(token);
    const k = `${h}|${channel}`;
    const hit = cache.get(k);
    if (hit && deps.now() - hit.at < ttl) return hit.ok;
    let ok = false;
    try {
      const row = await deps.store.findActive(h);
      const expired = row?.accountId != null && !!row.createdAt && deps.now() - row.createdAt.getTime() > ACCOUNT_TOKEN_TTL_MS;
      if (expired) ok = false;
      else if (row?.accountId != null) ok = await deps.isMod(row.accountId, channel);
      else if (row?.integrationSlug) ok = (await deps.slugForChannel(channel))?.toLowerCase() === row.integrationSlug.toLowerCase();
    } catch { ok = false; }
    if (cache.size > 5000) cache.clear();
    cache.set(k, { at: deps.now(), ok });
    return ok;
  };
}

export type GifTokenVerifier = ReturnType<typeof createGifTokenVerifier>;
