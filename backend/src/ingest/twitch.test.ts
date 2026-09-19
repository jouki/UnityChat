import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TwitchListener } from './twitch.js';
import type { IngestMessage } from './types.js';

class FakeWs {
  static instances: FakeWs[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(public url: string) { FakeWs.instances.push(this); }
  send(s: string) { this.sent.push(s); }
  close() { this.readyState = 3; this.onclose?.(); }
  // test helpers
  open() { this.readyState = 1; this.onopen?.(); }
  recv(data: string) { this.onmessage?.({ data }); }
}

const silent = { info() {}, warn() {}, error() {} };

test('TwitchListener: handshake, JOIN, PING→PONG, PRIVMSG → onMessage', () => {
  FakeWs.instances = [];
  const got: IngestMessage[] = [];
  const l = new TwitchListener('robdiesalot', (m) => got.push(m), { WebSocketCtor: FakeWs as unknown as typeof WebSocket, log: silent });
  l.start();
  const ws = FakeWs.instances[0];
  assert.equal(ws.url, 'wss://irc-ws.chat.twitch.tv:443');
  ws.open();
  assert.ok(ws.sent.some((s) => s.startsWith('CAP REQ :twitch.tv/tags twitch.tv/commands')));
  assert.ok(ws.sent.some((s) => s.startsWith('NICK justinfan')));
  assert.ok(ws.sent.includes('JOIN #robdiesalot'));
  assert.equal(l.status(), 'connected');
  ws.recv('PING :tmi.twitch.tv\r\n');
  assert.ok(ws.sent.includes('PONG :tmi.twitch.tv'));
  ws.recv('@id=m1;display-name=A;tmi-sent-ts=1700000000000;user-id=1 :a!a@a PRIVMSG #robdiesalot :hello\r\n@id=m2;display-name=B;tmi-sent-ts=1700000001000;user-id=2 :b!b@b PRIVMSG #robdiesalot :world\r\n');
  assert.equal(got.length, 2);
  assert.equal(got[1].content, 'world');
  assert.equal(l.lastMessageAt()?.getTime(), 1700000001000);
  l.stop();
  assert.equal(l.status(), 'off');
});

test('TwitchListener: po close se reconnectne s backoffem a stop() reconnect zruší', async () => {
  FakeWs.instances = [];
  const l = new TwitchListener('robdiesalot', () => {}, { WebSocketCtor: FakeWs as unknown as typeof WebSocket, log: silent, reconnectBaseMs: 10 });
  l.start();
  FakeWs.instances[0].open();
  FakeWs.instances[0].close();
  assert.equal(l.status(), 'reconnecting');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(FakeWs.instances.length, 2);
  l.stop();
  FakeWs.instances[1].close();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(FakeWs.instances.length, 2, 'po stop() žádný další pokus');
});
