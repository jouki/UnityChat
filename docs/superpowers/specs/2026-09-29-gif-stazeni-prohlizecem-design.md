# GIF — stažení prohlížečem odesílatele (rozhodnutí usera 2026-09-29)

Navazuje na `2026-09-26-gif-knihovna-design.md` (tok žádostí) a `2026-09-27-gif-review-upravy-design.md`.

## 0. Proč
- Imgur blokuje IP naší VPS (Hetzner) **úplně**: HTML stránky i CDN `i.imgur.com` vracejí 429 „over capacity“
  (ověřeno 2026-09-28/29, libovolný UA i hlavičky). Imgur API nové aplikace neregistruje (12/2025) a jeho odkazy
  vedou zase na blokovanou CDN. Bright Data Web Unlocker stránku odemkne, ale za médium vrací HTML stránku (chová se
  jako prohlížeč, který na adresu naviguje); residenční proxy jsou placené (mimo free kredity).
- Z prohlížeče uživatele médium jde: `i.imgur.com` posílá `Access-Control-Allow-Origin: *` (ověřeno), takže
  `fetch()` z webu i addonu bajty přečte.
- **Řešení:** když server médium stáhnout nemůže, ale ví, co má stáhnout, požádá odesílatele, ať ho stáhne jeho
  prohlížeč a pošle serveru. Server ověří, že dostal to, co povolil, a dál jede běžná cesta (fronta modům / „jen
  schválené“ / knihovna).

## 1. Kdy se výzva spustí
- Jen při **selhání převodu typu „host blokuje server“**: stažení stránky nebo média skončí `http_429` nebo
  `http_403` (bez Cloudflare challenge — ta má dnes unlocker), a to ne u našeho odkazu (`mode: own`).
- Server se **učí blokující hosty za běhu**: host (bez `www.`) po prvním 429/403 na 24 h v paměti procesu
  (`blockedHosts`, strop 200 položek). Pro známý blokující host se přímé stažení přeskočí a jde se rovnou na krok 2
  (ušetří 10 s limit převodu). Nic natvrdo na imgur; `*.imgur.com` je jen první případ.
- Podmínky navíc: odesílatel má účet UnityChatu (`tell` z `toSender` není null — jinak není komu výzvu poslat →
  dnešní chování „běžný odkaz“), odměna GIFů odesílatele je použitelná (stejná kontrola jako dnes; cooldown / bez
  odměny se rozhoduje dřív než převod) a režim není takový, aby médium nemělo smysl (režim `approved`: neznámé médium
  = „Nové GIFy teď nejsou povolené“ **bez** výzvy — bajty by se stejně nepoužily).

## 2. Co server zjistí sám (popis média)
- `mode: direct` (odkaz přímo na soubor): adresa média = odkaz, očekávaný typ podle přípony / neznámý.
- `mode: page` (stránka Tenor / Giphy / Imgur…): stránka se přečte **přes Web Unlocker** (u blokujícího hosta vždy,
  bez ohledu na Cloudflare; funguje, ověřeno u imguru — nová větev v `safeGet`: 429/403 od hosta v `blockedHosts`
  → unlocker; v režimu `approved` se unlocker nevolá, viz §1). Z `og:video` / `og:image` vezme adresu média
  (`pickOgMedia` jako dnes), typ (`og:video` → mp4, jinak gif/webp podle přípony) a **rozměry**
  `og:video:width/height` resp. `og:image:width/height` (u imguru jsou vždy; chybí-li, popis je bez rozměrů a
  kontrola rozměrů se u uploadu neaplikuje).
- Adresa média musí projít `assertPublicUrl` a **musí být na stejném registrovaném doménovém jméně jako stránka**
  (imgur.com ↔ i.imgur.com ano; stránka X → médium na cizím hostu ne → bez výzvy, chyba `no_media`). Klient adresu
  nikdy nevolí.
- Když se popis nezíská (stránka přes unlocker selže, žádné `og:*`, vyčerpaný denní strop unlockeru) → dnešní
  chování (běžný odkaz), bez výzvy.

## 3. Token a výzva
- Server vydá **jednorázový token** (32 B náhodně, base64url; v paměti procesu, `Map<tokenHash, ClientFetchGrant>`,
  strop 500, TTL 90 s): `{ requestKey (platform:messageId), channel, accountId (senderAccount), mediaUrl, kind|null,
  width|null, height|null, maxBytes: GIF_MAX_BYTES, expiresAt }`. Token se nikdy neloguje.
- Odesílateli (jen jemu, `/account/stream`) jde `gif-progress` s novou fází
  `client_fetch`, `pct: 50`, `{ token, url, kind, width, height, host, expiresAt, serverNow }`.
- Intercept **čeká** na výsledek (`deps.clientFetch(grant)` vrací `Promise<ResolvedGif | null>`): upload → jede
  dál jako by médium stáhl server (`fresh`), odmítnutí / vypršení → `null` → dnešní cesta selhání (`settleHeld` /
  běžný odkaz). Během čekání zůstává původní zpráva schovaná (`gif_request`), jako u stahování dnes; `GET /gif/held`
  ji hlásí „čeká“ (`inflight`). Limit převodu se prodlouží o TTL tokenu.
- Odesílatel může poslat **odmítnutí**: `POST /gif/client-fetch/decline { token }` → grant zrušen, intercept dostane
  `null` hned (nečeká na TTL), `gif-notice { kind: 'client_declined' }` → štítek „Odkaz zůstal běžnou zprávou“
  zmizí po 5 s (zpráva se obnoví jako běžný odkaz přes `settleHeld` → `message-restored`, jak je dnes u selhání).

## 4. Klient (addon i web, sdílený core)
- `GifOutbox.onProgress`: fáze `client_fetch` → `e.state = 'client_fetch'`, uloží `{ token, url, kind, width,
  height, host, expiresAt }`; `view()` vrací `{ kind: 'client_fetch', host, url, token, expiresAt }`.
- **Štítek u vlastní zprávy** (`paintGifStatus`, nový `kind === 'client_fetch'`): text
  „Server nemůže GIF z **imgur.com** stáhnout. Stáhnout ho tvým prohlížečem a poslat?“ + tlačítka
  **Stáhnout a poslat** / **Ne** + zaškrtávací **Zapamatovat volbu** (výchozí nezaškrtnuto). Nic nevyskakuje. Pod
  textem tenký odpočet do vypršení (jako `uc-gif-st-wait`). Po vypršení: štítek „Vypršelo, odkaz zůstal běžnou
  zprávou“ 5 s a pryč (server mezitím zprávu obnovil).
- **Stáhnout a poslat:** `fetch(url, { mode: 'cors', credentials: 'omit', redirect: 'error' })` s `AbortSignal.timeout(20 s)`
  → kontrola `Content-Length` / průběžně načtených bajtů ≤ `maxBytes` (jinak stop + štítek „GIF je moc velký (max
  10 MB)“) → `POST /gif/client-upload` (Bearer, `Content-Type: application/octet-stream`, hlavička
  `X-Gif-Token: <token>`, tělo = bajty; průběh uploadu se ukazuje kolečkem jako dnes: 50–95 %). Odpověď 202 →
  dál běžný průběh ze serveru (`verify` 95 → `done`). Chyba → štítek s důvodem (§6) 5 s, zpráva zůstane běžným
  odkazem (server po chybě uploadu grant zruší a intercept dostane `null`).
- Odkaz na stažení jde přímo z prohlížeče uživatele na `i.imgur.com` — jeho IP imgur uvidí (jako když stránku
  otevře sám). Do štítku tooltip „Stáhne se z tvého prohlížeče (imgur uvidí tvou IP)“.
- **Ne:** `POST /gif/client-fetch/decline`.
- **Zapamatovat volbu:** při zaškrtnutí se s akcí pošle `remember: true` → server uloží předvolbu účtu (§5).
  Předvolba `always` → klient výzvu vůbec neukáže a stáhne rovnou (štítek jen kolečko „Stahuji z imgur.com…“);
  `never` → klient pošle decline hned (štítek „Odkaz zůstal běžnou zprávou“ 5 s). Předvolba dorazí v `/auth/me`
  (`gifClientFetch: 'ask'|'always'|'never'`) a v samotné události (`pref`), aby klient nemusel čekat.
- **Nastavení:** v nastavení účtu (addon ⚙ sekce GIFy / web ⚙) řádek „GIF, který server nestáhne: **Zeptat se** /
  Stáhnout mým prohlížečem / Nechat jako odkaz“ (`PUT /account/gif-prefs { clientFetch }`). Bez přihlášení řádek není.
- Addon: `fetch` na `i.imgur.com` jde z kontextu side panelu; host není v `host_permissions` — CORS `*` stačí
  (běžný cross-origin fetch), žádné nové oprávnění. Web: totéž z `robdiesalot.com`. OBS (`raw`): nic (nemá účet).

## 5. Předvolba účtu
- Tabulka `account_gif_prefs (account_id PK → web_accounts, client_fetch text NOT NULL DEFAULT 'ask',
  updated_at)` — SQL `backend/sql/2026-09-29-gif-client-fetch.sql` (ručně na produkci před pushem, jako
  `account_donate_prefs`). Hodnoty `ask | always | never`.
- `GET /auth/me` přidá `gifClientFetch`. `PUT /account/gif-prefs { clientFetch }` (Bearer), 400 na jinou hodnotu.
  Přepnutí platí pro všechna zařízení účtu; při `always` server výzvu dál posílá stejně (klient jen nečeká na
  souhlas) — tím pádem se nic neděje, když je uživatel offline: bez uploadu do TTL → běžný odkaz.

## 6. Kontroly na serveru (`POST /gif/client-upload`)
Pořadí, každá chyba = 4xx s `{ ok:false, error }`, grant se zruší (jednorázový), intercept dostane `null`:
1. Bearer session (`requireWebSession`); rate limit **5 uploadů / min / účet** a **20 / min / IP** (`rate_limited`).
2. `X-Gif-Token` → grant existuje, nevypršel, **`grant.accountId === req.webAccountId`** (`bad_token`; stejný kód pro
   všechny tři případy — neprozrazovat, který).
3. Tělo: `bodyLimit` route = `GIF_MAX_BYTES` + 1 KiB (Fastify vrátí 413 dřív, než se tělo načte celé); parser
   `application/octet-stream` jen pro tuto routu (`parseAs: 'buffer'`). Prázdné tělo → `empty`.
4. `sniffKind(bytes)` musí dát typ (gif/webp/mp4) a **rovnat se `grant.kind`**, je-li znám (`bad_type`).
5. `withinLimits` (rozměry z hlavičky + sonda `sharp`/`ffprobe`: ≤ 2048 px, ≤ 600 snímků; poškozené → `bad_media`).
6. **Rozměry = rozměry ze stránky** (`grant.width/height`, jsou-li známé) s tolerancí ±1 px (`size_mismatch`).
   U `direct` odkazů bez `og:*` rozměry známé nejsou → jen limity.
7. Výsledek = `ResolvedGif { bytes, kind, contentType, width, height, sourceUrl: grant.mediaUrl }` → intercept.
Odpověď 202 `{ ok: true }`; server pak pokračuje jako po vlastním stažení (sha256, dedup podle hashe, uložení,
žádost / instant / approved-only). Odpověď na `decline`: 200 `{ ok: true }` (i pro neznámý token — bez informace).

## 7. Důvěra a dedup
- Médium z klienta se ukládá s `gif_media.source = 'client'` (nový sloupec, výchozí `'server'`; SQL ve stejném
  souboru jako §5) a **bez
  `source_url_norm`** (NULL). Tím se imgur URL **nestane klíčem dedupu**: kdyby někdo k odkazu X nahrál jiný obsah,
  další lidé s odkazem X dostanou znovu výzvu a stáhnou si svůj skutečný soubor. Dedup podle `sha256` zůstává (stejný
  soubor od dvou lidí = jedno médium; už schválené → rovnou do chatu).
- Zamítnuté / zahozené: `findMedia` podle URL se u klientských médií nepoužije (NULL), podle hashe ano → zamítnutý
  obsah zůstane zamítnutý, i když přijde přes klienta.
- Do karty moda (`gif-pending` → `media`) a do knihovny se přidá štítek zdroje „z prohlížeče odesílatele“
  (`clientFetched: true` ve view), aby mod věděl, že adresa zdroje je jen tvrzení. Riziko obsahu je stejné jako u
  odkazu na vlastní hosting (to jde dnes) — rozhoduje mod, popř. auto-schválení moda u vlastních GIFů (jako dnes).
- `moderation_actions`: `gif_request` dostane `params.source = 'client:<host>'`.

## 8. Co se nemění
- Cooldowny, odměna, „jen schválené“, fronta, karty, knihovna, OBS, integrační stream Židolišty (jen `gif.pending`
  nese `clientFetched`). Web Unlocker zůstává pro Cloudflare challenge; **proxy modul `lib/gifProxy.ts` a env
  `BRIGHTDATA_CUSTOMER_ID` / `BRIGHTDATA_PROXY_PASSWORD` se odstraní** (pro imgur nepoužitelný, ověřeno §0) —
  z kódu, `.env.example`, README i z Coolify.

## 9. Testy
- Backend (`gifRequests.test.ts`, `gif.test.ts`, `gifMedia.test.ts`): blokující host → popis přes unlocker → výzva
  (`gif-progress client_fetch` jen odesílateli, bez tokenu v logu) → upload správných bajtů → žádost / instant;
  upload cizím účtem (`bad_token`), po TTL, dvakrát týmž tokenem, jiný typ, jiné rozměry, přes limit, poškozené;
  decline → `null` → obnova zprávy; režim `approved` → bez výzvy; odesílatel bez účtu → běžný odkaz; `blockedHosts`
  učení + přeskočení přímého stažení; klientské médium bez `source_url_norm` (stejná URL znovu = nová výzva),
  dedup podle sha256; rate limit; `PUT /account/gif-prefs` + `/auth/me`.
- Core (`scripts/test-gif-library.js`): `onProgress client_fetch` → view, `always/never`, vypršení; `paintGifStatus`
  nový štítek s tlačítky.
- E2E addon + web (`e2e-gif`): výzva u vlastní zprávy, klik „Stáhnout a poslat“ (mock `i.imgur.com` přes
  Fetch interception → CORS hlavičky), upload (mock 202) → kolečko → `done`; „Ne“; „Zapamatovat“ → další GIF bez
  výzvy; nastavení účtu přepíná.
