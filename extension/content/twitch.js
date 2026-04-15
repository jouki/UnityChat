// UnityChat - Twitch content script
// Odesílá zprávy do Twitch chatu z side panelu
// Twitch používá Slate-based rich text editor - vyžaduje speciální handling

(function () {
  if (window._ucTwitch) return;
  window._ucTwitch = true;

  // ---- Side panel opener button injected into Twitch chat header ----
  // Twitch's chat shell re-mounts on channel/route changes, so we keep a
  // MutationObserver alive and re-inject whenever our button disappears.

  const UC_BTN_ID = 'uc-open-panel-btn';

  function buildUcButton() {
    const btn = document.createElement('button');
    btn.id = UC_BTN_ID;
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Otevřít UnityChat');
    btn.title = 'Otevřít UnityChat';
    Object.assign(btn.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '30px',
      height: '30px',
      minWidth: '30px',
      padding: '0',
      margin: '0 2px',
      background: 'transparent',
      border: 'none',
      borderRadius: '4px',
      cursor: 'pointer',
      flexShrink: '0',
      transition: 'background 0.15s ease'
    });
    const img = document.createElement('img');
    img.src = chrome.runtime.getURL('icons/icon48.png');
    img.alt = 'UC';
    Object.assign(img.style, { width: '20px', height: '20px', display: 'block', pointerEvents: 'none' });
    btn.appendChild(img);
    btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(255,140,0,0.15)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: 'TOGGLE_SIDE_PANEL' }, (resp) => {
        if (!resp) return;
        if (resp.action === 'opened') {
          // Opening UC → hide vanilla chat visually but keep it mounted.
          // Collapsing would unmount the chat-room — which breaks DOM mirror
          // features (channel-point redeems, loyalty credits, username
          // colors). Instead we set display:none on the right-column
          // container but leave the chat-shell alive.
          hideTwitchChatVisually(true);
        } else if (resp.action === 'closed') {
          hideTwitchChatVisually(false);
        }
      });
    });
    return btn;
  }

  // Hide the Twitch right-column chat visually without collapsing — we
  // need the chat DOM alive for redeem/credit/color mirroring to keep
  // working. Toggling visibility is reversible; collapsing via the
  // built-in button would unmount .chat-shell.
  //
  // Twitch's layout uses BEM modifier classes (player--with-chat /
  // info--with-chat) to reserve horizontal space for the chat column.
  // Hiding the column alone leaves that reserved gap — so we also strip
  // the --with-chat modifier while UC is open and restore it on close.
  // A MutationObserver re-applies the strip when Twitch re-renders
  // (channel switch, SPA nav) and we're still in the "hidden" state.
  const UC_HIDE_STYLE_ID = 'uc-hide-twitch-chat';
  const UC_WITH_CHAT_TARGETS = [
    { selector: '.channel-root__player', modifier: 'channel-root__player--with-chat' },
    { selector: '.channel-root__info', modifier: 'channel-root__info--with-chat' },
  ];
  let ucChatHidden = false;
  let ucWithChatObserver = null;

  function stripWithChatModifiers() {
    for (const t of UC_WITH_CHAT_TARGETS) {
      for (const el of document.querySelectorAll(t.selector + '.' + t.modifier)) {
        el.classList.remove(t.modifier);
        el.dataset.ucWithChat = '1';
      }
    }
  }

  function restoreWithChatModifiers() {
    for (const t of UC_WITH_CHAT_TARGETS) {
      for (const el of document.querySelectorAll(t.selector + '[data-uc-with-chat="1"]')) {
        el.classList.add(t.modifier);
        delete el.dataset.ucWithChat;
      }
    }
  }

  // ---- Top-nav restore button (visible while UC has hidden the chat) ----
  // Sits left of the user avatar / notification bell. Clicking it reverses
  // our soft-hide so vanilla Twitch chat reappears, then the button
  // removes itself (same as if UC had never hidden chat).
  const UC_RESTORE_BTN_ID = 'uc-restore-chat-btn';
  function buildRestoreButton() {
    const btn = document.createElement('button');
    btn.id = UC_RESTORE_BTN_ID;
    btn.type = 'button';
    btn.title = 'Zobrazit Twitch chat';
    btn.setAttribute('aria-label', 'Zobrazit Twitch chat');
    Object.assign(btn.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '30px',
      height: '30px',
      minWidth: '30px',
      padding: '0',
      marginRight: '6px',
      background: 'transparent',
      border: 'none',
      borderRadius: '4px',
      cursor: 'pointer',
      color: 'var(--color-text, #efeff1)',
      transition: 'background 0.15s ease',
    });
    // Speech-bubble SVG (matches Twitch's visual language)
    btn.innerHTML =
      '<svg viewBox="0 0 20 20" width="20" height="20" fill="currentColor" aria-hidden="true">'
      + '<path d="M17 3H3c-1.1 0-2 .9-2 2v9c0 1.1.9 2 2 2h3v3l4-3h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 9H5v-2h5v2zm5-4H5V6h10v2z"/>'
      + '</svg>';
    btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(255,255,255,0.1)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Toggle: hide chat if currently shown, show if hidden. Mirrors
      // the UC toolbar button so the user has a chat-toggle available
      // from anywhere on the Twitch tab, regardless of UC state.
      hideTwitchChatVisually(!ucChatHidden);
    });
    return btn;
  }

  function findTopNavActions() {
    // Twitch has refactored .top-nav several times — try semantic selectors
    // first, then fall back to walking up from the user avatar / menu
    // button (which we can identify reliably by data-a-target attrs).
    const directSelectors = [
      '.top-nav__actions',
      '[data-a-target="top-nav-actions-container"]',
      '[data-test-selector="top-nav__actions-container"]',
    ];
    for (const sel of directSelectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    const anchor = document.querySelector('[data-a-target="user-menu-toggle"]')
      || document.querySelector('[data-a-target="top-nav-avatar"]')
      || document.querySelector('[data-a-target="top-nav-account-menu"]')
      || document.querySelector('[aria-label*="Account" i][role="button"]')
      || document.querySelector('[data-test-selector="top-nav-search-input"]')
      || document.querySelector('header [data-a-target="login-button"]');
    if (!anchor) return null;
    // Walk up to the first flex row that holds multiple siblings — that's
    // the actions strip (avatar + bell + bits + ads + …).
    let p = anchor.parentElement;
    while (p && p !== document.body) {
      const style = getComputedStyle(p);
      if (style.display === 'flex' && p.children.length >= 2 && p.offsetHeight < 60) return p;
      p = p.parentElement;
    }
    return null;
  }

  function ensureRestoreButton() {
    const actions = findTopNavActions();
    if (!actions) return;
    if (document.getElementById(UC_RESTORE_BTN_ID)) return;
    const btn = buildRestoreButton();
    // Land the button immediately left of the avatar / user-menu wrapper.
    const avatar = actions.querySelector('[data-a-target="user-menu-toggle"]')
      || actions.querySelector('[data-a-target="top-nav-avatar"]')
      || actions.querySelector('[data-a-target="top-nav-account-menu"]');
    let target = avatar;
    while (target && target.parentElement !== actions) target = target.parentElement;
    if (target) {
      actions.insertBefore(btn, target);
    } else {
      actions.appendChild(btn);
    }
  }

  function removeRestoreButton() {
    const btn = document.getElementById(UC_RESTORE_BTN_ID);
    if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
  }

  let restoreBtnObserver = null;
  function setupRestoreBtnObserver() {
    if (restoreBtnObserver) return;
    // Always-on observer — keep the chat-toggle button present in the
    // top nav regardless of chat hidden state. The button acts as a
    // toggle: hides when chat is visible, restores when hidden.
    restoreBtnObserver = new MutationObserver(() => {
      ensureRestoreButton();
    });
    restoreBtnObserver.observe(document.body, { childList: true, subtree: true });
  }

  function hideTwitchChatVisually(hide) {
    ucChatHidden = !!hide;
    let style = document.getElementById(UC_HIDE_STYLE_ID);
    if (hide) {
      if (!style) {
        style = document.createElement('style');
        style.id = UC_HIDE_STYLE_ID;
        style.textContent = `
          .channel-root__right-column,
          [data-a-target="right-column"],
          .right-column {
            width: 0 !important;
            min-width: 0 !important;
            max-width: 0 !important;
            overflow: hidden !important;
            visibility: hidden !important;
          }
        `;
        document.documentElement.appendChild(style);
      }
      stripWithChatModifiers();
      if (!ucWithChatObserver) {
        ucWithChatObserver = new MutationObserver(() => {
          if (ucChatHidden) stripWithChatModifiers();
        });
        ucWithChatObserver.observe(document.body, {
          attributes: true,
          attributeFilter: ['class'],
          subtree: true,
          childList: true,
        });
      }
      ensureRestoreButton();
      setupRestoreBtnObserver();
    } else {
      if (style) style.remove();
      restoreWithChatModifiers();
      if (ucWithChatObserver) {
        ucWithChatObserver.disconnect();
        ucWithChatObserver = null;
      }
      // Keep the chat-toggle button + its observer alive — button now
      // works as a toggle, visible regardless of hidden state.
    }
    // Reflect new state on the button (title + aria-label) so hover
    // hint makes sense in both directions.
    const restoreBtn = document.getElementById(UC_RESTORE_BTN_ID);
    if (restoreBtn) {
      const label = ucChatHidden ? 'Zobrazit Twitch chat' : 'Schovat Twitch chat';
      restoreBtn.title = label;
      restoreBtn.setAttribute('aria-label', label);
    }
  }

  function findChatHeader() {
    return document.querySelector('.stream-chat-header');
  }

  function injectSidePanelButton() {
    if (document.querySelectorAll('#' + UC_BTN_ID).length > 0) return;
    const header = document.querySelector('.stream-chat-header');
    if (!header) return;
    const label = header.querySelector('#chat-room-header-label');
    if (!label) return;
    // label is inside a wrapper div — insert button before that wrapper
    const wrapper = label.parentElement;
    if (wrapper && wrapper.parentElement === header) {
      header.insertBefore(buildUcButton(), wrapper);
    }
  }

  // Poll for header — Twitch re-mounts on navigation
  setInterval(() => {
    if (document.querySelectorAll('#' + UC_BTN_ID).length === 0) {
      injectSidePanelButton();
    }
  }, 2000);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PING') {
      // Username z Twitch cookie (vždy dostupné, ne DOM dropdown)
      const m = document.cookie.match(/(?:^|;\s*)login=([^;]*)/);
      const username = m ? decodeURIComponent(m[1]) : null;
      sendResponse({ platform: 'twitch', username });
      return;
    }

    if (msg.type === 'OPEN_USER_CARD') {
      const name = msg.username.toLowerCase();
      const safeName = CSS.escape(name);
      // Hledat všechny klikatelné username elementy v Twitch chatu
      const selectors = [
        `[data-a-user="${safeName}"]`,
        '.chat-author__display-name',
        '[data-a-target="chat-message-username"]',
        'button.chat-line__username',
        'span.chat-author__display-name'
      ];
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          const u = (el.dataset?.aUser || el.textContent?.trim() || '').toLowerCase();
          if (u === name) {
            el.click();
            sendResponse({ ok: true });
            return;
          }
        }
      }
      sendResponse({ ok: false, error: 'User v chatu nenalezen' });
      return;
    }

    if (msg.type === 'REPLY_CHAT') {
      chrome.runtime.sendMessage({
        type: 'TW_REPLY',
        text: msg.text,
        parentMsgId: msg.parentMsgId,
        username: msg.username,
        broadcasterId: msg.broadcasterId
      }).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }

    if (msg.type === 'TW_OPEN_REWARDS_POPOVER') {
      // Open the rewards popover even when our soft-hide is keeping
      // vanilla chat invisible. Strategy: temporarily lift the hide,
      // click the summary button to open the popover, then watch for
      // the [role=dialog] element to disappear and re-apply hide.
      const log = (step, extra) => {
        try {
          chrome.runtime.sendMessage({ type: 'UC_LOG', tag: 'RewardsPopover', args: [step, extra ? JSON.stringify(extra) : ''] });
        } catch {}
      };
      try {
        const styleEl = document.getElementById(UC_HIDE_STYLE_ID);
        const anyStripped = document.querySelector('[data-uc-with-chat="1"]');
        const wasHidden = !!styleEl || !!anyStripped;
        log('start', { wasHidden, flagSaid: ucChatHidden, hasStyle: !!styleEl, hasStrippedMods: !!anyStripped, url: location.href });

        // Toggle case: if a popover is already open (our portaled copy
        // or Twitch's own), close it and bail. Same click semantics as
        // clicking the button in vanilla chat — second click = close.
        const openDlg = document.querySelector('[role="dialog"][aria-labelledby="channel-points-reward-center-header"], [role="dialog"][aria-labelledby*="bits"]');
        if (openDlg) {
          log('toggle-close', { html: openDlg.outerHTML.slice(0, 120) });
          try { openDlg.remove(); } catch {}
          // Also dispatch ESC on document so Twitch's internal state
          // reflects the close.
          try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true })); } catch {}
          sendResponse({ ok: true, closed: true });
          return;
        }
        const summary = document.querySelector('[data-test-selector="community-points-summary"], .community-points-summary');
        log('summary-lookup', { found: !!summary, html: summary ? summary.outerHTML.slice(0, 200) : null });
        if (!summary) { sendResponse({ ok: false, error: 'no_summary' }); return; }
        const btn = summary.querySelector('button');
        log('btn-lookup', { found: !!btn, ariaLabel: btn?.getAttribute('aria-label'), rect: btn ? btn.getBoundingClientRect().toJSON?.() || { l: btn.getBoundingClientRect().left, t: btn.getBoundingClientRect().top, w: btn.getBoundingClientRect().width, h: btn.getBoundingClientRect().height } : null });
        if (!btn) { sendResponse({ ok: false, error: 'no_btn' }); return; }
        // NO LIFT — try the click on the button while chat is still
        // hidden. Twitch's React click listener fires on dispatched
        // composed events even if the button's bounding rect is 0
        // (width:0 container). If the popover opens, great — no visual
        // flash of vanilla chat. Only if polling fails to find the
        // dialog do we lift hide as a fallback.
        log('click-without-lift');
        // Scroll button into view if off-screen — Twitch's React popover
        // handler may bail when the trigger has zero intersection.
        try { btn.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
        const r2 = btn.getBoundingClientRect();
        const x = r2.left + r2.width / 2, y = r2.top + r2.height / 2;
        log('btn-after-scroll', { x, y, w: r2.width, h: r2.height, vw: window.innerWidth, vh: window.innerHeight });

        const opts = (extra = {}) => ({
          bubbles: true, cancelable: true, composed: true,
          clientX: x, clientY: y, view: window, button: 0, buttons: 1, ...extra,
        });
        try { btn.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', isPrimary: true, ...opts() })); } catch {}
        try { btn.dispatchEvent(new MouseEvent('mousedown', opts())); } catch {}
        try { btn.dispatchEvent(new PointerEvent('pointerup',   { pointerId: 1, pointerType: 'mouse', isPrimary: true, ...opts({ buttons: 0 }) })); } catch {}
        try { btn.dispatchEvent(new MouseEvent('mouseup',   opts({ buttons: 0 }))); } catch {}
        try { btn.dispatchEvent(new MouseEvent('click',     opts({ buttons: 0 }))); } catch {}
        try { btn.click(); } catch {}
        log('clicks-dispatched');

        // Last-resort: invoke React's own onClick prop directly. React
        // stores it on the DOM element under a __reactProps$* key. Vue
        // uses _vnode/_props. This bypasses Twitch's click-guard if any.
        try {
          const reactKey = Object.keys(btn).find((k) => k.startsWith('__reactProps$'));
          if (reactKey && typeof btn[reactKey]?.onClick === 'function') {
            btn[reactKey].onClick({ preventDefault() {}, stopPropagation() {}, currentTarget: btn, target: btn, type: 'click' });
            log('react-onclick-invoked');
          } else {
            log('no-react-onclick', { reactKey });
          }
        } catch (e) { log('react-onclick-err', { msg: e.message }); }

        // Poll for dialog. Once it mounts:
        //   - If we lifted the hide, re-apply IMMEDIATELY so the chat
        //     column goes back to width:0 but the popover (portaled to
        //     body or with position:fixed) stays visible.
        //   - If the popover turns out to be a DOM child of the chat
        //     column, our width:0/overflow:hidden would clip it — in
        //     that case relocate the popover to document.body with
        //     fixed positioning so it survives the re-hide.
        const dialogSel = '[role="dialog"][aria-labelledby="channel-points-reward-center-header"], [role="dialog"][aria-labelledby*="bits"], [role="dialog"]';
        const rightColumnSel = '.channel-root__right-column, [data-a-target="right-column"], .right-column';

        // Portal any dialog that's inside the chat column out to body
        // so our width:0 hide doesn't clip it.
        const portalIfNeeded = (dlg) => {
          const rr = dlg.getBoundingClientRect();
          const insideColumn = !!dlg.closest(rightColumnSel);
          if (!insideColumn) return { portaled: false, rr };
          try {
            document.body.appendChild(dlg);
            dlg.style.position = 'fixed';
            dlg.style.left = rr.left + 'px';
            dlg.style.top = rr.top + 'px';
            dlg.style.width = rr.width + 'px';
            dlg.style.height = rr.height + 'px';
            dlg.style.zIndex = '9999';
            dlg.dataset.ucPortaled = '1';
            return { portaled: true, rr };
          } catch { return { portaled: false, rr }; }
        };

        const wireDismiss = (dlg) => {
          const obs = new MutationObserver(() => {
            if (!document.contains(dlg)) { obs.disconnect(); log('portal-dialog-removed'); }
          });
          obs.observe(document.body, { childList: true, subtree: true });
          const onDocClick = (e) => {
            if (!dlg.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
              document.removeEventListener('click', onDocClick, true);
              obs.disconnect();
              setTimeout(() => { try { dlg.remove(); } catch {} }, 100);
              log('portal-click-outside');
            }
          };
          setTimeout(() => document.addEventListener('click', onDocClick, true), 200);
        };

        // Phase 1: poll up to 1.2s for dialog WITHOUT lifting hide. When
        // the sidepanel has focus the Twitch tab is backgrounded and
        // Chrome throttles React's scheduler — the popover can take
        // 500-800ms to mount. Re-dispatch the click at a couple of
        // checkpoints to nudge React if it hasn't picked up the first
        // click yet.
        const rec = () => {
          const rb = btn.getBoundingClientRect();
          const cx2 = rb.left + rb.width / 2, cy2 = rb.top + rb.height / 2;
          const mopts = (extra = {}) => ({ bubbles: true, cancelable: true, composed: true, clientX: cx2, clientY: cy2, view: window, button: 0, buttons: 1, ...extra });
          try { btn.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', isPrimary: true, ...mopts() })); } catch {}
          try { btn.dispatchEvent(new MouseEvent('mousedown', mopts())); } catch {}
          try { btn.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, pointerType: 'mouse', isPrimary: true, ...mopts({ buttons: 0 }) })); } catch {}
          try { btn.dispatchEvent(new MouseEvent('mouseup', mopts({ buttons: 0 }))); } catch {}
          try { btn.dispatchEvent(new MouseEvent('click', mopts({ buttons: 0 }))); } catch {}
          try { btn.click(); } catch {}
        };
        let attempts = 0;
        const maxPhase1 = 24; // 24 × 50ms = 1200ms
        const retryAt = new Set([8, 16]); // re-click at ~400ms and ~800ms
        const checkDialog = () => {
          attempts++;
          const dlg = document.querySelector(dialogSel);
          if (dlg) {
            const info = portalIfNeeded(dlg);
            log('post-click-dialog', { attempts, phase: 1, x: info.rr.left, y: info.rr.top, w: info.rr.width, h: info.rr.height, portaled: info.portaled });
            wireDismiss(dlg);
            return;
          }
          if (retryAt.has(attempts)) { log('phase1-reclick', { attempts }); rec(); }
          if (attempts < maxPhase1) { setTimeout(checkDialog, 50); return; }
          // Phase 2 fallback: popover didn't open — lift hide briefly,
          // re-dispatch click, poll again, portal + re-hide.
          log('fallback-lift', { attempts });
          if (wasHidden) {
            const style = document.getElementById(UC_HIDE_STYLE_ID);
            if (style) style.remove();
            for (const t of UC_WITH_CHAT_TARGETS) {
              for (const el of document.querySelectorAll(t.selector + '[data-uc-with-chat="1"]')) {
                el.classList.add(t.modifier);
              }
            }
          }
          // Re-click after lift
          try { btn.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
          const rb = btn.getBoundingClientRect();
          const cx = rb.left + rb.width / 2, cy = rb.top + rb.height / 2;
          const mopts = (extra = {}) => ({ bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, view: window, button: 0, buttons: 1, ...extra });
          try { btn.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', isPrimary: true, ...mopts() })); } catch {}
          try { btn.dispatchEvent(new MouseEvent('mousedown', mopts())); } catch {}
          try { btn.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, pointerType: 'mouse', isPrimary: true, ...mopts({ buttons: 0 }) })); } catch {}
          try { btn.dispatchEvent(new MouseEvent('mouseup', mopts({ buttons: 0 }))); } catch {}
          try { btn.dispatchEvent(new MouseEvent('click', mopts({ buttons: 0 }))); } catch {}
          try { btn.click(); } catch {}

          let attempts2 = 0;
          const checkDialog2 = () => {
            attempts2++;
            const dlg = document.querySelector(dialogSel);
            if (dlg) {
              const info = portalIfNeeded(dlg);
              log('post-click-dialog', { attempts: attempts2, phase: 2, x: info.rr.left, y: info.rr.top, w: info.rr.width, h: info.rr.height, portaled: info.portaled });
              if (wasHidden) {
                // Re-apply hide now that popover is portaled out
                for (const t of UC_WITH_CHAT_TARGETS) {
                  for (const el of document.querySelectorAll(t.selector + '[data-uc-with-chat="1"]')) {
                    el.classList.remove(t.modifier);
                  }
                }
                let style = document.getElementById(UC_HIDE_STYLE_ID);
                if (!style) {
                  style = document.createElement('style');
                  style.id = UC_HIDE_STYLE_ID;
                  style.textContent = `
                    .channel-root__right-column, [data-a-target="right-column"], .right-column {
                      width: 0 !important; min-width: 0 !important; max-width: 0 !important;
                      overflow: hidden !important; visibility: hidden !important;
                    }
                  `;
                  document.documentElement.appendChild(style);
                }
              }
              wireDismiss(dlg);
              return;
            }
            if (attempts2 < 20) setTimeout(checkDialog2, 50);
            else log('post-click-no-dialog', { phase: 2, attempts: attempts2 });
          };
          setTimeout(checkDialog2, 50);
        };
        setTimeout(checkDialog, 50);

        if (!wasHidden) log('not-hidden-no-restore-needed');
        sendResponse({ ok: true });
      } catch (e) { log('exception', { msg: e.message, stack: (e.stack || '').slice(0, 300) }); sendResponse({ ok: false, error: e.message }); }
      return;
    }

    if (msg.type === 'GET_CREDITS') {
      // Sidepanel just opened — give it whatever the current snapshot
      // is right now, bypassing the dedup cache so it gets sent even if
      // we already relayed this exact value to a previous (now-dead)
      // sidepanel context.
      try {
        const snap = snapshotCredits();
        if (snap) {
          lastCreditsHash = ''; // force next observer fire to also relay
          chrome.runtime.sendMessage({ type: 'TW_CREDITS', data: snap }).catch(() => {});
        }
        sendResponse({ ok: true, data: snap });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
      return;
    }

    if (msg.type === 'TW_CLAIM_BONUS') {
      try {
        let target = null;
        const iconEl = document.querySelector('.claimable-bonus__icon');
        if (iconEl) target = iconEl.closest('button, [role="button"]');
        if (!target) {
          for (const b of document.querySelectorAll('[aria-label*="bonus" i], [aria-label*="claim" i], [aria-label*="vyzv" i]')) {
            const al = (b.getAttribute('aria-label') || '').toLowerCase();
            if (!/claim|bonus|vyzv/i.test(al)) continue;
            const r = b.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) { target = b; break; }
          }
        }
        if (!target) { sendResponse({ ok: false, error: 'no_claim_btn' }); return; }
        const r = target.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const opts = (extra = {}) => ({
          bubbles: true, cancelable: true, composed: true,
          clientX: x, clientY: y, view: window, button: 0, buttons: 1, ...extra,
        });
        try { target.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', isPrimary: true, ...opts() })); } catch {}
        try { target.dispatchEvent(new MouseEvent('mousedown', opts())); } catch {}
        try { target.dispatchEvent(new PointerEvent('pointerup',   { pointerId: 1, pointerType: 'mouse', isPrimary: true, ...opts({ buttons: 0 }) })); } catch {}
        try { target.dispatchEvent(new MouseEvent('mouseup',   opts({ buttons: 0 }))); } catch {}
        try { target.dispatchEvent(new MouseEvent('click',     opts({ buttons: 0 }))); } catch {}
        try { target.click(); } catch {}
        sendResponse({ ok: true });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
      return;
    }

    if (msg.type === 'GET_CHANNEL_AVATAR') {
      try {
        const imgs = document.querySelectorAll('img[src*="jtv_user_pictures"], img[src*="profile_image"], [class*="channel-info"] img, [data-a-target*="avatar"] img, .channel-info-content img');
        let pick = null;
        for (const img of imgs) {
          const r = img.getBoundingClientRect();
          if (r.width >= 28 && r.width <= 300 && Math.abs(r.width - r.height) < 4 && img.src) {
            pick = img.src; break;
          }
        }
        sendResponse({ ok: true, avatar: pick });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
      return;
    }

    if (msg.type === 'GET_DOM_COLORS') {
      try {
        sendResponse({ ok: true, colors: getDomColors(msg.usernames || []) });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
      return;
    }

    if (msg.type === 'SCRAPE_CHAT') {
      try {
        sendResponse({ ok: true, messages: scrapeMessages() });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
      return;
    }

    if (msg.type === 'SEND_CHAT') {
      sendChat(msg.text)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
  });

  // Resolve rendered username colors from the live Twitch/7TV chat DOM. The
  // .seventv-chat-user wrapper carries an inline style="color: rgb(...)" that
  // reflects whatever color Twitch+7TV decided on (Twitch's real chat color,
  // including any user-custom hex — this is stricter than hash palette guesses).
  function getDomColors(usernames) {
    const want = new Set((usernames || []).map((u) => String(u).toLowerCase()));
    if (!want.size) return {};
    const out = {};
    // 7TV path
    document.querySelectorAll('.seventv-chat-user').forEach((el) => {
      const uEl = el.querySelector('.seventv-chat-user-username');
      const name = (uEl?.textContent || '').trim().toLowerCase();
      if (!name || !want.has(name) || out[name]) return;
      const col = el.style.color;
      if (col) out[name] = col;
    });
    // Native Twitch path: .chat-author__display-name carries inline color
    document.querySelectorAll('.chat-author__display-name, [data-a-target="chat-message-username"]').forEach((el) => {
      const name = (el.textContent || '').trim().toLowerCase();
      if (!name || !want.has(name) || out[name]) return;
      const col = el.style.color;
      if (col) out[name] = col;
    });
    return out;
  }

  function scrapeMessages() {
    const messages = [];
    const seenLines = new Set();

    // Najít všechny chat lines (7TV i nativní Twitch)
    const lineSelectors = [
      '.seventv-message',
      '.seventv-chat-line',
      '.chat-line__message',
      '[data-a-target="chat-line-message"]'
    ];
    const lines = [];
    for (const sel of lineSelectors) {
      document.querySelectorAll(sel).forEach((el) => {
        if (!seenLines.has(el)) {
          seenLines.add(el);
          lines.push(el);
        }
      });
    }

    // Synthetic timestamps - každá zpráva 1s rozestup, posledni je nejnovější (just before now)
    const now = Date.now();
    const baseTime = now - lines.length * 1000;

    let idx = 0;
    for (const line of lines) {
      // Username
      const userEl = line.querySelector(
        '.seventv-chat-user-username, [data-a-user] .chat-author__display-name, ' +
        '.chat-author__display-name, [data-a-target="chat-message-username"]'
      );
      const username = (userEl?.textContent || '').trim();
      if (!username) continue;

      // Color z parent .seventv-chat-user nebo z elementu samotného
      const colorEl = line.querySelector('.seventv-chat-user, [data-a-user]') || userEl;
      const color = colorEl?.style?.color || '#9146ff';

      // Walk DOM (include img alt text — emotes are <img> with alt=emoteName)
      const walk = (node) => {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent;
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.tagName === 'IMG') return ' ' + (node.alt || '') + ' ';
          let t = '';
          for (const c of node.childNodes) t += walk(c);
          return t;
        }
        return '';
      };

      // Body: prefer outermost message container (has ALL fragments as children).
      // Twitch native chat splits message into multiple .text-fragment + .mention-fragment
      // spans — picking just the first one (querySelector default) would truncate.
      let text = '';
      const container = line.querySelector(
        '.seventv-message-body, [data-a-target="chat-message-text"], ' +
        '[class*="message-body"], [class*="message-content"]'
      );
      if (container) {
        text = walk(container);
      } else {
        // No container — concatenate all known fragment types in document order.
        const frags = line.querySelectorAll('.text-fragment, .mention-fragment, [class*="text-fragment"]');
        for (const f of frags) text += walk(f);
      }
      // Strip UC_MARKER (Braille blank, U+2800) before emptiness check
      // — trim() alone doesn't recognise it as whitespace, so marker-
      // only extractions would pass through as garbage.
      text = text.replace(/\u2800/g, '').replace(/\s+/g, ' ').trim();

      if (!text) {
        const fullText = (line.textContent || '').trim();
        text = fullText.replace(username, '').replace(/\u2800/g, '').replace(/^[\s:]+/, '').trim();
      }
      if (!text) continue;

      messages.push({
        platform: 'twitch',
        username,
        message: text,
        color,
        timestamp: baseTime + idx * 1000,
        id: 'scraped-' + idx + '-' + now,
        scraped: true
      });
      idx++;
    }

    return messages;
  }

  function findInput() {
    // Moderní Twitch - Slate editor (contenteditable div uvnitř chat-input)
    const selectors = [
      '[data-a-target="chat-input"] [contenteditable="true"]',
      '[data-a-target="chat-input"]',
      'textarea[data-a-target="chat-input"]',
      '.chat-input [contenteditable="true"]',
      '.chat-input textarea'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  async function sendChat(text) {
    const input = findInput();
    if (!input) throw new Error('Twitch chat input nenalezen');

    input.focus();

    // Počkat chvíli na focus
    await new Promise((r) => setTimeout(r, 50));

    if (input.tagName === 'TEXTAREA') {
      // Starší Twitch - React textarea
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value'
      ).set;
      setter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // Moderní Twitch - Slate contenteditable div
      // Vyčistit obsah a vložit text přes simulaci paste
      input.focus();

      // Metoda 1: DataTransfer paste (nejspolehlivější pro Slate)
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        input.dispatchEvent(
          new ClipboardEvent('paste', {
            clipboardData: dt,
            bubbles: true,
            cancelable: true
          })
        );
      } catch {
        // Metoda 2: InputEvent insertText
        try {
          input.dispatchEvent(
            new InputEvent('beforeinput', {
              inputType: 'insertText',
              data: text,
              bubbles: true,
              cancelable: true
            })
          );
        } catch {
          // Metoda 3: execCommand fallback
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, text);
        }
      }
    }

    // Počkat na React/Slate zpracování
    await new Promise((r) => setTimeout(r, 150));

    // Kliknout na Send tlačítko
    const sendBtn = document.querySelector(
      '[data-a-target="chat-send-button"]'
    );
    if (sendBtn) {
      sendBtn.click();
    } else {
      // Fallback - Enter key
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true
        })
      );
    }
  }

  async function replyChat(text, parentMsgId, username) {
    // Najít zprávu v Twitch chatu podle message ID a kliknout její reply button
    let clicked = false;

    const lines = document.querySelectorAll(
      '.chat-line__message, [class*="chat-line--"], [data-a-target="chat-line-message"]'
    );

    for (const line of lines) {
      // Hledej msg ID v atributech elementu nebo jeho potomků
      const hasId =
        line.getAttribute('data-msg-id') === parentMsgId ||
        line.querySelector(`[data-msg-id="${parentMsgId}"]`);

      if (!hasId) continue;

      // Hover pro zobrazení action buttons
      line.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      line.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));

      // Najít reply button
      const replyBtn =
        line.querySelector('[data-a-target="chat-reply-button"]') ||
        line.querySelector('button[aria-label*="Reply"]') ||
        line.querySelector('button[aria-label*="Odpov"]') ||
        line.querySelector('button[aria-label*="eply"]');

      if (replyBtn) {
        replyBtn.click();
        await new Promise((r) => setTimeout(r, 300));
        clicked = true;
      }
      break;
    }

    if (clicked) {
      // Reply stav je nastavený → odeslat text (Twitch přidá threading automaticky)
      await sendChat(text);
    } else {
      // Zpráva nenalezena v DOM (scrolled away) → fallback na @mention
      await sendChat('@' + username + ' ' + text);
    }
  }

  // ---- DOM mirror: Twitch redeem / highlighted / community-goal lines ----
  // IRC doesn't carry text-less redemptions (community goals, "unlock emote"),
  // only PubSub does — and PubSub needs OAuth, which our anonymous justinfan
  // connection can't do. Watching the rendered Twitch chat DOM lets us mirror
  // those events anyway.
  const REDEEM_SEEN = new WeakSet();
  const REDEEM_KEY_TTL = 30 * 1000; // ms — dedup against rapid re-render
  const redeemKeyMap = new Map();

  function currentTwitchChannel() {
    const m = location.pathname.match(/^\/([a-zA-Z0-9_]+)(?:\/|$)/);
    return m ? m[1].toLowerCase() : null;
  }

  function extractRedeem(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
    if (REDEEM_SEEN.has(node)) return null;

    const cls = (node.className && typeof node.className === 'string') ? node.className : '';
    const deep = (node.textContent || '').trim();
    if (!deep) return null;

    // Heuristics: redeem/highlight/community-goal lines on Twitch typically
    // carry one of these class hints OR contain the phrase "redeemed" with
    // no regular chat ":" username→message split.
    const isRedeemClass = /redeem|channel-points|highlight|contribution|community-goal/i.test(cls);
    const hasRedeemedWord = / redeemed /i.test(deep);

    if (!isRedeemClass && !hasRedeemedWord) return null;

    // Reject container nodes that wrap multiple chat lines — otherwise our
    // textContent grabs reward header + cost + following chat message all
    // jammed together and the reward name ends up as
    //   "Send Cult follower message2000mojma98: Veru Veru..."
    const childChatLines = node.querySelectorAll
      ? node.querySelectorAll('.chat-line__message, [class*="chat-line"]').length
      : 0;
    if (childChatLines > 1) return null;

    // Reject lines that have an embedded chat message body — those come
    // through IRC as PRIVMSG with custom-reward-id, which the sidepanel
    // already renders as a proper redeem. Emitting DOM for them would
    // duplicate (and mangle) the event.
    const hasInlineMessage = node.querySelector
      && (node.querySelector('[data-a-target="chat-line-message-body"]')
        || node.querySelector('.seventv-message-body')
        || node.querySelector('[class*="message-body"]'));
    if (hasInlineMessage) return null;

    // Reject if text contains ":" after "redeemed" (chat message smuggled
    // into the snapshot via sibling DOM nesting).
    const redeemedAt = deep.search(/ redeemed /i);
    if (redeemedAt !== -1 && /:\s/.test(deep.substring(redeemedAt))) return null;

    // Try to extract username
    const userEl = node.querySelector && (
      node.querySelector('.chat-author__display-name')
      || node.querySelector('[data-a-target="chat-message-username"]')
      || node.querySelector('.seventv-chat-user-username')
      || node.querySelector('[data-a-user]')
    );
    let username = userEl?.textContent?.trim() || '';

    // Fallback: take the first "word before redeemed"
    if (!username && hasRedeemedWord) {
      const m = deep.match(/^\s*([A-Za-z0-9_]{2,25})\s+redeemed\s/i);
      if (m) username = m[1];
    }
    if (!username) return null;

    // Extract reward name + cost. Twitch's textContent concatenates the
    // reward title and the trailing cost pill with NO separator, so
    // "redeemed Contribute to Cult's Totem500" comes through as one
    // string. Pull trailing digits as cost first, then strip them off
    // the rewardName so we don't render "…Totem500" alongside the cost
    // pill ⊙ 500.
    let rewardName = null;
    let rewardCost = null;
    const rm = deep.match(/redeemed\s+(.+?)\s*$/i);
    if (rm) rewardName = (rm[1] || '').trim();
    if (rewardName) {
      const cm = rewardName.match(/(?:[\u25CB\u25CF\u25CE\u2B24\u2022\u25A0-\u25FF\u2700-\u27BF⚫⚪◯●○]\s*)?(\d{1,7})\s*$/);
      if (cm && parseInt(cm[1], 10) > 0) {
        rewardCost = parseInt(cm[1], 10);
        rewardName = rewardName.slice(0, cm.index).trim();
      }
    }

    // Optional attached chat message (redeems that require text input)
    let message = '';
    const msgEl = node.querySelector && (
      node.querySelector('[data-a-target="chat-line-message-body"]')
      || node.querySelector('.seventv-message-body')
      || node.querySelector('[class*="message-body"]')
    );
    if (msgEl) message = (msgEl.textContent || '').trim();

    REDEEM_SEEN.add(node);

    const key = `${username.toLowerCase()}|${rewardName || ''}|${message.slice(0, 40)}`;
    const now = Date.now();
    const prev = redeemKeyMap.get(key);
    if (prev && now - prev < REDEEM_KEY_TTL) return null;
    redeemKeyMap.set(key, now);
    // Trim old keys
    if (redeemKeyMap.size > 500) {
      for (const [k, t] of redeemKeyMap) {
        if (now - t > REDEEM_KEY_TTL) redeemKeyMap.delete(k);
      }
    }

    return {
      username,
      rewardName,
      rewardCost,
      message,
      timestamp: now,
      channel: currentTwitchChannel(),
    };
  }

  let redeemObserver = null;
  function setupRedeemObserver() {
    if (redeemObserver) return;
    redeemObserver = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          // Check the node itself + any chat-line descendants
          const candidates = [node];
          if (node.querySelectorAll) {
            node.querySelectorAll('.chat-line__message, [class*="chat-line"], [class*="redeem"], [class*="highlight"]').forEach((el) => candidates.push(el));
          }
          for (const cand of candidates) {
            const data = extractRedeem(cand);
            if (data) {
              try { chrome.runtime.sendMessage({ type: 'TW_REDEEM_DOM', data }); } catch { /* extension context gone */ }
            }
          }
        }
      }
    });
    redeemObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ---- Intercept native Twitch "Sbalit" (collapse) button ----
  // Native collapse unmounts .chat-shell which kills redeem/credit/color
  // mirroring. Capture-phase listener rewrites the click to our soft-hide.
  function isCollapseButton(el) {
    if (!el || !el.closest) return null;
    return el.closest('[data-a-target="right-column__toggle-collapse-btn"]');
  }
  function setupSbalitIntercept() {
    document.addEventListener('click', (e) => {
      const btn = isCollapseButton(e.target);
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      hideTwitchChatVisually(!ucChatHidden);
    }, true);
  }

  // ---- Community highlights mirror (Hype Train, gift-sub leaderboard, pinned messages) ----
  // These live in Twitch's DOM, not IRC. Observer watches the highlights
  // container and relays structured snapshots to the sidepanel, which
  // renders a compact version at the top of its own chat.
  // Prefer the inner card class — that's the actual content unit. Falling
  // back to broader matches when the card class isn't present.
  const HIGHLIGHT_SELECTORS = [
    '.community-highlight-stack__card',
    '.community-highlight',
    '[data-test-selector*="community-highlight"]',
  ];
  let highlightObserver = null;
  let lastHighlightHash = '';
  function snapshotHighlights() {
    const cards = [];
    const seenEls = new Set();
    const seenTexts = new Set();
    // Collect all candidate elements first
    const allCandidates = [];
    for (const sel of HIGHLIGHT_SELECTORS) {
      document.querySelectorAll(sel).forEach((el) => {
        if (!seenEls.has(el)) {
          seenEls.add(el);
          allCandidates.push(el);
        }
      });
    }
    // Drop ancestors of other candidates — keep only the innermost matches
    // so a wrapping container and its inner card don't both emit. Also
    // drop descendants of already-kept elements.
    const kept = allCandidates.filter((el) =>
      !allCandidates.some((other) => other !== el && el.contains(other))
    );
    for (const el of kept) {
      const text = (el.textContent || '').trim();
      if (!text) continue;
      const key = text.slice(0, 120);
      if (seenTexts.has(key)) continue;
      seenTexts.add(key);
      const isHypeTrain = /hype\s*train|hype\s*raid|úr\.|%\b/i.test(text)
        || /hype/i.test(el.className || '');
      const isRaid = /n[aá]jezd|raid/i.test(text) || /raid/i.test(el.className || '');
      const isGiftLeaderboard = /gift/i.test(text) || /gift/i.test(el.className || '');
      const kind = isRaid ? 'raid'
        : isHypeTrain ? 'hype-train'
        : isGiftLeaderboard ? 'gift-leaderboard'
        : 'generic';
      // Pull the first channel-style avatar image out of the card if
      // present — raid notices embed the raider's profile pic.
      let avatar = null;
      const imgs = el.querySelectorAll('img[src]');
      for (const img of imgs) {
        const src = img.src || '';
        // Skip tiny Twitch icons (badges, arrows) — avatars have profile-image-style paths
        if (/profile_image|jtvnw\.net\/jtv_user_pictures|userlogos|cdn-prod\.twitch\.tv\/ttv-boxart/i.test(src)) {
          avatar = src;
          break;
        }
        // Fall back to first square-ish img with size >=24
        const r = img.getBoundingClientRect();
        if (r.width >= 24 && Math.abs(r.width - r.height) < 4) { avatar = src; break; }
      }
      cards.push({ kind, text: text.slice(0, 400), avatar, html: el.outerHTML.slice(0, 4000) });
    }
    return cards;
  }
  function relayHighlights() {
    const cards = snapshotHighlights();
    const hash = cards.map((c) => c.kind + ':' + c.text).join('|');
    if (hash === lastHighlightHash) return;
    lastHighlightHash = hash;
    try {
      chrome.runtime.sendMessage({
        type: 'TW_HIGHLIGHTS',
        channel: currentTwitchChannel(),
        cards,
      });
    } catch { /* extension context gone */ }
  }
  // ---- Twitch credits mirror (bits balance + channel-point balance + icon) ----
  // Anonymous IRC can't pull these via PubSub/Helix — they're behind OAuth.
  // Mirroring the rendered .community-points-summary widget from the Twitch
  // tab is the only anonymous-safe path. We extract: bits string, channel-point
  // balance string, and the channel-point icon URL (channels can customize it).
  let lastCreditsHash = '';
  function snapshotCredits() {
    const summary = document.querySelector('[data-test-selector="community-points-summary"], .community-points-summary');
    if (!summary) return null;
    // Multiple known selectors — Twitch's class hashes change but the
    // data-test-selector attrs are reasonably stable. We also fall back to
    // looking at the .ScAnimatedNumber-* spans inside the summary in
    // document order: convention is bits first, then channel-points.
    const bitsEl = summary.querySelector('[data-test-selector="bits-balance-string"], [data-a-target="bits-balance-text"]');
    let pointsEl = summary.querySelector('[data-test-selector="copo-balance-string"], [data-a-target="copo-balance-text"]');
    if (!pointsEl) {
      const animSpans = summary.querySelectorAll('[class*="ScAnimatedNumber"]');
      // Skip the bits one if we found it
      for (const s of animSpans) {
        if (bitsEl && bitsEl.contains(s)) continue;
        pointsEl = s;
        break;
      }
    }
    const iconEl = summary.querySelector('img.image--D5HXC, img[src*="channel-points-icons"]');
    // Claim-bonus button: appears periodically as a visible button near
    // the points summary with aria-label like "Claim Bonus" / "Vyzvédněte
    // si bonus" depending on locale, or a [data-test-selector*="claim"].
    // We just look for an interactive element whose label matches.
    const claimBtn = (() => {
      // Most reliable signal: the .claimable-bonus__icon class lives
      // inside the actual claim button. Walk up from there to its
      // nearest button ancestor.
      const iconEl = document.querySelector('.claimable-bonus__icon');
      if (iconEl) {
        const btn = iconEl.closest('button, [role="button"]');
        if (btn) {
          const r = btn.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return btn;
        }
      }
      // Fallback: aria-label match in EN/CZ on any visible button.
      const cands = document.querySelectorAll('[aria-label*="bonus" i], [aria-label*="claim" i], [aria-label*="vyzv" i]');
      for (const b of cands) {
        const al = (b.getAttribute('aria-label') || '').toLowerCase();
        if (!/claim|bonus|vyzv/i.test(al)) continue;
        const r = b.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return b;
      }
      return null;
    })();
    return {
      bits: bitsEl ? (bitsEl.textContent || '').trim() : null,
      points: pointsEl ? (pointsEl.textContent || '').trim() : null,
      pointsIcon: iconEl?.src || null,
      claimAvailable: !!claimBtn,
      channel: currentTwitchChannel(),
    };
  }
  function relayCredits() {
    const snap = snapshotCredits();
    if (!snap) return;
    const hash = `${snap.bits || ''}|${snap.points || ''}|${snap.pointsIcon || ''}|${snap.claimAvailable ? '1' : '0'}|${snap.channel || ''}`;
    if (hash === lastCreditsHash) return;
    lastCreditsHash = hash;
    try { chrome.runtime.sendMessage({ type: 'TW_CREDITS', data: snap }); } catch {}
  }
  // Detect Twitch's floating "+N" reward animation inside the summary
  // subtree. When Twitch fires the +10 watch reward, a small transient
  // element with text "+10" (or similar) appears near the points icon.
  // We catch it by walking added nodes' text content; if it matches the
  // "+N" pattern we relay a fixed delta event to the sidepanel.
  function scanForRewardFlash(nodeList) {
    for (const n of nodeList) {
      if (n.nodeType !== Node.ELEMENT_NODE && n.nodeType !== Node.TEXT_NODE) continue;
      const txt = (n.textContent || '').trim();
      if (!txt || txt.length > 10) continue;
      const m = /^\+\s*(\d{1,4})\s*$/.exec(txt);
      if (!m) continue;
      const amount = parseInt(m[1], 10);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 5000) continue;
      try { chrome.runtime.sendMessage({ type: 'TW_POINTS_DELTA', amount }); } catch {}
      return true;
    }
    return false;
  }

  let creditsObserver = null;
  function setupCreditsObserver() {
    if (creditsObserver) return;
    creditsObserver = new MutationObserver((mutations) => {
      // Fast path: scan added nodes for Twitch's reward flash — needs
      // synchronous detection so we catch it before Twitch tears it down.
      for (const m of mutations) {
        if (m.addedNodes?.length) scanForRewardFlash(m.addedNodes);
      }
      if (creditsObserver._t) return;
      creditsObserver._t = setTimeout(() => {
        creditsObserver._t = null;
        relayCredits();
      }, 400);
    });
    creditsObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    // Twitch lazy-loads the community-points-summary subtree, and the
    // ScAnimatedNumber span sometimes only renders the actual balance
    // after the first watch-reward animation fires (the +10 flash) —
    // before that its textContent can be empty/0 even though the value
    // is held in component state. MutationObserver settles on
    // surrounding noise and misses it. So:
    //   - Stagger early scrapes during page hydration
    //   - Then keep polling every 5s permanently. It's just a DOM walk,
    //     no network — and the relay hash-dedups so nothing is sent
    //     unless the snapshot actually changed.
    [800, 2000, 4000, 8000, 16000].forEach((ms) => setTimeout(relayCredits, ms));
    setInterval(relayCredits, 5000);
  }

  function setupHighlightsObserver() {
    if (highlightObserver) return;
    highlightObserver = new MutationObserver(() => {
      // Throttle via microtask coalescing — multiple mutations per tick
      // collapse to a single snapshot.
      if (highlightObserver._t) return;
      highlightObserver._t = setTimeout(() => {
        highlightObserver._t = null;
        relayHighlights();
      }, 300);
    });
    highlightObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    // First snapshot after initial paint
    setTimeout(relayHighlights, 1500);
  }

  // Setup after DOM is ready (idempotent via window._ucTwitch guard at top)
  function setupAll() {
    setupRedeemObserver();
    setupSbalitIntercept();
    setupHighlightsObserver();
    setupCreditsObserver();
    // Always-on chat-toggle button in the top nav — hides chat when
    // visible, restores when hidden. Observer keeps it re-injected
    // across SPA navigations and Twitch re-renders.
    ensureRestoreButton();
    setupRestoreBtnObserver();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupAll, { once: true });
  } else {
    setupAll();
  }
})();
