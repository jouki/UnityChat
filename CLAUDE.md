# UnityChat - Chrome/Opera Extension + Backend v3.12.3

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
│   ├── sidepanel.js            # ~2000 řádků - UI/messaging logika
│   ├── content/
│   │   ├── twitch.js           # Twitch DOM (Slate editor) + scrape + reply
│   │   ├── youtube.js          # YouTube live_chat iframe + API fallback
│   │   └── kick.js             # Kick DOM + API fallback
│   └── icons/                  # 16/48/128 PNG (oranžový gradient logo)
├── landing/                 # jouki.cz under-construction static page
│   ├── index.html              # Gaming HUD aesthetic, Orbitron + JetBrains Mono
│   ├── nginx.conf              # Nginx static server config
│   └── Dockerfile              # nginx:alpine + curl for Coolify healthcheck
├── backend/                 # Node.js + Fastify + Drizzle + Postgres API server
│   ├── src/
│   │   ├── server.ts           # Fastify entry point + health endpoints
│   │   ├── config.ts           # Zod env validation
│   │   └── db/
│   │       ├── index.ts        # Drizzle client + pingDb
│   │       └── schema.ts       # users, platform_identities, messages, events
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

| | Chrome | Opera |
|---|---|---|
| `chrome.sidePanel` API | ✅ dostupné | ❌ undefined |
| `HAS_SIDE_PANEL` | `true` | `false` |
| UI open flow | `setPanelBehavior({ openPanelOnActionClick: true })` → native side panel | `chrome.action.onClicked` → `chrome.windows.create({ type: 'popup' })` |
| Manifest `sidePanel` permission | aktivní | Opera (Chromium-based) přijímá, ale API nepoužívá |
| Manifest `side_panel` key | Chrome load | Opera ignoruje (neznámý key, warning) |

Side panel JS používá `_getActiveBrowserTab()` který volá `chrome.windows.getLastFocused({ windowTypes: ['normal'] })` - funguje pro oba scénáře (Chrome side panel i Opera popup).

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
- YouTube: `yt-formatted-string#channel-handle`

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
2. **Kick API** (chat zavřený): inject `<script>` do page kontextu (Kick CSP povoluje inline) → `POST /api/v2/messages/send/{chatroomId}` s XSRF-TOKEN z cookies

### content script auto-injection
- `background.js` `chrome.runtime.onInstalled` → injektuje do otevřených tabů
- `sidepanel.js` `_injectContentScript(tab)` → on-demand injection pokud PING neodpoví
- Wrapper `if (window._ucXxx) return;` proti duplicitní inicializaci
- Uživatel NEMUSÍ refreshovat stránku po update

## background.js

**Service worker handlers:**
- `chrome.runtime.onInstalled` → auto-inject content scriptů
- `OPEN_USER_CARD` → executeScript MAIN world (klikání na DOM)
- `TW_REPLY` → GQL mutace `SendChatMessage` s reply ID
- `YT_SEND` → executeScript MAIN world (CSP bypass pro YouTube)
- `LOAD_BADGES` → IVR API fetch (Twitch badge images)
- `PIN_MESSAGE` → GQL mutace `PinChatMessage` + follow-up dotaz pro pin entity ID
- `CHECK_PIN` → GQL `channel.pinnedChatMessages` polling
- `DUMP_LOGS` → uloží `_logs` array do `Downloads/unitychat-debug.log` přes `chrome.downloads`
- `UC_LOG` → relay log zpráva ze side panelu

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
7tv.io, cdn.7tv.app                                               # 7TV API + CDN
static-cdn.jtvnw.net                                              # Twitch emote CDN
files.kick.com                                                    # Kick emote CDN
api.betterttv.net, cdn.betterttv.net                              # BTTV
api.frankerfacez.com, cdn.frankerfacez.com                        # FFZ
```

## Verzování
- Verze v `extension/manifest.json` → titulek side panelu (`chrome.runtime.getManifest().version`)
- Bumpovat jediný manifest při release
- Aktuální: **v3.12.2**

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

## Backend (v0.1.0)

Node.js 22 + TypeScript (ESM) + Fastify 5 + Drizzle ORM + PostgreSQL 18. Nasazeno přes Coolify na Hetzner VPS, build z `backend/` subdirectory v monorepu.

### Schema
| Tabulka | Popis |
|---|---|
| `users` | Kanonický záznam uživatele (jeden per osoba, ne per platforma) |
| `platform_identities` | Vazba uživatele na Twitch/YouTube/Kick handle (many-to-one) |
| `messages` | Všechny chat zprávy s UC marker detekcí, reply context, raw segmenty |
| `events` | Stream events: raidy, piny, first-time chatters, bany, timeouty |

### Endpoints (v0.1.0)
- `GET /` — service info
- `GET /health` — liveness, uptime
- `GET /health/db` — DB connectivity (503 pokud down)

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
