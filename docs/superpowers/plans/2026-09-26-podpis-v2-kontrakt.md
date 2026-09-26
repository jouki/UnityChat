# Podpis v2 mezi UnityChatem a Židolištou (kontrakt, 2026-09-26)

Dohodnuto se session Židolišty (robjewsalot) po bezpečnostním auditu integrací
(nález I2: v1 podepisuje klíčem, který jde v `X-Api-Key` téhož požadavku; nekryje metodu/cestu; bez ochrany proti replay).

## Klíče
- Dva samostatné podpisové klíče, jeden pro každý směr — **nikdy nejdou po síti** (ani v hlavičce, ani v logu):
  - `UC_TO_ZIDOLISTA_SIGNING_KEY` — UC podepisuje odchozí volání na Židolištu, Židolišta ověřuje.
  - `ZIDOLISTA_TO_UC_SIGNING_KEY` — Židolišta podepisuje volání/webhooky na UC, UC ověřuje.
- Formát: ≥ 32 náhodných bajtů, hex (64 znaků). Generují se na VPS a zapisují do env obou aplikací v Coolify bez vypsání.
- `X-Api-Key` zůstává jako identifikace a první brána (401 dřív, než se cokoli dalšího děje).

## Podepisovaný text
```
signed = METHOD + " " + PATH_AND_QUERY + "\n" + t + "\n" + nonce + "\n" + hex(sha256(rawBody))
```
- `METHOD` velkými písmeny (`GET`, `POST`, `DELETE`, …).
- `PATH_AND_QUERY` přesně jak požadavek odešel, bez schématu a hostu (včetně prefixu cesty, pokud ho base URL má;
  query v pořadí a kódování, jak byla odeslána). Příjemce bere `req.url` (surová cesta+query), ne rekonstrukci.
- `t` = unix čas v sekundách (desítkové číslo).
- `nonce` = hodnota hlavičky `X-UC-Nonce`.
- `rawBody` = surové bajty těla (u GET / bez těla prázdný řetězec → `e3b0c442…b855`).

## Hlavičky
- `X-UC-Signature: t=<unix s>,v2=<hex HMAC-SHA256(signingKey, signed)>`
- `X-UC-Nonce: <16–64 znaků [A-Za-z0-9_-]>` (doporučeno 16 náhodných bajtů hex)

## Ověření u příjemce (v tomto pořadí)
1. `X-Api-Key` platný (konstantní čas) — jinak 401 `unauthorized`.
2. Hlavička podpisu a nonce přítomné a ve správném formátu — jinak 401 `bad_signature` (`missing` / `malformed`).
3. `|now − t| ≤ 300 s` — jinak 401 `bad_signature` (`expired`).
4. HMAC sedí (`timingSafeEqual`) — jinak 401 `bad_signature` (`mismatch`).
5. Nonce ještě neviděný — jinak 401 `replay`. Nonce se zapíše až po úspěšném ověření podpisu; cache 360 s per směr
   (paměť, jedna instance; restart cache smaže — přijaté riziko max 300 s).

## Přesměrování
- Odchozí volání oběma směry **nesledují přesměrování** (`redirect: 'manual'` → 3xx = chyba). Klíč ani podpis nesmí
  odejít na jiný host.

## Přechod
- Židolišta: env `ZIDOLISTA_INBOUND_SIGNATURE = v1 | any | v2`; UC: env `ZIDOLISTA_INBOUND_SIGNATURE` stejně
  (`any` přijme v1 i v2). Po nasazení obou stran s `any` + klíči v env → přepnout na `v2`.
- UC odchozí: když je `UC_TO_ZIDOLISTA_SIGNING_KEY` nastavený, posílá v2 (všechna volání včetně donations);
  jinak dosavadní v1 u donations.
- Židolišta odchozí: když je `ZIDOLISTA_TO_UC_SIGNING_KEY` nastavený, posílá v2.

## Testovací vektor
- key = `"00".repeat(32)` (hex → 32 nulových bajtů), METHOD `POST`, path `/integrations/rob/gif-used?x=1`,
  t = `1790000000`, nonce = `abcdef0123456789abcdef0123456789`, body = `{"a":1}`
- `signed` = `POST /integrations/rob/gif-used?x=1\n1790000000\nabcdef0123456789abcdef0123456789\n` + hex(sha256(`{"a":1}`))
- Očekávaný HMAC (hex): `cb61b914ef408396607b33abdc35704be697298d9cce2b55bb1727012a237ecb` — obě strany mají v testech.
