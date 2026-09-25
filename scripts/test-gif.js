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

  check('gifFitSize: karta 400×160', eq(g.gifFitSize(498, 280, 400, 160), { width: 285, height: 160 }));
  check('isGifMessageId', g.isGifMessageId('gif-12') && !g.isGifMessageId('gif-') && !g.isGifMessageId('abc') && !g.isGifMessageId(null) && !g.isGifMessageId('xgif-1'));
  check('gifMoreText 3 tvary', g.gifMoreText(1) === '+1 další GIF' && g.gifMoreText(3) === '+3 další GIFy' && g.gifMoreText(5) === '+5 dalších GIFů' && g.gifMoreText(12) === '+12 dalších GIFů');
  check('normalizeGifMedia: origins', g.normalizeGifMedia({ url: URL_OK }, { origins: ['https://api.jouki.cz'] }) !== null && g.normalizeGifMedia({ url: `https://evil.cz/media/gif/${ID}` }, { origins: ['https://api.jouki.cz'] }) === null);

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

  // --- UX 2026-09-25: schovaná původní zpráva (gif_request) + nahrazení GIFem ---
  check('isGifHeldReason jen gif_request', g.isGifHeldReason('gif_request') && !g.isGifHeldReason('gif_rejected') && !g.isGifHeldReason('mod') && !g.isGifHeldReason(null));
  check('gifHeldAfter: schovaná + ozvěna z platformy → dál schovaná', g.gifHeldAfter('gif_request', 'platform') === 'gif_request' && g.gifHeldAfter('gif_request', null) === 'gif_request');
  check('gifHeldAfter: schovaná + gif_rejected / mod → běžně smazaná', g.gifHeldAfter('gif_request', 'gif_rejected') === 'gif_rejected' && g.gifHeldAfter('gif_request', 'mod') === 'mod');
  check('gifHeldAfter: nová zpráva', g.gifHeldAfter(undefined, 'gif_request') === 'gif_request' && g.gifHeldAfter(null, 'platform') === 'platform' && g.gifHeldAfter('mod', 'gif_request') === 'gif_request');
  check('gifReplacedTarget', eq(g.gifReplacedTarget({ replaces: 'twitch:abc-1' }), { platform: 'twitch', id: 'abc-1' }) && g.gifReplacedTarget({ replaces: 'evil:x' }) === null && g.gifReplacedTarget({}) === null);

  // --- detektor GIF odkazů (kopie backendu, shodu hlídá backend gifMedia.test.ts) ---
  const gl = await import('../extension/core/gif-links.js');
  check('hasGifLink: Tenor / Giphy / přímý soubor', gl.hasGifLink('hele https://tenor.com/view/cat-gif-1') && gl.hasGifLink('giphy.com/gifs/x-1') && gl.hasGifLink('neco.cz/a.gif'));
  check('hasGifLink: běžný odkaz / text ne', !gl.hasGifLink('seznam.cz') && !gl.hasGifLink('ahoj') && !gl.hasGifLink('') && !gl.hasGifLink(null));

  // --- bublina cooldownu (core/gif-cooldown.js) ---
  const cd = await import('../extension/core/gif-cooldown.js');
  check('gifCooldownText', cd.gifCooldownText(true) === 'Můžeš až za:' && cd.gifCooldownText(false) === 'GIF můžeš poslat za');
  check('gifCooldownRing: 30 s z 60 → 180°, číslo 30', eq(cd.gifCooldownRing(30_000, 60_000), { deg: 180, sec: 30 }));
  check('gifCooldownRing: 0,2 s → číslo 1, 60 s bez celkové délky → 0°', cd.gifCooldownRing(200, 60_000).sec === 1 && cd.gifCooldownRing(60_000, 0).deg === 0);
  check('normalizeGifState: posun hodin přes serverNow', eq(cd.normalizeGifState({ ok: true, allowed: true, cooldownUntil: 15_000, cooldownSec: 60, serverNow: 5_000 }, 100_000), { allowed: true, until: 110_000, sec: 60, mod: false, at: 100_000 }));
  check('normalizeGifState: mod, bez cooldownu; chyba → null', cd.normalizeGifState({ ok: true, allowed: true, cooldownUntil: null, cooldownSec: 0, serverNow: 1, mod: true }, 5).mod === true && cd.normalizeGifState({ ok: false }, 1) === null);

  // Minimální DOM pro GifCooldown.
  class El {
    constructor(tag) { this.tagName = tag; this.children = []; this.parent = null; this.attrs = {}; this.hidden = false; this.textContent = ''; this._cls = new Set(); this.style = { props: {}, setProperty: (k, v) => { this.style.props[k] = v; } }; }
    set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get className() { return [...this._cls].join(' '); }
    get classList() { const c = this._cls; return { add: (x) => c.add(x), remove: (x) => c.delete(x), contains: (x) => c.has(x), toggle: (x, on) => { const v = on === undefined ? !c.has(x) : !!on; if (v) c.add(x); else c.delete(x); return v; } }; }
    get isConnected() { let e = this; while (e.parent) e = e.parent; return e.root === true; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    appendChild(c) { c.parent = this; this.children.push(c); return c; }
    append(...cs) { for (const c of cs) this.appendChild(c); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; }
    _all() { return this.children.flatMap((c) => [c, ...c._all()]); }
    _match(sel) { return sel.startsWith('.') ? this._cls.has(sel.slice(1)) : this.tagName === sel; }
    querySelector(sel) {
      const parts = sel.trim().split(/\s+/);
      const find = (root, i) => { for (const e of root._all()) if (e._match(parts[i])) { if (i === parts.length - 1) return e; const r = find(e, i + 1); if (r) return r; } return null; };
      return find(this, 0);
    }
  }
  const doc = { createElement: (t) => new El(t), defaultView: null };
  const host = new El('div'); host.root = true;
  const input = new El('textarea');
  let t = 1_000_000;
  const calls = [];
  let state = { ok: true, allowed: true, cooldownUntil: 50_000 + 10_000, cooldownSec: 60, serverNow: 50_000 };
  let tick = null;
  const G = new cd.GifCooldown({ doc, host, input, api: async (p) => { calls.push(p); return state; }, channel: () => 'RobDiesALot', platform: () => 'kick', review: () => false,
    now: () => t, setInterval: (fn) => { tick = fn; return 1; }, clearInterval: () => { tick = null; } });
  G.onInput('ahoj');
  check('GifCooldown: text bez GIF odkazu → žádný dotaz, žádná bublina', calls.length === 0 && !G.visible);
  G.onInput('hele https://tenor.com/view/cat-gif-1');
  await G.fetchState();
  check('GifCooldown: GIF odkaz → GET /gif/state (kanál, platforma)', calls[0] === '/gif/state?channel=robdiesalot&platform=kick', calls.join(' | '));
  const bubble = host.querySelector('.uc-gif-cd');
  check('GifCooldown: bublina s kolečkem a číslem sekund', G.visible && bubble.querySelector('.uc-gif-cd-text').textContent === 'GIF můžeš poslat za' && bubble.querySelector('.uc-gif-cd-ring em').textContent === '10' && bubble.querySelector('.uc-qd-ring') !== null);
  t += 4_000; tick?.();
  check('GifCooldown: odpočet (číslo klesá, kolečko ukazuje uplynulou část celého cooldownu)', bubble.querySelector('.uc-gif-cd-ring em').textContent === '6' && bubble.querySelector('.uc-gif-cd-ring i').style.props['--deg'] === '324deg', JSON.stringify(bubble.querySelector('.uc-gif-cd-ring i').style.props));
  check('GifCooldown: odeslání bez GIF odkazu projde', G.checkSend('ahoj') === true);
  check('GifCooldown: odeslání GIFu během cooldownu → blokováno, červeně „Můžeš až za:", okraj pole', G.checkSend('hele https://tenor.com/view/cat-gif-1') === false && G.blocked && bubble.classList.contains('uc-gif-cd--blocked')
    && bubble.querySelector('.uc-gif-cd-text').textContent === 'Můžeš až za:' && input.classList.contains('uc-gif-input-blocked'));
  G.onInput('hele');
  check('GifCooldown: odkaz pryč → bublina i červená pryč', !G.visible && !input.classList.contains('uc-gif-input-blocked'));
  G.onInput('https://giphy.com/gifs/x-1');
  check('GifCooldown: stav z cache do konce cooldownu (bez nového dotazu)', calls.length === 1 && G.visible && !G.blocked);
  t += 6_100; tick?.();
  check('GifCooldown: cooldown doběhl → bublina zmizí, odeslání projde', !G.visible && G.checkSend('https://giphy.com/gifs/x-1') === true);
  // Stav bez cooldownu (60 s cache) → po odeslání GIFu lokální cooldown z cooldownSec.
  G.reset(); state = { ok: true, allowed: true, cooldownUntil: null, cooldownSec: 60, serverNow: 1 };
  G.onInput('https://giphy.com/gifs/x-1'); await G.fetchState();
  check('GifCooldown: bez cooldownu → bez bubliny', !G.visible && calls.length === 2);
  G.onSent('https://giphy.com/gifs/x-1');
  G.onInput('https://giphy.com/gifs/x-2');
  check('GifCooldown: po odeslání GIFu lokální cooldown 60 s', G.visible && bubble.querySelector('.uc-gif-cd-ring em').textContent === '60' && calls.length === 2);
  G.onDecided({ requestId: 1, channel: 'robdiesalot', status: 'rejected', own: true });
  check('GifCooldown: vlastní GIF zamítnut → cooldown pryč', !G.visible && G.remainingMs() === 0);
  // Mod (bez Dev módu) cooldown nemá ani po odeslání; Dev mód → review=1 v dotazu.
  G.reset(); state = { ok: true, allowed: true, cooldownUntil: null, cooldownSec: 0, serverNow: 1, mod: true };
  G.onInput('https://giphy.com/gifs/x-1'); await G.fetchState(); G.onSent('https://giphy.com/gifs/x-1'); G.onInput('https://giphy.com/gifs/x-1');
  check('GifCooldown: mod → bez bubliny', !G.visible && G.checkSend('https://giphy.com/gifs/x-1') === true);
  const R = new cd.GifCooldown({ doc, host: new El('div'), api: async (p) => { calls.push(p); return state; }, channel: () => 'robdiesalot', platform: () => 'twitch', review: () => true, now: () => t, setInterval: () => 1, clearInterval: () => {} });
  await R.fetchState();
  check('GifCooldown: Dev mód moda → review=1', calls.at(-1) === '/gif/state?channel=robdiesalot&platform=twitch&review=1', calls.at(-1));
  const off = new cd.GifCooldown({ doc, host: new El('div'), api: async (p) => { calls.push(p); return state; }, channel: () => 'robdiesalot', platform: () => 'twitch', enabled: () => false, now: () => t, setInterval: () => 1, clearInterval: () => {} });
  const nBefore = calls.length; off.onInput('https://giphy.com/gifs/x-1');
  check('GifCooldown: nepřihlášený → žádný dotaz', calls.length === nBefore && off.checkSend('https://giphy.com/gifs/x-1') === true);

  console.log(fails ? `\n${fails} FAIL` : '\nvše PASS');
  process.exit(fails ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
