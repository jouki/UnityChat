// Moderace — sdílený vzhled smazané/skryté zprávy napříč addonem, webem i OBS.
// „Smazáno" = moderátorská akce na platformě (timeout/ban/delete/CLEARCHAT
// nebo CLEARMSG), „skryto" = UnityChat zprávu jen lokálně schová bez zásahu
// na platformě („Jen UC skrýt", Task 8 controller — divák jinde v chatu
// zprávu dál vidí). Divákovi bez moderátorských práv se skrytá zpráva chová
// jako `hide` (úplně zmizí), moderátorovi jako `dim` (musí vidět kontext pro
// rozhodnutí), se štítkem „Skryto v UnityChatu" místo „Smazáno".
//
// Styly pro smazané zprávy (konfigurovatelné, `style` param):
//   'label'  — text zmizí, zůstane kurzívní poznámka (výchozí)
//   'dim'    — text zůstane, jen ztlumený + malý štítek
//   'strike' — text zůstane přeškrtnutý + štítek
//   'hide'   — zpráva úplně zmizí z DOM
// Moderátor vidí vždy 'dim' (potřebuje přečíst kontext), `raw` (neanonymizovaný
// log/audit pohled) vidí vždy 'label' bez ohledu na roli — s výjimkou `hidden`,
// kde ani raw pohled zprávu z platformy stále nemazal, takže se řídí rolí.
//
// Žádné chrome.*, žádný globální DOM — vše se předává přes parametry.

export const DELETED_STYLES = ['label', 'dim', 'strike', 'hide'];
export const DEFAULT_DELETED_STYLE = 'label';

/**
 * Rozhodne, jak zprávu zobrazit danému divákovi.
 * @param {{style?: string, isMod?: boolean, raw?: boolean, hidden?: boolean}} opts
 * @returns {'label'|'dim'|'strike'|'hide'}
 */
export function deletedMode({ style, isMod, raw, hidden } = {}) {
  if (hidden) return isMod ? 'dim' : 'hide';
  if (raw) return 'label';
  if (isMod) return 'dim';
  return DELETED_STYLES.includes(style) ? style : DEFAULT_DELETED_STYLE;
}

/**
 * Aplikuje vizuální stav smazané/skryté zprávy na DOM element. Idempotentní —
 * opakované volání se stejnými (nebo jinými) opts nezdvojí štítky ani labely.
 * Nikdy nepoužívá innerHTML s nedůvěryhodným textem (jen textContent).
 * @param {HTMLElement} el       kořenový element zprávy (`.msg`)
 * @param {{mode: string, label?: string, hasContent?: boolean, hidden?: boolean}} opts
 */
export function applyDeleted(el, opts = {}) {
  if (!el) return;
  const { mode: rawMode, label = 'Zpráva smazána', hasContent = true, hidden = false } = opts;
  const mode = DELETED_STYLES.includes(rawMode) ? rawMode : DEFAULT_DELETED_STYLE;

  if (mode === 'hide') {
    // Nejdřív smazat případný předchozí stav (tag/jiné mode třídy), pak schovat.
    clearDeleted(el);
    el.classList.add('uc-deleted', 'uc-deleted--hide');
    el.hidden = true;
    return;
  }

  el.hidden = false;
  for (const m of DELETED_STYLES) el.classList.remove(`uc-deleted--${m}`);
  el.classList.add('uc-deleted', `uc-deleted--${mode}`);

  const doc = el.ownerDocument || (typeof document !== 'undefined' ? document : null);
  const q = (sel) => (typeof el.querySelector === 'function' ? el.querySelector(sel) : null);
  const showLabel = mode === 'label' || !hasContent;

  if (showLabel) {
    // label štítek nahrazuje text — samostatný tag by byl nadbytečný.
    const staleTag = q('.uc-deleted-tag');
    if (staleTag && typeof staleTag.remove === 'function') staleTag.remove();
    const tx = q('.tx');
    if (tx && doc) {
      const span = doc.createElement('span');
      span.className = 'uc-deleted-label';
      span.textContent = label;
      if (typeof tx.replaceChildren === 'function') tx.replaceChildren(span);
      else { tx.textContent = ''; tx.appendChild(span); }
    }
  } else {
    // dim/strike — text zůstává, jen se přidá/aktualizuje malý štítek.
    let tag = q('.uc-deleted-tag');
    if (!tag && doc) {
      tag = doc.createElement('span');
      tag.className = 'uc-deleted-tag';
      el.appendChild(tag);
    }
    if (tag) tag.textContent = hidden ? 'Skryto v UnityChatu' : 'Smazáno';
  }
}

/**
 * Vrátí element do stavu před `applyDeleted` — odstraní `uc-deleted*` třídy,
 * štítek a `hidden`. Obnovu původního obsahu `.tx` (odstraněného v 'label'
 * režimu) NEDĚLÁ — to je na hostu, který zprávu znovu vykreslí z dat (stejný
 * princip jako u ChatStore: DOM se nepatchuje, znovu se vyrenderuje).
 * @param {HTMLElement} el
 */
export function clearDeleted(el) {
  if (!el) return;
  el.classList.remove('uc-deleted');
  for (const m of DELETED_STYLES) el.classList.remove(`uc-deleted--${m}`);
  const tag = typeof el.querySelector === 'function' ? el.querySelector('.uc-deleted-tag') : null;
  if (tag && typeof tag.remove === 'function') tag.remove();
  el.hidden = false;
}

// ---- Část 2: timeout / ban uživatele (SSE user-moderated, Twitch CLEARCHAT) ----

/** Délka v sekundách → „5 s", „1 min", „2 h", „3 dny" (hlášky a štítky moderace). */
export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${String(Math.round((s / 3600) * 10) / 10).replace('.', ',')} h`;
  const d = Math.round(s / 86400);
  return `${d} ${d === 1 ? 'den' : d < 5 ? 'dny' : 'dní'}`;
}

/**
 * Text štítku u zpráv moderovaného uživatele: „Timeout (5 min)" / „Zabanován" / null (unban).
 * Délka timeoutu: `durationSec`, jinak `until - at` (SSE user-moderated), jinak `until - now`.
 * @param {{action: string, until?: number|null, at?: number|string|null, durationSec?: number|null, now?: number}} o
 */
export function modTagText({ action, until = null, at = null, durationSec = null, now = Date.now() } = {}) {
  if (action === 'ban') return 'Zabanován';
  if (action !== 'timeout') return null;
  let sec = Number(durationSec);
  if (!(sec > 0) && until) {
    const from = at ? (typeof at === 'number' ? at : Date.parse(at)) : now;
    sec = (Number(until) - (Number.isFinite(from) ? from : now)) / 1000;
  }
  return sec > 0 ? `Timeout (${fmtDuration(sec)})` : 'Timeout';
}

/**
 * Normalizace SSE `user-moderated` (a lokálního Twitch CLEARCHAT) — null = neplatná / cizí kanál.
 * @param {object} d  { channel, platform, userId, login, action, until, by, at }
 * @param {string} [channel]  aktuální UC kanál (Twitch login streamera); bez něj se kanál nekontroluje
 */
export function normalizeUserModerated(d, channel) {
  if (!d || typeof d !== 'object') return null;
  if (!['timeout', 'ban', 'unban'].includes(d.action)) return null;
  if (!['twitch', 'kick', 'youtube'].includes(d.platform)) return null;
  if (channel != null && String(d.channel || '').toLowerCase() !== String(channel).toLowerCase()) return null;
  const userId = d.userId != null && d.userId !== '' ? String(d.userId) : null;
  const login = d.login ? String(d.login).toLowerCase().replace(/^@/, '') : null;
  if (!userId && !login) return null;
  return { platform: d.platform, userId, login, action: d.action, until: Number(d.until) || null, at: d.at ?? null, by: d.by ?? null, tag: modTagText(d) };
}

/**
 * Štítek moderace uživatele na zprávě (`.uc-mod-tag`). `text` null = štítek pryč (unban).
 * Idempotentní; se štítkem se schová obecné „Smazáno" (`.uc-mod-tagged`), ať nejsou dva.
 */
export function applyModTag(el, text) {
  if (!el) return;
  const q = typeof el.querySelector === 'function' ? el.querySelector('.uc-mod-tag') : null;
  if (!text) {
    if (q && typeof q.remove === 'function') q.remove();
    el.classList.remove('uc-mod-tagged');
    return;
  }
  let tag = q;
  if (!tag) {
    const doc = el.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) return;
    tag = doc.createElement('span');
    tag.className = 'uc-mod-tag';
    el.appendChild(tag);
  }
  tag.textContent = text;
  el.classList.add('uc-mod-tagged');
}
