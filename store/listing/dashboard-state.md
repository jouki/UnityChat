# Chrome Web Store — stav dashboardu (kanonický záznam)

> **Tohle je jediný zdroj pravdy o tom, co je v Developer Dashboardu položky
> UnityChat zadané.** Dashboard nejde číst přes API ani přes Claude in Chrome
> (`chrome.google.com/webstore/devconsole` je „extensions gallery", skriptování
> i screenshoty jsou blokované), takže každá změna v dashboardu se musí
> zapsat sem ručně. Pravidlo: **změníš pole v dashboardu → změníš ho tady, ve
> stejném commitu.** Reviewer porovnává tahle prohlášení s privacy policy
> (`jouki.cz/UnityChat/privacy`) a s chováním balíčku — rozpor = odmítnutí.

Snapshot: **2026-09-19**, po odeslání v3.39.3 ke kontrole (PR #21). Hodnoty
ověřené ze screenshotů dashboardu od usera + z textů, které do něj vložil.

## Identita položky

| | |
|---|---|
| Item ID | `picaeipbmkgcippknkpkbnbgjlkblbnp` |
| Publisher ID | `d58dce79-af81-41eb-91a9-4df9337c3727` |
| Veřejná URL | https://chromewebstore.google.com/detail/unitychat/picaeipbmkgcippknkpkbnbgjlkblbnp |
| Dashboard | https://chrome.google.com/webstore/devconsole/d58dce79-af81-41eb-91a9-4df9337c3727/picaeipbmkgcippknkpkbnbgjlkblbnp/edit |
| Publikovaná verze | 3.40.24 |
| Ve frontě na review | 3.41.0 (PR #29, 25. 9. 2026; znovu odesláno ručně po zrušení kvůli „Finanční a platební údaje") |
| Viditelnost / distribuce | Veřejné, všechny regiony, zdarma |
| Jazyk záznamu | čeština (jediný; anglický text v `description-en.md` je jen rezerva) |
| Kategorie | Social & Communication (Komunikace) |
| Support e-mail (publisher) | `m.joukal+unitychat@gmail.com` (ověřený) |
| Oficiální adresa URL | `jouki.cz` (doména ověřená v Search Console; podstránku dropdown nedovolí → nginx Referer redirect z rootu na `/UnityChat`) |
| Service account (CI) | `cws-release@unitychat-493319.iam.gserviceaccount.com`, klíč v GitHub secrets `CWS_SERVICE_ACCOUNT` + Bitwarden „UnityChat — CWS service account" |

## Karta „Balíček"

Nahrává CI (`scripts/build-store.ps1` → `scripts/cws.mjs release`) při pushi do
`master`, který mění `extension/manifest.json`. Manifest = `extension/` beze
změn (od v3.38.67 žádné stripování). Oprávnění v manifestu:
`sidePanel, storage, tabs, scripting, cookies, downloads` + 19 host permissions.

## Karta „Záznam v obchodě"
**Název**
```
UnityChat
```

**Krátký popis** (105 znaků, limit 132)
```
Twitch, YouTube a Kick chat v jednom panelu. Čti všechny tři najednou a odpovídej, aniž bys přepínal tab.
```

**Popis** (2501 znaků, limit 16 000)
```
UnityChat spojí live chat z Twitche, YouTube a Kicku do jednoho panelu vedle streamu. Místo tří tabů máš jeden seznam zpráv — a odpovědět můžeš do kteréhokoli z nich, aniž bys od streamu odešel.

━━━ CO TO UMÍ ━━━

• Sjednocený chat — zprávy ze všech tří platforem v jednom sloupci, každá s barevným odznakem své platformy
• Odesílání a odpovídání — píšeš přímo z panelu, zpráva odejde přes účet, kterým jsi na dané platformě přihlášený
• Emoty odevšad — 7TV, BetterTTV, FrankerFaceZ, nativní Twitch a Kick emoty včetně zero-width stackování
• Odznaky — subscriber, moderátor, VIP a další se zobrazují stejně jako v nativním chatu
• Našeptávač — Tab doplní emote nebo @jméno, funguje i pro příkazy StreamElements bota
• Zvýraznění zmínek — když někdo napíše tvoje jméno, zpráva se označí a nepřehlédneš ji
• Připnuté zprávy — banner nad chatem ukáže, co streamer připnul
• Raidy a první zprávy — nové chattery a příchozí raidy panel odliší
• Přezdívky — komukoli můžeš nastavit vlastní jméno a barvu, které se drží napříč platformami
• Historie chatu — po otevření panelu se načte, co v chatu proběhlo, i když jsi ho měl zavřený
• Tři velikosti rozhraní a tmavý vzhled, který nebije do očí vedle streamu

━━━ JAK TO FUNGUJE ━━━

UnityChat je dělaný pro konkrétní komunitu: otevři stream RobDiesALota na Twitchi, YouTube nebo Kicku, klikni na ikonu UnityChat a panel se připojí ke všem třem chatům najednou. Podporovaní jsou zatím tři streameři — RobDiesALot, TenSterakdary a ArcadeBulls; když máš otevřený stream jiného z nich, panel ti nabídne přepnutí jedním tlačítkem. Na ostatních kanálech zůstává u RobDiesALota. Nic nenastavuješ.

Zprávy odcházejí přes přihlášení, které už v prohlížeči máš — UnityChat od tebe nechce žádné heslo ani vlastní účet.

━━━ SOUKROMÍ ━━━

Historii chatu načítá panel ze serveru UnityChatu, který veřejné zprávy z chatů podporovaných streamerů (Twitch, YouTube, Kick) archivuje — ukládá se text zprávy, jméno autora, čas a odznaky či emoty potřebné k zobrazení, bez časového omezení; smazání na žádost. Ze samotného rozšíření jde na server jen jméno, kterým jsi na platformě přihlášený, sledovaný kanál a přezdívky, které sám nastavíš. Podrobnosti: https://jouki.cz/UnityChat/privacy

━━━ POZNÁMKY ━━━

• YouTube chat se čte přes veřejné rozhraní streamu — stream musí běžet živě, u záznamů a premiér chat nenačte
• Připínání zpráv funguje na Twitchi
• UnityChat je nezávislý projekt, není nijak spojený s Twitchem, YouTube ani Kickem

Nápady a chyby: https://jouki.cz
```

**Assety:** ikona 128×128, screenshot 1280×800, promo 440×280 a 1400×560 —
generuje `scripts/build-promo.ps1`, checklist v `assets-checklist.md`.

## Karta „Ochrana soukromí"

### Popis jednoho účelu (438 znaků)
```
UnityChat merges the live chat of a stream that is running on Twitch, YouTube
and Kick into one side panel, so a viewer can read all three chats in a single
list and send a message to any of them without switching tabs.

Every feature serves that one purpose: reading the chats, rendering their
emotes and badges, and sending or replying to messages on the user's behalf
using the session they are already logged in with on each platform.
```

### Vysvětlení oprávnění

**sidePanel** (282 znaků)
```
The entire user interface is a side panel: sidepanel.html renders the merged chat, its settings and the message input. The toolbar action opens that panel, and a button inside it can open the same page in a separate browser window for users who want it next to a full-screen stream.
```

**storage** (380 znaků)
```
Stores the user's settings (which channels to follow, which platforms are
enabled, layout size, display name colour) in chrome.storage.sync, plus small
local bookkeeping in chrome.storage.local (which usernames were already
reported to our API). Chat history is not cached in the browser - it is loaded
from our server on demand. Nothing in either store leaves the user's browser.
```

**tabs** (271 znaků)
```
The panel needs to know which stream the user is currently watching. We read
the URL of the open tabs to find the Twitch, YouTube or Kick channel page,
auto-select that channel, and target the correct tab when sending a message.
We do not read tab URLs of any other site.
```

**scripting** (514 znaků)
```
Chat messages are sent through the page the user is already logged in on. We
inject our content scripts into the Twitch, YouTube and Kick tab to type the
message into the site's own chat box, and use chrome.scripting.executeScript
in the MAIN world where the page's own API is the only way to post a message
with the user's existing session (YouTube and Kick block this from an isolated
world through their CSP). The injected functions are part of the extension
package; no remote code is ever fetched or executed.
```

**cookies** (517 znaků)
```
To send a chat message on Twitch on the user's behalf, we need the auth-token
cookie that their browser already holds for twitch.tv. The cookie is HttpOnly,
so page JavaScript cannot read it and chrome.cookies is the only way to obtain
it. It is used solely as the Authorization header on requests to Twitch's own
API endpoint (gql.twitch.tv) for sending a message, replying to a message and
pinning a message. The token is never stored by the extension, never logged,
and never sent anywhere except to Twitch itself.
```

**downloads** (224 znaků)
```
The panel has a "save debug log" button. When the user clicks it, the
extension writes its in-memory diagnostic log to the Downloads folder so the
user can attach it to a bug report. Nothing is downloaded without that click.
```

**Oprávnění pro hostitele** (982 znaků, limit 1 000)
```
twitch.tv, youtube.com, kick.com (and their API hosts api.twitch.tv, gql.twitch.tv): the three chat platforms the extension merges. Needed to read the live chat and to send messages using the user's own session.

wss://irc-ws.chat.twitch.tv: Twitch's public IRC gateway, how the extension reads Twitch chat in real time.

7tv.io, cdn.7tv.app, api.betterttv.net, cdn.betterttv.net, api.frankerfacez.com, cdn.frankerfacez.com, static-cdn.jtvnw.net, files.kick.com: emote providers. Chat is unreadable without them - these hosts supply the emote definitions and images that the messages reference.

api.ivr.fi: public API for Twitch badge images (subscriber, mod, VIP) shown next to usernames. badges.twitch.tv: Twitch's own endpoint, fallback for the same images.

api.jouki.cz: the extension's own backend. It stores cross-platform nicknames, the channels the extension is used on, and serves the chat history archive the panel loads on open. See the privacy policy for what is sent.
```

### Vzdálený kód
Zaškrtnuto: **Ne, oprávnění vzdálený kód nepoužívám.** (pole Zdůvodnění prázdné —
je jen pro variantu „Ano"). Interní podklad:
```
No. The extension does not execute remote code. All JavaScript is contained in
the uploaded package. chrome.scripting.executeScript only injects functions
and files that ship inside the extension.
```

### Využití dat — „Jaká data plánujete teď nebo v budoucnu shromažďovat od uživatelů?"

| Checkbox | Stav | Proč |
|---|---|---|
| Údaje umožňující zjištění totožnosti | ☑ ANO | username uživatele na platformě jde na backend (`/users/seen`), jména cizích uživatelů u přezdívek (`/nicknames`), od 2026-09-25 e-mail zadaný uživatelem (QR dono → Židolišta) |
| Zdravotní informace | ☐ NE | — |
| Finanční a platební údaje | ☑ ANO (od 2026-09-25) | QR dono: částka, měna a zpráva daru jdou přes backend Židolišti |
| Ověřovací informace | ☑ ANO | čtení Twitch `auth-token` cookie (`cookies` permission); neopouští Twitch |
| Osobní komunikace | ☑ ANO | archiv chatu: server ukládá veřejné zprávy z chatů podporovaných streamerů, panel je zobrazuje |
| Poloha | ☐ NE | — |
| Webová historie | ☑ ANO | `/streamers/lookup` posílá handle sledovaného kanálu = co uživatel sleduje |
| Aktivita uživatelů | ☐ NE | žádný tracking kliků/myši/kláves |
| Obsah webových stránek | ☑ ANO | rozšíření čte obsah chatu ze stránek platforem |

### „Potvrzuji, že následující informace jsou pravdivé" — všechna tři ☑
1. Neprodávám ani nepředávám údaje o uživatelích třetím stranám, s výjimkou schválených případů.
2. Nepoužívám ani nepředávám údaje o uživatelích pro účely, které nesouvisí s jedním účelem mé položky.
3. Nepoužívám ani nepředávám údaje o uživatelích pro potřeby určení úvěruschopnosti nebo za účelem poskytnutí půjčky.

### URL zásad ochrany soukromí
```
https://jouki.cz/UnityChat/privacy
```
Policy platná od **25. 9. 2026** (CS/EN; ve 3.41.0 doplněny v 1c odpovědi napříč platformami a soundboard, podmínky mají nový bod 4 Dary přes QR a zvukové efekty), popisuje: lokální konfiguraci (1a),
Google OAuth pro streamery (1b), data posílaná na `api.jouki.cz` + **archiv chatu**
kanálů robdiesalot/tensterakdary/arcadebulls bez časového omezení, mazání na žádost
(1c), cookie Twitch `auth-token` a Kick `session_token` (1d), přihlášení diváka
v rozšíření i na webu + psaní přes účet (1e), **e-mail zadaný uživatelem + dary přes
QR kód, předání Židolišti, Brevo/Resend** (1f), účely (2), uložení (3), sdílení (4),
retence (5), GDPR práva (6). Kontakt `m.joukal+unitychat@gmail.com`.
Zdroj: repo `jouki/jouki.cz`, `unitychat/privacy/index.html`.

## Karta „Přístup"

Uživatelské jméno / heslo pro testery: **prázdné** (UnityChat nemá účet).

**Další pokyny** (469 znaků, limit 500)
```
No account needed to read chat; UI is in Czech. UnityChat serves one community: by default it connects to the Twitch/YouTube/Kick chat of channel robdiesalot (also supported: tensterakdary, arcadebulls).

Test: open twitch.tv/robdiesalot, click the UnityChat toolbar icon. The panel loads recent history from our server and, if the stream is live, new messages appear in seconds. On other channels it stays on robdiesalot.

Sending needs you logged in to that platform.
```

## Co se musí přepsat, když se změní…

| Změna v kódu | Pole v dashboardu | + soubor |
|---|---|---|
| nové/odebrané oprávnění v manifestu | Vysvětlení oprávnění (přibude/zmizí pole) | `permissions-justification.md` |
| nový host v `host_permissions` | Oprávnění pro hostitele (limit 1 000!) | `permissions-justification.md` |
| nové volání na `api.jouki.cz` s daty uživatele | Využití dat checkboxy + privacy policy 1c | `privacy-disclosure.md`, jouki.cz repo |
| nový podporovaný streamer | Popis (JAK TO FUNGUJE), Pokyny k testu, privacy 1c (seznam kanálů) | `description-cs.md`, `permissions-justification.md`, jouki.cz repo |
| změna retence archivu | privacy 1c + 5, Popis (SOUKROMÍ) | jouki.cz repo, `description-cs.md` |
| cokoli, co by načítalo kód mimo balíček | Vzdálený kód → Ano + zdůvodnění | `permissions-justification.md` |
