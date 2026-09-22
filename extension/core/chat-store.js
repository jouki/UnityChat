// ChatStore — jediný držitel dat zpráv v panelu i na webu. Bez DOM, bez
// chrome.*, aby šel testovat v Node (scripts/test-chat-store.js) a sdílet
// s webovou verzí (extension/core/ = sdílený core, viz CLAUDE.md „Web verze").
// Renderer si z něj bere okno (slice) a nikdy nedrží zprávy, které store nemá.
//
// Řazení: timestamp ASC, tie-break id. Dedup jen podle "platform:id" —
// content-key dedup zmizel spolu se scrape (zprávy bez id už neexistují).
export class ChatStore {
  constructor() {
    this._all = [];
    this._ids = new Set();
    // Kurzor pro další stránku /chat/history (nastavuje renderer z nextBefore).
    this.oldestCursor = null;
  }

  get length() { return this._all.length; }
  key(msg) { return `${msg.platform}:${msg.id}`; }
  at(i) { return this._all[i]; }
  get(id) { const i = this.indexOf(id); return i === -1 ? null : this._all[i]; }

  indexOf(id) {
    for (let i = this._all.length - 1; i >= 0; i--) if (this._all[i].id === id) return i;
    return -1;
  }

  slice(from, to) {
    const a = Math.max(0, from | 0);
    const b = Math.min(this._all.length, to == null ? this._all.length : to | 0);
    return a < b ? this._all.slice(a, b) : [];
  }

  static _cmp(a, b) {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    const ai = String(a.id), bi = String(b.id);
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  }

  // Pozice pro vložení: první index, jehož prvek je > msg. Hledá se od konce,
  // protože živé zprávy jsou skoro vždy nejnovější (typicky O(1)).
  _insertPos(msg) {
    let i = this._all.length;
    while (i > 0 && ChatStore._cmp(this._all[i - 1], msg) > 0) i--;
    return i;
  }

  add(msg) {
    if (!msg || msg.id == null || !msg.platform) return 'dup';
    if (typeof msg.timestamp !== 'number' || !Number.isFinite(msg.timestamp)) msg.timestamp = Date.now();
    const k = this.key(msg);
    if (this._ids.has(k)) return 'dup';
    this._ids.add(k);
    this._all.splice(this._insertPos(msg), 0, msg);
    return 'added';
  }

  prependOlder(msgs) {
    let n = 0;
    for (const m of msgs || []) if (this.add(m) === 'added') n++;
    return n;
  }

  // Optimistická zpráva → echo z platformy: nové id, reálný čas, badges…
  upgrade(optimisticId, realMsg) {
    const i = this.indexOf(optimisticId);
    if (i === -1) return false;
    const old = this._all[i];
    this._ids.delete(this.key(old));
    this._all.splice(i, 1);
    const merged = { ...old, ...realMsg, _optimistic: false };
    delete merged.sendFailed;
    this.add(merged);
    return true;
  }

  markFailed(id) {
    const m = this.get(id);
    if (!m) return false;
    m.sendFailed = true;
    return true;
  }

  remove(id) {
    const i = this.indexOf(id);
    if (i === -1) return false;
    this._ids.delete(this.key(this._all[i]));
    this._all.splice(i, 1);
    return true;
  }
}

