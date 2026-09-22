# Chatové reakce (animace na zprávě) — referenční příručka

> **Pro koho:** pro příští session, která má přidat **další animaci**. První
> reakce (`poop`, „Peepo poop", 2026-09-22/23) je referenční implementace;
> tenhle dokument popisuje, jak se chová, proč je udělaná takhle a co přesně
> udělat u nové animace. Čti celé, hlavně části **3 (pozicování)**, **6 (pasti)**
> a **7 (postup pro novou animaci)**.

Reakce = krátká animace, kterou **mod nebo streamer** spustí kliknutím u konkrétní
zprávy a kterou pak **vidí všichni** uživatelé UnityChatu (rozšíření i web,
včetně browser source v OBS), synchronně a zacílenou na tutéž zprávu.

---

## 1. Finální podoba (co přesně uživatel vidí)

Časová osa od okamžiku, kdy server reakci přijme (`t = 0`). Čísla jsou z
`POOP` v `extension/core/reaction.js`.

| Čas | Co se děje |
|---|---|
| `t = 0` | Chat u **všech** klientů plynule ztmavne (1,2 s), na cílovou zprávu se rozsvítí měkký reflektor. Chat zároveň plynule odscrolluje k cílové zprávě (bez zvýraznění/bliknutí). Video začíná hrát. |
| `t = 0` | Tlačítko reakce **zmizí všem** modům i streamerovi (zámek). Další kliknutí serveru vrátí `409 busy`. |
| `t = 7,2 s` | Jméno autora, **text zprávy** a logo platformy **u cílové zprávy** zhnědnou (jméno `#6b4423`, text světlejší `#b5835a`, aby zůstal čitelný, logo přes filtr). Platí jen pro tu jednu zprávu. |
| `t = 15 s` | Video končí, scéna se 1,2 s odtmívá, overlay se odstraní, tlačítko se **zpřístupní**. |
| `t = 22,2 s` | Hnědá začíná 15 s plynule přecházet zpět na původní barvu (CSS `transition`). |
| `t = 37,2 s` | Hotovo, vše v původním stavu. |

Další vlastnosti finální podoby:

- **Zacílení:** animace je posazená tak, aby „to" dopadalo na **první řádek**
  cílové zprávy (u víceřádkové tedy na řádek se jménem, ne na konec odstavce).
- **Velikost:** odvozená od **výšky řádku textu**, ne od šířky okna. V úzkém
  panelu rozšíření zabere video celou šířku, v širokém okně má strop a
  **vycentruje se**. Ve velkém okně je záměrně větší než v panelu.
- **Kdo se přidá později** (otevře chat v průběhu): dostane `GET /reactions/active`
  a animace se **dopočítá od správného místa** (`offsetMs`), takže dohraje jen zbytek.
- **Zpráva mimo paměť:** kdo cílovou zprávu už nemá (odscrolloval daleko), uvidí
  animaci u spodního okraje a scéna se mu zatmí taky.
- **`prefers-reduced-motion`:** přechody se vypnou (`.no-motion`), animace se
  jen zobrazí bez prolnutí.

---

## 2. Architektura a datový tok

```
[mod klikne 💩 u zprávy]
        │  web: POST /reactions  (Bearer web session)
        │  addon: POST /reactions (Bearer, token z chrome.identity flow)
        ▼
[backend routes/reactions.ts]
        │  1) ověří oprávnění (mod/broadcaster)
        │  2) zámek per kanál (běží už něco? → 409 busy)
        │  3) zapíše do paměti `active` + broadcast SSE
        ▼
[SSE `reaction` na GET /nicknames/stream]  ← posloucháVŠE, co je připojené
        │
        ├── web:   Nicknames.onReaction → WebChat.playReaction()
        └── addon: NicknameManager.onReaction → UnityChat._playReaction()
                    │
                    ▼
        [core/reaction.js → playPoopReaction()]   ← veškeré vykreslení a časování
```

**Soubory:**

| Soubor | Role |
|---|---|
| `extension/core/reaction.js` | **Jádro.** Konstanty, normalizace eventu, výpočet pozice/velikosti, vykreslení overlaye, časování hnědé, úklid. Sdílené mezi addonem a webem (žádné `chrome.*`, žádné importy z addonu). |
| `extension/core-bridge.js` | Vystaví modul do `window.UC_CORE` (addon nemá build krok). |
| `extension/sidepanel.css` | CSS reakce (overlay, reflektor, video, hnědá, viditelnost tlačítka). Web ho importuje 1:1 přes `@ext/sidepanel.css`. |
| `extension/sidepanel.js` | Addon: tlačítko v hover akcích, `_playReaction`, `_triggerPoop`, `_updatePoopButtons`, přihlášení k backendu. |
| `backend/src/routes/reactions.ts` | `POST /reactions`, `GET /reactions/active`, ověření role, zámek, SSE broadcast. |
| `backend/src/sse/bus.ts` | Stávající SSE sběrnice (`/nicknames/stream`) — reakce jede po ní, nic nového se nezakládá. |
| `web/src/render.js` | Tlačítko v HTML hover akcí. |
| `web/src/chat.js` | `playReaction()`, `reactionBusy()`, `onPoop`. |
| `web/src/nicknames.js` | Odběr SSE události `reaction`. |
| `web/src/main.js` | Propojení: role → `body.uc-can-poop`, klik → `triggerReaction()`, načtení běžící reakce při startu. |
| `web/src/auth.js` | `triggerReaction()` (POST /reactions). |
| `web/public/media/<video>.webm` | Video. Addon si ho bere ze stejné URL (`robdiesalot.com/chat/media/…`). |

---

## 3. Pozicování a velikost (nejdůležitější část)

### 3.1 Kotva

Animace se **nezarovnává na spodek zprávy** (to byl první pokus a bylo to
špatně), ale na **střed prvního řádku**:

```js
const nameEl = targetEl.querySelector('.un') || targetEl.querySelector('.ts');
const anchor = nameEl.top + nameEl.height / 2;   // střed řádku se jménem
```

Důvod: u víceřádkové zprávy má animace sedět na řádku se jménem. `.un`
(jméno) je vždy na prvním řádku, takže je to spolehlivá kotva.

### 3.2 Vzorec

```js
lineH   = lineHeightOf(targetEl)                       // computed line-height, fallback fontSize×1.5, jinak 21
wide    = clamp((hostWidth - narrowPx) / (widePx - narrowPx), 0, 1)
maxH    = lineH * (minHeightLines + (maxHeightLines - minHeightLines) * wide)
w       = min(hostWidth, maxH * aspect)                // šířka videa
h       = w / aspect                                   // výška videa
grow    = max(0, h - lineH * minHeightLines) * growOffsetRatio
landing = anchor - hostTop + lineH * offsetLines + grow   // kam má „dopadat" obsah
video.top  = landing - h * poopRatio
video.left = max(0, (hostWidth - w) / 2)               // vycentrování v širokém okně
```

### 3.3 Konstanty a co znamenají

| Konstanta | Hodnota | Význam |
|---|---|---|
| `aspect` | `5` | Poměr stran videa (1440×288). **U nové animace přepočítat.** |
| `poopRatio` | `0.88` | **Kde uvnitř videa je „dopadová linie"** (podíl výšky). Změřeno z alfa kanálu: Peepo chodí v 95,5 %, hromádky se usazují kolem 88 %. Tenhle bod se položí na `landing`. |
| `offsetLines` | `1.7` | Ruční doladění v řádcích (níž = větší číslo). Vzniklo ze dvou kol zpětné vazby. |
| `growOffsetRatio` | `0.45` | Když je video větší než základní velikost, posune se navíc dolů o tenhle podíl přírůstku výšky. Bez toho velké video lezlo nahoru přes chat. |
| `minHeightLines` | `5.5` | Strop výšky videa v řádcích pro **úzké** okno. |
| `maxHeightLines` | `8` | Strop výšky pro **široké** okno. |
| `narrowPx` / `widePx` | `550` / `850` | Mezi těmito šířkami chatu se strop lineárně interpoluje. |

**Proč velikost podle řádku a ne podle šířky:** kdyby se video roztáhlo přes
celou šířku vždy, na monitoru 1440 px by byla postavička obří vůči textu
(reálně se to stalo). Vazba na `line-height` drží poměr postavičky k písmu
stejný v panelu, na webu i v OBS s vlastní velikostí písma (`?font=`).

### 3.4 Průběžný přepočet

`layout()` se volá znovu při **scrollu chatu** (`scroll` listener) a při
**změně velikosti** (`ResizeObserver` na hostu), takže animace zůstane
u své zprávy, i když se během ní scrolluje nebo se změní okno.

### 3.5 Když cíl chybí

Není-li `targetEl` (zpráva už není v DOM), video jde ke spodnímu okraji a
reflektor míří na spodní dva řádky. **Scéna se zatmí i tak** — dřív se
nezatmívala a vypadalo to jako chyba.

---

## 4. Vizuální vrstvy a CSS

```
#chat-wrapper (host, position: relative, overflow: hidden)
└── .uc-poop-overlay            opacity 0 → 1 (transition 1,2 s), z-index 40, pointer-events: none
    ├── .uc-poop-spot           tmavá plocha přes celý chat s VYKROJENÝM světlem
    └── video.uc-poop-video     absolutně pozicované, object-fit: contain, drop-shadow
```

**Reflektor** není ostrý obdélník (první verze používala `box-shadow` a
uživatel to odmítl), ale **maska s radiálním gradientem**:

```css
.uc-poop-spot {
  position: absolute; inset: 0; background: rgba(0,0,0,0.82);
  --spot-y: 50%; --spot-h: 60px;
  mask-image: radial-gradient(ellipse 62% calc(var(--spot-h) * 2.6) at 50% var(--spot-y),
    rgba(0,0,0,0) 0%, rgba(0,0,0,0.12) 22%, rgba(0,0,0,0.55) 48%, rgba(0,0,0,0.88) 72%, #000 100%);
}
```

`--spot-y` (střed cílové zprávy) a `--spot-h` (výška zprávy + 26 px) nastavuje
JS v `layout()`. Musí být i `-webkit-mask-image`.

**Hnědnutí** (jen cílová zpráva):

```css
.msg.uc-poop-brown .un { color: #6b4423 !important; }               /* jméno tmavě */
.msg.uc-poop-brown .tx,
.msg.uc-poop-brown .tx a { color: #b5835a !important; }             /* text světleji, ať je čitelný */
.msg.uc-poop-brown .pi { filter: grayscale(1) sepia(1) saturate(4) hue-rotate(-12deg) brightness(0.55); }
.msg.uc-poop-fade .un,
.msg.uc-poop-fade .tx,
.msg.uc-poop-fade .tx a { transition: color 15s linear; }           /* návrat zpět */
.msg.uc-poop-fade .pi { transition: filter 15s linear; }
```

Emoty (`<img>`) barva neovlivní — zůstávají barevné záměrně.

Pořadí v JS: `add('uc-poop-brown')` → po 15 s `add('uc-poop-fade')` +
`remove('uc-poop-brown')` (spustí přechod zpět) → po dalších 15 s `remove` obojí.

---

## 5. Tlačítko, oprávnění, zámek

### 5.1 Viditelnost tlačítka

Tlačítko je v hover akcích zprávy **úplně vlevo** (`data-act="poop"`), řízené
**třídami na `<body>`**, ne podmíněným vykreslením:

```css
.msg-action-btn[data-act="poop"] { display: none; }
body.uc-can-poop:not(.uc-poop-busy) .msg-action-btn[data-act="poop"] { display: flex; }
```

- `uc-can-poop` — moje role je `moderator` nebo `broadcaster` (web: `myRole()`
  z badge vlastních zpráv, addon: `_myChatRole()`).
- `uc-poop-busy` — právě běží reakce. Nastavuje se ze SSE, takže **zmizí všem**
  modům, ne jen tomu, kdo klikl.
- Obojí se přepočítává i periodicky (`setInterval` 5 s), protože role se pozná
  teprve z badge, které dorazí až s vlastní zprávou.

### 5.2 Oprávnění na serveru

`POST /reactions` vyžaduje web session (Bearer). Server projde identity účtu a
uzná první, která je v kanálu mod nebo broadcaster:

- login **se rovná názvu kanálu** → broadcaster, nebo
- v **serverovém logu zpráv za posledních 24 h** má badge `moderator`/`broadcaster`
  (`rolesFromBadges` ze `sse/integrationStream.ts`).

Jinak `403 not_mod`. Známé omezení: mod, který 24 h nenapsal, neprojde; kdyby
vadilo, doplnit dotaz na Twitch API (`/moderation/moderators`).

### 5.3 Zámek

V paměti serveru `active: Map<channel, ReactionEvent>`, platnost
`durationMs + 1,5 s`. Druhý pokus během přehrávání → `409 busy`.
Klient navíc ignoruje klik, když `reactionBusy()`.

---

## 6. Pasti, na které se přišlo (nepřepisovat bez důvodu)

1. **`requestAnimationFrame` se ve skrytém tabu nespustí.** OBS na pozadí i
   MCP okno = `visibilityState: hidden` → overlay by zůstal s `opacity: 0`.
   Proto `setTimeout(…, 20)`, ne rAF.
2. **`<video>` vytvořené v JS se nemusí samo načíst** → vždy `video.load()`
   (stejná past jako u announcementů).
3. **Addon recykluje element zprávy.** Po IRC echu se u optimistické zprávy jen
   přepíše `data-msg-id`; element se nevykresluje znovu. Proto se tlačítko
   **vykresluje vždy** a skutečné id se čte **až při kliknutí** z
   `closest('.msg').dataset.msgId`. (Web naopak optimistickou zprávu smaže a
   vykreslí echo jako novou — tam by podmíněné vykreslení fungovalo.)
4. **Zpráva může být v „parku"** (web drží jen okno ~500 uzlů).
   `scrollToMessage()` ji umí vrátit zpět; volej ho s `{ flash: false }`,
   zvýraznění cíle si uživatel výslovně nepřál.
5. **Kurzor SSE po restartu serveru.** (Týká se integračního streamu, ale
   princip platí: klient po reconnectu posílá `Last-Event-ID` z minulého běhu.)
6. **MCP okno neumí ověřit vizuál** — transitions neběží a video se nenačte.
   Vizuál se tam dá zkontrolovat jen vynuceným `classList.add('on')` a
   `style.opacity = 1`; pozici a rozměry lze měřit normálně.
7. **Cache videa.** `.htaccess` ve `web/public` musí mít `webm` v pravidle pro
   dlouhou cache, jinak se 2 MB video tahá pořád dokola.

---

## 7. Postup pro PŘIDÁNÍ NOVÉ ANIMACE

### Krok 1 — změřit video

Video je VP9 s alfou; `alphaextract` **selže**, když se nevynutí dekodér:

```bash
# alfa kanál jednoho snímku do PNG
ffmpeg -v error -y -c:v libvpx-vp9 -ss 7.2 -i anim.webm -frames:v 1 -vf alphaextract a_7.2.png
# rozměry, délka, poměr
ffprobe -v error -show_entries format=duration:stream=width,height,r_frame_rate -of default=nw=1 anim.webm
```

Z PNG spočítat (skript v `scratchpad`, viz historie session):
- **bounding box** neprůhledných pixelů po snímcích → kde je „země",
- **vážené těžiště / kvantily** hmoty v pásech mimo hlavní postavu → kde je
  „dopadová linie".

Výsledek = `aspect` (šířka/výška) a `poopRatio` (podíl výšky, který se klade na
kotvu). U `poop` vyšlo: země 95,5 %, hromádky ~88 % → `poopRatio: 0.88`.

### Krok 2 — video na server

`web/public/media/<jmeno>.webm`, nasadit `npm run deploy`. Addon i web si ho
berou z `https://robdiesalot.com/chat/media/<jmeno>.webm` (addon přes
`<video src>`, ne `fetch` — nepotřebuje host permission).

### Krok 3 — core

V `extension/core/reaction.js` přidat konstanty a přehrávač. **Dnes je modul
psaný pro jednu animaci** (`POOP`, `playPoopReaction`). Pro druhou animaci:

- buď přidat druhý exportovaný objekt konstant + tenkou obálku, která volá
  stejnou vykreslovací funkci s jiným configem,
- nebo (čistší) udělat `REACTIONS = { poop: {...}, nova: {...} }` a
  `playReaction(kind, opts)`, který si config vybere podle `kind`.
  Pak stačí v klientech předat `ev.kind`.

Pravidlo: **vykreslovací logika zůstane jedna**, liší se jen konstanty,
URL videa a případně efekt na zprávě.

### Krok 4 — backend

`backend/src/routes/reactions.ts`: rozšířit `Body.kind` o novou hodnotu
(dnes `z.literal('poop')`) a případně nastavit jinou `durationMs`. Zámek,
oprávnění ani SSE se nemění.

### Krok 5 — klienti

- **Web:** tlačítko v `render.js` (`data-act="<kind>"`), obsluha v `chat.js`,
  napojení v `main.js` (role → body třída, klik → `triggerReaction({ kind })`).
- **Addon:** tlačítko v builderu zprávy v `sidepanel.js`, `_triggerPoop`
  zobecnit na `_triggerReaction(kind, platform, messageId)`.
- CSS do `extension/sidepanel.css` (web ho dědí).

### Krok 6 — verze a nasazení

1. `extension/manifest.json` — bump patch verze.
2. Commit + push `dev` v `UnityChat` (backend se nasadí sám z `dev`).
3. V `UnityChat-web`: `git fetch upstream dev && git merge upstream/dev`,
   pak `cd web && npm run deploy`, pak push `main`.
   **Konflikty ve `extension/**` vždy řešit `git checkout upstream/dev -- <soubor>`**
   — sdílený kód se mění jen v `UnityChat`.
4. Uživateli říct, ať **reloadne rozšíření** (web je hned).

### Krok 7 — ověření (bez spamu do chatu)

```js
// v konzoli klienta: simulace eventu bez volání backendu
uc.chat.playReaction({
  id: 'test-' + Date.now(), kind: 'poop', channel: 'robdiesalot',
  target: { platform: 'twitch', messageId: '<id zprávy z DOM>' },
  by: { login: 'test' }, startedAt: new Date().toISOString(), durationMs: 15000,
}, { videoUrl: 'https://robdiesalot.com/chat/media/anim.webm', channel: 'robdiesalot', onBusy: () => {} });
```

Kontrolní body: `landing` sedí na střed `.un`, `overlay.classList` má `on`,
`body.uc-poop-busy` je nastavené, tlačítko `display: none`, po skončení se
overlay odstraní a třídy zmizí.

Reálný průchod pak přes `POST /reactions` (vrátí `202` + event, druhý pokus `409`).
Testovat na vlastním kanálu (`?debug=1&channel=<vlastní>`), ne na Robově, dokud
to není hotové.

---

## 8. Kontrakt události (SSE `reaction`)

```json
{
  "id": "m1a2b3-x9y8",
  "kind": "poop",
  "channel": "robdiesalot",
  "target": { "platform": "twitch", "messageId": "9d218e76-…", "username": "Jouki728" },
  "by": { "platform": "twitch", "login": "jouki728" },
  "startedAt": "2026-09-22T20:04:10.205Z",
  "durationMs": 15000
}
```

- `id` — dedup na klientovi (`_reactionSeen`), ať se reakce nepřehraje dvakrát.
- `startedAt` — klient z něj spočítá `offsetMs` a **doskočí do videa**, když
  se připojil později. Když `offsetMs > durationMs`, reakce se **nepřehraje**.
- `GET /reactions/active?channel=` vrací tentýž objekt nebo `null` (pro klienty,
  kteří se právě načetli).

---

## 9. Ladicí smyčka se zadavatelem (osvědčený postup)

Vizuální detaily se neladí odhadem. U `poop` to trvalo pět kol a fungovalo tohle:

1. Nasadit, nechat si poslat **screenshot s vyznačením** (uživatel kreslí
   obdélníky „z tohohle na tohle").
2. Z obrázku **změřit poměr** (šířka/výška obdélníků vůči rozestupu řádků),
   ne odhadovat v pixelech — screenshot bývá ve škálovaném DPI.
3. Převést na **jednu konstantu** (řádky, podíl výšky) a znovu nasadit.
4. Po každém kole mít v kódu komentář **proč** ta hodnota vznikla.

Hodnoty, které takhle vznikly: `offsetLines 1 → 1,7`, `maxHeightLines 5,5 → 8`
(jen pro široká okna), `growOffsetRatio 0,45`.
