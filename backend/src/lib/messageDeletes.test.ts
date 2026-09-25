import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deletedEvent, publishDeleted, channelMatches, rememberRestored, restoredCount, RESTORED_MS, RESTORED_MAX, type PublishDeletedDeps, type MarkDeletedParams } from './messageDeletes.js';

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

test('publishDeleted: každé smazání jde i do integračního streamu (dep integration), chyba integrace nevadí', async () => {
  const seen: object[] = [];
  const deps: PublishDeletedDeps = {
    markDeleted: async () => ({ channel: null, login: null }),
    broadcast: () => {},
    now: () => 1700000000000,
    integration: async (ev) => { seen.push(ev); throw new Error('boom'); },
  };
  await publishDeleted({ channel: 'robdiesalot', platform: 'youtube', messageId: 'pd-int-1', by: null, reason: 'platform' }, deps);
  assert.deepEqual(seen, [{ channel: 'robdiesalot', platform: 'youtube', messageId: 'pd-int-1', by: null, reason: 'platform', at: 1700000000000 }]);
});

test('channelMatches: normalizace jako ingest (velikost písmen, YouTube @), chybějící strana → false', () => {
  assert.equal(channelMatches('robdiesalot', 'robdiesalot'), true);
  assert.equal(channelMatches('@RobDiesALot', 'robdiesalot'), true);
  assert.equal(channelMatches('jouki', 'robdiesalot'), false);
  assert.equal(channelMatches(null, 'robdiesalot'), false);
  assert.equal(channelMatches('robdiesalot', null), false);
});

test('publishDeleted: expectedChannel se předá do markDeleted (pojistka AND channel = …)', async () => {
  const seen: MarkDeletedParams[] = [];
  const deps: PublishDeletedDeps = {
    markDeleted: async (p) => { seen.push(p); return { channel: null, login: null }; },
    broadcast: () => {},
    now: () => 1700000000000,
  };
  await publishDeleted({ channel: 'robdiesalot', platform: 'twitch', messageId: 'pd-exp-1', by: 'twitch:jouki', reason: 'mod', expectedChannel: 'robdiesalot' }, deps);
  await publishDeleted({ channel: 'robdiesalot', platform: 'twitch', messageId: 'pd-exp-2', by: null, reason: 'platform' }, deps);
  assert.equal(seen[0].expectedChannel, 'robdiesalot');
  assert.equal(seen[1].expectedChannel, undefined);
});

test('publishDeleted: když markDeleted selže, dedup se nezapíše — opakování do 60 s projde', async () => {
  let fail = true;
  let markCalls = 0;
  let broadcasts = 0;
  const deps: PublishDeletedDeps = {
    markDeleted: async () => { markCalls++; if (fail) throw new Error('db down'); return { channel: null, login: null }; },
    broadcast: () => { broadcasts++; },
    now: () => 1700000000000,
  };
  const p = { channel: 'robdiesalot', platform: 'twitch' as const, messageId: 'pd-fail-1', by: null, reason: 'platform' as const };
  await assert.rejects(publishDeleted(p, deps), /db down/);
  assert.equal(broadcasts, 0);
  fail = false;
  await publishDeleted(p, deps); // retry hned — musí projít
  assert.equal(markCalls, 2);
  assert.equal(broadcasts, 1);
  await publishDeleted(p, deps); // teď už dedup
  assert.equal(markCalls, 2);
});

test('publishDeleted: po odkrytí modem se smazání z platformy (ozvěna) ignoruje RESTORED_MS; smazání modem projde a značku zruší', async () => {
  let t = 1_800_000_000_000;
  let broadcasts = 0;
  const deps: PublishDeletedDeps = { markDeleted: async () => ({ channel: null, login: null }), broadcast: () => { broadcasts++; }, now: () => t };
  rememberRestored('twitch', 'rr-1', t);
  await publishDeleted({ channel: 'robdiesalot', platform: 'twitch', messageId: 'rr-1', by: null, reason: 'platform' }, deps);
  assert.equal(broadcasts, 0);
  await publishDeleted({ channel: 'robdiesalot', platform: 'twitch', messageId: 'rr-1', by: 'twitch:jouki', reason: 'mod' }, deps);
  assert.equal(broadcasts, 1);
  // Po uplynutí okna smazání z platformy zase projde.
  rememberRestored('kick', 'rr-2', t);
  t += RESTORED_MS;
  await publishDeleted({ channel: 'robdiesalot', platform: 'kick', messageId: 'rr-2', by: null, reason: 'platform' }, deps);
  assert.equal(broadcasts, 2);
});

test('rememberRestored: tvrdý strop RESTORED_MAX, zahazují se nejstarší (i v okně 30 min)', async () => {
  const t = 1_900_000_000_000;
  for (let i = 0; i < RESTORED_MAX + 50; i++) rememberRestored('youtube', `cap-${i}`, t + i);
  assert.ok(restoredCount() <= RESTORED_MAX);
  let broadcasts = 0;
  const deps: PublishDeletedDeps = { markDeleted: async () => ({ channel: null, login: null }), broadcast: () => { broadcasts++; }, now: () => t + 5000 };
  // Nejstarší značka vypadla → smazání z platformy projde; nejnovější drží.
  await publishDeleted({ channel: 'robdiesalot', platform: 'youtube', messageId: 'cap-0', by: null, reason: 'platform' }, deps);
  assert.equal(broadcasts, 1);
  await publishDeleted({ channel: 'robdiesalot', platform: 'youtube', messageId: `cap-${RESTORED_MAX + 49}`, by: null, reason: 'platform' }, deps);
  assert.equal(broadcasts, 1);
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
