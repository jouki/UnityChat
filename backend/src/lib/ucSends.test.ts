import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UcSendRegistry, SEND_TTL_MS, RECENT_TTL_MS } from './ucSends.js';
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
