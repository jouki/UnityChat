// =============================================================
// UnityChat - Sjednocený chat z Twitch, YouTube a Kick
// 7TV emotes + Twitch/Kick/YouTube nativní emoty
// =============================================================

// Neviditelný marker na konci zpráv odeslaných přes UnityChat.
// Braille Pattern Blank (U+2800) - vypadá prázdně, platformy ho nestripují.
// Vkládá se za mezeru, aby neovlivnil trailing emoty.
const UC_MARKER = '\u2800';

const DEFAULTS = {
  channel: 'robdiesalot',
  kickChannel: 'robdiesalot',
  ytChannel: 'robdiesalot',
  twitch: true,
  youtube: true,
  kick: true,
  maxMessages: 500,
  username: '',
  layout: 'small'
};

// =============================================================
// EmoteManager - 7TV + BTTV + FFZ + Twitch + Kick + YouTube emotes
// Segment-based rendering: [{ type:'text'|'emote', value, url? }]
// =============================================================

class EmoteManager {
  constructor() {
    this.global7tv = new Map();   // name -> url
    this.channel7tv = new Map();  // name -> url
    this.bttvEmotes = new Map();   // name -> url (BTTV global + channel)
    this.ffzEmotes = new Map();    // name -> url (FFZ global + channel)
    this.twitchNative = new Map(); // name -> url (naučené z IRC)
    this.kickNative = new Map();   // name -> url (naučené z [emote:ID:NAME])
    this._globalLoaded = false;
  }

  // ---- Loading ----

  async loadGlobal() {
    if (this._globalLoaded) return;
    try {
      const resp = await fetch('https://7tv.io/v3/emote-sets/global');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const emotes = data.emotes || [];
      for (const emote of emotes) {
        const url = this._build7tvUrl(emote);
        if (url) this.global7tv.set(emote.name, url);
      }
      this._globalLoaded = true;
      console.log(`[7TV] ${this.global7tv.size} global emotes loaded`);
    } catch (err) {
      console.error('[7TV] Failed to load global emotes:', err);
    }
  }

  async loadChannel(platform, userId) {
    try {
      const resp = await fetch(`https://7tv.io/v3/users/${platform}/${userId}`);
      if (!resp.ok) {
        console.warn(`[7TV] Channel emotes ${platform}/${userId}: HTTP ${resp.status}`);
        return 0;
      }
      const data = await resp.json();
      const emotes = data.emote_set?.emotes || [];
      let count = 0;
      for (const emote of emotes) {
        const url = this._build7tvUrl(emote);
        if (url) {
          this.channel7tv.set(emote.name, url);
          count++;
        }
      }
      console.log(`[7TV] ${count} channel emotes loaded (${platform}/${userId})`);
      return count;
    } catch (err) {
      console.error(`[7TV] Channel emotes error (${platform}/${userId}):`, err);
      return 0;
    }
  }

  async loadBTTV(twitchUserId) {
    let count = 0;
    try {
      // Globální BTTV emotes
      const gr = await fetch('https://api.betterttv.net/3/cached/emotes/global');
      if (gr.ok) {
        for (const e of await gr.json()) {
          this.bttvEmotes.set(e.code, `https://cdn.betterttv.net/emote/${e.id}/1x`);
          count++;
        }
      }
    } catch {}
    try {
      // Kanálové BTTV emotes
      const cr = await fetch(`https://api.betterttv.net/3/cached/users/twitch/${twitchUserId}`);
      if (cr.ok) {
        const data = await cr.json();
        for (const e of [...(data.channelEmotes || []), ...(data.sharedEmotes || [])]) {
          this.bttvEmotes.set(e.code, `https://cdn.betterttv.net/emote/${e.id}/1x`);
          count++;
        }
      }
    } catch {}
    console.log(`[BTTV] ${count} emotes loaded`);
    return count;
  }

  async loadFFZ(twitchUserId) {
    let count = 0;
    const parseSet = (sets) => {
      for (const setId in sets) {
        for (const e of sets[setId].emoticons || []) {
          const url = e.urls?.['1'] || e.urls?.['2'];
          if (url) {
            this.ffzEmotes.set(e.name, url.startsWith('//') ? `https:${url}` : url);
            count++;
          }
        }
      }
    };
    try {
      const gr = await fetch('https://api.frankerfacez.com/v1/set/global');
      if (gr.ok) parseSet((await gr.json()).sets || {});
    } catch {}
    try {
      const cr = await fetch(`https://api.frankerfacez.com/v1/room/id/${twitchUserId}`);
      if (cr.ok) parseSet((await cr.json()).sets || {});
    } catch {}
    console.log(`[FFZ] ${count} emotes loaded`);
    return count;
  }

  _build7tvUrl(emote) {
    const host = emote.data?.host || emote.host;
    if (!host?.url) return null;

    // Preferovat WebP (animované), fallback na AVIF, pak cokoliv
    const file =
      host.files?.find((f) => f.name === '1x.webp') ||
      host.files?.find((f) => f.name === '2x.webp') ||
      host.files?.find((f) => f.name === '1x.avif') ||
      host.files?.find((f) => f.name?.startsWith('1x')) ||
      host.files?.[0];

    if (!file) return null;

    const baseUrl = host.url.startsWith('//')
      ? `https:${host.url}`
      : host.url;

    return `${baseUrl}/${file.name}`;
  }

  _get7tv(word) {
    return this.channel7tv.get(word) || this.global7tv.get(word)
      || this.bttvEmotes.get(word) || this.ffzEmotes.get(word) || null;
  }

  /** Vrátí URL emotu z jakéhokoliv zdroje (pro autocomplete preview). */
  getAnyUrl(name) {
    return this.channel7tv.get(name) || this.global7tv.get(name)
      || this.bttvEmotes.get(name) || this.ffzEmotes.get(name)
      || this.twitchNative.get(name) || this.kickNative.get(name)
      || null;
  }

  // ---- Učení nativních emotes z příchozích zpráv ----

  learnTwitch(text, emotesTag) {
    if (!emotesTag) return;
    for (const part of emotesTag.split('/')) {
      const ci = part.indexOf(':');
      if (ci === -1) continue;
      const id = part.substring(0, ci);
      const range = part.substring(ci + 1).split(',')[0];
      const dash = range.indexOf('-');
      if (dash === -1) continue;
      const s = parseInt(range.substring(0, dash), 10);
      const e = parseInt(range.substring(dash + 1), 10);
      if (isNaN(s) || isNaN(e)) continue;
      const name = text.substring(s, e + 1);
      if (name && !this.twitchNative.has(name)) {
        this.twitchNative.set(name,
          `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/1.0`);
      }
    }
  }

  learnKick(content) {
    if (!content) return;
    const re = /\[emote:(\d+):([^\]]+)\]/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      if (!this.kickNative.has(m[2])) {
        this.kickNative.set(m[2], `https://files.kick.com/emotes/${m[1]}/fullsize`);
      }
    }
  }

  /**
   * Tab autocomplete - hledá ve všech zdrojích emotes (case insensitive).
   */
  findCompletions(prefix) {
    if (!prefix) return [];
    const lower = prefix.toLowerCase();
    const results = [];
    const seen = new Set();

    // Pořadí: 7TV channel → 7TV global → BTTV → FFZ → Twitch → Kick
    const maps = [this.channel7tv, this.global7tv, this.bttvEmotes, this.ffzEmotes, this.twitchNative, this.kickNative];
    for (const map of maps) {
      for (const name of map.keys()) {
        if (name.toLowerCase().startsWith(lower) && !seen.has(name)) {
          results.push(name);
          seen.add(name);
        }
      }
    }

    results.sort((a, b) => {
      const aExact = a.startsWith(prefix);
      const bExact = b.startsWith(prefix);
      if (aExact !== bExact) return aExact ? -1 : 1;
      return a.localeCompare(b);
    });

    return results;
  }

  // ---- Rendering ----

  /**
   * Převede pole segmentů na finální HTML.
   * Textové segmenty projdou 7TV matching, emote segmenty se zachovají.
   */
  renderSegments(segments) {
    const out = [];
    for (const seg of segments) {
      if (seg.type === 'emote') {
        out.push(seg);
        continue;
      }
      // Rozdělit text na slova, zachovat mezery
      const parts = seg.value.split(/(\s+)/);
      for (const part of parts) {
        const url = this._get7tv(part);
        if (url) {
          out.push({ type: 'emote', value: part, url });
        } else {
          out.push({ type: 'text', value: part });
        }
      }
    }
    return this._toHtml(out);
  }

  /**
   * Twitch zpráva - parsuje IRC emotes tag + 7TV.
   */
  renderTwitch(text, emotesTag) {
    const segments = this._splitTwitchEmotes(text, emotesTag);
    return this.renderSegments(segments);
  }

  /**
   * Kick zpráva - parsuje HTML content (zachovává <img> emotes) + 7TV.
   */
  renderKick(htmlContent) {
    const segments = this._parseKickHtml(htmlContent);
    return this.renderSegments(segments);
  }

  /**
   * YouTube zpráva - parsuje runs array + 7TV.
   */
  renderYouTube(runs) {
    const segments = [];
    for (const run of runs) {
      if (run.text) {
        segments.push({ type: 'text', value: run.text });
      } else if (run.emoji) {
        const url =
          run.emoji.image?.thumbnails?.[0]?.url ||
          run.emoji.image?.thumbnails?.[1]?.url;
        const name = run.emoji.shortcuts?.[0] || run.emoji.emojiId || '';
        if (url) {
          segments.push({ type: 'emote', value: name, url });
        } else {
          segments.push({ type: 'text', value: name });
        }
      }
    }
    return this.renderSegments(segments);
  }

  /**
   * Prostý text + 7TV (pro fallback).
   */
  renderPlain(text) {
    return this.renderSegments([{ type: 'text', value: text }]);
  }

  // ---- Twitch emote parsing ----

  _splitTwitchEmotes(text, tag) {
    if (!tag) return [{ type: 'text', value: text }];

    const positions = [];
    for (const part of tag.split('/')) {
      if (!part) continue;
      const ci = part.indexOf(':');
      if (ci === -1) continue;
      const id = part.substring(0, ci);
      for (const range of part.substring(ci + 1).split(',')) {
        const dash = range.indexOf('-');
        if (dash === -1) continue;
        const s = parseInt(range.substring(0, dash), 10);
        const e = parseInt(range.substring(dash + 1), 10);
        if (!isNaN(s) && !isNaN(e)) {
          positions.push({ id, start: s, end: e + 1 });
        }
      }
    }

    if (positions.length === 0) return [{ type: 'text', value: text }];
    positions.sort((a, b) => a.start - b.start);

    const segs = [];
    let last = 0;
    for (const p of positions) {
      if (p.start > last) {
        segs.push({ type: 'text', value: text.substring(last, p.start) });
      }
      const name = text.substring(p.start, p.end);
      segs.push({
        type: 'emote',
        value: name,
        // OPRAVENÁ URL - správná doména jtvnw.net
        url: `https://static-cdn.jtvnw.net/emoticons/v2/${p.id}/default/dark/1.0`
      });
      last = p.end;
    }
    if (last < text.length) {
      segs.push({ type: 'text', value: text.substring(last) });
    }
    return segs;
  }

  // ---- Kick content parsing ----

  _parseKickHtml(content) {
    if (!content) return [{ type: 'text', value: '' }];

    // Krok 1: [emote:ID:NAME] → emote segmenty
    const hasEmoteTags = content.includes('[emote:');
    const hasHtml = content.includes('<');

    if (!hasEmoteTags && !hasHtml) {
      return [{ type: 'text', value: content }];
    }

    // Parsovat [emote:ID:NAME] tagy
    if (hasEmoteTags) {
      const segments = [];
      const re = /\[emote:(\d+):([^\]]+)\]/g;
      let last = 0;
      let m;
      while ((m = re.exec(content)) !== null) {
        if (m.index > last) {
          const txt = content.substring(last, m.index);
          segments.push(...this._parseKickHtmlFragment(txt));
        }
        segments.push({
          type: 'emote',
          value: m[2],
          url: `https://files.kick.com/emotes/${m[1]}/fullsize`
        });
        last = m.index + m[0].length;
      }
      if (last < content.length) {
        segments.push(...this._parseKickHtmlFragment(content.substring(last)));
      }
      return segments.length > 0 ? segments : [{ type: 'text', value: content }];
    }

    // Jen HTML (bez [emote:] tagů)
    return this._parseKickHtmlFragment(content);
  }

  _parseKickHtmlFragment(html) {
    if (!html) return [];
    if (!html.includes('<')) return [{ type: 'text', value: html }];

    const div = document.createElement('div');
    div.innerHTML = html;
    const segments = [];
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent) segments.push({ type: 'text', value: node.textContent });
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.tagName === 'IMG') {
          const src = node.getAttribute('src') || '';
          const alt = node.getAttribute('alt') || '';
          if (src.startsWith('http')) {
            segments.push({ type: 'emote', value: alt, url: src });
          } else {
            segments.push({ type: 'text', value: alt });
          }
        } else {
          for (const child of node.childNodes) walk(child);
        }
      }
    };
    walk(div);
    return segments.length > 0 ? segments : [{ type: 'text', value: div.textContent || '' }];
  }

  // ---- HTML helpers ----

  _toHtml(segments) {
    return segments
      .map((s) => {
        if (s.type === 'emote') {
          const alt = this._ea(s.value);
          return `<img class="emote" src="${this._ea(s.url)}" alt="${alt}" title="${alt}">`;
        }
        return this._eh(s.value);
      })
      .join('');
  }

  _eh(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  _ea(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}

// =============================================================
// NicknameManager - custom display names backed by api.jouki.cz
// SSE push for real-time updates, chrome.storage.local cache
// =============================================================

// DEV: http://178.104.160.182:3001 | PROD: https://api.jouki.cz
const UC_API = 'http://178.104.160.182:3001';

class NicknameManager {
  constructor() {
    this._map = new Map();       // "platform:username" → { nickname, color }
    this._eventSource = null;
    this.onChange = null;         // callback: ({ platform, username, nickname, color }) => void
    this.onLoad = null;          // callback after fetchAll completes
  }

  async loadCache() {
    try {
      const s = await chrome.storage.local.get('uc_nicknames');
      if (s.uc_nicknames && typeof s.uc_nicknames === 'object') {
        for (const [k, v] of Object.entries(s.uc_nicknames)) {
          // Backward compat: old cache stored string, new stores {nickname, color}
          this._map.set(k, typeof v === 'string' ? { nickname: v, color: null } : v);
        }
      }
    } catch {}
  }

  async fetchAll() {
    try {
      const resp = await fetch(`${UC_API}/nicknames`);
      if (!resp.ok) return;
      const data = await resp.json();
      this._map.clear();
      for (const n of data.nicknames) {
        this._map.set(`${n.platform}:${n.username.toLowerCase()}`, {
          nickname: n.nickname,
          color: n.color || null,
        });
      }
      this._saveCache();
      if (this.onLoad) this.onLoad();
    } catch {}
  }

  connectSSE() {
    if (this._eventSource) return;
    try {
      this._eventSource = new EventSource(`${UC_API}/nicknames/stream`);
      this._eventSource.addEventListener('nickname-change', (e) => {
        try {
          const d = JSON.parse(e.data);
          const key = `${d.platform}:${d.username.toLowerCase()}`;
          this._map.set(key, { nickname: d.nickname, color: d.color || null });
          this._saveCache();
          if (this.onChange) this.onChange(d);
        } catch {}
      });
      this._eventSource.onerror = () => {
        if (this._eventSource?.readyState === EventSource.CLOSED) {
          this._eventSource = null;
          setTimeout(() => this.connectSSE(), 5000);
        }
      };
    } catch {}
  }

  disconnect() {
    if (this._eventSource) {
      this._eventSource.close();
      this._eventSource = null;
    }
  }

  get(platform, username) {
    if (!platform || !username) return null;
    const name = username.toLowerCase().replace(/^@/, '');
    return this._map.get(`${platform}:${name}`) || null;
  }

  getNickname(platform, username) {
    return this.get(platform, username)?.nickname || null;
  }

  getColor(platform, username) {
    return this.get(platform, username)?.color || null;
  }

  async save(platform, username, nickname, color) {
    const cleanName = username.replace(/^@/, '');
    try {
      const resp = await fetch(`${UC_API}/nicknames`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, username: cleanName, nickname, color: color || null }),
      });
      const data = await resp.json();
      if (data.ok) {
        this._map.set(`${platform}:${cleanName.toLowerCase()}`, { nickname, color: color || null });
        this._saveCache();
      }
      return data;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  _saveCache() {
    const obj = Object.fromEntries(this._map);
    chrome.storage.local.set({ uc_nicknames: obj }).catch(() => {});
  }
}

// =============================================================
// Twitch IRC Provider
// =============================================================

class TwitchProvider {
  constructor() {
    this.ws = null;
    this.channel = '';
    this.connected = false;
    this.roomId = null;
    this._rt = null;
    this.onMessage = null;
    this.onStatus = null;
    this.onRoomId = null;
  }

  connect(channel) {
    this.channel = channel.toLowerCase().trim();
    this.disconnect(true);
    this.onStatus?.('connecting');

    try {
      this.ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');

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

    const message = after.substring(ci + 1);
    const username = tags['display-name'] || rest.match(/:(\w+)!/)?.[1] || 'Unknown';
    const color = tags.color || '#9146ff';

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
    // (reply context už ukazuje komu se odpovídá)
    let cleanMessage = message;
    if (replyTo && message.startsWith('@')) {
      const sp = message.indexOf(' ');
      if (sp !== -1) cleanMessage = message.substring(sp + 1);
    }

    this.onMessage?.({
      platform: 'twitch',
      username,
      message: cleanMessage,
      color,
      timestamp: Date.now(),
      id: tags.id || crypto.randomUUID(),
      badgesRaw,
      twitchEmotes: tags.emotes || null,
      replyTo,
      firstMsg: tags['first-msg'] === '1'
    });
  }

  _parseNotice(raw) {
    let tags = {};
    if (raw.startsWith('@')) {
      const si = raw.indexOf(' ');
      for (const t of raw.substring(1, si).split(';')) {
        const eq = t.indexOf('=');
        if (eq !== -1) tags[t.substring(0, eq)] = t.substring(eq + 1);
      }
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
        timestamp: Date.now(),
        id: tags.id || crypto.randomUUID(),
        isRaid: true
      });
    }
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

// =============================================================
// Kick Provider (Pusher WebSocket)
// =============================================================

class KickProvider {
  constructor() {
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
  }

  async connect(channel) {
    this.channel = channel.toLowerCase().trim();
    this.disconnect(true);
    this.onStatus?.('connecting');

    try {
      const resp = await fetch(`https://kick.com/api/v2/channels/${this.channel}`, {
        headers: { Accept: 'application/json' }
      });
      if (!resp.ok) throw new Error(`Kick API: ${resp.status}`);

      const data = await resp.json();
      this.chatroomId = data?.chatroom?.id;
      this.userId = data?.user_id || data?.id;
      if (!this.chatroomId) throw new Error('Chatroom nenalezen');
      if (this.userId) this.onUserId?.(this.userId);

      this._connectPusher();
    } catch (err) {
      console.error('Kick:', err);
      this.onStatus?.('error', err.message);
      this._reconnect();
    }
  }

  _connectPusher() {
    const key = '32cbd69e4b950bf97679';
    this.ws = new WebSocket(
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
      const color = data.sender?.identity?.color || '#53fc18';
      const content = data.content || '';

      const badges = [];
      if (data.sender?.is_broadcaster) badges.push('\uD83C\uDFA4');
      if (data.sender?.is_moderator) badges.push('\u2694\uFE0F');
      if (data.sender?.is_subscriber) badges.push('\u2B50');

      this.onMessage?.({
        platform: 'kick',
        username,
        kickContent: content, // surový HTML obsah pro EmoteManager
        message: this._textOnly(content), // plain text fallback
        color,
        badges,
        timestamp: Date.now(),
        id: data.id || crypto.randomUUID()
      });
    } catch {}
  }

  _textOnly(html) {
    if (!html.includes('<')) return html;
    const d = document.createElement('div');
    d.innerHTML = html;
    return d.textContent || '';
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

// =============================================================
// YouTube Live Chat Provider
// Dual approach: zkusí interní API, při selhání přepne na page refresh
// =============================================================

class YouTubeProvider {
  constructor() {
    this.channel = '';
    this.polling = false;
    this._pt = null;
    this._videoId = null;
    this._cont = null;
    this._apiKey = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
    this._ctx = null;
    this._seen = new Set();
    this._apiFails = 0;       // počet po sobě jdoucích prázdných API odpovědí
    this._usePageRefresh = false;
    this.onMessage = null;
    this.onStatus = null;
    this.onDebug = null;      // callback pro debug zprávy
  }

  async connect(channel) {
    this.channel = channel.trim();
    this.disconnect(true);
    this.onStatus?.('connecting');

    try {
      // Krok 1: najít videoId
      this._videoId = await this._findLiveVideoId();
      if (!this._videoId) throw new Error('Streamer není live na YouTube');
      this.onDebug?.(`YouTube videoId: ${this._videoId}`);

      // Krok 2: načíst live chat stránku
      const chatHtml = await this._fetchChatPage();
      const ytData = this._extractJson(chatHtml, 'ytInitialData');
      if (!ytData) throw new Error('YouTube chat data nenalezena');

      // API key + client version + visitorData
      const keyM = chatHtml.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
      if (keyM) this._apiKey = keyM[1];
      const verM = chatHtml.match(/"clientVersion"\s*:\s*"([^"]+)"/);
      const visM = chatHtml.match(/"visitorData"\s*:\s*"([^"]+)"/);
      this._ctx = {
        client: {
          clientName: 'WEB',
          clientVersion: verM?.[1] || '2.20250401.00.00',
          hl: 'cs',
          gl: 'CZ',
          ...(visM ? { visitorData: visM[1] } : {})
        }
      };

      // Continuation token - preferovat timedContinuationData (funguje s pollingem)
      const conts = ytData?.contents?.liveChatRenderer?.continuations;
      if (conts?.length) {
        for (const c of conts) {
          // timedContinuationData funguje nejlépe s HTTP pollingem
          if (c?.timedContinuationData?.continuation) {
            this._cont = c.timedContinuationData.continuation;
            break;
          }
        }
        // Fallback na jiný typ
        if (!this._cont) {
          const c = conts[0];
          this._cont =
            c?.reloadContinuationData?.continuation ||
            c?.invalidationContinuationData?.continuation;
        }
      }

      // Zpracovat úvodní zprávy (zobrazit posledních několik)
      const actions = ytData?.contents?.liveChatRenderer?.actions || [];
      const recentActions = actions.slice(-10); // zobrazit max 10 posledních
      this._processActions(recentActions);
      // Označit všechny jako viděné
      for (const a of actions) {
        const r =
          a?.addChatItemAction?.item?.liveChatTextMessageRenderer ||
          a?.addChatItemAction?.item?.liveChatPaidMessageRenderer;
        if (r?.id) this._seen.add(r.id);
      }

      this.polling = true;
      this._apiFails = 0;
      this._usePageRefresh = !this._cont; // bez continuation jdeme rovnou na page refresh
      this.onStatus?.('connected');

      if (this._usePageRefresh) {
        this.onDebug?.('YouTube: page refresh mód (bez continuation)');
      } else {
        this.onDebug?.('YouTube: API polling mód');
      }

      this._pt = setTimeout(() => this._poll(), 2000);
    } catch (err) {
      console.error('YouTube:', err);
      this.onStatus?.('error', err.message);
    }
  }

  async _fetchChatPage() {
    const resp = await fetch(
      `https://www.youtube.com/live_chat?v=${this._videoId}`,
      { credentials: 'include' }
    );
    if (!resp.ok) throw new Error(`YouTube chat page: ${resp.status}`);
    return resp.text();
  }

  async _findLiveVideoId() {
    const urls = [
      `https://www.youtube.com/${this.channel}/live`,
      `https://www.youtube.com/@${this.channel}/live`
    ];
    for (const url of urls) {
      try {
        const r = await fetch(url, { credentials: 'include', redirect: 'follow' });
        if (!r.ok) continue;
        const html = await r.text();
        const isLive =
          html.includes('"isLive":true') ||
          html.includes('"isLiveContent":true') ||
          html.includes('"isLiveNow":true') ||
          html.includes('"isLiveBroadcast":true');
        if (!isLive) continue;
        const m = html.match(/"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/);
        if (m) return m[1];
      } catch {
        continue;
      }
    }
    return null;
  }

  _extractJson(html, varName) {
    const markers = [
      `var ${varName} = `,
      `window["${varName}"] = `,
      `window['${varName}'] = `
    ];
    let start = -1;
    for (const m of markers) {
      const i = html.indexOf(m);
      if (i !== -1) { start = i + m.length; break; }
    }
    if (start === -1) return null;

    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < html.length; i++) {
      const ch = html[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\' && inStr) { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(html.substring(start, i + 1)); }
          catch { return null; }
        }
      }
    }
    return null;
  }

  // ---- Polling ----

  async _poll() {
    if (!this.polling) return;

    if (this._usePageRefresh) {
      await this._pollPageRefresh();
    } else {
      await this._pollApi();
    }
  }

  async _pollApi() {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 15000);

      const resp = await fetch(
        `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${this._apiKey}&prettyPrint=false`,
        {
          method: 'POST',
          credentials: 'include',
          signal: ctrl.signal,
          headers: {
            'Content-Type': 'application/json',
            'X-YouTube-Client-Name': '1',
            'X-YouTube-Client-Version': this._ctx?.client?.clientVersion || '2.20250401.00.00'
          },
          body: JSON.stringify({ context: this._ctx, continuation: this._cont })
        }
      );
      clearTimeout(timeout);

      if (!resp.ok) throw new Error(`API ${resp.status}`);

      const data = await resp.json();
      const lcc = data?.continuationContents?.liveChatContinuation;

      if (!lcc) {
        this._apiFails++;
        if (this._apiFails >= 3) {
          this.onDebug?.('YouTube API: prázdné odpovědi, přepínám na page refresh');
          this._usePageRefresh = true;
        }
        if (this.polling) this._pt = setTimeout(() => this._poll(), 5000);
        return;
      }

      // Aktualizovat continuation - preferovat timedContinuationData
      let nextMs = 5000;
      const conts = lcc.continuations;
      if (conts?.length) {
        for (const c of conts) {
          if (c?.timedContinuationData) {
            this._cont = c.timedContinuationData.continuation;
            nextMs = c.timedContinuationData.timeoutMs || 5000;
            break;
          }
          if (c?.invalidationContinuationData) {
            this._cont = c.invalidationContinuationData.continuation;
            nextMs = c.invalidationContinuationData.timeoutMs || 5000;
          }
        }
      }

      const actions = lcc.actions || [];
      if (actions.length > 0) {
        this._apiFails = 0;
        this._processActions(actions);
      } else {
        this._apiFails++;
        if (this._apiFails >= 5) {
          this.onDebug?.('YouTube API: žádné zprávy, přepínám na page refresh');
          this._usePageRefresh = true;
        }
      }

      if (this.polling) {
        this._pt = setTimeout(() => this._poll(), Math.max(nextMs, 1500));
      }
    } catch (err) {
      console.error('YouTube API poll:', err);
      this._apiFails++;
      if (this._apiFails >= 3) {
        this.onDebug?.(`YouTube API selhalo (${err.message}), přepínám na page refresh`);
        this._usePageRefresh = true;
      }
      if (this.polling) this._pt = setTimeout(() => this._poll(), 5000);
    }
  }

  async _pollPageRefresh() {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 15000);

      const html = await this._fetchChatPage();
      clearTimeout(timeout);

      const ytData = this._extractJson(html, 'ytInitialData');
      if (!ytData) {
        if (this.polling) this._pt = setTimeout(() => this._poll(), 8000);
        return;
      }

      const actions = ytData?.contents?.liveChatRenderer?.actions || [];
      this._processActions(actions);

      if (this.polling) {
        this._pt = setTimeout(() => this._poll(), 3000);
      }
    } catch (err) {
      console.error('YouTube page refresh:', err);
      if (this.polling) this._pt = setTimeout(() => this._poll(), 10000);
    }
  }

  // ---- Message processing ----

  _processActions(actions) {
    for (const a of actions) {
      const item = a?.addChatItemAction?.item;
      if (!item) continue;
      const renderer = item.liveChatTextMessageRenderer || item.liveChatPaidMessageRenderer;
      if (!renderer) continue;

      const id = renderer.id;
      if (!id || this._seen.has(id)) continue;
      this._seen.add(id);
      if (this._seen.size > 5000) {
        const arr = [...this._seen];
        this._seen = new Set(arr.slice(-2500));
      }

      const username = renderer.authorName?.simpleText || 'Unknown';
      const runs = renderer.message?.runs || [];
      const message = runs.map((r) =>
        r.text || r.emoji?.shortcuts?.[0] || r.emoji?.emojiId || ''
      ).join('');
      const isSuperChat = !!item.liveChatPaidMessageRenderer;

      const badges = [];
      for (const ab of renderer.authorBadges || []) {
        const tip = (ab?.liveChatAuthorBadgeRenderer?.tooltip || '').toLowerCase();
        if (tip.includes('owner')) badges.push('\uD83C\uDFA4');
        else if (tip.includes('moderator')) badges.push('\u2694\uFE0F');
        else if (tip.includes('member')) badges.push('\u2B50');
      }

      this.onMessage?.({
        platform: 'youtube',
        username,
        message,
        ytRuns: runs,
        color: isSuperChat ? '#ffd600' : '#ff0000',
        badges,
        timestamp: Date.now(),
        id,
        superChat: isSuperChat
      });
    }
  }

  disconnect(internal) {
    this.polling = false;
    if (this._pt) { clearTimeout(this._pt); this._pt = null; }
    this._cont = null;
    this._videoId = null;
    // _seen NEMAZAT - musí přežít reconnect aby se neduplikovaly zprávy
    this._apiFails = 0;
    this._usePageRefresh = false;
    if (!internal) this.onStatus?.('disconnected');
  }
}

// =============================================================
// UnityChat - Hlavní aplikace
// =============================================================

class UnityChat {
  constructor() {
    this.config = { ...DEFAULTS };
    this.emotes = new EmoteManager();
    this.nicknames = new NicknameManager();
    this.twitch = new TwitchProvider();
    this.kick = new KickProvider();
    this.youtube = new YouTubeProvider();
    this.autoScroll = true;
    this.msgCount = 0;
    this.filters = { twitch: true, youtube: true, kick: true };
    this.activePlatform = null;
    this._msgCache = [];
    this._cacheTimer = null;
    this._twitchBadges = {};
    this._chatUsers = new Map();
    this._seenMsgIds = new Set();
    this._seenContentKeys = new Set(); // pro scrape dedup (username + text)
    this._platformUsernames = {}; // per-platform username tracking (loaded from config in _init)

    // Uložit cache okamžitě při zavření/reloadu panelu
    window.addEventListener('beforeunload', () => {
      if (this._msgCache.length > 0) {
        chrome.storage.local.set({ [this._cacheKey]: this._msgCache });
      }
      this.nicknames?.disconnect();
    });

    this.chatEl = document.getElementById('chat');
    this.scrollBtn = document.getElementById('btn-scroll');
    this.msgInput = document.getElementById('msg-input');
    this.sendBtn = document.getElementById('btn-send');
    this.platformBadge = document.getElementById('active-badge');

    this._init();
  }

  async _init() {
    // Verze v titulku
    const ver = chrome.runtime.getManifest().version;
    document.getElementById('header-title').innerHTML =
      `<img src="icons/icon48.png" class="hdr-logo"> UnityChat <span class="hdr-ver">v${ver}</span> <span class="hdr-beta">[BETA]</span>`;

    await this._loadConfig();
    if (this.config._platformUsernames) {
      this._platformUsernames = { ...this.config._platformUsernames };
    }
    await this.nicknames.loadCache();
    this.nicknames.fetchAll();  // non-blocking, fire-and-forget
    this.nicknames.connectSSE();
    this.nicknames.onChange = (d) => this._onNicknameChange(d);
    this.nicknames.onLoad = () => {
      if (this.config.username) {
        for (const p of ['twitch', 'youtube', 'kick']) {
          const profile = this.nicknames.get(p, this.config.username);
          if (profile) {
            const nickEl = document.getElementById('input-nickname');
            const colorEl = document.getElementById('input-color-hex');
            const pickerEl = document.getElementById('input-color-picker');
            if (nickEl && !nickEl.value) nickEl.value = profile.nickname;
            if (colorEl && !colorEl.value && profile.color) {
              colorEl.value = profile.color;
              if (pickerEl) pickerEl.value = profile.color;
            }
            break;
          }
        }
      }
    };
    this._setupUI();
    this._setupProviders();

    console.log('[UC] init: providers set up, detecting username...');
    // Auto-detekce username z aktivního tabu PŘED cache renderem
    if (!this.config.username) {
      try {
        const tab = await this._getActiveBrowserTab();
        if (tab) {
          await this._injectContentScript(tab);
          const resp = await chrome.tabs.sendMessage(tab.id, { type: 'PING' }).catch(() => null);
          if (resp?.username) {
            this.config.username = resp.username;
            document.getElementById('input-username').value = resp.username;
            this._saveConfig();
          }
        }
      } catch {}
    }

    console.log('[UC] init: loading cache + connecting...');
    // Load cache + connect FIRST (instant), emotes in background
    await this._loadCachedMessages();
    console.log('[UC] init: cache loaded, connecting all...');
    this._connectAll();
    console.log('[UC] init: connected, starting detect loop');
    this._detectLoop();

    // Load emotes + badges in background (don't block the UI)
    this.emotes.loadGlobal().then(() => {
      if (this.config._roomId) {
        return Promise.all([
          this.emotes.loadChannel('twitch', this.config._roomId),
          this.emotes.loadBTTV(this.config._roomId),
          this.emotes.loadFFZ(this.config._roomId),
          this._loadTwitchBadges(this.config._roomId)
        ]);
      }
    }).catch(() => {});
  }

  // ---- Config ----

  async _loadConfig() {
    try {
      const s = await chrome.storage.sync.get('uc_config');
      if (s.uc_config) this.config = { ...DEFAULTS, ...s.uc_config };
    } catch {}
  }

  async _saveConfig() {
    try {
      await chrome.storage.sync.set({ uc_config: this.config });
    } catch {}
  }

  // ---- UI ----

  _setupUI() {
    const $ = (id) => document.getElementById(id);

    $('input-channel').value = this.config.channel;
    $('input-kick-channel').value = this.config.kickChannel || this.config.channel;
    $('input-yt-channel').value = this.config.ytChannel || this.config.channel;
    $('input-username').value = this.config.username || '';
    // Pre-populate nickname + color from cache
    if (this.config.username) {
      for (const p of ['twitch', 'youtube', 'kick']) {
        const profile = this.nicknames.get(p, this.config.username);
        if (profile) {
          $('input-nickname').value = profile.nickname || '';
          if (profile.color) {
            $('input-color-hex').value = profile.color;
            $('input-color-picker').value = profile.color;
          }
          break;
        }
      }
    }
    $('input-layout').value = this.config.layout || 'small';
    this._applyLayout();
    $('input-layout').addEventListener('change', () => {
      this.config.layout = $('input-layout').value;
      this._saveConfig();
      this._applyLayout();
    });
    // Auto-resize textarea + auto @username suggest
    this.msgInput.addEventListener('input', () => {
      this.msgInput.style.height = 'auto';
      const max = 250;
      const h = Math.min(this.msgInput.scrollHeight, max);
      this.msgInput.style.height = h + 'px';
      this.msgInput.style.overflowY = this.msgInput.scrollHeight > max ? 'auto' : 'hidden';

      // Auto-trigger @username autocomplete while typing
      const text = this.msgInput.value;
      const pos = this.msgInput.selectionStart;
      // Find the word being typed
      let ws = pos;
      while (ws > 0 && text[ws - 1] !== ' ') ws--;
      const partial = text.substring(ws, pos);
      if (partial.startsWith('@') && partial.length >= 2) {
        const prefix = partial.substring(1).toLowerCase();
        const matches = [...this._chatUsers.values()]
          .filter(u => u.name.toLowerCase().startsWith(prefix))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(u => '@' + u.name);
        if (matches.length) {
          this._ac = { start: ws, end: pos, index: 0, matches };
          this._acRender();
        } else {
          this._acHide();
        }
      } else if (!partial.startsWith('@')) {
        // Not typing @, clear any open @suggest (emote suggest is Tab-only)
        if (this._ac && this._ac.matches[0]?.startsWith('@')) this._acHide();
      }
    });

    // Username se nastaví okamžitě při psaní, uloží při blur
    $('input-username').addEventListener('input', () => {
      const val = $('input-username').value.trim();
      this.config.username = val;
      if (this.activePlatform) this._platformUsernames[this.activePlatform] = val;
    });
    $('input-username').addEventListener('change', () => {
      const val = $('input-username').value.trim();
      this.config.username = val;
      if (this.activePlatform) {
        this._platformUsernames[this.activePlatform] = val;
        if (!this.config._platformUsernames) this.config._platformUsernames = {};
        this.config._platformUsernames[this.activePlatform] = val;
      }
      this._saveConfig();
    });
    $('chk-twitch').checked = this.config.twitch;
    $('chk-youtube').checked = this.config.youtube;
    $('chk-kick').checked = this.config.kick;

    $('btn-popout').addEventListener('click', () => {
      chrome.windows.create({
        url: 'sidepanel.html',
        type: 'popup',
        width: 420,
        height: 720
      });
    });
    $('btn-dump').addEventListener('click', () =>
      chrome.runtime.sendMessage({ type: 'DUMP_LOGS' })
    );
    $('btn-settings').addEventListener('click', () =>
      $('settings').classList.toggle('hidden')
    );

    // Nickname
    $('btn-nickname').addEventListener('click', async () => {
      const nick = $('input-nickname').value.trim();
      const color = $('input-color-hex').value.trim() || null;
      const statusEl = $('nickname-status');
      if (!nick) {
        statusEl.textContent = 'Zadej přezdívku';
        statusEl.className = 'nick-status error';
        return;
      }
      if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) {
        statusEl.textContent = 'Barva musí být #RRGGBB';
        statusEl.className = 'nick-status error';
        return;
      }
      $('btn-nickname').disabled = true;

      // Detect username on each platform via PING and save nickname for all
      const platforms = ['twitch', 'youtube', 'kick'];
      const tabUrls = { twitch: '*://*.twitch.tv/*', youtube: '*://*.youtube.com/*', kick: '*://*.kick.com/*' };
      let saved = 0;
      let lastError = null;

      for (const p of platforms) {
        let uname = null;
        // Try config username first (always set for Twitch)
        if (p === 'twitch' && this.config.username) {
          uname = this.config.username;
        } else {
          // PING active tab for this platform
          try {
            const tabs = await chrome.tabs.query({ url: [tabUrls[p]] });
            for (const tab of tabs) {
              const resp = await chrome.tabs.sendMessage(tab.id, { type: 'PING' }).catch(() => null);
              if (resp?.username) { uname = resp.username; break; }
            }
          } catch {}
        }
        if (!uname) continue;
        const result = await this.nicknames.save(p, uname, nick, color);
        if (result.ok) saved++;
        else if (result.retryAfter) lastError = `Počkej ${Math.ceil(result.retryAfter)}s`;
        else lastError = result.error;
      }

      $('btn-nickname').disabled = false;
      if (saved > 0) {
        statusEl.textContent = `Přezdívka uložena pro ${saved} ${saved === 1 ? 'platformu' : 'platformy'}!`;
        statusEl.className = 'nick-status success';
      } else {
        statusEl.textContent = lastError || 'Nepodařilo se uložit';
        statusEl.className = 'nick-status error';
      }
      setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'nick-status'; }, 4000);
    });

    // Sync color picker ↔ hex input
    $('input-color-picker').addEventListener('input', () => {
      $('input-color-hex').value = $('input-color-picker').value;
    });
    $('input-color-hex').addEventListener('input', () => {
      const v = $('input-color-hex').value;
      if (/^#[0-9a-fA-F]{6}$/.test(v)) $('input-color-picker').value = v;
    });

    $('btn-connect').addEventListener('click', () => {
      this.config.channel = $('input-channel').value.trim() || DEFAULTS.channel;
      this.config.kickChannel = $('input-kick-channel').value.trim() || this.config.channel;
      this.config.ytChannel = $('input-yt-channel').value.trim() || this.config.channel;
      this.config.username = $('input-username').value.trim();
      this.config.twitch = $('chk-twitch').checked;
      this.config.youtube = $('chk-youtube').checked;
      this.config.kick = $('chk-kick').checked;
      this._saveConfig();
      this._disconnectAll();
      this.emotes.channel7tv.clear();
      this._connectAll();
    });

    $('btn-disconnect').addEventListener('click', () => this._disconnectAll());
    $('btn-clear').addEventListener('click', () => {
      this.chatEl.innerHTML = '';
      this.msgCount = 0;
    });

    // Dev mode
    $('chk-devmode').addEventListener('change', () => {
      $('dev-tools').classList.toggle('hidden', !$('chk-devmode').checked);
    });
    $('btn-dump-cache').addEventListener('click', () => {
      chrome.storage.local.get(this._cacheKey, (d) => {
        const json = JSON.stringify(d[this._cacheKey] || [], null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'unitychat-message-cache.json';
        a.click();
        URL.revokeObjectURL(url);
      });
    });
    $('btn-dump-nicknames').addEventListener('click', () => {
      chrome.storage.local.get('uc_nicknames', (d) => {
        const json = JSON.stringify(d.uc_nicknames || {}, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'unitychat-nickname-cache.json';
        a.click();
        URL.revokeObjectURL(url);
      });
    });
    $('btn-clear-cache').addEventListener('click', () => {
      chrome.storage.local.remove(this._cacheKey);
      this._msgCache = [];
      this._seenMsgIds.clear();
      this._seenContentKeys.clear();
      this.chatEl.innerHTML = '';
      this.msgCount = 0;
    });

    // Scroll - detekce nových zpráv + auto-scroll pause
    this._unreadCount = 0;
    this.chatEl.addEventListener('scroll', () => {
      const el = this.chatEl;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      this.autoScroll = atBottom;
      if (atBottom) {
        this._clearUnread();
      }
    });
    this.scrollBtn.addEventListener('click', () => {
      this.chatEl.scrollTo({ top: this.chatEl.scrollHeight, behavior: 'smooth' });
      this.autoScroll = true;
      this._clearUnread();
    });

    // Filtry
    document.querySelectorAll('.fbtn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const p = btn.dataset.platform;
        if (p === 'all') {
          const all = Object.values(this.filters).every(Boolean);
          this.filters.twitch = !all;
          this.filters.youtube = !all;
          this.filters.kick = !all;
        } else {
          this.filters[p] = !this.filters[p];
        }
        this._applyFilters();
      });
    });

    // Odesílání zpráv + Tab autocomplete
    this._ac = null;
    this.msgInput.addEventListener('keydown', (e) => {
      // Tab / Shift+Tab - cykluje seznamem
      if (e.key === 'Tab') {
        e.preventDefault();
        this._acTab(e.shiftKey ? -1 : 1);
        return;
      }
      // Šipky během aktivního autocomplete
      if (this._ac && this._ac.matches.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          this._acTab(1);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          this._acTab(-1);
          return;
        }
        if (e.key === 'ArrowRight') {
          // Potvrdit výběr - kurzor je už za doplněným textem, jen zavřít suggest
          e.preventDefault();
          this._acHide();
          return;
        }
      }
      if (e.key === 'Escape') {
        if (this._ac) { this._acHide(); return; }
        if (this._reply) { this._clearReply(); return; }
        return;
      }
      // Modifier klávesy (Shift, Ctrl, Alt) samy o sobě neruší autocomplete
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
      // Jakákoliv jiná klávesa ruší autocomplete
      this._ac = null;
      this._acHide();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._sendMessage();
      }
    });
    this.sendBtn.addEventListener('click', () => this._sendMessage());

    this._updateDisabled();
  }

  _applyFilters() {
    document.querySelectorAll('.fbtn').forEach((btn) => {
      const p = btn.dataset.platform;
      btn.classList.toggle(
        'active',
        p === 'all' ? Object.values(this.filters).every(Boolean) : this.filters[p]
      );
    });
    this.chatEl.querySelectorAll('.msg').forEach((el) => {
      el.classList.toggle('hide-platform', !this.filters[el.dataset.platform]);
    });
  }

  _updateDisabled() {
    for (const p of ['twitch', 'youtube', 'kick']) {
      const dot = document.querySelector(`#st-${p} .dot`);
      if (dot && !this.config[p]) dot.className = 'dot disabled';
    }
  }

  // ---- Emote Tab autocomplete (suggest list) ----

  _acTab(dir) {
    const input = this.msgInput;
    const text = input.value;
    const pos = input.selectionStart;

    // Cycling - opakovaný Tab / Shift+Tab
    if (this._ac && this._ac.end === pos) {
      const len = this._ac.matches.length;
      this._ac.index = (this._ac.index + dir + len) % len;
      this._acApply();
      return;
    }

    // Nový autocomplete
    let ws = pos;
    while (ws > 0 && text[ws - 1] !== ' ') ws--;
    const partial = text.substring(ws, pos);
    if (!partial) return;

    let matches;
    if (partial.startsWith('@')) {
      // @username autocomplete (@ samotné = všichni uživatelé)
      const prefix = partial.substring(1).toLowerCase();
      matches = [...this._chatUsers.values()]
        .filter(u => !prefix || u.name.toLowerCase().startsWith(prefix))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(u => '@' + u.name);
    } else {
      // Emote autocomplete
      matches = this.emotes.findCompletions(partial);
    }
    if (!matches.length) { this._acHide(); return; }

    this._ac = { start: ws, end: pos, index: 0, matches };
    this._acApply();
  }

  _acApply() {
    const ac = this._ac;
    if (!ac) return;
    const match = ac.matches[ac.index];
    const input = this.msgInput;
    const text = input.value;
    const before = text.substring(0, ac.start);
    const after = text.substring(ac.end);
    input.value = before + match + ' ' + after;
    ac.end = ac.start + match.length + 1;
    input.setSelectionRange(ac.end, ac.end);
    this._acRender();
  }

  /** Zjistí zdroj emotu pro zobrazení tagu. */
  _acSource(name) {
    if (name.startsWith('@')) {
      const u = this._chatUsers.get(name.substring(1).toLowerCase());
      return u ? u.platform.charAt(0).toUpperCase() + u.platform.slice(1) : '';
    }
    if (this.emotes.channel7tv.has(name)) return '7TV';
    if (this.emotes.global7tv.has(name)) return '7TV';
    if (this.emotes.bttvEmotes.has(name)) return 'BTTV';
    if (this.emotes.ffzEmotes.has(name)) return 'FFZ';
    if (this.emotes.twitchNative.has(name)) return 'Twitch';
    if (this.emotes.kickNative.has(name)) return 'Kick';
    return '';
  }

  _acRender() {
    const ac = this._ac;
    if (!ac) return;

    let el = document.getElementById('emote-suggest');
    if (!el) {
      el = document.createElement('div');
      el.id = 'emote-suggest';
      document.getElementById('input-area').appendChild(el);
    }

    const VISIBLE = 4;
    const total = ac.matches.length;
    const idx = ac.index;

    // Okno kolem vybraného (posun aby vybraný byl vidět)
    let winStart = ac._winStart || 0;
    if (idx < winStart) winStart = idx;
    if (idx >= winStart + VISIBLE) winStart = idx - VISIBLE + 1;
    winStart = Math.max(0, Math.min(winStart, total - VISIBLE));
    ac._winStart = winStart;

    const winEnd = Math.min(winStart + VISIBLE, total);

    let html = '';
    for (let i = winStart; i < winEnd; i++) {
      const name = ac.matches[i];
      const sel = i === idx ? ' selected' : '';
      html += `<div class="es-item${sel}" data-idx="${i}">`;

      if (name.startsWith('@')) {
        // Username: barevná tečka
        const u = this._chatUsers.get(name.substring(1).toLowerCase());
        const col = u?.color || '#ccc';
        html += `<span class="es-dot" style="background:${col}"></span>`;
      } else {
        // Emote: obrázek
        const url = this.emotes.getAnyUrl(name);
        if (url) html += `<img src="${this.emotes._ea(url)}" alt="${this.emotes._ea(name)}">`;
      }

      const src = this._acSource(name);
      html += `<span class="es-name"><span class="es-name-inner">${this.emotes._eh(name)}</span></span>`;
      if (src) html += `<span class="es-src">${src}</span>`;
      html += '</div>';
    }

    if (total > VISIBLE) {
      html += `<div class="es-counter">${idx + 1} / ${total}</div>`;
    }

    el.innerHTML = html;
    el.classList.remove('hidden');

    // Detekce overflow + nastavení CSS variable pro scroll animaci
    el.querySelectorAll('.es-item').forEach((item) => {
      const outer = item.querySelector('.es-name');
      const inner = item.querySelector('.es-name-inner');
      if (outer && inner) {
        const overflow = inner.scrollWidth - outer.clientWidth;
        if (overflow > 0) {
          item.classList.add('overflowing');
          item.style.setProperty('--scroll-dist', `-${overflow + 8}px`);
        }
      }
      item.addEventListener('click', () => {
        const i = parseInt(item.dataset.idx, 10);
        this._ac.index = i;
        this._acApply();
        this.msgInput.focus();
      });
    });
  }

  _acHide() {
    this._ac = null;
    const el = document.getElementById('emote-suggest');
    if (el) el.classList.add('hidden');
  }

  // ---- Odesílání zpráv ----

  async _detectLoop() {
    await this._detectActivePlatform();
    setInterval(() => this._detectActivePlatform(), 3000);
  }

  // Najít aktivní tab v hlavním okně (Opera popup je separátní okno → musíme hledat jinde)
  async _getActiveBrowserTab() {
    try {
      const win = await chrome.windows.getLastFocused({ populate: true, windowTypes: ['normal'] });
      return win?.tabs?.find((t) => t.active) || null;
    } catch {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return tab || null;
      } catch { return null; }
    }
  }

  async _detectActivePlatform() {
    try {
      const tab = await this._getActiveBrowserTab();
      if (!tab) { this._setActivePlatform(null); return; }

      let resp = await chrome.tabs.sendMessage(tab.id, { type: 'PING' }).catch(() => null);

      // Pokud content script neodpovídá, zkusit ho injektovat on-demand
      if (!resp) {
        await this._injectContentScript(tab);
        resp = await chrome.tabs.sendMessage(tab.id, { type: 'PING' }).catch(() => null);
      }

      this._setActivePlatform(resp?.platform || null);

      // Track username per platform + persist
      if (resp?.username && resp?.platform) {
        const name = resp.username.replace(/^@/, '');
        this._platformUsernames[resp.platform] = name;
        if (!this.config._platformUsernames) this.config._platformUsernames = {};
        if (this.config._platformUsernames[resp.platform] !== name) {
          this.config._platformUsernames[resp.platform] = name;
          this._saveConfig();
        }
      }
      // Auto-detekce username z platformy (hlavní config field)
      if (resp?.username && !this.config.username) {
        this.config.username = resp.username;
        const el = document.getElementById('input-username');
        if (el) el.value = resp.username;
        this._saveConfig();
      }
    } catch {
      this._setActivePlatform(null);
    }
  }

  async _injectContentScript(tab) {
    const url = tab.url || '';
    let file, allFrames = false;
    if (url.includes('twitch.tv')) file = 'content/twitch.js';
    else if (url.includes('youtube.com')) { file = 'content/youtube.js'; allFrames = true; }
    else if (url.includes('kick.com')) file = 'content/kick.js';
    if (!file) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames },
        files: [file]
      });
    } catch {}
  }

  _setActivePlatform(platform) {
    this.activePlatform = platform;
    if (!this.platformBadge) return;

    if (platform === 'twitch') {
      this.platformBadge.textContent = 'TW';
      this.platformBadge.className = 'badge tw';
    } else if (platform === 'youtube') {
      this.platformBadge.textContent = 'YT';
      this.platformBadge.className = 'badge yt';
    } else if (platform === 'kick') {
      this.platformBadge.textContent = 'KI';
      this.platformBadge.className = 'badge ki';
    } else {
      this.platformBadge.textContent = '--';
      this.platformBadge.className = 'badge';
    }

    this.msgInput.disabled = !platform;
    this.sendBtn.disabled = !platform;
    this.msgInput.placeholder = platform
      ? `Zpráva do ${platform.charAt(0).toUpperCase() + platform.slice(1)}...`
      : 'Otevři stream pro odesílání...';

    // Update username field to show current platform's username
    const el = document.getElementById('input-username');
    const label = document.querySelector('label[for="input-username"]');
    if (el && platform) {
      const pName = this._platformUsernames[platform] || this.config._platformUsernames?.[platform];
      if (pName) {
        el.value = pName;
        this._platformUsernames[platform] = pName;
      }
    }
    if (label) {
      const names = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick' };
      label.textContent = platform ? `Username (${names[platform] || platform})` : 'Tvoje username';
    }
  }

  _applyLayout() {
    const layout = this.config.layout || 'small';
    document.body.classList.remove('layout-small', 'layout-medium', 'layout-large');
    document.body.classList.add('layout-' + layout);
  }

  // ---- Twitch Badges ----

  async _loadTwitchBadges(roomId) {
    try {
      const badges = await chrome.runtime.sendMessage({
        type: 'LOAD_BADGES',
        channel: this.config.channel,
        roomId
      });
      if (badges && typeof badges === 'object') {
        Object.assign(this._twitchBadges, badges);
        console.log(`[Badges] Loaded: ${Object.keys(this._twitchBadges).length}`);
      }
    } catch (e) {
      console.error('[Badges] Load error:', e);
    }
  }

  // ---- Scroll to message ----

  _scrollToMessage(msgId) {
    const target = this.chatEl.querySelector(`.msg[data-msg-id="${CSS.escape(msgId)}"]`);
    if (!target) {
      this._sys('Původní zpráva už není v cache');
      return;
    }
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('msg-flash');
    void target.offsetWidth; // restart animace
    target.classList.add('msg-flash');
    setTimeout(() => target.classList.remove('msg-flash'), 2000);
  }

  // ---- Pin message ----

  async _pinMessage(msg) {
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'PIN_MESSAGE',
        messageId: msg.id,
        broadcasterId: this.config._roomId || null
      });
      if (resp?.ok) {
        this._showPinnedBanner(msg);
        // Sledovat pin entity ID z odpovědi (ne původní message ID)
        this._startPinWatcher(resp.pinId || msg.id);
      } else {
        this._sys(`Pin: ${resp?.error || 'selhalo'}`);
      }
    } catch (e) {
      this._sys(`Pin chyba: ${e.message}`);
    }
  }

  _showPinnedBanner(msg) {
    const banner = document.getElementById('pinned-banner');
    if (!banner) return;

    // Vyrenderovat zprávu v banneru
    const ts = new Date(msg.timestamp);
    const time = `${ts.getHours().toString().padStart(2, '0')}:${ts.getMinutes().toString().padStart(2, '0')}`;

    let body;
    if (msg.platform === 'twitch') {
      const emotesTag = msg.replyTo ? null : msg.twitchEmotes;
      body = this.emotes.renderTwitch(msg.message, emotesTag);
    } else if (msg.platform === 'kick') {
      body = this.emotes.renderKick(msg.kickContent || msg.message);
    } else {
      body = this.emotes.renderPlain(msg.message);
    }

    banner.innerHTML = `
      <div class="pin-icon">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/>
        </svg>
        <span>Připnuto</span>
      </div>
      <div class="pin-content">
        <span class="pin-time">${time}</span>
        <span class="pin-user" style="color:${msg.color}">${this.emotes._eh(msg.username)}:</span>
        <span class="pin-text">${body}</span>
      </div>
      <button class="pin-close" title="Odepnout">&times;</button>
    `;
    banner.classList.remove('hidden');

    banner.querySelector('.pin-close').addEventListener('click', () => {
      this._hidePinnedBanner();
    });

    // Bez lokálního timeru - banner zmizí když polling detekuje unpin
    clearTimeout(this._pinTimer);
  }

  _hidePinnedBanner() {
    document.getElementById('pinned-banner')?.classList.add('hidden');
    clearTimeout(this._pinTimer);
    this._stopPinWatcher();
  }

  _startPinWatcher(pinId) {
    this._stopPinWatcher();
    this._pinWatcherId = pinId;
    this._pinWatcherFails = 0;
    // Delay first poll - dej pinu čas se propagovat
    this._pinWatcherStartTimeout = setTimeout(() => {
      this._pinWatcher = setInterval(async () => {
        try {
          const resp = await chrome.runtime.sendMessage({
            type: 'CHECK_PIN',
            channel: this.config.channel,
            messageId: pinId
          });
          if (!resp?.ok) return; // GQL error - nezavírat banner
          if (resp.stillPinned === false) {
            this._pinWatcherFails++;
            // Skrýt až po 3 konzistentních "not pinned" odpovědích (6s)
            if (this._pinWatcherFails >= 3) {
              this._hidePinnedBanner();
            }
          } else {
            this._pinWatcherFails = 0;
          }
        } catch {}
      }, 2000);
    }, 8000);
  }

  _stopPinWatcher() {
    if (this._pinWatcherStartTimeout) {
      clearTimeout(this._pinWatcherStartTimeout);
      this._pinWatcherStartTimeout = null;
    }
    if (this._pinWatcher) {
      clearInterval(this._pinWatcher);
      this._pinWatcher = null;
      this._pinWatcherId = null;
    }
  }

  // ---- Nickname live update ----

  _onNicknameChange({ platform, username, nickname, color }) {
    this.chatEl.querySelectorAll('.un').forEach((un) => {
      if (un.dataset.platform === platform && un.dataset.username === username.toLowerCase()) {
        un.textContent = nickname;
        un.title = username;
        if (color) un.style.color = color;
      }
    });
  }

  // ---- User Card ----

  async _openUserCard(platform, username) {
    // Debounce - max 1 klik za 2s
    if (this._ucDebounce) return;
    this._ucDebounce = true;
    setTimeout(() => { this._ucDebounce = false; }, 2000);

    try {
      const tab = await this._getActiveBrowserTab();
      if (!tab) return;

      chrome.runtime.sendMessage({
        type: 'OPEN_USER_CARD',
        tabId: tab.id,
        username,
        platform,
        channel: this.config.channel,
        broadcasterId: this.config._roomId || null
      });
    } catch (e) {
      console.error('[UserCard] Error:', e);
    }
  }

  // ---- Odpovědi na zprávy ----

  _setReply(platform, username, messageId) {
    this._reply = { platform, username, messageId };

    let el = document.getElementById('reply-indicator');
    if (!el) {
      el = document.createElement('div');
      el.id = 'reply-indicator';
      document.getElementById('input-area').prepend(el);
    }

    const pClass = { twitch: 'tw', youtube: 'yt', kick: 'ki' }[platform] || '';
    el.innerHTML =
      `<span class="ri-label">Odpověď pro</span> ` +
      `<span class="badge ${pClass}">${pClass.toUpperCase()}</span> ` +
      `<span class="ri-user">${this.emotes._eh(username)}</span>` +
      `<button class="ri-close" title="Zrušit">&times;</button>`;
    el.classList.remove('hidden');

    el.querySelector('.ri-close').addEventListener('click', () => this._clearReply());

    this.msgInput.focus();
  }

  _clearReply() {
    this._reply = null;
    const el = document.getElementById('reply-indicator');
    if (el) el.classList.add('hidden');
  }

  async _sendMessage() {
    const text = this.msgInput.value.trim();
    if (!text || !this.activePlatform) return;

    const isCmd = text.startsWith('!') || text.startsWith('/');
    const markedText = isCmd ? text : text + ' ' + UC_MARKER;
    const platform = this.activePlatform;
    const reply = this._reply ? { ...this._reply } : null;

    // Clear input IMMEDIATELY — responsive feel
    this.msgInput.value = '';
    this.msgInput.style.height = 'auto';
    this._clearReply();

    // Optimistic UI: show message instantly (include @mention for cross-platform reply)
    const username = this._platformUsernames[platform] || this.config.username || 'me';
    const ucProfile = this.nicknames.get(platform, username);
    const defaultColors = { twitch: '#9146ff', youtube: '#ff4b4b', kick: '#53fc18' };
    let displayText = text;
    if (reply && reply.platform !== platform) {
      const at = `@${reply.username}`;
      if (!displayText.startsWith(at)) displayText = `${at} ${displayText}`;
    }
    this._lastSentText = text;
    this._addMessage({
      id: `sent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      platform,
      username,
      message: displayText,
      color: ucProfile?.color || this._lastUserColor || defaultColors[platform] || null,
      timestamp: Date.now(),
      _uc: true,
      _optimistic: true,
      ...(reply ? { replyTo: { id: reply.messageId, username: reply.username } } : {}),
    });

    // Send in background (don't block UI)
    try {
      const tab = await this._getActiveBrowserTab();
      if (!tab) { this._sys('Žádný aktivní tab'); return; }

      let resp;
      // Native reply only on Twitch (GQL threading).
      // YouTube/Kick don't support native reply → @mention prefix.
      if (reply?.messageId && reply.platform === platform && platform === 'twitch') {
        resp = await chrome.tabs.sendMessage(tab.id, {
          type: 'REPLY_CHAT',
          text: markedText,
          parentMsgId: reply.messageId,
          username: reply.username,
          broadcasterId: this.config._roomId || null
        });
      } else {
        let sendText = markedText;
        if (reply) {
          const name = reply.username.replace(/^@/, '');
          const at = `@${name}`;
          if (!sendText.startsWith(at)) sendText = `${at} ${sendText}`;
        }
        resp = await chrome.tabs.sendMessage(tab.id, { type: 'SEND_CHAT', text: sendText });
      }

      if (!resp?.ok) {
        this._sys(`Chyba: ${resp?.error || 'nepodařilo se odeslat'}`);
      }
    } catch (err) {
      this._sys(`Nelze odeslat: ${err.message}`);
    }
  }

  // ---- Providers ----

  _setupProviders() {
    this.twitch.onMessage = (m) => this._addMessage(m);
    this.twitch.onStatus = (s, d) => this._status('twitch', s, d);
    this.twitch.onRoomId = (id) => {
      this.config._roomId = id;
      this._saveConfig();
      this.emotes.loadChannel('twitch', id);
      this.emotes.loadBTTV(id);
      this.emotes.loadFFZ(id);
      this._loadTwitchBadges(id);
    };

    this.kick.onMessage = (m) => this._addMessage(m);
    this.kick.onStatus = (s, d) => this._status('kick', s, d);
    this.kick.onUserId = (id) => {
      if (this.emotes.channel7tv.size === 0) {
        this.emotes.loadChannel('kick', id);
      }
    };

    this.youtube.onMessage = (m) => this._addMessage(m);
    this.youtube.onStatus = (s, d) => this._status('youtube', s, d);
    this.youtube.onDebug = null; // tiché debug
  }

  _connectAll() {
    this._updateDisabled();
    const connecting = [];
    if (this.config.twitch) { this.twitch.connect(this.config.channel); connecting.push('Twitch'); }
    if (this.config.kick) { this.kick.connect(this.config.kickChannel || this.config.channel); connecting.push('Kick'); }
    if (this.config.youtube) { this.youtube.connect(this.config.ytChannel || this.config.channel); connecting.push('YouTube'); }
    if (connecting.length) this._sys(`Připojování: ${connecting.join(', ')}...`);

    // Doparsovat existující zprávy z Twitch tabu (pokud existuje)
    setTimeout(() => this._scrapeExistingChat(), 1500);
  }

  async _scrapeExistingChat() {
    // Skip scrape if cache has recent messages (< 2 min old).
    // After a reload the cache IS the backfill — scraping would just
    // create incomplete duplicates (emotes are img tags in DOM, lost
    // during text extraction → boundary detection fails).
    const lastCached = this._msgCache[this._msgCache.length - 1];
    if (lastCached?.timestamp && Date.now() - lastCached.timestamp < 120_000) return;

    try {
      const tabs = await chrome.tabs.query({ url: ['*://*.twitch.tv/*'] });
      for (const tab of tabs) {
        const resp = await chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_CHAT' }).catch(() => null);
        if (!resp?.ok || !resp.messages?.length) continue;

        // Boundary detection: match on username sequence (not message text,
        // because scraped text is often incomplete — emotes are img tags).
        // Take last N cached Twitch usernames and find that sequence in scraped.
        const cachedUsers = this._msgCache
          .filter((m) => m.platform === 'twitch' && m.username)
          .slice(-20)
          .map((m) => m.username.toLowerCase());
        const scrapedUsers = resp.messages.map((m) => (m.username || '').toLowerCase());

        let boundary = -1;
        // Try decreasing suffix lengths (5→2) of cached username sequence
        for (let len = Math.min(cachedUsers.length, 5); len >= 2 && boundary === -1; len--) {
          const suffix = cachedUsers.slice(-len);
          for (let i = scrapedUsers.length - len; i >= 0; i--) {
            let match = true;
            for (let j = 0; j < len; j++) {
              if (scrapedUsers[i + j] !== suffix[j]) { match = false; break; }
            }
            if (match) {
              boundary = i + len - 1;
              break;
            }
          }
        }

        const newMessages = resp.messages.slice(boundary + 1);
        if (newMessages.length) {
          this._sys(`Doparsováno ${newMessages.length} zpráv z Twitch chatu`);
          for (const msg of newMessages) {
            this._addMessage(msg);
          }
        }
        break;
      }
    } catch {}
  }

  _disconnectAll() {
    this.twitch.disconnect();
    this.kick.disconnect();
    this.youtube.disconnect();
  }

  // ---- Status ----

  _status(platform, status, detail) {
    const dot = document.querySelector(`#st-${platform} .dot`);
    if (!dot) return;
    dot.className = 'dot';
    if (status === 'connected') {
      dot.classList.add('connected');
      // Jen tiché připojení - indikátor stačí
    } else if (status === 'connecting') {
      dot.classList.add('connecting');
    } else if (status === 'error') {
      dot.classList.add('error');
      this._sys(`${platform.toUpperCase()}: ${detail || 'chyba připojení'}`);
    }
  }

  // ---- Messages ----

  _sys(text) {
    const el = document.createElement('div');
    el.className = 'sys';
    el.textContent = text;
    this.chatEl.appendChild(el);
    this._scroll();
  }

  _addMessage(msg) {
    // Dedup podle ID (cache + live zprávy)
    if (msg.id) {
      if (this._seenMsgIds.has(msg.id)) return;
      this._seenMsgIds.add(msg.id);
      if (this._seenMsgIds.size > 2000) {
        const arr = [...this._seenMsgIds];
        this._seenMsgIds = new Set(arr.slice(-1000));
      }
    }

    // Content-based dedup pro scraped zprávy
    // Normalizace: lowercase, sjednocené whitespace, jen alfanumerika a mezery
    const norm = (s) => (s || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[^a-z0-9\s]/g, '')
      .trim()
      .substring(0, 80);
    const contentKey = msg.username && msg.message
      ? norm(msg.username) + '|' + norm(msg.message)
      : null;
    if (contentKey) {
      // Drop duplicates: scraped messages always, live messages if we already
      // have an optimistic (sent) version with the same content
      if (this._seenContentKeys.has(contentKey) && (msg.scraped || !msg._optimistic)) return;
      this._seenContentKeys.add(contentKey);
      if (this._seenContentKeys.size > 2000) {
        const arr = [...this._seenContentKeys];
        this._seenContentKeys = new Set(arr.slice(-1000));
      }
    }

    this.msgCount++;

    // Sbírat usernames pro @mention autocomplete
    if (msg.username) {
      this._chatUsers.set(msg.username.toLowerCase(), {
        name: msg.username,
        platform: msg.platform,
        color: msg.color
      });
    }

    // Učení nativních emotes z příchozích zpráv
    if (msg.platform === 'twitch' && msg.twitchEmotes) {
      // Pro učení emotes potřebujeme originální pozice - u reply zpráv
      // je @username stripnutý, ale emote tag má originální pozice.
      // learnTwitch extrahuje jen name→url mapování, takže OK i s offsetem.
      this.emotes.learnTwitch(msg.message, msg.twitchEmotes);
    } else if (msg.platform === 'kick' && msg.kickContent) {
      this.emotes.learnKick(msg.kickContent);
    }

    // Detekce UnityChat markeru → oranžový platform badge
    // Flag _uc se cachuje aby přežil reload
    let isUC = !!msg._uc;
    if (!isUC && msg.message?.includes(UC_MARKER)) {
      isUC = true;
      msg.message = msg.message.replace(' ' + UC_MARKER, '').replace(UC_MARKER, '');
      if (msg.kickContent) {
        msg.kickContent = msg.kickContent.replace(' ' + UC_MARKER, '').replace(UC_MARKER, '');
      }
      msg._uc = true; // zachovat pro cache

      // Auto-detekce username + track color
      if (this._lastSentText && msg.message === this._lastSentText) {
        this._lastSentText = null;
        if (msg.color) this._lastUserColor = msg.color;
        if (msg.username && this.config.username !== msg.username) {
          this.config.username = msg.username;
          const el = document.getElementById('input-username');
          if (el) el.value = msg.username;
          this._saveConfig();
        }
      }
    }

    // @mention zvýraznění - kontroluje text zprávy i reply-parent
    // Matchuje jak @username tak @nickname (pokud je nastavený)
    const myName = this.config.username?.toLowerCase();
    // Check nickname on the message's platform (not activePlatform —
    // that may be null when rendering cached messages at startup)
    const myNick = myName ? this.nicknames.getNickname(msg.platform, this.config.username)?.toLowerCase() : null;
    const msgLower = msg.message?.toLowerCase() || '';
    const isMentioned = myName && (
      msgLower.includes(`@${myName}`) ||
      (myNick && msgLower.includes(`@${myNick}`)) ||
      msg.replyTo?.username?.toLowerCase() === myName
    );

    const el = document.createElement('div');
    el.className = 'msg';
    el.dataset.platform = msg.platform;
    if (msg.id) el.dataset.msgId = msg.id;
    if (msg.superChat) el.classList.add('superchat');
    if (isMentioned) el.classList.add('mentioned');
    if (msg.firstMsg) el.classList.add('first-msg');
    if (msg.isRaid) el.classList.add('raid');
    if (!this.filters[msg.platform]) el.classList.add('hide-platform');

    // First-time chatter label
    if (msg.firstMsg) {
      const fl = document.createElement('div');
      fl.className = 'first-label';
      fl.textContent = 'První zpráva';
      el.appendChild(fl);
    }

    // Raid label
    if (msg.isRaid) {
      const rl = document.createElement('div');
      rl.className = 'raid-label';
      rl.textContent = 'RAID';
      el.appendChild(rl);
    }

    // Reply context (Twitch reply-parent tagy)
    if (msg.replyTo) {
      const ctx = document.createElement('div');
      ctx.className = 'reply-ctx';
      if (msg.replyTo.id) ctx.classList.add('clickable');
      ctx.innerHTML =
        `&#8617; <span class="rctx-user">@${this.emotes._eh((msg.replyTo.username || '').replace(/^@/, ''))}</span>` +
        (msg.replyTo.message ? ` <span class="rctx-body">${this.emotes._eh(msg.replyTo.message)}</span>` : '');
      if (msg.replyTo.id) {
        ctx.addEventListener('click', (e) => {
          e.stopPropagation();
          this._scrollToMessage(msg.replyTo.id);
        });
      }
      el.appendChild(ctx);
    }

    // Platform badge
    const pClass = { twitch: 'tw', youtube: 'yt', kick: 'ki' }[msg.platform];
    const pName = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick' }[msg.platform];
    const pi = document.createElement('span');
    pi.className = `pi ${pClass}${isUC ? ' uc' : ''}`;
    pi.textContent = pClass.toUpperCase();
    const tooltipText = isUC ? 'UnityChat User' : pName;
    pi.setAttribute('data-tooltip', tooltipText);
    el.appendChild(pi);

    // Čas
    const ts = document.createElement('span');
    ts.className = 'ts';
    const d = new Date(msg.timestamp);
    ts.textContent = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
    el.appendChild(ts);

    // Badges
    if (msg.badgesRaw) {
      const bdg = document.createElement('span');
      bdg.className = 'bdg';
      const badgeCount = Object.keys(this._twitchBadges).length;
      for (const badge of msg.badgesRaw.split(',')) {
        if (!badge) continue;
        const url = this._twitchBadges[badge];
        if (!url && badgeCount > 0) {
          console.warn(`[Badge] Not found: "${badge}" (have ${badgeCount} badges)`);
        }
        if (url) {
          const img = document.createElement('img');
          img.className = 'bdg-img';
          img.src = url;
          img.alt = badge.split('/')[0];
          img.title = badge.split('/')[0];
          bdg.appendChild(img);
        }
      }
      if (bdg.children.length) el.appendChild(bdg);
    }

    // Username (klik → otevře user card na platformě)
    const un = document.createElement('span');
    un.className = 'un';
    const ucProfile = isUC ? this.nicknames.get(msg.platform, msg.username) : null;
    un.style.color = ucProfile?.color || msg.color;
    un.textContent = ucProfile?.nickname || msg.username;
    if (ucProfile?.nickname) un.title = msg.username; // tooltip shows real username
    un.dataset.platform = msg.platform;
    un.dataset.username = msg.username.toLowerCase();
    un.addEventListener('click', () => this._openUserCard(msg.platform, msg.username));
    el.appendChild(un);
    el.appendChild(document.createTextNode(' '));

    // Zpráva s emoty - platform-specifický rendering
    const tx = document.createElement('span');
    tx.className = 'tx';

    if (msg.platform === 'twitch') {
      // Reply zprávy mají stripnutý @username prefix → pozice z emotes tagu nesedí
      // → pro reply použít jen 7TV/BTTV matching (bez position-based Twitch emotes)
      const emotesTag = msg.replyTo ? null : msg.twitchEmotes;
      tx.innerHTML = this.emotes.renderTwitch(msg.message, emotesTag);
    } else if (msg.platform === 'kick') {
      tx.innerHTML = this.emotes.renderKick(msg.kickContent || msg.message);
    } else if (msg.platform === 'youtube' && msg.ytRuns?.length) {
      tx.innerHTML = this.emotes.renderYouTube(msg.ytRuns);
    } else {
      tx.innerHTML = this.emotes.renderPlain(msg.message);
    }

    el.appendChild(tx);

    // Hover akce
    const actions = document.createElement('div');
    actions.className = 'msg-actions';

    // Pin button (jen Twitch zprávy - vyžaduje mod práva)
    if (msg.platform === 'twitch') {
      const pinBtn = document.createElement('button');
      pinBtn.className = 'msg-action-btn';
      pinBtn.title = 'Připnout zprávu (pouze mod)';
      pinBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">' +
        '<path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/>' +
        '</svg>';
      pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._pinMessage(msg);
      });
      actions.appendChild(pinBtn);
    }

    // Reply button
    const replyBtn = document.createElement('button');
    replyBtn.className = 'msg-action-btn';
    replyBtn.title = 'Odpovědět';
    replyBtn.innerHTML = '&#8617;'; // ↩
    replyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._setReply(msg.platform, msg.username, msg.id);
    });
    actions.appendChild(replyBtn);
    el.appendChild(actions);

    // Pokud nejsme dole, přidat unread separator (jen jednou pro první novou zprávu)
    if (!this.autoScroll) {
      if (this._unreadCount === 0) {
        // První nová zpráva → vložit separator
        const sep = document.createElement('div');
        sep.id = 'unread-separator';
        sep.className = 'unread-sep';
        sep.textContent = 'Nové zprávy';
        this.chatEl.appendChild(sep);
      }
      this._unreadCount++;
      this.scrollBtn.textContent = `↓ ${this._unreadCount} ${this._unreadCount === 1 ? 'nová zpráva' : 'nové zprávy'}`;
      this.scrollBtn.classList.remove('hidden');
    }

    this.chatEl.appendChild(el);

    if (this.msgCount > this.config.maxMessages) this._trim();
    this._scroll();

    // Cache zprávy (serializovatelná data, bez DOM)
    this._cacheMsg(msg);
  }

  // ---- Message cache (per-channel, 72h TTL, compact format) ----

  get _cacheKey() {
    return `uc_messages_${(this.config.channel || 'default').toLowerCase()}`;
  }

  _compactMsg(msg) {
    const m = {};
    for (const [k, v] of Object.entries(msg)) {
      // Strip null, undefined, false, empty string
      if (v === null || v === undefined || v === false || v === '') continue;
      m[k] = v;
    }
    // rgb() → #hex (shorter)
    if (m.color?.startsWith('rgb')) {
      const [r, g, b] = m.color.match(/\d+/g);
      m.color = '#' + [r, g, b].map(c => (+c).toString(16).padStart(2, '0')).join('');
    }
    // Slim replyTo: drop message text, keep id + username
    if (m.replyTo && typeof m.replyTo === 'object') {
      m.replyTo = { id: m.replyTo.id, username: m.replyTo.username };
    }
    return m;
  }

  _expandMsg(msg) {
    // Restore defaults expected by _addMessage
    if (!('firstMsg' in msg)) msg.firstMsg = false;
    if (!('replyTo' in msg)) msg.replyTo = null;
    if (!('twitchEmotes' in msg)) msg.twitchEmotes = null;
    // Expand string replyTo (legacy compact) to object
    if (typeof msg.replyTo === 'string') {
      msg.replyTo = { id: msg.replyTo, username: null, message: null };
    }
    // Expand replyTo missing message field
    if (msg.replyTo && !('message' in msg.replyTo)) msg.replyTo.message = null;
    return msg;
  }

  _cacheMsg(msg) {
    this._msgCache.push(this._compactMsg(msg));
    if (this._msgCache.length > 200) this._msgCache = this._msgCache.slice(-150);
    // Save immediately — extension reload can kill context anytime
    chrome.storage.local.set({ [this._cacheKey]: this._msgCache }).catch(() => {});
  }

  async _loadCachedMessages() {
    try {
      const data = await chrome.storage.local.get(this._cacheKey);
      const raw = data[this._cacheKey];
      if (!raw?.length) return;

      // 72h TTL filter
      const cutoff = Date.now() - 72 * 60 * 60 * 1000;
      const msgs = raw.filter((m) => !m.timestamp || m.timestamp > cutoff);

      // Load each message individually — don't let one bad message kill the rest
      for (const msg of msgs) {
        try { this._addMessage(this._expandMsg(msg)); } catch {}
      }
      // Merge with _msgCache (which _cacheMsg may have already populated during _addMessage)
      // Use the raw filtered messages as the authoritative cache
      this._msgCache = msgs;
    } catch (e) {
      console.error('Cache load failed:', e);
      // DON'T reset _msgCache — keep whatever was there so beforeunload
      // doesn't overwrite the storage with an empty array
    }
  }

  _clearUnread() {
    this._unreadCount = 0;
    this.scrollBtn.classList.add('hidden');
    document.getElementById('unread-separator')?.remove();
  }

  _trim() {
    const c = this.chatEl.children;
    const n = Math.max(0, c.length - this.config.maxMessages);
    for (let i = 0; i < n; i++) c[0].remove();
  }

  _scroll() {
    if (this.autoScroll) {
      requestAnimationFrame(() => {
        this.chatEl.scrollTop = this.chatEl.scrollHeight;
      });
    }
  }
}

// ---- Custom tooltip for platform badges (viewport-clamped, escapes overflow) ----
function _initPlatformBadgeTooltip() {
  const tooltip = document.createElement('div');
  tooltip.className = 'uc-tooltip';
  document.body.appendChild(tooltip);

  let currentBadge = null;

  function show(badge) {
    const text = badge.getAttribute('data-tooltip');
    if (!text) return;
    currentBadge = badge;
    tooltip.textContent = text;
    // Make visible to measure, then reposition
    tooltip.classList.add('visible');
    const bRect = badge.getBoundingClientRect();
    const tRect = tooltip.getBoundingClientRect();
    const margin = 6;

    // Prefer below the badge (matches cursor position for hover feedback)
    let top = bRect.bottom + 4;
    if (top + tRect.height > window.innerHeight - margin) {
      // Not enough room below → flip above
      top = bRect.top - tRect.height - 4;
    }

    // Horizontally centered to badge, clamped to viewport
    let left = bRect.left + bRect.width / 2 - tRect.width / 2;
    if (left < margin) left = margin;
    if (left + tRect.width > window.innerWidth - margin) {
      left = window.innerWidth - tRect.width - margin;
    }

    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  }

  function hide() {
    tooltip.classList.remove('visible');
    currentBadge = null;
  }

  document.body.addEventListener('mouseover', (e) => {
    const badge = e.target.closest('.pi[data-tooltip]');
    if (!badge || badge === currentBadge) return;
    show(badge);
  });

  document.body.addEventListener('mouseout', (e) => {
    if (!currentBadge) return;
    const related = e.relatedTarget;
    if (related && currentBadge.contains(related)) return;
    hide();
  });

  // Hide if the badge scrolls away or is removed
  document.addEventListener('scroll', hide, true);
}

// ---- Start ----
document.addEventListener('DOMContentLoaded', () => {
  new UnityChat();
  _initPlatformBadgeTooltip();
});
