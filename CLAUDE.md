# UnityChat - Chrome/Opera Extension + Backend v3.23.13

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
- Aktuální: **v3.23.13**

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
- **v1.x** - základní 3 platformy, 7TV emoty, side panel
- **v2.0** - hover replies, mention highlight, reply context
- **v2.5** - skutečné Twitch badge images, native reply via GQL
- **v3.0** - GQL endpoint místo Helix (auth-token cookie), draggable user card fallback
- **v3.3** - User card v chatter listu, 7TV custom element discovery
- **v3.5** - Layout sizes, smooth scroll, accent gradient, BETA tag
- **v3.6** - Pin message + GQL mutace
- **v3.7** - Klikatelné reply context + flash animace, raid notifications, first-msg
- **v3.8** - Pinned banner s polling detekcí unpinu
- **v3.9** - Autocomplete arrow keys + scroll only when overflowing
- **v3.10** - Twitch chat scrape + boundary detection
- **v3.11** - Opera verze + Opera-compatible active tab detection
- **v3.12** - Pop-out button, platform badge tooltipy, single-source `extension/` (chrome+opera merge), build script, backend scaffold (Node.js + Fastify + Drizzle + Postgres)
- **v3.12.2** - Unified `extension/` bez build kroku: jeden `manifest.json` + `background.js` s runtime `HAS_SIDE_PANEL` feature-detection. Chrome používá native side panel, Opera spadne na popup window. Load unpacked z `extension/` přímo v obou browserech, žádné build skripty, žádný `dist/`.
- **v3.12.3** - Platform badge tooltip přepsán na JS-positioned `.uc-tooltip` s viewport clamping (fix pro ořez u okrajů side panelu).
- **v3.12.4** - Opera native sidebar support přes `sidebar_action` manifest key. Opera users si teď mohou připnout UnityChat přímo do Opera levého sidebaru (vedle Messenger/Twitch/atd.). Chrome ignoruje unknown key, používá dál `side_panel`. Popup window fallback zůstává pro Operu jako sekundární entry point.
- **v3.12.5** - Twitch chat header button (UnityChat logo v chatu, klik otevře side panel), `OPEN_SIDE_PANEL` background handler s user-gesture propagací, `web_accessible_resources` pro ikony. jouki.cz/UnityChat install page: hero s 512px brand logem, funkční platform filtry v preview mockupu, click-to-play audio na StreamElements zprávě, animované FAQ, click-to-copy chrome:// URL.
- **v3.13–v3.18** - Nickname system (SSE real-time push, DB), per-channel cache (72h TTL), dev mode, @username auto-suggest, per-platform username tracking, YouTube username detekce, optimistic messages, UC button na YouTube, per-platform colors
- **v3.18.26** - Optimistic → real message upgrade (`_upgradeOptimistic`), `_savePlatformColor` jen pro vlastní zprávy, emotes+badges load PŘED cache
- **v3.18.29** - Settings UI: merged save button pro nickname+color, readonly username (dev mode), depersonalizované placeholdery, autocomplete=off, status dot tooltipy, odstraněn "Vše" filtr
- **v3.18.35** - Twitch display-name z IRC (ne login cookie), color save fix, backend rate limit 10s
- **v3.18.38** - Nickname lookup pro VŠECHNY zprávy (ne jen UC-marked)
- **v3.19.0** - Message history (ArrowUp/Down jako terminal, max 50, draft preserved)
- **v3.19.1** - Optimistic badges z posledních známých badges uživatele
- **v3.19.6** - Copy button (SVG clipboard ikona, trailing space pro emote stacking)
- **v3.19.7–v3.19.14** - 7TV zero-width emote layering (CSS grid stacking, lookahead pro whitespace)
- **v3.20.0** - StreamElements !command autocomplete (SE public API), bulgarians easter egg (click-to-play audio)
- **v3.20.1** - Tab autocomplete: první TAB potvrdí výběr, pak cykluje
- **v3.20.2** - IRC ACTION (/me) parsing — kurzíva + barva usernamu
- **v3.21.0** - Right-side message tags (Replying to you, Mentions you, First, Raid, Raider, Sus), /uc mock commands
- **v3.21.2** - Scraper DOM walker — extrahuje emote alt text pro správný content dedup
- **v3.21.4** - Raider tag color: yellow-green (#b2e63d)
- **v3.21.5** - Raider background+border shift to yellow-green
- **v3.21.6** - `/uc` command autocomplete (raid, raider, first, sus)
- **v3.22.0–v3.22.5** - UC button toggle (open/close side panel), YouTube native theater button, port-based panel state tracking, window.close() via port
- **v3.23.0** - UnityChat custom emotes (`ucEmotes` Map, first: CaneBear), preview Fremaner message
- **v3.23.1** - Retroactive color update po save, Ko-fi link, active-badge styling, nickname API normalizace
- **v3.23.2–v3.23.3** - Profile sync (`_syncProfile`), `seen_users` tabulka + `POST /users/seen` endpoint, `_syncedProfiles` Set s local dedup (`uc_synced` v chrome.storage.local)
- **v3.23.4–v3.23.6** - YouTube username detekce: avatar menu click fallback (klik avatar → `#channel-handle` → Escape), content script cache per URL s `MutationObserver` + `popstate` invalidací, settings UI refresh při async příchodu platform username
- **v3.23.7** - Security hardening: GQL parameterized variables, createElement/textContent místo innerHTML, Kick send přes background `KICK_SEND` + executeScript (ne inline `<script>`), YouTube postMessage se specifickým origin, `CSS.escape()` pro username selektory, `_sc()` sanitizace barev, UC_API na `https://api.jouki.cz`, odstranění raw IP z host_permissions
- **v3.23.8–v3.23.10** - Color UI: "Barva jména (platform)" label, `_refreshColorUI(platform)`, `_platformDefaultColor(platform)` (YT default #ff0000), custom color → real value / no custom → placeholder s default hex, `_upgradeOptimistic` zachovává UC custom color
- **v3.23.11** - `GET /users` merged endpoint (seen_users + nicknames), `backend/src/routes/users.ts`
- **v3.23.12** - Backup utility (`extension/backup.html` + `backup.js`): export/import chrome.storage sync+local, external JS (MV3 CSP), export přes chrome.downloads API (saveAs dialog)
- **v3.23.13** - Profile sync s local dedup + merged users endpoint, repo public, aktuální verze

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
