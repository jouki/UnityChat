// EmoteManager — 7TV / BTTV / FFZ / Twitch / Kick / UC emoty, segmentový
// rendering zpráv do HTML, autocomplete. Sdílený core (addon i web), bez
// chrome.*/DOM: log, fetch a URL assetů jsou injektované přes opts. Tělo 1:1
// ze sidepanel.js v3.39.20 (plán web v0.1, Task 5); Kick HTML fragmenty se
// parsují bez DOM (core/html.js).
import { isTwitchOgFaceName } from './colors.js';
import { decodeEntities, stripTags, tagAttrs } from './html.js';
import { makeLog } from './log.js';
import { compileBlacklist, censorText } from './censor.js';

/** Plná URL odkazu z YouTube runu (navigationEndpoint → youtube.com/redirect?q=<url> nebo přímo), jinak původní text. */
export function ytRunFullText(run) {
  const raw = run?.navigationEndpoint?.urlEndpoint?.url || run?.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || '';
  if (!raw || !run.text) return run.text;
  try {
    const u = new URL(raw, 'https://www.youtube.com');
    let full = null;
    if (u.hostname.endsWith('youtube.com') && u.pathname === '/redirect') { const q = u.searchParams.get('q'); full = q && /^https?:\/\//i.test(q) ? q : null; }
    else if (/^https?:$/.test(u.protocol)) full = u.toString();
    if (!full) return run.text;
    const t = run.text;
    return (t.endsWith('…') || t.endsWith('...') || full.startsWith(t) || t.startsWith(full.slice(0, 12))) ? full : t;
  } catch { return run.text; }
}

export class EmoteManager {
  /**
   * opts.log(tag, text) — logování (addon: UC_LOG), opts.fetch — injekce pro
   * testy, opts.assetUrl(path) — URL vlastních assetů (addon: runtime getURL rozšíření,
   * web: Vite URL). Vše volitelné.
   */
  constructor(opts = {}) {
    this._log = makeLog(opts.log);
    this._fetchImpl = opts.fetch || ((...a) => globalThis.fetch(...a));
    this._assetUrl = opts.assetUrl || ((p) => p);
    this.global7tv = new Map();   // name -> url
    this.channel7tv = new Map();  // name -> url
    this.bttvEmotes = new Map();   // name -> url (BTTV global + channel)
    this.ffzEmotes = new Map();    // name -> url (FFZ global + channel)
    this.twitchNative = new Map(); // name -> url (naučené z IRC)
    this.kickNative = new Map();   // name -> url (naučené z [emote:ID:NAME])
    this.ucEmotes = new Map();     // name -> url (UnityChat custom emotes)
    this.zeroWidth = new Set();    // names of zero-width 7TV emotes (overlay on previous)
    this._blacklist = null;        // zkompilovaný blacklist slov (core/censor.js) — cenzura textu v _toHtml
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
    this.ucEmotes.set('CaneBear', this._assetUrl('emotes/canebear.webp'));
  }

  // ---- Loading ----

  // Bounded fetch for emote/badge providers. Boot awaits these via
  // Promise.allSettled, so a single provider that accepts the TCP/TLS
  // handshake but never sends a byte (FFZ outage 2026-09-05) would hang
  // _init forever — Chrome's fetch has no idle timeout of its own. Timeout
  // and any other failure are surfaced via UC_LOG [EmoteFetch] so the
  // boot dump shows WHICH provider stalled instead of a silent 0-count.
  async _fetch(url, opts = {}, timeoutMs = 8000) {
    const t0 = Date.now();
    try {
      return await this._fetchImpl(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const kind = err?.name === 'TimeoutError' ? 'timeout' : (err?.name || 'error');
      this._log('EmoteFetch', `${kind} after ${Date.now() - t0}ms: ${url}`);
      throw err;
    }
  }

  async loadGlobal() {
    if (this._globalLoaded) return;
    try {
      const resp = await this._fetch('https://7tv.io/v3/emote-sets/global');
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
      const resp = await this._fetch(`https://7tv.io/v3/users/${platform}/${userId}`);
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
      const gr = await this._fetch('https://api.betterttv.net/3/cached/emotes/global');
      if (gr.ok) {
        for (const e of await gr.json()) {
          this.bttvEmotes.set(e.code, `https://cdn.betterttv.net/emote/${e.id}/2x`);
          count++;
        }
      }
    } catch {}
    try {
      // Kanálové BTTV emotes
      const cr = await this._fetch(`https://api.betterttv.net/3/cached/users/twitch/${twitchUserId}`);
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
      const resp = await this._fetch('https://gql.twitch.tv/gql', {
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
      const gr = await this._fetch('https://api.frankerfacez.com/v1/set/global');
      if (gr.ok) parseSet((await gr.json()).sets || {});
    } catch {}
    try {
      const cr = await this._fetch(`https://api.frankerfacez.com/v1/room/id/${twitchUserId}`);
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
      // Zero-width: v setu je to bit 1 příznaků položky (e.flags, stejně jako u kanálu/globálních),
      // ve vlastnostech emotu bit 1<<8 (e.data.flags = 256). Dřív se četlo data.flags & 1 → vždy
      // false, a protože osobní emoty mají při renderu přednost, rozbilo to vrstvení (RAVE apod.).
      const zw = !!(((e?.flags ?? 0) & 1) || ((e?.data?.flags ?? 0) & 256));
      map.set(e.name, { url, zw });
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
    this._log('ShortEmote', `name="${name}" source=${source} url=${url} platform=${platform} author=${author}`);
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

  learnTwitch(text, emotesTag, offset = 0) {
    if (!emotesTag) return;
    for (const part of emotesTag.split('/')) {
      const ci = part.indexOf(':');
      if (ci === -1) continue;
      const id = part.substring(0, ci);
      const range = part.substring(ci + 1).split(',')[0];
      const dash = range.indexOf('-');
      if (dash === -1) continue;
      const s = parseInt(range.substring(0, dash), 10) - offset;
      const e = parseInt(range.substring(dash + 1), 10) - offset;
      if (isNaN(s) || isNaN(e) || s < 0 || e >= text.length) continue;
      const name = text.substring(s, e + 1);
      // Sanity check: real Twitch emote names are alphanumeric (with
      // some punctuation). Skip if the slice would learn a fragment of
      // a regular word — happens when offset is wrong (we'd teach
      // "te" as an alias for :D from a misaligned reply prefix).
      if (!name || !/^[\S]+$/.test(name) || /^[a-z]{1,3}$/.test(name)) continue;
      if (!this.twitchNative.has(name)) {
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
        // Cheermote: "Cheer{N}" on Twitch is a bits cheer — render the
        // animated tier emote + colored bits count. Tier + color per
        // Twitch's standard Cheer prefix (channels can have custom
        // prefixes with their own emotes, which we can't resolve
        // without OAuth — those fall through to the regular flow).
        if (platform === 'twitch') {
          const cm = /^(?:Cheer)(\d+)$/i.exec(part);
          if (cm) {
            const bits = parseInt(cm[1], 10);
            const tier = bits >= 100000 ? 100000 : bits >= 10000 ? 10000 : bits >= 5000 ? 5000 : bits >= 1000 ? 1000 : bits >= 100 ? 100 : 1;
            const colors = { 1: '#979797', 100: '#9c3ee8', 1000: '#1db2a5', 5000: '#0099fe', 10000: '#f43021', 100000: '#f43021' };
            const url = `https://d3aqoihi2n8ty8.cloudfront.net/actions/cheer/dark/animated/${tier}/2.gif`;
            out.push({ type: 'emote', value: `Cheer${bits}`, url, zw: false });
            out.push({ type: 'text', value: `${bits}`, style: `color:${colors[tier]};font-weight:700;` });
            continue;
          }
        }
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
        // YouTube zkracuje text odkazu („…"), plná URL je v navigationEndpoint (redirect?q=…).
        segments.push({ type: 'text', value: ytRunFullText(run) });
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
    // Bez DOM (core sdílený s webem / Node testy): projde HTML fragment po
    // tazích, <img> = emote (src http…) nebo text (alt), ostatní tagy se
    // zahodí, text mezi nimi se dekóduje z entit — shodné s dřívějším
    // průchodem přes div.innerHTML + textContent.
    if (!html) return [];
    if (!html.includes('<')) return [{ type: 'text', value: html }];

    const segments = [];
    const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
    let last = 0;
    let m;
    while ((m = re.exec(html)) !== null) {
      if (m.index > last) {
        const txt = decodeEntities(html.substring(last, m.index));
        if (txt) segments.push({ type: 'text', value: txt });
      }
      if (m[1].toLowerCase() === 'img' && !m[0].startsWith('</')) {
        const at = tagAttrs(m[0]);
        const src = at.src || '';
        const alt = at.alt || '';
        if (src.startsWith('http')) {
          segments.push({ type: 'emote', value: alt, url: src });
        } else {
          segments.push({ type: 'text', value: alt });
        }
      }
      last = m.index + m[0].length;
    }
    if (last < html.length) {
      const txt = decodeEntities(html.substring(last));
      if (txt) segments.push({ type: 'text', value: txt });
    }
    return segments.length > 0 ? segments : [{ type: 'text', value: stripTags(html) }];
  }

  // ---- HTML helpers ----

  /** Blacklist slov ze Židolišty (GET /blacklist): text zpráv se cenzuruje při vykreslení. Vrací počet položek. */
  setBlacklist(terms) {
    this._blacklist = compileBlacklist(terms);
    return this._blacklist.size;
  }

  /** Cenzura libovolného textu (zobrazované jméno apod.); bez blacklistu beze změny. */
  censor(text) {
    return censorText(text, this._blacklist);
  }

  /**
   * Textové segmenty jsou rozsekané po slovech (renderSegments), takže se sousední
   * nestylované texty pro hledání spojí (fráze přes víc segmentů) a výsledek se rozdělí
   * zpátky na původní délky — cenzura délku zachovává, segmentace pro ZW stack zůstane.
   */
  _censorSegments(segments) {
    const out = segments.slice();
    for (let i = 0; i < out.length;) {
      if (out[i].type !== 'text' || out[i].style) { i++; continue; }
      let j = i;
      while (j < out.length && out[j].type === 'text' && !out[j].style) j++;
      const run = out.slice(i, j);
      const joined = run.map((x) => x.value).join('');
      const censored = censorText(joined, this._blacklist);
      if (censored !== joined) {
        const cps = Array.from(censored);
        let pos = 0;
        for (let k = i; k < j; k++) {
          const len = Array.from(out[k].value).length;
          out[k] = { ...out[k], value: cps.slice(pos, pos + len).join('') };
          pos += len;
        }
      }
      i = j;
    }
    return out;
  }

  _toHtml(segments) {
    if (this._blacklist?.size) segments = this._censorSegments(segments);
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
        if (s.style) {
          // Styled text segment (cheermote bits count, future spans).
          // Sanitize the inline style to allow only color/font-weight/
          // background rules — no URL / expression injection.
          const safe = String(s.style).replace(/[<>"'`]/g, '');
          out.push(`<span style="${safe}">${this._eh(s.value)}</span>`);
        } else {
          out.push(this._linkify(s.value));
        }
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
      if (isTwitchCdn && isTwitchOgFaceName(s.value)) cls += ' emote-tiny';
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
    // Match any of:
    //   https://… / http://…           — explicit scheme
    //   www.example.com[/...]          — schemeless www-prefixed
    //   example.com[/...]              — bare domain with a known TLD
    // The bare-domain branch is gated on a TLD whitelist so we don't
    // accidentally turn things like "verca.je" / Czech sentences with
    // dots into links. Word-boundary lookbehind keeps it from matching
    // mid-token (like emails).
    const urlRe = /(?:(?<=^|[\s(\[<])(?:https?:\/\/[^\s<>'")\]]+|www\.[A-Za-z0-9][A-Za-z0-9\-_.]*\.[A-Za-z]{2,}(?:\/[^\s<>'")\]]*)?|[A-Za-z0-9][A-Za-z0-9\-_]*\.(?:cz|sk|com|net|org|io|gg|tv|me|app|dev|ai|eu|de|uk|us|fr|pl|jp|ru|ca|nl|it|info|live|video|stream|games|game|wiki|news|blog|shop|store|fun)(?:\/[^\s<>'")\]]*)?))/gi;
    let last = 0;
    let out = '';
    let m;
    while ((m = urlRe.exec(s)) !== null) {
      if (m.index > last) out += this._eh(s.substring(last, m.index));
      const raw = m[0].replace(/[.,;:!?)]+$/, '');
      // Build href: prepend https:// if no scheme present
      const href = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
      urlRe.lastIndex = m.index + raw.length;
      out += `<a href="${this._ea(href)}" target="_blank" rel="noopener">${this._eh(raw)}</a>`;
      last = m.index + raw.length;
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
