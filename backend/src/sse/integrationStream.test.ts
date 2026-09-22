import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rolesFromBadges, toChatEvent } from './integrationStream.js';
import type { IngestMessage } from '../ingest/types.js';

test('rolesFromBadges: Twitch tag string', () => {
  assert.deepEqual(rolesFromBadges('twitch', 'moderator/1,subscriber/12'), { isSub: true, isMod: true, isVip: false, isBroadcaster: false });
  assert.deepEqual(rolesFromBadges('twitch', 'broadcaster/1'), { isSub: false, isMod: false, isVip: false, isBroadcaster: true });
  assert.deepEqual(rolesFromBadges('twitch', 'vip/1,founder/0'), { isSub: true, isMod: false, isVip: true, isBroadcaster: false });
  assert.equal(rolesFromBadges('twitch', '', 'RobDiesALot', 'robdiesalot').isBroadcaster, true, 'jméno = kanál');
});

test('rolesFromBadges: Kick pole objektů, YouTube tooltipy', () => {
  assert.deepEqual(rolesFromBadges('kick', [{ type: 'moderator' }, { type: 'og' }]), { isSub: false, isMod: true, isVip: true, isBroadcaster: false });
  assert.deepEqual(rolesFromBadges('youtube', ['Moderator', 'Member (6 months)']), { isSub: true, isMod: true, isVip: false, isBroadcaster: false });
  assert.equal(rolesFromBadges('youtube', ['Owner']).isBroadcaster, true);
  assert.deepEqual(rolesFromBadges('kick', undefined), { isSub: false, isMod: false, isVip: false, isBroadcaster: false });
});

test('toChatEvent: tvar chat.message podle kontraktu', () => {
  const m: IngestMessage = {
    platform: 'twitch', platformMessageId: 'abc', platformUserId: '30645675', username: 'Jouki728', channel: 'uctest',
    content: '!brohemians', contentRaw: { badges: 'subscriber/3', replyParentUsername: 'Rob' }, sentAt: new Date('2026-09-22T14:00:00Z'),
    isUnitychatUser: false, isReply: true, replyToMessageId: 'p1',
  };
  assert.deepEqual(toChatEvent(m, 'jouki'), {
    type: 'chat.message', workspace: 'jouki', messageId: 'abc', platform: 'twitch', user: 'Jouki728', userId: '30645675', text: '!brohemians',
    isSub: true, isMod: false, isVip: false, isBroadcaster: false, isBot: false, replyTo: { messageId: 'p1', user: 'Rob' }, timestamp: '2026-09-22T14:00:00.000Z',
  });
});
