// UnityChat — tlačítko s logem do záhlaví chatu platformy (Twitch, Kick). Sdílené content
// scripty: manifest ho načítá PŘED content/twitch.js a content/kick.js (stejný izolovaný svět,
// takže window.__ucHeaderButton je vidět). Klik → TOGGLE_SIDE_PANEL do background (Chrome
// side panel / Firefox postranní lišta / Opera záložka); platformní reakci řeší onResult.
(function () {
  if (window.__ucHeaderButton) return;

  /**
   * @param {{ id: string, onResult?: (resp: { action?: string } | undefined) => void }} o
   * @returns {HTMLButtonElement}
   */
  window.__ucHeaderButton = function buildUcHeaderButton({ id, onResult }) {
    const btn = document.createElement('button');
    btn.id = id;
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
      chrome.runtime.sendMessage({ type: 'TOGGLE_SIDE_PANEL' }, (resp) => { onResult?.(resp); });
    });
    return btn;
  };
})();
