# GIF — úpravy po testu (rozhodnutí usera 2026-09-27)

Navazuje na `2026-09-26-gif-knihovna-design.md` a `2026-09-27-gif-nahled-zahozeni-design.md`.

## 1. Schválení ruší „tresty“
- Ověřeno v kódu: `gif_rejections` (strike per uživatel+GIF) se schválením nenuluje → po schválení a zpětném odebrání
  zůstal uživateli strike z prvního zamítnutí (další zamítnutí = pak už auto-zamítání).
- **Nově:** jakékoli schválení média (rozhodnutí moda, „Schválit“ ze Zamítnutých, obnova do schváleného, sloučení
  do schváleného) **smaže `gif_rejections` i `gif_bans` pro to médium** (všichni uživatelé). Zpětné odebrání
  (`unapprove`) ani zahození strike nepřidávají. Po odebrání tedy další poslání = normální žádost bez ⚠.

## 2. Zamítnout + trest (karta fronty)
- Tlačítko „Zamítnout“ je split button: hlavní část = zamítnout (jako dnes), šipka ▾ rozbalí:
  - **Zamítnout + timeout** `[10] [s|m|h]` (výchozí **10 min**; stejný výběr délky jako custom timeout v mod
    menu — `CUSTOM_UNITS`/`customDurationSec` z `core/mod-menu.js`, max 14 dní) → potvrdit tlačítkem.
  - **Zamítnout + permaban** → modální potvrzení („Trvale zabanovat <jméno> na <platforma>?“).
- Provedení: zamítnutí žádosti (`decide`) + stávající moderace `POST /moderation/user` (timeout/ban) pro odesílatele
  na jeho platformě. Stejné zámky karty (1 s / 0,3 s). Chyba moderace = hláška, zamítnutí platí.

## 3. Profil — zprávy zahozených GIFů
- V Profilu (mod+ seznam zpráv) se zprávy s GIFem, jehož médium je zamítnuté / odebrané / `purging` / `withdrawn`,
  zobrazí **normálně jako GIF, ale rozmazané** (CSS blur). Klik na GIF = zaostřit, další klik = znovu rozmazat.
  Náhled zamítnutých / `purging` přes token moda. `unavailable` → štítek „[GIF nedostupný]“. Chat se nemění.

## 4. Nabídka ⋯ se nesmí usekávat
- Nabídka dlaždice se polohuje uvnitř panelu (zarovnání k pravému/levému okraji podle místa, případně nad dlaždici).

## 5. Mod bez výjimky z odměny
- Mod / streamer **nemá GIF odměnu automaticky**; platí pro něj `gif-access` ze Židolišty stejně jako pro ostatní
  (Židolišta dostává roli a může mody odemknout sama). Cooldown taky.
- GIF moda **s** odemčenou odměnou se dál schvaluje sám (bez fronty; mimo Dev mód) — beze změny.
- Text v panelu „Jako mod posíláš GIFy bez odměny.“ pryč; mod vidí stav odměny jako ostatní.
