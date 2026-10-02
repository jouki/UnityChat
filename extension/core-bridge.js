// Most mezi ES moduly v core/ a klasickým sidepanel.js (bez build kroku).
//
// sidepanel.html načítá <script type="module" src="core-bridge.js"> a hned za
// ním <script defer src="sidepanel.js">. Oba jsou v „deferred" frontě a
// spouští se v pořadí dokumentu (modul až po načtení svých importů), takže
// window.UC_CORE existuje dřív, než sidepanel.js začne běžet. DOMContentLoaded
// se vyvolá až po obou, listener v sidepanel.js tedy dál funguje.
//
// Core = kód sdílený s webovou verzí (privátní repo jouki/UnityChat-web):
// žádné chrome.*, žádný DOM, logování přes injektovaný log(tag, text).
import { ChatStore } from './core/chat-store.js';
import * as colors from './core/colors.js';
import * as html from './core/html.js';
import { makeLog } from './core/log.js';
import { TwitchProvider } from './core/twitch-irc.js';
import { KickProvider } from './core/kick.js';
import { EmoteManager } from './core/emotes.js';
import * as announcement from './core/announcement.js';
import * as broadcastGroup from './core/broadcast-group.js';
import * as giveaway from './core/giveaway.js';
import * as reaction from './core/reaction.js';
import * as emotePicker from './core/emote-picker.js';
import * as panelMorph from './core/panel-morph.js';
import * as mentions from './core/mentions.js';
import * as colonEmotes from './core/colon-emotes.js';
import * as emoteAutocomplete from './core/emote-autocomplete.js';
import * as emotePreview from './core/emote-preview.js';
import * as soundboard from './core/soundboard.js';
import * as sfxRequest from './core/sfx-request.js';
import * as qrDono from './core/qr-dono.js';
import * as emailVerify from './core/email-verify.js';
import * as toolDock from './core/tool-dock.js';
import * as slideIndicator from './core/slide-indicator.js';
import * as emoteRetry from './core/emote-retry.js';
import * as codeInput from './core/code-input.js';
import * as loginModal from './core/login-modal.js';
import * as slideIn from './core/slide-in.js';
import * as ucReply from './core/uc-reply.js';
import * as moderation from './core/moderation.js';
import * as modMenu from './core/mod-menu.js';
import * as accountWarnings from './core/account-warnings.js';
import * as mentionNotify from './core/mention-notify.js';
import * as userHistory from './core/user-history.js';
import * as gif from './core/gif.js';
import * as gifLinks from './core/gif-links.js';
import * as gifCooldown from './core/gif-cooldown.js';
import * as gifLibrary from './core/gif-library.js';
import * as gifHost from './core/gif-host.js';
import * as gifClientFetch from './core/gif-client-fetch.js';
import * as userSearch from './core/user-search.js';
import * as anniversary from './core/anniversary.js';
import * as updateNotice from './core/update-notice.js';
import * as gifLightbox from './core/gif-lightbox.js';
import * as heightAnim from './core/height-anim.js';
import * as timeFmt from './core/time.js';
import * as donorBadge from './core/donor-badge.js';

window.UC_CORE = Object.freeze({ ChatStore, ...colors, ...html, makeLog, TwitchProvider, KickProvider, EmoteManager, ...announcement, ...reaction, ...emotePicker, ...mentions, ...colonEmotes, ...emoteAutocomplete, ...emotePreview, ...soundboard, ...sfxRequest, ...loginModal, ...slideIn, ...ucReply, ...qrDono, ...emailVerify, ...toolDock, ...slideIndicator, ...emoteRetry, ...moderation, ...modMenu, ...accountWarnings, ...mentionNotify, ...userHistory, ...gif, ...gifLinks, ...gifCooldown, ...gifLibrary, ...gifHost, ...gifClientFetch, ...userSearch, ...anniversary, ...updateNotice, ...gifLightbox, ...heightAnim, ...timeFmt, ...donorBadge, ...panelMorph, ...broadcastGroup, ...giveaway });
window.EmoteManager = EmoteManager;
window.TwitchProvider = TwitchProvider;
window.KickProvider = KickProvider;
window.ChatStore = ChatStore; // zpětná kompatibilita: sidepanel.js dělá `new ChatStore()`
