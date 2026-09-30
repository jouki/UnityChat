# GIF knihovna, deduplikace, zamítnuté GIFy a průběh stahování — rozhodnutí usera (2026-09-26)

Navazuje na moderaci část 4 (GIF odměna): `docs/superpowers/specs/2026-09-25-moderace-odkazy-gify-design.md`,
kontrakt `docs/superpowers/plans/2026-09-25-moderace-cast-2-kontrakt.md` (Část 4). Nasazení: **addon + web + OBS (raw)**.

## 1. Průběh stahování (optimistická zpráva)
- **Odesílatel** (mod i divák) vidí svou zprávu s odkazem hned jako optimistickou (jen on; ostatní nic).
- U ní **kolečko s procenty** podle fází (server posílá fáze přes SSE jen odesílateli — `/account/stream`):
  - 0–10 % detekce + přístup; 10–50 % přímé stahování (skutečné bajty, když je známa velikost, jinak odhad);
  - 50–95 % Bright Data — lineárně podle odhadu doby (klouzavý průměr skutečných dob fallbacku, škálovaný
    velikostí, když je známa); když trvá déle, **zasekne se na 95 %**; když je hotovo dřív, skočí na 95 %;
  - bez Bright Data skok z 50 na 95; 95–100 % kontrola + uložení.
- **Mod** (auto-schválení): po dokončení indikátor zmizí a místo zprávy se ukáže GIF.
- **Divák**: po stažení se indikátor změní na peach/oranžový label **„Schvalování moderátorem ( )“** s animací čekání.
  - Po zamítnutí / vypršení: label **červený „Zamítnuto moderátorem“ / „Vypršelo“ a zůstane** (zpráva nezmizí);
    na platformě (vanilla chat) je zpráva smazaná (bot / mod).
- Ostatní diváci čekající zprávu **nevidí**. **OBS (raw) ji nevidí vůbec**.
- **Po schválení** se GIF zobrazí **na konci chatu (čas schválení)** — v UC i v OBS (mění dnešní „na místě původní zprávy“).

## 2. Fronta ke schválení (mod) — FIFO, synchronizovaná
- Dole nad polem **jedna karta = nejstarší čekající GIF** + „+N čeká“. Po rozhodnutí se ukáže další.
- **Synchronizace napříč všemi přihlášenými mody**: rozhodnutí jednoho → ostatním se karta co nejdřív aktualizuje
  (SSE). Platí **první odpověď** (server atomicky; pozdější klik = „už rozhodl X“).
- **Zámek tlačítek**: když modovi přijde aktualizace fronty (jiná karta), tlačítka Schválit/Zamítnout jsou **1 s**
  zamčená (proti omylem schválenému dalšímu GIFu); modovi, který kliknul, **0,3 s** (proti dvojkliku).

## 3. Deduplikace
- **Přesná**: normalizovaná URL zdroje + **sha256 obsahu**. Stejná URL → nestahuje se znovu; jiná URL na identický
  soubor → pozná se po stažení. Schválený duplikát = **bez nového schvalování**, použije se naše verze.
- **Podobnost (hned v tomto kole)**: perceptuální hash (dHash/pHash) z více snímků rozprostřených v čase; odolné vůči
  kompresi, rozlišení, oříznutí začátku/konce, rychlosti. Jen **návrhy duplikátů k potvrzení**: „nechat první /
  nechat druhý / nechat oba“ (nic se neslučuje samo). Hashe i zpětně pro existující GIFy (na pozadí).
  Návrhy vidí mod v UC a Židolišta přes API (dashboard).

## 4. Opakovaně zamítnuté GIFy
- Stejný uživatel + stejný (zamítnutý) GIF: 1. zamítne mod, 2. jde znovu ke schválení, **3. a další automaticky
  zamítnuto + zpráva smazána** (dokud je GIF zamítnutý).
- Jiný uživatel pošle dříve zamítnutý GIF: jde ke schválení, ale **odesílatel** má u labelu čekání **⚠ (žlutooranžový
  trojúhelník) s tooltipem „tento GIF byl už dříve zamítnut“** a **mod na kartě** vidí, že byl zamítnut (kdy, kým) +
  tlačítko **„Automaticky zahazovat 12 h“** (pro tento GIF od všech).

## 5. Zamítnuté GIFy — přístup a správa
- Zamítnuté GIFy **nejsou veřejně dostupné** přes odkaz. Otevřou se jen s **tokenem** v parametru URL:
  - token vydává **UC server** per účet moda (náhodný, v DB jen hash, ověření + kontrola, že účet je stále mod);
    UC ho do odkazů pro moda přidává sám; **Židolišta dostane vlastní token** pro dashboard. Veřejnost kódu nevadí —
    bezpečnost stojí na tajemství na serveru.
- **Čekající GIFy** blokované nejsou (náhodné ID; user 2026-09-26). **Schválené** jsou veřejné (i pro vložení
  do Discordu — žádná ochrana proti hotlinkingu; při podezřelém provozu se omezí).
- GIF záložka pro **mody/streamera** má nahoře dva taby: **GIFy** | **Zamítnuté GIFy**. U zamítnutých akce:
  **Schválit** (jen do knihovny, do chatu nic), **Vault** (zůstane zamítnutý, ale nesmaže se), **Trvale zahodit**.
- Zamítnuté se **po 14 dnech automaticky mažou**, kromě vaultovaných (ty dokud je mod neschválí/nezahodí).

## 6. GIF záložka v panelu emotů (knihovna schválených)
- Vlevo v panelu emotů svislé „záložky“ (Emoty | GIFy | …). GIF záložka = schválené GIFy kanálu, **řazení podle použití**.
- **Divák bez odemčené odměny knihovnu vidí**, ale odeslat může jen s odemčenou odměnou.
- Výběr GIFu → do chatu platformy se pošle **odkaz na náš server** (`api.jouki.cz/media/gif/<id>`) → UC ho díky
  dedup rovnou zobrazí jako schválený (bez schvalování).
- Tagy/labely: ze zdroje (Tenor/Giphy) se naparsují, správa tagů v dashboardu Židolišty (API UC).
- **Indikátor odměny** jako u soundboardu: **časový pásek pod ikonou emotů** (ubývá s timerem odměny) a stejný pásek
  na boční GIF záložce; nahoře v GIF záložce odpočet jako u soundboardu.

## 7. Režim odměny (Židolišta)
- V akci odměny „Posílání GIFů“ volba **„Všechny“ / „Schválené“** (Židolišta UI; `gif-access` vrací `mode`).
  - **Všechny**: nové GIFy přes schvalování (jako dnes) + knihovna.
  - **Schválené**: jen existující schválené (knihovna, dedup známých). Odkaz na **nový** GIF → **zpráva se smaže +
    hláška** „Nové GIFy teď nejdou, vyber z GIFů v panelu“. **Platí i pro mody a streamera.**
- Mod/streamer v režimu „Všechny“: nový GIF se schválí sám (jako dnes; mimo Dev mód).

## Rozdělení práce
- **UC backend**: dedup (URL + sha256), perceptuální hashe + návrhy, zamítací logika (3.+ auto, 12h zákaz), tokeny
  pro zamítnuté, retence 14 dní + vault, knihovna API (řazení podle použití, tagy ze zdroje), FIFO fronta + sync +
  „první vyhrává“, fáze průběhu přes SSE, režim z `gif-access`, pozice na konci chatu, OBS skrytí čekajících.
- **Core + addon + web + OBS**: optimistická zpráva + kolečko %, labely (peach/červený/⚠), karta FIFO se zámky,
  GIF záložka (+ mod taby Zamítnuté), indikátor pásek, hlášky.
- **Židolišta**: volba režimu „Všechny/Schválené“ v akci odměny (+ `mode` v `gif-access`), dashboard GIFů (tagy,
  návrhy duplikátů, zamítnuté) nad API UC.
