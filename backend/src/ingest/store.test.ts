import { test } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;

test('insertMessages: duplicita (platform, platform_message_id) se tiše zahodí; retence maže staré', { skip: !url && 'TEST_DATABASE_URL není nastavené' }, async () => {
  process.env.DATABASE_URL = url!;
  const { insertMessages, deleteOlderThan } = await import('./store.js');
  const { db, closeDb } = await import('../db/index.js');
  const { messages } = await import('../db/schema.js');
  const { eq } = await import('drizzle-orm');
  const id = 'test-' + Date.now();
  const row = {
    platform: 'twitch', platformMessageId: id, platformUserId: '1', platformUsername: 'tester',
    content: 'hi', contentRaw: {}, channel: '__test__', isUnitychatUser: false, isReply: false,
    replyToMessageId: null, sentAt: new Date(Date.now() - 10 * 24 * 3600 * 1000),
  };
  try {
    assert.equal(await insertMessages([row]), 1);
    assert.equal(await insertMessages([row]), 0);
    // retence: 10 dní stará zpráva s cutoff 7 dní zmizí
    const deleted = await deleteOlderThan(7);
    assert.ok(deleted >= 1);
    const left = await db.select().from(messages).where(eq(messages.platformMessageId, id));
    assert.equal(left.length, 0);
  } finally {
    await closeDb();
  }
});
