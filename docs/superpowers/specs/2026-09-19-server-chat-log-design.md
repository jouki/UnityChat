# Server-side chat log + přestavba klientské historie

**Datum:** 2026-09-19
**Stav:** návrh schválený uživatelem v chatu, čeká na review tohoto dokumentu
**Rozsah:** backend (nový ingest + API), extension (nahrazení cache/scrape vrstvy), privacy policy

## 1. Proč

Panel dnes skládá historii ze dvou zdrojů se smyšlenými časy a výsledek je při
návratu do chatu chaos (screenshot 2026-09-19: všechny zprávy „11:34", Twitch
blok, pak YouTube blok). Ověřeno z debug logu a z kódu:

- **Žádná platforma nepoužívá reálný čas.** `TwitchProvider` (`sidepanel.js:1309`),
  `KickProvider` (`:1697`) i `YouTubeProvider` (`:2269`) dávají `timestamp: Date.now()`,
  přestože IRC posílá `tmi-sent-ts`, Kick `created_at` a YouTube `timestampUsec`.
  Extension ani jeden nečte.
- **Scrape z Twitch DOM** (`content/twitch.js:885-947`) přiděluje `baseTime + idx*1000`.
  V logu: posledních 30 zpráv v cache má rozestup přesně 1000 ms.
- **Boundary detection** (`sidepanel.js:4944-4971`) hádá překryv podle sekvence
  usernamů — heuristika, která selhává (ticket `bug_scrape_boundary_overlap.md`).
- **Race při hydrataci:** živá zpráva doručená během `_hydrateOlderMessages` skončí
  v dočasném fragmentu, nezapíše se do cache a zobrazí se nahoře (`:7918`, `:7944`, `:7721`).
- **`msgCount` se nikdy nedekrementuje** (`:7268` vs `:8068`) → po 5000 zprávách se
  `_trim()` volá u každé další.
- **Optimistická zpráva při selhání odeslání zůstane viset jako odeslaná** a po
  reloadu se z cache vykreslí znovu (`:4620-4625`, `:7780`).

Probe 2026-09-19 (kanál `robdiesalot`, live):

| Platforma | Reálný čas ve zprávě | Přesnost | Poznámka |
|---|---|---|---|
| Twitch IRC | `tmi-sent-ts` | ms | latence vůči PC −579 ms → hodiny klienta jdou za Twitchem, `Date.now()` nelze míchat s časem platformy |
| YouTube | `timestampUsec` | µs | 75/75 zpráv v `live_chat?is_popout=1` |
| Kick | `created_at` | ISO 8601 | payload ho nese; formát potvrdit při implementaci (chat mlčel 60 s) |

## 2. Rozhodnutí uživatele

| Otázka | Rozhodnutí |
|---|---|
| Kdo plní log | **Server poslouchá platformy sám.** Klient dál poslouchá přímo kvůli okamžitosti. |
| Rozsah | **Jen `robdiesalot`.** Rozšíření je konfigurace, ne přepis. |
| Lokální cache | **Zrušit.** Historie výhradně ze serveru. |
| DOM okno | **~300 zpráv kolem viewportu**, unload oběma směry. |
| Retence | **7 dní** (policy ji dosud neurčuje — „doplníme před spuštěním"). Jedno číslo ke změně. |
| Bug první zprávy | **Hned, samostatný fix** (v3.38.63), nezávisle na přestavbě. |
| Ověření | Před zapnutím uživatelům **měřit kompletnost a latenci** serveru proti dnešnímu klientu. |

## 3. Architektura

```
Twitch IRC ──┐                                   ┌─ Twitch IRC (live)
Kick Pusher ─┼─► ChatIngest ─► messages (PG) ─► GET /chat/history ─► ChatStore ◄─┼─ Kick Pusher (live)
YT poller ───┘      (server)                        (100/page)         (klient)   └─ YT poller (live)
                                                                          │
                                                                          ▼
                                                                    ChatRenderer
                                                                    (okno ~300 v DOM)
```

Server je **jediný zdroj historie**. Klient je **jediný zdroj okamžitosti**.
Potkávají se na hranici „posledních 100 ze serveru" ↔ „první live", kde se
duplicity poznají podle `platform:platformMessageId`.

### 3.1 Backend — `ChatIngest`

Nový modul `backend/src/ingest/`:

| Soubor | Účel |
|---|---|
| `index.ts` | start/stop podle konfigurace kanálů; registrace do Fastify lifecycle (`onReady` start, `onClose` stop) |
| `twitch.ts` | anonymní IRC WebSocket (`justinfan`), `CAP REQ tags/commands`, `JOIN #channel`, parser PRIVMSG + USERNOTICE (raid, sub, …), auto-reconnect s backoffem, PING/PONG |
| `kick.ts` | `GET kick.com/api/v2/channels/{slug}` → `chatroom.id`; Pusher WS, subscribe `chatrooms.{id}.v2`, `ChatMessageEvent`; ping 30 s, reconnect |
| `youtube.ts` | `findLiveVideoId` (`/{channel}/live` → `isLive`, `videoId`), poller `live_chat?v=&is_popout=1` každých 6 s (invalidation-only kanály nedovolí víc — ověřeno v extension v3.38.41–43), dedup přes `_seen` |
| `normalize.ts` | platform payload → `NewMessage` řádek |

Konfigurace přes env: `CHAT_INGEST_CHANNELS=twitch:robdiesalot,kick:robdiesalot,youtube:robdiesalot`.
Prázdné = ingest vypnutý (dev bez efektu).

Parsery se **portují z extension** (`TwitchProvider._parse`, `KickProvider`,
`YouTubeProvider._processActions`), ne píšou znovu — chování je vyladěné v3.x
iteracemi (IRC escaping, Kick `[emote:ID:NAME]`, YT `runs[]`). Porty jsou
vědomá duplikace: extension a backend jsou různé runtimy bez sdíleného balíčku.

**Zápis:** `INSERT … ON CONFLICT (platform, platform_message_id) DO NOTHING`.
Unique index už existuje (`messages_platform_message_unique`). `sent_at` = čas z
platformy, `created_at` = čas přijetí serverem → jejich rozdíl je ingest latence,
kterou test v §6 měří.

**Schéma `messages`:** existuje, beze změn kromě:
- `content_raw` (jsonb) ponese, co klient potřebuje pro render: Twitch `emotes`
  IRC tag + `badges` string + `color`, Kick surový `content`, YT `runs`.
  Klient dnes tyhle věci renderuje z `badgesRaw` / `kickContent` / `ytRuns`
  (Explore report §1), server je jen přenese.
- `platform_user_id` je `NOT NULL`; YT anonymní zprávy ho mají (`authorExternalChannelId`),
  Twitch `user-id` tag, Kick `sender.id`. Kde chybí → `''`.

**Retence:** `setInterval` v ingest modulu, 1× za hodinu
`DELETE FROM messages WHERE sent_at < now() - interval '7 days'`. Konstanta
`CHAT_RETENTION_DAYS` v env, default 7.

**Systémové události** (raid, sub, milestone…) se ukládají do `messages` s
`content_raw.event = {...}` a `content` = lidský popis, ne do tabulky `events`
— klient je dnes renderuje jako zprávy v jednom proudu a tak to má zůstat.

### 3.2 Backend — API

```
GET /chat/history?channel=robdiesalot&limit=100[&before=<cursor>]
```

- `channel` = Twitch login; server vrací zprávy **všech tří platforem** pro
  streamera podle `streamers` directory mapování (twitchLogin → youtubeHandle,
  kickSlug). Když mapování chybí, jen Twitch.
- `limit` 1–200, default 100.
- `before` = cursor `"<sent_at_ms>:<id>"` poslední zprávy z předchozí stránky;
  řazení `ORDER BY sent_at DESC, id DESC`, podmínka `(sent_at, id) < (cursor)`.
  Stabilní i při shodných časech.
- Odpověď: `{ ok, messages: [ …nejstarší → nejnovější… ], nextBefore: cursor | null }`.
- Tvar message ve výstupu odpovídá tomu, co klient dnes dostává od providerů
  (`platform, id, username, message, timestamp(ms), color, badgesRaw|badges,
  replyTo, isRaid…, ytRuns, kickContent`), aby renderer nemusel mít dvě cesty.
  Mapování v `backend/src/routes/chat.ts` → `toClientMessage(row)`.
- Cache-Control: `no-store` (živá data). Rate limit: 10 req/s per IP přes
  jednoduchý token bucket v paměti — ochrana proti scroll-spam, ne proti útoku.

`GET /health` dostane `ingest: { twitch: 'connected'|'reconnecting'|'off', kick, youtube, lastMessageAt }`.

### 3.3 Extension — `ChatStore`

Nový soubor `extension/chat-store.js`, načtený v `sidepanel.html` přes vlastní
`<script src>` před `sidepanel.js` (projekt nemá bundler, ale více skriptů
načte bez problému; `build-store.ps1` kopíruje celou složku). Jediný držitel
dat zpráv, bez závislosti na DOM — testovatelný samostatně v Node:

```
ChatStore
  _all: Message[]           // seřazeno podle timestamp ASC, id ASC
  _ids: Set<string>         // "platform:id" všech držených zpráv
  add(msg) → 'added'|'dup'|'upgraded'
  prependOlder(msgs[])      // z /chat/history, vrací kolik reálně přibylo
  slice(from, to)           // pro renderer
  indexOf(id)
  oldestCursor()            // pro další stránku
  markFailed(id) / upgrade(optimisticId, realMsg)
```

- **Timestamp = čas z platformy.** Providery se upraví: Twitch `Number(tags['tmi-sent-ts'])`,
  Kick `Date.parse(data.created_at)`, YT `Math.floor(Number(timestampUsec) / 1000)`.
  Fallback `Date.now()` jen když tag chybí (USERNOTICE bez `tmi-sent-ts` neexistuje,
  ale ať to nespadne).
- **Optimistická zpráva** dostává `timestamp: Date.now()` (jiný zdroj nemá) a
  po IRC echu se nahradí reálným časem (`upgrade`). Skok o ±1 s na vlastní
  zprávě je přijatelný; pořadí zůstane, protože echo přijde do vteřiny.
- **Dedup jen podle `platform:id`.** Content-key dedup (`norm(user)|norm(text)`)
  existoval kvůli scraped zprávám bez ID — s koncem scrape zmizí. Zůstává jen
  párování optimistická ↔ echo (stejný mechanismus jako dnes, `_optimisticKeys`).
- **Per-channel dedup LRU** (`_dedupChannels`) zmizí; store se při přepnutí
  kanálu vytvoří nový.

### 3.4 Extension — `ChatRenderer`, okno ~300

Renderer drží `[winStart, winEnd)` index do `store._all` a synchronizuje DOM:

- **Boot:** `GET /chat/history?limit=100` → `store.prependOlder` → render
  posledních ≤100, scroll dolů. Pak `_connectAll()`. Live zprávy → `store.add`
  → když je uživatel dole (`atBottom`), append do DOM a posun okna; jinak jen
  `_unreadCount++` (jako dnes).
- **Scroll nahoru** (`scrollTop < 200`): pokud `winStart > 0`, rozšířit okno o 100
  ze store (prepend do DOM, scroll-restore přes `scrollHeight` delta jako dnes v
  `:7962`). Pokud `winStart === 0` a `store.oldestCursor()` existuje, `fetch
  history(before=cursor)` → `prependOlder` → totéž. Spinner `.hydrate-spinner`
  zůstává.
- **Unload spodku:** když `winEnd - winStart > 300` po prependu, odebrat z konce
  DOM `(winEnd - winStart) - 300` uzlů a snížit `winEnd`. Data zůstávají ve store.
- **Scroll dolů:** když `scrollHeight - scrollTop - clientHeight < 200` a
  `winEnd < store.length`, append dalších ≤100 ze store, unload shora symetricky.
- **Klik na „N nových"**: `winEnd = store.length`, okno `[max(0, len-300), len)`,
  DOM se překreslí celý (300 uzlů je levné), scroll dolů.
- **Dedup DOM ↔ store:** DOM nikdy neobsahuje uzel bez odpovídajícího indexu ve
  store; `data-msg-id` zůstává pro `_scrollToMessage`, `_upgradeOptimistic`,
  mod akce (`_markMessageCleared`). Ty se upraví, aby při chybějícím uzlu (mimo
  okno) změnily jen data ve store — uzel se vykreslí správně, až se do okna vrátí.
- **Systémové řádky** (`_sys`) přestanou být děti `chatEl` míchané se zprávami;
  vykreslí se jako dočasný overlay/toast nad inputem (3 s), aby nerozbíjely
  index okna. Výjimka: „Připojování…" a chyby odeslání — ty jdou do store jako
  zpráva `platform: 'system'` s `Date.now()`, ať mají místo v proudu.

### 3.5 Co se maže z extension

| Odstranit | Kde |
|---|---|
| `_msgCache`, `_cacheKey`, `_cacheMsg`, `_compactMsg`, `_expandMsg`, `beforeunload` zápis | `sidepanel.js` ~7739–7793, 2500 |
| `_loadCachedMessages`, `_hydratedIdx`, `_hydrateOlderMessages`, `_hydratingOlder` | ~7897–8060 |
| `_scrapeExistingChat` + volání 1500 ms po connect | ~4913–4983 |
| `SCRAPE_CHAT` handler + `scrapeMessages()` | `content/twitch.js` 821–954 |
| Content-key dedup, `_dedupChannels`, `_dedupLRU`, `_dedupTrim` | ~2477, 7072–7106, 7234–7266 |
| `_trim`, `msgCount` guard | ~7730, 8068 |
| `uc_messages_*` klíče ve storage — jednorázový úklid při prvním startu nové verze | migrace v `_init` |
| `_msgHistory` naplnění z cache (ArrowUp historie) — nahradit naplněním z `/chat/history` filtrovaným na vlastní username | ~8043 |

`DIAG` dump: `dedupChannels*`, `msgCache*` pole nahradit `store.length`,
`window`, `oldestCursor`, `historyFetches`.

### 3.6 Bug první zprávy (samostatně, v3.38.63)

Nezávisí na ničem výše, jde ven první.

1. `content/twitch.js:989` — `findInput()` obalit pollingem 50 ms / max 3 s
   (stejný vzor jako `waitReady`). Twitch chat input je React komponenta
   mountovaná po `document_idle`; první `SEND_CHAT` po otevření panelu ho
   často předběhne.
2. `sidepanel.js:4620-4625` — při `!resp?.ok` nebo throw: najít DOM uzel
   optimistické zprávy (`data-msg-id`), přidat třídu `.send-failed` (červený
   levý pruh + „neodesláno", klik = znovu vložit text do inputu), a **odstranit
   ji z cache** (dnes) / označit `failed` ve store (po přestavbě). Dnes navíc
   `_optimisticKeys` záznam smazat, aby pozdější reálná zpráva se stejným textem
   nebyla omylem „upgradnuta".
3. UC_LOG tag `SendFail` s důvodem — instrumentace pro potvrzení, že to byl
   tenhle scénář (pravidlo č. 1: uživatel to nedokáže reprodukovat, log ano).

Orphaned content script po reloadu extension (Explore §5C, `window._ucTwitch`
guard) je pravděpodobný, ale neověřený — dostane jen instrumentaci: pokud
`chrome.runtime.id` v content scriptu neodpovídá, guard se přeskočí a
zaloguje `Orphan`. Fix až s daty.

## 4. Datový tok — boot panelu po přestavbě

1. `_init` → config, emotes, badges (beze změny)
2. `fetch /chat/history?channel=…&limit=100` (timeout 5 s) → `store.prependOlder`
   → render → scroll dolů. Při chybě: `system` zpráva „Historie nedostupná",
   pokračuje se bez ní.
3. `_connectAll()` → providery. Každá live zpráva → `store.add`:
   - `dup` (už z historie) → nic
   - `added` → renderer podle pozice uživatele
4. Žádný scrape, žádné „Doparsováno N zpráv".

## 5. Chybové stavy

| Situace | Chování |
|---|---|
| Server nedostupný při bootu | 5 s timeout, `system` řádek, live funguje. Žádný retry historie na pozadí — uživatel může scrollnout nahoru, což zkusí znovu. |
| `/chat/history` vrátí 5xx při scrollu | spinner zmizí, `system` řádek, další pokus při dalším scrollu (bez tight loopu — 3 s cooldown). |
| Ingest ztratí spojení | reconnect s backoffem 1→30 s; mezera v logu je viditelná jako díra v časech, nic se nedopočítává. `/health.ingest` to hlásí. |
| YT stream skončí / začne | poller každých 60 s zkouší `findLiveVideoId`, při změně `videoId` restartuje. |
| Kick chatroom id se změní (nepravděpodobné) | při `subscription_error` re-fetch channel API. |
| Duplicita id přes platformy (teoretická) | klíč je `platform:id`, ne `id`. |

## 6. Ověření před zapnutím (požadavek uživatele)

Cíl: **čísla, že server vidí všechny zprávy a včas.**

1. Nasadit ingest na backend **dřív** než klientskou část. Sbírá do DB, nikdo
   z něj nečte.
2. Jeden živý stream (≥ 1 h): u vybraných 3 uživatelů (včetně Jouki) nechat
   běžet dnešní extension a po streamu dumpnout DIAG (`msgCache` ids).
3. Skript `scripts/ingest-audit.mjs`: pro každé `platform:id` z dumpů zjistit,
   zda je v DB. Hlásit **chybějící** (recall) a distribuci `created_at − sent_at`
   (latence ingestu, p50/p95/max) per platforma.
4. Kritérium: Twitch a Kick recall ≥ 99,5 %, p95 latence < 2 s. YouTube: recall
   ≥ 95 % a p95 < 10 s (page-refresh režim nedovolí líp; ztráty nastávají,
   když mezi dvěma refreshy odejde víc zpráv, než stránka drží).
5. Teprve pak klientská část (v3.39.0).

Během vývoje klienta poslouží `GET /chat/history` i ručně přes curl.

## 7. Privacy policy

Sekce 1c: nahradit „připravujeme… zatím není aktivní" za:
> Veřejné zprávy z chatu kanálu robdiesalot na Twitchi, YouTube a Kicku
> ukládáme na server po dobu **7 dní**, aby si uživatel mohl přečíst, co
> v chatu proběhlo před jeho příchodem. Ukládá se text zprávy, jméno autora
> na platformě, čas odeslání a odznaky/emoty potřebné k zobrazení. Po 7 dnech
> se zprávy automaticky mažou.

Sekce 5 (retence): doplnit řádek o 7 dnech. EN zrcadlově. Datum platnosti bump.
CWS disclosure „Osobní komunikace" je už zaškrtnutá, popis položky říká
„připravuje se archiv" → po zapnutí přeformulovat.

## 8. Mimo rozsah

- Live zprávy přes server (SSE) — klient poslouchá přímo; server jako druhý
  live zdroj až kdyby se ukázala potřeba (výpadky klientských spojení).
- Více kanálů než `robdiesalot` — env konfigurace to umožní, ale YT poller
  per kanál je citelná zátěž; rozhodnout zvlášť.
- Full-text vyhledávání v historii.
- Offline cache jako fallback.
- Twitch EventSub místo IRC (samostatný plán v paměti).

## 9. Verzování

- v3.38.63 — bug první zprávy (§3.6)
- backend v0.3.0 — ingest + `/chat/history` (§3.1–3.2), nasazený před klientem
- v3.39.0 — klient (§3.3–3.5), po projití testu §6
