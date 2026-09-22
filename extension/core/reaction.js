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
  // Kam ve videu dopadají hromádky (podíl výšky) — změřeno z alfa kanálu:
  // Peepo chodí v 95,5 %, hromádky se usazují kolem 88 %. Tenhle bod se zarovná
  // na střed prvního řádku cílové zprávy (u víceřádkové tedy na řádek se jménem),
  // takže „to" padá na zprávu a Peepo stojí kousek pod ní.
  poopRatio: 0.88,
  // Doladění podle usera (dvě kola): animace o 1,7 řádku níž, ať „to" dopadá přesně na zprávu.
  offsetLines: 1.7,
  // Když je video větší (široké okno), posune se navíc dolů o tenhle podíl přírůstku
  // výšky — jinak by kotva držela pořád stejně a animace by lezla nahoru přes chat.
  growOffsetRatio: 0.45,
  // Velikost se řídí VÝŠKOU ŘÁDKU, ne šířkou chatu: na širokém okně by se video
  // roztáhlo přes celou šířku a Peepo by byl obří vůči textu. Strop = tolik řádků
  // na výšku videa; nad ním se video vycentruje a zbytek šířky zůstane volný.
  // Strop výšky roste se šířkou chatu: úzký panel drží menší animaci (jinak by
  // zabrala půl panelu), široké okno ji má větší (pokyn usera 2026-09-23).
  minHeightLines: 5.5,
  maxHeightLines: 8,
  narrowPx: 550,      // do téhle šířky platí minHeightLines
  widePx: 850,        // od téhle šířky platí maxHeightLines
});

/** Výška řádku zprávy (px) — z cílové zprávy, jinak z chatu; fallback 21. */
export function lineHeightOf(el) {
  for (const node of [el, el?.parentElement]) {
    if (!node?.ownerDocument?.defaultView) continue;
    const cs = node.ownerDocument.defaultView.getComputedStyle(node);
    const lh = parseFloat(cs.lineHeight);
    if (Number.isFinite(lh) && lh > 0) return lh;
    const fs = parseFloat(cs.fontSize);
    if (Number.isFinite(fs) && fs > 0) return fs * 1.5;
  }
  return 21;
}

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
    // Výška podle řádku textu (strop), šířka dopočtená z poměru; na širokém chatu
    // se video vycentruje, na úzkém zabere celou šířku.
    const lineH = lineHeightOf(targetEl || chatEl);
    const wide = Math.max(0, Math.min(1, (host.width - POOP.narrowPx) / (POOP.widePx - POOP.narrowPx)));
    const maxH = lineH * (POOP.minHeightLines + (POOP.maxHeightLines - POOP.minHeightLines) * wide);
    const w = Math.min(host.width, maxH * POOP.aspect);
    const h = w / POOP.aspect;
    let landing;   // kam mají dopadat hromádky, v px od horního okraje hosta
    if (targetEl && targetEl.isConnected) {
      const r = targetEl.getBoundingClientRect();
      // Střed PRVNÍHO řádku zprávy: jméno (.un) tam je vždy; u víceřádkové zprávy
      // se tak animace drží řádku se jménem, ne spodku celého odstavce.
      const nameEl = targetEl.querySelector('.un') || targetEl.querySelector('.ts');
      const first = nameEl ? nameEl.getBoundingClientRect() : null;
      const grow = Math.max(0, h - lineH * POOP.minHeightLines) * POOP.growOffsetRatio;
      landing = (first && first.height ? first.top + first.height / 2 : r.top + Math.min(r.height, lineH) / 2) - host.top + lineH * POOP.offsetLines + grow;
      // Reflektor: měkké světlo kolem cílové zprávy (maska v CSS podle proměnných).
      spot.style.setProperty('--spot-y', `${r.top + r.height / 2 - host.top}px`);
      spot.style.setProperty('--spot-h', `${Math.max(r.height + 26, 54)}px`);
      spot.style.display = '';
    } else {
      // Cílová zpráva není v DOM (odscrollovaná pryč z paměti): video u spodního
      // okraje, ale scéna se zatmí taky — reflektor jen míří na spodek chatu.
      landing = host.height - h * (1 - POOP.poopRatio) - 8;
      spot.style.setProperty('--spot-y', `${Math.max(0, host.height - lineH * 2)}px`);
      spot.style.setProperty('--spot-h', `${Math.max(lineH * 2, 54)}px`);
      spot.style.display = '';
    }
    video.style.width = `${w}px`;
    video.style.height = `${h}px`;
    video.style.left = `${Math.max(0, (host.width - w) / 2)}px`;
    video.style.top = `${landing - h * POOP.poopRatio}px`;
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
