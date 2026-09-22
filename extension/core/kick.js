// KickProvider — Kick chat přes Pusher WebSocket (chatroom id z veřejného
// kick.com/api/v2/channels). Sdílený core (addon i web), bez chrome.*/DOM:
// log, WebSocket i fetch jsou injektované přes opts. Tělo 1:1 ze sidepanel.js
// v3.39.19 (plán web v0.1, Task 4).
//
// Callbacky: onMessage(msg), onStatus(state, detail?), onUserId(id),
// onSubBadges(list). Tvar msg beze změny (platform 'kick', id, username,
// timestamp = created_at, color, badgesRaw, kickContent, message = text bez HTML).
import { stripTags } from './html.js';
import { makeLog } from './log.js';

export class KickProvider {
  /** opts.log(tag, text), opts.WebSocket, opts.fetch — injekce pro testy/web. */
  constructor(opts = {}) {
    this._log = makeLog(opts.log);
    this._WS = opts.WebSocket || globalThis.WebSocket;
    this._fetch = opts.fetch || ((...a) => globalThis.fetch(...a));
    this.ws = null;
    this.channel = '';
    this.chatroomId = null;
    this.userId = null;
    this.connected = false;
    this._rt = null;
    this._pt = null;
    this.onMessage = null;
    this.onStatus = null;
    this.onUserId = null;
    this.onSubBadges = null;
    this._badgeLogBudget = 5;
  }

  async connect(channel) {
    this.channel = channel.toLowerCase().trim();
    this.disconnect(true);
    this.onStatus?.('connecting');

    try {
      const resp = await this._fetch(`https://kick.com/api/v2/channels/${this.channel}`, {
        headers: { Accept: 'application/json' }
      });
      if (!resp.ok) throw new Error(`Kick API: ${resp.status}`);

      const data = await resp.json();
      this.chatroomId = data?.chatroom?.id;
      this.userId = data?.user_id || data?.id;
      if (!this.chatroomId) throw new Error('Chatroom nenalezen');
      if (this.userId) this.onUserId?.(this.userId);
      // Per-channel subscriber badge tiers ({months, badge_image.src}); the
      // built-in role badges are bundled in icons/kick-badges/.
      this.onSubBadges?.(Array.isArray(data?.subscriber_badges) ? data.subscriber_badges : []);

      this._connectPusher();
    } catch (err) {
      console.error('Kick:', err);
      this.onStatus?.('error', err.message);
      this._reconnect();
    }
  }

  _connectPusher() {
    const key = '32cbd69e4b950bf97679';
    this.ws = new this._WS(
      `wss://ws-us2.pusher.com/app/${key}?protocol=7&client=js&version=8.3.0&flash=false`
    );

    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        switch (msg.event) {
          case 'pusher:connection_established':
            this.ws.send(JSON.stringify({
              event: 'pusher:subscribe',
              data: { channel: `chatrooms.${this.chatroomId}.v2` }
            }));
            break;
          case 'pusher_internal:subscription_succeeded':
            this.connected = true;
            this.onStatus?.('connected');
            this._startPing();
            break;
          case 'pusher:ping':
            this.ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
            break;
          case 'App\\Events\\ChatMessageEvent':
            this._parse(msg.data);
            break;
        }
      } catch {}
    };

    this.ws.onclose = () => {
      this.connected = false;
      this._stopPing();
      this.onStatus?.('disconnected');
      this._reconnect();
    };

    this.ws.onerror = () => this.onStatus?.('error', 'Pusher chyba');
  }

  _parse(raw) {
    try {
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (data.type !== 'message' && data.type !== 'reply') return;

      const username = data.sender?.username || 'Unknown';
      const senderId = data.sender?.id || null;
      const color = data.sender?.identity?.color || '#53fc18';
      let content = data.content || '';

      // Parse native Kick reply metadata
      let replyTo = null;
      if (data.type === 'reply' && data.metadata) {
        const origMsg = data.metadata.original_message;
        const origSender = data.metadata.original_sender;
        if (origMsg && origSender) {
          replyTo = {
            id: origMsg.id,
            username: origSender.username,
            message: origMsg.content || null,
            platform: 'kick'
          };
          // Strip leading @username prefix if Kick added one
          const at = `@${origSender.username}`;
          if (content.startsWith(at + ' ')) content = content.substring(at.length + 1);
          else if (content.startsWith(at)) content = content.substring(at.length);
        }
      }

      // Kick sends roles as sender.identity.badges[] = {type, text, count?}
      // (e.g. moderator, subscriber+count, founder, vip, og, sub_gifter+count,
      // verified, broadcaster, bot). Serialised like Twitch's IRC tag so the
      // rest of the pipeline (cache, user entries) stays string-based.
      const identityBadges = Array.isArray(data.sender?.identity?.badges) ? data.sender.identity.badges : [];
      const badgesRaw = identityBadges
        .filter((b) => b && typeof b.type === 'string')
        .map((b) => (b.count ? `${b.type}/${b.count}` : b.type))
        .join(',');
      if (identityBadges.length && this._badgeLogBudget > 0) {
        this._badgeLogBudget--;
        this._log('KickBadge', `${username} identity=${JSON.stringify(data.sender?.identity)} senderKeys=${Object.keys(data.sender || {}).join(',')}`);
      }

      this.onMessage?.({
        platform: 'kick',
        username,
        senderId,
        kickContent: content, // surový HTML obsah pro EmoteManager
        message: this._textOnly(content), // plain text fallback
        color,
        badgesRaw,
        timestamp: Date.parse(data.created_at) || Date.now(), // čas z Kicku (ISO created_at)
        id: data.id || crypto.randomUUID(),
        replyTo
      });
    } catch {}
  }

  _textOnly(html) {
    // stripTags = textContent bez DOM (core/html.js): tagy pryč, entity dekódované.
    return stripTags(html);
  }

  _startPing() {
    this._stopPing();
    this._pt = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN)
        this.ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
    }, 30000);
  }

  _stopPing() {
    if (this._pt) { clearInterval(this._pt); this._pt = null; }
  }

  _reconnect() {
    if (this._rt) return;
    this._rt = setTimeout(() => {
      this._rt = null;
      if (!this.connected && this.channel) this.connect(this.channel);
    }, 5000);
  }

  disconnect(internal) {
    this.connected = false;
    this.userId = null;
    this._stopPing();
    if (this._rt) { clearTimeout(this._rt); this._rt = null; }
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
    if (!internal) this.onStatus?.('disconnected');
  }
}
