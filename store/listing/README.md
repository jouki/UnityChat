# Chrome Web Store — podklady pro publikaci

Tahle složka je **zdroj pravdy pro texty do Developer Dashboardu**. Balíček
sám se generuje skriptem, nic tady se do ZIPu nedostane.

## Build

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-store.ps1
```

Výstup (gitignorovaný):

```
store/build/unpacked/                      # pro "Load unpacked" test v Chrome
store/build/unitychat-store-vX.Y.Z.zip     # tohle se nahrává do dashboardu
```

Skript sám spadne, pokud v balíčku přežije cokoli zakázaného (self-update
endpoint, `update.bat`, streamer OAuth, `sidebar_action`, zbylý strip marker)
nebo pokud strip rozbije JS syntaxi (`node --check` na každém skriptu).

### Co store build nemá oproti `extension/`

| Vyříznuto | Proč |
|---|---|
| `_checkForUpdate()` + 15min alarm + update tooltip | CWS zakazuje update mechanismy mimo store (Program Policies) |
| `update.bat` | spustitelný updater |
| `streamer.html/js/css` + tlačítko „Jsem streamer" | streamer OAuth přihlašování se do store verze nepouští |
| `backup.html/js` | není dosažitelné z UI, jen mrtvý kód navíc pro reviewera |
| `sidebar_action` v manifestu | Opera/Firefox klíč, v Chrome balíčku jen šum |
| `alarms` permission | používal ho výhradně update poll |

Auto-switch přes `/streamers/lookup` zůstává — to je čtení veřejného
directory, ne přihlašování.

### Jak funguje stříhání

Ve zdrojích v `extension/` jsou markery, v dev verzi jsou to jen komentáře:

```js
// UC_STORE_STRIP_START: důvod
...kód...
// UC_STORE_STRIP_END
```

V HTML totéž jako `<!-- UC_STORE_STRIP_START: důvod -->`.

**Když přidáváš kód, který nemá jít do store verze, obal ho markerem.**
Pozor na `else if` řetězy — stripnutá větev nesmí nechat osamocené `else`.
Proto je v `_wireBackgroundUpdateListener` větev `UC_UPDATE_*` schválně až na
konci řetězu.

## Stav položky

| | |
|---|---|
| **Item ID** | `picaeipbmkgcippknkpkbnbgjlkblbnp` |
| **Stav** | ✅ **PUBLIKOVÁNO 18. 9. 2026** (odesláno 16. 9., review 2 dny) |
| **Veřejná URL** | https://chromewebstore.google.com/detail/unitychat/picaeipbmkgcippknkpkbnbgjlkblbnp |
| **Verze ve storu** | **3.38.59** |
| **Viditelnost** | Veřejné, všechny regiony, bez poplatků |
| **Jazyk listingu** | čeština |
| **Kategorie** | Komunikace |
| **Publisher e-mail** | `m.joukal+unitychat@gmail.com` (ověřený) |
| **Doména** | `jouki.cz` ověřená v Search Console (TXT záznam na GigaServeru) |

Položka je veřejná i **vyhledatelná** ve storu (ověřeno 18. 9. 2026).

Do pár hodin po publikaci začnou na veřejný kontaktní e-mail chodit **cold
marketingové nabídky** (analytics dashboardy pro vývojáře rozšíření apod.).
Nejsou to phishingy, jen scraping veřejného listingu — proto ten `+unitychat`
alias, jde na ně nasadit jedno filtrovací pravidlo. Metriky, které nabízejí,
už máš v dashboardu pod *Analytics*.

## Postup publikace (prošlé kroky)

1. **Developer účet** — jednorázový registrační poplatek $5 na
   [Developer Dashboard](https://chrome.google.com/webstore/devconsole).
2. **Build** — `scripts\build-store.ps1`, výsledný ZIP nahrát jako nový item.
3. **Store listing** — texty z `description-cs.md` (výchozí jazyk) a
   `description-en.md`. Jako support e-mail zadat
   **m.joukal+unitychat@gmail.com** (stejný, jaký je v privacy policy).
4. **Privacy practices** — postupovat podle `privacy-disclosure.md`
   (single purpose, per-permission justifikace, data disclosure checkboxy,
   limited use certifikace, URL privacy policy).
5. **Assets** — podle `assets-checklist.md`.
6. **Pokyny k testu** (Přístup → Pokyny k testu) — bez nich reviewer uvidí
   prázdný panel. Text v `permissions-justification.md`, limit **500 znaků**.
7. **Visibility: Public**, distribuce všechny regiony.
8. **Submit for review.** Review u rozšíření s širokými host permissions a
   `cookies` obvykle trvá déle než standardní pár dní.

### ⚠️ Past: šedé tlačítko „Odeslat ke kontrole"

Tlačítko zůstává zašedlé **bez ohledu na to, jak kompletně je položka
vyplněná**, dokud není v *Nastavení účtu* zadaný a **ověřený** kontaktní
e-mail vydavatele. Dashboard to neřekne sám od sebe — důvod vypíše až
odkaz **„Kde mohu položku odeslat?"** vedle tlačítka, případně levé menu
→ *Sestavení → Stav*.

### Odkaz pod názvem položky (Oficiální adresa URL)

Rozbalovátko nabízí **jen domény ověřené v Search Console**, konkrétní cestu
tam zadat nelze. Prefix property `https://jouki.cz/UnityChat/` se v Search
Console ověří automaticky (doménový DNS TXT ji pokrývá), ale v CWS dropdownu
se neobjeví — ověřeno 18. 9. 2026.

Řešení: v `nginx.conf` repa `jouki/jouki.cz` je v `location = /` redirect
podle `Referer` z `chromewebstore.google.com` na `/UnityChat`. Klik z listingu
tak končí na install stránce, root zůstává pro ostatní beze změny.

**Adresa URL domovské stránky** je naproti tomu volný text a zobrazuje se
v sekci Podrobnosti — tam patří `https://jouki.cz/UnityChat`.

### Limity polí (naražené v praxi)

| Pole | Limit |
|---|---|
| Popis položky | 16 000 |
| Single purpose, každá permission justifikace | 1 000 |
| **Pokyny k testu → Další pokyny** | **500** |
| URL zásad ochrany soukromí | 2 048 |

## Při každé další verzi

1. Bumpnout `version` v `extension/manifest.json` (store nepřijme stejnou
   nebo nižší verzi než už publikovanou).
2. Spustit build skript.
3. V dashboardu „Package → Upload new package" a znovu submit.
   Listing texty a privacy odpovědi zůstávají — měnit je jen když se
   změní chování rozšíření.

## Navazující kroky (mimo tenhle balíček)

- **Firefox** — `build-store.ps1` je strukturovaný tak, aby šel rozšířit o
  další cíl: `sidebar_action` se pro Firefox naopak ponechává a odstraňuje se
  `side_panel`, MV3 service worker se mění na `background.scripts`.
  addons.mozilla.org navíc vyžaduje zdrojáky, což tady není problém.
- **Opera** — addons.opera.com bere prakticky stejný balíček jako Chrome,
  jen se `sidebar_action` nechává.
- **Mobil** — zásadně jiná architektura, tohle sdílet nebude.
