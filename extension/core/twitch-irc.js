// TwitchProvider — anonymní Twitch IRC (justinfan) přes WebSocket. Sdílený
// core (addon i web), bez chrome.*/DOM: logování a WebSocket jsou injektované
// přes opts. Tělo 1:1 ze sidepanel.js v3.39.18 (plán web v0.1, Task 3).
//
// Callbacky: onMessage(msg), onStatus(state, detail?), onRoomId(id),
// onClear(user), onClearMsg(id). Tvar msg beze změny (platform 'twitch', id,
// username, userId, message, timestamp = tmi-sent-ts, color, badgesRaw,
// twitchEmotes, firstMsg, isAction, replyTo, …).
import { twitchDefaultColor } from './colors.js';
import { makeLog } from './log.js';

export class TwitchProvider {
  /** opts.log(tag, text) — logování (addon: UC_LOG), opts.WebSocket — injekce pro testy/web. */
  constructor(opts = {}) {
    this._log = makeLog(opts.log);
    this._WS = opts.WebSocket || globalThis.WebSocket;
    this.ws = null;
    this.channel = '';
    this.connected = false;
    this.roomId = null;
    this._rt = null;
    this.onMessage = null;
    this.onStatus = null;
    this.onRoomId = null;
    // Mod actions: timeout/ban (CLEARCHAT) + single-message delete (CLEARMSG)
    this.onClear = null;
    this.onClearMsg = null;
  }

  connect(channel) {
    this.channel = channel.toLowerCase().trim();
    this.disconnect(true);
    this.onStatus?.('connecting');

    try {
      this.ws = new this._WS('wss://irc-ws.chat.twitch.tv:443');

      this.ws.onopen = () => {
        const n = 'justinfan' + Math.floor(10000 + Math.random() * 90000);
        this.ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
        this.ws.send('PASS SCHMOOPIIE');
        this.ws.send('NICK ' + n);
        this.ws.send('JOIN #' + this.channel);
        this.connected = true;
        this.onStatus?.('connected');
      };

      this.ws.onmessage = (e) => {
        for (const line of e.data.split('\r\n')) {
          if (!line) continue;
          if (line.startsWith('PING')) {
            this.ws.send('PONG :tmi.twitch.tv');
          } else if (line.includes('ROOMSTATE') && !this.roomId) {
            const m = line.match(/room-id=(\d+)/);
            if (m) {
              this.roomId = m[1];
              this.onRoomId?.(this.roomId);
            }
          } else if (line.includes('PRIVMSG')) {
            this._parse(line);
          } else if (line.includes('USERNOTICE')) {
            this._parseNotice(line);
          } else if (line.includes('CLEARCHAT')) {
            this._parseClearChat(line);
          } else if (line.includes('CLEARMSG')) {
            this._parseClearMsg(line);
          }
        }
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.onStatus?.('disconnected');
        this._reconnect();
      };

      this.ws.onerror = () => this.onStatus?.('error', 'WebSocket chyba');
    } catch (err) {
      this.onStatus?.('error', err.message);
      this._reconnect();
    }
  }

  _parse(raw) {
    let tags = {};
    let rest = raw;

    if (raw.startsWith('@')) {
      const si = raw.indexOf(' ');
      for (const t of raw.substring(1, si).split(';')) {
        const eq = t.indexOf('=');
        if (eq !== -1) tags[t.substring(0, eq)] = t.substring(eq + 1);
      }
      rest = raw.substring(si + 1);
    }

    const pi = rest.indexOf('PRIVMSG');
    if (pi === -1) return;
    const after = rest.substring(pi + 8);
    const ci = after.indexOf(':');
    if (ci === -1) return;

    let message = after.substring(ci + 1);
    const username = tags['display-name'] || rest.match(/:(\w+)!/)?.[1] || 'Unknown';
    const ircColor = tags.color;
    const color = ircColor || twitchDefaultColor(username);

    // Detect /me (CTCP ACTION): \x01ACTION text\x01
    let isAction = false;
    if (message.startsWith('\x01ACTION ') && message.endsWith('\x01')) {
      message = message.substring(8, message.length - 1);
      isAction = true;
    }

    // Surový badges string pro image rendering (parsuje se v _addMessage)
    const badgesRaw = tags.badges || '';

    // Reply context z Twitch IRC tagů
    let replyTo = null;
    const replyUser = tags['reply-parent-display-name'];
    if (replyUser) {
      let body = (tags['reply-parent-msg-body'] || '')
        .replace(/\\s/g, ' ')
        .replace(/\\n/g, ' ')
        .replace(/\\r/g, '')
        .replace(/\\:/g, ';')
        .replace(/\\\\/g, '\\');
      replyTo = {
        username: replyUser,
        message: body,
        id: tags['reply-parent-msg-id'] || null
      };
    }

    // Twitch přidává @username na začátek reply zpráv - odstranit
    // (reply context už ukazuje komu se odpovídá).
    // Track how many chars we stripped so emote positions in the emotes tag
    // (which are computed from the ORIGINAL message including the @username
    // prefix) can be shifted to match the trimmed body when we render.
    let cleanMessage = message;
    let replyPrefixLen = 0;
    if (replyTo && message.startsWith('@')) {
      const sp = message.indexOf(' ');
      if (sp !== -1) {
        cleanMessage = message.substring(sp + 1);
        replyPrefixLen = sp + 1;
      }
    }

    this.onMessage?.({
      platform: 'twitch',
      username,
      message: cleanMessage,
      color,
      // When IRC didn't carry a color= tag we fell back to the hash palette.
      // Signal that the listener should look up the real Twitch chat color
      // via GQL so we can retro-apply it (hash may differ from the user's
      // actual stored color assigned by Twitch).
      _needsColorLookup: !ircColor,
      // Twitch numeric user-id — needed to look up 7TV profile (nickname paint).
      userId: tags['user-id'] || null,
      timestamp: Number(tags['tmi-sent-ts']) || Date.now(), // čas z Twitche, ne z klienta (spec 2026-09-19)
      id: tags.id || crypto.randomUUID(),
      badgesRaw,
      twitchEmotes: tags.emotes || null,
      twitchEmotesOffset: replyPrefixLen || 0,
      replyTo,
      firstMsg: tags['first-msg'] === '1',
      isAction,
      // Channel-point reward redemption (with required message body).
      // IRC only exposes the reward UUID, not the display name/cost — those
      // come via PubSub which is OAuth-gated (not available anonymously).
      isRedeem: !!tags['custom-reward-id'],
      rewardId: tags['custom-reward-id'] || null,
      // Highlight My Message channel-point redeem — Twitch exposes this via msg-id.
      isHighlight: tags['msg-id'] === 'highlighted-message',
    });
  }

  _parseNotice(raw) {
    let tags = {};
    let rest = raw;
    if (raw.startsWith('@')) {
      const si = raw.indexOf(' ');
      for (const t of raw.substring(1, si).split(';')) {
        const eq = t.indexOf('=');
        if (eq !== -1) tags[t.substring(0, eq)] = t.substring(eq + 1);
      }
      rest = raw.substring(si + 1);
    }
    const msgId = tags['msg-id'];
    if (msgId === 'raid') {
      const raider = tags['msg-param-displayName'] || tags['display-name'] || '?';
      const viewers = tags['msg-param-viewerCount'] || '?';
      this.onMessage?.({
        platform: 'twitch',
        username: raider,
        message: `raiduje s ${viewers} diváky!`,
        color: '#ff6b6b',
        timestamp: Number(tags['tmi-sent-ts']) || Date.now(), // čas z Twitche, ne z klienta (spec 2026-09-19)
        id: tags.id || crypto.randomUUID(),
        isRaid: true,
        raidViewers: viewers,
      });
      return;
    }
    if (msgId === 'sub' || msgId === 'resub') {
      // Optional attached chat message body
      let body = '';
      const uni = rest.indexOf('USERNOTICE');
      if (uni !== -1) {
        const after = rest.substring(uni + 10);
        const ci = after.indexOf(':');
        if (ci !== -1) body = after.substring(ci + 1);
      }
      const username = tags['display-name'] || tags.login || '?';
      const ircColor = tags.color;
      const color = ircColor || twitchDefaultColor(username);
      const plan = tags['msg-param-sub-plan'] || '1000';
      const months = parseInt(tags['msg-param-cumulative-months'] || tags['msg-param-months'] || '0', 10) || null;
      const streak = (tags['msg-param-should-share-streak'] === '1')
        ? (parseInt(tags['msg-param-streak-months'] || '0', 10) || null)
        : null;
      this.onMessage?.({
        platform: 'twitch',
        username,
        message: body,
        color,
        _needsColorLookup: !ircColor,
        userId: tags['user-id'] || null,
        timestamp: Number(tags['tmi-sent-ts']) || Date.now(), // čas z Twitche, ne z klienta (spec 2026-09-19)
        id: tags.id || crypto.randomUUID(),
        badgesRaw: tags.badges || '',
        twitchEmotes: tags.emotes || null,
        isSubEvent: true,
        subPlan: plan,
        subMonths: months,
        subStreak: streak,
      });
      return;
    }
    if (msgId === 'submysterygift') {
      // Bundle announcement: "gifter is gifting N subs to the community"
      const gifter = tags['display-name'] || tags.login || '?';
      const count = parseInt(tags['msg-param-mass-gift-count'] || '0', 10) || 1;
      const plan = tags['msg-param-sub-plan'] || '1000';
      const ircColor = tags.color;
      const color = ircColor || twitchDefaultColor(gifter);
      this.onMessage?.({
        platform: 'twitch',
        username: gifter,
        message: '',
        color,
        _needsColorLookup: !ircColor,
        userId: tags['user-id'] || null,
        timestamp: Number(tags['tmi-sent-ts']) || Date.now(), // čas z Twitche, ne z klienta (spec 2026-09-19)
        id: tags.id || crypto.randomUUID(),
        badgesRaw: tags.badges || '',
        isGiftBundle: true,
        giftCount: count,
        giftPlan: plan,
      });
      return;
    }
    if (msgId === 'subgift') {
      // Individual gift line: "gifter gifted a sub to recipient"
      const gifter = tags['display-name'] || tags.login || '?';
      const recipient = tags['msg-param-recipient-display-name']
        || tags['msg-param-recipient-user-name'] || '?';
      const plan = tags['msg-param-sub-plan'] || '1000';
      const ircColor = tags.color;
      const color = ircColor || twitchDefaultColor(gifter);
      this.onMessage?.({
        platform: 'twitch',
        username: gifter,
        message: '',
        color,
        _needsColorLookup: !ircColor,
        userId: tags['user-id'] || null,
        timestamp: Number(tags['tmi-sent-ts']) || Date.now(), // čas z Twitche, ne z klienta (spec 2026-09-19)
        id: tags.id || crypto.randomUUID(),
        badgesRaw: tags.badges || '',
        isSubGift: true,
        giftRecipient: recipient,
        giftPlan: plan,
      });
      return;
    }
    if (msgId === 'viewermilestone') {
      // Watch streak / viewer milestone — Twitch awards channel points to
      // viewers when they hit milestones (e.g. 5-stream watch streak).
      // Tag names per Twitch IRC docs (https://dev.twitch.tv/docs/irc/tags/):
      //   msg-param-category    — milestone category (currently "watch-streak")
      //   msg-param-value       — milestone value (streak count)
      //   msg-param-copoReward  — channel points awarded
      let body = '';
      const uni = rest.indexOf('USERNOTICE');
      if (uni !== -1) {
        const after = rest.substring(uni + 10);
        const ci = after.indexOf(':');
        if (ci !== -1) body = after.substring(ci + 1);
      }
      const username = tags['display-name'] || tags.login || '?';
      const ircColor = tags.color;
      const color = ircColor || twitchDefaultColor(username);
      const category = tags['msg-param-category'] || 'watch-streak';
      const value = parseInt(tags['msg-param-value'] || '0', 10) || 0;
      const points = parseInt(tags['msg-param-copoReward'] || '0', 10) || 0;
      // Diagnostic: verify tag names match docs against real-world data.
      // Remove this block once a few production samples confirm the parser.
      this._log('Milestone', `category=${category} value=${value} points=${points} body="${body.slice(0, 80)}" tags=${JSON.stringify(tags).slice(0, 500)}`);
      this.onMessage?.({
        platform: 'twitch',
        username,
        message: body,
        color,
        _needsColorLookup: !ircColor,
        userId: tags['user-id'] || null,
        timestamp: Number(tags['tmi-sent-ts']) || Date.now(), // čas z Twitche, ne z klienta (spec 2026-09-19)
        id: tags.id || crypto.randomUUID(),
        badgesRaw: tags.badges || '',
        twitchEmotes: tags.emotes || null,
        isMilestone: true,
        milestoneCategory: category,
        milestoneValue: value,
        milestonePoints: points,
      });
      return;
    }
    if (msgId === 'announcement') {
      // USERNOTICE #channel :message text — grab the body after the command+channel.
      const uni = rest.indexOf('USERNOTICE');
      if (uni === -1) return;
      const after = rest.substring(uni + 10);
      const ci = after.indexOf(':');
      const message = ci !== -1 ? after.substring(ci + 1) : '';
      if (!message) return;
      const username = tags['display-name'] || '?';
      const ircColor = tags.color;
      const color = ircColor || twitchDefaultColor(username);
      // PRIMARY | BLUE | GREEN | ORANGE | PURPLE — used by CSS to pick accent color.
      const ann = (tags['msg-param-color'] || 'PRIMARY').toUpperCase();
      this.onMessage?.({
        platform: 'twitch',
        username,
        message,
        color,
        _needsColorLookup: !ircColor,
        userId: tags['user-id'] || null,
        timestamp: Number(tags['tmi-sent-ts']) || Date.now(), // čas z Twitche, ne z klienta (spec 2026-09-19)
        id: tags.id || crypto.randomUUID(),
        badgesRaw: tags.badges || '',
        twitchEmotes: tags.emotes || null,
        isAnnouncement: true,
        announcementColor: ann,
      });
    }
  }

  // CLEARCHAT — `:tmi.twitch.tv CLEARCHAT #channel :targetuser`
  // Tags: ban-duration=N (timeout, N seconds) — absent = permanent ban.
  // No target after the colon = chat-wide clear (we don't act on those).
  _parseClearChat(raw) {
    let tags = {};
    let rest = raw;
    if (raw.startsWith('@')) {
      const si = raw.indexOf(' ');
      for (const t of raw.substring(1, si).split(';')) {
        const eq = t.indexOf('=');
        if (eq !== -1) tags[t.substring(0, eq)] = t.substring(eq + 1);
      }
      rest = raw.substring(si + 1);
    }
    const ci = rest.indexOf('CLEARCHAT');
    if (ci === -1) return;
    const after = rest.substring(ci + 9);
    const colonIdx = after.indexOf(':');
    if (colonIdx === -1) return; // chat-wide clear, skip
    const targetUser = after.substring(colonIdx + 1).trim();
    if (!targetUser) return;
    const banDuration = tags['ban-duration']
      ? parseInt(tags['ban-duration'], 10) || null
      : null;
    this.onClear?.({ user: targetUser, banDuration });
  }

  // CLEARMSG — single message deletion. Tags: target-msg-id, login.
  _parseClearMsg(raw) {
    let tags = {};
    if (raw.startsWith('@')) {
      const si = raw.indexOf(' ');
      for (const t of raw.substring(1, si).split(';')) {
        const eq = t.indexOf('=');
        if (eq !== -1) tags[t.substring(0, eq)] = t.substring(eq + 1);
      }
    }
    const id = tags['target-msg-id'];
    if (!id) return;
    this.onClearMsg?.({ id, login: tags.login || null });
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
    this.roomId = null;
    if (this._rt) { clearTimeout(this._rt); this._rt = null; }
    if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
    if (!internal) this.onStatus?.('disconnected');
  }
}
