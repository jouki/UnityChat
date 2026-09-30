# Pole pro psaní a panely — animace, sjednocené stavy, ikony (rozhodnutí usera 2026-09-27)

Platí pro addon i web (sdílený core `extension/core/`, CSS `composer.css`, `emote-picker.js`, `soundboard.js`,
`gif-library.js`, QR dono panel). Navazuje na morphing mezi panely (fix/gif-test2, bod 5).
`prefers-reduced-motion` → všechny animace okamžité.

## 1. Animace
- **Otevření panelu** (emoty/GIFy, soundboard, QR dono): žádné bliknutí — panel vyroste z nulové velikosti
  z **pravého spodního rohu** (transform-origin vpravo dole, scale 0 → 1 + fade, ~180–220 ms, easing).
  Zavření obráceně (do pravého spodního rohu). Přepnutí mezi panely = morphing (viz bod 5 fix/gif-test2).
- **Přepínání záložek s posuvným výběrem** (zvýrazněný rámeček/pozadí aktivní položky **přejede** z jedné na druhou,
  ne okamžité přepnutí): boční záložky panelu (Emoty | GIFy), horní taby GIF panelu (GIFy | Zamítnuté GIFy)
  a **ikony v textovém poli** (aktivní ikona otevřeného panelu — QR / nota / smajlík). Jeden sdílený helper.

## 2. Stav odměny — sjednotit se soundboardem
- GIF panel: hláška o odměně ve stejném stylu jako soundboard („**Odměna není aktivována**“ červeně / aktivní stav
  s časem), **jen první věta** — pryč „Knihovnu vidíš, poslat GIF jde s odemčenou odměnou.“ Přidat **ikonu zámku**
  jako soundboard.
- Soundboard: pryč druhá věta „Sound efekty se odemykají milestony Židolišty.“ a u tierů pryč slovo **„zamčeno“**
  (zůstane jen ikona zámku).
- Klik na zamčený sound efekt → **zámek se zatřese a zčervená**, pomalou animací (~1 s) se vrátí do šedé.
  (Totéž u pokusu poslat GIF bez odemčené odměny — zámek v GIF panelu.)

## 3. Ikony v textovém poli
- Všechny tři ikony (QR dono, soundboard, emoty) jsou **uvnitř textového pole**; samostatný řádek s ikonami navíc
  **zmizí úplně** (výjimka: addon napojený na Twitch si nechá svůj řádek bodů/bitů).
- **Mobil:** po kliknutí do textového pole se ikona QR **animovaně schová** (a po opuštění pole zase ukáže).
- **Web a addon:** ne na focus, ale když je v poli **napsaný text**, QR ikona se schová — **jen pod prahem šířky
  textového pole** (stávající práh pro QR, ~330 px; ověřit v kódu). Širší pole → QR ikona zůstává vždy.

## 4. Mobil — bez automatické klávesnice
- Otevření panelu emotů (i GIF záložky) na dotykovém zařízení **nesmí zaktivovat vyhledávací pole** (klávesnice se
  nesmí ukázat sama). Na desktopu fokus do hledání zůstává. (Regrese proti v3.40.1–4.)
