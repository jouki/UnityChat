import { normalizeTwitchPrivmsg, parseIrcLine } from './normalize.js';
import type { IngestDelete, IngestListener, IngestMessage, IngestUserModeration, PlatformStatus } from './types.js';
import type { IrcLine } from './normalize.js';

/**
 * CLEARCHAT → timeout/ban konkrétního uživatele. Bez `target-user-id` (vyčištění celého chatu) nebo
 * bez loginu v trailing → null. `ban-duration` = timeout v s, chybí = permanentní ban.
 */
export function clearchatToUserModeration(p: IrcLine, channel: string): IngestUserModeration | null {
  if (p.command !== 'CLEARCHAT') return null;
  const userId = p.tags['target-user-id'];
  const login = p.trailing.trim().toLowerCase();
  if (!userId || !login) return null;
  const d = Number(p.tags['ban-duration']);
  return { platform: 'twitch', channel: channel.toLowerCase(), userId, login, durationSec: Number.isFinite(d) && d > 0 ? d : null };
}

export interface Logger {
  info(o: object, msg: string): void;
  warn(o: object, msg: string): void;
  error(o: object, msg: string): void;
}
export const noopLog: Logger = { info() {}, warn() {}, error() {} };

interface Opts {
  WebSocketCtor?: typeof WebSocket; log?: Logger; reconnectBaseMs?: number;
  onDelete?: (d: IngestDelete) => void;
  onUserModerated?: (d: IngestUserModeration) => void;
}

/**
 * Anonymní IRC posluchač (justinfan) — port TwitchProvider z extension
 * (sidepanel.js), bez UI: jen PRIVMSG → onMessage. USERNOTICE (raid, sub…)
 * se zatím neukládá — klient je renderuje živě a v historii by potřeboval
 * vlastní render cestu; přidá se, až bude klientská část hotová.
 */
export class TwitchListener implements IngestListener {
  private ws: WebSocket | null = null;
  private st: PlatformStatus = 'off';
  private last: Date | null = null;
  private stopped = true;
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly Ctor: typeof WebSocket;
  private readonly log: Logger;
  private readonly baseMs: number;
  private readonly onDelete?: (d: IngestDelete) => void;
  private readonly onUserModerated?: (d: IngestUserModeration) => void;

  constructor(
    private readonly channel: string,
    private readonly onMessage: (m: IngestMessage) => void,
    opts: Opts = {},
  ) {
    this.Ctor = opts.WebSocketCtor ?? WebSocket;
    this.log = opts.log ?? noopLog;
    this.baseMs = opts.reconnectBaseMs ?? 1000;
    this.onDelete = opts.onDelete;
    this.onUserModerated = opts.onUserModerated;
  }

  status() { return this.st; }
  lastMessageAt() { return this.last; }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.onclose = null; ws.close(); } catch { /* socket už může být pryč */ } }
    this.st = 'off';
  }

  private connect() {
    this.st = this.attempt ? 'reconnecting' : 'connecting';
    let ws: WebSocket;
    try {
      ws = new this.Ctor('wss://irc-ws.chat.twitch.tv:443');
    } catch (err) {
      this.log.error({ err, channel: this.channel }, 'twitch ingest: WebSocket ctor selhal');
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      const nick = 'justinfan' + Math.floor(10000 + Math.random() * 90000);
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send('PASS SCHMOOPIIE');
      ws.send('NICK ' + nick);
      ws.send('JOIN #' + this.channel);
      this.st = 'connected';
      this.attempt = 0;
      this.log.info({ channel: this.channel }, 'twitch ingest: connected');
    };
    ws.onmessage = (e: MessageEvent) => {
      const data = typeof e.data === 'string' ? e.data : String(e.data);
      for (const line of data.split('\r\n')) {
        if (!line) continue;
        if (line.startsWith('PING')) { ws.send('PONG :tmi.twitch.tv'); continue; }
        // Příkaz z parsovaných IRC dat, ne podřetězcem — PRIVMSG s textem obsahujícím
        // "CLEARMSG" by se jinak tiše zahodila (viz code review 2026-09-25).
        const clearmsg = parseIrcLine(line);
        if (clearmsg?.command === 'CLEARMSG') {
          const id = clearmsg.tags['target-msg-id'];
          if (id && this.onDelete) {
            try { this.onDelete({ platform: 'twitch', channel: this.channel, messageId: id }); } catch (err) { this.log.error({ err }, 'twitch ingest: onDelete threw'); }
          }
          continue;
        }
        // CLEARCHAT (timeout/ban odjinud) — opět podle parsovaného příkazu, nikdy podřetězcem.
        if (clearmsg?.command === 'CLEARCHAT') {
          const um = clearchatToUserModeration(clearmsg, this.channel);
          if (um && this.onUserModerated) {
            try { this.onUserModerated(um); } catch (err) { this.log.error({ err }, 'twitch ingest: onUserModerated threw'); }
          }
          continue;
        }
        if (!line.includes('PRIVMSG')) continue;
        const m = normalizeTwitchPrivmsg(line, this.channel);
        if (!m) continue;
        this.last = m.sentAt;
        try { this.onMessage(m); } catch (err) { this.log.error({ err }, 'twitch ingest: onMessage threw'); }
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.log.warn({ channel: this.channel }, 'twitch ingest: socket closed');
      this.scheduleReconnect();
    };
    ws.onerror = (e: Event) => this.log.warn({ channel: this.channel, e: String(e) }, 'twitch ingest: socket error');
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    this.st = 'reconnecting';
    const delay = Math.min(30000, this.baseMs * 2 ** Math.min(this.attempt, 5));
    this.attempt++;
    this.timer = setTimeout(() => { this.timer = null; if (!this.stopped) this.connect(); }, delay);
  }
}
