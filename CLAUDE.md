# UnityChat - Chrome Extension + Backend v3.40.22

> **Infra & deploy runbook**: see `SERVER.md` (local-only, in `.gitignore`) for Hetzner VPS details, Coolify operations, jouki.cz DNS, GitHub deploy key, login credentials, common tasks, and gotchas. Start there if you need to touch anything on the live server. If `SERVER.md` is missing on a fresh clone, ask the user for it or reconstruct from memory.

## Popis projektu
Monorepo s browser extensionem (Manifest V3) sjednocující live chat z **Twitch**, **YouTube** a **Kick** do jednoho panelu, plus backend API pro cross-platform user database, message log a stream events. Inspirováno Truffle extension. Primárně vyvíjeno pro streamera **robdiesalot**.

## Struktura projektu
```
UnityChat/
├── extension/               # Jednotný zdroj pro Chrome i Operu (no build step)
│   ├── manifest.json           # Unified MV3 manifest (sidePanel perm + side_panel key)
│   ├── background.js           # Service worker s runtime feature-detection
│   ├── sidepanel.html          # UI
│   ├── sidepanel.css           # Dark theme styling
│   ├── sidepanel.js            # ~6500 řádků - UI/messaging logika (klasický skript, defer)
│   ├── core-bridge.js          # module script: importuje core/ a vystaví window.UC_CORE
│   ├── core/                   # SDÍLENÝ CORE s webovou verzí — ES moduly bez chrome.*/DOM (v3.39.17–21)
│   │   ├── chat-store.js       #   ChatStore (data zpráv, řazení, dedup)
│   │   ├── colors.js           #   twitchDefaultColor, readableColor, ytNameColor, isTwitchOgFaceName
│   │   ├── html.js             #   escapeHtml/Attr, decodeEntities, stripTags, tagAttrs (Kick HTML bez DOM)
│   │   ├── log.js              #   makeLog — injektované logování (addon → UC_LOG, web → console/overlay)
│   │   ├── twitch-irc.js       #   TwitchProvider (anonymní IRC), WebSocket injektovatelný
│   │   ├── kick.js             #   KickProvider (Pusher), fetch + WebSocket injektovatelné
│   │   └── emotes.js           #   EmoteManager (7TV/BTTV/FFZ/Twitch/Kick/UC, render segmentů, autocomplete)
│   ├── audio/
│   │   └── streamelements-bulgarians.mp3  # Easter egg audio
│   ├── content/
│   │   ├── twitch.js           # Twitch DOM (Slate editor) + send + reply
│   │   ├── youtube.js          # YouTube live_chat iframe + API fallback
│   │   └── kick.js             # Kick DOM + API fallback
│   └── icons/                  # 16/48/128 PNG (oranžový gradient logo)
│       └── platform/           # twitch/youtube/kick.svg badge loga + *-gold.svg pro UC uživatele
# landing/ — POZOR: web jouki.cz je v SAMOSTATNÉM privátním repu github.com/jouki/jouki.cz
#            (ne tady). Viz sekce "Landing page" níže. Tento repo dává jen extension/.
├── backend/                 # Node.js + Fastify + Drizzle + Postgres API server
│   ├── src/
│   │   ├── server.ts           # Fastify entry point + health endpoints
│   │   ├── config.ts           # Zod env validation
│   │   ├── routes/
│   │   │   └── users.ts        # /users endpoints (merged seen_users + nicknames)
│   │   └── db/
│   │       ├── index.ts        # Drizzle client + pingDb
│   │       └── schema.ts       # users, platform_identities, messages, events, seen_users
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile              # Multi-stage Node 22 alpine, user 'app', healthcheck
│   ├── drizzle.config.ts
│   ├── .env.example
│   └── README.md
├── logo-designer.html       # Standalone tool pro design ikon (orange gradient)
└── CLAUDE.md                # Tato dokumentace
```

### Kompatibilita Chrome + Opera (runtime feature detection)

Jeden unified `extension/` loader, žádný build step. V `background.js` je feature-detection konstanta:

```js
const HAS_SIDE_PANEL = typeof chrome.sidePanel !== 'undefined'
  && typeof chrome.sidePanel.setPanelBehavior === 'function';
```

**Od v3.38.67 je manifest čistě Chrome** (`side_panel`, bez `sidebar_action`) — `extension/` je přesně to, co jde do Chrome Web Store, žádná dev-only vrstva. V Opeře se UnityChat otevírá jako tab (toolbar action → `openUcTab`), nativní Opera sidebar nemá (rozhodnutí usera 2026-09-19: „nativní sidebar v Opeře stejně nikdo nevyužije"). Opera store release dostane případně vlastní manifest.

| | Chrome | Opera |
|---|---|---|
| `chrome.sidePanel` API | ✅ dostupné | ❌ undefined |
| `HAS_SIDE_PANEL` | `true` | `false` |
| UI entry | native side panel přes `setPanelBehavior({ openPanelOnActionClick: true })` | toolbar action → UnityChat jako regular tab vedle stream tabu (`openUcTab`, v3.38.56) |
| Manifest `sidePanel` permission | aktivní | Opera (Chromium-based) přijímá syntakticky, ale API nepoužívá |
| Manifest `side_panel` key | Chrome load | Opera ignoruje |

Side panel JS používá `_getActiveBrowserTab()` který volá `chrome.windows.getLastFocused({ windowTypes: ['normal'] })` - funguje pro všechny scénáře (Chrome side panel, Opera sidebar, Opera popup).

## Dev workflow

Žádný build není potřeba. Unified `extension/` složku načti v obou browserech:

**Chrome:**
1. `chrome://extensions` → Developer mode ON
2. Load unpacked → vyber `D:\...\UnityChat\extension\`
3. Po každé změně klikni reload 🔄 u extensionu

**Opera:**
1. `opera://extensions` → Developer mode ON
2. Load unpacked → vyber `D:\...\UnityChat\extension\`
3. Po každé změně klikni reload 🔄 u extensionu

Verzi bumpni v `extension/manifest.json` (jediný soubor teď). Distribuční ZIPy pro store upload pokud někdy bude potřeba — stačí zipnout celou `extension/` složku.

## Architektura sidepanel.js

### Konstanty
- `UC_MARKER = '\u2800'` — Braille Pattern Blank, marker UnityChat zpráv. Přidává se jako `text + ' ' + marker` (NE na commandy `!` `/`). Detekuje se v jiných instancích → oranžový platform badge.
- `DEFAULTS` — config: `channel`, `ytChannel`, `username`, `layout: 'small'`, `twitch/youtube/kick: true`, `maxMessages: 500`

### EmoteManager
6 zdrojů emotes + segment-based rendering:

| Map | Zdroj | Kdy se načítá |
|---|---|---|
| `global7tv` | 7TV global | startup, `7tv.io/v3/emote-sets/global` |
| `channel7tv` | 7TV channel | po room-id, `7tv.io/v3/users/{platform}/{userId}` |
| `bttvEmotes` | BTTV global+channel | po room-id, `api.betterttv.net/3/cached/...` |
| `ffzEmotes` | FFZ global+channel | po room-id, `api.frankerfacez.com/v1/...` |
| `twitchNative` | Twitch IRC emotes | naučené z `emotes` IRC tagu |
| `kickNative` | Kick emotes | naučené z `[emote:ID:NAME]` v Kick HTML |

**CDN URL formáty:**
- 7TV: `cdn.7tv.app/emote/{id}/1x.webp`
- BTTV: `cdn.betterttv.net/emote/{id}/1x`
- FFZ: `cdn.frankerfacez.com/emote/{id}/1`
- Twitch: `static-cdn.jtvnw.net/emoticons/v2/{id}/default/dark/1.0`
- Kick: `files.kick.com/emotes/{id}/fullsize`

**Rendering pipeline:**
1. Provider parser → segmenty `[{ type: 'text'|'emote', value, url? }]`
   - `_splitTwitchEmotes()` - z IRC `emotes` pozic
   - `_parseKickHtml()` - `[emote:ID:NAME]` + HTML `<img>`
   - `renderYouTube()` - YouTube `runs[]` (text + emoji thumbnaily)
2. `renderSegments()` - text segmenty se prohledávají proti 7TV/BTTV/FFZ
3. `_toHtml()` - segmenty → HTML s `<img class="emote">`

**Tab autocomplete (`findCompletions`):**
- Pořadí: channel 7TV → global 7TV → BTTV → FFZ → Twitch native → Kick native
- Sort: exact case match → abecedně
- Min 1 znak prefix
- Vrací všechny matche (žádný cap)

### TwitchProvider
Anonymní IRC WebSocket: `wss://irc-ws.chat.twitch.tv:443`

- Login: `justinfan{random}` (read-only)
- CAP REQ: `twitch.tv/tags twitch.tv/commands`
- Parsuje IRC tagy: `display-name`, `color`, `badges`, `emotes`, `room-id`, `reply-parent-*`, `first-msg`, `id`
- `room-id` z ROOMSTATE → trigger pro načtení 7TV/BTTV/FFZ kanálových emotes + Twitch badge images
- USERNOTICE handler pro `msg-id=raid` → emit raid zprávy
- `first-msg=1` → first chatter highlight
- Reply tagy: `reply-parent-display-name`, `reply-parent-msg-body`, `reply-parent-msg-id`
- Reply zprávy: stripuje `@username` prefix z message textu (Twitch ho přidává automaticky)
- IRC tag value unescaping: `\s`→space, `\n`→space, `\r`→remove, `\:`→`;`, `\\`→`\`
- Auto-reconnect 5s, PING/PONG keep-alive

### KickProvider
Dvoustupňové připojení:
1. `GET kick.com/api/v2/channels/{channel}` → `chatroom.id`, `user_id`
2. Pusher WebSocket: `wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679`
3. Subscribe: `chatrooms.{chatroomId}.v2`, event: `App\Events\ChatMessageEvent`

- `user_id` → 7TV channel emotes (fallback pokud Twitch ještě nenačetl)
- Content field: plain text, HTML s `<img>`, nebo `[emote:ID:NAME]` tagy
- Ping 30s, auto-reconnect 5s

### YouTubeProvider
Dual polling - interní API + page refresh fallback.

**Připojení:**
1. Fetch `/{channel}/live` → najít `videoId` + ověřit `isLive:true`
2. Fetch `/live_chat?v={videoId}` → parsovat `ytInitialData`
3. **Brace counting** pro extrakci JSON (NE regex `{.+?}` - selže na vnořeném)
4. Z HTML extrahovat: `INNERTUBE_API_KEY`, `clientVersion`, `visitorData`, `continuation`
5. Continuation preference: `timedContinuationData` > `reloadContinuationData` > `invalidationContinuationData`

**Polling režimy:**
1. **API polling** (primární): `POST /youtubei/v1/live_chat/get_live_chat`
   - Headers: `X-YouTube-Client-Name: 1`, `X-YouTube-Client-Version`
   - AbortController timeout 15s
   - `_apiFails` counter → po 3-5 prázdných odpovědích přepne na page refresh
2. **Page refresh** (fallback): re-fetch `/live_chat` stránky každých 6s

**`_seen` set** - dedup IDs zpráv (max 5000 → ořezává na 2500). **NEMAZAT** při disconnectu (jinak duplikace při reconnectu).

### UnityChat (hlavní třída)
UI, messaging, autocomplete, replies, cache, dedup, scroll, pin.

**Konfigurace** (`chrome.storage.sync`, klíč `uc_config`):
```json
{
  "channel": "robdiesalot",
  "ytChannel": "robdiesalot",
  "username": "Jouki728",
  "twitch": true, "youtube": true, "kick": true,
  "maxMessages": 500,
  "layout": "small",
  "_roomId": "160028137"
}
```

**Verze v titulku:** `<img logo> UnityChat v{version} [BETA]`

**Layout sizes** (3 velikosti):
- `layout-small` (default 13px font)
- `layout-medium` (14px, větší padding/badges/emotes)
- `layout-large` (16px, ještě větší + 14px input)

**Auto-detekce username:**
- Před cache renderem: ping aktivního tabu
- Twitch: `document.cookie.match('login=...')` 
- Kick: navbar profile selectory
- YouTube: `yt-formatted-string#channel-handle` + avatar menu click fallback (v3.23.4–v3.23.6): klikne avatar button, přečte `#channel-handle`, zavře menu přes Escape
- Content script cache: výsledek se kešuje per URL, `MutationObserver` + `popstate` invalidují při SPA navigaci
- Settings UI se refreshne když platform username dorazí asynchronně

**Historie a data zpráv (v3.39+):**
- `ChatStore` (`extension/core/chat-store.js`, ES modul přes `core-bridge.js`) — jediný držitel zpráv, řazení `timestamp ASC, id`; dedup jen `platform:id`
- Boot: `GET /chat/history?channel&limit=100` → každá zpráva přes `_addMessage` (dedup ve store, render, sběr barev/jmen) → scroll dolů
- Scroll nahoru: nejdřív zaparkované uzly (`_parkedTop`), pak `before=<cursor>` po 100 (`_extendUp`); DOM nad 300 uzlů se ořezává do parku (`_unloadTop/_unloadBottom`), „N nových" = `_jumpToLatest`
- Timestamp = čas platformy (`tmi-sent-ts`, `created_at`, `timestampUsec`); optimistická zpráva má `Date.now()` do echa (`_optimisticKeys` → `store.upgrade`)
- Žádná lokální cache, žádný DOM scrape, žádný import z Twitch tabu — historii dává server (backend `ingest/`); staré klíče `uc_messages_*` se při startu smažou

**@Mention zvýraznění:**
- Kontroluje `msg.message.includes('@' + username)` (case insensitive)
- + `msg.replyTo?.username === username`
- CSS: `.msg.mentioned` - červený border-left + tmavě červené pozadí
- Hover: tmavší red

**First-time chatter:**
- Tag `first-msg=1` z IRC
- CSS: `.msg.first-msg` - fialový (Twitch purple) border + label "PRVNÍ ZPRÁVA"

**Raid notification:**
- USERNOTICE `msg-id=raid` → zpráva s `isRaid=true`
- Parsuje `msg-param-displayName`, `msg-param-viewerCount`
- CSS: `.msg.raid` - červený border + label "RAID"

**Reply context (Twitch):**
- IRC tagy `reply-parent-*`
- UI: `↩ @Username text...` nad zprávou
- **Klikatelný** → `_scrollToMessage(msg.replyTo.id)` smooth scroll na původní zprávu + 2s flash animace (oranžová)
- Reply text má stripnutý `@username` prefix

**Native Twitch reply (GQL):**
- Klik na hover ↩ tlačítko → `_setReply(platform, username, messageId)`
- Při sendMessage: pokud reply na stejné platformě → `REPLY_CHAT` do background → GQL mutace `SendChatMessage` s `replyParentMessageID`
- Cross-platform reply → fallback na `@username` text prefix

**UC Badge (UnityChat user identification):**
- Odeslaná zpráva: `text + ' ' + UC_MARKER` (Braille blank na konci)
- Přijatá: `msg.message.includes(UC_MARKER)` → oranžový platform badge (`.pi.uc` - gradient žlutá → oranžová)
- Commandy (`!`, `/`): marker se NEpřidává (rozbilo by boty)
- Marker se stripuje z displeje
- Glow: `box-shadow: 0 0 6px rgba(255,140,0,0.5)`

**Auto-username detection z UC zpráv:**
- Při send: `_lastSentText = text`
- Při příjmu UC zprávy: pokud msg.message obsahuje `_lastSentText` → uložit `msg.username` jako `config.username`

**Hover akce na zprávách:**
- `.msg-actions` - absolutně pozicovaný div v pravém horním rohu
- Pin button (📌 SVG) - jen Twitch zprávy
- Reply button (↩)

**Emote autocomplete (suggest list):**
- Tab/Shift+Tab - cyklování
- ↓/↑ - alternativní cyklování
- → - potvrdit a zavřít
- Esc - zrušit
- Modifier klávesy (Shift/Ctrl/Alt/Meta) NERUŠÍ suggest list
- Okno 4 viditelných položek, scroll oknem
- Inner span `.es-name-inner` + JS detekce overflow → CSS `--scroll-dist` variable + class `.overflowing`
- Animace běží **jen pro `.selected.overflowing`**, ne na hover
- Klik na položku → výběr
- Po výběru: vloží emote + mezeru, kurzor za mezerou
- Autocomplete pro `@username` (sbírá usernames z příchozích zpráv) - barevná tečka místo emote obrázku

**Pinned message banner:**
- Po pinnutí (klik na 📌 hover button) - GQL mutace `PinChatMessage` (5min default)
- Banner nahoře nad chatem - oranžový gradient pozadí + glow + border
- Obsah: pin ikona + "PŘIPNUTO" + čas + username + text s emoty
- × tlačítko + Esc pro zavření
- Polling každé 2s přes background `CHECK_PIN` (GQL `channel.pinnedChatMessages`)
- Po 8s delay first poll, vyžaduje 3 konzistentní "not pinned" před skrytím
- Pin entity ID z mutation response (singulární `pinnedMessage.id` neexistuje, query se dělá jako follow-up `pinnedChatMessages` after mutation)

**User Card:**
- Klik na username → `_openUserCard(platform, username)`
- Background `OPEN_USER_CARD` → `executeScript({ world: 'MAIN' })`
- Strategie:
  1. `[data-a-user]` element → klik na text-matching span uvnitř (nativní Twitch user card)
  2. Text search v `[class*="seventv"], [class*="chat-line"]` - klik na 7TV username (nativní 7TV card)
  3. Fallback: floating card s GQL daty (avatar, displayName, createdAt, followedAt, role)
- Floating card je draggable (mousedown na header, mousemove pro pozici)
- Esc zavírá

**New messages detection + auto-scroll:**
- `_unreadCount` - počet nových zpráv při scrolled-up stavu
- První nová zpráva při scroll up → vloží se `.unread-sep` separator
- Scroll button "↓ N nových zpráv" se zobrazí jen když `_unreadCount > 0`
- Klik na button → smooth scroll na konec + clear unread
- Auto-scroll PAUSE když uživatel scrolluje nahoru (atBottom < 60px threshold)

## Content scripty

### content/twitch.js
**Send chat:**
1. `findInput()` selektory: `[data-a-target="chat-input"] [contenteditable="true"]`, textarea fallback
2. Slate editor: DataTransfer paste primary → InputEvent beforeinput → execCommand fallback
3. Send button: `[data-a-target="chat-send-button"]`, Enter fallback

**Reply:** delegováno na background přes `TW_REPLY` (potřebuje GQL)

### content/youtube.js
**Send chat - 3 strategie:**
1. **Live chat iframe** (`isLiveChat`): přímý DOM, `execCommand('insertText')`
2. **Main frame s iframe** (`#chatframe`): `frame.contentDocument` → DOM access
3. **Chat zavřený**: `chrome.runtime.sendMessage({ type: 'YT_SEND' })` → background `executeScript world:MAIN` → fetch `/live_chat?v=` pro params → `POST /youtubei/v1/live_chat/send_message`

### content/kick.js
1. **DOM** (chat otevřený): `#message-input`, React setter / execCommand
2. **Kick API** (chat zavřený): `KICK_SEND` message do background → `chrome.scripting.executeScript({ world: 'MAIN' })` → `POST /api/v2/messages/send/{chatroomId}` s XSRF-TOKEN z cookies (v3.23.7: migrace z inline `<script>` injection na background executeScript)

### content script auto-injection
- `background.js` `chrome.runtime.onInstalled` → injektuje do otevřených tabů
- `sidepanel.js` `_injectContentScript(tab)` → on-demand injection pokud PING neodpoví
- Wrapper `if (window._ucXxx) return;` proti duplicitní inicializaci
- Uživatel NEMUSÍ refreshovat stránku po update

## background.js

**Service worker handlers:**
- `chrome.runtime.onInstalled` → auto-inject content scriptů
- `OPEN_USER_CARD` → executeScript MAIN world (klikání na DOM, CSS.escape pro username selektory)
- `TW_REPLY` → GQL mutace `SendChatMessage` s reply ID (parameterized variables)
- `YT_SEND` → executeScript MAIN world (CSP bypass pro YouTube)
- `KICK_SEND` → executeScript MAIN world (Kick API send, v3.23.7 migrace z inline script injection)
- `LOAD_BADGES` → IVR API fetch (Twitch badge images)
- `PIN_MESSAGE` → GQL mutace `PinChatMessage` + follow-up dotaz pro pin entity ID (parameterized variables)
- `CHECK_PIN` → GQL `channel.pinnedChatMessages` polling (parameterized variables)
- `DUMP_LOGS` → uloží `_logs` array do `Downloads/unitychat-debug.log` přes `chrome.downloads`
- `UC_LOG` → relay log zpráva ze side panelu

**Security (v3.23.7):**
- Všechny GQL queries používají parameterized variables (ne string interpolation)
- Floating user card v MAIN world: createElement/textContent místo innerHTML
- YouTube postMessage: specifický origin `'https://www.youtube.com'` místo wildcard `'*'`, origin validace na receiveru
- Color values sanitizovány přes `_sc()` před HTML interpolací
- UC_API endpoint: `https://api.jouki.cz` (dříve raw IP `http://178.104.160.182:3001`)
- `http://178.104.160.182:*` odstraněno z manifest host_permissions

**ucLog systém:**
- In-memory `_logs[]` array (max 500 → ořezává na 300)
- Side panel posílá `UC_LOG` zprávy
- `dumpLogs()` exportuje do `unitychat-debug.log` přes data URL + `chrome.downloads.download`

## Permissions
- `storage` - config (sync) + message cache (local) + room-id
- `tabs` - detekce aktivního tabu
- `scripting` - auto-injection + executeScript MAIN world
- `cookies` - Twitch auth-token (HttpOnly) → GQL mutations
- `downloads` - export debug logu
- `sidePanel` - **jen Chrome verze**

## Host Permissions
```
kick.com, www.youtube.com, youtube.com, twitch.tv, www.twitch.tv  # platformy
wss://irc-ws.chat.twitch.tv                                       # Twitch IRC
api.twitch.tv, gql.twitch.tv                                      # Twitch GQL/Helix
badges.twitch.tv (deprecated, fallback IVR)                       # Badge API
api.ivr.fi                                                         # Twitch badge images (veřejné API)
api.jouki.cz                                                       # UnityChat backend API (v3.23.7+)
7tv.io, cdn.7tv.app                                               # 7TV API + CDN
static-cdn.jtvnw.net                                              # Twitch emote CDN
files.kick.com                                                    # Kick emote CDN
api.betterttv.net, cdn.betterttv.net                              # BTTV
api.frankerfacez.com, cdn.frankerfacez.com                        # FFZ
```

## Verzování
- Verze v `extension/manifest.json` → titulek side panelu (`chrome.runtime.getManifest().version`)
- Bumpovat jediný manifest při release
- Aktuální: **v3.40.22** (dev i master; release PR #27 2026-09-24)

## Chrome Web Store (v3.38.58+)

> **✅ PUBLIKOVÁNO 18. 9. 2026** — review prošla za 2 dny. Položka je veřejná
> a vyhledatelná: https://chromewebstore.google.com/detail/unitychat/picaeipbmkgcippknkpkbnbgjlkblbnp
> Item ID `picaeipbmkgcippknkpkbnbgjlkblbnp`, jazyk CS. Publikovaná 3.38.62;
> **3.39.50 odeslána ke kontrole 2026-09-23** (PR #23).
>
> ⚠️ **Nové oprávnění = dashboard napřed.** Automatický `cws-release.yml` nahrál
> 3.39.50 v pořádku, ale `:publish` skončil `HTTP 400 INVALID_ITEM_METADATA`,
> protože verze přidala permission `identity` bez vyplněného zdůvodnění
> v Developer Dashboardu (Privacy practices). Po doplnění textu z
> `store/listing/permissions-justification.md` (sekce `identity`) a ručním
> spuštění `gh workflow run cws-release.yml --ref master -f force=true`
> odeslání prošlo. **Při každém dalším novém oprávnění stejný postup.**
>
> **Když čeká starší verze na review a chceš poslat novější:**
> `gh workflow run cws-release.yml --ref master -f cancel_pending=true -f force=true`
> (ručně: `node scripts/cws.mjs cancel`, pak `release <zip>`). Zrušení je
> vratné jen novým odesláním, proto nikdy automaticky při pushi.
> Podklady pro dashboard: `store/listing/README.md`; **kompletní záznam všeho,
> co je v dashboardu zadané (texty, oprávnění, data-use checkboxy, prohlášení):
> `store/listing/dashboard-state.md`** — při každé změně v dashboardu aktualizovat.
>
> Další verze se nahrává přes „Package → Upload new package" a jde znovu přes
> review; **bumpnout `extension/manifest.json`**, store nepřijme stejnou nebo
> nižší verzi.

**Od v3.38.67 je `extension/` přímo store verze.** Dřívější dvouvrstvý model
(dev zdroj + stripovaný store derivát přes `UC_STORE_STRIP` markery) je zrušený
na explicitní pokyn usera 2026-09-19: „chci udržovat jen jednu verzi a to
takovou, kterou můžeme poslat do storu". Odstraněno ze zdroje:

| Pryč | Proč |
|---|---|
| `_checkForUpdate()`, background update alarm, update dot + tooltip | CWS zakazuje out-of-store update; store se aktualizuje sám |
| `update.bat` | spustitelný updater |
| `streamer.html/js/css` + tlačítko „Jsem streamer" | streamer OAuth se nepouští (git history ho má, commit před 3.38.67) |
| `backup.html/js` | z UI nedosažitelné |
| `sidebar_action` (manifest) | Opera klíč; Opera bere tab mode |
| `alarms` permission | používal ho jen update poll |

Auto-switch přes `/streamers/lookup` **zůstává** — čtení veřejného directory.
Debug dump (💾, `downloads`) a audio easter egg zůstávají také.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-store.ps1   # balíček
powershell -ExecutionPolicy Bypass -File scripts\build-promo.ps1   # ikona, dlaždice, screenshot
```
→ `store/build/unpacked/` (kopie `extension/`) + `store/build/unitychat-store-vX.Y.Z.zip`

`build-store.ps1` už nic nestříhá — jen kopíruje, ověřuje (manifest parsuje,
`node --check` na každém skriptu, žádný `jouki.cz/download` / `update.bat` /
`UC_STORE_STRIP` / `sidebar_action`, žádný z odstraněných souborů) a zipuje.
**Nový kód, který by porušoval CWS policy, se nepíše vůbec** — není kam ho
schovat.

`build-promo.ps1` renderuje headless Chromem z `store/listing/assets/`:
`icon.html` → ikona 128×128 (průhledná, 96×96 kresba + glow), `promo.html`
→ dlaždice 440×280 a 1400×560, `screenshot.html` → snímek 1280×800.
Sdílené pozadí je v `brand.css`, logo ve vektoru `logo.svg`.

⚠️ Snímek obrazovky skládá `panel-mock.png` = render `preview.html`
z jouki.cz, který načítá **skutečné** `extension/sidepanel.css`. Po větší
změně toho CSS je potřeba mock přerenderovat, jinak screenshot ve store
ukazuje UI, které addon nemá. Jednou se to už stalo (mockup přidával
dvojtečku za jméno navíc k té z `.un::after`, opraveno 2026-09-15).

Texty pro Developer Dashboard (single purpose, permission justifikace, data
disclosure, listing CS/EN, assety) žijí v `store/listing/` — **tracked**,
`store/build/` je v `.gitignore`.

Navazující cíle (Firefox / Opera store / mobil) jsou v `store/listing/README.md`.

### Firefox (testovací build, v3.40.8+)

Kód zůstává jeden (`extension/`), pro Firefox se mění jen manifest: `node scripts/build-firefox.mjs`
→ `store/build/firefox/unpacked/` (about:debugging → „Načíst dočasný doplněk“ → `manifest.json`)
+ `unitychat-firefox-vX.Y.Z.xpi`. Převod (`toFirefoxManifest`, test `scripts/test-firefox-manifest.mjs`):
`background.scripts` místo service workeru, **postranní lišta `sidebar_action`** (rozhodnutí usera
2026-09-23) místo `side_panel`, bez `sidePanel` oprávnění, ID `unitychat@jouki.cz`, min. Firefox 128
(`scripting` world MAIN). `background.js`: `FF_SIDEBAR` → tlačítko v liště = `sidebarAction.toggle()`,
tlačítko v chatu Twitche = `open()` s fallbackem na záložku (zpráva z content scriptu nemusí nést
gesto uživatele). Přihlášení: Firefox vrací `https://<40 hex>.extensions.allizom.org/` — povoleno
v `isAllowedReturnTo`. `web-ext lint`: 0 chyb; na AMO bude potřeba `data_collection_permissions`
a projít 27 varování `innerHTML`. **v3.40.18 odeslána na AMO 2026-09-23** (veřejně, jen desktop; podklady `store/listing/amo.md`, zásady `amo-privacy-en.txt`). Od 2026-09-24 nahrává každou novou verzi po merge do master workflow `amo-release.yml` (`web-ext sign --channel listed`, secrets `AMO_JWT_ISSUER`/`AMO_JWT_SECRET`); 3.40.22 prošla.

## Známé limitace / gotchas

**Twitch:**
- Zero-width Unicode (U+200B, U+200C, TAG chars) Twitch stripuje → UC marker je Braille blank (U+2800)
- UC marker NEpřidávat na commandy (`!`, `/`) - rozbilo by to boty
- Twitch native emoty se učí z chatu (ne pre-loaded) - Kappa apod. se objeví v autocomplete až po prvním použití někým
- BTTV+FFZ jen pro Twitch kanál (ne Kick/YouTube)
- 7TV completely replaces chat DOM (zero `[data-a-user]` elements with 7TV)
- 7TV používá Vue.js s custom elements (`<seventv-container>`) - **klikání na 7TV elementy z executeScript NEFUNGUJE** (Vue handlery ignorují synthetic clicks)
- User card pro nedávno chatující funguje (text search v 7TV chat DOM), pro starší uživatele jen floating GQL card

**YouTube:**
- Interní API nestabilní, může se kdykoliv změnit
- `invalidationContinuationData` vyžaduje push notifikace (nefunguje s HTTP polling)
- Stream musí být live (ne replay/premiere)
- Polling latency 2-6s
- `auth-token` cookie je HttpOnly (`document.cookie` to nevidí v MAIN world) → background musí použít `chrome.cookies.get`
- Helix API nefunguje s `auth-token` cookie (vyžaduje OAuth flow token) → použít GQL endpoint
- GQL field names časem mění (`PinChatMessagePayload.pinnedMessage` neexistuje, používá se follow-up query)

**Pin:**
- Twitch UI: 30s/1m/2m/5m/10m/30m/1h + custom + "do konce streamu"
- GQL enum cap je `PIN_DURATION_ONE_HOUR`
- Pro neomezené trvání: pinnout na 1h + spoléhat na polling pro detekci unpinu
- Polling porovnává **pin entity ID** (z `pinnedChatMessages.edges.node.id`), NE původní message ID
- Banner skryje až po **3 konzistentních "not pinned"** odpovědích (proti false positives)

**Cache + dedup:**
- `_seenMsgIds` pro ID-based dedup
- `_seenContentKeys` pro párování optimistické zprávy s IRC echem
- YouTube `_seen` set NEMAZAT při disconnect (jinak duplikace na reconnect)

**Aktivní tab detekce (Chrome side panel + Opera popup):**
- `chrome.tabs.query({ currentWindow: true })` v Opera popup vrací tab v popup okně, ne v hlavním
- Použít `chrome.windows.getLastFocused({ windowTypes: ['normal'] })` → najít active tab tam
- Helper `_getActiveBrowserTab()` v UnityChat třídě

**Debug log:**
- 💾 button v headeru pro ad-hoc dump
- Soubor: `Downloads/unitychat-debug.log`
- Side panel posílá `UC_LOG` do background, background drží `_logs[]` array
- Read přes `Read tool` při debugování

## Twitch chat header button (v3.12.5)
Content script `content/twitch.js` injektuje tlačítko do Twitch chat headeru (vedle collapse toggle). Tlačítko používá `chrome.runtime.getURL('icons/icon48.png')` (reálné extension logo). Klik pošle `OPEN_SIDE_PANEL` do background → `chrome.sidePanel.open({ tabId })` (Chrome) nebo popup window (Opera).

**Klíčové detaily:**
- `web_accessible_resources` v manifestu zpřístupňuje `icons/*` pro Twitch stránky
- `chrome.sidePanel.open()` musí být volán synchronně v rámci user gesture chain — žádné awaity před voláním v background handleru
- `MutationObserver` na `document.body` re-injektuje button po Twitch chat remountech (změna kanálu, 7TV rerender)
- Selektory pro chat header: `.stream-chat-header`, `[data-a-target="stream-chat-header"]`, `.chat-room__header`, `.chat-shell__header`, `.chat-header` + fallback přes parent collapse toggle buttonu

## Web verze (robdiesalot.com) — privátní repo `jouki/UnityChat-web`

> Rozhodnuto 2026-09-21. Web verze UnityChatu **není v tomto repu**. Žije
> v privátním repu `jouki/UnityChat-web`, které je **mirror kopie tohoto repa
> + složka `web/`** (Vite + vanilla JS). Upstream = tento repo; GitHub Action
> tam každých 15 min merguje `dev → main`. Lokální klon: `D:\_BACKUP_2.0\Code Projects\UnityChat-web`.

**Pravidla, která platí tady:**
- **Sdílený kód se mění jen v tomto repu**: `extension/`, `extension/core/`
  (ES moduly bez `chrome.*`/DOM, sdílené s webem), `backend/` (včetně
  endpointů pro web: `/chat/stream` SSE, `/auth/*`, `/chat/send`). V privátním
  repu se sdílené soubory needitují — merge by konfliktoval.
- **Pravidlo portování (user 2026-09-21):** obecná funkcionalita implementovaná
  pro addon nebo web jde do sdíleného core, nebo se **před implementací** user
  zeptá, zda ji chce i ve druhé variantě (core / jen web / jen addon / oboje).
  Nikdy tiše nechat jednu variantu pozadu. Přihlášení uživatele + výběr
  platformy pro psaní se dělá **nejdřív na webu**, port do addonu potom.
- Spec, plány a vše o webu: `UnityChat-web/docs/superpowers/`. Sem patří jen
  změny core/backendu a tenhle pointer. Backend zůstává na api.jouki.cz.
- **Stav 2026-09-22 ráno: web v0.5 = parita s addonem** (pokyn usera „doimplementovat
  všechny funkce"): autocomplete (emoty/Tab + Fulltext, @jména, `!` StreamElements,
  `/uc`), historie ↑/↓, systémové události (raid, oznámení, sub/Prime/Tier, dary,
  odměny, milníky), moderace z IRC (timeout/ban/smazání), banner s piny (Twitch GQL
  `GetPinnedChat` přímo z prohlížeče — gql.twitch.tv posílá `Access-Control-Allow-Origin: *`)
  a raidem, user card (GQL), náhled emotu, skutečné barvy jmen (GQL `chatColor`) +
  7TV paints + osobní emote sety, zmínky bez zavináče, oddělovač nových zpráv,
  parkování DOM uzlů, tooltipy, easter egg. Neportováno (Twitch tab / chrome.*):
  credits pill, DOM redeemy, hype train, pin modem, přepínání streamera, pop-out,
  dev mode. Detaily: `UnityChat-web/web/CLAUDE.md` + plán (Stav v0.5).
- **Stav 2026-09-22: web v0.4** — v0.3 parita (odpojení platformy, odpovědi,
  @zmínky, sdílené přezdívky, nastavení ⚙ + profil přezdívka/barva s auto-párováním
  na všechny propojené účty) + **živé změny přezdívek**: web poslouchá stejné SSE
  `GET /nicknames/stream` jako addon, `WebChat.applyNickname()` přepíše u
  vykreslených zpráv jméno, barvu, title i `.mention` spany (revert přes
  `data-display` / `data-color`), nová @zmínka novou přezdívkou se překládá hned.
  Kanál `robdiesalot` má prázdnou historii, dokud Rob nestreamuje (ingest od 19. 9.).
- **Stav 2026-09-21 večer: web v0.2 (přihlášení + posílání) běží na https://robdiesalot.com/chat/**
  — badge u inputu + šipka = menu Twitch / Kick / YouTube (Přihlásit / přepnout /
  Odhlásit), zprávy přes `POST /chat/send`, optimistická zpráva + echo.
  **Ověřeno bez reálného loginu** (flow končí na `auth.twitch.tv` se správnými
  scopes; user musí projít přihlášení sám). Známé podmínky: Kick dev app musí
  mít povolený scope `chat:write`; Google consent screen musí mít
  `youtube.force-ssl` (citlivý → do verifikace jen test users).
- v0.1 (read-only) běžel od 2026-09-21 odpoledne na https://robdiesalot.com/chat/
  (kořen domény = WordPress Roba, nesahat). Deploy je **z PC**:
  `cd UnityChat-web/web && npm run deploy` (build + `scripts/deploy-ftp.mjs`,
  heslo z `SERVER.md`). Hosting profiwh.com pouští FTP login **jen z českých
  IP** (GitHub runner timeout, Hetzner VPS „530 Access denied"), proto ne CI.
  Ladění na cizím streamu: `?debug=1&channel=<login>` (jinak natvrdo Rob).
- **Jak addon načítá core bez buildu:** `sidepanel.html` má
  `<script type="module" src="core-bridge.js">` + `<script defer src="sidepanel.js">`;
  bridge vystaví `window.UC_CORE` (+ globály `ChatStore`, `TwitchProvider`,
  `KickProvider`, `EmoteManager`). Oba skripty jsou v deferred frontě v pořadí
  dokumentu, `DOMContentLoaded` listener v sidepanel.js dál funguje.

## Landing page (jouki.cz/UnityChat)

> ⚠️ **DŮLEŽITÉ — web žije v SAMOSTATNÉM repu.** Landing/web jouki.cz **NENÍ** v tomto
> UnityChat repu (žádná `landing/` složka tu není, navzdory starším poznámkám). Web je v
> **privátním repu `github.com/jouki/jouki.cz`** (branch `master`, Coolify base dir `/`).
> Ověřeno přes Coolify DB: `jouki-landing` (app id=2) → `git@github.com:jouki/jouki.cz.git`.
> Tento UnityChat repo poskytuje jen `extension/` (ZIP se zipuje při buildu landing image z
> public UnityChat repa, branche master + dev). Pro úpravy webu: `gh repo clone jouki/jouki.cz`.

Statická install stránka na `jouki.cz/UnityChat` (case-insensitive). Nasazena jako nginx container přes Coolify, auto-deploy z pushů do `jouki/jouki.cz` (a refresh ZIPů při pushi do `jouki/UnityChat` master/dev).

### Struktura repa `jouki/jouki.cz`
- `jouki-cz/index.html` — root page (jouki.cz, under-construction CRT estetika)
- `unitychat/index.html` — hlavní install page (Orbitron + JetBrains Mono, gaming HUD)
- `unitychat/preview.html` — iframe mockup (načítá `extension/sidepanel.css` pro pixel-accurate rendering)
- `unitychat/dev/` — dev install page
- `unitychat/privacy/index.html` — **bilingvální (CS/EN) privacy policy** pro Google OAuth verifikaci (`youtube.readonly` sensitive scope). URL `jouki.cz/UnityChat/privacy` (+`?lang=en`). Live od 2026-06-24.
- `nginx.conf` — routing (case-insensitive `/UnityChat`, `/UnityChat/dev`, `/UnityChat/privacy`, download area, `/dev-api/` proxy na :3001)
- `Dockerfile` — base dir `/`, klonuje public UnityChat (master+dev), zipuje obě `extension/` složky, kopíruje sidepanel.css + icons

### Dockerfile build kontext (repo jouki/jouki.cz)
```dockerfile
# Base directory v Coolify = "/" (jouki.cz repo root)
FROM alpine:3 AS zipper    # git clone UnityChat master+dev → zip každou extension/
FROM nginx:alpine           # runtime
COPY jouki-cz/  → /usr/share/nginx/html/            # root page
COPY unitychat  → /usr/share/nginx/html/unitychat   # install + privacy + dev pages
COPY --from=zipper .../extension/sidepanel.css → /unitychat/assets/sidepanel.css
COPY --from=zipper .../extension/icons          → /unitychat/assets/icons
COPY --from=zipper unitychat.zip + manifest.json → /download/...
```

### Nginx routing
```nginx
location ~* ^/unitychat/?$   # case-insensitive → /unitychat/index.html
location /unitychat/          # static files
location = /download/unitychat.zip  # Content-Disposition: attachment
location = /                  # root + store redirect (viz níže)
```

⚠️ **Store redirect na rootu — nemazat.** `location = /` obsahuje podmínku:
návštěvník s `Referer: https://chromewebstore.google.com/...` dostane 302 na
`https://jouki.cz/UnityChat`, ostatní vidí osobní root.

Důvod: odkaz pod názvem položky ve store je „Oficiální adresa URL" a její
rozbalovátko nabízí **jen domény ověřené v Search Console, ne konkrétní cesty**.
Prefix property `https://jouki.cz/UnityChat/` se sice v Search Console ověří
(automaticky, díky doménovému DNS TXT), ale do CWS dropdownu se nepropíše.
Redirect je způsob, jak ten odkaz stejně dovést na install stránku — jinak
klikající ze storu přistál na „under construction" rozcestníku.

Funguje díky tomu, že CWS posílá `<meta name="referrer" content="origin">`.
URL v `return` musí být **absolutní https** — nginx za Coolify proxy vidí
`$scheme = http`, takže relativní cesta přidá hop navíc (ověřeno curl-em).

### Preview mockup (preview.html)
Interaktivní demo v iframe simulující reálný UnityChat panel:
- 16 chat zpráv (Rob TT jokes, raids, first-msg, mentions, replies, commands)
- **Filtry funkční** — klik na TW/YT/KI toggle filtruje zprávy podle platformy
- **Click-to-play audio** — klik na StreamElements zprávu přehraje mp3 (ElevenLabs voiced)
- **Dynamická verze** — fetch `/download/manifest.json` pro header verzi
- **Dynamický věk** — Rob's věk počítán z birthdate (29.6.1991)
- Reálné CSS třídy: `.tx` (ne `.txt`), `.bdg-img`, `.pi.uc` — matchují `sidepanel.css`
- 7TV emoty: RAGEY (`01F7JCJ0D80007RBBSW6MHGEVC`), WAYTOODANK (`01EZPJ8YRR000C438200A44F2Y`)

### Install page features
- Hero: 512px brand logo + Orbitron wordmark (gradient `background-clip: text`) + glow
- HUD grid pozadí (dual-res 72px/18px, `body::after`, background na `html` aby `z-index: -1` fungoval)
- `<code data-copy="chrome://extensions">` — click-to-copy (browsers blokují navigaci na chrome:// URL)
- Toast notifikace po kopírování s Ctrl+L → Ctrl+V → Enter instrukcemi
- FAQ `<details>` animované přes `::details-content` + `interpolate-size: allow-keywords` (Chrome 129+)
- Lightbox pro klikací screenshoty
- JS fetches `/download/manifest.json` pro verzi a ZIP `Last-Modified` pro datum updatu

### Emote/badge zdroje pro mockup
| Asset | CDN |
|---|---|
| Twitch native emoty (Kappa, LUL, Kreygasm, EZ) | `static-cdn.jtvnw.net/emoticons/v2/{id}/default/dark/1.0` |
| 7TV emoty (RAGEY, WAYTOODANK) | `cdn.7tv.app/emote/{id}/2x.gif` |
| BTTV emoty (search) | `api.betterttv.net/3/emotes/shared/search?query={name}` |
| Twitch badges | IVR API `api.ivr.fi/v2/twitch/badges/global` → `image_url_2x` |
| Chatbot badge | `bot-badge` set v IVR API |

## Backend (v0.5.0)

Node.js 22 + TypeScript (ESM) + Fastify 5 + Drizzle ORM + PostgreSQL 18. Nasazeno přes Coolify na Hetzner VPS, build z `backend/` subdirectory v monorepu.

### Schema
| Tabulka | Popis |
|---|---|
| `users` | Kanonický záznam uživatele (jeden per osoba, ne per platforma) |
| `platform_identities` | Vazba uživatele na Twitch/YouTube/Kick handle (many-to-one) |
| `messages` | Všechny chat zprávy s UC marker detekcí, reply context, raw segmenty |
| `events` | Stream events: raidy, piny, first-time chatters, bany, timeouty |
| `seen_users` | Unikátní uživatelé viděni přes UnityChat (platform, username, first/last_seen_at, seen_count) |

### Endpoints (v0.2.0)
- `GET /` — service info
- `GET /health` — liveness, uptime, SSE client count
- `GET /health/db` — DB connectivity (503 pokud down)
- `GET /nicknames` — bulk fetch all nicknames
- `PUT /nicknames` — set/update nickname + color (rate limit 10s)
- `DELETE /nicknames` — delete nickname
- `GET /nicknames/stream` — SSE stream pro real-time nickname changes
- `POST /users/seen` — upsert uživatele do `seen_users` (insert if new, ignore if exists)
- `GET /users` — merged view ze `seen_users` + `nicknames` tabulek
- `GET /dev/manifest.json` — dev branch extension manifest (dev mode only)
- `GET /dev` — dev download page HTML (dev mode only)
- `GET /dev/download` — dev branch extension ZIP (dev mode only)
- `POST /webhook/deploy` — GitHub webhook → git pull + signal file
- `GET /chat/history?channel&limit&before` — historie chatu pro panel ze
  serverového logu (ingest níže). Kurzor `<sent_at_ms>:<id>`, odpověď
  `{ok, messages[nejstarší→nejnovější], nextBefore}`, tvar zprávy = to, co
  posílají živé providery (`historical: true`). `no-store`, 10 req/s/IP.
- `GET /chat/stream?channel&platforms` — **SSE živých zpráv z ingestu** (v0.4.0,
  pro web verzi): `event: hello`, `event: message` (tvar jako `/chat/history`,
  `historical:false`, emitované PŘED dávkovým zápisem do DB), keepalive 15 s,
  bez replay (klient dorovná přes `/chat/history`), max 5 streamů/IP.
  Implementace `sse/chatBus.ts` + hook `onLive` v `ingest/index.ts`.
- **Web přihlášení + posílání (v0.5.0, `routes/webAuth.ts`, `lib/webAuth.ts`, `lib/webSend.ts`):**
  `POST /auth/:platform/start {returnTo}` (state `kind:'web'`, returnTo jen z
  `WEB_ORIGINS`; Bearer = napojení další platformy na účet) → OAuth callbacky
  **sdílené se streamer flow** (`/streamers/oauth/:platform/callback`, větvení
  podle `kind` ve state, stejné redirect URI u providerů) → 302 na web
  `#uc_code=…` → `POST /auth/exchange {code}` → Bearer session (SHA-256 hash v
  `web_sessions`, 30 dní klouzavě). `GET /auth/me`, `POST /auth/logout`,
  `DELETE /auth/:platform`, `GET /auth/config`. `POST /chat/send {platform,
  text, replyTo?, channel?}`: Twitch Helix `chat/messages` (`user:write:chat`),
  Kick public API `/chat` (`chat:write`), YouTube `liveChatMessages.insert`
  (`youtube.force-ssl`, liveChatId z videoId ingestu → jen když stream běží);
  refresh tokenů, UC marker (ne na `!`/`/`), rate limit 5 + 1/s per účet.
  Tokeny v `web_identities` šifrované jako `streamer_tokens` (NIKDY z API).
  Tabulky vytvořeny ručně SQL 2026-09-21 (drizzle-kit push přes tunel padal na ECONNRESET).
- `GET /commands?channel=<twitch login>` — **chat commandy ze Židolišty** (RobJewsALot
  server `GET /integrations/:slug/chat-commands`, hlavička `X-Api-Key`) pro našeptávání
  „!" v panelu a na webu. Klíč jen na serveru (`ZIDOLISTA_API_KEY` = `INTEGRATION_API_KEYS`
  Židolišty, oba v Coolify envu, generováno 2026-09-22, nikde v gitu), kanál → workspace
  přes `ZIDOLISTA_WORKSPACES` (`robdiesalot=rob`), regex spouštěče → literál
  (`!topd ?reset` → `!topd reset`), role (`allowRoles`) klient filtruje podle vlastního
  badge, cache 60 s, při výpadku poslední stav (`stale`). Židolišta zná jen commandy ze
  své stránky Commandy (dnes jen „Reset Top D"); commandy ze Streamer.botu (COMMANDS.md)
  by musel publikovat WebBridge — zatím ne (viz memory `project_web_version`). Změna commandu
  v Židolištce → webhook `POST /commands/invalidate` (stejný klíč) → cache pryč + SSE
  `commands-change` na `/nicknames/stream` → web i addon (v3.39.26) seznam obnoví hned.
  **Od 2026-09-22 mapování kanál ↔ workspace bere registr Židolišty** (`lib/zidolista.ts`,
  `GET <ZIDOLISTA_API_BASE>/integrations/workspaces`, cache 60 s, webhook `reason:"workspaces"`);
  env `ZIDOLISTA_WORKSPACES` je jen fallback, když Židolišta nikdy neodpověděla.
- **Chat bot Židolišty (2026-09-22, spec `docs/superpowers/specs/2026-09-22-zidolista-chat-bot-design.md`,
  `routes/integrations.ts`, `lib/botSend.ts`, `lib/botIdentities.ts`, `sse/integrationStream.ts`):**
  UnityChat = oči a ústa, Židolišta = mozek. `GET /integrations/chat/stream` (X-Api-Key, SSE
  `chat.message` s `workspace`, rolemi z badge, `isBot`, `id:` kurzor + `Last-Event-ID` replay 5 min,
  `: ping` 15 s) — jen kanály namapované v registru. `POST /bot/send` `{workspace, platform, text,
  replyTo?, idempotencyKey}` → 202 `{ok,id,channel,login,identity}`; kanál se odvozuje **jen ze slugu**
  (izolace workspaců), identita = vlastní bot workspace, jinak sdílený `_shared` (JoukiBOT); 409
  `duplicate`, 429 `rate_limited`, 404 `unknown_workspace`/`no_channel`, 503 `bot_unavailable`.
  Napojení účtu bota: `POST /integrations/bot/link-token` `{workspace|'_shared', platform, returnTo}`
  (returnTo jen origin z `ZIDOLISTA_RETURN_ORIGINS`, výchozí `https://jouki.cz`) → jednorázová
  `GET /bot/link/:token` (10 min) → OAuth `kind:'bot'` (sdílený callback) → `returnTo#bot_linked=…`.
  `GET /integrations/bot/status?workspace=`, `DELETE /integrations/bot/identity`. Tabulka
  `bot_identities` (SQL `backend/sql/2026-09-22-bot-identities.sql`, tokeny šifrované jako
  `web_identities`, nikdy z API).
- `GET /store/status` — stav položky v Chrome Web Store (publikovaná verze,
  verze čekající na review, policy varování). Landing page z toho kreslí řádek
  „verze vX.Y.Z čeká na schválení", který zmizí po schválení. Cache 10 min,
  při výpadku CWS API se hodinu vrací poslední známý stav. Bez
  `CWS_SERVICE_ACCOUNT` vrací 503.

### Dev
```bash
cd backend
npm install
cp .env.example .env
# nastavit DATABASE_URL na lokální Postgres
npm run db:push    # apply schema to DB
npm run dev        # hot reload na :3000
```

### Chat ingest (v0.3.0, spec `docs/superpowers/specs/2026-09-19-server-chat-log-design.md`)

`backend/src/ingest/`: `twitch.ts` (anonymní IRC), `kick.ts` (Pusher),
`youtube.ts` (live_chat poller, režim „všechny zprávy", page-refresh
fallback), `normalize.ts` (payload → řádek, čas z platformy: `tmi-sent-ts`,
`created_at`, `timestampUsec`), `store.ts` (INSERT … ON CONFLICT DO NOTHING +
retence), `index.ts` (orchestrace, dávkový zápis 500 ms/50 ks, retence 1×/h,
`/health.ingest`). Env `CHAT_INGEST_CHANNELS` (prázdné = vypnuto),
`CHAT_RETENTION_DAYS` (**0 = bez retence**, rozhodnutí usera 2026-09-19: archiv držet po neurčitou dobu, mazání na žádost; kladná hodnota zapne hodinové mazání). USERNOTICE (raid/sub) se zatím neukládá.
Testy `npm test` (node --test přes tsx, `.env.test`), listenery mají
injektovaný WebSocket/fetch. Audit kompletnosti: `scripts/ingest-audit.mjs`.

### Deploy
Coolify Application resource nastavený s Base Directory `backend/`, build z `Dockerfile`. `DATABASE_URL` injectnutý Coolify přes "magic" env variable napojenou na `unitychat-db` Postgres resource na stejné Docker síti.

### ⚠️ Coolify env proměnné: víceřádkové hodnoty rozbijí build

Coolify vkládá env proměnné do generovaného Dockerfile jako `ARG key=value`.
Víceřádková hodnota (typicky JSON klíč service accountu) ukončí ARG na prvním
newline a **deploy spadne na syntaxi Dockerfile**. Aplikace přitom běží dál na
staré image, takže se to tváří jako „změna se nenasadila", ne jako výpadek.

Proto je `CWS_SERVICE_ACCOUNT` v Coolify uložený **base64**; `cwsApi.ts`
přijímá obě podoby, aby v GitHub Actions mohl zůstat plain JSON.

Další past: `watch_paths = 'backend/**'` znamená, že **prázdný commit deploy
nespustí** — Coolify webhook přijme (200 OK), ale do fronty nic nezařadí.

### Tech poznámky
- **Drizzle ORM** místo Prisma: lightweight, zero codegen, SQL-like queries, perfect type inference, menší bundle
- **Fastify 5** místo Express: rychlejší, nativní async/await, JSON schema validation, lepší DX
- **Postgres driver** `postgres` npm package (ne `pg`): lightweight, typed, native template strings
- **Zod env validation** v `config.ts` - hard-fail při chybném `DATABASE_URL` nebo špatném `NODE_ENV`
- **Multi-stage Dockerfile**: `deps` (devDeps) → `build` (tsc) → `prod-deps` (runtime only) → `runner` (non-root user, healthcheck)

## Verzové milestones

> Starší milestones (v1.x – v3.37.4) jsou archivovány v `CLAUDE-HISTORY.md`. Níže jen aktivní v3.38.0+.
>
> **Logging pravidlo:** Při aktualizaci dokumentace (CLAUDE.md, memory, workflow) zapsat krátký záznam do sekce "Changelog dokumentace" v `CLAUDE-HISTORY.md`. Když CLAUDE.md znovu překročí ~40k znaků, přesunout další blok starších milestones do history.

- **v3.38.0** - **Per-channel LRU dedup (V8 OOM fix)**: předchozí `_seenMsgIds` / `_seenContentKeys` globální Sets rostly bez triminy per session → crash dump (`0xE0000008` V8 OOM v renderer co hostoval sidepanel.html). Teď `_dedupChannels: Map<"platform:channel", {ids,content}>` — per-channel FIFO cap 250 (25 % nad Twitch DOM cap ~200), per-session LRU cap 150 kanálů (~50 per platforma × 3). Worst-case paměť ~1.5 MB vs. dosavadní unbounded. Channel switch už NEclearuje dedup (feature: při návratu na channel A scraper nerenderuje duplicity z Twitch DOM). Helpers `_dedupEntry(msg)` + `_dedupTrim(set)`. DIAG dump rozšířen o `dedupChannels`, `dedupIdsTotal`, `dedupContentTotal`, `dedupPerChannel` breakdown + `dedupChannelsLRU` order.
- **v3.38.1** - **Cache hydration fix (77s → <2s boot)**: boot log po v3.38.0 odhalil `+79709ms cache loaded rendered=5000 msgCache=5699` — 77.8s synchronního main-thread blocku během `_loadCachedMessages`. Root cause: v3.24.24 bumpnutý `maxMessages` na 5000 znamenal rendering 5000+ DOM elementů in-row bez yield. Chunked insert přes `requestIdleCallback` (CHUNK=40) zavedený — UI thread dýchá mezi batchi.
- **v3.38.2** - **Lazy scroll-up load (storage 5000, DOM jen 250)**: split mezi **storage cap** (`maxMessages: 5000`) a **render cap** (`initialRender: 250`). `_hydratedIdx` kurzor + `_hydrateOlderMessages()` prepend z `_msgCache` při scroll nahoru. Scroll-position preservation přes `scrollHeight` delta. `_trim()` bumpne kurzor při DOM cap. Boot cache load ~500-800 ms.
- **v3.38.3** - **Lazy-load UX polish**: inline `.hydrate-spinner` (brand-orange gradient card + rotating ring + "Načítání starších zpráv…") + `requestAnimationFrame` yield pro paint. Batch size 250 → 150. Unread counter/separator suppression během `_hydratingOlder`. CS plural rules helper `_formatNewMsgCount(n)` — 1/2-4/0+5 varianty.
- **v3.38.4** - **Hydrate scroll-restore stale-capture fix**: `prevHeight`/`prevTop` zachyceno až PO rAF yieldu. Stale capture přes 16ms gap znamenal že user scroll během yieldu rozhodil restore.
- **v3.38.5** - **Credits pill: stale icon + watch-streak filter**: (1) channel switch bez custom icon vyčistí `backgroundImage` + `.has-icon`. (2) Watch-streak text filter — regex pustí jen balance-looking text, `StreakSkip` log pro rejected values.
- **v3.38.6** - **Lazy-hydrate ordering & scroll-restore fix**: (1) `_loadCachedMessages` sortuje `_msgCache` podle timestamp (scraped drift fix). (2) Slice sort před prependem (safety). (3) `_addMessage` early-return před `_trim`/`_scroll`/`_cacheMsg` při `_hydratingOlder`. (4) Scroll-restore — pokud `prevTop < 40 px`, `scrollTop = 0` po prependu.
- **v3.38.7** - **Scroll-lock při append když user scrolloval pryč**: capture/restore `scrollTop` v `_addMessage` pokud `!autoScroll && !hydratingOlder`. Fix Chrome reflow-induced scroll drift i s `overflow-anchor: none`.
- **v3.38.8** - **Pin extractor přepsán + DOM diagnostic**: DOM-walk label span + tight word-char capture + body anywhere-label reject + author null-guard + diagnostic Pin log.
- **v3.38.9** - **Pin extractor iter 2 — short-leaf pinnedBy + time-anchored author**: short leaf element scan pro pinnedBy, time-anchored walk previous siblings pro author, badges fallback.
- **v3.38.10** - **Pin author: search INSIDE time container**: author žije uvnitř pin footer `<p>`, ne vedle. Dvoustupňový search (inside leaf-first + fallback siblings), `<p>/<div>` akceptovaný jako timeEl.
- **v3.38.11** - **Pin highlight diagnostic pro collapsed chat**: rozšířené selectory + rate-limited `HighlightDiag` dump (pro tuning). Diagnostic odhalil: Twitch v collapsed chat mode rendruje `.pinned-chat__highlight-card__collapsed` verzi kde **author footer je úplně vynechaný** (pinnedBy + body only).
- **v3.38.12** - **Auto-expand collapsed pin card** (workaround): content script detekuje `__collapsed` + klikne expand button před extract. Nahrazeno v3.38.13 root fixem.
- **v3.38.13** - **Hide strategie — (reverted)**: pokus `position: fixed; right: -9999px` vedl k tomu, že Twitch highlight stack byl úplně unmountovaný (log `HighlightDiag` ukázal jen chat-list + wysiwyg, žádný highlight root). Twitch pravděpodobně používá IntersectionObserver a out-of-viewport = unmount.
- **v3.38.14** - **GQL pin fallback — pin fetch přes Twitch API, nezávislý na DOM**: background `FETCH_PINS` + sidepanel `_startPinPoll()` + merge DOM/GQL cards. Hide CSS zpět na stabilní `width: 0`.
- **v3.38.15** - **GQL schema fix #1 pro FETCH_PINS** (špatný guess — `message` také neexistuje).
- **v3.38.16** - **GQL introspection pro PinnedChatMessage** — introspection však Twitch disabled, vrátila `{"data":{}}`.
- **v3.38.17** - **GQL field probing** (bug: variable name mismatch — všechny probes fail-ovaly na `Variable "n" has invalid value null`).
- **v3.38.18** - **Probe variable fix + subselection detection**: odhalila že `PinnedChatMessage` má jen `id`, `startsAt`, `endsAt`, `pinnedBy`, `type` ("MOD" scalar). Ostatní 16 kandidátů neexistují → content pinu není dostupný přes anonymní GQL.
- **v3.38.19** - **DOM+GQL merge strategy for pins**: hybrid, DOM má přednost + GQL fallback pro hidden chat. Probe odstraněn.
- **v3.38.20** - **Real Twitch schema wired — GetPinnedChat operation**: query přepsaná na real schema s `emoteID` spread. Query failovala na Client-Integrity gate.
- **v3.38.21** - **emoteID gated by Client-Integrity — resolve by name**: query bez `emoteID` spread, sidepanel resolve emote URL podle text name proti local emote library. Poll 8s → 4s + visibilitychange trigger.
- **v3.38.22** - **Pin duplication fixes (2 bugy)**: (1) stacking cache duplicity → `_lastDomHighlightCards` filtruje pins out. (2) Mod badge 2× → `authorRow = authorEl.closest('p')` strict scope.
- **v3.38.23** - **Idempotent pin rerender + collapsed state persistence**: hash visible data + skip re-mount + per-pin collapsed preserve.
- **v3.38.24** - **Pin merge per-field (no more downgrades)**: `_mergePinCard(dom, gql)` per-field picker, `_lastGoodPinCache` pro sticky expanded data.
- **v3.38.25** - **Proactive DOM highlight scan (boot latency fix)**: `SCAN_HIGHLIGHTS_NOW` handler + `_kickDomHighlightScan` na boot/tick/visibility.
- **v3.38.26** - **Fix emote downgrade po polling tick**: `_rerenderHighlights` už neposílá GQL pins v msg.cards; GQL se merguje separately. `isRerender` guard. **Pin flow uzamčen jako stable.**
- **v3.38.27** - **Pin banner visual polish (jen CSS + readableColor)**: fancy gold gradient, pulsing icon, readable author, pill timestamp.
- **v3.38.28** - **Pin footer one-line**: `flex-wrap: nowrap` + ellipsis na author + `flex-shrink: 0` na timestamp.
- **v3.38.29** - **Pin body full-width, no author truncation**: padding-left 42→14, author nowrap bez ellipsis.
- **v3.38.30** - **`/uc pin [text]` mock command** (bug: `args.slice` na stringu místo array).
- **v3.38.31** - **`/uc pin` body parsing fix**: `parts.slice(1)` místo `args.slice(1)`.
- **v3.38.32** - **`/uc pin` injection path fix**: inject mock jako DOM card přímým voláním `_handleHighlights`. Mock zmizí po pár vteřin, řešeno v dalších verzích.
- **v3.38.33** - **Mock pin sticky 30s** (přechodný): `_mockPinUntil` flag suppress real GQL poll. Nahrazeno v3.38.34 aby mock mohl coexistovat s real pinem.
- **v3.38.34** - **Mock pin stackuje s reálným pinem**: separate `_mockPinCards`, oba pin sources renderovány vedle sebe.
- **v3.38.35** - **DOM pin extract iter 3 — direct text nodes + body selector fix**: scan přímých text nodes pro pinner, `.pinned-chat__message` selector pro body.
- **v3.38.36** - **Pin emote resolve + rounded corners**: tokenize text body for emote lookup (bug: použil `entry?.url` ale maps drží URL string). Border-image → solid border + box-shadow.
- **v3.38.37** - **Emote map value type fix**: maps drží URL string přímo, ne `{url}` objekt. Resolve fix v `_buildPinCard` + `/uc pin` mocku.
- **v3.38.38** - **Unify pin path**: legacy `#pinned-banner` schován po PIN_MESSAGE, jen `#highlights-banner` přes immediate FETCH_PINS. `_pinFromGql(p)` extracted method.
- **v3.38.39** - **Version bump (live)** — záměrný release pro test update-notifikace (live cap je nyní +1 nad uživatelovou aktuálně-staženou verzí, červená pulse + tooltip by se měla objevit do 15 min poll cyklu).
- **v3.38.40** - **YT provider instrumentation**: UC_LOG tag `YT` napříč connect/poll/disconnect — serial cid, findLiveVideoId per-URL isLive/videoId/bytes/finalUrl, fetchChatPage bytes/ms, continuation type (timed/reload/invalidation/none), initial actions count, seen-set priming, mode (api vs pageRefresh). pollApi: tick, HTTP status, NO_LCC dataKeys, contKeys, actions, newSeen, apiFails, nextMs, ms. pollPage: tick, actions, newSeen, ms, exceptions. disconnect: wasPolling, hadTimer, videoId, seenSize.
- **v3.38.41** - **YT silent polling fix on invalidation-only channels**: invalidationContinuationData je push-only (vrací HTTP 403 v `get_live_chat`). connect() teď adopt `_cont` POUZE pokud je timedContinuationData přítomná, jinak rovnou page refresh mode. `_pollApi` při poll response s pouze invalidation continuation taky přepne na page refresh (no _cont downgrade).
- **v3.38.42** - **YT is_popout=1 forcing timedContinuation**: smaller channels' embedded /live_chat?v=X vrací jen invalidationContinuationData. Popout chat nemá rodičovský iframe pro push → server vrátí timed token. connect() try popout first, fall back to embedded. `_variant` stored pro consistent `_pollPageRefresh` re-fetch.
- **v3.38.43** - **YT invalidation-only probe (debug-only)**: jednorázový probe při detekci invalidation-only streamu zkusí 6 endpoint/payload variant (POST get_live_chat WEB/WEB_EMBEDDED/TVHTML5 + Referer; GET /live_chat?continuation s+bez popout). Výsledky log-only. Confirmed: vše POST → 403, vše GET → static snapshot. Push channel je z extension kontextu nedosažitelný.
- **v3.38.44** - **YT prefer @handle URL (REVERTED v3.38.45)**: pokus fixnout multi-stream channel (TGL má více paralelních streamů) ordering URL `@{handle}/live` first → user řekl "nemíříme na multi-stream", revert.
- **v3.38.45** - **Revert v3.38.44**: zpět na `{channel}/live` first. Defensive fixy z v3.38.41–43 zůstávají.
- **v3.38.46** - **Mention flash fix + nickname display + sus priority**: (1) `_upgradeOptimistic` re-aplikuje `_processMentions` po `tx.innerHTML` přepisu IRC echem (mentions už neflasujou). (2) `_processMentions` zobrazuje `@Nickname` místo `@rawlogin` pokud má user UC nickname; raw v cache/dedup/data-mention-user zůstává. (3) Tag-line priorita: `reply > mention > raid > suspicious (isSus || _cleared) > first-message` — moderovaný uživatel retroaktivně přepne tag z "First message" na "Suspicious" v `_markMessageCleared`.
- **v3.38.47** - **Theatre-mode player width fix**: Twitch v theater mode dává inline `width: calc(100% - 34rem)` na `.persistent-player--theatre`. UC hide style přebíjí s `!important` → player zaplní viewport když je chat skrytý. Reverze automatická (style block se odstraní na un-hide). **Last master release (PR #17)**.
- **v3.38.48** - **Autocomplete Enter + multi-line history nav**: (1) Enter v active-autocomplete branche potvrdí výběr a zavře suggest list (předtím propadnul na `_sendMessage`). (2) ArrowUp/Down v `_msgHistory` browsing mode použije `_isCursorOnFirstLine()` / nový `_isCursorOnLastLine()` — kurzor nejdřív posune v textu, teprve při dosažení okraje řádku přepne historii.
- **v3.38.49** - **Textarea autoresize on history nav + sentinel**: (1) `value =` setter v history nav nefiruje `'input'` event → výška se nepřizpůsobila multi-line zprávě. Extrahováno do `_autoResizeInput()` helperu, voláno z ArrowUp/Down. (2) Sentinel `'X'` append/prepend ve cursor-line detekci pro zachycení wrap-point cursor pozice. _Sentinel byl nakonec problém — viz v3.38.51 revert._
- **v3.38.50** - **Enter confirms autocomplete only for @username**: v3.38.48 udělal Enter univerzální confirm pro libovolný typ autocompletu. User chtěl Enter jen pro user list (Tab/ArrowRight stačí pro emote/!cmd/`/uc`). Detekce: `ac.kind === 'user'` (Tab) nebo `matches[0].startsWith('@')` (auto-trigger). Pro emote/cmd Enter propadne na send.
- **v3.38.51** - **Remove sentinel from cursor-line detection**: v3.38.49 sentinel způsoboval false positive pro kurzor na konci nearly-full single line ("HeHe", "!command remove !tts") — sentinel push do line 2 → vrátilo false → return → user musel mačkat ArrowUp 2×. Odstraněno. Hard-newline check zůstává; visual-wrap edge case přijímám jako vzácný false negative.
- **v3.38.52** - **Viewer milestone (watch-streak) notifications**: IRC USERNOTICE `msg-id=viewermilestone` parser (tag names z Twitch dev docs: `msg-param-category`, `msg-param-value`, `msg-param-copoReward`) + UC_LOG `Milestone` diagnostic pro verifikaci. `_renderMilestoneEvent`: flame SVG + username + "+N" points pill (žlutá) + "Watch Streak Reached!" subtitle + optional attached chat msg. CSS `.msg.milestone-event` zelený card. Mock command `/uc milestone [streak] [points] [body]` (alias `/uc streak`).
- **v3.38.53** - **Cursor-line detection instrumentation (debug)**: po stížnosti že "HeHe" potřebuje 4 ArrowUp k advancementu, přidána UC_LOG `CursorLine` instrumentace v ArrowUp/Down handlerech a v `_isCursorOnFirstLine` / `_isCursorOnLastLine`. Dump z 6.5. ukázal že shortcut `sel===0` funguje správně — bug ve v3.38.51 byl fakticky vyřešen, zbývající user complaint je jiný (zatím v session není repro).
- **v3.38.54** - **Highlight banner doubled-text dedup**: "Sdílený chat byl spuštěn!" v UC banner zobrazoval text 2× ("Sdílený chat byl spuštěn!Sdílený chat byl spuštěn!"). String není v UC kódu — Twitch DOM má phrase 2× v textContent (visible + aria/sr-only nebo 7TV overlay). Defensive heuristic v `snapshotHighlights`: pokud `textContent` má sudou délku ≥ 10 a první polovina === druhá polovina, trim na 1 kopii. Plus UC_LOG `HighlightDup` co loguje outerHTML při dedupu pro budoucí targeted DOM filter.
- **v3.38.55** - **Twitch verified send (fix občasného neodeslání)**: `sendChat` byl fire-and-forget od v3.3.9 — fixních 150 ms mezi paste eventem a klikem na send button, bez verifikace výsledku. React/Slate zpracovává paste async přes scheduler, který Chrome throttluje když má fokus sidepanel (in-repo důkaz: 500–800 ms naměřeno u rewards popoveru). Commit paste > 150 ms → klik trefil "prázdný input" stav → Twitch neodeslal, text zůstal viset v inputu, další zpráva se appendla a odešly spojené. Fix: condition-based wait (text v editoru + button enabled, cap 1.5 s), post-click verifikace vyprázdnění inputu (okno 2 s proti double-send), retry 3×, pak `ok:false` → chyba v UC. UC_LOG tag `TwSend` (start/pre-click/sent/not-cleared).
- **v3.38.56** - **Opera tab mode + stream-tab URL-scan fix**: (1) Opera toolbar/chat-header klik otevírá UnityChat jako regular tab (openerTabId + index vedle stream tabu → Opera tab island best-effort; existující UC tab se fokusne, žádné duplicity) místo popup okna. (2) `_findStreamTab(platform?)` — aktivní tab má přednost, fallback URL-scan přes všechny taby (jen channel stránky, preferuje nakonfigurovaný kanál, sticky drží poslední aktivní platformu; YouTube přijímá i /watch). Nahrazuje `_getActiveBrowserTab()` v `_detectActivePlatform`, `_sendMessage`, `_openUserCard` + boot username detect → chat v Opera split screenu už nešediví, když je aktivní UnityChat tab. Split poměr = ruční divider (Opera nemá split API), `chrome.tabGroups` v Opeře neexistuje. UC_LOG tagy `StreamTab` + `TabOpen` (cleanup po user verifikaci).
- **v3.38.57** - **Boot hang na FFZ výpadku — emote/badge fetche s 8s timeoutem**: 6× watchdog auto-dump 2026-09-05 (18:23–18:28), boot vždy stál po `7TV globals loaded` + `Badges Total: 511`, nikdy nedošel k `channel emotes+badges loaded`. `_init` awaituje `Promise.allSettled` přes 5 provider loadů; curl potvrdil `api.frankerfacez.com` (global i room) přijme TCP+TLS (33/63 ms) a pak nepošle ani byte. Chrome fetch nemá idle timeout → `loadFFZ` se nikdy nesettlnul → panel visel za loading overlay. Fix: `EmoteManager._fetch()` = fetch + `AbortSignal.timeout(8000)`, použit ve všech 7 loader fetchech (7TV global/channel, BTTV global/channel, FFZ global/channel, Twitch GQL sub emotes); stejný timeout na 2 IVR badge fetche v background `loadTwitchBadges`. UC_LOG tag `EmoteFetch` (kind + elapsed ms + url) → boot dump pojmenuje zaseklý provider.
- **v3.38.64** - **YouTube layout po skrytí chatu**: křížek u YT chatu je UC intercept → `hideYtChat()`. Ta (1) neposílala `resize` event, takže když flexy už měl `theater`, player zůstal v šířce sloupce, dokud user nepřepnul fullscreen; (2) nechávala `#secondary` (sloupec s chatem) s computed 402px → prázdný obdélník pod playerem. Fix: `#secondary` width:0 (NE display:none — iframe), resize po hide i show. UC_LOG `YtLayout`. Memory `feedback_youtube_layout.md` aktualizována (bylo 159 dní staré a neodpovídalo kódu).
- **v3.38.65** - **Platform badge = logo platformy**: `.msg .pi` a header/reply `.badge` už nejsou textové chipy TW/YT/KI, ale SVG loga v `extension/icons/platform/{twitch,youtube,kick}.svg` (background-image, text zůstává v DOM jen pro kopírování). Uživatel UnityChatu (`.pi.uc`) dostává zlaté varianty `*-gold.svg` + původní glow — zatím placeholder (zlatý gradient + tmavý glyf), finální zlatou verzi kreslí user. Kick logo je aproximace (blokové K). ⚠️ `preview.html` na jouki.cz načítá reálné `sidepanel.css` → po deployi landing přerenderovat `panel-mock.png` pro store screenshot.
- **v3.38.76** - **Obnoven SEND_CHAT handler**: při rušení scrape (.74) skript uřízl i následující blok v `content/twitch.js` → Twitch zprávy ve v3.38.74–75 vůbec neodcházely („nepodařilo se odeslat“). Ověřeno diffem proti 6326c39. Poučení: při mazání bloku přes python nikdy nehledat uzavírací závorku „od konce textu“, vždy mazat přesný literál celého bloku.
- **v3.40.19–22** - **Release** (PR #27, 2026-09-24; CWS 3.40.22 v review, AMO přes workflow): **přihlášení k účtu UnityChat hned v addonu** (nastavení → „Účet UnityChat“ + ikona v hlavičce; Twitch/Kick/YouTube přes `chrome.identity`, připojení další platformy s Bearer na `/auth/:platform/start`, odpojení, odhlášení; stav z `/auth/me`, UC_LOG `Account`); **soundboard sound efektů** (spec `docs/superpowers/specs/2026-09-24-soundboard-se-tiers-design.md`): sdílený `core/soundboard.js` + `soundboard.css`, backend `GET /soundboard`, `PUT /soundboard/favorites`, SSE `soundboard-change/played/denied` (proxy na Židolištu, SQL `backend/sql/2026-09-24-soundboard.sql`), addon tlačítko s notou vedle emotů, klik = `!se <jméno>` přes `_sendMessage({ text })` (rozepsaný text zůstává), refetch po SSE rozprostřený do 0–3 s (limit Židolišty per IP), UC_LOG `Sfx`. Backend: YouTube streamer flow žádá `youtube.force-ssl` místo `readonly` (Google verifikace).
- **v3.40.5–18** - **Release** (2026-09-23): zlaté logo i u commandů z UnityChatu (server páruje hlášení odeslání, `lib/ucSends.ts`, SSE `uc-mark`); vrstvení ZW emotů z osobního 7TV setu + náhled stacku se všemi emoty (`core/emote-preview.js`); **Firefox build** (`scripts/build-firefox.mjs`, postranní lišta) a opravy, které z něj vzešly: Twitch send přes GQL s `dropReason`, dump z panelu, YouTube/Kick odeslání ověřené (jinak API), YouTube přes backend při consent stránce, Kick jméno z `/api/v1/user`, Kick API s `Authorization: Bearer session_token`; tlačítko UnityChatu v záhlaví chatu Kicku (`content/uc-header-button.js` sdílené s Twitchem, injekce podle manifestu); Kick odpověď na starou zprávu → `@jméno` bez zdvojení. Backend: `kick_user_id` = ID uživatele (dřív ID kanálu → web na Kick 404), YouTube ingest hledá live po 10 s.
- **v3.40.1–4** - **Release** (2026-09-23): cenzura zpráv i jmen podle sdíleného blacklistu slov ze Židolišty (`core/censor.js`, backend `GET /blacklist`, SSE `blacklist-change`; přesné slovo bez ohledu na velikost písmen), @zmínka víceslovnou přezdívkou se přeloží na login (`core/mentions.js`), menu emotů na dotyku bez automatické klávesnice a na úzké obrazovce přes celou šířku.
- **v3.40.0** - **Release** (2026-09-23): shrnuje 3.39.51–57 — nastavení „Přehrávat zvuky" a „Po animaci se vrátit na konec chatu", announcement skryje odpověď StreamElements (`hideBotReplies`) + volba „neukazovat v OBS" (`hideInBrowserSource`), tlačítko emotů v poli pro psaní se sdíleným výběrem a hledáním (`core/emote-picker.js`).
- **v3.39.51** - Nastavení **„Přehrávat zvuky"** (addon ⚙ `config.sound`, web ⚙, OBS profil `sound` v `/raw-profiles`): core `playPoopReaction({ muted })` + `setMuted()` pro přepnutí během reakce. Web: posuvník šířky v konfigurátoru OBS už neujíždí (sloupec náhledu `minmax(0, 1fr)`, formulář pevných 380 px).
- **v3.39.48–50** - Reakce: hnědne i **text zprávy** (světlejší `#b5835a` než jméno, ať zůstane čitelný); v raw režimu logo platformy dostalo velikost přes `--uc-pi` (má `font-size: 0`, takže `em` padalo na nulu a ikona mizela); **video se zvukem** (`peepo-chat-alpha-v2-wet-sound.webm`, VP9+Opus, `volume 0.85`, při odmítnutém autoplay fallback potichu); zarovnání videa **doleva** místo na střed. **Release do master (PR #23) + odesláno do CWS.**
- **v3.39.40–47** - Reakce „Peepo poop" doladěná podle usera: tlačítko 💩 vlevo v hover akcích a vykreslené **vždy** (addon po IRC echu recykluje element, podmíněné vykreslení znamenalo chybějící tlačítko u vlastních zpráv — id se čte až při kliknutí z `dataset.msgId`); zarovnání na **střed prvního řádku** (kotva `.un`) + `offsetLines 1.7`; velikost podle **výšky řádku** (strop `5.5 → 8` řádků podle šířky chatu, `narrowPx 550`/`widePx 850`), větší video se sází níž (`growOffsetRatio 0.45`); reflektor jako měkká maska místo ostrého `box-shadow`; cíl se nezvýrazňuje (`scrollToMessage(..., { flash: false })`); zatmavení i když cílová zpráva není v DOM. **Podrobná příručka pro další animace: `docs/reactions/README.md`.**
- **v3.39.39** - **Reakce „Peepo poop"** (`core/reaction.js`, backend `POST /reactions` + `GET /reactions/active` + SSE `reaction`, web i addon): mod/broadcaster klikne 💩 v hover akcích zprávy → všem se chat zatmí (1,2 s), reflektor na zprávu, video 15 s (5:1 na šířku chatu, spodní hrana = spodek zprávy; cílová zpráva se odscrolluje do záběru, bez ní video dole), v 7,2 s jméno + logo platformy u cílové zprávy zhnědnou (15 s natvrdo, 15 s přechod zpět). Tlačítko během reakce zmizí všem (body `uc-poop-busy`; zámek per kanál na serveru → 409). Backend ověřuje moda z badge v serverovém logu zpráv (24 h) nebo login = kanál. Addon se k backendu přihlašuje přes `chrome.identity.launchWebAuthFlow` (nová permission `identity`, returnTo `https://<id>.chromiumapp.org` povolený v `isAllowedReturnTo`), token v `chrome.storage.local.uc_session`. Video `robdiesalot.com/chat/media/peepo-chat-alpha-v2.webm` (1440×288, 15 s, alfa).
- **v3.39.38** - `/uc command <!spouštěč>` = lokální náhled reakce commandu Židolišty (announcement + odpověď bota jako zpráva „Židolišta", skrytí podle nastavení), nic se neodesílá. Backend `/commands` propouští `reply` a `announcement` (Židolišta je posílá v integračním seznamu).
- **v3.39.37** - Announcement `media.loopDelayMs` (0–60000): smyčka s pauzou — bez nativního `loop`, core `wireAnnouncementVideo` (ended → čekat → od začátku; zároveň řeší load videa z template a replay klikem).
- **v3.39.36** - (1) Backend `/announcements` zahazoval `textHtml` (validace propouštěla jen známá pole) → rich text se ukazoval jako surový Markdown; propuštěno + core má Markdown fallback `richTextToHtml` (stejná podmnožina jako Židolišta). (2) YouTube zkracuje text odkazu v `runs` („…"), plná URL je v `navigationEndpoint` (redirect?q=) → `ytRunFullText` v core `renderYouTube` a `ytRunUrl/ytRunText` v ingestu.
- **v3.39.35** - Announcement: `media.loop` je zase volba z editoru Židolišty (výchozí zapnuto), `false` = jedno přehrání.
- **v3.39.34** - Announcement rich text: Židolišta posílá `textHtml` (Markdown → HTML), core `sanitizeAnnouncementHtml` (whitelist b/i/u/br/h1–h3/a http(s) + target=_blank) má přednost před `text`; nadpisy a odkazy stylované v desce.
- **v3.39.33** - Announcement podle usera: médium max 38 % šířky desky (`--ua-w` strop, `--ua-ar` poměr), bez řádku „spustil", responzivní hlavička (wrap + ellipsis), video vždy ve smyčce, drop-shadow na médiu.
- **v3.39.32** - Announcement: `<video>` z `<template>` se po vložení nenačte samo → `load()` + `play()` (gotcha inertního dokumentu).
- **v3.39.31** - **UnityChat Announcement**: command v Židolištce (RobJewsALot) může jako odpověď poslat honosnou zprávu s videem/animací (VP9 alfa / WebP) a textem jen pro uživatele UnityChatu. Cesta: Židolišta `POST api.jouki.cz/announcements` (X-Api-Key, kontrakt v `backend/src/routes/announcements.ts`) → SSE `announcement` na `/nicknames/stream` → `core/announcement.js` (`normalizeAnnouncement`, `announcementHtml`, `matchesChatReply`) → addon `_addAnnouncement` / web `chat.addAnnouncement`. `chatReply.hideInUnityChat` = běžnou odpověď commandu (SB ji pošle všem) klient 15 s nevykreslí. Deska bez gradientu pod médiem (průhledné video se nesmí slévat), reflektor za médiem, zlatý rám; `prefers-reduced-motion` → `stillUrl` / bez autoplay; klik na médium = replay. Mock `/uc annc [text]` (demo erb z `robdiesalot.com/chat/media/`). Test `scripts/test-announcement.js`.
- **v3.39.30** - Animace změny log v otevřeném našeptávači (`.es-logo-in` / `.es-logo-out`: nové si udělá místo a prolne se, odebrané vybledne).
- **v3.39.29** - Otevřený našeptávač `!` se po změně seznamu (SSE) přepočítá sám.
- **v3.39.28** - **Commandy o stav pozadu**: `/commands` mělo `Cache-Control: max-age=60`, takže refetch po SSE `commands-change` bral prohlížeč z vlastní cache → klient vždy ukazoval předchozí stav. Fix: backend `no-store` + klient `cache: 'no-store'`. Stejný spouštěč ve více zdrojích = jeden řádek se všemi logy a štítky (Židolišta první, jen zdroje povolené pro moji roli).
- **v3.39.27** - Zdroj u commandu = záznam nabídnutý pro moji roli (stejný spouštěč v Židolištce i SE).
- **v3.39.26** - SSE `commands-change` (webhook ze Židolišty) → `_loadUcCommands()` hned.
- **v3.39.25** - Loga commandů ve stejném boxu 28 px (menší logo s paddingem) → zarovnaná na střed.
- **v3.39.24** - Logo Židolišty 28 px + drop-shadow (`.es-logo-zidolista`, styl od usera).
- **v3.39.23** - Logo zdroje u commandů v autocomplete (`icons/commands/zidolista.png`, `streamelements.svg`, třída `.es-logo`) místo oranžové tečky; web totéž přes `logos` option.
- **v3.39.22** - **Našeptávání commandů Židolišty**: `_loadUcCommands()` bere `GET /commands?channel=` z backendu (jméno, literál spouštěče, role) a slučuje se StreamElements v `!` autocomplete (`_allBangCommands()`), zdroj v seznamu „Židolišta"/„SE"; commandy jen pro mody se divákům nenabízí (`_myChatRole()` z badge vlastních zpráv). Obnova 5 min, znovu při přepnutí streamera. UC_LOG `Cmd`. Port z webu (pokyn usera 2026-09-22).
- **v3.39.17–21** - **`extension/core/` — sdílený core s webovou verzí** (plán web v0.1, Task 1–5): postupné vytažení `ChatStore`, barev jmen + HTML helperů (+ `log.js`), `TwitchProvider`, `KickProvider` a `EmoteManager` ze `sidepanel.js` (−1 550 řádků) do ES modulů bez `chrome.*`/DOM; log, WebSocket, fetch a assetUrl injektované přes `opts`. Kick HTML fragmenty se parsují bez `document` (`core/html.js`). Addon je konzumuje přes `core-bridge.js` (module) + `sidepanel.js` s `defer`. Testy: `scripts/test-core-helpers.js` (19), `test-twitch-irc.js` (18), `test-kick.js` (12), `test-emotes.js` (12), starší testy převedené na `import()`/`require(esm)`. Chování addonu beze změny (smoke test u usera zatím neproběhl — reload rozšíření!).
- **v3.39.9–16** - YouTube: panel ↔ vanilla chat (toolbar), `#columns padding-right:0` (jediný zdroj prázdna, ověřeno v DevTools), ikona v mastheadu jen na live (`.ytp-live-badge`), nativní „Otevřít panel" odemčené (Disabled→Mono) → vrací chat; popout ikona ze SVG; Fulltext přepínač persistentní (`config.acFulltext`); badge u inputu zlatý. **Release 3.39.14 (PR #22) → CWS review (3.39.3 zrušena přes `cancelSubmission`).**
- **v3.39.0** - **Historie ze serveru (Task 13 plánu)**: klient bere historii z `GET /chat/history`, `ChatStore` drží data, DOM okno 300 uzlů s parkováním odpojených uzlů nad/pod oknem (scroll oběma směry bez re-renderu), starší stránky přes kurzor. Smazáno: `_msgCache` + storage cache, `_loadCachedMessages`, `_hydrateOlderMessages`, `_trim`, per-channel dedup LRU, content-key dedup, import z Twitch tabu (`TW_HISTORY`). Audit ingestu na Stérově streamu PASS (Twitch 84/84, p95 733 ms; YT 7/7, p95 4,9 s).
- **v3.38.81** - **Ruční přepínání streamera**: primární Rob, whitelist Rob + TenSterakdary, start podle aktivního tabu, jinak tlačítko „Přepnout chat na …" nad chatem. Root cause míchání chatů/emotů: re-entry auto-switche z 3s detekce rušila rozdělané přepnutí.
- **v3.38.78–80** - DIAG `msgCacheIds` pro audit, čas z platformy v providerech, `ChatStore` + testy (`scripts/test-chat-store.js`, `test-provider-timestamps.js`).
- **v3.38.76–77** - obnovený SEND_CHAT handler, `TwHistory` log s rozsahy časů.
- **v3.38.75** - **Doplnění Twitch historie z React props** (zrušeno ve v3.39.0): náhrada scrape. Background `TW_HISTORY` (executeScript MAIN world) přečte z `.chat-line__message` fiber `memoizedProps.message` — reálné `id` (= IRC tag id → přesný dedup), `timestamp` ms, `messageBody`, `messageParts` (0 text / 4 mention / 5 link / 6 emote → IRC emotes tag v code pointech), `badges` {set:ver} → `badgesRaw`, `user`, `reply`. Ověřeno na živém tabu: 50/50 zpráv, parts == body. `_importTwitchHistory()` 1,5 s po connectu, `_historyToMsg()`, `msg.historical` → `_addMessage` vloží podle `dataset.ts` před první novější zprávu (`_firstNewerMsgEl`). Systémový řádek „Doplněno N zpráv z Twitch chatu“, UC_LOG `TwHistory`.
- **v3.38.74** - **Twitch DOM scrape zrušen**: po reloadu (v3.38.72) panel „doparsoval" 10 zpráv ze začátku streamu s časem teď a jeden řádek měl místo textu čas („Strainer8: 10:12:") — scrape dával syntetické timestampy (`baseTime + idx*1000`) a text četl heuristikou přes textContent včetně 7TV timestampu. Spec serverového chat logu ho stejně ruší; odstraněn `_scrapeExistingChat`, `SCRAPE_CHAT` handler i `scrapeMessages()`. Mezeru po reloadu vyplní serverová historie.
- **v3.38.73** - **Twitch zpráva s textem 2×**: report PanPixu — jeden Enter, na streamu jedna zpráva s textem dvakrát. `waitReady` 1,5 s prohrál se Slate commitem → repaste za rozpracovaný paste. Reprodukováno v `scripts/test-send-race.js` (mock: Slate stav sync, DOM později, DOM výběr přebírá s ~100 ms zpožděním). Fix: čekání 4 s, sonda z obou konců, select-all + 150 ms před repastem, detekce zdvojení před klikem → přepis nebo SendFail, nikdy klik nad zdvojeným textem.
- **v3.38.72** - **Reload ikona + stav ve filtrech**: Připojit/Odpojit/Vyčistit pryč, reload v hlavičce; tečka stavu uvnitř TW/YT/KI filtrů (červená/žlutá/zelená, šedá = vyfiltrováno).
- **v3.38.71** - **Kick badge**: provider četl neexistující `is_moderator` apod.; teď `sender.identity.badges[]` → `badgesRaw`, `_kickBadgeEntry()`, oficiální SVG (moderator/subscriber/founder/verified/bot z DOM), aproximace pro broadcaster/vip/og/sub_gifter/staff. UC_LOG `KickBadge`.
- **v3.38.68–70** - Oficiální loga platforem (zlaté od usera), glow přes drop-shadow, velikosti 16/18/20, nastavení „Odpovědi zobrazit na jeden řádek".
- **v3.38.67** - **Jeden zdroj = store verze**: zrušen dvouvrstvý model dev/store. Ze zdroje smazáno vše, co `build-store.ps1` dřív vyřezával (self-update check + alarm + update dot/tooltip, `update.bat`, `streamer.*` + „Jsem streamer", `backup.*`, `sidebar_action`, `alarms`), včetně mrtvého CSS. `build-store.ps1` je teď jen kopie + verifikace + zip. Opera: tab mode přes toolbar action, bez nativního sidebaru. Landing page (repo jouki.cz) odkazuje jen na store, ZIP zůstává pro `/UnityChat/dev`.
- **v3.38.66** - **Logo i u badge vedle inputu + větší badge**: `#active-badge.tw` (ID selektor) přebíjel `.badge.tw` z v3.38.65. Velikosti 18/20/22 px (small/medium/large), input 22 px, reply indikátor 18 px.
- **v3.38.63** - **První zpráva po otevření panelu se ztrácela jako „odeslaná"**: `sendChatNow` volal `findInput()` jednorázově → před mountem Twitch inputu hodil chybu, ale optimistická zpráva zůstala v DOM i cache. Fix: polling na input 3 s + `_markSendFailed()` (červený pruh „neodesláno", klik vrátí text do inputu, vypadne z cache, uvolní párovací klíč). `_contentKey()` extrahován. UC_LOG `SendFail`, `TwSend input-wait`, `Guard`.
- **v3.38.60–62** - YouTube all-messages režim, serializace Twitch sendů, YT barvy jmen + @přezdívky (VPS session).
- **v3.38.59** - **Store assety + medium layout jako výchozí**: `DEFAULTS.layout` small → medium (jen nové instalace, uložené configy si své nastavení nechávají). Přibyl `scripts/build-promo.ps1` — headless Chrome renderuje ikonu, obě promo dlaždice i screenshot 1280×800 ze zdrojů v `store/listing/assets/` (sdílené `brand.css`, vektorové `logo.svg` vytažené z logo-designer.html). **Položka odeslána do CWS ke kontrole 16. 9. 2026.**
- **v3.38.58** - **Chrome Web Store build pipeline**: `extension/` zůstává jediný dev zdroj, store balíček je generovaný derivát přes `scripts/build-store.ps1` (markerové stříhání `UC_STORE_STRIP_START/END`, patch manifestu, verifikace + `node --check`, ZIP). Vyříznuto: self-update check (`_checkForUpdate` + background alarm + update tooltip — CWS zakazuje out-of-store update), `update.bat`, streamer OAuth (`streamer.*` + „Jsem streamer" tlačítko), `backup.*`, `sidebar_action` klíč, `alarms` permission. Refaktor v `_wireBackgroundUpdateListener`: větve `UC_UPDATE_*` přesunuty na konec `else if` řetězu, aby strip nenechal osamocené `else` (chování beze změny). Podklady pro Developer Dashboard v `store/listing/` — single purpose, per-permission justifikace (nejcitlivější `cookies` + Twitch auth-token a `scripting` MAIN world), data disclosure checkboxy podložené auditem všech volání `UC_API`, listing CS/EN, asset checklist + store ikona s 16px paddingem. Cílová viditelnost: Public.
- **v3.38.60** - **YouTube: režim „všechny zprávy" místo Top chatu**: user hlásil chybějící YT zprávy v panelu, které na streamu vidět byly. `/live_chat` servíruje default režim „Nejlepší zprávy", který část zpráv zahodí jako domnělý spam; UnityChat bral continuation z `contents.liveChatRenderer.continuations` = token právě vybraného (filtrovaného) režimu. Token druhého režimu („Chat", *Zobrazí se všechny zprávy*) žije v `header.liveChatHeaderRenderer.viewSelector.sortFilterSubMenuRenderer.subMenuItems[1].continuation.reloadContinuationData` a nikdy se nečetl. Nové helpery `_lcr(data)` (sjednocuje `contents.liveChatRenderer` vs. `continuationContents.liveChatContinuation`) + `_pickAllChatToken(lcr)`; `connect()` po prvním fetchi stránku znovu načte přes `?continuation=<allToken>`, `_fetchChatPage(variant, cont)` a `_pollPageRefresh` token respektují, API polling ho dědí přes continuation řetěz. Ověřeno proti živému streamu před pushem: POST `get_live_chat` s tokenem → 200 + 77 akcí + `selected=("Chat", true)`, GET `live_chat?continuation` → 78 akcí, taktéž režim Chat. UC_LOG `YT` rozšířen o `chatMode`.
- **v3.38.61** - **Twitch sendy serializované — rychlé zprávy za sebou se ztrácely**: dvě rychle odeslané zprávy sdílely jeden DOM input, `SEND_CHAT` handler spouštěl `sendChat` pro každou zvlášť → druhý paste vlezl do Slate editoru dřív, než první stihl kliknout na send. Druhá zpráva se v UC zobrazila (optimistic UI), do Twitch chatu nedošla. Tiché to bylo kvůli druhé díře: verifikace brala „input neobsahuje náš text" jako důkaz odeslání — když se text do editoru vůbec nedostal, byla podmínka splněná hned → `sent` → `ok:true`. Fix: `sendChat` je fronta (promise chain, log nese `q`), práci dělá `sendChatNow`; paste vytažen do `insertText(replaceExisting)` a chybí-li text před klikem, vloží se znovu (Range API výběr proti zdvojení); prázdný editor už neklikne naprázdno ani nehlásí úspěch; při neshodě probe je důkazem až úplně prázdný editor a retry se nepouští (ochrana proti odeslání dvakrát). `scripts/test-send-race.js` pouští skutečný `sendChat` proti mocku Slate editoru — reprodukuje bug bez fronty a ověřuje fix ve 3 timingech.
- **v3.38.62** - **YouTube barvy jmen + @přezdívky v autocomplete + YT jména bez zavináče**: (1) YT diváci byli v panelu všichni červení. Barva **není v datech** — ověřeno na robdiesalot streamu i cizím: renderer nese jen `authorName`/`authorPhoto`/`authorExternalChannelId`, žádné `*Color*` pole. Klient si ji počítá sám (`live_chat_polymer.js` → `computeAuthorNameColor`) a je za A/B experimentem. Přidán port jejich hashe jména `ytNameColor()`; kontrastní půlku jejich algoritmu neduplikujeme, čitelnost řeší stávající `readableColor()`. Hash počítá z jména **včetně `@`**, jinak by barvy nesouhlasily s YouTube. `_authorColor()` drží jejich pořadí větví (`authorUsernameColorDark` > `authorSeedColorArgb` > hash) a loguje, která platí. (2) Autocomplete nabízel raw login, který uživatel v panelu nikde nevidí (zobrazuje se UC přezdívka) → nemohl na člověka odkázat. Nově nabízí přezdívku (hledá podle ní i podle loginu), ale do chatu se mention přeloží zpět na login přes `_resolveNicknameMentions()` + `NicknameManager.resolveNickname()` — zmíněný tak dostane upozornění a lidé mimo UC vědí, o koho jde; v panelu se zobrazí zpátky přezdívka. Duplicitní generování návrhů ze dvou míst sjednoceno do `_acUserMatches()`, `_acUserEntry()` opravuje zdroj i barevnou tečku. (3) YT `simpleText` nese handle včetně `@`; strip je na **vstupu**, ne v renderu — klíč v `_chatUsers` byl `youtube:@nekdo`, zatímco mention regex i autocomplete hledají jméno bez něj, takže tím zároveň začne fungovat mention matching pro YT. `scripts/test-names-colors.js` (barvy + 11 případů překladu mentionů). **Aktuální verze (dev)**

## Session workflow — jak Claude pracuje v tomto repu

> **Tato sekce je primární orientace pro každou novou Claude session.** Memory soubory v `~/.claude/projects/D---BACKUP-2-0-Code-Projects-UnityChat/memory/` jsou doplňkové — feedback od uživatele, security context, otevřené TODO, locks. CLAUDE.md drží kompletní obraz "jak pracujeme" tady.

### ⚠️ Pravidlo č. 1 — Nehádat. Ověřit.

**Každý fix musí být podložený důkazem co problém způsobuje.** NE spekulativní "this might work, let's try". Před push změny Claude **musí vědět proč** to opraví bug, ne jen doufat že pomůže.

**Standard troubleshooting flow:**
1. User reportuje bug → **nehádat root cause hned**
2. **Data first**:
   - Existuje UC_LOG instrumentace v té oblasti? → požádat o `Downloads/unitychat-debug.txt` (💾 button nebo `window.ucDump()` v F12)
   - Žádná instrumentace → přidat ji jako separate `debug:` commit, ask for repro+dump, **AŽ POTOM** fix v dalším commitu
3. **Read code end-to-end** — Grep / Glob / Read full functions, trace data flow, check git log/blame
4. **Diagnostic probe** pro nejisté hypotézy — pokud >1 možná příčina, přidat probe co testuje varianty (jako v3.38.43 — 6 endpoint probnuto), rozhodnout podle dat
5. **Push fix s instrumentací VŽDY** — když v té oblasti není ověřitelná hypotéza (browser DOM, IRC realtime, async timing), v rámci fix commitu přidat UC_LOG do změněných cest. Pokud první pokus neopraví bug, máme data pro korekci hned, neztrácíme round-trip "log commit → user dump → fix commit". Logy se odstraní v cleanup commitu až user potvrdí.
6. **Po pushi sbírat repro/log** dokud user nepotvrdí.

**Co je dovoleno bez ověření:**
- Pure code review fixy (typo, syntax error, missing await, broken refactor — očividné z kódu)
- Reverze na user request
- Instrumentace (právě nástroj pro získání dat)
- Známé vzory dokumentované v memory / CLAUDE.md / CLAUDE-HISTORY

**Red flags v interní úvaze (recognize and stop):**
- "this should work" / "maybe X helps" / "let's try and see" / "likely the cause is..." (bez podložení)
- "could be a race" (bez konkrétní timing trace)

→ STOP. Nepush. Přidej instrumentaci, ověř přes log, vrať se s důkazem.

**Co Claude může aktivně testovat sám** (Claude Code prostředí):
- HTTP endpoint behavior (`curl`, deploy verifikace)
- Code path traces (Read + Grep, mental simulation)
- Git history (`git log --oneline -p`)
- GQL queries proti veřejným endpointům (`curl` test)
- Bash skripty na test inputu

**Co je MIMO** (akceptovat limit, kompenzovat instrumentací):
- Browser DOM/CSS rendering
- Twitch IRC / WebSocket real-time flow
- YouTube push notifications
- Service worker lifecycle

→ Pro tyhle je instrumentace JEDINÁ cesta. Bez logu = slepý. Vyžadovat data od usera.

**Override:** User může explicit říct "just ship it" / "zkus naslepo" / "máme málo času, hodit to a uvidíme" → tehdy je guess přípustný. Bez explicit overridu **vždy** podle pravidla výše.

Detaily + příklady (správně vs špatně z v3.38.x): viz `memory/feedback_no_guessing.md`.

### Co číst na startu session (pořadí)

1. **`MEMORY.md`** (auto-loaded) — index, ukazuje na všechny memory soubory
2. **`CLAUDE.md`** (tento soubor, auto-loaded) — projekt, architektura, milestones, workflow
3. **`memory/checkpoint_v3_23_1.md`** — aktuální verze, co je live, otevřené úkoly
4. **`memory/feedback_release_workflow.md`** — commit+push default, branch policy
5. **`memory/checkpoint_v3_38_26_pin_stable.md`** ⚠️ — POVINNÉ pokud cokoli souvisí s pin bannerem
6. **`memory/security_streamer_tokens.md`** ⚠️ — POVINNÉ pokud cokoli souvisí s OAuth tokens / streamer auth
7. **`docs/handoff/2026-09-21-web-version-handoff.md`** ⚠️ — POVINNÉ pokud jde o **webovou verzi UnityChatu** (robdiesalot.com): závazná rozhodnutí (**web žije v privátním repu `jouki/UnityChat-web`**, viz sekce „Web verze" níže; **pravidlo portování addon ↔ web**), ověřená fakta o providerech/backendu; spec je v privátním repu

### Workflow loop (typická iterace)

```
1. User reportuje bug nebo požaduje feature
2. Pokud jde o bug v UC chování:
   a. Pokud je v té oblasti instrumentace → požádat o debug log z 💾 buttonu
   b. Pokud není → přidat instrumentaci jako separate commit, repro+dump, PAK fix
3. Read/Grep/Glob pro nalezení relevantního kódu (NE Bash find/grep/cat)
4. Edit minimal change
5. Bumpnout extension/manifest.json version (patch level X+1)
6. git stash; git pull --rebase origin dev; git stash pop  (druhá session mohla pushnout)
7. git add specific files (NE -A, NE .)
8. git commit s conventional message:
   "type(scope): summary (vX.Y.Z)" + tělo + Co-Authored-By
9. git push origin dev
10. Pokračovat na další bug
```

**Bez ptání:** commit+push po každé hotové změně. To je explicit user policy (`feedback_release_workflow.md`). Ptat se JEN při destructive operacích nebo zásahu do master.

### Verzování (extension/manifest.json)

- Bumpnout `version` při **KAŽDÉM** commitu, který mění chování
- Patch level (`3.38.X → 3.38.X+1`) — bugfixy, drobné změny
- Minor level (`3.38 → 3.39`) — větší feature changes
- Major level — netýká se, držíme se 3.x
- **Důvod:** uživatel vidí verzi v titulku side panelu = vizuální feedback že reload extension proběhl OK

### Conventional commit messages

Formát:
```
type(extension|backend|landing|docs): krátký popis (vX.Y.Z)

Volitelné tělo s detaily — proč, ne co (kód říká co).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Types: `fix`, `feat`, `refactor`, `chore`, `docs`, `debug` (jen instrumentace), `revert`, `security`.

### Branch policy

- **`dev`** = vývoj. Commit+push rovnou, bez PR.
- **`master`** = produkce. **POUZE přes PR `dev → master`**, jen na **explicit user request** ("merguj", "release", "pushni do main").
- Dev branch se NIKDY nemaže při merge.
- PR merge: `gh pr merge <num> --merge --admin` — vždy `--merge`, NIKDY `--squash` ani `--rebase`.

### ⚠️ Release = DVA cíle, ne jeden

> **Od 18. 9. 2026 to řeší automatika.** Push do `master`, který mění
> `extension/manifest.json`, spustí workflow `.github/workflows/cws-release.yml`:
> sestaví store balíček, nahraje ho a **odele ke kontrole**. Není na co
> zapomínat — ale když workflow spadne nebo ho někdo vypne, platí níže
> popsaný ruční postup.
>
> **Stav položky kdykoli zjistíš:**
> ```bash
> CWS_PUBLISHER_ID=<id> node scripts/cws.mjs status --key <cesta k JSON klíči>
> ```
> Vypíše publikovanou verzi, verzi čekající na review a případná varování
> o porušení policy. Klíč má user v Bitwardenu (položka „UnityChat — CWS
> service account"), v CI je v secrets `CWS_SERVICE_ACCOUNT` + `CWS_PUBLISHER_ID`.

UnityChat má **dvě distribuční cesty** a release není hotový, dokud nejsou
obě na stejné verzi:

| Cíl | Jak | Kdo to dostane |
|---|---|---|
| **jouki.cz ZIP** | PR `dev → master`, Coolify rebuild | jen dev větev (`/UnityChat/dev`) a ruční Load unpacked; landing na ZIP od 19. 9. 2026 neodkazuje |
| **Chrome Web Store** | `cws-release.yml` automaticky po merge do master (ručně `build-store.ps1` + `cws.mjs release`) | Chrome / Edge / Brave / Opera — **všichni uživatelé** |

**Když uděláš master release, udělej i upload do storu.** Jinak dostanou
uživatelé ze storu starší build než ti, co si stahují ZIP — a protože store
verze se aktualizuje sama, budou na staré verzi, aniž by o tom věděli.

Store upload má vlastní review (u v3.38.59 trvala 2 dny). Verze v manifestu
musí být vyšší než ta publikovaná, jinak ji store odmítne. Listing texty a
privacy odpovědi se nemění — jen když se změní chování rozšíření, viz
`store/listing/privacy-disclosure.md`.

### Release flow (master deploy)

```bash
# 1. User řekne "merguj" / "release" / "pushni do main"
gh pr create --base master --head dev --title "Release vX.Y.Z — souhrn" --body "..."
gh pr merge <PR#> --merge --admin

# 2. GitHub Actions trigger-jouki-cz.yml fire automaticky → Coolify webhook (force=1)
gh run list --branch master --limit 3 --json status,conclusion,name,createdAt,databaseId,url

# 3. Coolify rebuild jouki-landing container ~60–90s

# 4. Polling deploy ověření
for i in 1 2 3 4 5 6 7 8; do
  V=$(curl -sSL "https://jouki.cz/download/manifest.json" 2>/dev/null \
      | grep -oE '"version"[^"]*"[^"]+"' | grep -oE '[0-9.]+')
  echo "[try $i] version=$V"
  [ "$V" = "X.Y.Z" ] && { echo "DEPLOYED"; break; }
  sleep 15
done
```

```bash
# 5. Chrome Web Store — dělá workflow cws-release.yml samé po merge do master.
#    Kontrola, že to opravdu odešlo:
CWS_PUBLISHER_ID=<id> node scripts/cws.mjs status --key <klíč>
#    Ruční záloha, kdyby workflow selhal:
#    powershell -File scripts/build-store.ps1
#    CWS_PUBLISHER_ID=<id> node scripts/cws.mjs release store/build/unitychat-store-vX.Y.Z.zip --key <klíč>
```

⚠️ **Coolify gotcha (`feedback_coolify_force1.md`):** trigger-jouki-cz.yml **musí** mít `force=1` v Coolify URL, jinak Coolify dedupuje (trackuje jouki.cz repo, ne UnityChat) a build se nespustí.

### Debugging — UC_LOG instrumentation

UC má vlastní logging system. Logy se akumulují v service worker `_logs[]` (max 500, trim na 300, persist do `chrome.storage.session`), dump přes 💾 button v UC headeru nebo `window.ucDump()` v F12 sidepanel devtools.

**Soubor:** `Downloads/unitychat-debug.txt`

**Známé tagy** (filtruj přes Grep `\[TAG\]`):
- `Boot` — _bootMark fáze inicializace + heap size
- `DIAG` — rich diagnostic dump (config, providers, cache stats, per-user color/paint, last 30 msgs)
- `YT` — YouTube provider lifecycle
- `ShortEmote` — emoty s ≤3 char names (debugging mismatched emote names)
- `EmptyMsg` — empty-body drop diagnostic
- `PillClick` — credits pill click flow
- `RewardsPopover` — popover portal flow
- `HighlightDiag` — pin/raid/highlight DOM dump
- `Pin` — pin extractor DOM-walk
- `StreakSkip` — watch-streak text reject
- `EmoteFetch` — timeout/error emote a badge provider fetchů (url + elapsed ms); když boot stojí mezi `7TV globals loaded` a `channel emotes+badges loaded`, tady je viník

**Pattern když není instrumentace:** přidej UC_LOG tag jako separate `debug:` commit, požádej user o repro+dump, AŽ POTOM fix v dalším commitu. NE pokoušet se fix slepě.

**Watchdog auto-dump (v3.37.4):** pokud `BOOT_WATCH_END` nepřijde do 20s po `BOOT_WATCH_START`, background sám dumpne log bez user-click. Užitečné když panel freezne a 💾 button nereaguje.

### Dual-session synchronizace (`feedback_dual_session.md`)

Můžou současně běžet dvě Claude sessions:
1. **PC** (Windows, `D:\_BACKUP_2.0\Code Projects\UnityChat`)
2. **VPS** (`ssh root@178.104.160.182`, tmux session `uc`, remote-control přes claude.ai/code z mobilu)

**Disciplína:**
- VŽDY `git stash; git pull --rebase origin dev; git stash pop` před commitem (druhá session mohla pushnout)
- Pokud `git pull` hlásí conflict → NIKDY force, informovat usera
- Auto-sync skript (`scripts/auto-sync.ps1`) běží na PC, sleduje signal file z VPS, automaticky `git pull` na PC
- Při startu session ověř že auto-sync skript běží (`feedback_autosync_check.md`)
- Po update memory na VPS pošli VPS Claude instrukci aby si přečetl (`feedback_vps_claude_update.md`)

### Tools to prefer (Claude Code)

- File search: **Glob** (NE `find`/`ls`)
- Content search: **Grep** (NE `grep`/`rg`)
- Read: **Read** (NE `cat`/`head`/`tail`)
- Edit: **Edit** (NE `sed`/`awk`)
- Write: **Write** jen pro nové soubory (existující edituj přes Edit)
- Bash: jen pro git/gh/curl/test commands, NE pro file operace
- **Agent** s `subagent_type: Explore` pro broad codebase research, NE pro každý drobný lookup

### Critical locks (NEROZHRABÁVAT bez explicit user souhlasu)

⚠️ **Pin banner** — `memory/checkpoint_v3_38_26_pin_stable.md`. User explicit lock po sérii iterací v3.38.0 → v3.38.26.
- `fetchPins` GQL query shape (`GetPinnedChat`, ne `... on Emote { emoteID }` — Client-Integrity gate)
- `_mergePinCard` per-field picker order (DOM → cache → GQL)
- `_rerenderHighlights` posílá jen non-pin cards (GQL pin separately)
- `_lastGoodPinCache` update condition (full footer required)

⚠️ **Streamer OAuth tokens** — `memory/security_streamer_tokens.md`.
- AES-256-GCM encryption, master key v Coolify secrets
- **NIKDY** do gitu (public repo), **NIKDY** do logů, **NIKDY** vrátit z API
- Při návrhu OAuth flow přijde streamer-tokens téma — automaticky aplikovat security checklist

⚠️ **YouTube layout hide rules** — `memory/feedback_youtube_layout.md`.
- `hideYtChat()` MUSÍ mít 3 kroky: `#chat` off-screen (NE display:none, iframe by umřel), `#panels-full-bleed-container` display:none, theater mode na `ytd-watch-flexy`
- Bez toho jsou v UI artefakty co user už hlásil

### Memory system

Memory soubory v `~/.claude/projects/D---BACKUP-2-0-Code-Projects-UnityChat/memory/`:

- `MEMORY.md` — index, auto-loaded
- `checkpoint_*.md` — current state snapshots
- `feedback_*.md` — user explicit guidance
- `project_*.md` — work context, plans
- `security_*.md` — sensitive info, NEVER public
- `user_*.md` — user profile

**Update memory** když:
- User řekne "ulož to do paměti" / "pamatuj si"
- Naučím se nové preference / pravidlo
- Nový stable checkpoint dosažen
- Otevřené TODO se posune

**Dokumentační changelog:** každá update CLAUDE.md / memory / workflow → krátký záznam do "Changelog dokumentace" v `CLAUDE-HISTORY.md`. Cíl: nezávislý audit trail (memory restrukturalizace, oprava stale poznámky, přesun milestones nejsou vázané na source commit).

### VPS / backend

- SSH: `ssh root@178.104.160.182` (key: `C:\Users\mjouk\.ssh\id_ed25519`)
- Repo: `~/UnityChat`
- Backend dev server: port 3001, `tsx watch`, start script `/tmp/start-backend.sh`
- Postgres: Coolify resource `unitychat-db`, internal IP `10.0.1.7`
- DB shell: `docker exec aj70ceyvdhxuvhe07suo3q9y psql -U postgres -d unitychat`
- Tmux: `tmux attach -t uc` pro připojení k VPS Claude
- Detaily v `memory/project_vps_setup.md` + `SERVER.md` (lokální only, není v gitu)

### Common gotchas (rychlý seznam)

- **Twitch ZWS marker**: U+2800 (Braille blank), NE U+200B/200C/TAG. NE na commandy (`!`, `/`). Vždy za mezerou na konci.
- **YouTube CSP**: žádné inline scripts, pro page-context volání `chrome.scripting.executeScript({world:'MAIN'})` z background.
- **Kick CSP**: povoluje inline scripts, ale od v3.23.7 taky executeScript z background pro consistency.
- **7TV Vue handlers**: ignorují synthetic `.click()`. Use real-event sequence `pointerdown → mousedown → pointerup → mouseup → click` s `composed: true, clientX/Y`.
- **MV3 service worker spí**: `_logs[]` array se ztratí. Persist do `chrome.storage.session`. UC_LOG round-trip ack před DUMP_LOGS.
- **Twitch IRC tag value escaping**: `\s`→space, `\n`→space, `\r`→remove, `\:`→`;`, `\\`→`\`.
- **YouTube invalidation continuation**: nelze pollovat HTTP, je push-only. Skipnout kanály co dávají jen invalidation (vědomě nefixujeme).
- **Coolify force=1**: cross-repo deploy trigger MUSÍ mít, jinak dedup → silent fail.
- **Active tab detection**: `chrome.tabs.query({currentWindow: true})` v Opera popup vrací popup tab, ne hlavní. Use `_getActiveBrowserTab()` helper s `chrome.windows.getLastFocused({windowTypes:['normal']})`.
- **Backend za Traefikem = `trustProxy: true`** (od 0.5.0): bez něj je `req.ip` pro všechny klienty 10.0.1.2 a per-IP limity (`/chat/stream` 10 streamů, `/chat/history` 10 req/s) platí globálně — 2026-09-21 to shodilo YouTube stream na webu (429 pro všechny). SSE klienty uklízet i přes `reply.raw` 'close'/'error' + kontrolu mrtvého socketu při keepalive.

## Release workflow

- **Repo je veřejný** (public na GitHubu)
- **`dev`** = vývojová branch, vývoj probíhá zde
- **`master`** = production branch, release přes PR `dev → master`
- Dev branch se NIKDY nemaže při merge
- Push na `dev` → VPS dev API servíruje dev ZIP + manifest (jouki.cz/UnityChat/dev)
- Push/merge na `master` → Coolify auto-deploy produkce (jouki.cz/UnityChat)
- Auto-sync: webhook-driven (`/webhook/deploy` → VPS `git pull` + touch signal → PC `inotifywait` + `git pull`)
- `scripts/auto-sync.ps1` — systray ikona, balloon notifikace, spouští se automaticky při přihlášení
- `gh` CLI autentizovaný na VPS i PC — oba mohou vytvářet PR

## Nové features (v3.13+)

### Optimistic message upgrade
- Při odeslání zprávy se okamžitě zobrazí optimistická zpráva (barva, badges z posledních známých)
- Když dorazí IRC echo, `_upgradeOptimistic()` aktualizuje barvu, badges, ID a cache entry
- `_upgradeOptimistic` zachovává UnityChat custom color přes IRC echo color (v3.23.10)
- Content dedup: optimistické zprávy vždy projdou, scraped se zahazují, IRC echo upgraduje

### Message history (ArrowUp/Down)
- `_msgHistory` array (max 50 zpráv)
- ArrowUp/Down listuje historii (jako terminal/CMD)
- Draft text se uloží při vstupu do historie, obnoví se při ArrowDown za konec
- Po reloadu se historie naplní z cached zpráv (matchuje username varianty)

### 7TV Zero-width emote stacking
- `emote.flags & 1` detekuje zero-width emoty při loadingu 7TV API
- Base emote + ZW overlays se zabalí do `<span class="emote-stack">` (CSS grid, `grid-area: 1/1`)
- Šířku containeru určuje nejširší emote, všechny vycentrované
- Lookahead: whitespace mezi base a ZW emotem neuzavírá stack

### StreamElements integration
- `GET /kappa/v2/channels/{channel}` → SE channel ID
- `GET /kappa/v2/bot/commands/{seId}` → seznam bot commands (veřejné, bez auth)
- `!` autocomplete na začátku zprávy
- Easter egg: "Bulgarians a pojedeš..." zpráva je klikatelná → přehraje audio

### IRC ACTION (/me) parsing
- `\x01ACTION text\x01` detekován v IRC PRIVMSG
- Text renderován kurzívou v barvě usernamu (`.msg.action .tx { font-style: italic }`)

### Right-side message tags
- `.msg-tag-line` div s right-aligned tagy nad obsahem zprávy
- Typy: Replying to you, Mentions you, First message, Raid, Raider, Suspicious
- `/uc` mock commands pro testování (raid, raider, first, sus)

### Settings UI (v3.18.29+)
- Username field readonly (editovatelný v Dev mode)
- Merged save button pro nickname + color (vycentrovaný)
- `autocomplete="off"` na všech inputech, depersonalizované placeholdery
- Status dot tooltipy: "Twitch - Connected/Connecting.../Disconnected"
- Odstraněn "Vše" filtr button

### Color UI (v3.23.8–v3.23.10)
- "Barva jména" label zobrazuje platformu v závorce: "Barva jména (Twitch)" / "(YouTube)" / "(Kick)"
- `_refreshColorUI(platform)` — unified logika pro aktualizaci color UI
- `_platformDefaultColor(platform)` — YouTube default `#ff0000`, Twitch/Kick = IRC color
- Custom color (z UnityChat profilu) → reálná hodnota v poli (bílý text)
- Bez custom color → prázdné pole, placeholder s default hex (šedý), picker reflektuje default
- Settings UI se refreshne když platform username dorazí asynchronně

### Profile sync (v3.23.2+)
- `_syncProfile(platform, username)` — odesílá nové usernames na backend (`POST /users/seen`)
- `_syncedProfiles` Set + `uc_synced` v `chrome.storage.local` pro local dedup
- Odesílá jen usernames co nejsou v lokálním seznamu; při selhání odstraní z lokální sady pro retry
