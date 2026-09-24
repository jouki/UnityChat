# Firefox — addons.mozilla.org (AMO), podklady pro formulář

Build: `node scripts/build-firefox.mjs` → `store/build/firefox/unitychat-firefox-vX.Y.Z.xpi`
(jeden kód s Chrome, jiný manifest: sidebar_action, background.scripts, gecko ID
`unitychat@jouki.cz`, min. Firefox 128, `data_collection_permissions`).
Distribuce: **Na tomto webu** (veřejně na AMO, automatické aktualizace) — rozhodnutí usera 2026-09-23.

## 1. Nahrání souboru

- Soubor: `unitychat-firefox-vX.Y.Z.xpi`.
- **Kompatibilita:** jen **Firefox (desktop)**. Firefox pro Android **nezaškrtávat** —
  doplněk je postavený na postranní liště (`sidebar_action`), kterou Android nemá.

## 2. Zdrojový kód

Otázka „Potřebujete odeslat zdrojový kód?" → **Ne.** Kód v balíčku je přesně to, co
je v repu (`extension/`): žádný bundler, minifikace ani transpilace (i `core/` jsou
čisté ES moduly). Veřejné repo: https://github.com/jouki/UnityChat

## 3. Popis (listing)

- **Název:** `UnityChat`
- **Adresa (slug):** `unitychat`
- **Shrnutí** (max 250 znaků, CS):
  `Twitch, YouTube a Kick chat v jednom panelu. Čti všechny tři najednou a odpovídej, aniž bys přepínal tab.`
- **Popis:** převzít „Detailní popis" z `description-cs.md` (EN verze v `description-en.md`
  pro anglickou lokalizaci).
- **Kategorie:** Social & Communication
- **E-mail podpory:** `m.joukal+unitychat@gmail.com`
- **Web podpory / domovská stránka:** `https://jouki.cz/UnityChat`
- **Licence:** rozhodnutí usera (výchozí „All Rights Reserved").
- **Zásady ochrany osobních údajů:** `https://jouki.cz/UnityChat/privacy`
  (AMO chce text nebo odkaz; policy popisuje stejný sběr dat jako manifest).
- **Obrázky:** ikona `extension/icons/icon128.png`; snímky obrazovky ze
  `store/listing/assets/` (Chrome screenshot 1280×800 lze použít, ideálně nový
  z Firefoxu s postranní lištou).

## 4. Poznámky pro recenzenta (EN, zkopírovat)

```
UnityChat merges the live chats of Twitch, YouTube and Kick into one sidebar next
to the stream. The code is not minified, bundled or transpiled — it is the same
source as https://github.com/jouki/UnityChat (folder extension/, built for Firefox
by scripts/build-firefox.mjs, which only rewrites the manifest).

How to test:
1. Open a live channel, e.g. https://www.twitch.tv/robdiesalot (or any live
   Twitch/Kick/YouTube stream) and click the UnityChat toolbar button — the
   sidebar opens and shows the chat of all three platforms.
2. Reading chat needs no login. Sending a message requires being logged in on
   the platform in this browser (the message is sent as that account).

Why the permissions are needed:
- cookies: reads the Twitch "auth-token" and Kick "session_token" cookies only to
  authenticate requests to Twitch's and Kick's own APIs when the user sends,
  replies to or pins a message. They are never stored and never sent anywhere
  other than Twitch/Kick.
- scripting (world: MAIN): sends messages and reads the logged-in username via
  the platform's own page APIs (YouTube, Kick), because those require the page's
  session and cannot be called from the extension context.
- tabs: finds the open stream tab to send messages through it.
- storage: settings and small caches. downloads: user-initiated debug log export.
- identity: optional sign-in to our backend (moderator features).
- Host permissions: the three platforms, emote/badge providers (7TV, BTTV, FFZ,
  IVR) and our backend api.jouki.cz (chat history, shared nicknames).

innerHTML: chat messages are rendered from segments built by our renderer —
all text passes through escaping (EmoteManager._eh / core/html.js escapeHtml)
before insertion; emote/badge URLs come from fixed CDN templates.

Data collection is declared in the manifest (data_collection_permissions) and
described at https://jouki.cz/UnityChat/privacy.
```

## 5. Po schválení

- Stránka doplňku: `https://addons.mozilla.org/firefox/addon/unitychat/` → přidat odkaz
  na jouki.cz/UnityChat vedle Chrome Web Store.
- Další verze: nahrát nové .xpi (Developer Hub → Nahrát novou verzi). Automatizace
  jako `cws-release.yml` (web-ext sign s API klíči AMO v GitHub secrets) — až bude potřeba.
