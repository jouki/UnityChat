// Broadcast jako JEDNA zpráva (pokyn usera 2026-10-02) — addon i web.
// Kopie téže zprávy na víc platformách (Broadcast moda / streamera) se v UnityChatu nekreslí 3×: první vykreslená
// zpráva dostane místo loga platformy řadu menších log všech cílů a další kopie do ní „vstřebají“ (nevykreslí se).
//   - logo ztmavené = na platformě zatím nepotvrzeno, rozsvícené = kopie z chatu platformy dorazila,
//     s vykřičníkem = neodesláno (tooltip s důvodem),
//   - vlastní zpráva je celá ztmavená, dokud nedorazí první kopie (uc-bc-pending).
// Skupinu pozná klient podle `bcast: { id, targets }` (historie, /chat/stream — backend lib/ucSends.ts attachBcast),
// živě z vlastního IRC / Pusheru přes SSE `bcast-mark`, vlastní odeslání podle lokálního klíče + id skupiny
// z odpovědi /chat/broadcast. Bez chrome.*; DOM jen přes předané prvky.

export const BC_PLATFORMS = ['twitch', 'kick', 'youtube'];
const CLS = { twitch: 'tw', youtube: 'yt', kick: 'ki' };
const NAMES = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Stav loga platformy: 'on' | 'fail' | 'wait'. */
export function bcLogoState(entry, platform) {
  if (entry.failed.has(platform)) return 'fail';
  return entry.sent.has(platform) ? 'on' : 'wait';
}

/** HTML řady log (čisté, testovatelné). */
export function bcLogosHtml(entry) {
  return entry.targets.filter((p) => CLS[p]).map((p) => {
    const st = bcLogoState(entry, p);
    const tip = st === 'on' ? `${NAMES[p]} — odesláno`
      : st === 'fail' ? `${NAMES[p]} — neodesláno${entry.failed.get(p) ? `: ${entry.failed.get(p)}` : ''}`
        : `${NAMES[p]} — čeká na potvrzení`;
    return `<span class="uc-bc-slot uc-bc-${st}" data-platform="${p}" data-tooltip="${esc(tip)}"><span class="pi ${CLS[p]} uc">${CLS[p].toUpperCase()}</span>`
      + `${st === 'fail' ? '<span class="uc-bc-warn" aria-label="neodesláno">!</span>' : ''}</span>`;
  }).join('');
}

/** Překreslit skupinu do jejího prvku zprávy. */
export function paintBroadcast(entry) {
  const el = entry.el;
  if (!el) return;
  el.classList.add('uc-bc');
  let row = el.querySelector(':scope > .pi-bc');
  if (!row) {
    row = el.ownerDocument.createElement('span');
    row.className = 'pi-bc';
    const pi = el.querySelector(':scope > .pi');
    if (pi) pi.before(row); else el.prepend(row);
  }
  row.innerHTML = bcLogosHtml(entry);
  const allFailed = entry.targets.length > 0 && entry.targets.every((p) => entry.failed.has(p));
  el.classList.toggle('uc-bc-pending', entry.own && !entry.sent.size && !allFailed);
}

/**
 * Skupiny broadcastu v jednom chatu. Klíč = id skupiny ze serveru, u vlastního odeslání i lokální id optimistické
 * zprávy (alias, dokud server id nevrátí). Kopie z platformy, která do skupiny vstřebala, se pamatuje podle id.
 */
export function createBroadcastGroups({ log } = {}) {
  const groups = new Map();   // klíč → entry
  const marks = new Map();    // id zprávy → { group, targets } (SSE bcast-mark dřív než zpráva)
  const absorbed = new Set(); // id kopií, které se nekreslí
  const cap = (m, n = 500) => { while (m.size > n) m.delete(m.keys().next().value); };

  const api = {
    /** Nová skupina pro vykreslený prvek. `own` = vlastní odeslání (ztmavené do první kopie). */
    create(key, el, targets, { own = false, sent = [], msgId = null } = {}) {
      const entry = { keys: new Set([key]), el, targets: BC_PLATFORMS.filter((p) => targets.includes(p)), sent: new Set(sent), failed: new Map(), own, primaryId: msgId };
      groups.set(key, entry);
      cap(groups, 300);
      paintBroadcast(entry);
      return entry;
    },
    get: (key) => (key != null ? groups.get(String(key)) : undefined),
    /** Druhý klíč téže skupiny (id skupiny ze serveru k lokálnímu klíči). */
    alias(key, other) {
      const e = groups.get(key);
      if (!e || !other) return;
      e.keys.add(other);
      groups.set(other, e);
    },
    /** Kopie z platformy dorazila (nebo už je to první vykreslená). */
    sent(key, platform) {
      const e = groups.get(key);
      if (!e) return;
      e.failed.delete(platform);
      e.sent.add(platform);
      paintBroadcast(e);
      log?.('Broadcast', `${platform} potvrzeno (${[...e.sent].join(',')}/${e.targets.join(',')})`);
    },
    failed(key, platform, reason) {
      const e = groups.get(key);
      if (!e || e.sent.has(platform)) return;
      e.failed.set(platform, String(reason || ''));
      paintBroadcast(e);
      log?.('Broadcast', `${platform} neodesláno: ${reason || '?'}`);
    },
    /** Všechny cíle selhaly? (host pak zprávu označí jako neodeslanou celou) */
    allFailed(key) { const e = groups.get(key); return !!e && e.targets.every((p) => e.failed.has(p)); },
    /** Cíle skupiny doplnit (odpověď bota z další platformy — cíle se dozvídáme postupně). */
    extend(key, targets) {
      const e = groups.get(key);
      if (!e || !Array.isArray(targets)) return;
      const add = targets.filter((p) => BC_PLATFORMS.includes(p) && !e.targets.includes(p));
      if (!add.length) return;
      e.targets = BC_PLATFORMS.filter((p) => e.targets.includes(p) || add.includes(p));
      paintBroadcast(e);
    },
    /** Zpráva `id` patří do skupiny, která už má vykreslený prvek → nekreslit, jen rozsvítit logo (`targets` doplní cíle). */
    absorb(key, platform, id, targets = null) {
      const e = groups.get(key);
      if (e && targets) api.extend(key, targets);
      // Prvek může být zaparkovaný mimo DOM (okno 300 uzlů) — pořád je to vykreslená zpráva skupiny.
      if (!e || !e.el) return false;
      if (id != null && String(id) === String(e.primaryId)) return false;
      if (id != null) { absorbed.add(String(id)); cap(absorbed); }
      api.sent(key, platform);
      return true;
    },
    isAbsorbed: (id) => id != null && absorbed.has(String(id)),
    /** SSE bcast-mark: zapamatovat (zpráva může přijít až po marku). */
    noteMark({ id, group, targets }) {
      if (!id || !group) return;
      marks.set(String(id), { id: group, targets: Array.isArray(targets) ? targets : [] });
      cap(marks);
      api.extend(group, targets);
    },
    markFor: (id) => (id != null ? marks.get(String(id)) : undefined),
  };
  return api;
}
