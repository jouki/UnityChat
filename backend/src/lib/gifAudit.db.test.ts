// DB testy oprav ze závěrečného auditu GIF knihovny (2026-09-27) — jen s TEST_DATABASE_URL a spuštěnými SQL
// 2026-09-25-gif-requests … 2026-09-27-gif-purge (+ volitelně 2026-09-27-gif-audit). Ověřují SQL, které paměťové
// testy nepokryjí: statusByMessages (C1), unpublishedApproved (A1), setMediaApproved onlyApproved (A2),
// servableMeta bez bajtů (SEC-2), revokeHash (L13).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL není nastavené';
const CH = '__test_gifaudit__';
const mid = (c: string) => c.repeat(32);

test('dbGifStore: statusByMessages / unpublishedApproved / onlyApproved / servableMeta', { skip }, async () => {
  process.env.DATABASE_URL = url!;
  const { db } = await import('../db/index.js');
  const { gifMedia, gifRequests, messages } = await import('../db/schema.js');
  const { eq, inArray } = await import('drizzle-orm');
  const { dbGifStore: s, servableMeta } = await import('./gifRequests.js');
  const ids = ['4', '5', '6'].map(mid);
  const base = { kind: 'gif', contentType: 'image/gif', bytes: Buffer.from('GIF89a'), size: 6, channel: CH };
  const cleanup = async () => {
    await db.delete(messages).where(eq(messages.channel, CH));
    await db.delete(gifRequests).where(eq(gifRequests.channel, CH));
    await db.delete(gifMedia).where(inArray(gifMedia.id, ids));
  };
  await cleanup();
  try {
    await db.insert(gifMedia).values([
      { ...base, id: ids[0], sha256: 'a1', status: 'pending' },
      { ...base, id: ids[1], sha256: 'a2', status: 'rejected', rejectedAt: new Date(1000) },
      { ...base, id: ids[2], sha256: 'a3', status: 'unavailable', bytes: Buffer.alloc(0), size: 0 },
    ]);
    const req = (messageId: string, mediaId: string, status: string, decidedAt: Date | null = null) => ({ channel: CH, workspace: 'x', platform: 'twitch', platformChannel: CH, userId: '1', login: 'a', kind: 'gif', expiresAt: new Date(Date.now() + 60_000), messageId, mediaId, status, decidedAt });
    const old = new Date(Date.now() - 120_000);
    const [r1] = await db.insert(gifRequests).values(req('m1', ids[0], 'rejected')).returning();
    const [r2] = await db.insert(gifRequests).values(req('m1', ids[0], 'approved', old)).returning();
    const [r3] = await db.insert(gifRequests).values(req('m3', ids[1], 'approved', old)).returning();
    await db.insert(messages).values({ platform: 'twitch', platformMessageId: `gif-${r3.id}`, platformUserId: '1', platformUsername: 'a', content: '', contentRaw: {}, channel: CH, isUnitychatUser: false, isReply: false, sentAt: new Date() });

    // C1: poslední žádost ke zprávě vyhrává; zpráva bez žádosti chybí.
    const st = await s.statusByMessages([{ platform: 'twitch', messageId: 'm1' }, { platform: 'twitch', messageId: 'nic' }]);
    assert.deepEqual([...st], [['twitch:m1', 'approved']]);
    assert.ok(r1.id < r2.id);

    // A1: r2 bez zprávy (médium pending) ano, r3 se zprávou a zamítnutým médiem ne.
    const un = await s.unpublishedApproved(new Date(Date.now() - 60_000), new Date(Date.now() - 7 * 86_400_000), 50);
    const mine = un.filter((x) => x.request.channel === CH);
    assert.deepEqual(mine.map((x) => [x.request.id, x.mediaStatus, x.hasMessage]), [[r2.id, 'pending', false]]);

    // A2: z knihovny jen dosud schválené.
    assert.equal(await s.setMediaApproved(ids[1], new Date(), { onlyApproved: true }), null);
    assert.equal((await s.getMedia(ids[1]))!.status, 'rejected');

    // SEC-2: metadata bez bajtů; unavailable (prázdné bajty) → null.
    assert.deepEqual(await servableMeta(ids[1]), { contentType: 'image/gif', status: 'rejected', channel: CH });
    assert.equal(await servableMeta(ids[2]), null);
  } finally {
    await cleanup();
  }
});

test('dbGifTokenStore.revokeHash: zneplatní jen token s tím hashem', { skip }, async () => {
  process.env.DATABASE_URL = url!;
  const { db } = await import('../db/index.js');
  const { gifAccessTokens } = await import('../db/schema.js');
  const { eq } = await import('drizzle-orm');
  const { dbGifTokenStore, hashToken } = await import('./gifTokens.js');
  const slug = '__test_gifaudit__';
  await db.delete(gifAccessTokens).where(eq(gifAccessTokens.integrationSlug, slug));
  try {
    await db.insert(gifAccessTokens).values([
      { accountId: null, integrationSlug: slug, tokenHash: hashToken('A'.repeat(43)) },
      { accountId: null, integrationSlug: slug, tokenHash: hashToken('B'.repeat(43)) },
    ]);
    await dbGifTokenStore.revokeHash(hashToken('A'.repeat(43)), new Date());
    assert.equal(await dbGifTokenStore.findActive(hashToken('A'.repeat(43))), null);
    assert.ok(await dbGifTokenStore.findActive(hashToken('B'.repeat(43))));
  } finally {
    await db.delete(gifAccessTokens).where(eq(gifAccessTokens.integrationSlug, slug));
  }
});
