// Ověření e-mailu kódem (spec 2026-09-25-qr-dono-v-unitychatu-design.md): čistá logika bez DB.
import { createHash, randomInt } from 'node:crypto';

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 5;
/** Cooldown před dalším odesláním: po 1. e-mailu 2 min, po 2. 5 min, pak 15 min (pokyn usera). */
export const RESEND_COOLDOWN_MS = [2 * 60_000, 5 * 60_000, 15 * 60_000];
/** Změna už ověřeného e-mailu nejvýš 1× za 24 h (proti spamu kódy, pokyn usera 2026-09-25). */
export const EMAIL_CHANGE_COOLDOWN_MS = 24 * 60 * 60_000;
/** Kdy smí účet ověřený e-mail zase změnit (0 = hned; bez e-mailu vždy hned). */
export function emailChangeAllowedAt(verifiedAt: Date | null, now = Date.now()): number {
  if (!verifiedAt) return 0;
  const at = verifiedAt.getTime() + EMAIL_CHANGE_COOLDOWN_MS;
  return at > now ? at : 0;
}
export const LIMITS = { perAccountDay: 6, perEmailDay: 6, perIpDay: 10 };

export const normEmail = (e: string) => e.trim().toLowerCase();
export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export function newCode(): string { return String(randomInt(0, 1_000_000)).padStart(6, '0'); }
/** Hash kódu vázaný na účet a adresu (kód z jiné žádosti neprojde). */
export function codeHash(code: string, accountId: number, email: string): string {
  return createHash('sha256').update(`${accountId}|${normEmail(email)}|${code}`).digest('hex');
}
export const ipHash = (ip: string) => createHash('sha256').update(`uc-mail|${ip}`).digest('hex').slice(0, 24);

/** Kdy smí jít další e-mail: podle počtu už poslaných pro tuhle žádost. */
export function nextAllowedAt(sends: number, lastSentAt: number): number {
  if (sends <= 0) return 0;
  return lastSentAt + RESEND_COOLDOWN_MS[Math.min(sends - 1, RESEND_COOLDOWN_MS.length - 1)];
}

/** Kód z klienta: jen 6 číslic (mezery / pomlčky z vložení se ignorují). */
export function cleanCode(raw: unknown): string | null {
  const c = String(raw ?? '').replace(/[\s-]/g, '');
  return /^\d{6}$/.test(c) ? c : null;
}
