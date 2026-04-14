import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';

// AES-256-GCM primitives for encrypting streamer OAuth tokens at rest.
// Master key is a base64-encoded 32-byte value from config.TOKEN_ENCRYPTION_KEY.
// NEVER log tokens, NEVER include plaintext in errors.

const KEY_VERSION_CURRENT = 1;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = config.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('TOKEN_ENCRYPTION_KEY not configured');
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (256 bits)');
  }
  cachedKey = buf;
  return buf;
}

export interface Encrypted {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
}

export function encryptToken(plaintext: string): Encrypted {
  const iv = randomBytes(12); // GCM standard IV length
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext: encrypted, iv, authTag, keyVersion: KEY_VERSION_CURRENT };
}

export function decryptToken(enc: Encrypted): string {
  const decipher = createDecipheriv('aes-256-gcm', getKey(), enc.iv);
  decipher.setAuthTag(enc.authTag);
  const decrypted = Buffer.concat([decipher.update(enc.ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

export function isCryptoReady(): boolean {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}
