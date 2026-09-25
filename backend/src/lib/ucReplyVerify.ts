// Citace u odpovědi napříč platformami se bere z ARCHIVU podle id zprávy, ne od klienta —
// jinak šlo připojit ke zprávě vymyšlenou citaci komukoli (zneužito přes /chat/uc-sent 2026-09-25).
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { messages } from '../db/schema.js';
import type { UcReply } from './ucSends.js';

const UC_MARKER = '\u2800';

export interface QuotedRow { platformUsername: string; content: string; isUnitychatUser: boolean; deletedAt: Date | null; hiddenAt: Date | null }
export type QuoteLookup = (platform: string, id: string) => Promise<QuotedRow | null>;

const dbLookup: QuoteLookup = async (platform, id) => {
  const [r] = await db.select({
    platformUsername: messages.platformUsername, content: messages.content, isUnitychatUser: messages.isUnitychatUser,
    deletedAt: messages.deletedAt, hiddenAt: messages.hiddenAt,
  }).from(messages).where(and(eq(messages.platform, platform), eq(messages.platformMessageId, id))).limit(1);
  return r ?? null;
};

/** Ověřená citace: autor a text z archivu; zpráva mimo archiv / smazaná / skrytá = bez citace (null). */
export async function verifyUcReply(r: UcReply | null, lookup: QuoteLookup = dbLookup): Promise<UcReply | null> {
  if (!r) return null;
  const row = await lookup(r.platform, r.id);
  if (!row || row.deletedAt || row.hiddenAt) return null;
  const message = row.content.split(UC_MARKER).join('').trim().slice(0, 300);
  return { platform: r.platform, id: r.id, username: row.platformUsername.replace(/^@/, '').slice(0, 60), message, ...(row.isUnitychatUser ? { authorUc: true } : {}) };
}
