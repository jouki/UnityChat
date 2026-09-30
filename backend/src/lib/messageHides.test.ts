import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hiddenEvent, unhiddenEvent, publishHidden, publishUnhidden, type PublishHiddenDeps, type PublishUnhiddenDeps } from './messageHides.js';
import type { Message } from '../db/schema.js';

const url = process.env.TEST_DATABASE_URL;

const row: Message = {
  id: 1, platform: 'twitch', platformMessageId: 'h1', platformUserId: '1', platformUsername: 'Trokner', userId: null,
  content: 'ahoj', contentRaw: { color: '#fff', badges: '' }, channel: 'robdiesalot', isUnitychatUser: false, isReply: false,
  replyToMessageId: null, sentAt: new Date(1789820014396), createdAt: new Date(),
  deletedAt: null, deletedBy: null, deletedReason: null, hiddenAt: null, hiddenBy: null,
};

test('hiddenEvent / unhiddenEvent: tvary SSE message-hidden / message-unhidden', () => {
  assert.deepEqual(hiddenEvent({ channel: 'robdiesalot', platform: 'kick', messageId: 'k1', by: 'zidolista:7', at: 5 }),
    { channel: 'robdiesalot', platform: 'kick', messageId: 'k1', by: 'zidolista:7', at: 5 });
  const msg = { platform: 'kick', id: 'k1', username: 'x', userId: '1', message: 'hi', timestamp: 1, historical: true };
  assert.deepEqual(unhiddenEvent({ channel: 'robdiesalot', platform: 'kick', messageId: 'k1', by: 'zidolista:7', at: 5, message: msg }),
    { channel: 'robdiesalot', platform: 'kick', messageId: 'k1', by: 'zidolista:7', at: 5, message: msg });
});

test('publishHidden: nalezená zpráva → SSE message-hidden s UC kanálem + integrační událost, výsledek ok', async () => {
  const calls: { event: string; data: object }[] = [];
  const integ: object[] = [];
  const deps: PublishHiddenDeps = {
    markHidden: async () => true,
    broadcast: (event, data) => { calls.push({ event, data }); },
    integration: async (ev) => { integ.push(ev); throw new Error('integrace spadla — nevadí'); },
    now: () => 1700000000000,
  };
  const r = await publishHidden({ channel: 'robdiesalot', platform: 'twitch', messageId: 'h1', by: 'zidolista:7' }, deps);
  assert.equal(r, 'ok');
  assert.deepEqual(calls, [{ event: 'message-hidden', data: { channel: 'robdiesalot', platform: 'twitch', messageId: 'h1', by: 'zidolista:7', at: 1700000000000 } }]);
  assert.equal(integ.length, 1);
});

test('publishHidden: neznámá zpráva → not_found, žádné SSE', async () => {
  let n = 0;
  const deps: PublishHiddenDeps = { markHidden: async () => false, broadcast: () => { n++; }, integration: async () => { n++; }, now: () => 1 };
  assert.equal(await publishHidden({ channel: 'robdiesalot', platform: 'twitch', messageId: 'x', by: 'zidolista:7' }, deps), 'not_found');
  assert.equal(n, 0);
});

test('publishUnhidden: SSE message-unhidden nese celou zprávu v klientském tvaru (historical)', async () => {
  const calls: { event: string; data: any }[] = [];
  const deps: PublishUnhiddenDeps = {
    markUnhidden: async () => row,
    broadcast: (event, data) => { calls.push({ event, data }); },
    integration: async () => {},
    now: () => 9,
  };
  const r = await publishUnhidden({ channel: 'robdiesalot', platform: 'twitch', messageId: 'h1', by: 'zidolista:7' }, deps);
  assert.equal(r, 'ok');
  assert.equal(calls[0].event, 'message-unhidden');
  assert.equal(calls[0].data.channel, 'robdiesalot');
  assert.equal(calls[0].data.message.message, 'ahoj');
  assert.equal(calls[0].data.message.id, 'h1');
  assert.equal(calls[0].data.message.historical, true);
  assert.equal(calls[0].data.message.hidden, undefined);
});

test('publishUnhidden: neznámá zpráva → not_found', async () => {
  const deps: PublishUnhiddenDeps = { markUnhidden: async () => null, broadcast: () => { throw new Error('nemá'); }, now: () => 1 };
  assert.equal(await publishUnhidden({ channel: 'robdiesalot', platform: 'twitch', messageId: 'x', by: 'zidolista:7' }, deps), 'not_found');
});

test('markHidden / markUnhidden: DB', { skip: !url && 'TEST_DATABASE_URL není nastavené' }, async () => {
  process.env.DATABASE_URL = url!;
  const { markHidden, markUnhidden } = await import('./messageHides.js');
  const { db, closeDb } = await import('../db/index.js');
  const { messages } = await import('../db/schema.js');
  const { eq } = await import('drizzle-orm');
  const id = 'test-hide-' + Date.now();
  try {
    await db.insert(messages).values({
      platform: 'twitch', platformMessageId: id, platformUserId: '1', platformUsername: 'tester',
      content: 'hi', contentRaw: {}, channel: '__test__', isUnitychatUser: false, isReply: false,
      replyToMessageId: null, sentAt: new Date(),
    });
    assert.equal(await markHidden({ platform: 'twitch', messageId: id, by: 'zidolista:7' }), true);
    assert.equal(await markHidden({ platform: 'twitch', messageId: 'neexistuje-' + id, by: 'zidolista:7' }), false);
    let rows = await db.select().from(messages).where(eq(messages.platformMessageId, id));
    assert.ok(rows[0]?.hiddenAt);
    assert.equal(rows[0]?.hiddenBy, 'zidolista:7');
    const un = await markUnhidden({ platform: 'twitch', messageId: id });
    assert.equal(un?.content, 'hi');
    rows = await db.select().from(messages).where(eq(messages.platformMessageId, id));
    assert.equal(rows[0]?.hiddenAt, null);
  } finally {
    await db.delete(messages).where(eq(messages.platformMessageId, id));
    await closeDb();
  }
});
