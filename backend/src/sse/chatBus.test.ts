import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyReply } from 'fastify';
import { subscribeChatStream, publishChat, chatStreamClientCount, chatStreamClientsForIp, formatEvent, disconnectAllChatStreams } from './chatBus.js';

function fakeReply() {
  const frames: string[] = [];
  const reply = { raw: { write: (s: string) => { frames.push(s); return true; }, end: () => {} } } as unknown as FastifyReply;
  return { reply, frames };
}

test('chatBus: hello při subscribe, filtr podle kanálu i platformy, unsubscribe', () => {
  const a = fakeReply();
  const b = fakeReply();
  const offA = subscribeChatStream(a.reply, { ip: '1.1.1.1', channels: ['RobDiesALot', 'robdiesalot'], platforms: ['twitch', 'youtube'] });
  const offB = subscribeChatStream(b.reply, { ip: '2.2.2.2', channels: ['tensterakdary'], platforms: ['twitch'] });
  assert.equal(chatStreamClientCount(), 2);
  assert.equal(chatStreamClientsForIp('1.1.1.1'), 1);
  assert.equal(a.frames[0], formatEvent('hello', { channels: ['robdiesalot'], platforms: ['twitch', 'youtube'] }));

  const msg = { platform: 'twitch', id: 'm1', message: 'hi', historical: false };
  assert.equal(publishChat('RobDiesALot', 'twitch', msg), 1);
  assert.equal(a.frames[1], 'event: message\ndata: {"platform":"twitch","id":"m1","message":"hi","historical":false}\n\n');
  assert.equal(b.frames.length, 1, 'B odebírá jiný kanál');

  assert.equal(publishChat('robdiesalot', 'kick', msg), 0, 'A neodebírá kick');
  assert.equal(publishChat('tensterakdary', 'twitch', msg), 1);
  assert.equal(b.frames.length, 2);

  offA();
  assert.equal(chatStreamClientCount(), 1);
  assert.equal(publishChat('robdiesalot', 'twitch', msg), 0);
  offB();
  assert.equal(chatStreamClientCount(), 0);
});

test('chatBus: klient, jehož write hází, se odpojí a nerozbije ostatní', () => {
  const bad = { raw: { write: () => { throw new Error('EPIPE'); }, end: () => {} } } as unknown as FastifyReply;
  const good = fakeReply();
  subscribeChatStream(bad, { ip: 'x', channels: ['c'], platforms: ['twitch'] });
  subscribeChatStream(good.reply, { ip: 'y', channels: ['c'], platforms: ['twitch'] });
  assert.equal(chatStreamClientCount(), 1, 'bad klient vypadl už při hello');
  assert.equal(publishChat('c', 'twitch', { id: '1' }), 1);
  disconnectAllChatStreams();
  assert.equal(chatStreamClientCount(), 0);
});
