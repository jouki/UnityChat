# Permission justifikace — Privacy practices tab

Do dashboardu se píše anglicky (čtou to reviewery Google). Níže je vždy text
k přímému zkopírování a pod ním česky, proč je to formulované takhle.

Pravidlo, kterým se řídí všechny texty: reviewer chce u každého permission
vidět **konkrétní funkci**, ne obecné „needed for the extension to work".
Vágní justifikace je nejčastější důvod odmítnutí.

---

## Single purpose

```
UnityChat merges the live chat of a stream that is running on Twitch, YouTube
and Kick into one side panel, so a viewer can read all three chats in a single
list and send a message to any of them without switching tabs.

Every feature serves that one purpose: reading the chats, rendering their
emotes and badges, and writing to them on the user's behalf with the account
they sign in with - messages, replies, chat commands such as sound effects,
and an optional donation message for the streamer paid by bank QR code.
```

**Proč takhle:** Single purpose musí být jedna věta, ze které je vidět, že
rozšíření nedělá několik nesouvisejících věcí. Druhý odstavec preventivně
vysvětluje, proč je v balíčku tolik host permissions — všechny slouží té jedné
věci.

---

## Per-permission justifikace

### `sidePanel`

```
The entire user interface is a side panel: sidepanel.html renders the merged chat, its settings and the message input. The toolbar action opens that panel, and a button inside it can open the same page in a separate browser window for users who want it next to a full-screen stream.
```

**Pozor na formulaci:** dřívější verze říkala „the extension has no popup and no
options page". Technicky to platí (`action.default_popup` ani `options_ui`
v manifestu nejsou), ale slovo *popup* je dvojznačné — tlačítko „Otevřít
v samostatném okně" dělá `chrome.windows.create({type:'popup'})`, což je něco
jiného. Justifikace má vysvětlovat, proč oprávnění potřebuješ, ne vyjmenovávat,
co v rozšíření není.

### `storage`

```
Stores the user's settings (which channels to follow, which platforms are
enabled, layout size, display name colour) in chrome.storage.sync, plus small
local bookkeeping in chrome.storage.local (which usernames were already
reported to our API). Chat history is not cached in the browser - it is loaded
from our server on demand. Nothing in either store leaves the user's browser.
```

### `tabs`

```
The panel needs to know which stream the user is currently watching. We read
the URL of the open tabs to find the Twitch, YouTube or Kick channel page,
auto-select that channel, and target the correct tab when sending a message.
We do not read tab URLs of any other site.
```

**Pozor:** tohle je tvrzení, které musí sedět s kódem. `_findStreamTab()`
skutečně skenuje `chrome.tabs.query`, ale filtruje na channel stránky tří
platforem — viz `sidepanel.js`, `_detectPlatformFromUrl`.

### `scripting`

```
Chat messages are sent through the page the user is already logged in on. We
inject our content scripts into the Twitch, YouTube and Kick tab to type the
message into the site's own chat box, and use chrome.scripting.executeScript
in the MAIN world where the page's own API is the only way to post a message
with the user's existing session (YouTube and Kick block this from an isolated
world through their CSP). The injected functions are part of the extension
package; no remote code is ever fetched or executed.
```

**Proč tolik textu:** `world: 'MAIN'` je pro reviewery červený praporek,
protože se často zneužívá k načítání vzdáleného kódu. Věta „no remote code is
ever fetched" tam musí být explicitně a musí být pravdivá — je (ověřeno, v
balíčku není `eval`, `new Function` ani načítání externích skriptů).

### `cookies`

```
To send a chat message on Twitch on the user's behalf, we need the auth-token
cookie that their browser already holds for twitch.tv. The cookie is HttpOnly,
so page JavaScript cannot read it and chrome.cookies is the only way to obtain
it. It is used solely as the Authorization header on requests to Twitch's own
API endpoint (gql.twitch.tv) for sending a message, replying to a message and
pinning a message. The token is never stored by the extension, never logged,
and never sent anywhere except to Twitch itself.
```

**Tohle je nejcitlivější bod celého review.** Text musí říct čtyři věci:
proč to jde jen přes `chrome.cookies` (HttpOnly), ke kterému jedinému hostu
token jde, že se neukládá a že se nikam jinam neposílá.

### `downloads`

```
The panel has a "save debug log" button. When the user clicks it, the
extension writes its in-memory diagnostic log to the Downloads folder so the
user can attach it to a bug report. Nothing is downloaded without that click.
```

### `identity`   ⚠️ NOVÉ ve v3.39.50 — bez vyplnění dashboard odmítne odeslat verzi ke kontrole

```
The extension lets the user sign in with their own Twitch, YouTube or Kick account so it can act on their behalf: send chat messages from the panel, and use features that the server must authorize, such as moderator-only chat reactions that every UnityChat user sees at once. chrome.identity.launchWebAuthFlow opens the platform's normal OAuth page in a browser window, so the password is typed on the platform's own site and the extension never sees it. Only the resulting session token for our own backend (api.jouki.cz) is stored locally on the user's machine; it is used to prove who the user is and can be removed by signing out. The flow starts only when the user clicks sign in or an action that needs it. We do not request the user's email address or any Google account data.
```

**Proč obecně:** text schválně nemluví jen o reakcích — `identity` použijeme i na
přihlášení pro **psaní zpráv z addonu** (port webového loginu). Kdyby zdůvodnění
mluvilo jen o reakcích, museli bychom ho při rozšíření měnit a znovu čekat na review.
`launchWebAuthFlow` jen otevře OAuth okno platformy; `identity.email` ani Google účet
nežádáme.

### `notifications`   ⚠️ NOVÉ ve v3.44.5 — před releasem vyplnit v dashboardu (jinak `:publish` → `INVALID_ITEM_METADATA`)

```
Optional and off by default. When the user turns on "Notify on mentions" in the panel settings, the extension shows a local notification when someone in the chat @mentions the user or replies directly to the user's message while the panel is in the background (hidden or not focused). The notification contains only the author's name, the message text and the platform and channel, all taken from the chat already displayed in the panel. Clicking it focuses the browser window with the panel. Notifications are created locally with chrome.notifications; nothing is sent to our server or to any third party, and no notification is shown for other messages or while the user is looking at the chat.
```

**Proč:** opt-in volba „Upozornit na zmínky (oznámení prohlížeče)" (výchozí vypnuto).
Oznámení vytváří panel lokálně (`core/mention-notify.js` + `chrome.notifications.create`),
jen na @zmínku / odpověď na moji zprávu, když panel není vidět nebo nemá fokus.
Žádná data nikam neodcházejí → data-use disclosure se nemění. (696 znaků)

### Host permissions

⚠️ **Každé pole má limit 1 000 znaků.** Tahle verze (3.41.0, 2026-09-25) má 829 znaků —
api.jouki.cz nově zmiňuje přihlášení, psaní účtem, zvukové efekty a dary přes QR.

```
twitch.tv, youtube.com, kick.com (+ api.twitch.tv, gql.twitch.tv): the three chat platforms the extension merges - reading the live chat and sending messages.

wss://irc-ws.chat.twitch.tv: Twitch's public IRC gateway for reading Twitch chat in real time.

7tv.io, cdn.7tv.app, api.betterttv.net, cdn.betterttv.net, api.frankerfacez.com, cdn.frankerfacez.com, static-cdn.jtvnw.net, files.kick.com: emote providers - the emote definitions and images that chat messages reference.

api.ivr.fi, badges.twitch.tv: Twitch badge images (subscriber, mod, VIP) shown next to usernames.

api.jouki.cz: the extension's own backend - signing in and sending messages with the user's own account, shared nicknames, the chat history archive, chat sound effects and an optional donation via bank QR code. See the privacy policy for what is sent.
```

**Proč seskupené:** dashboard má jedno pole na všechny host permissions.
Seskupení podle účelu (platformy / emotes / badges / vlastní backend) čte se
líp než 19 řádků.

---

## Remote code

```
No. The extension does not execute remote code. All JavaScript is contained in
the uploaded package. chrome.scripting.executeScript only injects functions
and files that ship inside the extension.
```

**Ověřeno:** v balíčku není `eval()`, `new Function()`, `importScripts()` ani
dynamické načítání `<script src>`. Build skript nic z toho nekontroluje
automaticky — pokud by někdy takový kód přibyl, tahle odpověď přestane platit
a musí se změnit.


---

## Pokyny k testu (Přístup → Pokyny k testu)

⚠️ **Limit tohoto pole je 500 znaků**, ne 1 000 jako u ostatních.

Uživatelské jméno a heslo nechat **prázdné** — UnityChat vlastní účet nemá.
Do „Další pokyny" jde tohle (469 znaků):

```
No account needed to read chat; UI is in Czech. UnityChat serves one community: by default it connects to the Twitch/YouTube/Kick chat of channel robdiesalot (also supported: tensterakdary, arcadebulls).

Test: open twitch.tv/robdiesalot, click the UnityChat toolbar icon. The panel loads recent history from our server and, if the stream is live, new messages appear in seconds. On other channels it stays on robdiesalot.

Sending needs you logged in to that platform.
```

**Proč to tam patří:** reviewer, který otevře náhodný kanál, by viděl chat
robdiesalota a vyhodnotil to jako chybu — od v3.38.81 se přepíná jen mezi
podporovanými streamery. Navíc je UI česky. Historie ze serveru znamená, že
panel není prázdný ani mimo živý stream.
