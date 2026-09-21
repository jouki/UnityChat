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

window.UC_CORE = Object.freeze({ ChatStore, ...colors, ...html, makeLog });
window.ChatStore = ChatStore; // zpětná kompatibilita: sidepanel.js dělá `new ChatStore()`
