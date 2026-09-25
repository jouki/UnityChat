import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deletedEvent, publishDeleted, type PublishDeletedDeps } from './messageDeletes.js';

const url = process.env.TEST_DATABASE_URL;

test('deletedEvent: tvar SSE message-deleted', () => {
  const e = deletedEvent({ channel: 'robdiesalot', platform: 'twitch', messageId: 'abc', by: 'twitch:jouki', reason: 'mod', at: 1700000000000 });
  assert.deepEqual(e, { channel: 'robdiesalot', platform: 'twitch', messageId: 'abc', by: 'twitch:jouki', reason: 'mod', at: 1700000000000 });
});

test('publishDeleted: broadcast vždy s kanálem z parametru p.channel (DB řádek má platformní kanál, ne UC kanál)', async () => {
  const calls: { event: string; data: object }[] = [];
  const deps: PublishDeletedDeps = {
    markDeleted: async () => ({ channel: 'jiny-platformni-kanal', login: 'nekdo' }),
    broadcast: (event, data) => { calls.push({ event, data }); },
    now: () => 1700000000000,
  };
  await publishDeleted({ channel: 'robdiesalot', platform: 'twitch', messageId: 'pd-1', by: 'twitch:jouki', reason: 'mod' }, deps);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].event, 'message-deleted');
  assert.deepEqual(calls[0].data, { channel: 'robdiesalot', platform: 'twitch', messageId: 'pd-1', by: 'twitch:jouki', reason: 'mod', at: 1700000000000 });
});

test('publishDeleted: kanál z parametru i když markDeleted řádek nenajde (neznámé/už smazané ID)', async () => {
  const calls: { event: string; data: object }[] = [];
  const deps: PublishDeletedDeps = {
    markDeleted: async () => ({ channel: null, login: null }),
    broadcast: (event, data) => { calls.push({ event, data }); },
    now: () => 1700000000000,
  };
  await publishDeleted({ channel: 'robdiesalot', platform: 'kick', messageId: 'pd-2', by: null, reason: 'platform' }, deps);
  assert.equal((calls[0].data as { channel: string }).channel, 'robdiesalot');
});

test('publishDeleted: dedup 60 s per platform:messageId (Twitch CLEARMSG po vlastním smazání)', async () => {
  let markCalls = 0;
  let broadcasts = 0;
  let t = 1700000000000;
  const deps: PublishDeletedDeps = {
    markDeleted: async () => { markCalls++; return { channel: 'robdiesalot', login: 'x' }; },
    broadcast: () => { broadcasts++; },
    now: () => t,
  };
  const p = { channel: 'robdiesalot', platform: 'twitch' as const, messageId: 'pd-dedup-1', by: 'twitch:jouki', reason: 'mod' as const };
  await publishDeleted(p, deps);
  await publishDeleted(p, deps); // stejná zpráva do 60 s → potlačeno
  assert.equal(broadcasts, 1);
  assert.equal(markCalls, 1);
  t += 61_000;
  await publishDeleted(p, deps); // po 60 s znovu projde
  assert.equal(broadcasts, 2);
});

test('markDeleted: nastaví deleted_* jen když ještě není smazaná; vrátí channel+login', { skip: !url && 'TEST_DATABASE_URL není nastavené' }, async () => {
  process.env.DATABASE_URL = url!;
  const { markDeleted } = await import('./messageDeletes.js');
  const { db, closeDb } = await import('../db/index.js');
  const { messages } = await import('../db/schema.js');
  const { eq } = await import('drizzle-orm');
  const id = 'test-del-' + Date.now();
  try {
    await db.insert(messages).values({
      platform: 'twitch', platformMessageId: id, platformUserId: '1', platformUsername: 'tester',
      content: 'hi', contentRaw: {}, channel: '__test__', isUnitychatUser: false, isReply: false,
      replyToMessageId: null, sentAt: new Date(),
    });
    const r1 = await markDeleted({ platform: 'twitch', messageId: id, by: 'twitch:jouki', reason: 'mod' });
    assert.equal(r1.channel, '__test__');
    assert.equal(r1.login, 'tester');
    const r2 = await markDeleted({ platform: 'twitch', messageId: id, by: 'twitch:jouki', reason: 'mod' });
    assert.equal(r2.channel, null); // už smazaná — druhý pokus nic needituje
    assert.equal(r2.login, null);
    const rows = await db.select().from(messages).where(eq(messages.platformMessageId, id));
    assert.equal(rows[0]?.deletedReason, 'mod');
    assert.equal(rows[0]?.deletedBy, 'twitch:jouki');
  } finally {
    await db.delete(messages).where(eq(messages.platformMessageId, id));
    await closeDb();
  }
});
