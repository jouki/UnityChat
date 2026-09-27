# Twitch Client-Integrity: research (spike)

Datum: 2026-09-27. Nic se neimplementovalo, na Twitch se nic neposlalo.

**Problém:** `background.js` → `annivGql()` posílá `SendUserModiversaryNotice`
(a `Chat_ShareResub_UseResubToken`) s `Authorization: OAuth <auth-token cookie>`.
Dotazy projdou, mutace vrátí `errors=["failed integrity check"]` a
`extensions.challenge.type = "integrity"`.

**Zdroje:**
- Uložený build Twitche: `C:\Users\mjouk\Downloads\(24) RobDiesALot - Twitch_files\`,
  hlavně `21956-986df8e24fc2e5eb1587.js` (integrity manager, Apollo linky, session)
  a `p.js` (Kasada SDK, 150 kB, obfuskované).
- Předchozí research: `2026-09-27-twitch-vyroci-research.md`, kapitola 5.
- Veřejné zdroje: streamlink `plugins/twitch.py` a issue #6109, Kodi plugin.video.twitch
  issue #667, Kappador/twitch-integrity.

---

## 1. Jak web získá token (jisté, z kódu)

Endpoint je v configu: `this.integrityEndpoint = \`${_.Tx}/integrity\`` (`_.Tx` = `https://gql.twitch.tv`).

`rawFetchIntegrityResponse` (třída `me`, integrity manager):

```js
async rawFetchIntegrityResponse(e){
  const t=this.config.integrityEndpoint;
  let r={"Client-Id":this.config.authSettings.clientID,
         "X-Device-Id":this.session.deviceID,
         "Client-Request-Id":e,                 // náhodných 32 znaků (Ie.Q(32))
         "Client-Session-Id":this.session.appSessionID,
         "Client-Version":this.config.buildID};
  this.authToken&&(r.Authorization=`OAuth ${this.authToken}`);
  r=await this.nexus.maybeAddNexusAuthorizationHeader(t,r);   // no-op v produkci
  const i=await fetch(t,{headers:r,method:"POST"}), n=await i.json();
  if("error"in n)throw new Error(n.message);
  return n}
```

- **POST bez těla.** Hlavičky `x-kpsdk-*` v kódu Twitche **nejsou**. Přidává je
  Kasada, která přepisuje `window.fetch`/XHR pro nakonfigurované endpointy:
  ```js
  // konstruktor me: pokud flag cit_kasada_rollout
  i.push({protocol:"https",method:"POST",domain:"gql.twitch.tv",path:"/integrity"})
  // + passport.twitch.tv /integrity, /protected_register, /protected_login
  this.kasada=new Se({..., endpointsToProtect:i})
  // Se.loadKPSDK(): vloží <script src="https://k.twitchcdn.net/149e9513-.../p.js">,
  // na události "kpsdk-load" zavolá window.KPSDK.configure(endpoints), čeká na "kpsdk-ready"
  ```
  Před každým stažením tokenu: `this.shouldUseKasadaSDK&&await this.kasada.loadKPSDK()`.
- **Odpověď:** objekt s `token`, `expiration` (ms epoch) a `request_id`
  (`i.expiration`, `i.request_id` v `fetchAndStoreIntegrityToken`).
- **Platnost a obnova:** token se obnoví v 90 % životnosti:
  `const o=Math.round(.9*(i.expiration-n)); ... setTimeout(()=>this.fetchAndStoreIntegrityToken("expiration"),o)`.
  Délku životnosti kód neurčuje. Veřejné zdroje (streamlink cache `expires_at=expiration`)
  uvádějí řádově hodiny (odhad, v datech jsme ji neviděli).
- Retry: max `cit_max_retries` (3), backoff `5**n*(1+rand)` s.
- Kdy se token stahuje: při bootu (flag `cit_fetch_at_boot`), jinak líně při první
  challengi (`fetchNewToken("gql-challenge")`). Celý manager běží jen při
  `config.integrityAvailable && flag cit_manager_rollout`.
- `Authorization` se nastavuje po přihlášení: `i.x2.integrity.authToken=e`
  (stejný token jako `apollo.authToken`, tj. hodnota cookie `auth-token`).
  **Token je tedy vázaný na uživatele.**
- `X-Device-Id` = `session.deviceID` = cookie `unique_id` (kopie v localStorage
  `local_copy_unique_id`), `Client-Session-Id` = localStorage
  `local_storage_app_session_id` (konstanty v modulu 879386).

Token formát (veřejné zdroje, streamlink #6109): dřív PASETO `v4.public.` s čitelnými
poli (`is_bad_bot`, `device_id`, `user_id`, `client_id`, `exp` …), dnes šifrované
`v4.local.`. Obsah už nejde přečíst a „there's no way to verify that a token is good
anymore without making an additional request to an integrity restricted GQL
endpoint". **Vazba na device id je jistá** (streamlink posílá token vždy spolu
s `Device-Id`, pod kterým ho získal). Vazba na IP/UA je odhad.

## 2. Kde token žije a jak se přikládá (jisté, z kódu)

- **Jen v paměti** integrity manageru: `this.integrityResponse = i`,
  `getStoredToken(){ return this.integrityResponse?.token }`. Není v `localStorage`,
  cookie ani ve `window`.
- Manager je `Sr.integrity` / `i.x2.integrity` v modulu 571421 (root „x2“ s `apollo`,
  `integrity`, `session`, `store` …). Na `window` se nevystavuje; z globálů je
  jen `window.webpackChunktwitch_twilight` (webpack runtime).
- Přikládání (Apollo link, `getHeaders`):
  ```js
  this.authToken&&(r.Authorization=`OAuth ${this.authToken}`);
  const E=this.integrity.getStoredToken();
  E&&(0,ce.fX)("cit_gql_rollout")&&(r["Client-Integrity"]=E);
  const _=(0,Gt.e)(); _&&(r["Trusted-Twitch-Session"]=_);
  ```
  Takže když Twitch token má, přikládá ho ke **všem** GQL požadavkům.
- Challenge v odpovědi → link zařadí operaci do fronty, zavolá
  `Sr.integrity.fetchNewToken("gql-challenge")` a operaci zopakuje s hlavičkou
  `{"Client-Integrity": token}` (`replayOperation`).
- Kromě `Client-Integrity` posílá Twitch v GQL také `X-Device-Id`,
  `Client-Session-Id`, `Client-Version`, `Accept-Language`. Addon z `background.js`
  posílá jen `Client-Id` + `Authorization`.

## 3. Potřebuje to Kasadu? (jisté + odhad)

- **Jisté:** bez Kasady endpoint `/integrity` dnes nevydá použitelný token. Streamlink
  proto token bere přes headless Chromium na twitch.tv. Na stránce spustí
  `window.KPSDK.configure([{protocol:"https:",method:"POST",domain:"gql.twitch.tv",path:"/integrity"}])`
  a potom obyčejný `fetch("https://gql.twitch.tv/integrity",{method:"POST",headers:{Client-Id…, "x-device-id": …}})`.
  Kasada si hlavičky doplní sama. Kappador/twitch-integrity (bez prohlížeče) autor
  sám označuje za nepoužitelný: „flags the tokens generated by this package as a bot“.
  Kodi plugin se kvůli tomu vzdal follow/unfollow.
- **Silný odhad:** skript v MAIN world skutečné, přihlášené karty Twitche běží ve
  stejném `window`, kde je načtená Kasada, s reálným prohlížečem, cookies a IP.
  Je to stejná situace jako u streamlinku, jen prohlížeč není headless (to je pro
  Kasadu ještě lepší). Token vydaný takto by měl mít `is_bad_bot=false`.
- **Neověřeno:** jestli mutace výročí projdou i s platným tokenem. Server může mít
  další gate (`challenge-gates`, ověření telefonu). Zjistí se až prvním pokusem.
- Z **background service workeru** token získat nelze (Kasada tam neběží). Token
  získaný na stránce by šlo poslat do background a použít tam se stejným `X-Device-Id`.
  Nedoporučuju to: jiný kontext požadavku (bez `Origin: https://www.twitch.tv`,
  Kasada cookies atd.) a zbytečný přenos tokenu.

## 4. Bezpečnost a pravidla

- Požadavek jde jménem vlastního přihlášeného uživatele, z jeho karty, s jeho
  cookie a tokenem. Nic neopouští prohlížeč. Addon už teď používá `auth-token`
  cookie pro GQL (pin, výročí). Ani token, ani cookie se nesmí logovat ani posílat
  na api.jouki.cz.
- **ToS:** Twitch GQL je neveřejné API. Automatizace přes neveřejné API a obcházení
  „bezpečnostních opatření“ je v šedé zóně ToS a Developer Agreementu. Použití
  vlastní Kasady na stránce není obcházení, ale čtení interního tokenu z webpack
  modulu už je zásah do klienta. Riziko je nízké: jedna akce na uživatele
  a výročí, iniciovaná klikem. Nulové ale není.
- **Detekce:** integrity systém je antibot. Při chybném použití (jiný device id, token
  z jiného kontextu, příliš mnoho volání `/integrity`) může Twitch účet nebo zařízení
  označit (`is_bad_bot`). V praxi to znamená další challenge nebo captcha, bany
  kvůli tomu veřejně doložené nejsou (odhad). Proto token **nestahovat vlastní
  smyčkou**. Když ho má Twitch, převzít ho, jinak si ho nechat vydat Twitchem
  (`fetchNewToken`), který má rate limit a retry.
- **Křehkost:** názvy minifikovaných tříd a čísla modulů (571421, `x2`) se mění
  s každým buildem. Stabilní jsou tvary API (`integrity.getStoredToken`,
  `integrity.fetchNewToken`, `session.deviceID`, `session.appSessionID`),
  endpoint `/integrity`, cookie `unique_id`, `window.KPSDK`. Kasada p.js URL se
  mění. Počítat s tím, že se to jednou rozbije, a mít fallback.

## 5. Doporučené řešení pro addon

Mutaci poslat **z MAIN world karty Twitche** (`chrome.scripting.executeScript`,
vzor `KICK_SEND` / `YT_SEND`). Token převzít od Twitche, a když ho Twitch nemá,
nechat ho vydat Kasadou na stránce.

### 5.1 Karta
`_findStreamTab('twitch')` / background: najít tab `https://www.twitch.tv/<channel>`
(preferovat stejný kanál, stačí jakýkoli přihlášený twitch.tv tab, protože token je
vázaný na uživatele a zařízení, ne na kanál).

### 5.2 Funkce v MAIN world (náčrt, neimplementováno)

Pořadí strategií:

**A) Twitchův vlastní integrity manager (preferováno).** Najít ho přes webpack module
cache bez závislosti na čísle modulu:

```js
function twitchRoot() {
  let req;
  const q = self.webpackChunktwitch_twilight;
  q.push([[Symbol('uc')], {}, (r) => { req = r; }]);
  for (const m of Object.values(req.c || {})) {
    const ex = m?.exports; if (!ex) continue;
    for (const v of Object.values(ex)) {
      if (v?.integrity?.getStoredToken && v?.session?.deviceID && v?.apollo) return v;
    }
  }
  return null;
}
const root = twitchRoot();
let cit = root.integrity.getStoredToken() || await root.integrity.fetchNewToken('uc-share');
const headers = {
  'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
  'Content-Type': 'application/json',
  Authorization: 'OAuth ' + root.apollo.authToken,   // nebo auth-token předaný z background jako arg
  'X-Device-Id': root.session.deviceID,
  'Client-Session-Id': root.session.appSessionID,
  'Client-Integrity': cit,
};
const r = await fetch('https://gql.twitch.tv/gql', { method: 'POST', headers, body: JSON.stringify({ operationName, query, variables }) });
```
Když odpověď i tak vrátí `challenge.type === 'integrity'`: jednou
`fetchNewToken('uc-retry')` a opakovat. Pak to vzdát.
(`fetchNewToken` vrací `undefined`, když má Twitch manager vypnutý flag
`cit_manager_rollout`. Pak přejít na B.)

**B) Bez webpacku: vlastní `fetch` na `/integrity` ze stránky** (jako streamlink):
- `X-Device-Id` = cookie `unique_id` (fallback `localStorage.local_copy_unique_id`),
  `Client-Session-Id` = `localStorage.local_storage_app_session_id`,
  `Authorization` = `OAuth <auth-token>` (background ho má z `chrome.cookies`, předá
  jako `args`).
- Pokud `window.KPSDK?.isReady()` a Twitch endpoint nemá nakonfigurovaný, zavolat
  `KPSDK.configure([{protocol:'https',method:'POST',domain:'gql.twitch.tv',path:'/integrity'}])`.
  **Odhad:** nevíme, jestli druhé `configure` přepíše seznam Twitche (pak by
  přišel o passport endpointy). Proto B jen jako záloha a configure raději předat
  s kompletním seznamem (integrity + passport `/integrity`, `/protected_register`,
  `/protected_login`).
- `POST https://gql.twitch.tv/integrity` → `{token, expiration}` → GQL jako v A.
  Token cachovat jen v paměti té funkce (jedno použití), nikam neukládat.

**C) DOM fallback** (už navržený v research výročí): kliknout na callout Twitche
a vložit text. Nepotřebuje token, protože Twitch pošle mutaci sám a challenge si
vyřeší.

Fakticky nejbezpečnější a nejvěrnější Twitchi je ještě **A′**: poslat mutaci přímo
přes `root.apollo.client.mutate(...)`. Link si pak sám doplní token, challenge
i replay. Potřebuje ale `DocumentNode` (Apollo nepřijme string, `gql` tag není
vystavený). DocumentNode by šlo předat jako hotový AST objekt (JSON) vygenerovaný
v addonu z textu dotazu. Je to víc práce a křehké, proto A (vlastní fetch s tokenem
Twitche) je lepší poměr.

### 5.3 Tok v addonu
1. Panel: Sdílet → `TW_ANNIV_SHARE` do background.
2. Background: stávající `annivShare()` z background (bez tokenu). Při
   `integrity:true`:
3. najde Twitch tab → `executeScript({world:'MAIN', func: shareInPage, args:[op, query, variables, authToken]})`,
   funkce vrací jen `{status, data, errors, extensions, via:'A'|'B'}` (nikdy token).
4. Žádný Twitch tab → panel ukáže „Pro sdílení výročí otevři Twitch kanál
   v kartě a zkus to znovu“ (+ tlačítko, které kartu otevře `chrome.tabs.create`,
   počká na load a pak zopakuje krok 3, případně C).
5. UC_LOG `Anniversary`: cesta (bg/A/B/C), `hasStoredToken`, `challenge` typ,
   `errors`. **Bez tokenu, cookie a device id.**

Alternativa: rovnou jít přes kartu (bez pokusu z background). Pokus z background je
ale levný a kdyby server gate uvolnil, funguje i bez karty.

## 6. Totéž pro další operace

- `useChatNotificationToken` (resub share): stejný mechanismus, server vrací stejnou
  challenge (hlášeno v addonu, jisté).
- `GetPinnedChat` s `emoteID`: z v3.38.20–21 víme, že pole je za Client-Integrity.
  Stejná cesta A by ho vrátila (odhad). Pin je ale uzamčený (checkpoint v3.38.26),
  bez souhlasu usera nesahat.

---

## Co je jisté × odhad

| Tvrzení | Stav |
|---|---|
| Token = `POST https://gql.twitch.tv/integrity`, bez těla, hlavičky Client-Id / X-Device-Id / Client-Request-Id / Client-Session-Id / Client-Version / Authorization | jisté (kód) |
| `x-kpsdk-*` přidává Kasada přes `KPSDK.configure` na `fetch`, ne kód Twitche | jisté (kód + streamlink) |
| Odpověď `{token, expiration(ms), request_id}`, obnova v 90 % životnosti | jisté (kód) |
| Token jen v paměti `integrity.integrityResponse`, ne ve storage ani `window` | jisté (kód) |
| Twitch přikládá `Client-Integrity` ke všem GQL požadavkům (při flagu), na challenge replay | jisté (kód) |
| Token vázaný na uživatele (Authorization) a `X-Device-Id` | jisté pro user (kód), device silný odhad (streamlink) |
| Bez Kasady/prohlížeče token nefunguje nebo je `is_bad_bot` | jisté (veřejné zdroje) |
| Kasada v přihlášené kartě vydá dobrý token pro MAIN-world fetch | silný odhad |
| S platným tokenem mutace výročí projdou | neověřeno, jiný gate možný |
| Druhé `KPSDK.configure` nepřepíše konfiguraci Twitche | neznámé |
| Délka platnosti tokenu | neznámé (hodiny, odhad) |
| Riziko postihu účtu | nízké, nedoložené, nenulové |

## Zdroje
- Twitch build `21956-986df8e24fc2e5eb1587.js` (třídy `me`, `Se`, Apollo `getHeaders`, modul 879386)
- [streamlink #6109 — Client integrity token acquisition broken](https://github.com/streamlink/streamlink/issues/6109)
- [streamlink plugins/twitch.py](https://github.com/streamlink/streamlink/blob/master/src/streamlink/plugins/twitch.py)
- [plugin.video.twitch #667 — failed integrity check u follow](https://github.com/anxdpanic/plugin.video.twitch/issues/667)
- [Kappador/twitch-integrity README](https://github.com/Kappador/twitch-integrity/blob/master/README.md)
