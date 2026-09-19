import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KickListener } from './kick.js';
import type { IngestMessage } from './types.js';

class FakeWs {
  static instances: FakeWs[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(public url: string) { FakeWs.instances.push(this); }
  send(s: string) { this.sent.push(s); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  recv(o: unknown) { this.onmessage?.({ data: JSON.stringify(o) }); }
}
const silent = { info() {}, warn() {}, error() {} };
const fakeFetch = (async (url: string) => {
  assert.equal(url, 'https://kick.com/api/v2/channels/robdiesalot');
  return new Response(JSON.stringify({ chatroom: { id: 91976532 }, user_id: 5 }), { status: 200 });
}) as unknown as typeof fetch;

test('KickListener: chatroom id z API, subscribe, ChatMessageEvent → onMessage', async () => {
  FakeWs.instances = [];
  const got: IngestMessage[] = [];
  const l = new KickListener('robdiesalot', (m) => got.push(m), { WebSocketCtor: FakeWs as unknown as typeof WebSocket, fetchImpl: fakeFetch, log: silent });
  l.start();
  await new Promise((r) => setTimeout(r, 10));
  const ws = FakeWs.instances[0];
  assert.match(ws.url, /^wss:\/\/ws-us2\.pusher\.com\/app\/32cbd69e4b950bf97679/);
  ws.open();
  ws.recv({ event: 'pusher:connection_established', data: '{}' });
  const sub = JSON.parse(ws.sent[0]);
  assert.equal(sub.event, 'pusher:subscribe');
  assert.equal(sub.data.channel, 'chatrooms.91976532.v2');
  ws.recv({ event: 'pusher_internal:subscription_succeeded', data: '{}' });
  assert.equal(l.status(), 'connected');
  ws.recv({ event: 'pusher:ping', data: {} });
  assert.ok(ws.sent.some((s) => s.includes('pusher:pong')));
  ws.recv({ event: 'App\\Events\\ChatMessageEvent', data: JSON.stringify({ id: 'k1', type: 'message', content: 'ahoj', created_at: '2026-09-19T12:00:00.000Z', sender: { id: 1, username: 'x', identity: { badges: [] } } }) });
  assert.equal(got.length, 1);
  assert.equal(got[0].platform, 'kick');
  l.stop();
});

test('KickListener: chybějící chatroom → reconnecting (retry přes fetch)', async () => {
  FakeWs.instances = [];
  const badFetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
  const l = new KickListener('robdiesalot', () => {}, { WebSocketCtor: FakeWs as unknown as typeof WebSocket, fetchImpl: badFetch, log: silent, reconnectBaseMs: 10 });
  l.start();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(l.status(), 'reconnecting');
  assert.equal(FakeWs.instances.length, 0);
  l.stop();
});
