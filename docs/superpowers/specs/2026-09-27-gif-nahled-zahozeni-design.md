# GIF — náhled a dvě varianty zahození (rozhodnutí usera 2026-09-27)

Navazuje na `2026-09-26-gif-knihovna-design.md`. Nasazení: backend + core + addon + web (OBS jen zobrazuje) + API pro Židolištu.

## 1. Náhled GIFu
- Každá dlaždice v GIF panelu (knihovna **i** Zamítnuté, i návrhy duplikátů) má **nabídku ⋯** s položkou **„Náhled“**. V knihovně ji vidí i divák.
  Mod tam má i dosavadní akce (Odebrat z knihovny, Trvale zahodit …).
- V **Zamítnutých** (a v duplikátech) otevře náhled i **prostý klik** na GIF. V knihovně klik dál GIF posílá do chatu.
- Náhled = překryv **nad GIF panelem** (v rámci panelu emotů): GIF ve větší velikosti (fit do panelu), rozměry, tagy,
  u zamítnutých kdo/kdy zamítl. Zavření: ×, klik mimo, Esc. Zamítnuté se načítají s tokenem jako náhledy.

## 2. „Trvale zahodit“ — volba, co se zprávami
Potvrzovací dialog nabízí dvě tlačítka (+ Zrušit):

**a) „Zahodit, zprávy nechat“** → stav média `withdrawn` („stažený“):
- GIF zmizí z knihovny i ze seznamu zamítnutých; **soubor zůstane na serveru** a staré zprávy ho dál zobrazují
  (veřejně, stejně jako dřív schválený).
- Nový odkaz na tentýž GIF (URL / sha256 / náš odkaz) se bere jako **zahozený** — do chatu se nepustí (smazání +
  stejné chování jako zamítnutý se zákazem: bez schvalování, auto zamítnuto).
- V záložce Zamítnuté je sekce **„Stažené GIFy“**: jejich seznam, u každého **„Odstranit ze serveru“** (s potvrzením)
  → soubor se smaže a staré zprávy ukážou místo GIFu štítek **„[GIF nedostupný]“** (stav `unavailable`). Nevratné.

**b) „Zahodit i se zprávami“** → stav `purging` s `purge_at = now + 7 dní`:
- Zprávy s GIFem se **hned schovají** (jako dnes `gif_removed`, divák „Zpráva smazána“, OBS skryje).
- Soubor se ze serveru smaže **po 7 dnech** (retenční tick), pak médium zmizí úplně.
- Do té doby je v Zamítnutých sekce **„Ke smazání“** s odpočtem („smaže se za 6 dní“) a tlačítkem **„Obnovit“** →
  médium se vrátí do stavu před zahozením (schválené zpět do knihovny, zamítnuté zpět do zamítnutých) a zprávy se
  znovu zobrazí.

## 3. API / kontrakt
- UC mod: `POST /moderation/gif/:mediaId/purge { keepMessages: boolean }`; nové `POST …/restore` (jen `purging`),
  `POST …/remove-file` (jen `withdrawn`); `GET /moderation/gif/withdrawn?channel&before`, `GET …/purging?channel&before`.
- Integrace (podpis v2): stejné akce na `/integrations/:slug/gifs/:mediaId/purge|restore|remove-file`,
  `GET …/gifs/withdrawn`, `GET …/gifs/purging`. **`purge` bez `keepMessages` = „i se zprávami“ (b)** — zpětně
  kompatibilní s dnešním dashboardem (dnes maže hned; nově s 7denní lhůtou a možností obnovit).
- Zprávy v historii / streamu / Profilu: `withdrawn` → GIF normálně; `purging` → smazaná zpráva `gif_removed`;
  `unavailable` (soubor pryč) → zpráva s GIF štítkem „[GIF nedostupný]“ (ne smazaná).
- `/media/gif/:id`: `withdrawn` veřejně (cache 300 s); `purging` jen s tokenem (náhled v „Ke smazání“); `unavailable` 404.
- SSE po zahození / obnovení / odstranění souboru, ať otevření klienti překreslí zprávy (řeší i dřívější M5).
