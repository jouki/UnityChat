// UnityChat - YouTube content script
// DOM přístup pro otevřený chat, background proxy pro zavřený chat (obchází CSP)

(function () {
  if (window._ucYoutube) return;
  window._ucYoutube = true;
  const isLiveChat = window.location.pathname.startsWith('/live_chat');
  const isMainFrame = window === window.top;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PING' && isMainFrame) {
      const hasLiveChat =
        !!document.querySelector('ytd-live-chat-frame') ||
        window.location.href.includes('/live');
      if (hasLiveChat) {
        // Username z YouTube profil menu (@handle)
        const handleEl = document.querySelector('yt-formatted-string#channel-handle');
        const username = handleEl?.textContent?.trim()?.replace(/^@/, '') || null;
        sendResponse({ platform: 'youtube', username });
      }
      return;
    }

    if (msg.type === 'SEND_CHAT') {
      if (isLiveChat) {
        sendDirect(msg.text)
          .then(() => sendResponse({ ok: true }))
          .catch((e) => sendResponse({ ok: false, error: e.message }));
        return true;
      }
      if (isMainFrame) {
        sendSmart(msg.text)
          .then(() => sendResponse({ ok: true }))
          .catch((e) => sendResponse({ ok: false, error: e.message }));
        return true;
      }
    }
  });

  // Přímé odeslání v live_chat iframe
  async function sendDirect(text) {
    const input = findInput(document);
    if (!input) throw new Error('YouTube chat input nenalezen');
    input.focus();
    input.textContent = '';
    document.execCommand('insertText', false, text);
    await new Promise((r) => setTimeout(r, 150));
    const btn = findSendBtn(document);
    if (btn) btn.click();
  }

  // Zkusí iframe DOM, pak API přes background
  async function sendSmart(text) {
    const frame = document.querySelector('#chatframe, iframe[src*="live_chat"]');

    // 1. Zkusit iframe DOM (přímé psaní do inputu)
    if (frame) {
      try {
        const doc = frame.contentDocument;
        if (doc) {
          for (let i = 0; i < 3; i++) {
            const input = findInput(doc);
            if (input) {
              input.focus();
              input.textContent = '';
              frame.contentWindow.document.execCommand('insertText', false, text);
              await new Promise((r) => setTimeout(r, 150));
              const btn = findSendBtn(doc);
              if (btn) btn.click();
              return;
            }
            await new Promise((r) => setTimeout(r, 300));
          }
        }
      } catch {}
    }

    // 2. Force-load iframe → extract params → API send (correct channel).
    //    When chat is collapsed, #chatframe exists but is empty. Loading its
    //    src populates it with YouTube's session context (correct channel).
    //    We extract sendLiveChatMessageEndpoint params from the loaded HTML
    //    and use them for the API call (DOM send is unreliable in force-loaded iframes).
    const videoId = getVideoId();
    if (frame && videoId) {
      try {
        const doc = frame.contentDocument;
        const isEmpty = !doc || doc.documentElement.innerHTML.length < 1000;

        if (isEmpty) {
          const chatUrl = `https://www.youtube.com/live_chat?v=${videoId}&is_popout=0`;
          frame.src = chatUrl;
          await new Promise((resolve) => {
            const onLoad = () => { frame.removeEventListener('load', onLoad); resolve(); };
            frame.addEventListener('load', onLoad);
            setTimeout(resolve, 8000);
          });
          await new Promise((r) => setTimeout(r, 500));
        }

        const loadedDoc = frame.contentDocument;
        if (loadedDoc) {
          const iframeHtml = loadedDoc.documentElement.innerHTML;
          let pm = iframeHtml.match(/"sendLiveChatMessageEndpoint"\s*:\s*\{[^}]*"params"\s*:\s*"([^"]+)"/);
          if (!pm) pm = iframeHtml.match(/"sendLiveChatMessageEndpoint"\s*:\s*\{[\s\S]{0,500}?"params"\s*:\s*"([^"]+)"/);
          if (pm) {
            const result = await chrome.runtime.sendMessage({
              type: 'YT_SEND',
              videoId,
              text,
              iframeParams: pm[1]
            });
            if (result?.ok) return;
          }
        }
      } catch {}
    }

    // 3. Fallback: API přes background (fetchne /live_chat fresh — may use wrong channel)
    if (!videoId) throw new Error('Video ID nenalezeno');

    const result = await chrome.runtime.sendMessage({
      type: 'YT_SEND',
      videoId,
      text
    });

    if (!result?.ok) {
      throw new Error(result?.error || 'YouTube odeslání selhalo');
    }
  }

  function getVideoId() {
    // ?v= parametr
    const vParam = new URLSearchParams(window.location.search).get('v');
    if (vParam) return vParam;
    // Canonical link
    const canon = document.querySelector('link[rel="canonical"]');
    if (canon?.href) {
      const m = canon.href.match(/v=([A-Za-z0-9_-]{11})/);
      if (m) return m[1];
    }
    // og:url meta
    const og = document.querySelector('meta[property="og:url"]');
    if (og?.content) {
      const m = og.content.match(/v=([A-Za-z0-9_-]{11})/);
      if (m) return m[1];
    }
    return null;
  }

  function findInput(doc) {
    return doc.querySelector(
      'div#input[contenteditable="true"], yt-live-chat-text-input-field-renderer #input'
    );
  }

  function findSendBtn(doc) {
    return doc.querySelector(
      '#send-button button, yt-button-renderer#send-button button, ' +
        'button[aria-label*="Send"], button[aria-label*="Odeslat"]'
    );
  }
})();
