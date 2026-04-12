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
      // Collapse vanilla Twitch chat
      const collapseBtn = document.querySelector('[data-a-target="right-column__toggle-collapse-btn"]');
      if (collapseBtn) collapseBtn.click();
      // Open UnityChat side panel
      chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' }).catch(() => {});
    });
    return btn;
  }

  function findChatHeader() {
    // Twitch uses several header classes across layouts; try them in order.
    const selectors = [
      '.stream-chat-header',
      '[data-a-target="stream-chat-header"]',
      '.chat-room__header',
      '.chat-shell__header',
      '.chat-header'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    // Fallback: climb from the collapse toggle button.
    const toggle = document.querySelector('[data-a-target="right-column__toggle-collapse-btn"]');
    if (toggle) {
      // Walk up until we find a row-ish container (flex parent with siblings).
      let n = toggle.parentElement;
      for (let i = 0; i < 5 && n; i++) {
        if (n.childElementCount >= 2) return n;
        n = n.parentElement;
      }
    }
    return null;
  }

  function injectSidePanelButton() {
    if (document.getElementById(UC_BTN_ID)) return;
    const header = findChatHeader();
    if (!header) return;
    const btn = buildUcButton();
    // Insert after first child (collapse toggle), flex order:1 keeps it there
    if (header.children.length > 0) {
      header.insertBefore(btn, header.children[1] || null);
    } else {
      header.appendChild(btn);
    }
    console.log('[UC] Twitch button injected into header');
  }

  function startHeaderObserver() {
    injectSidePanelButton();
    const obs = new MutationObserver(() => {
      if (!document.getElementById(UC_BTN_ID)) injectSidePanelButton();
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startHeaderObserver, { once: true });
  } else {
    startHeaderObserver();
  }

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
      // Hledat všechny klikatelné username elementy v Twitch chatu
      const selectors = [
        `[data-a-user="${name}"]`,
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

      // Body - zkusit více selektorů
      const bodyEl = line.querySelector(
        '.seventv-message-body, .text-fragment, [data-a-target="chat-message-text"], ' +
        '[class*="message-body"], [class*="message-content"]'
      );
      let text = (bodyEl?.textContent || '').trim();

      // Fallback - vzít celý text linky a odečíst username
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
})();
