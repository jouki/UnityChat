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
- **Rate limit** per účet (10, doplňuje 2/s) sdílený s `/moderation/delete` → `429 { error:'rate_limited' }`.
- `userId` = ID na platformě: Twitch user id, Kick user id, YouTube channel id (`UC…`) — to, co nese zpráva
  (`platformUserId` / `userId` v `/chat/history` a `/chat/stream`).
- **Výsledek po platformách** (`ModResult`): `'ok'` (účtem moda) · `'bot'` (botem workspace) · `'error:<kód>'`:
  `no_actor` (mod nemá scopes/není mod na té platformě a bot chybí nebo nemá scopes), `no_channel`,
  `not_live` (YouTube: stream neběží), `no_ban_id` (YouTube unban bez známého id banu), `unsupported`,
  `exception`, nebo HTTP status platformy (`error:403`, `error:401`, …).
- Chyba platformy po SSE nikdy nevrací 500 — vždy `200` s `results`.

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
- Pořadí: SSE `user-moderated` pro každou identitu → akce na platformách (paralelně) → `moderation_bans` → `moderation_actions`.
- Odpověď `200`:
```json
{ "ok": true, "action": "timeout", "until": 1790000300000,
  "results": { "twitch": "ok", "kick": "bot", "youtube": "error:not_live" },
  "targets": [ { "platform": "twitch", "login": "spammer" }, { "platform": "kick", "login": "spammer_k" } ],
  "notes": { "kick": "rounded_to_minutes:1" } }
```
  `until` = konec timeoutu (ms epoch) na platformě zprávy, jinak `null`. `notes.kick` jen když se Kick
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
- `200 { ok:true, until: <ms>, results: { permit: 'ok'|'error:db', chat: 'ok'|'bot'|'error:<kód>' } }`
  (`chat` kódy bota: `no_actor`, `bot_unavailable`, `not_live`, `no_channel`, `send_failed`, …).

### `PUT /moderation/nickname` — přejmenování
```json
{ "channel": "robdiesalot", "platform": "twitch", "login": "spammer", "nickname": "Pan Spam", "color": "#ff8800" }
```
- `nickname: null` = smazat přezdívku. Pravidla jako `PUT /nicknames` (1–30 znaků, `color` `#rrggbb` / null),
  ale bez 10s limitu a bez vlastnictví — jen mod kanálu a jen uživatel z archivu kanálu (přesná shoda loginu).
- SSE `nickname-change` / `nickname-delete` rozešle trigger v DB (`nicknames_notify`), route sama nic nevysílá.
- `200 { ok:true, login, nickname }`, neznámý login v kanálu `404 not_found`.

### `GET /moderation/user-state?channel=&platform=&userId=`
- `200 { ok:true, banned: boolean, until: <ms>|null }` — `banned` = známý ban (until null) nebo běžící timeout
  (vlastní akce UC/Židolišty + Twitch CLEARCHAT). Podle toho nabídka ukáže **Unban** místo Timeout/Zabanovat.
  Bez rate limitu, jen pro mody.

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
  + štítek „Timeout (5 min)" / „Zabanován"; `unban` štítek sundá. CLEARCHAT, který je echem vlastní
  akce, server do 30 s nevyšle podruhé.

## Integrace Židolišty (X-Api-Key + HMAC, `inboundAuthorized`)

`POST /integrations/:slug/moderation/timeout | ban | unban`
```json
{ "platform": "kick", "userId": "77", "durationSec": 600, "reason": "spam",
  "actor": { "source": "zidolista", "userId": "7", "name": "Jouki", "role": "owner" } }
```
- `durationSec` povinné u `timeout` (1–1 209 600 s, Kick se zaokrouhlí na minuty), jinak ignorováno. `login` volitelný (ignoruje se).
- Kanál JEN ze slugu (`ws.channels.twitch` = UC kanál), cíl musí mít zprávu v archivu platformního
  kanálu workspace; propojené identity jen na platformách workspace. Akce jen **botem workspace**.
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
