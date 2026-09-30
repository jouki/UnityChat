// DB testy „Trvale zahodit“ (spec 2026-09-27-gif-nahled-zahozeni-design.md) — jen s TEST_DATABASE_URL a spuštěnými
// SQL 2026-09-25-gif-requests, 2026-09-26-gif-library, 2026-09-26-gif-phash a 2026-09-27-gif-purge.
// Ověřují SQL, které paměťové testy nepokryjí (status_before_purge = starý stav, join zpráv přes žádosti, retence).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL není nastavené';
const CH = '__test_gifpurge__';
const mid = (c: string) => c.repeat(32);

test('dbGifStore: purge / restore / remove-file / listDiscarded / purgeDue / messagesForMedia / findMedia pořadí', { skip }, async () => {
  process.env.DATABASE_URL = url!;
  const { db } = await import('../db/index.js');
  const { gifMedia, gifRequests, messages } = await import('../db/schema.js');
  const { eq, inArray } = await import('drizzle-orm');
  const { dbGifStore: s } = await import('./gifRequests.js');
  const { gifMediaGone } = await import('../routes/chat.js');
  const ids = ['1', '2', '3'].map(mid);
  const base = { kind: 'gif', contentType: 'image/gif', bytes: Buffer.from('GIF89a'), size: 6, channel: CH };
  const cleanup = async () => {
    await db.delete(messages).where(eq(messages.channel, CH));
    await db.delete(gifRequests).where(eq(gifRequests.channel, CH));
    await db.delete(gifMedia).where(inArray(gifMedia.id, ids));
  };
  await cleanup();
  try {
    await db.insert(gifMedia).values([
      { ...base, id: ids[0], sha256: 'p1', status: 'approved', sourceUrlNorm: 'https://tenor.com/view/__test_gifpurge_1' },
      { ...base, id: ids[1], sha256: 'p2', status: 'rejected', rejectedAt: new Date(1000) },
    ]);
    const [r] = await db.insert(gifRequests).values({ channel: CH, workspace: 'x', platform: 'twitch', platformChannel: CH, userId: '1', login: 'a', messageId: 'm', mediaId: ids[0], kind: 'gif', expiresAt: new Date(), status: 'approved' }).returning();
    await db.insert(messages).values({ platform: 'twitch', platformMessageId: `gif-${r.id}`, platformUserId: '1', platformUsername: 'a', content: 'hele', contentRaw: { gif: { mediaId: ids[0], kind: 'gif' } }, channel: CH, isUnitychatUser: false, isReply: false, sentAt: new Date() });

    // Zahodit, zprávy nechat.
    // Čekající žádost na médium se zamítne v téže transakci.
    const [pend] = await db.insert(gifRequests).values({ channel: CH, workspace: 'x', platform: 'twitch', platformChannel: CH, userId: '2', login: 'b', messageId: 'm2', mediaId: ids[0], kind: 'gif', expiresAt: new Date(Date.now() + 60_000), status: 'pending' }).returning();
    const purged = await s.purgeMedia(ids[0], 'withdrawn', 'twitch:moda', new Date(5000), null);
    assert.equal(purged.ok, true);
    assert.deepEqual(purged.rejected.map((x) => [x.id, x.status, x.decidedBy]), [[pend.id, 'rejected', 'twitch:moda']]);
    assert.equal(await s.setMediaApproved(ids[0], new Date()), null, 'zahozené se schválením nevzkřísí');
    let md = (await s.getMedia(ids[0]))!;
    assert.equal(md.status, 'withdrawn');
    assert.equal(md.statusBeforePurge, 'approved', 'SET status_before_purge = starý stav');
    assert.equal(md.purgedBy, 'twitch:moda');
    assert.equal((await s.purgeMedia(ids[0], 'purging', 'x', new Date(), new Date())).ok, false, 'už zahozené');
    assert.equal(await s.findMedia(CH, { url: 'https://tenor.com/view/__test_gifpurge_1' }), null, 'dedup zahozené nevidí (jako nikdy neviděný GIF)');
    assert.deepEqual((await s.listDiscarded(CH, 'withdrawn', null, 10)).map((m) => m.id), [ids[0]]);
    let gone = await gifMediaGone([{ contentRaw: { gif: { mediaId: ids[0] } } }]);
    assert.equal(gone.size, 0, 'stažený = zprávy vidět');
    assert.deepEqual(await s.messageKeysForMedia(ids[0], 10), [`twitch:gif-${r.id}`]);

    // Odstranit ze serveru.
    assert.equal(await s.removeMediaFile(ids[0]), true);
    const [row] = await db.select().from(gifMedia).where(eq(gifMedia.id, ids[0]));
    assert.equal(row.status, 'unavailable');
    assert.equal(row.bytes.length, 0);
    gone = await gifMediaGone([{ contentRaw: { gif: { mediaId: ids[0] } } }]);
    assert.deepEqual([...(gone.unavailable ?? [])], [ids[0]]);

    // Zahodit i se zprávami (zamítnutý) → obnovit → zpět do zamítnutých; znovu → purgeDue smaže.
    assert.equal((await s.purgeMedia(ids[1], 'purging', 'twitch:moda', new Date(6000), new Date(10_000))).ok, true);
    assert.deepEqual((await s.listDiscarded(CH, 'purging', null, 10)).map((m) => m.id), [ids[1]]);
    assert.deepEqual(await s.restoreMedia(ids[1], new Date(8000), 'twitch:modc'), { status: 'rejected' });
    md = (await s.getMedia(ids[1]))!;
    assert.equal(md.status, 'rejected');
    assert.equal(md.purgeAt, null);
    assert.equal(md.rejectedAt!.getTime(), 8000, 'nové zamítnutí = retence od obnovy');
    assert.equal(await s.restoreMedia(ids[1], new Date(), 'x'), null, 'jen purging');
    await s.purgeMedia(ids[1], 'purging', 'x', new Date(6000), new Date(10_000));
    assert.deepEqual(await s.purgeDue(new Date(9_000)), []);
    assert.deepEqual(await s.purgeDue(new Date(10_000)), [ids[1]]);
    assert.equal(await s.getMedia(ids[1]), null);
  } finally {
    await cleanup();
  }
});
