// DB testy GIF knihovny (Task 2) — jen s TEST_DATABASE_URL (a spuštěnými SQL 2026-09-25-gif-requests,
// 2026-09-26-gif-library a 2026-09-26-gif-phash). Ověřují SQL, které paměťové testy nepokryjí.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL není nastavené';
const CH = '__test_giflib__';
const mid = (c: string) => c.repeat(32);

test('dbGifLibraryStore: knihovna (řazení, kurzor, hledání v tagech), duplicity (jednou bez ohledu na pořadí), sloučení', { skip }, async () => {
  process.env.DATABASE_URL = url!;
  const { db } = await import('../db/index.js');
  const { gifMedia, gifRequests, messages } = await import('../db/schema.js');
  const { eq, inArray } = await import('drizzle-orm');
  const { dbGifLibraryStore: s, libraryPage } = await import('./gifLibrary.js');
  const ids = ['1', '2', '3', '4'].map(mid);
  const base = { kind: 'gif', contentType: 'image/gif', bytes: Buffer.from('GIF89a'), size: 6, channel: CH };
  const cleanup = async () => {
    await db.delete(messages).where(eq(messages.channel, CH));
    await db.delete(gifRequests).where(eq(gifRequests.channel, CH));
    await db.delete(gifMedia).where(inArray(gifMedia.id, ids));
  };
  await cleanup();
  try {
    await db.insert(gifMedia).values([
      { ...base, id: ids[0], sha256: 's1', status: 'approved', useCount: 5, lastUsedAt: new Date(3000), tags: ['cat dance', 'cat'] },
      { ...base, id: ids[1], sha256: 's2', status: 'approved', useCount: 5, lastUsedAt: new Date(4000), tags: ['dog'] },
      { ...base, id: ids[2], sha256: 's3', status: 'approved', useCount: 9, tags: [] },
      { ...base, id: ids[3], sha256: 's4', status: 'rejected', rejectedAt: new Date(), useCount: 1, tags: ['kočka'] },
    ]);
    const page1 = await libraryPage(s, CH, { limit: 2 });
    const b1 = page1.body as { items: Array<{ mediaId: string }>; nextCursor: string };
    assert.deepEqual(b1.items.map((i) => i.mediaId), [ids[2], ids[1]]);
    const page2 = await libraryPage(s, CH, { limit: 2, cursor: b1.nextCursor });
    assert.deepEqual((page2.body as { items: Array<{ mediaId: string }> }).items.map((i) => i.mediaId), [ids[0]]);
    assert.deepEqual((await s.listLibrary(CH, { q: 'cat', after: null, limit: 10 })).map((i) => i.id), [ids[0]]);

    await s.setTags(ids[1], ['pes', 'dog']);
    assert.equal(await s.mediaChannel(ids[1]), CH);

    assert.equal(await s.insertDuplicate({ channel: CH, a: ids[0], b: ids[3], score: 0.75 }), true);
    assert.equal(await s.insertDuplicate({ channel: CH, a: ids[3], b: ids[0], score: 0.9 }), false, 'obrácená dvojice = stejná');
    const [d] = await s.listDuplicates(CH, 10);
    assert.equal(d.first.id, ids[0]);

    // Sloučení: žádost + syntetická zpráva zamítnutého (ids[3]) → ponechané schválené ids[0].
    const [r] = await db.insert(gifRequests).values({ channel: CH, workspace: 'x', platform: 'twitch', platformChannel: CH, userId: '1', login: 'a', messageId: 'm', mediaId: ids[3], kind: 'gif', expiresAt: new Date(), status: 'approved' }).returning();
    await db.insert(messages).values({ platform: 'twitch', platformMessageId: `gif-${r.id}`, platformUserId: '1', platformUsername: 'a', content: '', contentRaw: { gif: { mediaId: ids[3] } }, channel: CH, isUnitychatUser: false, isReply: false, sentAt: new Date() });
    assert.equal(await s.mergeInto(ids[0], ids[3], new Date()), true);
    const [kept] = await db.select().from(gifMedia).where(eq(gifMedia.id, ids[0]));
    assert.equal(kept.useCount, 6);
    assert.deepEqual(kept.tags, ['cat dance', 'cat', 'kočka']);
    assert.equal((await db.select().from(gifMedia).where(eq(gifMedia.id, ids[3]))).length, 0);
    const [req] = await db.select().from(gifRequests).where(eq(gifRequests.id, r.id));
    assert.equal(req.mediaId, ids[0]);
    const [msg] = await db.select().from(messages).where(eq(messages.platformMessageId, `gif-${r.id}`));
    assert.equal((msg.contentRaw as { gif: { mediaId: string } }).gif.mediaId, ids[0]);
    assert.equal(await s.getDuplicate(d.id), null, 'návrh zmizel kaskádou');
    assert.equal(await s.mergeInto(ids[0], ids[3], new Date()), false, 'druhé médium už není');

    // Worker selektory: rozhodnutá bez hashe → hash; s hashem → kontrola.
    const h = await s.nextToHash();
    assert.ok(h && ids.includes(h.id));
    await s.saveHash(ids[0], ['0f0f0f0f0f0f0f0f'], new Date());
    const hashes = await s.channelHashes(CH, ids[1]);
    assert.deepEqual(hashes.map((x) => x.id), [ids[0]]);
  } finally {
    await cleanup();
  }
});
