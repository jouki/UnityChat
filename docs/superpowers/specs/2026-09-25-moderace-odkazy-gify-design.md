# Moderace z UnityChatu, filtr odkazů a odměna GIF — rozhodnutí usera

> 2026-09-25. Zdroj pravdy pro rozhodnutí (brainstorming v session s userem).
> Čtyři části, každá se vydá samostatně v pořadí **1 → 2 → 3 → 4**; další staví na předchozích.
> Týká se addonu, webu i OBS chatu (sdílený core), backendu UnityChatu a Židolišty.

## Společné: kdo je mod a čím se akce provádí

- **Mod** = přihlášený uživatel UnityChatu, který je v kanálu moderátorem nebo streamerem
  **aspoň na jedné platformě**. Ověřuje **server** z odznaků v serverovém logu zpráv (stejně
  jako reakce 💩, `routes/reactions.ts`) nebo login = kanál; klientovi se nevěří.
- **Účet pro akci na platformě X:**
  1. účet moda na platformě X — jen když je na X modem **a** jeho token má moderátorské scopes;
  2. jinak **bot workspace** kanálu (`bot_identities`, dnes JoukiBOT u Roba);
  3. když nejde ani to (bot na X není mod, chybí scope, API chyba), akce na X selže a mod
     dostane výsledek po platformách. UnityChat-strana akce (skrytí, zobrazení) platí vždy.
- **Moderátorské scopes** se nežádají po běžných divácích. Mod při první akci uvidí nabídku
  „Povolit moderaci účtem" = doplňkové přihlášení (`/auth/:platform/start` s `scopes: 'mod'`):
  - Twitch: `moderator:manage:chat_messages`, `moderator:manage:banned_users`,
    `moderator:manage:warnings`
  - Kick: `moderation:chat_message:manage`, `moderation:ban`
  - YouTube: stávající `youtube.force-ssl` stačí (liveChatMessages.delete, liveChatBans)
  Dokud ho nepotvrdí, akce jde přes bota.
- **Bot potřebuje stejné scopes** → Rob musí bota jednou znovu napojit přes Židolištu
  (`/integrations/bot/link-token`). Link flow bota tyto scopes přidá.
- **Log moderace** (nová tabulka `moderation_actions`): kdo (účet UC + platforma), komu, akce,
  parametry, kanál, výsledek po platformách, čas. Podklad pro budoucí přehled v Židolištce.
- **Kanály:** funguje všude, kde je workspace s botem; dnes reálně Rob. Že bot ještě není
  modem na YouTube, řeší Rob.

## Část 1 — Mazání zprávy

- **Tlačítko** v hover akcích zprávy **vlevo od 💩**, jen pro mody.
- `POST /moderation/delete {channel, platform, messageId}` → server ověří moda → **hned** SSE
  `message-deleted {channel, platform, messageId, by}` na `/nicknames/stream` (všichni klienti
  skryjí okamžitě, nečeká se na platformu) → pak smazání na platformě:
  Twitch Helix `DELETE /moderation/chat`, Kick `DELETE /public/v1/chat/{id}`,
  YouTube `liveChatMessages.delete`.
- **Smazání odjinud** (Twitch CLEARMSG, Kick `MessageDeletedEvent`, YouTube
  `markChatItemAsDeletedAction`) zachytí **ingest** a pošle stejné SSE → jednotné chování, ať
  maže kdokoli. Klienti dál reagují i na vlastní Twitch IRC CLEARMSG (rychlejší).
- **Archiv:** `messages.deleted_at` + `deleted_by` + `deleted_reason` (`mod` | `platform` |
  `link_filter`); obsah v DB zůstává (audit, obnovení permitem v části 3); `/chat/history` a `/chat/stream` pošlou
  smazanou zprávu s `deleted: true` a **bez obsahu** (text, segmenty, GIF) — po reloadu se
  smazaný obsah neobjeví.
- **Zobrazení** — nové nastavení „Smazané zprávy" (addon ⚙ + web ⚙, `config.deletedStyle`):
  - **Zpráva smazána** (výchozí): místo obsahu štítek, jméno zůstane;
  - **Zašedlé + štítek**: text 50 % + štítek „Smazáno" (jako 7TV „Dimmed");
  - **Přeškrtnuté**: přeškrtnutý text + štítek;
  - **Skryté**: řádek zmizí.
  Modi vidí vždy zašedlé + štítek (potřebují kontext). **OBS vždy jen „Smazáno"** (bez obsahu).
  GIF se ve všech stylech přestane zobrazovat.
- Klient pro mody nemá text smazané zprávy z historie (server ho neposílá) → zašedlý text
  jen u zpráv, které klient měl v paměti; jinak štítek.

## Část 2 — Kontextová nabídka na jméno (mody)

Pravé tlačítko na jméno → vlastní nabídka (divákům zůstává nativní menu prohlížeče):

| Položka | Chování |
|---|---|
| Smazat zprávu | = část 1 |
| Timeout ▸ | 5 s · 30 s · 1 min · 5 min · 10 min · 30 min · 1 h · 2 h |
| Zabanovat | permanentní ban |
| Unban | místo Timeout/Zabanovat, když víme o banu/timeoutu (CLEARCHAT/ingest + vlastní akce; timeout s expirací) |
| Přejmenovat | mod nastaví/smaže divákovi přezdívku v UnityChatu (stávající `nicknames`, zápis s ověřením moda, bez rate limitu 10 s) |
| Varovat… | pole důvodu; Twitch nativně (Helix `POST /moderation/warnings`, divák musí potvrdit). **Uživatel UnityChatu** dostane v UnityChatu varování **napříč platformami**: okno s důvodem, které musí potvrdit, než může psát. Divák mimo UnityChat na Kicku/YouTube nic nedostane. |
| Permit ▸ | 30 s · 1 min · 2 min · 5 min · 10 min; pošle do chatu `!permit <skutečný login>` **a** zapne náš permit (část 3) |

- **Timeout / ban / unban platí pro všechny platformy, kde člověka známe**: propojené
  identity účtu UnityChatu (`web_identities`), jinak jen platforma zprávy. Každá platforma
  vlastním účtem moda, jinak botem.
- Kick má timeout v minutách → 5 s a 30 s se na Kicku zaokrouhlí na 1 min (v hlášce).
  YouTube: `liveChatBans.insert` (`temporary` + `banDurationSeconds` / `permanent`); unban
  potřebuje id banu → server si ho uloží z insertu.
- Výsledek krátkou hláškou po platformách: „Twitch ✓ · Kick ✓ · YouTube ✗ bot není mod".
- SSE `user-moderated {channel, platform, login, action, until}` → klienti aplikují styl
  smazaných zpráv na předchozí zprávy uživatele (podle stejného nastavení) a štítek
  „Timeout (5 min)" / „Zabanován".
- Varování: tabulka `account_warnings` (účet, kanál, důvod, kdo, kdy, potvrzeno); klient ho
  dostane v `/auth/me` + SSE `account-warning` (jen dotčenému účtu), potvrzení
  `POST /account/warnings/:id/ack`.

## Část 3 — Filtr odkazů a permit (náhrada link filtru StreamElements)

- **Detekce** URL i bez schématu (`neco.cz/x`), ne verze (`v1.2`) ani e-maily; sdílený
  detektor v `extension/core/links.js` (server i klienti), testy.
- **Bez permitu smí:** modi, streamer, VIP, známí boti (JoukiBOT, StreamElements + seznam
  kanálu). **Povolené domény** (projdou všem): nastavitelný seznam; výchozí YouTube
  (`youtube.com`, `youtu.be`) a Spotify (`open.spotify.com`).
- **Akce:** zpráva se **jen smaže** (bez hlášky, bez timeoutu) — účtem streamera, jinak botem.
  Rychlost: Twitch a Kick ~1 s, YouTube 2–6 s (polling ingestu).
- **Permit:** z nabídky (část 2) nebo `!permit <jméno>` od moda z libovolného klienta (server
  ho zachytí v ingestu). Po dobu permitu smí uživatel posílat odkazy **na všech platformách,
  kde ho známe**. Permit v paměti serveru + tabulka pro restart (krátké TTL).
- **Obnovení zprávy permitem (jen UnityChat):** permit udělený z nabídky **na konkrétní
  zprávě**, kterou smazal filtr odkazů, tu zprávu v UnityChatu (addon, web, OBS) **obnoví**
  — zobrazí se, jako by nikdy nebyla smazaná (SSE `message-restored` s plným obsahem).
  Na platformě zůstane smazaná (platformy obnovení neumí). Proto server u zpráv smazaných
  filtrem **drží obsah** (`deleted_reason: 'link_filter'`); do klientů ho neposílá, dokud
  zpráva není obnovená. Totéž obnovení platí jen pro smazání filtrem, ne pro smazání modem.
- **Nastavení v dashboardu Židolišty** (zapnutí, výjimky, domény). UnityChat ho stahuje
  jako commandy/dary; změna → webhook → cache pryč + SSE.
- **Přechod:** filtr zapnout až **po vypnutí link filtru v SE** (jinak SE smaže GIF dřív, než
  ho mod schválí).

## Část 4 — Odměna „Posílání GIFů"

- **Odměna v Levels Židolišty** (nový typ jako odemčení SE): doba, cooldown. UnityChat se
  ptá Židolišty, zda má uživatel GIFy odemčené (cache + webhook při změně).
- **Zachycení:** zpráva s odkazem (část 3), autor má odměnu a odkaz vede na GIF → zpráva se
  na platformě smaže (jako každý odkaz) a vznikne **žádost o schválení**. Funguje pro
  zprávy z **libovolného klienta** (ingest); stav čekání/výsledek vidí jen uživatelé UnityChatu.
- **Převod odkazu (server):**
  - stránky Tenor / Giphy / Imgur / 7TV → `og:video` (MP4), jinak `og:image`;
  - přímé odkazy `.gif/.webp/.mp4` z **libovolného** hostu. Pozor: `media1.tenor.com/….gif`
    vrací prohlížeči při navigaci HTML obal a čistý GIF jen s `Accept: image/*` (ověřeno);
  - ověřit `Content-Type` + magic bytes, limit velikosti (10 MB), rozměry.
  - **Server médium stáhne a uloží u sebe** (`/media/gif/:id`), klienti načítají jen z
    api.jouki.cz: žádný únik IP divákům cizím serverům a zobrazí se **přesně to, co mod
    schválil**. Zamítnuté/propadlé se smaže, schválené drží retence archivu.
  - Převod selže → zachází se jako s běžným odkazem.
- **Čekání:** modům karta s náhledem + **Povolit / Zamítnout**; odesílateli (má-li UnityChat)
  jeho zpráva s pruhem „čeká na schválení". Ostatní nevidí nic.
- **Rozhodnutí:** kterýkoli mod, **první klik rozhodne** (zámek na serveru). Modům a
  odesílateli krátký efekt (zelená/červená + kdo rozhodl), pak zmizí. **Po 5 minutách bez
  rozhodnutí propadne** („nevyřízeno"; doba nastavitelná v Židolištce).
- **Po schválení** všem (addon, web, OBS) **nová zpráva**: jméno + text bez odkazu + GIF pod
  ním. Velikost 100 %, nejvýš šířka chatu, max **400 × 250 px**, poměr zachován; MP4 jako
  `<video autoplay loop muted playsinline>`, jinak `<img>`.
- **Smazání modem** (část 1) GIF skryje všem okamžitě.
- SSE: `gif-pending` (jen modům + odesílateli), `gif-decided`, `gif-message` (všem).
  Nové tabulky `gif_requests` (stav, médium, rozměry, kdo rozhodl).

## Práce pro Židolištu (session RobJewsALot)

1. Link flow bota (`/integrations/bot/link-token`) — informovat Roba, že bota musí znovu
   napojit kvůli moderátorským scopes (UnityChat scopes přidá).
2. Část 3: sekce „Filtr odkazů" v dashboardu (zapnutí, výjimky, domény) + webhook změny;
   veřejné API pro UnityChat stejně jako commandy.
3. Část 4: typ odměny „GIF" v Levels (doba, cooldown), API „má uživatel odemčené GIFy",
   webhook při udělení/vypršení; doba propadnutí žádosti v nastavení.

### Dohodnutý kontrakt se Židolištou (2026-09-25, session robjewsalot)
- Bot: Nastavení → Chat bot ukáže `missingScopes` per platforma z `GET /integrations/bot/status`
  (UnityChat pole doplní v části 1) + výzvu „napojit znovu".
- `GET /integrations/:slug/link-filter` (X-Api-Key, ETag/304) →
  `{ ok, workspace, enabled, allowDomains[], extraBots[], version }` (version = ISO updated_at;
  výchozí enabled false, allowDomains [youtube.com, youtu.be, open.spotify.com]). Role
  mod/streamer/VIP/známí boti mají výjimku vždy (Židolišta je neukládá). Webhook
  `POST /commands/invalidate { workspace, reason:"link-filter", data:{ version } }`.
- GIF = **nový typ akce v labelu** („Posílání GIFů" vedle „Sound Efekt"): doba = časovač
  labelu (sčítání, zmrazení, zrušení, obnova), „Pro koho" (role jako SE), cooldown s/uživatel;
  doba propadnutí žádosti = nastavení workspace (výchozí 300 s).
  `GET /integrations/:slug/gif-access?platform=&userId=&login=&role=` (role = ověřená nejvyšší
  z badge, chybí = viewer) → `{ ok, serverNow, allowed, until|null, cooldownUntil|null,
  cooldownSec, requestTtlSec }`; zmrazená = allowed:false.
  `POST /integrations/:slug/gif-used { platform, userId }` → `{ ok, cooldownUntil }`.
  Webhook `reason:"gif-access" { data:{ etag } }` při každé změně.

## Mimo rozsah
- Přehled moderačního logu v UI (data se sbírají, UI později).
- Hromadné akce, automoderace obsahu, zpomalený režim, emote-only.
- Varování pro diváky mimo UnityChat na Kicku a YouTube (platformy to nemají).
