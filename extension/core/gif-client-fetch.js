// Stažení GIFu prohlížečem odesílatele (spec docs/superpowers/specs/2026-09-29-gif-stazeni-prohlizecem-design.md §4):
// server médium stáhnout nemůže (host blokuje jeho IP), zná ale adresu, typ a rozměry a poslal odesílateli jednorázový
// token (gif-progress client_fetch, core gif-library.js GifOutbox). Tady: štítek s tlačítky → fetch() z prohlížeče
// (CORS, bez cookies, jen adresa ze serveru) → upload bajtů s tokenem. Sdílené addonem i webem; host dodá upload/decline.
import { GIF_MAX_BYTES } from './gif.js';

export const CLIENT_FETCH_TIMEOUT_MS = 20_000;

/**
 * Stáhne `url` v prohlížeči odesílatele (CORS, bez cookies, jen adresa poslaná serverem), ohlídá velikost před i po
 * stažení a nahraje bajty přes `upload(bytes, token, remember)`. Nikdy nic neloguje s tokenem uvnitř (volající loguje
 * jen host / kód chyby). Vrací `{ ok: true } | { ok: false, code }`.
 */
export async function runClientFetch({ url, token, maxBytes = GIF_MAX_BYTES, remember = false, fetchImpl, upload, onProgress = () => {} }) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  let res;
  try {
    res = await doFetch(url, { mode: 'cors', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(CLIENT_FETCH_TIMEOUT_MS) });
  } catch { return { ok: false, code: 'network' }; }
  if (!res.ok) return { ok: false, code: 'network' };
  // Content-Length dřív, než se stahují bajty — ušetří přenos, když je server (Bright Data) upřímný o velikosti.
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > maxBytes) return { ok: false, code: 'too_large' };
  let buf;
  try { buf = await res.arrayBuffer(); } catch { return { ok: false, code: 'network' }; }
  // Server mohl lhát (chybějící / špatná Content-Length) → ověřit ještě po stažení.
  if (buf.byteLength > maxBytes) return { ok: false, code: 'too_large' };
  if (!buf.byteLength) return { ok: false, code: 'bad_type' };
  onProgress(75);
  try {
    const r = await upload(buf, token, remember);
    return r?.ok ? { ok: true } : { ok: false, code: r?.error || (r?.status === 429 ? 'rate_limited' : 'upload') };
  } catch (e) { return { ok: false, code: e?.error || (e?.status === 429 ? 'rate_limited' : 'upload') }; }
}

/**
 * Delegované klikání na tlačítka štítku výzvy (core/gif-library.js paintGifStatus, `.uc-gif-st--client_fetch`,
 * `[data-cf="yes"|"no"|"remember"]`) + automatika podle uložené předvolby účtu (always/never).
 * deps: { outbox, upload(bytes, token, remember) → Promise<{ok, error?, status?}>, decline(token, remember) → Promise,
 *         fetchImpl?, log?, pref: () => 'ask'|'always'|'never' }
 * Vrací funkci pro odinstalování (uklidí listener i hák na `outbox.onClientFetch`).
 */
export function installGifClientFetch(doc, chatEl, { outbox, upload, decline, fetchImpl, log = () => {}, pref = () => 'ask' } = {}) {
  if (!chatEl || !outbox) return () => {};
  const keyOf = (st) => { const m = st.closest('.msg'); return m ? { platform: m.dataset.platform, id: m.dataset.msgId } : null; };
  const go = async (platform, id, remember) => {
    const v = outbox.view(platform, id);
    // Ochrana proti dvojkliku / dvojí automatice: jakmile stahování začne, view().kind už není 'client_fetch'.
    if (!v || v.kind !== 'client_fetch') return;
    outbox.clientFetchStarted(platform, id);
    log('Gif', `stahuji z ${v.host} prohlížečem${remember ? ' (zapamatovat)' : ''}`);
    const r = await runClientFetch({ url: v.url, token: v.token, remember, fetchImpl, upload });
    if (!r.ok) { outbox.clientFetchFailed(platform, id, r.code); log('Gif', `stažení prohlížečem selhalo: ${r.code}`); }
  };
  const no = async (platform, id, remember) => {
    const v = outbox.view(platform, id);
    if (!v || v.kind !== 'client_fetch') return;
    try { await decline(v.token, remember); } catch { /* server grant zruší po TTL */ }
    outbox.onNotice({ requestKey: `${platform}:${id}`, platform, messageId: id, kind: 'client_declined' });
  };
  const onClick = (e) => {
    const b = e.target?.closest?.('[data-cf="yes"],[data-cf="no"]');
    if (!b || !chatEl.contains(b)) return;
    const st = b.closest('.uc-gif-st--client_fetch');
    const k = st && keyOf(st);
    if (!k) return;
    e.preventDefault(); e.stopPropagation();
    const remember = !!st.querySelector('[data-cf="remember"]')?.checked;
    if (b.dataset.cf === 'yes') void go(k.platform, k.id, remember); else void no(k.platform, k.id, remember);
  };
  chatEl.addEventListener('click', onClick);
  // Předvolba účtu: always → rovnou stáhnout, never → rovnou odmítnout (bez zapamatování znovu — už je uložená).
  const prev = outbox.onClientFetch;
  outbox.onClientFetch = (entry, p) => {
    prev?.(entry, p);
    const eff = p.pref !== 'ask' ? p.pref : pref();
    if (eff === 'always') void go(entry.platform, entry.messageId, false);
    else if (eff === 'never') void no(entry.platform, entry.messageId, false);
  };
  return () => { chatEl.removeEventListener('click', onClick); outbox.onClientFetch = prev || null; };
}
