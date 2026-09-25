// Varování účtu od moderátora (moderace část 2) — sdílené addonem i webem.
// Uživatel UnityChatu dostane varování napříč platformami: okno s důvodem, které musí potvrdit,
// než může psát (server psaní blokuje i sám: /chat/send → 403 warning_pending).
//
// Zdroje: GET /auth/me (`warnings`), SSE /account/stream?ticket=… (jen vlastní účet; ticket
// jednorázový 60 s z POST /account/stream-ticket — při každém (re)connectu nový),
// potvrzení POST /account/warnings/:id/ack. DOM, EventSource a volání API dodá host.

/** Varování ze serveru → { id, channel, reason, createdAt } nebo null. */
export function normalizeWarning(w) {
  if (!w || typeof w !== 'object' || w.id == null) return null;
  return { id: String(w.id), channel: w.channel ? String(w.channel) : '', reason: String(w.reason || ''), createdAt: w.createdAt || null };
}

/**
 * Připojení k /account/stream s ticketem. Po chybě / konci spojení se připojí znovu s NOVÝM
 * ticketem (EventSource by jinak opakoval propadlý). `too_many_streams` = konec bez obnovy.
 * @param {object} o
 * @param {() => Promise<string>} o.getTicket     POST /account/stream-ticket → ticket
 * @param {string} o.baseUrl                      např. https://api.jouki.cz
 * @param {typeof EventSource} [o.EventSource]
 * @param {(w: object) => void} o.onWarning
 * @param {(id: string) => void} o.onAck
 * @param {(tag: string, text: string) => void} [o.log]
 * @param {number} [o.retryMs]
 * @returns {{close: () => void}}
 */
export function connectAccountStream({ getTicket, baseUrl, EventSource: ES = globalThis.EventSource, onWarning, onAck, log = () => {}, retryMs = 5000, setTimeout: st = globalThis.setTimeout.bind(globalThis), clearTimeout: ct = globalThis.clearTimeout.bind(globalThis) }) {
  let es = null;
  let timer = null;
  let closed = false;
  let fails = 0;
  const schedule = () => {
    if (closed || timer) return;
    const wait = Math.min(60000, retryMs * 2 ** Math.min(Math.max(fails - 1, 0), 4));
    timer = st(() => { timer = null; connect(); }, wait);
  };
  const drop = () => { if (es) { try { es.close(); } catch {} es = null; } };
  const connect = async () => {
    if (closed) return;
    let ticket;
    try { ticket = await getTicket(); }
    catch (e) {
      fails++;
      log('AccWarn', `ticket FAIL ${e?.status || 0} ${e?.error || e?.message || e}`);
      if (e?.status === 401) return;   // bez přihlášení nemá smysl zkoušet znovu
      schedule();
      return;
    }
    if (closed || !ticket) return;
    drop();
    const src = new ES(`${baseUrl}/account/stream?ticket=${encodeURIComponent(ticket)}`);
    es = src;
    src.addEventListener('open', () => { fails = 0; log('AccWarn', 'stream připojen'); });
    src.addEventListener('account-warning', (e) => {
      try { const w = normalizeWarning(JSON.parse(e.data)); if (w) onWarning?.(w); } catch {}
    });
    src.addEventListener('account-warning-ack', (e) => {
      try { const d = JSON.parse(e.data); if (d?.id != null) onAck?.(String(d.id)); } catch {}
    });
    src.addEventListener('error', (e) => {
      if (src !== es) return;
      let data = null;
      try { data = e?.data ? JSON.parse(e.data) : null; } catch {}
      drop();
      if (data?.error === 'too_many_streams') { log('AccWarn', 'too_many_streams → bez obnovy'); return; }
      fails++;
      schedule();
    });
  };
  connect();
  return {
    close() { closed = true; if (timer) { ct(timer); timer = null; } drop(); },
  };
}

/**
 * Okno s varováním (musí se potvrdit; Esc ani klik vedle ho nezavřou). Drží frontu nepotvrzených.
 */
export class WarningModal {
  /**
   * @param {object} o
   * @param {Document} [o.doc]
   * @param {(id: string) => Promise<any>} o.onAck  POST /account/warnings/:id/ack (404 = už potvrzené)
   * @param {() => void} [o.onChange]  změna fronty (host přepne pole pro psaní)
   * @param {(tag: string, text: string) => void} [o.log]
   */
  constructor({ doc = globalThis.document, onAck, onChange, log } = {}) {
    this.doc = doc;
    this.onAck = onAck;
    this.onChange = onChange || (() => {});
    this.log = log || (() => {});
    this._list = [];
    this.el = null;
  }

  /** Nepotvrzená varování (nejstarší první). */
  get pending() { return this._list.slice(); }
  get blocked() { return this._list.length > 0; }

  /** Nahradí frontu (např. z /auth/me). */
  set(list) {
    const next = (Array.isArray(list) ? list : []).map(normalizeWarning).filter(Boolean);
    const changed = JSON.stringify(next.map((w) => w.id)) !== JSON.stringify(this._list.map((w) => w.id));
    this._list = next;
    if (changed) this.onChange();
    this._sync();
  }

  add(w) {
    const n = normalizeWarning(w);
    if (!n || this._list.some((x) => x.id === n.id)) return;
    this._list.push(n);
    this.log('AccWarn', `nové varování ${n.id} (${n.channel})`);
    this.onChange();
    this._sync();
  }

  remove(id) {
    const before = this._list.length;
    this._list = this._list.filter((w) => w.id !== String(id));
    if (this._list.length !== before) { this.log('AccWarn', `potvrzeno ${id}`); this.onChange(); }
    this._sync();
  }

  clear() { this.set([]); }

  /** Otevře okno s nejstarším nepotvrzeným (nic, když žádné není). */
  open() { this._sync(true); }

  _sync(force = false) {
    const w = this._list[0];
    if (!w) { this._close(); return; }
    if (this.el && this.el.dataset.id === w.id && !force) return;
    this._render(w);
  }

  _close() { if (this.el) { this.el.remove(); this.el = null; } }

  _render(w) {
    const doc = this.doc;
    this._close();
    const shade = doc.createElement('div');
    shade.className = 'uc-mod-shade uc-warn-shade';
    shade.dataset.id = w.id;
    const win = doc.createElement('div');
    win.className = 'uc-mod-dialog uc-warn-dialog';
    win.setAttribute('role', 'alertdialog');
    win.setAttribute('aria-modal', 'true');
    const h = doc.createElement('h2');
    h.textContent = 'Varování od moderátora';
    win.setAttribute('aria-label', h.textContent);
    const where = doc.createElement('p');
    where.className = 'uc-mod-dialog-sub';
    where.textContent = w.channel ? `Kanál ${w.channel}` : '';
    const reason = doc.createElement('p');
    reason.className = 'uc-warn-reason';
    reason.textContent = w.reason;
    const note = doc.createElement('p');
    note.className = 'uc-warn-note';
    note.textContent = 'Dokud varování nepotvrdíš, nemůžeš psát do chatu.';
    const err = doc.createElement('p');
    err.className = 'uc-mod-dialog-err';
    err.setAttribute('role', 'alert');
    err.hidden = true;
    const btns = doc.createElement('div');
    btns.className = 'uc-mod-dialog-btns';
    const ok = doc.createElement('button');
    ok.type = 'button';
    ok.className = 'uc-mod-btn uc-mod-btn--primary';
    ok.textContent = 'Rozumím';
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      err.hidden = true;
      try {
        await this.onAck?.(w.id);
        this.remove(w.id);
      } catch (e) {
        if (e?.status === 404) { this.remove(w.id); return; }   // už potvrzené (jiné okno)
        this.log('AccWarn', `ack ${w.id} FAIL ${e?.status || 0} ${e?.error || e?.message || e}`);
        err.textContent = 'Potvrzení se nepodařilo odeslat, zkus to znovu.';
        err.hidden = false;
      } finally { ok.disabled = false; }
    });
    btns.appendChild(ok);
    if (this._list.length > 1) {
      const more = doc.createElement('p');
      more.className = 'uc-warn-more';
      const n = this._list.length - 1;
      more.textContent = `Čeká ${n === 1 ? 'ještě 1 další varování' : n < 5 ? `ještě ${n} další varování` : `ještě ${n} dalších varování`}.`;
      win.append(h, where, reason, note, more, err, btns);
    } else win.append(h, where, reason, note, err, btns);
    shade.appendChild(win);
    doc.body.appendChild(shade);
    this.el = shade;
    try { ok.focus(); } catch {}
  }
}
