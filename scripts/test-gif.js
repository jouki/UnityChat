// Testy čistých částí odměny „Posílání GIFů" (extension/core/gif.js) + handlerů /account/stream
// (core/account-warnings.js). DOM část (karty, render média) kryje scripts/e2e-gif.mjs.
// Spuštění: node scripts/test-gif.js
Promise.all([
  import('../extension/core/gif.js'),
  import('../extension/core/account-warnings.js'),
]).then(async ([g, aw]) => {
  let fails = 0;
  const check = (n, ok, detail = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || !detail ? '' : ` — ${detail}`)); if (!ok) fails++; };
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const ID = '0123456789abcdef0123456789abcdef';
  const URL_OK = `https://api.jouki.cz/media/gif/${ID}`;

  // --- URL média ---
  check('isGifMediaUrl: náš server', g.isGifMediaUrl(URL_OK));
  check('isGifMediaUrl: localhost http (vývoj)', g.isGifMediaUrl(`http://localhost:3001/media/gif/${ID}`));
  check('isGifMediaUrl: cizí http ne', !g.isGifMediaUrl(`http://api.jouki.cz/media/gif/${ID}`));
  check('isGifMediaUrl: cizí cesta ne', !g.isGifMediaUrl('https://media1.tenor.com/x.gif') && !g.isGifMediaUrl(`https://api.jouki.cz/media/gif/${ID}/x`));
  check('isGifMediaUrl: krátké / velké hex ne', !g.isGifMediaUrl('https://api.jouki.cz/media/gif/abc') && !g.isGifMediaUrl(`https://api.jouki.cz/media/gif/${ID.toUpperCase()}`));
  check('isGifMediaUrl: query, hash, údaje v URL ne', !g.isGifMediaUrl(`${URL_OK}?x=1`) && !g.isGifMediaUrl(`${URL_OK}#a`) && !g.isGifMediaUrl(`https://u:p@api.jouki.cz/media/gif/${ID}`));
  check('isGifMediaUrl: javascript: / nesmysl ne', !g.isGifMediaUrl('javascript:alert(1)') && !g.isGifMediaUrl(null) && !g.isGifMediaUrl(''));
  check('isGifMediaUrl: whitelist originů', g.isGifMediaUrl(URL_OK, ['https://api.jouki.cz']) && !g.isGifMediaUrl(`https://evil.cz/media/gif/${ID}`, ['https://api.jouki.cz']));

  // --- médium ---
  check('normalizeGifMedia: mp4 s rozměry', eq(g.normalizeGifMedia({ url: URL_OK, kind: 'mp4', width: 498, height: 280 }), { url: URL_OK, kind: 'mp4', width: 498, height: 280 }));
  check('normalizeGifMedia: neznámý druh → gif, bez rozměrů null', eq(g.normalizeGifMedia({ url: URL_OK, kind: 'exe', width: null, height: 'x' }), { url: URL_OK, kind: 'gif', width: null, height: null }));
  check('normalizeGifMedia: špatná URL → null', g.normalizeGifMedia({ url: 'https://x.cz/a.gif', kind: 'gif' }) === null && g.normalizeGifMedia(null) === null);
  check('isGifVideo jen mp4', g.isGifVideo({ kind: 'mp4' }) && !g.isGifVideo({ kind: 'webp' }) && !g.isGifVideo(null));

  // --- velikost ---
  check('gifFitSize: menší než strop = 100 %', eq(g.gifFitSize(200, 100), { width: 200, height: 100 }));
  check('gifFitSize: široký → šířka 400', eq(g.gifFitSize(800, 400), { width: 400, height: 200 }));
  check('gifFitSize: vysoký → výška 250', eq(g.gifFitSize(300, 600), { width: 125, height: 250 }));
  check('gifFitSize: 498×280 → 400×225', eq(g.gifFitSize(498, 280), { width: 400, height: 225 }));
  check('gifFitSize: neznámé rozměry → null', g.gifFitSize(null, 200) === null && g.gifFitSize(0, 0) === null);

  // --- SSE ---
  const P = { requestId: 12, channel: 'RobDiesALot', platform: 'twitch', login: 'divak', userId: 42, messageId: 'abc', text: 'hele lol', media: { url: URL_OK, kind: 'mp4', width: 498, height: 280 }, createdAt: 1000, expiresAt: 301000 };
  const np = g.normalizeGifPending(P);
  check('normalizeGifPending: tvar', np && np.requestId === '12' && np.channel === 'robdiesalot' && np.userId === '42' && np.own === false && np.media.kind === 'mp4' && np.expiresAt === 301000, JSON.stringify(np));
  check('normalizeGifPending: own', g.normalizeGifPending({ ...P, own: true }).own === true);
  check('normalizeGifPending: bez média / expiresAt / id → null', g.normalizeGifPending({ ...P, media: { url: 'https://x/a.gif' } }) === null && g.normalizeGifPending({ ...P, expiresAt: undefined }) === null && g.normalizeGifPending({ ...P, requestId: 'x1' }) === null);
  const nd = g.normalizeGifDecided({ requestId: 12, channel: 'robdiesalot', approved: false, status: 'rejected', by: 'twitch:modik' });
  check('normalizeGifDecided: zamítnuto', nd && nd.requestId === '12' && nd.status === 'rejected' && !nd.approved && nd.by === 'twitch:modik');
  check('normalizeGifDecided: propadlo bez by', eq(g.normalizeGifDecided({ requestId: 3, channel: 'x', approved: false, status: 'expired', by: null }), { requestId: '3', channel: 'x', status: 'expired', approved: false, by: null, own: false }));
  const GM = { channel: 'robdiesalot', requestId: 12, message: { platform: 'twitch', id: 'gif-12', username: 'Divak', message: 'hele lol', timestamp: 5, gif: { url: URL_OK, kind: 'gif', width: 100, height: 50 } } };
  const gm = g.gifMessageFromEvent(GM, 'RobDiesALot');
  check('gifMessageFromEvent: zpráva s ověřeným gif', gm && gm.id === 'gif-12' && gm.gif.url === URL_OK && gm.message === 'hele lol');
  check('gifMessageFromEvent: jiný kanál → null', g.gifMessageFromEvent(GM, 'jiny') === null);
  check('gifMessageFromEvent: cizí médium → null', g.gifMessageFromEvent({ ...GM, message: { ...GM.message, gif: { url: 'https://evil/x.gif' } } }, 'robdiesalot') === null);

  // --- texty ---
  check('formatCountdown', g.formatCountdown(300000) === '5:00' && g.formatCountdown(64500) === '1:05' && g.formatCountdown(-5) === '0:00' && g.formatCountdown(1) === '0:01');
  check('gifDecisionText', g.gifDecisionText('approved', 'twitch:modik') === 'Schváleno · modik (Twitch)' && g.gifDecisionText('rejected', 'me') === 'Zamítnuto · tebou' && g.gifDecisionText('expired', null) === 'Propadlo — nikdo nerozhodl včas' && g.gifDecisionText('approved', null) === 'Schváleno');
  check('gifOwnStatusText', g.gifOwnStatusText('pending') === 'GIF čeká na schválení' && g.gifOwnStatusText('approved') === 'GIF byl schválen' && g.gifOwnStatusText('rejected') === 'GIF byl zamítnut' && g.gifOwnStatusText('expired') === 'O GIFu nikdo nerozhodl včas');
  check('gifDecideErrorText', g.gifDecideErrorText({ error: 'already_decided', status: 409 }) === 'O GIFu už rozhodl jiný mod.' && g.gifDecideErrorText({ error: 'not_mod', status: 403 }) === 'Rozhodovat můžou jen modi.' && g.gifDecideErrorText({ error: 'HTTP 401', status: 401 }) === 'Přihlášení vypršelo, přihlas se znovu.' && g.gifDecideErrorText({ error: 'boom', status: 500 }) === 'Rozhodnutí se nepodařilo odeslat, zkus to znovu.');

  // --- HTML varianta (OBS / raw) ---
  const hv = g.gifMediaHtml({ url: URL_OK, kind: 'mp4', width: 800, height: 400 });
  check('gifMediaHtml: video autoplay loop muted playsinline, 400×200', /<video[^>]+autoplay loop muted playsinline/.test(hv) && /width="400" height="200"/.test(hv), hv);
  const hi = g.gifMediaHtml({ url: URL_OK, kind: 'webp' });
  check('gifMediaHtml: img lazy, bez rozměrů nosize', /<img[^>]+loading="lazy"/.test(hi) && /uc-gif--nosize/.test(hi), hi);
  check('gifMediaHtml: cizí URL → prázdné', g.gifMediaHtml({ url: 'https://x/"><script>', kind: 'gif' }) === '');

  // --- /account/stream: další handlery (gif-pending / gif-decided) ---
  class FakeES {
    constructor(url) { this.url = url; this.l = {}; FakeES.last = this; }
    addEventListener(t, f) { (this.l[t] ||= []).push(f); }
    emit(t, data) { for (const f of this.l[t] || []) f({ data }); }
    close() { this.closed = true; }
  }
  const got = [];
  const s = aw.connectAccountStream({ baseUrl: 'https://api', EventSource: FakeES, getTicket: async () => 't1', onWarning: () => {}, onAck: () => {},
    handlers: { 'gif-pending': (d) => got.push(['p', d.requestId]), 'gif-decided': (d) => got.push(['d', d.status]) }, setTimeout: () => 1, clearTimeout: () => {} });
  await new Promise((r) => setTimeout(r, 10));
  FakeES.last.emit('gif-pending', JSON.stringify({ requestId: 5 }));
  FakeES.last.emit('gif-decided', JSON.stringify({ requestId: 5, status: 'approved' }));
  FakeES.last.emit('gif-pending', 'nejson');
  check('connectAccountStream handlers: gif-pending / gif-decided, rozbitý JSON ignorován', eq(got, [['p', 5], ['d', 'approved']]), JSON.stringify(got));
  s.close();

  console.log(fails ? `\n${fails} FAIL` : '\nvše PASS');
  process.exit(fails ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
