# Twitch výročí (moderátorské + předplatné) — research spike

Datum: 2026-09-27. Nic se neimplementovalo, nic se neodeslalo na Twitch.

## Zdroje

- Uložená stránka `(24) RobDiesALot - Twitch.html` + `_files/` (build Twitche
  s hashi `21956-986df8…`, `49198-9bc781…`, `core-10ca3f…`).
- Uložené soubory **neobsahují** lazy chunky výzev. Webpack runtime je inline
  v HTML `twitch.tv/robdiesalot` (stejný build, ověřeno podle shodných hashů).
  Z jeho mapy (`b.u=e=>"assets/"+{…}[e]+"-"+{…}[e]+".js"`) se stáhlo všech
  1 654 veřejných chunků z `assets.twitch.tv/assets/` (jen GET statických JS,
  bez přihlášení). Leží ve scratchpadu, v repu nejsou.
- Klíčové chunky:
  - `features.chat-private-callouts.components.chat-private-callout-queue-6c64b4c71b1776b442a7.js`
    (chunk 5587): fronta výzev a dotaz na moderátorské výročí.
  - `73451-c3893656013aa597b70a.js`: komponenty výzev, sdílení mod výročí,
    `Chat_ShareResub_ChannelData`, render `ShareResub`.
  - `61242-b89b972bf99675d78d96.js`: výzva a sdílení resubu.
  - `76892-2024e3d9a6f902d257e9.js`: řádek v chatu `ModiversaryLine`.
  - `71916-3ebb9c93cad7bad03211.js`: dispatch chat událostí.
  - Uložený `49198-*.js`: IRC parser Twitche (USERNOTICE → události).
  - Uložený `21956-*.js`: Apollo linky, persisted queries, Client-Integrity, enumy.
  - `core.locales.cs-3a5f32c1069442cca6ad.js`: české texty.
- GraphQL dokumenty jsou v chuncích jako AST (`kind:"Document"`). Vytiskl jsem je
  přes `graphql@16` `print()` a hash spočítal jako SHA-256 vytištěného textu. Tak
  to dělá Twitch: `createPersistedQueryLink({sha256: e => Bt()(e).toString()})`
  v `21956`, `this.config.graphqlPersistedQueriesAvailable`.

> ⚠️ **Terminologie.** Twitch interně rozlišuje tři věci:
> - **Modiversary** = moderátorské výročí. To je výzva z uložené stránky.
> - **Resub / ShareResub** = měsíční výročí předplatného.
> - **UserAnniversary** = roky (`msg-param-years`), zřejmě výročí účtu na Twitchi.
>   Webový klient ho nepoužívá, viz níže.
>
> Zadání zmiňuje `SendUserAnniversaryNotice`. Ten na uložené výzvě **není**, výzva
> „Blahopřejeme k 1letému moderátorskému výročí!“ patří k **Modiversary**.

---

## 1. Odkud se výzva bere

### 1a. Moderátorské výročí (Modiversary) — JISTÉ

Výzvu nenese PubSub. Při montáži fronty výzev (chunk 5587) se jednorázově pošle
GQL dotaz s kanálem a přihlášeným uživatelem:

```js
// chunk 5587, komponenta Se
const {data:s} = useQuery(ModiversaryStatusQuery, {skip:!e||!t, variables:{channelID:e, userID:t||""}});
useEffect(() => {
  const e = s?.userModiversary;
  if (e && e.hasMilestoneAlert && e.canSendUserNotice && e.months != null && e.months > 0) {
    clearCalloutType(Modiversary); pushCallout({key:uuid(), event:{type:"modiversary", months:e.months}});
  }
}, …)
```

```graphql
# sha256 811a62815487547845c1da820f8f9a927ef90f348bf818b3b6c6753246f3aaa0
query ModiversaryStatusQuery($channelID: ID!, $userID: ID!) {
  userModiversary(channelID: $channelID, userID: $userID) {
    hasMilestoneAlert
    canSendUserNotice
    months
  }
}
```

- Výzva se ukáže jen tehdy, když platí `hasMilestoneAlert && canSendUserNotice && months > 0`.
- Hodnota `months` je **v měsících**. Text se skládá v `$n(months)`: `years = floor(months/12)`,
  `remainingMonths = months % 12`. Zbytek po dělení 12 znamená variantu „N let a M měsíců“.
- UI: ikona meče (`swordIcon--BGB_9`), progress bar 30 s. Po jeho doběhnutí se výzva
  jen skryje přes `popCallout`, mutace se nevolá, takže se při dalším načtení kanálu
  ukáže znovu. Křížek naopak volá `DismissUserModiversaryCallout`.
- Odlišení od resubu: jiný typ výzvy (`"modiversary"` × `"share-resub"` v enumu
  `CalloutType`, chunk `50955`), jiný zdroj dat a jiná ikona (meč × náhodný
  emote „rare-emote“).

### 1b. Výročí předplatného (ShareResub) — JISTÉ

Komponenta v `73451` (modul 193853) používá dotaz `Chat_ShareResub_ChannelData`.
Při každé změně PubSub `subscriptionInfo` volá `refetch()`
(`this.props.pubsub.messages.subscriptionInfo !== e.pubsub.messages.subscriptionInfo && this.props.data.refetch()`).
Když `user.self.resubNotification` existuje, pošle výzvu typu `ShareResub`:

```graphql
# sha256 5a33052c25ecacf09200bd0dfcf15e886d1a4df05948fcf5fea3fb72b939bd5c
# (plný dotaz nese i subscriptionProducts + velké fragmenty; relevantní část:)
query Chat_ShareResub_ChannelData($channelLogin: String!, $giftRecipientLogin: String = "", $withStandardGifting: Boolean = false) {
  user(login: $channelLogin) {
    id
    self {
      resubNotification {
        id
        cumulativeTenureMonths
        months
        streakTenureMonths
        token
        isGiftSubscription
        gifter { id login displayName }
      }
      subscriptionBenefit { id interval { duration } isDNRd }
    }
  }
}
```

- Odmítnutí, připomenutí a připnutí resub výzvy je **jen lokální**, server nic
  neví. Ukládá se do localStorage `shareResubNotificationIDs`
  (`{[id]: {data, timestamp, type: dismissed|lapsed|pinned}}`). Serverová
  dismiss mutace pro resub **neexistuje**.
- Doprovodný dotaz `Chat_ShareResub_CalloutData`
  (`0df4e69dbe3af1989b28f5f680bd928b7f1fa89f837dcbca76665ebec66f9e4c`) načítá jen
  `alertViewerCustomizations`, tedy obrázek a zvuk alertu, které si divák může
  vybrat. UnityChat ho nepotřebuje.

---

## 2. Sdílení

### 2a. Moderátorské výročí — JISTÉ

```graphql
# sha256 9c88807e41898569ff4526052ae554f1fc11c8db070271c1ce8a7a2f354fc4ab
mutation SendUserModiversaryNotice($input: SendUserModiversaryNoticeInput!) {
  sendUserModiversaryNotice(input: $input) {
    modiversary { hasMilestoneAlert canSendUserNotice months }
    error
  }
}
```

Volání z `73451` (komponenta `Qn`):

```js
const t = await c({variables:{input:{channelID:n, noticeMessage:e}}});
if (t.data?.sendUserModiversaryNotice?.error) {
  // ALREADY_SENT → "You've already shared your Mod Anniversary in this channel!"
}
```

- Vstup: `{ channelID: ID, noticeMessage: String }`. Hodnota `noticeMessage` je
  text, který uživatel napsal do input tray.
- Předvyplněný text je `Jn(months)`, česky „Oslavuji #leté moderátorské výročí!“.
  V CS lokalizaci je u let chyba: „Oslavuji #leté **modifikátorské** výročí!“.
- Enum chyb (`21956`): `ALREADY_SENT | NOT_USER_MODIVERSARY | UNKNOWN`.
- Tray je běžné chatové pole (`type: ModiversaryShare`, `sendMessageHandler.type: Custom`).
  Nemá `allowEmptyMessage`, takže prázdná zpráva asi neprojde. **Odhad:** limit
  je běžných 500 znaků chatu. Emoty se píšou jako text, stejně jako v běžné
  zprávě, a Twitch je rozpozná na serveru. V kódu jsem explicitní `maxLength`
  nenašel.

```graphql
# sha256 3db262a9371deb31d414b5558e89d01ab56324baea67620c5dae330927426cf1
mutation DismissUserModiversaryCallout($input: DismissUserModiversaryCalloutInput!) {
  dismissUserModiversaryCallout(input: $input) {
    modiversary { hasMilestoneAlert canSendUserNotice months }
    error
  }
}
```

Vstup: `{ channelID }`. Twitch ho volá jen z křížku, `.catch(() => {})`.

### 2b. Resub — JISTÉ

```graphql
# sha256 f54cd09bc04ee2afbf5bce0ec473a1ba7dfb7771711117affd1c14f2e8105118
mutation Chat_ShareResub_UseResubToken($input: UseChatNotificationTokenInput!) {
  useChatNotificationToken(input: $input) { isSuccess }
}
```

Volání z `61242` (`shareResub`). Helper `g.AR` je `e => ({variables:{input:e}})`:

```js
const n = {
  message: e,                 // text uživatele
  channelLogin: o,
  includeStreak: !!i.opt,     // checkbox „Zobrazit v chatové zprávě mou N měsíční sérii“
  tokenID: r,                 // = resubNotification.id  (POZOR: ne pole `token`)
  selection: …                // volitelně obrázek/zvuk alertu {channelID, alertSetID, sourceAlertViewerCustomizationID, image?, sound?}
};
await this.props.shareResubNotification({variables:{input:n}});
```

- Tray má `allowEmptyMessage: true`, takže resub jde sdílet i bez textu.
  `disableBits: true`, `disableCommands: true`.
- U darovaného předplatného se předvyplní text „Děkuji za dárek, @{gifter}!“.
- Po úspěchu Twitch v Apollo cache nastaví `user.self.resubNotification = null`.

### 2c. UserAnniversary (roky) — ODHAD

- Schéma obsahuje typy `UserAnniversary`, `SendUserAnniversaryNoticePayload` a
  `DismissUserAnniversaryCalloutPayload` (`21956`, type policies).
- **Žádný** ze všech 1 654 chunků webu nemá operaci, která by je používala.
  Web chat IRC `useranniversary` výslovně zahazuje
  (`71916`: `case"useranniversary": … break;`).
- Parser `49198` ho umí (`msg-param-years`). Nejspíš jde o výročí účtu, které
  používá mobilní aplikace, nebo o funkci za flagem. Pro UnityChat to zatím nemá
  smysl.

---

## 3. Jak to vidí ostatní v chatu (IRC USERNOTICE)

### `msg-id=modiversary` — JISTÉ (kód + veřejná dokumentace)

- Parser Twitche (`49198`):
  `handleModiversary: raise("modiversary",{channel, message: createChatMessage(e,r), months: parseInt(tags["msg-param-months"])})`.
- Oficiální dokumentace IRC (Tags → USERNOTICE) má `modiversary` s
  `msg-param-months`: „total number of months the user has been a moderator in this channel“.
- EventSub `channel.chat.notification` má `notice_type: modiversary`.
- Text uživatele (`noticeMessage`) přijde jako trailing část USERNOTICE,
  stejně jako u resubu (`:tmi… USERNOTICE #kanál :text`). Emoty jsou v tagu
  `emotes`. Zbytek (`display-name`, `color`, `badges`, `user-id`, `login`,
  `tmi-sent-ts`, `id`, `system-msg`) je standardní USERNOTICE.
- Render na webu (`76892`, `ModiversaryLine`): zvýrazněný řádek s barvou
  `#00AD03` (zelená), ikona meče, jméno a text
  - `months % 12 == 0`: „je už **# rok** moderátorem!“ / „je moderátorem už **# roky/let**!“
  - jinak: „je už **# měsíc/měsíce/měsíců** moderátorem!“

  Pod tím je volitelně vložená zpráva uživatele (`chat-line--inline`, bez reply).
- Web si `system-msg` skládá sám (`has been a moderator for ${months} months in this channel!`),
  tag z IRC nepoužívá.
- Ve sdíleném chatu (`sharedchatnotice`) se `modiversary` **nepřeposílá**.
  Seznam `source-msg-id` v `49198` ho neobsahuje: announcement, anongiftpaidupgrade,
  bitsbadgetier, charitydonation, communitypayforward, giftpaidupgrade,
  primepaidupgrade, raid, resub, standardpayforward, sub, subgift,
  submysterygift, unraid, viewermilestone.

### `msg-id=resub` — JISTÉ

Sdílený resub je obyčejný `resub` USERNOTICE s textem uživatele. Nese
`msg-param-cumulative-months`, `msg-param-should-share-streak`,
`msg-param-streak-months`, `msg-param-sub-plan` a další. UnityChat ho už
zpracovává (`extension/core/twitch-irc.js` ř. 209–243, `isSubEvent`).

### Stav v UnityChatu

- `core/twitch-irc.js` zná `raid`, `sub/resub`, `submysterygift`, `subgift`,
  `viewermilestone` a `announcement`. **`modiversary` nezná**, taková zpráva se
  dnes nevykreslí vůbec.
- Nezná ani `sharedchatnotice`, ale to je samostatné téma.

---

## 4. Autentizace

- Všechny tři mutace i dotazy jsou **interní GQL** (`gql.twitch.tv/gql`), ne Helix.
  Potřebují first-party token uživatele: `Authorization: OAuth <auth-token cookie>`
  a `Client-Id: kimne78kx3ncx6brgo4mv6wki5h1ko`. Stejný vzor addon používá v
  `background.js` u `fetchPins` / `CHECK_PIN` / `PIN_MESSAGE`.
- **Helix ekvivalent neexistuje.** EventSub/Helix modiversary jen *hlásí*
  (`channel.chat.notification`). Endpoint pro sdílení resubu ani mod výročí není.
  Helix `POST /chat/messages` pošle jen obyčejnou zprávu, ne USERNOTICE.
- OAuth token z webu (`user:write:chat`) proto pro GQL nepůjde. GQL s tokenem
  třetí strany Twitch nepřijímá.
- Addon posílá plný text dotazu (`query:`), ne persisted hash. Tak to funguje
  u `GetPinnedChat`. Hashe výše jsou jen pro úplnost a pro případ, že by Twitch
  začal vyžadovat persisted queries.

## 5. Client-Integrity

Z `21956`:

- Hlavička `Client-Integrity` se přidá ke **každému** GQL požadavku, pokud má
  klient uložený token a je zapnutý flag `cit_gql_rollout`:
  `const E=this.integrity.getStoredToken(); E&&(0,ce.fX)("cit_gql_rollout")&&(r["Client-Integrity"]=E);`
- Jinak ji server vynutí **challengí v odpovědi**:
  `response.extensions.challenge.type === "integrity"`. Klient pak zavolá
  `integrity.fetchNewToken("gql-challenge")` a operaci zopakuje s hlavičkou. Další
  typ je `challenge-gates` (ověření telefonu atd.).
- Pevný seznam operací, které integritu vyžadují, v klientovi **není**. Rozhoduje
  server u každé operace zvlášť. Jediná pevná sada `sr = {"PlaybackAccessToken",
  "sendChatMessage", "sendGifMessage"}` říká jen, co se neposílá v batchi.
- **Nevím, jestli `SendUserModiversaryNotice` / `useChatNotificationToken` vrací
  integrity challenge.** Musí se to ověřit prvním reálným pokusem. Poznáme to
  podle `extensions.challenge.type` v odpovědi, ne podle HTTP chyby. Pro srovnání:
  `PinChatMessage` z addonu prochází, u `GetPinnedChat` blokovalo jen pole `emoteID`.
- Instrumentace při implementaci: logovat celé `extensions` a `errors` odpovědi
  (UC_LOG tag např. `Anniv`). Integrity token z extension kontextu získat neumíme,
  takže challenge = fallback na DOM.

---

## Co je jisté × odhad

| Tvrzení | Stav |
|---|---|
| Moderátorská výzva = `ModiversaryStatusQuery` při načtení, podmínka `hasMilestoneAlert && canSendUserNotice && months>0` | jisté (kód) |
| Sdílení mod výročí = `SendUserModiversaryNotice {channelID, noticeMessage}`, chyby ALREADY_SENT / NOT_USER_MODIVERSARY / UNKNOWN | jisté (kód) |
| Zavření = `DismissUserModiversaryCallout {channelID}` | jisté (kód) |
| Resub výzva = `user.self.resubNotification` (refetch při PubSub subscriptionInfo) | jisté (kód) |
| Sdílení resubu = `useChatNotificationToken {channelLogin, message, includeStreak, tokenID=resubNotification.id, selection?}` | jisté (kód) |
| Resub dismiss jen lokálně (localStorage) | jisté (kód) |
| Ostatní vidí `USERNOTICE msg-id=modiversary` + `msg-param-months` + text | jisté (kód + dokumentace) |
| Modiversary se nepřeposílá do shared chatu | jisté pro klienta (switch), server neověřen |
| SHA-256 hashe | spočítané ze stejného buildu stejnou metodou jako Twitch; proti živému serveru neověřené (addon je nepotřebuje) |
| Limit délky `noticeMessage` = 500 | odhad |
| Mutace nevyžadují integrity | **neznámé**, nutný živý test |
| UserAnniversary = výročí účtu, na webu nepoužité | odhad |

---

## Doporučení pro addon

**Primárně GQL z `background.js`** (vzor `fetchPins`), fallback přes DOM.

1. **Detekce** (panel otevřený na Twitch kanálu, přihlášený uživatel):
   - Mod výročí: `userModiversary(channelID, userID)`. `channelID` = room-id
     z ROOMSTATE, `userID` = vlastní ID (GQL `currentUser { id }` nebo `user-id`
     z vlastní zprávy). Dotaz stačí při přepnutí kanálu, Twitch ho také nepolluje.
   - Resub: `user(login) { self { resubNotification { id cumulativeTenureMonths streakTenureMonths isGiftSubscription gifter { displayName } } } }`.
     Stačí malý dotaz, celý `Chat_ShareResub_ChannelData` není potřeba. Obnovit
     při přepnutí kanálu, případně v pomalém intervalu (Twitch reaguje na PubSub,
     který addon neposlouchá).
2. **UI v panelu**: vlastní karta nad inputem („Blahopřejeme k N-letému
   moderátorskému výročí!“ / „Máte N měsíční výročí předplatného!“) s tlačítkem
   Sdílet a křížkem. Sdílet vloží do inputu předvyplněný text a přepne composer do
   režimu „sdílení výročí“. Odeslání pak nepůjde přes `/chat/send`, ale přes
   příslušnou mutaci. U resubu přidat checkbox série (`includeStreak`)
   a povolit prázdnou zprávu.
3. **Odeslání**: nové zprávy v background, např. `TW_MODIVERSARY_SHARE`,
   `TW_MODIVERSARY_DISMISS` a `TW_RESUB_SHARE`, s raw `query` a `variables`
   (parametrizované, podle bezpečnostního pravidla v3.23.7). UC marker (U+2800)
   k `noticeMessage` / `message` **nepřidávat**, dokud se neověří, že ho Twitch
   nezahodí nebo neodmítne. Rozhodne user.
4. **Kontrola odpovědi**: `error` (ALREADY_SENT → hláška „Své moderátorské výročí
   jste již v tomto kanálu sdíleli!“), `isSuccess`, `extensions.challenge`
   (integrity → fallback na DOM + log).
5. **Resub dismiss**: jen lokálně v addonu (`chrome.storage.local`), stejně jako Twitch.
6. **Fallback přes DOM** (když GQL vrátí integrity challenge): content script
   `content/twitch.js` najde
   `[data-test-selector="chat-private-callout__hover-container"]`,
   klikne `button[data-a-target="chat-private-callout__primary-button"]` a do
   otevřeného input tray vloží text stejnou cestou jako `sendChat` (Slate paste
   + ověření). Křehké: výzva zmizí po 30 s progress baru, 7TV přestavuje chat
   a chat musí být otevřený. Proto jen jako záloha.
7. **Zobrazení cizích výročí** (nezávisle na sdílení, nejlevnější a nejužitečnější
   krok): do `core/twitch-irc.js` přidat větev `msg-id === 'modiversary'` →
   `{isModiversary: true, modMonths: parseInt(tags['msg-param-months'])}` + text
   z trailing části. Render ve stylu Twitche: zelený akcent, meč, „je už N let
   moderátorem!“ podle pravidla `months % 12 == 0` → roky, jinak měsíce, a pod
   tím zpráva. Protože jde o core, dostane to i web. Backend ingest ukládá
   USERNOTICE zatím jen částečně (CLAUDE.md: „USERNOTICE (raid/sub) se zatím
   neukládá“), historie tedy modiversary mít nebude, dokud se ingest nerozšíří.

## Doporučení pro web

- **Sdílení nejde.** Web má jen Helix OAuth tokeny (`web_identities`), GQL
  mutace chtějí first-party `auth-token` Twitche. Helix nemá ekvivalent.
  Webová karta výročí by maximálně odkázala na Twitch („Sdílet na Twitchi“).
  Nedoporučuju ji vůbec ukazovat, protože detekce také potřebuje GQL s cookie.
- **Zobrazení ano**: sdílený parser v `core/twitch-irc.js` (bod 7) + render
  v `core`. Pro web je to zadarmo, jakmile ho má addon. Živé zprávy na webu jdou
  přes `/chat/stream` z backendového ingestu, takže `backend/src/ingest/twitch.ts`
  a `normalize.ts` musí `modiversary` také propustit.
- Podle pravidla portování se user musí před implementací rozhodnout:
  zobrazení v core (addon + web), sdílení jen v addonu.
