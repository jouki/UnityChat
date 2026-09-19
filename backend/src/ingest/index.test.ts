import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIngest } from './index.js';
import type { IngestListener, IngestMessage } from './types.js';

const silent = { info() {}, warn() {}, error() {} };
const msg = (id: string): IngestMessage => ({ platform: 'twitch', platformMessageId: id, platformUserId: '', username: 'u', channel: 'c', content: 'x', contentRaw: {}, sentAt: new Date(1700000000000), isUnitychatUser: false, isReply: false, replyToMessageId: null });

test('createIngest: startuje listenery per kanál, dávkuje inserty, hlásí status', async () => {
  const batches: number[] = [];
  let emit: ((m: IngestMessage) => void) | null = null;
  const fakeListener: IngestListener & { started: boolean } = {
    started: false,
    start() { this.started = true; },
    stop() { this.started = false; },
    status: () => 'connected',
    lastMessageAt: () => new Date(1700000000000),
  };
  const ing = createIngest({
    channels: [{ platform: 'twitch', channel: 'c' }],
    retentionDays: 7,
    log: silent,
    flushMs: 10,
    insert: async (rows) => { batches.push(rows.length); return rows.length; },
    deleteOld: async () => 0,
    listenerFactory: (_c, onMessage) => { emit = onMessage; return fakeListener; },
  });
  ing.start();
  assert.equal(fakeListener.started, true);
  emit!(msg('1'));
  emit!(msg('2'));
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(batches, [2]);
  const s = ing.status();
  assert.equal(s.twitch, 'connected');
  assert.equal(s.kick, 'off');
  assert.equal(s.inserted, 2);
  assert.equal(s.lastMessageAt, '2023-11-14T22:13:20.000Z');
  await ing.stop();
  assert.equal(fakeListener.started, false);
});

test('createIngest: bez kanálů je vše off a start() nic nedělá', async () => {
  const ing = createIngest({ channels: [], retentionDays: 7, log: silent, insert: async () => 0, deleteOld: async () => 0 });
  ing.start();
  assert.deepEqual(ing.status(), { twitch: 'off', kick: 'off', youtube: 'off', lastMessageAt: null, inserted: 0, dropped: 0 });
  await ing.stop();
});

test('createIngest: dva kanály na jedné platformě dostanou každý svůj listener', async () => {
  const made: string[] = [];
  const mk = (name: string, st: 'connected' | 'connecting'): IngestListener => ({ start() { made.push(name); }, stop() {}, status: () => st, lastMessageAt: () => null });
  const ing = createIngest({
    channels: [{ platform: 'twitch', channel: 'robdiesalot' }, { platform: 'twitch', channel: 'tensterakdary' }],
    retentionDays: 7, log: silent, insert: async () => 0, deleteOld: async () => 0,
    listenerFactory: (c) => mk(c.channel, c.channel === 'robdiesalot' ? 'connecting' : 'connected'),
  });
  ing.start();
  assert.deepEqual(made, ['robdiesalot', 'tensterakdary']);
  assert.equal(ing.status().twitch, 'connected');
  await ing.stop();
});
