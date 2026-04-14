// UnityChat "Jsem streamer" page.
// Flow:
//  1. On load, check chrome.storage.local for an existing session token.
//  2. If session exists, GET /streamers/me to render current state.
//  3. If URL hash contains #session=... (returning from OAuth callback), store it.
//  4. Link button opens OAuth flow in a new tab via POST /oauth/{platform}/start.
//  5. Unlink button DELETEs platform from account.
//  6. Logout revokes session.

const API_BASE = 'https://api.jouki.cz';
const SESSION_KEY = 'uc_streamer_session';

const PLATFORMS = [
  { id: 'twitch',  label: 'Twitch',  handleField: 'twitchLogin',   displayField: 'twitchDisplayName', avatarField: 'twitchAvatarUrl' },
  { id: 'youtube', label: 'YouTube', handleField: 'youtubeHandle', displayField: 'youtubeTitle',      avatarField: 'youtubeAvatarUrl' },
  { id: 'kick',    label: 'Kick',    handleField: 'kickSlug',      displayField: 'kickDisplayName',   avatarField: 'kickAvatarUrl' },
];

const $platforms = document.getElementById('platforms');
const $accountActions = document.getElementById('account-actions');
const $btnLogout = document.getElementById('btn-logout');

let sessionId = null;
let streamer = null;

init();

async function init() {
  // 1. Capture session from OAuth callback URL fragment.
  const hash = location.hash.slice(1);
  if (hash) {
    const params = new URLSearchParams(hash);
    const sess = params.get('session');
    if (sess) {
      await chromeStorageSet(SESSION_KEY, sess);
      // Clean URL so session isn't visible in address bar after first load.
      history.replaceState(null, '', location.pathname + location.search);
    }
  }
  // Success toast if query param indicates it
  const qs = new URLSearchParams(location.search);
  const success = qs.get('success');
  if (success) {
    toast('success', `Přihlášen${success === 'youtube' ? 'o' : 'o'} přes ${success}.`);
    history.replaceState(null, '', location.pathname);
  }

  sessionId = await chromeStorageGet(SESSION_KEY);

  await renderState();

  $btnLogout.addEventListener('click', handleLogout);
}

async function renderState() {
  // Fetch /streamers/me if we have a session.
  streamer = null;
  if (sessionId) {
    try {
      const resp = await apiFetch('/streamers/me');
      if (resp.ok && resp.data?.streamer) {
        streamer = resp.data.streamer;
      } else if (resp.status === 401) {
        // Session expired — clear.
        await chromeStorageSet(SESSION_KEY, null);
        sessionId = null;
      }
    } catch (err) {
      console.warn('Failed to fetch /streamers/me', err);
    }
  }

  renderPlatforms();
  $accountActions.classList.toggle('hidden', !sessionId);
}

function renderPlatforms() {
  $platforms.innerHTML = '';
  for (const p of PLATFORMS) {
    const linked = streamer && streamer[p.handleField];
    const handle = linked ? streamer[p.handleField] : null;
    const displayName = linked ? streamer[p.displayField] : null;
    const avatar = linked ? streamer[p.avatarField] : null;

    const card = document.createElement('div');
    card.className = 'platform' + (linked ? ' linked' : '');
    card.dataset.platform = p.id;

    const avatarEl = document.createElement(avatar ? 'img' : 'div');
    avatarEl.className = 'avatar';
    if (avatar) avatarEl.src = avatar;
    card.appendChild(avatarEl);

    const info = document.createElement('div');
    info.className = 'info';
    const pname = document.createElement('p');
    pname.className = 'pname';
    pname.textContent = p.label;
    info.appendChild(pname);
    const h = document.createElement('div');
    h.className = 'handle' + (linked ? '' : ' empty');
    h.textContent = linked ? (displayName || handle) : 'Nepřihlášeno';
    info.appendChild(h);
    card.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'actions';
    if (linked) {
      const unlink = document.createElement('button');
      unlink.className = 'btn-unlink';
      unlink.textContent = 'Odpojit';
      unlink.addEventListener('click', () => handleUnlink(p.id));
      actions.appendChild(unlink);
    } else {
      const link = document.createElement('button');
      link.className = 'btn-link';
      link.textContent = 'Přihlásit';
      link.addEventListener('click', () => handleLink(p.id));
      actions.appendChild(link);
    }
    card.appendChild(actions);

    $platforms.appendChild(card);
  }
}

async function handleLink(platform) {
  try {
    const resp = await apiFetch(`/streamers/oauth/${platform}/start`, { method: 'POST' });
    if (!resp.ok) {
      toast('error', resp.data?.error || 'Start OAuth selhal');
      return;
    }
    // Redirect current tab to the provider. After callback, browser comes back
    // here and we'll parse the session from URL fragment.
    location.href = resp.data.url;
  } catch (err) {
    toast('error', 'Chyba: ' + err.message);
  }
}

async function handleUnlink(platform) {
  if (!confirm(`Opravdu odpojit ${platform}? Token bude smazán.`)) return;
  try {
    const resp = await apiFetch(`/streamers/me/platforms/${platform}`, { method: 'DELETE' });
    if (resp.ok) {
      toast('success', `Odpojeno: ${platform}`);
      await renderState();
    } else {
      toast('error', resp.data?.error || 'Odpojení selhalo');
    }
  } catch (err) {
    toast('error', 'Chyba: ' + err.message);
  }
}

async function handleLogout() {
  if (!confirm('Odhlásit? Relace bude zrušena.')) return;
  try {
    await apiFetch('/streamers/me/logout', { method: 'POST' });
  } catch {}
  await chromeStorageSet(SESSION_KEY, null);
  sessionId = null;
  toast('success', 'Odhlášeno');
  await renderState();
}

// ---- API helper ---------------------------------------------------------

async function apiFetch(path, init = {}) {
  const headers = { ...(init.headers || {}) };
  if (sessionId) headers['X-UC-Session'] = sessionId;
  const resp = await fetch(API_BASE + path, { ...init, headers });
  let data = null;
  try {
    data = await resp.json();
  } catch {}
  return { ok: resp.ok, status: resp.status, data };
}

// ---- chrome.storage helpers --------------------------------------------

function chromeStorageGet(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (res) => resolve(res[key] ?? null));
  });
}

function chromeStorageSet(key, value) {
  return new Promise((resolve) => {
    if (value === null || value === undefined) {
      chrome.storage.local.remove([key], resolve);
    } else {
      chrome.storage.local.set({ [key]: value }, resolve);
    }
  });
}

// ---- Toast --------------------------------------------------------------

function toast(kind, message) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}
