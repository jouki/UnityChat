// UnityChat - Kick content script
// Odesílá zprávy přes DOM (chat otevřený) nebo Kick API (chat zavřený)

(function () {
  if (window._ucKick) return;
  window._ucKick = true;
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PING') {
      // Viewer's own Kick username. Kick is a Next.js app — the logged-in
      // user data is streamed in <script> tags as __next_f.push payloads.
      // We parse those rather than guessing from DOM (chat user spans would
      // return a random chatter) or relying on a specific API endpoint.
      let username = null;
      try {
        // Strategy 1: __next_f payload contains {"username":"...","slug":"..."}
        // alongside "session" / "authenticated" markers for the logged-in user.
        for (const s of document.querySelectorAll('script')) {
          const txt = s.textContent;
          if (!txt || !txt.includes('__next_f.push')) continue;
          // Match username key near session/authenticated context only (avoid
          // picking up streamer names from other parts of the payload).
          const m = txt.match(/"session"[^{}]{0,100}"user"\s*:\s*\{[^}]*?"username"\s*:\s*"([^"]+)"/);
          if (m) { username = m[1]; break; }
        }
        // Strategy 2: avatar image alt attribute in header/navbar.
        if (!username) {
          const avatars = document.querySelectorAll(
            'header img[alt], nav img[alt], [class*="navbar"] img[alt], [class*="avatar"] img[alt]'
          );
          for (const img of avatars) {
            const alt = img.getAttribute('alt')?.trim();
            if (alt && /^[a-z0-9_-]+$/i.test(alt) && alt.toLowerCase() !== 'kick') {
              username = alt;
              break;
            }
          }
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
