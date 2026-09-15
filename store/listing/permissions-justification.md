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
emotes and badges, and sending or replying to messages on the user's behalf
using the session they are already logged in with on each platform.
```

**Proč takhle:** Single purpose musí být jedna věta, ze které je vidět, že
rozšíření nedělá několik nesouvisejících věcí. Druhý odstavec preventivně
vysvětluje, proč je v balíčku tolik host permissions — všechny slouží té jedné
věci.

---

## Per-permission justifikace

### `sidePanel`

```
The entire user interface is a side panel. The extension has no popup and no
options page; sidepanel.html is where the merged chat is rendered.
```

### `storage`

```
Stores the user's settings (which channels to follow, which platforms are
enabled, layout size, display name colour) in chrome.storage.sync, and the
local chat history cache in chrome.storage.local so reopening the panel does
not lose the conversation. Nothing in either store leaves the user's browser.
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

### Host permissions

```
twitch.tv, youtube.com, kick.com (and their API hosts api.twitch.tv,
gql.twitch.tv): the three chat platforms the extension merges. Needed to read
the live chat and to send messages using the user's own session.

wss://irc-ws.chat.twitch.tv: Twitch's public IRC gateway, which is how the
extension reads Twitch chat in real time.

7tv.io, cdn.7tv.app, api.betterttv.net, cdn.betterttv.net,
api.frankerfacez.com, cdn.frankerfacez.com, static-cdn.jtvnw.net,
files.kick.com: emote providers. Chat is unreadable without them — these hosts
supply the emote definitions and images that the messages reference.

api.ivr.fi: public API used to fetch Twitch badge images (subscriber, mod,
VIP) shown next to usernames.

badges.twitch.tv: Twitch's own badge endpoint, kept as a fallback source for
the same images.

api.jouki.cz: the extension's own backend. It stores the cross-platform
nicknames users assign to each other and the list of channels the extension
has been used on. See the privacy policy for exactly what is sent.
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
