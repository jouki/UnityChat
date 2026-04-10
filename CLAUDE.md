# UnityChat - Chrome Extension v2.3.0

## Popis projektu
Chrome extension (Manifest V3) sjednocující live chat z **Twitch**, **YouTube** a **Kick** do jednoho side panelu. Inspirováno Truffle extension. Primárně vyvíjeno pro streamera **robdiesalot** (stejný username na všech platformách).

## Struktura souborů
```
UnityChat/
├── manifest.json           # Manifest V3, permissions, content_scripts
├── background.js           # Service worker: side panel + YouTube API proxy
├── sidepanel.html          # UI side panelu (header, settings, chat, input)
├── sidepanel.css           # Styling (dark theme, Twitch-inspired)
├── sidepanel.js            # Hlavní logika (~1700+ řádků)
├── content/
│   ├── twitch.js           # Content script pro Twitch (DOM + Slate editor)
│   ├── youtube.js          # Content script pro YouTube (DOM + API proxy)
│   └── kick.js             # Content script pro Kick (DOM + Kick API)
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── CLAUDE.md               # Tento soubor
```

## Architektura sidepanel.js

### Konstanty
- `UC_MARKER = '\u2800'` — Braille Pattern Blank, neviditelný marker pro identifikaci UnityChat uživatelů. Přidává se jako `text + ' ' + marker` na konec odeslaných zpráv (NE na commandy začínající `!` nebo `/`). Jiné instance UnityChat ho detekují a obarví platform badge na oranžovo.
- `DEFAULTS` — defaultní konfigurace: `channel: 'robdiesalot'`, `ytChannel: 'robdiesalot'`, `username: ''`

### EmoteManager
Spravuje emoty z 6 zdrojů a segment-based rendering.

**Emote mapy (name → URL):**
| Mapa | Zdroj | Načtení |
|------|-------|---------|
| `global7tv` | 7TV globální | `7tv.io/v3/emote-sets/global` při startu |
| `channel7tv` | 7TV kanálové | `7tv.io/v3/users/{platform}/{userId}` po připojení |
| `bttvEmotes` | BTTV global+channel | `api.betterttv.net/3/cached/...` po room-id |
| `ffzEmotes` | FFZ global+channel | `api.frankerfacez.com/v1/...` po room-id |
| `twitchNative` | Twitch IRC emotes | Naučené z `emotes` tagu příchozích zpráv |
| `kickNative` | Kick emotes | Naučené z `[emote:ID:NAME]` v příchozích zprávách |

**Emote CDN URL formáty:**
- 7TV: `https://cdn.7tv.app/emote/{id}/1x.webp`
- BTTV: `https://cdn.betterttv.net/emote/{id}/1x`
- FFZ: `https://cdn.frankerfacez.com/emote/{id}/1`
- Twitch: `https://static-cdn.jtvnw.net/emoticons/v2/{id}/default/dark/1.0`
- Kick: `https://files.kick.com/emotes/{id}/fullsize`

**Rendering pipeline (segment-based):**
1. Zpráva → platform-specifický parser → segmenty `[{ type:'text'|'emote', value, url? }]`
2. `renderSegments()` — textové segmenty → 7TV/BTTV/FFZ matching → emote segmenty
3. `_toHtml()` — segmenty → HTML s `<img class="emote">` tagy

**Platform parsery:**
- `renderTwitch(text, emotesTag)` — pozice z IRC `emotes` tagu → `_splitTwitchEmotes()`
- `renderKick(htmlContent)` — `_parseKickHtml()` → `[emote:ID:NAME]` tagy + HTML `<img>`
- `renderYouTube(runs)` — YouTube `runs` array s emoji thumbnaily
- `renderPlain(text)` — jen 7TV/BTTV/FFZ matching

**Tab autocomplete:**
- `findCompletions(prefix)` — case insensitive, prohledává všech 6 map
- Pořadí: 7TV channel → 7TV global → BTTV → FFZ → Twitch native → Kick native
- Řazení: exact case match → abecedně
- `getAnyUrl(name)` — vrátí URL z jakéhokoliv zdroje (pro preview)

### TwitchProvider
Anonymní IRC WebSocket na `wss://irc-ws.chat.twitch.tv:443`.

- Login: `justinfan{random}` (read-only)
- CAP REQ: `twitch.tv/tags twitch.tv/commands`
- Parsuje tagy: `display-name`, `color`, `badges`, `emotes`, `room-id`, `reply-parent-*`
- `room-id` z ROOMSTATE → spouští načtení 7TV/BTTV/FFZ kanálových emotes
- `reply-parent-display-name` + `reply-parent-msg-body` → reply context
- Tag value unescaping: `\s`→space, `\n`→space, `\r`→remove, `\:`→`;`, `\\`→`\`
- Reply zprávy: stripuje `@username` prefix z message textu (emote pozice invalid → renderPlain)
- Auto-reconnect 5s, PING/PONG keep-alive

### KickProvider
Dvoustupňové připojení:
1. `GET https://kick.com/api/v2/channels/{channel}` → `chatroom.id`, `user_id`
2. Pusher WebSocket: `wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679`
3. Subscribe: `chatrooms.{chatroomId}.v2`, event: `App\Events\ChatMessageEvent`

- `user_id` → 7TV channel emotes (fallback pokud Twitch ještě nenačetl)
- Message content: plain text, HTML `<img>`, nebo `[emote:ID:NAME]` tagy
- `_textOnly(html)` — plain text fallback, `kickContent` — surový obsah pro rendering
- Ping 30s, auto-reconnect 5s

### YouTubeProvider
Dual polling — interní API + page refresh fallback.

**Připojení:**
1. Fetch `/{channel}/live` nebo `/@{channel}/live` → `videoId` + `isLive` check
2. Fetch `/live_chat?v={videoId}` → `ytInitialData` parsing
3. **JSON extraction: brace counting** (NE regex `{.+?}` — selže na vnořeném JSON)
4. Extrakce: `continuation`, `INNERTUBE_API_KEY`, `clientVersion`, `visitorData`
5. Continuation preference: `timedContinuationData` > `reloadContinuationData` > `invalidationContinuationData`

**Polling režimy:**
1. **API polling** (primární): `POST /youtubei/v1/live_chat/get_live_chat`
   - Headers: `X-YouTube-Client-Name: 1`, `X-YouTube-Client-Version`
   - AbortController timeout 15s
   - `_apiFails` counter → po 3-5 prázdných odpovědích přepne na page refresh
2. **Page refresh** (fallback): znovu-načtení `/live_chat` stránky každých 6s
   - Spolehlivější ale pomalejší

**Známé problémy:**
- YouTube interní API se může kdykoliv změnit
- `invalidationContinuationData` vyžaduje push notifikace, nefunguje s HTTP polling
- YouTube chat musí být live (ne replay/premiere)

### UnityChat (hlavní třída)
UI, messaging, autocomplete, odpovědi, cache.

**Konfigurace** (`chrome.storage.sync`, klíč `uc_config`):
```json
{
  "channel": "robdiesalot",
  "ytChannel": "robdiesalot",
  "username": "Jouki728",
  "twitch": true,
  "youtube": true,
  "kick": true,
  "maxMessages": 500
}
```

**Verze v titulku:** `chrome.runtime.getManifest().version` → `⚡ UnityChat v2.3.0`

**@Mention zvýraznění:**
- Kontroluje `msg.message.includes('@' + username)` (case insensitive)
- + `msg.replyTo?.username === username` (reply na tvou zprávu)
- CSS: `.msg.mentioned` — oranžový border-left + light background

**Reply context (Twitch):**
- IRC tagy: `reply-parent-display-name`, `reply-parent-msg-body`
- UI: `↩ @Username text_původní_zprávy` nad zprávou
- Reply message text: stripnutý `@username` prefix (Twitch ho přidává automaticky)

**UC Badge:**
- Odeslaná zpráva: `text + ' ' + UC_MARKER` (Braille blank na konci)
- Přijatá zpráva: `msg.message.includes(UC_MARKER)` → oranžový platform badge (`.pi.uc`)
- Commandy (`!`, `/`): marker se nepřidává (rozbilo by boty)
- Marker se stripuje z displeje

**Hover reply tlačítko:**
- `.msg-actions` — absolutně pozicovaný div v pravém horním rohu zprávy
- Zobrazí se na `:hover`, obsahuje ↩ reply button
- Klik → `_setReply(platform, username)` → reply indicator nad inputem

**Emote autocomplete (suggest list):**
- Tab / Shift+Tab — navigace, Escape — zavřít
- `.es-item` — obrázek + název + zdroj (7TV/BTTV/FFZ/Twitch/Kick)
- Okno 4 viditelných položek, scroll při navigaci
- Po výběru: vloží emote + mezeru, cursor za mezerou
- Klik na položku → výběr
- Modifier klávesy (Shift, Ctrl, Alt) samy o sobě neruší suggest list
- Dlouhé názvy: `text-overflow: ellipsis`, hover → CSS scroll animace

**Message cache:**
- `chrome.storage.local`, klíč `uc_messages`
- Max 200 zpráv, ořezává na 150 při překročení
- Debounce 500ms + `beforeunload` handler pro okamžité uložení
- Načítá se v `_init()` před připojením k platformám

## Content scripty

### content/twitch.js
- Selektory: `[data-a-target="chat-input"] [contenteditable="true"]`, textarea fallback
- Slate editor: DataTransfer paste (primární), InputEvent beforeinput, execCommand (fallback)
- Send button: `[data-a-target="chat-send-button"]`, Enter fallback

### content/youtube.js
1. **Live chat iframe** (chat otevřený): přímý DOM přístup, `execCommand('insertText')`
2. **Main frame iframe access** (chat skrytý): `frame.contentDocument` → DOM
3. **YouTube API** (chat zavřený): `chrome.runtime.sendMessage({ type: 'YT_SEND' })` → background.js → `chrome.scripting.executeScript({ world: 'MAIN' })` — obchází YouTube CSP

### content/kick.js
1. **DOM** (chat otevřený): `#message-input`, React setter / execCommand
2. **Kick API** (chat zavřený): page injection (`document.createElement('script')`) → `POST /api/v2/messages/send/{chatroomId}` s XSRF-TOKEN z cookies. Kick CSP povoluje inline scripty.

### content script auto-injection
- `background.js` → `chrome.runtime.onInstalled` → injektuje do otevřených tabů
- `sidepanel.js` → `_injectContentScript(tab)` → on-demand injection pokud PING neodpoví
- Uživatel NEMUSÍ refreshovat stránku po update extension

## background.js
1. `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`
2. `chrome.runtime.onInstalled` → auto-inject content scripts
3. `YT_SEND` message handler → `chrome.scripting.executeScript({ world: 'MAIN' })` → YouTube API v page kontextu (session cookies, ytcfg)

## Permissions
- `sidePanel` — side panel API
- `storage` — config (sync) + message cache (local)
- `tabs` — detekce aktivního tabu
- `scripting` — auto-injection + YouTube API proxy (world: MAIN)

## Host Permissions
```
https://kick.com/*              # Kick API + channel info
https://www.youtube.com/*       # YouTube stránky + API
https://youtube.com/*           # YouTube alternativní doména
wss://irc-ws.chat.twitch.tv/*  # Twitch IRC WebSocket
https://7tv.io/*                # 7TV API
https://cdn.7tv.app/*           # 7TV emote CDN
https://static-cdn.jtvnw.net/* # Twitch emote CDN
https://files.kick.com/*        # Kick emote CDN
https://cdn.betterttv.net/*     # BTTV emote CDN
https://api.betterttv.net/*     # BTTV API
https://api.frankerfacez.com/*  # FFZ API
https://cdn.frankerfacez.com/*  # FFZ emote CDN
https://www.twitch.tv/*         # Twitch content script
https://twitch.tv/*             # Twitch alternativní doména
```

## Verzování
- Verze v `manifest.json` → zobrazuje se v titulku side panelu
- Bumpovat při každé změně
- Aktuální: **v2.3.0**

## Známé limitace
- YouTube interní API je nestabilní, může se kdykoliv změnit
- Zero-width Unicode znaky (U+200B, U+200C, TAG chars) Twitch stripuje — UC marker používá Braille blank (U+2800)
- UC marker na konci zprávy může ovlivnit trailing emoty (proto je za mezerou: `text + ' ' + marker`)
- UC marker se nepřidává na commandy (!, /) aby nerozbil boty
- Twitch native emoty se učí z chatu (nejsou pre-loaded) — globální Twitch emoty typu Kappa se objeví v autocomplete až poté co je někdo použije v chatu
- BTTV + FFZ emoty se načítají jen pro Twitch kanál (ne Kick/YouTube)
- YouTube chat polling může mít zpoždění 2-6s oproti real-time
