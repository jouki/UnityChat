// UnityChat - Twitch content script
// Odesílá zprávy do Twitch chatu z side panelu
// Twitch používá Slate-based rich text editor - vyžaduje speciální handling

(function () {
  if (window._ucTwitch) return;
  window._ucTwitch = true;
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

    if (msg.type === 'SEND_CHAT') {
      sendChat(msg.text)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
  });

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
