// Přihlašovací okno: tři loga platforem vedle sebe, reflektorový hover
// (okolí ztmavne, vybrané logo se rozsvítí) — chování převzaté z AoE Inviter
// (PrihlaseniOkno), grafika přizpůsobená UnityChatu. Sdílené addonem i webem
// (dřív web/src/loginModal.js); DOM a cesty k logům dostává zvenku, CSS je
// v extension/composer.css.

const DEFAULT_PLATFORMS = ['twitch', 'kick', 'youtube'];
const DEFAULT_NAMES = { twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube' };

export class LoginModal {
  /**
   * @param {object} o
   * @param {(platform: string) => Promise<void>|void} o.onPick  klik na logo
   * @param {Record<string, {base: string, gold: string}>} o.logos  URL log (barevné + zlaté na hover)
   * @param {string[]} [o.platforms]
   * @param {Record<string, string>} [o.names]
   * @param {string} [o.note]  text pod logy
   * @param {Document} [o.doc]
   */
  constructor({ onPick, logos, platforms = DEFAULT_PLATFORMS, names = DEFAULT_NAMES, note, doc = globalThis.document }) {
    this.onPick = onPick;
    this.logos = logos || {};
    this.platforms = platforms;
    this.names = names;
    this.note = note || 'Přihlášení proběhne v novém okně přímo u platformy.<br>UnityChat nikdy nevidí tvoje heslo.';
    this.doc = doc;
    this.el = null;
    this._onKey = (e) => { if (e.key === 'Escape') this.close(); };
  }

  /** Chyba při startu přihlášení — zůstat otevřený a říct, co se stalo. Vrací false, když okno není otevřené. */
  showError(text) {
    if (!this.el) return false;
    let el = this.el.querySelector('.uc-login-err');
    if (!el) { el = this.doc.createElement('p'); el.className = 'uc-login-err'; el.setAttribute('role', 'alert'); this.el.querySelector('.uc-login-choices').after(el); }
    el.textContent = text;
    return true;
  }

  open({ title = 'Přihlášení', subtitle = 'Vyber platformu, na kterou chceš psát', only = null } = {}) {
    this.close();
    const doc = this.doc;
    const shade = doc.createElement('div');
    shade.className = 'uc-shade';
    shade.setAttribute('role', 'dialog');
    shade.setAttribute('aria-modal', 'true');
    shade.setAttribute('aria-label', title);
    const items = (only || this.platforms).map((p) => `
      <button type="button" class="uc-login-choice" data-platform="${p}" aria-label="Přihlásit se přes ${esc(this.names[p] || p)}">
        <span class="uc-logo">
          <img class="uc-logo-base" src="${esc(this.logos[p]?.base || '')}" alt="" draggable="false">
          <img class="uc-logo-gold" src="${esc(this.logos[p]?.gold || this.logos[p]?.base || '')}" alt="" draggable="false">
        </span>
        <span class="uc-login-name">${esc(this.names[p] || p)}</span>
      </button>`).join('');
    shade.innerHTML = `
      <div class="uc-login-win">
        <button type="button" class="uc-login-close" aria-label="Zavřít">&times;</button>
        <h1>${esc(title)}</h1>
        <p class="uc-login-sub">${esc(subtitle)}</p>
        <div class="uc-login-choices">${items}</div>
        <p class="uc-login-note">${this.note}</p>
      </div>`;
    // Klik na překryv zavře — ale ne ten, který modal právě otevřel (ochrana 250 ms).
    const openedAt = Date.now();
    shade.addEventListener('click', (e) => { if (e.target === shade && Date.now() - openedAt > 250) this.close(); });
    shade.querySelector('.uc-login-close').addEventListener('click', () => this.close());
    for (const btn of shade.querySelectorAll('.uc-login-choice')) {
      btn.addEventListener('click', async () => {
        btn.classList.add('busy');
        try { await this.onPick(btn.dataset.platform); } finally { btn.classList.remove('busy'); }
      });
    }
    // Výběr loga řídí JS, ne :hover: v mezeře mezi logy zůstává vybrané to,
    // ze kterého kurzor odjel, a přepne se až po překročení prahu za středem
    // mezery (hystereze 18 px). Odjetí z řady log výběr zruší.
    const choicesEl = shade.querySelector('.uc-login-choices');
    const choices = [...choicesEl.querySelectorAll('.uc-login-choice')];
    const HYST = 18;
    let active = null;
    const setActive = (btn) => {
      if (btn === active) return;
      active = btn;
      for (const c of choices) c.classList.toggle('is-active', c === btn);
      choicesEl.classList.toggle('has-active', !!btn);
      shade.classList.toggle('has-active', !!btn);
    };
    choicesEl.addEventListener('mousemove', (e) => {
      const rects = choices.map((c) => c.getBoundingClientRect());
      const band = { top: Math.min(...rects.map((r) => r.top)) - 12, bottom: Math.max(...rects.map((r) => r.bottom)) + 12 };
      if (e.clientY < band.top || e.clientY > band.bottom) { setActive(null); return; }
      let best = null; let bestD = Infinity;
      choices.forEach((c, i) => {
        const r = rects[i];
        const d = e.clientX < r.left ? r.left - e.clientX : e.clientX > r.right ? e.clientX - r.right : 0;
        if (d < bestD) { bestD = d; best = c; }
      });
      if (active && best !== active) {
        // hystereze: přepnout až když je kurzor o HYST blíž novému než starému
        const ra = rects[choices.indexOf(active)];
        const da = e.clientX < ra.left ? ra.left - e.clientX : e.clientX > ra.right ? e.clientX - ra.right : 0;
        if (da - bestD < HYST) return;
      }
      setActive(best);
    });
    choicesEl.addEventListener('mouseleave', () => setActive(null));
    for (const c of choices) {
      c.addEventListener('focus', () => setActive(c));
      c.addEventListener('blur', () => { if (active === c) setActive(null); });
    }
    doc.body.appendChild(shade);
    doc.addEventListener('keydown', this._onKey);
    this.el = shade;
    // setTimeout místo rAF: v neaktivním tabu rAF nemusí přijít a okno by zůstalo neviditelné.
    setTimeout(() => shade.classList.add('open'), 10);
  }

  close() {
    if (!this.el) return;
    this.doc.removeEventListener('keydown', this._onKey);
    this.el.remove();
    this.el = null;
  }

  get isOpen() { return !!this.el; }
}

/**
 * Menu „Psát jako" u pole pro psaní: řádek na platformu (vybraná / přihlásit /
 * odpojit ×) + Odhlásit se. Sdílené addonem i webem; stav drží volající.
 * @param {HTMLElement} menuEl
 * @param {object} o
 * @param {{platforms?: Record<string, {login: string, displayName?: string}|null>}|null} o.me  odpověď /auth/me
 * @param {string} o.current  vybraná platforma
 * @param {(p: string) => void} o.onSelect   přihlášená platforma → psát na ni
 * @param {(p: string) => void} o.onLogin    nepřihlášená → přihlásit / připojit
 * @param {(p: string) => Promise<void>} o.onUnlink
 * @param {() => void} o.onLogout
 * @param {() => void} [o.onClose]
 */
export function renderPlatformMenu(menuEl, { me, current, onSelect, onLogin, onUnlink, onLogout, onClose, platforms = DEFAULT_PLATFORMS, names = DEFAULT_NAMES }) {
  const CLS = { twitch: 'tw', kick: 'ki', youtube: 'yt' };
  const rows = platforms.map((p) => {
    const id = me?.platforms?.[p] || null;
    const cls = CLS[p] || p;
    const sel = p === current ? ' selected' : '';
    const state = id
      ? `<span class="pm-state pm-linked">${esc(id.displayName || id.login)}</span><span class="pm-unlink" role="button" tabindex="0" data-unlink="${p}" title="Odpojit ${esc(names[p] || p)}">&times;</span>`
      : '<span class="pm-state pm-login">Přihlásit</span>';
    return `<button type="button" class="pm-row${sel}" data-platform="${p}" data-linked="${id ? '1' : '0'}">`
      + `<span class="badge ${cls} pm-badge">${cls.toUpperCase()}</span><span class="pm-name">${esc(names[p] || p)}</span>${state}</button>`;
  }).join('');
  const foot = me ? '<button type="button" class="pm-row pm-logout" data-action="logout"><span class="pm-name">Odhlásit se</span></button>' : '';
  menuEl.innerHTML = `<div class="pm-title">Psát jako</div>${rows}${foot}`;
  for (const x of menuEl.querySelectorAll('.pm-unlink')) {
    x.addEventListener('click', async (e) => {
      e.stopPropagation();
      x.textContent = '…';
      try { await onUnlink(x.dataset.unlink); } finally { onClose?.(); }
    });
  }
  for (const btn of menuEl.querySelectorAll('.pm-row')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onClose?.();
      if (btn.dataset.action === 'logout') { onLogout(); return; }
      const p = btn.dataset.platform;
      if (btn.dataset.linked === '1') onSelect(p); else onLogin(p);
    });
  }
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
