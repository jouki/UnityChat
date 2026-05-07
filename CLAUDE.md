# UnityChat - Chrome/Opera Extension + Backend v3.37.3

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
│   ├── sidepanel.js            # ~3000 řádků - UI/messaging logika
│   ├── backup.html             # Export/import extension data (sync + local storage)
│   ├── backup.js               # Backup logic (external JS, MV3 CSP blocks inline)
│   ├── update.bat              # One-click updater (stáhne ZIP, přepíše soubory)
│   ├── audio/
│   │   └── streamelements-bulgarians.mp3  # Easter egg audio
│   ├── content/
│   │   ├── twitch.js           # Twitch DOM (Slate editor) + scrape + reply
│   │   ├── youtube.js          # YouTube live_chat iframe + API fallback
│   │   └── kick.js             # Kick DOM + API fallback
│   └── icons/                  # 16/48/128 PNG (oranžový gradient logo)
├── landing/                 # jouki.cz root + /UnityChat install page
│   ├── index.html              # Root page (under construction, gaming HUD aesthetic)
│   ├── nginx.conf              # Nginx static server config (case-insensitive /UnityChat)
│   ├── Dockerfile              # nginx:alpine, zips extension/, healthcheck
│   └── unitychat/              # /UnityChat install page
│       ├── index.html          # Install guide: hero+preview, steps, features, FAQ
│       ├── preview.html        # Iframe mockup using real sidepanel.css
│       └── assets/
│           ├── brand/unitychat-logo.png  # 512px polished logo for hero branding
│           ├── badges/         # broadcaster, moderator, chatbot, vip, partner PNG
│           ├── emotes/         # kappa, lul, kreygasm, ragey(7TV), waytoodank(7TV)
│           ├── audio/          # streamelements-bulgarians.mp3 (click-to-play demo)
│           ├── chrome-extension-card.png
│           └── chrome-extensions-header.png
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

Manifest obsahuje **oba side panel mechanismy** (`side_panel` pro Chrome + `sidebar_action` pro Operu). Každý browser vezme ten svůj, druhý ignoruje jako neznámý key (jen warning, extension se načte OK).

| | Chrome | Opera |
|---|---|---|
| `chrome.sidePanel` API | ✅ dostupné | ❌ undefined |
| `HAS_SIDE_PANEL` | `true` | `false` |
| Primary UI entry | native side panel přes `setPanelBehavior({ openPanelOnActionClick: true })` | native Opera sidebar přes `sidebar_action` manifest key (user si připne přes "Customize sidebar") |
| Secondary UI entry | n/a (sidebar = main) | toolbar action → `chrome.windows.create({ type: 'popup' })` (pro userů co sidebar nepoužívají) |
| Manifest `sidePanel` permission | aktivní | Opera (Chromium-based) přijímá syntakticky, ale API nepoužívá |
| Manifest `side_panel` key | Chrome load | Opera ignoruje |
| Manifest `sidebar_action` key | Chrome ignoruje (unknown key warning) | Opera load |

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

**Message cache:**
- `chrome.storage.local`, klíč `uc_messages`
- Max 200 zpráv, ořezává na 150
- Debounce 500ms zápis + `beforeunload` handler pro okamžité uložení
- Načítá se v `_init()` PO emote loading (aby se renderovaly s emoty)

**Globální dedup:**
- `_seenMsgIds` - dedup podle msg.id (cache + live)
- `_seenContentKeys` - normalized `username|first80chars` pro scraped zprávy
- Boundary detection při scrape: najít poslední cached zprávu v scraped DOM, vzít jen vše PO ní

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

**Twitch chat scrape:**
- Po `_connectAll` (1.5s delay) zavolá `_scrapeExistingChat`
- Pošle `SCRAPE_CHAT` na všechny Twitch taby
- Content script parsuje `.seventv-message, .chat-line__message` selektory
- Extrahuje username, color, message text
- Boundary detection: najít poslední cached zprávu v scraped → vzít jen vše PO ní
- Synthetic IDs `scraped-N-timestamp`

## Content scripty

### content/twitch.js
**Send chat:**
1. `findInput()` selektory: `[data-a-target="chat-input"] [contenteditable="true"]`, textarea fallback
2. Slate editor: DataTransfer paste primary → InputEvent beforeinput → execCommand fallback
3. Send button: `[data-a-target="chat-send-button"]`, Enter fallback

**Scrape chat:**
- Iteruje `.seventv-message, .seventv-chat-line, .chat-line__message`
- Extrahuje username z `.seventv-chat-user-username, [data-a-user]`
- Color z `.seventv-chat-user style`
- Text z `.seventv-message-body, .text-fragment, [data-a-target="chat-message-text"]`
- Synthetic timestamps + ID

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
- Aktuální: **v3.37.3**

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
- `_seenContentKeys` pro scraped messages (synthetic IDs nematchují)
- Boundary detection při scrape - najít poslední cached match
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

## Landing page (jouki.cz/UnityChat)

Statická install stránka na `jouki.cz/UnityChat` (case-insensitive). Nasazena jako nginx container přes Coolify, auto-deploy z GitHub pushů (webhook na `landing/**` a `extension/**`).

### Architektura
- `landing/unitychat/index.html` — hlavní install page (Orbitron + JetBrains Mono, gaming HUD)
- `landing/unitychat/preview.html` — iframe mockup (načítá `extension/sidepanel.css` pro pixel-accurate rendering)
- `landing/Dockerfile` — base_directory je `/` (repo root), zipuje extension/ pro download, kopíruje sidepanel.css + icons z extension/

### Dockerfile build kontext
```dockerfile
# Base directory v Coolify = "/" (repo root)
# Dockerfile location = "/landing/Dockerfile"
FROM alpine:3 AS zipper    # zipuje extension/ → unitychat.zip
FROM nginx:alpine           # runtime
COPY landing/unitychat → /unitychat        # install page
COPY extension/sidepanel.css → /unitychat/assets/sidepanel.css  # real CSS for preview
COPY extension/icons → /unitychat/assets/icons
COPY unitychat.zip → /download/unitychat.zip
COPY extension/manifest.json → /download/manifest.json
```

### Nginx routing
```nginx
location ~* ^/unitychat/?$   # case-insensitive → /unitychat/index.html
location /unitychat/          # static files
location = /download/unitychat.zip  # Content-Disposition: attachment
```

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

## Backend (v0.2.0)

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

### Dev
```bash
cd backend
npm install
cp .env.example .env
# nastavit DATABASE_URL na lokální Postgres
npm run db:push    # apply schema to DB
npm run dev        # hot reload na :3000
```

### Deploy
Coolify Application resource nastavený s Base Directory `backend/`, build z `Dockerfile`. `DATABASE_URL` injectnutý Coolify přes "magic" env variable napojenou na `unitychat-db` Postgres resource na stejné Docker síti.

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
- **v3.38.54** - **Highlight banner doubled-text dedup**: "Sdílený chat byl spuštěn!" v UC banner zobrazoval text 2× ("Sdílený chat byl spuštěn!Sdílený chat byl spuštěn!"). String není v UC kódu — Twitch DOM má phrase 2× v textContent (visible + aria/sr-only nebo 7TV overlay). Defensive heuristic v `snapshotHighlights`: pokud `textContent` má sudou délku ≥ 10 a první polovina === druhá polovina, trim na 1 kopii. Plus UC_LOG `HighlightDup` co loguje outerHTML při dedupu pro budoucí targeted DOM filter. **Aktuální verze (dev)**

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

## Release workflow

- **Repo je veřejný** (public na GitHubu)
- **`dev`** = vývojová branch, vývoj probíhá zde
- **`master`** = production branch, release přes PR `dev → master`
- Dev branch se NIKDY nemaže při merge
- Push na `dev` → VPS dev API servíruje dev ZIP + manifest (jouki.cz/UnityChat/dev)
- Push/merge na `master` → Coolify auto-deploy produkce (jouki.cz/UnityChat)
- `update.bat` v extension složce — one-click updater pro uživatele
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

### Backup utility (v3.23.12)
- `extension/backup.html` + `extension/backup.js` — export/import veškerých extension dat (`chrome.storage.sync` + `local`)
- External JS soubor (MV3 CSP blokuje inline skripty)
- Export přes `chrome.downloads` API (saveAs dialog)
