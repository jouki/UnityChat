# UnityChat - Verzový changelog / archiv

> Historický archiv verzových milestones. Aktivní milestones (v3.31.0+) jsou v `CLAUDE.md`. Sem se přesouvají starší záznamy když `CLAUDE.md` překročí performance threshold (~40k znaků).
>
> **Pravidlo logování:** Při každé aktualizaci dokumentace (CLAUDE.md, memory files, architektury, release) přidat krátký záznam do sekce **Changelog dokumentace** dole. Cíl: mít nezávislý audit trail změn, které nemusí být vždy vázané na commit (např. restrukturalizace memory, oprava stale poznámky, přesun milestones).

---

## Archivované verzové milestones (v1.x – v3.30.3)

- **v1.x** - základní 3 platformy, 7TV emoty, side panel
- **v2.0** - hover replies, mention highlight, reply context
- **v2.5** - skutečné Twitch badge images, native reply via GQL
- **v3.0** - GQL endpoint místo Helix (auth-token cookie), draggable user card fallback
- **v3.3** - User card v chatter listu, 7TV custom element discovery
- **v3.5** - Layout sizes, smooth scroll, accent gradient, BETA tag
- **v3.6** - Pin message + GQL mutace
- **v3.7** - Klikatelné reply context + flash animace, raid notifications, first-msg
- **v3.8** - Pinned banner s polling detekcí unpinu
- **v3.9** - Autocomplete arrow keys + scroll only when overflowing
- **v3.10** - Twitch chat scrape + boundary detection
- **v3.11** - Opera verze + Opera-compatible active tab detection
- **v3.12** - Pop-out button, platform badge tooltipy, single-source `extension/` (chrome+opera merge), build script, backend scaffold (Node.js + Fastify + Drizzle + Postgres)
- **v3.12.2** - Unified `extension/` bez build kroku: jeden `manifest.json` + `background.js` s runtime `HAS_SIDE_PANEL` feature-detection. Chrome používá native side panel, Opera spadne na popup window. Load unpacked z `extension/` přímo v obou browserech, žádné build skripty, žádný `dist/`.
- **v3.12.3** - Platform badge tooltip přepsán na JS-positioned `.uc-tooltip` s viewport clamping (fix pro ořez u okrajů side panelu).
- **v3.12.4** - Opera native sidebar support přes `sidebar_action` manifest key. Opera users si teď mohou připnout UnityChat přímo do Opera levého sidebaru (vedle Messenger/Twitch/atd.). Chrome ignoruje unknown key, používá dál `side_panel`. Popup window fallback zůstává pro Operu jako sekundární entry point.
- **v3.12.5** - Twitch chat header button (UnityChat logo v chatu, klik otevře side panel), `OPEN_SIDE_PANEL` background handler s user-gesture propagací, `web_accessible_resources` pro ikony. jouki.cz/UnityChat install page: hero s 512px brand logem, funkční platform filtry v preview mockupu, click-to-play audio na StreamElements zprávě, animované FAQ, click-to-copy chrome:// URL.
- **v3.13–v3.18** - Nickname system (SSE real-time push, DB), per-channel cache (72h TTL), dev mode, @username auto-suggest, per-platform username tracking, YouTube username detekce, optimistic messages, UC button na YouTube, per-platform colors
- **v3.18.26** - Optimistic → real message upgrade (`_upgradeOptimistic`), `_savePlatformColor` jen pro vlastní zprávy, emotes+badges load PŘED cache
- **v3.18.29** - Settings UI: merged save button pro nickname+color, readonly username (dev mode), depersonalizované placeholdery, autocomplete=off, status dot tooltipy, odstraněn "Vše" filtr
- **v3.18.35** - Twitch display-name z IRC (ne login cookie), color save fix, backend rate limit 10s
- **v3.18.38** - Nickname lookup pro VŠECHNY zprávy (ne jen UC-marked)
- **v3.19.0** - Message history (ArrowUp/Down jako terminal, max 50, draft preserved)
- **v3.19.1** - Optimistic badges z posledních známých badges uživatele
- **v3.19.6** - Copy button (SVG clipboard ikona, trailing space pro emote stacking)
- **v3.19.7–v3.19.14** - 7TV zero-width emote layering (CSS grid stacking, lookahead pro whitespace)
- **v3.20.0** - StreamElements !command autocomplete (SE public API), bulgarians easter egg (click-to-play audio)
- **v3.20.1** - Tab autocomplete: první TAB potvrdí výběr, pak cykluje
- **v3.20.2** - IRC ACTION (/me) parsing — kurzíva + barva usernamu
- **v3.21.0** - Right-side message tags (Replying to you, Mentions you, First, Raid, Raider, Sus), /uc mock commands
- **v3.21.2** - Scraper DOM walker — extrahuje emote alt text pro správný content dedup
- **v3.21.4** - Raider tag color: yellow-green (#b2e63d)
- **v3.21.5** - Raider background+border shift to yellow-green
- **v3.21.6** - `/uc` command autocomplete (raid, raider, first, sus)
- **v3.22.0–v3.22.5** - UC button toggle (open/close side panel), YouTube native theater button, port-based panel state tracking, window.close() via port
- **v3.23.0** - UnityChat custom emotes (`ucEmotes` Map, first: CaneBear), preview Fremaner message
- **v3.23.1** - Retroactive color update po save, Ko-fi link, active-badge styling, nickname API normalizace
- **v3.23.2–v3.23.3** - Profile sync (`_syncProfile`), `seen_users` tabulka + `POST /users/seen` endpoint, `_syncedProfiles` Set s local dedup (`uc_synced` v chrome.storage.local)
- **v3.23.4–v3.23.6** - YouTube username detekce: avatar menu click fallback (klik avatar → `#channel-handle` → Escape), content script cache per URL s `MutationObserver` + `popstate` invalidací, settings UI refresh při async příchodu platform username
- **v3.23.7** - Security hardening: GQL parameterized variables, createElement/textContent místo innerHTML, Kick send přes background `KICK_SEND` + executeScript (ne inline `<script>`), YouTube postMessage se specifickým origin, `CSS.escape()` pro username selektory, `_sc()` sanitizace barev, UC_API na `https://api.jouki.cz`, odstranění raw IP z host_permissions
- **v3.23.8–v3.23.10** - Color UI: "Barva jména (platform)" label, `_refreshColorUI(platform)`, `_platformDefaultColor(platform)` (YT default #ff0000), custom color → real value / no custom → placeholder s default hex, `_upgradeOptimistic` zachovává UC custom color
- **v3.23.11** - `GET /users` merged endpoint (seen_users + nicknames), `backend/src/routes/users.ts`
- **v3.23.12** - Backup utility (`extension/backup.html` + `backup.js`): export/import chrome.storage sync+local, external JS (MV3 CSP), export přes chrome.downloads API (saveAs dialog)
- **v3.23.13** - Profile sync s local dedup + merged users endpoint, repo public
- **v3.24.0–v3.24.18** - Streamer Directory fáze 2–5: backend schema (`streamers`, `streamer_tokens` AES-256-GCM, `streamer_sessions`), OAuth flow pro Twitch + YouTube (Google) + Kick (PKCE), public lookup + seen + private `/me`/unlink/logout endpointy, extension "Jsem streamer" page s Link/Unlink UI, auto-switch na změnu tab URL (extension sleduje usera napříč streamery); extracted landing pages do private `jouki/jouki.cz` repo (workflow `trigger-jouki-cz.yml` z UnityChat pushu)
- **v3.24.19** - YouTube auto-switch funguje na `/watch` live stream stránkách (content script resolvuje channel handle z DOM: `ytd-video-owner-renderer a[href^="/@"]` + JSON-LD fallback); sidepanel použije `resp.channelHandle` jako fallback když URL parsing selže
- **v3.24.20** - Reset `@mention` autocomplete na auto-switch: `_performAutoSwitch` smaže plain-key entries z `_chatUsers` (ale zachová `platform:username` color cache)
- **v3.24.21** - Twitch default color palette (15 colors, Chatty-style `(firstChar + lastChar) % 15` hash) místo flat `#9146ff` pro colorless usery
- **v3.24.22** - Twitch chat colors z GQL: batched `user(login:) { chatColor }` query v `GET_CHAT_COLORS` background handleru, retint DOM přes `data-username` selektor. `_fromGQL: true` flag v `_chatUsers` zabraňuje aby další IRC hash-fallback zprávy clobbernuly resolvnutou barvu
- **v3.24.23** - Twitch Announcement render (`USERNOTICE msg-id=announcement`): parsed message body, `msg-param-color` (PRIMARY|BLUE|GREEN|ORANGE|PURPLE), bilateral gradient border (PRIMARY duhový rainbow), pulsující megafon ikona, color-tinted glow
- **v3.24.24** - Color preservation fix (`_fromGQL` přes nové zprávy zachován) + 72h message cache (age-based prune místo 200 count cap) + `maxMessages` bumpnut 500→5000 s migrací + prominentní announcement (bilaterální border-image, pulse)
- **v3.24.25** - 7TV paints na Twitch nicknamech (LINEAR_GRADIENT, RADIAL_GRADIENT, URL paints + drop-shadows). GQL bulk query `{ cosmetics { paints { ... } } }` načte všech ~1000 paintů najednou (per-paint REST endpoint 404s); per-user paint ID z `/v3/users/twitch/{userId}` cached v `_chatUsers._paint`
- **v3.24.26** - 7TV paints retroactive pro cached/scraped zprávy: `fetchChatColors` rozšířený o `user.id`, `_flushColorLookups` triggerne paint lookup pro všechny userId
- **v3.24.27** - `@mention` v textu zprávy bold + colored target user's chat color (`_processMentions` walker v `.tx` po emote renderu)
- **v3.24.28** - Settings: timestamp toggle (`body.no-timestamps .ts { display:none }`)
- **v3.25.0–v3.25.7** - Update notification UI: červená pulsující tečka na logu (ne v toolbaru), tooltip anchored left (max-width `min(300px, calc(100vw - 24px))`), template v HTML, logo-wrap s dot+tooltip, cursor revert na default v tooltipu + link hover color feedback
- **v3.25.8–v3.25.10** - Browser action badge (`chrome.action.setBadgeText`/`setTitle`), speech-bubble arrow (2 stacked triangles outside tooltip), 10s auto-reveal s countdown barem (scaleX origin-left), layout-scaled tooltip přes `--ut-scale` CSS variable (1 / 1.1 / 1.22)
- **v3.26.0** - Periodic update poll: `chrome.alarms` 15min interval v background, broadcasts `UC_UPDATE_AVAILABLE` message do sidepanelu (auto-reveal jen na false→true); loading overlay: pulsující logo + radial glow + animované "Načítání chatu…" + 3 platform pills (pulse → brand gradient při connected) + bouncing bar
- **v3.26.1** - Channel switch recykluje boot loading overlay; per-user 7TV emote loadouts (cross-channel personal emotes, retroactive re-render); fulltext toggle v emote autocomplete; emote hover preview (220ms intent) + click-pinned detail card s lazy-fetch metadata (owner, added date, external link)
- **v3.26.2** - Twitch mod actions: CLEARCHAT (timeout/ban) + CLEARMSG (single delete) parser, greyed out + italic line-through + red pill label ("Timeout (10m)" / "Permanently banned" / "Deleted by mod"), persisted v `_cleared` field v cache
- **v3.26.3** - "Added by" row v 7TV emote preview (actor_id + timestamp z emote-set entries, cached přes `fetch7tvUser`); auto-scroll race fix (`_programmaticScrollUntil` 150ms window suprimuje scroll events z vlastního scrollu)
- **v3.26.4** - Chat vibration fix na rychlém chatu: `scrollbar-gutter: stable` + `overflow-anchor: none` na `#chat`, `contain: layout style` na `.msg`, `min-width: 1.75em` placeholder na emote `<img>` aby inline flow reservoval prostor před image decodem.
- **v3.26.5** - Twitch badge tooltips: IVR badge API vrací `title` field (např. "Moderator", "1-Month Subscriber"). `_twitchBadges` teď ukládá `{url, title}` místo plain URL, badge img renderuje přes `data-tooltip` custom tooltip selector (`.pi, .bdg-img`) místo nativního `title` atributu.
- **v3.27.0** - **Sub / gift / redeem / highlight events**: USERNOTICE `msg-id=sub`, `resub`, `subgift`, `submysterygift` parsers + dedicated renderers (`_renderSubEvent`, `_renderGiftEvent`, `_renderRedeemEvent`). Gift bundle = purple pill s `×N` counter; individual subgifts = compact line s "Gifted a Tier N Sub to {recipient}"; subs = "Subscribed with Tier/Prime + N months + N months in a row" + optional attached message; redeem = IRC PRIVMSG s `custom-reward-id` tagem → isRedeem flag + rewardName placeholder. Each has bilateral purple-accent CSS + glow.
- **v3.27.1** - **Readability color boost**: `readableColor(hex)` pro `.un` usernames — HSL L clamp do [0.5, 0.88] + WCAG-aware minL bump (0.78 pro pure blue, 0.65 pro dark colors) — mirror Twitch's vanilla "readable colors" behavior. Memoized cache.
- **v3.27.2** - **DOM color lookup**: content script handler `GET_DOM_COLORS` scrapuje `.seventv-chat-user` nebo `.chat-author__display-name` inline styly. `_flushColorLookups` teď nejdřív zkusí open Twitch tabs (free, matchuje přesně co vanilla Twitch+7TV renderuje) a jen neresolved jména padají na GQL batch fallback.
- **v3.27.3** - **Mod actions**: CLEARCHAT (timeout/ban) + CLEARMSG (single delete) IRC parsers. `_applyTwitchClear` / `_applyTwitchClearMsg` → greyed out + italic + line-through + red pill label ("Timeout (10m)" / "Permanently banned" / "Deleted by mod"), `_cleared` field perzistuje v cache.
- **v3.27.4** - **Reply emote fix** + **hide-not-collapse**: reply messages strip `@username ` prefix → IRC emote positions nesedí na trimmed body. Nový `twitchEmotesOffset` field + `_splitTwitchEmotes(text, tag, offset)` přepočítává pozice. Plus: UC button teď nepoužívá Twitch's vestavěný collapse (unmountne `.chat-shell` → kills DOM mirroring), místo toho inject `<style width:0 + visibility:hidden>` na right column → chat DOM zůstává live.
- **v3.27.5** - **Optimistic message badges**: na `_upgradeOptimistic` vždy nahradit `.bdg` set z IRC echa (předtím guard `!el.querySelector('.bdg')` blokoval nahrazení stale sady z prev-channel cache).
- **v3.27.6** - **--with-chat BEM strip**: při hiding chat column odstranit `channel-root__player--with-chat` a `channel-root__info--with-chat` modifiers (jinak zůstane vyhrazený prostor pro chat vedle videa). MutationObserver re-stripuje přes SPA nav, cleanup na chat restore.
- **v3.28.0** - **Community highlights mirror** (hype train, gift leaderboard, pinned message) + **Sbalit intercept**: content script MutationObserver na `.community-highlight-stack__card`, relayuje `TW_HIGHLIGHTS` cards do sidepanelu (kind heuristic — hype-train / gift-leaderboard / raid / generic). Sidepanel renderuje `#highlights-banner` nad chat. Capture-phase click na `[data-a-target="right-column__toggle-collapse-btn"]` (nativní Sbalit) přesměruje na náš soft-hide.
- **v3.28.1** - **Dedupe IRC+DOM redeems**: IRC PRIVMSG redeem (s `custom-reward-id` UUID) + DOM mirror (reward name + cost) emitovaly duplicity. Teď DOM redeem hledá nedávný (<10s) IRC redeem od stejného usera a **upgraduje** mu reward name + cost in-place místo duplicity. Plus fix DOM extractor: odmítne container nodes s >1 chat-line descendant nebo inline message body.
- **v3.28.2** - **@mention color pro unspoken users**: `_processMentions` enqueue-uje `_enqueueTwitchColorLookup` pro jména co ještě nejsou v `_chatUsers` mapě. `_flushColorLookups` retintuje `.mention[data-mention-user="X"]` spans (v obou DOM i GQL větvi).
- **v3.28.3–v3.28.4** - **Top-nav restore button**: speech-bubble icon injectnutý do `.top-nav__actions` (fallback walk-up z `[data-a-target="user-menu-toggle"]`), objeví se když UC schoval chat, klik revertuje hide. MutationObserver re-injectuje přes SPA nav.
- **v3.28.5** - **Scrape backfill**: `_scrapeExistingChat` odstraněný 120s cache-skip (loss gapů messages) + boundary detection iteruje **start→end** místo end→start (earliest suffix match místo latest) — nevynechá messages mezi dvěma identickými user-pair occurrences.
- **v3.28.6** - **Rich diagnostics dump**: 💾 button attach rich `DIAG` section do debug log — version, config, provider state, cache sizes, per-rendered-user color/paint/userId/_fromGQL stav, chrome.storage.local.uc_user_colors slim, live Twitch DOM color snapshot per open tab, last 30 cached messages s flags.
- **v3.28.7** - **Log persistence**: MV3 service worker spí → `_logs[]` array se ztratí. Persist do `chrome.storage.session` + hydrate při čtení/zápisu. Plus fix race: sidepanel čeká na `UC_LOG` round-trip ack před `DUMP_LOGS` (jinak file write race-loses).
- **v3.28.8** - **Color/paint state preservation**: GQL fallback path nastavoval `_fromGQL: true` i když GQL vrátil null color (drží raw IRC). `_enqueueTwitchColorLookup` pak skip forever → self-perpetuating stuck. Teď `_fromGQL: !!color`. Plus hydration cleanup: na startup invalidace `_fromGQL` pro entries kde color je raw hex — recovery z předchozích buggy buildů. Plus `readableColor` používá WCAG luminance pro per-hue boost (pure blue pushuje na L=0.78 stejně jako Twitch).
- **v3.28.9** - **Strip redeem cost digits from reward name**: Twitch textContent concatenuje reward + cost bez separatoru (`"Cult's Totem500"`), regex pobere vše za "redeemed", pak z konce odpáruje digit run (s optional bullet icon) jako cost.
- **v3.28.10** - **Bare-name mention coloring**: pass 2 v `_processMentions` tokenizuje slova 3-25 chars a wrapuje do `.mention.bare` pokud existují v `_chatUsers`. Známí chatters se zbarví i bez `@` prefixu; generic slova se nezmíní.
- **v3.28.11** - **Dedupe highlights snapshot**: `snapshotHighlights` queryoval 4 overlapping selektory, stejný element matchnul několik → "Pořiďte si předplatné" se v banneru zobrazilo 3×. Teď collect kandidátů first, drop ancestors, then text-level dedup.
- **v3.28.12–v3.28.13** - **Shrink OG Twitch face emotes**: `:)`, `:D`, `:O`, `<3`, `O_o` atd. (Global Emotes panel) jsou tiny-resolution originály → upscale rozmazává. Detekce podle NAME (stable přes ID renumbering; `<3` měl low ID ale teď 555555584) + Twitch CDN guard (BTTV/FFZ/7TV se stejným jménem nejsou shrunk). CSS `.emote-tiny` height 1.25em.
- **v3.29.0** - **2x emote variants**: default 1x CDN size scalovalo blurred na hi-DPI. Switched Twitch → `/2.0`, BTTV → `/2x`, FFZ → `urls['2']`, 7TV → `2x.webp`, graceful fallback na 1x pokud 2x nedostupné.
- **v3.29.1** - **Neverdowngrade DOM-resolved color**: druhá `_chatUsers.set` cesta (IRC echo) taky spreadovala prev ale reset color na `msg.color` (raw IRC). Teď `color: prev?._fromGQL ? (prev.color || msg.color) : msg.color` v obou cestách + v `_upgradeOptimistic`.
- **v3.29.2–v3.29.3** - **Smaller hover actions + no native emote tooltip**: `.msg-actions` cluster `26×24 → 20×18`, SVG `14px → 11px`, floatnut nad řádkem (`top: -14px`) aby nepřekrýval emoty pod hoverem. Plus `<img class="emote">` odebráno `title` atribut (custom hover preview už pokrývá funkci).
- **v3.29.4** - **Two unstuck color paths**: GQL fallback setoval _fromGQL true i když GQL vrátil null (recurring bug), + hydrate cleanup + bigger emote heights (small 2em / medium 2.25em / large 2.5em) — matchne Twitch ~28px renderovaných emotes.
- **v3.30.0** - **Prominent RAID callout + expanded /uc mocks**: `.msg.raid` dostal bilaterální gradient border (orange→red→yellow), glow, header s pulsujícím rocket + RAID label + viewer count pill. `/uc` mockups rozšířené o `announcement [color]`, `sub`, `resub`, `subgift`, `giftbundle [N]`, `redeem [name] [cost]`, `highlight`, `timeout [s]`, `ban`, `delete`.
- **v3.30.1–v3.30.2** - **Prime sub differentiation + Tier 1/2/3 polish**: `subPlan === "Prime"` → crown SVG + "Prime" label (cyan/blue gradient) + Twitch-Prime `#00adef` background. Tier 1/2/3 subs dostali stejný bilaterální border + glow jako Prime; Tier 2 cyan, Tier 3 zlatý, Tier 1 purple. Mocks `/uc prime`, `/uc sub2`, `/uc sub3`.
- **v3.30.3** - **Hide hover actions on system events**: raid/sub/gift/redeem/announcement jsou system events — copy/reply/pin cluster je nerelevantní (IRC neakceptuje reply na USERNOTICE).
- **v3.31.0** - **Twitch credits mirror** (bits + channel-points balance): content script scrapuje `.community-points-summary` (bits + points + custom icon) a emituje `TW_CREDITS`. Sidepanel renderuje footer pill row nad input area. Channel-scoped. Plus **periodic color revalidation**: hash-default colors se mění mezi sessions (F5 změní seed), takže každých 5min re-query DOM colors všech rendered Twitch userů.
- **v3.31.1–v3.31.2** - **User-card click via 7TV wrapper** + **clickable credits + claim-bonus mirror**: Twitch synthetic `.click()` 7TV Vue handler ignoruje. Strategy 0 přidána: najde `.seventv-chat-user` wrapper bottom-up (latest message first), real-event click (pointerdown/up/click) na inner username span (kde Vue listener je delegated). Plus bits/points pills clickable → otevře Twitch's own popover na tabu. Plus claim-bonus pill (green pulsing) detect přes `.claimable-bonus__icon`, click posílá `TW_CLAIM_BONUS` do tabu (silent, no focus).
- **v3.31.3** - **Legible claim pill + wrap credits row**: solid Twitch-green gradient místo semi-transparent + explicit `color: #fff !important`; `#tw-credits` `flex-wrap: wrap` aby na úzkém panelu claim pill nezmizel uřízlý.
- **v3.31.4** - **Robust credits snapshot**: staggered retries 0.8/2/4/8/16s + selector fallbacks (`data-test-selector` → `data-a-target` → walk `[class*="ScAnimatedNumber"]` spans v document order). Po extension reload content script race s lazy-loaded Twitch DOM → partial snapshots se re-zachytí jak Twitch hydrtuje.
- **v3.31.5** - **Badges 2x** (`image_url_2x` z IVR) + force-visible claim label (explicit display + fixed color).
- **v3.31.6** - **Short-name emote diagnostic**: `ShortEmote` UC_LOG line + diag dump "Short-name (≤3 chars) emote entries across all maps" sekce — detekce co causuje že ngl. "te" → emote.
- **v3.31.7** - **Permanent 5s credits poll**: `ScAnimatedNumber` span rendruje real value až po prvním watch-reward animation. Permanent `setInterval(relayCredits, 5000)` — cheap DOM walk, hash-dedupuje, pill catch-up do 5s.
- **v3.32.0** - **Float "+N" animation over points pill** při watch-reward / claim delta. `_flashPointsDelta(delta)` — green "+N" floats up/fade (1.5s). Czech/EN-aware parser ("1,5 tis." → 1500, "K"/"tis./mil" suffixes).
- **v3.32.1** - **Pull credits on sidepanel open**: push-only relay čekal na DOM mutation. Teď `_pullCredits` requestuje `GET_CREDITS` na všechny Twitch tabs s retry 0/1.5/4/9s.
- **v3.32.2** - **Keep credits pills visible + optimistic claim flash**: Twitch +10 animation briefly drop text spans. Keep-last-shown pattern + dropna text-equality guard pro delta + optimistic +50 flash na claim click + suppress subsequent flashes 3s.
- **v3.32.3** - **Linkify schemeless URLs**: `www.foo.cz` / `foo.com` (s TLD whitelist) + word-boundary lookbehind (ne mid-token). Schemeless match dostane `https://` jako href, text beze změny.
- **v3.32.4** - **"te" → :D bug fix** + bullet-proof credits keep-last: reply messages learnTwitch nebral `twitchEmotesOffset` → pozice cílila na špatný substring → "te" naučeno jako alias pro :D emote ID 555555560. Teď offset + validace sane slice. Plus credits keep-last přepsán na explicit `_lastBitsText` / `_lastPointsText` / `_lastPointsIcon`.
- **v3.33.0** - **Rewards popover works with hidden chat**: dočasný lift hide → click summary button → poll for dialog → pokud dialog je uvnitř chat column, portal na `document.body` s `position: fixed` → re-apply hide. Chat zůstává hidden, popover viditelný.
- **v3.33.1** - **Verbose popover log**: `PillClick` + `RewardsPopover` tags loggují end-to-end flow (tabs, target, summary-lookup, btn-lookup, click-dispatch, dialog-found/no-dialog, portal-decision).
- **v3.33.2** - **ScrollIntoView + React onClick + always-poll**: button scrollintoview před click, React onClick direct invoke via `__reactProps$*` fallback, always poll for dialog (ne jen když hidden).
- **v3.34.0** - **Twitch Cheermotes**: `Cheer{N}` text pattern → tier-based emote (1/100/1000/5000/10000/100000) + colored bit count (gray→purple→teal→blue→red). Default Cheer prefix only; custom prefixes skip (need OAuth/Helix).
- **v3.34.1** - **Suppress phantom +100 flash na abbreviated rounding**: 1400→1500 (parsed z "1,4 tis." → "1,5 tis.") vypadá jako +100 ale je to jen rounding artifact jednoho +10 ticku. Delta flash jen pokud ani prev ani new jsou abbreviated.
- **v3.34.2** - **Keep credits pills during +10 reward animation**: Twitch drop spans during +10 → our snapshot saw null → hide. Keep-last-shown logic (pill stays, text unchanged) + optimistic +50 na claim.
- **v3.34.3** - **Popover stays visible while vanilla chat re-hides**: poll for dialog → if inside chat column, portal to body → re-apply hide IMMEDIATELY → chat stays hidden, popover stays (via portal with fixed position).
- **v3.34.4–v3.34.6** - **Gold announcement gradient** (mirror dark edges→bright gold center na border i label) + `/uc claim` / `/uc points10` / `/uc points50` mocks + fix `/uc autocomplete` fires už při `/uc` (bez mezery).
- **v3.34.7** - **Longer Phase 1 popover poll**: UC panel focused → Twitch tab backgrounded → Chrome throttles React scheduler → popover mount trvá 500-800ms. Phase 1 `300ms → 1200ms` + re-click na attempt 8 a 16.
- **v3.34.8** - **Reset credits on channel auto-switch**: `_lastBitsText` / `_lastPointsText` etc. persistoval přes switch → old channel values bleed do new channel. Reset + `_pullCredits()` po channel-specific emote/badge clear.
- **v3.34.9** - **Horizontal +N flash from rightmost pill**: vertical float-up byl přes chat hard to read. Teď slides L→R z RIGHTMOST visible pill (claim > points > bits), stays inline v credits row, never overlaps claim button.

---

## Changelog dokumentace

Záznamy změn, které nejsou vázané na source code commit (memory restrukturalizace, přesun milestones, oprava stale poznámky, workflow changes).

Formát: `YYYY-MM-DD [autor/session] — popis`

- **2026-04-15** [session post-v3.37.3] — Archiv založen. Přesunuty milestones v1.x–v3.30.3 z `CLAUDE.md` do `CLAUDE-HISTORY.md` (CLAUDE.md překročil 40k threshold, performance warning od Claude Code). `CLAUDE.md` teď obsahuje jen v3.31.0+ milestones + pointer na tento soubor. Memory `project_unitychat.md` doplněn o pravidlo logování.
- **2026-04-15** [stejná session] — Druhá iterace archivace: přesunuty milestones v3.31.0–v3.34.9 (CLAUDE.md byl po prvním přesunu stále 43.7k znaků). `CLAUDE.md` teď drží jen v3.35.0+ milestones.
- **2026-04-15** [stejná session] — v3.37.4 milestone zapsán (boot instrumentation + watchdog auto-dump). Důvod zápisu do changelogu: user reportoval freeze + nereagující 💾 button na vysoce zatížených streamech, přidán logging + escape hatch.
- **2026-04-16** [session v3.38.x iterace] — 🔒 **Pin systém zamčen na v3.38.26**. User po sérii iterací v3.38.0→v3.38.26 (probing Twitch GQL schema, Client-Integrity discovery, DOM/GQL merge bugy, cache stacking, collapse race) explicit řekl "neměnit". Vytvořen `memory/checkpoint_v3_38_26_pin_stable.md` s dokumentací stable flow + pravidly pro budoucí session (fetchPins query shape, _mergePinCard order, _rerenderHighlights semantic, _lastGoodPinCache conditions, isRerender guard). Ověřovací test flow + "zeptat se user před změnou" policy.
