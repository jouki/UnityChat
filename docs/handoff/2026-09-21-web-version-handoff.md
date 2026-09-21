# Handoff: webová verze UnityChat (2026-09-21)

> Přepis rozhodnutí a ověřených faktů ze session vedené ve složce RobJewsALot.
> Účel: nová session v UnityChat začíná odsud, nic z toho níže nemusí znovu zjišťovat.
> Nic v tomto souboru není implementované. Je to výchozí stav pro brainstorming a spec.

## 1. Co user chce

- **Experimentální stránka**, zatím u sebe, později přímo na **robdiesalot.com**.
- Jednou z jejích částí bude **webová verze UnityChatu** (dnes browser extension).
- Stránka bude časem potřebovat i další věci spojené s Robem (donate data, Hall of Fame,
  goaly), které žijí v repu **RobJewsALot** (= userův hub pro projekty kolem Roba).

## 2. Rozhodnutí (závazná)

| Otázka | Rozhodnutí | Důvod |
|---|---|---|
| Kde webová verze žije | **V repu UnityChat** (nová složka vedle `extension/` a `backend/`) | Sdílený kód s extensionem má prioritu nad blízkostí k RobJewsALot souborům. Data z RobJewsALot půjdou přes API. |
| Samostatná branch `UnityChatWeb` | **Ne** | Větve jsou na sloučení. Dvě trvale žijící varianty = ruční cherry-pick oběma směry a konflikty. Přesný opak požadavku „změna se propíše do obou“. |
| Složka v RobJewsALot | **Ne** (zvažováno, zamítnuto userem) | User zvolil UnityChat. |
| **Pravidlo portování** | Když se v jedné variantě (addon / web) implementuje **obecná funkcionalita**, AI **musí** buď (a) implementovat ji ve sdíleném core, nebo (b) **zeptat se usera**, zda ji chce portovat i do druhé varianty. Platí oběma směry. Nikdy tiše nechat jednu variantu pozadu. | Explicitní zadání usera 2026-09-21. Je v pořádku se ptát; není v pořádku zapomenout. |

Zatím **nerozhodnuto** (viz §5): stack webu, způsob doručení live zpráv na webu,
posílání zpráv z webu, kdy se ptát na port (před implementací / po ní / portovat rovnou).

## 3. Navržená architektura (doporučení, ne rozhodnutí)

Jedno repo, jeden sdílený core, dvě tenké slupky:

```
UnityChat/
├── extension/
│   ├── core/          # NOVÉ: platformově nezávislé ES moduly, bez buildu, bez chrome.*
│   │                  #   kandidáti: chat-store.js (už dnes bez DOM/chrome, testovaný v Node),
│   │                  #   EmoteManager, IRC parser z TwitchProvider, Kick Pusher client,
│   │                  #   formátování zpráv, badge, nastavení
│   ├── sidepanel.*    # slupka: jen chrome.* + DOM wrapper nad core
│   ├── background.js, content/, manifest.json
├── web/               # NOVÉ: webová slupka, importuje ../extension/core/* (Vite alias
│                      #   + server.fs.allow), live zprávy + historie z backendu
└── backend/           # beze změny: ingest, /chat/history, SSE bus
```

**Proč core uvnitř `extension/`:** Chrome „load unpacked“ nevidí soubory mimo složku
extensionu. Core proto musí fyzicky ležet v ní. Web si ho naopak přes Vite bez problémů
naimportuje odjinud. Extension zůstává bez build kroku (MV3 umí `<script type="module">`
i `"type": "module"` u service workeru).

**Migrace:** postupná. Ne přepis `sidepanel.js` naráz, ale vytahování kusů do `core/`
vždy, když je web potřebuje. Každé vytažení = samostatný commit s bumpem verze.

## 4. Ověřená fakta o stavu repa (2026-09-21, branch `dev`, clean)

### Extension v3.39.16
- `sidepanel.js` 8003 řádků, `background.js` 1090, `chat-store.js` 90 (bez DOM, bez chrome.*).
- 87 použití `chrome.*` v sidepanel.js: `runtime` 32, `tabs` 30, `storage` 21, `windows` 3, `scripting` 1.
  To je hranice slupky; vše ostatní je kandidát na core.
- **Live zprávy** dnes chodí přímo z prohlížeče, ne přes backend:
  - `TwitchProvider` (ř. 1168): anonymní IRC WS `wss://irc-ws.chat.twitch.tv:443`, login `justinfan*`.
    → Funguje z jakékoli webové stránky, žádný extension privilege není potřeba.
  - `KickProvider` (ř. 1581): Pusher WS `wss://ws-us2.pusher.com/...`.
    → Rovněž funguje z webu.
  - `YouTubeProvider` (ř. 1769): fetchuje `youtube.com/{channel}/live` a `live_chat` HTML,
    parsuje `ytInitialData`. → **Na webu nemožné** (CORS, cookies). Musí jít přes backend.
- **Historie:** od v3.39 pouze `GET /chat/history` ze serverového ingestu; lokální cache
  i DOM scrape zmizely (komentář u ř. 2487). Dedup jen `platform:id`.
- **Posílání zpráv a reply:** content scripty (`content/twitch.js` 1971 ř., `youtube.js`, `kick.js`)
  píší do DOM stránky platformy. → Na webu nemožné. Web by potřeboval OAuth uživatele
  a API platformy (backend má `lib/oauthTwitch.ts`, `oauthKick.ts`, `oauthYoutube.ts`,
  ale pro **streamer** tokeny; viz `memory/security_streamer_tokens.md` v UnityChat memory).
- Emoty/badge: 7TV, BTTV, FFZ, Twitch CDN, Kick files (host_permissions v manifestu).
  Všechno jsou veřejné CDN/API, z webu dostupné.

### Backend v0.3.0 (Fastify 5 + Drizzle + Postgres 18, Coolify na Hetzner)
- **Ingest všech tří platforem už běží server-side**: `backend/src/ingest/` (`twitch.ts` IRC,
  `kick.ts` Pusher, `youtube.ts` poller, `normalize.ts`, `store.ts`). Env `CHAT_INGEST_CHANNELS`.
  Retence `CHAT_RETENTION_DAYS=0` = archiv navždy (rozhodnutí usera 2026-09-19).
- Tabulky `messages`, `events`, `users`, `platform_identities`, `seen_users`.
- `GET /chat/history?channel&limit&before` — kurzor `<sent_at_ms>:<id>`, tvar zprávy =
  to, co posílají živé providery, `historical: true`, 10 req/s/IP.
- `backend/src/sse/bus.ts` existuje (dnes pro `/nicknames/stream`). Kandidát na
  **live stream zpráv z ingestu** pro web, aby web nemusel držet vlastní WS na platformy.
- Spec ingestu: `docs/superpowers/specs/2026-09-19-server-chat-log-design.md`.

### RobJewsALot (hub, jen pro kontext integrace)
- `web/`: SvelteKit + adapter-static + Tailwind 4 + Svelte 5, base path `/zidolista`,
  deploy Coolify. Sem web UnityChatu **nepatří** (tenant login, jiný účel).
- `server/`: Fastify, dostává `chat.message` ze Streamer.botu (Twitch/Kick/YouTube) a
  má donate data (Hall of Fame, goaly, Top D). Pro robdiesalot.com později veřejné endpointy.
- Dokumentace v RobJewsALot je git-crypt šifrovaná. UnityChat git-crypt **nepoužívá**.

## 5. Otevřené otázky pro brainstorming v nové session

1. **Stack webu.** Doporučení: SvelteKit + Tailwind 4 (stejné jako RobJewsALot/web, sdílené
   know-how). Alternativa: čisté HTML + ES moduly bez buildu (stejný režim jako extension,
   snazší reuse `sidepanel.html`, hůř se rozšiřuje o zbytek robdiesalot.com).
2. **Live zprávy na webu.** (a) Stejné providery jako extension (Twitch IRC + Kick Pusher
   z prohlížeče, YouTube přes backend), core sdílený 1:1. (b) Jediný SSE/WS stream
   z backend ingestu pro všechny tři platformy, web nemá žádný platform client.
   (b) je jednodušší web a jediný zdroj pravdy, ale rozjede se od extensionu, pokud
   extension zůstane na přímých providerech. Rozhodnout společně s otázkou, zda i extension
   časem přejde na backend stream.
3. **Posílání zpráv z webu.** Read-only první verze? Nebo OAuth uživatele (Twitch/Kick/YouTube)
   a posílání přes backend? Bezpečnostní dopad: userské tokeny na serveru.
4. **Politika portování** (upřesnění pravidla z §2): ptát se po dokončení / ptát se před
   implementací (rozsah core / web / addon / oboje) / portovat rovnou a jen oznámit.
5. **Název složky** (`web/` vs jiný) a **deploy**: Coolify app, experimentální subdoména na
   jouki.cz, později robdiesalot.com. Pozor: landing jouki.cz/UnityChat je v jiném repu
   (`jouki/jouki.cz`), viz sekce „Landing page“ v CLAUDE.md.
6. **Integrace s RobJewsALot daty** (HoF, goaly): až bude stránka existovat, přes veřejné
   API RobJewsALot serveru, ne přes soubory.

## 6. Doporučený první krok

1. `superpowers:brainstorming` nad §5 → spec `docs/superpowers/specs/2026-09-21-web-version-design.md`.
2. Do `CLAUDE.md` přidat sekci „Web verze“ + pravidlo portování z §2 (aby platilo ve všech
   budoucích sessions, ne jen v paměti).
3. Plán přes `superpowers:writing-plans`; první implementační krok = vytažení
   `chat-store.js` a IRC parseru do `extension/core/`, extension dál funguje beze změny.
