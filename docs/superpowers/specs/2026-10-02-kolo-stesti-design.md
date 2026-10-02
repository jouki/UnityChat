# Kolo štěstí pro podporovatele — design (2026-10-02)

Zadání usera: ruleta pro lidi, kteří se zapojí tlačítkem „Připojit se“ v UnityChatu; zapojit se smí jen ten, kdo
poslal za posledních 30 dní donate (jakákoli částka, jakýkoli zdroj); kdo donatne až po vyhlášení, připojí se
dodatečně. Mod / streamer kolo vyhlásí, ručně spustí losování, výherce potvrdí do lhůty (výchozí 15 min,
nastavitelná), jinak se losuje znovu bez něj. Po potvrzení si mod vybere: losovat dalšího, nebo ukončit.

Rozhodnutí usera (2026-10-02): připojení jen tlačítkem v UnityChatu (přihlášený účet), 1 účet = 1 los (rovná
šance), potvrzení tlačítkem v UnityChatu, kolo + výherce v addonu i na webu (ne v OBS), přihlášky končí ručně
(„Losovat“), vyhlášení = název výhry + počet přihlášených + zpráva bota do chatu, víc výherců postupně podle volby
moda. „Buď samostatný“ — zbytek rozhodnutí níže dělá Claude.

## Stavový automat (backend, jeden aktivní na kanál)

| stav | význam | přechody |
|---|---|---|
| `open` | přihlášky běží | `draw` → `pending`; `end` → `cancelled` |
| `pending` | vylosovaný výherce čeká na potvrzení (`deadline`) | `confirm` (výherce) → `confirmed`; lhůta → `expired`; `end` → `ended` |
| `confirmed` | výherce potvrdil | `draw` → `pending` (další výherce ze zbytku); `end` → `ended` |
| `expired` | výherce nepotvrdil, je vyřazený | `draw` → `pending`; `end` → `ended` |
| `ended` / `cancelled` | konec (cancelled = bez výherce) | — |

- Losuje server (`crypto.randomInt`) z přihlášených, kteří nejsou vyřazení ani už nevyhráli. Prázdný pool → 409 `no_entries`.
- Po prvním losování se přihlášky zavírají (připojit se jde jen ve stavu `open`).
- Lhůta: časovač v procesu + kontrola při každém čtení stavu (restart serveru nic neztratí — stav je v DB).
- Ukončené kolo se v UI ukazuje ještě 60 s (výsledek), pak řádek zmizí.

## Data (SQL `backend/sql/2026-10-02-giveaways.sql`, ručně, schema.ts zrcadlí)

- `giveaways`: `id` bigserial, `channel`, `prize` (≤ 100), `confirm_minutes` (1–120, výchozí 15), `status`,
  `winner_account_id`, `winner_name`, `winner_platform`, `deadline`, `draw_seq` (počítadlo losování → klient
  spustí animaci jen při změně), `created_by`, `created_at`, `updated_at`. Částečný unikátní index: jeden
  nekončený (`status in (open, pending, confirmed, expired)`) na kanál.
- `giveaway_entries`: (`giveaway_id`, `account_id`) PK, `name`, `platform`, `joined_at`, `excluded` (vypršel),
  `won` (potvrzený výherce).

## API

Veřejné:
- `GET /giveaway?channel=` → `{ ok, giveaway: State | null, serverNow }`.
- SSE `giveaway` na `/nicknames/stream` → `State` (při každé změně: vyhlášení, připojení, losování, potvrzení,
  vypršení, konec). Veřejná data jsou jen jména přihlášených (stejná jako v Síni slávy), žádná id účtů.

`State = { id, channel, prize, status, count, names[] (pool pro kolo, max 80), winner: { name, platform } | null,
deadline (ms) | null, drawSeq, winners: [{ name, platform }] (potvrzení výherci), confirmMinutes, updatedAt }`.

Přihlášený divák (`requireWebSession`):
- `GET /giveaway/me?channel=` → `{ ok, joined, isWinner, eligible }` (`eligible` = podporovatel teď; bez obnovy).
- `POST /giveaway/join { channel }` → `{ ok, joined: true }` | 409 `not_open` | 403 `not_donor`. Kontrola:
  kterákoli identita účtu (`accountIdentities`) je podle `lib/donors.ts` `isDonor` podporovatel (ID nebo jméno
  s leetspeakem). Když ne → jednou obnovit dárce workspace ze Židolišty (`refreshDonors`, nejvýš 1× / 20 s na
  workspace) a zkusit znovu — donate poslaný po vyhlášení. Jméno v kole = přezdívka UnityChatu, jinak zobrazované
  jméno identity (přednost Twitch → Kick → YouTube).
- `POST /giveaway/confirm { channel }` → jen výherce ve stavu `pending` před `deadline` → `confirmed`.

Mod / streamer (`modGate` z moderace, role ze serveru):
- `POST /moderation/giveaway/start { channel, prize, confirmMinutes? }` → 409 `active` když už jedno běží.
- `POST /moderation/giveaway/draw { channel }` → nový výherce (`pending`, `deadline = now + confirmMinutes`).
- `POST /moderation/giveaway/end { channel }` → `ended` (s výherci) / `cancelled` (bez).

## Bot do chatu (JoukiBOT přes `sendAsBot`, všechny platformy workspace, chyba = jen log)

- vyhlášení: „Kolo štěstí: {výhra}! Připojit se můžou podporovatelé z posledních 30 dní tlačítkem v UnityChatu.“
- losování: „Kolo štěstí vybralo: {jméno}! Výhru ({výhra}) je potřeba potvrdit v UnityChatu do {N} min.“
- potvrzení: „Výhra potvrzena: {jméno} ({výhra}).“
- vypršení: „Lhůta na potvrzení vypršela ({jméno}), losuje se znovu.“ (texty bez rodu)

## UI — sdílený `core/giveaway.js` + `extension/giveaway.css` (addon i web, OBS ne)

- **Řádek nad polem pro psaní** (`#gw-bar`, vyjede jako banner výročí): ikona kola, výhra, počet přihlášených a
  podle stavu: `Připojit se` / `Připojeno ✓` / `Přihlas se` (otevře přihlášení) / „Jen pro podporovatele za 30 dní“
  + `Poslat donate` (otevře QR dono, je-li v kanálu). Ve `pending`: „Vylosováno: X · potvrzení 14:32“; výherce
  vidí `Potvrdit výhru` s odpočtem. `confirmed`: „Výherce: X 🎉“. Mod vidí v řádku navíc `Losovat` (open /
  confirmed / expired), `Ukončit`.
- **Tlačítko moda v poli** (`#btn-giveaway`, ikona kola, jen `uc-can-moderate`, v tool docku vlevo od QR):
  otevře panel (registerPanel, morfuje jako QR / emoty) s formulářem Vyhlásit (výhra, lhůta v minutách, výchozí
  15) nebo — když kolo běží — se stavem a tlačítky Losovat / Ukončit a seznamem přihlášených.
- **Animace losování**: při změně `drawSeq` (ne při prvním načtení) překryv nad chatem s kolem (SVG výseče se
  jmény, max 80), roztočí se ~5 s a zastaví na výherci (index ze `State.names` + `winner`), pak 2 s jméno výherce,
  zavřít klikem / Esc. `prefers-reduced-motion` → bez točení, rovnou výherce.
- Po každé SSE změně si přihlášený klient dotáhne `/giveaway/me` (joined / isWinner).

## Testy

- Backend (`node --test`): stavový automat a přechody (open → draw → pending → confirm / expire → draw → end),
  pool bez vyřazených / výherců, `no_entries`, jeden aktivní na kanál, join jen dárce (+ obnova dárců po
  odmítnutí, limit), confirm jen výherce před lhůtou, mod gate (divák 403), veřejný stav bez id účtů.
- Core (`scripts/test-giveaway.js`): render řádku podle stavu a role, výpočet úhlu kola k výherci, odpočet.
- E2E web (`scripts/e2e-giveaway.mjs`) a addon: řádek se zobrazí po SSE, join (dárce / nedárce → donate tlačítko),
  mod panel vyhlásí, losování spustí kolo a zastaví na výherci, výherce potvrdí, losování znovu po vypršení.
