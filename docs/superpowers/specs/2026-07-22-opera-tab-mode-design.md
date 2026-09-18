# Opera tab mode + stream-tab detection fix (v3.38.56)

Datum: 2026-07-22 · Stav: schváleno uživatelem (bez detailního čtení, doporučené volby)

## Cíl

Opera setup se split screenem (stream tab vlevo, UnityChat tab vpravo) musí fungovat:
chat se otevírá jako **tab** (ne popup okno), best-effort se groupne se stream tabem,
a přestane "šedivět" když stream tab není aktivní.

## Rozhodnutí (AskUserQuestion wizard)

1. **Split poměr**: taby + ruční divider v Opeře. Extension poměr neřeší (Opera Split
   Screen nemá extension API).
2. **Grouping**: best-effort přes `openerTabId` + `index` vedle stream tabu (Opera
   auto-vytváří tab islandy z related tabů; `chrome.tabGroups` v Opeře neexistuje).
3. **Send target**: aktivní tab → fallback URL-scan přes všechny taby, sticky poslední
   aktivní platforma.
4. **Scope**: tab-open jen Opera. Chrome si nechá nativní side panel. URL-scan fix
   platí všude.

## Změny

### background.js — Opera tab open
- `!HAS_SIDE_PANEL` path (toolbar action + `OPEN_SIDE_PANEL`/`TOGGLE_SIDE_PANEL`
  fallback): místo `chrome.windows.create({type:'popup'})`:
  1. `chrome.tabs.query` na `chrome.runtime.getURL('sidepanel.html')` — existuje-li
     tab, fokusnout (tabs.update active + windows.update focused), nevytvářet duplicitu.
  2. Jinak `chrome.tabs.create({ url, openerTabId: streamTab?.id, index: streamTab.index+1 })`.
     Stream tab = `sender.tab` (klik z chat header buttonu) nebo aktivní tab posledního
     normal okna, případně URL-scan.
- Opera `sidebar_action` i Chrome side panel beze změny.

### sidepanel.js — `_findStreamTab(platform?)`
Nový helper, nahrazuje přímé `_getActiveBrowserTab()` v detekci/odesílání:
1. Aktivní tab je platform stránka (twitch.tv / kick.com / youtube.com) → použít
   (dnešní chování).
2. Jinak `chrome.tabs.query({})` → filtrovat platform URL, matchovat proti
   nakonfigurovaným kanálům (`channel`, `ytChannel`). Sticky: pokud `activePlatform`
   má živý tab, držet; jinak pořadí twitch → kick → youtube.
3. Nic → `null` → zašednutí (správně, žádný stream neběží).

Konzumenti: `_detectActivePlatform` (3s loop), `_sendMessage` (send protection +
send — s parametrem platformy, aby zpráva šla do tabu správné platformy), user card.

### Instrumentace (pravidlo č. 1 — Opera netestovatelná lokálně)
- UC_LOG tag `StreamTab`: zvolený tab, důvod (active/scan/sticky), fallback path.
- UC_LOG v background tab-open path: existující vs. nový tab, openerTabId.
- Cleanup po user potvrzení v Opeře.

## Mimo scope
- Poměr split screenu (ruční divider).
- `chrome.tabGroups` (v Opeře není).
- Chrome tab-open volba.

## Rizika
Minimální: Chrome path beze změny, Opera sidebar beze změny. URL-scan jen přidává
chování tam, kde dnes vrací `null`.
