import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UcSendRegistry, GifReviewRegistry, SEND_TTL_MS, RECENT_TTL_MS } from './ucSends.js';
import type { IngestMessage } from '../ingest/types.js';

const msg = (o: Partial<IngestMessage>): IngestMessage => ({
  platform: 'twitch', platformMessageId: 'id1', platformUserId: 'u1', username: 'Tonner', channel: 'robdiesalot',
  content: '!chcihrat', contentRaw: {}, sentAt: new Date(), isUnitychatUser: false, isReply: false, replyToMessageId: null, ...o,
});

test('ucSends: hlášení před zprávou → match podle loginu (case-insensitive), jen jednou', () => {
  let t = 1000; const r = new UcSendRegistry(() => t);
  assert.equal(r.report({ platform: 'twitch', channel: 'RobDiesALot', username: 'tonner', text: '!chcihrat ' }), null);
  assert.equal(r.match(msg({})), true);
  assert.equal(r.match(msg({ platformMessageId: 'id2' })), false, 'spotřebováno');
});

test('ucSends: web podle userId, jiný kanál / text / po TTL ne', () => {
  let t = 1000; const r = new UcSendRegistry(() => t);
  r.report({ platform: 'twitch', channel: 'robdiesalot', userId: 'u1', text: '!chcihrat' });
  assert.equal(r.match(msg({ channel: 'jinykanal' })), false);
  assert.equal(r.match(msg({ content: '!jiny' })), false);
  assert.equal(r.match(msg({ username: 'JinéJméno' })), true, 'userId stačí');
  r.report({ platform: 'twitch', channel: 'robdiesalot', username: 'tonner', text: '!x' });
  t += SEND_TTL_MS + 1;
  assert.equal(r.match(msg({ content: '!x' })), false, 'po TTL');
});

test('ucSends: zpráva dřív než hlášení → report vrátí zprávu (zpětné označení)', () => {
  let t = 1000; const r = new UcSendRegistry(() => t);
  const m = msg({ platformMessageId: 'late1' });
  assert.equal(r.match(m), false);
  t += 2000;
  assert.equal(r.report({ platform: 'twitch', channel: 'robdiesalot', username: 'Tonner', text: '!chcihrat' })?.platformMessageId, 'late1');
  assert.equal(r.report({ platform: 'twitch', channel: 'robdiesalot', username: 'Tonner', text: '!chcihrat' }), null, 'podruhé už ne');
  const old = msg({ platformMessageId: 'old1', content: '!y' });
  r.match(old); t += RECENT_TTL_MS + 1;
  assert.equal(r.report({ platform: 'twitch', channel: 'robdiesalot', username: 'Tonner', text: '!y' }), null, 'moc stará');
});

test('ucReplies: odpověď napříč platformami nese data; najde i zprávu s markerem, která přišla dřív', () => {
  let t = 1000; const r = new UcSendRegistry<{ id: string }>(() => t, { recentMarked: true });
  r.report({ platform: 'kick', channel: 'robdiesalot', userId: 'u1', text: '@Tonner ahoj ⠀', data: { id: 'tw-1' } });
  assert.deepEqual(r.take(msg({ platform: 'kick', content: '@Tonner ahoj', isUnitychatUser: true })), { data: { id: 'tw-1' } });
  const early = msg({ platformMessageId: 'k2', content: '@Tonner znovu ⠀', isUnitychatUser: true });
  assert.equal(r.take(early), null);
  assert.equal(r.report({ platform: 'twitch', channel: 'robdiesalot', userId: 'u1', text: '@Tonner znovu', data: { id: 'tw-2' } })?.platformMessageId, 'k2');
  const plain = new UcSendRegistry(() => t);
  plain.match(msg({ platformMessageId: 'm1', content: 'x', isUnitychatUser: true }));
  assert.equal(plain.report({ platform: 'twitch', channel: 'robdiesalot', userId: 'u1', text: 'x' }), null, 'commandy si zprávy s markerem nepamatují');
});

test('gifReviews: hlášení před zprávou (/chat/send) → requested; po zprávě (/chat/uc-sent) → lateRequested jednou', () => {
  let t = 1000; const r = new GifReviewRegistry(() => t);
  const gif = 'hele https://tenor.com/view/cat-gif-1 ⠀';
  r.report({ platform: 'twitch', channel: 'robdiesalot', userId: 'u1', text: 'hele https://tenor.com/view/cat-gif-1' });
  assert.equal(r.requested(msg({ content: gif })), true, 'marker se ignoruje');
  assert.equal(r.requested(msg({ content: gif, platformMessageId: 'id2' })), false, 'spotřebováno');
  // Pozdní hlášení: zpráva napřed (requested ji zapamatuje), hlášení potom.
  assert.equal(r.requested(msg({ content: 'a https://giphy.com/gifs/x-1', platformMessageId: 'id3' })), false);
  assert.equal(r.lateRequested({ platform: 'twitch', platformMessageId: 'id3' }), false);
  r.report({ platform: 'twitch', channel: 'robdiesalot', username: 'tonner', text: 'a https://giphy.com/gifs/x-1' });
  assert.equal(r.lateRequested({ platform: 'twitch', platformMessageId: 'id3' }), true);
  assert.equal(r.lateRequested({ platform: 'twitch', platformMessageId: 'id3' }), false, 'jednou');
  // Pozdní hlášení po okně RECENT_TTL_MS → nic.
  r.requested(msg({ content: 'b https://giphy.com/gifs/x-2', platformMessageId: 'id4' }));
  t += RECENT_TTL_MS + 1;
  r.report({ platform: 'twitch', channel: 'robdiesalot', username: 'tonner', text: 'b https://giphy.com/gifs/x-2' });
  assert.equal(r.lateRequested({ platform: 'twitch', platformMessageId: 'id4' }), false);
});
