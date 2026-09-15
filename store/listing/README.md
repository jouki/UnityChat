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
store/build/unitychat-store-v3.38.58.zip   # tohle se nahrává do dashboardu
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

## Postup první publikace

1. **Developer účet** — jednorázový registrační poplatek $5 na
   [Developer Dashboard](https://chrome.google.com/webstore/devconsole).
   Před publikací je potřeba ověřit e-mail vydavatele.
2. **Build** — `scripts\build-store.ps1`, výsledný ZIP nahrát jako nový item.
3. **Store listing** — texty z `description-cs.md` (výchozí jazyk) a
   `description-en.md`.
4. **Privacy practices** — postupovat podle `privacy-disclosure.md`
   (single purpose, per-permission justifikace, data disclosure checkboxy,
   limited use certifikace, URL privacy policy).
5. **Assets** — podle `assets-checklist.md`.
6. **Visibility: Public**, distribuce všechny regiony.
7. **Submit for review.** Review u rozšíření s širokými host permissions a
   `cookies` obvykle trvá déle než standardní pár dní.

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
