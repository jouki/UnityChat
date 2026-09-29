// Testy čistých částí GIF knihovny (extension/core/gif-library.js, gif.js FIFO texty + zámek, gif-links.js náš odkaz,
// ChatStore pořadí schváleného GIFu). DOM (štítky, karta, záložka GIFy) kryje scripts/e2e-gif.mjs.
// Spuštění: node scripts/test-gif-library.js
Promise.all([
  import('../extension/core/gif-library.js'),
  import('../extension/core/gif.js'),
  import('../extension/core/gif-links.js'),
  import('../extension/core/chat-store.js'),
  import('../extension/core/gif-host.js'),
  import('../extension/core/gif-client-fetch.js'),
]).then(async ([L, g, links, cs, H, CF]) => {
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
  check('classifyGifUrl: Imgur <slug>-<ID> (galerie i album, fragment se ignoruje; 2026-09-28)', links.classifyGifUrl('https://imgur.com/gallery/hold-breath-jVjKCJJ#/t/joke')?.mode === 'page' && links.classifyGifUrl('https://imgur.com/a/nazev-alba-8as1KiG')?.mode === 'page' && links.classifyGifUrl('https://imgur.com/a/8as1KiG')?.mode === 'page' && links.classifyGifUrl('https://imgur.com/gallery/') === null);

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
  check('Outbox: gif-notice approved_only → hláška + štítek', notices.includes('approved_only') && box.view('twitch', 'm5')?.text === 'Nové GIFy teď nejsou povolené');
  box.onNotice({ requestKey: 'twitch:m6', channel: 'robdiesalot', platform: 'twitch', messageId: 'm6', kind: 'auto_rejected', reason: 'repeat' });
  check('Outbox: gif-notice auto_rejected → „Zamítnuto moderátorem“', box.view('twitch', 'm6')?.text === 'Zamítnuto moderátorem');
  check('GIF_APPROVED_ONLY_TEXT', L.GIF_APPROVED_ONLY_TEXT === 'Nové GIFy teď nejsou povolené, vyber z GIFů v panelu.');
  check('GIF_NOT_ALLOWED_REASON (gif.js, re-export v gif-library importu)', g.GIF_NOT_ALLOWED_REASON === 'gif_not_allowed');
  // Kolo 4 bod 4a: konečné červené stavy = odesílatel vidí zprávu smazanou (důvod pro vzhled smazané zprávy).
  check('isGifOwnFinal / gifOwnFinalReason: rejected, expired, not_allowed ano; progress, pending, approved ne',
    ['rejected', 'expired', 'not_allowed'].every((k) => L.isGifOwnFinal({ kind: k })) && !['progress', 'pending', 'approved'].some((k) => L.isGifOwnFinal({ kind: k })) && !L.isGifOwnFinal(null)
    && L.gifOwnFinalReason({ kind: 'rejected' }) === 'gif_rejected' && L.gifOwnFinalReason({ kind: 'expired' }) === 'gif_rejected' && L.gifOwnFinalReason({ kind: 'not_allowed' }) === 'gif_not_allowed' && L.gifOwnFinalReason({ kind: 'pending' }) === null);
  // Review kola 4 M2: konečný stav i v datech zprávy (store) — kopírování / citace / překreslení ji berou jako smazanou.
  {
    const m = { id: 'x', message: 'hele https://tenor.com/view/a-1' };
    check('syncGifOwnFinal: rejected → _deleted + _gifOwnFinal + gif_rejected', H.syncGifOwnFinal(m, { kind: 'rejected' }) === true && m._deleted === true && m._gifOwnFinal === true && m.deletedReason === 'gif_rejected');
    const held = { id: 'y', _deleted: true, deletedReason: 'gif_request' };
    H.syncGifOwnFinal(held, { kind: 'not_allowed' });
    check('syncGifOwnFinal: schovaná gif_request → gif_not_allowed', held.deletedReason === 'gif_not_allowed' && held._deleted === true);
    const soft = { id: 'z' };
    H.syncGifOwnFinal(soft, { kind: 'expired' });
    H.syncGifOwnFinal(soft, { kind: 'pending' });
    check('syncGifOwnFinal: soft „Vypršelo“ → znovu čeká = zpět nesmazaná', soft._deleted === false && !('deletedReason' in soft) && !soft._gifOwnFinal, JSON.stringify(soft));
    const srv = { id: 'w' };
    H.syncGifOwnFinal(srv, { kind: 'expired' });
    srv._srvDeleted = true;
    H.syncGifOwnFinal(srv, { kind: 'pending' });
    check('syncGifOwnFinal: smazání potvrzené serverem mezitím zůstane', srv._deleted === true, JSON.stringify(srv));
    check('syncGifOwnFinal: průběh / bez zprávy nic', H.syncGifOwnFinal({ id: 'p' }, { kind: 'progress' }) === false && H.syncGifOwnFinal(null, { kind: 'rejected' }) === false);
  }
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

  // Stažení prohlížečem (spec 2026-09-29): výzva → view s tlačítky; start → kolečko; odmítnutí / vypršení → 5 s text.
  {
    const ch = []; let t = 5_000_000;
    const bx = new L.GifOutbox({ channel: () => 'robdiesalot', now: () => t, onChange: (k) => ch.push(...k), hasMessage: () => true, setInterval: (fn) => { intervals.push(fn); return 99; }, clearInterval: () => {} });
    const CF = { requestKey: 'twitch:c1', channel: 'robdiesalot', platform: 'twitch', messageId: 'c1', phase: 'client_fetch', pct: 50, token: 'tok', url: 'https://i.imgur.com/a.mp4', kind: 'mp4', width: 640, height: 360, host: 'i.imgur.com', expiresAt: t + 90_000, serverNow: t, pref: 'ask' };
    bx.onProgress({ ...CF, phase: 'detect', pct: 0, token: undefined });
    bx.onProgress(CF);
    const v = bx.view('twitch', 'c1');
    check('Outbox: client_fetch → view s hostem, tokenem, adresou a odpočtem', v.kind === 'client_fetch' && v.host === 'i.imgur.com' && v.token === 'tok' && v.url === CF.url && v.pref === 'ask' && v.remaining === 90_000 && /imgur\.com/.test(v.text), JSON.stringify(v));
    check('Outbox: busy() i při výzvě', bx.busy() === true);
    bx.clientFetchStarted('twitch', 'c1');
    check('Outbox: start stahování → kolečko 50 %', bx.view('twitch', 'c1').kind === 'progress' && bx.view('twitch', 'c1').text === '50 %');
    bx.onProgress({ ...CF, phase: 'client_fetch', token: 'tok2', messageId: 'c2', requestKey: 'twitch:c2' });
    bx.clientFetchFailed('twitch', 'c2', 'too_large');
    check('Outbox: chyba → červený text, po 5 s pryč', bx.view('twitch', 'c2').kind === 'client_failed' && bx.view('twitch', 'c2').text === 'GIF je moc velký (max 10 MB)');
    t += 5_001; for (const fn of intervals) fn();
    check('Outbox: … po 5 s bez štítku', bx.view('twitch', 'c2') === null);
    bx.onProgress({ ...CF, messageId: 'c3', requestKey: 'twitch:c3' });
    t += 90_001; for (const fn of intervals) fn();
    check('Outbox: vypršení výzvy → „Vypršelo, odkaz zůstal běžnou zprávou“', bx.view('twitch', 'c3')?.text === 'Vypršelo, odkaz zůstal běžnou zprávou');
    bx.onProgress({ ...CF, messageId: 'c4', requestKey: 'twitch:c4', expiresAt: t + 90_000 });
    bx.onNotice({ requestKey: 'twitch:c4', channel: 'robdiesalot', platform: 'twitch', messageId: 'c4', kind: 'client_declined' });
    check('Outbox: gif-notice client_declined → „Odkaz zůstal běžnou zprávou“', bx.view('twitch', 'c4')?.kind === 'client_declined');
    check('normalizeGifProgress: client_fetch propouští popis', eq(Object.keys(L.normalizeGifProgress(CF)).filter((k) => ['token', 'url', 'host', 'kind', 'width', 'height', 'expiresAt', 'pref'].includes(k)).sort(), ['expiresAt', 'height', 'host', 'kind', 'pref', 'token', 'url', 'width']));
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
  check('gifRewardView: mod bez výjimky — bez odměny zamčeno, v cooldownu čeká, bez textu „bez odměny“', RV({ allowed: false, mod: true }, 0).mode === 'locked' && !RV({ allowed: false, mod: true }, 0).canSend
    && RV({ allowed: true, mod: true, until: 5_000 }, 0).mode === 'cooldown' && !/bez odměny/.test(RV({ allowed: true, mod: true }, 0).text));
  const locked = RV({ allowed: false, mod: false, until: null }, 0);
  check('gifRewardView: bez odměny zamčeno + hláška jako soundboard (jen „Odměna není aktivována“)', locked.mode === 'locked' && !locked.canSend && locked.text === 'Odměna není aktivována' && locked.text === L.GIF_REWARD_LOCKED_TEXT);
  const act = RV({ allowed: true, mod: false, until: null, rewardUntil: 250_000, rewardTotalMs: 1_000_000 }, 0);
  check('gifRewardView: aktivní s koncem odměny → pásek 25 % + odpočet (věta s tečkou)', act.mode === 'active' && act.progress === 0.25 && act.text === 'Odměna ještě 4:10.', JSON.stringify(act));
  check('gifRewardView: bez konce odměny → bez pásku', RV({ allowed: true, until: null }, 0).progress === null && RV({ allowed: true, until: null }, 0).canSend);
  check('gifRewardView: bez konce odměny → „Odměna „Posílání GIFů“ je aktivní.“', RV({ allowed: true, until: null }, 0).text === 'Odměna „Posílání GIFů“ je aktivní.', RV({ allowed: true, until: null }, 0).text);
  const cdv = RV({ allowed: true, until: 42_000 }, 0);
  check('gifRewardView: cooldown → nelze poslat, „Další GIF můžeš poslat za 42 s.“', cdv.mode === 'cooldown' && !cdv.canSend && cdv.text === 'Další GIF můžeš poslat za 42 s.', cdv.text);
  check('gifRewardView: odměna vypršela → zamčeno', RV({ allowed: true, rewardUntil: 5 }, 10).mode === 'locked');
  check('gifRewardView: režim approved', RV({ allowed: true, mode: 'approved' }, 0).approvedOnly === true);
  // Hláška v hlavičce GIF panelu (bod 4 testu 2026-09-27): v cooldownu jen cooldown, v aktivním stavu tečka mezi větami.
  const HL = L.gifRewardHeadline;
  check('gifRewardHeadline: cooldown + jen schválené → jen „Další GIF můžeš poslat za 35 s.“', HL(RV({ allowed: true, until: 35_000, mode: 'approved', rewardUntil: 226_000 }, 0)) === 'Další GIF můžeš poslat za 35 s.', HL(RV({ allowed: true, until: 35_000, mode: 'approved', rewardUntil: 226_000 }, 0)));
  // Kolo 4 bod 2: v aktivním stavu nahoře žádný text (jen pásek), ani s režimem „jen schválené“.
  check('gifRewardHeadline: aktivní + jen schválené → prázdné (žádné „Odměna ještě …“ ani „Teď jdou jen …“)', HL(RV({ allowed: true, until: null, mode: 'approved', rewardUntil: 226_000 }, 0)) === '', HL(RV({ allowed: true, until: null, mode: 'approved', rewardUntil: 226_000 }, 0)));
  check('gifRewardHeadline: aktivní bez konce → prázdné', HL(RV({ allowed: true, until: null, mode: 'approved' }, 0)) === '' && HL(RV({ allowed: true, until: null }, 0)) === '');
  check('gifRewardTip: aktivní + jen schválené → tooltip beze změny (věta o knihovně zůstává)', JSON.stringify(L.gifRewardTip(RV({ allowed: true, until: null, mode: 'approved', rewardUntil: 226_000 }, 0))?.lines) === JSON.stringify([L.GIF_APPROVED_ONLY_LINE]));
  check('gifRewardHeadline: zamčeno (i jen schválené) → jen „Odměna není aktivována“', HL(RV({ allowed: false, mode: 'approved' }, 0)) === 'Odměna není aktivována');
  check('gifRewardHeadline: neznámý stav → prázdné', HL(RV(null, 0)) === '');

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

  // --- Trvale zahodit + náhled (2026-09-27): texty, množná čísla, položky zahozených ---
  check('gifDaysText: 1 den / 2 dny / 4 dny / 5 dní / 0 dní', ['1 den', '2 dny', '4 dny', '5 dní', '0 dní'].join('|') === [1, 2, 4, 5, 0].map(L.gifDaysText).join('|'));
  const D = 86_400_000, N0 = 1_000_000_000;
  check('gifDeleteInText: za 6 dní / za 1 den / dnes', L.gifDeleteInText(N0 + 6 * D, N0) === 'smaže se za 6 dní' && L.gifDeleteInText(N0 + 3600_000, N0) === 'smaže se za 1 den' && L.gifDeleteInText(N0 - 1, N0) === 'smaže se dnes');
  check('rejectedMetaText: beze změny (3 dny)', L.rejectedMetaText({ rejectedBy: 'twitch:modik', deleteAt: N0 + 3 * D }, N0) === 'Zamítl modik (Twitch) · smaže se za 3 dny');
  const DISC = { mediaId: ID, url: OUR, kind: 'gif', width: 498, height: 280, tags: ['cat'], status: 'purging', purgedAt: N0, purgedBy: 'twitch:modik', purgeAt: N0 + 6 * D, restoreTo: 'approved' };
  const dn = L.normalizeDiscardedItem(DISC);
  check('normalizeDiscardedItem: purging', dn?.status === 'purging' && dn.purgeAt === N0 + 6 * D && dn.restoreTo === 'approved' && eq(dn.tags, ['cat']), JSON.stringify(dn));
  check('normalizeDiscardedItem: jiný stav / cizí URL → null', L.normalizeDiscardedItem({ ...DISC, status: 'approved' }) === null && L.normalizeDiscardedItem({ ...DISC, url: 'https://x.cz/a.gif' }) === null);
  check('normalizeDiscardedItem: restoreTo výchozí rejected', L.normalizeDiscardedItem({ ...DISC, restoreTo: 'x' }).restoreTo === 'rejected');
  check('discardedMetaText: ke smazání s odpočtem', L.discardedMetaText(dn, N0) === 'Zahodil modik (Twitch) · smaže se za 6 dní', L.discardedMetaText(dn, N0));
  check('discardedMetaText: stažený', L.discardedMetaText({ ...dn, status: 'withdrawn', purgeAt: null }, N0) === 'Zahodil modik (Twitch) · zprávy zůstaly');
  check('gifDimText', L.gifDimText({ kind: 'mp4', width: 498, height: 280 }) === '498 × 280 px · MP4' && L.gifDimText({ kind: 'gif' }) === 'GIF' && L.gifDimText({ kind: 'webp', width: 1, height: 2 }) === '1 × 2 px · WebP');
  check('gifPreviewMeta: knihovna = použití', L.gifPreviewMeta({ useCount: 5 }, 'lib', N0) === 'Použito 5×');
  check('gifPreviewMeta: zamítnuté = kdo + kdy (+ vault)', /^Zamítl modik \(Twitch\) · \d+\. \d+\. \d+:\d\d · Vault$/.test(L.gifPreviewMeta({ rejectedBy: 'twitch:modik', rejectedAt: N0, vault: true }, 'rej', N0)), L.gifPreviewMeta({ rejectedBy: 'twitch:modik', rejectedAt: N0, vault: true }, 'rej', N0));
  check('gifPreviewMeta: ke smazání / stažený / duplikát', /^Zahodil modik \(Twitch\) · \d+\. \d+\. \d+:\d\d · smaže se za 6 dní$/.test(L.gifPreviewMeta(dn, 'pg', N0))
    && / · zprávy zůstaly$/.test(L.gifPreviewMeta({ ...dn, status: 'withdrawn' }, 'wd', N0)) && L.gifPreviewMeta({ status: 'rejected', useCount: 2 }, 'dup', N0) === 'Zamítnutý · použito 2×');
  check('GIF_CONFIRM_TEXT: obě varianty v textu, odstranění nevratné', L.GIF_CONFIRM_TEXT.purge.lines.some((l) => l.startsWith('Zahodit, zprávy nechat')) && L.GIF_CONFIRM_TEXT.purge.lines.some((l) => l.startsWith('Zahodit i se zprávami') && l.includes('7 dní'))
    && L.GIF_CONFIRM_TEXT['remove-file'].lines[0] === 'Staré zprávy ukážou [GIF nedostupný]. Nejde vrátit.');
  check('gifLibraryErrorText: nové chyby', L.gifLibraryErrorText({ error: 'already_purged' }) === 'GIF už je zahozený.' && L.gifLibraryErrorText({ error: 'not_purging' }) === 'GIF už není ke smazání.' && L.gifLibraryErrorText({ error: 'not_withdrawn' }) === 'GIF už není mezi staženými.');

  // --- nabídka ⋯ uvnitř panelu (spec 2026-09-27-gif-review-upravy §4) ---
  const R = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const BOX = R(0, 100, 320, 400);          // .uc-gl-body
  const MENU = R(0, 0, 150, 90);
  const mid = L.gifMenuPlacement(R(200, 150, 110, 100), MENU, BOX);
  check('gifMenuPlacement: místo vlevo → zarovnat k pravé hraně dlaždice, pod ⋯', mid.left === 110 - 3 - 150 && mid.top === 27 && !mid.up, JSON.stringify(mid));
  const leftTile = L.gifMenuPlacement(R(4, 150, 104, 100), MENU, BOX);
  check('gifMenuPlacement: levý sloupec → nabídka nevyleze vlevo z panelu', 4 + leftTile.left >= BOX.left + 4 && 4 + leftTile.left + 150 <= BOX.right - 4, JSON.stringify(leftTile));
  const narrow = L.gifMenuPlacement(R(4, 150, 104, 100), MENU, R(0, 100, 120, 400));
  check('gifMenuPlacement: panel užší než nabídka → aspoň od levého okraje', 4 + narrow.left === 4, JSON.stringify(narrow));
  const low = L.gifMenuPlacement(R(200, 440, 110, 100), MENU, BOX);
  check('gifMenuPlacement: dole se nevejde → nad dlaždici', low.up && low.top === -90 - 2, JSON.stringify(low));
  const tight = L.gifMenuPlacement(R(200, 120, 110, 360), MENU, BOX);
  check('gifMenuPlacement: nevejde se ani nahoru → zůstane pod ⋯', !tight.up && tight.top === 27, JSON.stringify(tight));

  // --- závěrečný audit 2026-09-27 (klient) ---
  {
    // E1: výpadek sítě při dotazu /gif/held = zeptat se znovu (s odstupem), ne „Vypršelo“.
    let n = 0; const ticks = []; let online = false; const asked = [];
    const api = async (path) => { asked.push(path); if (!online) throw { error: 'network', status: 0 }; const ids = new URL(`https://x${path}`).searchParams.get('ids').split(','); return { ok: true, messages: ids.map((k) => ({ platform: 'twitch', messageId: k.split(':')[1], state: 'deleted', reason: 'gif_rejected', status: 'rejected' })) }; };
    const b = new L.GifOutbox({ channel: () => 'robdiesalot', now: () => n, api, setInterval: (fn) => { ticks.push(fn); return ticks.length; }, clearInterval: () => {} });
    const tick = async () => { ticks.at(-1)?.(); await new Promise((r) => setTimeout(r, 0)); };
    b.onOwnPending({ requestId: 70, channel: 'robdiesalot', platform: 'twitch', messageId: 'e1', login: 'ja', media: { url: OUR, kind: 'gif' }, expiresAt: 1000, own: true });
    n = 1000 + L.GIF_PENDING_GRACE_MS + 1; await tick();
    check('E1 chyba sítě při dotazu → štítek dál čeká (ne „Vypršelo“)', asked.length === 1 && b.view('twitch', 'e1')?.kind === 'pending', JSON.stringify(b.view('twitch', 'e1')));
    n += 1000; await tick();
    check('E1 … další dotaz ne hned (odstup)', asked.length === 1);
    online = true;
    n += L.GIF_HELD_RECHECK_MS * 4; await tick();
    check('E1 … po odstupu znovu dotaz → výsledek serveru', asked.length === 2 && b.view('twitch', 'e1')?.kind === 'rejected', `${asked.length} ${JSON.stringify(b.view('twitch', 'e1'))}`);
    // Průběh bez události + výpadek: taky jen znovu později.
    online = false;
    b.onProgress({ requestKey: 'twitch:e2', channel: 'robdiesalot', platform: 'twitch', messageId: 'e2', phase: 'download', pct: 20 });
    n += L.GIF_PROGRESS_MAX_SILENT_MS + 1; await tick();
    check('E1 průběh + výpadek → dál kolečko', b.view('twitch', 'e2')?.kind === 'progress');
  }
  {
    // F8: pozdní `done` po rozhodnutí serveru štítek nevrátí.
    const b = new L.GifOutbox({ channel: () => 'robdiesalot', now: () => 0, setInterval: () => 1, clearInterval: () => {} });
    b.onOwnPending({ requestId: 71, channel: 'robdiesalot', platform: 'twitch', messageId: 'f8', login: 'ja', media: { url: OUR, kind: 'gif' }, expiresAt: 999_999, own: true });
    b.onDecided({ requestId: 71, channel: 'robdiesalot', status: 'rejected' });
    b.onProgress({ requestKey: 'twitch:f8', channel: 'robdiesalot', platform: 'twitch', messageId: 'f8', phase: 'done', pct: 100, outcome: 'pending' });
    check('F8 pozdní done po zamítnutí → dál „Zamítnuto moderátorem“', b.view('twitch', 'f8')?.kind === 'rejected');
    b.onProgress({ requestKey: 'twitch:f8b', channel: 'robdiesalot', platform: 'twitch', messageId: 'f8b', phase: 'done', pct: 100, outcome: 'approved' });
    b.onProgress({ requestKey: 'twitch:f8b', channel: 'robdiesalot', platform: 'twitch', messageId: 'f8b', phase: 'done', pct: 100, outcome: 'pending' });
    check('F8 pozdní done po schválení → dál schváleno', b.view('twitch', 'f8b')?.kind === 'approved');
  }
  {
    // F1: čas serveru → lokální (serverNow v události, jinak posun z /gif/state).
    const np = g.normalizeGifPending({ requestId: 1, channel: 'rob', media: { url: OUR, kind: 'gif' }, expiresAt: 10_300_000, serverNow: 10_000_000 }, { now: 50_000 });
    check('F1 normalizeGifPending: serverNow → expiresAt v lokálním čase', np.expiresAt === 350_000, String(np.expiresAt));
    const np2 = g.normalizeGifPending({ requestId: 1, channel: 'rob', media: { url: OUR, kind: 'gif' }, expiresAt: 10_300_000 }, { now: 50_000, offset: -9_950_000 });
    check('F1 normalizeGifPending: bez serverNow → posun hostitele', np2.expiresAt === 350_000, String(np2.expiresAt));
    check('F1 normalizeGifPending: bez posunu beze změny', g.normalizeGifPending({ requestId: 1, channel: 'rob', media: { url: OUR, kind: 'gif' }, expiresAt: 9 }).expiresAt === 9);
    // Karta moda: hodiny klienta o 10 min napřed, server posílá serverNow → karta se ukáže.
    const cards = new g.GifRequests({ doc: { body: {} }, container: null, api: async () => ({}), channel: () => 'rob', canModerate: () => true, now: () => 600_000 + 1_000_000, setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {} });
    cards._render = () => {};
    const ok = cards.onPending({ requestId: 5, channel: 'rob', platform: 'twitch', login: 'x', media: { url: OUR, kind: 'gif' }, expiresAt: 1_000_000 + 300_000, serverNow: 1_000_000, createdAt: 1_000_000 });
    check('F1 GifRequests: hodiny napřed + serverNow → karta se neztratí', ok === true && cards.size === 1);
    const cards2 = new g.GifRequests({ doc: { body: {} }, container: null, api: async () => ({}), channel: () => 'rob', canModerate: () => true, now: () => 600_000 + 1_000_000, serverOffset: () => 600_000, setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {} });
    cards2._render = () => {};
    check('F1 GifRequests: posun z /gif/state (serverOffset)', cards2.onPending({ requestId: 6, channel: 'rob', platform: 'twitch', login: 'x', media: { url: OUR, kind: 'gif' }, expiresAt: 1_000_000 + 300_000, createdAt: 1_000_000 }) === true);
  }
  {
    // F5: loadPending prořeže karty, které server už nevrátil.
    let list = [{ requestId: 1, channel: 'rob', platform: 'twitch', login: 'a', media: { url: OUR, kind: 'gif' }, expiresAt: 9e12, createdAt: 1 }, { requestId: 2, channel: 'rob', platform: 'twitch', login: 'b', media: { url: OUR, kind: 'gif' }, expiresAt: 9e12, createdAt: 2 }];
    const q = new g.GifRequests({ doc: { body: {} }, container: null, api: async () => ({ ok: true, requests: list }), channel: () => 'rob', canModerate: () => true, now: () => 0, setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {} });
    q._render = () => {};
    await q.loadPending();
    list = [list[1]];
    await q.loadPending();
    check('F5 loadPending: karta, kterou server už nemá, zmizí', q.size === 1 && !q.has(1) && q.has(2));
  }
  {
    // F9: odhlášení během vydání tokenu → token se nezapíše.
    let release;
    const tk = new L.GifAccessToken({ api: () => new Promise((r) => { release = r; }), channel: () => 'rob' });
    const p = tk.get();
    await new Promise((r) => setTimeout(r, 0));
    tk.clear();
    release({ ok: true, token: 'pozdni' });
    const got = await p;
    check('F9 clear() během vydání → token zahozen', got === null && tk.current() === null);
  }
  {
    // X1: vlastní rozpracovaný / čekající GIF → busy (výběr z knihovny blokovat).
    let n = 0;
    const b = new L.GifOutbox({ channel: () => 'robdiesalot', now: () => n, setInterval: () => 1, clearInterval: () => {} });
    check('X1 busy: nic → false', b.busy() === false);
    b.onOwnPending({ requestId: 80, channel: 'robdiesalot', platform: 'twitch', messageId: 'x1', login: 'ja', media: { url: OUR, kind: 'gif' }, expiresAt: 999_999, own: true });
    check('X1 busy: čeká na moda → true', b.busy() === true);
    b.onDecided({ requestId: 80, channel: 'robdiesalot', status: 'rejected' });
    check('X1 busy: rozhodnuto → false', b.busy() === false);
    b.noteOptimistic('sent-x', 'twitch', { show: true });
    check('X1 busy: optimistická s kolečkem → true', b.busy() === true);
    n = L.GIF_OPTIMISTIC_SILENT_MS + 1;
    check('X1 busy: optimistická bez odezvy (15 s) → false', b.busy() === false);
    check('X1 text hlášky', L.GIF_WAIT_OWN_TEXT === 'Počkej, až mod rozhodne o tvém GIFu.');
  }
  {
    // A10: vlastní zpráva z historie smazaná gif_rejected → červený štítek (po reloadu), expired upřesní /gif/held.
    const asked = [];
    const b = new L.GifOutbox({ channel: () => 'robdiesalot', now: () => 0, api: async (p) => { asked.push(p); return { ok: true, messages: [{ platform: 'kick', messageId: 'h2', state: 'deleted', reason: 'gif_rejected', status: 'expired' }] }; }, setInterval: () => 1, clearInterval: () => {} });
    const me = { login: 'Ja' };
    const v1 = L.gifOwnHistoryView(b, { platform: 'twitch', id: 'h1', username: 'ja', deleted: true, deletedReason: 'gif_rejected' }, me);
    check('A10 historie: vlastní gif_rejected → „Zamítnuto moderátorem“', v1?.kind === 'rejected' && v1.text === 'Zamítnuto moderátorem', JSON.stringify(v1));
    check('A10 historie: cizí zpráva → null', L.gifOwnHistoryView(b, { platform: 'twitch', id: 'h9', username: 'jiny', deleted: true, deletedReason: 'gif_rejected' }, me) === null);
    check('A10 historie: bez přihlášení → null', L.gifOwnHistoryView(b, { platform: 'twitch', id: 'h8', username: 'ja', deleted: true, deletedReason: 'gif_rejected' }, null) === null);
    check('A10 historie: jiný důvod smazání (mod) → null', L.gifOwnHistoryView(b, { platform: 'twitch', id: 'h7', username: 'ja', deleted: true, deletedReason: 'mod' }, me) === null);
    L.gifOwnHistoryView(b, { platform: 'kick', id: 'h2', username: 'JA', deleted: true, deletedReason: 'gif_rejected' }, me);
    await new Promise((r) => setTimeout(r, 0));
    check('A10 historie: upřesnění přes /gif/held → „Vypršelo“', asked.some((p) => p.includes('kick%3Ah2')) && b.view('kick', 'h2')?.kind === 'expired', `${asked.length} ${JSON.stringify(b.view('kick', 'h2'))}`);
    const vh = L.gifOwnHistoryView(b, { platform: 'twitch', id: 'h3', username: '@ja', deleted: true, deletedReason: 'gif_request' }, me);
    check('A10 historie: vlastní schovaná gif_request → „Schvalování moderátorem“', vh?.kind === 'pending');
    // Review: upřesnění zamítnutých z historie v jedné dávce (ne dotaz na každou zprávu).
    const asked2 = [];
    const b2 = new L.GifOutbox({ channel: () => 'robdiesalot', now: () => 0, api: async (p) => { asked2.push(p); return { ok: true, messages: [] }; }, setInterval: () => 1, clearInterval: () => {} });
    for (let i = 0; i < 10; i++) L.gifOwnHistoryView(b2, { platform: 'twitch', id: `r${i}`, username: 'ja', deleted: true, deletedReason: 'gif_rejected' }, me);
    await new Promise((r) => setTimeout(r, 0));
    check('A10 historie: 10 zamítnutých zpráv → 1 dotaz /gif/held', asked2.length === 1 && decodeURIComponent(asked2[0]).includes('twitch:r9'), `${asked2.length}`);
    const asked3 = [];
    const b3 = new L.GifOutbox({ channel: () => 'robdiesalot', now: () => 0, api: async (p) => { asked3.push(p); return { ok: true, messages: [] }; }, setInterval: () => 1, clearInterval: () => {} });
    for (let i = 0; i < 60; i++) L.gifOwnHistoryView(b3, { platform: 'twitch', id: `q${i}`, username: 'ja', deleted: true, deletedReason: 'gif_rejected' }, me);
    await new Promise((r) => setTimeout(r, 0));
    check('A10 historie: 60 zamítnutých → 2 dotazy (max 50 klíčů)', asked3.length === 2, `${asked3.length}`);
  }

  // --- backend auditu 2026-09-27 (kontrakt pro klienta) ---
  {
    check('normalizeGifPending: media.tokenRequired (dříve zamítnuté médium jen s tokenem)', g.normalizeGifPending({ requestId: 1, channel: 'rob', media: { url: OUR, kind: 'gif', tokenRequired: true }, expiresAt: 9 }).tokenRequired === true
      && g.normalizeGifPending({ requestId: 1, channel: 'rob', media: { url: OUR, kind: 'gif' }, expiresAt: 9 }).tokenRequired === false);
    let tn = 1_000_000, n = 0;
    const tk = new L.GifAccessToken({ api: async () => { n++; return { ok: true, token: `t${n}`, serverNow: 5_000, expiresAt: 5_000 + 30 * 86_400_000 }; }, now: () => tn });
    const a = await tk.get();
    tn += 28 * 86_400_000;
    const b = await tk.get();
    tn += 1.5 * 86_400_000;
    const c = await tk.get();
    await new Promise((r) => setTimeout(r, 0));
    check('GifAccessToken: expiresAt (čas serveru → lokální) → den před koncem obnova na pozadí (platný token dál)', a === 't1' && b === 't1' && c === 't1' && n === 2 && tk.current() === 't2', `${a} ${b} ${c} ${n} ${tk.current()}`);
    // Review: current() (panel, karta moda) v okně obnovy taky obnoví na pozadí.
    let tn2 = 0, n2 = 0;
    const tk2 = new L.GifAccessToken({ api: async () => { n2++; return { ok: true, token: `u${n2}`, serverNow: 0, expiresAt: 30 * 86_400_000 }; }, now: () => tn2 });
    await tk2.get();
    tn2 = 29.5 * 86_400_000;
    const cur = tk2.current();
    await new Promise((r) => setTimeout(r, 0));
    check('GifAccessToken: current() v okně obnovy → vrátí platný token a obnoví ho na pozadí', cur === 'u1' && n2 === 2 && tk2.current() === 'u2', `${cur} ${n2} ${tk2.current()}`);
    tn2 = 70 * 86_400_000;
    check('GifAccessToken: propadlý token current() nevrátí', tk2.current() === null);
    // Token ze sessionStorage bez expirace → „obnovit brzy“: po prvním použití nový na pozadí.
    let n3 = 0;
    const tk3 = new L.GifAccessToken({ api: async () => { n3++; return { ok: true, token: 'novy', serverNow: 0, expiresAt: 30 * 86_400_000 }; }, store: { load: async () => 'ulozeny', save: async () => {}, clear: async () => {} }, now: () => 0 });
    const s1 = await tk3.get();
    await new Promise((r) => setTimeout(r, 0));
    check('GifAccessToken: token ze session bez expirace → použije se a obnoví na pozadí (jednou)', s1 === 'ulozeny' && n3 === 1 && tk3.current() === 'novy' && (tk3.current(), await tk3.get(), n3 === 1), `${s1} ${n3} ${tk3.current()}`);
    const ob = new L.GifOutbox({ channel: () => 'rob', now: () => 0, setInterval: () => 1, clearInterval: () => {} });
    ob.onNotice({ requestKey: 'twitch:u1', channel: 'rob', platform: 'twitch', messageId: 'u1', kind: 'auto_rejected', reason: 'unapproved' });
    check('gif-notice auto_rejected reason unapproved → „Zamítnuto moderátorem“', ob.view('twitch', 'u1')?.text === 'Zamítnuto moderátorem');
  }

  // --- gif-host.js (D1: sdílená logika hostitele addon / web) ---
  {
    // F3: YouTube kontrola se řídí stavem chatu (optimistická zpráva), ne frontou párování; GIF se štítkem nikdy neodesláno.
    const timers = []; const failed = []; const logs = [];
    const st = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
    let pending = true;
    H.watchYoutubeSend({ optId: 'sent-1', platform: 'youtube', isGif: false, pending: () => pending, markFailed: (r) => failed.push(r), log: (t, x) => logs.push(x), setTimeout: st, clearTimeout: () => {} });
    check('F3 watchYoutubeSend: první kontrola po 20 s', timers.length === 1 && timers[0].ms === 20_000);
    timers[0].fn();
    check('F3 … bez echa → neodesláno (i když fronta párování zprávu už prořezala)', failed.length === 1 && failed[0] === H.YT_SEND_FAIL_TEXT);
    pending = false; timers.length = 0; failed.length = 0;
    H.watchYoutubeSend({ optId: 'sent-2', platform: 'youtube', pending: () => pending, markFailed: (r) => failed.push(r), setTimeout: st, clearTimeout: () => {} });
    timers[0].fn();
    check('F3 … echo dorazilo (zpráva už není optimistická) → nic', failed.length === 0);
    const ob = new L.GifOutbox({ channel: () => 'rob', now: () => 0, setInterval: () => 1, clearInterval: () => {} });
    pending = true; timers.length = 0;
    H.watchYoutubeSend({ optId: 'sent-3', platform: 'youtube', isGif: true, outbox: ob, pending: () => pending, markFailed: (r) => failed.push(r), setTimeout: st, clearTimeout: () => {} });
    timers[0].fn();
    check('F3 … GIF bez štítku → ještě jednou po 25 s', failed.length === 0 && timers.length === 2 && timers[1].ms === 25_000);
    ob.noteOptimistic('sent-3', 'youtube', { show: true });
    timers[1].fn();
    check('F3 … GIF se štítkem → ne neodesláno', failed.length === 0);
  }
  {
    // applyGifHeldResult
    const store = new Map([['m1', { platform: 'twitch', id: 'm1', deletedReason: 'gif_request' }]]);
    const calls = [];
    const deps = { store, unhide: (d) => { calls.push(['unhide', d.messageId]); return 1; }, applyDeleted: (p, id, o) => { calls.push(['del', id, o.reason]); return 2; }, forgetHeld: (id) => calls.push(['forget', id]) };
    check('applyGifHeldResult: visible → odkrýt', H.applyGifHeldResult({ platform: 'twitch', messageId: 'm1', state: 'visible', message: { id: 'm1' } }, deps) === 1 && eq(calls.at(-1), ['unhide', 'm1']));
    check('applyGifHeldResult: deleted → smazaná s důvodem, důvod gif_request zapomenut', H.applyGifHeldResult({ platform: 'twitch', messageId: 'm1', state: 'deleted', reason: 'gif_rejected' }, deps) === 2 && eq(calls.slice(-2), [['forget', 'm1'], ['del', 'm1', 'gif_rejected']]) && store.get('m1').deletedReason === undefined);
    check('applyGifHeldResult: held / replaced → nic', H.applyGifHeldResult({ platform: 'twitch', messageId: 'm1', state: 'held' }, deps) === 0);
  }
  {
    // applyGifMediaEvent + loadGifMediaMessages + storeHasKey
    const store = new cs.ChatStore();
    store.add({ platform: 'twitch', id: 'a', timestamp: 1, message: 'x', gif: { url: OUR } });
    store.add({ platform: 'kick', id: 'b', timestamp: 2, message: 'y', gif: { url: `https://api.jouki.cz/media/gif/${'cd'.repeat(16)}` } });
    const deleted = [], unhidden = [];
    const deps = { doc: null, store, msgEls: () => [], applyDeleted: (p, id, o) => deleted.push(`${p}:${id}:${o.reason}`), unhide: (d) => unhidden.push(d.messageId) };
    check('applyGifMediaEvent: removed → jen zprávy s tím médiem smazané gif_removed', H.applyGifMediaEvent({ mediaId: ID, state: 'removed', messageIds: [] }, [], deps) === 1 && eq(deleted, ['twitch:a:gif_removed']));
    check('applyGifMediaEvent: unavailable → msg.gif.unavailable', H.applyGifMediaEvent({ mediaId: ID, state: 'unavailable', messageIds: [] }, [], deps) === 1 && store.get('a').gif.unavailable === true);
    check('applyGifMediaEvent: visible → obnovit jen zprávy, které chat má, s ověřeným médiem', H.applyGifMediaEvent({ mediaId: ID, state: 'visible', messageIds: [] }, [{ platform: 'twitch', id: 'a', gif: { url: OUR } }, { platform: 'twitch', id: 'zz', gif: { url: OUR } }, { platform: 'twitch', id: 'a', gif: { url: 'https://evil/x.gif' } }], deps) === 1 && eq(unhidden, ['a']));
    check('storeHasKey: platforma + id', H.storeHasKey(store, 'twitch:a') && !H.storeHasKey(store, 'kick:a') && !H.storeHasKey(store, 'twitch:zz'));
    const paths = [];
    const r = await H.loadGifMediaMessages({ channel: 'Rob', mediaId: ID, state: 'visible', messageIds: ['twitch:a', 'twitch:zz'] }, { channel: 'rob', api: async (p) => { paths.push(p); return { messages: [{ id: 'a' }] }; }, has: (k) => H.storeHasKey(store, k), delayMs: 0 });
    check('loadGifMediaMessages: dotaz jen na zprávy v chatu', r.n?.state === 'visible' && r.list.length === 1 && paths.length === 1 && paths[0].includes(encodeURIComponent('twitch:a')) && !paths[0].includes('zz'), paths[0]);
    let slept = null;
    await H.loadGifMediaMessages({ channel: 'rob', mediaId: ID, state: 'visible', messageIds: ['twitch:a'] }, { channel: 'rob', api: async () => ({ messages: [] }), has: () => true, delayMs: 1500, sleep: async (ms) => { slept = ms; } });
    check('loadGifMediaMessages: rozprostřený dotaz (audit F13)', slept === 1500);
    const none = await H.loadGifMediaMessages({ channel: 'jiny', mediaId: ID, state: 'visible' }, { channel: 'rob', api: async () => { throw new Error('ne'); }, has: () => true, delayMs: 0 });
    check('loadGifMediaMessages: jiný kanál → n null, bez dotazu', none.n === null && none.list.length === 0);
  }
  {
    // gifAccountHandlers
    const got = [];
    const req = { onPending: () => got.push('rp'), onDecided: () => got.push('rd'), onQueue: () => got.push('rq') };
    const out = { onOwnPending: () => got.push('op'), onDecided: () => got.push('od'), onProgress: () => got.push('pr'), onNotice: () => got.push('no'), resync: () => 2 };
    const cdn = { onDecided: () => got.push('cd') };
    const { handlers, onOpen } = H.gifAccountHandlers({ requests: () => req, outbox: () => out, cooldown: () => cdn });
    handlers['gif-pending']({ own: false }); handlers['gif-pending']({ own: true }); handlers['gif-decided']({ own: true }); handlers['gif-queue']({}); handlers['gif-progress']({}); handlers['gif-notice']({});
    check('gifAccountHandlers: směrování událostí', eq(got, ['rp', 'rp', 'op', 'rd', 'cd', 'od', 'rq', 'pr', 'no']), JSON.stringify(got));
    check('gifAccountHandlers: onOpen → resync', onOpen({ reconnect: true }) === 2);
  }
  {
    // gifMessageForChat + pairGifEcho
    const ob = new L.GifOutbox({ channel: () => 'rob', now: () => 0, setInterval: () => 1, clearInterval: () => {} });
    const ev = { channel: 'rob', message: { id: 'gif-9', platform: 'twitch', message: 'x', timestamp: 5, gif: { url: OUR }, gifOrigin: 'twitch:m9' } };
    ob.onOwnPending({ requestId: 9, channel: 'rob', platform: 'twitch', messageId: 'm9', login: 'ja', media: { url: OUR }, expiresAt: 9e12, own: true });
    const m = H.gifMessageForChat(ev, { channel: 'rob', has: () => false, outbox: ob });
    check('gifMessageForChat: zpráva k vykreslení (živá) + můj GIF schválen', m?.id === 'gif-9' && m.historical === false && ob.view('twitch', 'm9')?.kind === 'approved');
    check('gifMessageForChat: už v chatu / jiný kanál → null', H.gifMessageForChat(ev, { channel: 'rob', has: () => true }) === null && H.gifMessageForChat(ev, { channel: 'jiny', has: () => false }) === null);
    ob.noteOptimistic('sent-5', 'youtube', { show: true });
    ob.alias('sent-5', 'youtube', 'LCC.5');
    const p = H.pairGifEcho({ platform: 'youtube', id: 'LCC.5', message: '', deleted: true, deletedReason: 'gif_request' }, ob, (id) => id === 'sent-5');
    check('pairGifEcho: echo bez obsahu → optimistická + patch bez textu', p?.optId === 'sent-5' && !('message' in p.patch) && p.patch.deleted === true);
    check('pairGifEcho: cizí / optimistická už není → null', H.pairGifEcho({ platform: 'youtube', id: 'X' }, ob, () => true) === null && H.pairGifEcho({ platform: 'youtube', id: 'LCC.5' }, ob, () => false) === null);
  }

  {
    // test2 bod 4: náš odkaz (id) na GIF z knihovny → „Odesílám…“ bez procent, kolečko až s fází stahování.
    let n = 0; const ch = [];
    const ob = new L.GifOutbox({ channel: () => 'rob', now: () => n, onChange: (k) => ch.push(...k), hasMessage: () => false, setInterval: () => 1, clearInterval: () => {} });
    ob.noteOptimistic('sent-o1', 'twitch', { show: true, own: true });
    check('test2: náš odkaz → „Odesílám…“ bez procent', eq(ob.view('twitch', 'sent-o1'), { kind: 'sending', text: L.GIF_SENDING_TEXT }) && L.GIF_SENDING_TEXT === 'Odesílám…', JSON.stringify(ob.view('twitch', 'sent-o1')));
    const PK = (phase, pct, extra = {}) => ({ requestKey: 'twitch:o1', channel: 'rob', platform: 'twitch', messageId: 'o1', phase, pct, ...extra });
    ob.onProgress(PK('detect', 0)); ob.onProgress(PK('access', 10)); ob.onProgress(PK('verify', 95));
    check('test2: detect / access / verify u našeho odkazu → pořád „Odesílám…“ (spárováno)', ob.keyOf('twitch', 'sent-o1') === 'twitch:o1' && ob.view('twitch', 'sent-o1')?.kind === 'sending');
    check('test2: „Odesílám…“ blokuje další výběr (busy)', ob.busy() === true);
    ob.onProgress(PK('done', 100, { outcome: 'approved', cooldownUntil: 50_000, serverNow: 0 }));
    check('test2: done approved → štítek pryč', ob.view('twitch', 'o1')?.kind === 'approved');
    ob.noteOptimistic('sent-o2', 'twitch', { show: true, own: true });
    ob.onProgress({ ...PK('download', 30), requestKey: 'twitch:o2', messageId: 'o2' });
    check('test2: fáze stahování → kolečko s %', ob.view('twitch', 'sent-o2')?.kind === 'progress' && ob.view('twitch', 'sent-o2')?.text === '30 %');
    ob.noteOptimistic('sent-o3', 'twitch', { show: true });
    check('test2: cizí odkaz (Tenor) → kolečko 0 % hned jako dřív', ob.view('twitch', 'sent-o3')?.kind === 'progress');
    // 4.1: gif-notice cooldown → bez kolečka i štítku + hláška
    const notes = [];
    const ob2 = new L.GifOutbox({ channel: () => 'rob', now: () => n, onNotice: (kind, e, d) => notes.push([kind, d?.until]), hasMessage: () => false, setInterval: () => 1, clearInterval: () => {} });
    ob2.noteOptimistic('sent-c1', 'twitch', { show: true, own: true });
    ob2.onNotice({ requestKey: 'twitch:c1', channel: 'rob', platform: 'twitch', messageId: 'c1', kind: 'cooldown', until: 42_000, serverNow: 0 });
    check('test2 4.1: gif-notice cooldown → optimistická bez kolečka i štítku', ob2.view('twitch', 'sent-c1') === null && ob2.view('twitch', 'c1') === null && !ob2.governs('twitch', 'sent-c1'));
    check('test2 4.1: gif-notice cooldown → hláška hostiteli s until', eq(notes, [['cooldown', 42_000]]), JSON.stringify(notes));
    ob2.onProgress({ requestKey: 'twitch:c1', channel: 'rob', platform: 'twitch', messageId: 'c1', phase: 'detect', pct: 0 });
    check('test2 4.1: pozdní průběh po hlášce cooldown kolečko nevrátí', ob2.view('twitch', 'c1') === null);
    check('gifCooldownNoticeText: 3 tvary + odkaz zůstal', L.gifCooldownNoticeText(42_000) === 'GIF můžeš poslat až za 42 s — odkaz zůstal jako běžná zpráva.'
      && L.gifCooldownNoticeText(90_000) === 'GIF můžeš poslat až za 1:30 — odkaz zůstal jako běžná zpráva.', L.gifCooldownNoticeText(42_000));
    check('gifCooldownNoticeText: filtr odkazů zprávu smazal (removed) → nelže, že odkaz zůstal (review M2)', L.gifCooldownNoticeText(42_000, { removed: true }) === 'GIF můžeš poslat až za 42 s — zprávu s odkazem smazal filtr odkazů.');
  }
  {
    // test2 4.1: gifAccountHandlers → cooldown ze serveru (done approved s cooldownUntil, gif-notice cooldown)
    const got = [];
    const out = { onProgress: () => {}, onNotice: () => {} };
    const cdn = { onServerCooldown: (u, sn) => got.push([u, sn]) };
    const { handlers } = H.gifAccountHandlers({ requests: () => ({}), outbox: () => out, cooldown: () => cdn });
    handlers['gif-progress']({ phase: 'done', outcome: 'approved', cooldownUntil: 9_000, serverNow: 1_000 });
    handlers['gif-progress']({ phase: 'done', outcome: 'approved', cooldownUntil: null, serverNow: 1_000 });
    handlers['gif-progress']({ phase: 'download', pct: 30 });
    handlers['gif-notice']({ kind: 'cooldown', until: 7_000, serverNow: 1_000 });
    handlers['gif-notice']({ kind: 'approved_only' });
    check('test2 4.1: gifAccountHandlers → cooldown.onServerCooldown (done approved / notice cooldown)', eq(got, [[9_000, 1_000], [null, 1_000], [7_000, 1_000]]), JSON.stringify(got));
  }
  {
    // test2 bod 1 + 3: tooltip ikony emotů / záložky GIFy — stav odměny (mod i divák bez výjimky, zamčeno, cooldown)
    const T = L.gifRewardTip;
    const RV = L.gifRewardView;
    const act = T(RV({ allowed: true, until: null, rewardUntil: 268_000, rewardTotalMs: 400_000 }, 0));
    check('gifRewardTip: aktivní → „GIF odměna aktivní“, řádek s časem 4:28 a páskem', act.mode === 'active' && act.title === 'GIF odměna aktivní'
      && act.rows.length === 1 && act.rows[0].name === 'Posílání GIFů' && act.rows[0].remainingMs === 268_000 && act.rows[0].progress === 0.67 && !act.cooldownMs, JSON.stringify(act));
    const cd = T(RV({ allowed: true, until: 42_000, rewardUntil: 268_000, rewardTotalMs: 400_000 }, 0));
    check('gifRewardTip: cooldown → nadpis „GIF odměna — cooldown“ + cooldown 42 s', cd.mode === 'cooldown' && cd.title === 'GIF odměna — cooldown' && cd.cooldownMs === 42_000 && cd.rows.length === 1, JSON.stringify(cd));
    const lk = T(RV({ allowed: false }, 0));
    check('gifRewardTip: zamčeno → „Odměna není aktivována“ (jako panel), bez druhé věty (spec 2026-09-27 §2)', lk.mode === 'locked' && lk.title === 'Odměna není aktivována' && !lk.lines.length && !lk.rows?.length);
    const un = T(RV({ allowed: true, until: null }, 0));
    check('gifRewardTip: bez konce odměny → „bez omezení“ (remainingMs null)', un.rows[0].remainingMs === null && un.rows[0].progress === null);
    check('gifRewardTip: nepřihlášený → výzva', T(RV(null, 0, { loggedIn: false })).lines[0].startsWith('Přihlas se'));
    check('gifRewardTip: neznámý stav → null', T(RV(null, 0)) === null);
    const ap = T(RV({ allowed: true, until: null, mode: 'approved' }, 0));
    check('gifRewardTip: režim approved → řádek „Teď jdou jen GIFy z knihovny.“', ap.lines.includes('Teď jdou jen GIFy z knihovny.'));
    const apCd = T(RV({ allowed: true, until: 35_000, mode: 'approved', rewardUntil: 226_000 }, 0));
    check('gifRewardTip: cooldown + jen schválené → bez věty o knihovně (bod 4)', apCd.mode === 'cooldown' && !apCd.lines.length, JSON.stringify(apCd));
  }

  // --- core/gif-client-fetch.js: stažení v prohlížeči (CORS, bez cookies), upload, chyby ---
  {
    const mkRes = (bytes, headers = { 'content-type': 'video/mp4', 'content-length': String(bytes.length) }) => ({ ok: true, status: 200, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    const bytes = new Uint8Array(1000);
    const calls = [];
    const upload = async (b, token, remember) => { calls.push([b.byteLength, token, remember]); return { ok: true }; };
    const r1 = await CF.runClientFetch({ url: 'https://i.imgur.com/a.mp4', token: 'tok', remember: true, fetchImpl: async (u, init) => { calls.push(['fetch', u, init.mode, init.credentials, init.redirect]); return mkRes(bytes); }, upload });
    check('runClientFetch: CORS bez cookies, upload s tokenem a remember', eq(r1, { ok: true }) && eq(calls[0], ['fetch', 'https://i.imgur.com/a.mp4', 'cors', 'omit', 'error']) && eq(calls[1], [1000, 'tok', true]), JSON.stringify(calls));
    const r2 = await CF.runClientFetch({ url: 'https://i.imgur.com/a.mp4', token: 'tok', maxBytes: 500, fetchImpl: async () => mkRes(bytes), upload });
    check('runClientFetch: Content-Length přes limit → too_large bez uploadu', eq(r2, { ok: false, code: 'too_large' }) && calls.length === 2);
    const r3 = await CF.runClientFetch({ url: 'https://i.imgur.com/a.mp4', token: 'tok', fetchImpl: async () => { throw new TypeError('Failed to fetch'); }, upload });
    check('runClientFetch: chyba sítě / CORS → network', eq(r3, { ok: false, code: 'network' }));
    const r4 = await CF.runClientFetch({ url: 'https://i.imgur.com/a.mp4', token: 'tok', fetchImpl: async () => mkRes(bytes), upload: async () => ({ ok: false, error: 'size_mismatch', status: 400 }) });
    check('runClientFetch: server odmítl → jeho kód', eq(r4, { ok: false, code: 'size_mismatch' }));
    const r5 = await CF.runClientFetch({ url: 'https://i.imgur.com/a.mp4', token: 'tok', fetchImpl: async () => mkRes(bytes), upload: async () => { throw { error: 'rate_limited', status: 429 }; } });
    check('runClientFetch: upload zamítl (throw) → jeho kód', eq(r5, { ok: false, code: 'rate_limited' }));
    const r6 = await CF.runClientFetch({ url: 'https://i.imgur.com/a.mp4', token: 'tok', fetchImpl: async () => ({ ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }), upload });
    check('runClientFetch: HTTP chyba stažení (ok:false) → network, bez uploadu', eq(r6, { ok: false, code: 'network' }) && calls.length === 2);
  }

  // --- installGifClientFetch: klikání na štítek + automatika podle předvolby (always/never), bez DOM ---
  {
    let t9 = 0;
    const bx9 = new L.GifOutbox({ channel: () => 'rob', now: () => t9, hasMessage: () => true, setInterval: () => 1, clearInterval: () => {} });
    const uploadCalls = [];
    const declineCalls = [];
    const upload9 = async (b, token, remember) => { uploadCalls.push([b.byteLength, token, remember]); return { ok: true }; };
    const decline9 = async (token, remember) => { declineCalls.push([token, remember]); };
    const fetchImpl9 = async () => ({ ok: true, status: 200, headers: { get: (k) => (k.toLowerCase() === 'content-length' ? '4' : null) }, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer });
    const fakeChatEl = { addEventListener() {}, removeEventListener() {}, contains: () => true };
    const uninstall9 = CF.installGifClientFetch({}, fakeChatEl, { outbox: bx9, upload: upload9, decline: decline9, fetchImpl: fetchImpl9, pref: () => 'ask' });
    const CFEV = (id, pref) => ({ requestKey: `twitch:${id}`, channel: 'rob', platform: 'twitch', messageId: id, phase: 'client_fetch', pct: 50, token: 'tokA', url: 'https://i.imgur.com/a.mp4', kind: 'mp4', width: 640, height: 360, host: 'i.imgur.com', expiresAt: t9 + 90_000, serverNow: t9, pref });
    bx9.onProgress(CFEV('always1', 'always'));
    await new Promise((r) => setTimeout(r, 0));
    check('installGifClientFetch: předvolba "always" → rovnou stáhnout a nahrát bez zapamatování', eq(uploadCalls, [[4, 'tokA', false]]), JSON.stringify(uploadCalls));
    bx9.onProgress(CFEV('never1', 'never'));
    await new Promise((r) => setTimeout(r, 0));
    check('installGifClientFetch: předvolba "never" → rovnou odmítnout, štítek client_declined', eq(declineCalls, [['tokA', false]]) && bx9.view('twitch', 'never1')?.kind === 'client_declined', JSON.stringify(declineCalls));
    // "ask" (bez pref override) → nic se samo nestane, výzva zůstává vidět s tlačítky.
    bx9.onProgress(CFEV('ask1', 'ask'));
    check('installGifClientFetch: předvolba "ask" → beze změny, výzva čeká na klik', bx9.view('twitch', 'ask1')?.kind === 'client_fetch' && uploadCalls.length === 1 && declineCalls.length === 1);
    uninstall9();
    check('installGifClientFetch: uninstall vrátí outbox.onClientFetch (žádný předchozí hák → null)', bx9.onClientFetch === null);
  }

  console.log(fails ? `\n${fails} FAIL` : '\nvše PASS');
  process.exit(fails ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
