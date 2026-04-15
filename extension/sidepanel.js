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
  // Soft render cap — chat should hold ~72h of activity, cache is the source
  // of truth. Keep a ceiling to prevent runaway DOM growth on busy streams.
  maxMessages: 5000,
  username: '',
  layout: 'small',
  showTimestamps: true,
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
    this.ucEmotes = new Map();     // name -> url (UnityChat custom emotes)
    this.zeroWidth = new Set();    // names of zero-width 7TV emotes (overlay on previous)
    // Per-user "personal" 7TV emote loadouts so a chatter's own emotes
    // resolve in foreign channels too. Key: `${platform}:${loginLower}`,
    // value: Map(emoteName → { url, zw }).
    this.userEmotes = new Map();
    // 7TV "added to set" provenance per emote name — actor_id + timestamp
    // from the emote-set response. Used by the click-to-pin preview to
    // render "ADDED BY {actor}" + the actual addition date.
    this._emoteAdditions = new Map();
    // Cache of resolved 7TV user lookups (id → { displayName, avatarUrl })
    // so repeat actor resolutions across emotes don't re-hit the API.
    this._sevenTvUserCache = new Map();
    this._globalLoaded = false;

    // UnityChat custom emotes (bundled in extension/emotes/)
    this.ucEmotes.set('CaneBear', chrome.runtime.getURL('emotes/canebear.webp'));
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
        if (url) {
          this.global7tv.set(emote.name, url);
          if ((emote.flags ?? 0) & 1) this.zeroWidth.add(emote.name);
        }
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
          if ((emote.flags ?? 0) & 1) this.zeroWidth.add(emote.name);
          // Provenance: who added this emote to the channel set + when.
          // Used by the click-to-pin preview's "ADDED BY" row.
          if (emote.actor_id || emote.timestamp) {
            this._emoteAdditions.set(emote.name, {
              actorId: emote.actor_id || null,
              addedAt: emote.timestamp ? new Date(emote.timestamp) : null,
            });
          }
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
          this.bttvEmotes.set(e.code, `https://cdn.betterttv.net/emote/${e.id}/2x`);
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
          this.bttvEmotes.set(e.code, `https://cdn.betterttv.net/emote/${e.id}/2x`);
          count++;
        }
      }
    } catch {}
    console.log(`[BTTV] ${count} emotes loaded`);
    return count;
  }

  loadTwitchGlobals() {
    // Popular Twitch global emotes (ID → token). Pre-populated for autocomplete.
    const globals = {
      '25': 'Kappa', '354': '4Head', '86': 'BibleThump', '1902': 'Keepo',
      '425618': 'LUL', '41': 'Kreygasm', '305954156': 'PogChamp', '88': 'PogChamp',
      '52': 'SMOrc', '360': 'FailFish', '245': 'ResidentSleeper',
      '64138': 'SeemsGood', '65': 'FrankerZ', '148793': 'BlessRNG',
      '171104': 'TriHard', '28087': 'WutFace', '58765': 'NotLikeThis',
      '81274': 'VoHiYo', '55339': 'KappaHD', '55338': 'KappaPride',
      '30259': 'HeyGuys', '90076': 'PJSalt', '4339': 'EleGiggle',
      '114836': 'Jebaited', '115234': 'OpieOP', '68856': 'MingLee',
      '74510': 'OMGScoots', '307609315': 'Prayge', '196892': 'TwitchUnity',
      '160394': 'PunchTrees', '120232': 'MrDestructoid', '69': 'PJSugar',
      '33': 'DansGame', '9803': 'CoolCat', '34': 'GingerPower',
      '56': 'BatChest', '57': 'SwiftRage', '58': 'StoneLightning',
      '59': 'TheRinger', '80': 'OpieOP', '81': 'DBstyle',
      '112290': 'TheTarFu', '90': 'HassanChop', '305954156': 'PogChamp'
    };
    for (const [id, name] of Object.entries(globals)) {
      if (!this.twitchNative.has(name)) {
        this.twitchNative.set(name, `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`);
      }
    }
  }

  async loadTwitchChannel(channelLogin) {
    let count = 0;
    try {
      const resp = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko'
        },
        body: JSON.stringify({
          query: `query($login: String!) {
            user(login: $login) {
              subscriptionProducts {
                emotes { id token }
              }
            }
          }`,
          variables: { login: channelLogin }
        })
      });
      if (resp.ok) {
        const data = await resp.json();
        const products = data.data?.user?.subscriptionProducts || [];
        for (const product of products) {
          for (const e of (product.emotes || [])) {
            if (e.token && !this.twitchNative.has(e.token)) {
              this.twitchNative.set(e.token,
                `https://static-cdn.jtvnw.net/emoticons/v2/${e.id}/default/dark/2.0`);
              count++;
            }
          }
        }
      }
    } catch (err) {
      console.error('[Twitch] Channel emotes error:', err);
    }
    console.log(`[Twitch] ${count} channel emotes loaded`);
    return count;
  }

  async loadFFZ(twitchUserId) {
    let count = 0;
    const parseSet = (sets) => {
      for (const setId in sets) {
        for (const e of sets[setId].emoticons || []) {
          // Prefer 2x for hi-DPI sharpness; fall back to 4x then 1x.
          const url = e.urls?.['2'] || e.urls?.['4'] || e.urls?.['1'];
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

  // Register a Twitch user's personal 7TV emote loadout (the emote_set
  // returned by /v3/users/twitch/{id}). Looked up during render so when
  // the user types one of their emotes in any channel — even when not
  // their own — it still resolves to an image instead of plain text.
  learnUserEmotes(platform, login, emoteSet) {
    if (!login || !emoteSet?.emotes?.length) return;
    const map = new Map();
    for (const e of emoteSet.emotes) {
      const url = this._build7tvUrl(e?.data || e);
      if (!e?.name || !url) continue;
      const flags = (e?.data?.flags ?? e?.flags) || 0;
      map.set(e.name, { url, zw: !!(flags & 1) });
      // Same provenance capture as channel emotes — actor + timestamp.
      if (e.actor_id || e.timestamp) {
        this._emoteAdditions.set(e.name, {
          actorId: e.actor_id || null,
          addedAt: e.timestamp ? new Date(e.timestamp) : null,
        });
      }
    }
    if (map.size) this.userEmotes.set(`${platform}:${String(login).toLowerCase()}`, map);
  }

  // Resolve a 7TV user-id to display name + avatar (cached). Used to label
  // the "ADDED BY" row in the click-to-pin preview without re-hitting the
  // API every emote.
  async fetch7tvUser(userId) {
    if (!userId) return null;
    if (this._sevenTvUserCache.has(userId)) return this._sevenTvUserCache.get(userId);
    try {
      const r = await fetch(`https://7tv.io/v3/users/${userId}`);
      if (!r.ok) { this._sevenTvUserCache.set(userId, null); return null; }
      const d = await r.json();
      const info = {
        displayName: d.display_name || d.username || null,
        avatarUrl: d.avatar_url || null,
      };
      this._sevenTvUserCache.set(userId, info);
      return info;
    } catch {
      this._sevenTvUserCache.set(userId, null);
      return null;
    }
  }

  // Lookup an emote by name on a specific user's personal loadout.
  // Returns { url, zw } or null. Used as the highest-priority lookup
  // during render so foreign-channel personal emotes win over globals.
  _getUserEmote(platform, login, name) {
    if (!login) return null;
    const m = this.userEmotes.get(`${platform}:${String(login).toLowerCase()}`);
    return m?.get(name) || null;
  }

  // Identify which provider an emote came from based on its CDN URL.
  // Returns { source, id, hires } or null. id is fetched from the URL,
  // hires is a swapped-up resolution variant for the preview card.
  // Diagnostic: log every short-name emote hit (≤3 chars) once per
  // (name, source) so we can pin down stray entries like "te" being
  // matched out of one of the loaded maps.
  _logShortEmoteHit(name, source, url, platform, author) {
    if (!this._shortHitsLogged) this._shortHitsLogged = new Set();
    const key = `${name}|${source}`;
    if (this._shortHitsLogged.has(key)) return;
    this._shortHitsLogged.add(key);
    try {
      chrome.runtime.sendMessage({
        type: 'UC_LOG', tag: 'ShortEmote',
        args: [`name="${name}" source=${source} url=${url} platform=${platform} author=${author}`],
      });
    } catch {}
  }

  _emoteSourceFromUrl(url) {
    if (!url) return null;
    let m;
    if ((m = url.match(/cdn\.7tv\.app\/emote\/([A-Za-z0-9]+)/))) {
      return { source: '7TV', id: m[1], hires: url.replace(/\/[0-9]x\.(webp|avif|gif|png)/, '/4x.$1') };
    }
    if ((m = url.match(/cdn\.betterttv\.net\/emote\/([a-f0-9]+)/i))) {
      return { source: 'BTTV', id: m[1], hires: url.replace(/\/[0-9]x(?:$|\?)/, '/3x') };
    }
    if ((m = url.match(/cdn\.frankerfacez\.com\/emote\/(\d+)\/(\d+)/))) {
      return { source: 'FFZ', id: m[1], hires: url.replace(/\/(\d+)$/, '/4') };
    }
    if ((m = url.match(/static-cdn\.jtvnw\.net\/emoticons\/v2\/([^/]+)/))) {
      return { source: 'Twitch', id: m[1], hires: url.replace(/\/[0-9.]+$/, '/3.0') };
    }
    if ((m = url.match(/files\.kick\.com\/emotes\/(\d+)/))) {
      return { source: 'Kick', id: m[1], hires: url };
    }
    if (url.startsWith('chrome-extension://')) return { source: 'UnityChat', id: null, hires: url };
    return null;
  }

  // Lazy-fetch full emote metadata for the click-to-pin preview card.
  // Returns { owner, ownerAvatar, addedAt, externalUrl } or null. Per-source
  // public APIs, no auth needed.
  async fetchEmoteDetails(source, id, name) {
    if (!id) return null;
    try {
      if (source === '7TV') {
        const r = await fetch(`https://7tv.io/v3/emotes/${id}`);
        if (!r.ok) return null;
        const d = await r.json();
        // "Added to set" provenance was captured during channel/user emote
        // load — pull it back out by name. Resolve actor's display name
        // via the cached /users/{id} helper.
        const addition = name ? this._emoteAdditions.get(name) : null;
        let addedBy = null;
        let addedByAvatar = null;
        if (addition?.actorId) {
          const actor = await this.fetch7tvUser(addition.actorId);
          if (actor) {
            addedBy = actor.displayName;
            addedByAvatar = actor.avatarUrl;
          }
        }
        // Prefer the per-set addition timestamp over the emote's global
        // creation date — it's what the 7TV banner shows as "Added On".
        const addedAt = addition?.addedAt
          || (d.created_at ? new Date(d.created_at) : null);
        return {
          owner: d.owner?.display_name || d.owner?.username || null,
          ownerAvatar: d.owner?.avatar_url || null,
          addedBy,
          addedByAvatar,
          addedAt,
          externalUrl: `https://7tv.app/emotes/${id}`,
        };
      }
      if (source === 'BTTV') {
        const r = await fetch(`https://api.betterttv.net/3/emotes/${id}`);
        if (!r.ok) return null;
        const d = await r.json();
        return {
          owner: d.user?.displayName || d.user?.name || null,
          ownerAvatar: d.user?.providerId
            ? `https://cdn.betterttv.net/provider/twitch/${d.user.providerId}` : null,
          addedBy: null,
          addedByAvatar: null,
          addedAt: null,
          externalUrl: `https://betterttv.com/emotes/${id}`,
        };
      }
      if (source === 'FFZ') {
        const r = await fetch(`https://api.frankerfacez.com/v1/emote/${id}`);
        if (!r.ok) return null;
        const d = await r.json();
        const e = d?.emote || {};
        return {
          owner: e.owner?.display_name || e.owner?.name || null,
          ownerAvatar: null,
          addedBy: null,
          addedByAvatar: null,
          addedAt: e.created_at ? new Date(e.created_at) : null,
          externalUrl: `https://www.frankerfacez.com/emoticon/${id}`,
        };
      }
    } catch {}
    return null;
  }

  _build7tvUrl(emote) {
    const host = emote.data?.host || emote.host;
    if (!host?.url) return null;

    // Prefer 2x for hi-DPI sharpness — we render at ~28–32px CSS, so 1x
    // (typically 32px native) gets browser-upscaled and goes blurry on
    // high-DPI displays. 2x (~64px) downscales cleanly. WebP first
    // (animations + smaller bytes), then AVIF, then any 2x, then 1x.
    const file =
      host.files?.find((f) => f.name === '2x.webp') ||
      host.files?.find((f) => f.name === '2x.avif') ||
      host.files?.find((f) => f.name?.startsWith('2x')) ||
      host.files?.find((f) => f.name === '1x.webp') ||
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
      || this.bttvEmotes.get(word) || this.ffzEmotes.get(word)
      || this.ucEmotes.get(word) || null;
  }

  /** Vrátí URL emotu z jakéhokoliv zdroje (pro autocomplete preview). */
  getAnyUrl(name) {
    return this.channel7tv.get(name) || this.global7tv.get(name)
      || this.bttvEmotes.get(name) || this.ffzEmotes.get(name)
      || this.twitchNative.get(name) || this.kickNative.get(name)
      || this.ucEmotes.get(name) || null;
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
          `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`);
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
  findCompletions(prefix, opts) {
    if (!prefix) return [];
    const lower = prefix.toLowerCase();
    const fulltext = !!opts?.fulltext;
    const results = [];
    const seen = new Set();

    // Pořadí: 7TV channel → 7TV global → BTTV → FFZ → Twitch → Kick → UC
    const maps = [this.channel7tv, this.global7tv, this.bttvEmotes, this.ffzEmotes, this.twitchNative, this.kickNative, this.ucEmotes];
    const matchFn = fulltext
      ? (n) => n.toLowerCase().includes(lower)
      : (n) => n.toLowerCase().startsWith(lower);

    for (const map of maps) {
      for (const name of map.keys()) {
        if (matchFn(name) && !seen.has(name)) {
          results.push(name);
          seen.add(name);
        }
      }
    }

    results.sort((a, b) => {
      // Prefix matches always rank above contains matches in fulltext mode
      const aPrefix = a.toLowerCase().startsWith(lower);
      const bPrefix = b.toLowerCase().startsWith(lower);
      if (aPrefix !== bPrefix) return aPrefix ? -1 : 1;
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
  renderSegments(segments, ctx) {
    const platform = ctx?.platform || null;
    const author = ctx?.author || null;
    const out = [];
    // Per-message helper: highest priority is the message author's personal
    // 7TV emote loadout (so KombatWombatt's emotes resolve in foreign chats).
    const userLookup = (name) => this._getUserEmote(platform, author, name);

    for (const seg of segments) {
      if (seg.type === 'emote') {
        // Per-author personal emotes WIN over channel/global. 3rd-party
        // (7TV/BTTV/FFZ) still overrides platform-native (Twitch native).
        const personal = userLookup(seg.value);
        if (personal) {
          out.push({ type: 'emote', value: seg.value, url: personal.url, zw: personal.zw });
          continue;
        }
        const thirdParty = this.channel7tv.get(seg.value) || this.global7tv.get(seg.value)
          || this.bttvEmotes.get(seg.value) || this.ffzEmotes.get(seg.value);
        if (thirdParty) {
          out.push({ type: 'emote', value: seg.value, url: thirdParty, zw: this.zeroWidth.has(seg.value) });
        } else {
          out.push(seg);
        }
        continue;
      }
      // Text: per-author → 7TV/BTTV/FFZ → platform native → UC custom
      const parts = seg.value.split(/(\s+)/);
      for (const part of parts) {
        const personal = userLookup(part);
        if (personal) {
          out.push({ type: 'emote', value: part, url: personal.url, zw: personal.zw });
          if (part.length <= 3 && part.length > 0 && /\S/.test(part)) {
            this._logShortEmoteHit?.(part, 'personal', personal.url, platform, author);
          }
          continue;
        }
        let url = null;
        let source = null;
        if ((url = this.channel7tv.get(part))) source = 'channel7tv';
        else if ((url = this.global7tv.get(part))) source = 'global7tv';
        else if ((url = this.bttvEmotes.get(part))) source = 'bttv';
        else if ((url = this.ffzEmotes.get(part))) source = 'ffz';
        else if ((url = this.ucEmotes.get(part))) source = 'uc';
        else if ((url = this.twitchNative.get(part))) source = 'twitchNative';
        else if ((url = this.kickNative.get(part))) source = 'kickNative';
        if (url) {
          if (part.length <= 3 && /\S/.test(part)) {
            this._logShortEmoteHit?.(part, source, url, platform, author);
          }
          out.push({ type: 'emote', value: part, url, zw: this.zeroWidth.has(part) });
        } else {
          out.push({ type: 'text', value: part });
        }
      }
    }
    return this._toHtml(out);
  }

  /**
   * Twitch zpráva - parsuje IRC emotes tag + 7TV.
   * `ctx` (optional): { platform, author } — author login enables per-user
   * 7TV personal emote resolution across channels.
   */
  renderTwitch(text, emotesTag, ctx) {
    const offset = (ctx && ctx.emotesOffset) || 0;
    const segments = this._splitTwitchEmotes(text, emotesTag, offset);
    return this.renderSegments(segments, ctx);
  }

  /**
   * Kick zpráva - parsuje HTML content (zachovává <img> emotes) + 7TV.
   */
  renderKick(htmlContent, ctx) {
    const segments = this._parseKickHtml(htmlContent);
    return this.renderSegments(segments, ctx);
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

  _splitTwitchEmotes(text, tag, offset = 0) {
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
        const s = parseInt(range.substring(0, dash), 10) - offset;
        const e = parseInt(range.substring(dash + 1), 10) - offset;
        // Skip positions that got shifted entirely off the trimmed text
        // (shouldn't happen for emotes — the stripped prefix is plain
        // "@name " text — but guard anyway).
        if (!isNaN(s) && !isNaN(e) && s >= 0 && e >= 0 && e < text.length + 1) {
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
        url: `https://static-cdn.jtvnw.net/emoticons/v2/${p.id}/default/dark/2.0`
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
    const out = [];
    let stackOpen = false;

    // Check if a ZW emote follows at or after position i (skipping whitespace)
    const zwAhead = (i) => {
      for (let j = i; j < segments.length; j++) {
        const s = segments[j];
        if (s.type === 'emote' && s.zw) return true;
        if (s.type === 'emote' && !s.zw) return false; // solid emote = no
        if (s.type === 'text' && s.value.trim()) return false; // non-whitespace text = no
        // whitespace text → keep looking
      }
      return false;
    };

    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (s.type !== 'emote') {
        // Whitespace between base and ZW emote — skip (don't close stack)
        if (stackOpen && !s.value.trim() && zwAhead(i + 1)) continue;
        if (stackOpen) { out.push('</span>'); stackOpen = false; }
        out.push(this._linkify(s.value));
        continue;
      }
      const alt = this._ea(s.value);
      // Twitch's original global face emotes (:), :D, :O, ;), B), <3 …)
      // ship at a much lower native resolution than channel/subscriber
      // emotes — scaling them up to our standard chat-emote size makes
      // them blurry and pushes them visually out of proportion with
      // vanilla Twitch. Detect by NAME (stable across ID-system changes:
      // <3 went from low ID to 555555584) AND require a Twitch CDN URL
      // so BTTV/FFZ/7TV emotes that happen to share the same name (e.g.
      // someone's BTTV ":D") don't get shrunk — they live on different
      // domains.
      let cls = 'emote';
      const isTwitchCdn = /static-cdn\.jtvnw\.net\/emoticons\//.test(s.url || '');
      if (isTwitchCdn && _isTwitchOgFaceName(s.value)) cls += ' emote-tiny';
      // No native browser title — our own hover-preview card already shows
      // the emote name + source, and the browser tooltip would compete
      // with it (and pop up after the same hover delay).
      const img = `<img class="${cls}" src="${this._ea(s.url)}" alt="${alt}">`;
      if (s.zw) {
        if (!stackOpen) out.push('<span class="emote-stack">');
        out.push(img);
        stackOpen = true;
      } else {
        if (stackOpen) { out.push('</span>'); stackOpen = false; }
        out.push(`<span class="emote-stack">${img}`);
        stackOpen = true;
      }
    }
    if (stackOpen) out.push('</span>');
    return out.join('');
  }

  _eh(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  _linkify(s) {
    const urlRe = /https?:\/\/[^\s<>'")\]]+/g;
    let last = 0;
    let out = '';
    let m;
    while ((m = urlRe.exec(s)) !== null) {
      if (m.index > last) out += this._eh(s.substring(last, m.index));
      const url = m[0].replace(/[.,;:!?]+$/, '');
      urlRe.lastIndex = m.index + url.length;
      out += `<a href="${this._ea(url)}" target="_blank" rel="noopener">${this._eh(url)}</a>`;
      last = m.index + url.length;
    }
    if (last === 0) return this._eh(s);
    if (last < s.length) out += this._eh(s.substring(last));
    return out;
  }

  _ea(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Sanitize color for use in HTML style attributes
  _sc(c) {
    if (!c || typeof c !== 'string') return '';
    // Allow: #hex, rgb(), rgba(), named colors (single word)
    if (/^#[0-9a-fA-F]{3,8}$/.test(c)) return c;
    if (/^rgba?\(\s*[\d\s,./%]+\)$/.test(c)) return c;
    if (/^[a-zA-Z]{1,20}$/.test(c)) return c;
    return '';
  }
}

// =============================================================
// NicknameManager - custom display names backed by api.jouki.cz
// SSE push for real-time updates, chrome.storage.local cache
// =============================================================

// DEV: http://178.104.160.182:3001 | PROD: https://api.jouki.cz
const UC_API = 'https://api.jouki.cz';

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
      this._eventSource.addEventListener('nickname-delete', (e) => {
        try {
          const d = JSON.parse(e.data);
          this._map.delete(`${d.platform}:${d.username.toLowerCase()}`);
          this._saveCache();
          if (this.onChange) this.onChange({ ...d, nickname: null, color: null });
        } catch {}
      });
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

  async remove(platform, username) {
    const cleanName = username.replace(/^@/, '');
    try {
      const resp = await fetch(`${UC_API}/nicknames`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, username: cleanName }),
      });
      const data = await resp.json();
      if (data.ok) {
        this._map.delete(`${platform}:${cleanName.toLowerCase()}`);
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

// Twitch's default username-color palette — used by the vanilla web client
// when a user hasn't picked a custom color. Order + algorithm RE'd from
// Twitch source (matches what Chatty and tmi.js ship). Without this, every
// colorless user renders in the same brand purple fallback.
const TWITCH_DEFAULT_COLORS = [
  '#FF0000', '#0000FF', '#008000', '#B22222', '#FF7F50',
  '#9ACD32', '#FF4500', '#2E8B57', '#DAA520', '#D2691E',
  '#5F9EA0', '#1E90FF', '#FF69B4', '#8A2BE2', '#00FF7F',
];
function twitchDefaultColor(username) {
  if (!username) return '#9146ff';
  const n = username.toLowerCase();
  const sum = n.charCodeAt(0) + n.charCodeAt(n.length - 1);
  return TWITCH_DEFAULT_COLORS[sum % TWITCH_DEFAULT_COLORS.length];
}

// Twitch's "Global Emotes" panel ships these legacy face emotes at a tiny
// native resolution — upscaling makes them blurry. We render them smaller
// to match vanilla chat. Stable across ID renumbering (e.g. <3 = 555555584).
const _TWITCH_OG_FACE_NAMES = new Set([
  ':)', ':(', ':D', ':P', ':p', ':o', ':O', ';)', ';P', ';p',
  'B)', 'b)', ':|', ':/', ':\\', ':7', ':S', ':s', ':z', ':Z',
  'R)', 'r)', '<3', 'O_o', 'o_O', 'O_O', '8)',
  ':-)', ':-(', ':-D', ':-P', ':-p', ':-O', ':-o',
  '#/', ':?',
]);
function _isTwitchOgFaceName(name) {
  return _TWITCH_OG_FACE_NAMES.has(name);
}

// Twitch's vanilla chat lightens dark user colors on dark backgrounds so they
// stay legible (DarkRed #8B0000 → a visible red, etc.). We mirror that: lift
// the HSL Lightness floor to 0.5 and ceiling to 0.85 so both extremes read well.
const _READABLE_CACHE = new Map();
function readableColor(input) {
  if (!input) return input;
  if (_READABLE_CACHE.has(input)) return _READABLE_CACHE.get(input);
  const hex = /^#[0-9a-fA-F]{6}$/.test(input) ? input : null;
  if (!hex) { _READABLE_CACHE.set(input, input); return input; }
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0, s = 0;
  if (d) {
    s = l < 0.5 ? d / (max + min) : d / (2 - max - min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  // WCAG relative luminance — accounts for hue: pure blue is much harder
  // to read on dark bg than pure red even at the same HSL Lightness, so
  // we boost L extra when perceived luminance is very low. Twitch's vanilla
  // chat does the same — pure #0000FF renders at ~#9999FF (HSL L≈0.8).
  const wcagL = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  let minL = 0.5;
  if (wcagL < 0.10) minL = 0.78;       // very dark (pure blue, dark navy)
  else if (wcagL < 0.20) minL = 0.65;  // dark (e.g. dark red, navy variants)
  const maxL = 0.88;
  let nL = l;
  if (l < minL) nL = minL;
  else if (l > maxL) nL = maxL;
  if (nL === l) { _READABLE_CACHE.set(input, hex); return hex; }
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = nL < 0.5 ? nL * (1 + s) : nL + s - nL * s;
  const p = 2 * nL - q;
  const nr = Math.round(hue2rgb(p, q, h + 1 / 3) * 255);
  const ng = Math.round(hue2rgb(p, q, h) * 255);
  const nb = Math.round(hue2rgb(p, q, h - 1 / 3) * 255);
  const out = '#' + [nr, ng, nb].map(x => x.toString(16).padStart(2, '0')).join('');
  _READABLE_CACHE.set(input, out);
  return out;
}

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
    // Mod actions: timeout/ban (CLEARCHAT) + single-message delete (CLEARMSG)
    this.onClear = null;
    this.onClearMsg = null;
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
      timestamp: Date.now(),
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
        timestamp: Date.now(),
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
        timestamp: Date.now(),
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
        timestamp: Date.now(),
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
        timestamp: Date.now(),
        id: tags.id || crypto.randomUUID(),
        badgesRaw: tags.badges || '',
        isSubGift: true,
        giftRecipient: recipient,
        giftPlan: plan,
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
        timestamp: Date.now(),
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

      const badges = [];
      if (data.sender?.is_broadcaster) badges.push('\uD83C\uDFA4');
      if (data.sender?.is_moderator) badges.push('\u2694\uFE0F');
      if (data.sender?.is_subscriber) badges.push('\u2B50');

      this.onMessage?.({
        platform: 'kick',
        username,
        senderId,
        kickContent: content, // surový HTML obsah pro EmoteManager
        message: this._textOnly(content), // plain text fallback
        color,
        badges,
        timestamp: Date.now(),
        id: data.id || crypto.randomUUID(),
        replyTo
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
// 7TV Paints — cosmetic nickname styling (gradients / images / shadows)
// =============================================================

// Paint definitions are static — one global in-memory cache keyed by paint_id
// so multiple users with the same paint share a single fetch. Survives auto-
// switches because paints are not per-channel.
const _7TV_PAINTS = new Map();

// Decode 7TV's 32-bit RGBA integer (R<<24 | G<<16 | B<<8 | A) to a CSS color.
// JSON surfaces these as signed ints for values with R >= 0x80, so coerce to
// unsigned via `>>> 0` before shifting.
function _7tvIntToRgba(n) {
  if (n === null || n === undefined) return null;
  const u = n >>> 0;
  const r = (u >>> 24) & 0xff;
  const g = (u >>> 16) & 0xff;
  const b = (u >>> 8) & 0xff;
  const a = ((u & 0xff) / 255).toFixed(3);
  return `rgba(${r},${g},${b},${a})`;
}

// Convert a 7TV paint definition into a CSS-ready style object. Supported
// functions: LINEAR_GRADIENT, RADIAL_GRADIENT, URL (image). Drop shadows
// stack into a `filter` string. Text fill is transparent so background-clip
// reveals the paint across the glyph shapes.
function _7tvPaintToCss(paint) {
  if (!paint) return null;
  const fn = paint.function || paint.kind || '';
  const stops = (paint.stops || [])
    .map((s) => {
      const col = _7tvIntToRgba(s.color);
      if (!col) return null;
      const pos = (Number(s.at) * 100).toFixed(2) + '%';
      return `${col} ${pos}`;
    })
    .filter(Boolean)
    .join(', ');

  let background = null;
  if (fn === 'LINEAR_GRADIENT' && stops) {
    const angle = Number(paint.angle) || 0;
    background = paint.repeat
      ? `repeating-linear-gradient(${angle}deg, ${stops})`
      : `linear-gradient(${angle}deg, ${stops})`;
  } else if (fn === 'RADIAL_GRADIENT' && stops) {
    const shape = paint.shape || 'ellipse';
    background = paint.repeat
      ? `repeating-radial-gradient(${shape} at center, ${stops})`
      : `radial-gradient(${shape} at center, ${stops})`;
  } else if (fn === 'URL' && paint.image_url) {
    background = `url("${paint.image_url}") center / cover`;
  } else if (paint.color !== null && paint.color !== undefined) {
    // Solid paint — rare, but keep the code path honest.
    const col = _7tvIntToRgba(paint.color);
    if (col) background = col;
  }
  if (!background) return null;

  let filter = '';
  if (Array.isArray(paint.shadows) && paint.shadows.length) {
    filter = paint.shadows
      .map((s) => {
        const col = _7tvIntToRgba(s.color) || 'rgba(0,0,0,0.5)';
        const x = Number(s.x_offset) || 0;
        const y = Number(s.y_offset) || 0;
        const r = Number(s.radius) || 0;
        return `drop-shadow(${x}px ${y}px ${r}px ${col})`;
      })
      .join(' ');
  }

  return { background, filter };
}

// Apply a paint CSS object to a DOM element (the .un username span). Writes
// inline styles so we can coexist with and override the per-user `color`
// set by the normal color resolver. Pass `null` css to strip a paint.
function _7tvApplyPaintStyles(el, css) {
  if (!el) return;
  if (!css) {
    el.style.background = '';
    el.style.backgroundClip = '';
    el.style.webkitBackgroundClip = '';
    el.style.webkitTextFillColor = '';
    el.style.filter = '';
    return;
  }
  el.style.background = css.background;
  el.style.backgroundClip = 'text';
  el.style.webkitBackgroundClip = 'text';
  el.style.webkitTextFillColor = 'transparent';
  if (css.filter) el.style.filter = css.filter;
}

// 7TV's REST API doesn't expose per-paint GETs (/v3/cosmetics/paints/{id}
// 404s). The only way to get paint definitions is a bulk GQL query that
// returns all ~1000 paints in one shot (~300KB). We fire it lazily on the
// first paint lookup and every caller shares the same in-flight promise.
let _7TV_PAINTS_LOADED = false;
let _7TV_PAINTS_LOADING = null;

async function _7tvLoadAllPaints() {
  if (_7TV_PAINTS_LOADED) return;
  if (_7TV_PAINTS_LOADING) return _7TV_PAINTS_LOADING;
  _7TV_PAINTS_LOADING = (async () => {
    try {
      const query = `{ cosmetics { paints { id kind name function color stops { at color } repeat angle shape image_url shadows { x_offset y_offset radius color } } } }`;
      const r = await fetch('https://7tv.io/v3/gql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const json = await r.json();
      const paints = json?.data?.cosmetics?.paints || [];
      for (const p of paints) if (p?.id) _7TV_PAINTS.set(p.id, p);
      _7TV_PAINTS_LOADED = true;
    } catch (e) {
      // Allow a retry on next lookup
      _7TV_PAINTS_LOADING = null;
    }
  })();
  return _7TV_PAINTS_LOADING;
}

async function _7tvFetchPaint(paintId) {
  if (!paintId) return null;
  if (!_7TV_PAINTS_LOADED) await _7tvLoadAllPaints();
  return _7TV_PAINTS.get(paintId) || null;
}

// Resolve the 7TV cosmetics + emote-set assigned to a Twitch user (by their
// Twitch numeric ID). Returns { paint, emoteSet } where paint is the full
// definition or null, emoteSet is the raw 7TV emote-set object (with .emotes
// array) or null. The user's emote set is what they "carry" to other
// channels — typing their own emote there is still valid.
async function _7tvFetchUserData(twitchUserId) {
  if (!twitchUserId) return { paint: null, emoteSet: null };
  try {
    const r = await fetch(`https://7tv.io/v3/users/twitch/${twitchUserId}`);
    if (!r.ok) return { paint: null, emoteSet: null };
    const data = await r.json();
    const user = data?.user || data;
    const paintId = user?.style?.paint_id;
    const paint = paintId ? await _7tvFetchPaint(paintId) : null;
    // Top-level `emote_set` on the platform-binding response is the channel
    // emote set the user has assigned for Twitch (their personal "loadout").
    const emoteSet = data?.emote_set || null;
    return { paint, emoteSet };
  } catch {
    return { paint: null, emoteSet: null };
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
    this._chatUsers = new Map();  // username → { name, platform, color }
    this._seenMsgIds = new Set();
    this._seenContentKeys = new Set(); // pro scrape dedup (username + text)
    this._optimisticKeys = new Map();  // contentKey → sentId (for upgrading optimistic → real)
    this._platformUsernames = {}; // per-platform username tracking (loaded from config in _init)
    this._isModOnChannel = false; // viewer has moderator/broadcaster badge on current Twitch channel
    this._platformColors = {};    // per-platform user color (from IRC/API)
    this._syncedProfiles = new Set(); // platform:username pairs already synced with API
    this._seCommands = [];        // StreamElements bot commands (for ! autocomplete)
    this._msgHistory = [];         // sent message history (newest last)
    this._msgHistoryIdx = -1;      // -1 = not browsing, 0..N = position from end
    this._msgHistoryDraft = '';    // unsent text before browsing history

    // Connect port to background — tracks panel open/close state
    // Port auto-disconnects when panel closes (background detects via onDisconnect)
    const _port = chrome.runtime.connect({ name: 'sidepanel' });
    _port.onMessage.addListener((msg) => {
      if (msg.type === 'CLOSE') window.close();
    });

    // Uložit cache při zavření/reloadu panelu
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
    // Verze v titulku — wrap the logo so the update dot + tooltip can hang
    // off it (dot anchors to the top-right corner of the logo, tooltip
    // drops to the right from the logo's left edge).
    const ver = chrome.runtime.getManifest().version;
    const title = document.getElementById('header-title');
    title.innerHTML =
      `<span class="hdr-logo-wrap" id="hdr-logo-wrap">
        <img src="icons/icon48.png" class="hdr-logo" alt="UnityChat">
        <span class="update-dot" aria-hidden="true"></span>
      </span> UnityChat <span class="hdr-ver">v${ver}</span> <span class="hdr-beta">[BETA]</span>`;
    // Clone the update tooltip template into the logo wrap so hover on the
    // logo reveals it. Pulled from a <template> in sidepanel.html so the
    // markup stays authored in HTML and readable.
    const tpl = document.getElementById('update-tooltip-tpl');
    const logoWrap = document.getElementById('hdr-logo-wrap');
    if (tpl && logoWrap) {
      logoWrap.appendChild(tpl.content.cloneNode(true));
      // Hover-intent: 250ms hide delay covers the pixel gap between the logo
      // and the tooltip card (CSS-only :hover would drop as soon as the
      // cursor left the logo, killing the "move down to click the link" UX).
      const tip = logoWrap.querySelector('.update-tooltip');
      let hideT = null;
      const show = () => {
        clearTimeout(hideT);
        logoWrap.classList.add('is-hovering');
      };
      const hide = () => {
        clearTimeout(hideT);
        hideT = setTimeout(() => logoWrap.classList.remove('is-hovering'), 250);
      };
      logoWrap.addEventListener('mouseenter', show);
      logoWrap.addEventListener('mouseleave', hide);
      if (tip) {
        tip.addEventListener('mouseenter', show);
        tip.addEventListener('mouseleave', hide);
      }
    }

    await this._loadConfig();
    if (this.config._platformUsernames) {
      this._platformUsernames = { ...this.config._platformUsernames };
    }
    if (this.config._platformColors) {
      this._platformColors = { ...this.config._platformColors };
    }
    try {
      const r = await chrome.storage.local.get('uc_synced');
      if (Array.isArray(r.uc_synced)) this._syncedProfiles = new Set(r.uc_synced);
    } catch {}

    // Load persisted user colors. Sanitize stale state from prior buggy
    // builds: an entry can have _fromGQL=true while .color is still a raw
    // IRC hex (#rrggbb). That combo blocks future lookups (the queue
    // skips _fromGQL entries) so the user is stuck with the raw color
    // forever. Drop _fromGQL on those so a fresh lookup can re-resolve.
    try {
      const d = await chrome.storage.local.get('uc_user_colors');
      if (d.uc_user_colors) {
        for (const [k, v] of Object.entries(d.uc_user_colors)) {
          if (v && typeof v === 'object' && v._fromGQL && typeof v.color === 'string'
              && /^#[0-9a-fA-F]{6}$/.test(v.color)) {
            v._fromGQL = false;
          }
          this._chatUsers.set(k, v);
        }
      }
    } catch {}
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
            if (nickEl && !nickEl.value) nickEl.value = profile.nickname;
            break;
          }
        }
      }
      // Refresh color for active platform (or first available)
      this._refreshColorUI(this.activePlatform || 'twitch');
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

    console.log('[UC] init: loading emotes + badges...');
    // Load emotes + badges FIRST so cached messages render with correct emotes/badges.
    // Use Promise.allSettled — one failing source shouldn't block the rest.
    try {
      this.emotes.loadTwitchGlobals();
      await this.emotes.loadGlobal();
      if (this.config._roomId) {
        await Promise.allSettled([
          this.emotes.loadChannel('twitch', this.config._roomId),
          this.emotes.loadBTTV(this.config._roomId),
          this.emotes.loadFFZ(this.config._roomId),
          this.emotes.loadTwitchChannel(this.config.channel),
          this._loadTwitchBadges(this.config._roomId)
        ]);
      }
    } catch {}

    // Load SE bot commands in background (for ! autocomplete)
    this._loadSECommands().catch(() => {});

    // Spinner up before any heavy work — it covers cache hydration + the
    // first round of provider connects. Cleared on first rendered message,
    // when all configured platforms reach a terminal state, or after 8s.
    this._showLoading();

    console.log('[UC] init: loading cache...');
    await this._loadCachedMessages();
    console.log('[UC] init: cache loaded, connecting all...');
    this._connectAll();
    console.log('[UC] init: connected, starting detect loop');
    this._detectLoop();
    // Fire-and-forget update check against the public landing page manifest.
    this._checkForUpdate().catch(() => {});
    // Subscribe to background's 15-min alarm broadcasts so a long-open
    // panel still updates in real time when a new version drops.
    this._wireBackgroundUpdateListener();
    // Hover/click preview card for emotes inside chat messages.
    this._setupEmotePreview();
    this._scheduleColorRevalidation();
    this._pullCredits();
  }

  async _checkForUpdate() {
    try {
      const current = chrome.runtime.getManifest().version;
      const resp = await fetch('https://jouki.cz/download/manifest.json', { cache: 'no-store' });
      if (!resp.ok) return;
      const remote = await resp.json();
      const latest = remote?.version;
      const wrap = document.getElementById('hdr-logo-wrap');
      const num = document.getElementById('ut-version-num');
      const hasUpdate = latest && this._isNewerVersion(latest, current);
      if (!hasUpdate) {
        // User is on latest (or ahead — update.bat was run). Clear any stale
        // badge from a previous session.
        chrome.runtime.sendMessage({ type: 'CLEAR_UPDATE_BADGE' }).catch(() => {});
        return;
      }
      if (num) num.textContent = latest;
      if (wrap) wrap.classList.add('has-update');
      // Browser action icon: red ! badge + hover title "UPDATE available"
      chrome.runtime.sendMessage({ type: 'SET_UPDATE_BADGE', version: latest }).catch(() => {});
      // Auto-reveal the tooltip for 10s with a shrinking countdown bar so
      // the user sees the notice even without hovering the logo.
      this._autoRevealUpdateTooltip();
    } catch {}
  }

  _autoRevealUpdateTooltip() {
    const wrap = document.getElementById('hdr-logo-wrap');
    if (!wrap || !wrap.classList.contains('has-update')) return;
    // Restart the countdown bar animation on repeat calls by removing and
    // re-adding the class on the next frame.
    wrap.classList.remove('auto-reveal');
    // Force reflow so the animation restart actually takes effect
    void wrap.offsetWidth;
    wrap.classList.add('auto-reveal');
    clearTimeout(this._autoRevealT);
    this._autoRevealT = setTimeout(() => {
      wrap.classList.remove('auto-reveal');
    }, 10000);
  }

  // Background's 15-min alarm broadcasts UC_UPDATE_AVAILABLE / UC_UPDATE_CLEARED.
  // Wired here so a long-open sidepanel reflects update state in real time
  // without waiting for the user to close+reopen the panel.
  _wireBackgroundUpdateListener() {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'UC_UPDATE_AVAILABLE' && msg.version) {
        const wrap = document.getElementById('hdr-logo-wrap');
        const num = document.getElementById('ut-version-num');
        if (!wrap) return;
        const isNew = !wrap.classList.contains('has-update');
        if (num) num.textContent = msg.version;
        wrap.classList.add('has-update');
        // Only auto-reveal on transition (false→true), not on every periodic
        // re-confirmation, otherwise the tooltip would pop every 15 min.
        if (isNew) this._autoRevealUpdateTooltip();
      } else if (msg?.type === 'UC_UPDATE_CLEARED') {
        const wrap = document.getElementById('hdr-logo-wrap');
        if (wrap) {
          wrap.classList.remove('has-update', 'auto-reveal', 'is-hovering');
        }
      } else if (msg?.type === 'TW_REDEEM_DOM' && msg.data) {
        this._handleDomRedeem(msg.data);
      } else if (msg?.type === 'TW_HIGHLIGHTS') {
        this._handleHighlights(msg);
      } else if (msg?.type === 'TW_CREDITS' && msg.data) {
        this._handleCredits(msg.data);
      }
    });
  }

  _isNewerVersion(remote, current) {
    const parse = (v) => (v || '0').split('.').map((n) => parseInt(n, 10) || 0);
    const a = parse(remote);
    const b = parse(current);
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const x = a[i] || 0;
      const y = b[i] || 0;
      if (x > y) return true;
      if (x < y) return false;
    }
    return false;
  }

  // ---- Config ----

  async _loadConfig() {
    try {
      const s = await chrome.storage.sync.get('uc_config');
      if (s.uc_config) this.config = { ...DEFAULTS, ...s.uc_config };
      // One-time migration: older configs have maxMessages=500 baked in, bump
      // them to the new default so existing users benefit from the 72h cache.
      if ((this.config.maxMessages || 0) < DEFAULTS.maxMessages) {
        this.config.maxMessages = DEFAULTS.maxMessages;
        this._saveConfig();
      }
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

    $('input-channel').value = this.config.channel || '';
    $('input-kick-channel').value = this.config.kickChannel || '';
    $('input-yt-channel').value = this.config.ytChannel || '';
    $('input-username').value = this.config.username || '';
    // Pre-populate nickname from cache
    if (this.config.username) {
      for (const p of ['twitch', 'youtube', 'kick']) {
        const profile = this.nicknames.get(p, this.config.username);
        if (profile?.nickname) {
          $('input-nickname').value = profile.nickname;
          break;
        }
      }
    }
    // Color UI will be refreshed by _refreshColorUI after platform detection
    $('input-layout').value = this.config.layout || 'small';
    this._applyLayout();
    $('input-layout').addEventListener('change', () => {
      this.config.layout = $('input-layout').value;
      this._saveConfig();
      this._applyLayout();
    });
    // Timestamp visibility — CSS-only toggle, no re-render needed
    const tsBox = $('chk-timestamps');
    if (tsBox) {
      tsBox.checked = this.config.showTimestamps !== false;
      this._applyTimestampVisibility();
      tsBox.addEventListener('change', () => {
        this.config.showTimestamps = tsBox.checked;
        this._saveConfig();
        this._applyTimestampVisibility();
      });
    }
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
        const seen = new Set();
        const matches = [...this._chatUsers.entries()]
          .filter(([key, u]) => {
            if (key.includes(':')) return false;
            const name = u.name.replace(/^@/, '').toLowerCase();
            if (seen.has(name)) return false;
            if (!name.startsWith(prefix)) return false;
            seen.add(name);
            return true;
          })
          .sort(([, a], [, b]) => a.name.localeCompare(b.name))
          .map(([, u]) => '@' + u.name.replace(/^@/, ''));
        if (matches.length) {
          this._ac = { start: ws, end: pos, index: 0, matches };
          this._acRender();
        } else {
          this._acHide();
        }
      } else if (partial.startsWith('!') && partial.length >= 2 && ws === 0) {
        // !command autocomplete (only at start of message)
        const prefix = partial.substring(1).toLowerCase();
        const matches = this._seCommands
          .filter(c => c.name.toLowerCase().startsWith(prefix))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(c => '!' + c.name);
        if (matches.length) {
          this._ac = { start: ws, end: pos, index: 0, matches };
          this._acRender();
        } else {
          this._acHide();
        }
      } else if (text.startsWith('/uc ') && ws === 4) {
        // /uc subcommand autocomplete
        const prefix = partial.toLowerCase();
        const cmds = ['raid', 'raider', 'first', 'sus'];
        const matches = cmds.filter(c => c.startsWith(prefix)).map(c => '/uc ' + c);
        if (matches.length) {
          this._ac = { start: 0, end: pos, index: 0, matches, _type: 'uc' };
          this._acRender();
        } else {
          this._acHide();
        }
      } else if (text === '/uc ' && partial === '' && pos === 4) {
        // Just typed "/uc " — show all subcommands
        const cmds = ['raid', 'raider', 'first', 'sus'];
        const matches = cmds.map(c => '/uc ' + c);
        this._ac = { start: 0, end: pos, index: 0, matches, _type: 'uc' };
        this._acRender();
      } else if (!partial.startsWith('@') && !partial.startsWith('!')) {
        // Not typing @ or !, clear any open suggest (emote suggest is Tab-only)
        if (this._ac && (this._ac.matches[0]?.startsWith('@') || this._ac.matches[0]?.startsWith('!') || this._ac._type === 'uc')) this._acHide();
      }
    });

    // Username se nastaví okamžitě při psaní, uloží při blur
    // Username change (only in dev mode — field is readonly otherwise)
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
    // Platform checkboxes were removed — force all three on so cached configs
    // with stale `false` values don't silently disable a platform.
    this.config.twitch = true;
    this.config.youtube = true;
    this.config.kick = true;

    $('btn-popout').addEventListener('click', () => {
      chrome.windows.create({
        url: 'sidepanel.html',
        type: 'popup',
        width: 420,
        height: 720
      });
    });
    $('btn-dump').addEventListener('click', async () => {
      // Build a rich diagnostics report and prepend it to the log dump so
      // a single download answers the most common debugging questions
      // (color/paint mismatches, missing scrape, badge attribution, …).
      try {
        const diag = await this._buildDiagnostics();
        // Await the UC_LOG round-trip so the diag is in the array BEFORE
        // we trigger the file dump (otherwise the download race-loses).
        await chrome.runtime.sendMessage({ type: 'UC_LOG', tag: 'DIAG', text: diag });
      } catch (e) {
        try {
          await chrome.runtime.sendMessage({ type: 'UC_LOG', tag: 'DIAG', text: 'diag failed: ' + e.message });
        } catch {}
      }
      chrome.runtime.sendMessage({ type: 'DUMP_LOGS' });
    });
    $('btn-settings').addEventListener('click', () =>
      $('settings').classList.toggle('hidden')
    );

    // Nickname (empty = delete)
    $('btn-nickname').addEventListener('click', async () => {
      const nick = $('input-nickname').value.trim();
      const color = $('input-color-hex').value.trim() || null;
      const statusEl = $('nickname-status');
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
        // Use platform-specific username, falling back to config username
        let uname = this._platformUsernames[p] || this.config.username;
        if (!uname) {
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
        let result;
        if (nick || color) {
          // If no custom nickname, use the display name (from IRC display-name tag)
          // so it looks unchanged — only color changes
          const displayName = nick || this._chatUsers.get(`${p}:${uname.toLowerCase()}`)?.name || uname;
          result = await this.nicknames.save(p, uname, displayName, color);
        } else {
          // Both empty → delete
          result = await this.nicknames.remove(p, uname);
        }
        if (result.ok) saved++;
        else if (result.retryAfter) lastError = `Počkej ${Math.ceil(result.retryAfter)}s`;
        else lastError = result.error;
      }

      $('btn-nickname').disabled = false;
      if (saved > 0) {
        // Retroactively update all visible messages from this user
        let activeColor = null;
        for (const p of platforms) {
          const uname = this._platformUsernames[p] || this.config.username;
          if (!uname) continue;
          const profile = this.nicknames.get(p, uname);
          const fallbackColor = this._chatUsers.get(`${p}:${uname.toLowerCase()}`)?.color || '';
          const resolvedColor = profile?.color || fallbackColor;
          const newNick = profile?.nickname || null;
          this.chatEl.querySelectorAll('.un').forEach((un) => {
            if (un.dataset.platform === p && un.dataset.username === uname.toLowerCase()) {
              un.style.color = readableColor(resolvedColor);
              if (newNick) { un.textContent = newNick; un.title = uname; }
              else { un.textContent = uname; un.title = ''; }
            }
          });
          if (p === this.activePlatform) activeColor = resolvedColor;
        }
        // Refresh color UI to reflect saved/cleared state
        this._refreshColorUI(this.activePlatform);
        statusEl.textContent = nick || color
          ? `Uloženo pro ${saved} ${saved === 1 ? 'platformu' : 'platformy'}!`
          : `Smazáno pro ${saved} ${saved === 1 ? 'platformu' : 'platformy'}`;
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
      this.config.channel = $('input-channel').value.trim();
      this.config.kickChannel = $('input-kick-channel').value.trim();
      this.config.ytChannel = $('input-yt-channel').value.trim();
      this.config.username = $('input-username').value.trim();
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

    // "Jsem streamer" button — opens streamer.html in a new tab.
    // Stop propagation so click doesn't toggle the <details> section.
    const imStreamerBtn = $('btn-im-streamer');
    if (imStreamerBtn) {
      imStreamerBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        chrome.tabs.create({ url: chrome.runtime.getURL('streamer.html') });
      });
    }

    // Dev mode
    $('chk-devmode').addEventListener('change', () => {
      const on = $('chk-devmode').checked;
      $('dev-tools').classList.toggle('hidden', !on);
      // Enable/disable username editing
      $('input-username').readOnly = !on;
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

    // Scroll - detekce nových zpráv + auto-scroll pause.
    //
    // Race fix for fast chat: when many messages arrive in quick succession,
    // a programmatic scroll-to-bottom can fire its scroll event AFTER more
    // messages have appended (scrollHeight grew but scrollTop wasn't yet
    // re-set in this frame). The atBottom check then sees the gap and
    // wrongly disables autoScroll. We mark a short window after every
    // programmatic scroll during which scroll events are ignored.
    this._unreadCount = 0;
    this._programmaticScrollUntil = 0;
    this.chatEl.addEventListener('scroll', () => {
      if (performance.now() < this._programmaticScrollUntil) return;
      const el = this.chatEl;
      // Bigger slack (100px) so casual cursor wiggle near the bottom
      // doesn't accidentally pause auto-scroll on busy streams.
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
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
        this.filters[p] = !this.filters[p];
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
      // Message history (ArrowUp/Down when no autocomplete is active)
      if (e.key === 'ArrowUp' && !this._ac && this._msgHistory.length) {
        if (this._msgHistoryIdx !== -1) {
          e.preventDefault();
          if (this._msgHistoryIdx > 0) this._msgHistoryIdx--;
          this.msgInput.value = this._msgHistory[this._msgHistoryIdx];
          this.msgInput.setSelectionRange(0, 0);
          return;
        }
        if (this._isCursorOnFirstLine()) {
          e.preventDefault();
          this._msgHistoryDraft = this.msgInput.value;
          this._msgHistoryIdx = this._msgHistory.length - 1;
          this.msgInput.value = this._msgHistory[this._msgHistoryIdx];
          this.msgInput.setSelectionRange(0, 0);
          return;
        }
      }
      if (e.key === 'ArrowDown' && !this._ac && this._msgHistoryIdx !== -1) {
        e.preventDefault();
        if (this._msgHistoryIdx < this._msgHistory.length - 1) {
          this._msgHistoryIdx++;
          this.msgInput.value = this._msgHistory[this._msgHistoryIdx];
        } else {
          this._msgHistoryIdx = -1;
          this.msgInput.value = this._msgHistoryDraft;
        }
        const len = this.msgInput.value.length;
        this.msgInput.setSelectionRange(len, len);
        return;
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
      btn.classList.toggle('active', !!this.filters[btn.dataset.platform]);
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
      if (!this._ac.applied) {
        // First TAB after input-triggered suggest → confirm current selection
        this._acApply();
        return;
      }
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
      // Deduplicate by display name (map has both plain + platform:username keys)
      const prefix = partial.substring(1).toLowerCase();
      const seen = new Set();
      matches = [...this._chatUsers.entries()]
        .filter(([key, u]) => {
          if (key.includes(':')) return false;
          const name = u.name.replace(/^@/, '').toLowerCase();
          if (seen.has(name)) return false;
          if (prefix && !name.startsWith(prefix)) return false;
          seen.add(name);
          return true;
        })
        .sort(([, a], [, b]) => a.name.localeCompare(b.name))
        .map(([, u]) => '@' + u.name.replace(/^@/, ''));
    } else {
      // Emote autocomplete — honors the per-session "Fulltext" toggle
      matches = this.emotes.findCompletions(partial, { fulltext: this._acFulltext });
    }
    if (!matches.length) { this._acHide(); return; }

    this._ac = { start: ws, end: pos, index: 0, matches, prefix: partial, kind: partial.startsWith('@') ? 'user' : 'emote' };
    this._acApply();
  }

  // Re-run the search against the same prefix with the (possibly toggled)
  // fulltext flag and re-render the suggest panel in place. Used when the
  // user clicks the "Fulltext" checkbox while the panel is open.
  _acRefilter() {
    const ac = this._ac;
    if (!ac || ac.kind !== 'emote' || !ac.prefix) return;
    const next = this.emotes.findCompletions(ac.prefix, { fulltext: this._acFulltext });
    if (!next.length) { this._acHide(); return; }
    ac.matches = next;
    ac.index = 0;
    ac._winStart = 0;
    this._acRender();
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
    ac.applied = true;
    input.setSelectionRange(ac.end, ac.end);
    this._acRender();
  }

  /** Zjistí zdroj emotu pro zobrazení tagu. */
  _acSource(name) {
    if (name.startsWith('/uc ')) return 'UC';
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
    if (this.emotes.ucEmotes.has(name)) return 'UChat';
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
    // Fulltext-search toggle row (only for emote completion, not @user) —
    // when checked, future findCompletions() calls match by `includes`
    // rather than `startsWith`, so middle-of-name matches show up too.
    if (ac.kind === 'emote') {
      const checked = this._acFulltext ? ' checked' : '';
      html += `<label class="es-toggle"><input type="checkbox" id="es-fulltext"${checked}>Fulltext</label>`;
    }
    for (let i = winStart; i < winEnd; i++) {
      const name = ac.matches[i];
      const sel = i === idx ? ' selected' : '';
      html += `<div class="es-item${sel}" data-idx="${i}">`;

      if (name.startsWith('/uc ')) {
        // UC command: oranžová tečka
        html += `<span class="es-dot" style="background:#ff8c00"></span>`;
      } else if (name.startsWith('@')) {
        // Username: barevná tečka
        const u = this._chatUsers.get(name.substring(1).toLowerCase());
        const col = this.emotes._sc(u?.color) || '#ccc';
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

    // Wire fulltext checkbox — toggles persistent flag and re-runs the
    // current search, so the panel refilters live without retyping.
    const ftBox = el.querySelector('#es-fulltext');
    if (ftBox) {
      ftBox.addEventListener('change', (e) => {
        e.stopPropagation();
        this._acFulltext = ftBox.checked;
        this._acRefilter();
        this.msgInput.focus();
      });
      // Don't let mousedown on the label steal focus from the textarea.
      const lbl = el.querySelector('.es-toggle');
      if (lbl) lbl.addEventListener('mousedown', (e) => e.preventDefault());
    }

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

  // ---- Cursor line detection ----

  _isCursorOnFirstLine() {
    const ta = this.msgInput;
    if (ta.selectionStart === 0) return true;
    if (!ta.value) return true;
    if (!this._lineMirror) {
      this._lineMirror = document.createElement('div');
      this._lineMirror.style.cssText = 'position:absolute;visibility:hidden;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word;';
      document.body.appendChild(this._lineMirror);
    }
    const m = this._lineMirror;
    const cs = getComputedStyle(ta);
    m.style.width = ta.clientWidth + 'px';
    m.style.font = cs.font;
    m.style.padding = cs.padding;
    m.style.boxSizing = cs.boxSizing;
    m.style.letterSpacing = cs.letterSpacing;
    m.textContent = 'X';
    const lineH = m.offsetHeight;
    m.textContent = ta.value.substring(0, ta.selectionStart);
    return m.offsetHeight <= lineH;
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
        const prev = this._platformUsernames[resp.platform];
        this._platformUsernames[resp.platform] = name;
        if (!this.config._platformUsernames) this.config._platformUsernames = {};
        if (this.config._platformUsernames[resp.platform] !== name) {
          this.config._platformUsernames[resp.platform] = name;
          this._saveConfig();
        }
        this._syncProfile(resp.platform, name);
        // Update settings UI when username changes (or was missing on first detect)
        if (prev !== name && resp.platform === this.activePlatform) {
          const el = document.getElementById('input-username');
          if (el) el.value = name;
          const label = document.querySelector('label[for="input-username"]');
          const names = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick' };
          if (label) label.textContent = `Username (${names[resp.platform] || resp.platform})`;
          // Refresh nickname/color fields for new username
          const nickEl = document.getElementById('input-nickname');
          if (nickEl) {
            const profile = this.nicknames.get(resp.platform, name);
            nickEl.value = profile?.nickname || '';
          }
          this._refreshColorUI(resp.platform);
        }
      }
      // Auto-detekce username z platformy (hlavní config field)
      if (resp?.username && !this.config.username) {
        this.config.username = resp.username;
        const el = document.getElementById('input-username');
        if (el) el.value = resp.username;
        this._saveConfig();
      }

      // Auto-switch: zkontroluj jestli jsme na známém streamerovi a přepni pokud ano.
      // Pokud content script nereaguje, detekujeme platformu z URL — auto-switch
      // má fungovat i bez funkčního content scriptu.
      if (tab.url) {
        const p = resp?.platform || this._detectPlatformFromUrl(tab.url);
        if (p) this._checkAutoSwitch(p, tab.url, resp?.channelHandle).catch(() => {});
      }
    } catch {
      this._setActivePlatform(null);
    }
  }

  // ---- Auto-switch: detect current stream from tab URL, look up in
  // streamer directory, re-point UnityChat to all 3 channels if known. ----

  _parseChannelFromUrl(url, platform) {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      const parts = u.pathname.toLowerCase().split('/').filter(Boolean);
      if (platform === 'twitch') {
        // Only main www.twitch.tv / m.twitch.tv — skip dev.twitch.tv, id.twitch.tv,
        // api.twitch.tv, help.twitch.tv, etc. (those have non-channel paths that
        // would leak false-positive stub records into the directory).
        if (host !== 'www.twitch.tv' && host !== 'm.twitch.tv' && host !== 'twitch.tv') return null;
        const excluded = new Set([
          'directory', 'videos', 'search', 'p', 'turbo', 'prime', 'downloads',
          'subscriptions', 'settings', 'login', 'signup', 'logout', 'friends',
          'wallet', 'inventory', 'drops', 'moderator', 'user', 'videoproducer',
        ]);
        if (parts[0] === 'popout' && parts[1] && /^[a-z0-9_]+$/.test(parts[1])) return parts[1];
        if (parts[0] && !excluded.has(parts[0]) && /^[a-z0-9_]+$/.test(parts[0])) return parts[0];
      }
      if (platform === 'kick') {
        if (host !== 'kick.com' && host !== 'www.kick.com') return null;
        const excluded = new Set([
          'categories', 'category', 'browse', 'following', 'subscriptions',
          'search', 'dashboard', 'settings', 'login', 'signup', 'help',
          'community-guidelines', 'careers', 'about', 'terms', 'privacy',
        ]);
        if (parts[0] && !excluded.has(parts[0]) && /^[a-z0-9_-]+$/.test(parts[0])) return parts[0];
      }
      if (platform === 'youtube') {
        if (!host.endsWith('youtube.com') && host !== 'youtu.be') return null;
        // Only @handle pages for now — /watch pages need content-script resolution.
        if (parts[0]?.startsWith('@')) return parts[0].substring(1);
      }
    } catch {}
    return null;
  }

  async _lookupStreamer(platform, handle) {
    if (!this._streamerCache) this._streamerCache = new Map();
    const key = `${platform}:${handle}`;
    if (this._streamerCache.has(key)) return this._streamerCache.get(key);
    try {
      const resp = await fetch(`${UC_API}/streamers/lookup?platform=${platform}&handle=${encodeURIComponent(handle)}`);
      if (resp.status === 404) {
        this._streamerCache.set(key, null);
        this._trimStreamerCache();
        return null;
      }
      if (!resp.ok) return null;
      const data = await resp.json();
      const streamer = data.found ? data.streamer : null;
      this._streamerCache.set(key, streamer);
      this._trimStreamerCache();
      return streamer;
    } catch {
      return null;
    }
  }

  _trimStreamerCache() {
    if (this._streamerCache.size > 20) {
      const firstKey = this._streamerCache.keys().next().value;
      this._streamerCache.delete(firstKey);
    }
  }

  _sendSeenPing(platform, handle) {
    // Fire-and-forget. Chat activation signal that creates a stub in DB.
    fetch(`${UC_API}/streamers/seen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, handle }),
    }).catch(() => {});
  }

  _detectPlatformFromUrl(url) {
    try {
      const u = new URL(url);
      if (u.hostname.includes('twitch.tv')) return 'twitch';
      if (u.hostname.includes('kick.com')) return 'kick';
      if (u.hostname.includes('youtube.com') || u.hostname.includes('youtu.be')) return 'youtube';
    } catch {}
    return null;
  }

  async _checkAutoSwitch(platform, tabUrl, contentHandle) {
    if (!platform || !tabUrl) return;
    let handle = this._parseChannelFromUrl(tabUrl, platform);
    // YouTube /watch pages don't have channel handle in URL — use DOM-resolved
    // handle from content script as fallback.
    if (!handle && contentHandle) {
      handle = String(contentHandle).toLowerCase().replace(/^@/, '');
    }
    if (!handle) return;

    // Skip if the handle already matches our current config for this platform.
    const currentConfigHandle = this._getConfiguredHandle(platform);
    if (currentConfigHandle === handle && this._autoSwitchedTo === handle) return;

    // Cancel any in-flight switch: a new URL change trumps older work.
    this._autoSwitchSeq = (this._autoSwitchSeq || 0) + 1;
    const mySeq = this._autoSwitchSeq;

    const streamer = await this._lookupStreamer(platform, handle);
    if (mySeq !== this._autoSwitchSeq) return;

    // Known streamer → full cross-platform map. Unknown streamer → only the
    // current platform's channel is set; others cleared (per design — we don't
    // guess cross-platform handles for unregistered streamers).
    const target = streamer || {
      twitchLogin: platform === 'twitch' ? handle : null,
      youtubeHandle: platform === 'youtube' ? handle : null,
      kickSlug: platform === 'kick' ? handle : null,
    };

    await this._performAutoSwitch(target, mySeq, handle);
    this._sendSeenPing(platform, handle);
  }

  _getConfiguredHandle(platform) {
    if (platform === 'twitch') return (this.config.channel || '').toLowerCase();
    if (platform === 'youtube') return (this.config.ytChannel || '').toLowerCase().replace(/^@/, '');
    if (platform === 'kick') return (this.config.kickChannel || '').toLowerCase();
    return '';
  }

  async _performAutoSwitch(streamer, mySeq, sourceHandle) {
    const newTwitch = streamer.twitchLogin || '';
    const newYoutube = streamer.youtubeHandle || '';
    const newKick = streamer.kickSlug || '';

    // Need at least one platform to switch TO.
    if (!newTwitch && !newYoutube && !newKick) return;

    const changed =
      (this.config.channel || '').toLowerCase() !== newTwitch.toLowerCase() ||
      (this.config.ytChannel || '').toLowerCase() !== newYoutube.toLowerCase() ||
      (this.config.kickChannel || '').toLowerCase() !== newKick.toLowerCase();
    if (!changed) {
      this._autoSwitchedTo = sourceHandle;
      return;
    }

    this._showSwitchBanner(streamer);

    // Persist pending messages to OLD channel's cache before switching.
    if (this._msgCache.length > 0) {
      chrome.storage.local.set({ [this._cacheKey]: this._msgCache }).catch(() => {});
    }

    // Each platform's channel is strictly its own — never fall back cross-platform.
    this.config.channel = newTwitch;
    this.config.ytChannel = newYoutube;
    this.config.kickChannel = newKick;
    this._saveConfig();
    this._refreshSettingsInputs();

    // Clear on-screen chat + in-memory dedup — new streamer has its own history.
    this.chatEl.innerHTML = '';
    this.msgCount = 0;
    this._msgCache = [];
    this._seenMsgIds = new Set();
    this._seenContentKeys = new Set();
    this._optimisticKeys = new Map();
    this._isModOnChannel = false; // re-detect from badges on new channel
    // Recycle the boot-time loading overlay during channel switch — same
    // pattern fits: cache hydrating + new providers connecting + first
    // message of the new channel hides it.
    this._loadingClearedByMsg = false;
    this._showLoading();
    // Clear @mention autocomplete — old streamer's chatters should not show up
    // as suggestions on the new channel. Keep "platform:username" keys so the
    // color cache survives (users who chat across streams keep their color).
    for (const key of this._chatUsers.keys()) {
      if (!key.includes(':')) this._chatUsers.delete(key);
    }
    // Clear channel-specific emote + badge caches (belong to old streamer)
    this.emotes.channel7tv.clear();
    this.emotes.bttvEmotes.clear();
    this.emotes.ffzEmotes.clear();
    this.emotes.twitchNative.clear();
    this._twitchBadges = {};
    this.emotes.loadTwitchGlobals();

    this._disconnectAll();
    if (mySeq !== this._autoSwitchSeq) { this._hideSwitchBanner(); return; }

    // Pre-load channel emotes + badges BEFORE rendering cached messages —
    // otherwise cached messages render as plain text (no emote/badge resolve).
    // We use user_ids from the streamer lookup result (known) or stub (null);
    // unknown streamers without user_id get filled-in progressively once IRC
    // onRoomId arrives from reconnect.
    if (streamer.twitchUserId) {
      await Promise.allSettled([
        this.emotes.loadChannel('twitch', streamer.twitchUserId),
        this.emotes.loadBTTV(streamer.twitchUserId),
        this.emotes.loadFFZ(streamer.twitchUserId),
        streamer.twitchLogin ? this.emotes.loadTwitchChannel(streamer.twitchLogin) : Promise.resolve(),
        this._loadTwitchBadges(streamer.twitchUserId),
      ]);
      // Persist roomId for the new channel so future reloads short-circuit the IRC-wait.
      this.config._roomId = streamer.twitchUserId;
      this._saveConfig();
    } else {
      // Unknown streamer — clear stale roomId so onRoomId refreshes when IRC connects.
      this.config._roomId = null;
    }
    if (mySeq !== this._autoSwitchSeq) { this._hideSwitchBanner(); return; }

    await this._loadCachedMessages();
    if (mySeq !== this._autoSwitchSeq) { this._hideSwitchBanner(); return; }

    this._connectAll();

    this._autoSwitchedTo = sourceHandle;
    setTimeout(() => {
      if (this._autoSwitchSeq === mySeq) this._hideSwitchBanner();
    }, 1500);
  }

  _refreshSettingsInputs() {
    const map = { 'input-channel': this.config.channel, 'input-yt-channel': this.config.ytChannel, 'input-kick-channel': this.config.kickChannel };
    for (const [id, val] of Object.entries(map)) {
      const el = document.getElementById(id);
      if (el) el.value = val || '';
    }
  }

  _showSwitchBanner(streamer) {
    let banner = document.getElementById('switch-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'switch-banner';
      banner.className = 'switch-banner';
      const container = document.getElementById('chat') || document.body;
      container.parentNode.insertBefore(banner, container);
    }
    const name = streamer.twitchDisplayName || streamer.twitchLogin || streamer.youtubeTitle || streamer.kickDisplayName || streamer.kickSlug || '?';
    banner.textContent = `Připojuji se k streamerovi ${name}...`;
    banner.classList.remove('hidden');
  }

  _hideSwitchBanner() {
    const banner = document.getElementById('switch-banner');
    if (banner) banner.classList.add('hidden');
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

  _syncProfile(platform, username) {
    const key = `${platform}:${username.toLowerCase()}`;
    if (this._syncedProfiles.has(key)) return;
    this._syncedProfiles.add(key);
    chrome.storage.local.set({ uc_synced: [...this._syncedProfiles] }).catch(() => {});
    fetch(`${UC_API}/users/seen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, username }),
    }).catch(() => {
      this._syncedProfiles.delete(key);
      chrome.storage.local.set({ uc_synced: [...this._syncedProfiles] }).catch(() => {});
    });
  }

  _savePlatformColor(platform, color) {
    if (this._platformColors[platform] === color) return;
    this._platformColors[platform] = color;
    if (!this.config._platformColors) this.config._platformColors = {};
    this.config._platformColors[platform] = color;
    this._saveConfig();
    // Retroactively apply to all visible messages from this user
    const myName = (this._platformUsernames[platform] || this.config.username || '').toLowerCase();
    if (myName) {
      this.chatEl.querySelectorAll('.un').forEach((un) => {
        if (un.dataset.platform === platform && un.dataset.username === myName) {
          un.style.color = readableColor(color);
        }
      });
    }
  }

  _setActivePlatform(platform) {
    const changed = this.activePlatform !== platform;
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

    // Only update settings fields when platform actually changes
    // (detect loop runs every 3s — without this guard it overwrites user-typed values)
    if (!changed) return;

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
    // Update nickname field
    const nickEl = document.getElementById('input-nickname');
    if (nickEl && platform) {
      const pName = this._platformUsernames[platform] || this.config.username;
      const profile = pName ? this.nicknames.get(platform, pName) : null;
      nickEl.value = profile?.nickname || '';
    }
    // Update color + username labels
    this._refreshColorUI(platform);
    if (label) {
      const names = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick' };
      label.textContent = platform ? `Username (${names[platform] || platform})` : 'Username';
    }
  }

  // Default fallback color per platform (when no custom color is set)
  _platformDefaultColor(platform) {
    if (platform === 'youtube') return '#ff0000';
    // Twitch/Kick: use last known IRC/platform color, fallback orange
    const pName = this._platformUsernames[platform] || this.config.username;
    const ircColor = pName ? this._chatUsers.get(`${platform}:${pName.toLowerCase()}`)?.color : null;
    return ircColor || this._platformColors[platform] || '#ff8c00';
  }

  // Refresh color field, picker, placeholder, and label for the given platform
  _refreshColorUI(platform) {
    const colorHexEl = document.getElementById('input-color-hex');
    const colorPickerEl = document.getElementById('input-color-picker');
    const colorLabel = document.querySelector('label[for="input-color-hex"]');
    if (!colorHexEl) return;

    const names = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick' };
    if (colorLabel) {
      colorLabel.textContent = platform ? `Barva jména (${names[platform] || platform})` : 'Barva jména';
    }

    if (!platform) return;

    const pName = this._platformUsernames[platform] || this.config.username;
    const profile = pName ? this.nicknames.get(platform, pName) : null;
    const customColor = profile?.color || null;
    const fallback = this._platformDefaultColor(platform);

    if (customColor) {
      // Custom color set (saved via UnityChat) → real value in field + picker
      colorHexEl.value = customColor.toUpperCase();
      colorHexEl.placeholder = '';
      if (colorPickerEl) colorPickerEl.value = customColor;
    } else {
      // No custom color → empty field, placeholder shows platform default, picker shows it
      colorHexEl.value = '';
      colorHexEl.placeholder = fallback.toUpperCase();
      if (colorPickerEl) colorPickerEl.value = fallback;
    }
  }

  _applyLayout() {
    const layout = this.config.layout || 'small';
    document.body.classList.remove('layout-small', 'layout-medium', 'layout-large');
    document.body.classList.add('layout-' + layout);
  }

  _applyTimestampVisibility() {
    const show = this.config.showTimestamps !== false;
    document.body.classList.toggle('no-timestamps', !show);
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

  // ---- StreamElements bot commands (for ! autocomplete) ----

  async _loadSECommands() {
    try {
      // Get SE channel ID from channel name
      const chResp = await fetch(`https://api.streamelements.com/kappa/v2/channels/${this.config.channel}`);
      if (!chResp.ok) return;
      const chData = await chResp.json();
      const seId = chData._id;
      if (!seId) return;
      // Fetch commands
      const cmdResp = await fetch(`https://api.streamelements.com/kappa/v2/bot/commands/${seId}`);
      if (!cmdResp.ok) return;
      const cmds = await cmdResp.json();
      this._seCommands = cmds.filter(c => c.enabled).map(c => ({
        name: c.command,
        reply: c.reply || '',
      }));
      console.log(`[SE] ${this._seCommands.length} commands loaded`);
    } catch (e) {
      console.warn('[SE] Failed to load commands:', e);
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
        <span class="pin-user" style="color:${this.emotes._sc(msg.color)}">${this.emotes._eh(msg.username)}:</span>
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
        if (color) un.style.color = readableColor(color);
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

  _setReply(platform, username, messageId, message, senderId) {
    this._reply = { platform, username, messageId, message, senderId };

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

    // /uc commands — local mock messages for testing (mod/broadcaster only)
    if (text.startsWith('/uc ')) {
      this.msgInput.value = '';
      this.msgInput.style.height = 'auto';
      this._handleUcCommand(text.substring(4).trim());
      return;
    }

    // Send protection: if the active tab's channel differs from the configured
    // channel for this platform, refuse to send. Auto-switch should normally
    // fix this transparently — this is a safety net for the transient window.
    try {
      const tab = await this._getActiveBrowserTab();
      if (tab?.url) {
        const tabHandle = this._parseChannelFromUrl(tab.url, this.activePlatform);
        const configured = this._getConfiguredHandle(this.activePlatform);
        if (tabHandle && configured && tabHandle !== configured) {
          this._sys(`Nelze odeslat: jsi na kanálu ${tabHandle}, UnityChat je nastaven pro ${configured}.`);
          return;
        }
      }
    } catch {}

    const isCmd = text.startsWith('!') || text.startsWith('/');
    const markedText = isCmd ? text : text + ' ' + UC_MARKER;
    const platform = this.activePlatform;
    const reply = this._reply ? { ...this._reply } : null;

    // Save to message history (max 50)
    this._msgHistory.push(text);
    if (this._msgHistory.length > 50) this._msgHistory.shift();
    this._msgHistoryIdx = -1;
    this._msgHistoryDraft = '';

    // Clear input IMMEDIATELY — responsive feel
    this.msgInput.value = '';
    this.msgInput.style.height = 'auto';
    this._clearReply();

    // Optimistic UI: show message instantly
    // Native reply support: Twitch (GQL) + Kick (API reply metadata).
    // For cross-platform or YouTube → fallback to @mention prefix.
    const username = this._platformUsernames[platform] || this.config.username || 'me';
    const ucProfile = this.nicknames.get(platform, username);
    const hasNativeReply = reply && reply.platform === platform
      && (platform === 'twitch' || platform === 'kick');
    let displayText = text;
    if (reply && !hasNativeReply) {
      const at = reply.username.startsWith('@') ? reply.username : `@${reply.username}`;
      if (!displayText.startsWith(at)) displayText = `${at} ${displayText}`;
    }
    this._lastSentText = text;
    const userEntry = this._chatUsers.get(`${platform}:${username.toLowerCase()}`);
    this._addMessage({
      id: `sent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      platform,
      username,
      message: displayText,
      color: ucProfile?.color || userEntry?.color || this._platformColors?.[platform] || null,
      badgesRaw: userEntry?.badgesRaw || '',
      timestamp: Date.now(),
      _uc: true,
      _optimistic: true,
      ...(reply ? { replyTo: { id: reply.messageId, username: reply.username, message: reply.message || null } } : {}),
    });

    // Send in background (don't block UI)
    try {
      const tab = await this._getActiveBrowserTab();
      if (!tab) { this._sys('Žádný aktivní tab'); return; }

      let resp;
      // Native reply: Twitch (GQL threading) + Kick (API reply metadata).
      // YouTube → @mention prefix fallback.
      if (reply?.messageId && reply.platform === platform && platform === 'twitch') {
        resp = await chrome.tabs.sendMessage(tab.id, {
          type: 'REPLY_CHAT',
          text: markedText,
          parentMsgId: reply.messageId,
          username: reply.username,
          broadcasterId: this.config._roomId || null
        });
      } else if (reply?.messageId && reply.platform === platform && platform === 'kick') {
        resp = await chrome.tabs.sendMessage(tab.id, {
          type: 'SEND_CHAT',
          text: markedText,
          replyMeta: {
            messageId: reply.messageId,
            message: reply.message || ''
          }
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

  _handleUcCommand(args) {
    const parts = args.split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    const text = parts.slice(1).join(' ') || 'test message';
    const platform = this.activePlatform || 'twitch';
    const now = Date.now();
    const mockUser = 'MockUser';

    const base = {
      platform,
      username: mockUser,
      message: text,
      color: '#9146ff',
      timestamp: now,
      id: `uc-mock-${now}`,
    };

    switch (cmd) {
      case 'raid':
        this._addMessage({ ...base, username: mockUser, message: '', isRaid: true, color: '#ff6b6b', raidViewers: text.match(/^\d+$/) ? text : '88' });
        break;
      case 'raider':
        this._addMessage({ ...base, isRaider: true, color: '#00e676' });
        break;
      case 'first':
        this._addMessage({ ...base, firstMsg: true, color: '#9146ff' });
        break;
      case 'sus':
        this._addMessage({ ...base, isSus: true, color: '#ffc107' });
        break;
      case 'announcement':
      case 'ann': {
        // /uc announcement [PRIMARY|BLUE|GREEN|ORANGE|PURPLE] [body]
        const colorOpts = ['PRIMARY', 'BLUE', 'GREEN', 'ORANGE', 'PURPLE'];
        let annColor = 'PRIMARY';
        let body = text;
        const firstWord = (parts[1] || '').toUpperCase();
        if (colorOpts.includes(firstWord)) {
          annColor = firstWord;
          body = parts.slice(2).join(' ') || 'Mock announcement body';
        }
        this._addMessage({ ...base, message: body, isAnnouncement: true, announcementColor: annColor, color: '#9146ff' });
        break;
      }
      case 'sub':
        this._addMessage({ ...base, message: text === 'test message' ? '' : text, isSubEvent: true, subPlan: '1000', subMonths: 1 });
        break;
      case 'resub':
        this._addMessage({ ...base, message: text === 'test message' ? '' : text, isSubEvent: true, subPlan: '1000', subMonths: 6, subStreak: 6 });
        break;
      case 'prime':
        this._addMessage({ ...base, message: text === 'test message' ? '' : text, isSubEvent: true, subPlan: 'Prime', subMonths: 13, subStreak: 2 });
        break;
      case 'sub2':
        this._addMessage({ ...base, message: text === 'test message' ? '' : text, isSubEvent: true, subPlan: '2000', subMonths: 4, subStreak: 4 });
        break;
      case 'sub3':
        this._addMessage({ ...base, message: text === 'test message' ? '' : text, isSubEvent: true, subPlan: '3000', subMonths: 9, subStreak: 9 });
        break;
      case 'subgift':
        this._addMessage({ ...base, message: '', isSubGift: true, giftPlan: '1000', giftRecipient: text === 'test message' ? 'RecipientUser' : text });
        break;
      case 'giftbundle': {
        const n = parseInt(text, 10) || 6;
        this._addMessage({ ...base, message: '', isGiftBundle: true, giftPlan: '1000', giftCount: n });
        break;
      }
      case 'redeem': {
        const cost = parseInt(parts[parts.length - 1], 10);
        const rewardName = (Number.isFinite(cost) ? parts.slice(1, -1).join(' ') : text) || 'Send Cult follower message';
        this._addMessage({ ...base, message: 'Mock redeem message body', isRedeem: true, rewardName, rewardCost: Number.isFinite(cost) ? cost : 500, color: '#9146ff' });
        break;
      }
      case 'highlight':
        this._addMessage({ ...base, message: text, isHighlight: true });
        break;
      case 'mod':
      case 'timeout': {
        const secs = parseInt(text, 10) || 600;
        this._addMessage({ ...base, message: 'Tato zpráva byla timeoutnuta.', _cleared: `Timeout (${secs >= 60 ? Math.round(secs / 60) + 'm' : secs + 's'})` });
        break;
      }
      case 'ban':
        this._addMessage({ ...base, message: 'Tato zpráva byla banem skryta.', _cleared: 'Permanently banned' });
        break;
      case 'delete':
        this._addMessage({ ...base, message: 'Tato zpráva byla smazána.', _cleared: 'Deleted by mod' });
        break;
      default:
        this._sys(`/uc: neznámý příkaz "${cmd}". Použij: raid, raider, first, sus, announcement [color], sub, resub, prime, sub2, sub3, subgift, giftbundle [N], redeem [name] [cost], highlight, timeout [s], ban, delete`);
    }
  }

  _setupProviders() {
    this.twitch.onMessage = (m) => this._addMessage(m);
    this.twitch.onStatus = (s, d) => this._status('twitch', s, d);
    this.twitch.onClear = (e) => this._applyTwitchClear(e.user, e.banDuration);
    this.twitch.onClearMsg = (e) => this._applyTwitchClearMsg(e.id);
    this.twitch.onRoomId = (id) => {
      this.config._roomId = id;
      this._saveConfig();
      this.emotes.loadChannel('twitch', id);
      this.emotes.loadBTTV(id);
      this.emotes.loadFFZ(id);
      this.emotes.loadTwitchChannel(this.config.channel);
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
    // Only connect to platforms that have an explicit channel configured.
    // Auto-switch clears fields for platforms the streamer isn't registered on,
    // so we must NOT fall back to twitch channel as a cross-platform guess.
    if (this.config.twitch && this.config.channel) { this.twitch.connect(this.config.channel); connecting.push('Twitch'); }
    if (this.config.kick && this.config.kickChannel) { this.kick.connect(this.config.kickChannel); connecting.push('Kick'); }
    if (this.config.youtube && this.config.ytChannel) { this.youtube.connect(this.config.ytChannel); connecting.push('YouTube'); }
    if (connecting.length) this._sys(`Připojování: ${connecting.join(', ')}...`);

    // Doparsovat existující zprávy z Twitch tabu (pokud existuje)
    setTimeout(() => this._scrapeExistingChat(), 1500);
  }

  async _scrapeExistingChat() {
    // Always attempt scrape — dedup (_seenContentKeys + _seenMsgIds) drops
    // duplicates that overlap with the cache, and missing the scrape
    // entirely loses any messages that arrived during the gap between
    // last cached message and now (e.g. user reopened UC after 30s).
    const channel = (this.config.channel || '').toLowerCase();
    if (!channel) return;

    try {
      // Only scrape tabs that match the configured channel — otherwise we'd
      // import messages from an unrelated Twitch stream the user happens to have open.
      const tabs = await chrome.tabs.query({ url: ['*://*.twitch.tv/*'] });
      for (const tab of tabs) {
        // Path-based match (case-insensitive — Twitch handles are not case-sensitive).
        // Accept: /{channel}, /{channel}/..., /popout/{channel}/...
        let isChannelTab = false;
        try {
          const parts = new URL(tab.url || '').pathname.toLowerCase().split('/').filter(Boolean);
          isChannelTab = parts[0] === channel
            || (parts[0] === 'popout' && parts[1] === channel);
        } catch {}
        if (!isChannelTab) continue;

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
        // Try decreasing suffix lengths (5→2) of cached username sequence.
        // Iterate scraped from START → END so we lock onto the EARLIEST
        // occurrence of the suffix — when the same user-pair repeats later
        // in the scraped chat, picking the latest match would silently
        // drop the messages BETWEEN the two occurrences. Picking earliest
        // may add a few duplicates, but those get caught by content-key
        // dedup downstream.
        for (let len = Math.min(cachedUsers.length, 5); len >= 2 && boundary === -1; len--) {
          const suffix = cachedUsers.slice(-len);
          for (let i = 0; i + len <= scrapedUsers.length; i++) {
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
    const stEl = document.getElementById(`st-${platform}`);
    const dot = stEl?.querySelector('.dot');
    const name = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick' }[platform] || platform;
    if (dot) {
      dot.className = 'dot';
      if (status === 'connected') {
        dot.classList.add('connected');
        if (stEl) stEl.title = `${name} - Connected`;
      } else if (status === 'connecting') {
        dot.classList.add('connecting');
        if (stEl) stEl.title = `${name} - Connecting...`;
      } else if (status === 'error') {
        dot.classList.add('error');
        if (stEl) stEl.title = `${name} - Disconnected`;
      }
    }
    if (status === 'error' && detail) {
      this._sys(`${platform.toUpperCase()}: ${detail}`);
    }
    // Mirror to loading-overlay pills so the user sees connection progress.
    this._updateLoadingPill(platform, status);
  }

  // ---- Mod actions: timeout / ban / single-message delete ---------------

  _fmtBanDuration(seconds) {
    if (!seconds) return '';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
  }

  // Mark every Twitch message from `username` as cleared (greyed) with a
  // small label noting the action. Vanilla Twitch keeps the messages
  // visible; we mirror that. Also persists into _msgCache so the cleared
  // state survives reload / scroll-back.
  _applyTwitchClear(username, banDuration) {
    if (!username) return;
    const u = String(username).toLowerCase();
    const note = banDuration
      ? `Timeout (${this._fmtBanDuration(banDuration)})`
      : 'Permanently banned';
    // DOM
    const sel = `.msg[data-platform="twitch"] .un[data-username="${CSS.escape(u)}"]`;
    for (const un of this.chatEl.querySelectorAll(sel)) {
      const msgEl = un.closest('.msg');
      if (!msgEl) continue;
      this._markMessageCleared(msgEl, note);
    }
    // Cache (so reload preserves)
    let cacheDirty = false;
    for (const m of this._msgCache) {
      if (m.platform === 'twitch' && m.username && m.username.toLowerCase() === u) {
        if (m._cleared !== note) {
          m._cleared = note;
          cacheDirty = true;
        }
      }
    }
    if (cacheDirty) {
      chrome.storage.local.set({ [this._cacheKey]: this._msgCache }).catch(() => {});
    }
  }

  // Single message delete (CLEARMSG). Just one DOM node + cache entry.
  _applyTwitchClearMsg(msgId) {
    if (!msgId) return;
    const note = 'Deleted by mod';
    const msgEl = this.chatEl.querySelector(`.msg[data-msg-id="${CSS.escape(msgId)}"]`);
    if (msgEl) this._markMessageCleared(msgEl, note);
    const cached = this._msgCache.find((m) => m.id === msgId);
    if (cached && cached._cleared !== note) {
      cached._cleared = note;
      chrome.storage.local.set({ [this._cacheKey]: this._msgCache }).catch(() => {});
    }
  }

  // Apply the .cleared class + append (or update) the inline mod-action
  // note. Idempotent — repeated calls just refresh the label text.
  _markMessageCleared(msgEl, label) {
    if (!msgEl) return;
    msgEl.classList.add('cleared');
    let note = msgEl.querySelector('.cleared-note');
    if (!note) {
      note = document.createElement('span');
      note.className = 'cleared-note';
      msgEl.appendChild(note);
    }
    note.textContent = label;
  }

  // ---- Loading overlay ---------------------------------------------------

  _showLoading() {
    const el = document.getElementById('loading-overlay');
    if (!el) return;
    el.classList.remove('fade-out', 'hidden');
    // Mark every configured-active platform as "currently connecting" so its
    // pill pulses; disabled platforms stay dim.
    for (const p of ['twitch', 'youtube', 'kick']) {
      const pill = el.querySelector(`.lo-pill[data-platform="${p}"]`);
      if (!pill) continue;
      pill.classList.remove('lo-pulse', 'lo-connected');
      const enabled = this.config[p] && this._getConfiguredHandle(p);
      if (enabled) pill.classList.add('lo-pulse');
    }
    // Hard cap — if nothing renders or connects in 8s the overlay hides
    // anyway so the user isn't stuck staring at a spinner forever.
    clearTimeout(this._loadingHardT);
    this._loadingHardT = setTimeout(() => this._hideLoading(), 8000);
  }

  _hideLoading() {
    const el = document.getElementById('loading-overlay');
    if (!el) return;
    if (el.classList.contains('fade-out') || el.classList.contains('hidden')) return;
    el.classList.add('fade-out');
    clearTimeout(this._loadingHardT);
    // Drop from layout after the CSS fade so it doesn't keep absorbing
    // pointer events behind the curtain.
    setTimeout(() => el.classList.add('hidden'), 500);
  }

  _updateLoadingPill(platform, status) {
    const el = document.getElementById('loading-overlay');
    if (!el || el.classList.contains('hidden')) return;
    const pill = el.querySelector(`.lo-pill[data-platform="${platform}"]`);
    if (!pill) return;
    if (status === 'connected') {
      pill.classList.remove('lo-pulse');
      pill.classList.add('lo-connected');
    } else if (status === 'connecting') {
      pill.classList.remove('lo-connected');
      pill.classList.add('lo-pulse');
    } else if (status === 'error') {
      pill.classList.remove('lo-pulse', 'lo-connected');
    }
    // If every enabled platform is either connected or errored out, fade.
    const enabled = ['twitch', 'youtube', 'kick'].filter(
      (p) => this.config[p] && this._getConfiguredHandle(p)
    );
    if (!enabled.length) { this._hideLoading(); return; }
    const allDone = enabled.every((p) => {
      const pi = el.querySelector(`.lo-pill[data-platform="${p}"]`);
      return pi && (pi.classList.contains('lo-connected') || (!pi.classList.contains('lo-pulse')));
    });
    if (allDone) {
      // Tiny delay so the user sees the last pill light up before fade.
      setTimeout(() => this._hideLoading(), 350);
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

  // Twitch's hash fallback may not match the color Twitch actually stores for
  // each user (modern Twitch assigns once at first chat, not from username).
  // Queue a GQL lookup for any Twitch chatter we haven't resolved via GQL yet;
  // debounced batch resolver updates _chatUsers + live DOM once the real color
  // arrives, so cached + freshly-rendered messages both retint to match vanilla.
  _enqueueTwitchColorLookup(username) {
    if (!username) return;
    const u = username.toLowerCase();
    const key = `twitch:${u}`;
    const cached = this._chatUsers.get(key);
    if (cached?._fromGQL) return;
    if (!this._colorQueue) this._colorQueue = new Set();
    if (this._colorQueue.has(u)) return;
    this._colorQueue.add(u);
    if (!this._colorQueueTimer) {
      this._colorQueueTimer = setTimeout(() => this._flushColorLookups().catch(() => {}), 700);
    }
  }

  async _flushColorLookups() {
    this._colorQueueTimer = null;
    if (!this._colorQueue || !this._colorQueue.size) return;
    const batch = [...this._colorQueue].slice(0, 100);
    for (const u of batch) this._colorQueue.delete(u);

    // Phase 1: try DOM scrape on any open Twitch tab first. Rendered
    // colors already reflect whatever the vanilla chat picked (real Twitch
    // chat color including user-set hex, not a hash palette guess) and the
    // lookup is free (no network). Only usernames still missing after this
    // fall through to GQL.
    const domColors = {};
    try {
      const tabs = await chrome.tabs.query({ url: 'https://*.twitch.tv/*' });
      for (const tab of tabs) {
        if (!tab.id) continue;
        const missing = batch.filter((u) => !domColors[u]);
        if (!missing.length) break;
        let r;
        try {
          r = await chrome.tabs.sendMessage(tab.id, { type: 'GET_DOM_COLORS', usernames: missing });
        } catch { continue; }
        if (r?.ok && r.colors) Object.assign(domColors, r.colors);
      }
    } catch { /* tabs perm or no matching tab */ }

    // Apply DOM-resolved colors and drop them from the GQL batch.
    const pendingGql = [];
    for (const login of batch) {
      const col = domColors[login];
      if (!col) { pendingGql.push(login); continue; }
      const key = `twitch:${login}`;
      const prev = this._chatUsers.get(key);
      const entry = {
        name: prev?.name || login,
        platform: 'twitch',
        color: col,
        badgesRaw: prev?.badgesRaw || '',
        userId: prev?.userId || null,
        _paint: prev?._paint,
        _paintChecked: prev?._paintChecked || false,
        _fromGQL: true,
      };
      this._chatUsers.set(key, entry);
      this._chatUsers.set(login, entry);
      const sel = `.un[data-platform="twitch"][data-username="${CSS.escape(login)}"]`;
      for (const un of this.chatEl.querySelectorAll(sel)) {
        const msgId = un.closest('.msg')?.dataset.msgId;
        const cachedMsg = msgId ? this._msgCache.find((m) => m.id === msgId) : null;
        const ucProfile = cachedMsg ? this.nicknames.get('twitch', cachedMsg.username) : null;
        if (ucProfile?.color) continue;
        un.style.color = readableColor(col);
      }
      // Also retint any @mention spans for this user (may have been
      // rendered before the user ever spoke in our session).
      const msel = `.mention[data-mention-user="${CSS.escape(login)}"]`;
      for (const mn of this.chatEl.querySelectorAll(msel)) {
        mn.style.color = readableColor(col);
      }
    }
    if (!pendingGql.length) {
      if (this._colorQueue.size > 0) {
        this._colorQueueTimer = setTimeout(() => this._flushColorLookups().catch(() => {}), 1500);
      }
      if (!this._userColorTimer) {
        this._userColorTimer = setTimeout(() => {
          this._userColorTimer = null;
          chrome.storage.local.set({ uc_user_colors: Object.fromEntries(this._chatUsers) }).catch(() => {});
        }, 1500);
      }
      return;
    }

    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: 'GET_CHAT_COLORS', usernames: pendingGql });
    } catch { return; }
    if (!resp?.ok || !resp.users) return;

    let dirty = false;
    for (const login of pendingGql) {
      const info = resp.users[login] || {};
      const color = info.color;
      const userId = info.id;
      const key = `twitch:${login}`;
      const prev = this._chatUsers.get(key);
      // Even if GQL returned no color (user has none), mark as resolved so we
      // don't re-query. Keep the existing (hash) color as display fallback.
      // userId gets captured too so we can kick off 7TV paint lookups for
      // users whose messages didn't carry a user-id (cached schema, scrape).
      // Only mark _fromGQL when we actually got a non-null color from GQL.
      // If GQL had nothing (user has no custom Twitch color in their settings),
      // leave _fromGQL false so DOM lookup can keep trying — DOM is the
      // ground truth for the rendered color (incl. Twitch's readability
      // boost) and may resolve on a later flush once the user's row is
      // visible in the Twitch tab. Without this, any user whose first
      // resolution attempt missed got stuck with raw IRC color forever.
      const resolvedColor = color || prev?.color;
      const entry = {
        name: prev?.name || login,
        platform: 'twitch',
        color: resolvedColor,
        badgesRaw: prev?.badgesRaw || '',
        userId: userId || prev?.userId || null,
        _paint: prev?._paint,
        _paintChecked: prev?._paintChecked || false,
        _fromGQL: !!color,
      };
      this._chatUsers.set(key, entry);
      this._chatUsers.set(login, entry);
      dirty = true;

      // Retint already-rendered usernames (skip ones overridden by nickname)
      if (color) {
        const sel = `.un[data-platform="twitch"][data-username="${CSS.escape(login)}"]`;
        for (const un of this.chatEl.querySelectorAll(sel)) {
          const msgId = un.closest('.msg')?.dataset.msgId;
          const cachedMsg = msgId ? this._msgCache.find((m) => m.id === msgId) : null;
          const ucProfile = cachedMsg ? this.nicknames.get('twitch', cachedMsg.username) : null;
          if (ucProfile?.color) continue;
          un.style.color = readableColor(color);
        }
        // Retint @mention spans for this user too
        const msel = `.mention[data-mention-user="${CSS.escape(login)}"]`;
        for (const mn of this.chatEl.querySelectorAll(msel)) {
          mn.style.color = readableColor(color);
        }
      }

      // Kick off 7TV paint resolution — covers the gap where cached/scraped
      // messages don't have a user-id of their own. One-shot per user thanks
      // to _paintChecked guard inside _enqueue7tvPaintLookup.
      if (userId && !entry._paintChecked) {
        this._enqueue7tvPaintLookup(userId, login);
      }
    }
    if (dirty && !this._userColorTimer) {
      this._userColorTimer = setTimeout(() => {
        this._userColorTimer = null;
        chrome.storage.local.set({ uc_user_colors: Object.fromEntries(this._chatUsers) }).catch(() => {});
      }, 1500);
    }
    if (this._colorQueue.size > 0) {
      this._colorQueueTimer = setTimeout(() => this._flushColorLookups().catch(() => {}), 1500);
    }
  }

  // 7TV paint lookup — each Twitch user gets queried at most once per session
  // (per-user paint ID resolved via /users/twitch/{id}, then paint def cached
  // globally). Debounced flush with concurrency-bounded fan-out.
  _enqueue7tvPaintLookup(userId, username) {
    if (!userId || !username) return;
    const key = `twitch:${String(username).toLowerCase()}`;
    const cached = this._chatUsers.get(key);
    if (cached?._paintChecked) return;
    if (!this._paintQueue) this._paintQueue = [];
    if (!this._paintSeen) this._paintSeen = new Set();
    if (this._paintSeen.has(key)) return;
    this._paintSeen.add(key);
    this._paintQueue.push({ userId: String(userId), username: String(username).toLowerCase() });
    if (!this._paintQueueTimer) {
      this._paintQueueTimer = setTimeout(() => this._flush7tvPaints().catch(() => {}), 800);
    }
  }

  async _flush7tvPaints() {
    this._paintQueueTimer = null;
    if (!this._paintQueue?.length) return;
    // Pull a small concurrency batch; re-scheduled if more remain.
    const batch = this._paintQueue.splice(0, 20);

    await Promise.allSettled(batch.map(async ({ userId, username }) => {
      const key = `twitch:${username}`;
      const prev = this._chatUsers.get(key) || { name: username, platform: 'twitch' };
      const { paint, emoteSet } = await _7tvFetchUserData(userId);
      const entry = { ...prev, _paintChecked: true };
      if (paint) {
        entry._paint = paint;
        this._applyPaintToRenderedMessages(username, paint);
      } else {
        // Negative result still stored so we skip re-query next time.
        entry._paint = null;
      }
      // Personal emote loadout: register so the user's emotes resolve in any
      // channel, not just their own. e.g. KombatWombatt typing kombatwDefeated
      // outside his channel still renders the emote. Re-render any of their
      // already-displayed messages so the change is retroactive too.
      if (emoteSet?.emotes?.length) {
        this.emotes.learnUserEmotes('twitch', username, emoteSet);
        this._reRenderMessagesForUser('twitch', username);
      }
      this._chatUsers.set(key, entry);
      this._chatUsers.set(username, entry);
    }));

    if (!this._userColorTimer) {
      this._userColorTimer = setTimeout(() => {
        this._userColorTimer = null;
        chrome.storage.local.set({ uc_user_colors: Object.fromEntries(this._chatUsers) }).catch(() => {});
      }, 1500);
    }

    if (this._paintQueue.length > 0) {
      this._paintQueueTimer = setTimeout(() => this._flush7tvPaints().catch(() => {}), 1500);
    }
  }

  // Walk remaining text nodes inside a rendered message body and wrap any
  // @username references in <span class="mention"> with the target user's
  // color (looked up via _chatUsers). Runs post-emote/URL render so we
  // never touch existing <img>/<a> children — only pure text fragments.
  // Content script on a Twitch tab observed a redeem/highlight line in the
  // vanilla chat DOM and relayed it here. Twitch IRC does NOT carry text-less
  // redemptions (community goals, "unlock emote", etc.) — only PubSub does,
  // and that's OAuth-gated. DOM mirroring is the anonymous-safe workaround.
  // ---- Diagnostics dump (attached to debug log on 💾 click) ----
  // Aim: a single download contains enough state for someone (Claude, me)
  // to answer "why is user X colored Y / why is paint missing / why is
  // scrape skipping messages" without further round-trips with the user.
  async _buildDiagnostics() {
    const out = [];
    const push = (label, val) => out.push(`### ${label}\n${typeof val === 'string' ? val : JSON.stringify(val, null, 2)}`);

    push('UnityChat version', chrome.runtime.getManifest().version);
    push('Channel / config', {
      channel: this.config.channel,
      ytChannel: this.config.ytChannel,
      username: this.config.username,
      platforms: { tw: this.config.twitch, yt: this.config.youtube, ki: this.config.kick },
      maxMessages: this.config.maxMessages,
      layout: this.config.layout,
      _platformUsernames: this._platformUsernames,
      _isModOnChannel: this._isModOnChannel,
    });

    // Connection status
    push('Provider connection state', {
      twitch: { connected: !!this.twitch?.connected, channel: this.twitch?.channel },
      kick: { connected: !!this.kick?.connected, channel: this.kick?.channel },
      youtube: { connected: !!this.youtube?.connected, channel: this.youtube?.channel },
    });

    // Cache sizes
    push('Cache stats', {
      msgCacheSize: this._msgCache?.length || 0,
      msgCacheOldest: this._msgCache?.[0]?.timestamp,
      msgCacheNewest: this._msgCache?.[this._msgCache.length - 1]?.timestamp,
      seenMsgIds: this._seenMsgIds?.size || 0,
      seenContentKeys: this._seenContentKeys?.size || 0,
      chatUsersEntries: this._chatUsers?.size || 0,
      twitchBadgesLoaded: Object.keys(this._twitchBadges || {}).length,
      sevenTvPaintsLoaded: (typeof _7TV_PAINTS !== 'undefined') ? Object.keys(_7TV_PAINTS).length : 'n/a',
      sevenTvUserCacheSize: this.emotes?._sevenTvUserCache?.size || 0,
      emoteAdditions: this.emotes?._emoteAdditions?.size || 0,
    });

    // Per-user color/paint state for everyone currently rendered in chat
    const renderedUsers = new Map();
    this.chatEl.querySelectorAll('.un[data-platform="twitch"]').forEach((un) => {
      const u = un.dataset.username;
      if (!u || renderedUsers.has(u)) return;
      const entry = this._chatUsers.get(`twitch:${u}`) || this._chatUsers.get(u);
      const computed = un.style.color || getComputedStyle(un).color;
      const hasPaintBg = !!un.style.backgroundImage;
      renderedUsers.set(u, {
        renderedColor: computed,
        hasPaintBackground: hasPaintBg,
        entryColor: entry?.color,
        entryUserId: entry?.userId,
        entryFromGQL: !!entry?._fromGQL,
        entryPaintChecked: !!entry?._paintChecked,
        entryPaintNonNull: !!entry?._paint,
        entryPaintFunction: entry?._paint?.function,
      });
    });
    push('Twitch users currently rendered (color + paint state)', Object.fromEntries(renderedUsers));

    // Persistent storage snapshots
    try {
      const local = await chrome.storage.local.get(['uc_user_colors', 'uc_synced', 'uc_update', 'uc_msg_history']);
      const ucColors = local.uc_user_colors || {};
      // Slim down: just keys + paint flags, full color is huge
      const slim = {};
      for (const [k, v] of Object.entries(ucColors)) {
        if (!v || typeof v !== 'object') continue;
        slim[k] = {
          color: v.color,
          userId: v.userId,
          fromGQL: !!v._fromGQL,
          paintChecked: !!v._paintChecked,
          paint: v._paint ? { function: v._paint.function, id: v._paint.id } : null,
        };
      }
      push('chrome.storage.local.uc_user_colors (slim)', slim);
      push('chrome.storage.local.uc_synced size', (local.uc_synced || []).length || 0);
      push('chrome.storage.local.uc_update', local.uc_update || null);
    } catch (e) {
      push('storage.local read error', e.message);
    }

    // For each rendered Twitch user, ask the active Twitch tab what the
    // vanilla DOM thinks their color is. This is the gold-standard for
    // "what should our chat show".
    try {
      const tabs = await chrome.tabs.query({ url: 'https://*.twitch.tv/*' });
      const usernames = [...renderedUsers.keys()];
      const tabReports = [];
      for (const tab of tabs) {
        if (!tab.id) continue;
        let r = null;
        try {
          r = await chrome.tabs.sendMessage(tab.id, { type: 'GET_DOM_COLORS', usernames });
        } catch (e) { r = { error: e.message }; }
        tabReports.push({ url: tab.url, ok: !!r?.ok, colors: r?.colors || null, error: r?.error });
      }
      push('Twitch DOM color snapshot per open tab', tabReports);
    } catch (e) {
      push('tabs query error', e.message);
    }

    // Sweep all loaded emote maps for ≤3-char names — these are the most
    // likely culprits for "why did this short word get rendered as an
    // emote". Lists name + URL per source.
    try {
      const sources = [
        ['channel7tv',   this.emotes?.channel7tv],
        ['global7tv',    this.emotes?.global7tv],
        ['bttvEmotes',   this.emotes?.bttvEmotes],
        ['ffzEmotes',    this.emotes?.ffzEmotes],
        ['ucEmotes',     this.emotes?.ucEmotes],
        ['twitchNative', this.emotes?.twitchNative],
        ['kickNative',   this.emotes?.kickNative],
      ];
      const shortByName = {};
      for (const [src, map] of sources) {
        if (!map?.forEach) continue;
        map.forEach((url, name) => {
          if (typeof name !== 'string' || name.length > 3 || !name.length) return;
          if (!shortByName[name]) shortByName[name] = {};
          shortByName[name][src] = url;
        });
      }
      push('Short-name (≤3 chars) emote entries across all maps', shortByName);
    } catch (e) {
      push('short-emote sweep error', e.message);
    }

    // Recent messages snapshot — last 30 msgs with key flags
    const recent = (this._msgCache || []).slice(-30).map((m) => ({
      ts: m.timestamp,
      platform: m.platform,
      username: m.username,
      color: m.color,
      hasReplyTo: !!m.replyTo,
      hasTwitchEmotes: !!m.twitchEmotes,
      twitchEmotesOffset: m.twitchEmotesOffset,
      isRedeem: !!m.isRedeem,
      isAnnouncement: !!m.isAnnouncement,
      isSubEvent: !!m.isSubEvent,
      isGiftBundle: !!m.isGiftBundle,
      isSubGift: !!m.isSubGift,
      msgPreview: (m.message || '').slice(0, 80),
    }));
    push('Last 30 cached messages (slim)', recent);

    return out.join('\n\n');
  }

  // Mirror the Twitch credits widget (bits + channel-points) from an open
  // Twitch tab. Anonymous IRC has no way to get either balance — the only
  // anonymous-safe path is to scrape the rendered DOM.
  // Twitch picks default colors from a hash palette for users without a
  // custom hex set. That hash is per-session, so when the streamer (or
  // viewer) refreshes the Twitch page, those defaults can flip. Our
  // cached _fromGQL state would otherwise stick the old color forever.
  // Periodically re-snapshot DOM colors for currently-rendered Twitch
  // users and overwrite cache + retint when changed. DOM lookup is free.
  _scheduleColorRevalidation() {
    if (this._colorRevalT) return;
    const tick = async () => {
      this._colorRevalT = null;
      try {
        const seen = new Set();
        const usernames = [];
        this.chatEl.querySelectorAll('.un[data-platform="twitch"]').forEach((un) => {
          const u = un.dataset.username;
          if (!u || seen.has(u)) return;
          seen.add(u);
          usernames.push(u);
        });
        if (!usernames.length) return;
        const tabs = await chrome.tabs.query({ url: 'https://*.twitch.tv/*' });
        for (const tab of tabs) {
          if (!tab.id) continue;
          let r;
          try { r = await chrome.tabs.sendMessage(tab.id, { type: 'GET_DOM_COLORS', usernames }); }
          catch { continue; }
          if (!r?.ok || !r.colors) continue;
          for (const [login, col] of Object.entries(r.colors)) {
            if (!col) continue;
            const key = `twitch:${login}`;
            const prev = this._chatUsers.get(key);
            if (prev?.color === col) continue;
            const entry = {
              ...(prev || {}),
              name: prev?.name || login,
              platform: 'twitch',
              color: col,
              _fromGQL: true,
            };
            this._chatUsers.set(key, entry);
            this._chatUsers.set(login, entry);
            const sel = `.un[data-platform="twitch"][data-username="${CSS.escape(login)}"]`;
            for (const un of this.chatEl.querySelectorAll(sel)) {
              const msgId = un.closest('.msg')?.dataset.msgId;
              const cachedMsg = msgId ? this._msgCache.find((m) => m.id === msgId) : null;
              const ucProfile = cachedMsg ? this.nicknames.get('twitch', cachedMsg.username) : null;
              if (ucProfile?.color) continue;
              un.style.color = readableColor(col);
            }
            const msel = `.mention[data-mention-user="${CSS.escape(login)}"]`;
            for (const mn of this.chatEl.querySelectorAll(msel)) {
              mn.style.color = readableColor(col);
            }
          }
        }
      } catch {}
      // Re-arm — every 5 min while the panel is alive
      this._colorRevalT = setTimeout(tick, 5 * 60 * 1000);
    };
    // First tick after 90s (give initial lookups time to settle), then 5min
    this._colorRevalT = setTimeout(tick, 90 * 1000);
  }

  // Float a "+N" pill above the points balance so the +10 watch-reward
  // tick (and bonus claims) get visible feedback. Caller supplies the
  // already-computed delta; we just animate.
  // Ask all open Twitch tabs to push their current credits snapshot
  // immediately — the in-tab MutationObserver may have already settled
  // before our sidepanel opened, leaving us with no pill until the next
  // organic DOM mutation (typically the +10 watch-reward tick ~5 min
  // later). Retries a few times during page hydration.
  async _pullCredits() {
    const ask = async () => {
      try {
        const tabs = await chrome.tabs.query({ url: 'https://*.twitch.tv/*' });
        for (const tab of tabs) {
          if (!tab.id) continue;
          chrome.tabs.sendMessage(tab.id, { type: 'GET_CREDITS' }).catch(() => {});
        }
      } catch {}
    };
    // Initial ask, then a couple of retries during Twitch's hydration
    // window in case the summary subtree wasn't mounted yet.
    ask();
    [1500, 4000, 9000].forEach((ms) => setTimeout(ask, ms));
  }

  _flashPointsDelta(delta) {
    const wrap = document.getElementById('tw-credits');
    if (!wrap) return;
    const anchor = wrap.querySelector('.tc-points');
    if (!anchor) return;
    const f = document.createElement('span');
    f.className = 'tc-points-flash';
    f.textContent = `+${delta.toLocaleString('cs-CZ')}`;
    anchor.appendChild(f);
    // Remove after the CSS animation finishes (1.5s).
    setTimeout(() => f.remove(), 1600);
  }

  _handleCredits(data) {
    if (data.channel && data.channel.toLowerCase() !== (this.config.channel || '').toLowerCase()) return;
    const wrap = document.getElementById('tw-credits');
    if (!wrap) return;
    const bitsPill = wrap.querySelector('.tc-bits');
    const pointsPill = wrap.querySelector('.tc-points');
    const claimPill = wrap.querySelector('.tc-claim');
    // One-time wire: clicking a pill focuses the Twitch tab and clicks the
    // matching summary button there so Twitch's own popover (bits/rewards
    // center) opens. We don't try to mirror the popover content into UC
    // — its DOM is huge and dynamic; opening the real one is the simpler
    // contract.
    if (!wrap.dataset.wired) {
      wrap.dataset.wired = '1';
      const openOnTwitch = async (which) => {
        try {
          const tabs = await chrome.tabs.query({ url: 'https://*.twitch.tv/*' });
          const ch = (this.config.channel || '').toLowerCase();
          const target = tabs.find((t) => {
            try {
              const parts = new URL(t.url).pathname.toLowerCase().split('/').filter(Boolean);
              return parts[0] === ch || (parts[0] === 'popout' && parts[1] === ch);
            } catch { return false; }
          }) || tabs[0];
          if (!target?.id) return;
          await chrome.tabs.update(target.id, { active: true });
          await chrome.windows.update(target.windowId, { focused: true });
          await chrome.scripting.executeScript({
            target: { tabId: target.id },
            world: 'MAIN',
            func: () => {
              const btn = document.querySelector('[data-test-selector="community-points-summary"] button')
                || document.querySelector('.community-points-summary button')
                || document.querySelector('[aria-label*="bit" i][aria-label*="bod" i]');
              if (btn) btn.click();
            },
          });
        } catch {}
      };
      bitsPill.style.cursor = 'pointer';
      pointsPill.style.cursor = 'pointer';
      bitsPill.addEventListener('click', () => openOnTwitch('bits'));
      pointsPill.addEventListener('click', () => openOnTwitch('points'));
      // Claim bonus: dispatch TW_CLAIM_BONUS to the matching Twitch tab.
      // Content script finds the .claimable-bonus__icon button, real-event
      // clicks it. We DON'T focus the tab — claiming should be silent.
      claimPill.style.cursor = 'pointer';
      claimPill.addEventListener('click', async () => {
        try {
          const tabs = await chrome.tabs.query({ url: 'https://*.twitch.tv/*' });
          const ch = (this.config.channel || '').toLowerCase();
          const target = tabs.find((t) => {
            try {
              const parts = new URL(t.url).pathname.toLowerCase().split('/').filter(Boolean);
              return parts[0] === ch || (parts[0] === 'popout' && parts[1] === ch);
            } catch { return false; }
          }) || tabs[0];
          if (!target?.id) return;
          await chrome.tabs.sendMessage(target.id, { type: 'TW_CLAIM_BONUS' }).catch(() => {});
          // Optimistic hide — observer will re-show if claim didn't fire
          claimPill.classList.add('hidden');
        } catch {}
      });
    }
    const bitsVal = wrap.querySelector('.tc-bits-val');
    const pointsVal = wrap.querySelector('.tc-points-val');
    const pointsIcon = wrap.querySelector('.tc-points-icon');

    let anyShown = false;
    if (data.bits != null && data.bits !== '') {
      bitsVal.textContent = data.bits;
      bitsPill.classList.remove('hidden');
      anyShown = true;
    } else {
      bitsPill.classList.add('hidden');
    }
    if (data.points != null && data.points !== '') {
      // Parse numeric value to detect increases (+10 watch reward, +N from
      // claim) — Twitch formats with comma decimal + Czech "tis."/EN "K"
      // suffix for thousands. We strip non-breaking spaces too.
      const parseTwitchNum = (s) => {
        if (typeof s !== 'string') return null;
        let raw = s.replace(/[\u00A0\s]/g, '').replace(',', '.').toLowerCase();
        let mult = 1;
        if (/(?:tis|k)\.?$/.test(raw)) { mult = 1000; raw = raw.replace(/(?:tis|k)\.?$/, ''); }
        else if (/(?:mil|m)\.?$/.test(raw)) { mult = 1_000_000; raw = raw.replace(/(?:mil|m)\.?$/, ''); }
        const n = parseFloat(raw);
        return Number.isFinite(n) ? Math.round(n * mult) : null;
      };
      const prevText = pointsVal.textContent;
      const prevNum = this._lastPointsNum;
      const newNum = parseTwitchNum(data.points);
      pointsVal.textContent = data.points;
      if (data.pointsIcon) {
        pointsIcon.style.backgroundImage = `url(${this.emotes._ea(data.pointsIcon)})`;
        pointsIcon.classList.add('has-icon');
      }
      pointsPill.classList.remove('hidden');
      anyShown = true;
      if (prevNum != null && newNum != null && newNum > prevNum && data.points !== prevText) {
        this._flashPointsDelta(newNum - prevNum);
      }
      if (newNum != null) this._lastPointsNum = newNum;
    } else {
      pointsPill.classList.add('hidden');
    }
    if (data.claimAvailable) {
      claimPill.classList.remove('hidden');
      anyShown = true;
    } else {
      claimPill.classList.add('hidden');
    }
    wrap.classList.toggle('hidden', !anyShown);
  }

  _handleHighlights(msg) {
    // Channel-scoped: ignore highlights from other open Twitch tabs.
    if (msg.channel && msg.channel.toLowerCase() !== (this.config.channel || '').toLowerCase()) return;
    const banner = document.getElementById('highlights-banner');
    if (!banner) return;
    const cards = (msg.cards || []).filter((c) => c && c.text);
    if (!cards.length) {
      banner.classList.add('hidden');
      banner.innerHTML = '';
      return;
    }
    banner.classList.remove('hidden');
    banner.innerHTML = '';
    for (const c of cards) {
      const item = document.createElement('div');
      item.className = 'hl-card hl-' + (c.kind || 'generic');
      const icon = document.createElement('span');
      icon.className = 'hl-icon';
      icon.textContent = c.kind === 'hype-train' ? '\u{1F682}'
        : c.kind === 'gift-leaderboard' ? '\u{1F381}'
        : '\u2728';
      const body = document.createElement('span');
      body.className = 'hl-body';
      body.textContent = c.text;
      item.appendChild(icon);
      item.appendChild(body);
      banner.appendChild(item);
    }
  }

  _handleDomRedeem(data) {
    if (!data?.username) return;
    // Only mirror redeems for the currently-connected Twitch channel.
    const channelMatch = !data.channel
      || data.channel.toLowerCase() === (this.config.channel || '').toLowerCase();
    if (!channelMatch) return;
    const key = `dom-redeem:${data.username.toLowerCase()}|${data.rewardName || ''}|${Math.floor((data.timestamp || Date.now()) / 5000)}`;
    if (!this._domRedeemSeen) this._domRedeemSeen = new Set();
    if (this._domRedeemSeen.has(key)) return;
    this._domRedeemSeen.add(key);
    if (this._domRedeemSeen.size > 500) {
      // Simple cap to avoid unbounded growth on long sessions.
      const first = this._domRedeemSeen.values().next().value;
      this._domRedeemSeen.delete(first);
    }

    // Merge path: if IRC already rendered a redeem (with the "Channel Points
    // Reward" placeholder because IRC doesn't expose reward names) for the
    // same user in the last ~10s, upgrade its name + cost in place instead
    // of emitting a duplicate message.
    const uname = data.username.toLowerCase();
    const now = data.timestamp || Date.now();
    const recent = this.chatEl.querySelectorAll('.msg.redeem[data-platform="twitch"]');
    for (let i = recent.length - 1; i >= 0; i--) {
      const el = recent[i];
      const un = el.querySelector('.un');
      if (!un || un.dataset.username !== uname) continue;
      const mid = el.dataset.msgId;
      const cached = mid ? this._msgCache.find((m) => m.id === mid) : null;
      const ts = cached?.timestamp || 0;
      if (Math.abs(now - ts) > 10000) continue;
      // Upgrade reward name and append cost pill
      const nameEl = el.querySelector('.redeem-body strong');
      if (nameEl && data.rewardName) nameEl.textContent = data.rewardName;
      if (data.rewardCost != null && !el.querySelector('.redeem-cost')) {
        const cost = document.createElement('span');
        cost.className = 'redeem-cost';
        cost.textContent = `\u25CE ${data.rewardCost}`;
        el.appendChild(cost);
      }
      if (cached) {
        if (data.rewardName) cached.rewardName = data.rewardName;
        if (data.rewardCost != null) cached.rewardCost = data.rewardCost;
        chrome.storage.local.set({ [this._cacheKey]: this._msgCache }).catch(() => {});
      }
      return;
    }

    this._addMessage({
      platform: 'twitch',
      username: data.username,
      message: data.message || '',
      color: twitchDefaultColor(data.username),
      _needsColorLookup: true,
      timestamp: data.timestamp || Date.now(),
      id: `dom-redeem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      isRedeem: true,
      rewardName: data.rewardName || 'Channel Points Reward',
      rewardCost: data.rewardCost || null,
      _fromDom: true,
    });
  }

  _renderGiftEvent(el, msg) {
    // Gift icon (SVG, currentColor — tinted by CSS)
    const icon = document.createElement('span');
    icon.className = 'gift-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<polyline points="20 12 20 22 4 22 4 12"/>' +
      '<rect x="2" y="7" width="20" height="5"/>' +
      '<line x1="12" y1="22" x2="12" y2="7"/>' +
      '<path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/>' +
      '<path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>' +
      '</svg>';
    el.appendChild(icon);

    const body = document.createElement('div');
    body.className = 'gift-body';

    const un = document.createElement('span');
    un.className = 'un';
    un.textContent = msg.username;
    un.dataset.platform = msg.platform;
    un.dataset.username = msg.username.toLowerCase();
    un.addEventListener('click', () => this._openUserCard(msg.platform, msg.username));
    const chatUserEntry = this._chatUsers.get(`${msg.platform}:${msg.username?.toLowerCase()}`);
    const ucProfile = this.nicknames.get(msg.platform, msg.username);
    un.style.color = readableColor(ucProfile?.color || chatUserEntry?.color || msg.color);
    body.appendChild(un);

    const tier = { '1000': '1', '2000': '2', '3000': '3' }[msg.giftPlan] || '1';

    if (msg.isGiftBundle) {
      // "username – darovaná předplatná"  + count pill on right
      body.appendChild(document.createTextNode(' \u2013 darovaná předplatná'));
      const count = document.createElement('span');
      count.className = 'gift-count';
      count.textContent = `\u00D7${msg.giftCount || 1}`;
      el.appendChild(body);
      el.appendChild(count);
      return;
    }

    // isSubGift: "Gifted a Tier N Sub to Recipient"
    const line = document.createElement('div');
    line.className = 'gift-line';
    line.appendChild(document.createTextNode('Gifted a '));
    const tierSpan = document.createElement('strong');
    tierSpan.textContent = `Tier ${tier}`;
    line.appendChild(tierSpan);
    line.appendChild(document.createTextNode(' Sub to '));
    const recipSpan = document.createElement('strong');
    recipSpan.textContent = msg.giftRecipient || '?';
    line.appendChild(recipSpan);
    body.appendChild(line);
    el.appendChild(body);
  }

  _renderSubEvent(el, msg) {
    const isPrime = String(msg.subPlan || '').toLowerCase() === 'prime';
    if (isPrime) el.classList.add('prime');
    else if (msg.subPlan === '2000') el.classList.add('tier-2');
    else if (msg.subPlan === '3000') el.classList.add('tier-3');
    const icon = document.createElement('span');
    icon.className = 'sub-icon';
    icon.setAttribute('aria-hidden', 'true');
    // Prime gets a crown SVG (Twitch's Prime branding) instead of the
    // generic star, so it visually stands apart from Tier 1/2/3 subs.
    icon.innerHTML = isPrime
      ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">'
        + '<path d="M2 7l4 4 6-7 6 7 4-4-2 12H4L2 7zm3 14h14v2H5v-2z"/>'
        + '</svg>'
      : '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">'
        + '<path d="M12 2l2.9 6.9L22 10l-5.5 4.8L18 22l-6-3.5L6 22l1.5-7.2L2 10l7.1-1.1z"/>'
        + '</svg>';
    el.appendChild(icon);

    const body = document.createElement('div');
    body.className = 'sub-body';

    const un = document.createElement('span');
    un.className = 'un';
    un.textContent = msg.username;
    un.dataset.platform = msg.platform;
    un.dataset.username = msg.username.toLowerCase();
    un.addEventListener('click', () => this._openUserCard(msg.platform, msg.username));
    const chatUserEntry = this._chatUsers.get(`${msg.platform}:${msg.username?.toLowerCase()}`);
    const ucProfile = this.nicknames.get(msg.platform, msg.username);
    un.style.color = readableColor(ucProfile?.color || chatUserEntry?.color || msg.color);
    body.appendChild(un);

    const tier = { '1000': '1', '2000': '2', '3000': '3' }[msg.subPlan] || '1';
    const tierLabel = isPrime ? 'Prime' : `Tier ${tier}`;
    const line = document.createElement('div');
    line.className = 'sub-line';
    const prefix = document.createElement('strong');
    prefix.textContent = 'Subscribed';
    line.appendChild(prefix);
    line.appendChild(document.createTextNode(` with `));
    const tierSpan = document.createElement('strong');
    tierSpan.className = isPrime ? 'sub-tier-prime' : 'sub-tier';
    tierSpan.textContent = tierLabel;
    line.appendChild(tierSpan);
    line.appendChild(document.createTextNode('.'));
    if (msg.subMonths && msg.subMonths > 1) {
      line.appendChild(document.createTextNode(` They've subscribed for `));
      const m = document.createElement('strong');
      m.textContent = `${msg.subMonths} month${msg.subMonths === 1 ? '' : 's'}`;
      line.appendChild(m);
      if (msg.subStreak && msg.subStreak > 1) {
        line.appendChild(document.createTextNode(`, `));
        const s = document.createElement('strong');
        s.textContent = `${msg.subStreak} month${msg.subStreak === 1 ? '' : 's'} in a row`;
        line.appendChild(s);
      }
      line.appendChild(document.createTextNode('.'));
    }
    body.appendChild(line);

    // Optional attached message body
    if (msg.message) {
      const tx = document.createElement('div');
      tx.className = 'sub-text tx';
      tx.innerHTML = this.emotes.renderTwitch(msg.message, msg.twitchEmotes, { platform: 'twitch', author: msg.username });
      this._processMentions(tx, 'twitch');
      body.appendChild(tx);
    }
    el.appendChild(body);
  }

  _renderRedeemEvent(el, msg) {
    const icon = document.createElement('span');
    icon.className = 'redeem-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">' +
      '<path d="M12 2l3 7 7 .5-5.5 4.5L18 21l-6-4-6 4 1.5-7L2 9.5 9 9z"/>' +
      '</svg>';
    el.appendChild(icon);

    const body = document.createElement('div');
    body.className = 'redeem-body';

    const un = document.createElement('span');
    un.className = 'un';
    un.textContent = msg.username;
    un.dataset.platform = msg.platform;
    un.dataset.username = msg.username.toLowerCase();
    un.addEventListener('click', () => this._openUserCard(msg.platform, msg.username));
    const chatUserEntry = this._chatUsers.get(`${msg.platform}:${msg.username?.toLowerCase()}`);
    const ucProfile = this.nicknames.get(msg.platform, msg.username);
    un.style.color = readableColor(ucProfile?.color || chatUserEntry?.color || msg.color);
    body.appendChild(un);
    body.appendChild(document.createTextNode(' redeemed '));
    const rewardSpan = document.createElement('strong');
    rewardSpan.textContent = msg.rewardName || 'Channel Points Reward';
    body.appendChild(rewardSpan);
    el.appendChild(body);

    if (msg.rewardCost != null) {
      const cost = document.createElement('span');
      cost.className = 'redeem-cost';
      cost.textContent = `\u25CE ${msg.rewardCost}`;
      el.appendChild(cost);
    }

    if (msg.message) {
      const tx = document.createElement('div');
      tx.className = 'redeem-text tx';
      tx.innerHTML = this.emotes.renderTwitch(msg.message, msg.twitchEmotes, { platform: 'twitch', author: msg.username });
      this._processMentions(tx, 'twitch');
      el.appendChild(tx);
    }
  }

  _processMentions(el, platform) {
    if (!el) return;
    // Pattern: start-of-string OR a non-identifier character, then @name.
    // Username rules mirror Twitch/Kick/YT: 2–25 chars of [A-Za-z0-9_].
    const mentionRe = /(^|[^A-Za-z0-9_])@([A-Za-z0-9_]{2,25})/g;

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);

    for (const textNode of nodes) {
      const text = textNode.nodeValue;
      if (!text || text.indexOf('@') === -1) continue;

      mentionRe.lastIndex = 0;
      let match;
      let last = 0;
      let frag = null;

      while ((match = mentionRe.exec(text)) !== null) {
        const prefixLen = match[1].length;
        const start = match.index + prefixLen;
        const name = match[2];
        if (!frag) frag = document.createDocumentFragment();
        if (start > last) frag.appendChild(document.createTextNode(text.substring(last, start)));

        const span = document.createElement('span');
        span.className = 'mention';
        const lname = name.toLowerCase();
        span.dataset.mentionUser = lname;
        const entry = this._chatUsers.get(`${platform}:${lname}`)
          || this._chatUsers.get(lname);
        const color = entry?.color;
        if (color) {
          const sanitized = this.emotes._sc(color);
          if (sanitized) span.style.color = readableColor(sanitized);
        } else if (platform === 'twitch') {
          // Unknown user — they've been @mentioned but haven't spoken in
          // our session yet. Queue a Twitch color lookup so the mention
          // retroactively gets their real chat color once resolved.
          this._enqueueTwitchColorLookup(lname);
        }
        span.textContent = '@' + name;
        frag.appendChild(span);
        last = start + name.length + 1;
      }

      if (!frag) continue;
      if (last < text.length) frag.appendChild(document.createTextNode(text.substring(last)));
      textNode.parentNode.replaceChild(frag, textNode);
    }

    // Pass 2: bare-name mentions (no @ prefix). Scan remaining text nodes
    // and wrap any whole word that matches an existing chatter in
    // _chatUsers — restricted so we don't accidentally color generic
    // words. Plain key check is enough because _chatUsers only contains
    // entries for users we've actually seen (chat history + scrape +
    // queued mentions), so common Czech/English words don't collide.
    const bareRe = /[A-Za-z0-9_]{3,25}/g;
    const walker2 = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes2 = [];
    let n2;
    while ((n2 = walker2.nextNode())) {
      // Skip text nodes already inside a .mention (don't re-wrap @mentions)
      if (n2.parentNode?.classList?.contains('mention')) continue;
      nodes2.push(n2);
    }
    for (const textNode of nodes2) {
      const text = textNode.nodeValue;
      if (!text) continue;
      bareRe.lastIndex = 0;
      let match;
      let last = 0;
      let frag = null;
      while ((match = bareRe.exec(text)) !== null) {
        const word = match[0];
        const lname = word.toLowerCase();
        const entry = this._chatUsers.get(`${platform}:${lname}`)
          || this._chatUsers.get(lname);
        // Require a chatter entry — and skip the message author itself
        // (their own username appears literally inside the message body
        // on /me lines, no need to "mention" themselves).
        if (!entry || !entry.color) continue;
        if (!frag) frag = document.createDocumentFragment();
        if (match.index > last) frag.appendChild(document.createTextNode(text.substring(last, match.index)));
        const span = document.createElement('span');
        span.className = 'mention bare';
        span.dataset.mentionUser = lname;
        const sanitized = this.emotes._sc(entry.color);
        if (sanitized) span.style.color = readableColor(sanitized);
        span.textContent = word;
        frag.appendChild(span);
        last = match.index + word.length;
      }
      if (!frag) continue;
      if (last < text.length) frag.appendChild(document.createTextNode(text.substring(last)));
      textNode.parentNode.replaceChild(frag, textNode);
    }
  }

  // ---- Emote preview card (hover quick / click pinned + details) -------

  _setupEmotePreview() {
    if (this._emotePreviewWired) return;
    this._emotePreviewWired = true;

    // Delegated hover-intent over emote <img> inside chat message bodies.
    this.chatEl.addEventListener('mouseover', (e) => {
      const img = e.target?.closest?.('.tx .emote');
      if (!img) return;
      clearTimeout(this._emoteHoverT);
      this._emoteHoverT = setTimeout(() => this._showEmotePreview(img, false), 220);
    });
    this.chatEl.addEventListener('mouseout', (e) => {
      const img = e.target?.closest?.('.tx .emote');
      if (!img) return;
      clearTimeout(this._emoteHoverT);
      // Pinned (clicked) preview survives mouseout — only dismissed on
      // click outside or another emote click.
      if (!this._emotePreviewPinned) this._hideEmotePreview();
    });
    // Click an emote → pin the preview + lazy-fetch full metadata
    this.chatEl.addEventListener('click', (e) => {
      const img = e.target?.closest?.('.tx .emote');
      if (!img) return;
      e.stopPropagation();
      clearTimeout(this._emoteHoverT);
      this._showEmotePreview(img, true);
    });
    // Click outside dismisses the pinned preview
    document.addEventListener('mousedown', (e) => {
      if (!this._emotePreviewPinned) return;
      const card = document.getElementById('emote-preview');
      if (!card || card.classList.contains('hidden')) return;
      if (card === e.target || card.contains(e.target)) return;
      if (e.target?.closest?.('.tx .emote')) return; // click on another emote handled above
      this._hideEmotePreview();
    });
  }

  _hideEmotePreview() {
    this._emotePreviewPinned = false;
    const card = document.getElementById('emote-preview');
    if (card) card.classList.add('hidden');
  }

  async _showEmotePreview(img, pinned) {
    const url = img.src;
    const name = img.alt || img.title || '';
    const meta = this.emotes._emoteSourceFromUrl(url);
    let card = document.getElementById('emote-preview');
    if (!card) {
      card = document.createElement('div');
      card.id = 'emote-preview';
      card.className = 'emote-preview';
      document.body.appendChild(card);
    }
    card.classList.remove('hidden');
    this._emotePreviewPinned = !!pinned;
    card.classList.toggle('pinned', !!pinned);

    const sourceLabel = meta?.source || 'Emote';
    const sourceClass = sourceLabel.toLowerCase().replace(/[^a-z]/g, '');
    const hires = meta?.hires || url;
    const ehName = this.emotes._eh(name);
    const eaHires = this.emotes._ea(hires);

    card.innerHTML = `
      <div class="ep-img-wrap">
        <img class="ep-img" src="${eaHires}" alt="">
      </div>
      <div class="ep-name">
        <span class="ep-name-text">${ehName}</span>
        <span class="ep-source ep-src-${sourceClass}">${sourceLabel}</span>
      </div>
      <div class="ep-detail">${pinned
        ? '<span class="ep-loading">Načítám detaily…</span>'
        : '<span class="ep-hint">Klikni pro detaily</span>'}</div>
    `;

    // Position above the emote (keeps card inside the side panel even
    // when emote is at the very bottom). Falls back below if no room above.
    this._positionEmotePreview(card, img);

    // Pinned mode: lazy-fetch source details and re-render the .ep-detail
    // block with owner + date + external link.
    if (pinned && meta?.id) {
      try {
        const d = await this.emotes.fetchEmoteDetails(meta.source, meta.id, name);
        // Card may have been dismissed while we awaited
        if (!this._emotePreviewPinned || card.classList.contains('hidden')) return;
        const detail = card.querySelector('.ep-detail');
        if (!d || !detail) {
          if (detail) detail.innerHTML = '<span class="ep-hint">Žádné další detaily</span>';
          return;
        }
        const ehAvatar = (url) =>
          url
            ? `<img class="ep-avatar" src="${this.emotes._ea(url)}" alt="">`
            : '<span class="ep-avatar ep-avatar-blank"></span>';
        const rows = [];
        if (d.owner) {
          rows.push(`<div class="ep-row"><span class="ep-label">Made by</span>${ehAvatar(d.ownerAvatar)}<span class="ep-owner">${this.emotes._eh(d.owner)}</span></div>`);
        }
        if (d.addedBy) {
          rows.push(`<div class="ep-row"><span class="ep-label">Added by</span>${ehAvatar(d.addedByAvatar)}<span class="ep-owner">${this.emotes._eh(d.addedBy)}</span></div>`);
        }
        if (d.addedAt instanceof Date && !isNaN(d.addedAt)) {
          const fmt = d.addedAt.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' });
          rows.push(`<div class="ep-row"><span class="ep-label">Added on</span><span>${fmt}</span></div>`);
        }
        if (d.externalUrl) {
          rows.push(`<a class="ep-extlink" href="${this.emotes._ea(d.externalUrl)}" target="_blank" rel="noopener">Otevřít na ${sourceLabel} ↗</a>`);
        }
        detail.innerHTML = rows.length ? rows.join('') : '<span class="ep-hint">Žádné další detaily</span>';
        // Layout may have grown — reposition.
        this._positionEmotePreview(card, img);
      } catch {}
    }

    // Also include the source link in the name row when known
    if (!pinned) {
      // Name row already rendered, leave compact in hover mode
    }
  }

  _positionEmotePreview(card, anchor) {
    if (!card || !anchor) return;
    // Reset to measure unbiased
    card.style.position = 'fixed';
    card.style.left = '0px';
    card.style.top = '0px';
    requestAnimationFrame(() => {
      const r = anchor.getBoundingClientRect();
      const cw = card.offsetWidth;
      const ch = card.offsetHeight;
      const margin = 6;
      // Prefer ABOVE (per request — sidebar avoids bottom-clipping)
      let y = r.top - ch - margin;
      if (y < 4) y = r.bottom + margin; // fallback below
      let x = r.left + r.width / 2 - cw / 2;
      x = Math.max(4, Math.min(x, window.innerWidth - cw - 4));
      card.style.left = `${Math.round(x)}px`;
      card.style.top = `${Math.round(y)}px`;
    });
  }

  // Re-render text bodies of all already-displayed messages from a given
  // (platform, username) pair. Triggered when we learn the user's personal
  // 7TV emote set after their messages have already been rendered, so the
  // freshly-known emotes light up retroactively instead of only on future
  // messages.
  _reRenderMessagesForUser(platform, username) {
    const u = String(username).toLowerCase();
    const sel = `.un[data-platform="${CSS.escape(platform)}"][data-username="${CSS.escape(u)}"]`;
    for (const un of this.chatEl.querySelectorAll(sel)) {
      const msgEl = un.closest('.msg');
      if (!msgEl) continue;
      const tx = msgEl.querySelector('.tx');
      if (!tx) continue;
      const msgId = msgEl.dataset.msgId;
      const cached = msgId ? this._msgCache.find((m) => m.id === msgId) : null;
      if (!cached) continue;
      const ctx = { platform, author: cached.username || username };
      if (platform === 'twitch') {
        ctx.emotesOffset = cached.twitchEmotesOffset || 0;
        tx.innerHTML = this.emotes.renderTwitch(cached.message, cached.twitchEmotes, ctx);
      } else if (platform === 'kick') {
        tx.innerHTML = this.emotes.renderKick(cached.kickContent || cached.message, ctx);
      } else {
        continue;
      }
      // @mention spans need re-applying since innerHTML wiped them.
      this._processMentions(tx, platform);
    }
  }

  _applyPaintToRenderedMessages(username, paint) {
    const css = _7tvPaintToCss(paint);
    if (!css) return;
    const sel = `.un[data-platform="twitch"][data-username="${CSS.escape(username)}"]`;
    for (const un of this.chatEl.querySelectorAll(sel)) {
      // Respect user-set UnityChat nickname color override
      const msgId = un.closest('.msg')?.dataset.msgId;
      const cachedMsg = msgId ? this._msgCache.find((m) => m.id === msgId) : null;
      const ucProfile = cachedMsg ? this.nicknames.get('twitch', cachedMsg.username) : null;
      if (ucProfile?.color) continue;
      _7tvApplyPaintStyles(un, css);
    }
  }

  _addMessage(msg) {
    // First real message dropping in — chat is "live" enough, hide spinner.
    if (!this._loadingClearedByMsg && msg.username) {
      this._loadingClearedByMsg = true;
      this._hideLoading();
    }
    // Kick off async color resolution for Twitch chatters — hash fallback or
    // IRC color may not match what Twitch's own client shows, so we reconcile
    // via public GQL chatColor field for any user we haven't resolved yet.
    if (msg.platform === 'twitch' && msg.username && !msg._optimistic) {
      this._enqueueTwitchColorLookup(msg.username);
      if (msg.userId) {
        this._enqueue7tvPaintLookup(msg.userId, msg.username);
      } else {
        // Message didn't carry a user-id (older cache schema / scrape). Use
        // any user-id we resolved in a prior GQL round so paints still fire.
        const entry = this._chatUsers.get(`twitch:${msg.username.toLowerCase()}`);
        if (entry?.userId) this._enqueue7tvPaintLookup(entry.userId, msg.username);
      }
    }

    // Track color + badges BEFORE dedup (echo gets deduped but we still want the data)
    if (msg.color && msg.username && !msg._optimistic) {
      const colorKey = `${msg.platform}:${msg.username.toLowerCase()}`;
      const prev = this._chatUsers.get(colorKey);
      // CRITICAL: once we've resolved a user's color via DOM/GQL (the value
      // already includes Twitch's readability/7TV boost), never downgrade
      // back to the raw IRC color — even if msg.color is "set" by IRC.
      // The DOM ground truth IS the rendered color; raw IRC #008000 is just
      // user input that Twitch+7TV further adjust on display.
      const resolvedColor = prev?._fromGQL ? (prev.color || msg.color) : msg.color;
      const entry = {
        ...(prev || {}),
        name: msg.username,
        platform: msg.platform,
        color: resolvedColor,
        badgesRaw: msg.badgesRaw || prev?.badgesRaw || '',
        userId: msg.userId || prev?.userId || null,
      };
      if (!prev || prev.color !== resolvedColor || (msg.badgesRaw && prev.badgesRaw !== msg.badgesRaw)) {
        this._chatUsers.set(colorKey, entry);
      }
      // Also set plain username key for @autocomplete
      this._chatUsers.set(msg.username.toLowerCase(), entry);
      // Only track platform color for the current user's OWN messages
      // (previously this ran for every message → _platformColors got overwritten
      // with other users' colors → optimistic messages got wrong color)
      {
        const myName = (this._platformUsernames[msg.platform] || this.config.username || '').toLowerCase();
        if (msg.platform && myName && msg.username.toLowerCase() === myName) {
          this._savePlatformColor(msg.platform, msg.color);
          // Update platform username with display-name casing from IRC
          // (PING returns login "jouki728", IRC has display-name "Jouki728")
          if (msg.username !== this._platformUsernames[msg.platform]) {
            this._platformUsernames[msg.platform] = msg.username;
            if (!this.config._platformUsernames) this.config._platformUsernames = {};
            this.config._platformUsernames[msg.platform] = msg.username;
            this._saveConfig();
            // Update username field if settings are open
            const el = document.getElementById('input-username');
            if (el) el.value = msg.username;
          }
        }
      }
      if (this._lastSentText && msg.message) {
        const cleanMsg = msg.message.replace(' ' + UC_MARKER, '').replace(UC_MARKER, '');
        if (cleanMsg === this._lastSentText) this._lastSentText = null;
      }
    }

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
      if (this._seenContentKeys.has(contentKey)) {
        if (msg._optimistic) {
          // Optimistic messages always pass through — user can send same text twice
          this._optimisticKeys.set(contentKey, msg.id);
        } else if (msg.scraped) {
          return; // always drop scraped duplicates
        } else {
          // Real message — try to upgrade matching optimistic message
          const optId = this._optimisticKeys.get(contentKey);
          if (optId) {
            this._upgradeOptimistic(optId, msg);
            this._optimisticKeys.delete(contentKey);
            return; // upgraded in-place, don't render again
          }
          // No matching optimistic → legitimate repeat (e.g. bot responses
          // like !bulgarians always send the same text). Let it through.
        }
      } else {
        this._seenContentKeys.add(contentKey);
        if (msg._optimistic) this._optimisticKeys.set(contentKey, msg.id);
      }
      if (this._seenContentKeys.size > 2000) {
        const arr = [...this._seenContentKeys];
        this._seenContentKeys = new Set(arr.slice(-1000));
      }
    }

    this.msgCount++;

    // Sbírat usernames + barvy (platform:username → color mapping)
    // Optimistic messages skip — their color may be wrong (from _platformColors fallback);
    // the real IRC echo will set the correct color via _upgradeOptimistic
    if (msg.username && !msg._optimistic) {
      const colorKey = `${msg.platform}:${msg.username.toLowerCase()}`;
      const plainKey = msg.username.toLowerCase();
      const prevEntry = this._chatUsers.get(colorKey);
      // CRITICAL: preserve resolved state (_fromGQL, _paint, _paintChecked,
      // userId) from prior lookups. Otherwise every new IRC message wipes
      // it, the queue refires forever, and renderedColor stays stuck on
      // the raw IRC color (no DOM/GQL boost, no 7TV paint).
      const entry = {
        ...(prevEntry || {}),
        name: msg.username,
        platform: msg.platform,
        // Don't downgrade a GQL/DOM-resolved color back to raw IRC color —
        // the resolved one already includes Twitch's readability boost.
        color: prevEntry?._fromGQL ? (prevEntry.color || msg.color) : msg.color,
        badgesRaw: msg.badgesRaw || prevEntry?.badgesRaw || '',
        userId: msg.userId || prevEntry?.userId || null,
      };
      if (msg.color) {
        this._chatUsers.set(colorKey, entry);
        this._chatUsers.set(plainKey, entry); // for @autocomplete
        if (!prevEntry || prevEntry.color !== entry.color) {
          if (!this._userColorTimer) {
            this._userColorTimer = setTimeout(() => {
              this._userColorTimer = null;
              chrome.storage.local.set({ uc_user_colors: Object.fromEntries(this._chatUsers) }).catch(() => {});
            }, 2000);
          }
        }
      } else if (!this._chatUsers.has(colorKey)) {
        this._chatUsers.set(colorKey, entry);
        if (!this._chatUsers.has(plainKey)) this._chatUsers.set(plainKey, entry);
      }
    }

    // Detect if viewer is moderator/broadcaster on current Twitch channel.
    // We see our own username in IRC echoes; the badges tag carries the role.
    if (msg.platform === 'twitch' && !this._isModOnChannel && msg.badgesRaw && msg.username) {
      const mine = (this._platformUsernames.twitch || this.config.username || '').toLowerCase();
      if (mine && msg.username.toLowerCase() === mine) {
        if (/(^|,)(moderator|broadcaster)\//.test(msg.badgesRaw)) {
          this._isModOnChannel = true;
        }
      }
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

      // Track color from own sent message echo + persist
      if (this._lastSentText && msg.message === this._lastSentText) {
        this._lastSentText = null;
        if (msg.color && msg.platform) {
          this._savePlatformColor(msg.platform, msg.color);
        }
      }
      // Also track from username match
      if (msg.color && msg.platform) {
        const myName = this._platformUsernames[msg.platform]?.toLowerCase();
        if (myName && msg.username?.toLowerCase() === myName) {
          this._savePlatformColor(msg.platform, msg.color);
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
    const replyTarget = msg.replyTo?.username?.toLowerCase();
    const isMentioned = myName && (
      msgLower.includes(`@${myName}`) ||
      (myNick && msgLower.includes(`@${myNick}`)) ||
      replyTarget === myName ||
      (myNick && replyTarget === myNick) ||
      // Also match platform-specific username
      (this._platformUsernames[msg.platform] && replyTarget === this._platformUsernames[msg.platform]?.toLowerCase())
    );

    const el = document.createElement('div');
    el.className = 'msg';
    el.dataset.platform = msg.platform;
    if (msg.id) el.dataset.msgId = msg.id;
    if (msg.superChat) el.classList.add('superchat');
    if (isMentioned) el.classList.add('mentioned');
    if (msg.firstMsg) el.classList.add('first-msg');
    if (msg.isRaid) {
      el.classList.add('raid');
      // Prominent header bar matching the announcement style — pulsing
      // raid icon + RAID label + viewer count. Mirrors vanilla Twitch's
      // "RAID FROM …" callout so it doesn't get lost in fast chat.
      const rh = document.createElement('div');
      rh.className = 'raid-header';
      const viewers = msg.raidViewers != null ? ` <span class="raid-count">${msg.raidViewers}\u00A0div\u00E1k\u016F</span>` : '';
      rh.innerHTML = '<span class="raid-icon" aria-hidden="true">\u{1F680}</span>'
        + '<span class="raid-label">RAID</span>' + viewers;
      el.appendChild(rh);
    }
    if (msg.isRaider) el.classList.add('raider-msg');
    if (msg.isSus) el.classList.add('sus-msg');
    if (msg.isAnnouncement) {
      el.classList.add('announcement');
      // PRIMARY | BLUE | GREEN | ORANGE | PURPLE — CSS picks the accent.
      el.dataset.announcementColor = msg.announcementColor || 'PRIMARY';
      // Inline header bar with megaphone icon, matches Twitch's vanilla UI.
      const header = document.createElement('div');
      header.className = 'announcement-header';
      header.innerHTML = '<span class="announcement-icon" aria-hidden="true">\u{1F4E3}</span><span class="announcement-label">Announcement</span>';
      el.appendChild(header);
    }
    const isGift = !!(msg.isGiftBundle || msg.isSubGift);
    const isSubEvent = !!msg.isSubEvent;
    const isRedeem = !!msg.isRedeem;
    const isCustomEvent = isGift || isSubEvent || isRedeem;
    if (msg.isGiftBundle) el.classList.add('gift-bundle');
    if (msg.isSubGift) el.classList.add('sub-gift');
    if (isSubEvent) el.classList.add('sub-event');
    if (isRedeem) el.classList.add('redeem');
    if (msg.isHighlight) el.classList.add('highlight');
    if (!this.filters[msg.platform]) el.classList.add('hide-platform');
    // Cached message that was cleared (timeout/ban/delete) in a previous
    // session — re-apply the visual on render. Live clears go through
    // _markMessageCleared after the message is already in the DOM.
    if (msg._cleared) {
      el.classList.add('cleared');
      const cn = document.createElement('span');
      cn.className = 'cleared-note';
      cn.textContent = msg._cleared;
      // Append at end after the rest of the message renders below.
      // Defer with microtask so it lands as the last child.
      Promise.resolve().then(() => el.appendChild(cn));
    }

    // Determine if reply is TO the current user (not just any reply)
    const isReplyToMe = msg.replyTo && (
      replyTarget === myName ||
      (myNick && replyTarget === myNick) ||
      (this._platformUsernames[msg.platform] && replyTarget === this._platformUsernames[msg.platform]?.toLowerCase())
    );

    if (isGift) {
      this._renderGiftEvent(el, msg);
    } else if (isSubEvent) {
      this._renderSubEvent(el, msg);
    } else if (isRedeem) {
      this._renderRedeemEvent(el, msg);
    } else {

    // Reply context (Twitch reply-parent tagy)
    if (msg.replyTo) {
      const ctx = document.createElement('div');
      ctx.className = 'reply-ctx';
      if (msg.replyTo.id) ctx.classList.add('clickable');
      // Show nickname if available, otherwise platform username
      const replyRawName = (msg.replyTo.username || '').replace(/^@/, '');
      const replyProfile = this.nicknames.get(msg.platform, replyRawName);
      const replyDisplayName = replyProfile?.nickname || replyRawName;
      let replyBodyHtml = '';
      if (msg.replyTo.message) {
        // Render emotes in reply context using platform-specific parser.
        // No emotes tag for Twitch (positions unknown) → rely on 7TV/BTTV/FFZ/learned Twitch native.
        let body;
        if (msg.platform === 'kick') {
          body = this.emotes.renderKick(msg.replyTo.message);
        } else if (msg.platform === 'twitch') {
          body = this.emotes.renderTwitch(msg.replyTo.message, null);
        } else {
          body = this.emotes.renderPlain(msg.replyTo.message);
        }
        replyBodyHtml = ` <span class="rctx-body">${body}</span>`;
      }
      ctx.innerHTML =
        `&#8617; <span class="rctx-user">@${this.emotes._eh(replyDisplayName)}</span>` +
        replyBodyHtml;
      if (msg.replyTo.id) {
        ctx.addEventListener('click', (e) => {
          e.stopPropagation();
          this._scrollToMessage(msg.replyTo.id);
        });
      }
      el.appendChild(ctx);
    }

    // Tag line (right-aligned, above message content)
    const tagText =
      isReplyToMe ? 'Replying to you' :
      isMentioned ? 'Mentions you' :
      msg.isRaid ? 'Raid' :
      msg.isRaider ? 'Raider' :
      msg.firstMsg ? 'First message' :
      msg.isSus ? 'Suspicious' : null;
    if (tagText) {
      const tagLine = document.createElement('div');
      tagLine.className = 'msg-tag-line';
      const tagCls =
        isReplyToMe ? 'tag-reply' :
        isMentioned ? 'tag-mention' :
        msg.isRaid ? 'tag-raid' :
        msg.isRaider ? 'tag-raider' :
        msg.firstMsg ? 'tag-first' :
        'tag-sus';
      tagLine.innerHTML = `<span class="msg-tag ${tagCls}">${tagText}</span>`;
      el.appendChild(tagLine);
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
        const entry = this._twitchBadges[badge];
        const url = entry && typeof entry === 'object' ? entry.url : entry;
        if (!url && badgeCount > 0) {
          console.warn(`[Badge] Not found: "${badge}" (have ${badgeCount} badges)`);
        }
        if (url) {
          const title = (entry && typeof entry === 'object' && entry.title) || badge.split('/')[0];
          const img = document.createElement('img');
          img.className = 'bdg-img';
          img.src = url;
          img.alt = title;
          img.setAttribute('data-tooltip', title);
          bdg.appendChild(img);
        }
      }
      if (bdg.children.length) el.appendChild(bdg);
    }

    // Username (klik → otevře user card na platformě)
    const un = document.createElement('span');
    un.className = 'un';
    const ucProfile = this.nicknames.get(msg.platform, msg.username);
    const chatUserEntry = this._chatUsers.get(`${msg.platform}:${msg.username?.toLowerCase()}`);
    // Color priority: nickname custom → chatUsers map (platform:username) → msg.color fallback
    un.style.color = readableColor(ucProfile?.color || chatUserEntry?.color || msg.color);
    // 7TV paint overlay — only if no UnityChat custom color (that's a stronger
    // user intent), and we have a paint for this Twitch user. Paint replaces
    // the solid color with a gradient/image + background-clip on the glyphs.
    if (msg.platform === 'twitch' && !ucProfile?.color && chatUserEntry?._paint) {
      const css = _7tvPaintToCss(chatUserEntry._paint);
      if (css) _7tvApplyPaintStyles(un, css);
    }
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
    // /me (ACTION) messages — text has username color, italic
    if (msg.isAction) {
      el.classList.add('action');
      tx.style.color = un.style.color;
    }

    const renderCtx = { platform: msg.platform, author: msg.username };
    if (msg.platform === 'twitch') {
      // Reply messages strip the "@username " prefix from the body, but the
      // emotes tag positions are computed from the ORIGINAL message — shift
      // by twitchEmotesOffset so subscriber/native emotes resolve in replies.
      renderCtx.emotesOffset = msg.twitchEmotesOffset || 0;
      tx.innerHTML = this.emotes.renderTwitch(msg.message, msg.twitchEmotes, renderCtx);
    } else if (msg.platform === 'kick') {
      tx.innerHTML = this.emotes.renderKick(msg.kickContent || msg.message, renderCtx);
    } else if (msg.platform === 'youtube' && msg.ytRuns?.length) {
      tx.innerHTML = this.emotes.renderYouTube(msg.ytRuns);
    } else {
      tx.innerHTML = this.emotes.renderPlain(msg.message);
    }

    // @mentions — bold + colored with the mentioned user's chat color.
    // Runs AFTER emote/URL render so we only walk remaining text nodes (no
    // risk of corrupting <img> / <a> tags inside the rendered body).
    this._processMentions(tx, msg.platform);

    el.appendChild(tx);

    // Easter egg: StreamElements !bulgarians response — click to play audio
    if (msg.username?.toLowerCase() === 'streamelements' && msg.message?.includes('Bulgarians a pojedeš')) {
      el.classList.add('msg-audio');
      const audioUrl = chrome.runtime.getURL('audio/streamelements-bulgarians.mp3');
      el.addEventListener('click', () => {
        if (!this._bulgarianAudio) {
          this._bulgarianAudio = new Audio(audioUrl);
          this._bulgarianAudio.addEventListener('ended', () => {
            document.querySelectorAll('.msg-audio.playing').forEach(m => m.classList.remove('playing'));
          });
        }
        const a = this._bulgarianAudio;
        if (!a.paused) {
          a.pause(); a.currentTime = 0;
          el.classList.remove('playing');
        } else {
          // Stop any other playing instance
          document.querySelectorAll('.msg-audio.playing').forEach(m => m.classList.remove('playing'));
          a.currentTime = 0;
          a.play().then(() => el.classList.add('playing')).catch(() => {});
        }
      });
    }

    // Hover akce — skip for system events (raid, sub, gift, redeem,
    // announcement). They aren't user messages: copying their body text
    // is meaningless and Twitch IRC won't accept a reply to them.
    const isSystemEvent = msg.isRaid || msg.isAnnouncement
      || msg.isSubEvent || msg.isGiftBundle || msg.isSubGift || msg.isRedeem;
    if (isSystemEvent) {
      // Skip the entire actions cluster but keep the closing brace structure
      // (we still need to fall through to the unread/append/scroll/cache).
    } else {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';

    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-action-btn';
    copyBtn.title = 'Kopírovat zprávu';
    const copySvg = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
    copyBtn.innerHTML = copySvg;
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText((msg.message || '') + ' ').catch(() => {});
      copyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>';
      setTimeout(() => { copyBtn.innerHTML = copySvg; }, 1500);
    });
    actions.appendChild(copyBtn);

    // Pin button (jen Twitch zprávy; jen pokud viewer je mod/broadcaster).
    // Mod status se detekuje z IRC badge na vlastní zprávě — takže button se
    // objeví až poté co viewer pošle alespoň jednu zprávu (nebo dorazí echo).
    if (msg.platform === 'twitch' && this._isModOnChannel) {
      const pinBtn = document.createElement('button');
      pinBtn.className = 'msg-action-btn';
      pinBtn.title = 'Připnout zprávu';
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
      this._setReply(msg.platform, msg.username, msg.id, msg.message, msg.senderId);
    });
    actions.appendChild(replyBtn);
    el.appendChild(actions);
    }
    } // end isSystemEvent guard

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
    // Slim replyTo: keep id, username and message
    if (m.replyTo && typeof m.replyTo === 'object') {
      m.replyTo = { id: m.replyTo.id, username: m.replyTo.username, message: m.replyTo.message || null };
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
    // Cache is bounded by AGE (72h), not count — full 72h of chat activity is
    // preserved so reload restores everything. Age-prune in batches every 50
    // pushes to keep the hot path cheap on busy streams.
    if (!this._cachePruneN) this._cachePruneN = 0;
    if (++this._cachePruneN >= 50) {
      this._cachePruneN = 0;
      const cutoff = Date.now() - 72 * 60 * 60 * 1000;
      this._msgCache = this._msgCache.filter((m) => !m.timestamp || m.timestamp > cutoff);
    }
    // Save immediately — extension reload can kill context anytime
    chrome.storage.local.set({ [this._cacheKey]: this._msgCache }).catch(() => {});
  }

  // Upgrade an optimistic message to a real one (IRC echo arrived)
  _upgradeOptimistic(optId, realMsg) {
    // Update DOM element in-place
    const el = this.chatEl.querySelector(`[data-msg-id="${CSS.escape(optId)}"]`);
    if (el && realMsg.id) el.dataset.msgId = realMsg.id;
    if (realMsg.id) this._seenMsgIds.add(realMsg.id);

    // Update username color — prefer UnityChat custom color over IRC color
    if (el) {
      const ucColor = this.nicknames.getColor(realMsg.platform, realMsg.username);
      const resolvedColor = ucColor || realMsg.color;
      if (resolvedColor) {
        const un = el.querySelector('.un');
        if (un) un.style.color = readableColor(resolvedColor);
      }
    }

    // Replace badges with the authoritative IRC-echo set. The optimistic
    // message seeded its badges from a last-known cache entry which can be
    // stale (previous channel, session before sub bump, etc.) — we always
    // overwrite when the real echo lands so visual matches vanilla chat.
    if (el && realMsg.badgesRaw) {
      el.querySelectorAll(':scope > .bdg').forEach((n) => n.remove());
      const un = el.querySelector('.un');
      const bdg = document.createElement('span');
      bdg.className = 'bdg';
      for (const badge of realMsg.badgesRaw.split(',')) {
        if (!badge) continue;
        const entry = this._twitchBadges[badge];
        const url = entry && typeof entry === 'object' ? entry.url : entry;
        if (url) {
          const title = (entry && typeof entry === 'object' && entry.title) || badge.split('/')[0];
          const img = document.createElement('img');
          img.className = 'bdg-img';
          img.src = url;
          img.alt = title;
          img.setAttribute('data-tooltip', title);
          bdg.appendChild(img);
        }
      }
      if (bdg.children.length && un) el.insertBefore(bdg, un);
    }

    // Re-render message text with emotes from IRC echo
    if (el && realMsg.platform === 'twitch' && realMsg.twitchEmotes) {
      const tx = el.querySelector('.tx');
      if (tx) {
        // Learn new emotes first so renderSegments can find them
        this.emotes.learnTwitch(realMsg.message, realMsg.twitchEmotes);
        tx.innerHTML = this.emotes.renderTwitch(realMsg.message, realMsg.twitchEmotes, {
          platform: 'twitch',
          author: realMsg.username,
          emotesOffset: realMsg.twitchEmotesOffset || 0,
        });
      }
    }

    // Update cache entry: replace optimistic data with real data
    const cacheIdx = this._msgCache.findIndex(m => m.id === optId);
    if (cacheIdx !== -1) {
      const cached = this._msgCache[cacheIdx];
      if (realMsg.id) cached.id = realMsg.id;
      const ucColor = this.nicknames.getColor(realMsg.platform, realMsg.username);
      cached.color = ucColor || realMsg.color || cached.color;
      if (realMsg.badgesRaw) cached.badgesRaw = realMsg.badgesRaw;
      if (realMsg.twitchEmotes) cached.twitchEmotes = realMsg.twitchEmotes;
      if (realMsg.twitchEmotesOffset != null) cached.twitchEmotesOffset = realMsg.twitchEmotesOffset;
      delete cached._optimistic;
      chrome.storage.local.set({ [this._cacheKey]: this._msgCache }).catch(() => {});
    }

    // Update _chatUsers with the correct color from the real message —
    // preserve any DOM/GQL-resolved color/paint state so we don't downgrade.
    if (realMsg.color && realMsg.username) {
      const colorKey = `${realMsg.platform}:${realMsg.username.toLowerCase()}`;
      const plainKey = realMsg.username.toLowerCase();
      const prev = this._chatUsers.get(colorKey);
      const entry = {
        ...(prev || {}),
        name: realMsg.username,
        platform: realMsg.platform,
        color: prev?._fromGQL ? (prev.color || realMsg.color) : realMsg.color,
        userId: realMsg.userId || prev?.userId || null,
      };
      this._chatUsers.set(colorKey, entry);
      this._chatUsers.set(plainKey, entry);
      const myName = (this._platformUsernames[realMsg.platform] || this.config.username || '').toLowerCase();
      if (myName && realMsg.username.toLowerCase() === myName) {
        this._savePlatformColor(realMsg.platform, realMsg.color);
      }
    }
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

      // Populate message history from cached user messages (for ArrowUp/Down)
      // Match all known username variants + UC-marked messages
      const myNames = new Set();
      if (this.config.username) myNames.add(this.config.username.toLowerCase());
      for (const name of Object.values(this._platformUsernames)) {
        if (name) myNames.add(name.toLowerCase());
      }
      for (const m of msgs) {
        if (m.username && myNames.has(m.username.toLowerCase()) && m.message) {
          const text = m.message.replace(' ' + UC_MARKER, '').replace(UC_MARKER, '');
          if (text) this._msgHistory.push(text);
        }
      }
      if (this._msgHistory.length > 50) this._msgHistory = this._msgHistory.slice(-50);
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
        // Open a 200ms suppression window so the resulting scroll event
        // (which can fire after more messages have appended in a busy
        // chat) doesn't get re-interpreted as the user scrolling away.
        this._programmaticScrollUntil = performance.now() + 200;
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
    const badge = e.target.closest('.pi[data-tooltip], .bdg-img[data-tooltip]');
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
