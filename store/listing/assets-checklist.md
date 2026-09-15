# Vizuální assety — checklist

Požadavky podle [Chrome Web Store image guidelines](https://developer.chrome.com/docs/webstore/images).

## Povinné

| Asset | Rozměr | Formát | Stav |
|---|---|---|---|
| Ikona rozšíření | 128×128 (kresba 96×96 + 16 px průhledný okraj) | PNG | ✅ `assets/icon128-store.png` |
| Small promo tile | 440×280 | PNG / JPEG | ✅ `assets/promo-small-440x280.png` |
| Screenshot (min. 1) | 1280×800 (preferované) nebo 640×400 | PNG / JPEG, full bleed, ostré rohy | ☐ vytvořit |

Bez těchto tří položek nejde item publikovat.

### Promo dlaždice — hotovo

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-promo.ps1
```

Obě dlaždice (440×280 i 1400×560) vznikají z jednoho zdroje
`assets/promo.html` — `?size=small|marquee` přepíná měřítko a kompozici
(small staví na výšku, marquee je logo vedle textu). Renderuje headless
Chrome, skript ověří výsledné rozměry, protože špatně velký asset dashboard
odmítne při uploadu.

Logo je v `assets/logo.svg` — vektor vytažený z `logo-designer.html`
(varianta 5 „Stylized U-as-bubble", gradient #ffc800 → #ff8c00).
`icon128.png` se na 250 px rozmazával.

### Ikona — hotovo

`extension/icons/icon128.png` má kresbu přes celých 128 px (změřený průhledný
okraj 4/0/4/0 px), zatímco store čeká **96×96 kresby a 16 px průhledného
okraje**. Bez úpravy by ikona ve store vypadala větší než ostatní.

Store varianta je proto v `assets/icon128-store.png` — stejná kresba
přeškálovaná na 96×96 a vycentrovaná ve 128×128 (ověřený okraj 19/16/19/16 px,
rozdíl je vlastní odsazení původní kresby). **Nahrává se v dashboardu, do
balíčku nepatří** — rozšíření samo dál používá původní ikonu.

## Volitelné, ale vyplatí se

| Asset | Rozměr | Stav |
|---|---|---|
| Marquee promo tile | 1400×560 | ✅ `assets/promo-marquee-1400x560.png` — bez něj se rozšíření nemůže dostat do marquee featuru |
| Screenshoty 2–5 | 1280×800 | ☐ více záběrů = lepší konverze, max. 5 |

## Co nafotit (návrh 5 screenshotů)

Panel je úzký, samotný by na 1280×800 plaval — proto fotit **stream + panel
vedle sebe**, ať je hned vidět, k čemu to je.

1. **Hlavní záběr** — Twitch stream vlevo, UnityChat panel vpravo, v chatu
   promíchané zprávy ze všech tří platforem s viditelnými platform odznaky.
   Tohle je první screenshot, na ten se lidi dívají nejdéle.
2. **Emoty a odznaky** — výřez chatu, kde jsou vedle sebe 7TV, BTTV a nativní
   Twitch emoty plus subscriber/mod odznaky.
3. **Našeptávač** — rozepsaná zpráva s otevřeným seznamem emotů po Tabu.
4. **Zvýrazněná zmínka + reply** — zpráva se zmínkou a nad ní kontext odpovědi.
5. **Připnutá zpráva** — banner připnuté zprávy nad chatem.

### Na co dát pozor při focení

- **Žádná cizí osobní data** — ve viditelném chatu nesmí být e-maily,
  odkazy na soukromé profily ani nic, co by se dalo brát jako doxxing. Reálná
  jména chatterů z veřejného chatu jsou v pořádku, ale radši použít vlastní
  testovací zprávy.
- **Žádné branding prvky Twitche/YouTube/Kicku v promo dlaždicích** — logo ani
  wordmark cizí služby v promo grafice je důvod k odmítnutí. Ve screenshotu
  rozhraní je to v pořádku, protože jde o skutečný stav aplikace.
- **Žádný text „Free", „Install now", hodnocení hvězdičkami** ani jiné
  marketingové prvky v promo dlaždicích.
- Panel focený v **medium nebo large layoutu** — small layout je na 1280 px
  screenshotu nečitelný.
- Verze v hlavičce panelu se do screenshotu propíše, takže po větším redesignu
  je fajn screenshoty přefotit.

## Poznámka k promo dlaždicím

Obě dlaždice (440×280, 1400×560) jdou postavit na stejné estetice jako
install page na `jouki.cz/UnityChat` — Orbitron wordmark, oranžový gradient,
HUD mřížka. Tím drží brand napříč store i webem. Podklady: `logo-designer.html`
v kořeni repa a `unitychat/assets/` v repu `jouki/jouki.cz`.
