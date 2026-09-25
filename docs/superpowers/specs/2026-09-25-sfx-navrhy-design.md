# Návrhy zvukových efektů (soundboard) — rozhodnutí usera

> 2026-09-25. Zdroj pravdy pro rozhodnutí (brainstorming v session s userem).
> Týká se UnityChatu (addon + web, sdílený core, backend) a Židolišty (stažení, zpracování,
> fronta, hlasitost). Navazuje na soundboard (`docs/superpowers/specs/2026-09-24-soundboard-se-tiers-design.md`).

## Co
V panelu soundboardu vedle vyhledávání tlačítko **„Navrhnout zvuk“**. Přihlášený divák pošle
odkaz na **mp3** nebo **YouTube**, vybere úsek a název; mod/streamer návrh v Židolištce
schválí (nastaví název a tier) nebo zamítne.

## Rozhodnutí
- **Kdo:** kdokoli přihlášený v UnityChatu. Schvaluje mod nebo streamer v dashboardu Židolišty.
- **Limit:** **10 návrhů denně a 30 měsíčně** na účet UnityChatu (kalendářní den/měsíc v Europe/Prague).
  Hlídá server; formulář ukazuje, kolik zbývá.
- **Délka zvuku:** nejvýš **30 s**.
- **Stahování jen na serveru Židolišty** (yt-dlp + ffmpeg), nikdy z klienta, úplně odděleně od Google
  projektu UnityChatu (YouTube API / OAuth verifikace). Stahování z YouTube porušuje jeho podmínky —
  user o riziku ví.
- **Výběr úseku:** časová osa s průběhem hlasitosti (waveform) a **dvěma značkami** (začátek vlevo,
  konec vpravo, vybraný úsek zvýrazněný mezi nimi — dvojitý range slider), tlačítko ▶ přehraje
  vybraný úsek. U mp3 kratší než 30 s je výchozí výběr celá délka.
- **Hlasitost nedestruktivně:** originál se nikdy nepřepisuje. Server při importu změří hlasitost
  (EBU R128 / loudnorm) a uloží **výchozí zesílení v dB** (normalizace). Mod v Židolištce posuvníkem
  zesílí/ztlumí (dB), **reset = 0 dB proti normalizaci / původní hodnota**. Přehrávač na streamu
  i náhled v UnityChatu zesílení aplikuje za běhu (Web Audio GainNode — zvládne i zesílení nad 100 %).

## Tok
1. UC: klik „Navrhnout zvuk“ → formulář: odkaz, „Načíst“.
2. UC backend → Židolišta `prepare`: stáhne (limit délky zdroje a velikosti), vrátí dočasný náhled
   `{ previewId, durationMs, peaks[], previewUrl }` (náhled vyprší, např. 30 min).
3. UC: waveform + dvě značky + ▶ (přehraje `previewUrl` v rozsahu), název (povinný), poznámka.
4. UC backend → Židolišta `submit { previewId, startMs, endMs, name, note, requester }` → Židolišta
   ořízne, změří hlasitost, uloží originál + gainDb, návrh do fronty. Kontrola limitu PŘED `prepare`
   i `submit` (prepare taky stojí server práci).
5. Dashboard Židolišty: fronta návrhů (poslech, název, tier, schválit/zamítnout, důvod).
   Po schválení je zvuk v soundboardu (SSE `soundboard-change` jako dnes).
6. UC: „Moje návrhy“ se stavem (čeká / schváleno / zamítnuto + důvod); změna stavu přes SSE.

## Rozdělení práce
- **UnityChat:** tlačítko v soundboardu, formulář s waveformem a dvojitým posuvníkem (sdílený core
  `core/sfx-request.js` + CSS, addon i web), backend proxy `/soundboard/requests/*` s identitou
  z přihlášení a limity 10/den + 30/měsíc, náhled s gainDb.
- **Židolišta:** stažení (yt-dlp/ffmpeg), náhled + peaks, ořez, loudness → gainDb, úložiště originálů,
  fronta a schvalování v dashboardu, posuvník dB s resetem, aplikace gainDb v přehrávači na streamu,
  API pro UC (kontrakt dohodnout se session Židolišty).

## Mimo rozsah
- Úpravy zvuku kromě hlasitosti (ořez po schválení, efekty).
- Jiné zdroje než mp3 a YouTube (TikTok, Twitch klipy…).
