# Soundboard + Tiery Sound Efektů (SE) — rozhodnutí usera

> 2026-09-24. Zadání od usera (Jouki), otázky sesbírané ze sessions UnityChat
> (`unitychat-8f`, „Browser source URL vytváření") a Židolišta (`robjewsalot-d4`).
> Tento soubor je zdroj pravdy pro rozhodnutí; implementační detaily si každá
> strana doplní ve svém repu.

## Cíl

SE na Robově streamu běží **bez Streamer.botu**. Commandy vyhodnocuje Židolišta.
Chat se čte přes ingest backendu UnityChatu, odpovídá JoukiBOT. Divák v UnityChatu
(addon i web) má soundboard ve stylu Discordu. Klik na zvuk napíše `!se <jméno>`
do chatu.

## Rozhodnutí

### Architektura
- **Level logiku převezme server Židolišty**: total, přechody milestonů a časovače
  odměn. SB je nanejvýš zdroj donatů (QR Dono / Fourthwall), dokud je nenahradíme.
- **Soubory, seznam, tiery a vyhodnocení commandů jsou v Židolišti.** User původně
  chtěl soubory na robdiesalot.com, ale FTP tam pouští jen CZ IP a server Židolišty
  by `!se add` nenahrál. Rozhodnuto: **soubory na Židolišti** (vzor jsou média
  announcementů `/public/media/:slug/:file`).
- **Browser source přehrávače je samostatný zdroj v OBS jen pro zvuky**, oddělený
  od chatu `/chat/raw/`. Hostuje ho Židolišta (OBS overlay infrastruktura + WS),
  událost „přehraj" posílá server Židolišty přes WS.
- **Přechod jednorázově**: až bude vše hotové a otestované, Rob naráz vypne SE
  commandy v SB i starý OBS zdroj a přidá nový browser source. Nikdy neběží
  paralelně (riziko dvojího přehrání).
- **UnityChat nikdy nepřehrává SE globálně** jako reakci na command. Zvuk je slyšet
  jen ze streamu. Lokálně jen náhled (repráček).

### Tiery a odměny (dashboard Židolišty)
- Nové menu **Sound efekty** spravuje zvuky: upload, přejmenování, zařazení do tieru,
  **volitelné emoji/ikona**, náhled, **koš** s obnovením.
- **Každý zvuk patří do jednoho tieru.** Tier 1 / 2 / 3 … definuje, které zvuky obsahuje.
- **Odemčení se nastavuje v Levels** jako nový typ odměny levelu, stejně jako dnes
  commandy. Odměna „SE" = vybraný **Tier N** + checkbox **„odemyká i nižší tiery"**
  + **výběr rolí (víc najednou)**: diváci / subové / VIP / modi / broadcaster
  + **délka**: N minut, nebo neomezeně (do resetu).
  Příklad usera: odměna 1 = Tier 2 + nižší, diváci, 10 min; odměna 2 = Tier 2 + nižší,
  Mod + Broadcaster, neomezeně.
- **Opakované odemčení běžícího tieru pro stejnou roli čas sčítá** (jako dnes v SB
  u stejného labelu).
- **Cooldowny se nastavují u odměny**: globální + per-user (výchozí 10 s / 30 s,
  modi 0).

### Pozdější změny (rozhodnutí usera 2026-09-24, mají přednost před textem výše)
- **SE je typ akce v labelu** (Unlock akce), ne samostatná sekce levelu: řádek akce
  [Streamer.bot | Židolišta] → Židolišta → Sound Efekt. Název, délka, „V liště“ a karta
  v Aktivních odměnách patří labelu; timer řídí server se všemi operacemi časovaných
  odměn (zmrazit/pokračovat, zrušit → hřbitov, obnovit, úprava času, hromadné, Stream OFF,
  reset). Zmrazení = SE zamčené. Smíšené labely (SB + Židolišta) povolené. „force“ vynechán.
- **Výchozí cooldown nové akce: 15 s / osobní 60 s.**
- **Tiery = seřazený seznam** (stabilní id + `position` z dashboardu, přesouvání).
  „I nižší tiery“ = všechny s nižší pozicí. V akci dropdown + ➕ pro víc tierů se sdíleným
  nastavením.
- **Pro koho** (nahrazuje Q1 „diváci = všichni“): **Všichni** = kdokoli (ostatní zešednou);
  **Diváci** = jen bez sub/VIP/mod/streamer; ostatní role přesně podle nejvyšší role.
  Efektivní odemčení = odměny „Všichni“ ∪ odměny nejvyšší role. Dřívější „Diváci“ se
  migrují na „Všichni“.
- **Zvuk má volitelný srozumitelný název** (displayName) a ikonu (emoji nebo 7TV emote).
- Echo ochrana v Židolišti: úvodní „!“/„/“ dosazené proměnnou se ořízne; vlastní odpověď
  přijatá zpět se jako command nevyhodnotí.

### Commandy
- `!se <jméno>` přehraje zvuk, pokud má autor zprávy (podle role z ingestu) aktivní
  tier se zvukem a nemá cooldown.
- `!se add <jméno> <url> [tier]`: **jen přímá URL na audio** (YouTube ne), volitelný
  tier (jinak Tier 1). Přidávat jde i uploadem v dashboardu. **Limity souborů zatím
  žádné** (spravuje je user).
- `!se remove <jméno>` přesune zvuk do **koše** (obnovit v dashboardu).
- `!se` (help) = náhrada SE Help.cs.
- add/remove smí **moderátor a broadcaster**.
- **Platformy: Twitch, Kick i YouTube** (role z badge každé platformy; YT člen = sub).

### Soundboard v UnityChatu (addon + web, sdílený core)
- Ikona **osminové noty**. Je **neaktivní**, když divák nemá žádný tier; custom tooltip
  pak řekne „odměna není aktivována". Když tier aktivní je, tooltip i soundboard
  ukazují **zbývající čas vizuálně (progress) i číslem**.
- Layout jako Discord: **hledání**, sekce **Oblíbené** (hvězdička), **Často používané**,
  pak **sekce podle tierů** (zamčené tiery šedě). U zvuku volitelné emoji.
  Po najetí na tlačítko se ukáže repráček (lokální náhled) a hvězdička.
- **Hlasitost náhledu = posuvník v soundboardu** (pamatuje si ji). Nastavení
  „Přehrávat zvuky" se na náhled nevztahuje, je to výslovný klik.
- **Hlasitost na streamu: nic, jako dnes** (žádná normalizace ani ruční hlasitost per zvuk).
- **Cooldown se v UI ukazuje**: zablokovaná tlačítka + odpočet (globální i můj).
- Klik pošle `!se <jméno>` **vlastním účtem diváka a zpráva se v chatu zobrazí**
  normálně (není skrytá).
- **Identita: přihlášení i v addonu** (dnes jen líné kvůli reakcím). Role a stav
  odměny se ověřují na serveru, ne jen podle badge v klientovi.
- Oblíbené a často používané se ukládají k účtu (stejné v addonu i na webu).
- Pravidlo portování: logika v `extension/core/` (např. `core/soundboard.js`),
  addon a web ji jen napojí. Sdílený kód se mění jen v repu UnityChat.

## Otevřené (rozhodnou implementující sessions, případně se zeptat usera)
- Přesný kontrakt integrace Židolišta → UnityChat (seznam zvuků + tiery + URL, aktivní
  odemčení per role s `expiresAt`, stav cooldownů, invalidace přes webhook → SSE).
- Jak backend UnityChatu určí ověřenou roli přihlášeného diváka (badge z ingestu jako
  u reakcí, nebo API platformy).
