// =============================================================
// UnityChat - Sjednocený chat z Twitch, YouTube a Kick
// 7TV emotes + Twitch/Kick/YouTube nativní emoty
// =============================================================

// Neviditelný marker na konci zpráv odeslaných přes UnityChat.
// Braille Pattern Blank (U+2800) - vypadá prázdně, platformy ho nestripují.
// Vkládá se za mezeru, aby neovlivnil trailing emoty.
const UC_MARKER = '\u2800';

// Podporovaní streameři (Twitch login). Primární je Rob; na jiného se
// přepíná jen ručně tlačítkem nad chatem. Ostatní streamery addon ignoruje
// (rozhodnutí usera 2026-09-19 — chaty se míchaly a emoty se nepřenačítaly).
const PRIMARY_STREAMER = 'robdiesalot';
const SUPPORTED_STREAMERS = new Set(['robdiesalot', 'tensterakdary', 'arcadebulls']);

// Firefox (build scripts/build-firefox.mjs): browser.runtime.getBrowserInfo existuje jen tam.
const IS_FIREFOX = typeof browser !== 'undefined' && typeof browser.runtime?.getBrowserInfo === 'function';

const DEFAULTS = {
  channel: 'robdiesalot',
  kickChannel: 'robdiesalot',
  ytChannel: 'robdiesalot',
  twitch: true,
  youtube: true,
  kick: true,
  // Soft render cap — chat should hold ~72h of activity, cache is the source
  // of truth. Keep a ceiling to prevent runaway DOM growth on busy streams.
  username: '',
  layout: 'medium',
  showTimestamps: true,
  replyOneLine: false,
  sound: true, // zvuky reakcí (video Peepo poop); false = přehrát potichu
  reactionScrollBack: true, // po konci animace reakce skočit zpět na konec chatu
  acFulltext: false, // Fulltext prepinac v naseptavaci emotu (persistentni, user 2026-09-20)
};

// =============================================================
// EmoteManager - 7TV + BTTV + FFZ + Twitch + Kick + YouTube emotes
// Segment-based rendering: [{ type:'text'|'emote', value, url? }]
// =============================================================

// EmoteManager žije v extension/core/emotes.js (sdílený s webem),
// sem ho vystaví core-bridge.js přes window.UC_CORE / window.EmoteManager.

// =============================================================
// NicknameManager - custom display names backed by api.jouki.cz
// SSE push for real-time updates, chrome.storage.local cache
// =============================================================

// DEV: http://178.104.160.182:3001 | PROD: https://api.jouki.cz
const UC_API = 'https://api.jouki.cz';
// Reakce „Peepo poop" — video sdílené s webem (robdiesalot.com/chat/media/).
const POOP_VIDEO_URL = 'https://robdiesalot.com/chat/media/peepo-chat-alpha-v2-wet-sound.webm';

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
      // UnityChat Announcement ze Židolišty (command s videem) — vykreslí UnityChat._addAnnouncement.
      this._eventSource.addEventListener('announcement', (e) => {
        try { const d = JSON.parse(e.data); if (this.onAnnouncement) this.onAnnouncement(d); } catch {}
      });
      // Reakce „Peepo poop" spuštěná modem — přehraje UnityChat._playReaction (core/reaction.js).
      this._eventSource.addEventListener('reaction', (e) => {
        try { const d = JSON.parse(e.data); if (this.onReaction) this.onReaction(d); } catch {}
      });
      // Změna chat commandů v Židolištce (webhook → backend → SSE) — UnityChat si obnoví „!" našeptávání.
      this._eventSource.addEventListener('commands-change', (e) => {
        try { const d = JSON.parse(e.data); if (this.onCommandsChange) this.onCommandsChange(d); } catch {}
      });
      // Zpráva z UnityChatu bez markeru (command) — server ji poznal (backend lib/ucSends.ts).
      this._eventSource.addEventListener('uc-mark', (e) => {
        try { const d = JSON.parse(e.data); if (this.onUcMark) this.onUcMark(d); } catch {}
      });
      // Změna nastavení donací v Židolištce (webhook → backend) → QR dono si načte minimum a hlasy hned.
      this._eventSource.addEventListener('donate-config-change', (e) => {
        try { const d = JSON.parse(e.data); if (this.onDonateConfigChange) this.onDonateConfigChange(d); } catch {}
      });
      // Odpověď napříč platformami (server spároval nahlášenou odpověď se zprávou) → ↩ s citací.
      this._eventSource.addEventListener('uc-reply', (e) => {
        try { const d = JSON.parse(e.data); if (this.onUcReply) this.onUcReply(d); } catch {}
      });
      // Soundboard (Židolišta → backend → SSE): změna zvuků/odemčení = refetch, přehrání/odmítnutí = core.
      for (const type of ['soundboard-change', 'soundboard-played', 'soundboard-denied']) {
        this._eventSource.addEventListener(type, (e) => {
          try { const d = JSON.parse(e.data); if (this.onSoundboard) this.onSoundboard(type, d); } catch {}
        });
      }
      // Změna blacklistu slov v Židolištce → UnityChat._loadBlacklist() hned.
      this._eventSource.addEventListener('blacklist-change', (e) => {
        try { const d = JSON.parse(e.data); if (this.onBlacklistChange) this.onBlacklistChange(d); } catch {}
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

  // Reverzní lookup: UC přezdívka → skutečný login. Autocomplete nabízí
  // přezdívky (skutečný login uživatel nikde nevidí), do chatu ale musí odejít
  // login, jinak zmíněný nedostane upozornění a lidé mimo UnityChat nepoznají,
  // o koho jde. Bez `platform` hledá napříč platformami.
  resolveNickname(nickname, platform) {
    const want = String(nickname || '').toLowerCase().replace(/^@/, '');
    if (!want) return null;
    for (const [key, val] of this._map) {
      if ((val?.nickname || '').toLowerCase() !== want) continue;
      const i = key.indexOf(':');
      if (i < 0) continue;
      if (platform && key.slice(0, i) !== platform) continue;
      return key.slice(i + 1);
    }
    return null;
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

// Barvy jmen žijí v extension/core/colors.js (sdílené s webem), sem je
// vystaví core-bridge.js přes window.UC_CORE.
const { TWITCH_DEFAULT_COLORS, twitchDefaultColor, ytNameColor, readableColor } = window.UC_CORE;
const _isTwitchOgFaceName = window.UC_CORE.isTwitchOgFaceName;

// TwitchProvider žije v extension/core/twitch-irc.js (sdílený s webem),
// sem ho vystaví core-bridge.js přes window.UC_CORE / window.TwitchProvider.

// =============================================================
// Kick Provider (Pusher WebSocket)
// =============================================================

// KickProvider žije v extension/core/kick.js (sdílený s webem),
// sem ho vystaví core-bridge.js přes window.UC_CORE / window.KickProvider.

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
    this._allCont = null;     // reload token režimu "všechny zprávy" (ne Top chat)
    this._apiKey = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
    this._ctx = null;
    this._seen = new Set();
    this._apiFails = 0;       // počet po sobě jdoucích prázdných API odpovědí
    this._usePageRefresh = false;
    this._connectId = 0;      // serial ID for disambiguating overlapping connects
    this._pollTick = 0;       // incremented on each poll invocation
    this.onMessage = null;
    this.onStatus = null;
    this.onDebug = null;      // callback pro debug zprávy
    // Záloha přes backend (GET /chat/stream, jako web): když YouTube pošle požadavky addonu na
    // stránku se souhlasem s cookies (consent.youtube.com — Firefox bez souhlasu v profilu,
    // ověřeno logem 2026-09-23). backendChannel = Twitch login kanálu (backend z něj zná YT handle).
    this.backendChannel = '';
    this._consentBlocked = false;
    this._es = null;
  }

  _log(text) {
    try {
      chrome.runtime.sendMessage({ type: 'UC_LOG', tag: 'YT', text }).catch(() => {});
    } catch {}
  }

  async connect(channel) {
    this.channel = channel.trim();
    this.disconnect(true);
    this._consentBlocked = false;
    const cid = ++this._connectId;
    this._log(`connect() ch=${this.channel} cid=${cid}`);
    this.onStatus?.('connecting');

    try {
      // Krok 1: najít videoId
      this._log(`[${cid}] findLiveVideoId start`);
      const vidStart = Date.now();
      this._videoId = await this._findLiveVideoId();
      this._log(`[${cid}] findLiveVideoId done videoId=${this._videoId || 'null'} ms=${Date.now()-vidStart} consent=${this._consentBlocked}`);
      if (!this._videoId && this._consentBlocked && this.backendChannel) return this._connectBackend(cid);
      if (!this._videoId) throw new Error('Streamer není live na YouTube');
      this.onDebug?.(`YouTube videoId: ${this._videoId}`);

      // Krok 2: načíst live chat stránku. Try popout first (forces
      // timedContinuationData for HTTP polling); fall back to embedded if
      // popout returns no usable continuation.
      let chatHtml, ytData, lcrData = null, contType = 'none', variant = 'popout', invalidationToken = null;
      for (const v of ['popout', 'embedded']) {
        this._log(`[${cid}] fetchChatPage variant=${v} start`);
        const chatStart = Date.now();
        const html = await this._fetchChatPage(v);
        this._log(`[${cid}] fetchChatPage variant=${v} done bytes=${html.length} ms=${Date.now()-chatStart}`);
        const data = this._extractJson(html, 'ytInitialData');
        this._log(`[${cid}] extractJson variant=${v} ytData=${!!data}`);
        if (!data) continue;

        // YouTube servíruje ve výchozím stavu "Nejlepší zprávy" (Top chat),
        // který část zpráv zahazuje jako potenciální spam. Token pro režim
        // "Chat" (= všechny zprávy) je v header view selectoru; přepneme se
        // na něj a dál pracujeme s jeho odpovědí.
        let lcr = this._lcr(data);
        const allTok = this._pickAllChatToken(lcr);
        if (allTok) {
          try {
            const allHtml = await this._fetchChatPage(v, allTok);
            const allLcr = this._lcr(this._extractJson(allHtml, 'ytInitialData'));
            if (allLcr) {
              this._allCont = allTok;
              lcr = allLcr;
              this._log(`[${cid}] variant=${v} chatMode=all switched actions=${allLcr.actions?.length || 0} bytes=${allHtml.length}`);
            } else {
              this._log(`[${cid}] variant=${v} chatMode=all FAILED (no lcr in response), zůstávám na top chat`);
            }
          } catch (err) {
            this._log(`[${cid}] variant=${v} chatMode=all EXC ${err.name}:${err.message}`);
          }
        } else {
          this._log(`[${cid}] variant=${v} chatMode=noSwitch (selector chybí nebo už je all)`);
        }

        const conts = lcr?.continuations;
        let foundTimed = null, foundType = 'none', foundInv = null;
        if (conts?.length) {
          for (const c of conts) {
            if (c?.timedContinuationData?.continuation) {
              foundTimed = c.timedContinuationData.continuation;
              foundType = 'timed';
              break;
            }
          }
          if (!foundTimed) {
            for (const c of conts) {
              if (c?.invalidationContinuationData?.continuation) {
                foundInv = c.invalidationContinuationData.continuation;
                foundType = 'invalidation';
                break;
              }
              if (c?.reloadContinuationData) { foundType = 'reload'; break; }
            }
          }
        }
        this._log(`[${cid}] variant=${v} contType=${foundType} contKeys=${conts?.map(c=>Object.keys(c)).flat().join(',') || ''}`);
        chatHtml = html; ytData = data; lcrData = lcr; contType = foundType; variant = v;
        if (foundInv && !invalidationToken) invalidationToken = foundInv;
        if (foundTimed) { this._cont = foundTimed; break; }
        // No timed from popout — try embedded before accepting defeat
      }
      if (!ytData) throw new Error('YouTube chat data nenalezena');
      this._variant = variant;
      this._log(`[${cid}] final variant=${variant} contType=${contType} contPresent=${!!this._cont} chatMode=${this._allCont ? 'all' : 'top'}`);

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

      // Zpracovat úvodní zprávy (zobrazit posledních několik)
      const actions = lcrData?.actions || [];
      const recentActions = actions.slice(-10); // zobrazit max 10 posledních
      this._log(`[${cid}] initial actions=${actions.length} rendering=${recentActions.length}`);
      this._processActions(recentActions);
      // Označit všechny jako viděné
      let initialSeen = 0;
      for (const a of actions) {
        const r =
          a?.addChatItemAction?.item?.liveChatTextMessageRenderer ||
          a?.addChatItemAction?.item?.liveChatPaidMessageRenderer;
        if (r?.id) { this._seen.add(r.id); initialSeen++; }
      }
      this._log(`[${cid}] seen set primed with ${initialSeen} ids, total seen=${this._seen.size}`);

      this.polling = true;
      this._apiFails = 0;
      this._usePageRefresh = !this._cont; // bez continuation jdeme rovnou na page refresh
      this.onStatus?.('connected');
      this._log(`[${cid}] connected mode=${this._usePageRefresh ? 'pageRefresh' : 'api'}`);

      if (this._usePageRefresh) {
        this.onDebug?.('YouTube: page refresh mód (bez continuation)');
      } else {
        this.onDebug?.('YouTube: API polling mód');
      }

      // Diagnostic probe for invalidation-only streams — fires once per connect,
      // tries multiple endpoint/payload variants to find one that accepts the
      // invalidation token and returns fresh actions. Results purely logged.
      if (!this._cont && invalidationToken) {
        this._probeInvalidation(invalidationToken, cid).catch(() => {});
      }

      this._pt = setTimeout(() => this._poll(), 2000);
    } catch (err) {
      console.error('YouTube:', err);
      this._log(`[${cid}] connect ERROR ${err.message}`);
      this.onStatus?.('error', err.message);
    }
  }

  async _probeInvalidation(invToken, cid) {
    const base = `https://www.youtube.com/youtubei/v1/live_chat`;
    const key = this._apiKey;
    const ctx = this._ctx;
    const ctxEmbed = { client: { ...ctx.client, clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '1.20250401.00.00' } };
    const ctxTv = { client: { ...ctx.client, clientName: 'TVHTML5', clientVersion: '7.20250401.08.00' } };
    const attempts = [
      { name: 'POST get_live_chat WEB',          method: 'POST', url: `${base}/get_live_chat?key=${key}&prettyPrint=false`, body: { context: ctx, continuation: invToken } },
      { name: 'POST get_live_chat WEB_EMBEDDED', method: 'POST', url: `${base}/get_live_chat?key=${key}&prettyPrint=false`, body: { context: ctxEmbed, continuation: invToken } },
      { name: 'POST get_live_chat TVHTML5',      method: 'POST', url: `${base}/get_live_chat?key=${key}&prettyPrint=false`, body: { context: ctxTv, continuation: invToken } },
      { name: 'POST get_live_chat WEB referer',  method: 'POST', url: `${base}/get_live_chat?key=${key}&prettyPrint=false`, body: { context: ctx, continuation: invToken }, referrer: 'https://www.youtube.com/' },
      { name: 'GET live_chat?continuation',      method: 'GET',  url: `https://www.youtube.com/live_chat?v=${this._videoId}&continuation=${encodeURIComponent(invToken)}` },
      { name: 'GET live_chat?popout+cont',       method: 'GET',  url: `https://www.youtube.com/live_chat?v=${this._videoId}&is_popout=1&continuation=${encodeURIComponent(invToken)}` },
    ];
    for (const a of attempts) {
      const t0 = Date.now();
      try {
        const init = {
          method: a.method,
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'X-YouTube-Client-Name': '1',
            'X-YouTube-Client-Version': ctx.client.clientVersion,
          },
        };
        if (a.method === 'POST') init.body = JSON.stringify(a.body);
        if (a.referrer) init.referrer = a.referrer;
        const r = await fetch(a.url, init);
        const text = await r.text();
        let hasActions = false, contKeys = '', errSnippet = '';
        const trimmed = text.trim();
        if (trimmed.startsWith('{')) {
          try {
            const j = JSON.parse(text);
            const lcc = j?.continuationContents?.liveChatContinuation;
            hasActions = !!(lcc?.actions?.length);
            const conts = lcc?.continuations;
            if (conts?.length) contKeys = conts.map(c => Object.keys(c)).flat().join(',');
            if (j?.error?.message) errSnippet = j.error.message.slice(0, 120);
          } catch {}
        } else {
          if (text.includes('timedContinuationData')) contKeys = 'timed(inHTML)';
          else if (text.includes('invalidationContinuationData')) contKeys = 'invalidation(inHTML)';
          else contKeys = 'noCont(inHTML)';
        }
        this._log(`PROBE [${cid}] "${a.name}" status=${r.status} bytes=${text.length} hasActions=${hasActions} contKeys=${contKeys} err=${errSnippet} ms=${Date.now()-t0}`);
      } catch (err) {
        this._log(`PROBE [${cid}] "${a.name}" EXC ${err.name}:${err.message} ms=${Date.now()-t0}`);
      }
    }
    this._log(`PROBE [${cid}] done`);
  }

  // Live chat data mají dvě podoby: čerstvě načtená stránka je drží v
  // contents.liveChatRenderer, continuation fetch v continuationContents.
  _lcr(data) {
    return data?.contents?.liveChatRenderer
      || data?.continuationContents?.liveChatContinuation
      || null;
  }

  // View selector nabízí dva režimy: [0] "Nejlepší zprávy" (Top chat, filtruje
  // domnělý spam) a [1] "Chat" (všechny zprávy). Vrací reload token druhého,
  // nebo null když už v něm jsme / selector chybí.
  _pickAllChatToken(lcr) {
    const items = lcr?.header?.liveChatHeaderRenderer?.viewSelector
      ?.sortFilterSubMenuRenderer?.subMenuItems;
    if (!Array.isArray(items) || items.length < 2) return null;
    const all = items[items.length - 1];
    if (all?.selected) return null;
    return all?.continuation?.reloadContinuationData?.continuation || null;
  }

  async _fetchChatPage(variant, cont) {
    // is_popout=1 forces YouTube to return timedContinuationData (popout chat
    // has no parent frame for push, so server must provide polling tokens).
    // Embedded (default) returns invalidationContinuationData for small
    // channels, which cannot be used for HTTP polling.
    const v = variant || 'popout';
    // Continuation token je self-contained (nese videoId, popout i režim
    // chatu), takže v/is_popout se s ním neposílá.
    const qs = cont
      ? `continuation=${encodeURIComponent(cont)}`
      : v === 'popout'
      ? `v=${this._videoId}&is_popout=1`
      : `v=${this._videoId}`;
    const resp = await fetch(
      `https://www.youtube.com/live_chat?${qs}`,
      { credentials: 'include' }
    );
    if (!resp.ok) throw new Error(`YouTube chat page: ${resp.status}`);
    return resp.text();
  }

  /**
   * YouTube přes backend SSE (/chat/stream?platforms=youtube) — stejný zdroj a tvar zpráv jako
   * web a /chat/history. EventSource se po redeployi backendu (502) trvale zavře → nový pokus.
   */
  _connectBackend(cid, retry = 0) {
    if (cid !== this._connectId) return;
    const u = `${UC_API}/chat/stream?channel=${encodeURIComponent(this.backendChannel)}&platforms=youtube`;
    this._log(`[${cid}] consent.youtube.com → YouTube přes backend ${u}`);
    const es = new EventSource(u);
    this._es = es;
    es.addEventListener('hello', () => { if (cid === this._connectId) this.onStatus?.('connected'); });
    es.addEventListener('message', (e) => {
      if (cid !== this._connectId) return;
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (!m?.id || this._seen.has(m.id)) return;
      this._seen.add(m.id);
      if (this._seen.size > 5000) this._seen = new Set([...this._seen].slice(-2500));
      this.onMessage?.({ ...m, historical: false });
    });
    es.onerror = () => {
      if (cid !== this._connectId || es.readyState !== EventSource.CLOSED) return;
      es.close();
      if (this._es === es) this._es = null;
      this.onStatus?.('connecting');
      const delay = Math.min(30000, 3000 * (retry + 1));
      this._log(`[${cid}] backend stream zavřen, nový pokus za ${delay} ms`);
      setTimeout(() => this._connectBackend(cid, retry + 1), delay);
    };
  }

  async _findLiveVideoId() {
    const urls = [
      `https://www.youtube.com/${this.channel}/live`,
      `https://www.youtube.com/@${this.channel}/live`
    ];
    for (const url of urls) {
      try {
        const r = await fetch(url, { credentials: 'include', redirect: 'follow' });
        if (!r.ok) { this._log(`findLive ${url} status=${r.status}`); continue; }
        if (/^https:\/\/consent\.youtube\.com\//.test(r.url)) this._consentBlocked = true;
        const html = await r.text();
        const isLive =
          html.includes('"isLive":true') ||
          html.includes('"isLiveContent":true') ||
          html.includes('"isLiveNow":true') ||
          html.includes('"isLiveBroadcast":true');
        const m = html.match(/"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/);
        this._log(`findLive ${url} isLive=${isLive} videoId=${m?.[1] || 'none'} bytes=${html.length} finalUrl=${r.url}`);
        if (!isLive) continue;
        if (m) return m[1];
      } catch (err) {
        this._log(`findLive ${url} ERROR ${err.message}`);
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
    const tick = ++this._pollTick;
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 15000);
      const t0 = Date.now();

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

      if (!resp.ok) {
        this._log(`pollApi#${tick} HTTP ${resp.status} ms=${Date.now()-t0}`);
        throw new Error(`API ${resp.status}`);
      }

      const data = await resp.json();
      const lcc = data?.continuationContents?.liveChatContinuation;

      if (!lcc) {
        this._apiFails++;
        this._log(`pollApi#${tick} NO_LCC apiFails=${this._apiFails} dataKeys=${Object.keys(data || {}).join(',')} ms=${Date.now()-t0}`);
        if (this._apiFails >= 3) {
          this.onDebug?.('YouTube API: prázdné odpovědi, přepínám na page refresh');
          this._usePageRefresh = true;
        }
        if (this.polling) this._pt = setTimeout(() => this._poll(), 5000);
        return;
      }

      // Continuation update: ONLY timedContinuationData works with HTTP polling.
      // If the response stops emitting it (stream switched to push-only), keep
      // previous _cont and fall back to page refresh so we don't start 403-ing.
      let nextMs = 5000;
      let contTypeTick = 'none';
      const conts = lcc.continuations;
      if (conts?.length) {
        for (const c of conts) {
          if (c?.timedContinuationData) {
            this._cont = c.timedContinuationData.continuation;
            nextMs = c.timedContinuationData.timeoutMs || 5000;
            contTypeTick = 'timed';
            break;
          }
          if (c?.invalidationContinuationData) contTypeTick = 'invalidation-only';
        }
        if (contTypeTick === 'invalidation-only') {
          this.onDebug?.('YouTube API: stream switched to invalidation-only continuation, page refresh mode');
          this._usePageRefresh = true;
        }
      }

      const actions = lcc.actions || [];
      const beforeSeen = this._seen.size;
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
      const added = this._seen.size - beforeSeen;
      this._log(`pollApi#${tick} actions=${actions.length} newSeen=${added} apiFails=${this._apiFails} cont=${contTypeTick} nextMs=${nextMs} ms=${Date.now()-t0}`);

      if (this.polling) {
        this._pt = setTimeout(() => this._poll(), Math.max(nextMs, 1500));
      }
    } catch (err) {
      console.error('YouTube API poll:', err);
      this._apiFails++;
      this._log(`pollApi#${tick} EXC ${err.name}:${err.message} apiFails=${this._apiFails}`);
      if (this._apiFails >= 3) {
        this.onDebug?.(`YouTube API selhalo (${err.message}), přepínám na page refresh`);
        this._usePageRefresh = true;
      }
      if (this.polling) this._pt = setTimeout(() => this._poll(), 5000);
    }
  }

  async _pollPageRefresh() {
    const tick = ++this._pollTick;
    try {
      const t0 = Date.now();
      const html = await this._fetchChatPage(this._variant, this._allCont);
      const lcr = this._lcr(this._extractJson(html, 'ytInitialData'));
      if (!lcr) {
        this._log(`pollPage#${tick} NO_YTDATA bytes=${html.length} chatMode=${this._allCont ? 'all' : 'top'} ms=${Date.now()-t0}`);
        // Token pro režim "všechny zprávy" mohl expirovat — další tick jede
        // bez něj, ať chat nezmrzne úplně (a log to pojmenuje).
        if (this._allCont) {
          this._log(`pollPage#${tick} chatMode=all token zahozen, fallback na top chat`);
          this._allCont = null;
        }
        if (this.polling) this._pt = setTimeout(() => this._poll(), 8000);
        return;
      }

      const actions = lcr.actions || [];
      const beforeSeen = this._seen.size;
      this._processActions(actions);
      const added = this._seen.size - beforeSeen;
      this._log(`pollPage#${tick} actions=${actions.length} newSeen=${added} chatMode=${this._allCont ? 'all' : 'top'} ms=${Date.now()-t0}`);

      if (this.polling) {
        this._pt = setTimeout(() => this._poll(), 3000);
      }
    } catch (err) {
      console.error('YouTube page refresh:', err);
      this._log(`pollPage#${tick} EXC ${err.name}:${err.message}`);
      if (this.polling) this._pt = setTimeout(() => this._poll(), 10000);
    }
  }

  // ---- Message processing ----

  // Barva jména. Pořadí větví je stejné jako v computeAuthorNameColor na
  // YouTube: server-dodaná barva > seed color > hash z textu jména. Prvních
  // dvou polí jsme se v datech zatím nedočkali (ani na robdiesalot streamu),
  // ale jsou za A/B experimentem — když dorazí, mají přednost před hashem.
  // Diagnostiku zapisujeme jednou za connect, ať víme, která větev platí.
  _authorColor(renderer, rawName) {
    const argb = typeof renderer.authorUsernameColorDark === 'number'
      ? renderer.authorUsernameColorDark
      : (typeof renderer.authorSeedColorArgb === 'number' ? renderer.authorSeedColorArgb : null);
    const src = argb !== null ? 'data' : 'hash';
    if (this._colorSrc !== src) {
      this._colorSrc = src;
      this._log(`authorColor source=${src} sample=${rawName}`);
    }
    if (argb !== null) return '#' + ('000000' + (argb & 0xffffff).toString(16)).slice(-6);
    return ytNameColor(rawName);
  }

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

      // YouTube dává do simpleText handle včetně '@' ("@nekdo"). Zobrazovat
      // zavináč je zbytečné a navíc rozbíjel lookupy: _chatUsers klíč byl
      // "youtube:@nekdo", zatímco mention regex i autocomplete hledají jméno
      // bez něj. Strippujeme hned na vstupu, ať je jméno všude stejné.
      const rawName = renderer.authorName?.simpleText || 'Unknown';
      const username = rawName.replace(/^@/, '') || rawName;
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
        color: isSuperChat ? '#ffd600' : this._authorColor(renderer, rawName),
        badges,
        timestamp: Math.floor(Number(renderer.timestampUsec) / 1000) || Date.now(), // čas z YouTube (µs → ms)
        id,
        superChat: isSuperChat
      });
    }
  }

  disconnect(internal) {
    if (this.polling || this._pt || this._videoId) {
      this._log(`disconnect internal=${!!internal} wasPolling=${this.polling} hadTimer=${!!this._pt} videoId=${this._videoId || 'null'} seenSize=${this._seen.size}`);
    }
    this.polling = false;
    if (this._pt) { clearTimeout(this._pt); this._pt = null; }
    if (this._es) { this._es.close(); this._es = null; }
    this._cont = null;
    this._allCont = null;
    this._colorSrc = null;
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
    this.emotes = new EmoteManager({
      log: (tag, text) => this._ucLog(tag, text),
      assetUrl: (p) => chrome.runtime.getURL(p),
    });
    this.nicknames = new NicknameManager();
    this.twitch = new TwitchProvider({ log: (tag, text) => this._ucLog(tag, text) });
    this.kick = new KickProvider({ log: (tag, text) => this._ucLog(tag, text) });
    this._kickSubBadges = []; // Kick per-channel subscriber badge tiers
    this.youtube = new YouTubeProvider();
    this.autoScroll = true;
    this.filters = { twitch: true, youtube: true, kick: true };
    this.activePlatform = null;
    // Jediný držitel dat zpráv (extension/core/chat-store.js přes core-bridge). Historie jde ze
    // serveru (/chat/history), lokální cache i scrape zmizely ve v3.39.
    this.store = new ChatStore();
    // DOM okno: v chatu je naživo max ~300 uzlů. Co vypadne nahoře/dole, se
    // zaparkuje (odpojené uzly), ať jde scrollem vrátit bez znovurenderu.
    this.DOM_WINDOW = 300;
    this._parkedTop = [];     // odpojené uzly nad oknem (nejstarší první)
    this._parkedBottom = [];  // odpojené uzly pod oknem (nejstarší první)
    this._prependCursor = null; // při dotahování starší historie: před co vkládat
    this._bootLoading = false;
    this._historyBusy = false;
    this._historyCooldownUntil = 0;
    this._historyFetches = 0;
    this._twitchBadges = {};
    this._chatUsers = new Map();  // username → { name, platform, color }
    this._optimisticKeys = new Map();  // contentKey → sentId (párování optimistická ↔ echo)
    this._platformUsernames = {}; // per-platform username tracking (loaded from config in _init)
    this._isModOnChannel = false; // viewer has moderator/broadcaster badge on current Twitch channel
    this._platformColors = {};    // per-platform user color (from IRC/API)
    this._syncedProfiles = new Set(); // platform:username pairs already synced with API
    this._seCommands = [];        // StreamElements bot commands (for ! autocomplete)
    this._ucCommands = [];        // chat commandy ze Židolišty (backend GET /commands) — jméno = spouštěč bez '!', roles, source
    this._ucCommandsTimer = null;
    this._msgHistory = [];         // sent message history (newest last)
    this._msgHistoryIdx = -1;      // -1 = not browsing, 0..N = position from end
    this._msgHistoryDraft = '';    // unsent text before browsing history

    // Connect port to background — tracks panel open/close state
    // Port auto-disconnects when panel closes (background detects via onDisconnect)
    const _port = chrome.runtime.connect({ name: 'sidepanel' });
    _port.onMessage.addListener((msg) => {
      if (msg.type === 'CLOSE') window.close();
    });

    window.addEventListener('beforeunload', () => {
      this.nicknames?.disconnect();
    });

    this.chatEl = document.getElementById('chat');
    this.scrollBtn = document.getElementById('btn-scroll');
    this.msgInput = document.getElementById('msg-input');
    this.sendBtn = document.getElementById('btn-send');
    this.platformBadge = document.getElementById('active-badge');
    this._initEmotePicker();
    this._initSoundboard();
    this._initQrDono();

    // Boot instrumentation: every _bootMark() logs ms since this timestamp,
    // pushed to background (persisted to chrome.storage.session) so the log
    // survives even if the side panel freezes or the service worker sleeps.
    this._bootT0 = performance.now();
    this._bootLastT = this._bootT0;
    this._bootPending = true;
    this._bootMark('sidepanel.js instantiated');
    // Escape hatch: when the panel UI locks up, devtools console still runs.
    // Type `ucDump()` in the side-panel devtools (right-click → Inspect) to
    // force a log dump without needing the 💾 button to respond.
    try { window.ucDump = () => this._dumpLogs(); } catch {}

    this._init();
  }

  _bootMark(label, extra) {
    const now = performance.now();
    const sinceStart = Math.round(now - this._bootT0);
    const sinceLast = Math.round(now - this._bootLastT);
    this._bootLastT = now;
    let mem = '';
    try {
      if (performance.memory) {
        const mb = (performance.memory.usedJSHeapSize / 1048576).toFixed(1);
        mem = ` heap=${mb}MB`;
      }
    } catch {}
    const line = `+${sinceStart}ms (Δ${sinceLast}ms)${mem} ${label}${extra ? ' ' + extra : ''}`;
    console.log('[UC boot]', line);
    try {
      chrome.runtime.sendMessage({ type: 'UC_LOG', tag: 'Boot', text: line }).catch(() => {});
    } catch {}
  }

  /** Tlačítko emotů v poli pro psaní → sdílený picker z core (emote-picker.js), stejný jako na webu. */
  _initEmotePicker() {
    const core = window.UC_CORE;
    const btn = document.getElementById('btn-emotes');
    if (!btn || !core?.createEmotePicker) return;
    btn.innerHTML = core.EMOTE_BUTTON_SVG;
    this._emotePicker = core.createEmotePicker({
      host: document.getElementById('input-area'),
      button: btn,
      textarea: this.msgInput,
      emotes: this.emotes,
      recent: {
        load: () => JSON.parse(localStorage.getItem('uc_recent_emotes') || '[]'),
        save: (list) => localStorage.setItem('uc_recent_emotes', JSON.stringify(list)),
      },
      log: (tag, text) => this._ucLog(tag, text),
    });
  }

  /** Dev mode (pamatuje se v configu): nástroje, editace jména; QR dono ukáže i u kanálu bez darů. */
  _applyDevMode(on) {
    document.getElementById('dev-tools')?.classList.toggle('hidden', !on);
    const un = document.getElementById('input-username');
    if (un) un.readOnly = !on;
    document.body.classList.toggle('uc-dev', on);
    this._updateQrAvailability();
  }

  /** QR dono jen pro přihlášené, u kanálu s dary (body.uc-dono) nebo v Dev mode. */
  _updateQrAvailability() {
    const b = document.body.classList;
    const on = this._signedIn === true && (b.contains('uc-dono') || b.contains('uc-dev'));
    this._qdDock?.setAvailable(on);
    if (!on) this._qd?.close?.();
  }

  /** QR dono tlačítko jen u kanálu, kde má streamer v Židolištce nastavené dary (body.uc-dono). */
  async _refreshDonoAvailability() {
    const ch = (this.config.channel || '').toLowerCase();
    let on = false;
    try {
      const c = await this._donateApi().config();
      on = !!(c?.enabled && (c.currencies ? Object.keys(c.currencies).length : c.iban));
    } catch (e) { this._ucLog('QrDono', `dostupnost fail ${e?.error || e}`); }
    if (ch !== (this.config.channel || '').toLowerCase()) return; // mezitím přepnutý kanál
    document.body.classList.toggle('uc-dono', on);
    this._updateQrAvailability();
    this._ucLog('QrDono', `${ch}: ${on ? 'dary zapnuté' : 'bez darů'}`);
  }

  /** Volání backendu s Bearer session; chyba = throw objekt z JSON odpovědi ({error, …}). */
  async _ucApi(path, { method = 'GET', body } = {}) {
    const token = await this._ucSessionToken();
    const headers = { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const r = await fetch(`${UC_API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', signal: AbortSignal.timeout(15000) });
    let j = {};
    try { j = await r.json(); } catch {}
    if (!r.ok || j.ok === false) throw { ...j, error: j.error || `HTTP ${r.status}`, status: r.status };
    return j;
  }

  /** API QR dona + ověření e-mailu (backend proxy na Židolištu, spec 2026-09-25-qr-dono). */
  _donateApi() {
    const channel = () => (this.config.channel || '').toLowerCase();
    return {
      config: () => this._ucApi(`/donate/config?channel=${encodeURIComponent(channel())}`),
      testToken: (token) => this._ucApi('/donate/test-token', { method: 'POST', body: { channel: channel(), token } }),
      createIntent: (b) => this._ucApi('/donate/intents', { method: 'POST', body: { ...b, channel: channel(), platform: this.activePlatform } }),
      intentStatus: (id) => this._ucApi(`/donate/intents/${encodeURIComponent(id)}`),
      profile: () => this._ucApi('/account/profile'),
      emailStart: (email) => this._ucApi('/account/email/start', { method: 'POST', body: { email } }),
      emailVerify: (code) => this._ucApi('/account/email/verify', { method: 'POST', body: { code } }),
    };
  }

  /** QR dono + email v nastavení (pro všechny od 3.41.1, dřív jen Dev mode). */
  _initQrDono() {
    const core = window.UC_CORE;
    if (this._qd || !core?.createQrDono) return;
    const btn = document.getElementById('btn-qrdono');
    if (!btn) return;
    const api = this._donateApi();
    this._qd = core.createQrDono({
      // Kotva nad řádkem s body i nad polem → panel se otevře nad nimi, ať je tlačítko kdekoli.
      host: document.getElementById('qd-anchor'),
      button: btn,
      api,
      identity: () => {
        const id = this._identity(this.activePlatform);
        return id ? { platform: this.activePlatform, name: id.displayName || id.login } : null;
      },
      onLogin: () => this._openLoginModal(),
      currency: {
        load: () => { try { return localStorage.getItem('uc_qd_currency'); } catch { return null; } },
        save: (v) => { try { localStorage.setItem('uc_qd_currency', v); } catch {} },
      },
      log: (tag, text) => this._ucLog(tag, text),
    });
    const slot = document.getElementById('email-settings');
    if (slot && core.createEmailSettings) {
      this._emailSettings = core.createEmailSettings({ container: slot, api, onChange: () => this._qd?.refreshIdentity?.(), log: (tag, text) => this._ucLog(tag, text) });
    }
    // Pozice tlačítka podle šířky chatu: > 500 px v poli vedle noty, jinak v řádku nad polem.
    const row = document.getElementById('tw-credits');
    if (row && core.createToolDock) {
      this._qdDock = core.createToolDock({
        button: btn, row, container: document.body, breakpoint: 500,
        inlineParent: document.querySelector('#input-area .msg-input-wrap'),
        inlineBefore: document.getElementById('btn-sfx'),
        rowHasOther: () => !document.body.classList.contains('uc-no-twitch-login')
          && [...row.querySelectorAll('.tc-pill')].some((p) => !p.classList.contains('hidden')),
      });
      // Pill bodů/bitů se objeví nebo zmizí → řádek otevřít/zavřít.
      new MutationObserver(() => this._qdDock.update()).observe(row, { subtree: true, attributes: true, attributeFilter: ['class'] });
      this._updateQrAvailability();
    }
    this._ucLog('QrDono', 'zapnuto');
    this._refreshDonoAvailability();
  }

  /** Soundboard sound efektů (sdílený core/soundboard.js): tlačítko s notou v poli pro psaní. */
  _initSoundboard() {
    const core = window.UC_CORE;
    const btn = document.getElementById('btn-sfx');
    if (!btn || !core?.createSoundboard) return;
    this._sfx = core.createSoundboard({
      host: document.getElementById('input-area'),
      button: btn,
      // Klik na zvuk = `!se <jméno>` vlastním účtem diváka, stejnou cestou jako psaní (command → bez markeru).
      onSend: (s) => this._sendMessage({ text: `!se ${s.name}` }),
      onFavorite: async (soundId, on) => {
        const token = await this._ucSessionToken();
        const r = await fetch(`${UC_API}/soundboard/favorites`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ channel: (this.config.channel || '').toLowerCase(), soundId, on }),
        });
        this._ucLog('Sfx', `favorite ${soundId} ${on} → ${r.status}`);
        if (!r.ok) throw new Error(`favorites ${r.status}`);
      },
      // Nepřihlášený → sekce účtu; přihlášený bez účtu na aktivní platformě → rovnou připojit tu platformu.
      onLogin: (platform) => {
        if (platform && this._account) this._loginPlatform(platform);
        else this._openLoginModal();
      },
      volume: {
        load: () => { try { return Number(localStorage.getItem('uc_sfx_volume') ?? 0.6); } catch { return 0.6; } },
        save: (v) => { try { localStorage.setItem('uc_sfx_volume', String(v)); } catch {} },
      },
      log: (tag, text) => this._ucLog(tag, text),
    });
  }

  /** Stav soundboardu pro aktivní platformu + kanál (GET /soundboard, Bearer volitelně). */
  async _loadSoundboard() {
    if (!this._sfx) return;
    const platform = this.activePlatform;
    const channel = (this.config.channel || '').toLowerCase();
    const seq = (this._sfxSeq = (this._sfxSeq || 0) + 1);
    if (!platform || !channel) { this._sfx.update(null); return; }
    try {
      const token = await this._ucSessionToken();
      const r = await fetch(`${UC_API}/soundboard?channel=${encodeURIComponent(channel)}&platform=${platform}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store',
      });
      if (seq !== this._sfxSeq) return;   // mezitím přišel novější požadavek
      if (!r.ok) {
        this._ucLog('Sfx', `load ${channel}/${platform} → ${r.status}`);
        if (r.status === 404) this._sfx.update(null);   // kanál bez soundboardu → tlačítko schované
        return;
      }
      const j = await r.json();
      this._sfx.update(j);
      this._ucLog('Sfx', `load ${channel}/${platform} sounds=${j.sounds?.length ?? 0} loggedIn=${!!j.loggedIn} me=${j.me ? `${j.me.role} tiers=${j.me.tiers?.length ?? 0}` : 'null'}`);
    } catch (e) { this._ucLog('Sfx', `load FAIL ${e.message || e}`); }
  }

  async _init() {
    // Verze v titulku.
    const ver = chrome.runtime.getManifest().version;
    const title = document.getElementById('header-title');
    title.innerHTML =
      `<span class="hdr-logo-wrap" id="hdr-logo-wrap">
        <img src="icons/icon48.png" class="hdr-logo" alt="UnityChat">
      </span> UnityChat <span class="hdr-ver">v${ver}</span> <span class="hdr-beta">[BETA]</span>`;

    this._bootMark('_init start');
    // Arm background watchdog — if _bootMark('_init done') never arrives,
    // background auto-dumps the log at +20s. This survives a frozen side
    // panel because dump runs in the service worker context.
    try { chrome.runtime.sendMessage({ type: 'BOOT_WATCH_START' }).catch(() => {}); } catch {}
    await this._loadConfig();
    this._applyBarCollapsed(this.config.barCollapsed === true);
    // Dev mode se pamatuje v configu (QR dono, email účtu) — listenery se napojují dřív než config.
    { const dm = document.getElementById('chk-devmode'); if (dm) dm.checked = this.config.devMode === true; this._applyDevMode(this.config.devMode === true); }
    this._bootMark('config loaded', `channel=${this.config.channel} roomId=${this.config._roomId || '—'}`);
    await this._pickBootStreamer();
    this._bootMark('streamer picked', `channel=${this.config.channel} roomId=${this.config._roomId || '—'}`);
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
    this._bootMark('user colors hydrated', `size=${this._chatUsers.size}`);
    await this.nicknames.loadCache();
    this._bootMark('nicknames cache loaded');
    this.nicknames.fetchAll();  // non-blocking, fire-and-forget
    this.nicknames.connectSSE();
    this.nicknames.onChange = (d) => this._onNicknameChange(d);
    this.nicknames.onAnnouncement = (a) => { if (a?.channel === (this.config.channel || '').toLowerCase()) this._addAnnouncement(a); };
    // Reakce „Peepo poop": SSE → přehrát; tlačítko u zpráv řídí body třídy (role + běžící reakce).
    this._reactionSeen = new Set();
    this._activeReaction = null;
    this.nicknames.onReaction = (ev) => this._playReaction(ev);
    setInterval(() => this._updatePoopButtons(), 5000);
    fetch(`${UC_API}/reactions/active?channel=${encodeURIComponent((this.config.channel || '').toLowerCase())}`, { cache: 'no-store' })
      .then((r) => r.json()).then((j) => { if (j?.active) this._playReaction(j.active); }).catch(() => {});
    // Předehrát video do cache (fetch by bez host_permission pro robdiesalot.com neprošel, <video> ano).
    { const v = document.createElement('video'); v.preload = 'auto'; v.muted = true; v.src = POOP_VIDEO_URL; v.load(); this._poopPreload = v; }
    this.nicknames.onCommandsChange = (d) => { if (!d?.channel || d.channel === (this.config.channel || '').toLowerCase()) this._loadUcCommands().catch(() => {}); };
    this.nicknames.onSoundboard = (type, d) => {
      if (d?.channel && d.channel !== (this.config.channel || '').toLowerCase()) return;
      // Změnu dostanou všichni diváci naráz → refetch rozprostřít do 0–3 s (backend volá Židolištu z jedné IP).
      if (type === 'soundboard-change') { clearTimeout(this._sfxRefetchTimer); this._sfxRefetchTimer = setTimeout(() => this._loadSoundboard(), Math.random() * 3000); }
      else this._sfx?.onSse(type, d);
    };
    this.nicknames.onUcMark = (d) => this._applyUcMark(d);
    this.nicknames.onUcReply = (d) => this._applyUcReply(d);
    // Všichni diváci naráz → rozprostřít 0–2 s (backend se ptá Židolišty z jedné IP).
    this.nicknames.onDonateConfigChange = (d) => {
      if (d?.channel && d.channel !== (this.config.channel || '').toLowerCase()) return;
      if (!this._qd) return;
      clearTimeout(this._qdReloadTimer);
      this._qdReloadTimer = setTimeout(() => { this._qd?.reloadConfig?.(); this._refreshDonoAvailability(); }, Math.random() * 2000);
      this._ucLog('QrDono', 'donate-config-change → reload');
    };   // id zprávy je jednoznačné, kanál netřeba
    this.nicknames.onBlacklistChange = (d) => { if (!d?.channel || d.channel === (this.config.channel || '').toLowerCase()) this._loadBlacklist().catch(() => {}); };
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
    this._bootMark('UI setup done');
    this._setupProviders();
    this._bootMark('providers set up');

    // Auto-detekce username z aktivního tabu PŘED cache renderem
    if (!this.config.username) {
      try {
        const tab = await this._findStreamTab();
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
    this._bootMark('username detection done', `username=${this.config.username || '—'}`);

    // Load emotes + badges FIRST so cached messages render with correct emotes/badges.
    // Use Promise.allSettled — one failing source shouldn't block the rest.
    try {
      this.emotes.loadTwitchGlobals();
      await this.emotes.loadGlobal();
      this._bootMark('7TV globals loaded', `size=${this.emotes.global7tv?.size ?? 0}`);
      if (this.config._roomId) {
        const results = await Promise.allSettled([
          this.emotes.loadChannel('twitch', this.config._roomId),
          this.emotes.loadBTTV(this.config._roomId),
          this.emotes.loadFFZ(this.config._roomId),
          this.emotes.loadTwitchChannel(this.config.channel),
          this._loadTwitchBadges(this.config._roomId)
        ]);
        const rej = results.filter(r => r.status === 'rejected').length;
        this._bootMark('channel emotes+badges loaded',
          `7tv=${this.emotes.channel7tv?.size ?? 0} bttv=${this.emotes.bttvEmotes?.size ?? 0} ffz=${this.emotes.ffzEmotes?.size ?? 0} rejected=${rej}`);
      }
    } catch (e) {
      this._bootMark('emote load threw', String(e?.message || e));
    }

    // Load SE bot commands in background (for ! autocomplete)
    this._loadSECommands().catch(() => {});
    this._loadUcCommands().catch(() => {});
    // Blacklist slov ještě před historií, ať se nic neukáže necenzurované (fetch má timeout 8 s).
    await this._loadBlacklist().catch(() => {});

    // Spinner up before any heavy work — it covers cache hydration + the
    // first round of provider connects. Cleared on first rendered message,
    // when all configured platforms reach a terminal state, or after 8s.
    this._showLoading();

    // v3.39: lokální cache zpráv nahradil server. Staré klíče uklidit jednou.
    try {
      const all = await chrome.storage.local.get(null);
      const stale = Object.keys(all).filter((k) => k.startsWith('uc_messages'));
      if (stale.length) await chrome.storage.local.remove(stale);
    } catch {}
    await this._loadHistory();
    this._fillMsgHistoryFromStore();
    this._bootMark('history loaded', `rendered=${this.chatEl?.children.length ?? 0} store=${this.store.length}`);
    this._connectAll();
    this._bootMark('_connectAll dispatched');
    this._detectLoop();
    // Background broadcast listener (Twitch redeems/highlights/credits, plus
    // the self-update badge in non-store builds).
    this._wireBackgroundUpdateListener();
    // Hover/click preview card for emotes inside chat messages.
    this._setupEmotePreview();
    this._scheduleColorRevalidation();
    this._pullCredits();
    // GQL-backed pin polling. Twitch's highlight stack can unmount when
    // chat column is zero-width (hide-not-collapse), so DOM mirror misses
    // pin cards entirely. FETCH_PINS pulls pinned messages straight from
    // the server — works regardless of chat UI visibility.
    this._startPinPoll();
    try { const r = await chrome.storage.local.get('uc_send_platform'); if (['twitch', 'kick', 'youtube'].includes(r.uc_send_platform)) this._sendPlatform = r.uc_send_platform; } catch {}
    if (!this._sendPlatform) this._sendPlatform = 'twitch';
    if (!this._legacySend()) this._setActivePlatform(this._sendPlatform);
    this._refreshAccount();
    this._bootMark('_init done');
    this._bootPending = false;
    try { chrome.runtime.sendMessage({ type: 'BOOT_WATCH_END' }).catch(() => {}); } catch {}
  }


  // Background broadcasts for panel-wide state.
  _wireBackgroundUpdateListener() {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'TW_REDEEM_DOM' && msg.data) {
        this._handleDomRedeem(msg.data);
      } else if (msg?.type === 'TW_HIGHLIGHTS') {
        this._handleHighlights(msg);
      } else if (msg?.type === 'TW_CREDITS' && msg.data) {
        this._handleCredits(msg.data);
      } else if (msg?.type === 'TW_POINTS_DELTA' && msg.amount) {
        // Twitch fired a floating "+N" reward animation — content script
        // caught it from DOM mutations. We just flash the amount.
        this._flashPointsDelta(msg.amount);
      }
    });
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
    // Reply context on one line (ellipsis) — CSS-only toggle
    const rolBox = $('chk-reply-oneline');
    if (rolBox) {
      rolBox.checked = this.config.replyOneLine === true;
      this._applyReplyOneLine();
      rolBox.addEventListener('change', () => {
        this.config.replyOneLine = rolBox.checked;
        this._saveConfig();
        this._applyReplyOneLine();
      });
    }
    // Po animaci reakce zpět na konec chatu
    const rsbBox = $('chk-reaction-scrollback');
    if (rsbBox) {
      rsbBox.checked = this.config.reactionScrollBack !== false;
      rsbBox.addEventListener('change', () => {
        this.config.reactionScrollBack = rsbBox.checked;
        this._saveConfig();
      });
    }
    // Zvuky (reakce se zvukem) — běžící reakce se ztlumí/odtlumí hned
    const sndBox = $('chk-sound');
    if (sndBox) {
      sndBox.checked = this.config.sound !== false;
      sndBox.addEventListener('change', () => {
        this.config.sound = sndBox.checked;
        this._saveConfig();
        this._reaction?.setMuted?.(!sndBox.checked);
      });
    }
    // Auto-resize textarea + auto @username suggest
    this.msgInput.addEventListener('input', () => {
      this._autoResizeInput();

      // Auto-trigger @username autocomplete while typing
      const text = this.msgInput.value;
      const pos = this.msgInput.selectionStart;
      // Find the word being typed
      let ws = pos;
      while (ws > 0 && text[ws - 1] !== ' ') ws--;
      const partial = text.substring(ws, pos);
      if (partial.startsWith('@') && partial.length >= 2) {
        const matches = this._acUserMatches(partial.substring(1).toLowerCase());
        if (matches.length) {
          this._ac = { start: ws, end: pos, index: 0, matches };
          this._acRender();
        } else {
          this._acHide();
        }
      } else if (partial.startsWith('!') && partial.length >= 2 && ws === 0) {
        // !command autocomplete (only at start of message)
        const prefix = partial.substring(1).toLowerCase();
        const role = this._myChatRole();
        const matches = [...new Set(this._allBangCommands()
          .filter(c => c.name.toLowerCase().startsWith(prefix))
          .filter(c => !Array.isArray(c.roles) || !c.roles.length || c.roles.includes(role))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(c => '!' + c.name))];
        if (matches.length) {
          this._ac = { start: ws, end: pos, index: 0, matches };
          this._acRender();
        } else {
          this._acHide();
        }
      } else if (text === '/uc' || (text.startsWith('/uc ') && ws <= 4)) {
        // /uc subcommand autocomplete — shows the full list as soon as
        // the user finishes typing "/uc" (before the space) and filters
        // as they continue with "/uc r…".
        const UC_CMDS = [
          'raid', 'raider', 'first', 'sus',
          'announcement', 'ann',
          'sub', 'resub', 'prime', 'sub2', 'sub3',
          'subgift', 'giftbundle',
          'command', 'redeem', 'highlight', 'annc',
          'milestone', 'streak',
          'timeout', 'ban', 'delete',
          'claim', 'points10', 'points50',
          'raidbanner',
          'pin',
        ];
        const prefix = (text === '/uc' ? '' : partial).toLowerCase();
        const matches = (prefix ? UC_CMDS.filter((c) => c.startsWith(prefix)) : UC_CMDS).map((c) => '/uc ' + c);
        if (matches.length) {
          this._ac = { start: 0, end: pos, index: 0, matches, _type: 'uc' };
          this._acRender();
        } else {
          this._acHide();
        }
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
      this._dumpLogs();
    });
    $('btn-bar').addEventListener('click', () => {
      this.config.barCollapsed = !(this.config.barCollapsed === true);
      this._saveConfig();
      this._applyBarCollapsed(this.config.barCollapsed);
    });
    $('btn-settings').addEventListener('click', () => {
      const opening = $('settings').classList.toggle('hidden') === false;
      if (opening) this._refreshAccount();
    });
    // Pole pro psaní (jako web): badge + šipka → menu „Psát jako", bez přihlášení výzva.
    $('platform-btn').addEventListener('click', (e) => { e.stopPropagation(); this._togglePlatformMenu(); });
    document.addEventListener('click', (e) => { if (!$('platform-menu').contains(e.target)) this._closePlatformMenu(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this._closePlatformMenu(); });
    $('login-cta').addEventListener('click', () => this._openLoginModal());
    // Záloha: stará cesta přes otevřenou kartu (dev mode).
    $('chk-legacy-send').checked = this._legacySend();
    $('chk-legacy-send').addEventListener('change', () => {
      this.config.legacyTabSend = $('chk-legacy-send').checked;
      this._saveConfig();
      this._ucLog('Send', `režim: ${this.config.legacyTabSend ? 'otevřená karta (záloha)' : 'účet'}`);
      if (this.config.legacyTabSend) this._detectActivePlatform();
      else this._setActivePlatform(this._sendPlatform);
      this._renderComposer();
    });

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
              if (newNick) { un.textContent = this._censorName(newNick); un.title = uname; }
              else { un.textContent = this._censorName(uname); un.title = ''; }
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

    // Reload ikona v hlavičce = dřívější „Připojit": uloží kanály z inputů
    // a znovu připojí vše. „Odpojit" a „Vyčistit chat" zrušeny (v3.38.72).
    $('btn-reconnect').addEventListener('click', () => {
      this.config.channel = $('input-channel').value.trim();
      this.config.kickChannel = $('input-kick-channel').value.trim();
      this.config.ytChannel = $('input-yt-channel').value.trim();
      this.config.username = $('input-username').value.trim();
      this._saveConfig();
      this._disconnectAll();
      this.emotes.channel7tv.clear();
      this._connectAll();
    });



    // Dev mode
    $('chk-devmode').checked = this.config.devMode === true;
    this._applyDevMode(this.config.devMode === true);
    $('chk-devmode').addEventListener('change', () => {
      const on = $('chk-devmode').checked;
      this.config.devMode = on;
      this._saveConfig();
      this._applyDevMode(on);
    });
    $('btn-dump-cache').addEventListener('click', () => {
      // Dump dat zpráv ze store (in-memory; historie jde ze serveru).
      {
        const json = JSON.stringify(this.store.slice(), null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'unitychat-message-store.json';
        a.click();
        URL.revokeObjectURL(url);
      }
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
      this._resetChat();
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
      // Nahoru: nejdřív zaparkované uzly, pak starší stránka ze serveru.
      if (el.scrollTop < 200) this._extendUp();
      // Dolů: vrátit zaparkované uzly zpod okna.
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 200 && this._parkedBottom.length) this._extendDown();
    });
    this.scrollBtn.addEventListener('click', () => {
      this._jumpToLatest();
    });

    // Ruční přepnutí streamera (nabídka nad chatem)
    const switchBtn = $('btn-switch-streamer');
    if (switchBtn) {
      switchBtn.addEventListener('click', () => {
        if (this._offeredRecord) this._switchToStreamer(this._offeredRecord);
      });
    }

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
          // Potvrdit výběr — kurzor je už za doplněným textem, jen zavřít
          // suggest list.
          e.preventDefault();
          this._acHide();
          return;
        }
        if (e.key === 'Enter') {
          // Enter potvrdí JEN pro @username autocomplete (chat-app pattern).
          // Pro emote / !cmd / /uc autocomplete propadne dolů na _sendMessage
          // (původní funkcionalita — Tab/ArrowRight už emote vložilo,
          // Enter logicky odešle zprávu).
          const isUserAc = this._ac.kind === 'user'
            || this._ac.matches[0]?.startsWith?.('@');
          if (isUserAc) {
            e.preventDefault();
            this._acHide();
            return;
          }
          // Fall through — emote/cmd autocomplete: Enter sends message
        }
      }
      // Message history (ArrowUp/Down). Multi-line draft / history zpráva:
      // šipka prvně posouvá kurzor v textu, teprve při dosažení okraje
      // (první řádek pro Up, poslední pro Down) přepíná historii.
      if (e.key === 'ArrowUp' && !this._ac && this._msgHistory.length) {
        const idxBefore = this._msgHistoryIdx;
        const isFirst = this._isCursorOnFirstLine();
        this._logCursor({ key: 'ArrowUp', idxBefore, isFirst, willSwitch: isFirst, sel: this.msgInput.selectionStart });
        if (!isFirst) return; // native cursor-up
        e.preventDefault();
        if (this._msgHistoryIdx === -1) {
          this._msgHistoryDraft = this.msgInput.value;
          this._msgHistoryIdx = this._msgHistory.length - 1;
        } else if (this._msgHistoryIdx > 0) {
          this._msgHistoryIdx--;
        }
        this.msgInput.value = this._msgHistory[this._msgHistoryIdx];
        this._autoResizeInput();
        this.msgInput.setSelectionRange(0, 0);
        this._logCursor({ key: 'ArrowUp', phase: 'after', idxAfter: this._msgHistoryIdx, valueLen: this.msgInput.value.length, sel: this.msgInput.selectionStart });
        return;
      }
      if (e.key === 'ArrowDown' && !this._ac && this._msgHistoryIdx !== -1) {
        const idxBefore = this._msgHistoryIdx;
        const isLast = this._isCursorOnLastLine();
        this._logCursor({ key: 'ArrowDown', idxBefore, isLast, willSwitch: isLast, sel: this.msgInput.selectionEnd });
        if (!isLast) return; // native cursor-down
        e.preventDefault();
        if (this._msgHistoryIdx < this._msgHistory.length - 1) {
          this._msgHistoryIdx++;
          this.msgInput.value = this._msgHistory[this._msgHistoryIdx];
        } else {
          this._msgHistoryIdx = -1;
          this.msgInput.value = this._msgHistoryDraft;
        }
        this._autoResizeInput();
        const len = this.msgInput.value.length;
        this.msgInput.setSelectionRange(len, len);
        this._logCursor({ key: 'ArrowDown', phase: 'after', idxAfter: this._msgHistoryIdx, valueLen: this.msgInput.value.length, sel: this.msgInput.selectionEnd });
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
    this._updateBarDot();
  }

  /** Souhrnná tečka v hlavičce: zelená = aspoň jedna platforma připojená, žlutá = žádná, ale
   *  některá se připojuje, červená = všechny odpojené. Vypnuté platformy se nepočítají. */
  _updateBarDot() {
    const dot = document.querySelector('#btn-bar .dot');
    if (!dot) return;
    const dots = ['twitch', 'youtube', 'kick'].map((p) => document.querySelector(`#st-${p} .dot`)).filter((d) => d && !d.classList.contains('disabled'));
    const state = dots.some((d) => d.classList.contains('connected')) ? 'connected'
      : dots.some((d) => d.classList.contains('connecting')) ? 'connecting' : 'error';
    dot.className = `dot ${state}`;
  }

  _applyBarCollapsed(collapsed) {
    document.getElementById('bar')?.classList.toggle('collapsed', collapsed);
    const b = document.getElementById('btn-bar');
    if (b) {
      b.setAttribute('aria-expanded', String(!collapsed));
      b.title = collapsed ? 'Připojení platforem — rozbalit řádek' : 'Připojení platforem — sbalit řádek';
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
      matches = this._acUserMatches(partial.substring(1).toLowerCase());
    } else {
      // Emote autocomplete — honors the per-session "Fulltext" toggle
      matches = this.emotes.findCompletions(partial, { fulltext: this.config.acFulltext === true });
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
    const next = this.emotes.findCompletions(ac.prefix, { fulltext: this.config.acFulltext === true });
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

  // Návrhy pro @autocomplete. Uživatel s UC přezdívkou se nabízí pod ní —
  // skutečný login nikde v panelu nevidí, takže by ho neuměl napsat. Zpátky
  // na login se mention přeloží až při odeslání (_resolveNicknameMentions).
  // Mapa drží každého pod dvěma klíči (plain + platform:username), proto se
  // berou jen plain klíče a deduplikuje se podle zobrazeného jména.
  _acUserMatches(prefix) {
    const seen = new Set();
    const names = [];
    for (const [key, u] of this._chatUsers) {
      if (key.includes(':')) continue;
      const login = (u.name || '').replace(/^@/, '');
      if (!login) continue;
      const display = this.nicknames?.getNickname(u.platform, login) || login;
      const lower = display.toLowerCase();
      if (seen.has(lower)) continue;
      // Hledá se i podle skutečného loginu — kdo ho zná (třeba z tooltipu),
      // najde uživatele i tak.
      if (prefix && !lower.startsWith(prefix) && !login.toLowerCase().startsWith(prefix)) continue;
      seen.add(lower);
      names.push(display);
    }
    return names.sort((a, b) => a.localeCompare(b)).map((n) => '@' + n);
  }

  // Položka v seznamu může nést přezdívku — do _chatUsers se pak dostaneme
  // až přes skutečný login.
  _acUserEntry(atName) {
    const name = atName.replace(/^@/, '').toLowerCase();
    const direct = this._chatUsers.get(name);
    if (direct) return direct;
    const login = this.nicknames?.resolveNickname(name);
    return login ? this._chatUsers.get(login.toLowerCase()) : null;
  }

  /** Zjistí zdroj emotu pro zobrazení tagu. */
  _acSource(name) {
    if (name.startsWith('/uc ')) return 'UC';
    if (name.startsWith('!')) return this._bangSources(name).join(' · ') || 'SE';
    if (name.startsWith('@')) {
      const u = this._acUserEntry(name);
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
      const checked = this.config.acFulltext === true ? ' checked' : '';
      html += `<label class="es-toggle"><input type="checkbox" id="es-fulltext"${checked}>Fulltext</label>`;
    }
    for (let i = winStart; i < winEnd; i++) {
      const name = ac.matches[i];
      const sel = i === idx ? ' selected' : '';
      html += `<div class="es-item${sel}" data-idx="${i}">`;

      if (name.startsWith('!')) {
        // Chat command: loga všech zdrojů, kde spouštěč je (Židolišta první, pak StreamElements)
        html += '<span class="es-logos">' + this._bangSources(name).map((src) => {
          const logo = src === 'Židolišta' ? 'icons/commands/zidolista.png' : 'icons/commands/streamelements.svg';
          return `<img class="es-logo${src === 'Židolišta' ? ' es-logo-zidolista' : ''}" src="${logo}" alt="${this.emotes._ea(src)}">`;
        }).join('') + '</span>';
      } else if (name.startsWith('/uc ')) {
        // UC command: oranžová tečka
        html += `<span class="es-dot" style="background:#ff8c00"></span>`;
      } else if (name.startsWith('@')) {
        // Username: barevná tečka
        const u = this._acUserEntry(name);
        const col = this.emotes._sc(
          this.nicknames?.getColor(u?.platform, u?.name) || u?.color
        ) || '#ccc';
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

    const logosBefore = this._acAnimateLogos ? this._acSnapshotLogos(el) : null;
    el.innerHTML = html;
    el.classList.remove('hidden');
    if (logosBefore) this._acAnimateLogoDiff(el, logosBefore);

    // Wire fulltext checkbox — toggles persistent flag and re-runs the
    // current search, so the panel refilters live without retyping.
    const ftBox = el.querySelector('#es-fulltext');
    if (ftBox) {
      ftBox.addEventListener('change', (e) => {
        e.stopPropagation();
        this.config.acFulltext = ftBox.checked;
        this._saveConfig();
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

  /** Před překreslením: jaká loga měl každý řádek (podle jména) — pro animaci změny zdrojů. */
  _acSnapshotLogos(el) {
    const map = new Map();
    for (const item of el.querySelectorAll('.es-item')) map.set(item.querySelector('.es-name-inner')?.textContent || '', [...item.querySelectorAll('.es-logos img')].map((i) => i.alt));
    return map;
  }

  /** Po překreslení: nová loga prolnout, odebraná nechat vyblednout na původním místě. */
  _acAnimateLogoDiff(el, before) {
    const logoFor = (alt) => alt === 'Židolišta' ? 'icons/commands/zidolista.png' : alt === 'SE' ? 'icons/commands/streamelements.svg' : null;
    for (const item of el.querySelectorAll('.es-item')) {
      const name = item.querySelector('.es-name-inner')?.textContent || '';
      const old = before.get(name);
      const box = item.querySelector('.es-logos');
      if (!old || !box) continue;
      const now = [...box.querySelectorAll('img')];
      const nowAlts = now.map((i) => i.alt);
      for (const img of now) if (!old.includes(img.alt)) img.classList.add('es-logo-in');
      old.forEach((alt, i) => {
        if (nowAlts.includes(alt) || !logoFor(alt)) return;
        const ghost = document.createElement('img');
        ghost.className = 'es-logo es-logo-out' + (alt === 'Židolišta' ? ' es-logo-zidolista' : '');
        ghost.src = logoFor(alt); ghost.alt = alt;
        box.insertBefore(ghost, box.children[i] || null);
        ghost.addEventListener('animationend', () => ghost.remove(), { once: true });
      });
    }
  }

  _acHide() {
    this._ac = null;
    const el = document.getElementById('emote-suggest');
    if (el) el.classList.add('hidden');
  }

  // ---- Cursor line detection ----

  _isCursorOnFirstLine() {
    const ta = this.msgInput;
    const dbg = { fn: 'isFirst', selStart: ta.selectionStart, valueLen: ta.value.length };
    if (ta.selectionStart === 0) { this._logCursor({ ...dbg, shortcut: 'sel===0', result: true }); return true; }
    if (!ta.value) { this._logCursor({ ...dbg, shortcut: 'empty', result: true }); return true; }
    if (ta.value.substring(0, ta.selectionStart).includes('\n')) { this._logCursor({ ...dbg, shortcut: 'hasNL', result: false }); return false; }
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
    const subH = m.offsetHeight;
    const result = subH <= lineH;
    this._logCursor({
      ...dbg, shortcut: 'mirror', result,
      lineH, subH,
      taClientW: ta.clientWidth,
      mirrorW: m.style.width,
      mirrorPad: m.style.padding,
      mirrorBox: m.style.boxSizing,
      cssPadding: cs.padding,
      cssFont: cs.font,
      substr: ta.value.substring(0, ta.selectionStart).slice(0, 60),
    });
    return result;
  }

  _logCursor(data) {
    try {
      chrome.runtime.sendMessage({
        type: 'UC_LOG', tag: 'CursorLine',
        text: JSON.stringify(data),
      }).catch(() => {});
    } catch {}
  }

  _autoResizeInput() {
    // Adjust textarea height to fit content. Cap at 250px (matches the
    // 'input' event handler that fires on user typing). Programmatic
    // value changes (history nav, send clear, /uc commands) MUST call
    // this — setting .value doesn't fire 'input' so the listener
    // wouldn't run on its own.
    this.msgInput.style.height = 'auto';
    const max = 250;
    const h = Math.min(this.msgInput.scrollHeight, max);
    this.msgInput.style.height = h + 'px';
    this.msgInput.style.overflowY = this.msgInput.scrollHeight > max ? 'auto' : 'hidden';
  }

  _isCursorOnLastLine() {
    const ta = this.msgInput;
    const dbg = { fn: 'isLast', selEnd: ta.selectionEnd, valueLen: ta.value.length };
    if (!ta.value) { this._logCursor({ ...dbg, shortcut: 'empty', result: true }); return true; }
    if (ta.selectionEnd >= ta.value.length) { this._logCursor({ ...dbg, shortcut: 'sel===len', result: true }); return true; }
    if (ta.value.substring(ta.selectionEnd).includes('\n')) { this._logCursor({ ...dbg, shortcut: 'hasNL', result: false }); return false; }
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
    m.textContent = ta.value.substring(ta.selectionEnd);
    const subH = m.offsetHeight;
    const result = subH <= lineH;
    this._logCursor({
      ...dbg, shortcut: 'mirror', result,
      lineH, subH,
      taClientW: ta.clientWidth,
      substr: ta.value.substring(ta.selectionEnd).slice(0, 60),
    });
    return result;
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

  // Najít stream tab pro detekci platformy / odesílání zpráv. Aktivní tab má
  // přednost (dosavadní chování). Když aktivní tab není platform stránka —
  // typicky UnityChat otevřený jako tab v Opera split screenu — fallback
  // URL-scan přes všechny taby: bere jen skutečné channel stránky, preferuje
  // nakonfigurovaný kanál a sticky drží naposledy aktivní platformu.
  // platform = omezit na konkrétní platformu (send path), null = libovolná.
  async _findStreamTab(platform = null) {
    const active = await this._getActiveBrowserTab();
    const activeP = active?.url ? this._detectPlatformFromUrl(active.url) : null;
    if (active && activeP && (!platform || activeP === platform)) {
      return active;
    }

    let tabs;
    try { tabs = await chrome.tabs.query({}); } catch { return null; }

    const order = ['twitch', 'kick', 'youtube'];
    let wanted;
    if (platform) {
      wanted = [platform];
    } else if (this.activePlatform && order.includes(this.activePlatform)) {
      wanted = [this.activePlatform, ...order.filter((p) => p !== this.activePlatform)];
    } else {
      wanted = order;
    }

    for (const p of wanted) {
      if (!this.config[p]) continue;
      const candidates = [];
      for (const t of tabs) {
        if (!t.url || t.id == null) continue;
        const handle = this._parseChannelFromUrl(t.url, p);
        let ok = !!handle;
        // YouTube live běží na /watch — _parseChannelFromUrl umí jen @handle
        // stránky, watch stránky přijmout bez handle (content script si poradí).
        if (!ok && p === 'youtube') {
          try {
            const u = new URL(t.url);
            ok = u.hostname.endsWith('youtube.com')
              && (u.pathname === '/watch' || u.pathname.startsWith('/live'));
          } catch {}
        }
        if (ok) candidates.push({ tab: t, handle: handle || null });
      }
      if (!candidates.length) continue;
      const configured = this._getConfiguredHandle(p);
      const match = candidates.find((c) => configured && c.handle === configured)
        || candidates[0];
      this._streamTabLog(`scan hit p=${p} handle=${match.handle || '?'} cfg=${configured || '—'} tabId=${match.tab.id} cand=${candidates.length}`);
      return match.tab;
    }
    this._streamTabLog(`scan miss platform=${platform || 'any'} active=${(active?.url || '—').slice(0, 60)}`);
    return null;
  }

  // Rate-limited StreamTab diagnostic (fallback scan běží ve 3s loopu —
  // stejná zpráva se opakuje max 1× za 15 s).
  _streamTabLog(text) {
    const now = Date.now();
    if (this._streamTabLogPrev === text && now - (this._streamTabLogLast || 0) < 15000) return;
    this._streamTabLogLast = now;
    this._streamTabLogPrev = text;
    chrome.runtime.sendMessage({ type: 'UC_LOG', tag: 'StreamTab', text }).catch(() => {});
  }

  async _detectActivePlatform() {
    try {
      const tab = await this._findStreamTab();
      if (!tab) { if (this._legacySend()) this._setActivePlatform(null); this._hideSwitchOffer(); return; }

      let resp = await chrome.tabs.sendMessage(tab.id, { type: 'PING' }).catch(() => null);

      // Pokud content script neodpovídá, zkusit ho injektovat on-demand
      if (!resp) {
        await this._injectContentScript(tab);
        resp = await chrome.tabs.sendMessage(tab.id, { type: 'PING' }).catch(() => null);
      }

      if (this._legacySend()) this._setActivePlatform(resp?.platform || null);

      // Track username per platform + persist
      if (resp?.username && resp?.platform && (this._legacySend() || !this._identity(resp.platform))) {
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

      // Nabídka přepnutí: když tab patří podporovanému streamerovi, který
      // není ten připojený, ukáže se tlačítko. Nic se nepřepíná samo.
      if (tab.url) {
        const p = resp?.platform || this._detectPlatformFromUrl(tab.url);
        if (p) this._checkSwitchOffer(p, tab.url, resp?.channelHandle).catch(() => {});
      } else {
        this._hideSwitchOffer();
      }
    } catch {
      if (this._legacySend()) this._setActivePlatform(null);
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

  // Handle z URL/tabu → záznam podporovaného streamera (nebo null).
  async _resolveSupportedStreamer(platform, tabUrl, contentHandle) {
    let handle = this._parseChannelFromUrl(tabUrl, platform);
    // YouTube /watch nemá handle v URL — bere se z content scriptu.
    if (!handle && contentHandle) handle = String(contentHandle).toLowerCase().replace(/^@/, '');
    if (!handle) return null;
    const streamer = await this._lookupStreamer(platform, handle);
    const login = (streamer?.twitchLogin || '').toLowerCase();
    if (!login || !SUPPORTED_STREAMERS.has(login)) return null;
    return streamer;
  }

  _streamerDisplay(streamer) {
    return streamer.twitchDisplayName || streamer.twitchLogin || streamer.youtubeTitle || streamer.kickDisplayName || '?';
  }

  async _checkSwitchOffer(platform, tabUrl, contentHandle) {
    if (!platform || !tabUrl || this._switching) return;
    const streamer = await this._resolveSupportedStreamer(platform, tabUrl, contentHandle);
    if (!streamer) { this._hideSwitchOffer(); return; }
    const login = streamer.twitchLogin.toLowerCase();
    if (login === (this.config.channel || '').toLowerCase()) { this._hideSwitchOffer(); return; }
    this._showSwitchOffer(streamer);
  }

  _showSwitchOffer(streamer) {
    const box = document.getElementById('switch-offer');
    const btn = document.getElementById('btn-switch-streamer');
    if (!box || !btn) return;
    const login = streamer.twitchLogin.toLowerCase();
    if (this._offeredStreamer !== login) {
      this._offeredStreamer = login;
      this._offeredRecord = streamer;
      btn.textContent = `Přepnout chat na ${this._streamerDisplay(streamer)}`;
      this._ucLog?.('Streamer', `offer ${login}`);
    }
    box.classList.remove('hidden');
  }

  _hideSwitchOffer() {
    const box = document.getElementById('switch-offer');
    if (box) box.classList.add('hidden');
    this._offeredStreamer = null;
    this._offeredRecord = null;
  }

  // Ruční přepnutí (klik na tlačítko). Bývalý auto-switch měl race: detekce
  // každé 3 s znovu vstupovala do přepínání, bumpla sekvenci a rozdělané
  // přepnutí (emoty vyčištěné, nové nenačtené, providery napůl) zrušila;
  // druhý průchod viděl config už změněný a nic neudělal → smíchané chaty a
  // špatné emoty. Tady běží jedno přepnutí najednou, bez re-entry.
  async _switchToStreamer(streamer) {
    if (this._switching) return;
    this._switching = true;
    const login = (streamer.twitchLogin || '').toLowerCase();
    this._hideSwitchOffer();
    this._ucLog?.('Streamer', `switch → ${login}`);
    try {
      this._autoSwitchSeq = (this._autoSwitchSeq || 0) + 1;
      await this._performAutoSwitch(streamer, this._autoSwitchSeq, login);
    } catch (e) {
      this._sys(`Přepnutí selhalo: ${e.message}`);
      this._hideSwitchBanner();
    } finally {
      this._switching = false;
    }
  }

  // Při startu: podporovaný streamer na aktivním tabu vyhrává, jinak Rob.
  // Nastavuje jen config (nic ještě neběží), samotné načtení udělá _init.
  async _pickBootStreamer() {
    let target = null;
    try {
      const tab = await this._findStreamTab();
      if (tab?.url) {
        const platform = this._detectPlatformFromUrl(tab.url);
        let contentHandle = null;
        if (platform === 'youtube') {
          const resp = await chrome.tabs.sendMessage(tab.id, { type: 'PING' }).catch(() => null);
          contentHandle = resp?.channelHandle || null;
        }
        if (platform) target = await this._resolveSupportedStreamer(platform, tab.url, contentHandle);
      }
    } catch {}
    if (!target) {
      target = await this._lookupStreamer('twitch', PRIMARY_STREAMER).catch(() => null)
        || { twitchLogin: PRIMARY_STREAMER, twitchUserId: '160028137', youtubeHandle: PRIMARY_STREAMER, kickSlug: PRIMARY_STREAMER };
    }
    const before = `${this.config.channel}/${this.config.ytChannel}/${this.config.kickChannel}`;
    this.config.channel = target.twitchLogin || '';
    this.config.ytChannel = target.youtubeHandle || '';
    this.config.kickChannel = target.kickSlug || '';
    if (target.twitchUserId) this.config._roomId = target.twitchUserId;
    else if (before.split('/')[0] !== this.config.channel) this.config._roomId = null;
    this._saveConfig();
    this._refreshSettingsInputs();
    this._ucLog?.('Streamer', `boot ${before} → ${this.config.channel}/${this.config.ytChannel}/${this.config.kickChannel} roomId=${this.config._roomId || '-'}`);
  }

  _ucLog(tag, text) {
    try { chrome.runtime.sendMessage({ type: 'UC_LOG', tag, text }).catch(() => {}); } catch {}
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

    // Each platform's channel is strictly its own — never fall back cross-platform.
    this.config.channel = newTwitch;
    this.config.ytChannel = newYoutube;
    this.config.kickChannel = newKick;
    this._saveConfig();
    this._refreshSettingsInputs();

    // Clear on-screen chat — new streamer has its own history. Dedup structures
    // are per-channel (LRU-evicted), so we leave them alone: returning to a
    // recently-visited channel keeps its dedup state intact and prevents DOM
    // scrape from re-rendering messages that are still sitting in Twitch's DOM.
    this._resetChat();
    this._isModOnChannel = false; // re-detect from badges on new channel
    this._loadUcCommands().catch(() => {});
    this._loadSoundboard();
    this._loadBlacklist().catch(() => {});
    this._refreshDonoAvailability();
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

    // Reset credits keep-last-shown — old channel's bits/points would
    // otherwise bleed into the new channel until its first snapshot
    // arrives. Clear pills and request a fresh pull for the new tab.
    this._lastBitsText = null;
    this._lastPointsText = null;
    this._lastPointsIcon = null;
    this._lastPointsNum = null;
    const twCredits = document.getElementById('tw-credits');
    if (twCredits) {
      twCredits.classList.add('hidden');
      twCredits.querySelectorAll('.tc-pill').forEach((p) => p.classList.add('hidden'));
    }
    this._pullCredits();
    // Reset pin state on channel switch — old channel's pin is gone.
    this._gqlPinCards = [];
    this._lastDomHighlightCards = [];
    this._lastGoodPinCache = null;
    this._lastHighlightsHash = '';
    this._mockPinCards = [];
    clearTimeout(this._mockPinExpiryT);

    // Clear the highlight banner (raid / hype / gifts / pinned cards)
    // — the raid card that triggered this auto-switch is no longer
    // relevant now that we're on the target channel, and keeping it
    // visible is confusing ("raid into Lessinka" still showing when
    // we ARE on Lessinka). The next TW_HIGHLIGHTS snapshot from the
    // new channel's tab will repopulate with anything that belongs.
    const hlBanner = document.getElementById('highlights-banner');
    if (hlBanner) {
      hlBanner.classList.add('hidden');
      hlBanner.innerHTML = '';
    }

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

    await this._loadHistory();
    this._fillMsgHistoryFromStore();
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
    // Soubory z manifestu (content_scripts), stejně jako background při instalaci —
    // „*://*.twitch.tv/*" → host „twitch.tv" v URL záložky.
    const url = tab.url || '';
    const cs = (chrome.runtime.getManifest().content_scripts || []).find((c) =>
      (c.matches || []).some((m) => url.includes(m.replace(/^\*:\/\/\*\./, '').replace(/\/\*$/, ''))));
    if (!cs) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: !!cs.all_frames },
        files: cs.js
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

    this._renderComposer();

    // Only update settings fields when platform actually changes
    // (detect loop runs every 3s — without this guard it overwrites user-typed values)
    if (!changed) return;
    this._loadSoundboard();
    this._qd?.refreshIdentity?.();

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

  // Kick badge key "type" or "type/count" → {url, title}. Subscriber tiers
  // come from the channel API (highest tier ≤ months), everything else is a
  // bundled SVG. Unknown types render nothing rather than a broken image.
  /** Obrázek badge podle platformy zprávy (Kick vlastní sada, jinak Twitch). */
  _badgeEntry(platform, key) {
    return platform === 'kick' ? this._kickBadgeEntry(key) : this._twitchBadges[key];
  }

  _kickBadgeEntry(key) {
    const [type, countStr] = key.split('/');
    const count = parseInt(countStr, 10) || 0;
    const titles = {
      broadcaster: 'Broadcaster', moderator: 'Moderator', vip: 'VIP', og: 'OG',
      founder: 'Founder', subscriber: 'Subscriber', sub_gifter: 'Sub Gifter',
      verified: 'Verified', staff: 'Kick Staff', bot: 'Bot'
    };
    if (!titles[type]) return null;
    let title = titles[type];
    if (type === 'subscriber' && count) title += ` (${count} ${count === 1 ? 'měsíc' : count < 5 ? 'měsíce' : 'měsíců'})`;
    if (type === 'sub_gifter' && count) title += ` (${count})`;
    if (type === 'subscriber' && count && this._kickSubBadges.length) {
      const tier = this._kickSubBadges
        .filter((b) => b && b.months <= count && b.badge_image?.src)
        .sort((a, b) => b.months - a.months)[0];
      if (tier) return { url: tier.badge_image.src, title };
    }
    return { url: `icons/kick-badges/${type}.svg`, title };
  }

  // Nejstarší zpráva v DOM s časem > ts (prochází se odzadu, historie se
  // doplňuje do konce chatu, takže to je pár kroků).
  _olderThanDomTail(ts) {
    if (!ts) return false;
    for (let el = this.chatEl.lastElementChild; el; el = el.previousElementSibling) {
      if (!el.classList.contains('msg')) continue;
      const t = Number(el.dataset.ts);
      return !!t && t > ts;
    }
    return false;
  }

  _firstNewerMsgEl(ts) {
    let found = null;
    for (let el = this.chatEl.lastElementChild; el; el = el.previousElementSibling) {
      if (!el.classList.contains('msg')) continue;
      const t = Number(el.dataset.ts);
      if (!t) continue;
      if (t > ts) found = el;
      else break;
    }
    return found;
  }

  _applyReplyOneLine() {
    document.body.classList.toggle('reply-oneline', this.config.replyOneLine === true);
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

  /** „!" commandy pro autocomplete: Židolišta (přes backend, klíč zůstává na serveru) + StreamElements. */
  _allBangCommands() {
    return [...this._ucCommands, ...this._seCommands.map((c) => ({ ...c, source: 'SE' }))];
  }

  /** Zdroje, ve kterých spouštěč existuje a je pro moji roli povolený (Židolišta první). */
  _bangSources(name) {
    const role = this._myChatRole();
    return [...new Set(this._allBangCommands()
      .filter((c) => '!' + c.name === name && (!Array.isArray(c.roles) || !c.roles.length || c.roles.includes(role)))
      .map((c) => c.source || 'SE'))];
  }

  /** Moje role na Twitchi podle badge z vlastních zpráv — commandy Židolišty jen pro mody se divákům nenabízí. */
  _myChatRole() {
    const me = (this._platformUsernames.twitch || this.config.username || '').toLowerCase();
    if (!me) return 'viewer';
    if (me === (this.config.channel || '').toLowerCase()) return 'broadcaster';
    const b = this._chatUsers.get(`twitch:${me}`)?.badgesRaw || '';
    if (/(^|,)broadcaster\//.test(b)) return 'broadcaster';
    if (/(^|,)moderator\//.test(b) || this._isModOnChannel) return 'moderator';
    if (/(^|,)vip\//.test(b)) return 'vip';
    if (/(^|,)(subscriber|founder)\//.test(b)) return 'sub';
    return 'viewer';
  }

  // Chat commandy streamera ze Židolišty (RobJewsALot): backend GET /commands?channel=
  // vrací jen jméno, literál spouštěče a role (regex už převedený na serveru).
  // Obnova každých 5 minut — commandy se editují na stránce Commandy.
  /** Zobrazované jméno přes blacklist slov (stejný seznam jako text zpráv, core/censor.js). */
  _censorName(name) {
    return this.emotes?.censor ? this.emotes.censor(name) : name;
  }

  /**
   * Blacklist slov ze Židolišty (backend GET /blacklist) → EmoteManager cenzuruje text zpráv,
   * _censorName jména. Při startu, přepnutí streamera, každých 10 min a hned po SSE `blacklist-change`.
   * Už vykreslené zprávy se přerenderují (reRender), ať se změna projeví i zpětně.
   */
  async _loadBlacklist() {
    if (this._blacklistTimer) { clearInterval(this._blacklistTimer); this._blacklistTimer = null; }
    const channel = (this.config.channel || '').toLowerCase();
    const tick = async () => {
      try {
        const r = await fetch(`${UC_API}/blacklist?channel=${encodeURIComponent(channel)}`, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        const key = JSON.stringify(j.terms || []);
        if (key === this._blacklistKey) return;
        const first = this._blacklistKey === undefined;
        this._blacklistKey = key;
        const n = this.emotes.setBlacklist(j.terms || []);
        this._ucLog('Blacklist', `${channel}: ${n} položek${j.stale ? ' (stará cache)' : ''}`);
        if (!first || n) this._reRenderAllMessages?.();
      } catch (e) {
        this._ucLog('Blacklist', `načtení selhalo: ${e.message || e}`);
      }
    };
    if (!channel) return;
    await tick();
    this._blacklistTimer = setInterval(tick, 10 * 60 * 1000);
  }

  async _loadUcCommands() {
    if (this._ucCommandsTimer) { clearInterval(this._ucCommandsTimer); this._ucCommandsTimer = null; }
    const channel = (this.config.channel || '').toLowerCase();
    if (!channel) { this._ucCommands = []; return; }
    const tick = async () => {
      try {
        const r = await fetch(`${UC_API}/commands?channel=${encodeURIComponent(channel)}`, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        const out = [];
        for (const c of j.commands || []) {
          for (const t of c.triggers || [c.trigger]) {
            if (!t || !t.startsWith('!')) continue;
            out.push({ name: t.slice(1), label: c.name || '', roles: Array.isArray(c.roles) ? c.roles : [], source: 'Židolišta', reply: c.reply || '', announcement: c.announcement || null });
          }
        }
        this._ucCommands = out;
        this._ucLog('Cmd', `Židolišta ${channel}: ${out.length} spouštěčů${j.stale ? ' (stará cache)' : ''}`);
        // Otevřený našeptávač „!" příkazů přepočítat z aktuálního textu (s animací změny log).
        if (this._ac?.matches?.[0]?.startsWith('!')) {
          this._acAnimateLogos = true;
          try { this.msgInput.dispatchEvent(new Event('input')); } finally { this._acAnimateLogos = false; }
        }
      } catch (e) {
        this._ucLog('Cmd', `Židolišta fail ${e?.message || e}`);
      }
    };
    await tick();
    this._ucCommandsTimer = setInterval(() => { tick().catch(() => {}); }, 5 * 60 * 1000);
  }

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

  _scrollToMessage(msgId, { flash = true } = {}) {
    const target = this.chatEl.querySelector(`.msg[data-msg-id="${CSS.escape(msgId)}"]`);
    if (!target) {
      if (flash) this._sys('Původní zpráva už není v cache');
      return;
    }
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (!flash) return;
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
        // Hide the legacy #pinned-banner — pin will surface in
        // #highlights-banner via the next FETCH_PINS poll tick (≤4s),
        // unified with all other pinned messages from any source.
        this._hidePinnedBanner();
        // Trigger a fast pin poll so the banner shows up promptly
        // instead of waiting up to 4s for the next interval.
        chrome.runtime.sendMessage({ type: 'FETCH_PINS', channel: this.config.channel })
          .then((r) => {
            if (r?.ok) {
              this._gqlPinCards = (r.pins || []).map((p) => this._pinFromGql(p));
              this._lastHighlightsHash = '';
              this._rerenderHighlights();
            }
          })
          .catch(() => {});
        this._sys('Pin: zpráva připnuta — banner se zobrazí za chvíli.');
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

    const ts = new Date(msg.timestamp);
    const h = ts.getHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = ((h + 11) % 12 + 1).toString().padStart(2, '0');
    const mm = ts.getMinutes().toString().padStart(2, '0');
    const time = `${h12}:${mm} ${ampm}`;

    let body;
    if (msg.platform === 'twitch') {
      body = this.emotes.renderTwitch(msg.message, msg.twitchEmotes, { platform: 'twitch', author: msg.username, emotesOffset: msg.twitchEmotesOffset || 0 });
    } else if (msg.platform === 'kick') {
      body = this.emotes.renderKick(msg.kickContent || msg.message);
    } else {
      body = this.emotes.renderPlain(msg.message);
    }

    const pinnedBy = msg.pinnedBy || msg.username;
    const authorColor = this.emotes._sc(msg.color) || '#e6a11a';

    banner.innerHTML = `
      <div class="pin-head">
        <span class="pin-head-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
            <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/>
          </svg>
        </span>
        <span class="pin-head-text">
          Připnuto uživatelem
          <strong class="pin-head-user" style="color:${authorColor}">${this.emotes._eh(pinnedBy)}</strong>
        </span>
        <button class="pin-btn pin-btn-hide" title="Schovat" aria-label="Schovat připnutou zprávu">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path d="M12 4c-5.5 0-10 8-10 8s4.5 8 10 8 10-8 10-8-4.5-8-10-8Zm0 14c-4.1 0-7.5-5.2-8.1-6 .6-.8 4-6 8.1-6s7.5 5.2 8.1 6c-.6.8-4 6-8.1 6Z"/>
            <path d="M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/>
          </svg>
        </button>
        <button class="pin-btn pin-btn-toggle" title="Rozbalit" aria-label="Rozbalit">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path class="pin-chev" d="M6 9l6 6 6-6z"/>
          </svg>
        </button>
      </div>
      <div class="pin-body">
        <div class="pin-body-text">${body}</div>
        <div class="pin-body-foot">
          <span class="pin-author" style="color:${authorColor}">${this.emotes._eh(msg.username)}</span>
          <span class="pin-author-meta">odesláno v ${time}</span>
        </div>
      </div>
    `;
    banner.classList.remove('hidden', 'collapsed', 'dismissed');

    const toggleBtn = banner.querySelector('.pin-btn-toggle');
    const hideBtn = banner.querySelector('.pin-btn-hide');
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      banner.classList.toggle('collapsed');
      toggleBtn.setAttribute('title', banner.classList.contains('collapsed') ? 'Rozbalit' : 'Sbalit');
    });
    // Hide = local dismiss (message stays pinned on Twitch; our polling
    // will re-show it if the pin is still active AND user reloads).
    hideBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      banner.classList.add('dismissed');
      this._dismissedPinId = msg.id;
    });
    // Don't re-open if user manually dismissed this pin within this session
    if (this._dismissedPinId && this._dismissedPinId === msg.id) {
      banner.classList.add('dismissed');
    }

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
        un.textContent = this._censorName(nickname);
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
      const tab = await this._findStreamTab(platform);
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
    // Autor je uživatel UnityChatu (zlaté logo) → odpověď uvidí z libovolné platformy (↩ napříč platformami).
    const authorUc = !!(messageId && this.chatEl.querySelector(`.msg[data-msg-id="${CSS.escape(String(messageId))}"] .pi.uc`));
    this._reply = { platform, username, messageId, message, senderId, authorUc };
    // Uživatel mimo UnityChat vidí jen svou platformu → dočasně přepnout na ni (když na ní mám účet).
    // Vrátí se po odeslání nebo zrušení odpovědi; ruční přepnutí během odpovídání návrat ruší.
    // Původní platforma = ta před první automatickou změnou (další odpověď ji nepřepíše).
    if (!this._legacySend()) {
      const needSwitch = !authorUc && platform !== this.activePlatform && this._identity(platform);
      if (needSwitch) {
        if (!this._replyPrevPlatform) this._replyPrevPlatform = this.activePlatform;
        this._selectSendPlatform(platform, { quiet: true, auto: true });
      } else if (this._replyPrevPlatform && (authorUc || platform === this._replyPrevPlatform)) {
        this._restoreReplyPlatform();
      }
      this._ucLog('Reply', `na ${platform}:${username} uc=${authorUc} switch=${!!needSwitch} prev=${this._replyPrevPlatform || '-'}`);
    }

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
    // Odesláno nebo zrušeno → zpátky na platformu před automatickým přepnutím.
    this._restoreReplyPlatform();
  }

  _restoreReplyPlatform() {
    const prev = this._replyPrevPlatform;
    if (!prev) return;
    this._replyPrevPlatform = null;
    if (prev !== this.activePlatform && this._identity(prev)) this._selectSendPlatform(prev, { quiet: true, auto: true });
    this._ucLog('Reply', `platforma zpět na ${prev}`);
  }

  // @přezdívka → @login pro odchozí text. Záměrně širší než mention regex v
  // _processMentions ([A-Za-z0-9_]), aby prošly i přezdívky s diakritikou;
  // koncová interpunkce se z názvu odřízne a vrátí zpět. Když se přezdívka
  // nenajde, text zůstává beze změny.
  _resolveNicknameMentions(text, platform) {
    if (!text.includes('@') || !this.nicknames) return text;
    // Sdílené s webem (core/mentions.js): i víceslovné přezdívky („@Naprostej Kokot").
    // Přezdívková mapa je lowercase — pro hezčí zprávu vzít původní psaní
    // loginu tak, jak dorazil z chatu, když ho známe.
    const core = window.UC_CORE;
    return core.resolveNicknameMentions(text, core.nicknameEntries(this.nicknames._map, platform), (login) => this._chatUsers?.get(login)?.name || login);
  }

  async _sendMessage(opts = {}) {
    // opts.text = zpráva mimo pole pro psaní (soundboard `!se …`): rozepsaný text, odpověď i historie zůstávají.
    const external = typeof opts.text === 'string';
    const text = (external ? opts.text : this.msgInput.value).trim();
    if (!text || !this.activePlatform) return;

    // /uc commands — local mock messages for testing (mod/broadcaster only)
    if (!external && text.startsWith('/uc ')) {
      this.msgInput.value = '';
      this.msgInput.style.height = 'auto';
      this._handleUcCommand(text.substring(4).trim());
      return;
    }

    const legacy = this._legacySend();
    if (!legacy && !this._identity(this.activePlatform)) { this._openLoginModal(); return; }

    // Send protection (jen stará cesta přes kartu): if the active tab's channel differs from the configured
    // channel for this platform, refuse to send. Auto-switch should normally
    // fix this transparently — this is a safety net for the transient window.
    if (legacy) try {
      const tab = await this._findStreamTab(this.activePlatform);
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
    const platform = this.activePlatform;
    // Autocomplete vkládá UC přezdívku (skutečný login uživatel nevidí), do
    // chatu ale musí odejít login — jinak zmíněný nedostane upozornění a lidé
    // mimo UnityChat nepoznají, o koho jde. V panelu se @přezdívka zobrazí
    // zpátky přes _processMentions.
    const wireText = this._resolveNicknameMentions(text, platform);
    const markedText = isCmd ? wireText : wireText + ' ' + UC_MARKER;
    const reply = !external && this._reply ? { ...this._reply } : null;

    if (!external) {
      // Save to message history (max 50)
      this._msgHistory.push(text);
      if (this._msgHistory.length > 50) this._msgHistory.shift();
      this._msgHistoryIdx = -1;
      this._msgHistoryDraft = '';

      // Clear input IMMEDIATELY — responsive feel
      this.msgInput.value = '';
      this.msgInput.style.height = 'auto';
      this._clearReply();
    }

    // Optimistic UI: show message instantly
    // Native reply support: Twitch (GQL) + Kick (API reply metadata).
    // For cross-platform or YouTube → fallback to @mention prefix.
    const identity = legacy ? null : this._identity(platform);
    const username = identity ? this._accountName(platform) : (this._platformUsernames[platform] || this.config.username || 'me');
    const ucProfile = this.nicknames.get(platform, username);
    const hasNativeReply = reply && reply.platform === platform
      && (platform === 'twitch' || platform === 'kick');
    let displayText = text;
    if (reply && !hasNativeReply) {
      const at = reply.username.startsWith('@') ? reply.username : `@${reply.username}`;
      if (!displayText.startsWith(at)) displayText = `${at} ${displayText}`;
    }
    // Echo z IRC nese odeslanou (přeloženou) podobu, ne to, co je v inputu.
    this._lastSentText = wireText;
    const userEntry = this._chatUsers.get(`${platform}:${username.toLowerCase()}`);
    // Id si držíme stranou: když odeslání selže, musí se tahle optimistická
    // zpráva označit jako neodeslaná a vypadnout z cache (viz _markSendFailed).
    const optId = `sent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this._addMessage({
      id: optId,
      platform,
      username,
      message: displayText,
      color: ucProfile?.color || userEntry?.color || this._platformColors?.[platform] || null,
      badgesRaw: userEntry?.badgesRaw || '',
      timestamp: Date.now(),
      _uc: true,
      _optimistic: true,
      ...(reply ? { replyTo: { id: reply.messageId, username: reply.username, message: reply.message || null, ...(hasNativeReply ? {} : { platform: reply.platform, uc: true, authorUc: !!reply.authorUc }) } } : {}),
    });
    // Echo z platformy nese „@jméno text" — upgrade (_upgradeOptimistic) ho musí zase skrýt.
    if (reply && !hasNativeReply) {
      const optEl = this.chatEl.querySelector(`[data-msg-id="${CSS.escape(optId)}"]`);
      if (optEl) optEl.dataset.ucReplyUser = reply.username.replace(/^@/, '');
    }

    if (!legacy) {
      await this._sendViaAccount({ optId, platform, wireText, reply, hasNativeReply, external, raw: text });
      return;
    }

    // ---- Stará cesta (záloha): odeslání přes otevřenou kartu se streamem ----
    // Send in background (don't block UI)
    try {
      const tab = await this._findStreamTab(platform);
      if (!tab) {
        this._markSendFailed(optId, `nenalezen stream tab (${platform})`);
        this._sys(`Nenalezen otevřený stream tab (${platform})`);
        return;
      }

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
            message: reply.message || '',
            username: reply.username
          }
        });
      } else {
        let sendText = markedText;
        if (reply) {
          const name = reply.username.replace(/^@/, '');
          const at = `@${name}`;
          if (!sendText.startsWith(at)) sendText = `${at} ${sendText}`;
        }
        // Firefox: vložení do Twitch Slate editoru z content scriptu neprojde (izolace) → GQL.
        resp = (platform === 'twitch' && IS_FIREFOX)
          ? await chrome.runtime.sendMessage({ type: 'TW_GQL_SEND', tabId: tab.id, text: sendText, broadcasterId: this.config._roomId || null })
          : await chrome.tabs.sendMessage(tab.id, { type: 'SEND_CHAT', text: sendText });
      }

      if (resp?.ok && resp.fallback === 'mention') {
        // Kick odpověď odmítl (odpověď na starou zprávu) a odešla „@login text" → optimistická
        // „odpověď" by se s echem nespárovala (jiný text) a zůstala viset; skutečná přijde z chatu.
        this._dropOptimistic(optId);
        this._ucLog('KickSend', 'odpověď odmítnuta → odesláno jako @zmínka, optimistická zpráva odebrána');
      }
      if (!resp?.ok) {
        const reason = resp?.error || 'nepodařilo se odeslat';
        this._markSendFailed(optId, reason);
        this._sys(`Chyba: ${reason}`);
      } else if (text.startsWith('!') || (reply && !hasNativeReply)) {
        // Command jde bez markeru (rozbil by boty) → serveru nahlásit, že je z UnityChatu;
        // ingest zprávu označí a všem pošle SSE `uc-mark` (zlaté logo), backend lib/ucSends.ts.
        // Odpověď napříč platformami: server ji spáruje s echem (SSE `uc-reply`, ↩ u všech).
        const crossReply = reply && !hasNativeReply ? window.UC_CORE.ucReplyPayload(reply) : null;
        const sent = crossReply && !markedText.startsWith(`@${reply.username.replace(/^@/, '')}`) ? `@${reply.username.replace(/^@/, '')} ${markedText}` : markedText;
        this._reportUcSent(platform, username, sent, crossReply);
      }
    } catch (err) {
      this._markSendFailed(optId, err.message);
      this._sys(`Nelze odeslat: ${err.message}`);
    }
  }

  /**
   * Odeslání účtem uživatele přes backend (POST /chat/send, stejně jako web): Twitch Helix,
   * Kick API, YouTube liveChatMessages.insert. Marker UnityChatu přidává server (ne na !/ commandy)
   * a commandy sám hlásí pro zlaté logo. Echo z chatu spáruje optimistickou zprávu jako dřív.
   */
  async _sendViaAccount({ optId, platform, wireText, reply, hasNativeReply, external, raw }) {
    let text = wireText;
    if (reply && !hasNativeReply) {
      const at = `@${reply.username.replace(/^@/, '')}`;
      if (!text.toLowerCase().startsWith(at.toLowerCase())) text = `${at} ${text}`;
    }
    const replyTo = hasNativeReply && reply?.messageId ? reply.messageId : null;
    this._ucLog('Send', `účet ${platform} "${text.slice(0, 60)}"${replyTo ? ' reply→' + replyTo : ''}`);
    const fail = (reason) => {
      this._markSendFailed(optId, reason);
      // Text vrátit do pole, ať o něj člověk nepřijde.
      if (!external && !this.msgInput.value) { this.msgInput.value = raw; this._autoResizeInput?.(); }
    };
    try {
      const token = await this._ucSessionToken();
      const r = await fetch(`${UC_API}/chat/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          platform, text, replyTo, replyToUser: replyTo ? reply.username.replace(/^@/, '') : null, channel: (this.config.channel || '').toLowerCase(),
          // Odpověď napříč platformami (nebo na YouTube): server ji spáruje s echem a ukáže všem v UnityChatu.
          ...(reply && !replyTo ? { ucReplyTo: window.UC_CORE.ucReplyPayload(reply) } : {}),
        }),
        signal: AbortSignal.timeout(15000),
      });
      const j = await r.json().catch(() => ({}));
      this._ucLog('Send', `→ ${r.status} ${j.ok ? `id=${j.id || '-'}` : (j.error || '')}${j.fallback ? ' fallback=' + j.fallback : ''}`);
      if (r.status === 401) {
        fail('přihlášení vypršelo');
        this._sys('Přihlášení vypršelo, přihlas se znovu.');
        await chrome.storage.local.remove('uc_session');
        this._account = null;
        this._afterAccountChange();
        return;
      }
      if (!r.ok || j.ok === false) {
        const reason = r.status === 429 ? 'moc zpráv za sebou, zpomal' : (j.error || `HTTP ${r.status}`);
        fail(reason);
        this._sys(`Chyba: ${reason}`);
        return;
      }
      // Kick odpověď odmítl (odpověď na starou zprávu) a server poslal „@login text" → optimistická
      // „odpověď" by se s echem nespárovala a zůstala viset; skutečná přijde z chatu.
      if (j.fallback === 'mention') this._dropOptimistic(optId);
      // YouTube API vrátí 200 i pro zprávu, kterou chat tiše zahodí (odkaz od nemoderátora).
      if (platform === 'youtube') {
        setTimeout(() => {
          if (this.chatEl.querySelector(`[data-msg-id="${CSS.escape(optId)}"]`)) {
            this._markSendFailed(optId, 'YouTube zprávu přijal, ale v chatu ji nezobrazil — nejspíš blokuje odkazy nebo ji zadržel filtr');
            this._ucLog('Send', 'youtube: bez echa 20 s → označeno');
          }
        }, 20_000);
      }
    } catch (e) {
      fail(e.message || 'neodesláno');
      this._sys(`Nelze odeslat: ${e.message || e}`);
    }
  }

  /**
   * 💾 dump logu. Chrome: background (service worker, data: URL). Firefox: background je uspávaná
   * stránka a blob: URL s ní zaniká uprostřed stahování (soubor se smazal a nový nedopsal,
   * 2026-09-23) → blob vytvoří a stažení spustí panel, který běží.
   */
  async _dumpLogs() {
    if (!IS_FIREFOX) {
      chrome.runtime.sendMessage({ type: 'DUMP_LOGS' }).then((r) => { if (r && r.ok === false) this._sys(`Uložení logu selhalo: ${r.error || '?'}`); }).catch(() => {});
      return;
    }
    try {
      const r = await chrome.runtime.sendMessage({ type: 'GET_LOGS' });
      const text = r?.text || '(log prázdný)';
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      try {
        // Dialog „Uložit jako" (pokyn usera 2026-09-23) — předvyplněné unitychat-debug.log.
        await chrome.downloads.download({ url, filename: 'unitychat-debug.log', conflictAction: 'overwrite', saveAs: true });
        this._sys('Log uložen.');
      } catch (e) {
        // Zavření dialogu bez uložení není chyba.
        if (/cancel/i.test(e.message || '')) this._sys('Uložení logu zrušeno.');
        else this._sys(`Uložení logu selhalo: ${e.message}`);
      }
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
    } catch (e) {
      this._sys(`Dump selhal: ${e.message}`);
    }
  }

  /** POST /chat/uc-sent — command odeslaný z UnityChatu (bez markeru) dostane u všech zlaté logo. */
  _reportUcSent(platform, username, text, replyTo = null) {
    const channel = (this.config.channel || '').toLowerCase();
    if (!channel || !username || username === 'me') return;
    fetch(`${UC_API}/chat/uc-sent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, channel, username, text, ...(replyTo ? { replyTo } : {}) }),
      signal: AbortSignal.timeout(8000),
    }).then((r) => r.json()).then((j) => this._ucLog('UcSent', `${platform} ${text.slice(0, 30)} matched=${!!j?.matched}`)).catch((e) => this._ucLog('UcSent', `selhalo: ${e.message || e}`));
  }

  /** ↩ @jméno citace nad zprávou; platforma citované zprávy může být jiná (odpověď napříč platformami). */
  _buildReplyCtx(msg) {
    const rt = msg.replyTo;
    const rp = rt.platform || msg.platform;
    const ctx = document.createElement('div');
    ctx.className = 'reply-ctx';
    if (rt.id) ctx.classList.add('clickable');
    // Show nickname if available, otherwise platform username
    const replyRawName = (rt.username || '').replace(/^@/, '');
    const replyProfile = this.nicknames.get(rp, replyRawName);
    const replyDisplayName = replyProfile?.nickname || replyRawName;
    let replyBodyHtml = '';
    if (rt.message) {
      // Render emotes in reply context using platform-specific parser.
      // No emotes tag for Twitch (positions unknown) → rely on 7TV/BTTV/FFZ/learned Twitch native.
      let body;
      if (rp === 'kick') body = this.emotes.renderKick(rt.message);
      else if (rp === 'twitch') body = this.emotes.renderTwitch(rt.message, null);
      else body = this.emotes.renderPlain(rt.message);
      replyBodyHtml = ` <span class="rctx-body">${body}</span>`;
    }
    // Odpověď na zprávu z jiné platformy: malé logo té platformy.
    // Zlaté logo, když autor citované zprávy je uživatel UnityChatu (jako .pi.uc u jeho zprávy).
    const authorUc = !!rt.authorUc || !!(rt.id && this.chatEl.querySelector(`.msg[data-msg-id="${CSS.escape(String(rt.id))}"] .pi.uc`));
    const pBadge = rt.platform && rt.platform !== msg.platform
      ? `<span class="badge ${({ twitch: 'tw', kick: 'ki', youtube: 'yt' })[rt.platform] || ''} rctx-pi${authorUc ? ' uc' : ''}">${this.emotes._eh(rt.platform)}</span> ` : '';
    ctx.innerHTML = `&#8617; ${pBadge}<span class="rctx-user">@${this.emotes._eh(replyDisplayName)}</span>` + replyBodyHtml;
    if (rt.id) {
      ctx.addEventListener('click', (e) => {
        e.stopPropagation();
        this._scrollToMessage(rt.id);
      });
    }
    return ctx;
  }

  /**
   * SSE `uc-reply`: server spároval odpověď napříč platformami se zprávou. Zpráva ještě
   * nedorazila → zapamatovat (_addMessage si ji vezme); už je v DOM → doplnit ↩ a skrýt @jméno.
   */
  _applyUcReply({ id, replyTo }) {
    if (!id || !replyTo?.id) return;
    const key = String(id);
    if (!this._ucReplies) this._ucReplies = new Map();
    this._ucReplies.set(key, replyTo);
    if (this._ucReplies.size > 500) this._ucReplies.delete(this._ucReplies.keys().next().value);
    let n = 0;
    for (const el of this.chatEl.querySelectorAll(`.msg[data-msg-id="${CSS.escape(key)}"]`)) {
      n++;
      if (el.querySelector(':scope > .reply-ctx')) continue;
      const platform = el.dataset.platform || replyTo.platform;
      el.insertBefore(this._buildReplyCtx({ platform, replyTo }), el.querySelector(':scope > .msg-tag-line, :scope > .pi') || el.firstChild);
      this._stripReplyMentionInDom(el, replyTo.username);
    }
    this._ucLog('UcReply', `${key} → ${replyTo.platform}:${replyTo.id} el=${n}`);
  }

  /** Vykreslená zpráva: úvodní „@jméno" (span.mention nebo text) v .tx pryč. */
  _stripReplyMentionInDom(el, username) {
    const tx = el.querySelector('.tx');
    const re = window.UC_CORE?.replyMentionRe?.(username);
    if (!tx || !re) return;
    const first = tx.firstChild;
    if (first?.nodeType === 1 && first.classList?.contains('mention') && re.test(first.textContent + ' ')) {
      first.remove();
      const next = tx.firstChild;
      if (next?.nodeType === 3) next.textContent = next.textContent.replace(/^\s+/, '');
    } else if (first?.nodeType === 3 && re.test(first.textContent)) {
      first.textContent = first.textContent.replace(re, '');
    }
  }

  /** SSE `uc-mark`: server poznal zprávu z UnityChatu bez markeru → zlaté logo (i u vykreslené). */
  _applyUcMark({ platform, id }) {
    if (!id) return;
    // Zapamatovat (zpráva z IRC může dorazit až po uc-mark); strop, ať množina neroste.
    if (!this._ucMarkedIds) this._ucMarkedIds = new Set();
    this._ucMarkedIds.add(String(id));
    if (this._ucMarkedIds.size > 500) this._ucMarkedIds.delete(this._ucMarkedIds.values().next().value);
    const cached = this.store.get(id);
    if (cached) cached._uc = true;
    const sel = `.msg[data-msg-id="${CSS.escape(String(id))}"]`;
    const els = [...this.chatEl.querySelectorAll(sel), ...[...(this._parkedTop || []), ...(this._parkedBottom || [])].filter((el) => el.matches?.(sel))];
    for (const el of els) {
      const pi = el.querySelector('.pi');
      if (pi && (!platform || el.dataset.platform === platform || !el.dataset.platform)) { pi.classList.add('uc'); pi.setAttribute('data-tooltip', 'UnityChat User'); }
    }
    this._ucLog('UcSent', `uc-mark ${platform}:${id} → ${els.length} el`);
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
      case 'milestone':
      case 'streak': {
        // /uc milestone [streakCount] [points] [body]
        // Example: /uc milestone 5 450 Wow that was very cool!
        const argv = text.trim().split(/\s+/);
        const value = parseInt(argv[0], 10) || 5;
        const points = parseInt(argv[1], 10) || 450;
        const body = argv.slice(2).join(' ') || 'Wow that was very cool!';
        this._addMessage({
          ...base,
          username: mockUser,
          message: body,
          isMilestone: true,
          milestoneCategory: 'watch-streak',
          milestoneValue: value,
          milestonePoints: points,
          color: '#00b35a',
        });
        break;
      }
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
      case 'command':
      case 'cmd': {
        // Lokální náhled reakce commandu Židolišty (`/uc command !brohemians`): announcement + odpověď bota, nic se neodesílá.
        const trig = (parts[1] || '').replace(/^!/, '').toLowerCase();
        const c = this._ucCommands.find((x) => x.name.toLowerCase() === trig);
        if (!trig) { this._sys('/uc command <!spouštěč> — náhled reakce commandu Židolišty'); break; }
        if (!c) { this._sys(`/uc command: command „!${trig}" v Židolištce neznám (nabídka: ${this._ucCommands.map((x) => '!' + x.name).join(', ') || 'nic'})`); break; }
        const a = c.announcement;
        const hide = !!(a && a.hideChatReplyInUnityChat);
        if (a) {
          this._addAnnouncement({ id: `preview-${now}`, channel: (this.config.channel || '').toLowerCase(), command: c.label || c.name, text: a.text || '', textHtml: a.textHtml || '', media: a.media || null, chatReply: c.reply ? { text: c.reply, hideInUnityChat: hide } : null, hideBotReplies: a.hideBotReplies || [], triggeredBy: { user: this.config.username || 'MockUser', platform }, at: new Date().toISOString() });
        } else {
          this._sys(`!${c.name}: command nemá UnityChat Announcement`);
        }
        if (c.reply && !hide) this._addMessage({ ...base, id: `preview-reply-${now}`, username: 'Židolišta', message: c.reply, color: '#9146ff' });
        else if (c.reply && hide) this._sys(`!${c.name}: běžná odpověď „${c.reply.slice(0, 60)}" se uživatelům UnityChatu skrývá`);
        break;
      }
      case 'annc': {
        // Mock UnityChat Announcement s demo animací erbu (médium hostuje web robdiesalot.com/chat/media/).
        const origin = 'https://robdiesalot.com/chat/media/';
        this._addAnnouncement({ id: `mock-annc-${now}`, channel: (this.config.channel || '').toLowerCase(), command: 'Brohemians', text: text === 'test message' ? 'Brohemians! Pojď se přidat k bratrstvu.' : text, media: { url: origin + 'shield-orbit-alpha.webm', kind: 'video', width: 200, loop: true, stillUrl: origin + 'shield-still.webp' }, chatReply: { text: 'Brohemians!', hideInUnityChat: true }, triggeredBy: { user: this.config.username || 'MockUser', platform }, at: new Date().toISOString() });
        break;
      }
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
      case 'raidbanner': {
        const raider = (text && text !== 'test message') ? text : (this.config.channel || 'Karpo_cz');
        // Try to fetch the current channel's real profile avatar from
        // the open Twitch tab; fall back to a placeholder if nothing's
        // available (e.g. no Twitch tab open).
        (async () => {
          let avatar = null;
          try {
            const tabs = await chrome.tabs.query({ url: 'https://*.twitch.tv/*' });
            const ch = (this.config.channel || '').toLowerCase();
            const target = tabs.find((t) => {
              try {
                const parts = new URL(t.url).pathname.toLowerCase().split('/').filter(Boolean);
                return parts[0] === ch || (parts[0] === 'popout' && parts[1] === ch);
              } catch { return false; }
            }) || tabs[0];
            if (target?.id) {
              const r = await chrome.tabs.sendMessage(target.id, { type: 'GET_CHANNEL_AVATAR', channel: this.config.channel }).catch(() => null);
              if (r?.ok && r.avatar) avatar = r.avatar;
            }
          } catch {}
          this._handleHighlights({
            channel: this.config.channel,
            cards: [{
              kind: 'raid',
              text: `${raider} provádí nájezd na kanál Lessinka s 195 nájezdníky. Nájezd za +250 bodů.`,
              avatar,
            }],
          });
          this._sys(`/uc raidbanner: mock raid banner injected${avatar ? ' (with real channel avatar)' : ''}`);
        })();
        break;
      }
      case 'claim': {
        // Mock the claim-bonus pill showing up in the credits footer.
        // Injects a synthetic TW_CREDITS snapshot via _handleCredits.
        const channel = this.config.channel || '';
        this._handleCredits({
          bits: '0',
          points: '1,5 tis.',
          pointsIcon: null,
          claimAvailable: true,
          channel,
        });
        this._sys('/uc claim: mock claim pill visible');
        break;
      }
      case 'points10': {
        // Mock the +10 watch-reward flash (no balance change needed).
        this._flashPointsDelta(10);
        break;
      }
      case 'points50': {
        this._flashPointsDelta(50);
        break;
      }
      case 'pin': {
        // Mock pin banner injection. Uses the current user profile as
        // both pinner and author so colors + badges pick up whatever
        // the user has cached locally. Body = everything after "/uc pin".
        // args is the raw string passed in, so use parts.slice(1).
        const body = parts.slice(1).join(' ').trim() || 'Mock pin — připnutá zpráva pro testování.';
        // Split body into word-level segments, resolve any known emote
        // names via the full emote library (Twitch native, 7TV, BTTV,
        // FFZ) so mocks with real emote tokens render as images.
        const em = this.emotes;
        const resolveEmote = (name) =>
          em?.channel7tv?.get(name)
          || em?.global7tv?.get(name)
          || em?.bttvEmotes?.get(name)
          || em?.ffzEmotes?.get(name)
          || em?.twitchNative?.get(name);
        const segs = [];
        for (const token of body.split(/(\s+)/)) {
          if (!token) continue;
          if (/^\s+$/.test(token)) {
            const last = segs[segs.length - 1];
            if (last && last.type === 'text') last.value += token;
            else segs.push({ type: 'text', value: token });
            continue;
          }
          const url = resolveEmote(token);
          if (typeof url === 'string' && url) {
            segs.push({ type: 'emote', url, alt: token });
          } else {
            const last = segs[segs.length - 1];
            if (last && last.type === 'text') last.value += token;
            else segs.push({ type: 'text', value: token });
          }
        }
        const myName = this.config.username || 'TestUser';
        const myColorRaw = (this._platformColors?.twitch) || '#e6a11a';
        const myBadges = this._myBadgesCache
          ? (this._myBadgesCache.split(',').map((b) => {
              const entry = this._twitchBadges?.[b];
              const url = entry && typeof entry === 'object' ? entry.url : entry;
              const title = (entry && typeof entry === 'object' && entry.title) || b.split('/')[0];
              return url ? { url, alt: title } : null;
            }).filter(Boolean))
          : [];
        const mockPin = {
          kind: 'pin',
          text: body.slice(0, 200) || 'Pinned',
          pin: {
            pinnedBy: myName,
            author: myName,
            authorColor: myColorRaw,
            authorBadges: myBadges,
            bodySegments: segs,
            timeText: 'odesláno v ' + new Date().toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' }),
            pinId: 'mock-' + Date.now(),
          },
        };
        // Stash mock in its own _mockPinCards array — separate from
        // _gqlPinCards (real GQL poll source) so the mock can coexist
        // with whatever real pin is active. Banner stacks both. Auto-
        // expire after 30s so it doesn't linger forever.
        if (!this._mockPinCards) this._mockPinCards = [];
        this._mockPinCards.push(mockPin);
        clearTimeout(this._mockPinExpiryT);
        this._mockPinExpiryT = setTimeout(() => {
          this._mockPinCards = [];
          this._lastHighlightsHash = '';
          this._rerenderHighlights();
        }, 30000);
        this._lastHighlightsHash = '';
        this._rerenderHighlights();
        this._sys(`/uc pin: mock pin banner injected (30s, body="${body.slice(0, 60)}${body.length > 60 ? '…' : ''}")`);
        break;
      }
      default:
        this._sys(`/uc: neznámý příkaz "${cmd}". Použij: command <!spouštěč>, raid, raider, first, sus, announcement [color], sub, resub, prime, sub2, sub3, subgift, giftbundle [N], redeem [name] [cost], highlight, timeout [s], ban, delete, claim, points10, points50, raidbanner [name], pin [text]`);
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
    this.kick.onSubBadges = (list) => { this._kickSubBadges = list; };
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
    if (this.config.youtube && this.config.ytChannel) { this.youtube.backendChannel = (this.config.channel || '').toLowerCase(); this.youtube.connect(this.config.ytChannel); connecting.push('YouTube'); }
    if (connecting.length) this._sys(`Připojování: ${connecting.join(', ')}...`);

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
    this._updateBarDot();
    if (status === 'error' && detail) {
      this._sys(`${platform.toUpperCase()}: ${detail}`);
    }
    if (status === 'connected') this._scheduleReconcile();
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
    // Data ve store (uzly mimo okno se vykreslí až po návratu — stav musí sedět)
    for (const m of this.store.slice()) {
      if (m.platform === 'twitch' && m.username && m.username.toLowerCase() === u) m._cleared = note;
    }
  }

  // Single message delete (CLEARMSG). Just one DOM node + cache entry.
  _applyTwitchClearMsg(msgId) {
    if (!msgId) return;
    const note = 'Deleted by mod';
    const msgEl = this.chatEl.querySelector(`.msg[data-msg-id="${CSS.escape(msgId)}"]`);
    if (msgEl) this._markMessageCleared(msgEl, note);
    const cached = this.store.get(msgId);
    if (cached) cached._cleared = note;
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

    // Retroactively upgrade tag-line from "First message" to "Suspicious" —
    // a moderated user shouldn't keep the cheerful first-message label.
    // Preserves higher-priority tags (reply/mention/raid) if already present.
    const tagLine = msgEl.querySelector('.msg-tag-line');
    if (tagLine) {
      const tag = tagLine.querySelector('.msg-tag');
      if (tag && tag.classList.contains('tag-first')) {
        tag.classList.remove('tag-first');
        tag.classList.add('tag-sus');
        tag.textContent = 'Suspicious';
      }
    } else {
      const newTagLine = document.createElement('div');
      newTagLine.className = 'msg-tag-line';
      newTagLine.innerHTML = `<span class="msg-tag tag-sus">Suspicious</span>`;
      // Insert before message text (.tx) so tag-line appears above content,
      // matching the initial render order.
      const tx = msgEl.querySelector('.tx');
      if (tx) msgEl.insertBefore(newTagLine, tx);
      else msgEl.appendChild(newTagLine);
    }
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
    try { this._bootMark('loading overlay hiding'); } catch {}
    el.classList.add('fade-out');
    clearTimeout(this._loadingHardT);
    // Drop from layout after the CSS fade so it doesn't keep absorbing
    // pointer events behind the curtain.
    setTimeout(() => el.classList.add('hidden'), 500);
  }

  _updateLoadingPill(platform, status) {
    try { this._bootMark(`pill ${platform} → ${status}`); } catch {}
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

  // ---- UnityChat Announcement (command v Židolištce s videem, SSE `announcement`) ----
  _addAnnouncement(payload) {
    const core = window.UC_CORE;
    const a = core.normalizeAnnouncement(payload);
    if (!a) { this._ucLog('Annc', 'neplatný payload'); return false; }
    if (!this._anncSeen) this._anncSeen = new Set();
    if (this._anncSeen.has(a.id)) return false;
    this._anncSeen.add(a.id);
    if (!this._pendingReplies) this._pendingReplies = [];
    if (a.chatReply?.hideInUnityChat) {
      const now = Date.now();
      this._pendingReplies = this._pendingReplies.filter((p) => p.until > now);
      this._pendingReplies.push({ text: a.chatReply.text, until: now + core.ANNC_REPLY_HIDE_MS });
    }
    // Odpověď cizího bota (StreamElements…): už vykreslenou skrýt, jinak počkat na ni.
    if (a.hideBotReplies.length) {
      const now = Date.now();
      this._pendingBotReplies = (this._pendingBotReplies || []).filter((p) => p.until > now);
      for (const login of core.hideRecentBotReplies(this.chatEl, a.hideBotReplies, now)) this._pendingBotReplies.push({ login, until: now + core.ANNC_BOT_AHEAD_MS });
      this._ucLog('Annc', `boti ${a.hideBotReplies.join(',')} → čeká ${this._pendingBotReplies.map((p) => p.login).join(',') || 'nic (už skryto)'}`);
    }
    const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const d = new Date(a.at);
    const timeText = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
    const tpl = document.createElement('template');
    tpl.innerHTML = core.announcementHtml(a, { textHtml: a.textHtml ? a.textHtml : (a.text ? this.emotes.renderPlain(a.text) : ''), reducedMotion, timeText });
    const el = tpl.content.firstElementChild;
    const tx = el.querySelector('.ua-text');
    if (tx) this._processMentions(tx, 'twitch');
    let replay = null;
    el.querySelector('.ua-media')?.addEventListener('click', (e) => { e.stopPropagation(); replay?.(); });
    if (this._parkedBottom.length) { this._parkedBottom.push(el); return true; }
    if (!this.autoScroll) {
      if (this._unreadCount === 0) { const sep = document.createElement('div'); sep.id = 'unread-separator'; sep.className = 'unread-sep'; sep.textContent = 'Nové zprávy'; this.chatEl.appendChild(sep); }
      this._unreadCount++;
      this.scrollBtn.textContent = `↓ ${this._formatNewMsgCount(this._unreadCount)}`;
      this.scrollBtn.classList.remove('hidden');
    }
    this.chatEl.appendChild(el);
    // Načíst video (z <template> se samo nenačte) + smyčka s pauzou; klik = replay.
    replay = core.wireAnnouncementVideo(el, { autoplay: !reducedMotion });
    if (this.autoScroll) this._unloadTop();
    this._scroll();
    this._ucLog('Annc', `${a.command || '?'}${a.media ? ' + médium' : ''}${a.chatReply?.hideInUnityChat ? ' (odpověď skryta)' : ''}`);
    return true;
  }

  // ---- Reakce „Peepo poop" (core/reaction.js; backend POST /reactions, SSE `reaction`) ----

  /** Tlačítko 💩 jen pro mody/broadcastera a jen když žádná reakce neběží. */
  _updatePoopButtons() {
    const role = this._myChatRole();
    document.body.classList.toggle('uc-can-poop', role === 'moderator' || role === 'broadcaster');
    document.body.classList.toggle('uc-poop-busy', !!this._activeReaction && window.UC_CORE.reactionBusy(this._activeReaction));
  }

  _playReaction(raw) {
    const core = window.UC_CORE;
    const ev = core.normalizeReaction(raw);
    if (!ev || ev.channel !== (this.config.channel || '').toLowerCase()) return;
    if (this._reactionSeen.has(ev.id)) return;
    this._reactionSeen.add(ev.id);
    const offset = core.reactionOffsetMs(ev);
    if (offset > ev.durationMs) return;
    this._activeReaction = ev;
    this._updatePoopButtons();
    // Cílovou zprávu do záběru; když ji panel nemá, video jede u spodního okraje.
    const target = this.chatEl.querySelector(`.msg[data-msg-id="${CSS.escape(ev.target.messageId)}"]`);
    if (target) this._scrollToMessage(ev.target.messageId, { flash: false });
    this._reaction?.stop?.();
    setTimeout(() => {
      this._reaction = core.playPoopReaction({
        hostEl: this.chatEl.parentElement, chatEl: this.chatEl, targetEl: target, videoUrl: POOP_VIDEO_URL,
        offsetMs: core.reactionOffsetMs(ev), reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        muted: this.config.sound === false,
        onEnd: () => {
          this._activeReaction = null; this._updatePoopButtons();
          // Nastavení „Po animaci se vrátit na konec chatu" (výchozí zapnuto).
          if (this.config.reactionScrollBack !== false) { this._jumpToLatest(); this._ucLog('Reaction', 'konec → zpět na konec chatu'); }
        },
      });
    }, target ? 350 : 0);
    this._ucLog('Reaction', `${ev.kind} by ${ev.by?.login || '?'} → ${ev.target.platform}:${ev.target.messageId} target=${!!target} offset=${offset}`);
  }

  /** Přihlášení k backendu (stejný OAuth jako web) přes chrome.identity — token v chrome.storage.local. */
  async _ucSessionToken() {
    const s = await chrome.storage.local.get('uc_session');
    return s.uc_session || null;
  }

  /** Přihlášení (nebo napojení další platformy na účet, když už session je) —
   *  stejný flow jako web: /auth/:platform/start → OAuth v okně prohlížeče → /auth/exchange. */
  async _ucLogin(platform = 'twitch') {
    const returnTo = chrome.identity.getRedirectURL();
    const current = await this._ucSessionToken();
    const headers = { 'Content-Type': 'application/json' };
    if (current) headers.Authorization = `Bearer ${current}`;   // napojit na existující účet
    const start = await fetch(`${UC_API}/auth/${platform}/start`, { method: 'POST', headers, body: JSON.stringify({ returnTo }) });
    const sj = await start.json().catch(() => ({}));
    if (!start.ok || !sj.url) throw new Error(sj.error || `start ${start.status}`);
    const final = await chrome.identity.launchWebAuthFlow({ url: sj.url, interactive: true });
    const p = new URLSearchParams(new URL(final).hash.slice(1));
    if (p.get('uc_error')) throw new Error(p.get('uc_error'));
    const code = p.get('uc_code');
    if (!code) throw new Error('bez kódu');
    const ex = await fetch(`${UC_API}/auth/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    const ej = await ex.json().catch(() => ({}));
    if (!ex.ok || !ej.token) throw new Error(ej.error || `exchange ${ex.status}`);
    await chrome.storage.local.set({ uc_session: ej.token });
    this._ucLog('Account', `login ok (${platform})`);
    this._refreshAccount();
    return ej.token;
  }

  /** Stav účtu z /auth/me → pole pro psaní (výběr platformy, výzva k přihlášení). */
  async _refreshAccount() {
    const token = await this._ucSessionToken();
    if (!token) { this._account = null; this._afterAccountChange(); return null; }
    try {
      const r = await fetch(`${UC_API}/auth/me`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      if (r.status === 401) {
        await chrome.storage.local.remove('uc_session');
        this._account = null;
        this._ucLog('Account', 'session vypršela → odhlášen');
      } else if (r.ok) {
        const j = await r.json();
        this._account = { accountId: j.accountId, platforms: j.platforms || {} };
      }
      // Jiná chyba (síť, 5xx): nechat poslední známý stav.
    } catch (e) { this._ucLog('Account', `me FAIL ${e.message || e}`); if (this._account === undefined) this._account = null; }
    this._afterAccountChange();
    return this._account;
  }

  _afterAccountChange() {
    const acc = this._account;
    const linked = this._linkedPlatforms();
    // Moje jméno na platformě = identita z účtu (zvýraznění zmínek, vlastní zprávy, optimistická zpráva).
    for (const p of linked) this._platformUsernames[p] = this._accountName(p);
    // Vybraná platforma bez přihlášení → první přihlášená (jako web setMe).
    if (!this._legacySend() && linked.length && !linked.includes(this._sendPlatform)) this._selectSendPlatform(linked[0], { quiet: true, auto: true });
    this._ucLog('Account', `stav: ${linked.length ? linked.map((p) => `${p}=${acc.platforms[p].login}`).join(' ') : 'nepřihlášen'}`);
    this._renderComposer();
    this._loadSoundboard();
    this._qd?.refreshIdentity?.();
    // E-mail v nastavení patří k účtu → bez přihlášení skrytý.
    document.body.classList.toggle('uc-signed-out', !linked.length);
    this._signedIn = linked.length > 0;
    this._updateQrAvailability();
    this._emailSettings?.refresh?.();
  }

  /** Jméno, pod kterým mě vidí chat platformy: Twitch/Kick display name, YouTube handle (login),
   *  ne název kanálu — podle něj se páruje optimistická zpráva s echem (_contentKey). */
  _accountName(platform) {
    const id = this._identity(platform);
    if (!id) return null;
    return platform === 'youtube' ? id.login : (id.displayName || id.login);
  }

  _linkedPlatforms() {
    return ['twitch', 'kick', 'youtube'].filter((p) => this._account?.platforms?.[p]);
  }

  /** Identita přihlášeného účtu na platformě ({login, displayName}) nebo null. */
  _identity(platform = this.activePlatform) {
    return (platform && this._account?.platforms?.[platform]) || null;
  }

  /** Záloha (dev mode): posílání přes otevřenou kartu se streamem, platforma podle aktivního tabu. */
  _legacySend() {
    return this.config?.legacyTabSend === true;
  }

  _selectSendPlatform(platform, { quiet = false, auto = false } = {}) {
    // Ruční volba během odpovídání = platforma zůstane, návrat po odpovědi se nekoná.
    if (!auto) this._replyPrevPlatform = null;
    this._sendPlatform = platform;
    try { chrome.storage.local.set({ uc_send_platform: platform }); } catch {}
    if (!this._legacySend()) this._setActivePlatform(platform);
    if (!quiet && this._identity(platform)) this.msgInput.focus();
  }

  /** Pole pro psaní podle přihlášení: bez účtu na vybrané platformě výzva místo pole. */
  _renderComposer() {
    const legacy = this._legacySend();
    const platform = this.activePlatform;
    const id = this._identity(platform);
    const known = legacy || this._account !== undefined;   // undefined = /auth/me ještě neodpověděl
    const canWrite = legacy ? !!platform : !!id;
    const NAMES = { twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube' };
    const wrap = this.msgInput.closest('.msg-input-wrap');
    const cta = document.getElementById('login-cta');
    const btn = document.getElementById('platform-btn');
    wrap?.classList.toggle('hidden', known && !canWrite);
    this.sendBtn.classList.toggle('hidden', known && !canWrite);
    cta?.classList.toggle('hidden', !known || canWrite);
    btn?.classList.toggle('hidden', known && !canWrite);
    this.msgInput.disabled = !canWrite;
    this.sendBtn.disabled = !canWrite;
    this.msgInput.placeholder = platform ? `Zpráva do ${NAMES[platform] || platform}...` : 'Otevři stream pro odesílání...';
    if (btn) btn.title = id ? `Píšeš na ${NAMES[platform]} jako ${id.displayName || id.login}` : 'Vyber platformu / přihlas se';
    // Body a bity z Twitche jen s přihlášeným Twitch účtem (v záložním režimu jako dřív).
    document.body.classList.toggle('uc-no-twitch-login', !legacy && !this._identity('twitch'));
    this._qdDock?.update();
    const menu = document.getElementById('platform-menu');
    if (menu && !menu.classList.contains('hidden')) this._renderPlatformMenu();
  }

  _renderPlatformMenu() {
    const menu = document.getElementById('platform-menu');
    window.UC_CORE.renderPlatformMenu(menu, {
      me: this._account,
      current: this.activePlatform,
      onSelect: (p) => this._selectSendPlatform(p),
      onLogin: (p) => this._loginPlatform(p),
      onUnlink: (p) => this._unlinkPlatform(p),
      onLogout: () => this._accountLogout(),
      onClose: () => this._closePlatformMenu(),
    });
  }

  _togglePlatformMenu() {
    const menu = document.getElementById('platform-menu');
    if (!menu) return;
    if (menu.classList.contains('hidden')) {
      this._renderPlatformMenu();
      menu.classList.remove('hidden');
      document.getElementById('platform-btn')?.setAttribute('aria-expanded', 'true');
    } else this._closePlatformMenu();
  }

  _closePlatformMenu() {
    document.getElementById('platform-menu')?.classList.add('hidden');
    document.getElementById('platform-btn')?.setAttribute('aria-expanded', 'false');
  }

  /** Přihlašovací okno se třemi logy (core LoginModal, stejné jako web). */
  _openLoginModal() {
    const core = window.UC_CORE;
    if (!this._loginModal) {
      const logos = {};
      for (const p of ['twitch', 'kick', 'youtube']) logos[p] = { base: `icons/platform/${p}.svg`, gold: `icons/platform/${p}-gold.svg` };
      this._loginModal = new core.LoginModal({
        logos,
        note: 'Přihlášení proběhne v okně prohlížeče přímo u platformy.<br>UnityChat nikdy nevidí tvoje heslo.',
        onPick: async (p) => {
          const ok = await this._loginPlatform(p);
          if (ok) this._loginModal.close();
        },
      });
    }
    const linked = this._linkedPlatforms();
    const missing = ['twitch', 'kick', 'youtube'].filter((p) => !linked.includes(p));
    // Všechny platformy připojené → není co nabídnout (dřív se otevřelo prázdné okno).
    if (this._account && !missing.length) { this._ucLog('Account', 'přihlašovací okno: všechny platformy připojené'); return; }
    this._loginModal.open(this._account
      ? { title: 'Připojit další platformu', subtitle: 'Vyber platformu, kterou chceš připojit ke svému účtu.', only: missing }
      : {});
  }

  /** Přihlásit / připojit platformu a rovnou na ni psát. Vrací true při úspěchu. */
  async _loginPlatform(platform) {
    try {
      await this._ucLogin(platform);
      await this._refreshAccount();
      if (this._identity(platform)) this._selectSendPlatform(platform);
      return true;
    } catch (e) {
      const msg = String(e.message || e);
      this._ucLog('Account', `login ${platform} FAIL ${msg}`);
      // Zavřené okno přihlášení není chyba, kterou je potřeba hlásit.
      if (/cancel|closed|did not approve/i.test(msg)) return false;
      const text = /429/.test(msg) ? 'Příliš mnoho pokusů za sebou, zkus to za chvíli.' : `Přihlášení se nepodařilo: ${msg}`;
      if (!this._loginModal?.showError(text)) this._sys(text);
      return false;
    }
  }

  async _unlinkPlatform(platform) {
    const token = await this._ucSessionToken();
    try {
      const r = await fetch(`${UC_API}/auth/${platform}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      this._ucLog('Account', `unlink ${platform} → ${r.status}`);
    } catch (e) { this._ucLog('Account', `unlink FAIL ${e.message || e}`); }
    await this._refreshAccount();
    // Poslední platforma pryč = není čím se prokázat → odhlásit úplně.
    if (this._account && !this._linkedPlatforms().length) await this._accountLogout();
  }

  async _accountLogout() {
    const token = await this._ucSessionToken();
    if (token) {
      try { await fetch(`${UC_API}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }); } catch {}
    }
    await chrome.storage.local.remove('uc_session');
    this._account = null;
    this._ucLog('Account', 'logout');
    this._afterAccountChange();
  }

  async _triggerPoop(platform, messageId) {
    if (this._activeReaction && window.UC_CORE.reactionBusy(this._activeReaction)) return;
    if (!messageId || String(messageId).startsWith('sent-')) { this._sys('Počkej, až se zpráva potvrdí z chatu.'); return; }
    let token = await this._ucSessionToken();
    if (!token) {
      try { token = await this._ucLogin(platform); }
      catch (e) { this._ucLog('Reaction', `login FAIL ${e.message || e}`); this._sys(`Přihlášení pro reakce selhalo: ${e.message || e}`); return; }
    }
    const r = await fetch(`${UC_API}/reactions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ kind: 'poop', platform, messageId, channel: (this.config.channel || '').toLowerCase() }),
    }).catch((e) => ({ ok: false, status: 0, json: async () => ({ error: e.message }) }));
    const j = await r.json().catch(() => ({}));
    this._ucLog('Reaction', `trigger ${platform}:${messageId} → ${r.status} ${j.error || ''}`);
    if (r.status === 401) { await chrome.storage.local.remove('uc_session'); this._sys('Přihlášení pro reakce vypršelo, klikni znovu.'); return; }
    if (r.status === 403) { this._sys('Reakce může spustit jen mod nebo streamer (backend tě podle zpráv v chatu nepoznal jako moda).'); return; }
    if (r.status === 409) return;   // už běží — tlačítko se schová podle SSE
    if (!r.ok) this._sys(`Reakce se nespustila: ${j.error || r.status}`);
  }

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
        const cachedMsg = msgId ? this.store.get(msgId) : null;
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
          const cachedMsg = msgId ? this.store.get(msgId) : null;
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

    // Store / okno
    push('Cache stats', {
      storeLength: this.store.length,
      storeOldest: this.store.at(0)?.timestamp,
      storeNewest: this.store.at(this.store.length - 1)?.timestamp,
      oldestCursor: this.store.oldestCursor,
      historyFetches: this._historyFetches,
      domMsgs: this.chatEl.querySelectorAll('.msg').length,
      parkedTop: this._parkedTop.length,
      parkedBottom: this._parkedBottom.length,
      // Audit ingestu (scripts/ingest-audit.mjs): všechna platform:id ve store.
      msgCacheIds: this.store.slice().filter((m) => m.id && m.platform && !String(m.id).startsWith('sent-')).map((m) => `${m.platform}:${m.id}|${m.timestamp || 0}|${(m.username || '')}|${String(m.message || '').slice(0, 40)}`),
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
    const recent = this.store.slice(-30).map((m) => ({
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
      isMilestone: !!m.isMilestone,
      isAction: !!m.isAction,
      scraped: !!m.scraped,
      optimistic: !!m._optimistic,
      cleared: m._cleared || null,
      msgLen: (m.message || '').length,
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
              const cachedMsg = msgId ? this.store.get(msgId) : null;
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
    if (this._suppressFlashesUntil && Date.now() < this._suppressFlashesUntil) return;
    const wrap = document.getElementById('tw-credits');
    if (!wrap) return;
    // Anchor to the RIGHTMOST visible pill so the flash slides to the
    // right from outside the pill cluster and never overlaps the
    // claim-bonus button (which sits to the right of points when
    // available). Fall back to the points pill if nothing else visible.
    const claim = wrap.querySelector('.tc-claim');
    const points = wrap.querySelector('.tc-points');
    const bits = wrap.querySelector('.tc-bits');
    const pills = [claim, points, bits].filter((p) => p && !p.classList.contains('hidden'));
    const anchor = pills[0] || points || wrap;
    const f = document.createElement('span');
    f.className = 'tc-points-flash';
    f.textContent = `+${delta.toLocaleString('cs-CZ')}`;
    wrap.appendChild(f);
    // Position to the right of the anchor, vertically centered on the row.
    const ar = anchor.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    f.style.left = (ar.right - wr.left + 6) + 'px';
    f.style.top = (ar.top - wr.top + ar.height / 2) + 'px';
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
      const openOnTwitch = async () => {
        const log = (s, x) => chrome.runtime.sendMessage({ type: 'UC_LOG', tag: 'PillClick', args: [s, x ? JSON.stringify(x) : ''] }).catch(() => {});
        try {
          const tabs = await chrome.tabs.query({ url: 'https://*.twitch.tv/*' });
          const ch = (this.config.channel || '').toLowerCase();
          log('tabs', { count: tabs.length, channel: ch, urls: tabs.map((t) => t.url) });
          const target = tabs.find((t) => {
            try {
              const parts = new URL(t.url).pathname.toLowerCase().split('/').filter(Boolean);
              return parts[0] === ch || (parts[0] === 'popout' && parts[1] === ch);
            } catch { return false; }
          }) || tabs[0];
          log('target-tab', { id: target?.id, url: target?.url });
          if (!target?.id) return;
          await chrome.tabs.update(target.id, { active: true });
          await chrome.windows.update(target.windowId, { focused: true });
          const resp = await chrome.tabs.sendMessage(target.id, { type: 'TW_OPEN_REWARDS_POPOVER' }).catch((e) => ({ ok: false, error: e.message }));
          log('sendMessage-resp', resp);
        } catch (e) {
          log('exception', { msg: e.message });
        }
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
          // Optimistic +50 flash. Suppress the next ~3s of delta-based
          // flashes so the post-claim balance update doesn't fire a
          // second "+50" when Twitch's DOM observer picks up the reward
          // animation too.
          this._flashPointsDelta(50);
          this._suppressFlashesUntil = Date.now() + 3000;
        } catch {}
      });
    }
    const bitsVal = wrap.querySelector('.tc-bits-val');
    const pointsVal = wrap.querySelector('.tc-points-val');
    const pointsIcon = wrap.querySelector('.tc-points-icon');

    // Keep-last-shown: Twitch's points-balance subtree briefly drops the
    // bits/points text spans during the +10 watch-reward animation. We
    // remember the last seen value per pill so transient nulls don't
    // hide the row.
    let anyShown = false;
    if (data.bits != null && data.bits !== '') {
      this._lastBitsText = data.bits;
    }
    if (this._lastBitsText != null) {
      bitsVal.textContent = this._lastBitsText;
      bitsPill.classList.remove('hidden');
      anyShown = true;
    } else {
      bitsPill.classList.add('hidden');
    }
    if (data.points != null && data.points !== '') {
      // Twitch occasionally swaps the points-balance slot for the watch-streak
      // widget ("Den 3" / "3 nights streak" / custom copy). That text isn't a
      // points balance — if we mirror it we show garbage. Gate on: either a
      // parseable number, or a short string matching "NNN", "N,NN tis.",
      // "NK", etc. Anything else is treated as transient and dropped.
      const looksLikeBalance = /^[\d\u00A0\s.,]+(?:\s*(?:tis|k|mil|m)\.?)?$/i.test(data.points);
      if (looksLikeBalance) {
        this._lastPointsText = data.points;
      } else {
        // Log rejected points values so we can identify what Twitch is
        // rendering in the slot (watch-streak / sub-streak / etc.) and
        // later add dedicated handling if needed.
        try {
          chrome.runtime.sendMessage({ type: 'UC_LOG', tag: 'StreakSkip',
            text: `non-balance points text="${String(data.points).slice(0, 80)}" channel=${data.channel || '—'}` }).catch(() => {});
        } catch {}
      }
      // Explicit null/empty icon from content script → new channel without
      // a custom icon. Clear the stored icon so the render path below can
      // reset the DOM to the default (no background image, no has-icon).
      if (data.pointsIcon) this._lastPointsIcon = data.pointsIcon;
      else if (data.pointsIcon === null || data.pointsIcon === '') this._lastPointsIcon = null;
    }
    if (this._lastPointsText != null) {
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
      const prevNum = this._lastPointsNum;
      const newNum = parseTwitchNum(this._lastPointsText);
      // Precision gate: only accept the numeric delta when neither the
      // prev NOR the new text was abbreviated (no "tis."/"k"/"mil"/"m"
      // suffix). Crossing a rounding boundary like 1.4K → 1.5K would
      // otherwise fire a phantom "+100" that's actually the rounding
      // artefact of a single +10 tick. We still want +10 flashes for
      // precise values (< 1000).
      const isAbbrev = (s) => typeof s === 'string' && /(?:tis|k|mil|m)\.?\s*$/i.test(s.trim());
      const prevAbbrev = isAbbrev(pointsVal.textContent);
      const newAbbrev = isAbbrev(this._lastPointsText);
      pointsVal.textContent = this._lastPointsText;
      if (this._lastPointsIcon) {
        pointsIcon.style.backgroundImage = `url(${this.emotes._ea(this._lastPointsIcon)})`;
        pointsIcon.classList.add('has-icon');
      } else {
        // Channel has no custom points icon (e.g. after auto-switch to a
        // streamer who never set one). Clear any leftover backgroundImage
        // + class from the previous channel so the default circle glyph
        // (styled on .tc-points-icon in CSS) shows through.
        pointsIcon.style.backgroundImage = '';
        pointsIcon.classList.remove('has-icon');
      }
      pointsPill.classList.remove('hidden');
      anyShown = true;
      // Numerical delta — but only when both values are precise.
      // Abbreviated "1,5 tis." has ~100-point imprecision which would
      // manifest as phantom +100 flashes on boundary crossings.
      if (prevNum != null && newNum != null && newNum > prevNum && !prevAbbrev && !newAbbrev) {
        this._flashPointsDelta(newNum - prevNum);
      }
      if (newNum != null) this._lastPointsNum = newNum;
    } else {
      pointsPill.classList.add('hidden');
    }
    if (data.claimAvailable) {
      // Cancel any pending hide — bonus re-appeared (Twitch sometimes
      // transiently detaches .claimable-bonus__icon during the +10
      // animation even though the bonus is still claimable).
      if (this._claimHideT) { clearTimeout(this._claimHideT); this._claimHideT = null; }
      claimPill.classList.remove('hidden');
      anyShown = true;
    } else if (!claimPill.classList.contains('hidden')) {
      // Hysteresis: don't yank the button on a single false snapshot.
      // Give the DOM ~2s to stabilise; if the claim icon is still gone
      // then, it was really clicked/expired.
      anyShown = true; // keep row visible during hide delay
      if (!this._claimHideT) {
        this._claimHideT = setTimeout(() => {
          this._claimHideT = null;
          const p = document.getElementById('tw-credits')?.querySelector('.tc-claim');
          if (p) p.classList.add('hidden');
        }, 2000);
      }
    }
    wrap.classList.toggle('hidden', !anyShown);
  }

  // Map a GQL FETCH_PINS pin object into the highlight-card format
  // _handleHighlights expects. Centralised so both the periodic poll
  // and the post-pin-mutation fast-fetch use the same transform.
  _pinFromGql(p) {
    const ts = p.sentAt || p.pinnedAt;
    const em = this.emotes;
    return {
      kind: 'pin',
      text: (p.contentText || '').slice(0, 120) || 'Pinned',
      pin: {
        pinnedBy: p.pinnedBy,
        author: p.author,
        authorColor: p.authorColor,
        authorBadges: (p.senderBadges || []).map((b) => {
          const key = `${b.setID}/${b.version}`;
          const entry = this._twitchBadges?.[key];
          const url = entry && typeof entry === 'object' ? entry.url : entry;
          const title = (entry && typeof entry === 'object' && entry.title) || b.setID;
          return url ? { url, alt: title } : null;
        }).filter(Boolean),
        bodySegments: (p.segments || []).map((s) => {
          if (s.type === 'emote') {
            // Emote URL gated by Client-Integrity in GQL, so segments
            // arrive name-only. Resolve against local emote library
            // (URL strings, NOT objects — see v3.38.37 fix).
            const name = s.alt || '';
            const url =
              em?.twitchNative?.get(name)
              || em?.channel7tv?.get(name)
              || em?.global7tv?.get(name)
              || em?.bttvEmotes?.get(name)
              || em?.ffzEmotes?.get(name);
            if (typeof url === 'string' && url) return { type: 'emote', url, alt: name };
            return { type: 'text', value: name };
          }
          return { type: 'text', value: s.value || '' };
        }),
        timeText: ts
          ? 'odesláno v ' + new Date(ts).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })
          : null,
        pinId: p.pinId,
      },
    };
  }

  // Start a periodic GQL poll for pinned messages on the active Twitch
  // channel. Runs every 8s (pin state rarely changes faster). Caches
  // the last result in this._gqlPinCards so _handleHighlights merges
  // them into whatever DOM-sourced highlight cards are active.
  _startPinPoll() {
    if (this._pinPollT) return;
    this._gqlPinCards = [];
    const tick = async () => {
      try {
        const channel = this.config.channel;
        if (!channel) return;
        const resp = await chrome.runtime.sendMessage({ type: 'FETCH_PINS', channel });
        if (!resp?.ok) { this._gqlPinCards = []; return; }
        this._gqlPinCards = (resp.pins || []).map((p) => this._pinFromGql(p));
        // Re-render the banner merging freshly-fetched pins with whatever
        // DOM-mirror highlights are currently showing.
        this._rerenderHighlights();
      } catch {}
    };
    tick();
    this._kickDomHighlightScan();
    // 4s interval — fast enough to catch new pins promptly without
    // hammering GQL. Plus on every sidepanel focus (visibilitychange
    // → visible) kick an immediate tick so coming back from another
    // tab shows an up-to-date pin right away.
    this._pinPollT = setInterval(() => {
      tick();
      this._kickDomHighlightScan();
    }, 4000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        tick();
        this._kickDomHighlightScan();
      }
    });
  }

  // Ask every Twitch tab to snapshot highlight cards NOW and relay them
  // back via TW_HIGHLIGHTS. Cuts boot-time DOM pin latency from "wait for
  // next MutationObserver tick" (could be seconds) to one message round
  // trip (~10-30ms). Works even when chat column is hidden/not scrolling.
  async _kickDomHighlightScan() {
    try {
      const tabs = await chrome.tabs.query({ url: '*://*.twitch.tv/*' });
      for (const t of tabs) {
        try { chrome.tabs.sendMessage(t.id, { type: 'SCAN_HIGHLIGHTS_NOW' }).catch(() => {}); } catch {}
      }
    } catch {}
  }

  // Merge DOM + GQL pin data + last-good cache into a single card.
  // Each field prefers in order: DOM (current tick) → cache (last-good
  // DOM snapshot) → GQL (server metadata). Keeps author/badges/time
  // visible even when DOM flips the pin into its collapsed footerless
  // state, and keeps real emote URLs visible even when GQL-only data
  // is what we'd otherwise fall back to.
  _mergePinCard(domCard, gqlCard) {
    if (!domCard && !gqlCard) return null;
    const d = domCard?.pin || {};
    const g = gqlCard?.pin || {};
    const cached = this._lastGoodPinCache || {};
    const pick = (key) => {
      const dv = d[key];
      if (Array.isArray(dv) ? dv.length : dv) return dv;
      const cv = cached[key];
      if (Array.isArray(cv) ? cv.length : cv) return cv;
      return g[key] || null;
    };
    const pin = {
      pinnedBy: pick('pinnedBy'),
      author: pick('author'),
      authorColor: pick('authorColor'),
      authorBadges: pick('authorBadges') || [],
      bodySegments: pick('bodySegments') || [],
      timeText: pick('timeText'),
      pinId: d.pinId || g.pinId || cached.pinId,
    };
    // Refresh the cache whenever this tick had a DOM extract with a
    // complete footer (author + time) — that's our gold standard.
    if (d.author && d.timeText && d.bodySegments?.length) {
      this._lastGoodPinCache = { ...pin };
    }
    const text = (domCard?.text || gqlCard?.text || '').slice(0, 200) || 'Pinned';
    return { kind: 'pin', text, pin };
  }

  // Trigger a re-render of the highlights banner using cached non-pin
  // DOM cards only — pin data is merged inside _handleHighlights from
  // _gqlPinCards + _lastGoodPinCache. Pushing GQL pins into msg.cards
  // here (previous behaviour) caused the merge to read GQL body
  // segments as if they were DOM, clobbering the real emote URLs with
  // plaintext emote names.
  _rerenderHighlights() {
    const msg = {
      channel: this.config.channel,
      cards: [...(this._lastDomHighlightCards || [])],
    };
    this._rerenderTag = msg;
    this._handleHighlights(msg);
  }

  _handleHighlights(msg) {
    // Channel-scoped: ignore highlights from other open Twitch tabs.
    if (msg.channel && msg.channel.toLowerCase() !== (this.config.channel || '').toLowerCase()) return;
    // Cache cleanup logic — only runs for DOM-sourced TW_HIGHLIGHTS
    // messages (not our own _rerenderHighlights callbacks, which carry
    // the _rerenderTag identity). Splits pin cards out from the rest so
    // that re-renders never accidentally re-inject stale pins from the
    // cache (which caused 4x duplicate "Připnuto uživatelem …" banners).
    // Caching + pin merge. DOM-sourced TW_HIGHLIGHTS message carries
    // fresh DOM pin data in msg.cards; our own _rerenderHighlights
    // carries only non-pin cards. Either way we merge per-field with
    // GQL + cache and produce a single best-of pin card.
    const isRerender = msg === this._rerenderTag;
    if (msg.cards) {
      const domCards = msg.cards;
      const domPins = isRerender ? [] : domCards.filter((c) => c?.kind === 'pin');
      if (!isRerender) {
        this._lastDomHighlightCards = domCards.filter((c) => c?.kind !== 'pin');
      }
      const gqlPin = (this._gqlPinCards || [])[0];
      const domPin = domPins[0];
      const mergedPin = this._mergePinCard(domPin, gqlPin);
      const realPins = mergedPin ? [mergedPin] : [];
      // Mock pins (from /uc pin) stack on top of any real pin so the
      // user can compare layouts side by side. They auto-expire after
      // 30s via _mockPinExpiryT.
      const mockPins = this._mockPinCards || [];
      msg = { ...msg, cards: [...this._lastDomHighlightCards, ...realPins, ...mockPins] };
    }
    const banner = document.getElementById('highlights-banner');
    if (!banner) return;
    const cards = (msg.cards || []).filter((c) => c && c.text);
    if (!cards.length) {
      banner.classList.add('hidden');
      banner.innerHTML = '';
      this._lastHighlightsHash = '';
      return;
    }
    // Idempotency guard: if the rendered cards haven't actually changed
    // (same kind + text + pin identity + segment URLs), skip the DOM
    // re-mount. Previously we tore the banner down and rebuilt every 4s
    // poll tick, which (a) reset the user's collapse toggle click and
    // (b) looked like a refresh flicker. Hash covers the visible data;
    // anything else (e.g. timestamp difference between pins) warrants
    // a rebuild.
    const hash = cards.map((c) => {
      const pin = c.pin || {};
      const segs = (pin.bodySegments || []).map((s) => s.type === 'emote' ? `E:${s.alt}:${s.url || ''}` : `T:${s.value || ''}`).join('|');
      const badges = (pin.authorBadges || []).map((b) => b.url).join(',');
      return [
        c.kind,
        (c.text || '').slice(0, 200),
        pin.pinId || '',
        pin.author || '',
        pin.authorColor || '',
        badges,
        segs,
        pin.timeText || '',
      ].join('§');
    }).join('◊');
    if (hash === this._lastHighlightsHash) return;
    this._lastHighlightsHash = hash;
    banner.classList.remove('hidden', 'has-accent');
    banner.style.removeProperty('--hl-accent-r');
    banner.style.removeProperty('--hl-accent-g');
    banner.style.removeProperty('--hl-accent-b');
    // Preserve per-pin collapsed state across re-renders so the user's
    // chevron click isn't undone by the next poll.
    const preservedCollapse = new Map();
    for (const old of banner.querySelectorAll('.hl-card.hl-pin .hl-pin-wrap')) {
      const key = old.dataset.pinKey;
      if (key) preservedCollapse.set(key, old.classList.contains('collapsed'));
    }
    banner.innerHTML = '';
    this._pendingPinCollapse = preservedCollapse;
    for (const c of cards) {
      const item = document.createElement('div');
      item.className = 'hl-card hl-' + (c.kind || 'generic');

      if (c.kind === 'raid') {
        // Prominent raid layout: header bar with pulsing rocket + label,
        // main row with avatar + structured text highlighting raider
        // and target channel names.
        item.appendChild(this._buildRaidCard(c));
      } else if (c.kind === 'pin') {
        item.appendChild(this._buildPinCard(c));
      } else {
        if (c.avatar) {
          const av = document.createElement('img');
          av.className = 'hl-avatar';
          av.src = c.avatar;
          av.alt = '';
          item.appendChild(av);
        } else {
          const icon = document.createElement('span');
          icon.className = 'hl-icon';
          icon.textContent = c.kind === 'hype-train' ? '\u{1F682}'
            : c.kind === 'gift-leaderboard' ? '\u{1F381}'
            : '\u2728';
          item.appendChild(icon);
        }
        const body = document.createElement('span');
        body.className = 'hl-body';
        body.textContent = c.text;
        item.appendChild(body);
      }
      banner.appendChild(item);
    }
  }

  _buildPinCard(c) {
    // Structured pin render — expects c.pin = { pinnedBy, author,
    // authorColor, authorBadges[], bodySegments[], timeText }.
    const pin = c.pin || {};
    const pinnedBy = pin.pinnedBy || 'uživatel';
    const author = pin.author;
    const authorColor = this.emotes._sc(pin.authorColor) || '#e6a11a';
    const timeText = pin.timeText || '';

    // Build body HTML from segments. Twitch's pin DOM keeps body as a
    // text-fragment so 7TV/BTTV/FFZ emotes arrive as plain text (their
    // Vue replacer doesn't run inside pin subtrees). Tokenize each text
    // segment by whitespace and resolve every word against our local
    // emote library, falling back to linkified text. Plus strip the UC
    // marker (Braille blank) so it doesn't leak as visible whitespace.
    const em = this.emotes;
    // Each emote map stores URL strings directly (not {url: ...} objects),
    // so the lookup result IS the URL — must not access .url on it.
    const resolveEmote = (name) =>
      em?.twitchNative?.get(name)
      || em?.channel7tv?.get(name)
      || em?.global7tv?.get(name)
      || em?.bttvEmotes?.get(name)
      || em?.ffzEmotes?.get(name)
      || em?.kickNative?.get(name)
      || em?.ucEmotes?.get(name);
    const renderTextWithEmotes = (raw) => {
      const cleaned = String(raw || '').replace(new RegExp(UC_MARKER, 'g'), '');
      if (!cleaned) return '';
      const parts = cleaned.split(/(\s+)/);
      return parts.map((tok) => {
        if (!tok) return '';
        if (/^\s+$/.test(tok)) return em._eh(tok);
        const url = resolveEmote(tok);
        if (typeof url === 'string' && url) {
          return `<img class="emote" src="${em._ea(url)}" alt="${em._eh(tok)}">`;
        }
        return em._linkify(tok);
      }).join('');
    };
    const bodyHtml = (() => {
      if (!pin.bodySegments?.length) return renderTextWithEmotes(c.text || '');
      return pin.bodySegments.map((s) => {
        if (s.type === 'emote') {
          const alt = em._eh(s.alt || '');
          return `<img class="emote" src="${em._ea(s.url)}" alt="${alt}">`;
        }
        return renderTextWithEmotes(s.value || '');
      }).join('');
    })();

    // Badges row before author name
    const badgesHtml = (pin.authorBadges || []).map((b) => (
      `<img class="hl-pin-badge" src="${this.emotes._ea(b.url)}" alt="${this.emotes._eh(b.alt || '')}" title="${this.emotes._eh(b.alt || '')}">`
    )).join('');

    const wrap = document.createElement('div');
    wrap.className = 'hl-pin-wrap';

    wrap.innerHTML = `
      <div class="hl-pin-head">
        <span class="hl-pin-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
            <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/>
          </svg>
        </span>
        <span class="hl-pin-head-text">
          Připnuto uživatelem
          <strong class="hl-pin-head-user">${this.emotes._eh(pinnedBy)}</strong>
        </span>
        <button class="hl-pin-btn hl-pin-btn-hide" title="Schovat" aria-label="Schovat">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path d="M12 4c-5.5 0-10 8-10 8s4.5 8 10 8 10-8 10-8-4.5-8-10-8Zm0 14c-4.1 0-7.5-5.2-8.1-6 .6-.8 4-6 8.1-6s7.5 5.2 8.1 6c-.6.8-4 6-8.1 6Z"/>
            <path d="M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/>
          </svg>
        </button>
        <button class="hl-pin-btn hl-pin-btn-toggle" title="Rozbalit" aria-label="Rozbalit">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path class="hl-pin-chev" d="M6 9l6 6 6-6z"/>
          </svg>
        </button>
      </div>
      <div class="hl-pin-body">
        <div class="hl-pin-body-text">${bodyHtml}</div>
        ${author || timeText ? `
          <div class="hl-pin-foot">
            ${badgesHtml ? `<span class="hl-pin-badges">${badgesHtml}</span>` : ''}
            ${author ? `<span class="hl-pin-author" style="color:${readableColor(authorColor)}">${this.emotes._eh(author)}</span>` : ''}
            ${timeText ? `<span class="hl-pin-time">${this.emotes._eh(timeText)}</span>` : ''}
          </div>
        ` : ''}
      </div>
    `;

    const card = wrap;
    // Restore the user's previously-toggled collapsed state if this pin
    // identity matched an earlier render; otherwise start collapsed.
    const pinKey = pin.pinId || `anon-${pinnedBy}-${author}`;
    card.dataset.pinKey = pinKey;
    const wasCollapsed = this._pendingPinCollapse?.get(pinKey);
    // Default to collapsed on first render; on re-render, honour whatever
    // the user's last toggle state was (wasCollapsed === false means the
    // user expanded it manually — keep it expanded).
    if (wasCollapsed !== false) card.classList.add('collapsed');
    const toggleBtn = wrap.querySelector('.hl-pin-btn-toggle');
    const hideBtn = wrap.querySelector('.hl-pin-btn-hide');
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      card.classList.toggle('collapsed');
      toggleBtn.title = card.classList.contains('collapsed') ? 'Rozbalit' : 'Sbalit';
    });
    hideBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const host = wrap.closest('.hl-card');
      if (host) host.style.display = 'none';
    });

    // Propagate warm amber/gold accent to the outer banner so
    // #highlights-banner background matches the pin palette instead
    // of the default cyan/purple. Value matches our pin-banner
    // amber (#e6a11a ≈ 230,161,26).
    setTimeout(() => {
      const host = wrap.closest('.hl-card');
      const banner = wrap.closest('#highlights-banner');
      if (host) {
        host.classList.add('has-accent');
        host.style.setProperty('--hl-accent-r', '230');
        host.style.setProperty('--hl-accent-g', '161');
        host.style.setProperty('--hl-accent-b', '26');
      }
      if (banner) {
        banner.classList.add('has-accent');
        banner.style.setProperty('--hl-accent-r', '230');
        banner.style.setProperty('--hl-accent-g', '161');
        banner.style.setProperty('--hl-accent-b', '26');
      }
    }, 0);

    return wrap;
  }

  _buildRaidCard(c) {
    const wrap = document.createElement('div');
    wrap.className = 'hl-raid-wrap';

    // Header: pulsing rocket + "NÁJEZD" gold-gradient label
    const header = document.createElement('div');
    header.className = 'hl-raid-header';
    header.innerHTML = '<span class="hl-raid-icon" aria-hidden="true">\u{1F680}</span>'
      + '<span class="hl-raid-label">N\u00C1JEZD</span>';
    wrap.appendChild(header);

    // Body row: avatar + structured text
    const row = document.createElement('div');
    row.className = 'hl-raid-row';
    if (c.avatar) {
      const av = document.createElement('img');
      av.className = 'hl-raid-avatar';
      av.crossOrigin = 'anonymous';
      av.src = c.avatar;
      av.alt = '';
      // On load, sample a dominant colour from the avatar and apply it
      // as CSS custom properties on the raid card — gives the banner
      // a background tuned to the raider's brand without hardcoding
      // per-channel palettes.
      av.addEventListener('load', () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 24;
          canvas.height = 24;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(av, 0, 0, 24, 24);
          const { data } = ctx.getImageData(0, 0, 24, 24);
          // Histogram of quantised hues + chroma — picks the DOMINANT
          // colour instead of averaging (averaging yellow+blue yields
          // teal which bears no resemblance to either input).
          const buckets = new Map();
          for (let i = 0; i < data.length; i += 4) {
            const pr = data[i], pg = data[i + 1], pb = data[i + 2], pa = data[i + 3];
            if (pa < 180) continue;
            const max = Math.max(pr, pg, pb), min = Math.min(pr, pg, pb);
            const chroma = max - min;
            if (chroma < 30) continue; // skip grey / near-grey pixels
            const sum = pr + pg + pb;
            if (sum < 90 || sum > 680) continue;
            // Quantise to 6×6×6 RGB cube (216 buckets)
            const key = ((pr >> 5) * 64) + ((pg >> 5) * 8) + (pb >> 5);
            const cur = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0, chroma: 0 };
            cur.r += pr; cur.g += pg; cur.b += pb; cur.n++; cur.chroma += chroma;
            buckets.set(key, cur);
          }
          // Pick bucket with highest (count × avgChroma) — emphasises
          // a saturated dominant colour over a large grey backdrop.
          let best = null, bestScore = 0;
          for (const b of buckets.values()) {
            const score = b.n * (b.chroma / b.n);
            if (score > bestScore) { bestScore = score; best = b; }
          }
          if (best) {
            let r = Math.round(best.r / best.n);
            let g = Math.round(best.g / best.n);
            let b = Math.round(best.b / best.n);
            // Raid-specific warmth bias: blend sampled colour 60/40
            // with raid-red base so cool avatars don't turn the raid
            // banner into a cold teal callout. Keeps the avatar's
            // hue recognisable but anchors the palette to "raid".
            if (c.kind === 'raid') {
              const RAID_R = 255, RAID_G = 80, RAID_B = 30;
              r = Math.round(r * 0.6 + RAID_R * 0.4);
              g = Math.round(g * 0.6 + RAID_G * 0.4);
              b = Math.round(b * 0.6 + RAID_B * 0.4);
            }
            const card = av.closest('.hl-card');
            if (card) {
              card.style.setProperty('--hl-accent-r', r);
              card.style.setProperty('--hl-accent-g', g);
              card.style.setProperty('--hl-accent-b', b);
              card.classList.add('has-accent');
            }
            // Propagate accent to the outer banner so its own
            // background/border tunes to the card's palette instead
            // of the fixed cyan/purple gradient.
            const banner = av.closest('#highlights-banner');
            if (banner) {
              banner.style.setProperty('--hl-accent-r', r);
              banner.style.setProperty('--hl-accent-g', g);
              banner.style.setProperty('--hl-accent-b', b);
              banner.classList.add('has-accent');
            }
          }
        } catch { /* CORS or sample failed — keep default palette */ }
      }, { once: true });
      row.appendChild(av);
    }

    const body = document.createElement('div');
    body.className = 'hl-raid-body';
    // Try to parse the Twitch Czech raid callout into structured parts:
    // "{raider} provádí nájezd na kanál {target} s {N} nájezdníky. Nájezd za +{P} bodů."
    // English fallback: "{raider} is raiding {target} with {N} viewers. Raid in +{P} points."
    const m = c.text.match(/^([A-Za-z0-9_]+)[^A-Za-z0-9_]+?([A-Za-z0-9_]+)[^0-9]+?(\d+[\d\s]*)/);
    if (m) {
      const raider = m[1];
      const target = m[2];
      const viewers = m[3].replace(/\s/g, '');
      const tail = c.text.match(/\+(\d+[\d\s]*)/);
      const pts = tail ? tail[1].replace(/\s/g, '') : null;
      const title = document.createElement('div');
      title.className = 'hl-raid-title';
      title.innerHTML = `<strong class="hl-raid-raider">${this.emotes._eh(raider)}</strong>`
        + ` <span class="hl-raid-arrow">\u2192</span> `
        + `<strong class="hl-raid-target">${this.emotes._eh(target)}</strong>`;
      const meta = document.createElement('div');
      meta.className = 'hl-raid-meta';
      meta.innerHTML = `<span>\u{1F465} ${viewers}</span>`
        + (pts ? `<span class="hl-raid-points">\u{2728} +${pts}</span>` : '');
      body.appendChild(title);
      body.appendChild(meta);
    } else {
      // Fallback — keep the raw text if parsing didn't match the expected shape.
      body.textContent = c.text;
    }
    row.appendChild(body);

    // Close button — dismisses the raid by clicking the matching
    // close control on Twitch's raid card in the DOM.
    const close = document.createElement('button');
    close.className = 'hl-raid-close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Zrušit nájezd');
    close.title = 'Zrušit nájezd';
    close.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">'
      + '<path d="M6.414 5 5 6.414l5.588 5.588L5 17.59l1.414 1.414 5.588-5.588 5.588 5.588 1.414-1.414-5.588-5.588 5.588-5.588L17.59 5l-5.588 5.588L6.414 5Z"/></svg>';
    close.addEventListener('click', async (e) => {
      e.stopPropagation();
      // Optimistic hide + ask content script to click Twitch's close.
      const card = wrap.closest('.hl-card');
      if (card) card.style.display = 'none';
      try {
        const tabs = await chrome.tabs.query({ url: 'https://*.twitch.tv/*' });
        const ch = (this.config.channel || '').toLowerCase();
        const target = tabs.find((t) => {
          try {
            const parts = new URL(t.url).pathname.toLowerCase().split('/').filter(Boolean);
            return parts[0] === ch || (parts[0] === 'popout' && parts[1] === ch);
          } catch { return false; }
        }) || tabs[0];
        if (target?.id) {
          chrome.tabs.sendMessage(target.id, { type: 'TW_DISMISS_RAID' }).catch(() => {});
        }
      } catch {}
    });
    row.appendChild(close);

    wrap.appendChild(row);

    // Countdown progress bar — mirrors vanilla Twitch's raid banner
    // which shows a depleting timer until the raid executes. Duration
    // comes from the card (Twitch typically uses 90s); falls back to
    // 10s for mocks / when we can't parse it out.
    const durSec = c.raidCountdownSec || 10;
    const bar = document.createElement('div');
    bar.className = 'hl-raid-bar';
    const fill = document.createElement('span');
    fill.className = 'hl-raid-bar-fill';
    fill.style.animationDuration = durSec + 's';
    bar.appendChild(fill);
    wrap.appendChild(bar);
    return wrap;
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
      const cached = mid ? this.store.get(mid) : null;
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
    un.textContent = this._censorName(msg.username);
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
    un.textContent = this._censorName(msg.username);
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

  _renderMilestoneEvent(el, msg) {
    el.classList.add('milestone-event');
    if (msg.milestoneCategory) {
      el.classList.add(`milestone-${msg.milestoneCategory}`);
    }
    // Flame icon (Twitch's watch-streak symbol — same path Twitch uses)
    const icon = document.createElement('span');
    icon.className = 'milestone-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<svg viewBox="0 0 20 20" width="20" height="20" fill="currentColor">'
      + '<path fill-rule="evenodd" d="M11 4.5 9 2 4.8 6.9A7.48 7.48 0 0 0 3 11.77C3 15.2 5.8 18 9.23 18h1.65A6.12 6.12 0 0 0 17 11.88c0-1.86-.65-3.66-1.84-5.1L12 3l-1 1.5ZM6.32 8.2 9 5l2 2.5L12 6l1.62 2.07A5.96 5.96 0 0 1 15 11.88c0 2.08-1.55 3.8-3.56 4.08.36-.47.56-1.05.56-1.66 0-.52-.18-1.02-.5-1.43L10 11l-1.5 1.87c-.32.4-.5.91-.5 1.43 0 .6.2 1.18.54 1.64A4.23 4.23 0 0 1 5 11.77c0-1.31.47-2.58 1.32-3.57Z" clip-rule="evenodd"/>'
      + '</svg>';
    el.appendChild(icon);

    const body = document.createElement('div');
    body.className = 'milestone-body';

    // Header row: username + channel-points pill
    const header = document.createElement('div');
    header.className = 'milestone-header';
    const un = document.createElement('span');
    un.className = 'un';
    un.textContent = this._censorName(msg.username);
    un.dataset.platform = msg.platform;
    un.dataset.username = msg.username.toLowerCase();
    un.addEventListener('click', () => this._openUserCard(msg.platform, msg.username));
    const chatUserEntry = this._chatUsers.get(`${msg.platform}:${msg.username?.toLowerCase()}`);
    const ucProfile = this.nicknames.get(msg.platform, msg.username);
    un.style.color = readableColor(ucProfile?.color || chatUserEntry?.color || msg.color);
    header.appendChild(un);
    if (msg.milestonePoints > 0) {
      const points = document.createElement('span');
      points.className = 'milestone-points';
      points.innerHTML = '+ <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor" aria-hidden="true">'
        + '<path d="M10 6a4 4 0 014 4h-2a2 2 0 00-2-2V6z"/>'
        + '<path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-2 0a6 6 0 11-12 0 6 6 0 0112 0z" clip-rule="evenodd"/>'
        + '</svg> ';
      points.appendChild(document.createTextNode(String(msg.milestonePoints)));
      header.appendChild(points);
    }
    body.appendChild(header);

    // Subtitle line — category-specific copy
    const sub = document.createElement('div');
    sub.className = 'milestone-line';
    if (msg.milestoneCategory === 'watch-streak') {
      const label = document.createElement('strong');
      label.textContent = 'Watch Streak Reached!';
      sub.appendChild(label);
      sub.appendChild(document.createTextNode(`: ${msg.username} is currently on a `));
      const v = document.createElement('strong');
      v.textContent = `${msg.milestoneValue}-stream streak`;
      sub.appendChild(v);
      sub.appendChild(document.createTextNode('!'));
    } else {
      // Generic fallback for unknown categories — Twitch may add new ones.
      const label = document.createElement('strong');
      label.textContent = 'Milestone Reached!';
      sub.appendChild(label);
      sub.appendChild(document.createTextNode(`: ${msg.username} hit `));
      const v = document.createElement('strong');
      v.textContent = String(msg.milestoneValue || msg.milestoneCategory);
      sub.appendChild(v);
    }
    body.appendChild(sub);

    // Optional attached chat message
    if (msg.message) {
      const tx = document.createElement('div');
      tx.className = 'milestone-text tx';
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
    un.textContent = this._censorName(msg.username);
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
        // V optimistické zprávě může stát UC přezdívka — autocomplete ji
        // vkládá a na login se text přeloží až při odeslání. Namapovat zpět,
        // ať mention dostane barvu a data-mention-user zůstane login.
        const login = this._chatUsers.has(lname)
          ? lname
          : (this.nicknames?.resolveNickname(lname, platform) || lname);
        span.dataset.mentionUser = login;
        const entry = this._chatUsers.get(`${platform}:${login}`)
          || this._chatUsers.get(login);
        const color = entry?.color;
        if (color) {
          const sanitized = this.emotes._sc(color);
          if (sanitized) span.style.color = readableColor(sanitized);
        } else if (platform === 'twitch') {
          // Unknown user — they've been @mentioned but haven't spoken in
          // our session yet. Queue a Twitch color lookup so the mention
          // retroactively gets their real chat color once resolved.
          this._enqueueTwitchColorLookup(login);
        }
        // Display nickname if one is set for this user, else raw login name.
        // Raw message body / cache / dedup all use the original @name — only
        // the rendered text switches. data-mention-user stays lowercase login
        // so color retints and scrolls still work.
        const nick = this.nicknames?.getNickname(platform, login);
        span.textContent = '@' + (nick || name);
        if (nick) span.title = '@' + login;
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
    // Obsah karty ze sdíleného core (emote-preview.js, stejné jako web): u zero-width
    // stacku všechny vrstvy přes sebe + seznam všech emotů; detaily = emote pod myší.
    const core = window.UC_CORE;
    const layers = core.previewLayers(img, this.emotes);
    const active = layers.find((l) => l.active) || layers[0];
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
    card.innerHTML = core.previewCardHtml(layers, { pinned });

    // Position above the emote (keeps card inside the side panel even
    // when emote is at the very bottom). Falls back below if no room above.
    this._positionEmotePreview(card, img);

    // Pinned mode: lazy-fetch source details and re-render the .ep-detail block.
    if (pinned && active.meta?.id) {
      try {
        const d = await this.emotes.fetchEmoteDetails(active.meta.source, active.meta.id, active.name);
        // Card may have been dismissed while we awaited
        if (!this._emotePreviewPinned || card.classList.contains('hidden')) return;
        const detail = card.querySelector('.ep-detail');
        if (detail) detail.innerHTML = core.previewDetailHtml(d, active.source);
        // Layout may have grown — reposition.
        this._positionEmotePreview(card, img);
      } catch {}
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
  /** Tělo zprávy → HTML (emoty, odkazy, cenzura z blacklistu). Sdílí render i přerenderování. */
  _renderMsgBody(msg) {
    const renderCtx = { platform: msg.platform, author: msg.username };
    if (msg.platform === 'twitch') {
      // Reply messages strip the "@username " prefix from the body, but the
      // emotes tag positions are computed from the ORIGINAL message — shift
      // by twitchEmotesOffset so subscriber/native emotes resolve in replies.
      renderCtx.emotesOffset = msg.twitchEmotesOffset || 0;
      return this.emotes.renderTwitch(msg.message, msg.twitchEmotes, renderCtx);
    }
    if (msg.platform === 'kick') return this.emotes.renderKick(msg.kickContent || msg.message, renderCtx);
    if (msg.platform === 'youtube' && msg.ytRuns?.length) return this.emotes.renderYouTube(msg.ytRuns);
    return this.emotes.renderPlain(msg.message);
  }

  /** Po změně blacklistu: přerenderovat text i jméno všech zpráv (i zaparkovaných mimo DOM). */
  _reRenderAllMessages() {
    let n = 0;
    for (const msgEl of [...this.chatEl.querySelectorAll('.msg[data-msg-id]'), ...(this._parkedTop || []), ...(this._parkedBottom || [])]) {
      const cached = msgEl.dataset?.msgId ? this.store.get(msgEl.dataset.msgId) : null;
      if (!cached) continue;
      const tx = msgEl.querySelector('.tx');
      if (tx) { tx.innerHTML = this._renderMsgBody(cached); this._processMentions(tx, cached.platform); }
      const un = msgEl.querySelector('.un');
      if (un) un.textContent = this._censorName(this.nicknames.get(cached.platform, cached.username)?.nickname || cached.username);
      n++;
    }
    this._ucLog('Blacklist', `přerenderováno ${n} zpráv`);
  }

  _reRenderMessagesForUser(platform, username) {
    const u = String(username).toLowerCase();
    const sel = `.un[data-platform="${CSS.escape(platform)}"][data-username="${CSS.escape(u)}"]`;
    for (const un of this.chatEl.querySelectorAll(sel)) {
      const msgEl = un.closest('.msg');
      if (!msgEl) continue;
      const tx = msgEl.querySelector('.tx');
      if (!tx) continue;
      const msgId = msgEl.dataset.msgId;
      const cached = msgId ? this.store.get(msgId) : null;
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
      const cachedMsg = msgId ? this.store.get(msgId) : null;
      const ucProfile = cachedMsg ? this.nicknames.get('twitch', cachedMsg.username) : null;
      if (ucProfile?.color) continue;
      _7tvApplyPaintStyles(un, css);
    }
  }

  // Resolve dedup entry (ids Set + content-key Set) for a message's platform
  // and current channel. Creates the entry on first use, bumps it to the top
  // of the LRU, and evicts the oldest entry if we're over the channel cap.
  // Returns {ids, content} — callers mutate them directly. Returns null if
  // the platform/channel can't be resolved (let the caller skip dedup).
  _addMessage(msg) {
    // Odpověď napříč platformami (core/uc-reply.js): ze serveru (historie) nebo z SSE `uc-reply`,
    // které přišlo dřív než zpráva. ↩ s citací, úvodní „@jméno" v UnityChatu skryté.
    if (msg && !msg.replyTo && msg.id && this._ucReplies?.has(String(msg.id))) msg = { ...msg, replyTo: this._ucReplies.get(String(msg.id)) };
    if (msg?.replyTo?.uc && window.UC_CORE?.stripReplyMention) msg = window.UC_CORE.stripReplyMention(msg);
    // Defensive drop: a regular chat message with no body is just a
    // "username:" line with empty text — these were showing up in
    // production (confirmed in debug logs) from scraped system lines
    // or IRC edge cases. System events (raid/sub/announcement/gift/
    // redeem/highlight/cleared/action) have their own renderers that
    // don't need a body, so we let those through.
    // Strip UC_MARKER (Braille blank — intentionally NOT whitespace so
    // Twitch can't normalise it away) before the emptiness check.
    // Messages may carry their real content in platform-specific fields
    // (ytRuns for YouTube, kickContent for Kick) even when the plain
    // `message` string is empty — those must NOT be dropped.
    const msgProbe = String(msg?.message || '').replace(new RegExp(UC_MARKER, 'g'), '').trim();
    const hasPlatformContent = (msg?.ytRuns?.length > 0) || (typeof msg?.kickContent === 'string' && msg.kickContent.trim().length > 0);
    const textEmpty = !msgProbe && !hasPlatformContent;
    const isSystem = msg?.isRaid || msg?.isAnnouncement || msg?.isSubEvent
      || msg?.isGiftBundle || msg?.isSubGift || msg?.isRedeem
      || msg?.isMilestone
      || msg?.isHighlight || msg?._cleared || msg?.isAction;
    // Běžná odpověď commandu, místo které uživatel UnityChatu vidí announcement — nevykreslit.
    if (!msg._optimistic && !this._bootLoading && this._pendingReplies?.length && window.UC_CORE.matchesChatReply(this._pendingReplies, msg.message)) {
      this._ucLog('Annc', `skryta odpověď „${String(msg.message || '').slice(0, 40)}"`);
      return;
    }
    if (!msg._optimistic && !this._bootLoading && !msg.historical && this._pendingBotReplies?.length && window.UC_CORE.takeBotReply(this._pendingBotReplies, msg.username)) {
      this._ucLog('Annc', `skryta odpověď bota ${msg.username}: „${String(msg.message || '').slice(0, 40)}"`);
      return;
    }
    if (textEmpty && !isSystem) {
      // Log root-cause clues — which source produced an empty message.
      try {
        chrome.runtime.sendMessage({
          type: 'UC_LOG', tag: 'EmptyMsg',
          args: [JSON.stringify({
            platform: msg?.platform,
            username: msg?.username,
            id: msg?.id,
            scraped: !!msg?.scraped,
            optimistic: !!msg?._optimistic,
            isAction: !!msg?.isAction,
            firstMsg: !!msg?.firstMsg,
            hasReplyTo: !!msg?.replyTo,
            twitchEmotes: msg?.twitchEmotes,
            badgesRaw: msg?.badgesRaw,
            rawType: typeof msg?.message,
            rawLen: (msg?.message || '').length,
            rawCodes: [...String(msg?.message || '').slice(0, 16)].map((c) => c.charCodeAt(0)),
          })],
        });
      } catch {}
      return;
    }

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

    // Párování optimistická ↔ echo z platformy (echo má jiné id, stejný text).
    const contentKey = this._contentKey(msg.username, msg.message);
    if (msg._optimistic) {
      if (contentKey) this._optimisticKeys.set(contentKey, msg.id);
    } else if (contentKey && this._optimisticKeys.has(contentKey)) {
      const optId = this._optimisticKeys.get(contentKey);
      this._optimisticKeys.delete(contentKey);
      if (this.store.get(optId)) {
        this.store.upgrade(optId, msg);
        this._upgradeOptimistic(optId, msg);
        return; // upgraded in-place, don't render again
      }
    }

    // Dedup jen podle platform:id (historie ze serveru ↔ živé zprávy ↔ reconnect).
    if (this.store.add(msg) === 'dup') return;

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
      // Reply messages strip "@username " prefix from message body, but
      // IRC emote positions still reference the ORIGINAL text including
      // that prefix. Pass the same offset we use for rendering so we
      // extract the right substring for the emote name (otherwise we'd
      // learn garbage like "te" as an alias for :D from a misaligned
      // reply slice — confirmed in production logs).
      this.emotes.learnTwitch(msg.message, msg.twitchEmotes, msg.twitchEmotesOffset || 0);
    } else if (msg.platform === 'kick' && msg.kickContent) {
      this.emotes.learnKick(msg.kickContent);
    }

    // Detekce UnityChat markeru → oranžový platform badge
    // Flag _uc se cachuje aby přežil reload
    // _uc = marker (lokálně) nebo příznak serveru `uc` (command z UnityChatu bez markeru, /chat/history).
    let isUC = !!msg._uc || !!msg.uc || !!this._ucMarkedIds?.has(msg.id);
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
    if (msg.timestamp) el.dataset.ts = String(msg.timestamp);
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
    const isMilestone = !!msg.isMilestone;
    const isCustomEvent = isGift || isSubEvent || isRedeem || isMilestone;
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
    } else if (isMilestone) {
      this._renderMilestoneEvent(el, msg);
    } else {

    // Reply context (Twitch reply-parent tagy, Kick reply, odpověď napříč platformami)
    if (msg.replyTo) el.appendChild(this._buildReplyCtx(msg));

    // Tag line (right-aligned, above message content). Priority:
    // reply/mention/raid > suspicious (sus user OR message was cleared by mod)
    // > first message. Moderation-related flags win over first-message because
    // they're the signal that matters when scanning chat for trouble.
    const susLike = msg.isSus || !!msg._cleared;
    const tagText =
      isReplyToMe ? 'Replying to you' :
      isMentioned ? 'Mentions you' :
      msg.isRaid ? 'Raid' :
      msg.isRaider ? 'Raider' :
      susLike ? 'Suspicious' :
      msg.firstMsg ? 'First message' : null;
    if (tagText) {
      const tagLine = document.createElement('div');
      tagLine.className = 'msg-tag-line';
      const tagCls =
        isReplyToMe ? 'tag-reply' :
        isMentioned ? 'tag-mention' :
        msg.isRaid ? 'tag-raid' :
        msg.isRaider ? 'tag-raider' :
        susLike ? 'tag-sus' :
        'tag-first';
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
        const entry = this._badgeEntry(msg.platform, badge);
        const url = entry && typeof entry === 'object' ? entry.url : entry;
        if (!url && msg.platform !== 'kick' && badgeCount > 0) {
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
    un.textContent = this._censorName(ucProfile?.nickname || msg.username);
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

    tx.innerHTML = this._renderMsgBody(msg);

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
      || msg.isSubEvent || msg.isGiftBundle || msg.isSubGift || msg.isRedeem
      || msg.isMilestone;
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

    // Reakce „Peepo poop" — úplně vlevo; jen mod/broadcaster (body.uc-can-poop),
    // během přehrávání schované (body.uc-poop-busy). Id se bere až při kliknutí
    // z datasetu: u právě odeslané zprávy se po IRC echu přepíše, ale element
    // zůstává tentýž (_upgradeOptimistic), takže tlačítko musí být od začátku.
    const poopBtn = document.createElement('button');
    poopBtn.className = 'msg-action-btn';
    poopBtn.dataset.act = 'poop';
    poopBtn.title = 'Peepo poop (mod)';
    poopBtn.textContent = '\u{1F4A9}';
    poopBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const host = poopBtn.closest('.msg');
      this._triggerPoop(msg.platform, host?.dataset.msgId || msg.id);
    });
    actions.insertBefore(poopBtn, actions.firstChild);
    el.appendChild(actions);
    }
    } // end isSystemEvent guard

    // Historie (boot / starší stránka) není „nová zpráva" — bez unread logiky.
    const isHistory = this._bootLoading || !!this._prependCursor;
    // Pokud nejsme dole, přidat unread separator (jen jednou pro první novou zprávu).
    if (!this.autoScroll && !isHistory) {
      if (this._unreadCount === 0) {
        // První nová zpráva → vložit separator
        const sep = document.createElement('div');
        sep.id = 'unread-separator';
        sep.className = 'unread-sep';
        sep.textContent = 'Nové zprávy';
        this.chatEl.appendChild(sep);
      }
      this._unreadCount++;
      this.scrollBtn.textContent = `↓ ${this._formatNewMsgCount(this._unreadCount)}`;
      this.scrollBtn.classList.remove('hidden');
    }

    // When autoScroll is off (user scrolled up to read older msgs), lock
    // scrollTop across the append — even with overflow-anchor:none Chrome
    // occasionally nudges scrollTop during reflow (scrollbar gutter churn,
    // image-load height changes, etc). Explicit capture+restore keeps the
    // user's reading line dead still as new messages stack below.
    const preserveScroll = !this.autoScroll && !isHistory;
    const prevScrollTop = preserveScroll ? this.chatEl.scrollTop : 0;
    let appendedAtEnd = false;

    if (this._prependCursor) {
      // Starší stránka ze serveru (vzestupně) → před první dosavadní uzel.
      this.chatEl.insertBefore(el, this._prependCursor);
    } else if (!this._bootLoading && !msg._optimistic && this._olderThanDomTail(msg.timestamp)) {
      // Historická zpráva mezi živými (reconcile po connectu, YT backlog
      // z úvodní stránky) → podle času před první novější, ne na konec.
      const anchor = this._firstNewerMsgEl(msg.timestamp);
      if (anchor) this.chatEl.insertBefore(el, anchor); else this.chatEl.appendChild(el);
    } else if (this._parkedBottom.length) {
      // Uživatel je nahoře a pod oknem už jsou zaparkované uzly — nová
      // zpráva patří až za ně, do parku (DOM se dotáhne scrollem dolů).
      this._parkedBottom.push(el);
      return;
    } else {
      this.chatEl.appendChild(el);
      appendedAtEnd = true;
    }

    if (isHistory) return;

    if (preserveScroll && this.chatEl.scrollTop !== prevScrollTop) {
      // Suppress the scroll handler briefly so our restore doesn't get
      // re-interpreted as "user paused auto-scroll" when it already was.
      this._programmaticScrollUntil = performance.now() + 50;
      this.chatEl.scrollTop = prevScrollTop;
    }

    if (this.autoScroll) this._unloadTop();
    // Nová zpráva na konci plynule přijede zespodu (zkušebně, pokyn usera 2026-09-24).
    this._scroll(appendedAtEnd && !this._bootLoading ? el : null);
  }

  // ---- Historie ze serveru + DOM okno ---------------------------------

  // GET /chat/history — server je jediný zdroj historie (spec 2026-09-19).
  // Zprávy jdou přes _addMessage (dedup ve store, render, sběr barev/jmen).
  async _loadHistory({ before = null, limit = 100, reconcile = false } = {}) {
    const channel = (this.config.channel || '').toLowerCase();
    if (!channel) return 0;
    const url = new URL(`${UC_API}/chat/history`);
    url.searchParams.set('channel', channel);
    url.searchParams.set('limit', String(limit));
    if (before) url.searchParams.set('before', before);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    let added = 0;
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (!data?.ok) throw new Error(data?.error || 'bad response');
      const list = data.messages || [];
      if (before) {
        // Starší stránka: vkládat vzestupně před první dosavadní uzel.
        this._prependCursor = this.chatEl.querySelector('.msg') || this.chatEl.firstElementChild || null;
      } else if (!reconcile) {
        this._bootLoading = true;
      }
      // reconcile: nic z toho — historické zprávy se zařadí podle času mezi živé.
      try {
        for (const m of list) {
          const beforeLen = this.store.length;
          this._addMessage(m);
          if (this.store.length > beforeLen) added++;
        }
      } finally {
        this._prependCursor = null;
        this._bootLoading = false;
      }
      if (!reconcile) this.store.oldestCursor = data.nextBefore || null;
      this._historyFetches++;
      this._ucLog('History', `${reconcile ? 'reconcile ' : ''}before=${before || '-'} got=${list.length} added=${added} next=${data.nextBefore || '-'}`);
      if (!before && !reconcile) { this.autoScroll = true; this.chatEl.scrollTop = this.chatEl.scrollHeight; this._clearUnread(); }
    } catch (err) {
      this._sys(`Historie nedostupná (${err.name === 'AbortError' ? 'timeout' : err.message})`);
      this._historyCooldownUntil = performance.now() + 3000;
      this._ucLog('History', `error before=${before || '-'} ${err.message}`);
    } finally {
      clearTimeout(t);
    }
    return added;
  }

  // ArrowUp/Down historie odeslaných zpráv — z toho, co server vrátil.
  // Mezera mezi odpovědí /chat/history a JOINem na platformu (log 2026-09-19
  // 17:33: historie 44.18 s, Twitch connected 46.07 s → 4 zprávy v rušném
  // chatu propadly). Po každém 'connected' se historie stáhne ještě jednou;
  // dedup podle id nechá jen to, co chybí, a zařadí to podle času.
  _scheduleReconcile() {
    clearTimeout(this._reconcileT);
    this._reconcileT = setTimeout(() => {
      this._reconcileT = null;
      this._loadHistory({ reconcile: true, limit: 100 }).catch(() => {});
    }, 2500);
  }

  _fillMsgHistoryFromStore() {
    const myNames = new Set();
    if (this.config.username) myNames.add(this.config.username.toLowerCase());
    for (const name of Object.values(this._platformUsernames)) if (name) myNames.add(name.toLowerCase());
    if (!myNames.size) return;
    const hist = [];
    for (const m of this.store.slice()) {
      if (m.username && myNames.has(m.username.toLowerCase()) && m.message) {
        const text = m.message.replace(' ' + UC_MARKER, '').replace(UC_MARKER, '');
        if (text) hist.push(text);
      }
    }
    this._msgHistory = hist.slice(-50);
  }

  // Vyčistit vše — nový store, prázdný DOM, žádné parky (přepnutí streamera, dev tlačítko).
  _resetChat() {
    this.store = new ChatStore();
    this.chatEl.innerHTML = '';
    this._parkedTop = [];
    this._parkedBottom = [];
    this._prependCursor = null;
    this._optimisticKeys = new Map();
    this._clearUnread();
  }

  // Nad oknem: uzly, co vypadly nahoře, se odpojí a schovají (ne zahodí),
  // ať je scroll nahoru vrátí bez renderu. Volá se jen když je uživatel dole.
  _unloadTop() {
    const over = this.chatEl.children.length - this.DOM_WINDOW;
    if (over <= 0) return;
    for (let i = 0; i < over; i++) {
      const first = this.chatEl.firstElementChild;
      if (!first) break;
      first.remove();
      this._parkedTop.push(first);
    }
    // Pojistka proti neomezenému růstu za dlouhou session (data zůstávají ve store).
    if (this._parkedTop.length > 5000) this._parkedTop.splice(0, this._parkedTop.length - 5000);
  }

  _unloadBottom() {
    const over = this.chatEl.children.length - this.DOM_WINDOW;
    if (over <= 0) return;
    const taken = [];
    for (let i = 0; i < over; i++) {
      const last = this.chatEl.lastElementChild;
      if (!last) break;
      last.remove();
      taken.unshift(last);
    }
    this._parkedBottom = taken.concat(this._parkedBottom);
    this.autoScroll = false;
  }

  async _extendUp() {
    if (this._historyBusy || performance.now() < this._historyCooldownUntil) return;
    this._historyBusy = true;
    try {
      const prevHeight = this.chatEl.scrollHeight, prevTop = this.chatEl.scrollTop;
      if (this._parkedTop.length) {
        const batch = this._parkedTop.splice(-100, 100);
        const first = this.chatEl.firstElementChild;
        for (const node of batch) this.chatEl.insertBefore(node, first);
      } else if (this.store.oldestCursor) {
        const spinner = document.createElement('div');
        spinner.className = 'hydrate-spinner';
        spinner.innerHTML = '<span class="hs-ring" aria-hidden="true"></span><span class="hs-label">Načítání starších zpráv…</span>';
        this.chatEl.insertBefore(spinner, this.chatEl.firstChild);
        await new Promise((r) => requestAnimationFrame(() => r()));
        const h0 = this.chatEl.scrollHeight, t0 = this.chatEl.scrollTop;
        const added = await this._loadHistory({ before: this.store.oldestCursor });
        spinner.remove();
        if (!added) return;
        this._programmaticScrollUntil = performance.now() + 50;
        this.chatEl.scrollTop = t0 + (this.chatEl.scrollHeight - h0);
        this._unloadBottom();
        return;
      } else {
        return;
      }
      this._programmaticScrollUntil = performance.now() + 50;
      this.chatEl.scrollTop = prevTop + (this.chatEl.scrollHeight - prevHeight);
      this._unloadBottom();
    } finally {
      this._historyBusy = false;
    }
  }

  _extendDown() {
    if (!this._parkedBottom.length) return;
    const batch = this._parkedBottom.splice(0, 100);
    for (const node of batch) this.chatEl.appendChild(node);
    // Uvolnit místo nahoře, ať okno nepřeroste.
    const over = this.chatEl.children.length - this.DOM_WINDOW;
    for (let i = 0; i < over; i++) {
      const first = this.chatEl.firstElementChild;
      if (!first) break;
      first.remove();
      this._parkedTop.push(first);
    }
  }

  // „N nových" / konec chatu: vrátit vše zpod okna, ořezat nahoře, dolů.
  _jumpToLatest() {
    if (this._parkedBottom.length) {
      for (const node of this._parkedBottom) this.chatEl.appendChild(node);
      this._parkedBottom = [];
    }
    this.autoScroll = true;
    this._unloadTop();
    this._clearUnread();
    this._programmaticScrollUntil = performance.now() + 200;
    this.chatEl.scrollTop = this.chatEl.scrollHeight;
  }

  _contentKey(username, message) {
    if (!username || !message) return null;
    const norm = (s) => (s || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[^a-z0-9\s]/g, '')
      .trim()
      .substring(0, 80);
    // Úvodní @zmínka se nepočítá: optimistická odpověď napříč platformami ji v UnityChatu nemá, echo ano.
    return norm(username) + '|' + norm(String(message).replace(/^\s*@\S+\s+/, ''));
  }

  // Odeslání selhalo → optimistická zpráva nesmí dál vypadat jako odeslaná.
  // Dosud zůstala v DOM i v cache s _optimistic:true a po reloadu se vykreslila
  // znovu — z pohledu uživatele "poslal jsem to", přitom nikam nešla.
  /** Odebrat optimistickou zprávu (DOM, store, párovací klíč) — skutečná přijde z chatu. */
  _dropOptimistic(optId) {
    this.chatEl.querySelector(`[data-msg-id="${CSS.escape(optId)}"]`)?.remove();
    this.store.remove(optId);
    for (const [key, id] of this._optimisticKeys) {
      if (id === optId) { this._optimisticKeys.delete(key); break; }
    }
  }

  _markSendFailed(optId, reason) {
    const el = this.chatEl.querySelector(`[data-msg-id="${CSS.escape(optId)}"]`);
    if (el) {
      el.classList.add('send-failed');
      el.title = `Neodesláno: ${reason} — klikni pro vložení zpět do inputu`;
      el.addEventListener('click', () => {
        const tx = el.querySelector('.tx');
        if (!tx || !this.msgInput) return;
        this.msgInput.value = tx.textContent.trim();
        this.msgInput.focus();
        this._autoResizeInput?.();
      }, { once: true });
    }

    this.store.markFailed(optId);

    // Uvolnit párovací klíč — pozdější reálná zpráva se stejným textem
    // (třeba po ručním poslání ve vanilla chatu) by jinak tuhle mrtvou
    // optimistickou zprávu "upgradla" místo aby se vykreslila sama.
    for (const [key, id] of this._optimisticKeys) {
      if (id === optId) { this._optimisticKeys.delete(key); break; }
    }

    try {
      chrome.runtime.sendMessage({ type: 'UC_LOG', tag: 'SendFail', args: [optId, reason] }).catch(() => {});
    } catch {}
  }

  _upgradeOptimistic(optId, realMsg) {
    // Update DOM element in-place
    const el = this.chatEl.querySelector(`[data-msg-id="${CSS.escape(optId)}"]`);
    // Vlastní odpověď napříč platformami: echo nese „@jméno text", v UnityChatu bez něj.
    if (el?.dataset.ucReplyUser && window.UC_CORE?.stripReplyMention) {
      realMsg = window.UC_CORE.stripReplyMention({ ...realMsg, replyTo: { username: el.dataset.ucReplyUser } });
    }
    if (el && realMsg.id) { el.dataset.msgId = realMsg.id; if (realMsg.timestamp) el.dataset.ts = String(realMsg.timestamp); }
    // uc-mark mohl přijít dřív než echo (server byl rychlejší) → teď, když má element skutečné id.
    if (el && this._ucMarkedIds?.has(realMsg.id)) this._applyUcMark({ platform: realMsg.platform, id: realMsg.id });

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
        // Kick má vlastní badge (moderátor apod.) — dřív se hledal jen v Twitch mapě a po echu zmizel.
        const entry = this._badgeEntry(realMsg.platform, badge);
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
        this.emotes.learnTwitch(realMsg.message, realMsg.twitchEmotes, realMsg.twitchEmotesOffset || 0);
        tx.innerHTML = this.emotes.renderTwitch(realMsg.message, realMsg.twitchEmotes, {
          platform: 'twitch',
          author: realMsg.username,
          emotesOffset: realMsg.twitchEmotesOffset || 0,
        });
        // Re-apply @mention highlighting — innerHTML overwrite wiped spans
        this._processMentions(tx, realMsg.platform);
      }
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

  _clearUnread() {
    this._unreadCount = 0;
    this.scrollBtn.classList.add('hidden');
    document.getElementById('unread-separator')?.remove();
  }

  // Czech plural rules for the "N new messages" pill. 1 → singular;
  // 2-4 → few form; 0 + 5+ → many form.
  _formatNewMsgCount(n) {
    const abs = Math.abs(n);
    if (abs === 1) return `${n} nová zpráva`;
    if (abs >= 2 && abs <= 4) return `${n} nové zprávy`;
    return `${n} nových zpráv`;
  }

  _scroll(slideEl = null) {
    if (this.autoScroll) {
      requestAnimationFrame(() => {
        // Open a 200ms suppression window so the resulting scroll event
        // (which can fire after more messages have appended in a busy
        // chat) doesn't get re-interpreted as the user scrolling away.
        this._programmaticScrollUntil = performance.now() + 200;
        this.chatEl.scrollTop = this.chatEl.scrollHeight;
        if (slideEl) window.UC_CORE?.slideInMessage?.(this.chatEl, slideEl);
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
