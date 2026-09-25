# Moderace — část 2: HTTP/SSE kontrakt (backend)

> Pro implementaci addonu, webu (Task 3–4) a pro Židolištu. Backend: `routes/moderation.ts`,
> `routes/accountWarnings.ts`, `routes/integrationModeration.ts`, `lib/userModActions.ts`,
> `lib/userModeration.ts`, `lib/accountWarnings.ts`. SQL `backend/sql/2026-09-25-moderation-2.sql`
> se musí spustit PŘED nasazením backendu.

## Společné

- **Auth UC rout:** `Authorization: Bearer <session>` (jako `/chat/send`). Chybí/neplatná → `401`.
- **Mod:** server ověří `accountModIdentities(účet, kanál)` PŘED čímkoli dalším. Nemod → `403 { ok:false, error:'not_mod' }`.
  Kanál: `channel` v těle/query (lowercase se udělá na serveru), chybí → výchozí kanál serveru (robdiesalot);
  neplatný formát → `400 { error:'channel' }`.
- **Cíl** se určuje podle `(platform, userId)` zprávy a MUSÍ mít zprávu v serverovém archivu toho kanálu
  (login se bere z archivu, `login` z klienta je jen informativní). Jinak `404 { ok:false, error:'not_found' }`
  a nic se nestane (žádné SSE, platforma ani zápis). Akce na sebe (cíl je týž UC účet) → `400 { error:'self' }`.
- **Hierarchie** (timeout/ban/unban, varování, přejmenování): role cíle se ověří na serveru (`chatRole` na
  platformním kanálu každé známé identity cíle). Broadcastera kanálu nemoderuje nikdo, moda jen broadcaster
  → `403 { ok:false, error:'target_protected' }`, nic se nestane.
  Pozor: ochrana moda stojí na `chatRole` = odznaky z jeho zpráv v archivu za posledních 24 h (broadcaster
  = login shodný s kanálem); mod, který 24 h v kanálu nepsal, se jeví jako divák a chráněný není.
- **Rate limit** per účet (10, doplňuje 2/s) sdílený s `/moderation/delete` a `/moderation/user-state` → `429 { error:'rate_limited' }`.
- `userId` = ID na platformě: Twitch user id, Kick user id, YouTube channel id (`UC…`) — to, co nese zpráva
  (`platformUserId` / `userId` v `/chat/history` a `/chat/stream`).
- **Výsledek po platformách** (`ModResult`): `'ok'` (účtem moda) · `'bot'` (botem workspace) · `'error:<kód>'`:
  `no_actor` (mod nemá scopes/není mod na té platformě a bot chybí nebo nemá scopes), `no_channel`,
  `not_live` (YouTube: stream neběží), `no_ban_id` (YouTube unban bez známého id banu), `unsupported`,
  `exception`, nebo HTTP status platformy (`error:403`, `error:401`, …).
- Chyba platformy nikdy nevrací 500 — vždy `200` s `results`.

## UC routy (Bearer)

### `POST /moderation/user` — timeout / ban / unban
```json
{ "channel": "robdiesalot", "platform": "twitch", "userId": "123", "login": "spammer",
  "action": "timeout", "durationSec": 300, "reason": "spam" }
```
- `action`: `timeout` | `ban` | `unban`. `durationSec` povinné jen u `timeout`, jen z
  `5, 30, 60, 300, 600, 1800, 3600, 7200` (jinak `400 body`). `reason` volitelný (≤ 500 znaků, jde na platformu).
- Platí na **všech platformách, kde člověka známe**: identity téhož UC účtu (`web_identities`) na platformách,
  které má kanál v registru; bez UC účtu jen platforma zprávy.
- Pořadí: akce na platformách (paralelně) → SSE `user-moderated` **jen pro platformy, kde akce prošla**
  (`ok`/`bot`) → `moderation_bans` (zápis / u unbanu smazání) také jen pro ně → `moderation_actions`.
  Klient dostane výsledky všech platforem.
- Odpověď `200`:
```json
{ "ok": true, "action": "timeout", "until": 1790000300000,
  "results": { "twitch": "ok", "kick": "bot", "youtube": "error:not_live" },
  "targets": [ { "platform": "twitch", "login": "spammer" }, { "platform": "kick", "login": "spammer_k" } ],
  "notes": { "kick": "rounded_to_minutes:1" } }
```
  `until` = konec timeoutu (ms epoch) na platformě zprávy, pokud tam prošel, jinak `null`. `notes.kick` jen když se Kick
  zaokrouhlil na celé minuty (5 s a 30 s = 1 min) — klient to uvede v hlášce.

### `POST /moderation/warn`
```json
{ "channel": "robdiesalot", "platform": "kick", "userId": "77", "reason": "Nespamuj odkazy" }
```
- `reason` povinný (1–500 znaků po trim).
- Twitch nativně (Helix warnings), jen když má cíl Twitch identitu (zpráva z Twitche nebo propojený účet).
- Uživatel UnityChatu dostane varování napříč platformami (`account_warnings` + SSE `account-warning`
  **jen jeho účtu**, viz níže). Divák mimo UC na Kicku/YouTube nic.
- `200 { ok:true, results: { twitch?: ModResult, unitychat: 'ok' | 'no_account' | 'error:db' } }`.

### `POST /moderation/permit`
```json
{ "channel": "robdiesalot", "platform": "twitch", "userId": "123", "durationSec": 120 }
```
- `durationSec` z `30, 60, 120, 300, 600`.
- Pošle do chatu platformy zprávy `!permit <login z archivu>` — účtem moda, je-li na té platformě mod
  (přes stejnou logiku jako `/chat/send`), jinak / při selhání botem workspace (`sendAsBot`).
- Uloží náš permit (`link_permits`) pro všechny známé identity (pro filtr odkazů v části 3).
- Login cíle musí odpovídat `^[\w.-]{1,60}$` (jde doslova do chatu), jinak `400 { error:'bad_login' }`
  a nic se nepošle ani neuloží. Hierarchie se u permitu nekontroluje.
- `200 { ok:true, until: <ms>, results: { permit: 'ok'|'error:db', chat: 'ok'|'bot'|'error:<kód>' } }`
  (`chat` kódy bota: `no_actor`, `bot_unavailable`, `not_live`, `no_channel`, `send_failed`, …).

### `PUT /moderation/nickname` — přejmenování
```json
{ "channel": "robdiesalot", "platform": "twitch", "login": "spammer", "nickname": "Pan Spam", "color": "#ff8800" }
```
- `nickname: null` = smazat přezdívku. Pravidla jako `PUT /nicknames` (1–30 znaků, `color` `#rrggbb` / null),
  ale bez 10s limitu a bez vlastnictví — jen mod kanálu a jen uživatel z archivu kanálu (přesná shoda loginu).
- SSE `nickname-change` / `nickname-delete` rozešle trigger v DB (`nicknames_notify`), route sama nic nevysílá.
- Přezdívky jsou **globální** (tabulka `nicknames` nemá kanál; rozhodnutí: stejní modi napříč podporovanými
  streamery). Hierarchie platí (mod / broadcaster cíle → `403 target_protected`).
- Přezdívka se kontroluje proti blacklistu slov kanálu (Židolišta, stejný zdroj a stejné pravidlo celého
  slova jako `core/censor.js`) → `400 { error:'nickname_blacklisted' }`.
- `200 { ok:true, login, nickname }`, neznámý login v kanálu `404 not_found`.

### `GET /moderation/user-state?channel=&platform=&userId=`
- `200 { ok:true, banned: boolean, until: <ms>|null }` — `banned` = známý ban (until null) nebo běžící timeout
  (vlastní akce UC/Židolišty + Twitch CLEARCHAT). Podle toho nabídka ukáže **Unban** místo Timeout/Zabanovat.
  Jen pro mody, rate limit sdílený s ostatními routami moderace.

## Varování účtu (Bearer, jen vlastní účet)

| Metoda | Cesta | Odpověď |
|---|---|---|
| GET | `/account/warnings` | `{ ok, warnings: [{ id, channel, reason, createdAt }] }` nepotvrzená, nejstarší první |
| POST | `/account/warnings/:id/ack` | `{ ok }`; cizí / neexistující / už potvrzené → `404 not_found` |
| POST | `/account/stream-ticket` | `{ ok, ticket, expiresInMs: 60000 }` (limit 10, pak 1 / 2 s) |
| GET | `/account/stream?ticket=<ticket>` | SSE jen pro tento účet (bez Bearer — EventSource ho neumí) |

- `GET /auth/me` nově vrací i `warnings: [...]` (stejný tvar).
- `POST /chat/send` s nepotvrzeným varováním → `403 { ok:false, error:'warning_pending' }` (server psaní blokuje
  i bez klienta).
- **Proč ticket:** `/nicknames/stream` je veřejný broadcast (+ replay bufferu komukoli), důvod varování tam nesmí.
  Session token do URL (access log) také ne. Ticket je jednorázový, platí 60 s; při každém (re)connectu si
  klient vyžádá nový. Neplatný/propadlý ticket → `401 { error:'ticket' }`. Max 10 spojení na účet
  (další dostane `event: error` `{"error":"too_many_streams"}` a konec).
- Události na `/account/stream`:
  - `account-warning` `{ id, channel, reason, createdAt }` — při novém varování a po připojení pro každé
    nepotvrzené (klient nemusí zvlášť volat `/account/warnings`).
  - `account-warning-ack` `{ id }` — potvrzeno (i z jiného okna téhož účtu) → zavřít okno.
  - keepalive komentář každých 25 s.

## SSE `/nicknames/stream` (všichni klienti)

`user-moderated` — pro každou zasaženou identitu zvlášť:
```json
{ "channel": "robdiesalot", "platform": "kick", "userId": "77", "login": "spammer_k",
  "action": "timeout", "until": 1790000060000, "by": "twitch:modik", "at": 1790000000000 }
```
- `channel` = UC kanál (Twitch login streamera). `action`: `timeout` | `ban` | `unban`. `until` = konec
  timeoutu v ms (u Kicku už zaokrouhlený), jinak `null`. `by`: `"<platforma>:<login>"` moda,
  `"zidolista:<id>"` z Chat Logu, `null` = odjinud (Twitch CLEARCHAT z ingestu).
- **Nenese důvod.** Klient: styl smazaných zpráv (`deletedStyle`) na předchozí zprávy `(platform, userId)`
  + štítek „Timeout (5 min)" / „Zabanován"; `unban` štítek sundá. Chodí jen pro platformy, kde akce
  prošla. CLEARCHAT, který je echem vlastní akce (stejná akce i délka), server do 30 s nevyšle podruhé —
  i když dorazí dřív než výsledek platformy (očekávané echo se ohlásí před voláním, po selhání se zruší);
  re-timeout odjinud s jinou délkou projde (nové `until`).

## Integrace Židolišty (X-Api-Key + HMAC, `inboundAuthorized`)

`POST /integrations/:slug/moderation/timeout | ban | unban`
```json
{ "platform": "kick", "userId": "77", "durationSec": 600, "reason": "spam",
  "actor": { "source": "zidolista", "userId": "7", "name": "Jouki", "role": "owner" } }
```
- `durationSec` povinné u `timeout` (1–1 209 600 s, Kick se zaokrouhlí na minuty), jinak ignorováno. `login` volitelný (ignoruje se).
- Kanál JEN ze slugu (`ws.channels.twitch` = UC kanál), cíl musí mít zprávu v archivu platformního
  kanálu workspace; propojené identity jen na platformách workspace. Akce jen **botem workspace**.
- Hierarchie jako u UC: broadcaster cíle nikdy; mod cíle jen když `actor.role` je `owner` / `broadcaster`
  / `streamer` (role ověřuje Židolišta, požadavek je podepsaný HMAC) → jinak `403 target_protected`.
- Odpovědi: `400 body` / `400 durationSec`, `404 unknown_workspace` / `no_channel`, `429 rate_limited`
  (per workspace, sdílené s delete/hide/unhide), cíl mimo workspace `200 { ok:true, result:'not_found' }`,
  jinak `200` stejné tělo jako `POST /moderation/user`.
- Stejné SSE `user-moderated` (by `zidolista:<actor.userId>`), evidence banu i `moderation_actions`
  (`account_id` null, `actor` `zidolista:<id>`).

Integrační stream (`GET /integrations/chat/stream`) — nová událost, společný kurzor a replay:
```
event: chat.user_moderated
data: { "type": "chat.user_moderated", "workspace": "rob", "platform": "twitch", "userId": "123",
        "login": "spammer", "action": "timeout", "duration": 300, "by": "twitch:modik" }
```
`duration` (s) jen u `timeout`; `by` jako u SSE výše (`null` = CLEARCHAT odjinud).

## Tabulky (SQL `2026-09-25-moderation-2.sql`)
- `moderation_bans (channel, platform, target_user_id)` PK, `target_login`, `until` (null = permanentní),
  `youtube_ban_id`, `created_at`; unban řádek maže.
- `link_permits` (id, channel, platform, target_user_id, target_login, until, by, created_at), index kanál+platforma+uživatel.
- `account_warnings` (id, account_id → web_accounts, channel, reason, by, created_at, acknowledged_at).
- `moderation_actions.action` nově: `timeout`, `ban`, `unban`, `warn`, `permit`, `rename`;
  `params` `{ userId, durationSec?, reason?, targets[] }`, `result` po platformách.

## Moderátorské scopes
Beze změny proti části 1 (`lib/modScopes.ts`): Twitch `moderator:manage:banned_users` (timeout/ban/unban),
`moderator:manage:warnings` (varování); Kick `moderation:ban`; YouTube `youtube.force-ssl`.
`!permit` účtem moda potřebuje běžný scope pro psaní (`user:write:chat` / `chat:write` / force-ssl).

## Část 3 — filtr odkazů a permit (backend `lib/linkFilter.ts`, `lib/linkRestore.ts`, `lib/links.ts`)

**Nic se nezapíná samo.** Filtr řídí jen `enabled` z nastavení workspace v Židolištce (výchozí `false`).
Bez odpovědi Židolišty (nikdy nenačteno, chybí `ZIDOLISTA_API_KEY`) = vypnuto → nic se nemaže (fail-open).
Při pozdějším výpadku platí poslední známé nastavení. Zapnout až **po vypnutí link filtru v SE**.

### Nastavení (UnityChat → Židolišta)
`GET <ZIDOLISTA_API_BASE>/integrations/:slug/link-filter` (X-Api-Key, `If-None-Match` → `304`)
→ `{ ok, workspace, enabled, allowDomains[], extraBots[], version }`. Cache 60 s per workspace,
načítá se dopředu po každém načtení registru workspaců. Domény se normalizují (bez schématu, cesty, `*.`, `www.`),
povolená doména pokrývá i subdomény (`m.youtube.com` ⊂ `youtube.com`, ne `evilyoutube.com`).
Webhook `POST /commands/invalidate { workspace, reason: "link-filter", data: { version } }` → cache i ETag pryč,
načte se znovu (i když zrovna běží běžné načtení — vynucené počká a načte znovu); odpověď `{ ok, workspace, enabled, version }`, neznámý workspace `404 unknown_workspace`.

### Filtr (ingest, jen živé zprávy)
- Kanál musí být v registru workspaců a workspace musí mít Twitch kanál (= UC kanál).
- Zprávy starší než 60 s (čas platformy; YouTube po reconnectu přehrává historii) se nefiltrují ani nečtou jako `!permit`.
- Odkaz = sdílený detektor `extension/core/links.js` (backend má vědomou kopii `lib/links.ts`, test porovnává
  obě): se schématem vždy (i přilepený uvnitř tokenu: `ahoj,https://x.cz`, `x:https://x.cz`); bez schématu jen známá
  TLD a zároveň `www.`, cesta/dotaz (`neco.cz/x`, `bit.ly/abc`), nebo TLD z užšího seznamu bez českých slov a přípon
  souborů (`seznam.cz`, `discord.gg` ano; `tak.co`, `dobre.to`, `jo.je`, `readme.md`, `run.sh` ne); doména i za
  interpunkcí/emoji (`ahoj,evil.com`, `🔥evil.com`). Ne verze, čísla, časy, e-maily, @zmínky, emoty.
- **Výjimky:** broadcaster, mod, VIP (odznaky zprávy; Kick OG = VIP), známí boti — StreamElements, Nightbot,
  Streamlabs **jen na Twitchi** (jinde si jméno může vzít kdokoli), `extraBots` ze Židolišty (podle loginu na všech
  platformách), `bot.ownLogins`, identity botů workspace / sdílený JoukiBOT (podle id účtu, když ho zpráva nese,
  jinak loginu) — a aktivní permit.
- **Akce:** zpráva se označí jako smazaná **před** zápisem do archivu a rozesláním — `/chat/stream` i archiv ji mají
  rovnou jako `deleted: true` bez obsahu (obsah zůstává v DB, `deleted_reason = 'link_filter'`, `deleted_by = 'filter'`).
  Pak SSE `message-deleted { channel, platform, messageId, by: "filter", reason: "link_filter", at }`
  + `chat.deleted` (reason `link_filter`) a smazání na platformě **botem workspace** (`accountId: null`).
  Bez hlášky a bez timeoutu. Evidence `moderation_actions` (`actor: "filter"`, `action: "delete"`,
  `params: { reason: "link_filter", host }`). Chyby se jen logují, ingest nikdy nespadne.
- **Integrační stream:** smazaná zpráva jde jako `chat.message` s `text: ""` a `deleted: true` (obsah odkazu se
  Židolištce neposílá; commandy z ní nespouštět), hned za ní `chat.deleted` s `reason: "link_filter"`.

### Permit
- **Z chatu:** `!permit <login> [doba]` od moda/broadcastera (odznaky) z libovolného klienta. Doba `90`, `90s`,
  `2m`, `2min`, ořez 30–600 s, výchozí 60 s. `!permit` od kohokoli jiného je běžná zpráva (s odkazem se smaže).
  Echo vlastního `!permit` z nabídky (účtem moda i botem) se nezapisuje znovu: permit pro týž cíl udělený
  před méně než 10 s = echo.
  Cíl: login v archivu kanálu → všechny známé identity (propojený UC účet, jen platformy kanálu); uživatel,
  který ještě nepsal → permit podle loginu na platformě příkazu. Evidence `moderation_actions`
  (`action: "permit"`, `params.source: "chat"`).
- **Z nabídky:** `POST /moderation/permit` (část 2) beze změny, jen permity jdou navíc do paměti filtru.
- Permit platí v paměti serveru (rozhoduje synchronně) + `link_permits` (po restartu se načtou platné).
  Delší permit vyhrává (kratší ho nepřepíše). Shoda podle `(UC kanál, platforma, userId)` nebo loginu.

### Obnovení zprávy permitem
`POST /moderation/permit` má nové volitelné pole `messageId` (klient ho posílá, když se nabídka otevřela na
potvrzené zprávě). Po úspěšném permitu: je-li zpráva téhož autora v kanálu smazaná **filtrem odkazů**, smazání se
v DB zruší a jde SSE
```json
{ "channel": "robdiesalot", "platform": "twitch", "messageId": "abc", "by": "twitch:modik", "at": 1790000000000,
  "message": { "platform": "twitch", "id": "abc", "username": "divak", "message": "koukni na neco.cz", "...": "..." } }
```
jako `event: message-restored` (tvar `message` = `/chat/history`) + `chat.restored { workspace, platform, messageId, by }`
do integračního streamu. Na platformě zpráva zůstává smazaná. Smazání modem / platformou se permitem neobnovuje (na to je
„Odkrýt zprávu“, `POST /moderation/restore`, viz níže).
Odpověď navíc: `results.restore` = `'ok' | 'not_found' | 'error:no_channel' | 'error:db'` a `restored: boolean`
(jen když přišlo `messageId`). Klient (addon `_unhideMessage(d, { restore: true })`, core `buildModRequest`)
zprávu vykreslí na místě z `message`; hláška permitu doplní „zpráva obnovena“.

## Integrace — permit (Chat Log Židolišty, 2026-09-25)
`POST /integrations/:slug/moderation/permit` (X-Api-Key + X-UC-Signature) — tělo
`{ platform, userId, durationSec: 1–86400, messageId?, actor }`. Kanál a bot jen ze slugu.
Uloží permit (i napříč platformami známého UC účtu), pošle `!permit <login>` botem workspace, s `messageId`
obnoví zprávu smazanou filtrem odkazů (SSE `message-restored`, integrační `chat.restored`).
Odpověď jako UC `/moderation/permit`: `{ ok, until, results: { permit, chat, restore? }, restored? }`;
uživatel mimo kanál workspace → `200 { ok:true, result:'not_found' }`; chyby 400 body / bad_login,
404 unknown_workspace | no_channel, 429 rate_limited.

## Profil (2026-09-25; dřív „Chat historie“ jen pro moda)
Levý klik na jméno v chatu otevře Profil **všem**; mod ho má i v nabídce (pravý klik → „Profil“).
Panel `extension/core/user-history.js`, routy `backend/src/routes/userHistory.ts`, jádro `backend/src/lib/userHistory.ts`.

**Ochrana (pokyn usera — data smí vidět jen oprávnění):**
- všechny tři routy: `Cache-Control: no-store` už v `onRequest` (i pro 401/403/429), validace query (400),
- `messages` + `donations` (jen mod): `requireWebSession` (bez / s neplatným tokenem **401**) → rate limit na účet
  (messages **5 + 2/s**, donations **5 + 1/s** vlastní) → mod AKTUÁLNÍHO `channel` (`resolveModGate` /
  `accountModIdentities`; nemod **403 `not_mod`**) — teprve potom jakýkoli dotaz na data nebo na Židolištu,
- `summary` (veřejná): nejdřív limit **per IP 10 + 1/s** (429) — ještě PŘED ověřením tokenu, ať náhodné Bearer
  tokeny nedělají DB dotazy bez omezení; pak session nepovinná (`optionalWebSession`: bez tokenu / neplatný token =
  nepřihlášený), přihlášený navíc limit na účet (**5 + 2/s**, společný s messages); nemod / nepřihlášený dostane
  **veřejný tvar** (`buildPublicSummary`) — výběr polí dělá server. Veřejná suma donů: Židolišta se ptá jen u cíle
  s UC účtem (bez něj je `ucNamed` vždy 0) a necachovaná volání z veřejného Profilu mají globální strop
  **60/min celkem** (`PUBLIC_DONATIONS_PER_MIN`; limit Židolišty je 300/min na klíč) — po vyčerpání summary bez
  `donations`. Cache 60 s na identitu platí i pro prázdný výsledek a chybu,
- cíl musí mít zprávu v archivu **aktuálního** kanálu (`resolveUserTargets`; podle loginu `archivedUserByLogin`
  v platformním kanálu z registru) — jinak **404 `not_found`** (ani podle loginu nejde procházet celý archiv),
- dona jen z workspace kanálu gate (`defaultWorkspace(channel)` z registru Židolišty), slug se od klienta nebere;
  `ZIDOLISTA_API_KEY` jen na serveru (nikdy do odpovědi ani do logu).
Testy: `backend/src/routes/userHistory.test.ts` (401 skutečným `requireWebSession`, 403 bez jediného volání dat,
veřejná pole pro diváka i nepřihlášeného, 404 mimo archiv kanálu, 429 per účet i per IP, no-store).

Cíl: `userId`, nebo **jen `login`** (bez `userId` — otevření z citace v odpovědi); odpověď summary nese `user.userId`,
klient ho pak posílá u dalších dotazů. Identity (mod) = cíl + všechny identity jeho UC účtu (i na platformách, které
kanál nemá). Zprávy = `messages`, kde `(platform, platform_user_id)` ∈ identity (index `messages_platform_user_sent_idx`
na `(platform, platform_user_id, sent_at DESC) INCLUDE (channel)`, SQL `backend/sql/2026-09-25-user-history-index.sql`;
stránka zpráv = UNION ALL s LIMIT per identita). Záložky (identity + počty po kanálech) se cachují per
(účet moda, kanál, cíl) 10 s; summary je vždy přepočítá. Kanál záložky = UC kanál (Twitch login streamera):
Kick/YouTube kanál → registr Židolišty (Twitch kanál workspace), jinak adresář `streamers`, jinak platformní kanál sám.

### `GET /moderation/user-history/summary?channel=&platform=&userId=&login=`
S `userId` je `login` jen do logu serveru; bez `userId` se cíl hledá podle `login`.

**Mod aktuálního kanálu** (`view: "mod"`):
```json
{ "ok": true, "view": "mod",
  "user": { "platform": "twitch", "userId": "1", "login": "spammer", "displayName": "SpAmMeR",
            "nickname": "Pan S", "color": "#ff0000",
            "identities": [{ "platform": "twitch", "login": "spammer", "userId": "1", "displayName": "SpAmMeR" },
                           { "platform": "youtube", "login": "jouki728", "userId": "UCx", "displayName": "Jouki" }],
            "firstSeen": 1790000000000, "lastSeen": 1790500000000, "total": 11 },
  "channels": [{ "channel": "robdiesalot", "count": 7, "firstAt": 1790000000000, "lastAt": 1790500000000 },
               { "channel": "arcadebulls", "count": 3, "firstAt": 1790100000000, "lastAt": 1790200000000 }],
  "moderation": [{ "action": "timeout", "at": 1790400000000, "by": "twitch:modik", "platform": "twitch",
                   "params": { "durationSec": 600, "reason": "spam" } }],
  "latest": { "twitch": { "platform": "twitch", "id": "abc", "username": "SpAmMeR", "userId": "1",
                          "timestamp": 1790500000000, "color": "#1e90ff", "badgesRaw": "moderator/1,subscriber/12" } },
  "donations": { "total": { "czk": 1750, "byCurrency": { "CZK": 1250, "EUR": 20 } }, "count": 3,
                 "uc": { "czk": 1500, "count": 2 },
                 "guess": { "czk": 250, "byCurrency": { "CZK": 250 }, "count": 1 } } }
```
- `channels`: aktuální kanál **vždy první** (i s `count: 0`, pak `firstAt/lastAt: null`), další jen s `count > 0`,
  seřazené od posledně aktivního. `firstSeen/lastSeen/total` = přes všechny kanály (ms).
- `moderation`: posledních 20 z `moderation_actions` v **aktuálním** kanálu, akce `timeout|ban|unban|warn|permit|rename`
  (shoda `params.userId` + platforma akce, nebo `params.targets` obsahuje identitu). `params` jen `durationSec`,
  `reason`, u `rename` `nickname` (null = smazaná přezdívka). Mazání zpráv (`delete`) se neuvádí.
- `nickname`/`color` = přezdívka UnityChatu první identity, která ji má (cíl má přednost).
- `identities[].displayName` = `web_identities.display_name` (identita UC účtu), u cíle bez účtu jméno z poslední
  zprávy; `null` → klient ukáže login.
- Citace odpovědi (`replyTo`) na Twitchi nese `login` autora (IRC `reply-parent-user-login`, ingest
  `contentRaw.replyParentLogin`) — Profil autora citace se otevírá podle něj, bez něj podle `username`.
- `latest` = poslední zpráva každé identity v **aktuálním** kanálu (klíč = platforma) jen s poli pro badge
  (`badgesRaw`, `color`, id, jméno, čas) — **bez textu**, i když je zpráva smazaná. Platforma, kde v kanálu nepsal, chybí.
- `donations` = dona ve workspace aktuálního kanálu, sečtená z položek přes všechny identity po dedupu podle `id`:
  `total` všechno, `uc` jistá dona z UC (`matchedBy: 'uc'`), `guess` jen odhad podle jména (`matchedBy: 'nickname'`).
  **Pole chybí**, když Židolišta neodpoví (výpadek, 404, bez klíče) — panel pak sumu ani řádky neukáže.

**Divák / nepřihlášený** (`view: "public"`) — jen tahle pole, nic dalšího server nepošle:
```json
{ "ok": true, "view": "public",
  "user": { "platform": "twitch", "userId": "1", "login": "spammer", "displayName": "SpAmMeR",
            "nickname": "Pan S", "color": "#ff0000", "firstSeen": 1790000000000, "lastSeen": 1790500000000, "total": 5 },
  "latest": { "twitch": { "platform": "twitch", "id": "abc", "username": "SpAmMeR", "userId": "1",
                          "timestamp": 1790500000000, "color": "#1e90ff", "badgesRaw": "subscriber/12" } },
  "donations": { "ucNamed": { "czk": 1000, "count": 1 } } }
```
- statistika (`firstSeen/lastSeen/total`) **jen v aktuálním kanálu** a **jen za identitu, na kterou divák klikl**;
  `latest` také jen ta identita (jiné identity by prozradily propojené účty); přezdívka jen té identity,
- **chybí**: `identities`, `channels`, `moderation`, `donations.total|uc|guess|count`, položky a texty donů,
- `donations.ucNamed` = jistá dona z UC (`matchedBy: 'uc'`), u kterých přezdívka dona = login nebo zobrazované jméno
  kliknuté identity (dárce se neskrýval). Kdo donatoval pod jinou přezdívkou, do veřejné sumy se nepočítá.

### `GET /moderation/user-history/messages?channel=&platform=&userId=&login=&inChannel=&before=&limit=`
Jen mod. `inChannel` = záložka (UC kanál, výchozí aktuální; smí být jiný), `limit` 1–100 (výchozí 50),
`before` = kurzor `<sent_at_ms>:<id>` jako `/chat/history`.
```json
{ "ok": true, "messages": [ "/* tvar /chat/history (toClientMessage), historical: true */" ], "nextBefore": "1790000000000:123" }
```
Pořadí **stejné jako `/chat/history`**: v rámci stránky nejstarší → nejnovější, `nextBefore` = další (starší) stránka,
`null` = konec. Smazané / skryté zprávy jdou bez obsahu (`deleted: true` / `hidden: true`) — konzistentní s chatem.
Záložka, kde uživatel nic nenapsal → `{ ok: true, messages: [], nextBefore: null }`.
Chyby: 400 `query` | `before` | `in_channel` | `channel`, 401, 403 `not_mod`, 404 `not_found`, 429 `rate_limited`.

### `GET /moderation/user-history/donations?channel=&platform=&userId=&login=`
Jen mod. Řádky „💸 poslal QR dono …“ v Profilu (jen záložka aktuálního kanálu). Samostatná routa (ne součást stránky
zpráv): dona se nestránkují spolu se zprávami, panel je zařadí mezi zprávy podle času. Server stáhne všechna dona
identit (Židolišta, max 5 stránek × 200 na identitu, cache 60 s na identitu — sdílená se summary), dedup podle `id`
(jistá shoda `uc` má přednost před odhadem), od nejnovějšího.
```json
{ "ok": true, "available": true,
  "items": [{ "id": "d1", "amount": 150, "currency": "CZK", "amountCzk": 150, "paidAt": 1790500000000,
              "via": "qr", "matchedBy": "uc", "nickname": "Divák", "message": "díky za stream" }] }
```
`available: false` (a `items: []`) = Židolišta nedostupná. Chyby jako u messages.

### Zdroj: Židolišta
`GET <ZIDOLISTA_API_BASE>/integrations/:slug/donations?platform=&userId=&login=&limit=1..200&before=<ISO>`
→ `{ ok, workspace, total: { czk, byCurrency, uc, ucNamed }, count, items: [{ id, amount, currency, amountCzk,
paidAt (ISO), via: 'unitychat'|'qr'|'fourthwall'|'qr_old', matchedBy: 'uc'|'nickname', nickname, message? }], nextBefore }`,
stránkování `nextBefore` → `before`, limit Židolišty 300/min na klíč (proto cache 60 s na identitu).
Hlavičky: `X-Api-Key: ZIDOLISTA_API_KEY` + `X-UC-Signature: t=<unix s>,v1=<hex HMAC-SHA256(klíč, t + "." + signed)>`,
`signed` = `"GET " + cesta s query přesně tak, jak se posílá` (bez hostu; `signedGetPath` = pathname + search výsledné
URL, tj. i s případným prefixem z `ZIDOLISTA_API_BASE`, výchozí base prefix nemá), okno ±300 s; sdílený helper
`zidolistaSignature` / `zidolistaGetHeaders` v `lib/zidolista.ts` (pro další volání UC → Židolišta).
`total`/`count` Židolišty se nepoužívají — jsou za jednu identitu, takže by se dono spárované přes víc identit
sečetlo dvakrát; součty (`total`, `uc`, `guess`, veřejné `ucNamed`) počítá UnityChat z položek po dedupu podle `id`.
Omezení: u diváka s víc než 1 000 dony na jednu identitu (5 × 200) jsou součty jen z načtených položek (log
`donations: víc stránek, než se stahuje`).

## Obsah smazaných / skrytých zpráv pro moda (2026-09-25)
`/chat/history`, `/chat/stream` i `/moderation/user-history/messages` (Profil) posílají smazané a skryté zprávy
**bez obsahu** všem (i modům). Mod si text dotáhne zvlášť:

### `GET /moderation/deleted-content?channel=&ids=<platform>:<id>,…`
Bearer + mod `channel` (`resolveModGate`, nemod → `403 not_mod`, DB se nečte), vlastní rate limit per účet
**10 + 2/s** (429 `rate_limited`), `Cache-Control: no-store`. `ids` = nejvýš **100** klíčů `platform:id`
(čárkou, dedup; id smí obsahovat `:`), jinak `400 ids`.
```json
{ "ok": true, "messages": { "twitch:3fcf0d19-…": { "/* tvar /chat/history (toClientMessage) i s textem, emoty, replyTo */": 0,
                                                  "deleted": true, "deletedReason": "mod" },
                            "kick:k1": { "…": 0, "hidden": true } } }
```
- Vrací jen zprávy, které jsou v archivu, patří **platformnímu kanálu** `channel` (registr, `channelMatches`)
  a jsou smazané nebo skryté. Ostatní klíče v odpovědi chybí (nesmazaná zpráva → klient ji má z historie).
- GIF (`gif`) se neposílá (smazaný GIF server neservíruje).
- Klient (sdílený core `extension/core/moderation.js`): `DeletedContentLoader({ api, channel, onContent })`
  sbírá požadavky 250 ms, dedup, po 100 klíčích; `request(platform, id)` volat u moda pro každou vykreslenou
  smazanou/skrytou zprávu bez obsahu, `reset()` při přepnutí kanálu. Vzhled: `deletedView({ style, isMod, raw, hidden })`
  → `{ mode, dimmed, tag }` pro `applyDeleted(el, { mode, dimmed, tag, hasContent, hidden, restorable })`.
  Vzhled (user 2026-09-25 v2): **divák** vždy zašedlé „Zpráva smazána“ bez štítku a bez přeškrtnutí (skrytou nevidí);
  **mod** volí (`MOD_DELETED_STYLES`, řádek nastavení jen pro moda) `label` (zašedlé „Zpráva smazána“, bez štítku) /
  `dim` (zašedlý text + štítek) / `strike` (zašedlý přeškrtnutý text + štítek), uložené `hide` = `label`;
  **OBS (`raw`)** smazané i skryté zprávy skryje (`hide`). Bez textu se `dim`/`strike` kreslí jako label.

## Odkrytí zprávy jen v UnityChatu (2026-09-25)
Mod u **smazané** nebo **skryté** zprávy místo „Smazat zprávu“ vidí „Odkrýt zprávu“ (nabídka) a ikonu oka
v hover akcích (tooltip „Odkrýt zprávu (jen v UnityChatu)“). Zpráva se znovu zobrazí všem v UnityChatu
(addon, web, OBS); **na platformě zůstává smazaná** (platformy obnovení neumí).

### `POST /moderation/restore { channel?, platform, messageId }`
Bearer + brána moda (`modGate`: rate limit per účet 10 + 2/s → 429 `rate_limited`, kanál → 400 `channel`,
nemod → 403 `not_mod`), tělo špatně → 400 `body`. Zpráva musí být v archivu a patřit platformnímu kanálu
`channel` (registr + `channelMatches`, jako u delete), jinak **404** `{ ok:false, error:'not_found', result:'not_found' }`.

| Stav zprávy | Co se stane | Odpověď |
|---|---|---|
| smazaná, `deleted_reason` `mod` / `platform` / `link_filter` | `deleted_*` = NULL (`markRestored` s tímto důvodem), SSE `message-restored` s celou zprávou + integrační `chat.restored`, `moderation_actions` `action:'restore'`, `params.reason` = původní důvod, `result.restore` | `200 { ok:true, result:'ok' }` |
| smazaná, `gif_request` | nic (o GIFu rozhoduje karta ke schválení) | `409 { ok:false, error:'gif_pending' }` |
| smazaná, jiný / prázdný důvod | nic | `409 { ok:false, error:'not_restorable' }` |
| skrytá (`hidden_at`) | `publishUnhidden` (SSE `message-unhidden` + `chat.unhidden`), `moderation_actions` `action:'unhide'` | `200 { ok:true, result:'ok' }` |
| smazaná i skrytá | obojí v tomto pořadí | `200 { ok:true, result:'ok' }` |
| ani jedno (nebo mezitím odkryl jiný mod) | nic | `200 { ok:true, result:'not_deleted' }` |

Když je zpráva po akci celá vidět, odpověď `result:'ok'` nese navíc `message` (tvar `/chat/history`, s textem) —
Profil (bez SSE) z ní řádek vykreslí; chat stejně dostane `message-restored` / `message-unhidden`.

**Ozvěna smazání z platformy.** Po odkrytí server zprávu na **30 min** (`RESTORED_MS`) označí (`rememberRestored`,
`lib/messageDeletes.ts`); `publishDeleted` s `reason:'platform'` (Twitch CLEARMSG, Kick, YouTube) ji v té době
ignoruje — zpráva je na platformě smazaná, další smazání je jen ozvěna. Samotný 60s dedup `publishDeleted` nestačí:
obnovení ho maže (`forgetPublished`) a ozvěna po vlastním smazání modem může přijít až po odkrytí. Smazání modem
nebo filtrem značku zruší (nové rozhodnutí). Stejnou značku dává i obnovení permitem; obnovení po neúspěšném
převodu GIFu ne (tam se na platformě nic nesmazalo). Značka je jen v paměti procesu (restart ji zapomene),
tvrdý strop `RESTORED_MAX` = 2000 značek (nejstarší se zahodí).

Klient: `menuModel({ …, deleted: true })` → bez „Smazat zprávu“, s „Odkrýt zprávu“ (`buildModRequest('restore')`).
Oko / „Odkrýt“ jen u zpráv, které smazal nebo skryl server (historie `deleted`/`hidden`, SSE `message-deleted` /
`message-hidden`) — `applyDeleted(…, { restorable: true })` → třída `uc-deleted--restorable`. Zprávy ztlumené jen
po timeoutu / banu (`user-moderated`) ji nemají (server je smazané nemá), koš u nich zůstává;
po `message-restored` / `message-unhidden` (i od jiného moda) klient zprávu vykreslí zpět a v hover akcích
se vrátí koš.

## Část 4 — odměna „Posílání GIFů" (backend `lib/gifMedia.ts`, `lib/gifAccess.ts`, `lib/gifRequests.ts`, `routes/gif.ts`)

**SQL `backend/sql/2026-09-25-gif-requests.sql` se musí spustit PŘED nasazením backendu** (idempotentní):
```
docker exec -i <postgres> psql -U postgres -d unitychat < backend/sql/2026-09-25-gif-requests.sql
```
Tabulky `gif_media` (id = 32 hex, `bytes` bytea ≤ 10 MB, kind, content_type, size, sha256, width, height) a
`gif_requests` (id, channel = UC kanál, workspace, platform, platform_channel, user_id, login, message_id původní
zprávy, text_without_link, media_id, kind, width, height, meta `{displayName, color, badges}`, status
`pending|approved|rejected|expired|deleted`, decided_by, decided_at, created_at, expires_at); indexy `(status, expires_at)`,
`(channel, created_at)`, `(media_id)`.
**Úložiště = DB (bytea):** kontejner backendu nemá trvalý svazek; zamítnuté a propadlé médium se maže hned,
schválené zůstává (retence archivu).

### Odemčení (UnityChat → Židolišta)
- `GET <ZIDOLISTA_API_BASE>/integrations/:slug/gif-access?platform=&userId=&login=&role=` (X-Api-Key), role =
  nejvyšší ověřená z badge zprávy (`broadcaster|moderator|vip|sub|viewer`). Odpověď
  `{ ok, serverNow, allowed, until|null, cooldownUntil|null, cooldownSec, requestTtlSec }` (čas ISO nebo ms; přepočet
  přes `serverNow`). Cache 60 s per (workspace, platforma, uživatel, role). Chyba / bez klíče = neodemčeno.
- Po schválení `POST …/integrations/:slug/gif-used { platform, userId }` → `{ ok, cooldownUntil }`. Uživatel je v cooldownu
  **hned při schválení** (lokálně, podle `cooldownSec` z posledního `gif-access`, výchozí 60 s); selhání `gif-used` = jeden
  opakovaný pokus po 2 s, bez potvrzení platí lokální cooldown do vypršení. Potvrzení ho nahradí cooldownem Židolišty.
- Webhook `POST /commands/invalidate { workspace, reason: "gif-access", data: { etag } }` → cache workspace pryč;
  odpověď `{ ok, workspace }`, neznámý workspace `404 unknown_workspace`.

### Zachycení (ingest, v rámci filtru odkazů)
- Odkaz na GIF: stránky `tenor.com/view/…` (i `/<jazyk>/view/…`), `giphy.com/gifs/…`, `imgur.com/…` (`/a/`,
  `/gallery/`), `7tv.app/emotes/<id>` (→ `cdn.7tv.app/emote/<id>/4x.webp`); média `media*.tenor.com`, `c.tenor.com`,
  `media*.giphy.com`, `i.giphy.com`, `i.imgur.com/*.gifv` (→ `.mp4`); **libovolný přímý** `.gif/.webp/.mp4`.
- Platí pro autora s `allowed` (a bez cooldownu), **nezávisle na zapnutí filtru a na výjimkách** (odemčení řídí
  Židolišta); známí boti nikdy. Jedna čekající žádost na uživatele (další GIF = běžný odkaz).
- Stav přístupu v cache:
  - **odemčeno** → zpráva se hned označí `deleted_reason: 'gif_request'` (archiv i `/chat/stream` bez obsahu),
    SSE `message-deleted { …, reason: "gif_request" }` hned, převod na pozadí;
  - **neznámý** → filtr rozhodne jako vždy (smaže / pustí), přístup se ověří na pozadí; odemčeno + převod OK →
    zobrazená zpráva se smaže zpětně (`message-deleted`, reason `gif_request`), smazaná filtrem se jen přeznačí;
  - **neodemčeno** → běžný filtr odkazů.
- Převod: stránka → `og:video` (MP4), jinak `og:image`; médium s `Accept: image/*,video/*`. Ochrana SSRF: jen http(s)
  a porty 80/443, bez údajů v URL, všechny DNS adresy veřejné (privátní, loopback, link-local, CGNAT, multicast,
  IPv4-mapped/NAT64 zakázané; ověřující lookup i při samotném připojení), max 3 přesměrování (každé znovu ověřené),
  10 MB, 10 s celkem, Content-Type (`image/*`, `video/*`, octet-stream) + magic bytes (GIF87a/89a, RIFF…WEBP, MP4 `ftyp`),
  rozměry z hlavičky (GIF, WebP; MP4 z `tkhd`, jinak null).
- **Převod selže** → běžný odkaz: filtr by ho smazal → přeznačení na `link_filter` + akce filtru (platforma botem);
  filtr by ho pustil → v UC obnovení (`message-restored`, jako u permitu). Na platformě se nic nesmazalo.
- **Převod OK** → původní zpráva smazaná na platformě **botem workspace** (`deleted_reason` zůstává `gif_request`,
  permit ji neobnoví), médium do `gif_media`, žádost `pending`, `expires_at = now + requestTtlSec` (výchozí 300 s).
  Zámek „jedna žádost na uživatele“ platí hned po vzniku žádosti; když ji mod stihne rozhodnout dřív, než se ohlásí,
  `gif-pending` se už nepošle.
- Zprávu smazanou filtrem (`link_filter`) mohl během převodu obnovit permit → žádost ani médium nevzniknou.
- Text nad GIFem = zpráva bez odkazu na GIF **a bez dalších odkazů, které by filtr autorovi zablokoval** (povolené
  domény a odkazy autora s výjimkou zůstávají).
  Audit `moderation_actions` (`actor: "filter"`, `action: "gif_request"`; rozhodnutí `gif_approve` / `gif_reject`).

### Soukromé doručení — `/account/stream` (ticket, část 2)
`/nicknames/stream` je veřejný, čekající GIF tam nikdy nejde. Události jdou jen účtům s otevřeným `/account/stream`,
které jsou **mody kanálu** (`accountModIdentities`, cache 60 s) nebo **odesílatelem** (propojená identita
`web_identities` platformy + userId; dostane navíc `own: true`). Po připojení streamu přijdou čekající žádosti,
které účet smí vidět (`gif-pending`).
```
event: gif-pending
data: { "requestId": 12, "channel": "robdiesalot", "platform": "twitch", "login": "divak", "userId": "42",
        "messageId": "abc", "text": "hele lol",
        "media": { "url": "https://api.jouki.cz/media/gif/<32 hex>", "kind": "mp4", "width": 498, "height": 280 },
        "createdAt": 1790000000000, "expiresAt": 1790000300000, "own": true }

event: gif-decided
data: { "requestId": 12, "channel": "robdiesalot", "approved": false, "status": "rejected", "by": "twitch:modik" }
```
`status`: `approved` | `rejected` | `expired` (`by: null`). `media.url` je **absolutní** (`PUBLIC_BASE_URL`), klienti
(addon, web, OBS) načítají jen z api.jouki.cz. `kind` `mp4` → `<video autoplay loop muted playsinline>`, jinak `<img>`.

### UC routy (Bearer)
- `POST /moderation/gif/:requestId/decide { "approve": true }` — mod kanálu **žádosti** (kanál z DB, ne od klienta),
  rate limit per účet. `200 { ok, requestId, status }`; `404 not_found`; `403 not_mod`; už rozhodnuto nebo propadlo
  `409 { ok:false, error:'already_decided', status }` (první rozhodnutí vyhrává, podmíněný UPDATE); `400 body`.
  Schválení, jehož syntetickou zprávu se nepodaří zapsat do archivu ani napodruhé, se nerozešle (`gif-message` ani
  `/chat/stream`) a odpověď nese `published: false` (log `gif: schválený GIF se nezapsal do archivu`).
- `GET /moderation/gif/pending?channel=` — mod; `{ ok, requests: [<tvar gif-pending bez own>] }`.

### Médium
`GET /media/gif/:id` (bez auth, id 32 hex neuhodnutelné) — jen když patří žádosti `pending` nebo `approved`, jinak
`404`. Hlavičky: `Content-Type` podle ověřeného druhu, `Cache-Control` čekající `private, no-store`, schválené
`public, max-age=3600` (bez `immutable`, schválený GIF může mod smazat), `Content-Security-Policy: default-src 'none'; sandbox`,
`X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: cross-origin`. Rate limit per IP (60, 10/s).
Paměťová LRU cache 64 MB se stavem; souběžná čtení téhož média sdílí jedno načtení z DB; schválené médium se do cache
načte **před** rozesláním `gif-message`. Zamítnuté, propadlé i smazané médium dostane tombstone a už se nevrátí
(ani z načtení, které běželo souběžně se smazáním).

### Po schválení — všem
- Archiv: syntetická zpráva `messages` s `platform_message_id = "gif-<requestId>"` (platforma a autor původní
  zprávy, `channel` = platformní kanál, čas = schválení, `content` = text bez odkazu, `content_raw.gif`).
  `/chat/history` ji vrací běžně, zpráva má navíc `gif: { url, kind, width, height }`.
- SSE `/nicknames/stream`:
```
event: gif-message
data: { "channel": "robdiesalot", "requestId": 12,
        "message": { "platform": "twitch", "id": "gif-12", "username": "Divak", "userId": "42", "message": "hele lol",
                     "timestamp": 1790000100000, "historical": false, "color": "#ff0000", "badgesRaw": "subscriber/1",
                     "gif": { "url": "https://api.jouki.cz/media/gif/<id>", "kind": "mp4", "width": 498, "height": 280 } } }
```
  Stejná zpráva jde i do `/chat/stream` (`event: message`) — klient, který poslouchá oba, deduplikuje podle
  `platform:id` (ChatStore). Pak `gif-used` do Židolišty (cooldown).
- Zobrazení: 100 %, max šířka chatu, max 400 × 250 px, poměr zachován.

### Smazání schváleného GIFu (část 1)
`POST /moderation/delete { platform, messageId: "gif-12" }` (i Chat Log Židolišty) funguje beze změny: SSE
`message-deleted`, archiv `deleted: true` bez obsahu i bez `gif`. Na platformě se nic nevolá (výsledek `ok`), žádost
→ `deleted`, médium se přestane servírovat.

### Integrační stream (`GET /integrations/chat/stream`)
```
event: gif.pending
data: { "type": "gif.pending", "workspace": "rob", "requestId": 12, "platform": "twitch", "userId": "42", "login": "divak",
        "messageId": "abc", "text": "hele lol", "media": { "url": "…", "kind": "mp4", "width": 498, "height": 280 },
        "expiresAt": "2026-09-25T12:05:00.000Z" }
event: gif.decided
data: { "type": "gif.decided", "workspace": "rob", "requestId": 12, "platform": "twitch", "userId": "42", "login": "divak",
        "status": "approved", "by": "twitch:modik" }
```
Původní zpráva přijde jako `chat.message` s `deleted: true` (bez textu) + `chat.deleted` s `reason: "gif_request"`.
Propadnutí: kontrola každých 10 s (`status: expired`, `by: null`).
