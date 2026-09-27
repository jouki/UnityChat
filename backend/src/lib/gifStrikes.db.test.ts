// DB test „Schválení ruší tresty“ (spec 2026-09-27-gif-review-upravy-design.md §1) — jen s TEST_DATABASE_URL
// a spuštěnými SQL GIF knihovny. Ověřuje, že setMediaApproved / restoreMedia / mergeMedia mažou gif_rejections
// i gif_bans média v téže transakci a že hasRejections vidí strike kohokoli.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL není nastavené';
const CH = '__test_gifstrikes__';
const mid = (c: string) => c.repeat(32);

test('dbGifStore: schválení / obnova do schváleného / sloučení do schváleného smaže strike i zákaz', { skip }, async () => {
  process.env.DATABASE_URL = url!;
  const { db } = await import('../db/index.js');
  const { gifMedia, gifRejections, gifBans } = await import('../db/schema.js');
  const { eq, inArray } = await import('drizzle-orm');
  const { dbGifStore: s } = await import('./gifRequests.js');
  const ids = ['4', '5', '6'].map(mid);
  const base = { kind: 'gif', contentType: 'image/gif', bytes: Buffer.from('GIF89a'), size: 6, channel: CH };
  const cleanup = async () => {
    await db.delete(gifRejections).where(eq(gifRejections.channel, CH));
    await db.delete(gifBans).where(eq(gifBans.channel, CH));
    await db.delete(gifMedia).where(inArray(gifMedia.id, ids));
  };
  const strikes = async (id: string) => (await db.select().from(gifRejections).where(eq(gifRejections.mediaId, id))).length
    + (await db.select().from(gifBans).where(eq(gifBans.mediaId, id))).length;
  await cleanup();
  try {
    await db.insert(gifMedia).values([
      { ...base, id: ids[0], sha256: 's4', status: 'rejected', rejectedAt: new Date(1000) },
      { ...base, id: ids[1], sha256: 's5', status: 'purging', statusBeforePurge: 'approved', purgedAt: new Date(2000), purgeAt: new Date(Date.now() + 86_400_000) },
      { ...base, id: ids[2], sha256: 's6', status: 'rejected', rejectedAt: new Date(1000) },
    ]);
    for (const id of ids) {
      await s.addRejection(CH, id, 'twitch', '42', new Date());
      await s.addRejection(CH, id, 'kick', '7', new Date());
      await s.setBan(CH, id, new Date(Date.now() + 3600_000), 'twitch:moda');
    }
    assert.equal(await s.hasRejections(CH, ids[0]), true);
    assert.equal(await strikes(ids[0]), 3);

    assert.equal(await s.setMediaApproved(ids[0], new Date()), ids[0]);
    assert.equal(await strikes(ids[0]), 0, 'schválení smazalo strike všech i zákaz');
    assert.equal(await s.hasRejections(CH, ids[0]), false);
    assert.equal(await s.setMediaUnapproved(ids[0], 'twitch:moda', new Date()), true);
    assert.equal(await strikes(ids[0]), 0, 'odebrání strike nepřidává');

    assert.deepEqual(await s.restoreMedia(ids[1], new Date(), 'twitch:moda'), { status: 'approved' });
    assert.equal(await strikes(ids[1]), 0, 'obnova do schváleného');

    // ids[2] (zamítnuté) sloučit do schváleného ids[1]: tresty ids[2] kaskádou, ids[1] už žádné.
    await s.addRejection(CH, ids[1], 'twitch', '99', new Date());
    await s.mergeMedia(ids[2], ids[1]);
    assert.equal(await strikes(ids[1]), 0, 'sloučení do schváleného');
    assert.equal(await s.getMedia(ids[2]), null);
  } finally {
    await cleanup();
  }
});
