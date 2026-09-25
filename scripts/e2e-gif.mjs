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
];
const mock = { mod: true, sse: [], acc: [], heldAcc: null, decide: {} };   // decide[id] = { code, body }
const posts = { decide: [], pending: [], tickets: 0, auth: [], send: [] };
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
    const id = u.split('/media/gif/')[1];
    if (id === MEDIA.vid) return;   // video: podržet (jen kontrola prvku, ne dekódování)
    if (id === MEDIA.bad) return json({ ok: false, error: 'not_found' }, 404);
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
  const dm = u.match(/\/moderation\/gif\/(\d+)\/decide/);
  if (dm) {
    posts.decide.push({ id: dm[1], body, auth: q.headers?.Authorization || q.headers?.authorization || null });
    const r = mock.decide[dm[1]];
    if (r) return json(r.body, r.code);
    return json({ ok: true, requestId: Number(dm[1]), status: body.approve ? 'approved' : 'rejected' });
  }
  if (u.includes('/chat/send')) { posts.send.push(body); return json({ ok: true, id: 'x' }); }
  if (u.includes('/chat/history')) return json({ ok: true, messages: u.includes('before=') ? [] : H1, nextBefore: null });
  return call('Fetch.continueRequest', { requestId: rid }, sid);
};
await call('Fetch.enable', { patterns: ['/auth/me', '/moderation/', '/chat/history', '/chat/send', '/nicknames/stream', '/account/', '/media/gif/'].map((p) => ({ urlPattern: `*api.jouki.cz${p}*` })) }, sessionId);
await call('Runtime.enable', {}, sessionId);
const ev = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId); if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 300) }; return r.result?.result?.value; };
const until = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr) === true) return true; await sleep(150); } return false; };
const card = (id) => ev(`(() => { const c = document.querySelector('.uc-gif-card[data-request-id="${id}"]'); if (!c) return null;
  const vis = (e) => !!e && !e.hidden && getComputedStyle(e).display !== 'none';
  return { cls: [...c.classList].filter(x => x.startsWith('uc-gif-card--')).sort().join(' '), who: c.querySelector('.uc-gif-card-who').textContent,
    kind: c.querySelector('.uc-gif-card-kind').textContent, text: c.querySelector('.uc-gif-card-text').textContent,
    status: vis(c.querySelector('.uc-gif-card-status')) ? c.querySelector('.uc-gif-card-status').textContent : '',
    err: vis(c.querySelector('.uc-gif-card-err')) ? c.querySelector('.uc-gif-card-err').textContent : '',
    buttons: vis(c.querySelector('.uc-gif-card-actions')) ? [...c.querySelectorAll('.uc-gif-card-actions button')].map(b => b.textContent) : [],
    timer: vis(c.querySelector('.uc-gif-timer')) ? c.querySelector('.uc-gif-timer').textContent : null,
    media: !!c.querySelector('.uc-gif-card-media .uc-gif-media'), inWrapper: c.parentElement?.parentElement?.id === 'chat-wrapper' }; })()`);
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

// GET pending (mod) → karta 20
check('A GET /moderation/gif/pending s kanálem', await until(`true`, 10) && posts.pending.some((x) => /pending\?channel=robdiesalot$/.test(x)), posts.pending.join(' | '));
check('A karta z GET pending', await until(`!!document.querySelector('.uc-gif-card[data-request-id="20"]')`, 5000));
const c20 = await card(20);
check('A karta: jméno, text, náhled, odpočet, tlačítka, u spodku chatu', c20?.who === 'divak20' && c20.text === 'z GET pending' && c20.media && /^[45]:\d\d$/.test(c20.timer || '') && JSON.stringify(c20.buttons) === '["Zamítnout","Schválit"]' && c20.inWrapper && c20.kind === 'Chce poslat GIF', JSON.stringify(c20));

// gif-pending přes /account/stream (jedna dávka — klient se po konci spojení připojuje znovu za 5 s)
pushAcc(
  ['gif-pending', pend0(21)],
  ['gif-pending', pend0(22)],
  ['gif-pending', pend0(23)],
  ['gif-pending', pend0(24, { expiresAt: Date.now() + 5000 })],
  ['gif-pending', pend0(25, { channel: 'jinykanal' })],
  ['gif-pending', pend0(29, { media: { url: `https://evil.example/media/gif/${MEDIA.card}`, kind: 'gif' } })],
  ['gif-pending', pend0(20, { text: 'z GET pending' })],   // znovu po připojení streamu → bez duplicity
);
check('A gif-pending ze streamu → karty 21–24', await until(`[21,22,23,24].every(i => !!document.querySelector('.uc-gif-card[data-request-id="' + i + '"]'))`, 10000));
check('A gif-pending z cizího kanálu ignorováno', await ev(`!document.querySelector('.uc-gif-card[data-request-id="25"]')`) === true);
check('A opakované gif-pending bez duplicity', await ev(`document.querySelectorAll('.uc-gif-card[data-request-id="20"]').length`) === 1);
check('A cizí origin média (pending) → bez karty', await ev(`!document.querySelector('.uc-gif-card[data-request-id="29"]')`) === true);
const stackTxt = await ev(`(() => { const cs = [...document.querySelectorAll('.uc-gif-card')]; return { total: cs.length, visible: cs.filter(c => !c.hidden).map(c => c.dataset.requestId).join(','), more: document.querySelector('.uc-gif-more:not([hidden])')?.textContent || null, last: document.querySelector('.uc-gif-stack').lastElementChild.className }; })()`);
check('A zásobník: 3 karty + „+2 další GIFy“ na konci', stackTxt?.total === 5 && stackTxt.visible === '20,21,22' && stackTxt.more === '+2 další GIFy' && stackTxt.last === 'uc-gif-more', JSON.stringify(stackTxt));
await ev(`document.querySelector('.uc-gif-more').click()`);
check('A klik na „+2“ → všechny karty, „Sbalit“', await ev(`[...document.querySelectorAll('.uc-gif-card')].every(c => !c.hidden) && document.querySelector('.uc-gif-more').textContent === 'Sbalit'`) === true);
const scrollable = await ev(`(() => { const s = document.querySelector('.uc-gif-stack'); const r = s.getBoundingClientRect(); const hit = document.elementFromPoint(r.right - 3, r.top + 10); return { over: s.scrollHeight > s.clientHeight, hitInStack: s.contains(hit), pe: getComputedStyle(s).pointerEvents }; })()`);
check('A rozbalený zásobník se dá posouvat (posuvník patří zásobníku)', scrollable?.over === true && scrollable.hitInStack && scrollable.pe !== 'none', JSON.stringify(scrollable));
await ev(`document.querySelector('.uc-gif-more').click()`);
const cm = await ev(`(() => { const i = document.querySelector('.uc-gif-card[data-request-id="21"] .uc-gif-media'); const r = i.getBoundingClientRect(); return { w: i.getAttribute('width'), h: i.getAttribute('height'), rw: Math.round(r.width), rh: Math.round(r.height) }; })()`);
check('A náhled v kartě 498×280 → 285×160 bez deformace', cm?.w === '285' && cm.h === '160' && cm.rh === 160 && Math.abs(cm.rw / cm.rh - 498 / 280) < 0.02, JSON.stringify(cm));
// Vrstvení: tlačítko „↓ Nové zprávy“ a panel emotů nad kartami.
const zScroll = await ev(`(() => { const b = document.getElementById('btn-scroll'); b.classList.remove('hidden'); const r = b.getBoundingClientRect(); const s = document.querySelector('.uc-gif-stack').getBoundingClientRect();
  const overlap = r.top < s.bottom && r.bottom > s.top; const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); b.classList.add('hidden'); return { overlap, onTop: b.contains(hit) }; })()`);
check('A „↓ Nové zprávy“ nad kartami', zScroll?.overlap && zScroll.onTop, JSON.stringify(zScroll));
await ev(`document.getElementById('btn-emotes').click()`);
await until(`!!document.querySelector('.uc-ep') && getComputedStyle(document.querySelector('.uc-ep')).display !== 'none'`, 3000);
const zEp = await ev(`(() => { const p = document.querySelector('.uc-ep'); if (!p) return null; const r = p.getBoundingClientRect(); const s = document.querySelector('.uc-gif-stack').getBoundingClientRect();
  const y = Math.max(r.top, s.top) + 5; const overlap = r.top < s.bottom && r.bottom > s.top; const hit = document.elementFromPoint(r.left + r.width / 2, y); return { overlap, onTop: p.contains(hit) }; })()`);
check('A panel emotů nad kartami', zEp?.overlap && zEp.onTop, JSON.stringify(zEp));
await ev(`document.getElementById('btn-emotes').click()`);

// Schválit 21
await click(21, 'approve');
check('A Schválit → POST decide approve:true s Bearer', await until(`true`, 10) && await (async () => { const t = Date.now(); while (Date.now() - t < 4000) { if (posts.decide.some((x) => x.id === '21')) return true; await sleep(100); } return false; })()
  && posts.decide.find((x) => x.id === '21').body?.approve === true && posts.decide.find((x) => x.id === '21').auth === 'Bearer tok', JSON.stringify(posts.decide));
check('A schváleno → zelená + „Schváleno · tebou", bez tlačítek', await until(`document.querySelector('.uc-gif-card[data-request-id="21"]')?.classList.contains('uc-gif-card--approved')`, 3000)
  && (await card(21))?.status === 'Schváleno · tebou' && (await card(21)).buttons.length === 0, JSON.stringify(await card(21)));

// Zamítnout 22
await click(22, 'reject');
check('A Zamítnout → POST approve:false + červená', await until(`document.querySelector('.uc-gif-card[data-request-id="22"]')?.classList.contains('uc-gif-card--rejected')`, 3000)
  && posts.decide.find((x) => x.id === '22')?.body?.approve === false && (await card(22))?.status === 'Zamítnuto · tebou', JSON.stringify(await card(22)));

// 409 already_decided
mock.decide['23'] = { code: 409, body: { ok: false, error: 'already_decided', status: 'approved' } };
await click(23, 'approve');
check('A 409 already_decided → stav z těla + „už rozhodl jiný mod"', await until(`document.querySelector('.uc-gif-card[data-request-id="23"]')?.classList.contains('uc-gif-card--approved')`, 3000)
  && (await card(23))?.status === 'O GIFu už rozhodl jiný mod.', JSON.stringify(await card(23)));

// karta po rozhodnutí zmizí
check('A rozhodnutá karta po chvíli zmizí', await until(`!document.querySelector('.uc-gif-card[data-request-id="21"]')`, 7000));

// propadnutí (lokálně podle expiresAt)
check('A propadnutí → šedá karta „Propadlo"', await until(`document.querySelector('.uc-gif-card[data-request-id="24"]')?.classList.contains('uc-gif-card--expired')`, 8000)
  && (await card(24))?.status === 'Propadlo — nikdo nerozhodl včas' && (await card(24)).buttons.length === 0, JSON.stringify(await card(24)));

// rozhodnutí jiného moda (gif-decided) pro kartu 20
pushAcc(['gif-decided', { requestId: 20, channel: 'robdiesalot', approved: false, status: 'rejected', by: 'twitch:jinymod' }]);
check('A gif-decided jiného moda → „Zamítnuto · jinymod (Twitch)"', await until(`document.querySelector('.uc-gif-card[data-request-id="20"]')?.classList.contains('uc-gif-card--rejected')`, 12000)
  && (await card(20))?.status === 'Zamítnuto · jinymod (Twitch)', JSON.stringify(await card(20)));
check('A … a karta zmizí', await until(`!document.querySelector('.uc-gif-card[data-request-id="20"]')`, 7000));
check('A po všech rozhodnutích zásobník pryč', await until(`!document.querySelector('.uc-gif-stack')`, 7000));

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
check('C ztráta role → cizí karta pryč, vlastní zůstává; cizí pending divákovi nevznikne', coreC?.before === '101,102' && coreC.after === '102' && coreC.dropped === false, JSON.stringify(coreC));
check('C decide po clear() → nic nevykreslí', coreC?.res === null && coreC.left === 0, JSON.stringify(coreC));

// ---- fáze B: divák = odesílatel ----
mock.mod = false;
const pendBefore = posts.pending.length;
await boot();
await until(`!document.body.classList.contains('uc-can-moderate')`);
pushAcc(
  ['gif-pending', pend0(30, { own: true, login: 'moduser' })],
  ['gif-pending', pend0(31, { own: true, login: 'moduser' })],
  ['gif-pending', pend0(32, { own: true, login: 'moduser' })],
  ['gif-pending', pend0(33)],   // cizí — divák ji nemá vidět
);
check('B vlastní GIF → karta „GIF čeká na schválení"', await until(`!!document.querySelector('.uc-gif-card[data-request-id="32"]')`, 12000));
const c30 = await card(30);
check('B divák: bez tlačítek, „Tvůj GIF", odpočet', c30?.status === 'GIF čeká na schválení' && c30.buttons.length === 0 && c30.kind === 'Tvůj GIF' && !!c30.timer && c30.cls.includes('uc-gif-card--own'), JSON.stringify(c30));
check('B cizí žádost divákovi bez karty', await ev(`!document.querySelector('.uc-gif-card[data-request-id="33"]')`) === true);
check('B divák nevolá GET pending', posts.pending.length === pendBefore, `${pendBefore} → ${posts.pending.length}`);
pushAcc(
  ['gif-decided', { requestId: 30, channel: 'robdiesalot', approved: true, status: 'approved', by: 'twitch:modik', own: true }],
  ['gif-decided', { requestId: 31, channel: 'robdiesalot', approved: false, status: 'rejected', by: 'twitch:modik', own: true }],
  ['gif-decided', { requestId: 32, channel: 'robdiesalot', approved: false, status: 'expired', by: null, own: true }],
);
check('B schváleno → „GIF byl schválen"', await until(`document.querySelector('.uc-gif-card[data-request-id="30"]')?.classList.contains('uc-gif-card--approved')`, 12000) && (await card(30))?.status === 'GIF byl schválen', JSON.stringify(await card(30)));
check('B zamítnuto → „GIF byl zamítnut"', (await card(31))?.status === 'GIF byl zamítnut', JSON.stringify(await card(31)));
check('B propadlo → „O GIFu nikdo nerozhodl včas"', (await card(32))?.status === 'O GIFu nikdo nerozhodl včas', JSON.stringify(await card(32)));
check('B karty po chvíli zmizí', await until(`!document.querySelector('.uc-gif-card')`, 7000));
check('B GIF z historie vidí i divák', await ev(`!!document.querySelector('.msg[data-msg-id="gif-5"] .uc-gif img')`) === true);

console.log(`\n${pass} PASS, ${fail} FAIL`);
finish(fail ? 1 : 0);
