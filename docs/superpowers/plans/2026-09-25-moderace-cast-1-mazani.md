# Moderace — část 1: Mazání zprávy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mod smaže zprávu z UnityChatu (addon, web) — všem klientům zmizí okamžitě přes SSE, na platformě ji smaže účet moda nebo bot workspace; smazání z platforem (Twitch/Kick/YouTube) se projeví stejně.

**Architecture:** Backend `POST /moderation/delete` ověří moda (`chatRole`), zapíše `messages.deleted_*` + `moderation_actions`, hned `broadcast('message-deleted')`, pak `lib/modActions.ts` smaže zprávu na platformě (účet moda → bot → chyba). Ingest nově posílá smazání z platforem stejnou cestou (`onDelete`). Klienti renderují smazaný stav přes sdílený `core/moderation.js` + `extension/moderation.css` podle nastavení `deletedStyle`.

**Tech Stack:** Node 22 + TS + Fastify 5 + Drizzle (backend, testy `node --test` přes tsx); MV3 addon bez buildu (ES moduly v `extension/core/` přes `core-bridge.js`); web v privátním repu `UnityChat-web` (Vite, `@core`).

**Spec:** `docs/superpowers/specs/2026-09-25-moderace-odkazy-gify-design.md` (sekce Společné + Část 1)

## Global Constraints

- Tokeny (moda i bota) **nikdy** do logu, do odpovědi API ani do gitu. Logovat jen platformu, login, stav.
- Mod se ověřuje **na serveru** (`lib/chatRole.ts`), klientovi se nevěří.
- Backend se nasazuje **z dev hned** (Coolify) → SQL (Task 1) spustit na produkci **před** pushem backendu.
- Nikdy `git stash pop`; commitovat jen vlastní soubory; `git pull --rebase origin dev` před pushem.
- Addon: bump `extension/manifest.json` při každé změně chování; commit message `type(scope): … (vX.Y.Z)` + `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Česká UI: plná diakritika, množná čísla 3 tvary.
- Nastavení `deletedStyle`: `'label'` (výchozí, „Zpráva smazána") | `'dim'` | `'strike'` | `'hide'`. Modi vždy `'dim'`, OBS (raw) vždy `'label'` bez obsahu.
- Moderátorské scopes: Twitch `moderator:manage:chat_messages`, `moderator:manage:banned_users`, `moderator:manage:warnings`; Kick `moderation:chat_message:manage`, `moderation:ban`; YouTube stávající `youtube.force-ssl`.

---

### Task 1: DB — sloupce smazání a log moderace

**Files:**
- Create: `backend/sql/2026-09-25-moderation.sql`
- Modify: `backend/src/db/schema.ts` (tabulka `messages`, nová `moderationActions`)

**Interfaces:**
- Produces: sloupce `messages.deleted_at timestamptz`, `deleted_by text`, `deleted_reason text`; tabulka `moderation_actions`; Drizzle `messages.deletedAt/deletedBy/deletedReason`, `moderationActions`.

- [ ] **Step 1: SQL soubor**

```sql
-- Moderace z UnityChatu (spec 2026-09-25-moderace-odkazy-gify-design.md, část 1).
-- Spustit ručně PŘED pushem backendu (dev se nasazuje hned):
--   docker exec -i <postgres> psql -U postgres -d unitychat < backend/sql/2026-09-25-moderation.sql
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at     timestamptz;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_by     text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_reason text; -- 'mod' | 'platform' | 'link_filter'
CREATE TABLE IF NOT EXISTS moderation_actions (
  id          bigserial   PRIMARY KEY,
  channel     text        NOT NULL,
  account_id  bigint      REFERENCES web_accounts(id) ON DELETE SET NULL,
  actor       text        NOT NULL,           -- 'twitch:login' moda (pro audit)
  action      text        NOT NULL,           -- 'delete' (část 2: timeout, ban, unban, warn, permit, rename)
  platform    text        NOT NULL,
  target_login text,
  target_message_id text,
  params      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  result      jsonb       NOT NULL DEFAULT '{}'::jsonb, -- { twitch: 'ok'|'bot'|'error:…' }
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS moderation_actions_channel_idx ON moderation_actions (channel, created_at DESC);
```

- [ ] **Step 2: schema.ts** — do `messages` přidat `deletedAt: timestamp('deleted_at', { withTimezone: true })`, `deletedBy: text('deleted_by')`, `deletedReason: text('deleted_reason')`; nová `export const moderationActions = pgTable('moderation_actions', {...})` přesně podle SQL (stejný styl jako ostatní tabulky v souboru).

- [ ] **Step 3:** `cd backend && npx tsc --noEmit` → bez chyb.

- [ ] **Step 4: SQL na produkci** (runbook `SERVER.md`, kontejner Postgresu `unitychat-db`): spustit soubor, ověřit `\d messages` a `\d moderation_actions`.

- [ ] **Step 5: Commit** `feat(backend): sloupce smazání zpráv + log moderace (SQL, schema)`

---

### Task 2: Smazání v archivu + klientský tvar zprávy

**Files:**
- Create: `backend/src/lib/messageDeletes.ts`
- Modify: `backend/src/routes/chat.ts` (`toClientMessage` :48, select v `/chat/history` :213)
- Test: `backend/src/routes/chat.test.ts`, `backend/src/lib/messageDeletes.test.ts`

**Interfaces:**
- Produces:
  - `markDeleted(p: { platform: Platform; messageId: string; by: string | null; reason: 'mod' | 'platform' | 'link_filter' }): Promise<{ channel: string | null; login: string | null }>` — nastaví `deleted_*` jen když ještě není smazaná; vrátí kanál a autora (pro SSE).
  - `deletedEvent(p): { channel, platform, messageId, by, reason, at }` — tvar SSE `message-deleted`.
  - `publishDeleted(p)` = `markDeleted` + `broadcast('message-deleted', …)`; dedup 60 s per `platform:messageId` (Twitch CLEARMSG přijde z ingestu i po vlastním mazání).
  - `toClientMessage(row, historical)` pro řádek s `deletedAt` vrací `{ …meta, deleted: true, deletedReason, message: '', segments: [], contentRaw: undefined }` — **bez obsahu**.

- [ ] **Step 1: Failing test** v `chat.test.ts`:

```ts
test('toClientMessage: smazaná zpráva nenese obsah', () => {
  const row = { ...baseRow, content: 'https://evil', contentRaw: { segments: [{ type: 'text', value: 'https://evil' }] }, deletedAt: new Date(), deletedReason: 'mod' };
  const m = toClientMessage(row as any, true);
  assert.equal(m.deleted, true);
  assert.equal(m.message, '');
  assert.ok(!JSON.stringify(m).includes('evil'));
});
```
(`baseRow` = existující fixture v souboru; pokud není, vytvořit podle tvaru `messages` řádku.)

- [ ] **Step 2:** `npm test -- --test-name-pattern "smazaná"` → FAIL.
- [ ] **Step 3:** Implementovat v `toClientMessage` větev `if (row.deletedAt)`; `/chat/history` select musí vybírat nové sloupce (pokud select vyjmenovává sloupce).
- [ ] **Step 4:** Unit test `deletedEvent` + dedup `publishDeleted` s injektovaným `broadcast` a `markDeleted` (DB test jen s `TEST_DATABASE_URL`, vzor `ingest/store.test.ts`).
- [ ] **Step 5:** `npm test` → PASS. Commit `feat(backend): smazané zprávy v archivu a historii bez obsahu`.

---

### Task 3: Ingest — smazání z platforem

**Files:**
- Modify: `backend/src/ingest/types.ts` (listener opts `onDelete`), `ingest/twitch.ts:83`, `ingest/kick.ts:89`, `ingest/normalize.ts:190` + `ingest/youtube.ts:278`, `ingest/index.ts:36,82`, `server.ts:74`
- Test: `backend/src/ingest/twitch.test.ts`, `kick.test.ts`, `normalize.test.ts` (existující soubory rozšířit)

**Interfaces:**
- Consumes: `publishDeleted` (Task 2).
- Produces: `onDelete: (d: { platform: Platform; channel: string; messageId: string }) => void` v opts listenerů a `createIngest({ onDelete })`.

- [ ] **Step 1: Failing testy parsování:**
  - Twitch: řádek `@login=foo;target-msg-id=abc-123;tmi-sent-ts=1 :tmi.twitch.tv CLEARMSG #robdiesalot :text` → `onDelete({platform:'twitch', channel:'robdiesalot', messageId:'abc-123'})`.
  - Kick: Pusher event `App\\Events\\MessageDeletedEvent` s `data = '{"id":"x","message":{"id":"msg-1"}}'` → `messageId:'msg-1'`.
  - YouTube: `normalizeYoutubeDelete(action)` pro `{ markChatItemAsDeletedAction: { targetItemId: 'yt-1' } }` i `{ removeChatItemAction: { targetItemId: 'yt-1' } }` → `'yt-1'`, jinak `null`.
- [ ] **Step 2:** Spustit → FAIL. Tvar Kick `MessageDeletedEvent` i YouTube akcí ověřit na živých datech (UC_LOG/ingest log při smazání na `uctest`), fixture podle skutečnosti upravit.
- [ ] **Step 3: Implementace:** Twitch — před `if (!line.includes('PRIVMSG')) continue;` zpracovat `CLEARMSG` (tag `target-msg-id`); Kick — nový `case`; YouTube — v `processActions` pro každou akci nejdřív `normalizeYoutubeDelete`. `index.ts` protáhne `onDelete` do `defaultFactory`; `server.ts` ho napojí na `publishDeleted({ …d, by: null, reason: 'platform' })`.
- [ ] **Step 4:** `npm test` → PASS. Commit `feat(backend): ingest zachytí smazání zpráv na Twitchi, Kicku a YouTube`.

---

### Task 4: Moderátorské scopes (mod + bot) a `missingScopes`

**Files:**
- Modify: `backend/src/lib/oauthTwitch.ts`, `oauthKick.ts`, `oauthYoutube.ts` (konstanty `MOD_SCOPES`), `routes/webAuth.ts:74-106` (`/auth/:platform/start` body `mod?: boolean`), `routes/integrations.ts:178-189` (bot link flow), `lib/botIdentities.ts` (`BotIdentity.scopes`, `botStatus` → `missingScopes`)
- Create: `backend/src/lib/modScopes.ts`
- Test: `backend/src/lib/modScopes.test.ts`

**Interfaces:**
- Produces:
  - `MOD_SCOPES: Record<Platform, readonly string[]>` (`modScopes.ts`, hodnoty z Global Constraints; YouTube `[]`).
  - `missingModScopes(platform, granted: string[] | null): string[]`.
  - `/auth/:platform/start { returnTo, mod: true }` → authorize URL se `WEB_SCOPES + MOD_SCOPES[platform]`.
  - Bot link flow vždy žádá i `MOD_SCOPES`.
  - `botStatus().own[p].missingScopes` a `.shared[p].missingScopes` (`string[]`, jen pro napojené boty).
  - `BotIdentity.scopes: string[]`.

- [ ] **Step 1: Failing test:** `missingModScopes('twitch', ['user:write:chat'])` vrací všechny tři Twitch scopes; s kompletním seznamem `[]`; `'youtube'` vždy `[]`.
- [ ] **Step 2:** FAIL → **Step 3:** implementace + napojení do start/link/status → **Step 4:** PASS, `npx tsc --noEmit`.
- [ ] **Step 5:** Kick dev app: ověřit v Kick developer dashboardu, že jsou povolené scopes `moderation:chat_message:manage`, `moderation:ban` (jinak Kick authorize selže) — **ověří user**, poznamenat do hlášení.
- [ ] **Step 6: Commit** `feat(backend): moderátorská oprávnění pro mody a bota (+ missingScopes v bot/status)`. Po pushi poslat session `robjewsalot-d4`: „`missingScopes` je na dev".

---

### Task 5: `lib/modActions.ts` — smazání na platformě (mod → bot)

**Files:**
- Create: `backend/src/lib/modActions.ts`, `backend/src/lib/platformTokens.ts`
- Modify: `backend/src/lib/botSend.ts` (exportovat `twitchUserId`, `kickUserId`; `refreshBot` → `platformTokens`), `routes/webAuth.ts:165-172` (inline refresh → `platformTokens`)
- Test: `backend/src/lib/modActions.test.ts`

**Interfaces:**
- Consumes: `getDecryptedIdentity`, `storeRefreshedTokens`, `needsRefresh` (webAuth), `getBotIdentity`, `storeBotTokens` (botIdentities), `workspaceForChannel` (zidolista), `chatRole` (lib/chatRole), `MOD_SCOPES`/`missingModScopes` (Task 4), `youtubeLiveChatId` (webSend) není potřeba — delete bere jen id zprávy.
- Produces:
  - `refreshTokens(platform, refreshToken): Promise<TokenSet>` (`platformTokens.ts`) — jediné místo pro refresh (DRY; webAuth i botSend ho volají).
  - `type ModResult = 'ok' | 'bot' | `error:${string}``.
  - `deletePlatformMessage(p: { accountId: number; channel: string; platform: Platform; messageId: string }, deps?: { fetch?: typeof fetch; log? }): Promise<ModResult>`:
    1. aktér = identita moda na `platform`, když `chatRole(platform, login, platformChannel)` ∈ {moderator, broadcaster} a `missingModScopes` je prázdné;
    2. jinak bot workspace (`getBotIdentity(ws.slug, platform, ws.bot.mode !== 'shared')`, bez chybějících scopes) → výsledek `'bot'`;
    3. jinak `'error:no_actor'`.
    Volání: Twitch `DELETE https://api.twitch.tv/helix/moderation/chat?broadcaster_id=&moderator_id=&message_id=` (hlavičky `Authorization: Bearer`, `Client-Id`), 204 = ok; Kick `DELETE https://api.kick.com/public/v1/chat/{messageId}`; YouTube `DELETE https://www.googleapis.com/youtube/v3/liveChat/messages?id=`. 401 → refresh a jeden retry; 404 = ok (už smazaná); jiná chyba → `'error:<status>'`.
  - `platformChannel(channel, platform): Promise<string | null>` — Twitch = `channel`, Kick/YouTube z `ws.channels[platform]`.

- [ ] **Step 1: Failing testy** s injektovaným `fetch` a mocky identit (funkce přijmou `deps.identities` pro test: `{ mod: () => ident|null, bot: () => ident|null, role: () => 'moderator'|'viewer' }`):
  - mod je mod + má scopes → volá Twitch DELETE s jeho tokenem, vrací `'ok'`;
  - mod je mod, chybí scopes → bot → `'bot'`;
  - mod není mod na YouTube, bot existuje → `'bot'` (YouTube URL s `id=`);
  - 401 → refresh → retry → `'ok'`; žádný aktér → `'error:no_actor'`; 404 → `'ok'`.
- [ ] **Step 2:** FAIL → **Step 3:** implementace (refactor refreshů do `platformTokens.ts`, chování `/chat/send` a `sendAsBot` beze změny) → **Step 4:** `npm test` PASS + `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(backend): mazání zpráv na platformách účtem moda nebo botem (lib/modActions)`.

---

### Task 6: Route `POST /moderation/delete` + `GET /moderation/me`

**Files:**
- Create: `backend/src/routes/moderation.ts`
- Modify: `backend/src/server.ts` (registrace), `backend/src/lib/chatRole.ts` (helper pro účet)
- Test: `backend/src/routes/moderation.test.ts` (čisté funkce: validace těla, sestavení výsledku)

**Interfaces:**
- Consumes: `requireWebSession`, `listIdentities`, `isModOrBroadcaster` (reactions.ts), `publishDeleted` (Task 2), `deletePlatformMessage` (Task 5), `moderationActions`, `RateLimiter`.
- Produces:
  - `accountModPlatforms(accountId, channel): Promise<Platform[]>` — platformy, kde je účet mod/streamer (`chatRole.ts`).
  - `GET /moderation/me?channel=` → `{ ok, mod: boolean, platforms: Platform[], missingScopes: Record<Platform,string[]> }` (klient podle toho ukáže tlačítko a nabídku „Povolit moderaci účtem").
  - `POST /moderation/delete { channel, platform, messageId }` → 403 `not_mod` | 200 `{ ok, result: ModResult }`. Pořadí: ověřit moda → `publishDeleted({ reason:'mod', by:'<platform>:<login>' })` (SSE hned) → `deletePlatformMessage` → insert `moderation_actions` → odpověď. Rate limit 10 + 2/s per účet.

- [ ] **Step 1: Failing test** pro `DeleteBody` (zod: platform enum, messageId 1–128 znaků, channel `^[a-z0-9_]{2,25}$`).
- [ ] **Step 2–4:** implementace, `npm test` PASS, `npx tsc --noEmit`.
- [ ] **Step 5: Ručně proti lokálnímu backendu** (nebo po deployi): `curl -X POST …/moderation/delete` bez tokenu → 401; s tokenem ne-moda → 403.
- [ ] **Step 6: Commit** `feat(backend): POST /moderation/delete + GET /moderation/me`. **Před pushem ověřit, že Task 1 SQL běží na produkci.**

---

### Task 7: Sdílený core — zobrazení smazané zprávy

**Files:**
- Create: `extension/core/moderation.js`, `extension/moderation.css`, `scripts/test-moderation-core.js`
- Modify: `extension/core-bridge.js` (export `moderation`), `extension/sidepanel.html` (link `moderation.css`)

**Interfaces:**
- Produces (`core/moderation.js`):
  - `DELETED_STYLES = ['label', 'dim', 'strike', 'hide']`, `DEFAULT_DELETED_STYLE = 'label'`.
  - `deletedMode({ style, isMod, raw }): 'label' | 'dim' | 'strike' | 'hide'` — raw → `'label'`; isMod → `'dim'`; jinak `style` (neznámý → `'label'`).
  - `applyDeleted(el, { mode, label = 'Zpráva smazána', hasContent })` — DOM: přidá `uc-deleted uc-deleted--<mode>`; pro `'label'` (nebo když `hasContent` false) nahradí obsah `.tx` spanem `.uc-deleted-label`, odstraní GIF/emote obrázky; `'dim'`/`'strike'` nechá text + přidá štítek `Smazáno`; `'hide'` → `el.hidden = true`. Idempotentní. Nevolá `chrome.*`.
- CSS (`moderation.css`): `.uc-deleted--dim .tx { opacity: .5 }`, `.uc-deleted--strike .tx { text-decoration: line-through; opacity: .6 }`, `.uc-deleted-label { font-style: italic; color: var(--text-secondary) }`, štítek `.uc-deleted-tag` ve stylu `.cleared-note`.

- [ ] **Step 1: Failing test** (`node scripts/test-moderation-core.js`, vzor `scripts/test-core-helpers.js` s `import()`): tabulka `deletedMode` (raw vyhrává nad isMod, isMod nad style, neznámý style → label).
- [ ] **Step 2:** FAIL → **Step 3:** implementace → **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(core): sdílené zobrazení smazané zprávy (core/moderation.js)`.

---

### Task 8: Addon — tlačítko, SSE, nastavení

**Files:**
- Modify: `extension/sidepanel.js` (NicknameManager :96-126 listener `message-deleted`; `msg-actions` :6996-7046; `_applyTwitchClearMsg` :4223 + `_markMessageCleared` :4234 → přes `core.moderation`; nové `_loadModState`, `_deleteMessage`, `_applyDeleted`; nastavení), `extension/sidepanel.html` (nastavení „Smazané zprávy"), `extension/sidepanel.css` (odstranit `.msg.cleared` pravidla nahrazená `moderation.css`), `extension/manifest.json` (bump 3.42.0)

**Interfaces:**
- Consumes: `UC_CORE.moderation` (Task 7), `GET /moderation/me`, `POST /moderation/delete` (Task 6), SSE `message-deleted` (Task 2).
- Produces: `config.deletedStyle`; body třída `uc-can-moderate`; tlačítko `[data-act="delete"]` v `.msg-actions` vlevo od 💩.

- [ ] **Step 1:** NicknameManager: `es.addEventListener('message-deleted', (e) => this.onMessageDeleted?.(JSON.parse(e.data)))`; UnityChat: `onMessageDeleted = (d) => { if (d.channel === this.config.channel) this._applyDeleted(d.platform, d.messageId, d.reason) }`.
- [ ] **Step 2:** `_applyDeleted(platform, id)`: najít `.msg[data-msg-id="<id>"]` (CSS.escape) i zaparkované uzly (`_parkedTop/_parkedBottom`), ve store `store.get(id)._deleted = true`; `core.moderation.applyDeleted(el, { mode: deletedMode({ style: this.config.deletedStyle, isMod: this._canModerate }), hasContent: true })`. Re-render cesta (:6824) aplikuje totéž pro `_deleted` / `msg.deleted` z historie (`hasContent: false`).
- [ ] **Step 3:** `_applyTwitchClearMsg` přesměrovat na `_applyDeleted('twitch', id)` (jedna cesta); `_markMessageCleared` pro ban/timeout zatím ponechat (část 2).
- [ ] **Step 4:** `_loadModState()` po přihlášení a přepnutí streamera: `GET /moderation/me` → `this._canModerate`, `body.uc-can-moderate`; tlačítko delete (ikona koše, title „Smazat zprávu") vkládat vždy před 💩, CSS ho ukáže jen s `uc-can-moderate`. Klik → `_deleteMessage(el)`: okamžitě lokálně `_applyDeleted` (optimisticky), `POST /moderation/delete`; výsledek `'bot'` → toast „Smazáno botem (tvůj účet nemá oprávnění moderovat)" + tlačítko „Povolit moderaci účtem" → login modal s `mod: true`; `'error:…'` → toast „V UnityChatu smazáno, na <platforma> se smazat nepodařilo". UC_LOG tag `Mod`.
- [ ] **Step 5:** Nastavení (sekce Zobrazení): select „Smazané zprávy" (Zpráva smazána / Zašedlé / Přeškrtnuté / Skryté) → `config.deletedStyle`, změna přerenderuje smazané uzly.
- [ ] **Step 6: E2E headless** (vzor scratchpad `qde2e.mjs`: `Extensions.loadUnpacked` + `Fetch.requestPaused` mock): mock `/moderation/me` `{mod:true}`, historie s 1 zprávou → hover tlačítko existuje → klik → POST zachycen → zpráva má `uc-deleted--dim`; bez modu → emit SSE (mock EventSource odpovědi) → `uc-deleted--label`, text pryč.
- [ ] **Step 7: Commit** `feat(extension): mazání zpráv pro mody + zobrazení smazaných zpráv (v3.42.0)`.

---

### Task 9: Web + OBS (repo `UnityChat-web`)

**Files (repo `D:\_BACKUP_2.0\Code Projects\UnityChat-web`):**
- Modify: `web/src/chat.js` (WebChat — listener SSE `message-deleted`, render), `web/src/main.js` (RAW větev: vždy `raw: true`), nastavení ⚙ webu (`deletedStyle`), hover akce zprávy (tlačítko delete vlevo od 💩 jako addon)

**Interfaces:**
- Consumes: `@core/moderation.js`, `@core/../moderation.css` (stejně jako `composer.css`), endpointy Task 6.

- [ ] **Step 1:** Po merge upstream dev (`git pull` v UnityChat-web, sync action) napojit stejně jako addon Task 8 kroky 1–5; RAW (`body.uc-raw`) → `deletedMode({ raw: true })`, v RAW žádné tlačítko.
- [ ] **Step 2:** Lokálně `npm run dev`, ověřit `?debug=1&channel=uctest` s mock SSE; `npm run build` bez chyb.
- [ ] **Step 3:** Commit v UnityChat-web, `cd web && npm run deploy`.

---

### Task 10: Nasazení a ověření

- [ ] **Step 1:** Ověřit, že SQL z Task 1 je na produkci (`\d messages`).
- [ ] **Step 2:** Push dev (backend Coolify) → `curl https://api.jouki.cz/health` a `curl -s -o /dev/null -w "%{http_code}" -X POST https://api.jouki.cz/moderation/delete` → 401.
- [ ] **Step 3:** Poslat session `robjewsalot-d4` info o `missingScopes`; userovi napsat: Rob musí znovu napojit bota v Židolištce (moderátorské scopes); zkontrolovat Kick dev app scopes.
- [ ] **Step 4:** Živý test na kanálu `uctest` (ne veřejný chat — `feedback_no_web_leak.md`): mod smaže zprávu z addonu → zmizí na Twitchi i ve webu/OBS; smazání v nativním Twitchi → projeví se v UnityChatu.
- [ ] **Step 5:** Aktualizovat CLAUDE.md milestones + memory, `store/listing` beze změny (žádné nové oprávnění addonu).
