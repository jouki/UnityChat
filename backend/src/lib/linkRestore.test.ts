import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishRestored, restoreOnPermit, type PublishRestoredDeps, type RestoredEvent } from './linkRestore.js';
import type { Message } from '../db/schema.js';

const row = (over: Partial<Message> = {}): Message => ({
  id: 1, platform: 'twitch', platformMessageId: 'm1', platformUserId: '42', platformUsername: 'divak', userId: null,
  content: 'koukni na neco.cz/x', contentRaw: { badges: '', color: '#ff0000' }, channel: 'robdiesalot',
  isUnitychatUser: false, isReply: false, replyToMessageId: null, sentAt: new Date(1_000), createdAt: new Date(1_000),
  deletedAt: null, deletedBy: null, deletedReason: null, hiddenAt: null, hiddenBy: null,
  ...over,
} as Message);

function deps(found: Message | null) {
  const sent: Array<[string, RestoredEvent]> = [];
  const forgot: string[] = [];
  const integ: RestoredEvent[] = [];
  const marks: unknown[] = [];
  const d: PublishRestoredDeps = {
    markRestored: async (p) => { marks.push(p); return found; },
    broadcast: (event, data) => { sent.push([event, data as RestoredEvent]); },
    now: () => 5_000,
    forget: (platform, id) => { forgot.push(`${platform}:${id}`); },
    integration: (ev) => { integ.push(ev); },
  };
  return { d, sent, forgot, integ, marks };
}

const P = { channel: 'robdiesalot', platform: 'twitch' as const, messageId: 'm1', userId: '42', platformChannel: 'robdiesalot', by: 'twitch:modik' };

test('publishRestored: zpráva smazaná filtrem → SSE message-restored s plným obsahem + chat.restored + zapomenutý dedup', async () => {
  const { d, sent, forgot, integ, marks } = deps(row());
  assert.equal(await publishRestored(P, d), 'ok');
  assert.deepEqual(marks, [{ platform: 'twitch', messageId: 'm1', userId: '42', platformChannel: 'robdiesalot' }]);
  assert.equal(sent.length, 1);
  const [event, ev] = sent[0];
  assert.equal(event, 'message-restored');
  assert.equal(ev.channel, 'robdiesalot');
  assert.equal(ev.messageId, 'm1');
  assert.equal(ev.by, 'twitch:modik');
  assert.equal((ev.message as { message: string }).message, 'koukni na neco.cz/x');
  assert.equal((ev.message as { deleted?: boolean }).deleted, undefined);
  assert.deepEqual(forgot, ['twitch:m1']);
  assert.equal(integ.length, 1);
});

test('publishRestored: nic k obnovení (jiný důvod / autor / kanál) → not_found, nic se neposílá', async () => {
  const { d, sent, forgot, integ } = deps(null);
  assert.equal(await publishRestored(P, d), 'not_found');
  assert.equal(sent.length + forgot.length + integ.length, 0);
});

test('publishRestored: chyba integrace neshodí obnovení', async () => {
  const { d, sent } = deps(row());
  d.integration = () => { throw new Error('registr dole'); };
  assert.equal(await publishRestored(P, d), 'ok');
  assert.equal(sent.length, 1);
});

test('restoreOnPermit: bez messageId nic; s ním přes platformní kanál; chyby do výsledku', async () => {
  const log = { warn() {} };
  let called: unknown = null;
  const base = {
    platformChannel: async (_c: string, p: string) => (p === 'kick' ? 'robkick' : null),
    publishRestored: async (p: unknown) => { called = p; return 'ok' as const; },
    log,
  };
  assert.equal(await restoreOnPermit({ channel: 'robdiesalot', platform: 'kick', userId: '7', by: 'x' }, base), null);
  assert.equal(called, null);
  assert.equal(await restoreOnPermit({ channel: 'robdiesalot', platform: 'kick', userId: '7', messageId: 'k1', by: 'x' }, base), 'ok');
  assert.deepEqual(called, { channel: 'robdiesalot', platform: 'kick', messageId: 'k1', userId: '7', platformChannel: 'robkick', by: 'x' });
  assert.equal(await restoreOnPermit({ channel: 'robdiesalot', platform: 'youtube', userId: '7', messageId: 'y1', by: 'x' }, base), 'error:no_channel');
  assert.equal(await restoreOnPermit({ channel: 'robdiesalot', platform: 'kick', userId: '7', messageId: 'k1', by: 'x' }, { ...base, publishRestored: async () => { throw new Error('db'); } }), 'error:db');
});
