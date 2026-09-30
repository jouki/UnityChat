# GIF knihovna, dedup, zamítnuté GIFy, průběh stahování — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Každý task = vlastní
> worktree + testy + review. Plán je na úrovni tasků (jako předchozí plány moderace); implementer si detaily najde
> v kódu — body níže jsou závazné požadavky.

**Goal:** Rozšířit GIF odměnu o knihovnu schválených GIFů, deduplikaci (přesnou i podobnostní), správu zamítnutých
GIFů s tokenovým přístupem, FIFO frontu synchronizovanou mezi mody a průběh stahování u odesílatele.

**Architecture:** Backend (`backend/src/lib/gif*.ts`, `routes/gif.ts`) drží veškerou logiku a posílá stav přes SSE
(`/account/stream` soukromě, `/nicknames/stream` veřejně). Sdílený core (`extension/core/gif.js` + nové moduly)
vykresluje UI jednou pro addon i web; OBS (raw) jen zobrazuje.

**Tech Stack:** Fastify 5 + Drizzle + Postgres 18 (backend), vanilla ES moduly (core), Chrome MV3 addon, Vite web,
`sharp` (snímky GIF/WebP) + `ffmpeg` (MP4 snímky) pro perceptuální hash.

**Spec:** `docs/superpowers/specs/2026-09-26-gif-knihovna-design.md` (závazná; při rozporu vyhrává spec).
Navazuje na `docs/superpowers/plans/2026-09-25-moderace-cast-2-kontrakt.md` (Část 4) — kontrakt aktualizovat.

## Global Constraints
- Nasazení: **addon + web + OBS (raw)**. Web v repu `UnityChat-web` (jen `web/`), sdílené soubory jen tady.
- Manifest addonu: **jen build číslo +1** na každý commit měnící addon/core. Nikdy minor.
- Backend se nasazuje z `dev` hned na produkci → **nové SQL soubory spustit na produkci před pushem** (controller).
- Bezpečnost: tokeny nikdy do logu/odpovědí (kromě vydání vlastníkovi), v DB jen hash; mod gate na serveru
  (`accountModIdentities`); integrace Židolišty přes podpis v2 (`inboundAuthorized`).
- Čeština v UI s diakritikou, 3 tvary množného čísla.
- Čekající GIF: veřejně dostupný přes náhodné ID; schválený veřejný (Discord embed OK); **zamítnutý jen s tokenem**.
- Zámek tlačítek fronty: **1 s** po aktualizaci od jiného moda, **0,3 s** po vlastním kliku. Platí první rozhodnutí.
- Schválený GIF se zobrazí **na konci chatu (čas schválení)** v UC i OBS.
- Retence zamítnutých **14 dní**, vault vyjímka. Auto-zákaz GIFu **12 h** pro všechny.
- Opakované zamítnutí: stejný uživatel + stejný GIF → 1. mod, 2. znovu ke schválení, **3.+ auto zamítnuto + smazáno**.
- Režim odměny z `gif-access.mode` (`all` | `approved`); `approved` platí i pro mody/streamera; nový GIF v tom
  režimu → zpráva smazána + hláška odesílateli.

---

### Task 1: Backend — dedup, zamítací logika, přístup, retence, fronta, pozice, režim, průběh
**Files:** `backend/sql/2026-09-26-gif-library.sql` (nové), `backend/src/db/schema.ts`, `backend/src/lib/gifRequests.ts`,
`lib/gifMedia.ts`, `lib/gifAccess.ts`, `routes/gif.ts`, nový `lib/gifTokens.ts`, testy `*.test.ts`, kontrakt Část 4.
- SQL: `gif_media.sha256`, `gif_media.source_url_norm` (unikátní index per kanál pro schválené), `gif_media.status`
  (`approved|pending|rejected`), `rejected_at`, `vault`, `use_count`, `last_used_at`, `approved_at`; tabulka
  `gif_rejections(channel, media_id, platform, user_id, count, last_at)`; `gif_bans(channel, media_id, until, by)`;
  `gif_access_tokens(id, account_id|null, integration_slug|null, token_hash, created_at, revoked_at)`.
- Dedup: před stažením lookup podle normalizované URL (bez utm, fragmentu; stejné schéma/host lowercase), po stažení
  podle sha256. Schválený duplikát → rovnou `gif-message` bez žádosti (i divák), `use_count++`. Zamítnutý duplikát →
  logika zamítnutí (count per user; 3.+ auto; ban 12 h → auto pro všechny). Jinak žádost s příznakem
  `previouslyRejected` (+ kdy/kým) pro kartu i label odesílatele.
- Režim `approved`: nový (neznámý) GIF → smazat zprávu (reason `gif_rejected`/nový `gif_not_allowed`) + SSE
  odesílateli `gif-notice { kind: 'approved_only' }`; odkaz na naše médium / známý schválený projde.
- Fronta: `GET /moderation/gif/pending` řazené FIFO (`created_at`); `decide` atomicky, pozdní → 409
  `{ status, decidedBy }`; SSE `gif-queue { pendingCount, headId }` všem modům kanálu po každé změně.
- Pozice: `insertApprovedMessage` s časem **schválení** (ne původní zprávy); `replaces` pryč (nebo ignorovat klienty).
- Průběh: `gif-progress { requestKey, messageId, phase, pct }` odesílateli přes `/account/stream`
  (fáze dle specu; Bright Data odhad = klouzavý průměr posledních 20 dob fallbacku, škálovaný velikostí).
- Tokeny: `POST /moderation/gif/access-token` (mod, vydá/obnoví vlastní token, vrací jen jednou), ověření v
  `/media/gif/:id?t=` pro zamítnuté (hash lookup + účet je stále mod kanálu média, nebo integrační token).
- Zamítnuté: `GET /moderation/gif/rejected?channel&before`, `POST /moderation/gif/:mediaId/{approve|vault|purge}`,
  `POST /moderation/gif/:mediaId/ban12h`; retence tick 1×/h maže zamítnuté starší 14 dní bez vaultu.
- Testy: dedup URL i sha256, 3.+ auto, ban 12 h, previouslyRejected, režim approved, FIFO + 409, token (bez/špatný/
  revokovaný/nemod), retence, pozice času schválení, progress fáze.

### Task 2: Backend — knihovna, tagy, perceptuální hash, API pro Židolištu
**Files:** `backend/sql/2026-09-26-gif-phash.sql`, `lib/gifLibrary.ts` (nové), `lib/gifPhash.ts` (nové),
`routes/gif.ts`, `routes/integrationGif.ts` (nové), `backend/package.json` (sharp), `backend/Dockerfile` (ffmpeg), testy.
- `GET /gifs/library?channel&q&cursor` (veřejné, rate limit per IP): schválené GIFy kanálu řazené `use_count desc,
  last_used_at desc`, tagy, rozměry, URL média. Použití se počítá při každém zobrazení schválené zprávy (dedup hit).
- Tagy: z Tenor/Giphy stránky (og:title, keywords) při stažení; `gif_media.tags text[]`; úprava přes integraci.
- Perceptuální hash: dHash 64 bit z N=8 snímků rovnoměrně v čase (GIF/WebP přes `sharp` pages, MP4 přes `ffmpeg`
  `-vf fps`); uložit pole hashů; na pozadí dopočítat pro existující. Podobnost = podíl snímků s Hammingem ≤ 10
  přes posunuté zarovnání sekvencí ≥ 0,6 → návrh `gif_duplicates(a,b,score,status)`.
- Integrace (podpis v2, slug→kanál): `GET /integrations/:slug/gifs` (schválené + tagy), `PUT …/gifs/:id/tags`,
  `GET …/gifs/rejected`, `POST …/gifs/:id/{approve|vault|purge}`, `GET …/gifs/duplicates`,
  `POST …/gifs/duplicates/:id/{keep-first|keep-second|keep-both}` (sloučení = přesměrovat použití na ponechaný,
  druhý smazat), integrační token pro zamítnuté média.
- Mod v UC: `GET /moderation/gif/duplicates?channel` + stejné akce.
- Testy: řazení knihovny, tagy parse, dHash (fixture GIF + překomprimovaná kopie = podobné, jiný GIF = ne),
  duplicity akce, integrace auth.

### Task 3: Core + addon — průběh, labely, FIFO karta se zámky, GIF záložka, indikátor
**Files:** `extension/core/gif.js`, nové `extension/core/gif-library.js`, `extension/core/emote-picker.js`
(boční záložky), `extension/gif.css`, `extension/sidepanel.js`, manifest (build +1), `scripts/e2e-gif.mjs`, `scripts/test-gif.js`.
- Optimistická zpráva odesílatele s odkazem + **kolečko s %** (z `gif-progress`), pak peach label
  **„Schvalování moderátorem ( )“** (animace), ⚠ s tooltipem při `previouslyRejected`; po zamítnutí/vypršení červený
  label natrvalo; mod: po dokončení GIF místo zprávy.
- Schválený GIF na konci chatu (čas schválení).
- FIFO karta: jen nejstarší + „+N čeká“, sync z `gif-queue`, zámek 1 s / 0,3 s, 409 → „Už rozhodl X“.
- Panel emotů: svislé boční záložky (Emoty | GIFy). GIF záložka: knihovna (řazení podle použití, hledání v tazích),
  výběr → `_sendMessage({ text: <náš odkaz> })`; bez odemčené odměny zamčené + hláška; mod/streamer taby
  **GIFy | Zamítnuté GIFy** (akce Schválit / Vault / Trvale zahodit; náhledy s tokenem) + návrhy duplikátů.
- Indikátor: časový pásek pod ikonou emotů a na boční GIF záložce (jako soundboard), odpočet nahoře v záložce.
- Hláška pro režim `approved` (`gif-notice`).
- e2e: všechny body výše + zámky + sync dvou modů (dvě instance nebo simulované SSE).

### Task 4: Web + OBS
**Files:** `UnityChat-web/web/src/*` (napojení core jako addon), OBS (raw) cesta.
- Stejné napojení jako addon (merge `upstream/dev`), OBS: čekající nikdy, schválený na konci; e2e web.

### Task 5: Nasazení a kontrakt
- SQL na produkci (controller), push dev, deploy webu, info Židolišti (API kontrakt + integrační token přes Coolify),
  aktualizace kontraktu Část 4, memory.
