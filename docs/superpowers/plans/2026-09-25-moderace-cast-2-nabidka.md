# Moderace — část 2: Kontextová nabídka na jméno — Implementation Plan

> Spec: `docs/superpowers/specs/2026-09-25-moderace-odkazy-gify-design.md` (Společné + Část 2 + kontrakt Židolišty).
> Navazuje na část 1 (v produkci): `lib/modActions.ts` (aktér mod → bot, refresh tokenů), `lib/chatRole.ts`
> (`accountModIdentities` / `accountModPlatforms`), `routes/moderation.ts` (`resolveDeleteTarget`, rate limit),
> `routes/integrationModeration.ts`, `lib/messageDeletes.ts` (`publishDeleted`, integrační události),
> `core/moderation.js`, addon `_applyDeleted` / `_onModerationEvent`, web `chat.js` moderace.

## Global Constraints
- Ověření moda VŽDY na serveru (`accountModIdentities`); integrace přes `inboundAuthorized`. Tokeny nikdy do logu/API.
- Akce na platformě: účet moda (je-li na té platformě mod a má `MOD_SCOPES`), jinak bot workspace, jinak `error:no_actor`.
- **Rozsah timeout/ban/unban: všechny platformy, kde člověka známe** = identity téhož UC účtu (`web_identities` přes
  `platform_user_id` → `account_id` → všechny jeho identity), jinak jen platforma zprávy. Výsledek po platformách.
- Délky timeoutu (s): `5, 30, 60, 300, 600, 1800, 3600, 7200`; ban = permanentní. Kick má minuty → 5 s a 30 s = 1 min
  (uvést v hlášce). YouTube: `liveChatBans.insert` (`temporary` + `banDurationSeconds` / `permanent`); unban potřebuje
  id banu → uložit (tabulka `moderation_bans`).
- Permit: `30, 60, 120, 300, 600` s; pošle do chatu `!permit <skutečný login>` (účtem moda přes existující `/chat/send`
  logiku, jinak botem `sendAsBot`) **a** uloží náš permit (tabulka `link_permits`, pro část 3).
- Varování: Twitch nativně (Helix `POST /moderation/warnings`, důvod povinný); uživatel UnityChatu dostane varování
  **napříč platformami** (`account_warnings`, SSE `account-warning` jen jemu, musí potvrdit). Divák mimo UC na Kicku/YT nic.
- Přejmenovat: mod nastaví/smaže přezdívku divákovi (tabulka `nicknames`; SSE jde přes DB trigger `nicknames_notify`).
- Každá akce → `moderation_actions` (actor, action, params {duration, reason, …}, result po platformách).
- SSE `user-moderated { channel, platform, userId, login, action, until|null, by }` na `/nicknames/stream` + integrační
  `chat.user_moderated { workspace, platform, userId, login, action, duration?, by }`. Klient: styl smazaných zpráv na
  předchozí zprávy uživatele (stejné nastavení `deletedStyle`) + štítek „Timeout (5 min)“ / „Zabanován“; unban štítek sundá.
- Twitch CLEARCHAT z ingestu (timeout/ban odjinud) → stejné `user-moderated` (by null).
- Nové tabulky = SQL soubor, na produkci spustit PŘED nasazením backendu (souhlas usera).
- Addon bump minor (3.45.0), Czech UI s diakritikou, množná čísla 3 tvary.

## Tasks
1. **Backend: DB + platformní akce.** SQL `backend/sql/2026-09-25-moderation-2.sql`: `moderation_bans` (channel, platform,
   target_user_id, target_login, until, youtube_ban_id, created_at), `link_permits` (channel, platform, target_user_id,
   target_login, until, by, created_at; index channel+platform+user), `account_warnings` (id, account_id, channel,
   reason, by, created_at, acknowledged_at). schema.ts. `lib/modActions.ts`: `timeoutUser`, `banUser`, `unbanUser`,
   `warnUser` se stejným výběrem aktéra a refresh logikou jako `deletePlatformMessage` (DRY: vytáhnout společný „proveď
   s aktérem“ helper). Twitch Helix `POST/DELETE /moderation/bans`, `POST /moderation/warnings`; Kick
   `POST/DELETE /public/v1/moderation/bans`; YouTube `liveChatBans.insert/delete` (liveChatId přes existující helper).
   Unit testy s injektovaným fetch.
2. **Backend: cíl napříč platformami + routy.** `lib/moderationTargets.ts`: z (platform, userId/login) najít UC účet a
   všechny jeho identity (fallback jen platforma). `routes/moderation.ts`: `POST /moderation/user {channel, platform,
   userId, login, action: timeout|ban|unban, durationSec?, reason?}`, `POST /moderation/warn {…, reason}`,
   `POST /moderation/permit {…, durationSec}`, `PUT /moderation/nickname {platform, login, nickname|null, color?}`
   (mod-only rename; nickname null = smazat). `GET /moderation/user-state?channel&platform&userId` → { banned, until }.
   Integrační varianty `POST /integrations/:slug/moderation/{timeout,ban,unban}` (actor ze Židolišty, jen bot).
   SSE + integrační události + `moderation_actions`. Ingest Twitch CLEARCHAT → user-moderated.
   Account warnings: `GET /account/warnings` (nepotvrzená), `POST /account/warnings/:id/ack`, SSE `account-warning`
   jen dotčenému účtu (filtr v SSE podle session — pokud /nicknames/stream nemá identitu, přidat do SSE query token
   nebo nový endpoint `/account/stream`; zvolit nejjednodušší bezpečné řešení a zdokumentovat).
3. **Core + addon.** `core/mod-menu.js` (sdílené s webem): vlastní kontextová nabídka (položky a podnabídky dle specu,
   stav banu → „Unban“), dialog důvodu varování, dialog přejmenování, hlášky výsledku po platformách. Addon: pravé
   tlačítko na jméno jen pro mody (divákům nativní menu), SSE `user-moderated` (styl předchozích zpráv + štítek),
   `account-warning` (okno s důvodem, blokuje psaní do potvrzení), bump 3.45.0, E2E `scripts/e2e-mod-menu.mjs`.
4. **Web + OBS.** Stejné jako addon přes core (OBS: jen styl smazaných zpráv / štítek, žádná nabídka).
5. **Nasazení.** SQL na produkci (se souhlasem), merge do dev, deploy webu, info Židolišti (integrační timeout/ban/unban,
   chat.user_moderated), živý test na `uctest`.
