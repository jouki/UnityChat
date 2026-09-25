import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rolesFromBadges, toChatEvent, modIntegrationEvent, publishIntegrationEvent, publishModIntegration, publishUserModIntegration, subscribeIntegration } from './integrationStream.js';

test('publishUserModIntegration: tvar chat.user_moderated, duration jen u timeoutu, nenamapovaný kanál nic', async () => {
  const ws = { slug: 'rob', channels: { twitch: 'robdiesalot', kick: 'robkick', youtube: null }, bot: { mode: 'shared' as const, displayName: 'JoukiBOT' } };
  const published: object[] = [];
  const deps = { workspaceFor: async (p: string, ch: string) => (ws.channels[p as 'twitch'] === ch ? ws : null), publish: (e: object) => { published.push(e); return 1; } };
  await publishUserModIntegration('robdiesalot', { platform: 'kick', userId: '77', login: 'k', action: 'timeout', duration: 60, by: 'twitch:modik' }, deps);
  await publishUserModIntegration('robdiesalot', { platform: 'twitch', userId: '1', login: 't', action: 'ban', duration: null, by: null }, deps);
  assert.equal(await publishUserModIntegration('jouki', { platform: 'twitch', userId: '1', login: 't', action: 'unban', by: null }, deps), null);
  assert.deepEqual(published, [
    { type: 'chat.user_moderated', workspace: 'rob', platform: 'kick', userId: '77', login: 'k', action: 'timeout', by: 'twitch:modik', duration: 60 },
    { type: 'chat.user_moderated', workspace: 'rob', platform: 'twitch', userId: '1', login: 't', action: 'ban', by: null },
  ]);
});
import type { FastifyReply } from 'fastify';
import type { WorkspaceInfo } from '../lib/zidolista.js';
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

test('modIntegrationEvent: tvary chat.deleted / chat.hidden / chat.unhidden', () => {
  assert.deepEqual(modIntegrationEvent('chat.deleted', 'rob', { platform: 'twitch', messageId: 'm1', by: 'zidolista:7', reason: 'mod' }),
    { type: 'chat.deleted', workspace: 'rob', platform: 'twitch', messageId: 'm1', by: 'zidolista:7', reason: 'mod' });
  assert.deepEqual(modIntegrationEvent('chat.hidden', 'rob', { platform: 'kick', messageId: 'k1', by: 'zidolista:7' }),
    { type: 'chat.hidden', workspace: 'rob', platform: 'kick', messageId: 'k1', by: 'zidolista:7' });
  assert.deepEqual(modIntegrationEvent('chat.unhidden', 'rob', { platform: 'youtube', messageId: 'y1', by: 'zidolista:7', reason: 'mod' }),
    { type: 'chat.unhidden', workspace: 'rob', platform: 'youtube', messageId: 'y1', by: 'zidolista:7' }, 'reason jen u chat.deleted');
});

function fakeReply(out: string[]): FastifyReply {
  return { raw: { write: (s: string) => { out.push(s); return true; }, on: () => {} } } as unknown as FastifyReply;
}

test('publishIntegrationEvent: stejný kurzor + replay přes Last-Event-ID, název události z type', () => {
  const live: string[] = [];
  const unsub = subscribeIntegration(fakeReply(live), null);
  const ev = modIntegrationEvent('chat.hidden', 'rob', { platform: 'twitch', messageId: 'h-replay', by: 'zidolista:1' });
  const id = publishIntegrationEvent(ev);
  unsub();
  const frame = live.find((f) => f.includes('h-replay'))!;
  assert.equal(frame, `id: ${id}\nevent: chat.hidden\ndata: ${JSON.stringify(ev)}\n\n`);
  const replay: string[] = [];
  const unsub2 = subscribeIntegration(fakeReply(replay), id - 1);
  unsub2();
  assert.ok(replay.includes(frame), 'replay po reconnectu vrátí moderační událost');
});

test('publishModIntegration: workspace podle UC kanálu (Twitch), fallback platformní kanál, nenamapovaný kanál nic', async () => {
  const ws: WorkspaceInfo = { slug: 'rob', channels: { twitch: 'robdiesalot', kick: 'robkick', youtube: null }, bot: { mode: 'shared', displayName: 'JoukiBOT' } };
  const find = async (platform: string, ch: string) => (ws.channels[platform as 'twitch'] === ch ? ws : null);
  const published: object[] = [];
  const deps = { workspaceFor: find, publish: (e: object) => { published.push(e); return 1; } };
  const a = await publishModIntegration('robdiesalot', 'chat.deleted', { platform: 'kick', messageId: 'k1', by: null, reason: 'platform' }, deps);
  assert.equal(a?.workspace, 'rob');
  const b = await publishModIntegration('robkick', 'chat.deleted', { platform: 'kick', messageId: 'k2', by: null, reason: 'platform' }, deps);
  assert.equal(b?.workspace, 'rob', 'ucChannelFor spadl na Kick slug → najít podle platformy');
  const c = await publishModIntegration('cizi', 'chat.hidden', { platform: 'twitch', messageId: 't1', by: 'x' }, deps);
  assert.equal(c, null);
  assert.equal(published.length, 2);
});
