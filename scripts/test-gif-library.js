// Testy čistých částí GIF knihovny (extension/core/gif-library.js, gif.js FIFO texty + zámek, gif-links.js náš odkaz,
// ChatStore pořadí schváleného GIFu). DOM (štítky, karta, záložka GIFy) kryje scripts/e2e-gif.mjs.
// Spuštění: node scripts/test-gif-library.js
Promise.all([
  import('../extension/core/gif-library.js'),
  import('../extension/core/gif.js'),
  import('../extension/core/gif-links.js'),
  import('../extension/core/chat-store.js'),
]).then(async ([L, g, links, cs]) => {
  let fails = 0;
  const check = (n, ok, detail = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || !detail ? '' : ` — ${detail}`)); if (!ok) fails++; };
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const ID = 'ab'.repeat(16);
  const OUR = `https://api.jouki.cz/media/gif/${ID}`;

  // --- náš odkaz z knihovny (rozhodnutí 1) ---
  check('classifyGifUrl: náš odkaz = mode own + mediaId', eq(links.classifyGifUrl(OUR), { url: OUR, mode: 'own', mediaId: ID }));
  check('classifyGifUrl: náš odkaz bez schématu, s ?t= (token se zahodí)', links.classifyGifUrl(`api.jouki.cz/media/gif/${ID}?t=x`)?.url === OUR);
  check('classifyGifUrl: cizí host / krátké id ne', links.classifyGifUrl(`https://evil.cz/media/gif/${ID}`) === null && links.classifyGifUrl('https://api.jouki.cz/media/gif/abc') === null);
  check('gifCandidate / hasGifLink: náš odkaz ve zprávě', links.gifCandidate(`hele ${OUR}`)?.mediaId === ID && links.hasGifLink(`${OUR} ⠀`));
  check('classifyGifUrl: vlastní seznam hostů', links.classifyGifUrl(`https://localhost/media/gif/${ID}`, ['localhost'])?.mode === 'own');
  check('classifyGifUrl: ostatní beze změny (Tenor stránka)', links.classifyGifUrl('https://tenor.com/view/cat-gif-1')?.mode === 'page');

  // --- množná čísla, texty ---
  check('gifCountText: 1 GIF / 2 GIFy / 4 GIFy / 5 GIFů / 0 GIFů', ['1 GIF', '2 GIFy', '4 GIFy', '5 GIFů', '0 GIFů'].join('|') === [1, 2, 4, 5, 0].map(g.gifCountText).join('|'));
  check('gifWaitingText: „+N čeká“', g.gifWaitingText(1) === '+1 čeká' && g.gifWaitingText(7) === '+7 čeká');
  check('gifAlreadyDecidedText: kdo rozhodl', g.gifAlreadyDecidedText('approved', 'twitch:modik') === 'Už rozhodl modik (Twitch)');
  check('gifAlreadyDecidedText: knihovna / propadlo / neznámý', g.gifAlreadyDecidedText('approved', 'library') === 'Už schváleno z knihovny'
    && g.gifAlreadyDecidedText('expired', null) === 'Propadlo — nikdo nerozhodl včas' && g.gifAlreadyDecidedText('rejected', null) === 'Už rozhodl jiný mod');
  check('gifPrevRejectedText: kdy + kým', /^Dříve zamítnuto \d+\. \d+\. \d+:\d\d · modik \(Twitch\)$/.test(g.gifPrevRejectedText({ at: Date.UTC(2026, 8, 25, 12, 5), by: 'twitch:modik' })), g.gifPrevRejectedText({ at: Date.UTC(2026, 8, 25, 12, 5), by: 'twitch:modik' }));
  check('gifPrevRejectedText: bez údajů', g.gifPrevRejectedText({ at: null, by: null }) === 'Dříve zamítnuto' && g.gifPrevRejectedText(null) === '');
  check('gifMediaIdOf', g.gifMediaIdOf(OUR) === ID && g.gifMediaIdOf(`${OUR}?t=1`) === ID && g.gifMediaIdOf('https://x.cz/a.gif') === null);
  check('normalizeGifPending: previouslyRejected', eq(g.normalizeGifPending({ requestId: 1, channel: 'rob', media: { url: OUR, kind: 'gif' }, expiresAt: 9, previouslyRejected: { at: 5, by: 'twitch:m' } }).previouslyRejected, { at: 5, by: 'twitch:m' })
    && g.normalizeGifPending({ requestId: 1, channel: 'rob', media: { url: OUR, kind: 'gif' }, expiresAt: 9 }).previouslyRejected === null);

  // --- zámek karty (falešné hodiny) ---
  let t = 1000;
  const lock = new g.GifCardLock(() => t);
  check('GifCardLock: bez zámku', !lock.locked());
  lock.lock(g.GIF_LOCK_OTHER_MS);
  t += 999; check('GifCardLock: 1 s po aktualizaci jiného moda — v 999 ms zamčeno', lock.locked() && lock.remaining() === 1);
  t += 1; check('GifCardLock: po 1000 ms odemčeno', !lock.locked());
  lock.lock(g.GIF_LOCK_OWN_MS); t += 299; const own1 = lock.locked(); t += 1;
  check('GifCardLock: po vlastním kliku 0,3 s', own1 && !lock.locked() && g.GIF_LOCK_OWN_MS === 300 && g.GIF_LOCK_OTHER_MS === 1000);
  lock.lock(1000); t += 100; lock.lock(300);
  check('GifCardLock: kratší zámek běžící nezkrátí', lock.remaining() === 900);

  // --- procenta průběhu ---
  check('formatGifPct', L.formatGifPct(42.9) === '42 %' && L.formatGifPct(-3) === '0 %' && L.formatGifPct(100) === '100 %');
  check('gifProgressPct: fáze ze serveru', L.gifProgressPct({ phase: 'download', pct: 30 }, 0) === 30 && L.gifProgressPct({ phase: 'verify', pct: 95 }, 0) === 95);
  const un = { phase: 'unlock', pct: 50, estimateMs: 10_000, elapsedMs: 0, at: 0 };
  check('gifProgressPct: unlock lineárně 50 → 95', L.gifProgressPct(un, 0) === 50 && L.gifProgressPct(un, 5_000) === 72.5 && L.gifProgressPct(un, 10_000) === 95);
  check('gifProgressPct: unlock déle než odhad → zasekne se na 95', L.gifProgressPct(un, 60_000) === 95);
  check('gifProgressPct: unlock s elapsedMs od serveru', L.gifProgressPct({ ...un, elapsedMs: 5_000 }, 0) === 72.5);
  check('gifProgressPct: unlock bez odhadu = 50', L.gifProgressPct({ phase: 'unlock', pct: 50, estimateMs: null, at: 0 }, 9_000) === 50);
  check('gifProgressPct: nikdy zpět (floor)', L.gifProgressPct({ phase: 'verify', pct: 95 }, 0, 97) === 95 && L.gifProgressPct({ phase: 'download', pct: 20 }, 0, 40) === 40);
  check('gifProgressPct: done = 100', L.gifProgressPct({ phase: 'done', pct: 100 }, 0, 50) === 100);
  check('normalizeGifProgress: requestKey + chybná data', L.normalizeGifProgress({ requestKey: 'twitch:abc', channel: 'Rob', platform: 'twitch', messageId: 'abc', phase: 'download', pct: 130 })?.pct === 100
    && L.normalizeGifProgress({ phase: 'nesmysl', requestKey: 'twitch:a' }) === null && L.normalizeGifProgress({ phase: 'detect' }) === null);
  check('gifOutcomeState', eq(['pending', 'approved', 'rejected', 'not_allowed', 'failed', 'denied', 'cancelled'].map(L.gifOutcomeState), ['pending', 'approved', 'rejected', 'not_allowed', 'none', 'none', 'none']));

  // --- GifOutbox (odesílatel) ---
  let now = 10_000;
  const changes = [], notices = [];
  let domIds = new Set();
  const intervals = [];
  const box = new L.GifOutbox({ channel: () => 'robdiesalot', now: () => now, onChange: (k) => changes.push(...k), onNotice: (kind) => notices.push(kind), hasMessage: (p, id) => domIds.has(`${p}:${id}`), setInterval: (fn) => { intervals.push(fn); return intervals.length; }, clearInterval: () => {} });
  const P = (phase, pct, extra = {}) => ({ requestKey: 'twitch:m1', channel: 'robdiesalot', platform: 'twitch', messageId: 'm1', phase, pct, ...extra });
  domIds.add('twitch:m1');
  box.onProgress(P('detect', 0));
  check('Outbox: detect → kolečko 0 %', eq(box.view('twitch', 'm1'), { kind: 'progress', pct: 0, text: '0 %' }));
  box.onProgress(P('download', 30));
  check('Outbox: download 30 %', box.view('twitch', 'm1').text === '30 %' && changes.includes('twitch:m1'));
  box.onProgress(P('unlock', 50, { estimateMs: 4_000, elapsedMs: 0 }));
  now += 2_000;
  check('Outbox: unlock animuje (2 s z 4 s → 72 %)', box.view('twitch', 'm1').text === '72 %', JSON.stringify(box.view('twitch', 'm1')));
  check('Outbox: unlock spustí překreslování', intervals.length === 1);
  now += 10_000;
  check('Outbox: unlock déle → 95 %', box.view('twitch', 'm1').text === '95 %');
  box.onProgress(P('verify', 95));
  box.onProgress(P('done', 100, { outcome: 'pending' }));
  check('Outbox: done pending → „Schvalování moderátorem“', eq(box.view('twitch', 'm1'), { kind: 'pending', text: 'Schvalování moderátorem', warn: false }));
  box.onOwnPending({ requestId: 12, channel: 'robdiesalot', platform: 'twitch', messageId: 'm1', login: 'ja', media: { url: OUR, kind: 'gif' }, expiresAt: now + 300_000, own: true, previouslyRejected: { at: 5 } });
  check('Outbox: vlastní gif-pending s previouslyRejected → ⚠', box.view('twitch', 'm1').warn === true);
  box.onProgress(P('download', 60));
  check('Outbox: pozdní průběh po čekání štítek nevrátí', box.view('twitch', 'm1').kind === 'pending');
  box.onDecided({ requestId: 12, channel: 'robdiesalot', approved: false, status: 'rejected', by: 'twitch:modik', own: true });
  check('Outbox: zamítnuto → červený „Zamítnuto moderátorem“', eq(box.view('twitch', 'm1'), { kind: 'rejected', text: 'Zamítnuto moderátorem', warn: false }));
  // vypršelo
  box.onOwnPending({ requestId: 13, channel: 'robdiesalot', platform: 'twitch', messageId: 'm2', login: 'ja', media: { url: OUR, kind: 'gif' }, expiresAt: now + 1, own: true });
  box.onDecided({ requestId: 13, channel: 'robdiesalot', approved: false, status: 'expired', by: null, own: true });
  check('Outbox: vypršelo → „Vypršelo“', box.view('twitch', 'm2')?.text === 'Vypršelo');
  // jiný kanál
  check('Outbox: gif-progress z jiného kanálu ignorováno', box.onProgress({ ...P('detect', 0), requestKey: 'twitch:x9', channel: 'jiny' }) === null && !box.has('twitch', 'x9'));
  // schváleno (mod auto / po schválení)
  box.onProgress({ ...P('done', 100, { outcome: 'approved' }), requestKey: 'twitch:m3', messageId: 'm3' });
  check('Outbox: done approved → štítek pryč (kind approved)', box.view('twitch', 'm3')?.kind === 'approved');
  box.onProgress({ ...P('done', 100, { outcome: 'failed' }), requestKey: 'twitch:m4', messageId: 'm4' });
  check('Outbox: failed → běžná zpráva (null)', box.view('twitch', 'm4') === null);
  // gif-notice
  box.onNotice({ requestKey: 'twitch:m5', channel: 'robdiesalot', platform: 'twitch', messageId: 'm5', kind: 'approved_only' });
  check('Outbox: gif-notice approved_only → hláška + štítek', notices.includes('approved_only') && box.view('twitch', 'm5')?.text === 'Nové GIFy teď nejdou');
  box.onNotice({ requestKey: 'twitch:m6', channel: 'robdiesalot', platform: 'twitch', messageId: 'm6', kind: 'auto_rejected', reason: 'repeat' });
  check('Outbox: gif-notice auto_rejected → „Zamítnuto moderátorem“', box.view('twitch', 'm6')?.text === 'Zamítnuto moderátorem');
  check('GIF_APPROVED_ONLY_TEXT', L.GIF_APPROVED_ONLY_TEXT === 'Nové GIFy teď nejdou, vyber z GIFů v panelu');
  // optimistická zpráva: kolečko hned, spárování přes alias
  box.noteOptimistic('sent-1', 'twitch', { show: true });
  check('Outbox: optimistická → kolečko 0 % hned', box.view('twitch', 'sent-1')?.kind === 'progress');
  box.alias('sent-1', 'twitch', 'real1');
  check('Outbox: alias → stejný stav pod optId i skutečným id', box.view('twitch', 'sent-1')?.kind === 'progress' && box.view('twitch', 'real1')?.kind === 'progress' && eq(box.idsFor('twitch:real1'), ['real1', 'sent-1']));
  box.onProgress({ ...P('download', 40), requestKey: 'twitch:real1', messageId: 'real1' });
  check('Outbox: průběh pod skutečným id → vidí i optimistická', box.view('twitch', 'sent-1')?.text === '40 %');
  // průběh dřív než echo: spárovat s poslední optimistickou GIF zprávou
  box.noteOptimistic('sent-2', 'twitch', { show: false });
  box.onProgress({ ...P('detect', 0), requestKey: 'twitch:real2', messageId: 'real2' });
  check('Outbox: průběh bez zprávy v DOM → spárován s optimistickou', box.keyOf('twitch', 'sent-2') === 'twitch:real2' && box.view('twitch', 'sent-2')?.kind === 'progress');
  domIds.add('twitch:real3');
  box.noteOptimistic('sent-3', 'kick', { show: false });
  box.onProgress({ ...P('detect', 0), requestKey: 'twitch:real3', messageId: 'real3' });
  check('Outbox: jiná platforma / zpráva v DOM → nepáruje', box.keyOf('kick', 'sent-3') === 'kick:sent-3');
  // tichá optimistická zmizí
  box.noteOptimistic('sent-4', 'youtube', { show: true });
  now += L.GIF_OPTIMISTIC_SILENT_MS + 1;
  check('Outbox: optimistická bez odezvy serveru → po 15 s pryč', box.view('youtube', 'sent-4') === null);
  box.drop('twitch', 'sent-1');
  check('Outbox: drop → bez štítku', box.view('twitch', 'sent-1') === null);
  // gif-message s gifOrigin
  box.onOwnPending({ requestId: 20, channel: 'robdiesalot', platform: 'twitch', messageId: 'm7', login: 'ja', media: { url: OUR, kind: 'gif' }, expiresAt: now + 100, own: true });
  box.onGifMessage({ id: 'gif-20', gifOrigin: 'twitch:m7' });
  check('Outbox: gif-message (gifOrigin) → schváleno', box.view('twitch', 'm7')?.kind === 'approved');
  box.clear();
  check('Outbox: clear', box.size === 0 && box.view('twitch', 'm1') === null);

  // unlock bez done → strop 60 s: „Vypršelo“ a konec překreslování
  {
    let n2 = 0; const ticks = []; let cleared = 0; const ch2 = [];
    const b2 = new L.GifOutbox({ channel: () => 'robdiesalot', now: () => n2, onChange: (k) => ch2.push(...k), setInterval: (fn) => { ticks.push(fn); return ticks.length; }, clearInterval: () => { cleared++; } });
    b2.onProgress({ requestKey: 'twitch:u1', channel: 'robdiesalot', platform: 'twitch', messageId: 'u1', phase: 'unlock', pct: 50, estimateMs: 5000, elapsedMs: 0 });
    n2 = 30_000; ticks[0]();
    const mid = b2.view('twitch', 'u1');
    n2 = 60_001; ticks[0]();
    const end = b2.view('twitch', 'u1');
    n2 = 61_000; ticks[0]();
    check('Outbox: unlock bez done → po 60 s „Vypršelo“ a interval se zastaví', mid?.text === '95 %' && end?.kind === 'expired' && end.text === 'Vypršelo' && cleared >= 1, JSON.stringify({ mid, end, cleared }));
    b2.onProgress({ requestKey: 'twitch:u1', channel: 'robdiesalot', platform: 'twitch', messageId: 'u1', phase: 'done', pct: 100, outcome: 'pending' });
    check('Outbox: pozdní done po stropu stav opraví', b2.view('twitch', 'u1')?.kind === 'pending');
  }


  // --- závěrečná review I1: štítek řídí stav zprávy, echo schovaného GIFu bez textu se páruje přes id ---
  {
    let n3 = 0; const ch3 = [];
    const b3 = new L.GifOutbox({ channel: () => 'robdiesalot', now: () => n3, onChange: (k) => ch3.push(...k), setInterval: () => 1, clearInterval: () => {} });
    b3.noteOptimistic('sent-9', 'youtube', { show: true });
    b3.alias('sent-9', 'youtube', 'LCC.abc');
    check('I1 governs: optimistická GIF zpráva se štítkem → host ji po 20 s neoznačí jako neodeslanou', b3.governs('youtube', 'sent-9') === true);
    check('I1 optIdFor: skutečné id → optimistická zpráva', b3.optIdFor('youtube', 'LCC.abc') === 'sent-9' && b3.optIdFor('youtube', 'jine') === null);
    n3 = L.GIF_OPTIMISTIC_SILENT_MS + 1;
    check('I1 governs: optimistická bez odezvy serveru (15 s) → už ne (YouTube odkaz zahodil → neodesláno)', b3.governs('youtube', 'sent-9') === false);
    b3.onProgress({ requestKey: 'youtube:LCC.abc', channel: 'robdiesalot', platform: 'youtube', messageId: 'LCC.abc', phase: 'done', pct: 100, outcome: 'pending' });
    check('I1 governs: server se ozval (čeká na moda) → zase řídí štítek', b3.governs('youtube', 'sent-9') === true && b3.view('youtube', 'sent-9')?.kind === 'pending');
    b3.onDecided({ requestId: 1, channel: 'robdiesalot', status: 'rejected' });
    check('I1 governs: failed → běžná zpráva, neřídí', (() => { b3.onProgress({ requestKey: 'youtube:LCC.x', channel: 'robdiesalot', platform: 'youtube', messageId: 'LCC.x', phase: 'done', pct: 100, outcome: 'failed' }); return b3.governs('youtube', 'LCC.x') === false; })());
  }
  const echo = { platform: 'youtube', id: 'LCC.abc', username: 'Ja', userId: 'UC1', message: '', timestamp: 5, historical: false, deleted: true, deletedReason: 'gif_request', ytRuns: [], color: null };
  const patch = L.gifEchoPatch(echo);
  check('I1 gifEchoPatch: echo bez obsahu → jen id, čas, smazání (text optimistické zůstane)', !('message' in patch) && !('ytRuns' in patch) && !('color' in patch) && patch.id === 'LCC.abc' && patch.deleted === true && patch.deletedReason === 'gif_request' && patch.timestamp === 5, JSON.stringify(patch));
  const full = { ...echo, deleted: false, message: 'hele https://tenor.com/x ⠀' };
  check('I1 gifEchoPatch: echo s textem beze změny', L.gifEchoPatch(full) === full && L.gifEchoPatch({ ...echo, message: '⠀ ' }).message === undefined);

  // --- závěrečná review I3: /gif/held → štítek, strop průběhu i čekání, resync po znovupřipojení ---
  check('I3 gifHeldOwnState: status má přednost', eq(['approved', 'deleted', 'rejected', 'expired', 'pending'].map((status) => L.gifHeldOwnState({ state: 'held', status })), ['approved', 'approved', 'rejected', 'expired', 'pending']));
  check('I3 gifHeldOwnState: starší odpověď bez status', eq([{ state: 'replaced' }, { state: 'deleted', reason: 'gif_rejected' }, { state: 'deleted', reason: 'mod' }, { state: 'visible' }, { state: 'held' }, { state: 'unknown' }].map(L.gifHeldOwnState), ['approved', 'rejected', 'none', 'none', 'progress', 'expired']));
  {
    let n4 = 0; const ticks = []; const asked = []; const ch4 = [];
    let answer = (ids) => ids.map((k) => ({ platform: k.split(':')[0], messageId: k.slice(k.indexOf(':') + 1), state: 'held' }));
    const api = async (path) => { const u = new URL(`https://x${path}`); const ids = u.searchParams.get('ids').split(','); asked.push({ ch: u.searchParams.get('channel'), ids }); return { ok: true, messages: answer(ids) }; };
    const b4 = new L.GifOutbox({ channel: () => 'RobDiesALot', now: () => n4, api, onChange: (k) => ch4.push(...k), setInterval: (fn) => { ticks.push(fn); return ticks.length; }, clearInterval: () => {} });
    const tick = async () => { ticks.at(-1)?.(); await new Promise((r) => setTimeout(r, 0)); };
    // Průběh: ztracené done → po 60 s bez události dotaz; server „převádí“ → čeká dál, znovu za 30 s.
    b4.onProgress({ requestKey: 'twitch:p1', channel: 'robdiesalot', platform: 'twitch', messageId: 'p1', phase: 'download', pct: 30 });
    n4 = 59_000; await tick();
    check('I3 průběh bez události < 60 s → bez dotazu', asked.length === 0 && b4.view('twitch', 'p1')?.text === '30 %');
    n4 = 60_001; await tick();
    check('I3 průběh bez události 60 s → GET /gif/held (kanál malými, skutečné id)', asked.length === 1 && asked[0].ch === 'robdiesalot' && eq(asked[0].ids, ['twitch:p1']), JSON.stringify(asked));
    check('I3 … server „převádí“ (held bez status) → dál kolečko', b4.view('twitch', 'p1')?.kind === 'progress');
    answer = (ids) => ids.map((k) => ({ platform: 'twitch', messageId: k.split(':')[1], state: 'deleted', reason: 'gif_rejected', status: 'rejected' }));
    n4 = 60_001 + 29_000; await tick();
    check('I3 … další dotaz až za 30 s', asked.length === 1);
    n4 = 60_001 + 30_001; await tick();
    check('I3 … výsledek rejected → „Zamítnuto moderátorem“', asked.length === 2 && b4.view('twitch', 'p1')?.kind === 'rejected' && ch4.includes('twitch:p1'));
    // Čekání na moda: ztracené gif-decided → po expiresAt + 15 s dotaz → approved/replaced → štítek pryč.
    answer = (ids) => ids.map((k) => ({ platform: 'twitch', messageId: k.split(':')[1], state: 'replaced', status: 'approved' }));
    b4.onOwnPending({ requestId: 50, channel: 'robdiesalot', platform: 'twitch', messageId: 'p2', login: 'ja', media: { url: OUR, kind: 'gif' }, expiresAt: n4 + 300_000, own: true });
    const exp = n4 + 300_000;
    n4 = exp + L.GIF_PENDING_GRACE_MS - 1; await tick();
    check('I3 čekání: před expiresAt + rezerva bez dotazu', asked.length === 2 && b4.view('twitch', 'p2')?.kind === 'pending');
    n4 = exp + L.GIF_PENDING_GRACE_MS + 1; await tick();
    check('I3 čekání: po expiresAt + rezerva dotaz → schváleno → štítek pryč (approved)', asked.length === 3 && eq(asked[2].ids, ['twitch:p2']) && b4.view('twitch', 'p2')?.kind === 'approved');
    // Bez expiresAt (ztracený gif-pending): výchozí 300 s od „done pending“.
    answer = (ids) => ids.map((k) => ({ platform: 'twitch', messageId: k.split(':')[1], state: 'deleted', reason: 'gif_rejected', status: 'expired' }));
    const t0 = n4;
    b4.onProgress({ requestKey: 'twitch:p3', channel: 'robdiesalot', platform: 'twitch', messageId: 'p3', phase: 'done', pct: 100, outcome: 'pending' });
    n4 = t0 + L.GIF_PENDING_DEFAULT_TTL_MS + L.GIF_PENDING_GRACE_MS + 1; await tick();
    check('I3 čekání bez expiresAt → po výchozí době dotaz → „Vypršelo“', b4.view('twitch', 'p3')?.text === 'Vypršelo' && asked.at(-1).ids.includes('twitch:p3'));
    // Server pořád „čeká“ → nejvýš GIF_OWN_MAX_CHECKS dotazů, pak „Vypršelo“.
    answer = (ids) => ids.map((k) => ({ platform: 'twitch', messageId: k.split(':')[1], state: 'held', status: 'pending' }));
    b4.onOwnPending({ requestId: 51, channel: 'robdiesalot', platform: 'twitch', messageId: 'p4', login: 'ja', media: { url: OUR, kind: 'gif' }, expiresAt: n4, own: true });
    const before = asked.length;
    for (let i = 0; i < L.GIF_OWN_MAX_CHECKS + 2; i++) { n4 += L.GIF_PENDING_GRACE_MS + L.GIF_HELD_RECHECK_MS + 1; await tick(); }
    check('I3 server pořád „čeká“ → po GIF_OWN_MAX_CHECKS dotazech „Vypršelo“', b4.view('twitch', 'p4')?.kind === 'expired' && asked.length - before === L.GIF_OWN_MAX_CHECKS, `${asked.length - before}`);
    // Resync po znovupřipojení: hned dotaz na rozpracované / čekající (ne na hotové, ne na optimistické bez id).
    answer = (ids) => ids.map((k) => ({ platform: 'twitch', messageId: k.split(':')[1], state: 'deleted', reason: 'gif_rejected', status: 'rejected' }));
    b4.onOwnPending({ requestId: 52, channel: 'robdiesalot', platform: 'twitch', messageId: 'p5', login: 'ja', media: { url: OUR, kind: 'gif' }, expiresAt: n4 + 300_000, own: true });
    b4.noteOptimistic('sent-77', 'twitch', { show: true });
    const nRes = b4.resync();
    await new Promise((r) => setTimeout(r, 0));
    check('I3 resync po znovupřipojení → dotaz jen na čekající se skutečným id, výsledek do štítku', nRes === 1 && eq(asked.at(-1).ids, ['twitch:p5']) && b4.view('twitch', 'p5')?.kind === 'rejected', JSON.stringify(asked.at(-1)));
    // Resync: chyba dotazu štítek nemění.
    const b5 = new L.GifOutbox({ channel: () => 'robdiesalot', now: () => 0, api: async () => { throw { error: 'offline' }; }, setInterval: () => 1, clearInterval: () => {} });
    b5.onOwnPending({ requestId: 53, channel: 'robdiesalot', platform: 'twitch', messageId: 'p6', login: 'ja', media: { url: OUR, kind: 'gif' }, expiresAt: 999_999, own: true });
    b5.resync();
    await new Promise((r) => setTimeout(r, 0));
    check('I3 resync: chyba dotazu → štítek beze změny (čeká dál)', b5.view('twitch', 'p6')?.kind === 'pending');
    // Mezitím rozhodnuto událostí → odpověď dotazu štítek nepřepíše.
    let release;
    const b6 = new L.GifOutbox({ channel: () => 'robdiesalot', now: () => 0, api: () => new Promise((r) => { release = r; }), setInterval: () => 1, clearInterval: () => {} });
    b6.onOwnPending({ requestId: 54, channel: 'robdiesalot', platform: 'twitch', messageId: 'p7', login: 'ja', media: { url: OUR, kind: 'gif' }, expiresAt: 999_999, own: true });
    b6.resync();
    b6.onDecided({ requestId: 54, channel: 'robdiesalot', status: 'rejected' });
    release({ ok: true, messages: [{ platform: 'twitch', messageId: 'p7', state: 'held', status: 'pending' }] });
    await new Promise((r) => setTimeout(r, 0));
    check('I3 odpověď po gif-decided štítek nepřepíše', b6.view('twitch', 'p7')?.kind === 'rejected');
  }

  // --- závěrečná review I2: médium se nenačetlo → „GIF odebrán“ bez odkazu ---
  check('I2 GIF_REMOVED_TEXT', g.GIF_REMOVED_TEXT === 'GIF odebrán');

  // --- stav odměny (indikátor + hlavička) ---
  const RV = L.gifRewardView;
  check('gifRewardView: nepřihlášený', RV(null, 0, { loggedIn: false }).mode === 'login' && !RV(null, 0, { loggedIn: false }).canSend);
  check('gifRewardView: neznámý stav', RV(null, 0).mode === 'unknown');
  check('gifRewardView: mod smí vždy', RV({ allowed: true, mod: true }, 0).canSend && RV({ allowed: true, mod: true }, 0).mode === 'mod');
  const locked = RV({ allowed: false, mod: false, until: null }, 0);
  check('gifRewardView: bez odměny zamčeno + hláška', locked.mode === 'locked' && !locked.canSend && /není aktivní/.test(locked.text));
  const act = RV({ allowed: true, mod: false, until: null, rewardUntil: 250_000, rewardTotalMs: 1_000_000 }, 0);
  check('gifRewardView: aktivní s koncem odměny → pásek 25 % + odpočet', act.mode === 'active' && act.progress === 0.25 && act.text === 'Odměna ještě 4:10', JSON.stringify(act));
  check('gifRewardView: bez konce odměny → bez pásku', RV({ allowed: true, until: null }, 0).progress === null && RV({ allowed: true, until: null }, 0).canSend);
  const cdv = RV({ allowed: true, until: 42_000 }, 0);
  check('gifRewardView: cooldown → nelze poslat, „Další GIF můžeš poslat za 42 s“', cdv.mode === 'cooldown' && !cdv.canSend && cdv.text === 'Další GIF můžeš poslat za 42 s', cdv.text);
  check('gifRewardView: odměna vypršela → zamčeno', RV({ allowed: true, rewardUntil: 5 }, 10).mode === 'locked');
  check('gifRewardView: režim approved', RV({ allowed: true, mode: 'approved' }, 0).approvedOnly === true);

  // --- data knihovny ---
  const li = L.normalizeLibraryItem({ mediaId: ID, url: OUR, kind: 'mp4', width: 480, height: 270, tags: ['cat', 'dance'], useCount: 3, lastUsedAt: 7 });
  check('normalizeLibraryItem', li?.kind === 'mp4' && eq(li.tags, ['cat', 'dance']) && li.useCount === 3 && li.url === OUR);
  check('normalizeLibraryItem: cizí URL / špatné id → null', L.normalizeLibraryItem({ mediaId: ID, url: 'https://evil.cz/x.gif' }) === null && L.normalizeLibraryItem({ mediaId: 'x', url: OUR }) === null);
  const rj = L.normalizeRejectedItem({ mediaId: ID, url: OUR, kind: 'gif', rejectedAt: 1, rejectedBy: 'twitch:modik', vault: false, deleteAt: 3 * 86_400_000 });
  check('normalizeRejectedItem', rj?.rejectedBy === 'twitch:modik' && rj.vault === false && rj.deleteAt === 3 * 86_400_000);
  check('rejectedMetaText: 1 den / 3 dny / 5 dní / dnes / vault', L.rejectedMetaText({ rejectedBy: 'twitch:m', deleteAt: 86_400_000 }, 0) === 'Zamítl m (Twitch) · smaže se za 1 den'
    && L.rejectedMetaText({ rejectedBy: 'twitch:m', deleteAt: 3 * 86_400_000 }, 0).endsWith('za 3 dny')
    && L.rejectedMetaText({ rejectedBy: null, deleteAt: 5 * 86_400_000 }, 0) === 'Zamítnuto · smaže se za 5 dní'
    && L.rejectedMetaText({ deleteAt: 10 }, 20).endsWith('smaže se dnes')
    && L.rejectedMetaText({ rejectedBy: 'zidolista:1', vault: true }, 0) === 'Zamítl Židolišta · Vault — nesmaže se');
  const dup = L.normalizeDuplicate({ id: 4, score: 0.8, first: { mediaId: ID, url: OUR, kind: 'gif', status: 'approved', useCount: 2 }, second: { mediaId: 'cd'.repeat(16), url: `https://api.jouki.cz/media/gif/${'cd'.repeat(16)}`, kind: 'gif', status: 'rejected' } });
  check('normalizeDuplicate', dup?.id === '4' && dup.first.status === 'approved' && dup.second.status === 'rejected' && dup.score === 0.8);
  check('normalizeDuplicate: chybné médium → null', L.normalizeDuplicate({ id: 1, first: { mediaId: ID, url: OUR }, second: null }) === null);
  check('gifLibraryErrorText', L.gifLibraryErrorText({ error: 'already_decided' }) === 'O návrhu už rozhodl jiný mod.' && L.gifLibraryErrorText({ status: 401 }) === 'Přihlášení vypršelo, přihlas se znovu.');

  // --- token pro zamítnutá média (nikdy v logu) ---
  const logs = [];
  let issued = 0, stored = null;
  const SECRET = 'tajny-token-xyz';
  let tnow = 0;
  const tok = new L.GifAccessToken({
    api: async (path, o) => { if (path === '/moderation/gif/access-token' && o.method === 'POST') { issued++; return { ok: true, token: `${SECRET}${issued}` }; } throw { error: 'x' }; },
    channel: () => 'robdiesalot',
    store: { load: async () => stored, save: async (v) => { stored = v; }, clear: async () => { stored = null; } },
    log: (tag, t) => logs.push(`${tag} ${t}`),
    now: () => tnow,
  });
  const t1 = await tok.get();
  const t1b = await tok.get();
  check('GifAccessToken: vydá jednou, pak z paměti, uloží do session', t1 === `${SECRET}1` && t1b === t1 && issued === 1 && stored === t1);
  tnow = 5_000;
  const [t3, t3b] = await Promise.all([tok.refresh(), tok.refresh()]);
  check('GifAccessToken: obnova po chybě média → nový token (souběžné obnovy = jedno vydání)', t3 === `${SECRET}2` && t3b === t3 && issued === 2 && stored === t3);
  const tokFail = new L.GifAccessToken({ api: async () => { throw { error: 'not_mod', status: 403 }; }, log: (tag, t) => logs.push(`${tag} ${t}`) });
  check('GifAccessToken: 403 (už nejsem mod) → null', await tokFail.get() === null);
  const tok2 = new L.GifAccessToken({ api: async () => { issued++; return { ok: true, token: 'nový' }; }, store: { load: async () => 'uložený', save: async () => {}, clear: async () => {} } });
  check('GifAccessToken: nejdřív session úložiště', await tok2.get() === 'uložený');
  check('GifAccessToken: hodnota tokenu nikdy v logu', logs.length > 0 && !logs.some((l) => l.includes(SECRET)), logs.join(' | '));

  // --- pořadí schváleného GIFu v ChatStore (rozhodnutí 5): čas schválení = na konec, gifOrigin nic nemění ---
  const store = new cs.ChatStore();
  store.add({ platform: 'twitch', id: 'orig', timestamp: 1000, message: 'hele https://tenor.com/view/x-1' });
  store.add({ platform: 'twitch', id: 'a', timestamp: 2000, message: 'a' });
  store.add({ platform: 'twitch', id: 'b', timestamp: 3000, message: 'b' });
  store.add({ platform: 'twitch', id: 'gif-1', timestamp: 4000, message: '', gif: { url: OUR }, gifOrigin: 'twitch:orig' });
  check('ChatStore: GIF s časem schválení je poslední (ne u původní zprávy)', eq(store.slice().map((m) => m.id), ['orig', 'a', 'b', 'gif-1']), JSON.stringify(store.slice().map((m) => m.id)));
  check('ChatStore: stejné gif-<id> podruhé = dup', store.add({ platform: 'twitch', id: 'gif-1', timestamp: 4000 }) === 'dup');

  console.log(fails ? `\n${fails} FAIL` : '\nvše PASS');
  process.exit(fails ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
