// UnityChat - Background Service Worker
//
// Runtime browser detection for UI entry points:
//
//   Chrome:
//     manifest "sidePanel" permission + "side_panel" key → native side panel.
//     We call sidePanel.setPanelBehavior to make the toolbar action open it.
//
//   Opera:
//     chrome.sidePanel is undefined. Opera uses the "sidebar_action" manifest
//     key (Firefox-style) to surface UnityChat in its native left sidebar —
//     no JS is needed for that, Opera picks it up from the manifest.
//     As a second entry point, the toolbar action creates a popup window, so
//     users who prefer a floating window (or who haven't pinned the sidebar)
//     still have something to click.

const HAS_SIDE_PANEL = typeof chrome.sidePanel !== 'undefined'
  && typeof chrome.sidePanel.setPanelBehavior === 'function';

// Track side panel state via persistent port connection (survives SW restarts)
let _panelPort = null;
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidepanel') {
    _panelPort = port;
    port.onDisconnect.addListener(() => { _panelPort = null; });
  }
});

if (HAS_SIDE_PANEL) {
  // Chrome path: clicking the toolbar action opens the native side panel.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.warn('sidePanel.setPanelBehavior failed:', e));
} else {
  // Opera path: the native sidebar is wired via "sidebar_action" in the
  // manifest. The toolbar action falls back to a popup window.
  let _ucWindowId = null;

  chrome.action.onClicked.addListener(async () => {
    if (_ucWindowId !== null) {
      try {
        const win = await chrome.windows.get(_ucWindowId);
        if (win) {
          chrome.windows.update(_ucWindowId, { focused: true });
          return;
        }
      } catch {
        _ucWindowId = null;
      }
    }
    const win = await chrome.windows.create({
      url: 'sidepanel.html',
      type: 'popup',
      width: 420,
      height: 720
    });
    _ucWindowId = win.id;
  });

  chrome.windows.onRemoved.addListener((windowId) => {
    if (windowId === _ucWindowId) _ucWindowId = null;
  });
}

// Restore the update-available badge on service-worker startup. MV3 workers
// shut down under idle and lose in-memory state, but chrome.action badge is
// persistent in browser session; we still re-assert from storage to survive
// `chrome.action.*` internal clears between worker lifecycles.
(async () => {
  try {
    const d = await chrome.storage.local.get('uc_update');
    if (d?.uc_update?.version) {
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#e5484d' });
      if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#ffffff' });
      chrome.action.setTitle({ title: `UnityChat — UPDATE available (v${d.uc_update.version})` });
    }
  } catch {}
})();

// Periodic update poll — fires every 15 min via chrome.alarms (survives
// service-worker shutdown). Also runs once on each worker spin-up so the
// badge appears within seconds of an extension install/restart even before
// the alarm clock ticks. Sidepanel does its own check on open, so a freshly
// opened panel never sees stale state either.
const UC_UPDATE_ALARM = 'uc-update-check';
const UC_UPDATE_MANIFEST_URL = 'https://jouki.cz/download/manifest.json';

function _ucIsNewerVersion(remote, current) {
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

async function ucCheckForUpdate() {
  try {
    const current = chrome.runtime.getManifest().version;
    const r = await fetch(UC_UPDATE_MANIFEST_URL, { cache: 'no-store' });
    if (!r.ok) return;
    const remote = await r.json();
    const latest = remote?.version;
    if (!latest) return;
    if (_ucIsNewerVersion(latest, current)) {
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#e5484d' });
      if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#ffffff' });
      chrome.action.setTitle({ title: `UnityChat — UPDATE available (v${latest})` });
      await chrome.storage.local.set({ uc_update: { version: latest, at: Date.now() } });
      // Notify any open sidepanel so its in-panel tooltip lights up live,
      // without waiting for the user to close+reopen the panel.
      chrome.runtime.sendMessage({ type: 'UC_UPDATE_AVAILABLE', version: latest }).catch(() => {});
    } else {
      chrome.action.setBadgeText({ text: '' });
      chrome.action.setTitle({ title: 'UnityChat - Otevřít sjednocený chat' });
      await chrome.storage.local.remove('uc_update');
      chrome.runtime.sendMessage({ type: 'UC_UPDATE_CLEARED' }).catch(() => {});
    }
  } catch {}
}

// Create/refresh the alarm on every worker spin-up — chrome.alarms.create
// with the same name is a no-op if it already exists with the same period,
// so this is cheap and self-healing.
chrome.alarms.create(UC_UPDATE_ALARM, { periodInMinutes: 15 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UC_UPDATE_ALARM) ucCheckForUpdate();
});
// Also kick off a check immediately on this worker spin-up.
ucCheckForUpdate();

// Při instalaci/updatu injektovat content scripty do už otevřených tabů
chrome.runtime.onInstalled.addListener(async () => {
  const targets = [
    { matches: '*://*.twitch.tv/*', file: 'content/twitch.js' },
    { matches: '*://*.youtube.com/*', file: 'content/youtube.js', allFrames: true },
    { matches: '*://*.kick.com/*', file: 'content/kick.js' }
  ];

  for (const t of targets) {
    try {
      const tabs = await chrome.tabs.query({ url: t.matches });
      for (const tab of tabs) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: !!t.allFrames },
          files: [t.file]
        }).catch(() => {});
      }
    } catch {}
  }
});

// ---- Debug Log (ukládá do Downloads/unitychat-debug.log) ----
// MV3 service workers sleep after ~30s of inactivity and lose all module
// state on wake. Persisting to chrome.storage.session keeps the log alive
// across worker restarts within the same browser session.
let _logs = [];
let _logsHydrated = false;
let _logsSaveT = null;
let _bootWatchT = null;

async function _hydrateLogs() {
  if (_logsHydrated) return;
  try {
    const r = await chrome.storage.session.get('uc_logs');
    if (Array.isArray(r.uc_logs)) _logs = r.uc_logs;
  } catch {}
  _logsHydrated = true;
}
function _scheduleLogPersist() {
  if (_logsSaveT) return;
  _logsSaveT = setTimeout(() => {
    _logsSaveT = null;
    chrome.storage.session.set({ uc_logs: _logs }).catch(() => {});
  }, 800);
}

function ucLog(tag, ...args) {
  const line = `[${new Date().toISOString()}] [${tag}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}`;
  _logs.push(line);
  console.log(line);
  if (_logs.length > 500) _logs.splice(0, _logs.length - 300);
  _scheduleLogPersist();
}
async function dumpLogs() {
  await _hydrateLogs();
  const text = _logs.length ? _logs.join('\n') : '(log empty — service worker may have just been restarted; reproduce the issue then re-dump)';
  const url = 'data:text/plain;base64,' + btoa(unescape(encodeURIComponent(text)));
  try {
    await chrome.downloads.download({ url, filename: 'unitychat-debug.log', conflictAction: 'overwrite', saveAs: false });
  } catch (e) { console.error('Log dump failed:', e); }
}

// ---- Message handlers ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Log dump
  if (msg.type === 'DUMP_LOGS') {
    dumpLogs().then(() => sendResponse({ ok: true }));
    return true;
  }
  // Log relay (z side panelu)
  if (msg.type === 'UC_LOG') {
    _hydrateLogs().then(() => {
      // Accept either {args:[...]} or {text:"..."} for convenience.
      if (Array.isArray(msg.args)) ucLog(msg.tag || 'UC', ...msg.args);
      else if (typeof msg.text === 'string') ucLog(msg.tag || 'UC', msg.text);
      sendResponse?.({ ok: true });
    });
    return true;
  }

  // Boot watchdog: side panel announces start; if END doesn't arrive within
  // 20s, we assume it froze and auto-dump the log so the user has something
  // to share even when the 💾 button stopped responding. The dump runs in
  // the service worker, which stays alive independently of the panel UI.
  if (msg.type === 'BOOT_WATCH_START') {
    clearTimeout(_bootWatchT);
    ucLog('Boot', 'watchdog armed (20s)');
    _bootWatchT = setTimeout(() => {
      ucLog('Boot', 'WATCHDOG FIRED — panel did not report _init done within 20s; auto-dumping logs');
      dumpLogs();
    }, 20000);
    sendResponse?.({ ok: true });
    return false;
  }
  if (msg.type === 'BOOT_WATCH_END') {
    clearTimeout(_bootWatchT);
    _bootWatchT = null;
    ucLog('Boot', 'watchdog cleared — panel reported _init done');
    sendResponse?.({ ok: true });
    return false;
  }

  // Toggle side panel from content script (UC button in Twitch/YouTube).
  // Chrome requires sidePanel.open() to run inside the user gesture chain.
  if (msg.type === 'TOGGLE_SIDE_PANEL' || msg.type === 'OPEN_SIDE_PANEL') {
    const tabId = sender.tab?.id;
    const windowId = sender.tab?.windowId;
    const panelIsOpen = _panelPort !== null;
    const wantClose = msg.type === 'TOGGLE_SIDE_PANEL' && panelIsOpen;

    if (HAS_SIDE_PANEL && tabId != null) {
      if (wantClose) {
        // Tell the side panel to close itself via port message
        if (_panelPort) {
          _panelPort.postMessage({ type: 'CLOSE' });
          sendResponse({ ok: true, action: 'closed' });
        } else {
          sendResponse({ ok: false, error: 'Panel port not connected' });
        }
      } else {
        chrome.sidePanel.open({ tabId })
          .then(() => sendResponse({ ok: true, action: 'opened' }))
          .catch((e) => {
            if (windowId != null) {
              chrome.sidePanel.open({ windowId })
                .then(() => sendResponse({ ok: true, action: 'opened' }))
                .catch((err) => sendResponse({ ok: false, error: err.message }));
            } else {
              sendResponse({ ok: false, error: e.message });
            }
          });
      }
      return true;
    }
    // Opera (no sidePanel API) → popup window fallback (no toggle, just open)
    chrome.windows.create({
      url: 'sidepanel.html',
      type: 'popup',
      width: 420,
      height: 720
    }).then(() => sendResponse({ ok: true, action: 'opened' }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'SET_UPDATE_BADGE') {
    const v = msg.version || '?';
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#e5484d' });
    if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#ffffff' });
    chrome.action.setTitle({ title: `UnityChat — UPDATE available (v${v})` });
    chrome.storage.local.set({ uc_update: { version: v, at: Date.now() } }).catch(() => {});
    return;
  }
  if (msg.type === 'CLEAR_UPDATE_BADGE') {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'UnityChat - Otevřít sjednocený chat' });
    chrome.storage.local.remove('uc_update').catch(() => {});
    return;
  }
  if (msg.type === 'GET_CHAT_COLORS') {
    fetchChatColors(msg.usernames || [])
      .then((users) => sendResponse({ ok: true, users }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'LOAD_BADGES') {
    ucLog('Badges', 'Loading for channel:', msg.channel, 'roomId:', msg.roomId);
    loadTwitchBadges(msg.channel, msg.roomId)
      .then(sendResponse)
      .catch((e) => { ucLog('Badges', 'Error:', e.message); sendResponse({}); });
    return true;
  }

  if (msg.type === 'OPEN_USER_CARD') {
    ucLog('UserCard', 'open', msg.platform, msg.username, 'tab:', msg.tabId);
    openUserCard(msg.tabId, msg.username, msg.platform, msg.channel, msg.broadcasterId);
    return;
  }

  if (msg.type === 'CHECK_PIN') {
    checkPin(msg.channel, msg.messageId)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'FETCH_PINS') {
    fetchPins(msg.channel)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'PIN_MESSAGE') {
    pinMessage(msg.messageId, msg.broadcasterId, msg.durationSecs)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'TW_REPLY' && sender.tab?.id) {
    ucLog('TW_REPLY', 'parentMsgId:', msg.parentMsgId, 'broadcasterId:', msg.broadcasterId);
    twReply(sender.tab.id, msg.parentMsgId, msg.text, msg.username, msg.broadcasterId || null)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'YT_GET_USERNAME' && sender.tab?.id) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: 'MAIN',
      func: async () => {
        try {
          // 1) Try ytcfg keys first
          const gc = (k) => typeof ytcfg !== 'undefined' && ytcfg.get ? ytcfg.get(k) : null;
          const externalId = gc('CHANNEL_HANDLE') || gc('LOGGED_IN_CHANNEL_HANDLE');
          if (externalId) return { username: externalId.replace(/^@/, '') };

          // 2) Check if #channel-handle already in DOM (menu was opened before)
          let el = document.querySelector('yt-formatted-string#channel-handle, #channel-handle');
          if (el?.textContent?.trim()) return { username: el.textContent.trim().replace(/^@/, '') };

          // 3) Open avatar menu to force render, read username, close menu
          const avatarBtn = document.querySelector('button#avatar-btn, ytd-topbar-menu-button-renderer:last-child button');
          if (!avatarBtn) return { username: null };

          avatarBtn.click();
          // Wait for menu to render
          for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 100));
            el = document.querySelector('yt-formatted-string#channel-handle, #channel-handle');
            if (el?.textContent?.trim()) break;
          }
          const name = el?.textContent?.trim() || null;
          // Close menu — Escape key
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

          if (name) return { username: name.replace(/^@/, '') };
          return { username: null };
        } catch { return { username: null }; }
      }
    }).then(results => {
      sendResponse(results?.[0]?.result || { username: null });
    }).catch(() => sendResponse({ username: null }));
    return true;
  }

  if (msg.type === 'KICK_SEND' && sender.tab?.id) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: 'MAIN',
      func: async (slug, text, replyMeta) => {
        try {
          const ch = await (await fetch('/api/v2/channels/' + encodeURIComponent(slug))).json();
          const cid = ch?.chatroom?.id;
          if (!cid) return { ok: false, error: 'Chatroom nenalezen' };
          const xsrf = decodeURIComponent((document.cookie.match(/XSRF-TOKEN=([^;]*)/)||[])[1]||'');
          const body = replyMeta
            ? {
                content: text,
                type: 'reply',
                metadata: {
                  original_message: { id: replyMeta.messageId, content: replyMeta.message || '' }
                }
              }
            : { content: text, type: 'message' };
          const r = await fetch('/api/v2/messages/send/' + cid, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': xsrf },
            body: JSON.stringify(body)
          });
          if (r.ok) return { ok: true };
          if (r.status === 403) return { ok: false, error: 'Nejsi přihlášen na Kick' };
          const bodyText = await r.text().catch(() => '');
          return { ok: false, error: `HTTP ${r.status}${bodyText ? ': ' + bodyText.substring(0, 200) : ''}` };
        } catch (e) { return { ok: false, error: e.message }; }
      },
      args: [msg.slug, msg.text, msg.replyMeta || null]
    }).then(results => {
      sendResponse(results?.[0]?.result || { ok: false, error: 'executeScript failed' });
    }).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'YT_SEND' && sender.tab?.id) {
    ytSend(sender.tab.id, msg.videoId, msg.text, msg.iframeParams)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

// Fetch Twitch chat colors for up to 100 logins in one GQL request using
// field aliases (Twitch's `user(login:)` doesn't accept a list). chatColor
// is a public field — works without auth-token. Returns {loginLower: '#hex'}.
async function fetchChatColors(usernames) {
  if (!Array.isArray(usernames) || !usernames.length) return {};
  const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
  const cookie = await chrome.cookies.get({ url: 'https://www.twitch.tv', name: 'auth-token' });
  const headers = {
    'Client-Id': CLIENT_ID,
    'Content-Type': 'application/json',
    ...(cookie?.value ? { Authorization: 'OAuth ' + cookie.value } : {}),
  };
  const logins = [...new Set(usernames.map((u) => String(u).toLowerCase().replace(/^@/, '')))]
    .filter((u) => /^[a-z0-9_]{1,25}$/.test(u))
    .slice(0, 100);
  if (!logins.length) return {};

  const varDefs = logins.map((_, i) => `$l${i}: String!`).join(', ');
  const aliases = logins.map((_, i) => `u${i}: user(login: $l${i}) { id login chatColor }`).join(' ');
  const query = `query (${varDefs}) { ${aliases} }`;
  const variables = Object.fromEntries(logins.map((l, i) => [`l${i}`, l]));

  const r = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST', headers,
    body: JSON.stringify({ query, variables }),
  });
  const json = await r.json().catch(() => ({}));
  const data = json?.data || {};
  // Returns { login: { color, id } } — caller uses color for rendering and
  // id to kick off 7TV paint resolution for users whose msg objects didn't
  // carry a user-id (e.g. cached/scraped messages from an older schema).
  const out = {};
  for (const k of Object.keys(data)) {
    const u = data[k];
    if (!u?.login) continue;
    out[u.login.toLowerCase()] = { color: u.chatColor || null, id: u.id || null };
  }
  return out;
}

async function loadTwitchBadges(channel, roomId) {
  const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
  const cookie = await chrome.cookies.get({ url: 'https://www.twitch.tv', name: 'auth-token' });
  const gqlHeaders = {
    'Client-Id': CLIENT_ID,
    'Content-Type': 'application/json',
    ...(cookie?.value ? { Authorization: 'OAuth ' + cookie.value } : {})
  };

  const badges = {};

  // IVR API - veřejné, žádný auth, spolehlivé
  try {
    const gr = await fetch('https://api.ivr.fi/v2/twitch/badges/global');
    if (gr.ok) {
      for (const b of await gr.json()) {
        for (const v of b.versions || []) {
          badges[`${b.set_id}/${v.id}`] = { url: v.image_url_2x || v.image_url_1x, title: v.title || b.set_id };
        }
      }
    }
    if (roomId) {
      const cr = await fetch(`https://api.ivr.fi/v2/twitch/badges/channel?id=${roomId}`);
      if (cr.ok) {
        for (const b of await cr.json()) {
          for (const v of b.versions || []) {
            badges[`${b.set_id}/${v.id}`] = { url: v.image_url_2x || v.image_url_1x, title: v.title || b.set_id };
          }
        }
      }
    }
  } catch (e) { ucLog('Badges', 'IVR error:', e.message); }

  ucLog('Badges', `Total: ${Object.keys(badges).length}`);
  return badges;
}

async function openUserCard(tabId, username, platform, channel, broadcasterId) {
  if (platform === 'twitch') {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (name) => {
          const lower = name.toLowerCase();
          const log = [];
          const snippet = (el, max = 180) => {
            try { return (el.outerHTML || '').slice(0, max).replace(/\s+/g, ' '); }
            catch { return '<err>'; }
          };
          const isVisible = (el) => {
            if (!el || !el.getBoundingClientRect) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && el.offsetParent !== null;
          };

          // 7TV uses Vue.js — synthetic .click() is ignored. Real pointer
          // event sequence (pointerdown → pointerup → click) at the
          // element's center is what its handlers actually listen for.
          const realClick = (el) => {
            const r = el.getBoundingClientRect();
            const x = r.left + r.width / 2;
            const y = r.top + r.height / 2;
            const opts = (extra = {}) => ({
              bubbles: true, cancelable: true, composed: true,
              clientX: x, clientY: y, view: window, button: 0, buttons: 1,
              ...extra,
            });
            try { el.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', isPrimary: true, ...opts() })); } catch {}
            try { el.dispatchEvent(new MouseEvent('mousedown', opts())); } catch {}
            try { el.dispatchEvent(new PointerEvent('pointerup',   { pointerId: 1, pointerType: 'mouse', isPrimary: true, ...opts({ buttons: 0 }) })); } catch {}
            try { el.dispatchEvent(new MouseEvent('mouseup',   opts({ buttons: 0 }))); } catch {}
            try { el.dispatchEvent(new MouseEvent('click',     opts({ buttons: 0 }))); } catch {}
            try { el.click(); } catch {}
          };

          // 0. Preferred path for 7TV: click the .seventv-chat-user wrapper
          //    (7TV attaches its card-opening click handler to the wrapper,
          //    not the .seventv-chat-user-username text span). Iterate
          //    bottom-up so the most recent message wins → its message
          //    context is visible in the card.
          const stvWrappers = document.querySelectorAll('.seventv-chat-user');
          log.push(`stv-wrappers: ${stvWrappers.length}`);
          let stvMatched = 0;
          for (let i = stvWrappers.length - 1; i >= 0; i--) {
            const wrap = stvWrappers[i];
            const userEl = wrap.querySelector('.seventv-chat-user-username');
            const txt = (userEl?.textContent || '').trim().toLowerCase();
            if (txt !== lower) continue;
            stvMatched++;
            if (!isVisible(wrap)) {
              log.push(`stv match #${stvMatched} not visible: ${snippet(wrap, 80)}`);
              continue;
            }
            log.push(`stv click: ${snippet(wrap, 120)}`);
            // Try the inner username span first — that's where 7TV's
            // delegated listener is mounted in newer builds. Fall through
            // to wrapper if needed (kept second click as a safety net).
            const target = wrap.querySelector('.seventv-chat-user-username') || wrap;
            realClick(target);
            return 'clicked:stv-wrap|' + log.join(' | ');
          }
          if (stvMatched) log.push(`stv matches but none visible (${stvMatched})`);

          // 1. Twitch native: [data-a-user] container, click text matching username
          const aUserEls = document.querySelectorAll('[data-a-user]');
          log.push(`[data-a-user] count: ${aUserEls.length}`);
          let aUserMatched = 0;
          for (const container of aUserEls) {
            if (container.dataset.aUser?.toLowerCase() !== lower) continue;
            aUserMatched++;
            for (const el of container.querySelectorAll('button, span, a')) {
              const txt = el.textContent.trim();
              if (txt.toLowerCase() === lower && !el.querySelector('img')) {
                if (!isVisible(el)) continue;
                log.push(`a-user click: ${snippet(el, 120)}`);
                el.click();
                return 'clicked:a-user|' + log.join(' | ');
              }
            }
          }
          if (aUserMatched) log.push(`a-user matches but no visible text-only inside (${aUserMatched})`);

          // 2. Text search across chat-line / 7TV / native containers
          const lines = document.querySelectorAll(
            '[class*="chat-line"], [class*="seventv"], [data-a-target="chat-line-message"]'
          );
          log.push(`chat-lines: ${lines.length}`);
          let textTried = 0;
          for (const line of lines) {
            for (const el of line.querySelectorAll('span, button')) {
              if (el.closest('.chatter-list-item')) continue;
              const txt = el.textContent.trim().toLowerCase();
              if (txt !== lower) continue;
              textTried++;
              if (!isVisible(el)) continue;
              log.push(`text click: ${snippet(el, 120)}`);
              el.click();
              return 'clicked:text|' + log.join(' | ');
            }
          }
          log.push(`text matches: ${textTried}`);

          return 'not_found|' + log.join(' | ');
        },
        args: [username]
      });

      const res = results?.[0]?.result || '';
      ucLog('UserCard', `[${username}] executeScript result:`, res);
      if (res.startsWith('clicked')) return;
    } catch (e) {
      ucLog('UserCard', `[${username}] executeScript error:`, e.message);
    }

    // Fallback 2: hledat v 7TV Shadow DOM
    ucLog('UserCard', 'Fallback: 7TV shadow DOM');
    try {
      const res2 = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (username) => {
          const lower = username.toLowerCase();
          // 7TV shadow root
          const roots = document.querySelectorAll('[data-seventv-root], [class*="seventv"]');
          for (const r of roots) {
            const shadow = r.shadowRoot;
            if (!shadow) continue;
            for (const el of shadow.querySelectorAll('span, button, a')) {
              if (el.textContent.trim().toLowerCase() === lower && el.offsetParent !== null) {
                el.click();
                return 'clicked_7tv';
              }
            }
          }
          return 'not_found';
        },
        args: [username]
      });
      ucLog('UserCard', '7TV result:', res2?.[0]?.result);
      if (res2?.[0]?.result?.startsWith('clicked')) return;
    } catch (e) {
      ucLog('UserCard', '7TV error:', e.message);
    }

    // Fallback 3: floating card - fetch data v background (HttpOnly cookies), render v MAIN world
    ucLog('UserCard', 'Fallback: floating card');
    try {
      const cookie = await chrome.cookies.get({ url: 'https://www.twitch.tv', name: 'auth-token' });
      const gqlH = { 'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' };
      if (cookie?.value) gqlH.Authorization = 'OAuth ' + cookie.value;

      const r = await fetch('https://gql.twitch.tv/gql', { method: 'POST', headers: gqlH,
        body: JSON.stringify({
          query: `query ($login: String!${broadcasterId ? ', $targetId: ID!' : ''}) { user(login: $login) {
          id login displayName profileImageURL(width: 70) createdAt
          roles { isAffiliate isPartner }
          ${broadcasterId ? 'relationship(targetUserID: $targetId) { followedAt }' : ''}
        }}`,
          variables: { login: username.toLowerCase(), ...(broadcasterId ? { targetId: broadcasterId } : {}) }
        })
      });
      const user = (await r.json()).data?.user;
      if (!user) { ucLog('UserCard', 'User not found via GQL'); return; }
      ucLog('UserCard', 'GQL user found:', user.displayName);

      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (user) => {
          document.querySelector('.uc-card')?.remove();
          const fmt = (d) => new Date(d).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'long', year: 'numeric' });
          const created = user.createdAt ? fmt(user.createdAt) : '';
          const followed = user.relationship?.followedAt ? fmt(user.relationship.followedAt) : '';
          const role = user.roles?.isPartner ? 'Partner' : user.roles?.isAffiliate ? 'Affiliate' : '';

          const el = (tag, style, parent) => { const e = document.createElement(tag); if (style) e.style.cssText = style; if (parent) parent.appendChild(e); return e; };
          const txt = (tag, text, style, parent) => { const e = el(tag, style, parent); e.textContent = text; return e; };

          const card = el('div');
          card.className = 'uc-card';
          card.style.cssText = 'position:fixed;right:80px;top:80px;width:320px;background:#18181b;border:1px solid #3a3a3d;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,0.8);z-index:99999;font-family:Inter,-apple-system,sans-serif;overflow:hidden;';

          const hdr = el('div', 'padding:16px;display:flex;align-items:center;gap:12px;background:#0e0e10;cursor:grab;', card);
          hdr.className = 'uc-hdr';
          const img = el('img', 'width:56px;height:56px;border-radius:50%;border:2px solid #9146ff;', hdr);
          img.src = user.profileImageURL;
          const nameCol = el('div', 'flex:1;min-width:0;', hdr);
          txt('div', user.displayName, 'font-weight:700;font-size:16px;color:#efeff1;', nameCol);
          if (role) txt('div', role, 'font-size:11px;color:#bf94ff;margin-top:2px;', nameCol);
          const link = el('a', 'color:#adadb8;font-size:16px;text-decoration:none;padding:4px;', hdr);
          link.href = 'https://www.twitch.tv/' + encodeURIComponent(user.login);
          link.target = '_blank'; link.title = 'Profil'; link.textContent = '↗';
          const closeBtn = txt('button', '✕', 'background:none;border:none;color:#adadb8;font-size:18px;cursor:pointer;padding:4px;', hdr);
          closeBtn.className = 'uc-x';

          const body = el('div', 'padding:12px 16px;display:flex;flex-direction:column;gap:6px;font-size:13px;color:#dedee3;', card);
          if (created) txt('div', '📅 Založení účtu ' + created, null, body);
          if (followed) txt('div', '💜 Sleduje od ' + followed, null, body);
          else txt('div', 'Nesleduje kanál', 'color:#666;', body);
          card.querySelector('.uc-x').onclick = () => card.remove();
          let d=false,dx,dy;const h=card.querySelector('.uc-hdr');
          h.onmousedown=(e)=>{if(e.target.closest('button,a'))return;d=true;dx=e.clientX-card.offsetLeft;dy=e.clientY-card.offsetTop;h.style.cursor='grabbing';};
          document.addEventListener('mousemove',(e)=>{if(!d)return;card.style.left=(e.clientX-dx)+'px';card.style.top=(e.clientY-dy)+'px';card.style.right='auto';});
          document.addEventListener('mouseup',()=>{d=false;if(h)h.style.cursor='grab';});
          document.addEventListener('keydown',function f(e){if(e.key==='Escape'){card.remove();document.removeEventListener('keydown',f);}});
          document.body.appendChild(card);
        },
        args: [user]
      });
    } catch (e) {
      ucLog('UserCard', 'Floating card error:', e.message);
    }
  } else if (platform === 'kick') {
    chrome.windows.create({
      url: `https://kick.com/${username.toLowerCase()}`,
      type: 'popup',
      width: 400,
      height: 600
    });
  }
}

// Zkontrolovat jestli je pin stále aktivní (pinIdOrMsgId = pin entity ID)
async function checkPin(channel, pinIdOrMsgId) {
  const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
  try {
    const cookie = await chrome.cookies.get({ url: 'https://www.twitch.tv', name: 'auth-token' });
    const headers = {
      'Client-Id': CLIENT_ID,
      'Content-Type': 'application/json',
      ...(cookie?.value ? { Authorization: 'OAuth ' + cookie.value } : {})
    };

    const r = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST', headers,
      body: JSON.stringify({
        query: `query ($name: String!) {
          channel(name: $name) {
            pinnedChatMessages {
              edges { node { id } }
            }
          }
        }`,
        variables: { name: channel }
      })
    });

    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
    const data = await r.json();

    if (data.errors) {
      ucLog('Pin', 'CheckPin GQL errors:', JSON.stringify(data.errors));
      return { ok: false, error: 'GQL schema error' };
    }

    const edges = data.data?.channel?.pinnedChatMessages?.edges || [];
    // pinIdOrMsgId je pin entity ID (z PinChatMessage mutace)
    const stillPinned = edges.some(e => e.node?.id === pinIdOrMsgId);
    ucLog('Pin', `CheckPin: edges=${edges.length}, target=${pinIdOrMsgId}, stillPinned=${stillPinned}, ids=${JSON.stringify(edges.map(e => e.node?.id))}`);
    return { ok: true, stillPinned };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// FETCH_PINS: authoritative source for pin cards via Twitch GQL. Works
// regardless of chat UI visibility — DOM mirror would otherwise miss the
// pin when Twitch unmounts the highlight stack (hide-not-collapse + chat
// column width 0). Returns structured pin info the sidepanel renders into
// the highlights banner as kind:'pin' cards.
async function fetchPins(channel) {
  const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
  if (!channel) return { ok: false, error: 'no channel' };
  try {
    const cookie = await chrome.cookies.get({ url: 'https://www.twitch.tv', name: 'auth-token' });
    const headers = {
      'Client-Id': CLIENT_ID,
      'Content-Type': 'application/json',
      ...(cookie?.value ? { Authorization: 'OAuth ' + cookie.value } : {})
    };
    // Query pulls the pinner (via pinnedBy), message sender + badges,
    // message content with rich fragments (emotes carry ID we can resolve
    // to CDN URLs), pin timestamp and duration. Schema is reasonably
    // stable but Twitch occasionally renames fields — errors surface in
    // the Pin log for re-tuning.
    // Twitch disabled introspection on their public GQL endpoint (prev
    // attempt returned empty __type). Fallback: probe candidate fields
    // one at a time. Each failing field generates a GQL error we can
    // identify; fields that don't error are real. Runs once per session.
    if (!fetchPins._probed) {
      fetchPins._probed = true;
      const candidates = [
        'type', 'text', 'body', 'contentText', 'rawText', 'html',
        'messageID', 'messageId', 'pinnedMessageID', 'chatMessageID',
        'sender', 'user', 'author', 'fromUser', 'sourceUser',
        'fragments', 'emotes',
      ];
      for (const field of candidates) {
        try {
          const pr = await fetch('https://gql.twitch.tv/gql', {
            method: 'POST', headers,
            body: JSON.stringify({
              query: `query($n:String!){channel(name:$n){pinnedChatMessages{edges{node{${field}}}}}}`,
              variables: { name: channel }
            }),
          });
          const pdata = await pr.json();
          const err = pdata?.errors?.[0]?.message;
          if (err && /Cannot query field/.test(err)) {
            // field is NOT on PinnedChatMessage
          } else if (err) {
            // other error — field might exist but needs subselection
            ucLog('Pin', `PROBE ${field}: may exist (err: ${err.slice(0, 120)})`);
          } else {
            ucLog('Pin', `PROBE ${field}: EXISTS — data=${JSON.stringify(pdata?.data?.channel?.pinnedChatMessages?.edges?.[0]?.node || null)}`);
          }
        } catch (pe) { /* ignore */ }
      }
    }
    // Minimal working query (id/startsAt/endsAt/pinnedBy confirmed in
    // earlier diagnostics). Fields that previously errored (sender,
    // content, message, senderBadges, pinnedAt) are not direct on
    // PinnedChatMessage — introspection above should reveal the real
    // names so we can wire content + sender on the next iteration.
    const r = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST', headers,
      body: JSON.stringify({
        query: `query ($name: String!) {
          channel(name: $name) {
            pinnedChatMessages {
              edges {
                node {
                  id
                  startsAt
                  endsAt
                  pinnedBy { id login displayName }
                }
              }
            }
          }
        }`,
        variables: { name: channel }
      })
    });
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
    const data = await r.json();
    if (data.errors?.length) {
      ucLog('Pin', 'FetchPins GQL errors:', JSON.stringify(data.errors));
      return { ok: false, error: 'GQL ' + data.errors[0].message };
    }
    const edges = data.data?.channel?.pinnedChatMessages?.edges || [];
    const pins = edges.map((e) => {
      const n = e.node || {};
      const pinnedBy = n.pinnedBy || {};
      return {
        pinId: n.id,
        endsAt: n.endsAt,
        pinnedAt: n.startsAt,
        pinnedBy: pinnedBy.displayName || pinnedBy.login || null,
        // Sender + content populated once introspection log reveals the
        // actual field names on PinnedChatMessage. Sidepanel can fall
        // back to DOM mirror or _twitchBadges cache while we wait.
        author: null,
        authorLogin: null,
        authorUserId: null,
        authorColor: null,
        senderBadges: [],
        segments: [],
        contentText: '',
      };
    });
    return { ok: true, pins };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Mapování sekund → Twitch enum
function pinDurationEnum(secs) {
  if (secs <= 30) return 'PIN_DURATION_THIRTY_SECONDS';
  if (secs <= 60) return 'PIN_DURATION_ONE_MINUTE';
  if (secs <= 120) return 'PIN_DURATION_TWO_MINUTES';
  if (secs <= 300) return 'PIN_DURATION_FIVE_MINUTES';
  if (secs <= 600) return 'PIN_DURATION_TEN_MINUTES';
  if (secs <= 1800) return 'PIN_DURATION_THIRTY_MINUTES';
  return 'PIN_DURATION_ONE_HOUR';
}

async function pinMessage(messageId, broadcasterId, durationSecs) {
  const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
  try {
    const cookie = await chrome.cookies.get({ url: 'https://www.twitch.tv', name: 'auth-token' });
    if (!cookie?.value) return { ok: false, error: 'Nejsi přihlášen' };
    if (!broadcasterId) return { ok: false, error: 'Chybí broadcaster ID' };

    // Default: maximální duration (1h) - polling detekuje unpin dřív pokud je
    const duration = durationSecs ? pinDurationEnum(durationSecs) : 'PIN_DURATION_ONE_HOUR';

    const r = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: {
        'Client-Id': CLIENT_ID,
        Authorization: 'OAuth ' + cookie.value,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: `mutation PinChatMessage($input: PinChatMessageInput!) {
          pinChatMessage(input: $input) { __typename }
        }`,
        variables: {
          input: {
            channelID: broadcasterId,
            messageID: messageId,
            duration,
            type: 'MOD'
          }
        }
      })
    });

    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
    const data = await r.json();
    if (data.errors?.length) return { ok: false, error: data.errors[0].message };

    // Po pinnutí získat pin entity ID z seznamu pinned messages (last edge = nejnovější)
    let pinId = null;
    try {
      const lr = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: {
          'Client-Id': CLIENT_ID,
          Authorization: 'OAuth ' + cookie.value,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query: `query ($id: ID!) { channelByID: channel(id: $id) { pinnedChatMessages { edges { node { id } } } } }`,
          variables: { id: broadcasterId }
        })
      });
      if (lr.ok) {
        const ldata = await lr.json();
        const edges = ldata.data?.channelByID?.pinnedChatMessages?.edges || [];
        pinId = edges[edges.length - 1]?.node?.id || null;
      }
    } catch {}
    ucLog('Pin', 'Created, pinId:', pinId);
    return { ok: true, pinId };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function twReply(tabId, parentMsgId, text, username, broadcasterId) {
  const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

  try {
    const cookie = await chrome.cookies.get({
      url: 'https://www.twitch.tv',
      name: 'auth-token'
    });
    if (!cookie?.value) return { ok: false, error: 'Nejsi přihlášen na Twitch' };

    // Broadcaster ID fallback z URL tabu
    let channelId = broadcasterId;
    if (!channelId) {
      const tab = await chrome.tabs.get(tabId);
      const ch = tab.url?.match(/twitch\.tv\/(\w+)/)?.[1];
      if (ch) {
        // Získat channel ID přes GQL
        const r = await fetch('https://gql.twitch.tv/gql', {
          method: 'POST',
          headers: {
            'Client-Id': CLIENT_ID,
            Authorization: 'OAuth ' + cookie.value,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            query: `query ($login: String!) { user(login: $login) { id } }`,
            variables: { login: ch }
          })
        });
        if (r.ok) channelId = (await r.json()).data?.user?.id;
      }
    }
    if (!channelId) return { ok: false, error: 'Channel ID nenalezeno' };

    // Odeslat reply přes Twitch GQL (stejný endpoint co používá Twitch web app)
    const resp = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: {
        'Client-Id': CLIENT_ID,
        Authorization: 'OAuth ' + cookie.value,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: `mutation SendChatMessage($input: SendChatMessageInput!) {
          sendChatMessage(input: $input) { __typename }
        }`,
        variables: {
          input: {
            channelID: channelId,
            message: text,
            nonce: crypto.randomUUID(),
            replyParentMessageID: parentMsgId
          }
        }
      })
    });

    if (!resp.ok) return { ok: false, error: 'Twitch GQL: ' + resp.status };

    const data = await resp.json();
    if (data.errors?.length) {
      return { ok: false, error: data.errors[0].message };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function ytSend(tabId, videoId, text, iframeParams) {
  ucLog('YT_SEND', 'tabId:', tabId, 'videoId:', videoId, 'iframeParams:', !!iframeParams);
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (videoId, text, iframeParams) => {
        const log = [];
        try {
          const gc = (k) =>
            typeof ytcfg !== 'undefined' && ytcfg.get ? ytcfg.get(k) : null;
          const apiKey =
            gc('INNERTUBE_API_KEY') || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
          const cVer = gc('INNERTUBE_CLIENT_VERSION') || '2.20250401.00.00';
          const delegatedSessionId = gc('DELEGATED_SESSION_ID') || null;
          const datasyncId = gc('DATASYNC_ID') || null;
          const channelId = gc('CHANNEL_ID') || null;
          log.push('apiKey:' + apiKey.substring(0, 10));
          log.push('channelId:' + (channelId || 'none'));
          log.push('delegated:' + (delegatedSessionId || 'none'));
          log.push('datasync:' + (datasyncId || 'none'));

          // SAPISIDHASH auth — required for YouTube API when chat is closed
          const origin = 'https://www.youtube.com';
          const cookies = Object.fromEntries(
            document.cookie.split(';').map((c) => {
              const [k, ...v] = c.trim().split('=');
              return [k, v.join('=')];
            })
          );
          const sapisid = cookies['SAPISID'] || cookies['__Secure-3PAPISID'];
          let authHeader = null;
          if (sapisid) {
            const ts = Math.floor(Date.now() / 1000);
            const str = ts + ' ' + sapisid + ' ' + origin;
            const hashBuf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
            const hex = [...new Uint8Array(hashBuf)].map((b) => b.toString(16).padStart(2, '0')).join('');
            authHeader = 'SAPISIDHASH ' + ts + '_' + hex;
            log.push('auth:SAPISIDHASH');
          } else {
            log.push('auth:none(no SAPISID cookie)');
          }

          // Use iframe params if provided (correct channel), otherwise fetch
          let sendParams = iframeParams;
          if (sendParams) {
            log.push('params:iframe');
          } else {
            const chatResp = await fetch('/live_chat?v=' + videoId, { credentials: 'include' });
            if (!chatResp.ok) return { ok: false, error: 'live_chat fetch: ' + chatResp.status, log };
            const chatHtml = await chatResp.text();
            log.push('htmlLen:' + chatHtml.length);
            let pm = chatHtml.match(/"sendLiveChatMessageEndpoint"\s*:\s*\{[^}]*"params"\s*:\s*"([^"]+)"/);
            if (!pm) pm = chatHtml.match(/"sendLiveChatMessageEndpoint"\s*:\s*\{[\s\S]{0,500}?"params"\s*:\s*"([^"]+)"/);
            if (!pm) return { ok: false, error: 'Send params nenalezeny - otevři YouTube chat', log };
            sendParams = pm[1];
            log.push('params:fetched');
          }
          log.push('paramsLen:' + sendParams.length);

          // Odeslat zprávu
          const headers = { 'Content-Type': 'application/json', 'X-Origin': origin };
          if (authHeader) headers['Authorization'] = authHeader;

          // Build context with channel delegation
          // datasyncId format: "accountId||channelId" — use channelId part
          const activeChannelId = datasyncId?.includes('||')
            ? datasyncId.split('||')[1]
            : delegatedSessionId;
          log.push('activeChannel:' + (activeChannelId || 'none'));

          const context = { client: { clientName: 'WEB', clientVersion: cVer } };
          if (activeChannelId) {
            context.user = { delegatedSessionId: activeChannelId };
          }

          const r = await fetch('/youtubei/v1/live_chat/send_message?key=' + apiKey, {
            method: 'POST',
            credentials: 'include',
            headers,
            body: JSON.stringify({
              context,
              params: sendParams,
              richMessage: { textSegments: [{ text }] }
            })
          });

          log.push('apiStatus:' + r.status);
          if (r.ok) return { ok: true, log };
          if (r.status === 401 || r.status === 403)
            return { ok: false, error: 'Nejsi přihlášen na YouTube', log };
          return { ok: false, error: 'YouTube API: HTTP ' + r.status, log };
        } catch (e) {
          return { ok: false, error: e.message, log };
        }
      },
      args: [videoId, text, iframeParams || null]
    });

    const result = results?.[0]?.result || { ok: false, error: 'Žádný výsledek' };
    ucLog('YT_SEND', 'result:', JSON.stringify(result));
    return result;
  } catch (e) {
    ucLog('YT_SEND', 'execError:', e.message);
    return { ok: false, error: e.message };
  }
}
