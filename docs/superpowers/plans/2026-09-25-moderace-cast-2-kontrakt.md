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

`gif-media` (2026-09-27) — změna viditelnosti zpráv se schváleným GIFem po zahození / obnově / odstranění souboru
/ odebrání z knihovny: `{ channel, mediaId, state: "visible"|"removed"|"unavailable"|"library", messageIds? }`, viz Část 4
„Trvale zahodit — dvě varianty".

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
do integračního streamu. **Od 2026-09-27** nese `chat.restored` navíc `text` a `message` (celá zpráva v tvaru
`chat.message`, bez `deleted`) — Židolišta ji mohla dostat jen bez textu (smazaná filtrem), takže commandy a log ji
mají až teď. Zpětně kompatibilní (jen přidaná pole). Na platformě zpráva zůstává smazaná. Smazání modem / platformou se permitem neobnovuje (na to je
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

## Vyhledání uživatele — `/user <jméno>` (2026-09-25)
Mod napíše do pole pro psaní `/user <text>` a našeptávač nabídne **všechny uživatele kanálu** z archivu
(i ty, kdo v této session nepsali). Výběr (Tab / Enter / → / klik) otevře Profil (`UserHistoryPanel.open`),
pole se vyprázdní, do chatu nejde nic. Divákům se `/user` nenabízí a nefunguje (text by odešel jako obyčejná zpráva).

### `GET /moderation/users/search?channel=&q=&fulltext=0|1&limit=`
`routes/userSearch.ts` + jádro `lib/userSearch.ts`. Pořadí ochrany: `Cache-Control: no-store` v onRequest (i 401/403/429)
→ `requireWebSession` (401) → validace query (400: `q` 1–40 znaků po odebrání úvodního `@`, `fulltext` jen 0/1,
`limit` 1–50, výchozí 20) → rate limit na účet 8 + 3/s (429) → `resolveModGate` na kanál (403 `not_mod`) — teprve pak DB.

Rozsah = UC kanál: Twitch = kanál, Kick/YouTube = platformní kanál z registru Židolišty (`registryPlatformChannel`,
stejně jako Profil a timeout/ban), `messages.channel IN (x, @x)`. Hledá se v `platform_username` (i ve starších
jménech po přejmenování) a v UC přezdívkách (`nicknames.nickname` → (platform, login) → zprávy s tímto jménem);
bez diakritiky a velikosti písmen přes `uc_fold()`, `%`/`_`/`\` v textu doslovně (`likePattern` z chatLog.ts).
`fulltext=0` = začátek jména, `1` = kdekoli. Kandidáti = distinct `(platform, platform_user_id)`, max 100, přesná
shoda jména v SQL první, pak poslední aktivita; ke každému počet zpráv v kanálu, poslední čas, poslední jméno
a barva (`content_raw.color`) + přezdívka/barva z `nicknames`. Řazení výsledku: přesná shoda (login, jméno nebo
přezdívka) → začátek → `lastSeen` → počet zpráv.

Odpověď `200 { ok: true, users: [{ platform, userId, login, displayName, nickname?, color?, lastSeen, count }] }`
(`login` = poslední jméno malými písmeny — stejná konvence jako Profil; `lastSeen` ms).

SQL `backend/sql/2026-09-25-user-search-index.sql` (**spustit na produkci před nasazením**, předpokládá
`2026-09-25-chat-log-search.sql` — `uc_fold`, `pg_trgm`, `messages_username_fold_trgm` pro fulltext): btree
`messages (channel, uc_fold(platform_username) text_pattern_ops)` pro prefix, trigram GIN na `uc_fold(nicknames.nickname)`.

### Klient (core `extension/core/user-search.js`, addon `sidepanel.js`)
- `parseUserCommand(text)` → `{ query }` / null; `UserSearch({ api, channel, local, onResults })`: lokální uživatelé
  ze session hned, server po debounce 200 ms, starý požadavek se zruší (`AbortController`), cache 30 posledních dotazů
  (klíč kanál + fulltext + text bez diakritiky), sloučení session + server (dedup platforma + userId / login).
- Render položky `userSearchItemHtml` (barevná tečka, logo platformy, přezdívka + šedě login; CSS `.es-plat`,
  `.es-login`, `.es-status` v `sidepanel.css`). Přepínač **Fulltext** jako u emotů, ale vlastní uložený stav
  `config.acUserFulltext` (hledání lidí ≠ hledání emotů).
- Addon: jen když `_canModerate`; `/us…` napoví příkaz `/user`; ↑/↓ a Shift+Tab posouvají výběr, Tab / Enter / → /
  klik otevře Profil; Esc zavře. Enter s `/user …` bez seznamu nic neodešle (jen nápověda). UC_LOG `UserSearch`, `Profile`.
- Web: stejný core + `profile.open({ channel, platform, userId, login, displayName, nameColor })`; `api` musí propustit
  `signal`.

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
zprávy, text_without_link, media_id, kind, width, height, meta `{displayName, sentAt, color, badges, auto?}`, status
`pending|approved|rejected|expired|deleted`, decided_by, decided_at, created_at, expires_at); indexy `(status, expires_at)`,
`(channel, created_at)`, `(media_id)`.
**Úložiště = DB (bytea):** kontejner backendu nemá trvalý svazek. Od GIF knihovny (2026-09-26, SQL
`backend/sql/2026-09-26-gif-library.sql`, spustit PŘED nasazením) se zamítnuté médium **nemaže** (status `rejected`,
retence 14 dní, vault), propadlé se maže jen když na něj nečeká jiná žádost, schválené zůstává v knihovně — viz
**„GIF knihovna"** na konci této části.

### Odemčení (UnityChat → Židolišta)
- `GET <ZIDOLISTA_API_BASE>/integrations/:slug/gif-access?platform=&userId=&login=&role=` (X-Api-Key), role =
  nejvyšší ověřená z badge zprávy (`broadcaster|moderator|vip|sub|viewer`). Odpověď
  `{ ok, serverNow, allowed, until|null, cooldownUntil|null, cooldownSec, requestTtlSec, mode, cooldownGlobalSec }`
  (čas ISO nebo ms; přepočet přes `serverNow`). `mode: 'all' | 'approved'` (režim odměny, chybí / neznámé = `all`;
  neodemčený uživatel dostane `all` a rozhoduje `allowed: false`), `cooldownGlobalSec` = cooldown celého chatu
  (`cooldownUntil` je už pozdější z globálního a osobního). Cache 60 s per (workspace, platforma, uživatel, role).
  Chyba / bez klíče = neodemčeno (a režim `all`). **`allowed: false` → `cooldownSec` / `cooldownUntil` se ignorují**
  (u role bez oprávnění je to jen výchozí hodnota Židolišty) a jeho `cooldownGlobalSec` si server nepamatuje (2026-09-27).
- Po schválení `POST …/integrations/:slug/gif-used { platform, userId, role }` (role stejná jako v `gif-access`, uložená
  v `meta.role` žádosti; staré žádosti bez ní) → `{ ok, cooldownUntil | null, cooldownSec, cooldownGlobalSec }`;
  **`cooldownUntil: null` = bez cooldownu** (ne neznámo), `cooldownGlobalSec` 0 = globální cooldown pryč. Uživatel je
  v cooldownu **hned při schválení** (lokálně, podle `cooldownSec` z posledního `gif-access` odemčeného uživatele);
  **výchozí hodnota neexistuje** (2026-09-27, bod 5): `cooldownSec` 0 ani neznámý (prázdná cache) lokální cooldown
  nezakládá — platí jen to, co nastaví Židolišta. Selhání `gif-used` = jeden opakovaný pokus po 2 s, bez potvrzení
  platí lokální cooldown do vypršení. Potvrzení ho nahradí cooldownem Židolišty. Klient (`core/gif-cooldown.js`)
  výchozí cooldown také nemá (jen `cooldownSec` z `/gif/state`, `done.cooldownUntil`, `gif-notice cooldown`).
  **Globální cooldown chatu drží server i sám (audit 2026-09-27, SEC-8):** po každém GIFu zobrazeném v chatu (schválení
  modem, auto, okamžité schválení z knihovny) nastaví lokálně cooldown celého workspace na `cooldownGlobalSec` (z cache
  `gif-access`). Platí pro zachycení (`gifAccessSync` → neodemčeno), `/gif/state` (`cooldownUntil`) i pro okamžité
  schválení, které si slot bere synchronně (dva GIFy z knihovny naráz neprojdou oba; ten druhý = běžný odkaz, průběh
  `done` s `outcome: denied`). Mody bez výjimky. Dřív uživatelé s „allowed“ v 60s cache cooldown obešli.
- Webhook `POST /commands/invalidate { workspace, reason: "gif-access", data: { etag } }` → cache workspace pryč;
  odpověď `{ ok, workspace }`, neznámý workspace `404 unknown_workspace`. **Od 2026-09-27** zároveň veřejné SSE
  `gif-access-change { channel }` na `/nicknames/stream` pro každý Twitch kanál workspace (bez osobních dat —
  webhook stejně nenese, koho se změna týká). Přihlášený klient (`GifCooldown.onAccessChange`) si pak stav přenačte
  `GET /gif/state` (i čerstvý) s náhodným zpožděním 0–2 s, víc událostí za sebou = jeden dotaz → pásek a tooltip
  u ikony emotů naskočí hned po aktivaci odměny (dřív až po otevření záložky / GIF odkazu v poli).

### Zachycení (ingest, v rámci filtru odkazů)
- Odkaz na GIF: stránky `tenor.com/view/…` (i `/<jazyk>/view/…`), `giphy.com/gifs/…`, `imgur.com/…` (`/a/`,
  `/gallery/`), `7tv.app/emotes/<id>` (→ `cdn.7tv.app/emote/<id>/4x.webp`); média `media*.tenor.com`, `c.tenor.com`,
  `media*.giphy.com`, `i.giphy.com`, `i.imgur.com/*.gifv` (→ `.mp4`); **libovolný přímý** `.gif/.webp/.mp4`.
- Platí pro autora s `allowed` (a bez cooldownu), **nezávisle na zapnutí filtru a na výjimkách** (odemčení řídí
  Židolišta); známí boti nikdy. Jedna čekající žádost na uživatele (další GIF = běžný odkaz).
- Stav přístupu v cache:
  - **odemčeno** → zpráva se hned označí `deleted_reason: 'gif_request'` (archiv i `/chat/stream` bez obsahu),
    SSE `message-deleted { …, reason: "gif_request" }` hned, převod na pozadí;
  - **neznámý** a filtr by zprávu smazal → filtr ji smaže hned (`link_filter`), přístup se ověří na pozadí; odemčeno +
    převod OK → smazaná filtrem se jen přeznačí na `gif_request`;
  - **neznámý** a filtr ji pouští (nebo je vypnutý) → **od 2026-09-27 (audit A12) se schová hned** jako `gif_request`
    (jako u odemčeného — ostatní diváci čekající GIF nevidí ani během stahování), přístup se ověří; neodemčeno /
    převod selže / nejde o GIF → zpráva se obnoví (`message-restored`, jako u permitu);
  - **neodemčeno** → běžný filtr odkazů.
- Převod: stránka → `og:video` (MP4), jinak `og:image`; médium s `Accept: image/*,video/*`. Ochrana SSRF: jen http(s)
  a porty 80/443, bez údajů v URL, všechny DNS adresy veřejné (privátní, loopback, link-local, CGNAT, multicast,
  IPv4-mapped/NAT64 zakázané; ověřující lookup i při samotném připojení), max 3 přesměrování (každé znovu ověřené),
  10 MB, 10 s celkem, Content-Type (`image/*`, `video/*`, octet-stream) + magic bytes (GIF87a/89a, RIFF…WEBP, MP4 `ftyp`),
  rozměry z hlavičky (GIF, WebP; MP4 z `tkhd`, jinak null).
  **Limit rozměrů a snímků (audit 2026-09-27, SEC-7):** nad **2048 px** na stranu nebo nad **600 snímků** → převod
  selže s `too_large` (zpráva je běžný odkaz). Kontroluje se rozměr z hlavičky a sonda bez dekódování pixelů (GIF /
  WebP `sharp().metadata()`, MP4 `ffprobe -count_packets`); chybí-li nástroj, jen hlavička. Poškozené médium →
  `bad_media`. ffmpeg / ffprobe běží s `-f mp4 -protocol_whitelist file`.
- **Fallback přes Bright Data Web Unlocker** (`lib/gifUnlocker.ts`, 2026-09-26): když přímý pokus skončí Cloudflare
  challenge (403/503 + `cf-mitigated: challenge`, nebo 403 s HTML „Just a moment“ a `cf-` hlavičkami / `Server: cloudflare`),
  pošle se **stejná, už ověřená** URL (`assertPublicUrl` proběhne vždy předem) na `POST https://api.brightdata.com/request`
  `{ zone, url, format: "raw" }`. Status cíle z `x-brd-status-code`; vnější ≠ 200 nebo `x-brd-error` = chyba
  `unlocker_<x-brd-error-code|status>`. Na odpověď stejné kontroly (10 MB streamem, MIME + magic bytes, přesměrování
  i případná cílová adresa z odpovědi znovu ověřené → neveřejná = `blocked`); bez Content-Type rozhodnou magic bytes.
  Celkový limit převodu se s fallbackem prodlouží na 25 s. Denní strop `BRIGHTDATA_DAILY_CAP` (výchozí 100, reset
  o půlnoci UTC; po dosažení původní chyba `http_403`), negativní cache 10 min per URL po selhání, **nejvýš 3 pokusy
  na uživatele (kanál + platforma + id) za den** (audit 2026-09-27, L4 — vlastní server s „challenge“ nevyčerpá strop
  ostatním; další pokusy jdou bez fallbacku). Env
  `BRIGHTDATA_API_KEY` + `BRIGHTDATA_ZONE`, bez nich vypnuto. Log jen `gif: unlocker ok|err|skip { host, code }`, klíč
  nikdy. Bright Data je zpracovatel: dostane jen URL veřejného odkazu na GIF z chatu (žádné údaje o uživateli).
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
`status`: `approved` | `rejected` | `expired` (`by: null`). **Odesílatel (`own: true`) `by` nedostává** (nesmí vědět,
kdo o jeho GIFu rozhodl — závěrečná review 2026-09-26, M4); mody ho dostávají dál. `media.url` je **absolutní** (`PUBLIC_BASE_URL`), klienti
(addon, web, OBS) načítají jen z api.jouki.cz. `kind` `mp4` → `<video autoplay loop muted playsinline>`, jinak `<img>`.

### UC routy (Bearer)
- `POST /moderation/gif/:requestId/decide { "approve": true }` — mod kanálu **žádosti** (kanál z DB, ne od klienta),
  rate limit per účet. `200 { ok, requestId, status }`; `404 not_found`; `403 not_mod`; už rozhodnuto nebo propadlo
  `409 { ok:false, error:'already_decided', status, decidedBy }` (první rozhodnutí vyhrává, podmíněný UPDATE;
  `decidedBy` = `"<platform>:<login>"` moda, `"library"` = schváleno z knihovny, `null` = propadlo); `400 body`.
  Schválení, jehož syntetickou zprávu se nepodaří zapsat do archivu ani napodruhé, se nerozešle (`gif-message` ani
  `/chat/stream`) a odpověď nese `published: false` (log `gif: schválený GIF se nezapsal do archivu`). **Od 2026-09-27
  (audit A1)** žádost zůstává schválená a původní zpráva schovaná; zprávu dopíše **dorovnání** (níže). Dřív se původní
  zpráva přeznačila na `gif_rejected`.
- **Dorovnání schválených žádostí (audit A1):** 30 s po startu a pak 1×/min backend najde žádosti `approved`
  rozhodnuté před víc než 60 s (nejvýš 24 h zpět), kterým chybí syntetická zpráva `gif-<id>` nebo jejich médium
  zůstalo `pending` (restart / chyba DB mezi rozhodnutím a zápisem). Čekající médium schválí (souběh dedupu → sloučí),
  chybějící zprávu zapíše s časem schválení a rozešle (`gif-message`, `/chat/stream`). Médium zamítnuté / zahozené /
  smazané a zpráva chybí → žádost `rejected`, původní zpráva `gif_rejected` + `message-deleted`. Po 10 neúspěšných
  pokusech totéž.
- `GET /moderation/gif/pending?channel=` — mod; `{ ok, requests: [<tvar gif-pending bez own>] }`, **FIFO**
  (nejstarší první, `created_at`, `id`).

### Médium
`GET /media/gif/:id[?t=<token>]` (id 32 hex neuhodnutelné) — podle stavu **média** (`gif_media.status`): schválené
a čekající bez auth; **zamítnuté jen s tokenem** (viz GIF knihovna), jinak `404` (i neexistující). **Od 2026-09-27
(audit SEC-1)** zůstává zamítnuté médium jen s tokenem, i když na něj čeká nová žádost (dřív se chovalo jako čekající =
veřejné, takže šlo zamítnutý GIF znovu zveřejnit vlastním odkazem). `gif-pending` / `GET /moderation/gif/pending` /
`gif.pending` pak nesou `media.tokenRequired: true` a karta moda médium načítá s tokenem. Token se ověřuje nad
metadaty (stav, kanál) **dřív**, než se z DB načtou bajty (audit SEC-2). 404 i 401 GIF rout mají `Cache-Control:
no-store` (audit L12). Hlavičky: `Content-Type` podle ověřeného druhu, `Cache-Control`
čekající i zamítnuté `private, no-store`, schválené
`public, max-age=300` (bez `immutable`; od 2026-09-26 5 minut místo hodiny, ať se odebrání z knihovny projeví
brzy), `Content-Security-Policy: default-src 'none'; sandbox`,
`X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: cross-origin`. Rate limit per IP (60, 10/s).
Paměťová LRU cache 64 MB se stavem (položka nejvýš 10 min, audit L7); souběžná čtení téhož média sdílí jedno načtení z DB; schválené médium se do cache
načte **před** rozesláním `gif-message`. Smazané médium (propadlé, trvale zahozené, retence) dostane tombstone a už
se nevrátí (ani z načtení, které běželo souběžně se smazáním); změna stavu (zamítnuto, schváleno ze zamítnutých)
jen zahodí záznam z cache.

### Po schválení — všem
- Archiv: syntetická zpráva `messages` s `platform_message_id = "gif-<requestId>"` (platforma a autor původní
  zprávy, `channel` = platformní kanál, **čas = čas SCHVÁLENÍ** (GIF knihovna 2026-09-26: GIF se ukáže na konci
  chatu v UC i OBS), `content` = text bez odkazu, `content_raw.gif` včetně `origin`).
  `/chat/history` ji vrací běžně, zpráva má navíc `gif: { url, kind, width, height }` a
  **`gifOrigin: "<platform>:<messageId>"`** původní zprávy — **jen k párování** (optimistická zpráva odesílatele),
  klient nic nenahrazuje a vkládá podle času. `replaces` nesou už jen GIFy schválené před 2026-09-26 (historie).
- SSE `/nicknames/stream`:
```
event: gif-message
data: { "channel": "robdiesalot", "requestId": 12,
        "message": { "platform": "twitch", "id": "gif-12", "username": "Divak", "userId": "42", "message": "hele lol",
                     "timestamp": 1790000100000, "historical": false, "color": "#ff0000", "badgesRaw": "subscriber/1",
                     "gif": { "url": "https://api.jouki.cz/media/gif/<id>", "kind": "mp4", "width": 498, "height": 280 },
                     "gifOrigin": "twitch:abc" } }
```
  Stejná zpráva jde i do `/chat/stream` (`event: message`) — klient, který poslouchá oba, deduplikuje podle
  `platform:id` (ChatStore). Pak `gif-used` do Židolišty (cooldown).
- Zobrazení: 100 %, max šířka chatu, max 400 × 250 px, poměr zachován.

### Původní zpráva v klientech (UX 2026-09-25)
- Smazaná s `deleted_reason: 'gif_request'` (čeká na schválení / schválená) se v UnityChatu **nevykresluje vůbec**
  (divák ani mod, v chatu ani v Profilu; addon třída `uc-gif-held`, core `isGifHeldReason`). **Odesílatel** (od GIF
  knihovny 2026-09-26) vidí svou zprávu dál jako optimistickou se **štítkem** (core `GifOutbox`): kolečko průběhu
  (`gif-progress`), pak „Schvalování moderátorem ( )“. Ozvěna smazání z platformy (`reason: 'platform'`, bot ji smazal) ji neodkryje
  (core `gifHeldAfter`). SSE `message-deleted gif_request`, které předběhne zprávu z vlastního spojení (IRC), se
  pamatuje a zpráva se rovnou vykreslí schovaná.
- **Schváleno** → `gif-message` na konci chatu (viz výš); původní řádek zůstává `gif_request` (schovaný navždy).
- **Zamítnuto / propadlo** → důvod se v archivu přeznačí `gif_request → gif_rejected` a jde SSE
  `message-deleted { channel, platform, messageId, by: null, reason: "gif_rejected", at }` → ostatní ji ukážou jako
  **běžně smazanou**, **odesílatel** vidí svou zprávu dál s červeným štítkem „Zamítnuto moderátorem“ / „Vypršelo“.
  Zvolen vlastní důvod (ne `mod`): audit ukáže, že šlo o GIF, a mod ji v UnityChatu neodkryje
  (`POST /moderation/restore` → `409 not_restorable`, v klientu bez oka). Historie dává stejný výsledek.
  **`by` je u všech GIF důvodů (`gif_*`) na veřejném `/nicknames/stream` `null`** (audit 2026-09-27, SEC-4: odesílatel
  nesmí vidět, kdo rozhodl); mod je v `gif-decided` modům a v `moderation_actions`.

### Mod / broadcaster (UX 2026-09-25, **změna 2026-09-27**)
- **Od 2026-09-27 (spec `2026-09-27-gif-review-upravy-design.md` §5) mod / broadcaster NEMÁ GIF odměnu automaticky:**
  přístup (`gif-access` s `role: moderator|broadcaster`), cooldown (`gif-used` po schválení) i režim platí stejně jako
  pro diváka — Židolišta může mody odemknout sama podle role. Mod **bez** odemčené odměny = jako divák bez odměny
  (GIF cesta se nepoužije, zpráva je běžný odkaz; filtr odkazů mody nemaže, takže zůstane). Mod **s** odemčenou
  odměnou se dál schvaluje sám (níže), jen s cooldownem.
- GIF od moda / broadcastera s odemčenou odměnou (role z badge zprávy, stejný zdroj jako ostatní moderace) se
  **schválí rovnou** při zachycení: zpráva se hned schová (`gif_request`), médium se stáhne, žádost vznikne a projde
  stejnou cestou jako `decide` approve s `by = "<platform>:<login>"` (on sám), audit `gif_approve` s `params.auto: true`.
  Přístup z cache `unknown` → zpráva se schová hned a ověří se u Židolišty (`needAccess`), jako u diváka (od
  2026-09-27, audit A12; neodemčeno → obnoví se). Opakované zamítnutí ani zákaz 12 h se na mody
  nevztahují (jejich GIF = jejich rozhodnutí, schválí i dříve zamítnuté médium). Nikdo nic neschvaluje → `gif-pending`, `gif.pending`, `gif-decided` ani `gif.decided` se neposílají.
  Převod selže → zpráva se v UC obnoví (`message-restored`, mod filtr nemá).
  Schválení proběhne **hned po insertu žádosti, před mazáním na platformě**; auto žádost (`meta.auto`) se nevrací
  v `listPending` (`GET /moderation/gif/pending`, připojení `/account/stream`, načtení po startu), takže ji jiný mod
  nevidí ani nerozhodne.
- **Výjimka Dev mód:** mod, který píše z UnityChatu se zapnutým Dev módem, jde přes schvalování jako divák (testování).
  Klient pošle `gifReview: true` v `POST /chat/send` (server nahlásí před odesláním) nebo v `POST /chat/uc-sent`
  (záložní cesta přes kartu, po odeslání); backend páruje s echem jako `ucSends` / `ucReplies`
  (`lib/ucSends.ts` `gifReviews`: platforma, kanál, odesílatel, text do 20 s). Hlášení před zprávou → běžná GIF cesta
  (přístup ze Židolišty s rolí moda, cooldown); hlášení po zprávě → zjistí se po stažení média a z auto se stane
  běžná žádost (přístup už ověřený při zachycení), cooldown po schválení platí.
- Mod s odemčenou odměnou píšící přímo na platformě (mimo UC) = vždy auto.

### Bublina cooldownu (klient, UX 2026-09-25)
`GET /gif/state?channel=&platform=&review=1` (Bearer, rate limit 10 + 1/s per účet, `no-store`) — stav odměny pro
**vlastní** identitu účtu na platformě, kam uživatel píše (`platform`, jinak první propojená):
`{ ok, allowed, cooldownUntil|null, cooldownSec, serverNow, mode, cooldownGlobalSec, rewardUntil }` — **od 2026-09-27
i pro moda stejně jako pro diváka** (dřív `mod: true` = povoleno bez cooldownu; pole se už neposílá, klient ho ignoruje). `mode: 'all'|'approved'` = režim odměny (v `approved` klient
nabízí jen knihovnu), `cooldownGlobalSec` = cooldown celého chatu k zobrazení. Čas `cooldownUntil` je čas serveru, klient přepočte přes `serverNow`. Zdroj = stejný jako zachycení
(`chatRole` z archivu, `gifAccess` cache 60 s + lokální cooldown po schválení). `review=1` = Dev mód moda (jako divák).
Klient (core `gif-links.js` = kopie detektoru `lib/gifMedia.ts`, shodu hlídá `gifMedia.test.ts`; core
`gif-cooldown.js` `GifCooldown`): GIF odkaz v poli (input/paste) → dotaz (cache do konce cooldownu, jinak 60 s);
běžící cooldown → bublina nad polem s kolečkem `.uc-qd-ring` (QR dono) a sekundami, odpočet, po doběhnutí zmizí.
Odeslání GIFu během cooldownu se zablokuje (text zůstane, okraj pole červený, bublina červeně „Můžeš až za:“).
Po odeslání GIFu se cooldown nastaví lokálně z `cooldownSec`; vlastní `gif-decided` rejected/expired ho zruší,
approved ho obnoví od teď.

### Smazání schváleného GIFu (část 1)
`POST /moderation/delete { platform, messageId: "gif-12" }` (i Chat Log Židolišty) funguje beze změny: SSE
`message-deleted`, archiv `deleted: true` bez obsahu i bez `gif`. Na platformě se nic nevolá (výsledek `ok`), žádost
→ `deleted`. **Od GIF knihovny médium zůstává v knihovně** (smazání zprávy ≠ vyřazení GIFu; stejné médium může nést
víc zpráv).

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
Původní zpráva schovaná kvůli GIFu (`gif_request` — odemčený i **neznámý** přístup, audit A12) přijde **od 2026-09-27**
jako `chat.message` **s plným textem** a příznaky `held: true`, `hiddenReason: "gif_request"` (bez `deleted`; dřív
`deleted: true` a prázdný text, takže ji Židolišta neviděla vůbec). Integrace je důvěryhodná (podpis v2, workspace
kanálu). Pak `chat.deleted` s `reason: "gif_request"` a buď rozhodnutí (`gif.*`), nebo — převod selhal / neodemčeno /
nejde o GIF — `chat.restored` s `text` a `message`. Zpráva smazaná filtrem (`link_filter`) jde dál bez textu s
`deleted: true`. **`chat.deleted.by`** nese v integraci skutečného autora smazání i u GIF důvodů (`"filter"`, mod);
jen veřejné SSE `message-deleted` má u `gif_*` `by: null`.
Propadnutí: kontrola každých 10 s (`status: expired`, `by: null`). `gif.pending` nese při dříve zamítnutém GIFu
navíc `previouslyRejected: { at, by }`.

**`chat.held_settled` (od 2026-09-27)** — schovaná zpráva (`held`, `gif_request`) přestala čekat. Chodí **právě
jednou** za zprávu na **všech** cestách, i tam, kde `gif.decided` nechodí (tiché auto-schválení / zamítnutí), takže
Židolišta podle ní uzavře štítek „čeká na schválení GIFu". `gif.pending`, `gif.decided`, `chat.restored` a
`chat.deleted` zůstávají beze změny. Zpráva, která schovaná nikdy nebyla (zobrazená a hned zamítnutá / neodemčená),
`chat.held_settled` nedostane.
```
event: chat.held_settled
data: { "type": "chat.held_settled", "workspace": "rob", "platform": "twitch", "messageId": "abc",
        "outcome": "approved", "requestId": 12, "by": "twitch:modik" }
```
- `outcome`: `approved` | `rejected` | `expired` | `not_allowed` | `restored` | `link_filter`.
- `requestId`: jen když k zprávě vznikla žádost (u automatického zamítnutí bez žádosti chybí).
- `by`: kdo rozhodl — mod (`platforma:login`), Židolišta (`zidolista:<id>`), mod sám u vlastního GIFu; automatika
  (knihovna, filtr, propadnutí, dorovnání) = `"filter"`.
- `reason` (volitelné, strojový kód): u automatického zamítnutí `repeat` | `ban` | `purged` | `unapproved`;
  u `restored` / `link_filter` proč GIF neprošel (`denied` = neodemčeno, `cooldown` = globální cooldown chatu,
  kód převodu `too_large` / `no_media` / `http_403` …, `error`); u `not_allowed` případně kód převodu
  (`bot_protection`); u vzdaného dorovnání `reconcile:<důvod>`.

| Cesta | `outcome` | `by` |
|---|---|---|
| Rozhodnutí moda / Židolišty (i kaskáda na stejné médium, zamítnutí při zahození / zákazu 12 h) | `approved` / `rejected` | mod / `zidolista:<id>` |
| Propadnutí žádosti | `expired` | `filter` |
| Okamžité schválení — GIF z knihovny / mod s odemčenou odměnou (až po schování původní zprávy) | `approved` | `filter` / mod sám |
| Automatické zamítnutí (opakovaně zamítnutý, zákaz 12 h, zahozené médium, médium zahozené během zachycení) | `rejected` + `reason` | `filter` |
| Režim odměny „jen schválené" | `not_allowed` | `filter` |
| Převod selhal / neodemčeno / cooldown, filtr odkazů zprávu pouští | `restored` + `reason` (s ním i `chat.restored`) | `filter` |
| Totéž, ale filtr odkazů by zprávu smazal | `link_filter` + `reason` | `filter` |
| Schváleno, ale zpráva s GIFem se nezapsala → dopíše ji dorovnání | `approved` až po dopsání | mod |
| Dorovnání to vzdá (médium zahozené / pokusy vyčerpané) | `rejected`, `reason: "reconcile:…"` | `filter` |

Dedup v paměti procesu (posledních 5000 zpráv): opakovaná cesta (druhý pokus, souběh) událost znovu nepošle.
Židolišta má přesto brát `chat.held_settled` idempotentně (klíč `platform:messageId`) — paměť restart nepřežije
a replay po reconnectu (`Last-Event-ID`) ji doručí znovu.

### GIF knihovna (2026-09-26, spec `docs/superpowers/specs/2026-09-26-gif-knihovna-design.md`, plán Task 1)
**SQL `backend/sql/2026-09-26-gif-library.sql` spustit PŘED nasazením** (idempotentní):
`gif_media` + `channel`, `source_url_norm`, `status` (`pending|approved|rejected`), `approved_at`, `rejected_at`,
`rejected_by`, `vault`, `use_count`, `last_used_at` (staré řádky: `approved` jen s aspoň jednou žádostí `approved`,
média jen se smazanými zprávami → `rejected` (`rejected_by: "backfill"`), schválené duplikáty obsahu → nejstarší
zůstává schválené, ostatní čekající alias; unikátní `(channel, source_url_norm)` i `(channel, sha256)` pro schválené,
indexy zamítnutých a FIFO čekajících);
`gif_rejections(channel, media_id, platform, user_id, count, last_at)`; `gif_bans(channel, media_id, until, by)`;
`gif_access_tokens(id, account_id|null, integration_slug|null, token_hash, created_at, revoked_at)`.

**Dedup (zachycení):** (1) náš odkaz `https://api.jouki.cz/media/gif/<32 hex>` (i `PUBLIC_BASE_URL` host; výběr
z knihovny) → médium podle id, jen z téhož kanálu (jinak běžný odkaz); (2) normalizovaná URL zdroje (bez `utm_*`,
`fbclid`/`gclid`/…, bez fragmentu, schéma a host malými písmeny, parametry seřazené) → bez stahování; (3) po stažení
sha256 obsahu. Známé médium se znovu neukládá (přednost `approved` > `rejected` > `pending`).
- **Schválené** → rovnou `gif-message` (bez žádosti ke schválení, i od diváka; žádost vznikne interně jako okamžitě
  schválená `decided_by: "library"`, `meta.instant`, v `pending` se neukáže), `use_count++`, cooldown diváka platí
  (`gif-used`), původní zpráva smazaná na platformě botem. **Náš odkaz** (id) se nikdy nestahuje a od 2026-09-27
  (test2 bod 4) ani nečeká na zápis dávky ingestu (`FLUSH_WAIT_MS`) — přeznačení / obnovení původního řádku si ho
  počkají samy, jen když na ně dojde. Průběh u něj nemá fázi `download` (klient ukáže jen „Odesílám…“).
- **Čekající** (jiná žádost na totéž médium) → další žádost na stejné médium. **Schválení jedné žádosti schválí
  i ostatní čekající žádosti na stejné médium** (`gif-decided approved` jejich odesílatelům, audit `params.cascade`).
- **Zamítnuté** (divák; mody výjimka): aktivní zákaz 12 h nebo tentýž uživatel už má ≥ 2 zamítnutí tohoto média
  → **automaticky zamítnuto**: zpráva smazaná (`message-deleted reason gif_rejected`, na platformě botem), počítadlo
  +1, `gif-notice { kind: "auto_rejected", reason: "repeat"|"ban" }` odesílateli, audit `gif_auto_reject`; jinak
  žádost s `previouslyRejected: { at, by }` (poslední zamítnutí média) a `media.tokenRequired: true`. **Propadlá
  žádost na zamítnuté médium se počítá jako zamítnutí** (`gif_rejections.count + 1`, audit 2026-09-27, SEC-1) — jinak
  by šel zamítnutý GIF posílat ke schválení donekonečna, když mody kartu ignorují.
- Zamítnutí modem: médium `rejected` (`rejected_at/by`), `gif_rejections.count + 1` pro uživatele žádosti. Médium se
  **nemaže** (retence 14 dní). Propadnutí maže médium jen když je `pending` a neodkazuje na něj žádná jiná žádost kromě
  propadlých (čekající, schválená / smazaná = zpráva v archivu, např. čekající alias z backfillu).
- Souběh (dvě stažení téhož obsahu dřív, než se kterékoli uloží): při schválení druhého média unikátní index
  `(channel, sha256)` pozná, že stejný obsah už je schválený → žádosti se přesměrují na schválené médium, duplikát
  se smaže (gif-message nese URL schváleného média). Přesměrují se i syntetické zprávy (`content_raw.gif.mediaId`) a
  schválené médium převezme URL zdroje duplikátu, když žádnou nemá — stejná cesta jako sloučení duplikátu modem.
- Cache `/media/gif`: v paměti jen **schválená** (a stažená) média, nejvýš 10 min; čekající a zamítnutá se čtou pokaždé
  z DB (stav se mění rozhodnutím, propadnutím, obnovou).
- **GIF z knihovny souběžně s „Odebrat z knihovny“ (audit A2):** okamžité schválení schvaluje podmíněně jen dosud
  schválené médium. Když ho mod mezitím odebral, žádost se zamítne (bez strike), původní zpráva `gif_rejected`,
  odesílatel `gif-notice { kind: "auto_rejected", reason: "unapproved" }`; akce moda platí. Mod (auto) smí zamítnutý GIF
  dál schválit sám.

**Režim `approved`** (`gif-access.mode`, platí i pro mody): projde jen známé **schválené** médium (URL, sha256, náš
odkaz). Cokoli jiného → zpráva smazaná (`reason: "gif_not_allowed"`, SSE `message-deleted`, na platformě botem;
v UC neodkryvatelná jako `gif_rejected`), nic se neukládá, `gif-notice { kind: "approved_only" }` odesílateli,
audit `gif_not_allowed`. Neznámá URL se kvůli sha256 přesto stáhne (průběh běží), ale **jen přímo — Bright Data se
v tomto režimu nevolá**; skončí-li přímé stažení `bot_protection` (Cloudflare), bere se odkaz jako nový GIF (smazat
+ `approved_only`). Jiná chyba převodu = běžný odkaz.

**Soukromé SSE `/account/stream` (nové):**
```
event: gif-progress        # jen odesílateli (účet s propojenou identitou autora zprávy)
data: { "requestKey": "twitch:abc", "channel": "robdiesalot", "platform": "twitch", "messageId": "abc",
        "phase": "download", "pct": 30 }
```
`phase` / `pct`: `detect` 0 → `access` 10 → `download` 10–50 (skutečné bajty podle Content-Length; bez něj
1 − e^(−bajty/2 MB); posílá se po krocích ≥ 5 %) → `unlock` 50 (Bright Data; navíc `estimateMs` = odhadovaná doba
fallbacku (klouzavý průměr posledních 20 dob, škálovaný velikostí, když ji odpověď zná; strop 25 s) a `elapsedMs`
od začátku fallbacku — klient animuje lineárně 50→95 a zasekne se na 95; může přijít podruhé s přepočteným
odhadem) → `verify` 95 (staženo / známé médium bez stahování) → `done` 100 s `outcome`:
`pending` (čeká na moda → následuje vlastní `gif-pending`), `approved` (→ `gif-message` s `gifOrigin` = `requestKey`),
`rejected` (automaticky zamítnuto), `not_allowed` (režim approved), `failed` (převod selhal = běžný odkaz),
`denied` (neodemčeno), `cancelled` (zprávu mezitím obnovil permit). Bez účtu UnityChatu se nic neposílá.
**Od 2026-09-27 (test2 bod 4.1):** `done` s `outcome: "approved"` nese navíc `cooldownUntil` (čas serveru, ms; null =
bez cooldownu) a `serverNow` — tiché / okamžité schválení (mod, GIF z knihovny) `gif-decided` odesílateli neposílá,
takže jinak by klient nevěděl, že cooldown běží (mod mívá `cooldownSec` 0, globální cooldown chatu klient nezná).
Klient (`GifCooldown.onServerCooldown`) podle něj zablokuje další GIF (bublina „Můžeš až za:“, i výběr z knihovny).
```
event: gif-notice          # jen odesílateli
data: { "requestKey": "twitch:abc", "channel": "robdiesalot", "platform": "twitch", "messageId": "abc",
        "kind": "approved_only" }            # „Nové GIFy teď nejdou, vyber z GIFů v panelu"
data: { …, "kind": "auto_rejected", "reason": "repeat" | "ban" | "purged" | "unapproved" }   # label „Zamítnuto moderátorem" natrvalo
data: { …, "kind": "cooldown", "until": 1790497500000, "serverNow": 1790497460000, "removed": false }   # GIF odkaz během cooldownu
        # `removed: true` = zprávu hned smazal běžný filtr odkazů (hláška „… zprávu s odkazem smazal filtr odkazů.“);
        # jen u odemčené a nevypršelé odměny (`until`), jinak se nic neposílá (review M1/M2).
        # zůstal běžným odkazem (od 2026-09-27, test2 bod 4.1): klient u zprávy nenechá kolečko ani štítek, ukáže hlášku
        # „GIF můžeš poslat až za … — odkaz zůstal jako běžná zpráva.“ a nastaví cooldown; server loguje
        # „gif: cooldown → běžný odkaz“. Posílá filtr odkazů (přístup z cache `denied` kvůli cooldownu — gifCooldownUntilSync)
        # i zachycení (neznámý přístup / globální slot chatu obsazený).

event: gif-queue           # jen modům kanálu, po každé změně fronty (nová žádost, rozhodnutí, propadnutí)
data: { "channel": "robdiesalot", "pendingCount": 2, "headId": 12 }   # headId = nejstarší čekající (null = prázdná)
```
**Pojistka odesílatele (závěrečná review 2026-09-26, I3):** štítek u vlastní zprávy (core `GifOutbox`) se po ztrátě
SSE usadí dotazem `GET /gif/held?channel=&ids=<platform>:<messageId>,…` (veřejné, `no-store`, max 50 klíčů):
průběh bez další události 60 s, čekání na moda po `expiresAt` (z vlastního `gif-pending`, jinak 300 s) + 15 s
a po každém znovupřipojení `/account/stream`. Položka odpovědi `{ platform, messageId, state, reason?, message?,
status? }` — `state`: `held` | `visible` | `deleted` | `replaced` | `unknown`; **`status`** (nové, když k té zprávě
existuje žádost) = stav žádosti `pending` | `approved` | `rejected` | `expired` | `deleted`. Klient: `approved` /
`deleted` → štítek pryč (GIF je na konci chatu), `rejected` → „Zamítnuto moderátorem“, `expired` → „Vypršelo“,
`pending` → čeká dál, `visible` → běžná zpráva (převod selhal).
**Od 2026-09-27 (audit SEC-3, C1):** klíče syntetických zpráv `gif-<n>` vrací vždy `unknown` bez obsahu (sekvenční id
šla projít a vydat text GIFu, který mod schoval). `visible` nese zprávu ve veřejném tvaru jako `/chat/history`: GIF,
jehož médium už není veřejné → `deleted` s `reason: "gif_removed"` bez textu, skrytá zpráva bez obsahu. Dávkově jedním
dotazem na řádky a jedním na stavy žádostí, index `gif_requests_message_idx` (`backend/sql/2026-09-27-gif-audit.sql`).

Po připojení `/account/stream` přijdou čekající `gif-pending` a pro každý kanál, kde je účet mod a něco čeká,
`gif-queue`. `gif-pending` nese navíc `previouslyRejected: { at, by }` (mod) / `{ at }` (odesílatel, bez „kým";
⚠ „tento GIF byl už dříve zamítnut"). Klienti: karta = `headId` (FIFO), zámek tlačítek 1 s po `gif-queue` od
jiného moda, 0,3 s po vlastním kliku; `409 { status, decidedBy }` = „Už rozhodl X".

**Zamítnuté GIFy (mod kanálu):**
- `POST /moderation/gif/access-token { channel? }` (Bearer, mod kanálu, rate limit 5 + 1/10 s, `no-store`) →
  `{ ok, token, expiresAt, serverNow }` — nový náhodný token, **vrací se jen tady**; v DB jen SHA-256. **Od 2026-09-27
  (audit L1) token moda platí 30 dní od vydání** (`expiresAt` v čase serveru) a **odhlášení účtu** („Odhlásit se“ =
  `signOutAccount`) zneplatní všechny jeho tokeny. Token vložený do chatu v odkazu `…/media/gif/<id>?t=` server
  zneplatní (audit L13). Klient (zařízení / session) si ho
  drží a přidává do odkazů na zamítnutá média `…/media/gif/<id>?t=<token>`. Účet má **nejvýš 5 aktivních tokenů**
  (jeden na zařízení); šestý zneplatní nejstarší, ostatní platí dál. **Když klient s tokenem dostane `404`, vyžádá si
  jednou nový token a načte znovu** (token mohl vypadnout jako nejstarší, nebo účet přestal být modem — pak 403).
  URL požadavků se loguje bez hodnot `t`, `token`, `access_token`, `key`, `ticket` (`***`).
- Ověření v `/media/gif/:id?t=`: aktivní token + účet je **stále mod kanálu média** (`accountModIdentities`), nebo
  integrační token Židolišty (`integration_slug` = workspace kanálu; vydání `POST /integrations/:slug/gifs/access-token`,
  viz „GIF knihovna — Task 2"). Výsledek
  v cache 60 s (odebraný mod / zneplatněný token přestane platit do minuty). Bez / špatný token = `404`.
- `GET /moderation/gif/rejected?channel=&before=<rejectedAt ms>:<mediaId>` (Bearer, mod) →
  `{ ok, items: [{ mediaId, url, kind, width, height, rejectedAt, rejectedBy, vault, deleteAt|null }], nextBefore|null }`
  (nejnovější první podle `(rejectedAt, mediaId)`, stránka 50; `nextBefore` = kurzor `"<ms>:<mediaId>"` poslední
  položky, jinak `null`; neplatný kurzor `400 before`; `url` bez tokenu, `deleteAt` = `rejectedAt` + 14 dní, vault `null`).
- `POST /moderation/gif/:mediaId/approve|vault|purge|ban12h|unapprove` (Bearer, mod kanálu **média**) →
  `200 { ok, mediaId, action }` (ban12h: `{ ok, mediaId, bannedUntil, rejected: <počet zamítnutých čekajících> }`);
  `404 not_found`; `403 not_mod`; approve/vault nad nezamítnutým a purge nad čekajícím `409 { error: "not_rejected", status }`,
  ban12h nad schváleným `409 { error: "approved" }`, unapprove nad neschváleným `409 { error: "not_approved", status }`.
  - `approve` — do knihovny (approved); samo do chatu nic, ale **čekající žádosti na totéž médium se schválí**
    (jejich GIFy pak jdou do chatu jako při běžném schválení; odpověď `requests: N`); `vault` — zůstane zamítnutý,
    retence se na něj nevztahuje; `purge` — **nejdřív zamítne čekající žádosti na médium** (`requests: N`), pak
    **od 2026-09-27 nemaže hned**: viz „Trvale zahodit — dvě varianty" níž (`keepMessages`, bez něj 7 dní na obnovu);
    `ban12h` — „Automaticky zahazovat 12 h" (od všech), médium se označí `rejected` a
    **čekající žádosti na médium se hned zamítnou** (`by` = mod, stejně jako zamítnutí modem → každému čekajícímu
    odesílateli strike `gif_rejections.count + 1`); nad zahozeným `409 { error: "already_purged" }`.
  - Položka zamítnutých nese od 2026-09-27 i `tags` (náhled).
  - **Odebrat z knihovny** (Task 2): `unapprove` — schválený GIF → zamítnutý (`rejected_at/by`, bez `approved_at`
    a vaultu → retence 14 dní, od té chvíle jen s tokenem; staré zprávy s ním ho bez tokenu nenačtou); `purge` nad
    **schváleným** = od 2026-09-27 dvě varianty (`withdrawn` / `purging` se smazáním po 7 dnech), viz „Trvale zahodit“
    níž. **Záměrně:** `unapprove` i `purge` schváleného média (bez `keepMessages`) GIF skryje i ve **starých zprávách
    v historii** — mod
    GIF odebírá proto, že se nemá zobrazovat (rozhodnutí 2026-09-26). **Od závěrečné review (I2):** `/chat/history`
    (a do 2026-09-27 i Profil — od té doby viz „Úpravy po testu“ §3) pošle zprávu, jejíž médium není veřejné (zamítnuté = odebrané,
    neexistuje = trvale zahozené / sloučené), jako **smazanou** `{ …, message: '', deleted: true,
    deletedReason: "gif_removed" }` bez `gif` (divák „Zpráva smazána“ ztlumeně, OBS ji skryje, mod ji neodkryje).
    Stav médií se zjišťuje jedním dotazem na stránku. Čekající médium (alias z backfillu) zůstává vidět. Klienti
    místo odkazu „otevřít“ po chybě načtení média ukážou štítek „GIF odebrán“.
  - Audit `moderation_actions` `gif_media_<akce>` (`platform: "uc"`).
- Retence: **2 min po startu a pak 1×/h** (audit 2026-09-27, B2 — dřív až hodinu po startu, takže se při častých
  deployích z dev nespustila) se mažou zamítnutá média s `rejected_at` starším 14 dní bez vaultu (a bez čekající žádosti),
  zahozená `purging` po `purge_at`; propadlé zákazy se uklidí.

### GIF knihovna — Task 2 (knihovna, tagy, perceptuální hash, API pro Židolištu)
**SQL `backend/sql/2026-09-26-gif-phash.sql` spustit PŘED nasazením** (idempotentní, navazuje na `2026-09-26-gif-library.sql`):
`gif_media` + `tags text[]` (výchozí `{}`), `phash text[]` (dHashy, 16 hex; `NULL` = nespočítáno / selhalo), `phash_at`
(pokus o hash, i neúspěšný), `dup_checked_at`; index knihovny `(channel, use_count desc, last_used_at desc, id desc)`
pro schválené; `gif_duplicates(id, channel, a, b, score, status 'pending'|'kept_both', created_at, decided_at, decided_by)`,
`a`/`b` → `gif_media` `ON DELETE CASCADE`, dvojice unikátní bez ohledu na pořadí (`LEAST/GREATEST`).
Docker image backendu má `ffmpeg` (MP4); `sharp` (GIF/WebP) je v závislostech.

**Použití:** `use_count + 1` a `last_used_at` při každé zprávě, která zobrazí schválený GIF (schválení žádosti,
dedup známého schváleného média i odkaz `api.jouki.cz/media/gif/<id>` = okamžité schválení z knihovny; kaskáda
čekajících žádostí na totéž médium se počítá po jedné). Beze změny od Tasku 1 (`decideCore`).

**Tagy:** při stažení ze **stránky** Tenor / Giphy / Imgur (HTML, které se stahuje kvůli `og:video`, žádný požadavek
navíc): `og:title` / `twitter:title` bez přípony zdroje („… GIF - … - Discover & Share GIFs“, „… GIF by X - Find &
Share on GIPHY“), `<meta name="keywords">` a `keywords` z JSON-LD. Normalizace (i při úpravě): malá písmena, bez `#`,
bez obecných slov (`gif`, `animated gif`, `sticker`, `tenor`, `giphy` …) a duplicit, každý tag ≤ 40 znaků, nejvýš
20 tagů. Přímý odkaz na soubor tagy nemá.

**Perceptuální hash a návrhy duplikátů:** dHash 64 bit z **8 snímků rovnoměrně v čase** (GIF/WebP přes `sharp` podle
délek snímků, MP4 přes `ffprobe` + `ffmpeg -vf fps=8/délka` od půlky prvního intervalu); podobnost = podíl snímků
s Hammingovou vzdáleností **≤ 10** přes posunuté zarovnání sekvencí (vůči kratší sekvenci), **≥ 0,6** = návrh. Plochý
snímek se za shodu nepočítá. Výpočet je omezený: ffmpeg `-threads 1` a zabití po 20 s, sharp jedno vlákno,
`limitInputPixels` 25 M (od 2026-09-27, dřív 100 M) a nejvýš 20 s (jinak hash `NULL` + varování). Na pozadí **1 médium za 2 s** (bez práce / chyba 30 s): nejdřív hash rozhodnutých médií
(`approved` přednostně, pak `rejected`; čekající až po rozhodnutí), pak porovnání jednoho média s médii **téhož
kanálu** → `gif_duplicates` jen pro dvojici, která ještě nemá záznam (`a` = starší = „první"). Chybí `ffmpeg`/`sharp`
nebo selže → `phash` zůstane `NULL`, varování `gif phash: výpočet selhal`, médium funguje dál (znovu se nezkouší).
Nic se neslučuje samo.

**Veřejné — knihovna (addon, web, OBS; divák bez odměny ji vidí):**
- `GET /gifs/library?channel=&q=&cursor=&limit=` (bez auth, rate limit per IP 10 + 5/s, `no-store`) →
  `{ ok, items: [{ mediaId, url, kind, width, height, tags, useCount, lastUsedAt|null }], nextCursor|null }` — jen
  `approved` kanálu, řazení `useCount` desc, `lastUsedAt` desc (bez použití poslední), `mediaId` desc; `url` =
  `https://api.jouki.cz/media/gif/<id>` (výběr → tenhle odkaz do chatu → dedup = rovnou schválený); `q` = podřetězec
  v tagech (malými); `limit` výchozí 50, max 100; `cursor` = `nextCursor` (`<useCount>:<lastUsedMs|0>:<mediaId>`),
  neplatný `400 cursor`, špatný kanál `400 channel`.

**Mod v UC (Bearer, mod kanálu):**
- `GET /moderation/gif/duplicates?channel=` → `{ ok, items: [<návrh>] }` (čekající, nejstarší první, max 50), návrh:
  `{ id, channel, score, status, createdAt, first: <médium>, second: <médium> }`, médium
  `{ mediaId, url, kind, width, height, status, tags, useCount, createdAt }` (`url` bez tokenu — u zamítnutého ho klient
  přidá sám). `first` = starší.
- `POST /moderation/gif/duplicates/:id/keep-first|keep-second|keep-both` (mod kanálu **návrhu**) →
  `200 { ok, id, action, kept?, removed? }`; `404 not_found` (i neznámá akce); `403 not_mod`;
  už rozhodnuto `409 { error: "already_decided", status }` (sloučení zamyká řádek návrhu `FOR UPDATE` a vyžaduje
  `pending`, takže souběžné keep-both + keep-first nic nesloučí); návrh / médium mezitím pryč (souběh)
  `409 { error: "gone" }`. Chybí tabulka / sloupec (SQL neběželo, 42P01 / 42703) → `503 { error: "not_ready" }`,
  jiná chyba DB → `500 { error: "internal" }` (platí i pro `/gifs/library` a integraci).
  - `keep-both` → `kept_both` (znovu se nenavrhne).
  - `keep-first` / `keep-second` = **sloučení** do ponechaného média (transakce): žádosti a syntetické zprávy
    `gif-<requestId>` (`content_raw.gif.mediaId`) se přesměrují, `use_count` se sečte, `last_used_at` pozdější, tagy
    sjednocené; když bylo v knihovně odebírané médium a ponechané ne, ponechané se schválí; vault jen když výsledek
    není schválený (schválené médium vault nemá). Druhé médium se smaže
    (jeho počítadla zamítnutí, zákaz a ostatní návrhy kaskádou), `/media/gif` tombstone. URL zdroje
    (`source_url_norm`) zahozeného média ponechané převezme, když žádnou nemá (a nekoliduje se schváleným médiem
    kanálu). Má-li obě média URL, schéma drží jen jednu: dedup bez stahování pak zná jen URL ponechaného, URL
    zahozeného se pozná až po stažení podle sha256 (u vizuálně podobného, ne stejného obsahu vznikne nová žádost).
  - Audit `moderation_actions` `gif_duplicate_keep_first|keep_second|keep_both` (`platform: "uc"`).
- `POST /moderation/gif/:mediaId/unapprove` — viz „Odebrat z knihovny" výš.

**Integrace Židolišty (`inboundAuthorized` — X-Api-Key + podpis; kanál JEN ze slugu, médium / návrh jiného kanálu
`404 not_found`; neznámý slug `404 unknown_workspace`; rate limit per workspace 30 + 10/s; `no-store`):**
- `GET /integrations/:slug/gifs?q=&cursor=&limit=` — knihovna, tvar jako `/gifs/library`.
- `PUT /integrations/:slug/gifs/:mediaId/tags { tags: string[], actor? }` → `{ ok, mediaId, tags }` (normalizované);
  špatné tělo `400 body`.
- `GET /integrations/:slug/gifs/rejected?before=<ms>:<mediaId>` — tvar jako `/moderation/gif/rejected`.
- `POST /integrations/:slug/gifs/:mediaId/approve|vault|purge|ban12h|unapprove { actor? }` — stejné akce a odpovědi
  jako mod v UC (`by` = `zidolista:<actor.userId>`, bez aktéra `zidolista`).
- `GET /integrations/:slug/gifs/duplicates` a `POST /integrations/:slug/gifs/duplicates/:id/keep-first|keep-second|keep-both { actor? }`
  — jako mod v UC.
- `POST /integrations/:slug/gifs/access-token` (rate limit 5 + 1/10 s) → `{ ok, token }` — **integrační token** pro
  zamítnutá média (`/media/gif/<id>?t=<token>`), platí pro kanál workspace; vrací se **jen tady**, v DB jen SHA-256,
  nový zneplatní předchozí. Dashboard si ho drží; `404` na médiu = vyžádat nový.
- `actor` (volitelný) = `{ source: "zidolista", userId, name, role }` jako u moderace; neplatný `400 body`.

### Trvale zahodit — dvě varianty + náhled (2026-09-27, spec `docs/superpowers/specs/2026-09-27-gif-nahled-zahozeni-design.md`)
**SQL `backend/sql/2026-09-27-gif-purge.sql` spustit PŘED nasazením** (idempotentní): `gif_media` + `purged_at`,
`purged_by`, `purge_at`, `status_before_purge`; indexy pro seznamy zahozených a retenční tick. `status` je text bez CHECK
— nové stavy **`withdrawn`**, **`purging`**, **`unavailable`**. Bez SQL backend na nové sloupce padá (42703).

**Stavy a přechody:**
- `approved | rejected` —`purge { keepMessages: true }`→ **`withdrawn`** („Zahodit, zprávy nechat"): mimo knihovnu
  i zamítnuté, soubor zůstává, staré zprávy GIF ukazují **veřejně** (i dříve odebrané z knihovny se znovu ukážou).
- `approved | rejected` —`purge` bez `keepMessages` / `false`→ **`purging`** („Zahodit i se zprávami"): zprávy hned
  schované (`gif_removed`), `purge_at` = teď + **7 dní**; retenční tick (1×/h) pak smaže soubor i záznam.
  **Zpětně kompatibilní:** dnešní `purge` bez parametru = tahle varianta (dřív mazal hned, teď 7 dní + obnova).
- `purging` —`restore`→ stav před zahozením (`status_before_purge`: approved zpět do knihovny + zprávy vidět, rejected
  zpět do zamítnutých). Stejný obsah mezitím schválený jako jiné médium → sloučení do něj (jako duplikát).
- `withdrawn` —`remove-file`→ **`unavailable`**: bajty smazané, záznam zůstává; zprávy ukážou štítek „[GIF nedostupný]".
  **Nevratné.** `/media/gif` tombstone.
- Čekající žádosti na médium `purge` nejdřív zamítne (`requests: N`). Zahozené se nesloučí jako duplikát (návrhy
  s ním se neukazují, sloučení `409 gone`) a nedostane `ban12h` (`409 already_purged`).

**Dedup:** nový odkaz (stejná normalizovaná URL / sha256 / náš odkaz `…/media/gif/<id>`) na `withdrawn`, `purging` nebo
`unavailable` médium = **automaticky zamítnuto** (jako zákaz 12 h; i od moda — auto-schválení by zahozené vrátilo
do knihovny): původní zpráva smazaná `gif_rejected`, odesílateli `gif-notice { kind: "auto_rejected", reason: "purged" }`,
audit `gif_auto_reject` (`reason: "purged"`). Pořadí `findMedia`: approved > zahozené > rejected > pending.

**UC routy (Bearer, mod kanálu média):**
- `POST /moderation/gif/:mediaId/purge { keepMessages?: boolean }` → `200 { ok, mediaId, action: "purge", status:
  "withdrawn"|"purging", purgeAt?: <ms>, requests? }`; čekající médium `409 not_rejected`, už zahozené
  `409 { error: "already_purged", status }`, `keepMessages` jiného typu než boolean `400 body`.
- `POST /moderation/gif/:mediaId/restore` → `200 { ok, mediaId, action, status: "approved"|"rejected" }`; jiný stav
  než purging `409 { error: "not_purging", status }`.
- `POST /moderation/gif/:mediaId/remove-file` → `200 { ok, mediaId, action, status: "unavailable" }`; jiný stav než
  withdrawn `409 { error: "not_withdrawn", status }`.
- `GET /moderation/gif/withdrawn?channel=&before=` a `GET /moderation/gif/purging?channel=&before=` (mod kanálu,
  `no-store`) → `{ ok, items: [{ mediaId, url, kind, width, height, tags, status, purgedAt, purgedBy, purgeAt|null,
  restoreTo: "approved"|"rejected" }], nextBefore|null }` — nejnovější zahození první, stránka 50, kurzor
  `"<purgedAt ms>:<mediaId>"`, neplatný `400 before`. `url` bez tokenu (purging ho potřebuje).
- Audit `moderation_actions` `gif_media_purge` (`params.keepMessages`), `gif_media_restore`, `gif_media_remove_file`.

**Integrace Židolišty:** stejné akce `POST /integrations/:slug/gifs/:mediaId/purge|restore|remove-file { actor?,
keepMessages? }` (purge bez `keepMessages` = i se zprávami) a `GET /integrations/:slug/gifs/withdrawn|purging?before=`.

**`/media/gif/:id`:** `withdrawn` veřejně (`public, max-age=300`, v paměťové cache), `purging` jen s tokenem moda /
integrace (`private, no-store`; náhled v „Ke smazání"), `unavailable` `404`. Cache se invaliduje při každé změně stavu
(zahození, obnova, odebrání), `remove-file` a smazání po 7 dnech = tombstone.

**Zprávy (`/chat/history`, stream; Profil moda od 2026-09-27 jinak — viz „Úpravy po testu“ §3):** podle stavu média (`gifMessageState`, jeden dotaz na stránku):
`approved`, `pending` (alias), `withdrawn` → GIF normálně; `rejected`, `purging`, médium neexistuje → smazaná
`{ message: '', deleted: true, deletedReason: "gif_removed" }` bez `gif`; `unavailable` → **nesmazaná** zpráva s textem
a `gif: { url, kind, width, height, unavailable: true }` (URL zůstává — starší klient dostane 404 → „GIF odebrán").

**SSE `gif-media` na `/nicknames/stream` (veřejné) — po každé změně stavu média (zahození, obnova, odstranění
souboru, odebrání z knihovny, schválení ze zamítnutých):**
`{ channel, mediaId, state: "visible"|"removed"|"unavailable"|"library", messageIds?: ["<platform>:<id>", …] }`.
- `removed` (unapprove, purge → purging): klient zprávy s tímto médiem ukáže jako smazané `gif_removed`.
- `unavailable` (remove-file): klient místo média ukáže štítek „[GIF nedostupný]" (text zůstává).
- `visible` (restore do knihovny, approve ze zamítnutých, purge odebraného z knihovny se `keepMessages`): nese jen
  `messageIds` (nejvýš 200 nejnovějších syntetických zpráv `gif-<id>`, nesmazané / neskryté) — klient si obsah těch,
  které má, dotáhne přes `GET /chat/messages` a vykreslí je na místě jako obnovené.
- `library` — viditelnost zpráv se nezměnila (approved→withdrawn, rejected→purging, purging→rejected), jen otevřené
  panely GIFů se načtou znovu (klient refetch rozprostře náhodně do 0–2 s).
- Nenese interní stav média ani kdo zahodil. Řeší i dřívější M5 (odebrání z knihovny se otevřeným klientům projeví hned).

**`GET /chat/messages?channel=&ids=<platform>:<id>,…`** (veřejné, bez auth, rate limit per IP 10 + 2/s, `no-store`) →
`{ ok, messages: [<zpráva jako /chat/history>] }` — nejvýš 200 klíčů, jen zprávy kanálu (Twitch login + YouTube / Kick
z adresáře), jen nesmazané a neskryté (i GIF zpráva s neveřejným médiem se vynechá), nejstarší první. Špatný kanál
`400 channel`, žádný platný klíč `400 ids`.

**Souběh schválení se zahozením:** `purge` zamítne čekající žádosti na médium v téže transakci jako změnu stavu
(pozdní klik moda → `409 already_decided`). Když se médium zahodí mezi rozhodnutím a schválením (karta moda,
instantní schválení známého GIFu v ingestu během stahování), `setMediaApproved` to pozná (0 řádků) → žádost se
zamítne, nic se nezapíše ani nerozešle (`gif-message`, cooldown), původní zpráva `gif_rejected`, odesílatel
`gif-notice { kind: "auto_rejected", reason: "purged" }`; odpověď moda `200 { ok, requestId, status: "rejected",
reason: "purged" }`.

**Obnova mezi zamítnuté = nové zamítnutí:** `rejected_at` = čas obnovy (retence 14 dní znovu od ní, `deleteAt` za
14 dní), `rejected_by` zůstává, bez něj kdo zahodil / obnovil. `status_before_purge` NULL → `rejected`.

**Klient (core `gif-library.js`, `gif.js`):** každá dlaždice (knihovna, Zamítnuté, duplikáty) má nabídku ⋯ s „Náhled"
(i divák v knihovně); v Zamítnutých a duplikátech otevře náhled i klik. Náhled = překryv nad GIF panelem (větší GIF,
rozměry, tagy, u zamítnutých kdo/kdy; zavření ×, klik mimo, Esc). „Trvale zahodit" = dialog se dvěma tlačítky
(„Zahodit, zprávy nechat" / „Zahodit i se zprávami") + Zrušit. Záložka Zamítnuté má sekce „Stažené GIFy"
(Odstranit ze serveru s potvrzením) a „Ke smazání" (odpočet „smaže se za 6 dní", Obnovit).

### Úpravy po testu (2026-09-27, spec `docs/superpowers/specs/2026-09-27-gif-review-upravy-design.md`)
Bez nového SQL. (Opravy ze závěrečného auditu 2026-09-27 mají `backend/sql/2026-09-27-gif-audit.sql` — jen index pro
`/gif/held`, backend běží i bez něj; změny jsou popsané přímo v sekcích výš.)

**§1 Schválení ruší tresty.** Jakékoli schválení média — `decide` approve (i auto modem, instantní z knihovny,
kaskáda), `POST …/:mediaId/approve` ze Zamítnutých, `restore` do schváleného, sloučení do schváleného (souběh dedupu,
obnova sloučená do schváleného, `keep-first|keep-second` s výsledkem schváleným) — v **téže transakci** smaže
`gif_rejections` (všech uživatelů) i `gif_bans` pro to médium. `unapprove` ani `purge` strike nepřidávají
(zamítnutí modem ano, jako dosud). **`ban12h` zamítá čekající žádosti na médium stejnou cestou jako zamítnutí modem,
takže každému čekajícímu odesílateli strike přidá** (oprava textu kontraktu podle kódu, audit 2026-09-27 K2); médium
samo strike nedostane. Propadlá žádost na zamítnuté médium strike přidá (audit SEC-1). Karta ⚠ „už dříve zamítnut“ (`previouslyRejected`) se u zamítnutého média ukáže
jen tehdy, když ho někdo opravdu zamítl (existuje strike) — GIF odebraný z knihovny je při dalším poslání **běžná
žádost bez ⚠**, 3.+ pokus se počítá znovu od nuly.

**§2 Zamítnout + trest (karta fronty, klient).** Split „Zamítnout ▾“: „Zamítnout + timeout“ (číslo + s/m/h, výchozí
10 min, max 14 dní — stejné jako vlastní délka timeoutu v nabídce moda) a „Zamítnout + permaban…“ (modální
potvrzení „Trvale zabanovat <login> na <platformě>?“). Provedení: nejdřív `POST /moderation/gif/:id/decide
{ approve: false }`; jen když rozhodnutí je moje (200, i když SSE předběhlo HTTP), pak stávající
`POST /moderation/user { channel, platform, userId, login, action: "timeout", durationSec }` / `{ …, action: "ban" }`
pro odesílatele (identita z `gif-pending` / `GET /moderation/gif/pending`: `platform`, `userId`, `login`; server
login bere z archivu — původní zpráva `gif_request` v archivu je). Chyba moderace = hláška, zamítnutí platí; `409
already_decided` = trest se neprovede. Stejné zámky karty (1 s / 0,3 s). Backend beze změny.

**§3 Profil moda — zprávy zahozených GIFů.** `GET /moderation/user-history/messages` (jen mod) posílá zprávu
s GIFem, jehož médium je `rejected` (i odebrané z knihovny), `purging` nebo `withdrawn`, **se vším obsahem** a
`gif` + `gifHidden: true` + `gifStatus: "rejected"|"purging"|"withdrawn"` (URL bez tokenu). `unavailable` i médium,
které už neexistuje → `gif: { …, unavailable: true }` (štítek „[GIF nedostupný]“). `approved` / `pending` normálně.
Zprávy smazané modem / platformou / filtrem a skryté beze změny. Klient (core `user-history.js`): GIF zprávy
v Profilu 240×140; `gifHidden` rozmazaně se štítkem („Zamítnutý GIF“, „GIF ke smazání“, „Stažený GIF“), klik
zaostří, další klik rozmaže; `rejected` / `purging` se načtou až s tokenem moda (`?t=`, po chybě média jednou nový).
Chat (`/chat/history`, stream, OBS) a veřejný Profil beze změny. Chyba DB při zjištění stavu médií → GIF jako dosud.

**§4 Nabídka ⋯ dlaždice (klient).** Poloha uvnitř panelu (`gifMenuPlacement`): zarovnání k pravé hraně dlaždice,
u levého okraje posun dovnitř, když se nevejde dolů a nad dlaždici ano, otevře se nahoru.

**§5 Mod bez výjimky z odměny.** Viz „Mod / broadcaster“ výše: `gif-access` (s rolí) a `gif-used` pro mody stejně jako
pro diváky, `GET /gif/state` bez `mod: true`; s odemčenou odměnou se mod schvaluje sám (bez karty, mimo Dev mód).
Klient: bez textu „Jako mod posíláš GIFy bez odměny.“, mod vidí zámek, pásek i cooldown jako ostatní; karta fronty
a mod taby zůstávají. **Pro Židolištu:** když mají mody posílat GIFy jako dřív, musí jim `gif-access` pro
`role=moderator|broadcaster` vracet `allowed: true` (případně bez cooldownu).
