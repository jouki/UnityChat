// E2E (headless Chrome + CDP): odměna „Posílání GIFů" (moderace část 4) v addonu.
//  A (mod): GIF z historie (img 400×225, lazy), chyba média → odkaz, GET /moderation/gif/pending → karta,
//     gif-pending z /account/stream (karta s náhledem, textem, odpočtem), Schválit (POST decide) → „Schváleno · tebou"
//     → karta zmizí, SSE gif-message → zpráva s GIFem (dedup), MP4 = <video autoplay loop muted playsinline>,
//     Zamítnout, 409 already_decided, rozhodnutí jiného moda (gif-decided), propadnutí, cizí kanál, smazání GIFu modem.
//     Náhled v kartě 400×160 bez deformace, nejvýš 3 karty + „+N dalších“, karty pod panely (emoty, „↓ Nové zprávy“),
//     médium jen z api.jouki.cz (origins), odpověď na GIF = napříč platformami (ucReplyTo), GIF bez 📌,
//     video: play/pause podle viditelnosti i po vrácení zaparkovaného uzlu.
//  C (core ve stránce): ztráta role → cizí karty pryč, decide po clear() nic nevykreslí.
//  B (divák = odesílatel): „GIF čeká na schválení" bez tlačítek, schváleno / zamítnuto / propadlo.
//  UX 2026-09-25 (brief gif-ux):
//  A2 (mod): původní zpráva gif_request se nevykreslí (historie i živě, ozvěna z platformy ji neodkryje), schválený GIF
//     s `replaces` ji nahradí na jejím místě (historie i živě), gif_rejected = běžně smazaná; mod posílá GIF bez
//     bubliny cooldownu a bez gifReview. Selhání převodu (2026-09-26): schovaná gif_request → message-restored → vidět;
//     pojistka: bez rozhodnutí → GET /gif/held → visible → vidět.
//  D (divák): GIF odkaz v poli + cooldown → bublina s kolečkem a sekundami (GET /gif/state), odpočet, odeslání
//     GIFu během cooldownu zablokované (červený okraj, „Můžeš až za:"), bez GIF odkazu se posílá, po doběhnutí zmizí.
//  E (mod + Dev mód): GET /gif/state s review=1, POST /chat/send s gifReview: true.
//  GIF knihovna 2026-09-26 (Task 3):
//  A (mod): FIFO — jediná karta (nejstarší) + „+N čeká“ ze gif-queue, zámek 1 s po změně od jiného moda / nové kartě,
//     0,3 s po vlastním kliku, dvojklik = jeden POST, 409 → „Už rozhodl X“ a další karta, propadnutí → hláška,
//     dříve zamítnutý GIF (kdy, kým) + „Automaticky zahazovat 12 h“ (ban12h), gif-queue s neznámým headId → GET pending.
//  C: zámky GifRequests s falešnými hodinami.
//  B (divák = odesílatel): bez karty; štítek u zprávy — kolečko % (gif-progress, unlock 50→95 a zaseknutí), peach
//     „Schvalování moderátorem ( )“ + ⚠ (dříve zamítnutý), zpráva zůstává vidět i po gif_request / gif_rejected,
//     červený „Zamítnuto moderátorem“ / „Vypršelo“ natrvalo; schváleno → GIF na konci chatu (čas schválení),
//     approved_only → hláška; optimistická zpráva s kolečkem spárovaná přes id z /chat/send.
//  G (divák): záložky Emoty | GIFy, knihovna podle použití, hledání v tazích, bez odměny zamčeno + hláška, výběr →
//     POST /chat/send s odkazem api.jouki.cz/media/gif/<id>, cooldown v hlavičce, indikátor (pásek pod tlačítkem
//     emotů i na záložce, odpočet v záložce). G2 (mod): taby GIFy | Zamítnuté GIFy, „Možné duplikáty (N)“ (409 →
//     skrýt + obnovit), Odebrat z knihovny (unapprove), Trvale zahodit s potvrzením, zamítnuté: Schválit / Vault /
//     Trvale zahodit, náhledy s tokenem (404 → nový token), token jen v chrome.storage.session.
//
// Backend mockovaný přes Fetch.requestPaused (api.jouki.cz), vzor scripts/e2e-mod-menu.mjs.
// Spuštění: node scripts/e2e-gif.mjs   (Chrome v C:/Program Files/Google/Chrome/…, nebo CHROME=…)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '../extension').replace(/\\/g, '/');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

const port = await freePort();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-e2e-gif-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--enable-unsafe-extension-debugging', '--window-size=500,900', 'about:blank'], { stdio: 'ignore' });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const finish = (code) => { try { chrome.kill(); } catch {} setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} process.exit(code); }, 500); };

let ver = null;
for (let i = 0; i < 40 && !ver; i++) { await sleep(250); ver = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => null); }
if (!ver) { console.log('Chrome se nespustil'); finish(2); }

let seq = 0; const pend = new Map();
const s = await new Promise((res) => { const w = new WebSocket(ver.webSocketDebuggerUrl); w.onopen = () => res(w); w.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } else w.onevent?.(d); }; });
const call = (method, params = {}, sessionId) => new Promise((res) => { const i = ++seq; pend.set(i, res); s.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });

const lr = await call('Extensions.loadUnpacked', { path: EXT });
const extId = lr.result?.id;
if (!extId) { console.log('loadUnpacked FAIL', JSON.stringify(lr)); finish(2); }
const { result: { targetId } } = await call('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await call('Target.attachToTarget', { targetId, flatten: true });

// ---- mock backendu ----
const API = 'https://api.jouki.cz';
const hex = (n) => n.toString(16).padStart(32, '0');
const MEDIA = { ok: hex(1), bad: hex(2), vid: hex(3), card: hex(4) };
const murl = (id) => `${API}/media/gif/${id}`;
const GIF_1PX = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const now = Date.now();
const H = (id, user, userId, text, i, extra = {}) => ({ platform: 'twitch', id, username: user, userId, message: text, color: '#1e90ff', timestamp: now - 60000 + i * 1000, historical: true, ...extra });
const H1 = [
  H('e2e-a1', 'Tester', 'u1', 'první zpráva testera', 1),
  H('gif-5', 'Divak', 'u9', 'z historie', 2, { gif: { url: murl(MEDIA.ok), kind: 'gif', width: 498, height: 280 } }),
  H('gif-6', 'Divak', 'u9', '', 3, { gif: { url: murl(MEDIA.bad), kind: 'webp', width: 100, height: 100 } }),
  // UX: původní zpráva čekala na schválení (gif_request) → v historii ji nahradí gif-8 se stejným časem.
  H('e2e-held', 'Divak', 'u9', '', 4, { deleted: true, deletedReason: 'gif_request' }),
  H('gif-8', 'Divak', 'u9', 'nahradil', 4, { gif: { url: murl(MEDIA.ok), kind: 'gif', width: 50, height: 50 }, replaces: 'twitch:e2e-held' }),
  H('e2e-rej', 'Divak', 'u9', '', 5, { deleted: true, deletedReason: 'gif_rejected' }),
  H('e2e-wait', 'Divak', 'u9', '', 6, { deleted: true, deletedReason: 'gif_request' }),
  H('e2e-a2', 'Tester', 'u1', 'po GIFech', 7),
];
const mock = { mod: true, sse: [], acc: [], heldAcc: null, decide: {}, held: {}, sendId: null,   // decide[id] = { code, body }; held[id] = odpověď /gif/held
  library: [], libHold: false, libHeld: [], dups: [], dupAct: null, rejected: [], rejMedia: new Set(), badTokens: new Set() };
const posts = { decide: [], pending: [], tickets: 0, auth: [], send: [], state: [], held: [], token: 0, rejected: [], dupAct: [], dups: [], media: [], library: [], mediaTok: [] };
mock.gifState = { ok: true, allowed: true, cooldownUntil: null, cooldownSec: 0, serverNow: 1, mod: true };
const sseBody = (events) => 'retry: 300\n\n' + events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join('');
const fulfill = (rid, sid, code, type, body) => call('Fetch.fulfillRequest', { requestId: rid, responseCode: code, responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: Buffer.from(body).toString('base64') }, sid);
const pushAcc = (...evs) => {
  mock.acc.push(...evs);
  if (mock.heldAcc) { const h = mock.heldAcc; mock.heldAcc = null; fulfill(h.rid, h.sid, 200, 'text/event-stream', sseBody(mock.acc.splice(0))); }
};
const pend0 = (id, extra = {}) => ({ requestId: id, channel: 'robdiesalot', platform: 'twitch', login: `divak${id}`, userId: `u${id}`, messageId: `m${id}`, text: `hele ${id}`, media: { url: murl(MEDIA.card), kind: 'gif', width: 498, height: 280 }, createdAt: Date.now(), expiresAt: Date.now() + 300000, ...extra });
s.onevent = async (d) => {
  if (d.method !== 'Fetch.requestPaused') return;
  const q = d.params.request;
  const rid = d.params.requestId;
  const sid = d.sessionId;
  const json = (o, code = 200) => fulfill(rid, sid, code, 'application/json', JSON.stringify(o));
  const u = q.url;
  const body = q.postData ? JSON.parse(q.postData) : null;
  if (u.includes('/media/gif/')) {
    const [id, qs] = u.split('/media/gif/')[1].split('?');
    const tok = qs ? new URLSearchParams(qs).get('t') : null;
    if (tok) posts.mediaTok.push(tok);
    if (id === MEDIA.vid) return;   // video: podržet (jen kontrola prvku, ne dekódování)
    if (id === MEDIA.bad) return json({ ok: false, error: 'not_found' }, 404);
    // Zamítnuté médium: jen s platným tokenem (první vydaný „vypadl“ → 404 → klient si vyžádá nový).
    if (mock.rejMedia.has(id) && (!tok || mock.badTokens.has(tok))) return json({ ok: false, error: 'not_found' }, 404);
    return call('Fetch.fulfillRequest', { requestId: rid, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/gif' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: GIF_1PX.toString('base64') }, sid);
  }
  if (u.includes('/nicknames/stream')) return fulfill(rid, sid, 200, 'text/event-stream', sseBody(mock.sse.splice(0)));
  if (u.includes('/account/stream-ticket')) { posts.tickets++; return json({ ok: true, ticket: `tk${posts.tickets}`, expiresInMs: 60000 }); }
  if (u.includes('/account/stream')) {
    if (mock.acc.length) return fulfill(rid, sid, 200, 'text/event-stream', sseBody(mock.acc.splice(0)));
    mock.heldAcc = { rid, sid };
    return;
  }
  if (u.includes('/account/warnings')) return json({ ok: true, warnings: [] });
  if (u.includes('/auth/me')) return json({ ok: true, accountId: 7, platforms: { twitch: { login: 'moduser', displayName: 'ModUser' }, kick: null, youtube: null }, warnings: [] });
  if (u.includes('/moderation/me')) return json(mock.mod ? { ok: true, mod: true, platforms: ['twitch'], missingScopes: {} } : { ok: true, mod: false, platforms: [], missingScopes: {} });
  // Obsah smazaných zpráv pro moda (smazaný GIF server neposílá) — nesmí odejít na produkci.
  if (u.includes('/moderation/deleted-content')) return json({ ok: true, messages: {} });
  if (u.includes('/moderation/gif/pending')) {
    posts.pending.push(u);
    if (!mock.mod) return json({ ok: false, error: 'not_mod' }, 403);
    return json({ ok: true, requests: [pend0(20, { text: 'z GET pending' })] });
  }
  // GIF knihovna
  if (u.includes('/moderation/gif/access-token')) { posts.token++; return json({ ok: true, token: `tk-${posts.token}` }); }
  if (u.includes('/moderation/gif/rejected')) { posts.rejected.push(u); return json({ ok: true, items: mock.rejected, nextBefore: null }); }
  const da = u.match(/\/moderation\/gif\/duplicates\/(\d+)\/(keep-first|keep-second|keep-both)/);
  if (da) { posts.dupAct.push({ id: da[1], action: da[2] }); const r = mock.dupAct; if (r) return json(r.body, r.code); mock.dups = mock.dups.filter((d) => String(d.id) !== da[1]); return json({ ok: true, id: Number(da[1]), action: da[2] }); }
  if (u.includes('/moderation/gif/duplicates')) { posts.dups.push(u); return json({ ok: true, items: mock.dups }); }
  const ma = u.match(/\/moderation\/gif\/([0-9a-f]{32})\/(approve|vault|purge|ban12h|unapprove)/);
  if (ma) { posts.media.push({ id: ma[1], action: ma[2] }); return json(ma[2] === 'ban12h' ? { ok: true, mediaId: ma[1], bannedUntil: Date.now() + 43200000, rejected: 1 } : { ok: true, mediaId: ma[1], action: ma[2] }); }
  if (u.includes('/gifs/library')) {
    posts.library.push(u);
    const q = new URL(u).searchParams.get('q') || '';
    const send = () => json({ ok: true, items: mock.library.filter((x) => !q || x.tags.some((t) => t.includes(q))), nextCursor: null });
    if (mock.libHold) { mock.libHeld.push({ q, send }); return; }   // souběh: odpovědi pustí test v libovolném pořadí
    return send();
  }
  const dm = u.match(/\/moderation\/gif\/(\d+)\/decide/);
  if (dm) {
    posts.decide.push({ id: dm[1], body, auth: q.headers?.Authorization || q.headers?.authorization || null });
    const r = mock.decide[dm[1]];
    // Produkční pořadí: backend rozešle SSE (gif-decided + gif-queue) DŘÍV, než odpoví na HTTP → odpověď podržet.
    if (r?.hold) { r.release = () => json({ ok: true, requestId: Number(dm[1]), status: body.approve ? 'approved' : 'rejected' }); return; }
    if (r) return json(r.body, r.code);
    return json({ ok: true, requestId: Number(dm[1]), status: body.approve ? 'approved' : 'rejected' });
  }
  if (u.includes('/chat/send')) { posts.send.push(body); return json({ ok: true, id: mock.sendId || 'x' }); }
  if (u.includes('/gif/state')) { posts.state.push(u); return json(typeof mock.gifState === 'function' ? mock.gifState() : mock.gifState); }
  if (u.includes('/gif/held')) {
    posts.held.push(u);
    const ids = decodeURIComponent(new URL(u).searchParams.get('ids') || '').split(',').filter(Boolean);
    return json({ ok: true, messages: ids.map((k) => { const [platform, messageId] = k.split(':'); return mock.held[messageId] ? { platform, messageId, ...mock.held[messageId] } : { platform, messageId, state: 'held' }; }) });
  }
  if (u.includes('/chat/history')) return json({ ok: true, messages: u.includes('before=') ? [] : H1, nextBefore: null });
  return call('Fetch.continueRequest', { requestId: rid }, sid);
};
await call('Fetch.enable', { patterns: ['/auth/me', '/moderation/', '/chat/history', '/chat/send', '/nicknames/stream', '/account/', '/media/gif/', '/gif/state', '/gif/held', '/gifs/'].map((p) => ({ urlPattern: `*api.jouki.cz${p}*` })) }, sessionId);
await call('Runtime.enable', {}, sessionId);
const ev = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId); if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 300) }; return r.result?.result?.value; };
const until = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr) === true) return true; await sleep(150); } return false; };
const card = (id) => ev(`(() => { const c = document.querySelector('.uc-gif-card[data-request-id="${id}"]'); if (!c) return null;
  const vis = (e) => !!e && !e.hidden && getComputedStyle(e).display !== 'none';
  return { cls: [...c.classList].filter(x => x.startsWith('uc-gif-card--')).sort().join(' '), who: c.querySelector('.uc-gif-card-who').textContent,
    kind: c.querySelector('.uc-gif-card-kind').textContent, text: c.querySelector('.uc-gif-card-text').textContent,
    status: vis(c.querySelector('.uc-gif-card-status')) ? c.querySelector('.uc-gif-card-status').textContent : '',
    err: vis(c.querySelector('.uc-gif-card-err')) ? c.querySelector('.uc-gif-card-err').textContent : '',
    buttons: vis(c.querySelector('.uc-gif-card-actions')) ? [...c.querySelectorAll('.uc-gif-card-actions button')].filter(vis).map(b => b.textContent) : [],
    disabled: [...c.querySelectorAll('.uc-gif-card-actions button')].filter(vis).every(b => b.disabled),
    prev: vis(c.querySelector('.uc-gif-card-prev')) ? c.querySelector('.uc-gif-card-prev').textContent : '',
    timer: vis(c.querySelector('.uc-gif-timer')) ? c.querySelector('.uc-gif-timer').textContent : null,
    media: !!c.querySelector('.uc-gif-card-media .uc-gif-media'), inWrapper: !!c.closest('#chat-wrapper > .uc-gif-stack') }; })()`);
// FIFO fronta: které karty jsou vidět, „+N čeká“, hláška, zámek.
const stack = () => ev(`(() => { const s = document.querySelector('.uc-gif-stack'); const vis = (e) => !!e && !e.hidden && getComputedStyle(e).display !== 'none';
  return { cards: s ? [...s.querySelectorAll('.uc-gif-card')].map(c => c.dataset.requestId).join(',') : null, more: s && vis(s.querySelector('.uc-gif-more')) ? s.querySelector('.uc-gif-more').textContent : null,
    notice: s && vis(s.querySelector('.uc-gif-notice')) ? s.querySelector('.uc-gif-notice').textContent : null, lockMs: window.ucGif.gifs().lockMs, head: window.ucGif.gifs().headId }; })()`);
const click = (id, act) => ev(`document.querySelector('.uc-gif-card[data-request-id="${id}"] [data-act="${act}"]').click()`);

const boot = async () => {
  mock.heldAcc = null; mock.acc = [];
  await call('Page.navigate', { url: `chrome-extension://${extId}/sidepanel.html` }, sessionId);
  await until(`!!document.querySelector('.msg[data-msg-id="e2e-a1"]')`, 10000);
};

await call('Page.navigate', { url: `chrome-extension://${extId}/sidepanel.html` }, sessionId);
await sleep(1500);
await ev(`chrome.storage.local.set({ uc_session: 'tok' })`);

// ---- fáze A: mod ----
await boot();
check('A body.uc-can-moderate', await until(`document.body.classList.contains('uc-can-moderate')`));

// GIF z historie
check('A GIF z historie se vykreslil (img)', await until(`!!document.querySelector('.msg[data-msg-id="gif-5"] .uc-gif img.uc-gif-media')`, 5000));
const h5 = await ev(`(() => { const i = document.querySelector('.msg[data-msg-id="gif-5"] .uc-gif-media'); const r = i.getBoundingClientRect();
  return { src: i.getAttribute('src'), w: i.getAttribute('width'), h: i.getAttribute('height'), loading: i.loading, rw: Math.round(r.width), rh: Math.round(r.height),
    text: document.querySelector('.msg[data-msg-id="gif-5"] .tx').textContent, after: i.closest('.uc-gif').previousElementSibling?.className }; })()`);
check('A historie: 498×280 → 400×225, lazy, z našeho serveru, pod textem', h5?.w === '400' && h5.h === '225' && h5.loading === 'lazy' && h5.src === murl(MEDIA.ok) && h5.rw <= 400 && h5.rh <= 250 && h5.text === 'z historie' && h5.after === 'tx', JSON.stringify(h5));
check('A historie: obrázek se načetl', await until(`document.querySelector('.msg[data-msg-id="gif-5"] .uc-gif-media')?.complete && document.querySelector('.msg[data-msg-id="gif-5"] .uc-gif-media').naturalWidth > 0`, 5000));
check('A GIF s prázdným textem se nezahodí + chyba média → odkaz', await until(`document.querySelector('.msg[data-msg-id="gif-6"] .uc-gif-fallback')?.textContent === 'GIF se nepodařilo načíst — otevřít'`, 5000)
  && await ev(`document.querySelector('.msg[data-msg-id="gif-6"] .uc-gif-fallback').href`) === murl(MEDIA.bad));

// GET pending (mod) → karta 20 (FIFO: jen nejstarší čekající)
check('A GET /moderation/gif/pending s kanálem', await until(`true`, 10) && posts.pending.some((x) => /pending\?channel=robdiesalot$/.test(x)), posts.pending.join(' | '));
check('A karta z GET pending', await until(`!!document.querySelector('.uc-gif-card[data-request-id="20"]')`, 5000));
const c20a = await card(20);
check('A nová karta: tlačítka 1 s zamčená (aktualizace fronty)', c20a?.disabled === true && c20a.cls.includes('uc-gif-card--locked'), JSON.stringify(c20a));
check('A … po 1 s odemčená', await until(`(() => { const c = document.querySelector('.uc-gif-card[data-request-id="20"]'); return !!c && [...c.querySelectorAll('.uc-gif-btn--approve, .uc-gif-btn--reject')].every(b => !b.disabled); })()`, 2000));
const c20 = await card(20);
check('A karta: jméno, text, náhled, odpočet, tlačítka, u spodku chatu', c20?.who === 'divak20' && c20.text === 'z GET pending' && c20.media && /^[45]:\d\d$/.test(c20.timer || '') && JSON.stringify(c20.buttons) === '["Zamítnout","Schválit"]' && c20.inWrapper && c20.kind === 'Chce poslat GIF' && !c20.prev, JSON.stringify(c20));

// gif-pending přes /account/stream (jedna dávka — klient se po konci spojení připojuje znovu za 5 s)
pushAcc(
  ['gif-pending', pend0(21)],
  ['gif-pending', pend0(22)],
  ['gif-pending', pend0(23)],
  ['gif-pending', pend0(24, { expiresAt: Date.now() + 20000 })],
  ['gif-pending', pend0(25, { channel: 'jinykanal' })],
  ['gif-pending', pend0(29, { media: { url: `https://evil.example/media/gif/${MEDIA.card}`, kind: 'gif' } })],
  ['gif-pending', pend0(20, { text: 'z GET pending' })],   // znovu po připojení streamu → bez duplicity
  ['gif-queue', { channel: 'robdiesalot', pendingCount: 5, headId: 20 }],
);
check('A gif-pending ze streamu → žádosti 21–24 v datech', await until(`[21,22,23,24].every(i => window.ucGif.gifs().has(i))`, 10000));
const st1 = await stack();
check('A FIFO: jen jedna karta (nejstarší 20) + „+4 čeká“', st1?.cards === '20' && st1.more === '+4 čeká', JSON.stringify(st1));
check('A gif-pending z cizího kanálu / s cizím médiem ignorováno', await ev(`!window.ucGif.gifs().has(25) && !window.ucGif.gifs().has(29)`) === true);
check('A opakované gif-pending bez duplicity', await ev(`document.querySelectorAll('.uc-gif-card[data-request-id="20"]').length`) === 1);
const cm = await ev(`(() => { const i = document.querySelector('.uc-gif-card[data-request-id="20"] .uc-gif-media'); const r = i.getBoundingClientRect(); return { w: i.getAttribute('width'), h: i.getAttribute('height'), rw: Math.round(r.width), rh: Math.round(r.height) }; })()`);
check('A náhled v kartě 498×280 → 285×160 bez deformace', cm?.w === '285' && cm.h === '160' && cm.rh === 160 && Math.abs(cm.rw / cm.rh - 498 / 280) < 0.02, JSON.stringify(cm));
// Vrstvení: tlačítko „↓ Nové zprávy“ a panel emotů nad kartou.
const zScroll = await ev(`(() => { const b = document.getElementById('btn-scroll'); b.classList.remove('hidden'); const r = b.getBoundingClientRect(); const s = document.querySelector('.uc-gif-stack').getBoundingClientRect();
  const overlap = r.top < s.bottom && r.bottom > s.top; const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); b.classList.add('hidden'); return { overlap, onTop: b.contains(hit) }; })()`);
check('A „↓ Nové zprávy“ nad kartou', zScroll?.overlap && zScroll.onTop, JSON.stringify(zScroll));
await ev(`document.getElementById('btn-emotes').click()`);
await until(`!!document.querySelector('.uc-ep') && getComputedStyle(document.querySelector('.uc-ep')).display !== 'none'`, 3000);
const zEp = await ev(`(() => { const p = document.querySelector('.uc-ep'); if (!p) return null; const r = p.getBoundingClientRect(); const s = document.querySelector('.uc-gif-stack').getBoundingClientRect();
  const y = Math.max(r.top, s.top) + 5; const overlap = r.top < s.bottom && r.bottom > s.top; const hit = document.elementFromPoint(r.left + r.width / 2, y); return { overlap, onTop: p.contains(hit) }; })()`);
check('A panel emotů nad kartou', zEp?.overlap && zEp.onTop, JSON.stringify(zEp));
await ev(`document.getElementById('btn-emotes').click()`);

// Schválit 20 → další karta 21, zámek jen 0,3 s (moje rozhodnutí)
await click(20, 'approve');
check('A Schválit → POST decide approve:true s Bearer', await (async () => { const t = Date.now(); while (Date.now() - t < 4000) { if (posts.decide.some((x) => x.id === '20')) return true; await sleep(100); } return false; })()
  && posts.decide.find((x) => x.id === '20').body?.approve === true && posts.decide.find((x) => x.id === '20').auth === 'Bearer tok', JSON.stringify(posts.decide));
check('A po mém rozhodnutí hned další karta (21)', await until(`!!document.querySelector('.uc-gif-card[data-request-id="21"]') && !document.querySelector('.uc-gif-card[data-request-id="20"]')`, 3000));
const st2 = await stack();
check('A … zámek po vlastním kliku ≤ 0,3 s, „+3 čeká“', st2?.lockMs > 0 && st2.lockMs <= 300 && st2.more === '+3 čeká' && !st2.notice, JSON.stringify(st2));
await sleep(350);
// Dvojklik na Schválit: odejde jediný POST, další karta zůstane nerozhodnutá.
await ev(`(() => { const b = document.querySelector('.uc-gif-card[data-request-id="21"] [data-act="approve"]'); b.click(); b.click(); return true; })()`);
check('A dvojklik → karta 22, 21 rozhodnuta jednou', await until(`!!document.querySelector('.uc-gif-card[data-request-id="22"]')`, 3000));
await sleep(500);
check('A … jeden POST pro 21, žádný pro 22', posts.decide.filter((x) => x.id === '21').length === 1 && !posts.decide.some((x) => x.id === '22'), JSON.stringify(posts.decide.map((x) => x.id)));

// Rozhodnutí jiného moda (gif-decided + gif-queue) → hláška + karta 23 se zámkem 1 s
pushAcc(['gif-decided', { requestId: 22, channel: 'robdiesalot', approved: false, status: 'rejected', by: 'twitch:jinymod' }],
  ['gif-queue', { channel: 'robdiesalot', pendingCount: 2, headId: 23 }]);
check('A gif-decided jiného moda → karta 23', await until(`!!document.querySelector('.uc-gif-card[data-request-id="23"]')`, 12000));
const st3 = await stack();
check('A … hláška „Zamítnuto · jinymod (Twitch)“, zámek 1 s, „+1 čeká“', st3?.notice === 'Zamítnuto · jinymod (Twitch)' && st3.lockMs > 300 && st3.more === '+1 čeká', JSON.stringify(st3));
const clicksBefore = posts.decide.length;
await ev(`document.querySelector('.uc-gif-card[data-request-id="23"] [data-act="approve"]').click()`);
await sleep(300);
check('A klik během zámku 1 s nic neodešle', posts.decide.length === clicksBefore);

// 409 already_decided → „Už rozhodl X“ a další karta
mock.decide['23'] = { code: 409, body: { ok: false, error: 'already_decided', status: 'approved', decidedBy: 'twitch:modik' } };
await until(`!window.ucGif.gifs().locked && !document.querySelector('.uc-gif-card [data-act="approve"]:disabled')`, 2000);
await click(23, 'approve');
check('A 409 → hláška „Už rozhodl modik (Twitch)“ a karta 24', await until(`document.querySelector('.uc-gif-notice:not([hidden])')?.textContent === 'Už rozhodl modik (Twitch)' && !!document.querySelector('.uc-gif-card[data-request-id="24"]')`, 4000), JSON.stringify(await stack()));

// Propadnutí (lokálně podle expiresAt) → hláška a fronta prázdná
check('A propadnutí → „Propadlo — nikdo nerozhodl včas“', await until(`document.querySelector('.uc-gif-notice:not([hidden])')?.textContent === 'Propadlo — nikdo nerozhodl včas' && !document.querySelector('.uc-gif-card')`, 25000), JSON.stringify(await stack()));
check('A po hlášce karta i zásobník pryč', await until(`!document.querySelector('.uc-gif-stack')`, 5000));

// Produkční pořadí: gif-decided + gif-queue přijdou PŘED HTTP odpovědí na můj klik → pořád moje rozhodnutí (0,3 s, bez hlášky)
mock.decide['27'] = { hold: true };
pushAcc(['gif-pending', pend0(27)], ['gif-pending', pend0(28)], ['gif-queue', { channel: 'robdiesalot', pendingCount: 2, headId: 27 }]);
check('A SSE před HTTP: karta 27', await until(`!!document.querySelector('.uc-gif-card[data-request-id="27"]')`, 12000));
await until(`!window.ucGif.gifs().locked && !document.querySelector('.uc-gif-card [data-act="approve"]:disabled')`, 2000);
await click(27, 'approve');
await until(`true`, 10);
await (async () => { const t = Date.now(); while (Date.now() - t < 4000 && !mock.decide['27'].release) await sleep(50); })();
pushAcc(['gif-decided', { requestId: 27, channel: 'robdiesalot', approved: true, status: 'approved', by: 'twitch:moduser' }], ['gif-queue', { channel: 'robdiesalot', pendingCount: 1, headId: 28 }]);
check('A SSE před HTTP → karta 28', await until(`!!document.querySelector('.uc-gif-card[data-request-id="28"]')`, 12000));
const stSse = await stack();
check('A … zámek jen 0,3 s a bez hlášky (moje rozhodnutí)', stSse?.lockMs > 0 && stSse.lockMs <= 300 && !stSse.notice, JSON.stringify(stSse));
mock.decide['27'].release?.();
await sleep(600);
const stSse2 = await stack();
check('A … pozdní HTTP odpověď nic nerozbije (karta 28, bez hlášky)', stSse2?.cards === '28' && !stSse2.notice && posts.decide.filter((x) => x.id === '27').length === 1, JSON.stringify(stSse2));
pushAcc(['gif-decided', { requestId: 28, channel: 'robdiesalot', approved: false, status: 'rejected', by: 'twitch:jinymod' }], ['gif-queue', { channel: 'robdiesalot', pendingCount: 0, headId: null }]);
await until(`!document.querySelector('.uc-gif-card')`, 12000);
await until(`!document.querySelector('.uc-gif-stack')`, 5000);

// Dříve zamítnutý GIF: kdy + kým a „Automaticky zahazovat 12 h“
pushAcc(['gif-pending', pend0(26, { previouslyRejected: { at: Date.UTC(2026, 8, 25, 12, 5), by: 'twitch:modik' } })], ['gif-queue', { channel: 'robdiesalot', pendingCount: 1, headId: 26 }]);
check('A dříve zamítnutý → karta 26', await until(`!!document.querySelector('.uc-gif-card[data-request-id="26"]')`, 12000));
await until(`!window.ucGif.gifs().locked && !document.querySelector('.uc-gif-card [data-act="approve"]:disabled')`, 2000);
const c26 = await card(26);
check('A … „Dříve zamítnuto … · modik (Twitch)“ + „Automaticky zahazovat 12 h“', /^Dříve zamítnuto .+ · modik \(Twitch\)$/.test(c26?.prev || '') && JSON.stringify(c26.buttons) === '["Automaticky zahazovat 12 h","Zamítnout","Schválit"]', JSON.stringify(c26));
await click(26, 'ban12h');
check('A „Automaticky zahazovat 12 h“ → POST /moderation/gif/<médium>/ban12h, karta pryč', await until(`!document.querySelector('.uc-gif-card[data-request-id="26"]')`, 4000) && posts.media.some((x) => x.id === MEDIA.card && x.action === 'ban12h'), JSON.stringify(posts.media));

// gif-queue s neznámou první žádostí → dotáhnout GET pending; prázdná fronta → nic
const pendB = posts.pending.length;
pushAcc(['gif-queue', { channel: 'robdiesalot', pendingCount: 1, headId: 99 }]);
check('A gif-queue s neznámým headId → GET pending', await (async () => { const t = Date.now(); while (Date.now() - t < 12000) { if (posts.pending.length > pendB) return true; await sleep(100); } return false; })());
pushAcc(['gif-queue', { channel: 'robdiesalot', pendingCount: 0, headId: null }]);
check('A gif-queue prázdná → bez karty', await until(`!document.querySelector('.uc-gif-card')`, 12000));

// SSE gif-message → nová zpráva (dedup)
const GM = (id, gif, text = 'hele 21') => ({ channel: 'robdiesalot', requestId: id, message: { platform: 'twitch', id: `gif-${id}`, username: 'Divak21', userId: 'u21', message: text, timestamp: Date.now(), historical: false, color: '#ff0000', badgesRaw: 'subscriber/1', gif } });
mock.sse.push(['gif-message', GM(21, { url: murl(MEDIA.ok), kind: 'gif', width: 200, height: 100 })], ['gif-message', GM(21, { url: murl(MEDIA.ok), kind: 'gif', width: 200, height: 100 })]);
check('A gif-message → zpráva s GIFem v chatu', await until(`!!document.querySelector('.msg[data-msg-id="gif-21"] .uc-gif img')`, 6000));
await sleep(800);
check('A gif-message dvakrát → jedna zpráva', await ev(`document.querySelectorAll('.msg[data-msg-id="gif-21"]').length`) === 1);
check('A malý GIF 100 % (200×100), jméno + text', await ev(`(() => { const m = document.querySelector('.msg[data-msg-id="gif-21"]'); const i = m.querySelector('.uc-gif-media'); return i.getAttribute('width') === '200' && i.getAttribute('height') === '100' && m.querySelector('.un').textContent === 'Divak21' && m.querySelector('.tx').textContent === 'hele 21'; })()`) === true);
mock.sse.push(['gif-message', { ...GM(26, { url: murl(MEDIA.ok), kind: 'gif' }), channel: 'jinykanal' }]);
mock.sse.push(['gif-message', GM(27, { url: `https://evil.example/media/gif/${MEDIA.ok}`, kind: 'gif' })]);
mock.sse.push(['gif-message', GM(28, { url: murl(MEDIA.vid), kind: 'mp4', width: 640, height: 360 }, '')]);
check('A MP4 → <video autoplay loop muted playsinline>, 400×225', await until(`!!document.querySelector('.msg[data-msg-id="gif-28"] video.uc-gif-media')`, 6000)
  && await ev(`(() => { const v = document.querySelector('.msg[data-msg-id="gif-28"] video'); return v.autoplay && v.loop && v.muted && v.hasAttribute('playsinline') && v.getAttribute('width') === '400' && v.getAttribute('height') === '225'; })()`) === true);
check('A MP4 viditelné → src z našeho serveru (lazy přes IntersectionObserver)', await until(`document.querySelector('.msg[data-msg-id="gif-28"] video')?.getAttribute('src') === ${JSON.stringify(murl(MEDIA.vid))}`, 4000));
check('A gif-message z cizího kanálu / s cizím médiem ignorováno', await ev(`!document.querySelector('.msg[data-msg-id="gif-26"]') && !document.querySelector('.msg[data-msg-id="gif-27"]')`) === true);

// Video: play/pause podle viditelnosti (sdílený IntersectionObserver), i po vrácení zaparkovaného uzlu.
await ev(`(() => { window.__vid = []; const P = HTMLMediaElement.prototype; P.play = function () { window.__vid.push('play'); return Promise.resolve(); }; P.pause = function () { window.__vid.push('pause'); }; return true; })()`);
await ev(`(() => { const m = document.querySelector('.msg[data-msg-id="gif-28"]'); window.__parked = m; m.remove(); return true; })()`);
check('A zaparkovaný uzel (mimo DOM) → video pause', await until(`window.__vid.includes('pause')`, 3000), await ev(`JSON.stringify(window.__vid)`));
await ev(`(() => { window.__vid = []; document.getElementById('chat').appendChild(window.__parked); return true; })()`);
check('A vrácený uzel → video znovu play', await until(`window.__vid.includes('play')`, 3000), await ev(`JSON.stringify(window.__vid)`));

// Odpověď na GIF: nativní reply nejde (zpráva na Twitchi neexistuje) → ucReplyTo + @jméno.
await ev(`document.querySelector('.msg[data-msg-id="gif-21"] .msg-action-btn[data-act="reply"]').click()`);
await ev(`(() => { const i = document.getElementById('msg-input'); i.value = 'pěkný'; document.getElementById('btn-send').disabled = false; document.getElementById('btn-send').click(); return true; })()`);
const sendSeen = await (async () => { const t = Date.now(); while (Date.now() - t < 4000) { if (posts.send.length) return true; await sleep(100); } return false; })();
check('A odpověď na GIF → POST /chat/send bez replyTo, s ucReplyTo gif-21 a @jménem', sendSeen && posts.send[0].replyTo === null && posts.send[0].ucReplyTo?.id === 'gif-21' && /^@Divak21 pěkný/.test(posts.send[0].text), JSON.stringify(posts.send[0]));

// 📌 u GIFu ne (mod podle vlastní zprávy s moderator badge; běžná zpráva pin má).
const gm40 = GM(40, { url: murl(MEDIA.ok), kind: 'gif', width: 50, height: 50 }, 'moje');
mock.sse.push(['gif-message', { ...gm40, message: { ...gm40.message, username: 'ModUser', badgesRaw: 'moderator/1' } }]);
await until(`!!document.querySelector('.msg[data-msg-id="gif-40"]')`, 6000);
mock.sse.push(['message-restored', { channel: 'robdiesalot', platform: 'twitch', messageId: 'e2e-p1', by: 'twitch:modik', message: { platform: 'twitch', id: 'e2e-p1', username: 'Tester', userId: 'u1', message: 'běžná zpráva', timestamp: Date.now(), color: '#1e90ff' } }]);
mock.sse.push(['gif-message', GM(41, { url: murl(MEDIA.ok), kind: 'gif', width: 50, height: 50 }, 'další')]);
check('A běžná zpráva má 📌 (jsem mod)', await until(`!!document.querySelector('.msg[data-msg-id="e2e-p1"] .msg-action-btn[title="Připnout zprávu"]')`, 6000));
check('A GIF zpráva 📌 nemá', await until(`!!document.querySelector('.msg[data-msg-id="gif-41"]')`, 6000) && await ev(`!document.querySelector('.msg[data-msg-id="gif-41"] .msg-action-btn[title="Připnout zprávu"]')`) === true);

// Smazání GIFu modem → médium pryč
mock.sse.push(['message-deleted', { channel: 'robdiesalot', platform: 'twitch', messageId: 'gif-21', by: 'twitch:jinymod' }]);
check('A message-deleted gif-21 → GIF pryč, zpráva smazaná', await until(`(() => { const m = document.querySelector('.msg[data-msg-id="gif-21"]'); return !!m && m.classList.contains('uc-deleted') && !m.querySelector('.uc-gif'); })()`, 6000));

// ---- fáze A2 (UX): schovaná původní zpráva, nahrazení GIFem na místě, gif_rejected, mod bez bubliny ----
const isShown = (id) => `(() => { const m = document.querySelector('.msg[data-msg-id="${id}"]'); return !!m && getComputedStyle(m).display !== 'none'; })()`;
const order = () => ev(`[...document.querySelectorAll('#chat .msg[data-msg-id]')].filter(m => getComputedStyle(m).display !== 'none').map(m => m.dataset.msgId).join(',')`);
const waitFor = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(100); } return false; };
check('A2 historie: gif_request se nevykreslí, GIF (replaces) je na jejím místě', await ev(`!document.querySelector('.msg[data-msg-id="e2e-held"]')`) === true
  && /gif-6,gif-8,e2e-rej/.test(await order()), await order());
check('A2 historie: čekající gif_request (bez GIFu) je v DOM schovaná', await ev(`(() => { const m = document.querySelector('.msg[data-msg-id="e2e-wait"]'); return !!m && m.classList.contains('uc-gif-held') && getComputedStyle(m).display === 'none'; })()`) === true);
check('A2 historie: gif_rejected = běžně smazaná (vidět, uc-deleted)', await ev(isShown('e2e-rej')) === true && await ev(`document.querySelector('.msg[data-msg-id="e2e-rej"]').classList.contains('uc-deleted')`) === true);
// Živě: zpráva → message-deleted gif_request (schovat) → ozvěna z platformy (dál schovaná) → gif-message replaces (na jejím místě).
const LT = Date.now() - 30000;
const LIVE = (id, text, ts) => ['message-restored', { channel: 'robdiesalot', platform: 'twitch', messageId: id, by: 'filter', message: { platform: 'twitch', id, username: 'Divak', userId: 'u9', message: text, timestamp: ts, color: '#1e90ff' } }];
mock.sse.push(LIVE('e2e-live1', 'hele https://tenor.com/view/cat-gif-1', LT), LIVE('e2e-live2', 'hele https://tenor.com/view/dog-gif-2', LT + 1));
check('A2 živě: zprávy s GIF odkazem dorazily', await until(`!!document.querySelector('.msg[data-msg-id="e2e-live2"]')`, 8000));
const prevLive1 = await ev(`document.querySelector('.msg[data-msg-id="e2e-live1"]').previousElementSibling?.dataset.msgId || null`);
const DEL = (id, reason) => ['message-deleted', { channel: 'robdiesalot', platform: 'twitch', messageId: id, by: 'filter', reason }];
mock.sse.push(DEL('e2e-live1', 'gif_request'), DEL('e2e-live2', 'gif_request'));
check('A2 živě: message-deleted gif_request → zpráva schovaná (ne „smazaná")', await until(`(() => { const a = document.querySelector('.msg[data-msg-id="e2e-live1"]'); const b = document.querySelector('.msg[data-msg-id="e2e-live2"]'); return !!a && !!b && getComputedStyle(a).display === 'none' && getComputedStyle(b).display === 'none'; })()`, 8000));
mock.sse.push(DEL('e2e-live1', 'platform'));
await sleep(1500);
check('A2 živě: ozvěna smazání z platformy schovanou zprávu neodkryje', await ev(isShown('e2e-live1')) === false);
// Převod selhal (živě 2026-09-26, 4chan CDN 403): schovaná gif_request → message-restored s celou zprávou → vidět s textem.
const URL4 = 'https://i.4pcdn.org/pol/1562850136932.gif';
mock.sse.push(LIVE('e2e-live3', URL4, LT + 2));
await until(`!!document.querySelector('.msg[data-msg-id="e2e-live3"]')`, 8000);
mock.sse.push(DEL('e2e-live3', 'gif_request'));
check('A2 selhání převodu: gif_request → schovaná', await until(`(() => { const m = document.querySelector('.msg[data-msg-id="e2e-live3"]'); return !!m && getComputedStyle(m).display === 'none'; })()`, 8000));
mock.sse.push(['message-restored', { channel: 'robdiesalot', platform: 'twitch', messageId: 'e2e-live3', by: 'filter', message: { platform: 'twitch', id: 'e2e-live3', username: 'Jouki', userId: 'u5', message: URL4, timestamp: LT + 2, color: '#1e90ff', historical: true } }]);
check('A2 selhání převodu: message-restored → zpráva vidět s odkazem (bez uc-gif-held / uc-deleted)', await until(`(() => { const m = document.querySelector('.msg[data-msg-id="e2e-live3"]'); return !!m && getComputedStyle(m).display !== 'none' && !m.classList.contains('uc-gif-held') && !m.classList.contains('uc-deleted') && m.querySelector('.tx').textContent.includes('4pcdn.org'); })()`, 8000),
  await ev(`(() => { const m = document.querySelector('.msg[data-msg-id="e2e-live3"]'); return m ? m.className + ' | ' + m.querySelector('.tx')?.textContent : null; })()`));
// Pojistka: rozhodnutí serveru nedorazí → po delayMs GET /gif/held → visible → zpráva vidět.
await ev(`(() => { window.ucGifHold().delayMs = 700; return true; })()`);
mock.held['e2e-live4'] = { state: 'visible', message: { platform: 'twitch', id: 'e2e-live4', username: 'Jouki', userId: 'u5', message: `zase ${URL4}`, timestamp: LT + 3, color: '#1e90ff', historical: true } };
mock.sse.push(LIVE('e2e-live4', `zase ${URL4}`, LT + 3));
await until(`!!document.querySelector('.msg[data-msg-id="e2e-live4"]')`, 8000);
const heldBefore = posts.held.length;
mock.sse.push(DEL('e2e-live4', 'gif_request'));
check('A2 pojistka: gif_request → schovaná', await until(`(() => { const m = document.querySelector('.msg[data-msg-id="e2e-live4"]'); return !!m && getComputedStyle(m).display === 'none'; })()`, 8000));
check('A2 pojistka: schovaná bez rozhodnutí → GET /gif/held s kanálem a id', await waitFor(() => posts.held.slice(heldBefore).some((u) => /channel=robdiesalot/.test(u) && decodeURIComponent(u).includes('twitch:e2e-live4')), 8000), posts.held.slice(heldBefore).join(' | '));
check('A2 pojistka: /gif/held visible → zpráva vidět s textem', await until(`(() => { const m = document.querySelector('.msg[data-msg-id="e2e-live4"]'); return !!m && getComputedStyle(m).display !== 'none' && m.querySelector('.tx').textContent.includes('4pcdn.org'); })()`, 8000));
await ev(`(() => { window.ucGifHold().delayMs = 30000; return true; })()`);
mock.sse.push(['gif-message', { channel: 'robdiesalot', requestId: 50, message: { platform: 'twitch', id: 'gif-50', username: 'Divak', userId: 'u9', message: 'hele', timestamp: LT, historical: false, color: '#1e90ff', gif: { url: murl(MEDIA.ok), kind: 'gif', width: 60, height: 40 }, replaces: 'twitch:e2e-live1' } }]);
check('A2 živě: schválený GIF nahradí původní zprávu na jejím místě', await until(`!!document.querySelector('.msg[data-msg-id="gif-50"]') && !document.querySelector('.msg[data-msg-id="e2e-live1"]')`, 8000)
  && await ev(`document.querySelector('.msg[data-msg-id="gif-50"]').previousElementSibling?.dataset.msgId || null`) === prevLive1
  && await ev(`document.querySelector('.msg[data-msg-id="gif-50"]').nextElementSibling?.dataset.msgId || null`) === 'e2e-live2', `prev=${prevLive1} order=${await order()}`);
mock.sse.push(DEL('e2e-live2', 'gif_rejected'));
check('A2 živě: zamítnuto (gif_rejected) → běžně smazaná zpráva', await until(`(() => { const m = document.querySelector('.msg[data-msg-id="e2e-live2"]'); return !!m && getComputedStyle(m).display !== 'none' && m.classList.contains('uc-deleted') && !m.classList.contains('uc-gif-held'); })()`, 8000));
// Živě 2026-09-26 (web): mod poslal GIF odkaz, server ho schválil rovnou → gif-N s časem původní zprávy, text jen
// UC marker, `replaces`. Původní zpráva byla poslední a schovaná (0 px) → GIF na jejím místě musí zůstat ve výhledu
// (uživatel dole zůstane dole), jednou, i když gif-message dorazí dvakrát.
for (let i = 0; i < 25; i++) mock.sse.push(LIVE(`e2e-fill${i}`, `výplň ${i}`, Date.now() + i));
await until(`!!document.querySelector('.msg[data-msg-id="e2e-fill24"]')`, 8000);
await ev(`(() => { const c = document.getElementById('chat'); c.scrollTop = c.scrollHeight; return true; })()`);
await sleep(500);
const TS60 = Date.now() + 100;
mock.sse.push(LIVE('e2e-live60', `${URL4} ⠀`, TS60));
await until(`!!document.querySelector('.msg[data-msg-id="e2e-live60"]')`, 8000);
mock.sse.push(DEL('e2e-live60', 'gif_request'));
check('A2 živě GIF modem: původní zpráva (poslední) schovaná', await until(`(() => { const m = document.querySelector('.msg[data-msg-id="e2e-live60"]'); return !!m && getComputedStyle(m).display === 'none'; })()`, 8000));
const GM60 = ['gif-message', { channel: 'robdiesalot', requestId: 60, message: { platform: 'twitch', id: 'gif-60', username: 'Jouki', userId: 'u5', message: '⠀', timestamp: TS60, historical: false, color: '#1e90ff', badgesRaw: 'moderator/1', gif: { url: murl(MEDIA.ok), kind: 'gif', width: 60, height: 120 }, replaces: 'twitch:e2e-live60' } }];
mock.sse.push(GM60, GM60);
check('A2 živě GIF modem: gif-60 vidět na místě původní zprávy, jednou, s médiem', await until(`(() => { const els = document.querySelectorAll('.msg[data-msg-id="gif-60"]'); const m = els[0]; return els.length === 1 && getComputedStyle(m).display !== 'none' && !!m.querySelector('.uc-gif img') && !document.querySelector('.msg[data-msg-id="e2e-live60"]'); })()`, 8000), await order());
const gifInView = `(() => { const c = document.getElementById('chat'); const m = document.querySelector('.msg[data-msg-id="gif-60"]'); if (!m) return false; return c.scrollHeight - c.scrollTop - c.clientHeight < 2 && m.getBoundingClientRect().bottom <= c.getBoundingClientRect().bottom + 1; })()`;
check('A2 živě GIF modem: chat zůstal dole, gif-60 celý ve výhledu', await until(gifInView, 3000),
  await ev(`(() => { const c = document.getElementById('chat'); const m = document.querySelector('.msg[data-msg-id="gif-60"]'); return JSON.stringify({ gap: c.scrollHeight - c.scrollTop - c.clientHeight, bottom: m && Math.round(m.getBoundingClientRect().bottom), chatBottom: Math.round(c.getBoundingClientRect().bottom) }); })()`));
// Mod (bez Dev módu) píše GIF: stav mod → bez bubliny, odeslání bez gifReview.
const typeIn = (text) => ev(`(() => { const i = document.getElementById('msg-input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const clickSend = () => ev(`(() => { const b = document.getElementById('btn-send'); b.disabled = false; b.click(); return true; })()`);
const stateBefore = posts.state.length;
await typeIn('mod gif https://tenor.com/view/cat-gif-1');
// Stav odměny se ptá už po přihlášení (indikátor, GIF záložka), odkaz v poli ho bere z cache.
check('A2 mod: GET /gif/state (bez review)', await waitFor(() => posts.state.length > 0)
  && !posts.state.at(-1).includes('review=1') && /channel=robdiesalot&platform=twitch/.test(posts.state.at(-1)), posts.state.at(-1));
await sleep(300);
check('A2 mod: bez bubliny cooldownu', await ev(`!document.querySelector('.uc-gif-cd:not([hidden])')`) === true);
const sendBeforeMod = posts.send.length;
await clickSend();
check('A2 mod: GIF odeslán bez gifReview', await waitFor(() => posts.send.length > sendBeforeMod)
  && posts.send.at(-1).gifReview === undefined && /tenor\.com/.test(posts.send.at(-1).text), JSON.stringify(posts.send.at(-1)));

// ---- fáze C: core GifRequests přímo ve stránce ----
const coreC = await ev(`(async () => {
  let mod = true; const box = document.createElement('div'); document.body.appendChild(box);
  let resolve; const api = () => new Promise((r) => { resolve = r; });
  const g = new window.UC_CORE.GifRequests({ doc: document, container: box, api, channel: () => 'robdiesalot', canModerate: () => mod });
  const P = (id, own) => ({ requestId: id, channel: 'robdiesalot', platform: 'twitch', login: 'x' + id, userId: 'u' + id, messageId: 'm', text: '', media: { url: ${JSON.stringify(murl(MEDIA.card))}, kind: 'gif' }, expiresAt: Date.now() + 60000, own });
  g.onPending(P(101, false)); g.onPending(P(102, true));
  const before = g.requests.map(r => r.requestId).join(',');
  mod = false; g.repaint();
  const after = g.requests.map(r => r.requestId).join(',');
  const dropped = g.onPending(P(103, false));
  mod = true; g.onPending(P(104, false));
  const p = g.decide('104', true); g.clear(); resolve({ ok: true, status: 'approved' }); const res = await p;
  const left = box.querySelectorAll('.uc-gif-card').length; box.remove();
  return { before, after, dropped, res, left };
})()`);
check('C ztráta role → cizí žádost pryč, vlastní zůstává; cizí pending divákovi nevznikne', coreC?.before === '101,102' && coreC.after === '102' && coreC.dropped === false, JSON.stringify(coreC));
check('C decide po clear() → nic nevykreslí', coreC?.res === null && coreC.left === 0, JSON.stringify(coreC));
// Zámky s falešnými hodinami: nová karta 1 s, po vlastním rozhodnutí 0,3 s, klik během zámku nic.
const coreLock = await ev(`(async () => {
  let T = 1000; const box = document.createElement('div'); document.body.appendChild(box); const calls = [];
  const g = new window.UC_CORE.GifRequests({ doc: document, container: box, now: () => T, channel: () => 'robdiesalot', canModerate: () => true,
    api: async (path) => { calls.push(path); return { ok: true, status: 'approved' }; }, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} });
  const P = (id, c) => ({ requestId: id, channel: 'robdiesalot', platform: 'twitch', login: 'x', userId: 'u', messageId: 'm' + id, text: '', media: { url: ${JSON.stringify(murl(MEDIA.card))}, kind: 'gif' }, createdAt: c, expiresAt: T + 600000 });
  g.onPending(P(1, 10)); g.onPending(P(2, 20)); g.onPending(P(3, 30));
  const r = { head1: g.headId, lock1: g.lockMs };
  r.early = await g.decide('1', true); r.callsEarly = calls.length;
  T += 1000; r.unlocked = !g.locked;
  r.dec = await g.decide('1', true); r.head2 = g.headId; r.lock2 = g.lockMs;
  T += 300; r.unlocked2 = !g.locked;
  g.onDecided({ requestId: 2, channel: 'robdiesalot', status: 'rejected', by: 'twitch:jiny' }); r.head3 = g.headId; r.lock3 = g.lockMs;
  r.notice = box.querySelector('.uc-gif-notice').textContent;
  g.onQueue({ channel: 'robdiesalot', pendingCount: 0, headId: null }); r.empty = g.size === 0 && !box.querySelector('.uc-gif-card');
  g.clear(); box.remove(); return r;
})()`);
check('C zámek: nová karta 1 s, klik během zámku neodejde', coreLock?.head1 === '1' && coreLock.lock1 === 1000 && coreLock.early === null && coreLock.callsEarly === 0 && coreLock.unlocked, JSON.stringify(coreLock));
check('C zámek: po vlastním rozhodnutí další karta 0,3 s', coreLock?.dec === 'approved' && coreLock.head2 === '2' && coreLock.lock2 === 300 && coreLock.unlocked2, JSON.stringify(coreLock));
check('C zámek: rozhodnutí jiného moda → další karta 1 s + hláška', coreLock?.head3 === '3' && coreLock.lock3 === 1000 && coreLock.notice === 'Zamítnuto · jiny (Twitch)', JSON.stringify(coreLock));
check('C gif-queue prázdná → všechno pryč', coreLock?.empty === true, JSON.stringify(coreLock));
// SSE před HTTP (falešné hodiny): gif-decided / gif-queue během busy = moje rozhodnutí; 409 po SSE = hláška.
const coreSse = await ev(`(async () => {
  let T = 1000; const box = document.createElement('div'); document.body.appendChild(box); const pend = [];
  const g = new window.UC_CORE.GifRequests({ doc: document, container: box, now: () => T, channel: () => 'robdiesalot', canModerate: () => true,
    api: (path) => new Promise((res, rej) => pend.push({ res, rej })), setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} });
  const P = (id, c) => ({ requestId: id, channel: 'robdiesalot', platform: 'twitch', login: 'x', userId: 'u', messageId: 'm' + id, text: '', media: { url: ${JSON.stringify(murl(MEDIA.card))}, kind: 'gif' }, createdAt: c, expiresAt: T + 600000 });
  [1, 2, 3, 4].forEach((i) => g.onPending(P(i, i * 10)));
  T += 1000;
  const r = {};
  let p = g.decide('1', true);
  g.onDecided({ requestId: 1, channel: 'robdiesalot', status: 'approved', by: 'twitch:ja' });
  r.head1 = g.headId; r.lock1 = g.lockMs; r.notice1 = box.querySelector('.uc-gif-notice').hidden;
  pend.shift().res({ ok: true, status: 'approved' }); r.res1 = await p; r.head1b = g.headId;
  T += 300;
  p = g.decide('2', false);
  g.onQueue({ channel: 'robdiesalot', pendingCount: 2, headId: 3 });
  r.head2 = g.headId; r.lock2 = g.lockMs;
  pend.shift().res({ ok: true, status: 'rejected' }); r.res2 = await p;
  T += 300;
  p = g.decide('3', true);
  g.onDecided({ requestId: 3, channel: 'robdiesalot', status: 'approved', by: 'twitch:jiny' });
  pend.shift().rej({ error: 'already_decided', status: 409, body: { status: 'approved', decidedBy: 'twitch:jiny' } }); r.res3 = await p;
  r.notice3 = box.querySelector('.uc-gif-notice').textContent; r.head3 = g.headId;
  g.clear(); box.remove(); return r;
})()`);
check('C SSE gif-decided před HTTP → další karta 0,3 s, bez hlášky, pozdní odpověď OK', coreSse?.head1 === '2' && coreSse.lock1 === 300 && coreSse.notice1 === true && coreSse.res1 === 'approved' && coreSse.head1b === '2', JSON.stringify(coreSse));
check('C SSE gif-queue před HTTP → taky 0,3 s', coreSse?.head2 === '3' && coreSse.lock2 === 300 && coreSse.res2 === 'rejected', JSON.stringify(coreSse));
check('C 409 po SSE → hláška „Už rozhodl jiny (Twitch)“', coreSse?.res3 === 'approved' && coreSse.notice3 === 'Už rozhodl jiny (Twitch)' && coreSse.head3 === '4', JSON.stringify(coreSse));

// ---- fáze B: divák = odesílatel (štítky u vlastní zprávy místo karty) ----
mock.mod = false;
mock.gifState = { ok: true, allowed: true, cooldownUntil: null, cooldownSec: 60, serverNow: 1 };
const pendBefore = posts.pending.length;
await boot();
await until(`!document.body.classList.contains('uc-can-moderate')`);
const own = (id) => ev(`(() => { const m = document.querySelector('.msg[data-msg-id="${id}"]'); if (!m) return null; const s = m.querySelector('.uc-gif-st');
  const w = s?.querySelector('.uc-gif-st-warn');
  return { shown: getComputedStyle(m).display !== 'none', held: m.classList.contains('uc-gif-held'), deleted: m.classList.contains('uc-deleted'), text: m.querySelector('.tx')?.textContent || '',
    kind: s?.dataset.kind || null, label: s ? (s.querySelector('.uc-gif-st-pct, .uc-gif-st-txt')?.textContent || '') : null, spin: !!s?.querySelector('.uc-gif-st-spin'),
    warn: !!w && !w.hidden, warnTip: w?.getAttribute('title') || null, color: s ? getComputedStyle(s).color : null, ring: !!s?.querySelector('.uc-qd-ring') }; })()`);
const OWNMSG = (id, text) => ['message-restored', { channel: 'robdiesalot', platform: 'twitch', messageId: id, by: 'filter', message: { platform: 'twitch', id, username: 'ModUser', userId: 'u7', message: text, timestamp: Date.now(), color: '#1e90ff' } }];
const PR = (id, phase, pct, extra = {}) => ['gif-progress', { requestKey: `twitch:${id}`, channel: 'robdiesalot', platform: 'twitch', messageId: id, phase, pct, ...extra }];
pushAcc(
  ['gif-pending', pend0(34, { own: true, login: 'moduser', messageId: 'e2e-own0' })],
  ['gif-pending', pend0(33)],   // cizí — divák ji nemá vidět
);
await until(`window.ucGif.gifs().has(34)`, 12000);
check('B vlastní žádost → žádná karta (stav ukazuje štítek u zprávy)', await ev(`!document.querySelector('.uc-gif-card')`) === true);
check('B cizí žádost divákovi nevznikne', await ev(`!window.ucGif.gifs().has(33)`) === true);
check('B divák nevolá GET pending', posts.pending.length === pendBefore, `${pendBefore} → ${posts.pending.length}`);
// Zpráva z vlastního spojení (IRC) + průběh stahování
mock.sse.push(OWNMSG('e2e-own1', 'moje https://tenor.com/view/cat-gif-1'));
await until(`!!document.querySelector('.msg[data-msg-id="e2e-own1"]')`, 8000);
pushAcc(PR('e2e-own1', 'detect', 0), PR('e2e-own1', 'access', 10), PR('e2e-own1', 'download', 30));
check('B gif-progress → kolečko s % u zprávy („30 %“)', await until(`document.querySelector('.msg[data-msg-id="e2e-own1"] .uc-gif-st-pct')?.textContent === '30 %'`, 12000), JSON.stringify(await own('e2e-own1')));
check('B … kolečko (uc-qd-ring) pod textem', (await own('e2e-own1'))?.ring === true);
pushAcc(PR('e2e-own1', 'unlock', 50, { estimateMs: 3000, elapsedMs: 0 }));
check('B Bright Data: procenta rostou nad 50', await until(`parseInt(document.querySelector('.msg[data-msg-id="e2e-own1"] .uc-gif-st-pct')?.textContent) > 60`, 12000));
check('B … a zaseknou se na 95 %', await until(`document.querySelector('.msg[data-msg-id="e2e-own1"] .uc-gif-st-pct')?.textContent === '95 %'`, 6000));
await sleep(800);
check('B … zůstává 95 %', await ev(`document.querySelector('.msg[data-msg-id="e2e-own1"] .uc-gif-st-pct')?.textContent`) === '95 %');
pushAcc(PR('e2e-own1', 'verify', 95), PR('e2e-own1', 'done', 100, { outcome: 'pending' }), ['gif-pending', pend0(30, { own: true, login: 'moduser', messageId: 'e2e-own1', previouslyRejected: { at: Date.now() - 3600000 } })]);
check('B hotovo → peach „Schvalování moderátorem ( )“ s animací', await until(`document.querySelector('.msg[data-msg-id="e2e-own1"] .uc-gif-st')?.dataset.kind === 'pending'`, 12000)
  && (await own('e2e-own1'))?.label === 'Schvalování moderátorem' && (await own('e2e-own1')).spin, JSON.stringify(await own('e2e-own1')));
const o1 = await own('e2e-own1');
check('B dříve zamítnutý → ⚠ s tooltipem', o1?.warn && o1.warnTip === 'tento GIF byl už dříve zamítnut', JSON.stringify(o1));
check('B peach barva štítku', o1?.color === 'rgb(255, 190, 152)', o1?.color);
mock.sse.push(['message-deleted', { channel: 'robdiesalot', platform: 'twitch', messageId: 'e2e-own1', by: 'filter', reason: 'gif_request' }]);
await sleep(1500);
const o1h = await own('e2e-own1');
check('B message-deleted gif_request → odesílatel zprávu vidí dál (se štítkem)', o1h?.shown && !o1h.held && o1h.kind === 'pending' && o1h.text.includes('tenor.com'), JSON.stringify(o1h));
pushAcc(['gif-decided', { requestId: 30, channel: 'robdiesalot', approved: false, status: 'rejected', by: 'twitch:modik', own: true }]);
check('B zamítnuto → červený „Zamítnuto moderátorem“', await until(`document.querySelector('.msg[data-msg-id="e2e-own1"] .uc-gif-st')?.dataset.kind === 'rejected'`, 12000)
  && (await own('e2e-own1'))?.label === 'Zamítnuto moderátorem', JSON.stringify(await own('e2e-own1')));
mock.sse.push(['message-deleted', { channel: 'robdiesalot', platform: 'twitch', messageId: 'e2e-own1', by: 'twitch:modik', reason: 'gif_rejected' }]);
await sleep(1500);
const o1r = await own('e2e-own1');
check('B gif_rejected → zpráva nezmizí, text zůstává, štítek červený natrvalo', o1r?.shown && !o1r.deleted && o1r.kind === 'rejected' && o1r.text.includes('tenor.com') && /rgb\(255, 138, 142\)/.test(o1r.color), JSON.stringify(o1r));
// Vypršelo
mock.sse.push(OWNMSG('e2e-own2', 'druhý https://giphy.com/gifs/x-2'));
await until(`!!document.querySelector('.msg[data-msg-id="e2e-own2"]')`, 8000);
pushAcc(PR('e2e-own2', 'done', 100, { outcome: 'pending' }), ['gif-pending', pend0(31, { own: true, login: 'moduser', messageId: 'e2e-own2' })],
  ['gif-decided', { requestId: 31, channel: 'robdiesalot', approved: false, status: 'expired', by: null, own: true }]);
check('B vypršelo → červený „Vypršelo“', await until(`document.querySelector('.msg[data-msg-id="e2e-own2"] .uc-gif-st-txt')?.textContent === 'Vypršelo'`, 12000), JSON.stringify(await own('e2e-own2')));
check('B bez ⚠ u GIFu, který zamítnutý nebyl', await ev(`!document.querySelector('.msg[data-msg-id="e2e-own2"] .uc-gif-st-warn:not([hidden])')`) === true);
// Schváleno → původní zpráva pryč, GIF na konci chatu (čas schválení, ne čas původní zprávy)
mock.sse.push(OWNMSG('e2e-own3', 'třetí https://tenor.com/view/dog-gif-3'));
await until(`!!document.querySelector('.msg[data-msg-id="e2e-own3"]')`, 8000);
pushAcc(PR('e2e-own3', 'done', 100, { outcome: 'pending' }), ['gif-pending', pend0(32, { own: true, login: 'moduser', messageId: 'e2e-own3' })]);
await until(`document.querySelector('.msg[data-msg-id="e2e-own3"] .uc-gif-st')?.dataset.kind === 'pending'`, 12000);
mock.sse.push(['message-deleted', { channel: 'robdiesalot', platform: 'twitch', messageId: 'e2e-own3', by: 'filter', reason: 'gif_request' }]);
mock.sse.push(OWNMSG('e2e-after', 'zpráva po mé'));
await until(`!!document.querySelector('.msg[data-msg-id="e2e-after"]')`, 8000);
pushAcc(['gif-decided', { requestId: 32, channel: 'robdiesalot', approved: true, status: 'approved', by: 'twitch:modik', own: true }]);
mock.sse.push(['gif-message', { channel: 'robdiesalot', requestId: 32, message: { platform: 'twitch', id: 'gif-32', username: 'ModUser', userId: 'u7', message: 'třetí', timestamp: Date.now() + 500, historical: false, color: '#1e90ff', gif: { url: murl(MEDIA.ok), kind: 'gif', width: 60, height: 40 }, gifOrigin: 'twitch:e2e-own3' } }]);
check('B schváleno → GIF zpráva v chatu', await until(`!!document.querySelector('.msg[data-msg-id="gif-32"] .uc-gif img')`, 8000));
const lastIds = await ev(`[...document.querySelectorAll('#chat .msg[data-msg-id]')].filter(m => getComputedStyle(m).display !== 'none').map(m => m.dataset.msgId).slice(-3).join(',')`);
check('B schválený GIF na konci chatu (čas schválení), za pozdější zprávou', /e2e-after,gif-32$/.test(lastIds), lastIds);
check('B … původní zpráva schovaná, štítek pryč', await until(`(() => { const m = document.querySelector('.msg[data-msg-id="e2e-own3"]'); return !!m && getComputedStyle(m).display === 'none' && !m.querySelector('.uc-gif-st'); })()`, 4000));
// Režim „Schválené“: nový GIF → hláška + štítek
mock.sse.push(OWNMSG('e2e-own4', 'nový https://tenor.com/view/new-gif-4'));
await until(`!!document.querySelector('.msg[data-msg-id="e2e-own4"]')`, 8000);
pushAcc(PR('e2e-own4', 'download', 40), ['gif-notice', { requestKey: 'twitch:e2e-own4', channel: 'robdiesalot', platform: 'twitch', messageId: 'e2e-own4', kind: 'approved_only' }]);
check('B gif-notice approved_only → hláška „Nové GIFy teď nejdou, vyber z GIFů v panelu“', await until(`[...document.querySelectorAll('#chat .sys')].some(m => m.textContent === 'Nové GIFy teď nejdou, vyber z GIFů v panelu')`, 12000));
check('B … a štítek u zprávy', (await own('e2e-own4'))?.label === 'Nové GIFy teď nejdou', JSON.stringify(await own('e2e-own4')));
// Selhání převodu (běžný odkaz) → štítek pryč
mock.sse.push(OWNMSG('e2e-own5', 'pátý https://i.4pcdn.org/pol/1.gif'));
await until(`!!document.querySelector('.msg[data-msg-id="e2e-own5"]')`, 8000);
pushAcc(PR('e2e-own5', 'download', 20), PR('e2e-own5', 'done', 100, { outcome: 'failed' }));
check('B převod selhal (outcome failed) → bez štítku', await until(`!!window.ucGif.out().get('twitch', 'e2e-own5') && !document.querySelector('.msg[data-msg-id="e2e-own5"] .uc-gif-st')`, 12000));
// Optimistická zpráva: kolečko hned, průběh podle id z POST /chat/send
mock.sendId = 'e2e-own6';
const sendB = posts.send.length;
await typeIn('šestý https://tenor.com/view/six-gif-6');
await sleep(300);
await clickSend();
check('B odeslání GIF odkazu → optimistická zpráva s kolečkem 0 %', await until(`[...document.querySelectorAll('.msg[data-msg-id^="sent-"]')].some(m => m.querySelector('.uc-gif-st-pct')?.textContent === '0 %')`, 4000)
  && posts.send.length > sendB);
pushAcc(PR('e2e-own6', 'download', 45));
check('B gif-progress (id z /chat/send) → kolečko optimistické zprávy „45 %“', await until(`[...document.querySelectorAll('.msg[data-msg-id^="sent-"]')].some(m => m.querySelector('.uc-gif-st-pct')?.textContent === '45 %')`, 12000));
mock.sendId = null;
// Schválený GIF jiného diváka: na konci chatu
mock.sse.push(['gif-message', { channel: 'robdiesalot', requestId: 70, message: { platform: 'twitch', id: 'gif-70', username: 'Cizi', userId: 'u70', message: '', timestamp: Date.now() + 1000, historical: false, color: '#1e90ff', gif: { url: murl(MEDIA.ok), kind: 'gif', width: 60, height: 40 }, gifOrigin: 'twitch:hodne-stara' } }]);
check('B schválený GIF jiného diváka je poslední zprávou', await until(`[...document.querySelectorAll('#chat .msg[data-msg-id]')].filter(m => getComputedStyle(m).display !== 'none').at(-1)?.dataset.msgId === 'gif-70'`, 8000));
check('B GIF z historie vidí i divák', await ev(`!!document.querySelector('.msg[data-msg-id="gif-5"] .uc-gif img')`) === true);

// ---- fáze D (divák): bublina cooldownu ----
const SN = 5_000_000;   // hodiny serveru jinde než klient (posun přes serverNow)
mock.gifState = () => ({ ok: true, allowed: true, cooldownUntil: SN + 5_900, cooldownSec: 60, serverNow: SN });
await typeIn('');
await ev(`(() => { window.ucGif.cd().reset(); return true; })()`);   // stav z fáze B (lokální cooldown po odeslání) pryč
const st0 = posts.state.length;
await typeIn('ahoj bez odkazu');
await sleep(400);
check('D text bez GIF odkazu → žádný dotaz, žádná bublina', posts.state.length === st0 && await ev(`!document.querySelector('.uc-gif-cd:not([hidden])')`) === true);
await typeIn('koukni https://tenor.com/view/cat-gif-1');
check('D GIF odkaz + cooldown → bublina s kolečkem a sekundami', await until(`!!document.querySelector('.uc-gif-cd:not([hidden]) .uc-qd-ring em')`, 5000));
const bub = () => ev(`(() => { const b = document.querySelector('.uc-gif-cd'); if (!b) return null; const r = b.getBoundingClientRect(); const i = document.getElementById('msg-input').getBoundingClientRect();
  return { shown: !b.hidden, text: b.querySelector('.uc-gif-cd-text').textContent, sec: Number(b.querySelector('em').textContent), blocked: b.classList.contains('uc-gif-cd--blocked'),
    color: getComputedStyle(b.querySelector('.uc-gif-cd-text')).color, ringBg: getComputedStyle(b.querySelector('.uc-qd-ring i')).backgroundImage.slice(0, 40), above: r.bottom <= i.top + 2,
    inputBlocked: document.getElementById('msg-input').classList.contains('uc-gif-input-blocked'), inputBorder: getComputedStyle(document.getElementById('msg-input')).borderTopColor }; })()`);
const b1 = await bub();
check('D bublina: „GIF můžeš poslat za" + číslo 5–6, conic kolečko, nad polem', b1?.shown && b1.text === 'GIF můžeš poslat za' && b1.sec >= 5 && b1.sec <= 6 && /conic-gradient/.test(b1.ringBg) && b1.above && !b1.blocked, JSON.stringify(b1));
check('D GET /gif/state s kanálem a platformou (bez review)', /\/gif\/state\?channel=robdiesalot&platform=twitch$/.test(posts.state.at(-1) || ''), posts.state.at(-1));
await sleep(1300);
const b2 = await bub();
check('D číslo odpočítává', b2 && b2.sec < b1.sec, `${b1?.sec} → ${b2?.sec}`);
const sendD0 = posts.send.length;
await clickSend();
await sleep(600);
const b3 = await bub();
check('D odeslání GIFu během cooldownu → neodešlo, text v poli', posts.send.length === sendD0 && await ev(`document.getElementById('msg-input').value`) === 'koukni https://tenor.com/view/cat-gif-1');
check('D … červený okraj pole + červeně „Můžeš až za:" s kolečkem', b3?.blocked && b3.text === 'Můžeš až za:' && b3.inputBlocked && b3.inputBorder === 'rgb(229, 72, 77)' && /rgb\(255, 107, 112\)/.test(b3.color), JSON.stringify(b3));
await typeIn('ahoj');
check('D odkaz pryč → bublina i červený okraj pryč', await until(`!document.querySelector('.uc-gif-cd:not([hidden])') && !document.getElementById('msg-input').classList.contains('uc-gif-input-blocked')`, 2000));
await clickSend();
check('D bez GIF odkazu posílání funguje', await waitFor(() => posts.send.length > sendD0) && posts.send.at(-1).text.startsWith('ahoj'), JSON.stringify(posts.send.at(-1)));
await typeIn('znovu https://giphy.com/gifs/x-1');
check('D bublina zase (stav z cache)', await until(`!!document.querySelector('.uc-gif-cd:not([hidden])')`, 2000));
check('D po doběhnutí cooldownu bublina zmizí', await until(`!document.querySelector('.uc-gif-cd:not([hidden])')`, 8000));
const sendD1 = posts.send.length;
await clickSend();
check('D po cooldownu GIF odejde (bez gifReview)', await waitFor(() => posts.send.length > sendD1)
  && /giphy/.test(posts.send.at(-1).text) && posts.send.at(-1).gifReview === undefined, JSON.stringify(posts.send.at(-1)));
await typeIn('ještě https://giphy.com/gifs/x-2');
check('D po odeslání GIFu lokální cooldown z cooldownSec (≈60 s)', await until(`Number(document.querySelector('.uc-gif-cd:not([hidden]) em')?.textContent) >= 58`, 5000), JSON.stringify(await bub()));
pushAcc(['gif-decided', { requestId: 60, channel: 'robdiesalot', approved: false, status: 'rejected', by: 'twitch:modik', own: true }]);
check('D vlastní GIF zamítnut → cooldown pryč, bublina zmizí', await until(`!document.querySelector('.uc-gif-cd:not([hidden])')`, 12000));
await typeIn('');

// ---- fáze G (divák): záložka GIFy v panelu emotů, výběr z knihovny, indikátor odměny ----
const LIB = (n, tags, extra = {}) => ({ mediaId: hex(n), url: murl(hex(n)), kind: 'gif', width: 200, height: 100, tags, useCount: 20 - n, lastUsedAt: Date.now(), ...extra });
mock.library = [LIB(11, ['cat', 'dance']), LIB(12, ['dog']), LIB(13, ['cat', 'fail'])];
mock.gifState = { ok: true, allowed: false, cooldownUntil: null, cooldownSec: 60, serverNow: 1 };
await ev(`(async () => { window.ucGif.cd().reset(); await window.ucGif.cd().fetchState(); return true; })()`);
const gl = () => ev(`(() => { const p = document.querySelector('.uc-ep-pane[data-pane="gif"]'); const vis = (e) => !!e && !e.hidden && getComputedStyle(e).display !== 'none';
  return { shown: vis(p), items: p ? [...p.querySelectorAll('.uc-gl-grid:not(.uc-gl-grid--rej) .uc-gl-i')].map(i => i.dataset.id.slice(-2)).join(',') : null,
    reward: p?.querySelector('.uc-gl-reward-t')?.textContent || '', flash: !!p?.querySelector('.uc-gl-reward--flash'), tabs: vis(p?.querySelector('.uc-gl-tabs')),
    locked: !!p?.classList.contains('uc-gl--locked'), dups: vis(p?.querySelector('.uc-gl-dups')) ? p.querySelector('.uc-gl-dups .uc-gl-h').textContent : null,
    rej: p ? [...p.querySelectorAll('.uc-gl-grid--rej .uc-gl-i')].map(i => i.dataset.id.slice(-2)).join(',') : null,
    msg: vis(p?.querySelector('.uc-gl-msg')) ? p.querySelector('.uc-gl-msg').textContent : null,
    confirm: vis(p?.querySelector('.uc-gl-confirm')) ? p.querySelector('.uc-gl-confirm p').textContent : null }; })()`);
const glClick = (sel) => ev(`(() => { const b = document.querySelector('.uc-ep-pane[data-pane="gif"] ${sel}'); if (!b) return false; b.click(); return true; })()`);
await ev(`document.getElementById('btn-emotes').click()`);
check('G panel emotů má svislé záložky Emoty | GIFy', await until(`[...document.querySelectorAll('.uc-ep-side .uc-ep-tab')].map(b => b.textContent.trim()).join('|') === 'Emoty|GIFy'`, 3000));
await ev(`document.querySelector('.uc-ep-tab[data-tab="gif"]').click()`);
check('G záložka GIFy → knihovna (GET /gifs/library s kanálem), pořadí podle použití', await until(`document.querySelectorAll('.uc-ep-pane[data-pane="gif"] .uc-gl-i').length === 3`, 5000)
  && posts.library.some((u) => /channel=robdiesalot/.test(u)) && (await gl())?.items === '0b,0c,0d', JSON.stringify(await gl()));
const g0 = await gl();
check('G divák bez odměny: knihovnu vidí, zamčeno + hláška, bez modích tabů', g0?.locked && /není aktivní/.test(g0.reward) && !g0.tabs && g0.dups === null, JSON.stringify(g0));
const sendG0 = posts.send.length;
await glClick('.uc-gl-i[data-id$="0b"] .uc-gl-pick');
await sleep(300);
check('G zamčený výběr → nic neodejde, hlavička blikne', posts.send.length === sendG0 && (await gl())?.flash === true);
await ev(`(() => { const i = document.querySelector('.uc-gl-search input'); i.value = 'cat'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
check('G hledání v tazích → GET s q=cat, 2 GIFy', await until(`document.querySelectorAll('.uc-ep-pane[data-pane="gif"] .uc-gl-i').length === 2`, 3000) && posts.library.some((u) => /[?&]q=cat/.test(u)), JSON.stringify(await gl()));
await ev(`(() => { const i = document.querySelector('.uc-gl-search input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await until(`document.querySelectorAll('.uc-ep-pane[data-pane="gif"] .uc-gl-i').length === 3`, 3000);
// Souběh: hledání během běžícího načtení — platí poslední dotaz, i když starší odpověď dorazí později
mock.libHold = true;
await ev(`(() => { const i = document.querySelector('.uc-gl-search input'); i.value = 'cat'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await waitFor(() => mock.libHeld.some((x) => x.q === 'cat'), 3000);
await ev(`(() => { const i = document.querySelector('.uc-gl-search input'); i.value = 'dog'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
check('G souběh: druhé hledání se nezahodí (dva dotazy)', await waitFor(() => mock.libHeld.some((x) => x.q === 'dog'), 3000), JSON.stringify(mock.libHeld.map((x) => x.q)));
mock.libHold = false;
const heldDog = mock.libHeld.find((x) => x.q === 'dog'), heldCat = mock.libHeld.find((x) => x.q === 'cat');
mock.libHeld = [];
heldDog.send();
await sleep(300);
heldCat.send();   // starší odpověď až po novější
await sleep(500);
check('G souběh: platí poslední dotaz („dog“ = 1 GIF), starší odpověď zahozena', (await gl())?.items === '0c', JSON.stringify(await gl()));
await ev(`(() => { const i = document.querySelector('.uc-gl-search input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await until(`document.querySelectorAll('.uc-ep-pane[data-pane="gif"] .uc-gl-i').length === 3`, 3000);
// Přepnutí kanálu s otevřeným panelem (core createGifPanel ve stránce, odpovědi v libovolném pořadí)
const coreCh = await ev(`(async () => {
  let chan = 'kanala'; const calls = []; const pane = document.createElement('div'); document.body.appendChild(pane);
  const item = (n) => ({ mediaId: n.repeat(32).slice(0, 32), url: 'https://api.jouki.cz/media/gif/' + n.repeat(32).slice(0, 32), kind: 'gif', width: 10, height: 10, tags: [] });
  const api = (path) => new Promise((res) => calls.push({ path, res }));
  const p = window.UC_CORE.createGifPanel({ pane, api, channel: () => chan, onPick: () => {} });
  p.show();
  const ids = () => [...pane.querySelectorAll('.uc-gl-i')].map((i) => i.dataset.id[0]).join(',');
  const r = { first: calls.length };
  chan = 'kanalb'; p.reset();                                        // přepnutí kanálu → nový dotaz hned
  r.second = calls.length;
  calls[1].res({ ok: true, items: [item('b')] });
  await new Promise((x) => setTimeout(x, 20));
  calls[0].res({ ok: true, items: [item('a')] });                    // starý kanál dorazí pozdě
  await new Promise((x) => setTimeout(x, 20));
  r.afterReset = ids();
  chan = 'kanalc';                                                    // změna kanálu bez nového dotazu
  p.reload();
  const n3 = calls.length;
  chan = 'kanald';
  calls[n3 - 1].res({ ok: true, items: [item('c')] });               // dotaz pro c doběhne, kanál je už d → znovu
  await new Promise((x) => setTimeout(x, 20));
  r.refetch = calls.length > n3 && /channel=kanald/.test(calls.at(-1).path);
  calls.at(-1).res({ ok: true, items: [item('d')] });
  await new Promise((x) => setTimeout(x, 20));
  r.final = ids();
  p.destroy(); pane.remove(); return r;
})()`);
check('G souběh kanálu: přepnutí s otevřeným panelem → nový dotaz, starý výsledek zahozen', coreCh?.first === 1 && coreCh.second === 2 && coreCh.afterReset === 'b', JSON.stringify(coreCh));
check('G souběh kanálu: kanál se změnil během dotazu → po doběhnutí znovu načíst', coreCh?.refetch === true && coreCh.final === 'd', JSON.stringify(coreCh));
// Odemčená odměna → výběr pošle náš odkaz do chatu
mock.gifState = { ok: true, allowed: true, cooldownUntil: null, cooldownSec: 60, serverNow: 1 };
await ev(`(async () => { window.ucGif.cd().reset(); await window.ucGif.cd().fetchState(); return true; })()`);
check('G odměna aktivní → hlavička „Odměna „Posílání GIFů“ je aktivní“, odemčeno', await until(`!document.querySelector('.uc-ep-pane[data-pane="gif"]').classList.contains('uc-gl--locked')`, 3000)
  && (await gl())?.reward === 'Odměna „Posílání GIFů“ je aktivní', JSON.stringify(await gl()));
const sendG1 = posts.send.length;
await glClick('.uc-gl-i[data-id$="0c"] .uc-gl-pick');
check('G výběr → POST /chat/send s odkazem api.jouki.cz/media/gif/<id>, panel zavřený', await waitFor(() => posts.send.length > sendG1, 4000)
  && posts.send.at(-1).text.startsWith(murl(hex(12))) && await ev(`document.querySelector('.uc-ep').classList.contains('hidden')`) === true, JSON.stringify(posts.send.at(-1)));
check('G … zpráva s naším odkazem má kolečko průběhu (GIF odkaz)', await until(`[...document.querySelectorAll('.msg[data-msg-id^="sent-"]')].some(m => m.querySelector('.tx')?.textContent.includes('/media/gif/') && !!m.querySelector('.uc-gif-st'))`, 3000));
await ev(`document.getElementById('btn-emotes').click()`);
check('G po odeslání cooldown v hlavičce („Další GIF můžeš poslat za …“), výběr zamčený', await until(`/^Další GIF můžeš poslat za /.test(document.querySelector('.uc-ep-pane[data-pane="gif"] .uc-gl-reward-t')?.textContent || '')`, 3000), JSON.stringify(await gl()));
await ev(`document.getElementById('btn-emotes').click()`);
// Indikátor: konec odměny ze serveru → pásek pod tlačítkem emotů a na záložce, odpočet v hlavičce
mock.gifState = { ok: true, allowed: true, cooldownUntil: null, cooldownSec: 60, serverNow: SN, rewardUntil: SN + 300_000, rewardTotalMs: 600_000 };
await ev(`(async () => { window.ucGif.cd().reset(); await window.ucGif.cd().fetchState(); return true; })()`);
const ind = await ev(`(() => { const b = document.getElementById('btn-emotes'); const bar = b.querySelector('.uc-ep-btn-bar'); const tb = document.querySelector('.uc-ep-tab[data-tab="gif"] .uc-ep-tab-bar');
  return { timed: b.classList.contains('uc-ep-timed'), bar: !!bar && !bar.hidden && getComputedStyle(bar).display !== 'none', p: Number(b.style.getPropertyValue('--uc-ep-p')), tab: !!tb && !tb.hidden, tabP: Number(tb?.style.getPropertyValue('--p')) }; })()`);
check('G indikátor: pásek pod tlačítkem emotů i na záložce GIFy (≈ 50 %)', ind?.timed && ind.bar && ind.tab && Math.abs(ind.p - 0.5) < 0.02 && Math.abs(ind.tabP - 0.5) < 0.02, JSON.stringify(ind));
await ev(`document.getElementById('btn-emotes').click()`);
check('G odpočet odměny nahoře v záložce', await until(`/^Odměna ještě (5:00|4:5\\d)$/.test(document.querySelector('.uc-ep-pane[data-pane="gif"] .uc-gl-reward-t')?.textContent || '')`, 3000), JSON.stringify(await gl()));
await sleep(1200);
const ind2 = await ev(`Number(document.getElementById('btn-emotes').style.getPropertyValue('--uc-ep-p'))`);
check('G pásek ubývá s časem', ind2 < ind.p, `${ind.p} → ${ind2}`);
await ev(`document.getElementById('btn-emotes').click()`);

// ---- fáze G2 (mod): GIFy | Zamítnuté GIFy, duplikáty, odebrání z knihovny, token pro zamítnuté ----
mock.mod = true;
mock.gifState = { ok: true, allowed: true, cooldownUntil: null, cooldownSec: 0, serverNow: 1, mod: true };
mock.dups = [{ id: 4, channel: 'robdiesalot', score: 0.83, status: 'pending', createdAt: Date.now(), first: { ...LIB(11, ['cat']), status: 'approved' }, second: { ...LIB(14, []), status: 'rejected' } }];
mock.rejected = [15, 16].map((n) => ({ mediaId: hex(n), url: murl(hex(n)), kind: 'gif', width: 200, height: 100, rejectedAt: Date.now() - 86400000, rejectedBy: 'twitch:modik', vault: false, deleteAt: Date.now() + 13 * 86400000 }));
mock.rejMedia = new Set([hex(14), hex(15), hex(16)]);
mock.badTokens = new Set([`tk-${posts.token + 1}`]);   // první vydaný token „vypadl“ → 404 → klient si vyžádá nový
const goodTok = `tk-${posts.token + 2}`;
await boot();
await until(`document.body.classList.contains('uc-can-moderate')`);
await ev(`document.getElementById('btn-emotes').click()`);
await ev(`document.querySelector('.uc-ep-tab[data-tab="gif"]').click()`);
check('G2 mod: taby GIFy | Zamítnuté GIFy + „Možné duplikáty (1)“', await until(`!!document.querySelector('.uc-ep-pane[data-pane="gif"] .uc-gl-dups')`, 6000)
  && (await gl())?.tabs && (await gl()).dups === 'Možné duplikáty (1)', JSON.stringify(await gl()));
check('G2 náhled zamítnutého: 404 s prvním tokenem → nový token (POST access-token) → načteno', await until(`[...document.querySelectorAll('.uc-gl-dups img.uc-gif-media')].some(i => i.src.includes(${JSON.stringify(`t=${goodTok}`)}) && i.complete && i.naturalWidth > 0)`, 8000),
  JSON.stringify({ token: posts.token, tok: posts.mediaTok }));
check('G2 schválený GIF v duplikátu bez tokenu', await ev(`[...document.querySelectorAll('.uc-gl-dups img.uc-gif-media')].some(i => i.getAttribute('src') === ${JSON.stringify(murl(hex(11)))})`) === true);
check('G2 token jen v chrome.storage.session, ne v localStorage', await ev(`chrome.storage.session.get('uc_gif_token').then(r => r.uc_gif_token)`) === goodTok
  && await ev(`Object.keys(localStorage).every(k => !String(localStorage.getItem(k)).includes('tk-'))`) === true);
// Duplikát: 409 already_decided → skrýt a obnovit seznam
mock.dupAct = { code: 409, body: { ok: false, error: 'already_decided', status: 'kept_both' } };
const dupsGet = posts.dups.length;
mock.dups = [];
await glClick('.uc-gl-dup [data-act="keep-first"]');
check('G2 „Nechat první“ → POST keep-first; 409 → návrh pryč + nové načtení', await until(`!document.querySelector('.uc-ep-pane[data-pane="gif"] .uc-gl-dups')`, 4000)
  && posts.dupAct.some((x) => x.id === '4' && x.action === 'keep-first') && posts.dups.length > dupsGet, JSON.stringify({ act: posts.dupAct, dups: posts.dups.length }));
mock.dupAct = null;
// Odebrat z knihovny (unapprove) přes menu
await glClick('.uc-gl-i[data-id$="0b"] [data-act="menu"]');
check('G2 menu GIFu: Odebrat z knihovny / Trvale zahodit…', await ev(`[...document.querySelectorAll('.uc-gl-i[data-id$="0b"] .uc-gl-menu:not([hidden]) button')].map(b => b.textContent).join('|')`) === 'Odebrat z knihovny|Trvale zahodit…');
await glClick('.uc-gl-i[data-id$="0b"] [data-act="unapprove"]');
check('G2 Odebrat z knihovny → POST unapprove, GIF z knihovny pryč', await until(`!document.querySelector('.uc-gl-i[data-id$="0b"]')`, 4000) && posts.media.some((x) => x.id === hex(11) && x.action === 'unapprove'), JSON.stringify(posts.media));
// Trvale zahodit schválený: jen s potvrzením „Zmizí i ze starých zpráv“
await glClick('.uc-gl-i[data-id$="0c"] [data-act="menu"]');
await glClick('.uc-gl-i[data-id$="0c"] [data-act="purge-ask"]');
check('G2 Trvale zahodit… → potvrzení „Zmizí i ze starých zpráv.“', (await gl())?.confirm === 'Zmizí i ze starých zpráv.' && !posts.media.some((x) => x.id === hex(12)), JSON.stringify(await gl()));
await glClick('[data-act="confirm-yes"]');
check('G2 potvrzeno → POST purge', await until(`!document.querySelector('.uc-gl-i[data-id$="0c"]')`, 4000) && posts.media.some((x) => x.id === hex(12) && x.action === 'purge'));
// Zamítnuté GIFy
await glClick('[data-gl-tab="rej"]');
check('G2 Zamítnuté GIFy → GET rejected, 2 GIFy', await until(`document.querySelectorAll('.uc-gl-grid--rej .uc-gl-i').length === 2`, 5000) && posts.rejected.some((u) => /channel=robdiesalot/.test(u)), JSON.stringify(await gl()));
check('G2 zamítnuté náhledy s tokenem', await until(`[...document.querySelectorAll('.uc-gl-grid--rej img.uc-gif-media')].every(i => i.src.includes(${JSON.stringify(`t=${goodTok}`)}) && i.complete && i.naturalWidth > 0)`, 6000));
check('G2 kdo zamítl + kdy se smaže', /^Zamítl modik \(Twitch\) · smaže se za 13 dní$/.test(await ev(`document.querySelector('.uc-gl-grid--rej .uc-gl-meta').textContent`) || ''), await ev(`document.querySelector('.uc-gl-grid--rej .uc-gl-meta').textContent`));
check('G2 akce Schválit / Vault / Trvale zahodit', await ev(`[...document.querySelectorAll('.uc-gl-grid--rej .uc-gl-i')[0].querySelectorAll('.uc-gl-acts button')].map(b => b.textContent).join('|')`) === 'Schválit|Vault|Trvale zahodit');
await glClick('.uc-gl-grid--rej .uc-gl-i[data-id$="0f"] [data-act="vault"]');
check('G2 Vault → POST vault, „Ve vaultu“', await until(`document.querySelector('.uc-gl-grid--rej .uc-gl-i[data-id$="0f"] [data-act="vault"]')?.textContent === 'Ve vaultu'`, 4000) && posts.media.some((x) => x.id === hex(15) && x.action === 'vault'));
await glClick('.uc-gl-grid--rej .uc-gl-i[data-id$="10"] [data-act="approve"]');
check('G2 Schválit → POST approve, pryč ze zamítnutých', await until(`!document.querySelector('.uc-gl-grid--rej .uc-gl-i[data-id$="10"]')`, 4000) && posts.media.some((x) => x.id === hex(16) && x.action === 'approve'));
await glClick('.uc-gl-grid--rej .uc-gl-i[data-id$="0f"] [data-act="purge-ask"]');
check('G2 Trvale zahodit zamítnutý → potvrzení', (await gl())?.confirm === 'GIF se smaže natrvalo, nejde vrátit.');
await glClick('[data-act="confirm-yes"]');
check('G2 … POST purge', await until(`!document.querySelector('.uc-gl-grid--rej .uc-gl-i')`, 4000) && posts.media.some((x) => x.id === hex(15) && x.action === 'purge'));
await ev(`document.getElementById('btn-emotes').click()`);

// ---- fáze E (mod + Dev mód): schvalování jako divák ----
mock.mod = true;
mock.gifState = () => ({ ok: true, allowed: true, cooldownUntil: null, cooldownSec: 60, serverNow: SN });
await ev(`chrome.storage.sync.get('uc_config').then((r) => chrome.storage.sync.set({ uc_config: { ...(r.uc_config || {}), devMode: true } })).then(() => true)`);
const stE = posts.state.length;
await boot();
await until(`document.body.classList.contains('uc-can-moderate')`);
await typeIn('dev https://tenor.com/view/cat-gif-1');
check('E Dev mód moda → GET /gif/state s review=1', await waitFor(() => posts.state.slice(stE).some((u) => u.includes('review=1')), 5000), posts.state.slice(stE).join(' | '));
const sendE = posts.send.length;
await clickSend();
check('E Dev mód moda → POST /chat/send s gifReview: true', await waitFor(() => posts.send.length > sendE) && posts.send.at(-1).gifReview === true, JSON.stringify(posts.send.at(-1)));
await ev(`chrome.storage.sync.get('uc_config').then((r) => chrome.storage.sync.set({ uc_config: { ...(r.uc_config || {}), devMode: false } })).then(() => true)`);

console.log(`\n${pass} PASS, ${fail} FAIL`);
finish(fail ? 1 : 0);
