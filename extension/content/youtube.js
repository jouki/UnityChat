// UnityChat - YouTube content script
// DOM přístup pro otevřený chat, background proxy pro zavřený chat (obchází CSP)

(function () {
  if (window._ucYoutube) return;
  window._ucYoutube = true;
  const isLiveChat = window.location.pathname.startsWith('/live_chat');
  const isMainFrame = window === window.top;
  let _cachedYtUsername = null;
  let _cachedForUrl = null;

  // YouTube is SPA — watch for URL changes to invalidate cached username
  if (isMainFrame) {
    let _lastUrl = window.location.href;
    const _urlObserver = new MutationObserver(() => {
      if (window.location.href !== _lastUrl) {
        _lastUrl = window.location.href;
        _cachedYtUsername = null;
        _cachedForUrl = null;
      }
    });
    _urlObserver.observe(document.body, { childList: true, subtree: true });
    // Also catch popstate (back/forward)
    window.addEventListener('popstate', () => { _cachedYtUsername = null; _cachedForUrl = null; });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PING' && isMainFrame) {
      const chatFrame = document.querySelector('ytd-live-chat-frame');
      const urlHasLive = window.location.href.includes('/live');
      const hasLiveChat = !!chatFrame || urlHasLive;
      if (hasLiveChat) {
        // Return cached username if already detected for this URL
        if (_cachedYtUsername && _cachedForUrl === window.location.href) {
          sendResponse({ platform: 'youtube', username: _cachedYtUsername });
          return;
        }
        chrome.runtime.sendMessage({ type: 'YT_GET_USERNAME', tabId: null }, (resp) => {
          if (resp?.username) {
            _cachedYtUsername = resp.username;
            _cachedForUrl = window.location.href;
          }
          sendResponse({ platform: 'youtube', username: resp?.username || null });
        });
        return true; // async sendResponse
      }
      return;
    }

    if (msg.type === 'SEND_CHAT') {
      if (isLiveChat && isMainFrame) {
        // Only handle in live_chat if it's a top-level popout window,
        // NOT when embedded as iframe (main frame handles that via sendSmart)
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
          window.parent.postMessage({ type: 'UC_HIDE_CHAT' }, 'https://www.youtube.com');
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
    let _ucEnteredTheater = false;

    function hideYtChat() {
      // Move #chat off-screen (NOT display:none — iframe must stay alive for DOM send)
      const chat = document.querySelector('#chat');
      if (chat) chat.style.cssText = 'position:fixed!important;left:-9999px!important;width:1px!important;height:1px!important;overflow:hidden!important;opacity:0!important;';
      const pfbc = document.querySelector('#panels-full-bleed-container');
      if (pfbc) pfbc.style.cssText = 'display:none!important;';
      // Enter theater mode via native button (YouTube handles player resize properly)
      const flexy = document.querySelector('ytd-watch-flexy');
      if (flexy && !flexy.hasAttribute('theater')) {
        const theaterBtn = document.querySelector('.ytp-size-button');
        if (theaterBtn) { theaterBtn.click(); _ucEnteredTheater = true; }
      }
      const chatPanel = document.querySelector('ytd-live-chat-frame');
      if (chatPanel) chatPanel.dataset.ucHidden = '1';
    }

    function showYtChat() {
      // Restore #chat
      const chat = document.querySelector('#chat');
      if (chat) chat.style.cssText = '';
      // Restore #panels-full-bleed-container
      const pfbc = document.querySelector('#panels-full-bleed-container');
      if (pfbc) pfbc.style.cssText = '';
      // Exit theater mode via native button (if we entered it)
      if (_ucEnteredTheater) {
        const theaterBtn = document.querySelector('.ytp-size-button');
        if (theaterBtn) theaterBtn.click();
        _ucEnteredTheater = false;
      }
      const chatPanel = document.querySelector('ytd-live-chat-frame');
      if (chatPanel) delete chatPanel.dataset.ucHidden;
    }

    window.addEventListener('message', (e) => {
      if (e.origin !== 'https://www.youtube.com') return;
      if (e.data?.type === 'UC_HIDE_CHAT') hideYtChat();
    });

    // Periodic layout fix: if #secondary takes up space but chat is not
    // actually showing live content, collapse it. Catches X button close,
    // SPA navigation, or any state mismatch.
    setInterval(() => {
      const secondary = document.querySelector('#secondary');
      if (!secondary || secondary.style.display === 'none') return;
      // If secondary has width but chat iframe is not active → fix layout
      if (secondary.offsetWidth > 50) {
        const chatFrame = document.querySelector('ytd-live-chat-frame');
        const iframe = chatFrame?.querySelector('#chatframe');
        const isChatActive = iframe && iframe.offsetHeight > 100;
        if (!isChatActive) {
          hideYtChat();
        }
      }
    }, 1500);

    // ---- UnityChat button next to "Otevřít panel" ----
    const UC_BTN_ID = 'uc-yt-open-btn';

    function buildYtButton() {
      const btn = document.createElement('button');
      btn.id = UC_BTN_ID;
      btn.title = 'Otevřít UnityChat';
      Object.assign(btn.style, {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        gap: '6px', padding: '6px 12px', margin: '0 7px',
        background: 'linear-gradient(135deg, rgb(255, 192, 0), rgb(255, 122, 0))',
        border: 'none', borderRadius: '18px', cursor: 'pointer',
        fontFamily: 'Roboto, Arial, sans-serif', fontSize: '12px',
        fontWeight: '500', color: 'rgb(10, 10, 13)', lineHeight: '1',
        transition: 'filter 0.15s',
      });
      btn.textContent = 'UnityChat';
      btn.addEventListener('mouseenter', () => { btn.style.filter = 'brightness(1.15)'; });
      btn.addEventListener('mouseleave', () => { btn.style.filter = ''; });
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        chrome.runtime.sendMessage({ type: 'TOGGLE_SIDE_PANEL' }, (resp) => {
          if (!resp) return;
          if (resp.action === 'opened') {
            // Opening UC → hide vanilla YouTube chat
            const chatFrame = document.querySelector('ytd-live-chat-frame');
            const iframe = chatFrame?.querySelector('#chatframe');
            const chatIsOpen = iframe && iframe.offsetHeight > 100;
            if (chatIsOpen) {
              hideYtChat();
            } else {
              // Chat closed → click "Otevřít panel", wait, then hide
              const openPanelBtn = document.querySelector('.ytTextCarouselItemViewModelButton button');
              if (openPanelBtn && !openPanelBtn.disabled) {
                openPanelBtn.click();
                const closeObs = new MutationObserver(() => {
                  const closeBtn = document.querySelector('ytd-live-chat-frame #close-button button');
                  if (closeBtn) { closeObs.disconnect(); hideYtChat(); }
                });
                closeObs.observe(document.body, { childList: true, subtree: true });
                setTimeout(() => closeObs.disconnect(), 10000);
              }
            }
          } else if (resp.action === 'closed') {
            // Closing UC → show vanilla YouTube chat back
            showYtChat();
          }
        });
      });
      return btn;
    }

    function injectYtButton() {
      if (document.getElementById(UC_BTN_ID)) return;
      const frame = document.querySelector('ytd-live-chat-frame');
      const carousel = document.querySelector('#teaser-carousel');
      const container = document.querySelector('.ytVideoMetadataCarouselViewModelCarouselContainer');
      const targetBtn = document.querySelector('.ytTextCarouselItemViewModelButton');
      console.log('[UC] inject attempt:', { frame: !!frame, carousel: !!carousel, container: !!container, targetBtn: !!targetBtn });
      if (targetBtn) {
        targetBtn.parentElement.insertBefore(buildYtButton(), targetBtn);
        console.log('[UC] button injected!');
      }
    }

    const injectInterval = setInterval(() => {
      if (document.getElementById(UC_BTN_ID)) { clearInterval(injectInterval); return; }
      injectYtButton();
    }, 500);
  }

  // Přímé odeslání v live_chat iframe
  async function sendDirect(text) {
    const input = findInput(document);
    if (!input) throw new Error('YouTube chat input nenalezen');
    input.focus();
    input.textContent = '';
    document.execCommand('insertText', false, text);
    await new Promise((r) => setTimeout(r, 30));
    const btn = findSendBtn(document);
    if (btn) btn.click();
  }

  // Zkusí iframe DOM, pak API přes background
  async function sendSmart(text) {
    // Quick path: if iframe already has content (from previous send/UC button),
    // send directly — no toggle, no delay.
    const frame = document.querySelector('#chatframe, iframe[src*="live_chat"]');
    if (frame) {
      try {
        const doc = frame.contentDocument;
        if (doc && doc.documentElement.innerHTML.length > 1000) {
          const input = findInput(doc);
          if (input) {
            input.focus();
            input.textContent = '';
            frame.contentWindow.document.execCommand('insertText', false, text);
            await new Promise((r) => setTimeout(r, 30));
            const btn = findSendBtn(doc);
            if (btn) btn.click();
            return;
          }
        }
      } catch {}
    }

    // Slow path: chat not loaded yet — open it invisibly, then DOM send.
    const chatPanel = document.querySelector('ytd-live-chat-frame');
    if (chatPanel) {
      const chatVisible = chatPanel.offsetHeight > 100;
      if (!chatVisible) {
        const toggleBtn = chatPanel.querySelector('#show-hide-button button, #show-hide-button ytd-toggle-button-renderer, #show-hide-button');
        if (toggleBtn) {
          const chatContainer = document.querySelector('#chat, #chat-container');
          if (chatContainer) chatContainer.style.cssText = '';
          const flexy = document.querySelector('ytd-watch-flexy');
          if (flexy) flexy.setAttribute('is-two-columns_', '');
          toggleBtn.click();
          await new Promise((r) => setTimeout(r, 2500));
          hideYtChat();
          await new Promise((r) => setTimeout(r, 500));
        }
      } else {
        hideYtChat();
      }

      // Try DOM send in the now-loaded iframe
      const loadedFrame = document.querySelector('#chatframe, iframe[src*="live_chat"]');
      if (loadedFrame) {
        try {
          const doc = loadedFrame.contentDocument;
          if (doc) {
            for (let i = 0; i < 5; i++) {
              const input = findInput(doc);
              if (input) {
                input.focus();
                input.textContent = '';
                loadedFrame.contentWindow.document.execCommand('insertText', false, text);
                await new Promise((r) => setTimeout(r, 30));
                const btn = findSendBtn(doc);
                if (btn) btn.click();
                return;
              }
              await new Promise((r) => setTimeout(r, 200));
            }
          }
        } catch {}
      }
    }

    // Fallback: API přes background (may use wrong channel on multi-channel)
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
