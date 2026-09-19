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
        const channelHandle = getChannelHandle();
        // Return cached username if already detected for this URL
        if (_cachedYtUsername && _cachedForUrl === window.location.href) {
          sendResponse({ platform: 'youtube', username: _cachedYtUsername, channelHandle });
          return;
        }
        chrome.runtime.sendMessage({ type: 'YT_GET_USERNAME', tabId: null }, (resp) => {
          if (resp?.username) {
            _cachedYtUsername = resp.username;
            _cachedForUrl = window.location.href;
          }
          sendResponse({ platform: 'youtube', username: resp?.username || null, channelHandle });
        });
        return true; // async sendResponse
      }
      return;
    }

    if (msg.type === 'UC_PANEL_STATE' && isMainFrame && !isLiveChat) {
      try { if (msg.open) onUcPanelOpened(); else showYtChat(); } catch {}
      sendResponse({ ok: true });
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
    // true = naše layout styly (skrytý chat) jsou na stránce aktivní
    let _ucLayoutApplied = false;
    // Atributy, kterými YouTube říká „chat je otevřený" a podle nich rezervuje
    // místo vpravo (#columns::after spacer = sidebar + margin, theater player
    // užší o panel). Nativní zavření chatu je sundá; my je sundáme taky a při
    // show vrátíme jen ty, které jsme odebrali.
    const UC_PANEL_ATTRS = ['live-chat-present-and-expanded', 'panel-expanded', 'fixed-panel-expanded', 'watch-while-panels-active'];
    let _ucRemovedAttrs = [];
    function _ucDropPanelAttrs() {
      const flexy = document.querySelector('ytd-watch-flexy');
      if (!flexy) return;
      for (const a of UC_PANEL_ATTRS) {
        if (flexy.hasAttribute(a)) { flexy.removeAttribute(a); if (!_ucRemovedAttrs.includes(a)) _ucRemovedAttrs.push(a); }
      }
    }

    function hideYtChat() {
      // Jen na stránce s live chatem. Na běžném videu #secondary nese
      // doporučená videa — skrýt je znamená „zmizel sidebar" (report 2026-09-19).
      if (!document.querySelector('ytd-live-chat-frame')) return;
      _ucLayoutApplied = true;
      // Move #chat off-screen (NOT display:none — iframe must stay alive for DOM send)
      const chat = document.querySelector('#chat');
      if (chat) chat.style.cssText = 'position:fixed!important;left:-9999px!important;width:1px!important;height:1px!important;overflow:hidden!important;opacity:0!important;';
      const pfbc = document.querySelector('#panels-full-bleed-container');
      if (pfbc) pfbc.style.cssText = 'display:none!important;';
      // Cíl = nativní stav „chat zavřený": theater player, #primary normální
      // šířky, #secondary s doporučenými videi. Ten „prázdný obdélník" (v3.38.64)
      // nedělal #secondary, ale obal #chat-container: #chat je fixed mimo
      // obrazovku, jenže obal si drží výšku z YouTube CSS (~890 px, měřeno
      // 2026-09-20). Zkolabovat jen obal — #secondary, #columns ani #primary
      // se nesahá (zúžení sloupce zabilo related videa, v3.39.5).
      const chatContainer = document.querySelector('#chat-container');
      if (chatContainer) chatContainer.style.cssText = 'height:0!important;min-height:0!important;max-height:0!important;margin:0!important;padding:0!important;';
      // Player nedosahoval k okraji a vpravo zůstávalo prázdno (report 2026-09-20):
      // YouTube má chat pořád za „otevřený panel" a drží pro něj místo.
      _ucDropPanelAttrs();
      // Ověřeno v DevTools (user, 2026-09-20): za ~700 px prázdno vpravo od
      // related videí může jediné pravidlo
      //   ytd-watch-flexy[fixed-panels] #columns { padding-right: var(--ytd-watch-flexy-sidebar-width) }
      // — po jeho vypnutí je layout shodný s nativně zavřeným chatem.
      // #primary ani #secondary se nesahá (related videa zůstávají vpravo).
      const columns = document.querySelector('#columns');
      if (columns) columns.style.cssText = 'padding-right:0!important;';
      for (const sel of ['#secondary', '#primary']) { // úklid po 3.38.64–3.39.10
        const el = document.querySelector(sel);
        if (el && el.style.cssText) el.style.cssText = '';
      }
      // Enter theater mode via native button (YouTube handles player resize properly)
      const flexy = document.querySelector('ytd-watch-flexy');
      if (flexy && !flexy.hasAttribute('theater')) {
        const theaterBtn = document.querySelector('.ytp-size-button');
        if (theaterBtn) { theaterBtn.click(); _ucEnteredTheater = true; }
      }
      const chatPanel = document.querySelector('ytd-live-chat-frame');
      if (chatPanel) chatPanel.dataset.ucHidden = '1';
      // Když už flexy `theater` má, klik nahoře se přeskočí a YouTube nedostane
      // žádný impuls k přepočtu — player zůstane v šířce sloupce, dokud uživatel
      // nepřepne fullscreen (což je přesně resize event). Pošleme ho sami.
      window.dispatchEvent(new Event('resize'));
      _ucEnableOpenPanelBtn();
      _logYtLayout('hide');
    }

    // Nativní „Otevřít panel" je při otevřeném (= námi skrytém) chatu disabled.
    // User 2026-09-20: má být klikatelné a vrátit chat na obrazovku. YouTube
    // ho vypíná trojicí disabled + aria-disabled + třída; sundáme ji a klik
    // chytíme v capture fázi na documentu, aby YouTube handler nedostal nic.
    const OPEN_PANEL_SEL = '.ytTextCarouselItemViewModelButton button';
    const YT_DISABLED_CLS = 'ytSpecButtonShapeNextDisabled';
    function _ucEnableOpenPanelBtn() {
      const b = document.querySelector(OPEN_PANEL_SEL);
      if (!b || !b.disabled) return;
      b.disabled = false;
      b.removeAttribute('disabled');
      b.setAttribute('aria-disabled', 'false');
      b.classList.remove(YT_DISABLED_CLS);
      b.title = 'Zobrazit YouTube chat (UnityChat)';
      b.dataset.ucEnabled = '1';
      _ucLog('YtLayout', 'open-panel button enabled');
    }
    function _ucRestoreOpenPanelBtn() {
      const b = document.querySelector(OPEN_PANEL_SEL);
      if (!b || b.dataset.ucEnabled !== '1') return;
      b.disabled = true;
      b.setAttribute('aria-disabled', 'true');
      b.classList.add(YT_DISABLED_CLS);
      b.title = '';
      delete b.dataset.ucEnabled;
    }
    document.addEventListener('click', (e) => {
      if (!_ucLayoutApplied) return;
      const b = e.target?.closest?.(OPEN_PANEL_SEL);
      if (!b || b.dataset.ucEnabled !== '1') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      _ucLog('YtLayout', 'open-panel button clicked → showYtChat');
      showYtChat();
    }, true);

    function _ucLog(tag, text) {
      try { chrome.runtime.sendMessage({ type: 'UC_LOG', tag, args: [text] }).catch?.(() => {}); } catch {}
    }

    // Diagnostika do UC dumpu: co layout dělá po hide/show. Bez tohohle se
    // "video se nezarovnalo" nedá z logu odlišit od "theater se nezapnul".
    function _logYtLayout(phase) {
      try {
        const q = (s) => document.querySelector(s);
        const flexy = q('ytd-watch-flexy');
        chrome.runtime.sendMessage({ type: 'UC_LOG', tag: 'YtLayout', args: [phase, JSON.stringify({
          innerW: window.innerWidth,
          playerW: (q('#movie_player') || q('#player'))?.offsetWidth ?? null,
          secondaryW: q('#secondary')?.offsetWidth ?? null,
          belowW: q('#below')?.offsetWidth ?? null,
          chatContainerH: q('#chat-container')?.offsetHeight ?? null,
          primaryW: q('#primary')?.offsetWidth ?? null,
          columnsPadR: q('#columns') ? getComputedStyle(q('#columns')).paddingRight : null,
          relatedW: q('#related')?.offsetWidth ?? null,
          relatedInSecondary: !!q('#secondary #related'),
          theater: !!flexy?.hasAttribute('theater'),
          twoCol: !!flexy?.hasAttribute('is-two-columns_'),
          singleCol: !!flexy?.hasAttribute('is-single-column'),
          flexyAttrs: flexy ? [...flexy.attributes].map((a) => a.name).filter((a) => /theater|chat|panel|column|bleed|split/i.test(a)).join(',') : null,
          columnsW: q('#columns')?.offsetWidth ?? null,
        })] }).catch?.(() => {});
      } catch {}
    }

    function showYtChat() {
      _ucLayoutApplied = false;
      _ucRestoreOpenPanelBtn();
      const flexyEl = document.querySelector('ytd-watch-flexy');
      if (flexyEl) for (const a of _ucRemovedAttrs) flexyEl.setAttribute(a, '');
      _ucRemovedAttrs = [];
      // Restore #chat
      const chat = document.querySelector('#chat');
      if (chat) chat.style.cssText = '';
      // Restore #panels-full-bleed-container
      const pfbc = document.querySelector('#panels-full-bleed-container');
      if (pfbc) pfbc.style.cssText = '';
      const chatContainer = document.querySelector('#chat-container');
      if (chatContainer) chatContainer.style.cssText = '';
      for (const sel of ['#secondary', '#columns', '#primary']) {
        const el = document.querySelector(sel);
        if (el) el.style.cssText = '';
      }
      // Exit theater mode via native button (if we entered it)
      if (_ucEnteredTheater) {
        const theaterBtn = document.querySelector('.ytp-size-button');
        if (theaterBtn) theaterBtn.click();
        _ucEnteredTheater = false;
      }
      const chatPanel = document.querySelector('ytd-live-chat-frame');
      if (chatPanel) delete chatPanel.dataset.ucHidden;
      window.dispatchEvent(new Event('resize'));
      _logYtLayout('show');
    }

    window.addEventListener('message', (e) => {
      if (e.origin !== 'https://www.youtube.com') return;
      if (e.data?.type === 'UC_HIDE_CHAT') hideYtChat();
    });

    // Periodic layout fix — jen dokud jsou naše styly aktivní (_ucLayoutApplied):
    // YouTube při SPA navigaci / rerenderu inline styly zahodí, tak je vrátíme.
    // Dřív interval schovával #secondary vždy, když nebyl aktivní chat iframe —
    // na běžném videu (bez ytd-live-chat-frame) tím zmizel celý sidebar
    // s doporučenými videy. Na stránce bez live chatu se styly naopak sundají.
    setInterval(() => {
      if (!_ucLayoutApplied) return;
      const chatFrame = document.querySelector('ytd-live-chat-frame');
      if (!chatFrame) { showYtChat(); return; }
      const cc = document.querySelector('#chat-container');
      const flexyEl = document.querySelector('ytd-watch-flexy');
      const attrsBack = flexyEl && UC_PANEL_ATTRS.some((a) => flexyEl.hasAttribute(a));
      if ((cc && cc.offsetHeight > 50) || attrsBack) hideYtChat();
      else _ucEnableOpenPanelBtn();
    }, 1500);

    // UC panel se otevřel (pill v chat liště, ikona v toolbaru, cokoli) →
    // schovat vanilla chat. Zavřený chat se nejdřív otevře (iframe musí žít
    // kvůli DOM sendu) a hned schová. Idempotentní — background i pill to
    // můžou zavolat po sobě.
    let _ucOpening = false;
    function onUcPanelOpened() {
      if (_ucLayoutApplied || _ucOpening) return;
      const chatFrame = document.querySelector('ytd-live-chat-frame');
      if (!chatFrame) return;
      const iframe = chatFrame.querySelector('#chatframe');
      const chatIsOpen = iframe && iframe.offsetHeight > 100;
      if (chatIsOpen) { hideYtChat(); return; }
      const openPanelBtn = document.querySelector('.ytTextCarouselItemViewModelButton button');
      if (!openPanelBtn || openPanelBtn.disabled) return;
      _ucOpening = true;
      openPanelBtn.click();
      const closeObs = new MutationObserver(() => {
        const closeBtn = document.querySelector('ytd-live-chat-frame #close-button button');
        if (closeBtn) { closeObs.disconnect(); _ucOpening = false; hideYtChat(); }
      });
      closeObs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { closeObs.disconnect(); _ucOpening = false; }, 10000);
    }

    // ---- UnityChat ikona v mastheadu (jako na Twitchi v hlavičce chatu) ----
    // User 2026-09-20: pill „UnityChat" z řádku „Chat" pryč, místo něj jen
    // ikona nahoře v liště YouTube před ostatními tlačítky (#end). Masthead
    // přežívá SPA navigaci, takže stačí vložit jednou; interval jen hlídá,
    // že tam ikona zůstala.
    const UC_BTN_ID = 'uc-yt-open-btn';

    function buildYtButton() {
      const btn = document.createElement('button');
      btn.id = UC_BTN_ID;
      btn.title = 'Otevřít UnityChat';
      btn.setAttribute('aria-label', 'Otevřít UnityChat');
      Object.assign(btn.style, {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: '40px', height: '40px', minWidth: '40px', padding: '0', margin: '0 4px 0 0',
        background: 'transparent', border: 'none', borderRadius: '50%',
        cursor: 'pointer', flexShrink: '0', transition: 'background 0.15s ease',
      });
      const img = document.createElement('img');
      img.src = chrome.runtime.getURL('icons/icon48.png');
      img.alt = 'UC';
      Object.assign(img.style, { width: '24px', height: '24px', display: 'block', pointerEvents: 'none' });
      btn.appendChild(img);
      btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(255,255,255,0.1)'; });
      btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        chrome.runtime.sendMessage({ type: 'TOGGLE_SIDE_PANEL' }, (resp) => {
          if (!resp) return;
          if (resp.action === 'opened') onUcPanelOpened();
          else if (resp.action === 'closed') showYtChat();
        });
      });
      return btn;
    }

    function injectYtButton() {
      if (document.getElementById(UC_BTN_ID)) return true;
      const end = document.querySelector('ytd-masthead #end');
      if (!end) return false;
      // Před všechno viditelné (i před tlačítka cizích rozšíření), skeleton
      // ikony YouTube nechat na začátku.
      const skel = end.querySelector('#masthead-skeleton-icons');
      end.insertBefore(buildYtButton(), skel ? skel.nextSibling : end.firstChild);
      _ucLog('YtLayout', 'masthead button injected');
      return true;
    }

    setInterval(injectYtButton, 2000);
    injectYtButton();
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

  // Resolve channel handle of the currently-watched video/stream from DOM.
  // Works on /watch pages (live streams + VODs) where URL parsing can't help.
  // Prefers @handle (backend lookup key); falls back to UC... channel ID.
  function getChannelHandle() {
    const selectors = [
      'ytd-video-owner-renderer a[href^="/@"]',
      '#owner a[href^="/@"]',
      'ytd-channel-name a[href^="/@"]',
      'ytd-watch-metadata a[href^="/@"]',
      'ytd-video-owner-renderer a[href*="/channel/"]',
      '#owner a[href*="/channel/"]',
      'ytd-channel-name a[href*="/channel/"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const href = el.getAttribute('href') || '';
      const mAt = href.match(/^\/@([^/?#]+)/);
      if (mAt) return mAt[1];
      const mCh = href.match(/\/channel\/(UC[A-Za-z0-9_-]{22})/);
      if (mCh) return mCh[1];
    }
    // Fallback: og:url / canonical don't carry the channel, but JSON-LD often does
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      try {
        const json = JSON.parse(s.textContent || '{}');
        const authors = Array.isArray(json) ? json : [json];
        for (const a of authors) {
          const url = a?.author?.url || a?.itemListElement?.[0]?.item?.url;
          if (!url) continue;
          const m = url.match(/\/(@[^/?#]+|channel\/UC[A-Za-z0-9_-]{22})/);
          if (m) {
            const tok = m[1];
            if (tok.startsWith('@')) return tok.substring(1);
            return tok.substring(tok.indexOf('/') + 1);
          }
        }
      } catch {}
    }
    return null;
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
