import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BotPartRegistry, applyBotPart, ingestIdFor, PART_TTL_MS, type BotPart } from './botParts.js';
import { withSegmentFull, toClientMessage } from '../routes/chat.js';
import type { IngestMessage } from '../ingest/types.js';

const msg = (o: Partial<IngestMessage> = {}): IngestMessage => ({
  platform: 'youtube', platformMessageId: 'Ch1', platformUserId: 'UCbot', username: 'JoukiBOT', channel: 'robdiesalot',
  content: 'díl jedna', contentRaw: { runs: [{ text: 'díl jedna' }] }, sentAt: new Date(), isUnitychatUser: true, isReply: false, replyToMessageId: null, ...o,
});
const FULL = 'díl jedna díl dva';
const p = (index: number, total = 2): BotPart => ({ group: 'g1', index, total, fullText: FULL });

test('botParts: hlášení před echem i echo před hlášením (late), jen jednou', () => {
  let t = 1000; const r = new BotPartRegistry(() => t);
  assert.equal(r.note('youtube', 'Ch1', p(1)), null);
  assert.deepEqual(r.take(msg()), p(1));
  assert.equal(r.take(msg()), null, 'spotřebováno (a zapamatováno jako došlé)');
  // Echo dřív než hlášení → note vrátí zprávu.
  const m2 = msg({ platformMessageId: 'Ch2' });
  assert.equal(r.take(m2), null);
  assert.equal(r.note('youtube', 'Ch2', p(2)), m2);
  // Po TTL nic.
  r.note('youtube', 'Ch3', p(1));
  t += PART_TTL_MS + 1;
  assert.equal(r.take(msg({ platformMessageId: 'Ch3' })), null);
});

test('applyBotPart: díl 1 nese celý text, díl 2 je součást dílu 1; nedělená odpověď beze změny', () => {
  const r = new BotPartRegistry(() => 1000);
  const m1 = msg();
  assert.equal(applyBotPart(m1, p(1), r), null);
  assert.equal((m1.contentRaw as { segmentFull?: string }).segmentFull, FULL);
  const m2 = msg({ platformMessageId: 'Ch2', content: 'díl dva' });
  assert.equal(applyBotPart(m2, p(2), r), 'Ch1');
  assert.equal((m2.contentRaw as { segmentOf?: string }).segmentOf, 'Ch1');
  const single = msg({ platformMessageId: 'Ch9' });
  assert.equal(applyBotPart(single, { group: 'g2', index: 1, total: 1, fullText: 'x' }, r), null);
  assert.equal('segmentFull' in single.contentRaw, false);
  // Díl 2 jiné platformy se stejnou group nepatří k YouTube dílu 1.
  assert.equal(applyBotPart(msg({ platform: 'twitch', platformMessageId: 't2' }), p(2), r), null);
});

test('ingestIdFor: YouTube insert id → id v chatu, jinde beze změny', () => {
  assert.equal(ingestIdFor('youtube', 'LCC.EhwKGkNJN0ZpT09ybnBjREZhVEhQd1FkOGtFenRR'), 'ChwKGkNJN0ZpT09ybnBjREZhVEhQd1FkOGtFenRR');
  assert.equal(ingestIdFor('twitch', 'abc-1'), 'abc-1');
});

test('withSegmentFull / toClientMessage: díl 1 s celým textem (YouTube runs, Kick content), díl 2 dupHidden', () => {
  const base = { platform: 'youtube', platformMessageId: 'Ch1', platformUserId: 'UCbot', platformUsername: 'JoukiBOT', channel: 'robdiesalot', isUnitychatUser: true, isReply: false, replyToMessageId: null, sentAt: new Date(5000), deletedAt: null, hiddenAt: null };
  const yt = toClientMessage({ ...base, content: 'díl jedna', contentRaw: { runs: [{ text: 'díl jedna' }], segmentFull: FULL } } as Parameters<typeof toClientMessage>[0], false) as { message: string; ytRuns: { text: string }[]; dupHidden?: boolean };
  assert.equal(yt.message, FULL);
  assert.deepEqual(yt.ytRuns, [{ text: FULL }]);
  const kick = toClientMessage({ ...base, platform: 'kick', content: 'díl jedna', contentRaw: { content: 'díl jedna', segmentFull: FULL } } as Parameters<typeof toClientMessage>[0], false) as { kickContent: string };
  assert.equal(kick.kickContent, FULL);
  const two = toClientMessage({ ...base, platformMessageId: 'Ch2', content: 'díl dva', contentRaw: { runs: [], segmentOf: 'Ch1' } } as Parameters<typeof toClientMessage>[0], false) as { dupHidden?: boolean };
  assert.equal(two.dupHidden, true);
  const plain = { ...base, content: 'x', contentRaw: { runs: [{ text: 'x' }] } } as Parameters<typeof withSegmentFull>[0];
  assert.equal(withSegmentFull(plain), plain);
});
