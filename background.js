// UnityChat - Background Service Worker

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

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
const _logs = [];
function ucLog(tag, ...args) {
  const line = `[${new Date().toISOString()}] [${tag}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}`;
  _logs.push(line);
  console.log(line);
  if (_logs.length > 500) _logs.splice(0, _logs.length - 300);
}
async function dumpLogs() {
  const text = _logs.join('\n');
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
    ucLog(msg.tag, ...msg.args);
    return;
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

  if (msg.type === 'TW_REPLY' && sender.tab?.id) {
    ucLog('TW_REPLY', 'parentMsgId:', msg.parentMsgId, 'broadcasterId:', msg.broadcasterId);
    twReply(sender.tab.id, msg.parentMsgId, msg.text, msg.username, msg.broadcasterId || null)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'YT_SEND' && sender.tab?.id) {
    ytSend(sender.tab.id, msg.videoId, msg.text)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

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
          badges[`${b.set_id}/${v.id}`] = v.image_url_1x;
        }
      }
    }
    if (roomId) {
      const cr = await fetch(`https://api.ivr.fi/v2/twitch/badges/channel?id=${roomId}`);
      if (cr.ok) {
        for (const b of await cr.json()) {
          for (const v of b.versions || []) {
            badges[`${b.set_id}/${v.id}`] = v.image_url_1x;
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

          // 1. Najdi message container [data-a-user], pak klikni na element s textem username
          const aUserEls = document.querySelectorAll('[data-a-user]');
          log.push(`[data-a-user] count: ${aUserEls.length}`);
          for (const container of aUserEls) {
            if (container.dataset.aUser?.toLowerCase() !== lower) continue;
            // Klikni na element jehož TEXT je přesně username (ne badge/ikona)
            for (const el of container.querySelectorAll('button, span, a')) {
              const txt = el.textContent.trim();
              if (txt.toLowerCase() === lower && !el.querySelector('img')) {
                log.push(`Clicking: <${el.tagName}> "${txt}"`);
                el.click();
                return 'clicked|' + log.join('; ');
              }
            }
            log.push('Container found but no text-matching element');
          }

          // 2. Text search v chat zprávách (přeskočit viewer list)
          const lines = document.querySelectorAll(
            '[class*="chat-line"], [class*="seventv"], [data-a-target="chat-line-message"]'
          );
          log.push(`chat-lines: ${lines.length}`);
          for (const line of lines) {
            for (const el of line.querySelectorAll('span, button')) {
              if (el.closest('.chatter-list-item')) continue;
              const txt = el.textContent.trim().toLowerCase();
              if (txt === lower && el.offsetParent !== null) {
                log.push(`Found text: <${el.tagName} class="${el.className}">`);
                el.click();
                return 'clicked:text|' + log.join('; ');
              }
            }
          }

          return 'not_found|' + log.join('; ');
        },
        args: [username]
      });

      const res = results?.[0]?.result || '';
      ucLog('UserCard', 'executeScript result:', res);
      if (res.startsWith('clicked')) return;
    } catch (e) {
      ucLog('UserCard', 'executeScript error:', e.message);
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
        body: JSON.stringify({ query: `{ user(login: "${username.toLowerCase()}") {
          id login displayName profileImageURL(width: 70) createdAt
          roles { isAffiliate isPartner }
          ${broadcasterId ? `relationship(targetUserID: "${broadcasterId}") { followedAt }` : ''}
        }}`})
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

          const card = document.createElement('div');
          card.className = 'uc-card';
          card.style.cssText = 'position:fixed;right:80px;top:80px;width:320px;background:#18181b;border:1px solid #3a3a3d;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,0.8);z-index:99999;font-family:Inter,-apple-system,sans-serif;overflow:hidden;';
          card.innerHTML = `
            <div style="padding:16px;display:flex;align-items:center;gap:12px;background:#0e0e10;cursor:grab;" class="uc-hdr">
              <img src="${user.profileImageURL}" style="width:56px;height:56px;border-radius:50%;border:2px solid #9146ff;">
              <div style="flex:1;min-width:0;">
                <div style="font-weight:700;font-size:16px;color:#efeff1;">${user.displayName}</div>
                ${role ? `<div style="font-size:11px;color:#bf94ff;margin-top:2px;">${role}</div>` : ''}
              </div>
              <a href="https://www.twitch.tv/${user.login}" target="_blank" style="color:#adadb8;font-size:16px;text-decoration:none;padding:4px;" title="Profil">↗</a>
              <button class="uc-x" style="background:none;border:none;color:#adadb8;font-size:18px;cursor:pointer;padding:4px;">✕</button>
            </div>
            <div style="padding:12px 16px;display:flex;flex-direction:column;gap:6px;font-size:13px;color:#dedee3;">
              ${created ? `<div>📅 Založení účtu ${created}</div>` : ''}
              ${followed ? `<div>💜 Sleduje od ${followed}</div>` : '<div style="color:#666;">Nesleduje kanál</div>'}
            </div>`;
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
            query: `query { user(login: "${ch}") { id } }`
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

async function ytSend(tabId, videoId, text) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (videoId, text) => {
        try {
          const gc = (k) =>
            typeof ytcfg !== 'undefined' && ytcfg.get ? ytcfg.get(k) : null;
          const apiKey =
            gc('INNERTUBE_API_KEY') || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
          const cVer = gc('INNERTUBE_CLIENT_VERSION') || '2.20250401.00.00';

          // Fetch live_chat page pro send params
          const chatResp = await fetch('/live_chat?v=' + videoId);
          const chatHtml = await chatResp.text();
          const pm = chatHtml.match(
            /"sendLiveChatMessageEndpoint"\s*:\s*\{[^}]*"params"\s*:\s*"([^"]+)"/
          );
          if (!pm) return { ok: false, error: 'Send params nenalezeny' };

          // Odeslat zprávu
          const r = await fetch(
            '/youtubei/v1/live_chat/send_message?key=' + apiKey,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                context: {
                  client: { clientName: 'WEB', clientVersion: cVer }
                },
                params: pm[1],
                richMessage: { textSegments: [{ text }] }
              })
            }
          );

          if (r.ok) return { ok: true };
          if (r.status === 401 || r.status === 403)
            return { ok: false, error: 'Nejsi přihlášen na YouTube' };
          return { ok: false, error: 'YouTube API: HTTP ' + r.status };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      },
      args: [videoId, text]
    });

    return results?.[0]?.result || { ok: false, error: 'Žádný výsledek' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
