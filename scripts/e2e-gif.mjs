// E2E (headless Chrome + CDP): odměna „Posílání GIFů" (moderace část 4) v addonu.
//  A (mod): GIF z historie (img 400×225, lazy), chyba média → „GIF odebrán“ (bez odkazu), gif_removed z historie, GET /moderation/gif/pending → karta,
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
  // Závěrečná review I2: GIF odebraný z knihovny → server ho v historii pošle jako smazaný (gif_removed) bez média.
  H('gif-9', 'Divak', 'u9', '', 6.5, { deleted: true, deletedReason: 'gif_removed' }),
  // Stažený GIF se smazaným souborem (2026-09-27): zpráva zůstává s textem, místo GIFu štítek „[GIF nedostupný]“.
  H('gif-10', 'Divak', 'u9', 'text nad nedostupným', 6.7, { gif: { url: murl(hex(20)), kind: 'gif', width: 100, height: 50, unavailable: true } }),
  // Nový GIF v režimu „jen schválené“ (gif_not_allowed, user 2026-09-27 v2): všem v UnityChatu (odesílatel i ostatní)
  // smazaná zpráva + červený štítek „Nové GIFy teď nejsou povolené“ místo „Smazáno“; OBS nic.
  H('e2e-na-h', 'Divak', 'u9', '', 6.8, { deleted: true, deletedReason: 'gif_not_allowed' }),
  H('e2e-na-hown', 'ModUser', 'u7', '', 6.9, { deleted: true, deletedReason: 'gif_not_allowed' }),
  // Vlastní zamítnutý GIF z historie: odesílatel (i mod) štítek bez „Smazáno“, ostatní dál smazanou (user 2026-09-27).
  H('e2e-rej-own', 'ModUser', 'u7', '', 6.95, { deleted: true, deletedReason: 'gif_rejected' }),
  H('e2e-a2', 'Tester', 'u1', 'po GIFech', 7),
];
const mock = { modUser: null, mod: true, sse: [], acc: [], heldAcc: null, decide: {}, held: {}, sendId: null,   // decide[id] = { code, body }; held[id] = odpověď /gif/held
  library: [], libHold: false, libHeld: [], dups: [], dupAct: null, rejected: [], rejMedia: new Set(), badTokens: new Set(), wd: [], pg: [], byId: [] };
const posts = { modUser: [], decide: [], pending: [], tickets: 0, auth: [], send: [], state: [], held: [], token: 0, rejected: [], dupAct: [], dups: [], media: [], library: [], mediaTok: [], disc: [], byId: [] };
// Stažení GIFu prohlížečem (Task 12): POST /gif/client-upload → { token, remember, bytes (přesně z postDataEntries,
// `postData` string mangluje bajty nad 127) }, POST /gif/client-fetch/decline → { token, remember }.
const uploads = [], declines = [];
// Malý MP4 buffer (jen platný `ftyp` box header, obsah je jedno — mock uploadu přijme cokoli), > 100 bajtů ať sedí
// check na velikost uploadu.
const MP4_BUF = (() => { const b = Buffer.alloc(256, 0); b.write('ftypmp42', 4); return b; })();
mock.gifState = () => ({ ok: true, allowed: true, cooldownUntil: null, cooldownSec: 0, serverNow: Date.now() });
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
  // Binární tělo (client-upload) není platný JSON — bezpečný parse (nikdy nehodit výjimku uvnitř handleru).
  const body = q.postData ? (() => { try { return JSON.parse(q.postData); } catch { return null; } })() : null;
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
  if (u.includes('/auth/me')) return json({ ok: true, accountId: 7, platforms: { twitch: { login: mock.meLogin || 'moduser', displayName: mock.meLogin || 'ModUser' }, kick: null, youtube: null }, warnings: [], gifClientFetch: 'ask' });
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
  // Zahozené GIFy (2026-09-27): Stažené / Ke smazání.
  if (u.includes('/moderation/gif/withdrawn')) { posts.disc.push(u); return json({ ok: true, items: mock.wd, nextBefore: null }); }
  if (u.includes('/moderation/gif/purging')) { posts.disc.push(u); return json({ ok: true, items: mock.pg, nextBefore: null }); }
  const ma = u.match(/\/moderation\/gif\/([0-9a-f]{32})\/(approve|vault|purge|ban12h|unapprove|restore|remove-file)/);
  if (ma) {
    posts.media.push({ id: ma[1], action: ma[2], body });
    if (ma[2] === 'ban12h') return json({ ok: true, mediaId: ma[1], bannedUntil: Date.now() + 43200000, rejected: 1 });
    if (ma[2] === 'purge') return json({ ok: true, mediaId: ma[1], action: 'purge', status: body?.keepMessages ? 'withdrawn' : 'purging' });
    if (ma[2] === 'restore') return json({ ok: true, mediaId: ma[1], action: 'restore', status: 'approved' });
    if (ma[2] === 'remove-file') return json({ ok: true, mediaId: ma[1], action: 'remove-file', status: 'unavailable' });
    return json({ ok: true, mediaId: ma[1], action: ma[2] });
  }
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
  // Zamítnout + trest z karty (2026-09-27 §2) → stávající moderace uživatele.
  if (u.includes('/moderation/user') && !u.includes('/moderation/user-')) {
    posts.modUser.push(body);
    const r = mock.modUser;
    if (r) return json(r.body, r.code);
    return json({ ok: true, results: { twitch: 'ok' } });
  }
  if (u.includes('/chat/send')) { posts.send.push(body); return json({ ok: true, id: mock.sendId || 'x' }); }
  if (u.includes('/gif/state')) { posts.state.push(u); return json(typeof mock.gifState === 'function' ? mock.gifState() : mock.gifState); }
  if (u.includes('/gif/held')) {
    posts.held.push(u);
    const ids = decodeURIComponent(new URL(u).searchParams.get('ids') || '').split(',').filter(Boolean);
    return json({ ok: true, messages: ids.map((k) => { const [platform, messageId] = k.split(':'); return mock.held[messageId] ? { platform, messageId, ...mock.held[messageId] } : { platform, messageId, state: 'held' }; }) });
  }
  if (u.includes('/chat/history')) return json({ ok: true, messages: u.includes('before=') ? [] : H1, nextBefore: null });
  // Zprávy podle id (po SSE gif-media visible klient dotáhne obsah).
  if (u.includes('/chat/messages')) { posts.byId.push(u); return json({ ok: true, messages: mock.byId }); }
  // Stažení GIFu prohlížečem (core/gif-client-fetch.js, spec 2026-09-29): fetch() z prohlížeče na hostitele média,
  // pak upload bajtů s tokenem; „Ne“ pošle decline; předvolba účtu jde přes PUT /account/gif-prefs.
  if (u.includes('i.imgur.com')) return call('Fetch.fulfillRequest', { requestId: rid, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: MP4_BUF.toString('base64') }, sid);
  if (u.includes('/gif/client-upload')) {
    const tok = q.headers['X-Gif-Token'] || q.headers['x-gif-token'] || '';
    const remember = q.headers['X-Gif-Remember'] || q.headers['x-gif-remember'] || '';
    const bytes = (q.postDataEntries || []).reduce((n, e) => n + Buffer.from(e.bytes, 'base64').length, 0);
    uploads.push({ token: tok, remember, bytes });
    return json({ ok: true }, 202);
  }
  if (u.includes('/gif/client-fetch/decline')) { declines.push({ token: body?.token, remember: body?.remember }); return json({ ok: true }); }
  if (u.includes('/account/gif-prefs')) return json({ ok: true, clientFetch: body?.clientFetch });
  return call('Fetch.continueRequest', { requestId: rid }, sid);
};
await call('Fetch.enable', { patterns: [...['/auth/me', '/moderation/', '/chat/history', '/chat/messages', '/chat/send', '/nicknames/stream', '/account/', '/media/gif/', '/gif/state', '/gif/held', '/gif/client-upload', '/gif/client-fetch', '/gifs/'].map((p) => ({ urlPattern: `*api.jouki.cz${p}*` })), { urlPattern: '*i.imgur.com*' }] }, sessionId);
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
check('A GIF s prázdným textem se nezahodí + chyba média (404) → štítek „GIF odebrán“ bez odkazu', await until(`document.querySelector('.msg[data-msg-id="gif-6"] .uc-gif-fallback')?.textContent === 'GIF odebrán'`, 5000)
  && await ev(`!document.querySelector('.msg[data-msg-id="gif-6"] .uc-gif a') && document.querySelector('.msg[data-msg-id="gif-6"] .uc-gif-fallback').tagName`) === 'SPAN');
const g9 = await ev(`(() => { const m = document.querySelector('.msg[data-msg-id="gif-9"]'); if (!m) return null; return { deleted: m.classList.contains('uc-deleted'), held: m.classList.contains('uc-gif-held'), gif: !!m.querySelector('.uc-gif'), shown: getComputedStyle(m).display !== 'none' }; })()`);
check('A I2 gif_removed z historie → smazaná zpráva bez média (mod ji vidí jako smazanou, ne schovanou)', g9?.deleted && !g9.held && !g9.gif && g9.shown, JSON.stringify(g9));

const g10 = await ev(`(() => { const m = document.querySelector('.msg[data-msg-id="gif-10"]'); if (!m) return null; return { text: m.querySelector('.tx')?.textContent, label: m.querySelector('.uc-gif--unavailable .uc-gif-fallback')?.textContent, img: !!m.querySelector('.uc-gif-media'), deleted: m.classList.contains('uc-deleted') }; })()`);
check('A historie: stažený GIF bez souboru → text zůstává, místo GIFu „[GIF nedostupný]“, nic se nenačítá', g10?.text === 'text nad nedostupným' && g10.label === '[GIF nedostupný]' && !g10.img && !g10.deleted
  && await ev(`![...performance.getEntriesByType('resource')].some(e => e.name.includes(${JSON.stringify(hex(20))}))`) === true, JSON.stringify(g10));
// GET pending (mod) → karta 20 (FIFO: jen nejstarší čekající)
check('A GET /moderation/gif/pending s kanálem', await until(`true`, 10) && posts.pending.some((x) => /pending\?channel=robdiesalot$/.test(x)), posts.pending.join(' | '));
check('A karta z GET pending', await until(`!!document.querySelector('.uc-gif-card[data-request-id="20"]')`, 5000));
const c20a = await card(20);
check('A nová karta: tlačítka 1 s zamčená (aktualizace fronty)', c20a?.disabled === true && c20a.cls.includes('uc-gif-card--locked'), JSON.stringify(c20a));
check('A … po 1 s odemčená', await until(`(() => { const c = document.querySelector('.uc-gif-card[data-request-id="20"]'); return !!c && [...c.querySelectorAll('.uc-gif-btn--approve, .uc-gif-btn--reject')].every(b => !b.disabled); })()`, 2000));
const c20 = await card(20);
check('A karta: jméno, text, náhled, odpočet, tlačítka, u spodku chatu', c20?.who === 'divak20' && c20.text === 'z GET pending' && c20.media && /^[45]:\d\d$/.test(c20.timer || '') && JSON.stringify(c20.buttons) === '["Zamítnout","▾","Schválit"]' && c20.inWrapper && c20.kind === 'Chce poslat GIF' && !c20.prev, JSON.stringify(c20));

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
await sleep(350);   // panel z nuly vyroste z tlačítka (animace otevření, spec 2026-09-27 §1)
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
check('A … „Dříve zamítnuto … · modik (Twitch)“ + „Automaticky zahazovat 12 h“', /^Dříve zamítnuto .+ · modik \(Twitch\)$/.test(c26?.prev || '') && JSON.stringify(c26.buttons) === '["Automaticky zahazovat 12 h","Zamítnout","▾","Schválit"]', JSON.stringify(c26));
await click(26, 'ban12h');
check('A „Automaticky zahazovat 12 h“ → POST /moderation/gif/<médium>/ban12h, karta pryč', await until(`!document.querySelector('.uc-gif-card[data-request-id="26"]')`, 4000) && posts.media.some((x) => x.id === MEDIA.card && x.action === 'ban12h'), JSON.stringify(posts.media));

// Zamítnout + trest (spec 2026-09-27-gif-review-upravy §2): split ▾ → timeout (výchozí 10 min / vlastní délka), permaban s potvrzením.
const waitUnlocked = () => until(`!window.ucGif.gifs().locked && !document.querySelector('.uc-gif-card [data-act="approve"]:disabled')`, 2500);
const rmenu = (id) => ev(`(() => { const c = document.querySelector('.uc-gif-card[data-request-id="${id}"]'); const m = c?.querySelector('.uc-gif-rmenu'); if (!m) return null;
  return { open: !m.hidden && getComputedStyle(m).display !== 'none', value: m.querySelector('.uc-gif-rmenu-num').value, unit: m.querySelector('.uc-mm-unit[aria-pressed="true"]')?.dataset.unit,
    expanded: c.querySelector('.uc-gif-split-more').getAttribute('aria-expanded'), moreHidden: c.querySelector('.uc-gif-split-more').hidden,
    disabled: [...m.querySelectorAll('button, input')].every(b => b.disabled), label: m.querySelector('.uc-gif-rmenu-label').textContent, ban: m.querySelector('[data-act="reject-ban"]').textContent }; })()`);
pushAcc(['gif-pending', pend0(30)], ['gif-pending', pend0(31)], ['gif-pending', pend0(32)], ['gif-pending', pend0(33)], ['gif-queue', { channel: 'robdiesalot', pendingCount: 4, headId: 30 }]);
check('P karta 30', await until(`!!document.querySelector('.uc-gif-card[data-request-id="30"]')`, 12000));
const m30a = await rmenu(30);
check('P nabídka trestu je zavřená, během zámku 1 s zamčená i ona', m30a && !m30a.open && m30a.expanded === 'false' && m30a.disabled && !m30a.moreHidden, JSON.stringify(m30a));
await waitUnlocked();
await click(30, 'reject-more');
const m30 = await rmenu(30);
check('P ▾ → „Zamítnout + timeout“ [10] [m] + „Zamítnout + permaban…“', m30?.open && m30.expanded === 'true' && m30.value === '10' && m30.unit === 'm' && !m30.disabled
  && m30.label === 'Zamítnout + timeout' && m30.ban === 'Zamítnout + permaban…', JSON.stringify(m30));
check('P … fokus v poli délky', await ev(`document.activeElement?.classList.contains('uc-gif-rmenu-num')`) === true);
await ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
check('P Esc nabídku zavře', (await rmenu(30))?.open === false);
await click(30, 'reject-more');
const dec30 = posts.decide.length;
await click(30, 'reject-timeout');
check('P Zamítnout + timeout → POST decide approve:false', await until(`true`, 10) && await (async () => { const t = Date.now(); while (Date.now() - t < 4000) { if (posts.decide.length > dec30) return true; await sleep(100); } return false; })()
  && posts.decide.at(-1).id === '30' && posts.decide.at(-1).body?.approve === false, JSON.stringify(posts.decide.at(-1)));
check('P … pak POST /moderation/user timeout 600 s pro odesílatele', await (async () => { const t = Date.now(); while (Date.now() - t < 4000) { if (posts.modUser.length) return true; await sleep(100); } return false; })()
  && JSON.stringify(posts.modUser[0]) === JSON.stringify({ channel: 'robdiesalot', platform: 'twitch', userId: 'u30', login: 'divak30', action: 'timeout', durationSec: 600 }), JSON.stringify(posts.modUser));
check('P … hláška „Zamítnuto · Timeout 10 min pro divak30: …“, další karta 31', await until(`(document.querySelector('.uc-gif-notice:not([hidden])')?.textContent || '').startsWith('Zamítnuto · Timeout 10 min pro divak30') && !!document.querySelector('.uc-gif-card[data-request-id="31"]')`, 4000), JSON.stringify(await stack()));

// Vlastní délka 2 h + chyba moderace → hláška, zamítnutí platí.
await waitUnlocked();
mock.modUser = { code: 403, body: { ok: false, error: 'target_protected' } };
await click(31, 'reject-more');
await ev(`(() => { const c = document.querySelector('.uc-gif-card[data-request-id="31"]'); c.querySelector('.uc-gif-rmenu-num').value = '2'; c.querySelector('.uc-mm-unit[data-unit="h"]').click(); return true; })()`);
check('P jednotka h zvolená (aria-pressed)', (await rmenu(31))?.unit === 'h');
await click(31, 'reject-timeout');
check('P vlastní délka 2 h → durationSec 7200', await (async () => { const t = Date.now(); while (Date.now() - t < 4000) { if (posts.modUser.length > 1) return true; await sleep(100); } return false; })() && posts.modUser[1].durationSec === 7200 && posts.modUser[1].userId === 'u31', JSON.stringify(posts.modUser[1]));
check('P chyba moderace → „Zamítnuto, ale timeout se nepovedl: …“, zamítnutí platí (karta 32)', await until(`document.querySelector('.uc-gif-notice:not([hidden])')?.textContent === 'Zamítnuto, ale timeout se nepovedl: Na streamera nebo moda to nejde.' && !!document.querySelector('.uc-gif-card[data-request-id="32"]')`, 4000)
  && posts.decide.some((x) => x.id === '31' && x.body?.approve === false), JSON.stringify(await stack()));
mock.modUser = null;

// Neplatná délka (0) → nic neodejde.
await waitUnlocked();
await click(32, 'reject-more');
const decBad = posts.decide.length;
await ev(`(() => { const i = document.querySelector('.uc-gif-card[data-request-id="32"] .uc-gif-rmenu-num'); i.value = '999'; document.querySelector('.uc-gif-card[data-request-id="32"] .uc-mm-unit[data-unit="h"]').click(); return true; })()`);
await click(32, 'reject-timeout');
await sleep(300);
check('P délka nad 14 dní → nic neodejde, pole zčervená', posts.decide.length === decBad && await ev(`document.querySelector('.uc-gif-card[data-request-id="32"] .uc-gif-rmenu-row').classList.contains('uc-mm-custom--bad')`) === true);

// Permaban: potvrzovací dialog; Zrušit = nic, potvrdit = zamítnout + ban.
await click(32, 'reject-ban');
check('P permaban → dialog „Trvale zabanovat divak32 na Twitchi?“', await until(`document.querySelector('.uc-mod-dialog h2')?.textContent === 'Trvale zabanovat divak32 na Twitchi?'`, 2000));
await ev(`[...document.querySelectorAll('.uc-mod-dialog button')].find(b => b.textContent === 'Zrušit').click()`);
await sleep(200);
check('P Zrušit → nic neodejde, karta zůstává', !posts.decide.some((x) => x.id === '32') && await ev(`!document.querySelector('.uc-mod-dialog') && !!document.querySelector('.uc-gif-card[data-request-id="32"]')`) === true);
await click(32, 'reject-ban');
await until(`!!document.querySelector('.uc-mod-dialog')`, 2000);
await ev(`document.querySelector('.uc-mod-dialog button[type=submit]').click()`);
check('P potvrzeno → decide zamítnout + POST /moderation/user ban', await (async () => { const t = Date.now(); while (Date.now() - t < 4000) { if (posts.modUser.length > 2) return true; await sleep(100); } return false; })()
  && posts.decide.some((x) => x.id === '32' && x.body?.approve === false) && posts.modUser[2].action === 'ban' && posts.modUser[2].userId === 'u32' && posts.modUser[2].durationSec === undefined, JSON.stringify(posts.modUser[2]));
check('P … dialog zavřený, hláška „Zamítnuto · Ban pro divak32: …“', await until(`!document.querySelector('.uc-mod-dialog') && (document.querySelector('.uc-gif-notice:not([hidden])')?.textContent || '').startsWith('Zamítnuto · Ban pro divak32')`, 4000), JSON.stringify(await stack()));

// O GIFu rozhodl jiný mod dřív (409) → trest se neprovede.
await until(`!!document.querySelector('.uc-gif-card[data-request-id="33"]')`, 4000);
await waitUnlocked();
mock.decide['33'] = { code: 409, body: { ok: false, error: 'already_decided', status: 'approved', decidedBy: 'twitch:modik' } };
const mu33 = posts.modUser.length;
await click(33, 'reject-more');
await click(33, 'reject-timeout');
check('P 409 → „Už rozhodl modik (Twitch) — trest se neprovedl“, bez /moderation/user', await until(`document.querySelector('.uc-gif-notice:not([hidden])')?.textContent === 'Už rozhodl modik (Twitch) — trest se neprovedl'`, 4000) && posts.modUser.length === mu33, JSON.stringify(await stack()));
// Vlastní GIF (mod v Dev módu) bez ▾.
pushAcc(['gif-pending', pend0(34, { own: true })], ['gif-queue', { channel: 'robdiesalot', pendingCount: 1, headId: 34 }]);
check('P vlastní GIF → bez ▾', await until(`!!document.querySelector('.uc-gif-card[data-request-id="34"]')`, 12000) && (await rmenu(34))?.moreHidden === true);
pushAcc(['gif-decided', { requestId: 34, channel: 'robdiesalot', approved: false, status: 'rejected', by: 'twitch:jinymod' }], ['gif-queue', { channel: 'robdiesalot', pendingCount: 0, headId: null }]);
await until(`!document.querySelector('.uc-gif-card')`, 12000);

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
// Vrácený uzel do záběru (víc zpráv v historii ho jinak může nechat pod okrajem → IO ho správně nespustí).
await ev(`(() => { window.__vid = []; document.getElementById('chat').appendChild(window.__parked); window.__parked.scrollIntoView({ block: 'center' }); return true; })()`);
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
// Kolo 4 bod 3: „GIF odebrán“ i „[GIF nedostupný]“ = stejně nastylovaný štítek, čerstvý stav i po „Odkrýt zprávu“ (message-restored).
const pill = (id) => ev(`(() => { const f = document.querySelector('.msg[data-msg-id="${id}"] .uc-gif-fallback'); if (!f) return null; const cs = getComputedStyle(f); const m = f.closest('.msg');
  return { t: f.textContent, removed: !!f.closest('.uc-gif--removed'), unavailable: !!f.closest('.uc-gif--unavailable'), border: cs.borderTopStyle, radius: cs.borderTopLeftRadius, italic: cs.fontStyle, op: cs.opacity, deleted: m.classList.contains('uc-deleted'), img: !!m.querySelector('.uc-gif-media') }; })()`);
const p6 = await pill('gif-6'), p10 = await pill('gif-10');
check('A štítek „GIF odebrán“ (404) vypadá stejně jako „[GIF nedostupný]“ (rámeček, bez kurzívy)', p6?.t === 'GIF odebrán' && p6.removed && p10?.unavailable && p6.border === p10.border && p6.border === 'dashed' && p6.italic === p10.italic && p6.italic === 'normal' && p6.radius === p10.radius && p6.op === p10.op, JSON.stringify({ p6, p10 }));
mock.sse.push(['message-restored', { channel: 'robdiesalot', platform: 'twitch', messageId: 'gif-9', by: 'twitch:modik', message: { platform: 'twitch', id: 'gif-9', username: 'Divak', userId: 'u9', message: 'odkrytá s odebraným', timestamp: Date.now(), color: '#1e90ff', gif: { url: murl(hex(22)), kind: 'gif', width: 100, height: 50, removed: true } } }]);
check('A odkrytá zpráva s odebraným GIFem (removed) → štítek „GIF odebrán“ jako čerstvý, nic se nenačítá', await until(`document.querySelector('.msg[data-msg-id="gif-9"] .uc-gif--removed .uc-gif-fallback')?.textContent === 'GIF odebrán'`, 6000)
  && await (async () => { const p = await pill('gif-9'); return !p.deleted && !p.img && p.border === p10.border && p.italic === p10.italic && p.radius === p10.radius; })()
  && await ev(`![...performance.getEntriesByType('resource')].some(e => e.name.includes(${JSON.stringify(hex(22))}))`) === true, JSON.stringify(await pill('gif-9')));
// Smazání zprávy s GIFem: výška se mění plynule (core/height-anim.js), ne skokem — vzorkování výšky po snímcích.
await ev(`(() => { const el = document.querySelector('.msg[data-msg-id="gif-10"]'); window._hs = []; const tick = () => { if (el.isConnected) window._hs.push(Math.round(el.getBoundingClientRect().height)); if (window._hs.length < 400) requestAnimationFrame(tick); }; requestAnimationFrame(tick); return true; })()`);
mock.sse.push(['message-deleted', { channel: 'robdiesalot', platform: 'twitch', messageId: 'gif-10', by: 'twitch:jinymod' }]);
await until(`(() => { const m = document.querySelector('.msg[data-msg-id="gif-10"]'); return !!m && m.classList.contains('uc-deleted') && !m.querySelector('.uc-gif'); })()`, 6000);
await sleep(400);
{
  const hs = await ev(`(() => { const a = window._hs; window._hs = { length: 9999 }; return a; })()`);
  const h0 = hs?.[0] ?? 0, h1 = hs?.[hs.length - 1] ?? 0;
  let maxDrop = 0; for (let i = 1; i < (hs?.length || 0); i++) maxDrop = Math.max(maxDrop, hs[i - 1] - hs[i]);
  check('A message-deleted gif-10 → zpráva se zmenší plynule (největší skok < 1/3 výšky), ne naráz', hs && h0 > h1 + 20 && maxDrop < h0 / 3, JSON.stringify({ h0, h1, maxDrop, n: hs?.length }));
}
mock.sse.push(['message-restored', { channel: 'robdiesalot', platform: 'twitch', messageId: 'gif-10', by: 'twitch:modik', message: { platform: 'twitch', id: 'gif-10', username: 'Divak', userId: 'u9', message: 'text nad nedostupným', timestamp: Date.now(), color: '#1e90ff', gif: { url: murl(hex(20)), kind: 'gif', width: 100, height: 50, unavailable: true } } }]);
check('A odkrytá zpráva s nedostupným GIFem (unavailable) → štítek „[GIF nedostupný]“ jako čerstvý', await until(`(() => { const m = document.querySelector('.msg[data-msg-id="gif-10"]'); return !!m && !m.classList.contains('uc-deleted') && m.querySelector('.uc-gif--unavailable .uc-gif-fallback')?.textContent === '[GIF nedostupný]'; })()`, 6000), JSON.stringify(await pill('gif-10')));


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
// Mod (bez Dev módu) s odemčenou odměnou bez cooldownu píše GIF: bez bubliny, odeslání bez gifReview.
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

// ---- gif_not_allowed (nové GIFy nejsou povolené, user 2026-09-27) ----
const NA_TEXT = 'Nové GIFy teď nejsou povolené';
const naView = (id) => ev(`(() => { const m = document.querySelector('.msg[data-msg-id="${id}"]'); if (!m) return null; const s = m.querySelector('.uc-gif-st');
  return { shown: getComputedStyle(m).display !== 'none' && !m.hidden, deleted: m.classList.contains('uc-deleted'), tag: m.querySelector('.uc-deleted-tag')?.textContent || null,
    label2: m.querySelector('.tx .uc-deleted-label')?.textContent || null, kind: s?.dataset.kind || null, label: s?.querySelector('.uc-gif-st-txt')?.textContent || null,
    link: !!m.querySelector('.tx a[href]'), text: m.querySelector('.tx')?.textContent || '', op: Number(getComputedStyle(m.querySelector('.tx')).opacity),
    color: s ? getComputedStyle(s).color : null }; })()`);
// Odesílatel (divák i mod), konečný červený stav (nepovolené / zamítnuto / vypršelo): text (bez odkazu, mírně ztlumený)
// + červený štítek, bez vzhledu smazané zprávy a bez „Smazáno“ (user 2026-09-27).
const ownMuted = (o, kind, label, withText = true) => !!o && o.shown && !o.deleted && !o.tag && !o.label2 && o.kind === kind && o.label === label && !o.link
  && o.op < 1 && o.op > 0.3 && /rgb\(255, 138, 142\)/.test(o.color) && (!withText || /https?:\/\//.test(o.text));
// gif_not_allowed (user 2026-09-27 v2): všem smazaná zpráva (divák „Zpráva smazána“, mod svůj styl — s textem „Zašedlé“)
// + červený štítek místo „Smazáno“, odkaz neživý.
const naDel = (o, { text = false } = {}) => !!o && o.shown && o.deleted && !o.tag && o.kind === 'not_allowed' && o.label === NA_TEXT && !o.link
  && /rgb\(255, 138, 142\)/.test(o.color) && (text ? !o.label2 && /https?:\/\//.test(o.text) : o.label2 === 'Zpráva smazána');
check('A gif_rejected vlastní z historie (mod, „Zašedlé“) → štítek „Zamítnuto moderátorem“ bez „Smazáno“ / „Zpráva smazána“', await until(`document.querySelector('.msg[data-msg-id="e2e-rej-own"] .uc-gif-st')?.dataset.kind === 'rejected'`, 5000)
  && ownMuted(await naView('e2e-rej-own'), 'rejected', 'Zamítnuto moderátorem', false), JSON.stringify(await naView('e2e-rej-own')));
check('A gif_rejected cizí z historie → mod ji dál vidí jako smazanou', await (async () => { const o = await naView('e2e-rej'); return !!o && o.shown && o.deleted && o.tag === 'Smazáno'; })(), JSON.stringify(await naView('e2e-rej')));
check('A gif_not_allowed cizí z historie → mod: „Zpráva smazána“ (bez obsahu) + štítek, bez „Smazáno“', naDel(await naView('e2e-na-h')), JSON.stringify(await naView('e2e-na-h')));
check('A gif_not_allowed vlastní z historie (mod) → totéž co ostatní: „Zpráva smazána“ + štítek', await until(`document.querySelector('.msg[data-msg-id="e2e-na-hown"] .uc-gif-st')?.dataset.kind === 'not_allowed'`, 5000)
  && naDel(await naView('e2e-na-hown')), JSON.stringify(await naView('e2e-na-hown')));
// Živě: cizí zpráva s odkazem → message-deleted gif_request → gif_not_allowed (jako backend).
const NAMSG = (id, user, userId, text) => ['message-restored', { channel: 'robdiesalot', platform: 'twitch', messageId: id, by: 'filter', message: { platform: 'twitch', id, username: user, userId, message: text, timestamp: Date.now(), color: '#1e90ff' } }];
mock.sse.push(NAMSG('e2e-na-live', 'Divak', 'u9', 'cizí https://tenor.com/view/na-gif-1'));
await until(`!!document.querySelector('.msg[data-msg-id="e2e-na-live"]')`, 8000);
mock.sse.push(['message-deleted', { channel: 'robdiesalot', platform: 'twitch', messageId: 'e2e-na-live', by: 'filter', reason: 'gif_request' }],
  ['message-deleted', { channel: 'robdiesalot', platform: 'twitch', messageId: 'e2e-na-live', by: 'filter', reason: 'gif_not_allowed' }]);
check('A gif_not_allowed cizí živě → mod: zašedlý text (výchozí „Zašedlé“) bez odkazu + štítek, bez „Smazáno“', await until(`document.querySelector('.msg[data-msg-id="e2e-na-live"] .uc-gif-st')?.dataset.kind === 'not_allowed'`, 8000)
  && naDel(await naView('e2e-na-live'), { text: true }), JSON.stringify(await naView('e2e-na-live')));
await sleep(300);
check('A … i po ozvěně smazání z platformy (CLEARMSG bez důvodu, message-deleted platform) pořád se štítkem', await (async () => { await ev(`window.ucGif.applyDeleted('twitch', 'e2e-na-live')`); await ev(`window.ucGif.applyDeleted('twitch', 'e2e-na-live', { reason: 'platform' })`); return naDel(await naView('e2e-na-live'), { text: true }); })(), JSON.stringify(await naView('e2e-na-live')));
// GIF bez odměny (gif_denied, 2026-09-28): všem smazaná zpráva se štítkem „GIF teď není možné poslat“, odkaz neživý.
mock.sse.push(NAMSG('e2e-den-live', 'Divak2', 'u10', 'bez odmeny https://tenor.com/view/den-gif-1'));
await until(`!!document.querySelector('.msg[data-msg-id="e2e-den-live"]')`, 8000);
mock.sse.push(['message-deleted', { channel: 'robdiesalot', platform: 'twitch', messageId: 'e2e-den-live', by: 'filter', reason: 'gif_denied' }]);
check('A gif_denied cizí živě → smazaná + štítek „GIF teď není možné poslat“, bez odkazu a bez „Smazáno“', await until(`document.querySelector('.msg[data-msg-id="e2e-den-live"] .uc-gif-st')?.dataset.kind === 'denied'`, 8000)
  && await (async () => { const o = await naView('e2e-den-live'); return !!o && o.shown && o.deleted && !o.tag && o.label === 'GIF teď není možné poslat' && !o.link && /rgb\(255, 138, 142\)/.test(o.color); })(), JSON.stringify(await naView('e2e-den-live')));
check('A gif_denied i po ozvěně smazání z platformy pořád se štítkem', await (async () => { await ev(`window.ucGif.applyDeleted('twitch', 'e2e-den-live', { reason: 'platform' })`); const o = await naView('e2e-den-live'); return !!o && o.kind === 'denied' && !o.link; })(), JSON.stringify(await naView('e2e-den-live')));
// Vlastní zpráva moda: gif-notice approved_only + message-deleted gif_not_allowed → smazaná podle stylu + štítek.
mock.sse.push(NAMSG('e2e-na-mown', 'ModUser', 'u7', 'moje https://tenor.com/view/na-gif-2'));
await until(`!!document.querySelector('.msg[data-msg-id="e2e-na-mown"]')`, 8000);
pushAcc(['gif-notice', { requestKey: 'twitch:e2e-na-mown', channel: 'robdiesalot', platform: 'twitch', messageId: 'e2e-na-mown', kind: 'approved_only' }]);
mock.sse.push(['message-deleted', { channel: 'robdiesalot', platform: 'twitch', messageId: 'e2e-na-mown', by: 'filter', reason: 'gif_not_allowed' }]);
check('A gif_not_allowed vlastní živě (mod) → zašedlý text bez odkazu + štítek, bez „Smazáno“', await until(`document.querySelector('.msg[data-msg-id="e2e-na-mown"] .uc-gif-st')?.dataset.kind === 'not_allowed' && !!document.querySelector('.msg[data-msg-id="e2e-na-mown"].uc-deleted')`, 12000)
  && naDel(await naView('e2e-na-mown'), { text: true }), JSON.stringify(await naView('e2e-na-mown')));

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

// Streamer (2026-09-28): karta zabalená do záložky ⌃⌃ jen při čekajících GIFech, rozbalení / zabalení, GIF rozmazaný, klik zaostří.
const coreStreamer = await ev(`(async () => {
  let T = 1000; let streamer = true; const box = document.createElement('div'); document.body.appendChild(box);
  const g = new window.UC_CORE.GifRequests({ doc: document, container: box, now: () => T, channel: () => 'robdiesalot', canModerate: () => true, streamer: () => streamer,
    api: async () => ({ ok: true, status: 'approved' }), setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {} });
  const P = (id, c) => ({ requestId: id, channel: 'robdiesalot', platform: 'twitch', login: 'x', userId: 'u', messageId: 'm' + id, text: '', media: { url: ${JSON.stringify(murl(MEDIA.card))}, kind: 'gif' }, createdAt: c, expiresAt: T + 600000 });
  const vis = (el) => !!el && el.getClientRects().length > 0;
  const settle = () => new Promise((r) => setTimeout(r, 260));   // přechod rozmazání 160 ms
  const st = () => { const t = box.querySelector('.uc-gif-toggle'); const card = box.querySelector('.uc-gif-card'); const img = card?.querySelector('.uc-gif-card-media :is(img, video)');
    return { toggle: vis(t), n: t?.querySelector('.uc-gif-toggle-n')?.textContent || '', open: t?.classList.contains('open') || false, card: vis(card), blur: img ? getComputedStyle(img).filter : null }; };
  const r = { empty: st() };
  g.onPending(P(1, 10)); g.onPending(P(2, 20));
  r.collapsed = st();
  box.querySelector('.uc-gif-toggle').click(); r.expanded = st();
  box.querySelector('.uc-gif-card-media').click(); await settle(); r.focused = st();
  box.querySelector('.uc-gif-card-media').click(); await settle(); r.reblur = st();
  T += 1000; await g.decide('1', true); r.afterDecide = st();
  g.onQueue({ channel: 'robdiesalot', pendingCount: 0, headId: null }); r.drained = st();
  g.onPending(P(3, 30)); r.again = st();
  g.onQueue({ channel: 'robdiesalot', pendingCount: 0, headId: null }); streamer = false; g.onPending(P(4, 40)); r.mod = st();
  g.clear(); box.remove(); return r;
})()`);
check('S bez čekajících GIFů žádná záložka', coreStreamer?.empty.toggle === false, JSON.stringify(coreStreamer?.empty));
check('S streamer: čekající GIFy → jen záložka ⌃⌃ s počtem, karta schovaná', coreStreamer?.collapsed.toggle && coreStreamer.collapsed.n === '2' && !coreStreamer.collapsed.card && !coreStreamer.collapsed.open, JSON.stringify(coreStreamer?.collapsed));
check('S klik na záložku → karta vidět, šipky otočené (zabalit), GIF rozmazaný', coreStreamer?.expanded.card && coreStreamer.expanded.open && /blur/.test(coreStreamer.expanded.blur || ''), JSON.stringify(coreStreamer?.expanded));
check('S klik na GIF zaostří, další klik znovu rozmaže', coreStreamer?.focused.blur === 'none' && /blur/.test(coreStreamer.reblur.blur || ''), JSON.stringify([coreStreamer?.focused, coreStreamer?.reblur]));
check('S po rozhodnutí zůstane rozbaleno (další GIF, zase rozmazaný)', coreStreamer?.afterDecide.card && coreStreamer.afterDecide.open && /blur/.test(coreStreamer.afterDecide.blur || ''), JSON.stringify(coreStreamer?.afterDecide));
check('S fronta došla → záložka zmizí; další GIF zase zabalený (počet 1)', coreStreamer?.drained.toggle === false && coreStreamer.again.toggle && !coreStreamer.again.card && coreStreamer.again.n === '1', JSON.stringify([coreStreamer?.drained, coreStreamer?.again]));
check('S mod (ne streamer): karta rovnou, bez záložky a bez rozmazání', coreStreamer?.mod.card && !coreStreamer.mod.toggle && !/blur/.test(coreStreamer.mod.blur || ''), JSON.stringify(coreStreamer?.mod));

// GIF na výšku ve zprávě (2026-09-28): rám 4:3 s ambientem; na šířku beze změny.
const amb = await ev(`(() => {
  const chat = document.getElementById('chat');
  const mk = (w, h) => { const msg = document.createElement('div'); msg.className = 'msg'; const tx = document.createElement('span'); tx.className = 'tx'; msg.appendChild(tx); chat.appendChild(msg);
    const g = window.UC_CORE.createGifMedia(document, { url: ${JSON.stringify(murl(MEDIA.card))}, kind: 'gif', width: w, height: h }, { lazy: false, ambient: true }); msg.appendChild(g); return { msg, g }; };
  const tall = mk(212, 375), wide = mk(498, 280);
  const R = (el) => { const r = el?.getBoundingClientRect(); return r ? [Math.round(r.width), Math.round(r.height)] : null; };
  const st = tall.g.querySelector('.uc-gif-stage'), m = tall.g.querySelector('.uc-gif-media'), bg = tall.g.querySelector('.uc-gif-amb');
  const sr = st?.getBoundingClientRect(), mr = m?.getBoundingClientRect();
  const out = { stage: R(st), media: R(m), center: sr && mr ? Math.abs((mr.left - sr.left) - (sr.right - mr.right)) <= 1 : false, bg: !!bg && /blur/.test(getComputedStyle(bg).filter), wideStage: !!wide.g.querySelector('.uc-gif-stage'), wideMedia: R(wide.g.querySelector('.uc-gif-media')) };
  tall.msg.remove(); wide.msg.remove(); return out; })()`);
check('GIF na výšku: rám 4:3 333×250, GIF 141×250 uprostřed, ambient rozmazaný', JSON.stringify(amb?.stage) === '[333,250]' && JSON.stringify(amb.media) === '[141,250]' && amb.center && amb.bg, JSON.stringify(amb));
check('GIF na šířku: bez rámu, beze změny (400×225)', amb && !amb.wideStage && JSON.stringify(amb.wideMedia) === '[400,225]', JSON.stringify(amb));

// ---- fáze B: divák = odesílatel (štítky u vlastní zprávy místo karty) ----
mock.mod = false;
mock.gifState = () => ({ ok: true, allowed: true, cooldownUntil: null, cooldownSec: 60, serverNow: Date.now() });
const pendBefore = posts.pending.length;
await boot();
await until(`!document.body.classList.contains('uc-can-moderate')`);
// Instance UnityChat není globální → zachytit přes prototyp při dalším logu (vzor scripts/e2e-mention-notify.mjs),
// potřeba pro CF test níže (reset lokální předvolby `_account.gifClientFetch` mezi zprávami).
await ev(`(() => { const o = UnityChat.prototype._ucLog; UnityChat.prototype._ucLog = function (...a) { window.__uc = this; return o.apply(this, a); }; return true; })()`);
await ev(`document.getElementById('input-deleted-style')?.dispatchEvent(new Event('change'))`);
await until(`!!window.__uc`, 8000);
const own = (id) => ev(`(() => { const m = document.querySelector('.msg[data-msg-id="${id}"]'); if (!m) return null; const s = m.querySelector('.uc-gif-st');
  const w = s?.querySelector('.uc-gif-st-warn');
  return { shown: getComputedStyle(m).display !== 'none', held: m.classList.contains('uc-gif-held'), deleted: m.classList.contains('uc-deleted'), text: m.querySelector('.tx')?.textContent || '',
    kind: s?.dataset.kind || null, label: s ? (s.querySelector('.uc-gif-st-pct, .uc-gif-st-txt')?.textContent || '') : null, spin: !!s?.querySelector('.uc-gif-st-spin'),
    warn: !!w && !w.hidden, warnTip: w?.getAttribute('title') || null, color: s ? getComputedStyle(s).color : null, ring: !!s?.querySelector('.uc-qd-ring'),
    dimmed: m.classList.contains('uc-deleted--dimmed'), label2: m.querySelector('.tx .uc-deleted-label')?.textContent || null, link: !!m.querySelector('.tx a[href]') }; })()`);
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
check('B gif_rejected → odesílatel: text bez odkazu, mírně ztlumený, červený štítek natrvalo, bez „Zpráva smazána“ / „Smazáno“ (user 2026-09-27)', ownMuted(await naView('e2e-own1'), 'rejected', 'Zamítnuto moderátorem'), JSON.stringify(await naView('e2e-own1')));
// Vypršelo
mock.sse.push(OWNMSG('e2e-own2', 'druhý https://giphy.com/gifs/x-2'));
await until(`!!document.querySelector('.msg[data-msg-id="e2e-own2"]')`, 8000);
pushAcc(PR('e2e-own2', 'done', 100, { outcome: 'pending' }), ['gif-pending', pend0(31, { own: true, login: 'moduser', messageId: 'e2e-own2' })],
  ['gif-decided', { requestId: 31, channel: 'robdiesalot', approved: false, status: 'expired', by: null, own: true }]);
check('B vypršelo → červený „Vypršelo“', await until(`document.querySelector('.msg[data-msg-id="e2e-own2"] .uc-gif-st-txt')?.textContent === 'Vypršelo'`, 12000), JSON.stringify(await own('e2e-own2')));
check('B M6 zamítnutá / propadlá vlastní zpráva: překreslení textu z dat odkaz nevrátí', await ev(`(() => { const a = window.ucGif.renderBody('e2e-own1'), b = window.ucGif.renderBody('e2e-own2'); return !a.includes('<a ') && !b.includes('<a ') && a.includes('uc-link-off') && b.includes('uc-link-off'); })()`) === true,
  JSON.stringify(await ev(`[window.ucGif.renderBody('e2e-own1'), window.ucGif.renderBody('e2e-own2')]`)));
check('B vypršelo → odesílatel: text bez odkazu + štítek, bez vzhledu smazané zprávy', ownMuted(await naView('e2e-own2'), 'expired', 'Vypršelo'), JSON.stringify(await naView('e2e-own2')));
check('B gif_rejected vlastní z historie (divák) → štítek bez „Zpráva smazána“', await until(`document.querySelector('.msg[data-msg-id="e2e-rej-own"] .uc-gif-st')?.dataset.kind === 'rejected'`, 5000)
  && ownMuted(await naView('e2e-rej-own'), 'rejected', 'Zamítnuto moderátorem', false), JSON.stringify(await naView('e2e-rej-own')));
check('B gif_rejected cizí z historie → divák dál „Zpráva smazána“', await (async () => { const o = await naView('e2e-rej'); return !!o && o.shown && o.deleted && o.label2 === 'Zpráva smazána'; })(), JSON.stringify(await naView('e2e-rej')));
check('B bez ⚠ u GIFu, který zamítnutý nebyl', await ev(`!document.querySelector('.msg[data-msg-id="e2e-own2"] .uc-gif-st-warn:not([hidden])')`) === true);
// Schváleno → původní zpráva pryč, GIF na konci chatu (čas schválení, ne čas původní zprávy)
mock.sse.push(OWNMSG('e2e-own3', 'třetí https://tenor.com/view/dog-gif-3'));
await until(`!!document.querySelector('.msg[data-msg-id="e2e-own3"]')`, 8000);
pushAcc(PR('e2e-own3', 'done', 100, { outcome: 'pending' }), ['gif-pending', pend0(32, { own: true, login: 'moduser', messageId: 'e2e-own3' })]);
await until(`document.querySelector('.msg[data-msg-id="e2e-own3"] .uc-gif-st')?.dataset.kind === 'pending'`, 12000);
mock.sse.push(['message-deleted', { channel: 'robdiesalot', platform: 'twitch', messageId: 'e2e-own3', by: 'filter', reason: 'gif_request' }]);
mock.sse.push(OWNMSG('e2e-after', 'zpráva po mé'));
await until(`!!document.querySelector('.msg[data-msg-id="e2e-after"]')`, 8000);
// Stav odměny načtený PŘED schválením (dřív to záviselo na časování dřívějších GET /gif/state — test pak náhodně padal níž).
await ev(`window.ucGif.cd().fetchState()`);
pushAcc(['gif-decided', { requestId: 32, channel: 'robdiesalot', approved: true, status: 'approved', by: 'twitch:modik', own: true }]);
mock.sse.push(['gif-message', { channel: 'robdiesalot', requestId: 32, message: { platform: 'twitch', id: 'gif-32', username: 'ModUser', userId: 'u7', message: 'třetí', timestamp: Date.now() + 500, historical: false, color: '#1e90ff', gif: { url: murl(MEDIA.ok), kind: 'gif', width: 60, height: 40 }, gifOrigin: 'twitch:e2e-own3' } }]);
check('B schváleno → GIF zpráva v chatu', await until(`!!document.querySelector('.msg[data-msg-id="gif-32"] .uc-gif img')`, 8000));
const lastIds = await ev(`[...document.querySelectorAll('#chat .msg[data-msg-id]')].filter(m => getComputedStyle(m).display !== 'none').map(m => m.dataset.msgId).slice(-3).join(',')`);
check('B schválený GIF na konci chatu (čas schválení), za pozdější zprávou', /e2e-after,gif-32$/.test(lastIds), lastIds);
check('B schválení vlastního GIFu → cooldown odměny běží od teď (60 s)', await until(`window.ucGif.cd().remainingMs() > 45_000`, 12000), String(await ev(`window.ucGif.cd().remainingMs()`)));
check('B … původní zpráva schovaná, štítek pryč', await until(`(() => { const m = document.querySelector('.msg[data-msg-id="e2e-own3"]'); return !!m && getComputedStyle(m).display === 'none' && !m.querySelector('.uc-gif-st'); })()`, 4000));
// Režim „Schválené“: nový GIF → hláška + štítek
mock.sse.push(OWNMSG('e2e-own4', 'nový https://tenor.com/view/new-gif-4'));
await until(`!!document.querySelector('.msg[data-msg-id="e2e-own4"]')`, 8000);
pushAcc(PR('e2e-own4', 'download', 40), ['gif-notice', { requestKey: 'twitch:e2e-own4', channel: 'robdiesalot', platform: 'twitch', messageId: 'e2e-own4', kind: 'approved_only' }]);
check('B gif-notice approved_only → hláška „Nové GIFy teď nejsou povolené, vyber z GIFů v panelu.“', await until(`[...document.querySelectorAll('#chat .sys')].some(m => m.textContent === 'Nové GIFy teď nejsou povolené, vyber z GIFů v panelu.')`, 12000));
check('B … a štítek u zprávy', (await own('e2e-own4'))?.label === NA_TEXT, JSON.stringify(await own('e2e-own4')));
check('B nové GIFy nejsou povolené (gif_not_allowed) → odesílatel (divák): „Zpráva smazána“ + červený štítek místo „Smazáno“ (user 2026-09-27 v2)', naDel(await naView('e2e-own4')), JSON.stringify(await naView('e2e-own4')));
check('B M2: konečný stav i ve store (_gifOwnFinal, smazaná) → kopírování / citace potlačené', await ev(`(() => { const m = window.ucGif.msg('e2e-own4'); return !!m && m._gifOwnFinal === true && m._deleted === true && m.deletedReason === 'gif_not_allowed' && window.ucGif.textSuppressed('e2e-own4') === true; })()`) === true,
  JSON.stringify(await ev(`(() => { const m = window.ucGif.msg('e2e-own4'); return m && { f: m._gifOwnFinal, d: m._deleted, r: m.deletedReason }; })()`)));
check('B M2: odkaz ve smazané vlastní GIF zprávě (mod „Zašedlé“ s textem) není živý ani pro klávesnici', await ev(`(() => { const el = document.createElement('div'); el.className = 'msg uc-gif-own-final';
  el.innerHTML = '<span class="tx">hele <a href="https://tenor.com/view/x-1" target="_blank">https://tenor.com/view/x-1</a></span>'; document.body.appendChild(el);
  window.UC_CORE.applyDeleted(el, { mode: 'dim', dimmed: true, tag: true }); const r = !el.querySelector('a') && el.querySelector('.tx .uc-link-off')?.textContent === 'https://tenor.com/view/x-1'; el.remove(); return r; })()`) === true);
mock.sse.push(['message-deleted', { channel: 'robdiesalot', platform: 'twitch', messageId: 'e2e-own4', by: 'filter', reason: 'gif_not_allowed' }]);
await sleep(800);
check('B … po message-deleted gif_not_allowed pořád stejně', naDel(await naView('e2e-own4')), JSON.stringify(await naView('e2e-own4')));
// Ostatní (divák): cizí gif_not_allowed z historie, živě i když message-deleted předběhne zprávu → smazaná + štítek.
check('B gif_not_allowed cizí z historie → divák „Zpráva smazána“ + štítek', naDel(await naView('e2e-na-h')), JSON.stringify(await naView('e2e-na-h')));
check('B gif_not_allowed vlastní z historie (divák) → „Zpráva smazána“ + štítek', await until(`document.querySelector('.msg[data-msg-id="e2e-na-hown"] .uc-gif-st')?.dataset.kind === 'not_allowed'`, 5000)
  && naDel(await naView('e2e-na-hown')), JSON.stringify(await naView('e2e-na-hown')));
mock.sse.push(NAMSG('e2e-na-live2', 'Divak', 'u9', 'cizí https://tenor.com/view/na-gif-3'));
await until(`!!document.querySelector('.msg[data-msg-id="e2e-na-live2"]')`, 8000);
mock.sse.push(['message-deleted', { channel: 'robdiesalot', platform: 'twitch', messageId: 'e2e-na-live2', by: 'filter', reason: 'gif_not_allowed' }]);
check('B gif_not_allowed cizí živě → divák „Zpráva smazána“ + štítek', await until(`document.querySelector('.msg[data-msg-id="e2e-na-live2"] .uc-gif-st')?.dataset.kind === 'not_allowed'`, 8000) && naDel(await naView('e2e-na-live2')), JSON.stringify(await naView('e2e-na-live2')));
mock.sse.push(['message-deleted', { channel: 'robdiesalot', platform: 'twitch', messageId: 'e2e-na-early', by: 'filter', reason: 'gif_request' }],
  ['message-deleted', { channel: 'robdiesalot', platform: 'twitch', messageId: 'e2e-na-early', by: 'filter', reason: 'gif_not_allowed' }]);
await sleep(800);
await ev(`window.ucGif.applyDeleted('twitch', 'e2e-na-early')`);   // ozvěna smazání z platformy před zprávou
await ev(`window.ucGif.applyDeleted('twitch', 'e2e-na-early', { reason: 'platform' })`);
await ev(`(window.ucGif.add({ platform: 'twitch', id: 'e2e-na-early', username: 'Divak', userId: 'u9', message: 'pozdní https://tenor.com/view/na-gif-4', timestamp: Date.now(), historical: false, color: '#1e90ff' }), true)`);
// Review I2: citace rodiče — nikdy živý odkaz; smazaný rodič (nepovolený GIF, i odpověď bota) jen „↩ @jméno“.
const RMSG = (id, text, replyTo) => ['message-restored', { channel: 'robdiesalot', platform: 'twitch', messageId: id, by: 'filter', message: { platform: 'twitch', id, username: 'JoukiBOT', userId: 'u88', message: text, timestamp: Date.now(), color: '#1e90ff', replyTo } }];
const rctx = (id) => ev(`(() => { const c = document.querySelector('.msg[data-msg-id="${id}"] .reply-ctx'); return c ? { user: c.querySelector('.rctx-user')?.textContent || null, body: c.querySelector('.rctx-body')?.textContent ?? null, link: !!c.querySelector('a[href]'), off: !!c.querySelector('.uc-link-off') } : null; })()`);
mock.sse.push(RMSG('e2e-rc1', 'Nové GIFy teď nejsou povolené', { username: 'Divak', message: 'cizí https://tenor.com/view/na-gif-3', id: 'e2e-na-live2' }));
check('B I2 odpověď bota na smazaný nepovolený GIF → citace jen „↩ @jméno“ bez textu a odkazu', await until(`!!document.querySelector('.msg[data-msg-id="e2e-rc1"] .reply-ctx')`, 8000)
  && await (async () => { const c = await rctx('e2e-rc1'); return !!c && c.user === '@Divak' && c.body === null && !c.link; })(), JSON.stringify(await rctx('e2e-rc1')));
mock.sse.push(NAMSG('e2e-rc-par', 'Divak', 'u9', 'rodič https://example.com/stranka'),
  RMSG('e2e-rc2', 'odpověď', { username: 'Divak', message: 'rodič https://example.com/stranka', id: 'e2e-rc-par' }));
check('B I2 citace nesmazaného rodiče s odkazem → text ano, odkaz jen jako text (ne živý)', await until(`!!document.querySelector('.msg[data-msg-id="e2e-rc2"] .reply-ctx')`, 8000)
  && await (async () => { const c = await rctx('e2e-rc2'); return !!c && /example\.com/.test(c.body || '') && !c.link && c.off; })(), JSON.stringify(await rctx('e2e-rc2')));
mock.sse.push(['message-deleted', { channel: 'robdiesalot', platform: 'twitch', messageId: 'e2e-rc-par', by: 'filter', reason: 'gif_not_allowed' }]);
check('B I2 rodič smazaný až po vykreslení odpovědi → text citace pryč', await until(`!document.querySelector('.msg[data-msg-id="e2e-rc2"] .reply-ctx .rctx-body') && !!document.querySelector('.msg[data-msg-id="e2e-rc2"] .reply-ctx .rctx-user')`, 8000), JSON.stringify(await rctx('e2e-rc2')));
check('B gif_not_allowed předběhlo zprávu (IRC později) → zpráva se vykreslí rovnou smazaná se štítkem (nikdy s odkazem)', naDel(await naView('e2e-na-early')), JSON.stringify(await naView('e2e-na-early')));
// Selhání převodu (běžný odkaz) → štítek pryč
mock.sse.push(OWNMSG('e2e-own5', 'pátý https://i.4pcdn.org/pol/1.gif'));
await until(`!!document.querySelector('.msg[data-msg-id="e2e-own5"]')`, 8000);
pushAcc(PR('e2e-own5', 'download', 20), PR('e2e-own5', 'done', 100, { outcome: 'failed' }));
check('B převod selhal (outcome failed) → bez štítku', await until(`!!window.ucGif.out().get('twitch', 'e2e-own5') && !document.querySelector('.msg[data-msg-id="e2e-own5"] .uc-gif-st')`, 12000));
// Optimistická zpráva: kolečko hned, průběh podle id z POST /chat/send
mock.sendId = 'e2e-own6';
const sendB = posts.send.length;
// Cooldown ze schválení výš „doběhl“: stav znovu ze serveru (cooldownUntil null) — čekat na načtený stav, ne na čas.
await ev(`window.ucGif.cd().reset()`);
await typeIn('šestý https://tenor.com/view/six-gif-6');
await until(`!!window.ucGif.cd().snapshot() && window.ucGif.cd().remainingMs() === 0`, 4000);
await clickSend();
check('B odeslání GIF odkazu → optimistická zpráva s kolečkem 0 %', await until(`[...document.querySelectorAll('.msg[data-msg-id^="sent-"]')].some(m => m.querySelector('.uc-gif-st-pct')?.textContent === '0 %')`, 4000)
  && posts.send.length > sendB, JSON.stringify(await ev(`({ rem: window.ucGif.cd().remainingMs(), snap: window.ucGif.cd().snapshot(), val: document.getElementById('msg-input').value, sent: [...document.querySelectorAll('.msg[data-msg-id^="sent-"]')].map(m => m.dataset.msgId + ':' + (m.querySelector('.uc-gif-st')?.className || '-') + ':' + m.querySelector('.tx')?.textContent) })`)) + ' send=' + (posts.send.length - sendB) + ' ' + JSON.stringify(posts.send.at(-1)));
pushAcc(PR('e2e-own6', 'download', 45));
check('B gif-progress (id z /chat/send) → kolečko optimistické zprávy „45 %“', await until(`[...document.querySelectorAll('.msg[data-msg-id^="sent-"]')].some(m => m.querySelector('.uc-gif-st-pct')?.textContent === '45 %')`, 12000));
mock.sendId = null;
// Schválený GIF jiného diváka: na konci chatu
mock.sse.push(['gif-message', { channel: 'robdiesalot', requestId: 70, message: { platform: 'twitch', id: 'gif-70', username: 'Cizi', userId: 'u70', message: '', timestamp: Date.now() + 1000, historical: false, color: '#1e90ff', gif: { url: murl(MEDIA.ok), kind: 'gif', width: 60, height: 40 }, gifOrigin: 'twitch:hodne-stara' } }]);
check('B schválený GIF jiného diváka je poslední zprávou', await until(`[...document.querySelectorAll('#chat .msg[data-msg-id]')].filter(m => getComputedStyle(m).display !== 'none').at(-1)?.dataset.msgId === 'gif-70'`, 8000));
check('B GIF z historie vidí i divák', await ev(`!!document.querySelector('.msg[data-msg-id="gif-5"] .uc-gif img')`) === true);
check('B I2 gif_removed → divák „smazáno“ bez média', await ev(`(() => { const m = document.querySelector('.msg[data-msg-id="gif-9"]'); return !!m && m.classList.contains('uc-deleted') && !m.querySelector('.uc-gif'); })()`) === true);

// ---- Závěrečná review I1: GIF poslaný účtem, echo bez obsahu / žádné echo (YouTube: server zprávu schoval) ----
const optGif = (needle) => ev(`(() => { const els = [...document.querySelectorAll('#chat .msg')].filter(m => (m.querySelector('.tx')?.textContent || '').includes(${JSON.stringify(needle)}));
  const m = els[0]; return { n: els.length, id: m?.dataset.msgId || null, shown: m ? getComputedStyle(m).display !== 'none' : false, kind: m?.querySelector('.uc-gif-st')?.dataset.kind || null,
    label: m?.querySelector('.uc-gif-st-pct, .uc-gif-st-txt')?.textContent || null, failed: !!m?.classList.contains('send-failed') }; })()`);
const sendGif = async (id, text) => {
  await ev(`(() => { window.ucGif.cd().reset(); return true; })()`);
  mock.sendId = id;
  const n = posts.send.length;
  await typeIn(text);
  await sleep(300);
  await clickSend();
  return waitFor(() => posts.send.length > n, 4000);
};
mock.gifState = () => ({ ok: true, allowed: true, cooldownUntil: null, cooldownSec: 0, serverNow: Date.now() });
check('I1 GIF odeslán účtem (POST /chat/send → id)', await sendGif('e2e-i1', 'echo bez textu https://tenor.com/view/i1-gif-1'));
pushAcc(PR('e2e-i1', 'download', 30));
check('I1 průběh podle id z /chat/send → štítek u optimistické zprávy', await until(`[...document.querySelectorAll('.msg[data-msg-id^="sent-"]')].some(m => m.querySelector('.uc-gif-st-pct')?.textContent === '30 %')`, 12000), JSON.stringify(await optGif('i1-gif')));
// Echo z /chat/stream: server zprávu schoval (gif_request) → přijde BEZ textu; textem by se nespárovala.
await ev(`(window.ucGif.add({ platform: 'twitch', id: 'e2e-i1', username: 'ModUser', userId: 'u7', message: '', timestamp: Date.now(), historical: false, deleted: true, deletedReason: 'gif_request' }), true)`);
await sleep(300);
const i1 = await optGif('i1-gif');
check('I1 echo bez textu → spárováno přes id: jedna zpráva, text i štítek zůstaly', i1?.n === 1 && i1.id === 'e2e-i1' && i1.shown && i1.kind === 'progress' && !i1.failed, JSON.stringify(i1));
check('I1 … žádná druhá (prázdná) zpráva e2e-i1', await ev(`document.querySelectorAll('#chat .msg[data-msg-id="e2e-i1"]').length`) === 1);
// Bez echa (bot zprávu smazal dřív, než ji poller viděl): čeká → schváleno → optimistická pryč, GIF na konci chatu.
check('I1 druhý GIF odeslán', await sendGif('e2e-i2', 'bez echa https://tenor.com/view/i2-gif-2'));
pushAcc(PR('e2e-i2', 'done', 100, { outcome: 'pending' }), ['gif-pending', pend0(40, { own: true, login: 'moduser', messageId: 'e2e-i2' })]);
check('I1 bez echa → optimistická se štítkem „Schvalování moderátorem“', await until(`[...document.querySelectorAll('.msg[data-msg-id^="sent-"]')].some(m => m.querySelector('.tx')?.textContent.includes('i2-gif') && m.querySelector('.uc-gif-st')?.dataset.kind === 'pending')`, 12000), JSON.stringify(await optGif('i2-gif')));
pushAcc(['gif-decided', { requestId: 40, channel: 'robdiesalot', approved: true, status: 'approved', own: true }]);
mock.sse.push(['gif-message', { channel: 'robdiesalot', requestId: 40, message: { platform: 'twitch', id: 'gif-40', username: 'ModUser', userId: 'u7', message: 'bez echa', timestamp: Date.now() + 5000, historical: false, color: '#1e90ff', gif: { url: murl(MEDIA.ok), kind: 'gif', width: 60, height: 40 }, gifOrigin: 'twitch:e2e-i2' } }]);
check('I1 schváleno bez echa → GIF na konci chatu', await until(`!!document.querySelector('.msg[data-msg-id="gif-40"] .uc-gif img')`, 8000));
check('I1 … optimistická zpráva s odkazem zmizela (žádný duplikát)', await until(`![...document.querySelectorAll('#chat .msg')].some(m => m.querySelector('.tx')?.textContent.includes('i2-gif'))`, 4000), JSON.stringify(await optGif('i2-gif')));
// Bez echa → zamítnuto: zpráva zůstane s červeným štítkem, ne „neodesláno“.
check('I1 třetí GIF odeslán', await sendGif('e2e-i3', 'zamitnuty https://tenor.com/view/i3-gif-3'));
pushAcc(PR('e2e-i3', 'done', 100, { outcome: 'pending' }), ['gif-pending', pend0(41, { own: true, login: 'moduser', messageId: 'e2e-i3' })],
  ['gif-decided', { requestId: 41, channel: 'robdiesalot', approved: false, status: 'rejected', own: true }]);
// Zamítnutá optimistická = text bez živého odkazu s červeným štítkem, bez vzhledu smazané zprávy (user 2026-09-27).
const optRej = () => ev(`(() => { const m = [...document.querySelectorAll('.msg[data-msg-id^="sent-"]')].find(x => x.querySelector('.uc-gif-st')?.dataset.kind === 'rejected'); if (!m) return null;
  return { shown: getComputedStyle(m).display !== 'none', deleted: m.classList.contains('uc-deleted'), label: m.querySelector('.tx .uc-deleted-label')?.textContent || null, text: m.querySelector('.tx').textContent.includes('i3-gif'), link: !!m.querySelector('.tx a[href]'), failed: m.classList.contains('send-failed') }; })()`);
check('I1 bez echa → zamítnuto: optimistická zůstane s textem (odkaz neživý) a červeným „Zamítnuto moderátorem“, ne smazaná', await until(`(() => { const m = [...document.querySelectorAll('.msg[data-msg-id^="sent-"]')].find(x => x.querySelector('.uc-gif-st')?.dataset.kind === 'rejected'); return !!m && !m.classList.contains('uc-deleted'); })()`, 12000)
  && (await optRej())?.label === null && (await optRej()).text && !(await optRej()).link, JSON.stringify(await optRej()));
check('I1 … ne jako neodeslaná', (await optRej())?.failed === false);
mock.sendId = null;

// ---- CF: stažení GIFu prohlížečem odesílatele (core/gif-client-fetch.js, spec 2026-09-29) ----
mock.sse.push(OWNMSG('e2e-cf1', 'moje https://imgur.com/a/8as1KiG'));
await until(`!!document.querySelector('.msg[data-msg-id="e2e-cf1"]')`, 8000);
pushAcc(PR('e2e-cf1', 'client_fetch', 50, { token: 'tok-cf1', url: 'https://i.imgur.com/auBmmCk.mp4', kind: 'mp4', width: 640, height: 360, host: 'i.imgur.com', expiresAt: Date.now() + 90000, serverNow: Date.now(), pref: 'ask' }));
check('CF výzva: štítek s textem o imgur.com a tlačítky', await until(`(() => { const st = document.querySelector('.msg[data-msg-id="e2e-cf1"] .uc-gif-st--client_fetch'); return !!st && /imgur\\.com/.test(st.textContent) && !!st.querySelector('[data-cf="yes"]') && !!st.querySelector('[data-cf="no"]') && !!st.querySelector('[data-cf="remember"]'); })()`, 6000));
await ev(`(() => { const st = document.querySelector('.msg[data-msg-id="e2e-cf1"] .uc-gif-st--client_fetch'); st.querySelector('[data-cf="remember"]').checked = true; st.querySelector('[data-cf="yes"]').click(); return true; })()`);
check('CF: klik → stažení z i.imgur.com a upload s tokenem + remember', await waitFor(() => uploads.length === 1, 6000) && uploads[0].token === 'tok-cf1' && uploads[0].remember === '1' && uploads[0].bytes > 100, JSON.stringify(uploads));
check('CF: během uploadu kolečko', await ev(`document.querySelector('.msg[data-msg-id="e2e-cf1"] .uc-gif-st')?.dataset.kind`) === 'progress');
pushAcc(PR('e2e-cf1', 'verify', 95), PR('e2e-cf1', 'done', 100, { outcome: 'pending' }));
check('CF: po serveru „Schvalování moderátorem“', await until(`document.querySelector('.msg[data-msg-id="e2e-cf1"] .uc-gif-st')?.dataset.kind === 'pending'`, 6000));
// Ne (bez zapamatování): cf1 uložilo remember+yes → lokální _account.gifClientFetch je teď „always“ (spec §4
// „Zapamatovat → další GIF bez výzvy“ — ověřeno níže v CF3 na serverové předvolbě); pro nezávislý test výzvy + „Ne“
// vrátit lokální předvolbu zpět na „ask“ (jako fresh /auth/me se starou hodnotou).
await ev(`(() => { if (window.__uc?._account) window.__uc._account.gifClientFetch = 'ask'; return true; })()`);
mock.sse.push(OWNMSG('e2e-cf2', 'druhé https://imgur.com/a/vGm2qzT'));
await until(`!!document.querySelector('.msg[data-msg-id="e2e-cf2"]')`, 8000);
pushAcc(PR('e2e-cf2', 'client_fetch', 50, { token: 'tok-cf2', url: 'https://i.imgur.com/b1Fyunv.mp4', kind: 'mp4', width: 480, height: 854, host: 'i.imgur.com', expiresAt: Date.now() + 90000, serverNow: Date.now(), pref: 'ask' }));
check('CF2 výzva: štítek s tlačítky (lokální předvolba vrácena na ask)', await until(`!!document.querySelector('.msg[data-msg-id="e2e-cf2"] .uc-gif-st--client_fetch')`, 6000));
await ev(`(() => { const st = document.querySelector('.msg[data-msg-id="e2e-cf2"] .uc-gif-st--client_fetch'); st.querySelector('[data-cf="no"]').click(); return true; })()`);
check('CF: Ne → decline na server a text „Odkaz zůstal běžnou zprávou“', await waitFor(() => declines.length === 1, 6000) && declines[0].token === 'tok-cf2'
  && await until(`document.querySelector('.msg[data-msg-id="e2e-cf2"] .uc-gif-st')?.dataset.kind === 'client_declined'`, 3000)
  && await until(`document.querySelector('.msg[data-msg-id="e2e-cf2"] .uc-gif-st-txt')?.textContent === 'Odkaz zůstal běžnou zprávou'`, 3000),
  await ev(`document.querySelector('.msg[data-msg-id="e2e-cf2"] .uc-gif-st-txt')?.textContent`));
// pref always ze serveru → bez výzvy rovnou stažení
mock.sse.push(OWNMSG('e2e-cf3', 'třetí https://imgur.com/a/tCd8jXN'));
await until(`!!document.querySelector('.msg[data-msg-id="e2e-cf3"]')`, 8000);
pushAcc(PR('e2e-cf3', 'client_fetch', 50, { token: 'tok-cf3', url: 'https://i.imgur.com/auBmmCk.mp4', kind: 'mp4', width: 640, height: 360, host: 'i.imgur.com', expiresAt: Date.now() + 90000, serverNow: Date.now(), pref: 'always' }));
check('CF: předvolba always → bez výzvy rovnou upload', await waitFor(() => uploads.length === 2, 6000) && uploads[1].token === 'tok-cf3');

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
mock.gifState = () => ({ ok: true, allowed: false, cooldownUntil: null, cooldownSec: 60, serverNow: Date.now() });
await ev(`(async () => { window.ucGif.cd().reset(); await window.ucGif.cd().fetchState(); return true; })()`);
const gl = () => ev(`(() => { const p = document.querySelector('.uc-ep-pane[data-pane="gif"]'); const vis = (e) => !!e && !e.hidden && getComputedStyle(e).display !== 'none';
  return { shown: vis(p), items: p ? [...p.querySelectorAll('.uc-gl-grid:not(.uc-gl-grid--rej) .uc-gl-i')].map(i => i.dataset.id.slice(-2)).join(',') : null,
    reward: p?.querySelector('.uc-gl-reward-t')?.textContent || '', flash: !!p?.querySelector('.uc-gl-reward--flash'), tabs: vis(p?.querySelector('.uc-gl-tabs')),
    lock: vis(p?.querySelector('.uc-gl-reward .uc-lock')), shake: !!p?.querySelector('.uc-gl-reward .uc-lock.uc-lock-shake'),
    lock: vis(p?.querySelector('.uc-gl-reward .uc-lock')), shake: !!p?.querySelector('.uc-gl-reward .uc-lock.uc-lock-shake'),
    locked: !!p?.classList.contains('uc-gl--locked'), dups: vis(p?.querySelector('.uc-gl-dups')) ? p.querySelector('.uc-gl-dups .uc-gl-h').textContent : null,
    rej: p ? [...p.querySelectorAll('.uc-gl-grid--rej .uc-gl-i')].map(i => i.dataset.id.slice(-2)).join(',') : null,
    msg: vis(p?.querySelector('.uc-gl-msg')) ? p.querySelector('.uc-gl-msg').textContent : null,
    confirm: vis(p?.querySelector('.uc-gl-confirm')) ? p.querySelector('.uc-gl-confirm p').textContent : null }; })()`);
const glClick = (sel) => ev(`(() => { const b = document.querySelector('.uc-ep-pane[data-pane="gif"] ${sel}'); if (!b) return false; b.click(); return true; })()`);
await ev(`document.getElementById('btn-emotes').click()`);
check('G panel emotů má svislé záložky Emoty | GIFy (+ SFX, když kanál má zvuky)', await until(`['Emoty|GIFy', 'Emoty|GIFy|SFX'].includes([...document.querySelectorAll('.uc-ep-side .uc-ep-tab')].filter(b => !b.hidden).map(b => b.textContent.trim()).join('|'))`, 3000), await ev(`[...document.querySelectorAll('.uc-ep-side .uc-ep-tab')].filter(b => !b.hidden).map(b => b.textContent.trim()).join('|')`));
await ev(`document.querySelector('.uc-ep-tab[data-tab="gif"]').click()`);
check('G záložka GIFy → knihovna (GET /gifs/library s kanálem), pořadí podle použití', await until(`document.querySelectorAll('.uc-ep-pane[data-pane="gif"] .uc-gl-i').length === 3`, 5000)
  && posts.library.some((u) => /channel=robdiesalot/.test(u)) && (await gl())?.items === '0b,0c,0d', JSON.stringify(await gl()));
const g0 = await gl();
check('G divák bez odměny: knihovnu vidí, zámek + „Odměna není aktivována“ (jako soundboard), bez modích tabů', g0?.locked && g0.reward === 'Odměna není aktivována' && g0.lock && !g0.tabs && g0.dups === null, JSON.stringify(g0));
const sendG0 = posts.send.length;
await glClick('.uc-gl-i[data-id$="0b"] .uc-gl-pick');
await sleep(300);
check('G zamčený výběr → nic neodejde, zámek se zatřese (spec 2026-09-27 §2)', posts.send.length === sendG0 && (await gl())?.shake === true, JSON.stringify(await gl()));
check('G zatřesení po ~1 s doběhne (zámek zase šedý, bez třídy)', await until(`!document.querySelector('.uc-ep-pane[data-pane="gif"] .uc-lock-shake')`, 2500));
// Náhled (2026-09-27): nabídka ⋯ i pro diváka (jen „Náhled“), překryv nad panelem, zavření Esc / klik mimo / ×.
const pv = () => ev(`(() => { const p = document.querySelector('.uc-ep-pane[data-pane="gif"] .uc-gl-preview'); const vis = (e) => !!e && !e.hidden && getComputedStyle(e).display !== 'none';
  if (!vis(p)) return { open: false, picker: !document.querySelector('.uc-ep').classList.contains('hidden') };
  const m = p.querySelector('.uc-gif-media'); const r = m?.getBoundingClientRect(); const pr = p.getBoundingClientRect();
  return { open: true, picker: !document.querySelector('.uc-ep').classList.contains('hidden'), dim: p.querySelector('.uc-gl-preview-dim').textContent,
    tags: [...p.querySelectorAll('.uc-gl-tag')].map(t => t.textContent).join(','), meta: p.querySelector('.uc-gl-preview-meta').textContent,
    src: m?.getAttribute('src') || '', w: Math.round(r?.width || 0), fits: !!r && r.width <= pr.width && r.height <= pr.height, overPane: pr.width > 100 && pr.height > 100 }; })()`);
await glClick('.uc-gl-i[data-sec="lib"][data-id$="0b"] [data-act="menu"]');
check('G divák: nabídka ⋯ u GIFu v knihovně = jen „Náhled“', await ev(`[...document.querySelectorAll('.uc-gl-i[data-sec="lib"][data-id$="0b"] .uc-gl-menu:not([hidden]) button')].map(b => b.textContent).join('|')`) === 'Náhled');
const menuInside = (sel) => ev(`(() => { const m = document.querySelector('${sel} .uc-gl-menu:not([hidden])'); if (!m) return null; const b = document.querySelector('.uc-ep-pane[data-pane="gif"] .uc-gl-body').getBoundingClientRect(); const r = m.getBoundingClientRect();
  return { inside: r.left >= b.left && r.right <= b.right && r.top >= b.top - 1, left: Math.round(r.left - b.left), right: Math.round(b.right - r.right), place: m.dataset.place }; })()`);
const mi0 = await menuInside('.uc-gl-i[data-sec="lib"][data-id$="0b"]');
check('G nabídka ⋯ první (levé) dlaždice se neusekne o levý okraj panelu', mi0?.inside === true, JSON.stringify(mi0));
// Zúžení panelu při otevřené nabídce → přepočet (ResizeObserver), nabídka se zúží na šířku panelu.
await ev(`(() => { const b = document.querySelector('.uc-ep-pane[data-pane="gif"] .uc-gl-body'); b.style.width = '130px'; b.style.flex = '0 0 130px'; return true; })()`);
check('G zúžený panel → nabídka ⋯ přepočítaná a zúžená dovnitř', await until(`(() => { const m = document.querySelector('.uc-gl-i[data-sec="lib"][data-id$="0b"] .uc-gl-menu:not([hidden])'); const b = document.querySelector('.uc-ep-pane[data-pane="gif"] .uc-gl-body').getBoundingClientRect(); if (!m) return false; const r = m.getBoundingClientRect(); return r.width <= b.width - 8 + 0.5 && r.left >= b.left - 0.5 && r.right <= b.right + 0.5; })()`, 3000),
  JSON.stringify(await menuInside('.uc-gl-i[data-sec="lib"][data-id$="0b"]')));
await ev(`(() => { const b = document.querySelector('.uc-ep-pane[data-pane="gif"] .uc-gl-body'); b.style.width = ''; b.style.flex = ''; return true; })()`);
await glClick('.uc-gl-i[data-sec="lib"][data-id$="0b"] .uc-gl-menu [data-act="preview"]');
const pvG = await pv();
check('G náhled: překryv nad panelem — větší GIF (fit), rozměry, tagy, použití', pvG?.open && pvG.dim === '200 × 100 px · GIF' && pvG.tags === 'cat,dance' && pvG.meta === 'Použito 9×' && pvG.w > 100 && pvG.fits && pvG.overPane && pvG.src === murl(hex(11)), JSON.stringify(pvG));
check('G náhled: nic se neposlalo', posts.send.length === sendG0);
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
const pvEsc = await pv();
check('G náhled: Esc zavře náhled, panel emotů zůstane otevřený', pvEsc?.open === false && pvEsc.picker === true, JSON.stringify(pvEsc));
await glClick('.uc-gl-i[data-sec="lib"][data-id$="0c"] [data-act="menu"]');
await glClick('.uc-gl-i[data-sec="lib"][data-id$="0c"] .uc-gl-menu [data-act="preview"]');
check('G náhled jiného GIFu: jeho tagy (dog)', (await pv())?.tags === 'dog');
await ev(`document.querySelector('.uc-ep-pane[data-pane="gif"] .uc-gl-preview').click()`);
check('G náhled: klik mimo (na pozadí) zavře', (await pv())?.open === false);
await glClick('.uc-gl-i[data-sec="lib"][data-id$="0d"] [data-act="menu"]');
await glClick('.uc-gl-i[data-sec="lib"][data-id$="0d"] .uc-gl-menu [data-act="preview"]');
await glClick('.uc-gl-preview [data-act="preview-close"]');
const pvX = await pv();
check('G náhled: × zavře, panel zůstane', pvX?.open === false && pvX.picker === true, JSON.stringify(pvX));
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
mock.gifState = () => ({ ok: true, allowed: true, cooldownUntil: null, cooldownSec: 60, serverNow: Date.now() });
await ev(`(async () => { window.ucGif.cd().reset(); await window.ucGif.cd().fetchState(); return true; })()`);
// Kolo 4 bod 2: aktivní odměna bez konce = nahoře žádný text (ani pásek) → hlavička schovaná.
check('G odměna aktivní → hlavička bez textu (schovaná), odemčeno', await until(`!document.querySelector('.uc-ep-pane[data-pane="gif"]').classList.contains('uc-gl--locked')`, 3000)
  && (await gl())?.reward === '' && await ev(`document.querySelector('.uc-ep-pane[data-pane="gif"] .uc-gl-reward').hidden`) === true, JSON.stringify(await gl()));
// X1 (audit 2026-09-27): vlastní GIF ještě čeká → výběr z knihovny se nepošle, hláška „Počkej …“.
await ev(`(() => { const o = window.ucGif.out(); o.clear(); o.onOwnPending({ requestId: 991, channel: 'robdiesalot', platform: 'twitch', messageId: 'x1-own', login: 'divak', media: { url: '${murl(hex(12))}', kind: 'gif' }, expiresAt: Date.now() + 300000, own: true }); return o.busy(); })()`);
const sendX1 = posts.send.length;
await glClick('.uc-gl-i[data-id$="0c"] .uc-gl-pick');
await sleep(300);
check('X1 vlastní GIF čeká → výběr z knihovny neodejde, hláška „Počkej, až mod rozhodne o tvém GIFu.“', posts.send.length === sendX1 && (await gl())?.msg === 'Počkej, až mod rozhodne o tvém GIFu.', JSON.stringify(await gl()));
// Stav vlastních GIFů z předchozích fází (I1, D) pryč — další výběr má odejít.
await ev(`(window.ucGif.out().clear(), true)`);
const sendG1 = posts.send.length;
await glClick('.uc-gl-i[data-id$="0c"] .uc-gl-pick');
check('G výběr → POST /chat/send s odkazem api.jouki.cz/media/gif/<id>, panel zavřený', await waitFor(() => posts.send.length > sendG1, 4000)
  && posts.send.at(-1).text.startsWith(murl(hex(12))) && await until(`document.querySelector('.uc-ep').classList.contains('hidden')`, 1500), JSON.stringify(posts.send.at(-1)));
check('G … zpráva s naším odkazem: štítek „Odesílám…“ bez procent (test2 bod 4)', await until(`[...document.querySelectorAll('.msg[data-msg-id^="sent-"]')].some(m => m.querySelector('.tx')?.textContent.includes('/media/gif/') && m.querySelector('.uc-gif-st--sending .uc-gif-st-txt')?.textContent === 'Odesílám…' && !m.querySelector('.uc-gif-st-pct'))`, 3000));
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
// Kolo 4 bod 2: aktivní odměna = nahoře žádný text („Odměna ještě …“ pryč), jen pásek pod hlavičkou.
check('G aktivní odměna: hlavička bez textu, pásek pod ní zůstává', await until(`(() => { const r = document.querySelector('.uc-ep-pane[data-pane="gif"] .uc-gl-reward'); const b = r?.querySelector('.uc-gl-reward-bar');
  return !!r && !r.hidden && getComputedStyle(r).display !== 'none' && !r.innerText.trim() && !!b && b.getBoundingClientRect().width > 0; })()`, 3000), JSON.stringify(await gl()));
await sleep(1200);
const ind2 = await ev(`Number(document.getElementById('btn-emotes').style.getPropertyValue('--uc-ep-p'))`);
check('G pásek ubývá s časem', ind2 < ind.p, `${ind.p} → ${ind2}`);
await ev(`document.getElementById('btn-emotes').click()`);

// ---- test2 bod 1 + 3: vlastní tooltip ikony emotů a záložky GIFy (jako soundboard), bez nativního title ----
const tipOf = (sel) => ev(`(() => { const t = document.querySelector(${JSON.stringify(sel)}); if (!t || t.classList.contains('hidden') || getComputedStyle(t).display === 'none') return null;
  return { mode: [...t.classList].find(c => c.startsWith('uc-sb-tip-') && c !== 'uc-sb-tip-t') || '', title: t.querySelector('.uc-sb-tip-t')?.textContent || '', lines: [...t.querySelectorAll('.uc-sb-tip-l')].map(l => l.textContent),
    rows: [...t.querySelectorAll('.uc-sb-tip-r')].map(r => ({ name: r.querySelector('span')?.textContent, time: r.querySelector('b')?.textContent, bar: !!r.querySelector('i'), p: Number(r.querySelector('i')?.style.getPropertyValue('--p') || NaN) })),
    cd: t.querySelector('.uc-sb-tip-cd')?.textContent || null }; })()`);
check('T2 ikona emotů bez nativního title (vlastní tooltip)', await ev(`!document.getElementById('btn-emotes').hasAttribute('title')`) === true);
await ev(`(() => { const b = document.getElementById('btn-emotes'); b.dispatchEvent(new MouseEvent('mouseenter')); window.__tipEl = document.querySelector('#input-area > .uc-sb-tip:not(.uc-sb-tip.hidden):last-of-type') || [...document.querySelectorAll('#input-area > .uc-sb-tip')].find(t => !t.classList.contains('hidden')); return true; })()`);
const TIPSEL = '#input-area > .uc-sb-tip:not(.hidden)';
const tip1 = await tipOf(TIPSEL);
check('T2 tooltip ikony emotů: „GIF odměna aktivní“, řádek s časem (5:00 / 4:5x) a páskem ≈ 50 %', tip1?.title === 'GIF odměna aktivní' && tip1.rows.length === 1 && tip1.rows[0].name === 'Posílání GIFů'
  && /^(5:00|4:5\d)$/.test(tip1.rows[0].time) && tip1.rows[0].bar && Math.abs(tip1.rows[0].p - 0.5) < 0.03, JSON.stringify(tip1));
await ev(`(() => { window.__tipRow = document.querySelector('${TIPSEL} .uc-sb-tip-r'); return true; })()`);
await sleep(2200);
const tip1b = await tipOf(TIPSEL);
check('T2 tooltip se každou sekundu aktualizuje jen textem (prvek zůstává, čas klesá)', tip1b?.rows[0].time !== tip1.rows[0].time && await ev(`document.querySelector('${TIPSEL} .uc-sb-tip-r') === window.__tipRow`) === true, JSON.stringify([tip1.rows[0].time, tip1b?.rows[0].time]));
await ev(`document.getElementById('btn-emotes').dispatchEvent(new MouseEvent('mouseleave'))`);
check('T2 mouseleave → tooltip pryč', await tipOf(TIPSEL) === null);
await ev(`document.getElementById('btn-emotes').click()`);
await ev(`(() => { const tab = document.querySelector('.uc-ep-tab[data-tab="gif"]'); window.__titleMut = 0; window.__titleObs = new MutationObserver((l) => { window.__titleMut += l.length; }); window.__titleObs.observe(tab, { attributes: true, attributeFilter: ['title'] }); tab.dispatchEvent(new MouseEvent('mouseenter')); return true; })()`);
const TABTIP = '.uc-ep > .uc-sb-tip:not(.hidden)';
const tip2 = await tipOf(TABTIP);
check('T2 tooltip záložky GIFy = stejný obsah jako u ikony', tip2?.title === 'GIF odměna aktivní' && tip2.rows[0]?.name === 'Posílání GIFů' && /^\d:\d\d$/.test(tip2.rows[0].time), JSON.stringify(tip2));
await sleep(2200);
check('T2 záložka GIFy: nativní title nevzniká ani se nepřepisuje (neproblikává)', await ev(`(() => { const tab = document.querySelector('.uc-ep-tab[data-tab="gif"]'); window.__titleObs.disconnect(); return !tab.hasAttribute('title') && window.__titleMut === 0; })()`) === true,
  JSON.stringify(await ev(`({ title: document.querySelector('.uc-ep-tab[data-tab="gif"]').getAttribute('title'), mut: window.__titleMut })`)));
await ev(`document.querySelector('.uc-ep-tab[data-tab="gif"]').dispatchEvent(new MouseEvent('mouseleave'))`);
await ev(`document.getElementById('btn-emotes').click()`);
mock.gifState = () => ({ ok: true, allowed: false, cooldownUntil: null, cooldownSec: 60, serverNow: Date.now() });
await ev(`(async () => { window.ucGif.cd().reset(); await window.ucGif.cd().fetchState(); return true; })()`);
await ev(`document.getElementById('btn-emotes').dispatchEvent(new MouseEvent('mouseenter'))`);
check('bod 2: zamčená odměna → nad ikonou emotů žádný tooltip (nepůsobí jako zamčené emoty)', await tipOf(TIPSEL) === null);
check('bod 2: zamčená odměna → pod ikonou emotů žádný pásek', await ev(`(() => { const b = document.querySelector('#btn-emotes .uc-ep-btn-bar'); return !b || b.hidden; })()`) === true);
await ev(`document.getElementById('btn-emotes').dispatchEvent(new MouseEvent('mouseleave'))`);
await ev(`document.getElementById('btn-emotes').click()`);
await ev(`document.querySelector('.uc-ep-tab[data-tab="gif"]').dispatchEvent(new MouseEvent('mouseenter'))`);
const tip3 = await tipOf(TABTIP);
check('T2 tooltip záložky GIFy zamčeno: „Odměna není aktivována“ (jako panel), bez druhé věty, bez řádku', tip3?.title === 'Odměna není aktivována' && !tip3.lines.length && !tip3.rows.length, JSON.stringify(tip3));
await ev(`document.querySelector('.uc-ep-tab[data-tab="gif"]').dispatchEvent(new MouseEvent('mouseleave'))`);
await ev(`document.getElementById('btn-emotes').click()`);
// ---- bod 3: aktivace odměny (webhook Židolišty → SSE gif-access-change) → pásek a tooltip u ikony emotů sám, bez kliknutí ----
const stAcc = posts.state.length;
mock.gifState = () => ({ ok: true, allowed: true, cooldownUntil: null, cooldownSec: 0, serverNow: Date.now(), rewardUntil: Date.now() + 300_000, rewardTotalMs: 300_000 });
mock.sse.push(['gif-access-change', { channel: 'jinykanal' }], ['gif-access-change', { channel: 'robdiesalot' }]);
check('bod 3: SSE gif-access-change → GET /gif/state bez akce uživatele (jeden dotaz, rozprostřeně ≤ 2 s)', await waitFor(() => posts.state.length > stAcc, 6000) && (await sleep(500), posts.state.length - stAcc === 1), String(posts.state.length - stAcc));
check('bod 3: … pásek pod ikonou emotů se ukáže sám', await until(`(() => { const b = document.querySelector('#btn-emotes .uc-ep-btn-bar'); return !!b && !b.hidden && getComputedStyle(b).display !== 'none'; })()`, 3000));
await ev(`document.getElementById('btn-emotes').dispatchEvent(new MouseEvent('mouseenter'))`);
const tip3b = await tipOf(TIPSEL);
check('bod 3: … tooltip ikony „GIF odměna aktivní“', tip3b?.title === 'GIF odměna aktivní' && tip3b.rows.length === 1, JSON.stringify(tip3b));
await ev(`document.getElementById('btn-emotes').dispatchEvent(new MouseEvent('mouseleave'))`);
mock.gifState = () => ({ ok: true, allowed: true, cooldownUntil: Date.now() + 42_000, cooldownSec: 60, serverNow: Date.now(), rewardUntil: Date.now() + 300_000 });
await ev(`(async () => { window.ucGif.cd().reset(); await window.ucGif.cd().fetchState(); return true; })()`);
await ev(`document.getElementById('btn-emotes').dispatchEvent(new MouseEvent('mouseenter'))`);
const tip4 = await tipOf(TIPSEL);
check('T2 tooltip cooldown: „GIF odměna — cooldown“ + „Cooldown 42 s“ + řádek odměny', tip4?.title === 'GIF odměna — cooldown' && /^Cooldown 4\d s$/.test(tip4.cd || '') && tip4.rows.length === 1, JSON.stringify(tip4));
await ev(`document.getElementById('btn-emotes').dispatchEvent(new MouseEvent('mouseleave'))`);

// ---- test2 bod 4 + 4.1: tiché schválení (mod, cooldownSec 0) → cooldown ze serveru; cooldown notice → bez kolečka ----
mock.gifState = () => ({ ok: true, allowed: true, cooldownUntil: null, cooldownSec: 0, serverNow: Date.now() });
await ev(`(async () => { window.ucGif.cd().reset(); window.ucGif.out().clear(); await window.ucGif.cd().fetchState(); return true; })()`);
await ev(`document.getElementById('btn-emotes').click()`);
const sendT2 = posts.send.length;
mock.sendId = 't2-own';   // id zprávy z POST /chat/send = klíč průběhu (requestKey) na serveru
await glClick('.uc-gl-i[data-id$="0d"] .uc-gl-pick');
check('T2 výběr z knihovny (cooldownSec 0) → odešle se, „Odesílám…“', await waitFor(() => posts.send.length > sendT2, 4000)
  && await until(`[...document.querySelectorAll('.msg[data-msg-id^="sent-"]')].some(m => m.querySelector('.tx')?.textContent.includes(${JSON.stringify(hex(13))}) && m.querySelector('.uc-gif-st--sending'))`, 3000));
const T2NOW = Date.now();
pushAcc(['gif-progress', { requestKey: 'twitch:t2-own', channel: 'robdiesalot', platform: 'twitch', messageId: 't2-own', phase: 'detect', pct: 0 }],
  ['gif-progress', { requestKey: 'twitch:t2-own', channel: 'robdiesalot', platform: 'twitch', messageId: 't2-own', phase: 'done', pct: 100, outcome: 'approved', cooldownUntil: SN + 45_000, serverNow: SN }]);
check('T2 done approved s cooldownUntil → štítek pryč, klient zná cooldown (≈ 45 s)', await until(`window.ucGif.cd().remainingMs() > 40000`, 8000)
  && await until(`![...document.querySelectorAll('.msg[data-msg-id^="sent-"]')].some(m => m.querySelector('.tx')?.textContent.includes(${JSON.stringify(hex(13))}) && m.querySelector('.uc-gif-st'))`, 3000),
  JSON.stringify({ rem: await ev(`window.ucGif.cd().remainingMs()`), dt: Date.now() - T2NOW }));
await ev(`document.getElementById('btn-emotes').click()`);
const sendT2b = posts.send.length;
await glClick('.uc-gl-i[data-id$="0d"] .uc-gl-pick');
await sleep(400);
check('T2 další výběr z knihovny v cooldownu → neodejde, „Můžeš až za:“', posts.send.length === sendT2b && /^Můžeš až za: \d\d s$/.test((await gl())?.msg || ''), JSON.stringify(await gl()));
await ev(`document.getElementById('btn-emotes').click()`);
await typeIn(murl(hex(13)));
await clickSend();
await sleep(300);
check('T2 GIF odkaz z pole v cooldownu → neodejde, bublina „Můžeš až za:“', posts.send.length === sendT2b && await ev(`!!document.querySelector('.uc-gif-cd.uc-gif-cd--blocked:not([hidden])')`) === true);
await typeIn('');
// 4.1: odkaz přesto odešel (jiný klient / ručně) → server ho nechá jako odkaz a pošle gif-notice cooldown.
await ev(`(async () => { window.ucGif.cd().reset(); window.ucGif.out().clear(); await window.ucGif.cd().fetchState(); return true; })()`);
await typeIn(`${murl(hex(13))}`);
const sendT2c = posts.send.length;
mock.sendId = 't2-cd';
await clickSend();
check('T2 odkaz bez známého cooldownu odejde se štítkem „Odesílám…“', await waitFor(() => posts.send.length > sendT2c, 4000)
  && await until(`[...document.querySelectorAll('.msg[data-msg-id^="sent-"]')].some(m => m.querySelector('.uc-gif-st--sending'))`, 3000));
pushAcc(['gif-notice', { requestKey: 'twitch:t2-cd', channel: 'robdiesalot', platform: 'twitch', messageId: 't2-cd', kind: 'cooldown', until: SN + 30_000, serverNow: SN }]);
check('T2 4.1 gif-notice cooldown → u zprávy bez kolečka i štítku', await until(`![...document.querySelectorAll('.msg[data-msg-id^="sent-"]')].some(m => m.querySelector('.tx')?.textContent.includes(${JSON.stringify(hex(13))}) && m.querySelector('.uc-gif-st'))`, 8000)
  && await ev(`[...document.querySelectorAll('.msg[data-msg-id^="sent-"]')].some(m => m.querySelector('.tx')?.textContent.includes(${JSON.stringify(hex(13))}))`) === true);
check('T2 4.1 … hláška „GIF můžeš poslat až za 30 s — odkaz zůstal jako běžná zpráva.“ + cooldown v klientu', await until(`[...document.querySelectorAll('#chat .sys')].some(m => m.textContent === 'GIF můžeš poslat až za 30 s — odkaz zůstal jako běžná zpráva.')`, 3000)
  && await ev(`window.ucGif.cd().remainingMs() > 25000`) === true);
await typeIn('');
await ev(`(() => { window.ucGif.cd().reset(); window.ucGif.out().clear(); return true; })()`);
mock.sendId = null;

// ---- fáze G2 (mod): GIFy | Zamítnuté GIFy, duplikáty, odebrání z knihovny, token pro zamítnuté ----
mock.mod = true;
// Mod bez výjimky (2026-09-27 §5): stav odměny jako divák (tady odemčeno, konec za 5 min).
mock.gifState = () => ({ ok: true, allowed: true, cooldownUntil: null, cooldownSec: 0, serverNow: Date.now(), rewardUntil: Date.now() + 300_000 });
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
const g2r = await gl();
check('G2 mod bez výjimky: hlavička jako u diváka (aktivní = bez textu), ne „Jako mod posíláš GIFy bez odměny.“', g2r?.reward === '' && !g2r.locked, JSON.stringify(g2r));
check('G2 náhled zamítnutého: 404 s prvním tokenem → nový token (POST access-token) → načteno', await until(`[...document.querySelectorAll('.uc-gl-dups img.uc-gif-media')].some(i => i.src.includes(${JSON.stringify(`t=${goodTok}`)}) && i.complete && i.naturalWidth > 0)`, 8000),
  JSON.stringify({ token: posts.token, tok: posts.mediaTok }));
check('G2 schválený GIF v duplikátu bez tokenu', await ev(`[...document.querySelectorAll('.uc-gl-dups img.uc-gif-media')].some(i => i.getAttribute('src') === ${JSON.stringify(murl(hex(11)))})`) === true);
// Duplikát: klik na GIF = náhled (zamítnutý s tokenem), nabídka ⋯ = Náhled.
await glClick('.uc-gl-pair-i[data-id$="0e"] [data-act="preview"]');
const pvDup = await pv();
check('G2 duplikát: klik → náhled zamítnutého s tokenem, stav a použití', pvDup?.open && pvDup.src.includes(`t=${goodTok}`) && pvDup.meta === 'Zamítnutý · použito 6×', JSON.stringify(pvDup));
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
check('G2 duplikát: nabídka ⋯ s „Náhled“', await glClick('.uc-gl-pair-i[data-id$="0b"] [data-act="menu"]') && await ev(`[...document.querySelectorAll('.uc-gl-pair-i[data-id$="0b"] .uc-gl-menu:not([hidden]) button')].map(b => b.textContent).join('|')`) === 'Náhled'
  && await ev(`document.querySelectorAll('.uc-ep-pane[data-pane="gif"] .uc-gl-menu:not([hidden])').length`) === 1, 'jen jedna nabídka (stejné médium je i v knihovně)');
await glClick('.uc-gl-pair-i[data-id$="0b"] [data-act="menu"]');
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
await glClick('.uc-gl-i[data-sec="lib"][data-id$="0b"] [data-act="menu"]');
check('G2 menu GIFu: Náhled / Odebrat z knihovny / Trvale zahodit…', await ev(`[...document.querySelectorAll('.uc-gl-i[data-sec="lib"][data-id$="0b"] .uc-gl-menu:not([hidden]) button')].map(b => b.textContent).join('|')`) === 'Náhled|Odebrat z knihovny|Trvale zahodit…');
const mi2 = await menuInside('.uc-gl-i[data-sec="lib"][data-id$="0b"]');
check('G2 nabídka moda (3 položky) uvnitř panelu', mi2?.inside === true, JSON.stringify(mi2));
await glClick('.uc-gl-i[data-sec="lib"][data-id$="0b"] [data-act="unapprove"]');
check('G2 Odebrat z knihovny → POST unapprove, GIF z knihovny pryč', await until(`!document.querySelector('.uc-gl-i[data-sec="lib"][data-id$="0b"]')`, 4000) && posts.media.some((x) => x.id === hex(11) && x.action === 'unapprove'), JSON.stringify(posts.media));
// Trvale zahodit schválený: dialog se dvěma variantami + Zrušit a vysvětlením (2026-09-27)
const cf = () => ev(`(() => { const c = document.querySelector('.uc-ep-pane[data-pane="gif"] .uc-gl-confirm'); if (!c || c.hidden) return null;
  return { kind: c.dataset.kind, title: c.querySelector('b').textContent, lines: [...c.querySelectorAll('p')].map(p => p.textContent), btns: [...c.querySelectorAll('button')].map(b => b.textContent).join('|') }; })()`);
await glClick('.uc-gl-i[data-sec="lib"][data-id$="0c"] [data-act="menu"]');
await glClick('.uc-gl-i[data-sec="lib"][data-id$="0c"] [data-act="purge-ask"]');
const cf1 = await cf();
check('G2 Trvale zahodit… → dialog „Zrušit | Zahodit, zprávy nechat | Zahodit i se zprávami“ s vysvětlením', cf1?.title === 'Trvale zahodit GIF?' && cf1.btns === 'Zrušit|Zahodit, zprávy nechat|Zahodit i se zprávami'
  && cf1.lines.length === 2 && cf1.lines[1].includes('7 dní') && !posts.media.some((x) => x.id === hex(12)), JSON.stringify(cf1));
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
check('G2 Esc zavře dialog (nic neodejde), panel zůstane', await cf() === null && !posts.media.some((x) => x.id === hex(12)) && await ev(`!document.querySelector('.uc-ep').classList.contains('hidden')`) === true);
await glClick('.uc-gl-i[data-sec="lib"][data-id$="0c"] [data-act="menu"]');
await glClick('.uc-gl-i[data-sec="lib"][data-id$="0c"] [data-act="purge-ask"]');
await glClick('[data-act="confirm-keep"]');
check('G2 „Zahodit, zprávy nechat“ → POST purge { keepMessages: true }, GIF z knihovny pryč', await until(`!document.querySelector('.uc-gl-i[data-sec="lib"][data-id$="0c"]')`, 4000)
  && posts.media.some((x) => x.id === hex(12) && x.action === 'purge' && x.body?.keepMessages === true), JSON.stringify(posts.media.at(-1)));
// Zamítnuté GIFy + Stažené / Ke smazání
const DISC = (n, status, extra = {}) => ({ mediaId: hex(n), url: murl(hex(n)), kind: 'gif', width: 200, height: 100, tags: ['zahozeny'], status, purgedAt: Date.now() - 3600_000, purgedBy: 'twitch:modik', purgeAt: status === 'purging' ? Date.now() + 6 * 86400000 - 60_000 : null, restoreTo: 'approved', ...extra });
mock.wd = [DISC(21, 'withdrawn')];
mock.pg = [DISC(22, 'purging')];
mock.rejMedia.add(hex(22));
await glClick('[data-gl-tab="rej"]');
check('G2 Zamítnuté GIFy → GET rejected, 2 GIFy', await until(`document.querySelectorAll('.uc-gl-grid--rej .uc-gl-i').length === 2`, 5000) && posts.rejected.some((u) => /channel=robdiesalot/.test(u)), JSON.stringify(await gl()));
check('G2 zamítnuté náhledy s tokenem', await until(`[...document.querySelectorAll('.uc-gl-grid--rej img.uc-gif-media')].every(i => i.src.includes(${JSON.stringify(`t=${goodTok}`)}) && i.complete && i.naturalWidth > 0)`, 6000));
// Token moda jen v `src`, v žádném jiném atributu (data-uc-src, data-key, …) — obrázky v knihovně i líné video (core).
const tokInAttrs = (root, tok) => `[...(${root}).querySelectorAll('*'), ${root}].filter(Boolean).flatMap(e => [...e.attributes].filter(a => a.name !== 'src' && a.value.includes(${JSON.stringify(tok)})).map(a => e.tagName + '@' + a.name))`;
check('G2 knihovna: token moda v žádném atributu kromě src', JSON.stringify(await ev(tokInAttrs(`document.querySelector('.uc-ep-pane[data-pane="gif"]')`, 'tk-'))) === '[]', JSON.stringify(await ev(tokInAttrs(`document.querySelector('.uc-ep-pane[data-pane="gif"]')`, 'tk-'))));
const vidTok = await ev(`(async () => { const box = document.createElement('div'); box.id = 'e2e-vidtok'; document.body.appendChild(box);
  box.appendChild(window.UC_CORE.createGifMedia(document, { url: ${JSON.stringify(murl(MEDIA.vid))}, kind: 'mp4', width: 100, height: 50 }, { lazy: true, token: 'tk-vid' }));
  const before = ${tokInAttrs(`document.getElementById('e2e-vidtok')`, 'tk-vid')};
  box.scrollIntoView(); await new Promise((r) => setTimeout(r, 400));
  const v = box.querySelector('video'); const after = ${tokInAttrs(`document.getElementById('e2e-vidtok')`, 'tk-vid')}; box.remove();
  return { before, after, src: v.getAttribute('src') || '' }; })()`);
check('G2 líné video s tokenem: token jen v src (po zobrazení), ne v data-uc-src', vidTok && !vidTok.before.length && !vidTok.after.length && vidTok.src.endsWith('?t=tk-vid'), JSON.stringify(vidTok));
check('G2 kdo zamítl + kdy se smaže', /^Zamítl modik \(Twitch\) · smaže se za 13 dní$/.test(await ev(`document.querySelector('.uc-gl-grid--rej .uc-gl-meta').textContent`) || ''), await ev(`document.querySelector('.uc-gl-grid--rej .uc-gl-meta').textContent`));
check('G2 akce Schválit / Vault / Trvale zahodit', await ev(`[...document.querySelectorAll('.uc-gl-grid--rej .uc-gl-i')[0].querySelectorAll('.uc-gl-acts button')].map(b => b.textContent).join('|')`) === 'Schválit|Vault|Trvale zahodit');
// Klik na zamítnutý GIF = náhled (kdo a kdy zamítl, s tokenem)
await glClick('.uc-gl-grid--rej .uc-gl-i[data-id$="0f"] [data-act="preview"]');
const pvRej = await pv();
check('G2 zamítnuté: klik → náhled s tokenem, „Zamítl modik (Twitch) · <kdy>“', pvRej?.open && pvRej.src.includes(`t=${goodTok}`) && /^Zamítl modik \(Twitch\) · \d+\. \d+\. \d+:\d\d$/.test(pvRej.meta), JSON.stringify(pvRej));
check('G2 náhled: token není v atributu data-key (jen v paměti)', await ev(`(() => { const p = document.querySelector('.uc-ep-pane[data-pane="gif"] .uc-gl-preview'); return !!p.dataset.key && !p.dataset.key.includes('tk-') && p.dataset.key === 'rej:' + ${JSON.stringify(hex(15))}; })()`) === true,
  await ev(`document.querySelector('.uc-ep-pane[data-pane="gif"] .uc-gl-preview')?.dataset.key`));
await glClick('.uc-gl-preview [data-act="preview-close"]');
// Sekce Stažené GIFy / Ke smazání
check('G2 sekce „Stažené GIFy (1)“ a „Ke smazání (1)“ (GET withdrawn + purging)', await until(`document.querySelectorAll('.uc-gl-grid--disc .uc-gl-i').length === 2`, 5000)
  && await ev(`[...document.querySelectorAll('.uc-ep-pane[data-pane="gif"] .uc-gl-h')].map(h => h.textContent).join('|')`) === 'Zamítnuté (2 GIFy)|Stažené GIFy (1)|Ke smazání (1)'
  && posts.disc.some((u) => /withdrawn\?channel=robdiesalot/.test(u)) && posts.disc.some((u) => /purging\?channel=robdiesalot/.test(u)), await ev(`[...document.querySelectorAll('.uc-ep-pane[data-pane="gif"] .uc-gl-h')].map(h => h.textContent).join('|')`));
const disc = await ev(`(() => { const q = (s) => document.querySelector(s); const pg = q('.uc-gl-grid--pg .uc-gl-i'), wd = q('.uc-gl-grid--wd .uc-gl-i');
  return { pgMeta: pg?.querySelector('.uc-gl-meta')?.textContent, pgBtns: [...pg.querySelectorAll('.uc-gl-acts button')].map(b => b.textContent).join('|'), pgTok: pg?.querySelector('img')?.src.includes('t='),
    wdMeta: wd?.querySelector('.uc-gl-meta')?.textContent, wdBtns: [...wd.querySelectorAll('.uc-gl-acts button')].map(b => b.textContent).join('|'), wdTok: wd?.querySelector('img')?.src.includes('t=') }; })()`);
check('G2 Ke smazání: odpočet „smaže se za 6 dní“ + Obnovit (náhled s tokenem); Stažené: Odstranit ze serveru (bez tokenu)',
  disc?.pgMeta === 'Zahodil modik (Twitch) · smaže se za 6 dní' && disc.pgBtns === 'Obnovit' && disc.pgTok === true
  && disc.wdMeta === 'Zahodil modik (Twitch) · zprávy zůstaly' && disc.wdBtns === 'Odstranit ze serveru' && disc.wdTok === false, JSON.stringify(disc));
await glClick('.uc-gl-grid--pg .uc-gl-i [data-act="preview"]');
check('G2 Ke smazání: náhled s tokenem a odpočtem', / · smaže se za 6 dní$/.test((await pv())?.meta || '') && (await pv()).src.includes('t='), JSON.stringify(await pv()));
await ev(`document.querySelector('.uc-ep-pane[data-pane="gif"] .uc-gl-preview').click()`);
mock.pg = [];
await glClick('.uc-gl-grid--pg .uc-gl-i [data-act="restore"]');
check('G2 Obnovit → POST restore, sekce Ke smazání zmizí, hláška „obnoven zpět do knihovny“', await until(`!document.querySelector('.uc-gl-grid--pg')`, 4000)
  && posts.media.some((x) => x.id === hex(22) && x.action === 'restore') && (await gl())?.msg === 'GIF obnoven zpět do knihovny.', JSON.stringify(await gl()));
await glClick('.uc-gl-grid--wd .uc-gl-i [data-act="remove-ask"]');
const cf2 = await cf();
check('G2 Odstranit ze serveru → potvrzení „Staré zprávy ukážou [GIF nedostupný]. Nejde vrátit.“', cf2?.kind === 'remove-file' && cf2.lines[0] === 'Staré zprávy ukážou [GIF nedostupný]. Nejde vrátit.' && cf2.btns === 'Zrušit|Odstranit ze serveru'
  && !posts.media.some((x) => x.id === hex(21)), JSON.stringify(cf2));
mock.wd = [];
await glClick('[data-act="confirm-remove"]');
check('G2 … POST remove-file, stažený GIF pryč', await until(`!document.querySelector('.uc-gl-grid--wd')`, 4000) && posts.media.some((x) => x.id === hex(21) && x.action === 'remove-file'));
await glClick('.uc-gl-grid--rej .uc-gl-i[data-id$="0f"] [data-act="vault"]');
check('G2 Vault → POST vault, „Ve vaultu“', await until(`document.querySelector('.uc-gl-grid--rej .uc-gl-i[data-id$="0f"] [data-act="vault"]')?.textContent === 'Ve vaultu'`, 4000) && posts.media.some((x) => x.id === hex(15) && x.action === 'vault'));
await glClick('.uc-gl-grid--rej .uc-gl-i[data-id$="10"] [data-act="approve"]');
check('G2 Schválit → POST approve, pryč ze zamítnutých', await until(`!document.querySelector('.uc-gl-grid--rej .uc-gl-i[data-id$="10"]')`, 4000) && posts.media.some((x) => x.id === hex(16) && x.action === 'approve'));
await glClick('.uc-gl-grid--rej .uc-gl-i[data-id$="0f"] [data-act="purge-ask"]');
check('G2 Trvale zahodit zamítnutý → stejný dialog se dvěma variantami', (await cf())?.btns === 'Zrušit|Zahodit, zprávy nechat|Zahodit i se zprávami');
await glClick('[data-act="confirm-purge"]');
check('G2 „Zahodit i se zprávami“ → POST purge { keepMessages: false }', await until(`!document.querySelector('.uc-gl-grid--rej .uc-gl-i')`, 4000)
  && posts.media.some((x) => x.id === hex(15) && x.action === 'purge' && x.body?.keepMessages === false), JSON.stringify(posts.media.at(-1)));
// SSE gif-media library (zahodil jiný mod, viditelnost zpráv beze změny) → otevřený panel se načte znovu do ~2 s.
await sleep(300);
const rejN = posts.rejected.length, discN = posts.disc.length;
mock.sse.push(['gif-media', { channel: 'robdiesalot', mediaId: hex(16), state: 'library' }]);
check('G2 gif-media library → Zamítnuté i zahozené se načtou znovu (rozprostřeně do 2 s)', await waitFor(() => posts.rejected.length > rejN && posts.disc.length > discN, 5000), JSON.stringify({ rej: posts.rejected.length - rejN, disc: posts.disc.length - discN }));await ev(`document.getElementById('btn-emotes').click()`);

// Karta moda: žádost na dříve zamítnuté médium (media.tokenRequired) → náhled s tokenem moda (backend audit 2026-09-27).
pushAcc(['gif-pending', pend0(95, { createdAt: 1, media: { url: murl(hex(14)), kind: 'gif', width: 20, height: 20, tokenRequired: true } })]);
check('G2 karta: dříve zamítnuté médium (tokenRequired) → náhled s tokenem, načtený', await until(`(() => { const i = document.querySelector('.uc-gif-card[data-request-id="95"] img.uc-gif-media'); return !!i && /[?&]t=tk-/.test(i.src) && i.complete && i.naturalWidth > 0; })()`, 8000),
  await ev(`document.querySelector('.uc-gif-card[data-request-id="95"] img.uc-gif-media')?.src.replace(/t=[^&]+/, 't=…') || null`));
check('G2 karta: token jen v src (ne v jiném atributu)', await ev(`(() => { const c = document.querySelector('.uc-gif-card[data-request-id="95"]'); return !!c && ![...c.querySelectorAll('*')].some(e => [...e.attributes].some(a => a.name !== 'src' && /tk-/.test(a.value))); })()`) === true);
pushAcc(['gif-decided', { requestId: 95, channel: 'robdiesalot', approved: false, status: 'rejected', by: 'twitch:jiny' }]);
await until(`!document.querySelector('.uc-gif-card[data-request-id="95"]')`, 6000);

// ---- test2 bod 2: streamer (vlastní kanál) — Zamítnuté / Stažené / Ke smazání rozmazané, oko zaostří; mod ostře ----
check('T2 mod (ne streamer): zamítnuté GIFy ostře, bez oka', await ev(`(async () => { document.getElementById('btn-emotes').click(); await new Promise(r => setTimeout(r, 300)); document.querySelector('[data-gl-tab="rej"]').click(); await new Promise(r => setTimeout(r, 800)); const t = document.querySelectorAll('.uc-gl-grid--rej .uc-gl-i'); const out = t.length > 0 && [...t].every(i => !i.classList.contains('uc-gl-i--blur') && !i.querySelector('.uc-gl-eye')); document.getElementById('btn-emotes').click(); return out; })()`) === true);
mock.meLogin = 'robdiesalot';
mock.wd = [DISC(23, 'withdrawn')];
mock.pg = [DISC(24, 'purging')];
mock.rejMedia.add(hex(24));
await boot();
await until(`document.body.classList.contains('uc-can-moderate')`);
await ev(`document.getElementById('btn-emotes').click()`);
await ev(`document.querySelector('.uc-ep-tab[data-tab="gif"]').click()`);
await until(`!!document.querySelector('[data-gl-tab="rej"]')`, 4000);
await glClick('[data-gl-tab="rej"]');
await until(`document.querySelectorAll('.uc-gl-grid--rej .uc-gl-i').length > 0 && document.querySelectorAll('.uc-gl-grid--disc .uc-gl-i').length === 2`, 6000);
const blurSt = () => ev(`[...document.querySelectorAll('.uc-ep-pane[data-pane="gif"] .uc-gl-i[data-sec]')].filter(i => ['rej', 'wd', 'pg'].includes(i.dataset.sec)).map(i => ({ sec: i.dataset.sec, id: i.dataset.id.slice(-2), blur: i.classList.contains('uc-gl-i--blur'), eye: i.querySelector(':scope > .uc-gl-eye')?.getAttribute('aria-label') || null,
  filter: getComputedStyle(i.querySelector('.uc-gif-media') || i).filter }))`);
const bz0 = await blurSt();
check('T2 streamer: Zamítnuté, Stažené i Ke smazání rozmazané (filter blur) s okem „Zobrazit GIF“', bz0?.length >= 3 && ["rej", "wd", "pg"].every(sec => bz0.some(x => x.sec === sec)) && bz0.every(x => x.blur && x.eye === "Zobrazit GIF" && /blur/.test(x.filter)), JSON.stringify(bz0));
const sendEye = posts.send.length, prevEye = posts.media.length;
await glClick('.uc-gl-grid--rej .uc-gl-i [data-act="eye"]');
await sleep(350);   // přechod filtru 0,2 s
const bz1 = await blurSt();
check('T2 streamer: oko zaostří jen tu dlaždici (bez náhledu, bez akce)', bz1[0].blur === false && bz1[0].eye === "Rozmazat GIF" && !/blur/.test(bz1[0].filter) && bz1.slice(1).every(x => x.blur) && (await pv())?.open === false && posts.send.length === sendEye && posts.media.length === prevEye, JSON.stringify(bz1));
await glClick('.uc-gl-grid--rej .uc-gl-i [data-act="eye"]');
check('T2 streamer: oko znovu rozmaže', (await blurSt())[0].blur === true);
await glClick('.uc-gl-grid--pg .uc-gl-i [data-act="eye"]');
check('T2 streamer: Ke smazání — oko zaostří', (await blurSt()).find(x => x.sec === 'pg')?.blur === false);
await ev(`document.getElementById('btn-emotes').click()`);
mock.meLogin = null;
mock.wd = []; mock.pg = [];

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

// ---- fáze H: SSE gif-media — zahození / obnova / odstranění souboru překreslí zprávy s GIFem (2026-09-27) ----
mock.mod = false;
await boot();
await until(`!!document.querySelector('.msg[data-msg-id="gif-5"] .uc-gif img')`, 5000);
const gm = (id) => ev(`(() => { const m = document.querySelector('.msg[data-msg-id="${id}"]'); if (!m) return null;
  return { deleted: m.classList.contains('uc-deleted'), img: !!m.querySelector('.uc-gif img.uc-gif-media'), label: m.querySelector('.uc-gif-fallback')?.textContent || null, text: m.querySelector('.tx')?.textContent || '' }; })()`);
mock.sse.push(['gif-media', { channel: 'jiny', mediaId: MEDIA.ok, state: 'removed' }]);
mock.sse.push(['gif-media', { channel: 'robdiesalot', mediaId: MEDIA.ok, state: 'removed' }]);
check('H gif-media removed → obě zprávy s médiem „smazané“ bez GIFu (cizí kanál ignorován)', await until(`(() => { const a = document.querySelector('.msg[data-msg-id="gif-5"]'), b = document.querySelector('.msg[data-msg-id="gif-8"]'); return !!a && !!b && a.classList.contains('uc-deleted') && b.classList.contains('uc-deleted') && !a.querySelector('.uc-gif') && !b.querySelector('.uc-gif'); })()`, 6000),
  JSON.stringify([await gm('gif-5'), await gm('gif-8')]));
mock.byId = [{ platform: 'twitch', id: 'gif-5', username: 'Divak', userId: 'u9', message: 'z historie', timestamp: now - 58000, historical: true, gif: { url: murl(MEDIA.ok), kind: 'gif', width: 498, height: 280 } }];
const byId0 = posts.byId.length;
mock.sse.push(['gif-media', { channel: 'robdiesalot', mediaId: MEDIA.ok, state: 'visible', messageIds: ['twitch:gif-5', 'twitch:gif-neni'] }]);
check('H gif-media visible (jen id) → GET /chat/messages s id, které chat má → zpráva obnovená na místě s textem i GIFem', await until(`(() => { const m = document.querySelector('.msg[data-msg-id="gif-5"]'); return !!m && !m.classList.contains('uc-deleted') && !!m.querySelector('.uc-gif img.uc-gif-media') && m.querySelector('.tx')?.textContent === 'z historie'; })()`, 6000)
  && posts.byId.length === byId0 + 1 && decodeURIComponent(posts.byId.at(-1)).includes('channel=robdiesalot&ids=twitch:gif-5') && !decodeURIComponent(posts.byId.at(-1)).includes('gif-neni'),
  JSON.stringify({ m: await gm('gif-5'), q: posts.byId.slice(byId0).map(decodeURIComponent) }));
check('H … zpráva, kterou chat nemá, se nepřidá; zpráva mimo událost zůstane smazaná', await ev(`!document.querySelector('.msg[data-msg-id="gif-neni"]')`) === true && (await gm('gif-8'))?.deleted === true);
mock.sse.push(['gif-media', { channel: 'robdiesalot', mediaId: MEDIA.ok, state: 'unavailable' }]);
check('H gif-media unavailable → místo GIFu „[GIF nedostupný]“, text zůstává', await until(`document.querySelector('.msg[data-msg-id="gif-5"] .uc-gif--unavailable .uc-gif-fallback')?.textContent === '[GIF nedostupný]'`, 6000)
  && (await gm('gif-5'))?.text === 'z historie' && !(await gm('gif-5')).img, JSON.stringify(await gm('gif-5')));

console.log(`\n${pass} PASS, ${fail} FAIL`);
finish(fail ? 1 : 0);
