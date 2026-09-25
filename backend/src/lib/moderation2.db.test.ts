// DB testy moderace části 2 — jen s TEST_DATABASE_URL (a spuštěným backend/sql/2026-09-25-moderation-2.sql).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL není nastavené';

test('moderation_bans: recordBan / activeBan / clearBan, youtubeBanId se nepřepíše na null', { skip }, async () => {
  process.env.DATABASE_URL = url!;
  const { recordBan, activeBan, clearBan } = await import('./userModeration.js');
  const ch = '__test_mod2__';
  try {
    await recordBan({ channel: ch, platform: 'youtube', userId: 'UCx', login: 'a', until: null, youtubeBanId: 'B1' });
    await recordBan({ channel: ch, platform: 'youtube', userId: 'UCx', login: 'a', until: new Date(Date.now() + 60_000) });
    const b = await activeBan(ch, 'youtube', 'UCx');
    assert.equal(b?.youtubeBanId, 'B1');
    assert.ok(b?.until);
    await recordBan({ channel: ch, platform: 'twitch', userId: '1', login: 't', until: new Date(Date.now() - 1000) });
    assert.equal(await activeBan(ch, 'twitch', '1'), null, 'propadlý timeout');
    await clearBan(ch, 'youtube', 'UCx');
    assert.equal(await activeBan(ch, 'youtube', 'UCx'), null);
  } finally {
    const { db } = await import('../db/index.js');
    const { moderationBans } = await import('../db/schema.js');
    const { eq } = await import('drizzle-orm');
    await db.delete(moderationBans).where(eq(moderationBans.channel, ch));
  }
});

test('archivedLogin / archivedUserByLogin: jen kanál zprávy (YouTube handle i s @), přesná shoda loginu', { skip }, async () => {
  process.env.DATABASE_URL = url!;
  const { archivedLogin, archivedUserByLogin } = await import('./moderationTargets.js');
  const { db } = await import('../db/index.js');
  const { messages } = await import('../db/schema.js');
  const { like } = await import('drizzle-orm');
  const pre = 'test-mod2-' + Date.now();
  try {
    await db.insert(messages).values([
      { platform: 'youtube', platformMessageId: `${pre}-1`, platformUserId: 'UCq', platformUsername: 'Tester_1', content: 'x', contentRaw: {}, channel: '@__testyt__', sentAt: new Date() },
      { platform: 'twitch', platformMessageId: `${pre}-2`, platformUserId: '99', platformUsername: 'tester_1', content: 'x', contentRaw: {}, channel: '__jiny__', sentAt: new Date() },
    ]);
    assert.equal(await archivedLogin('youtube', '__testyt__', 'UCq'), 'Tester_1');
    assert.equal(await archivedLogin('twitch', '__testyt__', '99'), null, 'jiný kanál');
    assert.deepEqual(await archivedUserByLogin('youtube', '@__testyt__', 'tester_1'), { platform: 'youtube', userId: 'UCq', login: 'tester_1' });
    assert.equal(await archivedUserByLogin('youtube', '__testyt__', 'tester%1'), null, 'žádný LIKE wildcard');
  } finally {
    await db.delete(messages).where(like(messages.platformMessageId, `${pre}-%`));
  }
});

test('account_warnings: createWarning → pending → ack jen vlastník, podruhé false', { skip }, async () => {
  process.env.DATABASE_URL = url!;
  const { createWarning, pendingWarnings, ackWarning } = await import('./accountWarnings.js');
  const { db, closeDb } = await import('../db/index.js');
  const { webAccounts } = await import('../db/schema.js');
  const { eq } = await import('drizzle-orm');
  const [acc] = await db.insert(webAccounts).values({}).returning({ id: webAccounts.id });
  try {
    const w = await createWarning({ accountId: acc.id, channel: 'robdiesalot', reason: 'Nespamuj', by: 'twitch:modik' });
    assert.deepEqual((await pendingWarnings(acc.id)).map((x) => x.id), [w.id]);
    assert.equal(await ackWarning(acc.id + 1_000_000, w.id), false, 'cizí účet');
    assert.equal(await ackWarning(acc.id, w.id), true);
    assert.equal(await ackWarning(acc.id, w.id), false);
    assert.deepEqual(await pendingWarnings(acc.id), []);
  } finally {
    await db.delete(webAccounts).where(eq(webAccounts.id, acc.id));
    await closeDb();
  }
});
