import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, lcr, pickAllChatToken, pickTimedContinuation, pickLiveVideoId, YouTubeListener } from './youtube.js';
import type { IngestMessage } from './types.js';

test('extractJson: brace counting přes vnořené objekty a stringy se závorkami', () => {
  const html = 'x var ytInitialData = {"a":{"b":"}"},"c":[1,{"d":2}]}; y';
  assert.deepEqual(extractJson(html, 'ytInitialData'), { a: { b: '}' }, c: [1, { d: 2 }] });
  assert.equal(extractJson('nothing', 'ytInitialData'), null);
});

test('pickLiveVideoId: currentVideoEndpoint má přednost před prvním videoId, offline → null', () => {
  const html = '"videoId":"OLDVIDEO111" ... "currentVideoEndpoint":{"clickTrackingParams":"x","watchEndpoint":{"videoId":"LIVEVIDEO22","watchEndpointSupportedOnesieConfig":{}}} ... "isLive":true';
  assert.equal(pickLiveVideoId(html), 'LIVEVIDEO22');
  assert.equal(pickLiveVideoId('"isLiveNow":true "videoId":"ABCDEFGHIJK"'), 'ABCDEFGHIJK');
  assert.equal(pickLiveVideoId('"videoId":"ABCDEFGHIJK" "isLive":false'), null);
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

test('YouTubeListener: markChatItemAsDeletedAction/removeChatItemAction v akcích → onDelete, ne onMessage', async () => {
  const renderer = (id: string, usec: string) => ({ addChatItemAction: { item: { liveChatTextMessageRenderer: { id, timestampUsec: usec, authorName: { simpleText: '@a' }, authorExternalChannelId: 'UC1', message: { runs: [{ text: 'hi ' + id }] } } } } });
  const pageJson = (actions: unknown[]) => JSON.stringify({ contents: { liveChatRenderer: {
    continuations: [{ timedContinuationData: { continuation: 'T1', timeoutMs: 10 } }],
    actions,
  } } });
  const fetchImpl = (async (url: string) => {
    if (url.endsWith('/robdiesalot/live')) return new Response('"isLive":true "videoId":"ABCDEFGHIJK"', { status: 200 });
    if (url.startsWith('https://www.youtube.com/live_chat?v=')) {
      return new Response(`<script>var ytInitialData = ${pageJson([
        renderer('keep1', '1000000'),
        { markChatItemAsDeletedAction: { targetItemId: 'del1' } },
        { removeChatItemAction: { targetItemId: 'del2' } },
      ])};</script>"INNERTUBE_API_KEY":"KEY" "clientVersion":"2.20260101.00.00"`, { status: 200 });
    }
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;

  const got: IngestMessage[] = [];
  const deleted: { platform: string; channel: string; messageId: string }[] = [];
  const l = new YouTubeListener('robdiesalot', (m) => got.push(m), { fetchImpl, log: { info() {}, warn() {}, error() {} }, minPollMs: 20, onDelete: (d) => deleted.push(d) });
  l.start();
  await new Promise((r) => setTimeout(r, 60));
  l.stop();
  assert.deepEqual(got.map((m) => m.platformMessageId), ['keep1']);
  assert.deepEqual(deleted.sort((a, b) => a.messageId.localeCompare(b.messageId)), [
    { platform: 'youtube', channel: 'robdiesalot', messageId: 'del1' },
    { platform: 'youtube', channel: 'robdiesalot', messageId: 'del2' },
  ]);
});

test('YouTubeListener: stejné smazání v opakovaných odpovědích → onDelete jen jednou', async () => {
  const body = JSON.stringify({ contents: { liveChatRenderer: {
    continuations: [{ timedContinuationData: { continuation: 'T1', timeoutMs: 10 } }],
    actions: [{ markChatItemAsDeletedAction: { targetItemId: 'dup1' } }],
  } } });
  let polls = 0;
  const fetchImpl = (async (url: string) => {
    if (url.endsWith('/robdiesalot/live')) return new Response('"isLive":true "videoId":"ABCDEFGHIJK"', { status: 200 });
    if (url.startsWith('https://www.youtube.com/live_chat?v=')) {
      return new Response(`<script>var ytInitialData = ${body};</script>"INNERTUBE_API_KEY":"KEY" "clientVersion":"2.20260101.00.00"`, { status: 200 });
    }
    if (url.includes('/get_live_chat')) { polls++; return new Response(JSON.stringify({ continuationContents: { liveChatContinuation: JSON.parse(body).contents.liveChatRenderer } }), { status: 200 }); }
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
  const deleted: string[] = [];
  const l = new YouTubeListener('robdiesalot', () => {}, { fetchImpl, log: { info() {}, warn() {}, error() {} }, minPollMs: 10, onDelete: (d) => deleted.push(d.messageId) });
  l.start();
  await new Promise((r) => setTimeout(r, 120));
  l.stop();
  assert.ok(polls >= 2, `polls=${polls}`);
  assert.deepEqual(deleted, ['dup1']);
});

test('YouTubeListener: offline → live, nový stream → přepojení, konec streamu → zpět hledat', async () => {
  let live: string | null = null;   // aktuální videoId na /live (null = offline)
  const chatFor: string[] = [];
  const page = (vid: string) => `<script>var ytInitialData = ${JSON.stringify({ contents: { liveChatRenderer: { continuations: [{ timedContinuationData: { continuation: 'T-' + vid, timeoutMs: 10 } }], actions: [] } } })};</script>"INNERTUBE_API_KEY":"KEY"`;
  const fetchImpl = (async (url: string) => {
    if (url.endsWith('/live')) return new Response(live ? `"isLive":true "videoId":"${live}"` : 'offline', { status: 200 });
    const v = url.match(/live_chat\?v=([^&]+)/)?.[1];
    if (v) { chatFor.push(v); return new Response(page(v), { status: 200 }); }
    if (url.includes('get_live_chat')) return new Response(JSON.stringify({ continuationContents: { liveChatContinuation: { continuations: [{ timedContinuationData: { continuation: 'T', timeoutMs: 10 } }], actions: [] } } }), { status: 200 });
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
  const infos: string[] = [];
  const l = new YouTubeListener('robdiesalot', () => {}, { fetchImpl, log: { info: (_o, m) => infos.push(m), warn() {}, error() {} }, minPollMs: 10, liveCheckMs: 30, onlineCheckMs: 40 });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  l.start();
  await wait(100);
  assert.equal(l.status(), 'connecting', 'offline: hledá dál');
  assert.equal(infos.filter((m) => m.includes('není live')).length, 1, 'offline se loguje jen jednou');
  live = 'VIDEO1AAAAA';
  await wait(120);
  assert.equal(l.status(), 'connected');
  assert.equal(l.currentVideoId(), 'VIDEO1AAAAA');
  live = 'VIDEO2BBBBB';   // Rob stream restartoval
  await wait(150);
  assert.equal(l.currentVideoId(), 'VIDEO2BBBBB', 'online kontrola přepojila na nový stream');
  assert.ok(infos.includes('youtube ingest: nový stream → přepojuji'));
  live = null;   // stream skončil
  await wait(250);
  assert.notEqual(l.status(), 'connected', 'po 2× „není live" se vrací k hledání');
  assert.ok(infos.includes('youtube ingest: stream už není live → hledám po 10 s'));
  l.stop();
  assert.deepEqual([...new Set(chatFor)], ['VIDEO1AAAAA', 'VIDEO2BBBBB']);
});
