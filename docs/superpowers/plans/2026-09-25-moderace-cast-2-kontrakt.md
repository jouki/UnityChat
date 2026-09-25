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
do integračního streamu. Na platformě zpráva zůstává smazaná. Smazání modem / platformou se neobnovuje.
Odpověď navíc: `results.restore` = `'ok' | 'not_found' | 'error:no_channel' | 'error:db'` a `restored: boolean`
(jen když přišlo `messageId`). Klient (addon `_unhideMessage(d, { restore: true })`, core `buildModRequest`)
zprávu vykreslí na místě z `message`; hláška permitu doplní „zpráva obnovena“.
