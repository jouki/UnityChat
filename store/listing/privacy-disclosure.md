# Data disclosure — Privacy practices tab

Dashboard má sadu checkboxů „This item collects…". Nedeklarovaný sběr je
důvod k zablokování položky, takže je lepší přiznat víc než míň — ale každé
zaškrtnutí musí sedět s privacy policy na `jouki.cz/UnityChat/privacy`.

## Co rozšíření skutečně posílá mimo prohlížeč

Ověřeno v kódu (`sidepanel.js`, konstanta `UC_API`), tohle jsou **všechna**
volání na vlastní backend:

| Endpoint | Payload | Kdy |
|---|---|---|
| `POST /users/seen` | `{platform, username}` | jednou po detekci **vlastního** jména uživatele na dané platformě (`_syncProfile`, dedup přes `uc_synced` v local storage) |
| `POST /streamers/seen` | `{platform, handle}` | při aktivaci chatu na kanálu — handle sledovaného streamera |
| `GET /streamers/lookup` | query `platform`, `handle` | vyhledání cross-platform mapování kanálu |
| `GET /nicknames`, `GET /nicknames/stream` | — | čtení sdílených přezdívek |
| `PUT /nicknames` | `{platform, username, nickname, color}` | když uživatel někomu nastaví přezdívku |
| `DELETE /nicknames` | `{platform, username}` | smazání přezdívky |

**Chat zprávy se na backend neposílají.** Historie chatu žije výhradně v
`chrome.storage.local` v prohlížeči uživatele.

Mimo vlastní backend jdou požadavky jen na platformy samotné (Twitch, YouTube,
Kick), emote providery a badge API — tam se neposílají žádná data o uživateli
kromě toho, co si daná služba stejně přečte z requestu.

## Checkboxy — jak je vyplnit

| Kategorie | Odpověď | Odůvodnění |
|---|---|---|
| Personally identifiable information | **ANO** | CWS definuje PII včetně *username*. Na backend jde uživatelovo jméno na platformě (`/users/seen`) a jména, kterým uživatel nastavuje přezdívky (`/nicknames`). |
| Authentication information | **ANO** | Definice zahrnuje *authentication cookies*. Rozšíření čte Twitch `auth-token` cookie. Neopouští Twitch, ale reviewer vidí `cookies` permission — nezaškrtnout a nechat ho to objevit je horší varianta. |
| Web browsing activity | **ANO** | `/streamers/seen` posílá handle sledovaného kanálu, což je informace o tom, jakou stránku uživatel sleduje. |
| Website content | **ANO** | Rozšíření čte obsah chatu ze stránek platforem (text zpráv, jména, badge). Zůstává lokálně, ale čte se. |
| Personal communications | **NE** | Rozšíření pracuje s veřejným live chatem, ne se soukromou komunikací (e-maily, DM). Odeslané zprávy jdou na platformu, kam je uživatel sám posílá. |
| Financial and payment information | **NE** | — |
| Health information | **NE** | — |
| Location | **NE** | — |
| User activity | **NE** | Žádné sledování kliků, pohybu myši ani keystroke logging. |

### Doprovodný text k disclosure

```
UnityChat stores chat history locally in the browser only. The extension's own
backend receives three things: the username the user is logged in with on each
platform (so their own messages can be recognised across platforms), the
channel handle of the stream being watched (so the extension knows which
channels it is used on), and any cross-platform nickname the user chooses to
assign to another viewer.

The Twitch auth-token cookie is read only to authenticate requests to Twitch's
own API when the user sends, replies to or pins a message. It is never stored
and never transmitted to any host other than Twitch.
```

## Limited use certifikace

Zaškrtnout všechny tři — odpovídají skutečnosti:

- Použití dat odpovídá deklarovanému single purpose.
- Data se neprodávají třetím stranám ani nepoužívají pro reklamu či hodnocení
  bonity.
- Data se nepoužívají pro nic, co uživatel neschválil.

## Privacy policy URL

```
https://jouki.cz/UnityChat/privacy
```

Stránka je bilingvální (CS/EN, `?lang=en`), live od 2026-06-24. Kontaktní
e-mail na ní je **m.joukal+unitychat@gmail.com** — stejný musí být i jako
support e-mail v listingu, aby si to reviewer spároval.

⚠️ **Před submitem zkontrolovat, že policy pokrývá všechno výše** — hlavně
Twitch auth cookie a `/streamers/seen`. Rozpor mezi dashboard checkboxy a
textem policy je důvod k odmítnutí.
