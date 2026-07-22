# Opera Tab Mode + Stream-Tab Detection Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opera otevírá UnityChat jako tab (ne popup okno), best-effort groupnutý se stream tabem, a chat přestane šedivět, když stream tab není aktivní (split screen).

**Architecture:** Nový helper `_findStreamTab(platform?)` v `sidepanel.js` nahrazuje přímé použití `_getActiveBrowserTab()` v detekci platformy, odesílání a user card — aktivní tab má přednost (dnešní chování), fallback je URL-scan přes všechny taby. V `background.js` Opera path (`!HAS_SIDE_PANEL`) nahrazuje popup okno tabem s `openerTabId` (Opera auto-tab-island best-effort). Chrome side panel i Opera nativní sidebar beze změny.

**Tech Stack:** Chrome Extension MV3 (plain JS, žádný build step), `chrome.tabs` / `chrome.windows` API, UC_LOG instrumentace.

## Global Constraints

- Repo nemá automatizované testy — verifikace = `node --check` (syntax) + manuální test uživatelem v Opeře s UC_LOG dumpy (pravidlo č. 1: fix se pushuje S instrumentací).
- Verze bump v `extension/manifest.json`: `3.38.55` → `3.38.56` (jediný commit, který mění chování).
- Commit na `dev` branch, conventional message, `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Před commitem: `git stash; git pull --rebase origin dev; git stash pop` (dual-session sync). POZOR: ve stash listu jsou 2 staré entry — nepoužívat `git stash pop` naslepo, jen pokud `git stash` právě něco uložil.
- UC_LOG tagy: `StreamTab` (sidepanel), `TabOpen` (background). Cleanup až po user potvrzení.
- Nesahat na: pin flow (lock v3.38.26), Chrome `HAS_SIDE_PANEL` path, `sidebar_action`.

---

### Task 1: `_findStreamTab()` helper + rewire `_detectActivePlatform`

**Files:**
- Modify: `extension/sidepanel.js` (helper vložit za `_getActiveBrowserTab`, tj. za řádek ~3484; `_detectActivePlatform` na řádku ~3486; boot username detect na řádku ~2513)

**Interfaces:**
- Consumes: existující `_getActiveBrowserTab()`, `_detectPlatformFromUrl(url)`, `_parseChannelFromUrl(url, platform)`, `_getConfiguredHandle(platform)`, `this.config[platform]` (enable flagy), `this.activePlatform`
- Produces: `async _findStreamTab(platform = null)` → `Promise<Tab|null>` — vrací tab, do kterého se má PINGovat/posílat. `_streamTabLog(text)` — rate-limited UC_LOG. Task 2 na `_findStreamTab` závisí.

- [ ] **Step 1: Vložit helper za `_getActiveBrowserTab()` (za řádek 3484)**

```js
  // Najít stream tab pro detekci platformy / odesílání zpráv. Aktivní tab má
  // přednost (dosavadní chování). Když aktivní tab není platform stránka —
  // typicky UnityChat otevřený jako tab v Opera split screenu — fallback
  // URL-scan přes všechny taby: bere jen skutečné channel stránky, preferuje
  // nakonfigurovaný kanál a sticky drží naposledy aktivní platformu.
  // platform = omezit na konkrétní platformu (send path), null = libovolná.
  async _findStreamTab(platform = null) {
    const active = await this._getActiveBrowserTab();
    const activeP = active?.url ? this._detectPlatformFromUrl(active.url) : null;
    if (active && activeP && (!platform || activeP === platform)) {
      return active;
    }

    let tabs;
    try { tabs = await chrome.tabs.query({}); } catch { return null; }

    const order = ['twitch', 'kick', 'youtube'];
    let wanted;
    if (platform) {
      wanted = [platform];
    } else if (this.activePlatform && order.includes(this.activePlatform)) {
      wanted = [this.activePlatform, ...order.filter((p) => p !== this.activePlatform)];
    } else {
      wanted = order;
    }

    for (const p of wanted) {
      if (!this.config[p]) continue;
      const candidates = [];
      for (const t of tabs) {
        if (!t.url || t.id == null) continue;
        const handle = this._parseChannelFromUrl(t.url, p);
        let ok = !!handle;
        // YouTube live běží na /watch — _parseChannelFromUrl umí jen @handle
        // stránky, watch stránky přijmout bez handle (content script si poradí).
        if (!ok && p === 'youtube') {
          try {
            const u = new URL(t.url);
            ok = u.hostname.endsWith('youtube.com')
              && (u.pathname === '/watch' || u.pathname.startsWith('/live'));
          } catch {}
        }
        if (ok) candidates.push({ tab: t, handle: handle || null });
      }
      if (!candidates.length) continue;
      const configured = this._getConfiguredHandle(p);
      const match = candidates.find((c) => configured && c.handle === configured)
        || candidates[0];
      this._streamTabLog(`scan hit p=${p} handle=${match.handle || '?'} cfg=${configured || '—'} tabId=${match.tab.id} cand=${candidates.length}`);
      return match.tab;
    }
    this._streamTabLog(`scan miss platform=${platform || 'any'} active=${(active?.url || '—').slice(0, 60)}`);
    return null;
  }

  // Rate-limited StreamTab diagnostic (fallback scan běží ve 3s loopu —
  // stejná zpráva se opakuje max 1× za 15 s).
  _streamTabLog(text) {
    const now = Date.now();
    if (this._streamTabLogPrev === text && now - (this._streamTabLogLast || 0) < 15000) return;
    this._streamTabLogLast = now;
    this._streamTabLogPrev = text;
    chrome.runtime.sendMessage({ type: 'UC_LOG', tag: 'StreamTab', text }).catch(() => {});
  }
```

- [ ] **Step 2: `_detectActivePlatform` (řádek ~3488) — nahradit zdroj tabu**

Z:
```js
      const tab = await this._getActiveBrowserTab();
```
Na:
```js
      const tab = await this._findStreamTab();
```
(zbytek funkce beze změny — PING, inject, auto-switch fungují se scanovaným tabem stejně).

- [ ] **Step 3: Boot username detect (řádek ~2513) — stejná náhrada**

Z:
```js
        const tab = await this._getActiveBrowserTab();
```
Na:
```js
        const tab = await this._findStreamTab();
```

- [ ] **Step 4: Syntax check**

Run: `node --check extension/sidepanel.js`
Expected: žádný výstup (exit 0)

### Task 2: Rewire send path + user card na `_findStreamTab`

**Files:**
- Modify: `extension/sidepanel.js` — `_sendMessage` (řádky ~4284 a ~4340-4341), `_openUserCard` (řádek ~4221)

**Interfaces:**
- Consumes: `_findStreamTab(platform)` z Task 1
- Produces: nic nového — mění se jen zdroj tabu

- [ ] **Step 1: `_sendMessage` send-protection blok (řádek ~4284)**

Z:
```js
      const tab = await this._getActiveBrowserTab();
```
Na:
```js
      const tab = await this._findStreamTab(this.activePlatform);
```

- [ ] **Step 2: `_sendMessage` vlastní send (řádky ~4340-4341)**

Z:
```js
      const tab = await this._getActiveBrowserTab();
      if (!tab) { this._sys('Žádný aktivní tab'); return; }
```
Na:
```js
      const tab = await this._findStreamTab(platform);
      if (!tab) { this._sys(`Nenalezen otevřený stream tab (${platform})`); return; }
```

- [ ] **Step 3: `_openUserCard` (řádek ~4221)**

Z:
```js
      const tab = await this._getActiveBrowserTab();
```
Na:
```js
      const tab = await this._findStreamTab(platform);
```
(`platform` je parametr `_openUserCard(platform, username)`.)

- [ ] **Step 4: Syntax check**

Run: `node --check extension/sidepanel.js`
Expected: žádný výstup (exit 0)

### Task 3: Opera — otevírat tab místo popup okna (`background.js`)

**Files:**
- Modify: `extension/background.js` — else-branch `HAS_SIDE_PANEL` (řádky 33-62), Opera fallback v `TOGGLE_SIDE_PANEL`/`OPEN_SIDE_PANEL` handleru (řádky ~272-279)

**Interfaces:**
- Consumes: `ucLog(tag, ...args)` (definován na řádku ~184, function declaration → hoisted)
- Produces: top-level `async function openUcTab(streamTab)` a `function isPlatformTab(tab)`

- [ ] **Step 1: Nahradit celý else-branch (řádky 33-62 včetně `_ucWindowId` a `windows.onRemoved`)**

Z (celý blok od `} else {` po `}` za `onRemoved` listenerem):
```js
} else {
  // Opera path: the native sidebar is wired via "sidebar_action" in the
  // manifest. The toolbar action falls back to a popup window.
  let _ucWindowId = null;

  chrome.action.onClicked.addListener(async () => {
    ...
  });

  chrome.windows.onRemoved.addListener((windowId) => {
    if (windowId === _ucWindowId) _ucWindowId = null;
  });
}
```
Na:
```js
} else {
  // Opera path: the native sidebar is wired via "sidebar_action" in the
  // manifest. The toolbar action opens UnityChat as a regular tab next to
  // the stream tab (openerTabId → Opera may auto-group them into a tab
  // island). Popup-window mode was replaced in v3.38.56 — a tab works with
  // Opera Split Screen, a popup window does not.
  chrome.action.onClicked.addListener((tab) => {
    openUcTab(tab).catch((e) => ucLog('TabOpen', 'action open failed:', e.message));
  });
}

// Otevřít (nebo fokusnout existující) UnityChat tab. streamTab = tab, vedle
// kterého se má otevřít (openerTabId + index → Opera tab island best-effort).
async function openUcTab(streamTab) {
  const url = chrome.runtime.getURL('sidepanel.html');
  const existing = await chrome.tabs.query({ url });
  if (existing.length) {
    const t = existing[0];
    ucLog('TabOpen', 'focusing existing tab', t.id);
    await chrome.tabs.update(t.id, { active: true });
    if (t.windowId != null) await chrome.windows.update(t.windowId, { focused: true });
    return;
  }
  // Opener: předaný tab pokud je to platform stránka, jinak aktivní tab
  // posledního normal okna, jinak první platform tab v URL-scanu.
  let opener = isPlatformTab(streamTab) ? streamTab : null;
  if (!opener) {
    try {
      const win = await chrome.windows.getLastFocused({ populate: true, windowTypes: ['normal'] });
      const activeTab = win?.tabs?.find((t) => t.active);
      if (isPlatformTab(activeTab)) opener = activeTab;
    } catch {}
  }
  if (!opener) {
    try {
      const all = await chrome.tabs.query({});
      opener = all.find((t) => isPlatformTab(t)) || null;
    } catch {}
  }
  const createProps = { url: 'sidepanel.html', active: true };
  if (opener) {
    createProps.openerTabId = opener.id;
    createProps.index = opener.index + 1;
    createProps.windowId = opener.windowId;
  }
  ucLog('TabOpen', 'creating tab, opener=', opener ? `${opener.id} ${(opener.url || '').slice(0, 50)}` : 'none');
  await chrome.tabs.create(createProps);
}

function isPlatformTab(tab) {
  if (!tab?.url || tab.id == null) return false;
  try {
    const h = new URL(tab.url).hostname;
    return h.includes('twitch.tv') || h.includes('kick.com') || h.includes('youtube.com');
  } catch { return false; }
}
```

- [ ] **Step 2: Opera fallback v message handleru (řádky ~272-279)**

Z:
```js
    // Opera (no sidePanel API) → popup window fallback (no toggle, just open)
    chrome.windows.create({
      url: 'sidepanel.html',
      type: 'popup',
      width: 420,
      height: 720
    }).then(() => sendResponse({ ok: true, action: 'opened' }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
```
Na:
```js
    // Opera (no sidePanel API) → open as a regular tab next to the stream
    // tab (sender.tab = Twitch tab when clicked from the chat header button)
    openUcTab(sender.tab || null)
      .then(() => sendResponse({ ok: true, action: 'opened' }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
```
(`return true;` za blokem zůstává.)

POZOR: nesahat na `chrome.windows.create` na řádku ~725 (Kick user card popup) — ten s tímhle nesouvisí.

- [ ] **Step 3: Syntax check**

Run: `node --check extension/background.js`
Expected: žádný výstup (exit 0)

### Task 4: Version bump + docs + commit/push

**Files:**
- Modify: `extension/manifest.json` (`"version": "3.38.55"` → `"3.38.56"`)
- Modify: `CLAUDE.md` (milestone v3.38.56 + přepsat "Aktuální verze (dev)" marker z v3.38.55; aktualizovat "Aktuální: v3.37.3" v sekci Verzování pokud tam stále je)
- Modify: `CLAUDE-HISTORY.md` (záznam do "Changelog dokumentace")

**Interfaces:** n/a

- [ ] **Step 1: Bump `extension/manifest.json` version na `3.38.56`**

- [ ] **Step 2: CLAUDE.md milestone**

Přidat za v3.38.55 řádek (a z v3.38.55 odstranit "**Aktuální verze (dev)**"):
```md
- **v3.38.56** - **Opera tab mode + stream-tab URL-scan fix**: (1) Opera toolbar/chat-header klik otevírá UnityChat jako regular tab (openerTabId + index vedle stream tabu → Opera tab island best-effort; existující UC tab se fokusne, žádné duplicity) místo popup okna. (2) `_findStreamTab(platform?)` — aktivní tab má přednost, fallback URL-scan přes všechny taby (jen channel stránky, preferuje nakonfigurovaný kanál, sticky drží poslední aktivní platformu; YouTube přijímá i /watch). Nahrazuje `_getActiveBrowserTab()` v `_detectActivePlatform`, `_sendMessage`, `_openUserCard` + boot username detect → chat v Opera split screenu už nešediví, když je aktivní UnityChat tab. Split poměr = ruční divider (Opera nemá split API), `chrome.tabGroups` v Opeře neexistuje. UC_LOG tagy `StreamTab` + `TabOpen` (cleanup po user verifikaci). **Aktuální verze (dev)**
```

- [ ] **Step 3: CLAUDE-HISTORY.md changelog dokumentace**

Přidat řádek (formát dle existujících záznamů, datum 2026-07-22): spec + plan pro Opera tab mode uloženy do `docs/superpowers/`, milestone v3.38.56 zapsán.

- [ ] **Step 4: Sync + commit + push**

```bash
cd "/d/_BACKUP_2.0/Code Projects/UnityChat"
git pull --rebase origin dev
git add extension/background.js extension/sidepanel.js extension/manifest.json CLAUDE.md CLAUDE-HISTORY.md docs/superpowers/plans/2026-07-22-opera-tab-mode.md
git commit -m "feat(extension): Opera tab mode + stream-tab URL-scan fix (v3.38.56)

Opera otevírá UnityChat jako tab vedle stream tabu (openerTabId → tab
island best-effort) místo popup okna. _findStreamTab() fallback URL-scan
přes všechny taby řeší zašednutí chatu v split screenu — detekce ani send
už nezávisí na tom, že je stream tab aktivní. UC_LOG: StreamTab, TabOpen.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push origin dev
```
Expected: push OK na `origin/dev`.

- [ ] **Step 5: Manuální verifikace uživatelem (Opera)**

Požádat uživatele: reload extensionu v Opeře → klik na toolbar ikonu → UnityChat se otevře jako tab (ideálně v islandu se stream tabem) → nastavit split screen → kliknout do chat tabu → input NEsmí zašednout, odeslání zprávy musí projít. Při problému: 💾 dump → `Downloads/unitychat-debug.txt`, filtrovat `[StreamTab]` a `[TabOpen]`.
