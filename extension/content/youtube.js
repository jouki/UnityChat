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

    // 1. If chat is closed, open it invisibly (click YouTube's toggle).
    //    YouTube loads the iframe with correct channel session context.
    //    Then hide the panel so user only sees UnityChat.
    const chatPanel = document.querySelector('ytd-live-chat-frame');
    const chatVisible = chatPanel && chatPanel.offsetHeight > 100;

    if (!chatVisible && chatPanel) {
      // Find and click YouTube's show/hide chat button
      const toggleBtn = chatPanel.querySelector('#show-hide-button button, #show-hide-button ytd-toggle-button-renderer, #show-hide-button');
      if (toggleBtn) {
        toggleBtn.click();
        // Wait for iframe to load
        await new Promise((r) => setTimeout(r, 2000));
        // Hide the chat panel — YouTube thinks it's open, user doesn't see it
        if (!chatPanel.dataset.ucHidden) {
          chatPanel.style.cssText = 'position:absolute!important;width:1px!important;height:1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;opacity:0!important;pointer-events:none!important;';
          chatPanel.dataset.ucHidden = '1';
        }
        // Wait more for iframe content to fully initialize
        await new Promise((r) => setTimeout(r, 1500));
      }
    }

    // 2. Try iframe DOM send (chat is now open — either visibly or hidden)
    const activeFrame = document.querySelector('#chatframe, iframe[src*="live_chat"]');
    if (activeFrame) {
      try {
        const doc = activeFrame.contentDocument;
        if (doc) {
          for (let i = 0; i < 5; i++) {
            const input = findInput(doc);
            if (input) {
              input.focus();
              input.textContent = '';
              activeFrame.contentWindow.document.execCommand('insertText', false, text);
              await new Promise((r) => setTimeout(r, 200));
              const btn = findSendBtn(doc);
              if (btn) btn.click();
              return;
            }
            await new Promise((r) => setTimeout(r, 500));
          }
        }
      } catch {}
    }

    // 3. Fallback: API přes background (may use wrong channel on multi-channel)
    const videoId = getVideoId();
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
