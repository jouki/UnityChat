// UnityChat - Kick content script
// Odesílá zprávy přes DOM (chat otevřený) nebo Kick API (chat zavřený)

(function () {
  if (window._ucKick) return;
  window._ucKick = true;
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PING') {
      // Username z Kick session dat (cookie nebo meta)
      let username = null;
      try {
        const m = document.cookie.match(/(?:^|;\s*)kick_session[^=]*=([^;]*)/);
        if (!m) {
          // Fallback: hledej v DOM
          const el = document.querySelector('[class*="username"], [class*="profile-name"]');
          username = el?.textContent?.trim() || null;
        }
      } catch {}
      sendResponse({ platform: 'kick', username });
      return;
    }

    if (msg.type === 'OPEN_USER_CARD') {
      const name = msg.username.toLowerCase();
      const els = document.querySelectorAll('.chat-entry-username, [data-chat-entry-user]');
      for (const el of els) {
        if (el.textContent?.trim().toLowerCase() === name) {
          el.click(); sendResponse({ ok: true }); return;
        }
      }
      sendResponse({ ok: false });
      return;
    }

    if (msg.type === 'SEND_CHAT') {
      sendChat(msg.text, msg.replyMeta || null)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
  });

  function findInput() {
    const sels = [
      '#message-input',
      'div[contenteditable="true"][data-placeholder]',
      '.chat-input textarea',
      'textarea[placeholder*="Send"]',
      'textarea[placeholder*="message"]',
      'div[contenteditable="true"]'
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  async function sendChat(text, replyMeta) {
    // Native Kick replies vždy přes API (DOM send neumí reply metadata).
    if (replyMeta) return sendViaAPI(text, replyMeta);
    const input = findInput();
    if (input) {
      return sendViaDOM(input, text);
    }
    // Chat zavřený → odeslat přes Kick API (bez otevírání panelu)
    return sendViaAPI(text, null);
  }

  async function sendViaDOM(input, text) {
    input.focus();
    await new Promise((r) => setTimeout(r, 50));

    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      const proto = input.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      input.textContent = '';
      document.execCommand('insertText', false, text);
    }

    await new Promise((r) => setTimeout(r, 100));

    const sendBtn = document.querySelector(
      'button[data-testid="send-message-button"], button.base-button, button[aria-label*="Send"]'
    );
    if (sendBtn) sendBtn.click();
    else input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
    }));
  }

  async function sendViaAPI(text, replyMeta) {
    const slug = window.location.pathname.replace(/^\//, '').split(/[/?#]/)[0];
    if (!slug) throw new Error('Kick kanál nenalezen v URL');

    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'KICK_SEND', slug, text, replyMeta }, (resp) => {
        if (resp?.ok) resolve();
        else reject(new Error(resp?.error || 'Odeslání selhalo'));
      });
    });
  }
})();
