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
