// Reakce „Peepo poop" (2026-09-22): mod/broadcaster spustí na zprávě animaci, kterou
// vidí všichni (addon i web) — SSE `reaction` z backendu (POST /reactions).
// Sdílené: časování, normalizace eventu a přehrání v DOM (host = #chat-wrapper,
// cíl = element zprávy). Video peepo-chat-alpha-v2.webm: 1440×288 (5:1), 15 s,
// průhledné; Peepo jde po spodním okraji, hromádka se objeví v 7,2 s.
//
// Průběh: t=0 zatmívání + reflektor na zprávu (1,2 s) + start videa; t=7,2 s jméno a
// logo platformy u cílové zprávy zhnědnou; t=15 s konec videa, odtmívání (1,2 s),
// tlačítko zpět; t=22,2 s hnědá začne 15 s přecházet zpět; t=37,2 s hotovo.

export const POOP = Object.freeze({
  kind: 'poop',
  videoMs: 15_000,
  fadeMs: 1200,
  brownAtMs: 7200,
  brownFlatMs: 15_000,
  brownFadeMs: 15_000,
  aspect: 5,          // šířka : výška videa (1440×288)
  // „Země" (spodek postavičky) je v 95,5 % výšky videa — změřeno z alfa kanálu.
  // Podle toho se video posadí tak, aby Peepo stál na spodní hraně cílové zprávy.
  groundRatio: 0.955,
  groundPx: 4,        // jemné doladění pod spodní hranu zprávy
});

export const POOP_TOTAL_MS = POOP.brownAtMs + POOP.brownFlatMs + POOP.brownFadeMs;

/** Event z SSE → čistý tvar; null, když nedává smysl. */
export function normalizeReaction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const target = raw.target && typeof raw.target === 'object' ? raw.target : null;
  const messageId = String(target?.messageId ?? '').trim();
  if (!messageId) return null;
  const startedAt = Date.parse(raw.startedAt);
  return {
    id: String(raw.id ?? `${messageId}:${raw.startedAt ?? ''}`),
    kind: raw.kind === 'poop' ? 'poop' : String(raw.kind || 'poop'),
    channel: String(raw.channel ?? '').toLowerCase(),
    target: { platform: String(target.platform ?? '').toLowerCase(), messageId, username: target.username ? String(target.username) : null },
    by: raw.by && typeof raw.by === 'object' ? { platform: String(raw.by.platform ?? ''), login: String(raw.by.login ?? '') } : null,
    startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
    durationMs: Number(raw.durationMs) > 0 ? Number(raw.durationMs) : POOP.videoMs,
  };
}

/** Kolik ms od startu už uběhlo (SSE mohlo přijít se zpožděním / po reconnectu). */
export function reactionOffsetMs(ev, now = Date.now()) {
  return Math.max(0, now - ev.startedAt);
}

/** Je reakce ještě „živá" (video běží nebo dobíhá odtmívání)? Tlačítko je do té doby schované. */
export function reactionBusy(ev, now = Date.now()) {
  return !!ev && now - ev.startedAt < ev.durationMs + POOP.fadeMs;
}

/**
 * Přehrát v DOM. hostEl = obal chatu (position: relative, nescrolluje), chatEl = scrollující
 * seznam, targetEl = element cílové zprávy (nebo null → video u spodního okraje).
 * Vrací { stop, endsAt }. Volající před tím zprávu odscrolluje do záběru.
 */
export function playPoopReaction({ hostEl, chatEl, targetEl, videoUrl, offsetMs = 0, reducedMotion = false, onEnd }) {
  const doc = hostEl.ownerDocument;
  const timers = [];
  const later = (fn, ms) => { const t = setTimeout(fn, Math.max(0, ms)); timers.push(t); return t; };
  const start = Date.now() - offsetMs;

  const overlay = doc.createElement('div');
  overlay.className = 'uc-poop-overlay';
  const spot = doc.createElement('div');
  spot.className = 'uc-poop-spot';
  const video = doc.createElement('video');
  video.className = 'uc-poop-video';
  video.muted = true; video.playsInline = true; video.preload = 'auto';
  video.setAttribute('aria-hidden', 'true');
  video.src = videoUrl;
  overlay.append(spot, video);
  hostEl.appendChild(overlay);

  const layout = () => {
    const host = hostEl.getBoundingClientRect();
    const w = host.width;
    const h = w / POOP.aspect;
    let ground;   // kde má stát Peepo, v px od horního okraje hosta
    if (targetEl && targetEl.isConnected) {
      const r = targetEl.getBoundingClientRect();
      ground = r.bottom - host.top + POOP.groundPx;
      spot.style.top = `${r.top - host.top - 6}px`;
      spot.style.height = `${r.height + 12}px`;
      spot.style.display = '';
    } else {
      ground = host.height - 8;
      spot.style.display = 'none';
    }
    video.style.width = `${w}px`;
    video.style.height = `${h}px`;
    video.style.top = `${ground - h * POOP.groundRatio}px`;
  };
  layout();
  const onScroll = () => layout();
  chatEl?.addEventListener('scroll', onScroll, { passive: true });
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(layout) : null;
  ro?.observe(hostEl);

  // Zatmění + reflektor (CSS přechod přes třídu). Ne přes rAF: ve skrytém tabu
  // (OBS na pozadí, MCP okno) se rAF nespustí a overlay by zůstal průhledný.
  if (reducedMotion) overlay.classList.add('no-motion');
  later(() => overlay.classList.add('on'), 20);
  // Video z JS vytvořeného elementu se samo nenačte spolehlivě → load() (stejná past jako u announcementu).
  video.load();
  video.addEventListener('loadedmetadata', () => { try { if (offsetMs > 300) video.currentTime = offsetMs / 1000; } catch { /* ignore */ } layout(); }, { once: true });
  video.play().catch(() => {});

  // Hnědá: jméno + logo platformy jen u cílové zprávy.
  const brownOn = () => targetEl?.classList.add('uc-poop-brown');
  const brownFadeStart = () => { if (!targetEl) return; targetEl.classList.add('uc-poop-fade'); targetEl.classList.remove('uc-poop-brown'); };
  const brownEnd = () => targetEl?.classList.remove('uc-poop-fade', 'uc-poop-brown');
  const at = (ms) => start + ms - Date.now();
  if (offsetMs < POOP.brownAtMs + POOP.brownFlatMs) later(brownOn, at(POOP.brownAtMs));
  if (offsetMs < POOP.brownAtMs + POOP.brownFlatMs) later(brownFadeStart, at(POOP.brownAtMs + POOP.brownFlatMs));
  later(brownEnd, at(POOP_TOTAL_MS));

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    overlay.classList.remove('on');
    chatEl?.removeEventListener('scroll', onScroll);
    ro?.disconnect();
    later(() => { overlay.remove(); }, POOP.fadeMs + 50);
    onEnd?.();
  };
  video.addEventListener('ended', finish, { once: true });
  later(finish, at(POOP.videoMs) + 300);   // pojistka, kdyby `ended` nepřišel

  return {
    endsAt: start + POOP_TOTAL_MS,
    stop() { finished = true; for (const t of timers) clearTimeout(t); overlay.remove(); chatEl?.removeEventListener('scroll', onScroll); ro?.disconnect(); brownEnd(); },
  };
}
