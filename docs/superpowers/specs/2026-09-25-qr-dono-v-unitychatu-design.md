# QR dono v UnityChatu — rozhodnutí usera

> 2026-09-25. Zdroj pravdy pro rozhodnutí. Vzor: dárcovský formulář Židolišty
> (RobJewsALot `wrapper-service/donate.html`, dokumentace `docs/fio-donations/`,
> hlavně 03-donor-form, 04-public-api, 13-czk-raiffeisenbank).

## Co
Tlačítko s ikonou **QR kódu** v řádku nad polem pro psaní (v addonu řádek s credits pill).
Když řádek nemá nic jiného (divák není na Twitchi → bez credits pill), je v něm jen tohle
tlačítko. Klik otevře panel s QR dono formulářem **ve vzhledu UnityChatu**.
**Celé za dev módem** (addon: Dev mode v nastavení; web: stejný přepínač vývojáře).

## Rozhodnutí
- **Addon i web, sdílený core** (`extension/core/qr-dono.js` + CSS), hostitelé jen napojí.
- **API přes backend UnityChatu** (api.jouki.cz → Židolišta `/donate/public/:slug/…`),
  žádné nové oprávnění addonu. Backend doplní identitu z přihlášeného účtu (ne z klienta).
- **Formulář bez polí přezdívka a e-mail:** přezdívka = display name platformy, na kterou
  divák píše; e-mail z loginu.
  - Twitch: `user:read:email` už máme → Helix Get Users.
  - Kick: `user:read` → `/public/v1/users` pole `email` (ověřit na reálném účtu).
  - YouTube: **přidat scope `email`** (+ consent screen v Google Cloud, re-login YT uživatelů).
  - E-maily se ukládají **k identitě** a všechny patří **jednomu účtu** (web_accounts).
    Když identita e-mail nemá (YouTube bez scope, účet bez ověřeného e-mailu), použije se
    e-mail jiné propojené identity téhož účtu.
- **CZ / SK přepínač** = měna: CZ = Kč (QR Platba / SPD, Raiffeisenbank), SK = € (PayBySquare,
  Fio). Odpovídá `?cur=czk` / `?cur=eur` na Robově stránce.
- **Interaktivní jako na webu:** hlasy TTS + ukázka, živý přepočet Kč, minimum, výsledek
  s QR + VS + IBAN + částka, kolečko odpočtu, stav „Zaplaceno“ živě (SSE + polling záloha),
  kontrola verze konfigurace.
- **Test mode:** klik do prázdného panelu formuláře a napsat `testmode` → odkryje se pole
  testovacího tokenu + přepínače (markTest / markPaid). Token ověřuje **server**
  (debounce 500 ms, `POST test-token` → `{valid}`), nikdy klient; platný = zelené tlačítko
  „Testovací tip“.
- **Soukromí:** předávání e-mailu Židolišti = PII → upravit data disclosure v CWS i AMO
  a zásady ochrany soukromí (jouki.cz/UnityChat/privacy) **hned**.

## Závislosti na Židolišti
- Rate limit veřejného API je per IP (10 záměrů / 10 min, 20 ověření tokenu / 10 min);
  přes proxy by všichni sdíleli IP backendu → pro požadavky s X-Api-Key UnityChatu počítat
  limit podle IP klienta, kterou backend pošle (`X-UC-Client-Ip`), nebo podle účtu.
- Ověřit, že veřejné endpointy přijímají požadavek bez `Origin` (server-to-server).
