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

  // ---- Close button interceptor (inside live_chat iframe) ----
  // When user clicks X to close chat, hide the panel instead of closing it.
  // This keeps the iframe functional for DOM send.
  if (isLiveChat) {
    const UC_HIDE_CSS = 'position:absolute!important;width:1px!important;height:1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;opacity:0!important;pointer-events:none!important;';

    function interceptCloseButton() {
      const closeBtn = document.querySelector('#close-button button');
      if (closeBtn && !closeBtn.dataset.ucIntercepted) {
        closeBtn.dataset.ucIntercepted = '1';
        closeBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          // Tell main frame to hide (not close) the chat panel
          window.parent.postMessage({ type: 'UC_HIDE_CHAT' }, '*');
        }, true); // capture phase — fires before YouTube's handler
      }
    }

    // Close button appears async — watch for it
    interceptCloseButton();
    const closeObs = new MutationObserver(interceptCloseButton);
    closeObs.observe(document.body, { childList: true, subtree: true });
  }

  // ---- Hide chat listener (main frame) ----
  // Receives UC_HIDE_CHAT from iframe and hides ytd-live-chat-frame
  if (isMainFrame) {
    function hideYtChat() {
      // Hide the #chat container — collapses the layout column
      const chat = document.querySelector('#chat, #chat-container');
      if (chat) chat.style.cssText = 'display:none!important;';
      // Remove two-column layout so video fills full width
      const flexy = document.querySelector('ytd-watch-flexy');
      if (flexy) {
        flexy.removeAttribute('is-two-columns_');
        flexy.removeAttribute('is-two-columns-layout');
      }
      // Mark as hidden
      const chatPanel = document.querySelector('ytd-live-chat-frame');
      if (chatPanel) chatPanel.dataset.ucHidden = '1';
    }

    window.addEventListener('message', (e) => {
      if (e.data?.type === 'UC_HIDE_CHAT') hideYtChat();
    });

    // ---- UnityChat button on YouTube page ----
    const UC_BTN_ID = 'uc-yt-open-btn';

    function buildYtButton() {
      const btn = document.createElement('button');
      btn.id = UC_BTN_ID;
      btn.title = 'Otevřít UnityChat';
      Object.assign(btn.style, {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: '36px', height: '36px', padding: '6px', margin: '0 4px',
        background: 'transparent', border: '1px solid rgba(255,140,0,0.3)',
        borderRadius: '50%', cursor: 'pointer', flexShrink: '0',
        transition: 'background 0.15s, border-color 0.15s',
      });
      const img = document.createElement('img');
      img.src = chrome.runtime.getURL('icons/icon48.png');
      img.alt = 'UnityChat';
      Object.assign(img.style, {
        width: '22px', height: '22px', display: 'block',
        filter: 'drop-shadow(0 0 4px rgba(255,140,0,0.5))', pointerEvents: 'none',
      });
      btn.appendChild(img);
      btn.addEventListener('mouseenter', () => {
        btn.style.background = 'rgba(255,140,0,0.15)';
        btn.style.borderColor = 'rgba(255,140,0,0.6)';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.background = 'transparent';
        btn.style.borderColor = 'rgba(255,140,0,0.3)';
      });
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Open chat invisibly if closed
        const cp = document.querySelector('ytd-live-chat-frame');
        if (cp && cp.offsetHeight < 100) {
          // Restore layout temporarily so toggle works
          const cc = document.querySelector('#chat, #chat-container');
          if (cc) cc.style.cssText = '';
          const fl = document.querySelector('ytd-watch-flexy');
          if (fl) fl.setAttribute('is-two-columns_', '');

          const tb = cp.querySelector('#show-hide-button button, #show-hide-button');
          if (tb) tb.click();
          await new Promise((r) => setTimeout(r, 2500));
          hideYtChat();
        }
        chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' }).catch(() => {});
      });
      return btn;
    }

    function injectYtButton() {
      if (document.getElementById(UC_BTN_ID)) return;
      // Place near the chat toggle area or the video actions bar
      const targets = [
        'ytd-live-chat-frame #show-hide-button',
        '#chat-container',
        '#below ytd-live-chat-frame',
        '#panels',
      ];
      for (const sel of targets) {
        const el = document.querySelector(sel);
        if (el) {
          const container = el.closest('ytd-live-chat-frame') || el.parentElement;
          if (container) {
            container.insertBefore(buildYtButton(), container.firstChild);
            return;
          }
        }
      }
    }

    // Inject when ready + MutationObserver for SPA navigation
    function tryInject() {
      if (document.querySelector('ytd-live-chat-frame')) injectYtButton();
    }
    tryInject();
    const ytObs = new MutationObserver(tryInject);
    ytObs.observe(document.body, { childList: true, subtree: true });
  }

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
      const toggleBtn = chatPanel.querySelector('#show-hide-button button, #show-hide-button ytd-toggle-button-renderer, #show-hide-button');
      if (toggleBtn) {
        // First, restore #chat visibility so toggle button works
        const chatContainer = document.querySelector('#chat, #chat-container');
        if (chatContainer) chatContainer.style.cssText = '';
        const flexy = document.querySelector('ytd-watch-flexy');
        if (flexy) flexy.setAttribute('is-two-columns_', '');

        toggleBtn.click();
        await new Promise((r) => setTimeout(r, 2000));
        hideYtChat();
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
