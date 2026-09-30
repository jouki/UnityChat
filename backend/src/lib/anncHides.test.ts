import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnncHideRegistry } from './anncHides.js';

const T0 = 1_790_000_000_000;
const msg = (o: Partial<{ channel: string; username: string; content: string; at: number }>) => ({
  channel: o.channel ?? 'robdiesalot', username: o.username ?? 'Divak', content: o.content ?? 'ahoj', sentAt: new Date(o.at ?? T0 + 1000),
});

test('anncHides: odpověď commandu se stejným textem do 15 s → id announcementu; jiný text / pozdě ne', () => {
  let now = T0;
  const r = new AnncHideRegistry(() => now);
  assert.equal(r.remember({ id: 'a1', channel: 'RobDiesALot', at: T0, chatReply: { text: 'Brohemians!', hideInUnityChat: true } })?.id, 'a1');
  assert.equal(r.match(msg({ username: 'StreamElements', content: 'brohemians!  ⠀' }), 'robdiesalot'), 'a1', 'bez ohledu na velikost, mezery a marker');
  assert.equal(r.match(msg({ content: 'Brohemians! a něco' }), 'robdiesalot'), null);
  assert.equal(r.match(msg({ content: 'Brohemians!', at: T0 + 16_000 }), 'robdiesalot'), null, 'po 15 s ne');
  assert.equal(r.match(msg({ content: 'Brohemians!' }), 'jinykanal'), null, 'jiný kanál ne');
  now = T0 + 60_000;
  assert.equal(r.match(msg({ content: 'Brohemians!', at: T0 + 1000 }), 'robdiesalot'), null, 'prošlé záznamy pryč');
});

test('anncHides: odpověď bota podle odesílatele — jen první do 10 s, i 5 s před announcementem; hideInUnityChat=false nic', () => {
  const r = new AnncHideRegistry(() => T0);
  assert.equal(r.remember({ id: 'a2', channel: 'robdiesalot', at: T0, chatReply: { text: 'x', hideInUnityChat: false }, hideBotReplies: ['StreamElements', 'nightbot'] })?.botLogins.join(), 'streamelements,nightbot');
  assert.equal(r.match(msg({ username: 'Divak', content: 'x' }), 'robdiesalot'), null, 'text bez hideInUnityChat neskrývá');
  assert.equal(r.match(msg({ username: 'StreamElements', content: 'ODEBÍREJ…', at: T0 - 3000 }), 'robdiesalot'), 'a2', 'bot rychlejší než announcement');
  assert.equal(r.match(msg({ username: 'StreamElements', content: 'další', at: T0 + 2000 }), 'robdiesalot'), null, 'jen jedna zpráva bota');
  assert.equal(r.match(msg({ username: 'Nightbot', content: 'y', at: T0 + 11_000 }), 'robdiesalot'), null, 'po 10 s ne');
  assert.equal(r.remember({ id: 'a3', channel: 'robdiesalot', at: T0 }), null, 'nic ke skrytí');
});
