// Návrh zvukového efektu (spec docs/superpowers/specs/2026-09-25-sfx-navrhy-design.md) —
// sdílené addonem i webem, vzhled soundboardu. Divák pošle odkaz (mp3 / YouTube), Židolišta
// ho stáhne a vrátí náhled s průběhem hlasitosti; divák vybere úsek ≤ 30 s dvěma značkami,
// pojmenuje ho a odešle. Síť dělá hostitel přes `api` (backend /soundboard/requests*),
// DOM dostává zvenku (host), žádné chrome.*. Cizí text jde do DOM jen přes esc / textContent.

export const MAX_CLIP_MS = 30_000;
export const MIN_CLIP_MS = 200;
export const NAME_MAX = 40;
export const NOTE_MAX = 300;
const KEY_STEP_MS = 100;
const KEY_STEP_BIG_MS = 1000;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Čas úseku „m:ss,s“ (desetiny sekundy, česká desetinná čárka). */
export function formatClipTime(ms) {
  const t = Math.max(0, Math.round(Number(ms) / 100) || 0);   // desetiny sekundy
  const m = Math.floor(t / 600);
  const s = Math.floor((t % 600) / 10);
  return `${m}:${String(s).padStart(2, '0')},${t % 10}`;
}

/** Délka úseku „3,4 s“. */
export function formatClipLength(ms) {
  return `${(Math.max(0, Math.round(Number(ms) / 100) || 0) / 10).toFixed(1).replace('.', ',')} s`;
}

/** Výchozí výběr: od začátku, celá délka, nejvýš 30 s. */
export function defaultSelection(durationMs) {
  const d = Math.max(0, Math.round(Number(durationMs) || 0));
  return { startMs: 0, endMs: Math.min(d, MAX_CLIP_MS) };
}

/**
 * Posun jedné značky na `valueMs`; značka se nepustí za druhou (min. mezera MIN_CLIP_MS),
 * mimo zdroj ani tak daleko, aby byl úsek delší než 30 s. Druhá značka se nehýbe.
 */
export function moveHandle(sel, handle, valueMs, durationMs) {
  const d = Math.max(0, Number(durationMs) || 0);
  const gap = Math.min(MIN_CLIP_MS, d);
  const v = Math.round(Number(valueMs) || 0);
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  if (handle === 'start') {
    const lo = Math.max(0, sel.endMs - MAX_CLIP_MS);
    return { startMs: clamp(v, lo, Math.max(lo, sel.endMs - gap)), endMs: sel.endMs };
  }
  const hi = Math.min(d, sel.startMs + MAX_CLIP_MS);
  return { startMs: sel.startMs, endMs: clamp(v, Math.min(hi, sel.startMs + gap), hi) };
}

/** Název pro `!se` stejně jako Židolišta (normalizeSfxName): mezery → _, jen písmena, číslice, _ a -. */
export function normalizeRequestName(raw) {
  let s = String(raw ?? '').trim().replace(/^!+/, '').replace(/^["']+|["']+$/g, '').trim();
  s = s.replace(/\s+/g, '_');
  return /^[\p{L}\p{N}_-]{1,40}$/u.test(s) ? s : null;
}

/** Chybové kódy serveru → česky. `phase` rozliší too_long u zdroje (prepare) a u úseku (submit). */
export function sfxRequestErrorText(err, phase = 'prepare') {
  const code = typeof err === 'string' ? err : err?.error;
  const status = typeof err === 'object' ? err?.status : undefined;
  switch (code) {
    case 'bad_url': return 'Tohle nevypadá jako platný odkaz.';
    case 'unsupported': return 'Jde jen odkaz na YouTube nebo přímo na soubor .mp3.';
    case 'too_long': return phase === 'submit' ? 'Úsek je delší než 30 s.' : 'Zdroj je delší než 10 minut.';
    case 'too_large': return 'Soubor je moc velký (nejvýš 15 MB).';
    case 'download_failed': return 'Odkaz se nepodařilo stáhnout. Je veřejně dostupný?';
    case 'youtube_blocked': return 'YouTube stahování ze serveru teď blokuje — pošli odkaz na mp3.';
    case 'timeout': return 'Zpracování trvalo moc dlouho, zkus kratší video nebo mp3.';
    case 'busy': return 'Server teď zpracovává jiné odkazy, zkus to za chvíli.';
    case 'rate_limited': return 'Moc pokusů za sebou, zkus to za chvíli.';
    case 'expired': return 'Náhled vypršel, načti odkaz znovu.';
    case 'bad_range': return 'Neplatný úsek: konec musí být za začátkem a uvnitř zdroje.';
    case 'bad_time': return 'Zadej čas ve tvaru m:ss (třeba 1:05 nebo 1:05,5).';
    case 'bad_name': return `Název smí mít jen písmena, číslice, _ a - (nejvýš ${NAME_MAX} znaků).`;
    case 'name_taken': return 'Zvuk s tímhle názvem už existuje nebo čeká na schválení.';
    case 'limit_day': return 'Dnešní limit 10 návrhů je vyčerpaný, zkus to zítra.';
    case 'limit_month': return 'Limit 30 návrhů na tento měsíc je vyčerpaný.';
    case 'platform_not_linked': return 'Na téhle platformě nejsi přihlášený.';
    case 'unknown_channel': return 'Tenhle kanál návrhy zvuků nepřijímá.';
    case 'no session': case 'invalid session': return 'Přihlášení vypršelo, přihlas se znovu.';
    default: return status === 401 ? 'Přihlášení vypršelo, přihlas se znovu.' : 'Server Židolišty je teď nedostupný, zkus to znovu.';
  }
}

/** „Dnes zbývá 7 z 10 · tento měsíc 25 z 30“. */
export function limitsText(l) {
  if (!l) return '';
  const day = Math.max(0, l.dayMax - l.dayUsed), month = Math.max(0, l.monthMax - l.monthUsed);
  return `Dnes zbývá ${day} z ${l.dayMax} · tento měsíc ${month} z ${l.monthMax}`;
}

/** Vyčerpaný limit → kód chyby, jinak null. */
export function limitReached(l) {
  if (!l) return null;
  if (l.dayUsed >= l.dayMax) return 'limit_day';
  if (l.monthUsed >= l.monthMax) return 'limit_month';
  return null;
}

// „čeká na schválení“ i chvíli po schválení (Židolišta stahuje YouTube na PC schvalovatele).
export const REQUEST_STATUS_TEXT = { pending: 'čeká na schválení', approved: 'schváleno', rejected: 'zamítnuto' };

/** Ruční čas „m:ss“, „m:ss,s“, „m:ss.s“ nebo jen sekundy → ms; nesmysl = null. */
export function parseClipTime(v) {
  const m = /^\s*(?:(\d{1,3}):)?(\d{1,5})(?:[.,](\d{1,3}))?\s*$/.exec(String(v ?? ''));
  if (!m) return null;
  const min = m[1] ? Number(m[1]) : 0, sec = Number(m[2]);
  if (m[1] && sec >= 60) return null;
  const frac = m[3] ? Number(`0.${m[3]}`) : 0;
  return Math.round((min * 60 + sec + frac) * 1000);
}

export const YT_EMBED_HOST = 'https://www.youtube-nocookie.com';
/** Přehrávač YouTube bez IFrame API skriptu (MV3 zakazuje vzdálený kód) — ovládání přes postMessage. */
export function youtubeEmbedUrl(videoId, origin) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(videoId ?? ''))) return null;
  const q = new URLSearchParams({ enablejsapi: '1', controls: '0', playsinline: '1', ...(origin && origin !== 'null' ? { origin } : {}) });
  return `${YT_EMBED_HOST}/embed/${videoId}?${q}`;
}
/** Zprávy přehrávače jen z YouTube. */
export const isYoutubeOrigin = (o) => /^https:\/\/(www\.)?youtube(-nocookie)?\.com$/.test(String(o ?? ''));

/** Kontrola ručně zadaného úseku → kód chyby (jako server), jinak null. */
export function manualRangeError(startMs, endMs, durationMs) {
  if (startMs === null || endMs === null) return 'bad_time';
  if (!(endMs > startMs)) return 'bad_range';
  if (endMs - startMs > MAX_CLIP_MS) return 'too_long';
  if (durationMs > 0 && endMs > durationMs + 500) return 'bad_range';
  return null;
}
const EMBED_TIMEOUT_MS = 8000;

/** Nota s plusem (tlačítko „Navrhnout zvuk“ v soundboardu). */
export const SFX_REQUEST_BUTTON_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true"><path d="M10 3.2a1 1 0 0 1 1.45-.9c2.9 1.45 4.55 3.4 4.55 6.2 0 .5-.06 1-.17 1.49a1 1 0 1 1-1.95-.44c.08-.35.12-.7.12-1.05 0-1.53-.72-2.73-2-3.73V16.5a3.5 3.5 0 1 1-2-3.16V3.2Z"/><path d="M18 13v3h3a1 1 0 1 1 0 2h-3v3a1 1 0 1 1-2 0v-3h-3a1 1 0 1 1 0-2h3v-3a1 1 0 1 1 2 0Z"/></svg>';
const PLAY_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15a1 1 0 0 0 1.53.85l12-7.5a1 1 0 0 0 0-1.7l-12-7.5A1 1 0 0 0 7 4.5Z"/></svg>';
const STOP_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>';
const BACK_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';

/**
 * Panel návrhu zvuku.
 * @param {object} o
 * @param {HTMLElement} o.host        kontejner (v soundboardu místo seznamu zvuků)
 * @param {HTMLElement} [o.button]   volitelné tlačítko, které panel otevírá/zavírá
 * @param {{ prepare(url: string): Promise<object>, submit(b: object): Promise<object>, list(): Promise<{requests: object[], limits: object}> }} o.api
 * @param {(tag: string, text: string) => void} [o.log]
 * @param {(state: {requests: object[], limits: object|null}) => void} [o.onChange]
 * @param {() => void} [o.onBack]    šipka zpět (hostitel vrátí seznam zvuků)
 */
export function createSfxRequest({ host, button, api, log, onChange, onBack }) {
  const doc = host.ownerDocument;
  const win = doc.defaultView;
  const L = (t) => log?.('SfxReq', t);

  let limits = null, requests = [], listSeq = 0;
  let prep = null;            // odpověď prepare (previewId, mode, durationMs, peaks, previewUrl, videoId, title, source)
  let yt = null;              // embed režim: { iframe, id, alive, t, at, seekAt, playing, timers }
  let manual = false;         // přehrávač YouTube se nenačetl → ruční zadání časů
  let sel = { startMs: 0, endMs: 0 };
  let busy = false;
  let step = 'link';          // link | edit | done

  const root = doc.createElement('div');
  root.className = 'uc-sr hidden';
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Navrhnout zvuk');
  root.innerHTML = `
    <div class="uc-sr-head">
      ${onBack ? `<button type="button" class="uc-sr-back" data-act="back" aria-label="Zpět na zvuky" title="Zpět na zvuky">${BACK_SVG}</button>` : ''}
      <span class="uc-sr-title">Navrhnout zvuk</span>
      <span class="uc-sr-limits"></span>
    </div>
    <div class="uc-sr-scroll">
      <form class="uc-sr-link" novalidate>
        <div class="uc-sr-urlrow">
          <input name="url" type="url" placeholder="Odkaz na YouTube nebo .mp3" autocomplete="off" spellcheck="false" maxlength="2000" aria-label="Odkaz na YouTube nebo mp3">
          <button type="submit" class="uc-sr-load">Načíst</button>
        </div>
        <div class="uc-sr-hint">Mod nebo streamer návrh v Židolištce schválí, nebo zamítne. Úsek nejvýš 30 s.</div>
      </form>
      <div class="uc-sr-loading" hidden><i class="uc-sr-spin"></i><span>Stahuji a připravuji náhled…</span></div>
      <form class="uc-sr-edit" novalidate hidden>
        <div class="uc-sr-src"></div>
        <div class="uc-sr-yt" hidden><div class="uc-sr-yt-box"></div><div class="uc-sr-yt-wait">Načítám video…</div></div>
        <div class="uc-sr-tl">
          <div class="uc-sr-track">
            <div class="uc-sr-wave" aria-hidden="true"></div>
            <div class="uc-sr-dim uc-sr-dim-l"></div>
            <div class="uc-sr-sel"></div>
            <div class="uc-sr-dim uc-sr-dim-r"></div>
            <i class="uc-sr-ph" hidden></i>
            <div class="uc-sr-h uc-sr-h-start" data-h="start" role="slider" tabindex="0" aria-label="Začátek úseku"></div>
            <div class="uc-sr-h uc-sr-h-end" data-h="end" role="slider" tabindex="0" aria-label="Konec úseku"></div>
          </div>
          <div class="uc-sr-times">
            <button type="button" class="uc-sr-play" data-act="play" aria-label="Přehrát úsek" title="Přehrát úsek">${PLAY_SVG}</button>
            <span class="uc-sr-t"><em>Začátek</em> <b class="uc-sr-ts"></b></span>
            <span class="uc-sr-t"><em>Konec</em> <b class="uc-sr-te"></b></span>
            <span class="uc-sr-t"><em>Délka</em> <b class="uc-sr-tl2"></b></span>
          </div>
        </div>
        <div class="uc-sr-manual" hidden>
          <div class="uc-sr-manual-t">Přehrávač YouTube se tady nenačetl. Zadej začátek a konec úseku ručně (nejvýš 30 s). <a class="uc-sr-ytlink" target="_blank" rel="noopener noreferrer">Otevřít video na YouTube</a></div>
          <div class="uc-sr-manual-row">
            <label class="uc-sr-f"><span class="uc-sr-l">Od</span><input name="from" placeholder="0:00" autocomplete="off" inputmode="decimal"></label>
            <label class="uc-sr-f"><span class="uc-sr-l">Do</span><input name="to" placeholder="0:10" autocomplete="off" inputmode="decimal"></label>
            <span class="uc-sr-manual-len"></span>
          </div>
        </div>
        <label class="uc-sr-f">
          <span class="uc-sr-l">Název <em class="uc-sr-cmd"></em></span>
          <input name="name" maxlength="${NAME_MAX}" autocomplete="off" spellcheck="false" placeholder="např. ahShit" required>
        </label>
        <label class="uc-sr-f">
          <span class="uc-sr-l">Poznámka <em>nepovinné</em></span>
          <textarea name="note" rows="2" maxlength="${NOTE_MAX}" placeholder="Odkud zvuk je, kdy se hodí…"></textarea>
        </label>
        <div class="uc-sr-actions">
          <button type="button" class="uc-sr-other" data-act="other">Jiný odkaz</button>
          <button type="submit" class="uc-sr-go">Odeslat návrh</button>
        </div>
      </form>
      <div class="uc-sr-done" hidden></div>
      <div class="uc-sr-err" role="alert" hidden></div>
      <div class="uc-sr-mine">
        <div class="uc-sr-mine-h">Moje návrhy</div>
        <div class="uc-sr-list"></div>
      </div>
    </div>`;
  host.appendChild(root);
  const $ = (s) => root.querySelector(s);
  const linkForm = $('.uc-sr-link'), editForm = $('.uc-sr-edit');
  const urlInput = linkForm.elements.url, loadBtn = $('.uc-sr-load');
  const nameInput = editForm.elements.name, noteInput = editForm.elements.note, goBtn = $('.uc-sr-go');
  const track = $('.uc-sr-track'), wave = $('.uc-sr-wave');
  const hStart = $('.uc-sr-h-start'), hEnd = $('.uc-sr-h-end');
  const playBtn = $('.uc-sr-play'), playhead = $('.uc-sr-ph');
  const fromInput = editForm.elements.from, toInput = editForm.elements.to;

  if (button) {
    button.addEventListener('click', (e) => { e.stopPropagation(); isOpen() ? close() : open(); });
  }

  // ---- stav obrazovek ----
  let limitErr = false;   // zobrazená chyba je vyčerpaný limit (zmizí, až se limit uvolní)
  function setError(msg) { const e = $('.uc-sr-err'); e.textContent = msg || ''; e.hidden = !msg; limitErr = false; }
  function setStep(s) {
    step = s;
    linkForm.hidden = s !== 'link';
    editForm.hidden = s !== 'edit';
    $('.uc-sr-done').hidden = s !== 'done';
    if (s !== 'edit') { stopPlay(); ytTeardown(); }
    renderLimits();
  }
  function setLoading(on) {
    busy = on;
    $('.uc-sr-loading').hidden = !on;
    linkForm.hidden = on || step !== 'link';
    urlInput.disabled = on;
    renderLimits();
  }
  function renderLimits() {
    $('.uc-sr-limits').textContent = limitsText(limits);
    const over = limitReached(limits);
    loadBtn.disabled = busy || !!over;
    goBtn.disabled = busy || !!over;
    if (over && step !== 'done') { setError(sfxRequestErrorText(over)); limitErr = true; }
    else if (!over && limitErr) setError('');
  }

  // ---- časová osa ----
  function renderWave() {
    const peaks = prep?.peaks?.length ? prep.peaks : [];
    wave.innerHTML = peaks.map((p) => `<i style="height:${Math.max(4, Math.round(Math.min(1, Math.max(0, Number(p) || 0)) * 100))}%"></i>`).join('');
  }
  const pct = (msv) => (prep?.durationMs ? (msv / prep.durationMs) * 100 : 0);
  const tlReady = () => !!prep && prep.durationMs > 0 && !manual;
  /** Osa (a ▶) je aktivní, jen když je známá délka; v embed režimu bez ní „Načítám video…“. */
  function renderMode() {
    const embed = prep?.mode === 'embed';
    $('.uc-sr-yt').hidden = !embed || manual;
    $('.uc-sr-yt-wait').hidden = !embed || (prep?.durationMs > 0 && !!yt?.alive);
    $('.uc-sr-tl').hidden = manual;
    $('.uc-sr-manual').hidden = !manual;
    track.classList.toggle('uc-sr-off', !tlReady());
    track.classList.toggle('uc-sr-flat', embed);
    playBtn.disabled = !tlReady() || (embed && !yt?.alive);
  }
  function renderSel() {
    if (!prep) return;
    const a = pct(sel.startMs), b = pct(sel.endMs);
    hStart.style.left = `${a}%`;
    hEnd.style.left = `${b}%`;
    $('.uc-sr-sel').style.left = `${a}%`;
    $('.uc-sr-sel').style.width = `${b - a}%`;
    $('.uc-sr-dim-l').style.width = `${a}%`;
    $('.uc-sr-dim-r').style.left = `${b}%`;
    $('.uc-sr-ts').textContent = formatClipTime(sel.startMs);
    $('.uc-sr-te').textContent = formatClipTime(sel.endMs);
    $('.uc-sr-tl2').textContent = formatClipLength(sel.endMs - sel.startMs);
    for (const [h, v] of [[hStart, sel.startMs], [hEnd, sel.endMs]]) {
      h.setAttribute('aria-valuemin', '0');
      h.setAttribute('aria-valuemax', String(prep.durationMs));
      h.setAttribute('aria-valuenow', String(v));
      h.setAttribute('aria-valuetext', formatClipTime(v));
    }
  }
  function setHandle(which, value) {
    if (!tlReady()) return;
    sel = moveHandle(sel, which, value, prep.durationMs);
    renderSel();
    const t = currentMs();
    if (isPlaying() && (t < sel.startMs || t > sel.endMs)) stopPlay();
  }
  const msAt = (clientX) => {
    const r = track.getBoundingClientRect();
    return r.width > 0 ? ((clientX - r.left) / r.width) * prep.durationMs : 0;
  };
  // Tah myší i dotykem (Pointer Events + capture); klik do osy přesune bližší značku a tah pokračuje.
  let drag = null;
  track.addEventListener('pointerdown', (e) => {
    if (!tlReady() || (e.button !== undefined && e.button !== 0)) return;
    e.preventDefault();
    const h = e.target.closest('.uc-sr-h');
    const v = msAt(e.clientX);
    drag = h ? h.dataset.h : (Math.abs(v - sel.startMs) <= Math.abs(v - sel.endMs) ? 'start' : 'end');
    try { track.setPointerCapture(e.pointerId); } catch { /* syntetické události */ }
    (drag === 'start' ? hStart : hEnd).focus({ preventScroll: true });
    track.classList.add('dragging');
    if (!h) setHandle(drag, v);
  });
  track.addEventListener('pointermove', (e) => { if (drag) setHandle(drag, msAt(e.clientX)); });
  const endDrag = () => {
    if (!drag) return;
    L(`výběr ${sel.startMs}–${sel.endMs} ms`);
    drag = null;
    track.classList.remove('dragging');
  };
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);
  for (const h of [hStart, hEnd]) {
    h.addEventListener('keydown', (e) => {
      if (!tlReady()) return;
      const which = h.dataset.h;
      const cur = which === 'start' ? sel.startMs : sel.endMs;
      const d = e.shiftKey ? KEY_STEP_BIG_MS : KEY_STEP_MS;
      let v = null;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = cur - d;
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = cur + d;
      else if (e.key === 'Home') v = 0;
      else if (e.key === 'End') v = prep.durationMs;
      if (v === null) return;
      e.preventDefault();
      setHandle(which, v);
    });
  }

  // ---- přehrání úseku (bez zesílení — gainDb se měří až při odeslání) ----
  // Server režim: <audio> z previewUrl. Embed režim (YouTube blokuje stahování ze serveru):
  // přehrávač youtube-nocookie ovládaný postMessage, čas ze zpráv infoDelivery.
  const audio = new win.Audio();
  audio.preload = 'auto';
  let raf = null;
  const perfNow = () => (win.performance?.now ? win.performance.now() : Date.now());
  const isPlaying = () => (prep?.mode === 'embed' ? !!yt?.playing : !audio.paused);
  function currentMs() {
    if (prep?.mode !== 'embed') return audio.currentTime * 1000;
    if (!yt) return 0;
    return yt.t + (yt.playing ? perfNow() - yt.at : 0);
  }
  function tick() {
    const t = currentMs();
    if (!isPlaying() || t >= sel.endMs) { stopPlay(); return; }
    playhead.style.left = `${pct(t)}%`;
    raf = win.requestAnimationFrame(tick);
  }
  function stopPlay() {
    if (raf) win.cancelAnimationFrame(raf);
    raf = null;
    try { audio.pause(); } catch { /* ignore */ }
    if (yt?.playing) { yt.playing = false; ytCommand('pauseVideo'); }
    playhead.hidden = true;
    playBtn.innerHTML = PLAY_SVG;
    playBtn.classList.remove('playing');
    playBtn.setAttribute('aria-label', 'Přehrát úsek');
  }
  function showPlaying() {
    playBtn.innerHTML = STOP_SVG;
    playBtn.classList.add('playing');
    playBtn.setAttribute('aria-label', 'Zastavit');
    playhead.hidden = false;
    playhead.style.left = `${pct(sel.startMs)}%`;
  }
  async function play() {
    if (!tlReady()) return;
    if (isPlaying()) { stopPlay(); return; }
    if (prep.mode === 'embed') {
      if (!yt?.alive) return;
      ytCommand('seekTo', [sel.startMs / 1000, true]);
      ytCommand('playVideo');
      Object.assign(yt, { playing: true, t: sel.startMs, at: perfNow(), seekAt: perfNow() });
      showPlaying();
      raf = win.requestAnimationFrame(tick);
      return;
    }
    try {
      if (audio.dataset.src !== prep.previewUrl) { audio.src = prep.previewUrl; audio.dataset.src = prep.previewUrl; }
      audio.currentTime = sel.startMs / 1000;
      showPlaying();
      await audio.play();
      raf = win.requestAnimationFrame(tick);
    } catch (e) {
      stopPlay();
      L(`přehrání selhalo: ${e?.message || e}`);
      setError('Náhled nejde přehrát, zkus to znovu.');
    }
  }

  // ---- přehrávač YouTube (embed) ----
  let ytSeq = 0;
  function ytPost(obj) {
    try { yt?.iframe?.contentWindow?.postMessage(JSON.stringify({ ...obj, id: yt.id, channel: 'widget' }), YT_EMBED_HOST); } catch { /* ignore */ }
  }
  function ytCommand(func, args = []) { ytPost({ event: 'command', func, args }); }
  function clearYtTimers() {
    for (const t of yt?.timers || []) { win.clearInterval(t); win.clearTimeout(t); }
    if (yt) yt.timers = [];
  }
  function ytTeardown() {
    if (!yt) return;
    clearYtTimers();
    yt.iframe.remove();
    yt = null;
  }
  function ytSetup() {
    ytTeardown();
    manual = false;
    const url = youtubeEmbedUrl(prep.videoId, win.location?.origin);
    const iframe = doc.createElement('iframe');
    iframe.className = 'uc-sr-yt-frame';
    iframe.title = 'Náhled videa YouTube';
    iframe.allow = 'autoplay; encrypted-media';
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.src = url;
    $('.uc-sr-yt-box').appendChild(iframe);
    yt = { iframe, id: ++ytSeq, alive: false, playing: false, t: 0, at: 0, seekAt: 0, timers: [] };
    const cur = yt;
    // „listening“ opakovaně, dokud přehrávač neodpoví (stejně jako oficiální IFrame API).
    const hello = () => { if (yt === cur && !cur.alive) ytPost({ event: 'listening' }); };
    iframe.addEventListener('load', hello);
    cur.timers.push(win.setInterval(hello, 500));
    cur.timers.push(win.setTimeout(() => {
      if (yt !== cur || cur.alive) return;
      L(`embed ${prep.videoId}: přehrávač neodpověděl do ${EMBED_TIMEOUT_MS} ms → ruční časy`);
      startManual();
    }, EMBED_TIMEOUT_MS));
    L(`embed ${url}`);
  }
  function ytDuration(ms) {
    if (!prep || !(ms > 0) || prep.durationMs > 0) return;
    prep.durationMs = Math.round(ms);
    sel = defaultSelection(prep.durationMs);
    renderSrc();
    renderMode();
    renderSel();
    L(`embed délka ${prep.durationMs} ms`);
  }
  function onMessage(e) {
    if (!yt || e.source !== yt.iframe.contentWindow || !isYoutubeOrigin(e.origin)) return;
    let d = e.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return; } }
    if (!d || typeof d !== 'object') return;
    if (!yt.alive && (d.event === 'onReady' || d.event === 'infoDelivery' || d.event === 'initialDelivery')) {
      yt.alive = true;
      clearYtTimers();
      L('embed přehrávač odpověděl');
    }
    const info = d.info && typeof d.info === 'object' ? d.info : null;
    if (info) {
      if (Number.isFinite(info.duration) && info.duration > 0) ytDuration(info.duration * 1000);
      // Po seekTo chvíli chodí ještě starý čas → krátce ignorovat.
      if (Number.isFinite(info.currentTime) && perfNow() - yt.seekAt > 700) { yt.t = info.currentTime * 1000; yt.at = perfNow(); }
      if ((info.playerState === 0 || info.playerState === 2) && yt.playing && perfNow() - yt.seekAt > 1000) stopPlay();
    }
    renderMode();
  }
  win.addEventListener('message', onMessage);

  // ---- ruční časy (embed odmítnut) ----
  function startManual() {
    stopPlay();
    ytTeardown();
    manual = true;
    $('.uc-sr-ytlink').href = `https://www.youtube.com/watch?v=${encodeURIComponent(prep.videoId || '')}`;
    fromInput.value = formatClipTime(sel.startMs).replace(/,0$/, '');
    toInput.value = sel.endMs > 0 ? formatClipTime(sel.endMs).replace(/,0$/, '') : '';
    renderMode();
    renderManual();
  }
  function renderManual() {
    const a = parseClipTime(fromInput.value), b = parseClipTime(toInput.value);
    const err = manualRangeError(a, b, prep?.durationMs || 0);
    $('.uc-sr-manual-len').textContent = a !== null && b !== null && b > a ? `Délka ${formatClipLength(b - a)}` : '';
    fromInput.classList.toggle('invalid', !!fromInput.value.trim() && a === null);
    toInput.classList.toggle('invalid', !!toInput.value.trim() && (b === null || (!!err && err !== 'bad_time')));
    if (!err) sel = { startMs: a, endMs: b };
    return err;
  }

  // ---- načtení odkazu ----
  async function load() {
    const url = urlInput.value.trim();
    setError('');
    if (!/^https?:\/\/\S{4,}$/i.test(url)) { setError(sfxRequestErrorText('bad_url')); urlInput.focus(); return; }
    if (limitReached(limits)) { renderLimits(); return; }
    setLoading(true);
    L(`prepare ${url.slice(0, 120)}`);
    try {
      const r = await api.prepare(url);
      const embed = r.mode === 'embed';
      prep = {
        previewId: r.previewId, mode: embed ? 'embed' : 'server', durationMs: Number(r.durationMs) > 0 ? Math.round(Number(r.durationMs)) : 0,
        peaks: Array.isArray(r.peaks) ? r.peaks : [], previewUrl: r.previewUrl || null, videoId: r.videoId || null, title: r.title || '', source: r.source,
      };
      if (r.limits) limits = r.limits;
      sel = defaultSelection(prep.durationMs);
      audio.removeAttribute('src'); delete audio.dataset.src;
      manual = false;
      renderSrc();
      renderWave();
      setLoading(false);
      setStep('edit');
      if (embed) {
        if (youtubeEmbedUrl(prep.videoId)) ytSetup();
        else startManual();   // bez videoId přehrávač nejde → rovnou ruční časy
      }
      renderMode();
      renderSel();
      if (!nameInput.value) nameInput.focus({ preventScroll: true });
      L(`prepare ok ${prep.mode} ${prep.source} ${prep.durationMs} ms peaks=${prep.peaks.length}${prep.videoId ? ` video=${prep.videoId}` : ''}`);
    } catch (e) {
      setLoading(false);
      setStep('link');
      if (e?.limits) { limits = e.limits; renderLimits(); }
      setError(sfxRequestErrorText(e, 'prepare'));
      L(`prepare FAIL ${e?.error || e?.message || e}`);
    }
  }

  function renderSrc() {
    const src = prep.source === 'youtube' ? 'YouTube' : 'mp3';
    $('.uc-sr-src').innerHTML = `<b>${esc(src)}</b>${prep.title ? ` · ${esc(prep.title)}` : ''}${prep.durationMs > 0 ? ` · ${esc(formatClipTime(prep.durationMs))}` : ''}`;
  }

  function renderCmd() {
    const n = normalizeRequestName(nameInput.value);
    $('.uc-sr-cmd').textContent = n ? `!se ${n}` : '';
    nameInput.classList.toggle('invalid', !!nameInput.value.trim() && !n);
  }

  async function submit() {
    if (!prep || busy) return;
    setError('');
    const name = normalizeRequestName(nameInput.value);
    if (!name) { setError(nameInput.value.trim() ? sfxRequestErrorText('bad_name') : 'Vyplň název zvuku.'); nameInput.focus(); return; }
    if (limitReached(limits)) { renderLimits(); return; }
    if (manual) {
      const err = renderManual();
      if (err) { setError(sfxRequestErrorText(err, 'submit')); return; }
    } else if (!tlReady()) { setError('Počkej, až se načte video.'); return; }
    stopPlay();
    busy = true; goBtn.disabled = true;
    const body = { previewId: prep.previewId, startMs: Math.round(sel.startMs), endMs: Math.round(sel.endMs), name, note: noteInput.value.trim() || undefined };
    L(`submit ${name} ${body.startMs}–${body.endMs} ms`);
    try {
      const r = await api.submit(body);
      if (r?.limits) limits = r.limits;
      // Náhled je po odeslání spotřebovaný — další úsek = nové Načíst.
      prep = null;
      $('.uc-sr-done').innerHTML = `<p>Návrh <b>${esc(name)}</b> je odeslaný. Mod nebo streamer ho posoudí v Židolištce, stav uvidíš níže v Moje návrhy.</p><button type="button" class="uc-sr-go" data-act="again">Navrhnout další</button>`;
      nameInput.value = ''; noteInput.value = ''; urlInput.value = '';
      renderCmd();
      busy = false;
      setStep('done');
      L(`submit ok id=${r?.requestId}`);
      refresh();
    } catch (e) {
      busy = false;
      if (e?.limits) limits = e.limits;
      renderLimits();
      setError(sfxRequestErrorText(e, 'submit'));
      L(`submit FAIL ${e?.error || e?.message || e}`);
      if (e?.error === 'expired') { prep = null; setStep('link'); setError(sfxRequestErrorText(e, 'submit')); }
    }
  }

  // ---- moje návrhy ----
  function renderList() {
    const list = $('.uc-sr-list');
    if (!requests.length) { list.innerHTML = '<div class="uc-sr-empty">Zatím žádné návrhy.</div>'; return; }
    list.innerHTML = requests.map((r) => {
      const st = REQUEST_STATUS_TEXT[r.status] || r.status;
      const sub = r.status === 'approved' && r.soundName ? `<div class="uc-sr-rsub">!se ${esc(r.soundName)}</div>`
        : r.status === 'rejected' && r.reason ? `<div class="uc-sr-rsub">${esc(r.reason)}</div>` : '';
      return `<div class="uc-sr-r" data-id="${esc(r.requestId)}"><div class="uc-sr-rrow"><span class="uc-sr-rn">${esc(r.name)}</span><span class="uc-sr-st uc-sr-st-${esc(r.status)}">${esc(st)}</span></div>${sub}</div>`;
    }).join('');
  }
  async function refresh() {
    const seq = ++listSeq;
    try {
      const r = await api.list();
      if (seq !== listSeq) return;
      requests = Array.isArray(r?.requests) ? r.requests : [];
      if (r?.limits) limits = r.limits;
      renderList();
      renderLimits();
      onChange?.({ requests, limits });
    } catch (e) {
      if (seq !== listSeq) return;
      L(`list FAIL ${e?.error || e?.message || e}`);
      if (!requests.length) $('.uc-sr-list').innerHTML = `<div class="uc-sr-empty">${esc(sfxRequestErrorText(e))}</div>`;
    }
  }

  // ---- události ----
  linkForm.addEventListener('submit', (e) => { e.preventDefault(); load(); });
  editForm.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  nameInput.addEventListener('input', renderCmd);
  fromInput.addEventListener('input', renderManual);
  toInput.addEventListener('input', renderManual);
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'back') { stopPlay(); onBack?.(); }
    else if (act === 'play') play();
    else if (act === 'other') { prep = null; setError(''); setStep('link'); urlInput.focus(); }
    else if (act === 'again') { setError(''); setStep('link'); urlInput.focus(); }
  });
  // Klávesy zůstanou v panelu (chat pod ním je nedostane); Esc = zpět.
  root.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); stopPlay(); onBack ? onBack() : close(); }
  });

  function open() {
    root.classList.remove('hidden');
    button?.classList.add('active');
    renderLimits();
    refresh();
    if (step === 'link' && !(typeof win.matchMedia === 'function' && win.matchMedia('(pointer: coarse)').matches)) urlInput.focus({ preventScroll: true });
    L('otevřeno');
  }
  function close() {
    stopPlay();
    root.classList.add('hidden');
    button?.classList.remove('active');
  }
  const isOpen = () => !root.classList.contains('hidden');

  setStep('link');
  renderList();

  return {
    open, close, isOpen,
    /** Znovu načíst „Moje návrhy“ + limit (po SSE sfx-request). */
    update: refresh,
    /** SSE sfx-request: obnovit, když jde o můj návrh (je v seznamu) nebo je panel otevřený. */
    onSse(data) {
      if (isOpen() || requests.some((r) => String(r.requestId) === String(data?.requestId))) refresh();
    },
    destroy() { stopPlay(); ytTeardown(); win.removeEventListener('message', onMessage); root.remove(); },
  };
}
