# Chat bot Židolišty přes UnityChat backend — dohodnutý kontrakt

Datum: 2026-09-22. Dohoda mezi UnityChat (tento repo, backend `api.jouki.cz`)
a Židolištou (RobJewsALot server). Cíl od usera: Židolišta má vlastního chat
bota nezávislého na Streamer.botu — online 24/7, pro všechny workspacy, s
tvrdou izolací (bot workspace A nikdy nepíše do chatu workspace B). Vlastní
jméno bota per workspace tam, kde to jde (vlastní účet), jinak sdílený účet
**JoukiBOT**, který UnityChat v daném kanálu zobrazí pod jménem z nastavení
workspace (vidí jen uživatelé UnityChatu — user to ví).

## Rozdělení

- **UnityChat backend = oči a ústa.** Už ingestuje Twitch/Kick/YouTube chat
  všech kanálů, má OAuth pro všechny tři platformy, šifrované tokeny s
  refreshem a odesílání (Helix `chat/messages`, Kick `/chat`, YouTube
  `liveChatMessages.insert`). Přidává stream zpráv pro Židolištu, `POST
  /bot/send`, identity bota a stavový endpoint.
- **Židolišta = mozek.** Matching commandů, role, cooldowny, `%proměnné%`,
  announcementy — beze změny. Přibývá druhý zdroj zpráv (SSE) vedle Streamer.botu,
  odeslání odpovědi přes bota podle `bot.mode`, dedupe, nastavení workspace.
- Tokeny bota drží jen UnityChat backend (šifrované jako `web_identities`,
  nikdy z API). Židolišta tokeny nevidí.

## Fáze

1. Sdílený JoukiBOT + stream + `/bot/send` + přepínač `bot.mode` v Židolištce
   (Rob může přejít ze Streamer.botu na bota). Test na `uctest`.
2. Vlastní bot účet per workspace + zobrazovací jméno a štítek Židolišty v
   UnityChatu (addon i web).

## Kontrakt (autentizace všude `X-Api-Key` = sdílený integrační klíč)

### `GET /integrations/chat/stream` (SSE) — UnityChat → Židolišta

- Zprávy ze všech kanálů, které jsou v `GET /integrations/workspaces`
  namapované na nějaký workspace; `workspace` = slug.
- `id:` = monotónní kurzor; `Last-Event-ID` → replay **min. 60 s** (ring
  buffer 5 min). Heartbeat komentář `: ping` každých 15 s.
- `event: chat.message`, `data:`

```json
{
  "type": "chat.message",
  "workspace": "rob",
  "messageId": "<id zprávy z platformy>",
  "platform": "twitch",
  "user": "Jouki728", "userId": "12345",
  "text": "!brohemians",
  "isSub": false, "isMod": false, "isVip": false, "isBroadcaster": false,
  "isBot": false,
  "replyTo": { "messageId": "…", "user": "…" },
  "timestamp": "2026-09-22T14:00:00.000Z"
}
```

- Role z badge (Twitch `badges` tag, Kick `identity.badges`, YouTube
  `authorBadges` tooltip). Židolišta mapuje broadcaster > mod > vip > sub > viewer.
- `isBot: true` = píše sdílený nebo vlastní bot toho workspace (ochrana proti
  smyčce). `messageId` povinné — dedupe u Židolišty je `(workspace, platform,
  messageId)` s TTL 5 min (SB envelope dostane `msgId` taky).
- Stream se posílá **vždy**, i když `bot.mode = "sb"` — matching běží z obou
  zdrojů, liší se jen ústa.

### `POST /bot/send` — Židolišta → UnityChat

Tělo `{ workspace, platform, text, replyTo?: "<messageId>", idempotencyKey: "<uuid>" }`.
Text je hotový (po dosazení proměnných), max 480 znaků; UnityChat ořízne
podle limitu platformy. **Kanál se odvozuje ze slugu na serveru** — jediné
místo izolace, Židolišta kanál nikdy neadresuje.

Odpovědi: `200/202 { ok, id }`; `409 duplicate` (stejný idempotencyKey);
`429 rate_limited` + `retryAfterMs` (limit per workspace); `404
unknown_workspace`; `503 bot_unavailable` (žádná identita / mrtvý token).
Identita: vlastní bot workspace pro danou platformu, jinak sdílený JoukiBOT.

### `GET /integrations/workspaces` — Židolišta → UnityChat (zdroj pravdy mapování)

```json
{ "ok": true, "workspaces": [{
  "slug": "rob",
  "channels": { "twitch": "robdiesalot", "kick": "robdiesalot", "youtube": "robdiesalot" },
  "bot": { "mode": "sb" | "shared" | "own", "displayName": "JoukiBOT",
           "ownLogins": { "twitch": "…", "kick": "…", "youtube": "…" } }
}] }
```

UnityChat cachuje 60 s; změna → stejný webhook jako u commandů
(`POST /commands/invalidate` s `reason: "workspaces"`). Nahrazuje env
`ZIDOLISTA_WORKSPACES` (ta zůstane jako fallback, dokud endpoint nejede).
`bot.displayName` je zdroj jména bota pro zobrazení v UnityChatu
(**ne** `/commands`).

### Napojení bot účtu (OAuth) — jen přes Židolištu

Odkaz nesmí být hádatelný (kdokoli by jinak navázal svůj účet jako Robův bot).

1. Židolišta (klíč) `POST /integrations/bot/link-token`
   `{ workspace: "<slug>" | "_shared", platform, returnTo }` → `{ ok, url, expiresAt }`
   (token jednorázový, 10 min; `returnTo` jen na origin Židolišty z env —
   dashboard je `https://jouki.cz`, stránka Nastavení
   `https://jouki.cz/zidolista/<slug>/settings`).
2. UI Židolišty otevře `url` (popup) → UnityChat 302 na consent providera →
   callback (sdílený se streamer/web flow, `kind: 'bot'` ve state) → uloží
   identitu jako bota workspace (`_shared` = sdílený JoukiBOT) → 302 na
   `returnTo#bot_linked=<platform>:<login>` nebo `#bot_error=<důvod>`.
3. Židolišta po návratu zavolá status (níže). Žádný webhook není potřeba.

`_shared` smí navázat jen Židolišta z UI omezeného na superadmina (usera).

### `GET /integrations/bot/status?workspace=<slug>`

```json
{ "ok": true,
  "shared": { "twitch": { "state": "online", "login": "joukibot" }, "kick": { "state": "missing" }, "youtube": { "state": "expired", "login": "…" } },
  "own":    { "twitch": { "state": "online", "login": "robbot" }, "kick": { "state": "missing" }, "youtube": { "state": "missing" } } }
```

`state`: `online` (token platný / obnovitelný), `expired` (refresh selhal →
nutné znovu napojit), `missing`. Odpojení: `DELETE /integrations/bot/identity`
`{ workspace, platform }` (klíč).

### Zobrazení v UnityChatu (fáze 2)

Addon i web: zprávy loginu bota (sdíleného i vlastního) v kanálu workspace
se vykreslí s `bot.displayName` a štítkem/logem Židolišty; skutečný login
zůstává v datech (mention, dedup). `chatReply.hideInUnityChat` u announcementů
platí i pro odpovědi bota.

## Na userovi

Založit účty **JoukiBOT**: Twitch účet, Google účet s YouTube kanálem, Kick
účet. Pak je jednou napojit ze Židolišty (sekce Chat bot, `_shared`). Bez
nich bot nemá čím mluvit. Kick: aplikace musí mít scope `chat:write`; YouTube:
consent s `youtube.force-ssl` (verifikace u Google běží).

## Stav

- 2026-09-22 ~16:30: Židolišta fáze 1 nasazena (`lib/chatHandler.ts` = jeden
  mozek pro SB WS i SSE, `lib/unitychatBot.ts` = SSE klient + `/bot/send` +
  proxy status/link-token/identity, `GET /integrations/workspaces` živě —
  zatím všude `mode:'sb'` a prázdné kanály, dokud je user nevyplní; sekce
  „Chat bot" v Nastavení). Její SSE klient se připojuje hned → do nasazení
  streamu u nás 404 + reconnecty (neškodí).
- UnityChat strana **nasazena 2026-09-22 19:43** (commit 897fd59): stream, `/bot/send`,
  link-token, status, DELETE identity; tabulka `bot_identities` vytvořena; ingest
  sleduje navíc `twitch:jouki728`. Klient Židolišty se připojil hned. Ověřeno curlem
  (401 bez klíče, 404 no_channel / unknown_workspace, 503 bot_unavailable, link-token
  + odmítnutí cizího returnTo).
- Doporučený kanál pro workspace `jouki`: **twitch = `jouki728`** (userův vlastní
  kanál); `uctest` je cizí existující Twitch účet, do jeho chatu se psát nemá.
- **2026-09-22 22:04 — fáze 1 ověřena end-to-end:** `!test` v chatu jouki728 →
  stream → Židolišta (source unitychat) → `/bot/send` → Twitch 202 `badge: true`,
  zpráva v chatu s `bot-badge/1` („Chat Bot"). Sdílený JoukiBOT (`user:bot`) +
  souhlas broadcastera jouki728 (`channel:bot`). První pokusy po založení účtu
  končily `msg_rejected` „please try again later" — dočasné, po pár minutách
  prošlo. Odznak: app access token; fallback user tokenem s pauzou 1,2 s
  (Twitch počítá i zahozený pokus do limitu 1/s). Rob zatím `mode: sb`.
- Test fáze 1 (shoda 2026-09-22 ~17:00): workspace `uctest` v Židolištce
  neexistuje → testuje se na workspace **`jouki`** namapovaném na Twitch kanál
  `uctest` (user vyplní v Nastavení workspace jouki twitch = uctest a přepne
  replyVia = bot). Zpráva `!brohemians` do chatu uctest → očekává se
  `POST /bot/send` s `workspace: "jouki"`. Env fallback `ZIDOLISTA_WORKSPACES`
  pro uctest se zruší (jinak dvojí mapování na jeden kanál). Živé workspacy
  u Židolišty: `jouki`, `rob` (oba `mode:'sb'`, kanály prázdné).

## Otevřené / poznámky

- YouTube: bot může psát jen do chatu, který dovoluje psát komukoli (ne
  members-only), a jen když stream běží (`liveChatId` z ingestu).
- Twitch: bot bez mod role podléhá slow/followers-only režimu kanálu.
  Doporučit streamerům `/mod joukibot`.
- Kick public API posílá jako uživatel tokenu do `broadcaster_user_id`
  kanálu; sdílený účet nesmí být v kanálu zabanovaný.
