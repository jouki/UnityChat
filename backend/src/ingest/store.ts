import { sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/index.js';
import { messages, type NewMessage } from '../db/schema.js';

type Db = typeof defaultDb;

/** Vloží dávku, duplicity (platform, platform_message_id) přeskočí. Vrací počet vložených. */
export async function insertMessages(rows: NewMessage[], dbi: Db = defaultDb): Promise<number> {
  if (!rows.length) return 0;
  const inserted = await dbi
    .insert(messages)
    .values(rows)
    .onConflictDoNothing({ target: [messages.platform, messages.platformMessageId] })
    .returning({ id: messages.id });
  return inserted.length;
}

/** Retence: smaže zprávy se sent_at starším než `days` dní. Vrací počet smazaných. */
export async function deleteOlderThan(days: number, dbi: Db = defaultDb): Promise<number> {
  const res = await dbi
    .delete(messages)
    .where(sql`${messages.sentAt} < now() - make_interval(days => ${days})`)
    .returning({ id: messages.id });
  return res.length;
}
