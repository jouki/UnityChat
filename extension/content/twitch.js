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
      hideTwitchChatVisually(false);
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
    restoreBtnObserver = new MutationObserver(() => {
      if (ucChatHidden) ensureRestoreButton();
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
      removeRestoreButton();
      if (restoreBtnObserver) {
        restoreBtnObserver.disconnect();
        restoreBtnObserver = null;
      }
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
      text = text.replace(/\s+/g, ' ').trim();

      // Last-resort fallback: full line text minus username.
      if (!text) {
        const fullText = (line.textContent || '').trim();
        text = fullText.replace(username, '').replace(/^[\s:]+/, '').trim();
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
      // Final text-level dedup — handles duplicate cards that show up via
      // two distinct selectors with the same content.
      const key = text.slice(0, 120);
      if (seenTexts.has(key)) continue;
      seenTexts.add(key);
      // Classify. Hype train has progress / minutes text; gift sub has
      // "Tier" / "subs"; pinned messages have distinctive classes.
      const isHypeTrain = /hype\s*train|hype\s*raid|úr\.|%\b/i.test(text)
        || /hype/i.test(el.className || '');
      const isGiftLeaderboard = /gift/i.test(text) || /gift/i.test(el.className || '');
      const kind = isHypeTrain ? 'hype-train' : (isGiftLeaderboard ? 'gift-leaderboard' : 'generic');
      cards.push({ kind, text: text.slice(0, 400), html: el.outerHTML.slice(0, 4000) });
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
    const bitsEl = summary.querySelector('[data-test-selector="bits-balance-string"]');
    const pointsEl = summary.querySelector('[data-test-selector="copo-balance-string"]');
    const iconEl = summary.querySelector('img.image--D5HXC, img[src*="channel-points-icons"]');
    return {
      bits: bitsEl ? (bitsEl.textContent || '').trim() : null,
      points: pointsEl ? (pointsEl.textContent || '').trim() : null,
      pointsIcon: iconEl?.src || null,
      channel: currentTwitchChannel(),
    };
  }
  function relayCredits() {
    const snap = snapshotCredits();
    if (!snap) return;
    const hash = `${snap.bits || ''}|${snap.points || ''}|${snap.pointsIcon || ''}|${snap.channel || ''}`;
    if (hash === lastCreditsHash) return;
    lastCreditsHash = hash;
    try { chrome.runtime.sendMessage({ type: 'TW_CREDITS', data: snap }); } catch {}
  }
  let creditsObserver = null;
  function setupCreditsObserver() {
    if (creditsObserver) return;
    creditsObserver = new MutationObserver(() => {
      if (creditsObserver._t) return;
      creditsObserver._t = setTimeout(() => {
        creditsObserver._t = null;
        relayCredits();
      }, 400);
    });
    creditsObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    setTimeout(relayCredits, 1500);
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
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupAll, { once: true });
  } else {
    setupAll();
  }
})();
