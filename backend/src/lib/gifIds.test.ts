import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gifFromRaw, isGifMessageId, gifMessageId, gifMediaUrl } from './gifIds.js';
import { toClientMessage } from '../routes/chat.js';
import { deletePlatformMessage } from './modActions.js';

const MEDIA = 'b'.repeat(32);
const row = (over: Record<string, unknown> = {}) => ({
  platform: 'youtube', platformMessageId: gifMessageId(5), platformUserId: 'UC1', platformUsername: 'Divak', content: 'ahoj',
  sentAt: new Date(1000), contentRaw: { gif: { mediaId: MEDIA, kind: 'mp4', width: 480, height: 270 }, runs: [{ text: 'ahoj' }] }, ...over,
});

test('gifIds: id syntetické zprávy, URL média, content_raw.gif jen s platným id', () => {
  assert.equal(gifMessageId(12), 'gif-12');
  assert.equal(isGifMessageId('gif-12'), true);
  assert.equal(isGifMessageId('abc-gif-1'), false);
  assert.equal(gifMediaUrl(MEDIA, 'https://api.jouki.cz/'), `https://api.jouki.cz/media/gif/${MEDIA}`);
  assert.equal(gifFromRaw({ gif: { mediaId: '../x', kind: 'gif' } }), null);
  assert.equal(gifFromRaw({}), null);
});

test('toClientMessage: schválený GIF nese gif; smazaný ani skrytý GIF neposílá', () => {
  const c = toClientMessage(row() as Parameters<typeof toClientMessage>[0]);
  assert.deepEqual(c.gif, { url: `http://localhost:3000/media/gif/${MEDIA}`, kind: 'mp4', width: 480, height: 270 });
  assert.deepEqual(c.ytRuns, [{ text: 'ahoj' }]);
  const d = toClientMessage(row({ deletedAt: new Date(), deletedReason: 'mod' }) as Parameters<typeof toClientMessage>[0]);
  assert.equal(d.gif, undefined);
  assert.equal(d.deleted, true);
  assert.equal(toClientMessage(row({ hiddenAt: new Date() }) as Parameters<typeof toClientMessage>[0]).gif, undefined);
});

test('deletePlatformMessage: syntetická zpráva gif-… se na platformě nemaže (ok bez volání API)', async () => {
  let called = false;
  const r = await deletePlatformMessage({ accountId: 1, channel: 'robdiesalot', platform: 'twitch', messageId: 'gif-3' }, { fetch: (async () => { called = true; return new Response(''); }) as unknown as typeof fetch });
  assert.equal(r, 'ok');
  assert.equal(called, false);
});
