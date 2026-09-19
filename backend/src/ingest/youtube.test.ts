import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, lcr, pickAllChatToken, pickTimedContinuation, YouTubeListener } from './youtube.js';
import type { IngestMessage } from './types.js';

test('extractJson: brace counting přes vnořené objekty a stringy se závorkami', () => {
  const html = 'x var ytInitialData = {"a":{"b":"}"},"c":[1,{"d":2}]}; y';
  assert.deepEqual(extractJson(html, 'ytInitialData'), { a: { b: '}' }, c: [1, { d: 2 }] });
  assert.equal(extractJson('nothing', 'ytInitialData'), null);
});

test('lcr + pickAllChatToken + pickTimedContinuation', () => {
  const data = { contents: { liveChatRenderer: {
    header: { liveChatHeaderRenderer: { viewSelector: { sortFilterSubMenuRenderer: { subMenuItems: [
      { title: 'Nejlepší zprávy', selected: true },
      { title: 'Chat', selected: false, continuation: { reloadContinuationData: { continuation: 'ALL' } } },
    ] } } } },
    continuations: [{ invalidationContinuationData: { continuation: 'INV' } }, { timedContinuationData: { continuation: 'TIMED', timeoutMs: 4000 } }],
  } } };
  const l = lcr(data)!;
  assert.equal(pickAllChatToken(l), 'ALL');
  assert.deepEqual(pickTimedContinuation(l), { continuation: 'TIMED', timeoutMs: 4000 });
  assert.equal(pickAllChatToken({ header: { liveChatHeaderRenderer: { viewSelector: { sortFilterSubMenuRenderer: { subMenuItems: [{}, { selected: true }] } } } } }), null);
});

test('YouTubeListener: findLive → chat page (popout) → all-chat switch → API poll → onMessage', async () => {
  const calls: string[] = [];
  const renderer = (id: string, usec: string) => ({ addChatItemAction: { item: { liveChatTextMessageRenderer: { id, timestampUsec: usec, authorName: { simpleText: '@a' }, authorExternalChannelId: 'UC1', message: { runs: [{ text: 'hi ' + id }] } } } } });
  const pageJson = (actions: unknown[], all: boolean) => JSON.stringify({ contents: { liveChatRenderer: {
    header: { liveChatHeaderRenderer: { viewSelector: { sortFilterSubMenuRenderer: { subMenuItems: [{ selected: !all }, { selected: all, continuation: { reloadContinuationData: { continuation: 'ALLTOK' } } }] } } } },
    continuations: [{ timedContinuationData: { continuation: 'T1', timeoutMs: 10 } }],
    actions,
  } } });
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(url.split('?')[0] + (init?.method === 'POST' ? ' POST' : ''));
    if (url.endsWith('/robdiesalot/live')) return new Response('"isLive":true "videoId":"ABCDEFGHIJK"', { status: 200 });
    if (url.startsWith('https://www.youtube.com/live_chat?v=')) return new Response(`<script>var ytInitialData = ${pageJson([renderer('old', '1000000')], false)};</script>"INNERTUBE_API_KEY":"KEY" "clientVersion":"2.20260101.00.00"`, { status: 200 });
    if (url.startsWith('https://www.youtube.com/live_chat?continuation=')) return new Response(`<script>var ytInitialData = ${pageJson([renderer('old', '1000000')], true)};</script>`, { status: 200 });
    if (url.includes('/youtubei/v1/live_chat/get_live_chat')) return new Response(JSON.stringify({ continuationContents: { liveChatContinuation: { continuations: [{ timedContinuationData: { continuation: 'T2', timeoutMs: 10 } }], actions: [renderer('new1', '1789820014396123')] } } }), { status: 200 });
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;

  const got: IngestMessage[] = [];
  const l = new YouTubeListener('robdiesalot', (m) => got.push(m), { fetchImpl, log: { info() {}, warn() {}, error() {} }, minPollMs: 20 });
  l.start();
  await new Promise((r) => setTimeout(r, 120));
  l.stop();
  assert.ok(calls.includes('https://www.youtube.com/robdiesalot/live'));
  assert.ok(calls.includes('https://www.youtube.com/youtubei/v1/live_chat/get_live_chat POST'));
  // úvodní 'old' zprávy ze stránky se ukládají také (historie), 'new1' z API pollu
  assert.deepEqual(got.map((m) => m.platformMessageId).sort(), ['new1', 'old']);
  assert.equal(got.find((m) => m.platformMessageId === 'new1')!.sentAt.getTime(), 1789820014396);
});
