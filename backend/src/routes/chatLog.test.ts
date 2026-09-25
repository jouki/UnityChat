import { test } from 'node:test';
import assert from 'node:assert/strict';
import { likePattern, clampLimit, toLogMessage } from './chatLog.js';

test('chat-log: vzor LIKE (%, _ doslovně), limit', () => {
  assert.equal(likePattern('50% off_x'), '%50\\% off\\_x%');
  assert.equal(likePattern('rob', { prefix: true }), 'rob%');
  assert.equal(clampLimit('500'), 200);
  assert.equal(clampLimit('abc'), 100);
  assert.equal(clampLimit(25), 25);
});

test('chat-log: zpráva → tvar pro dashboard (login z raw, role z badge)', () => {
  const m = toLogMessage({ id: 7, platform: 'twitch', platformMessageId: 'abc', platformUserId: '42', platformUsername: 'Jouki728', content: 'ahoj',
    contentRaw: { login: 'jouki728', badges: 'moderator/1,subscriber/12' }, channel: 'robdiesalot', sentAt: new Date('2026-09-25T10:00:00Z'), isReply: false, replyToMessageId: null, isUnitychatUser: true });
  assert.equal(m.login, 'jouki728');
  assert.equal(m.user, 'Jouki728');
  assert.equal(m.role, 'moderator');
  assert.equal(m.viaUnityChat, true);
  assert.match(m.cursor, /^\d+:7$/);
  const k = toLogMessage({ id: 8, platform: 'kick', platformMessageId: 'x', platformUserId: '9', platformUsername: 'Jouki_BOT', content: 'x',
    contentRaw: { senderSlug: 'jouki-bot' }, channel: 'robdiesalot', sentAt: new Date(), isReply: false, replyToMessageId: null, isUnitychatUser: false });
  assert.equal(k.login, 'jouki-bot', 'Kick slug');
  assert.equal(k.deleted, false);
  assert.equal(k.hidden, false);
});

test('chat-log: stav moderace — smazáno (kdo, proč) a skryto v UC, text zůstává pro mody', () => {
  const at = new Date('2026-09-25T12:00:00Z');
  const m = toLogMessage({ id: 9, platform: 'twitch', platformMessageId: 'd', platformUserId: '1', platformUsername: 'Troll', content: 'spam',
    contentRaw: {}, channel: 'robdiesalot', sentAt: at, isReply: false, replyToMessageId: null, isUnitychatUser: false,
    deletedAt: at, deletedBy: 'zidolista:5', deletedReason: 'mod', hiddenAt: null, hiddenBy: null });
  assert.equal(m.deleted, true);
  assert.equal(m.deletedAt, '2026-09-25T12:00:00.000Z');
  assert.equal(m.deletedBy, 'zidolista:5');
  assert.equal(m.deletedReason, 'mod');
  assert.equal(m.hidden, false);
  assert.equal(m.text, 'spam', 'mod vidí, co se smazalo');
  const h = toLogMessage({ id: 10, platform: 'kick', platformMessageId: 'h', platformUserId: '2', platformUsername: 'X', content: 'x',
    contentRaw: {}, channel: 'robdiesalot', sentAt: at, isReply: false, replyToMessageId: null, isUnitychatUser: false,
    deletedAt: null, deletedBy: null, deletedReason: null, hiddenAt: at, hiddenBy: 'twitch:jouki728' });
  assert.equal(h.hidden, true);
  assert.equal(h.hiddenBy, 'twitch:jouki728');
  assert.equal(h.deleted, false);
});
