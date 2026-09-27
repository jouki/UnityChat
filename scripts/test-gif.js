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
  // gif_not_allowed (user 2026-09-27): zpráva, která dorazí až po message-deleted, se vykreslí rovnou schovaná.
  check('gifEarlyReason: gif_request i gif_not_allowed se pamatují', g.gifEarlyReason(null, 'gif_request') === 'gif_request' && g.gifEarlyReason('gif_request', 'gif_not_allowed') === 'gif_not_allowed');
  check('gifEarlyReason: ozvěna z platformy (bez důvodu) gif_not_allowed nechá', g.gifEarlyReason('gif_not_allowed', null) === 'gif_not_allowed' && g.gifEarlyReason(undefined, null) === null);
  check('gifEarlyReason: gif_rejected / mod / platform → nepamatovat', g.gifEarlyReason('gif_request', 'gif_rejected') === null && g.gifEarlyReason('gif_not_allowed', 'mod') === null && g.gifEarlyReason(null, 'platform') === null);
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
  check('normalizeGifState: posun hodin přes serverNow', eq(cd.normalizeGifState({ ok: true, allowed: true, cooldownUntil: 15_000, cooldownSec: 60, serverNow: 5_000 }, 100_000), { allowed: true, until: 110_000, sec: 60, mode: 'all', rewardUntil: null, rewardTotalMs: null, at: 100_000 }));
  check('normalizeGifState: režim approved + konec odměny (posun hodin)', (() => { const s = cd.normalizeGifState({ ok: true, allowed: true, cooldownUntil: null, cooldownSec: 60, serverNow: 5_000, mode: 'approved', rewardUntil: 65_000, rewardTotalMs: 600_000 }, 100_000); return s.mode === 'approved' && s.rewardUntil === 160_000 && s.rewardTotalMs === 600_000; })());
  check('normalizeGifState: `mod` ze starého serveru se ignoruje (mod bez výjimky); chyba → null', !('mod' in cd.normalizeGifState({ ok: true, allowed: true, cooldownUntil: null, cooldownSec: 0, serverNow: 1, mod: true }, 5)) && cd.normalizeGifState({ ok: false }, 1) === null);

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
  check('GifCooldown.serverOffset: lokální − serverový čas z /gif/state (audit F1)', G.serverOffset() === 1_000_000 - 50_000, String(G.serverOffset()));
  await G.refreshIfStale();
  check('GifCooldown.refreshIfStale: čerstvý stav → bez dotazu', calls.length === 1);
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
  // Mod bez výjimky (2026-09-27 §5): cooldown po odeslání jako divák (i kdyby starý server poslal `mod: true`); Dev mód → review=1 v dotazu.
  G.reset(); state = { ok: true, allowed: true, cooldownUntil: null, cooldownSec: 30, serverNow: 1, mod: true };
  G.onInput('https://giphy.com/gifs/x-1'); await G.fetchState(); G.onSent('https://giphy.com/gifs/x-1'); G.onInput('https://giphy.com/gifs/x-1');
  check('GifCooldown: mod → cooldown a bublina jako u diváka', G.visible && G.remainingMs() === 30_000 && G.checkSend('https://giphy.com/gifs/x-1') === false);
  const R = new cd.GifCooldown({ doc, host: new El('div'), api: async (p) => { calls.push(p); return state; }, channel: () => 'robdiesalot', platform: () => 'twitch', review: () => true, now: () => t, setInterval: () => 1, clearInterval: () => {} });
  await R.fetchState();
  check('GifCooldown: Dev mód moda → review=1', calls.at(-1) === '/gif/state?channel=robdiesalot&platform=twitch&review=1', calls.at(-1));
  const off = new cd.GifCooldown({ doc, host: new El('div'), api: async (p) => { calls.push(p); return state; }, channel: () => 'robdiesalot', platform: () => 'twitch', enabled: () => false, now: () => t, setInterval: () => 1, clearInterval: () => {} });
  const nBefore = calls.length; off.onInput('https://giphy.com/gifs/x-1');
  check('GifCooldown: nepřihlášený → žádný dotaz', calls.length === nBefore && off.checkSend('https://giphy.com/gifs/x-1') === true);
  // test2 bod 4.1: cooldown ze serveru (done approved u tichého schválení / gif-notice cooldown), i když cooldownSec = 0 (mod).
  {
    const OWN = `https://api.jouki.cz/media/gif/${'ab'.repeat(16)}`;
    let st2 = { ok: true, allowed: true, cooldownUntil: null, cooldownSec: 0, serverNow: t };
    const states = [];
    const S = new cd.GifCooldown({ doc, host: new El('div'), api: async () => st2, channel: () => 'robdiesalot', platform: () => 'twitch', now: () => t, onState: (x) => states.push(x), setInterval: () => 1, clearInterval: () => {} });
    await S.fetchState();
    S.onSent(OWN);
    check('GifCooldown: cooldownSec 0 (mod) → po odeslání cooldown neznámý (dřív tady neblokovalo nic)', S.remainingMs() === 0 && S.checkSend(OWN) === true);
    S.onServerCooldown(t + 45_000 - 1_000, t - 1_000);   // serverový čas o 1 s pozadu
    check('GifCooldown.onServerCooldown: konec cooldownu ze serveru (posun hodin přes serverNow)', S.remainingMs() === 45_000 && S.snapshot().until === t + 45_000 && states.length >= 2, String(S.remainingMs()));
    check('GifCooldown: další GIF (i z knihovny) → zablokováno „Můžeš až za:"', S.checkSend(OWN) === false && S.blocked);
    S.onServerCooldown(null, t);
    check('GifCooldown.onServerCooldown(null) → server cooldown nehlásí, lokální stav beze změny', S.remainingMs() === 45_000);
    const E = new cd.GifCooldown({ doc, host: new El('div'), api: async () => st2, channel: () => 'robdiesalot', platform: () => 'twitch', now: () => t, setInterval: () => 1, clearInterval: () => {} });
    E.onServerCooldown(t + 30_000, t);
    check('GifCooldown.onServerCooldown bez načteného stavu → cooldown platí (allowed, zbývá 30 s)', E.remainingMs() === 30_000 && E.snapshot()?.allowed === true && E.checkSend(OWN) === false);
  }
  // Bod 3 (test 2026-09-27): SSE gif-access-change (webhook Židolišty) → stav odměny znovu, i když je čerstvý,
  // rozprostřeně 0–2 s; víc událostí za sebou = jeden dotaz; cizí kanál / nepřihlášený nic.
  {
    let n = 0;
    const timers = [];
    let st3 = { ok: true, allowed: false, cooldownUntil: null, cooldownSec: 0, serverNow: t };
    const states = [];
    const mk = (o = {}) => new cd.GifCooldown({ doc, host: new El('div'), api: async () => { n++; return st3; }, channel: () => 'robdiesalot', platform: () => 'twitch', now: () => t, onState: (x) => states.push(x),
      setInterval: () => 1, clearInterval: () => {}, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {}, ...o });
    const A = mk();
    await A.fetchState();
    check('gif-access-change: výchozí stav zamčený', n === 1 && A.snapshot()?.allowed === false);
    st3 = { ...st3, allowed: true, rewardUntil: t + 300_000 };
    A.onAccessChange({ channel: 'jinykanal' });
    check('gif-access-change: cizí kanál → nic', timers.length === 0);
    A.onAccessChange({ channel: 'RobDiesALot' }, { delayMs: 1500 });
    A.onAccessChange({ channel: 'robdiesalot' });
    check('gif-access-change: víc událostí = jeden naplánovaný dotaz se zpožděním', timers.length === 1 && timers[0].ms === 1500 && n === 1, JSON.stringify(timers.map((x) => x.ms)));
    timers[0].fn();
    await new Promise((r) => setTimeout(r, 0));
    check('gif-access-change: dotaz i přes čerstvý stav → odemčeno, onState (pásek / tooltip hned)', n === 2 && A.snapshot()?.allowed === true && states.at(-1)?.allowed === true && Number.isFinite(states.at(-1)?.rewardUntil));
    A.onAccessChange({ channel: 'robdiesalot' });
    check('gif-access-change: výchozí zpoždění v rozsahu 0–2 s', timers.length === 2 && timers[1].ms >= 0 && timers[1].ms <= cd.GIF_ACCESS_REFETCH_SPREAD_MS && cd.GIF_ACCESS_REFETCH_SPREAD_MS === 2000);
    // Review 4: událost během běžícího dotazu → po jeho doběhnutí ještě jeden (starý výsledek nezůstane).
    {
      let release; let calls = 0;
      const timers2 = [];
      const C = mk({ api: async () => { calls++; if (calls === 1) await new Promise((r) => { release = r; }); return st3; },
        setTimeout: (fn) => { timers2.push(fn); return timers2.length; } });
      const first = C.fetchState();
      await new Promise((r) => setTimeout(r, 0));   // api se volá v mikroúloze
      C.onAccessChange({ channel: 'robdiesalot' }, { delayMs: 0 });
      timers2[0]();
      check('review 4: SSE během dotazu → nový dotaz se nespustí hned (sdílí rozběhnutý)', calls === 1);
      release(); await first; await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
      check('review 4: … po doběhnutí právě jeden dotaz navíc', calls === 2, String(calls));
    }
    const off2 = mk({ enabled: () => false });
    off2.onAccessChange({ channel: 'robdiesalot' });
    check('gif-access-change: nepřihlášený → nic', timers.length === 2);
  }

  // --- pojistka GifHoldWatch (zpráva schovaná jako gif_request bez rozhodnutí → GET /gif/held) ---
  {
    let now = 0; const timers = []; const api = []; const results = [];
    let reply = null;
    const W = new g.GifHoldWatch({
      api: async (p) => { api.push(p); if (reply instanceof Error) throw reply; return reply; },
      channel: () => 'RobDiesALot', onResult: (r) => results.push(r), delayMs: 30_000, maxChecks: 3,
      setTimeout: (fn, ms) => { timers.push({ fn, at: now + ms }); return timers.length; }, clearTimeout: () => {}, now: () => now,
    });
    const fire = async (ms) => {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      timers.splice(0, timers.length, ...timers.filter((t) => t.at > now));
      for (const t of due) t.fn();
      await new Promise((r) => setTimeout(r, 0));
    };
    W.hold('twitch', 'f6'); W.hold('twitch', 'f6'); W.hold('kick', 'k1');
    W.hold('twitch', 'gif-3'); W.hold('twitch', 'sent-1');
    check('GifHoldWatch: hold idempotentní, gif-/sent- se nehlídají', W.size === 2);
    await fire(29_000);
    check('GifHoldWatch: před 30 s žádný dotaz', api.length === 0);
    reply = { ok: true, messages: [{ platform: 'twitch', messageId: 'f6', state: 'visible', message: { id: 'f6', message: 'x' } }, { platform: 'kick', messageId: 'k1', state: 'held' }] };
    await fire(30_000);
    check('GifHoldWatch: po 30 s jeden dávkový dotaz s kanálem', api.length === 1 && api[0] === '/gif/held?channel=robdiesalot&ids=twitch%3Af6%2Ckick%3Ak1', api[0]);
    check('GifHoldWatch: visible → onResult, held → hlídat dál', results.length === 1 && results[0].state === 'visible' && !W.has('twitch', 'f6') && W.has('kick', 'k1'));
    reply = new Error('offline');
    await fire(30_000);
    check('GifHoldWatch: chyba serveru → zkusit znovu', api.length === 2 && W.has('kick', 'k1'));
    await fire(30_000);
    check('GifHoldWatch: po maxChecks vzdát (zůstane schovaná)', api.length === 3 && !W.has('kick', 'k1') && results.length === 1);
    W.hold('twitch', 'a'); W.release('twitch', 'a');
    await fire(60_000);
    check('GifHoldWatch: release → žádný dotaz', api.length === 3);
    W.hold('twitch', 'b'); W.clear();
    check('GifHoldWatch: clear', W.size === 0);
    // Nová zpráva s dřívějším termínem (kratší delayMs) přeplánuje běžící časovač.
    W.hold('twitch', 'late'); W.delayMs = 1000; W.hold('twitch', 'early');
    reply = { ok: true, messages: [] };
    const nApi = api.length;
    await fire(1000);
    check('GifHoldWatch: dřívější termín přeplánuje časovač', api.length === nApi + 1 && api.at(-1).includes('twitch%3Aearly') && !api.at(-1).includes('late'), api.at(-1));
  }

  // --- clearDeleted odstraní i uc-gif-held (obnovená zpráva nesmí zůstat neviditelná) ---
  {
    const mod = await import('../extension/core/moderation.js');
    const cls = new Set(['msg', 'uc-gif-held', 'uc-deleted']);
    const el = { hidden: true, classList: { remove: (...a) => a.forEach((c) => cls.delete(c)), add: (c) => cls.add(c), contains: (c) => cls.has(c) }, querySelector: () => null };
    mod.clearDeleted(el);
    check('clearDeleted: pryč uc-gif-held i uc-deleted, hidden false', !cls.has('uc-gif-held') && !cls.has('uc-deleted') && el.hidden === false);
  }

  // --- Trvale zahodit (2026-09-27): unavailable štítek, SSE gif-media ---
  check('normalizeGifMedia: unavailable jen true', g.normalizeGifMedia({ url: URL_OK, kind: 'gif', unavailable: true }).unavailable === true
    && g.normalizeGifMedia({ url: URL_OK, kind: 'gif', unavailable: 'ano' }).unavailable === undefined && !('unavailable' in g.normalizeGifMedia({ url: URL_OK })));
  check('GIF_UNAVAILABLE_TEXT', g.GIF_UNAVAILABLE_TEXT === '[GIF nedostupný]');
  // Kolo 4 bod 3: odkrytá zpráva s odebraným GIFem (server `removed`) → štítek „GIF odebrán“ stejnou funkcí jako čerstvý stav.
  check('normalizeGifMedia: removed jen true', g.normalizeGifMedia({ url: URL_OK, removed: true }).removed === true
    && !('removed' in g.normalizeGifMedia({ url: URL_OK, removed: 1 })) && !('removed' in g.normalizeGifMedia({ url: URL_OK })));
  {
    // Minimální DOM: createGifMedia s removed / unavailable nic nenačítá a vrací štítek (třída podle stavu).
    const mk = (tag) => { const cls = new Set(); const kids = []; return { tagName: tag.toUpperCase(), className: '', textContent: '', style: {}, kids,
      classList: { add: (...a) => a.forEach((c) => cls.add(c)), remove: (...a) => a.forEach((c) => cls.delete(c)), contains: (c) => cls.has(c), toggle: (c, on) => { if (on ?? !cls.has(c)) cls.add(c); else cls.delete(c); }, toString: () => [...cls].join(' ') },
      setAttribute() {}, addEventListener() {}, querySelector: () => null, replaceChildren(...n) { kids.splice(0, kids.length, ...n); }, appendChild(n) { kids.push(n); } }; };
    const doc = { createElement: mk, defaultView: {} };
    const r = g.createGifMedia(doc, { url: URL_OK, kind: 'gif', removed: true });
    const u = g.createGifMedia(doc, { url: URL_OK, kind: 'gif', unavailable: true });
    check('createGifMedia: removed → štítek „GIF odebrán“ (uc-gif--removed), bez média', r.kids.length === 1 && r.kids[0].className === 'uc-gif-fallback' && r.kids[0].textContent === 'GIF odebrán'
      && r.classList.contains('uc-gif--removed') && r.classList.contains('uc-gif--failed') && r.classList.contains('uc-gif--gone') && !r.classList.contains('uc-gif--unavailable'));
    check('createGifMedia: unavailable → „[GIF nedostupný]“ (uc-gif--unavailable)', u.kids[0]?.textContent === '[GIF nedostupný]' && u.classList.contains('uc-gif--unavailable') && !u.classList.contains('uc-gif--removed'));
  }
  const ev = g.normalizeGifMediaEvent({ channel: 'RobDiesALot', mediaId: ID, state: 'visible', messageIds: ['twitch:gif-1', 'twitch:gif-1', 'evil:x', 'kick:gif-2', null] }, 'robdiesalot');
  check('normalizeGifMediaEvent: visible s klíči zpráv (jen platné, bez duplicit)', ev?.state === 'visible' && ev.mediaId === ID && eq(ev.messageIds, ['twitch:gif-1', 'kick:gif-2']), JSON.stringify(ev));
  check('normalizeGifMediaEvent: strop 200 klíčů', g.normalizeGifMediaEvent({ channel: 'rob', mediaId: ID, state: 'visible', messageIds: Array.from({ length: 250 }, (_, i) => `twitch:gif-${i}`) }, 'rob').messageIds.length === 200);
  check('normalizeGifMediaEvent: removed / unavailable / library bez zpráv', eq(g.normalizeGifMediaEvent({ channel: 'rob', mediaId: ID, state: 'removed', messageIds: ['twitch:a'] }, 'rob')?.messageIds, [])
    && g.normalizeGifMediaEvent({ channel: 'rob', mediaId: ID, state: 'unavailable' }, 'rob')?.state === 'unavailable'
    && g.normalizeGifMediaEvent({ channel: 'rob', mediaId: ID, state: 'library' }, 'rob')?.state === 'library');
  check('gifMessagesPath: GET /chat/messages s kanálem a klíči; bez klíčů null', g.gifMessagesPath('RobDiesALot', ['twitch:gif-1', 'kick:gif-2']) === `/chat/messages?channel=robdiesalot&ids=${encodeURIComponent('twitch:gif-1,kick:gif-2')}`
    && g.gifMessagesPath('rob', []) === null && g.gifMessagesPath('rob', ['evil:x']) === null);
  check('normalizeGifMediaEvent: jiný kanál / neznámý stav / špatné id → null', g.normalizeGifMediaEvent({ channel: 'jiny', mediaId: ID, state: 'removed' }, 'rob') === null
    && g.normalizeGifMediaEvent({ channel: 'rob', mediaId: ID, state: 'purging' }, 'rob') === null && g.normalizeGifMediaEvent({ channel: 'rob', mediaId: 'abc', state: 'removed' }, 'rob') === null);
  check('gifMsgMediaId', g.gifMsgMediaId({ gif: { url: URL_OK } }) === ID && g.gifMsgMediaId({}) === null && g.gifMsgMediaId(null) === null);
  check('gifShortDate', /^\d+\. \d+\. \d+:\d\d$/.test(g.gifShortDate(Date.UTC(2026, 8, 27, 10, 5))) && g.gifShortDate(0) === '' && g.gifShortDate('x') === '');

  // --- Zamítnout + trest (spec 2026-09-27-gif-review-upravy §2) ---
  check('GIF_PENALTY_DEFAULT = 10 min', eq(g.GIF_PENALTY_DEFAULT, { value: 10, unit: 'm' }) && g.gifPenaltySec(10, 'm') === 600);
  check('gifPenaltySec: s / h, strop 14 dní, neplatné → null', g.gifPenaltySec(30, 's') === 30 && g.gifPenaltySec(2, 'h') === 7200
    && g.gifPenaltySec(336, 'h') === 1_209_600 && g.gifPenaltySec(337, 'h') === null && g.gifPenaltySec(0, 'm') === null && g.gifPenaltySec(5, 'd') === null && g.gifPenaltySec('x', 's') === null);
  check('gifBanConfirmTitle', g.gifBanConfirmTitle({ login: 'divak', platform: 'twitch' }) === 'Trvale zabanovat divak na Twitchi?'
    && g.gifBanConfirmTitle({ login: 'k', platform: 'kick' }) === 'Trvale zabanovat k na Kicku?' && g.gifBanConfirmTitle({ login: 'y', platform: 'youtube' }) === 'Trvale zabanovat y na YouTube?');
  const REQ = { platform: 'twitch', login: 'divak' };
  const okTo = g.gifPenaltyNotice({ kind: 'timeout', durationSec: 600 }, REQ, { results: { twitch: 'ok' } });
  check('gifPenaltyNotice: timeout ok', okTo.startsWith('Zamítnuto · Timeout 10 min pro divak'), okTo);
  check('gifPenaltyNotice: ban ok', g.gifPenaltyNotice({ kind: 'ban' }, REQ, { results: { twitch: 'ok' } }).startsWith('Zamítnuto · Ban pro divak'));
  check('gifPenaltyNotice: chyba moderace = zamítnutí platí', g.gifPenaltyNotice({ kind: 'timeout', durationSec: 60 }, REQ, null, { error: 'target_protected', status: 403 }) === 'Zamítnuto, ale timeout se nepovedl: Na streamera nebo moda to nejde.'
    && g.gifPenaltyNotice({ kind: 'ban' }, REQ, null, { status: 429 }).startsWith('Zamítnuto, ale ban se nepovedl: Moc akcí'));

  console.log(fails ? `\n${fails} FAIL` : '\nvše PASS');
  process.exit(fails ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
