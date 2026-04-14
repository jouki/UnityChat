import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import { db } from '../db/index.js';
import { streamerSessions } from '../db/schema.js';
import { config } from '../config.js';

// Session: random 32 bytes hex, stored in streamer_sessions.
// Sent to extension via URL fragment after OAuth callback; extension persists
// in chrome.storage.local. 90 days idle → expiry. Validation bumps last_used_at.

const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export function randomSessionId(): string {
  return randomBytes(32).toString('hex');
}

export async function createSession(streamerId: number): Promise<string> {
  const sessionId = randomSessionId();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(streamerSessions).values({ sessionId, streamerId, expiresAt });
  return sessionId;
}

export async function validateSession(sessionId: string): Promise<number | null> {
  if (!sessionId || sessionId.length !== 64) return null;
  const rows = await db
    .select({
      streamerId: streamerSessions.streamerId,
      expiresAt: streamerSessions.expiresAt,
    })
    .from(streamerSessions)
    .where(eq(streamerSessions.sessionId, sessionId))
    .limit(1);
  if (rows.length === 0) return null;
  if (rows[0].expiresAt.getTime() < Date.now()) {
    await db.delete(streamerSessions).where(eq(streamerSessions.sessionId, sessionId));
    return null;
  }
  // Bump last_used_at (+ renew expiry sliding-window style).
  const newExpiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db
    .update(streamerSessions)
    .set({ lastUsedAt: new Date(), expiresAt: newExpiresAt })
    .where(eq(streamerSessions.sessionId, sessionId));
  return rows[0].streamerId;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await db.delete(streamerSessions).where(eq(streamerSessions.sessionId, sessionId));
}

export async function cleanExpiredSessions(): Promise<void> {
  await db.delete(streamerSessions).where(lt(streamerSessions.expiresAt, new Date()));
}

// --- State signer (CSRF protection for OAuth flow) ------------------------
// The state param is a JSON payload: { platform, nonce, sessionId?, createdAt }
// signed with HMAC-SHA256 using TOKEN_ENCRYPTION_KEY. The callback verifies
// the HMAC before trusting the payload.

interface StatePayload {
  platform: 'twitch' | 'youtube' | 'kick';
  nonce: string;
  sessionId?: string;    // optional — present when streamer is linking another platform to existing session
  createdAt: number;
}

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getStateKey(): Buffer {
  const raw = config.TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error('TOKEN_ENCRYPTION_KEY not configured (needed for OAuth state signing)');
  return Buffer.from(raw, 'base64');
}

export function signState(payload: Omit<StatePayload, 'createdAt' | 'nonce'>): string {
  const full: StatePayload = {
    ...payload,
    nonce: randomBytes(8).toString('hex'),
    createdAt: Date.now(),
  };
  const jsonB64 = Buffer.from(JSON.stringify(full)).toString('base64url');
  const sig = createHmac('sha256', getStateKey()).update(jsonB64).digest('base64url');
  return `${jsonB64}.${sig}`;
}

export function verifyState(token: string): StatePayload | null {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [jsonB64, providedSig] = token.split('.', 2);
  if (!jsonB64 || !providedSig) return null;
  const expectedSig = createHmac('sha256', getStateKey()).update(jsonB64).digest('base64url');
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(jsonB64, 'base64url').toString('utf8')) as StatePayload;
    if (typeof payload.createdAt !== 'number' || Date.now() - payload.createdAt > STATE_TTL_MS) {
      return null;
    }
    if (!['twitch', 'youtube', 'kick'].includes(payload.platform)) return null;
    return payload;
  } catch {
    return null;
  }
}
