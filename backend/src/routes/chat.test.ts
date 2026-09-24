import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toClientMessage, RateLimiter } from './chat.js';
import type { Message } from '../db/schema.js';

const base: Message = {
  id: 7, platform: 'twitch', platformMessageId: 'abc', platformUserId: '1', platformUsername: 'Trokner', userId: null,
  content: 'hi LUL',
  contentRaw: { color: '#B22222', badges: 'moderator/1', emotes: '425618:3-5', emotesOffset: 0, firstMsg: false, action: false, replyParentDisplayName: 'hlavis697', replyParentBody: 'x' },
  channel: 'robdiesalot', isUnitychatUser: false, isReply: true, replyToMessageId: 'p1',
  sentAt: new Date(1789820014396), createdAt: new Date(),
};

test('toClientMessage: twitch', () => {
  const c = toClientMessage(base);
  assert.deepEqual(c, {
    platform: 'twitch', id: 'abc', username: 'Trokner', userId: '1', message: 'hi LUL', timestamp: 1789820014396,
    color: '#B22222', badgesRaw: 'moderator/1', twitchEmotes: '425618:3-5', twitchEmotesOffset: 0, firstMsg: false, isAction: false,
    replyTo: { username: 'hlavis697', message: 'x', id: 'p1' }, historical: true,
  });
});

test('toClientMessage: kick a youtube nesou platformní payload', () => {
  const k = toClientMessage({ ...base, platform: 'kick', contentRaw: { content: 'a [emote:1:X]', color: '#53fc18', badges: [{ type: 'moderator', text: 'Moderator' }] }, isReply: false, replyToMessageId: null });
  assert.equal(k.kickContent, 'a [emote:1:X]');
  assert.equal(k.badgesRaw, 'moderator');
  const y = toClientMessage({ ...base, platform: 'youtube', contentRaw: { runs: [{ text: 'hi' }], superChat: true, badges: ['Moderátor'] }, isReply: false, replyToMessageId: null });
  assert.deepEqual(y.ytRuns, [{ text: 'hi' }]);
  assert.equal(y.superChat, true);
  assert.equal(y.color, '#ffd600');
});

test('RateLimiter: 10 tokenů, doplňuje 10/s', () => {
  let now = 0;
  const rl = new RateLimiter(10, 10, () => now);
  for (let i = 0; i < 10; i++) assert.equal(rl.allow('ip'), true);
  assert.equal(rl.allow('ip'), false);
  now = 100; // +1 token
  assert.equal(rl.allow('ip'), true);
  assert.equal(rl.allow('ip'), false);
  assert.equal(rl.allow('other'), true);
});

test('toClientMessage: historical=false pro živé zprávy z ingestu (řádek bez id)', () => {
  const { id: _id, createdAt: _c, userId: _u, ...fresh } = base;
  const c = toClientMessage(fresh, false);
  assert.equal(c.historical, false);
  assert.equal(c.id, 'abc');
  assert.equal(c.timestamp, 1789820014396);
});

test('toClientMessage: odpověď napříč platformami z content_raw.ucReply (YouTube i Kick), nativní má přednost', () => {
  const ucReply = { platform: 'twitch', id: 'tw-9', username: 'Tonner', message: 'ahoj' };
  const yt = toClientMessage({ ...base, platform: 'youtube', isReply: false, replyToMessageId: null, contentRaw: { runs: [], ucReply } });
  assert.deepEqual(yt.replyTo, { ...ucReply, uc: true });
  const kick = toClientMessage({ ...base, platform: 'kick', isReply: false, replyToMessageId: null, contentRaw: { content: 'x', ucReply } });
  assert.equal(kick.replyTo?.id, 'tw-9');
  const native = toClientMessage({ ...base, contentRaw: { ...(base.contentRaw as object), ucReply } });
  assert.equal(native.replyTo?.id, 'p1', 'nativní odpověď platformy vyhrává');
});
