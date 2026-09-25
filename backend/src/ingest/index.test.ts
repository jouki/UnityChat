import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIngest } from './index.js';
import type { IngestDelete, IngestListener, IngestMessage } from './types.js';

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

test('createIngest: retentionDays=0 → deleteOld se nikdy nevolá', async () => {
  let calls = 0;
  const l: IngestListener = { start() {}, stop() {}, status: () => 'connected', lastMessageAt: () => null };
  const ing = createIngest({ channels: [{ platform: 'twitch', channel: 'c' }], retentionDays: 0, log: silent, insert: async () => 0, deleteOld: async () => { calls++; return 0; }, listenerFactory: () => l, retentionMs: 5 });
  ing.start();
  await new Promise((r) => setTimeout(r, 30));
  await ing.stop();
  assert.equal(calls, 0);
});

test('createIngest: onLive dostane zprávu synchronně před flushem, chyba v něm ingest nezastaví', async () => {
  const live: string[] = [];
  const batches: number[] = [];
  let emit: ((m: IngestMessage) => void) | null = null;
  const fakeListener: IngestListener = { start() {}, stop() {}, status: () => 'connected', lastMessageAt: () => null };
  let calls = 0;
  const ing = createIngest({
    channels: [{ platform: 'twitch', channel: 'c' }],
    retentionDays: 0,
    log: silent,
    flushMs: 10,
    insert: async (rows) => { batches.push(rows.length); return rows.length; },
    deleteOld: async () => 0,
    listenerFactory: (_c, onMessage) => { emit = onMessage; return fakeListener; },
    onLive: (m) => { calls++; if (calls === 2) throw new Error('boom'); live.push(m.platformMessageId); },
  });
  ing.start();
  emit!(msg('a'));
  assert.deepEqual(live, ['a'], 'onLive proběhl hned, bez čekání na flush');
  assert.deepEqual(batches, [], 'DB flush ještě neproběhl');
  emit!(msg('b')); // onLive hodí — nesmí shodit ingest
  emit!(msg('c'));
  assert.deepEqual(live, ['a', 'c']);
  await ing.stop();
  assert.deepEqual(batches, [3], 'všechny tři zprávy došly do DB dávky');
});

test('createIngest: onDelete se protáhne do factory a chyba v něm ingest nezastaví', async () => {
  const deleted: IngestDelete[] = [];
  let emitDelete: ((d: IngestDelete) => void) | null = null;
  const fakeListener: IngestListener = { start() {}, stop() {}, status: () => 'connected', lastMessageAt: () => null };
  let calls = 0;
  const ing = createIngest({
    channels: [{ platform: 'twitch', channel: 'c' }],
    retentionDays: 0,
    log: silent,
    insert: async () => 0,
    deleteOld: async () => 0,
    listenerFactory: (_c, _onMessage, onDelete) => { emitDelete = onDelete ?? null; return fakeListener; },
    onDelete: (d) => { calls++; deleted.push(d); if (calls === 1) throw new Error('boom'); },
  });
  ing.start();
  emitDelete!({ platform: 'twitch', channel: 'c', messageId: 'm1' }); // hodí — nesmí shodit ingest
  emitDelete!({ platform: 'twitch', channel: 'c', messageId: 'm2' });
  assert.deepEqual(deleted.map((d) => d.messageId), ['m1', 'm2']);
  await ing.stop();
});
