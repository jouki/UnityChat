// Kolo štěstí pro podporovatele — klient (addon i web, OBS ne). Spec docs/superpowers/specs/2026-10-02-kolo-stesti-design.md.
// Lišta nad polem pro psaní (stav kola + akce diváka / moda), formulář vyhlášení pro moda (tlačítko v poli) a
// animace kola při losování (překryv nad chatem: SVG výseče se jmény, roztočí se a zastaví na výherci, jehož vybral
// server). Stav ze serveru: GET /giveaway + SSE `giveaway`; vlastní stav (připojen / výherce) GET /giveaway/me.
// Bez chrome.*; DOM jen přes předané prvky, síť přes předané `api`.
import { czPlural } from './plural.js';

export const WHEEL_SPIN_MS = 5200;
export const WHEEL_RESULT_MS = 2600;
export const WHEEL_TURNS = 6;
/** Ukončené kolo zmizí z lišty (server ho vrací ještě minutu). */
export const BAR_ENDED_MS = 60_000;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLORS = ['#ff8a00', '#ffb347', '#9146ff', '#53fc18', '#ff4f4f', '#2fb5ff', '#ffd23f', '#e05cff'];

export const GIVEAWAY_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">'
  + '<circle cx="12" cy="12" r="9"/><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/></svg>';

/** „3 přihlášení“ apod. */
export const entrantsText = (n) => `${n} ${czPlural(n, 'přihlášený', 'přihlášení', 'přihlášených')}`;

/** Zbývající čas m:ss (nezáporný). */
export function fmtLeft(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Konečné natočení kola (stupně, po směru hodin) tak, aby střed výseče `index` z `n` stál pod ukazatelem nahoře,
 * po `turns` celých otáčkách. `jitter` (−0,4…0,4 výseče) — ať kolo nezastaví vždy přesně uprostřed.
 */
export function wheelAngle(n, index, turns = WHEEL_TURNS, jitter = 0) {
  if (!n) return 0;
  const seg = 360 / n;
  const center = (index + 0.5 + Math.max(-0.4, Math.min(0.4, jitter))) * seg;
  return turns * 360 + (360 - center);
}

/** SVG kola: výseče se jmény (výseč i začíná nahoře a jde po směru hodin). */
export function wheelSvg(names) {
  const n = Math.max(1, names.length);
  const seg = 360 / n;
  const R = 100;
  const pt = (deg, r = R) => { const a = (deg - 90) * Math.PI / 180; return [(r * Math.cos(a)).toFixed(2), (r * Math.sin(a)).toFixed(2)]; };
  let out = '';
  names.forEach((name, i) => {
    const [x1, y1] = pt(i * seg);
    const [x2, y2] = pt((i + 1) * seg);
    const path = n === 1 ? `<circle r="${R}" fill="${COLORS[0]}"/>` : `<path d="M0 0L${x1} ${y1}A${R} ${R} 0 ${seg > 180 ? 1 : 0} 1 ${x2} ${y2}Z" fill="${COLORS[i % COLORS.length]}"/>`;
    const mid = i * seg + seg / 2;
    const label = name.length > 14 ? name.slice(0, 13) + '…' : name;
    const fs = n > 40 ? 5 : n > 24 ? 6.5 : n > 12 ? 8 : 10;
    out += `${path}<text transform="rotate(${(mid - 90).toFixed(2)}) translate(${R - 6} 0)" text-anchor="end" dominant-baseline="middle" font-size="${fs}">${esc(label)}</text>`;
  });
  return `<svg class="uc-gw-wheel-svg" viewBox="-104 -104 208 208" aria-hidden="true"><g class="uc-gw-wheel-rot">${out}</g>`
    + '<circle r="104" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="3"/><circle r="12" fill="#18181b" stroke="#ff8a00" stroke-width="3"/></svg>';
}

/**
 * Části lišty podle stavu kola a role: `{ info, list, acts }` (HTML). `me` = { joined, isWinner, eligible } | null,
 * `opts` = { isMod, loggedIn, now, notDonor (poslední pokus o připojení odmítnut), canDonate, busy, listOpen }.
 * Host překresluje `info` / `list` zvlášť a tlačítka (`acts`) jen při změně — SSE při každém připojení by jinak
 * vyměnilo tlačítko pod kurzorem a klik mezi stiskem a puštěním myši by se ztratil (hlášení 2026-10-02, Strainer).
 */
export function giveawayParts(g, me, { isMod = false, loggedIn = false, now = Date.now(), notDonor = false, canDonate = false, busy = false, listOpen = false } = {}) {
  const btn = (act, label, cls = '') => `<button type="button" class="uc-gw-btn ${cls}" data-act="${act}"${busy ? ' disabled' : ''}>${label}</button>`;
  const count = (txt) => `<button type="button" class="uc-gw-count${listOpen ? ' open' : ''}" data-act="list" title="Seznam přihlášených">${txt} <span class="uc-gw-caret" aria-hidden="true">▾</span></button>`;
  let info = '';
  let acts = '';
  const winners = (g.winners || []).map((w) => esc(w.name)).join(', ');
  if (g.status === 'open') {
    info = count(entrantsText(g.count));
    if (me?.joined) acts += '<span class="uc-gw-ok">Připojeno ✓</span>';
    else if (!loggedIn) acts += btn('login', 'Přihlásit se');
    // Po donatu se jde připojit znovu (server si seznam dárců obnoví).
    else if (notDonor) acts += `<span class="uc-gw-note">Jen pro podporovatele za posledních 30 dní</span>${canDonate ? btn('donate', 'Poslat donate') : ''}${btn('join', 'Zkusit znovu')}`;
    else acts += btn('join', 'Připojit se', 'primary');
    if (isMod) acts += btn('draw', 'Losovat', 'mod') + btn('end', 'Zrušit', 'mod ghost');
  } else if (g.status === 'pending') {
    const left = fmtLeft((g.deadline || now) - now);
    if (me?.isWinner) { info = `<b>Vyhráváš!</b> Potvrď do <span class="uc-gw-left">${left}</span>`; acts += btn('confirm', 'Potvrdit výhru', 'primary'); }
    else info = `Vylosováno: <b>${esc(g.winner?.name)}</b> · čeká na potvrzení <span class="uc-gw-left">${left}</span>`;
    if (isMod) acts += btn('end', 'Ukončit', 'mod ghost');
  } else if (g.status === 'confirmed') {
    info = `Výherce: <b>${esc(g.winner?.name)}</b> 🎉 · ${count(`${g.count} ve hře`)}`;
    if (isMod) acts += btn('draw', 'Losovat dalšího', 'mod') + btn('end', 'Ukončit', 'mod ghost');
  } else if (g.status === 'expired') {
    info = `Lhůta na potvrzení vypršela · ${count(`${g.count} ve hře`)}`;
    if (isMod) acts += btn('draw', 'Losovat znovu', 'mod') + btn('end', 'Ukončit', 'mod ghost');
  } else if (g.status === 'ended') {
    info = winners ? `Kolo skončilo · ${czPlural((g.winners || []).length, 'výherce', 'výherci', 'výherci')}: <b>${winners}</b>` : 'Kolo skončilo';
  } else {
    info = 'Kolo zrušeno';
  }
  const names = g.names || [];
  const list = listOpen && ['open', 'pending', 'confirmed', 'expired'].includes(g.status)
    ? (names.length ? names.map((n) => `<span class="uc-gw-name">${esc(n)}</span>`).join('') + (g.count > names.length ? `<span class="uc-gw-more">+${g.count - names.length}</span>` : '') : '<span class="uc-gw-note">Zatím nikdo</span>')
    : '';
  return { info, list, acts };
}

/** Celá lišta (HTML). Zavřít (×) jde vždy — lišta se znovu ukáže při další změně stavu kola. */
export function giveawayBarHtml(g, me, opts = {}) {
  const { info, list, acts } = giveawayParts(g, me, opts);
  const head = `<span class="uc-gw-ico">${GIVEAWAY_ICON}</span><span class="uc-gw-title">Kolo štěstí</span><span class="uc-gw-prize">${esc(g.prize)}</span>`;
  return `<div class="uc-gw uc-gw--${esc(g.status)}" data-gw-id="${g.id}" data-status="${esc(g.status)}"><div class="uc-gw-row">${head}<span class="uc-gw-info">${info}</span>`
    + '<button type="button" class="uc-gw-x" data-act="close" aria-label="Zavřít" title="Zavřít">×</button></div>'
    + `<div class="uc-gw-list"${list ? '' : ' hidden'}>${list}</div>`
    + `<div class="uc-gw-acts"${acts ? '' : ' hidden'}>${acts}</div></div>`;
}

/** Formulář vyhlášení (mod). */
export function giveawayFormHtml({ busy = false, error = '' } = {}) {
  return '<form class="uc-gw uc-gw-form"><div class="uc-gw-row">'
    + `<span class="uc-gw-ico">${GIVEAWAY_ICON}</span><span class="uc-gw-title">Vyhlásit kolo štěstí</span>`
    + '<button type="button" class="uc-gw-x" data-act="form-close" aria-label="Zavřít">×</button></div>'
    + '<div class="uc-gw-fields"><input name="prize" maxlength="100" placeholder="O co se hraje (např. klíč ke hře)" autocomplete="off" required>'
    + '<label class="uc-gw-min">Lhůta na potvrzení <input name="minutes" type="number" min="1" max="120" value="15"> min</label></div>'
    + (error ? `<div class="uc-gw-err">${esc(error)}</div>` : '')
    + `<div class="uc-gw-acts"><button type="submit" class="uc-gw-btn primary"${busy ? ' disabled' : ''}>Vyhlásit</button></div></form>`;
}

const ERR = {
  not_donor: 'Připojit se můžou jen podporovatelé za posledních 30 dní.',
  not_open: 'Přihlášky už jsou uzavřené.',
  not_winner: 'Výhru už potvrdit nejde (lhůta vypršela?).',
  active: 'Kolo už běží.',
  no_entries: 'V kole nikdo není.',
  pending: 'Výherce ještě nepotvrdil.',
  prize: 'Napiš, o co se hraje.',
  confirm_minutes: 'Lhůta 1–120 minut.',
  not_mod: 'Jen pro moda nebo streamera.',
};
export const giveawayErrorText = (code) => ERR[code] || 'Nepovedlo se, zkus to znovu.';

const reduced = (win) => { try { return !!win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

/**
 * @param {object} o
 * @param {Document} o.doc
 * @param {HTMLElement} o.bar          kontejner lišty nad polem pro psaní
 * @param {HTMLElement} o.overlayHost  kam vložit překryv s kolem (obal chatu, position: relative)
 * @param {{ get: (path: string) => Promise<any>, post: (path: string, body: object) => Promise<any> }} o.api
 *        get/post vrací JSON; chyba = throw s `.code` (error ze serveru)
 * @param {() => string} o.channel
 * @param {() => boolean} o.isMod
 * @param {() => boolean} o.loggedIn
 * @param {() => void} o.onLogin
 * @param {(() => void) | null} [o.onDonate]
 * @param {() => void} [o.onLayout]    lišta změnila výšku (host přepočte scroll)
 * @param {(tag: string, text: string) => void} [o.log]
 */
export function createGiveaway({ doc, bar, overlayHost, api, channel, isMod, loggedIn, onLogin, onDonate = null, onLayout = null, log = () => {} }) {
  const win = doc.defaultView;
  let state = null;
  let me = null;
  let notDonor = false;
  let busy = false;
  let formOpen = false;
  let formErr = '';
  let listOpen = false;   // rozbalený seznam přihlášených
  let dismissed = null;   // `${id}:${status}` zavřené lišty
  let tick = null;
  let skew = 0;           // serverNow − Date.now()
  let lastSeq = null;     // drawSeq posledního známého stavu (animace jen při změně)
  let spinning = null;    // { el, until } běžící animace — lišta s výsledkem až po dotočení
  const now = () => Date.now() + skew;
  const L = (t) => log('Giveaway', t);

  function render() {
    // Zavřená lišta (×) zůstane zavřená, dokud se stav kola nezmění (nové kolo, losování, potvrzení…).
    const closed = state && dismissed === `${state.id}:${state.status}`;
    const show = formOpen || (state && !closed && (['open', 'pending', 'confirmed', 'expired'].includes(state.status) || now() - state.updatedAt < BAR_ENDED_MS));
    if (!show) { bar.replaceChildren(); bar.classList.add('hidden'); stopTick(); onLayout?.(); return; }
    const wasHidden = bar.classList.contains('hidden');
    // Během točení lišta drží stav před losováním (výherce prozradí až kolo).
    const view = spinning?.prev ?? state;
    const opts = { isMod: isMod(), loggedIn: loggedIn(), now: now(), notDonor, canDonate: !!onDonate, busy, listOpen };
    const root = bar.firstElementChild;
    if (formOpen && (!state || !['open', 'pending', 'confirmed', 'expired'].includes(state.status))) {
      // Formulář jen při změně (rozepsaný text zůstává).
      const sig = `${busy}|${formErr}`;
      if (!root?.classList.contains('uc-gw-form') || root.dataset.sig !== sig) {
        const keep = root?.classList.contains('uc-gw-form') ? { prize: root.prize.value, minutes: root.minutes.value } : null;
        bar.innerHTML = giveawayFormHtml({ busy, error: formErr });
        const f = bar.firstElementChild;
        f.dataset.sig = sig;
        if (keep) { f.prize.value = keep.prize; f.minutes.value = keep.minutes; }
      }
    } else if (root && root.dataset.gwId === String(view.id) && root.dataset.status === view.status) {
      // Stejné kolo i stav: přepsat jen text a seznam, tlačítka jen když se změnila (klik během SSE se neztratí).
      const p = giveawayParts(view, me, opts);
      root.querySelector('.uc-gw-info').innerHTML = p.info;
      const list = root.querySelector('.uc-gw-list');
      list.innerHTML = p.list; list.hidden = !p.list;
      const acts = root.querySelector('.uc-gw-acts');
      if (acts.dataset.sig !== p.acts) { acts.innerHTML = p.acts; acts.dataset.sig = p.acts; }
      acts.hidden = !p.acts;
    } else {
      bar.innerHTML = giveawayBarHtml(view, me, opts);
      const acts = bar.querySelector('.uc-gw-acts');
      if (acts) acts.dataset.sig = giveawayParts(view, me, opts).acts;
    }
    bar.classList.remove('hidden');
    if (wasHidden && !reduced(win)) bar.firstElementChild?.classList.add('uc-gw--enter');
    if (formOpen && !bar.contains(doc.activeElement)) bar.querySelector('input[name="prize"]')?.focus();
    if (view?.status === 'pending') startTick(); else stopTick();
    onLayout?.();
  }

  function startTick() {
    if (tick) return;
    tick = win.setInterval(() => {
      const el = bar.querySelector('.uc-gw-left');
      const st = spinning?.prev ?? state;
      if (el && st?.deadline) el.textContent = fmtLeft(st.deadline - now());
    }, 1000);
  }
  function stopTick() { if (tick) { win.clearInterval(tick); tick = null; } }

  async function refreshMe() {
    if (!loggedIn() || !state || !['open', 'pending'].includes(state.status)) { me = null; return; }
    try { me = await api.get(`/giveaway/me?channel=${encodeURIComponent(channel())}`); } catch (e) { L(`me fail ${e?.code || e?.message || e}`); }
  }

  /** Nový stav ze serveru (GET nebo SSE). `initial` = načtení stránky → bez animace kola. */
  async function apply(next, { initial = false, serverNow = null } = {}) {
    if (serverNow) skew = serverNow - Date.now();
    const prev = state;
    state = next || null;
    if (state && prev && state.id !== prev.id) notDonor = false;
    const seq = state?.drawSeq ?? null;
    const drew = !initial && state?.status === 'pending' && lastSeq != null && seq != null && seq > lastSeq && state.winner;
    lastSeq = seq;
    if (state && formOpen && ['open', 'pending', 'confirmed', 'expired'].includes(state.status)) formOpen = false;
    await refreshMe();
    if (drew) spin(state, prev);
    render();
    L(`stav ${state ? `${state.status} #${state.id} n=${state.count} seq=${state.drawSeq}` : 'žádné'}${drew ? ' → kolo' : ''}`);
  }

  /** Animace losování: kolo se jmény, zastaví na výherci (vybral server). */
  function spin(st, prev) {
    const names = st.names.length ? st.names : [st.winner.name];
    let idx = names.indexOf(st.winner.name);
    if (idx < 0) idx = 0;
    overlayHost.querySelector('.uc-gw-overlay')?.remove();
    const ov = doc.createElement('div');
    ov.className = 'uc-gw-overlay';
    ov.innerHTML = `<div class="uc-gw-stage"><div class="uc-gw-pointer"></div>${wheelSvg(names)}<div class="uc-gw-result" hidden></div></div>`;
    overlayHost.appendChild(ov);
    const rot = ov.querySelector('.uc-gw-wheel-rot');
    const result = ov.querySelector('.uc-gw-result');
    const fast = reduced(win) || typeof rot.animate !== 'function';
    const end = wheelAngle(names.length, idx, WHEEL_TURNS, (Math.random() - 0.5) * 0.6);
    spinning = { prev: prev && prev.id === st.id ? prev : null };
    const close = () => { ov.classList.add('uc-gw-overlay--out'); win.setTimeout(() => ov.remove(), 250); };
    const finish = () => {
      result.innerHTML = `<span>Vylosováno</span><b>${esc(st.winner.name)}</b>`;
      result.hidden = false;
      spinning = null;
      render();
      win.setTimeout(close, WHEEL_RESULT_MS);
    };
    ov.addEventListener('click', close);
    if (fast) { rot.setAttribute('transform', `rotate(${end % 360})`); finish(); return; }
    rot.style.transformOrigin = '0 0';   // střed kola = počátek viewBoxu
    const a = rot.animate([{ transform: 'rotate(0deg)' }, { transform: `rotate(${end}deg)` }], { duration: WHEEL_SPIN_MS, easing: 'cubic-bezier(.12,.62,.08,1)', fill: 'forwards' });
    a.finished.catch(() => {}).then(finish);
    L(`kolo: ${names.length} jmen, výherce #${idx}`);
  }

  async function act(name) {
    const ch = channel();
    if (name === 'login') { onLogin?.(); return; }
    if (name === 'donate') { onDonate?.(); return; }
    if (name === 'form-close') { formOpen = false; formErr = ''; render(); return; }
    if (name === 'close') { dismissed = state ? `${state.id}:${state.status}` : null; listOpen = false; render(); L('lišta zavřena'); return; }
    if (name === 'list') { listOpen = !listOpen; render(); return; }
    const path = { join: '/giveaway/join', confirm: '/giveaway/confirm', draw: '/moderation/giveaway/draw', end: '/moderation/giveaway/end' }[name];
    if (!path || busy) { L(`klik ${name} ignorován${busy ? ' (probíhá jiná akce)' : ''}`); return; }
    L(`klik ${name}`);
    busy = true; render();
    try {
      const r = await api.post(path, { channel: ch });
      if (name === 'join') notDonor = false;
      await apply(r.giveaway);
      L(`${name} ok`);
    } catch (e) {
      const code = e?.code || e?.error || '';
      if (name === 'join' && code === 'not_donor') notDonor = true;
      else bar.dataset.err = giveawayErrorText(code);
      L(`${name} fail ${code || e?.message || e}`);
    } finally {
      busy = false; render();
      if (bar.dataset.err) { const t = bar.dataset.err; delete bar.dataset.err; flash(t); }
    }
  }

  function flash(text) {
    const el = doc.createElement('div');
    el.className = 'uc-gw-flash';
    el.textContent = text;
    bar.firstElementChild?.appendChild(el);
    win.setTimeout(() => el.remove(), 3500);
    onLayout?.();
  }

  async function submitForm(form) {
    const prize = String(form.prize.value || '').trim();
    const minutes = Number(form.minutes.value) || 15;
    if (!prize) { formErr = giveawayErrorText('prize'); render(); return; }
    busy = true; formErr = ''; render();
    try {
      const r = await api.post('/moderation/giveaway/start', { channel: channel(), prize, confirmMinutes: Math.round(minutes) });
      formOpen = false;
      await apply(r.giveaway);
      L('vyhlášeno');
    } catch (e) {
      formErr = giveawayErrorText(e?.code || e?.error);
      L(`start fail ${e?.code || e?.message || e}`);
    } finally { busy = false; render(); }
  }

  const onClick = (e) => {
    const b = e.target.closest?.('[data-act]');
    if (!b || !bar.contains(b)) return;
    e.preventDefault();
    void act(b.dataset.act);
  };
  const onSubmit = (e) => { e.preventDefault(); void submitForm(e.target); };
  const onKey = (e) => { if (e.key === 'Escape' && formOpen) { formOpen = false; render(); } };
  bar.addEventListener('click', onClick);
  bar.addEventListener('submit', onSubmit);
  bar.addEventListener('keydown', onKey);

  return {
    apply,
    /** Načíst stav ze serveru (start, přepnutí kanálu, přihlášení). */
    async load() {
      try { const r = await api.get(`/giveaway?channel=${encodeURIComponent(channel())}`); await apply(r.giveaway, { initial: true, serverNow: r.serverNow }); }
      catch (e) { L(`load fail ${e?.code || e?.message || e}`); }
    },
    /** Tlačítko moda v poli: formulář vyhlášení (když nic neběží), jinak lištu jen ukázat. */
    toggleForm() {
      if (state && ['open', 'pending', 'confirmed', 'expired'].includes(state.status)) { dismissed = null; render(); bar.querySelector('.uc-gw')?.classList.add('uc-gw--pulse'); return; }
      formOpen = !formOpen; formErr = '';
      render();
    },
    /** Přihlášení / role se změnily → překreslit (a dotáhnout vlastní stav). */
    async refresh() { await refreshMe(); render(); },
    get state() { return state; },
    destroy() { stopTick(); bar.removeEventListener('click', onClick); bar.removeEventListener('submit', onSubmit); bar.removeEventListener('keydown', onKey); overlayHost.querySelector('.uc-gw-overlay')?.remove(); },
  };
}
