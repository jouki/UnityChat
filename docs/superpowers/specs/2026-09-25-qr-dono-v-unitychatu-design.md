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
- ~~Přezdívka a e-mail z loginu~~ → **ZMĚNA po právní analýze** (viz sekce Identita níže).
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

## Identita dárce (rozhodnutí usera 2026-09-25, po právní analýze)
Právní analýza: Twitch Developer Agreement VI.C a Kick ToS zakazují předávat data z jejich API
třetím stranám → **e-mail se z loginů platforem NEČTE** (YouTube scope `email` se nepřidává).
Uživatel e-mail zadá sám a dobrovolně ho **ověří kódem** → spárování účtu s e-mailem.

- **E-mail je povinný.** Když účet ještě nemá ověřený e-mail, formulář ukáže pole E-mail a pod
  ním checkbox **„Potvrdit email při první platbě“ (výchozí zaškrtnutý)** s vlastním hover
  tooltipem: „Abychom mohli autorizovat, že jsou platby skutečně od tebe, potřebujeme ověřit
  tvůj email. V budoucnu díky tomu získáš přístup a výhodu pro nadcházející funkce.“
- Klik na „Vytvořit QR kód“ se zaškrtnutým checkboxem → server pošle **6místný číselný kód** →
  panel ukáže „Na email jsme ti poslali 6místný kód, který přepiš sem:“ se **6 samostatnými
  políčky** (kurzor skáče dál, Backspace maže poslední číslici, Ctrl+V vloží celý kód). Po
  poslední číslici / vložení se kód **hned ověří**; úspěch = animace potvrzení → QR kód.
  Schránka se nekontroluje (vyžadovala by oprávnění).
- **„Poslat znovu“** s cooldownem 2 min → 5 min → 15 min.
- Nezaškrtnutý checkbox = e-mail se k donu pošle, ale účet se s ním nespáruje.
- **Ověřený e-mail patří účtu** (web_accounts = všechny propojené identity). Přihlášení kterýmkoli
  účtem, který byl u ověření propojený, e-mail doplní z DB → pole ani checkbox se už neukážou
  a znovu se neověřuje. Po „Zpět“ z QR obrazovky se u spárovaného účtu checkbox neukáže.
- **Nastavení UnityChatu:** nahoře zašedlé pole Email; bez ověřeného e-mailu tlačítko
  **„Spárovat email“** (stejný flow s kódem), s ověřeným **„Změnit email“**.
- **Přezdívka se ukazuje vždy**, předvyplněná: vlastní přezdívka z UnityChatu → poslední zadaná
  přezdívka v donu → přezdívka z aktuální platformy. Poslední přezdívka se ukládá k účtu.

### Posílání e-mailů
- Odesílatel **UnityChat <noreply-unitychat@jouki.cz>**. Primárně **Brevo** (EU, 300/den),
  **záloha Resend** (100/den) při chybě nebo vyčerpání limitu. Obě přes HTTPS API (Hetzner
  blokuje odchozí 25/465; na jouki.cz dnes žádný mail server — MX `mail.jouki.cz` míří na starou
  domácí IP, user: nepoužívaný).
- DNS jouki.cz (gigaserver): SPF s oběma službami, DKIM obou, explicitní `_dmarc.jouki.cz`
  (dnes ho přebíjí wildcard CNAME) `p=none; rua=…` → později `p=quarantine`.
- Ochrana kvóty: kód jen pro přihlášeného, cooldown 2/5/15 min, denní strop na účet, IP i adresu,
  kód platí 10 min, max 5 pokusů. Obě služby nedostupné → hláška + pokračovat bez ověření.
- Obsah: plain text + jednoduché HTML, bez obrázků a zkracovačů, předmět „Tvůj ověřovací kód: 123456“.

## Vzhled obrazovky s QR (rozhodnutí usera 2026-09-25)
- **Invertovaný barevný QR** (světlé moduly s gradientem UC na tmavém pozadí, glow) — user ho
  otestoval v bankovních aplikacích: „úplně v pohodě“. Stažený PNG zůstává klasický černobílý.
- **Bez VS / IBAN a bez věty „Platíš přímo na účet streamera…“** na obrazovce — vědomé rozhodnutí
  usera (právní analýza tu větu doporučovala jako checklist bod 9; user ji nechce).

## Závislosti na Židolišti
- Rate limit veřejného API je per IP (10 záměrů / 10 min, 20 ověření tokenu / 10 min);
  přes proxy by všichni sdíleli IP backendu → pro požadavky s X-Api-Key UnityChatu počítat
  limit podle IP klienta, kterou backend pošle (`X-UC-Client-Ip`), nebo podle účtu.
- Ověřit, že veřejné endpointy přijímají požadavek bez `Origin` (server-to-server).
