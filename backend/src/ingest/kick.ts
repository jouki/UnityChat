import { normalizeKickMessage } from './normalize.js';
import { noopLog, type Logger } from './twitch.js';
import type { IngestListener, IngestMessage, PlatformStatus } from './types.js';

interface Opts { WebSocketCtor?: typeof WebSocket; fetchImpl?: typeof fetch; log?: Logger; reconnectBaseMs?: number }

const PUSHER_KEY = '32cbd69e4b950bf97679';

/** Port KickProvider z extension: channel API → chatroom id → Pusher subscribe. */
export class KickListener implements IngestListener {
  private ws: WebSocket | null = null;
  private st: PlatformStatus = 'off';
  private last: Date | null = null;
  private stopped = true;
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;
  private ping: NodeJS.Timeout | null = null;
  private chatroomId: number | null = null;
  private readonly Ctor: typeof WebSocket;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;
  private readonly baseMs: number;

  constructor(
    private readonly slug: string,
    private readonly onMessage: (m: IngestMessage) => void,
    opts: Opts = {},
  ) {
    this.Ctor = opts.WebSocketCtor ?? WebSocket;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? noopLog;
    this.baseMs = opts.reconnectBaseMs ?? 1000;
  }

  status() { return this.st; }
  lastMessageAt() { return this.last; }

  start() { this.stopped = false; void this.connect(); }

  stop() {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.ping) { clearInterval(this.ping); this.ping = null; }
    const ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.onclose = null; ws.close(); } catch { /* socket už může být pryč */ } }
    this.st = 'off';
  }

  private async connect() {
    this.st = this.attempt ? 'reconnecting' : 'connecting';
    try {
      const resp = await this.fetchImpl(`https://kick.com/api/v2/channels/${this.slug}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (UnityChat ingest)' },
      });
      if (!resp.ok) throw new Error(`Kick API ${resp.status}`);
      const data = (await resp.json()) as { chatroom?: { id?: number } };
      this.chatroomId = data?.chatroom?.id ?? null;
      if (!this.chatroomId) throw new Error('chatroom id nenalezen');
    } catch (err) {
      this.log.warn({ err, slug: this.slug }, 'kick ingest: channel API selhalo');
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;

    const ws = new this.Ctor(`wss://ws-us2.pusher.com/app/${PUSHER_KEY}?protocol=7&client=js&version=8.3.0&flash=false`);
    this.ws = ws;
    ws.onmessage = (e: MessageEvent) => {
      let msg: { event?: string; data?: unknown };
      try { msg = JSON.parse(String(e.data)); } catch { return; }
      switch (msg.event) {
        case 'pusher:connection_established':
          ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: `chatrooms.${this.chatroomId}.v2` } }));
          break;
        case 'pusher_internal:subscription_succeeded':
          this.st = 'connected';
          this.attempt = 0;
          this.startPing(ws);
          this.log.info({ slug: this.slug, chatroom: this.chatroomId }, 'kick ingest: subscribed');
          break;
        case 'pusher:ping':
          ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
          break;
        case 'pusher:error':
        case 'pusher_internal:subscription_error':
          this.log.warn({ slug: this.slug, data: msg.data }, 'kick ingest: pusher error → reconnect');
          try { ws.close(); } catch { /* ignore */ }
          break;
        case 'App\\Events\\ChatMessageEvent': {
          const m = normalizeKickMessage(msg.data, this.slug);
          if (!m) return;
          this.last = m.sentAt;
          try { this.onMessage(m); } catch (err) { this.log.error({ err }, 'kick ingest: onMessage threw'); }
          break;
        }
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.ping) { clearInterval(this.ping); this.ping = null; }
      this.log.warn({ slug: this.slug }, 'kick ingest: socket closed');
      this.scheduleReconnect();
    };
    ws.onerror = (e: Event) => this.log.warn({ slug: this.slug, e: String(e) }, 'kick ingest: socket error');
  }

  private startPing(ws: WebSocket) {
    if (this.ping) clearInterval(this.ping);
    this.ping = setInterval(() => { try { ws.send(JSON.stringify({ event: 'pusher:ping', data: {} })); } catch { /* ignore */ } }, 30000);
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    this.st = 'reconnecting';
    const delay = Math.min(30000, this.baseMs * 2 ** Math.min(this.attempt, 5));
    this.attempt++;
    this.timer = setTimeout(() => { this.timer = null; if (!this.stopped) void this.connect(); }, delay);
  }
}
