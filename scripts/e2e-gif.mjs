// E2E (headless Chrome + CDP): odměna „Posílání GIFů" (moderace část 4) v addonu.
//  A (mod): GIF z historie (img 400×225, lazy), chyba média → odkaz, GET /moderation/gif/pending → karta,
//     gif-pending z /account/stream (karta s náhledem, textem, odpočtem), Schválit (POST decide) → „Schváleno · tebou"
//     → karta zmizí, SSE gif-message → zpráva s GIFem (dedup), MP4 = <video autoplay loop muted playsinline>,
//     Zamítnout, 409 already_decided, rozhodnutí jiného moda (gif-decided), propadnutí, cizí kanál, smazání GIFu modem.
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
const posts = { decide: [], pending: [], tickets: 0, auth: [] };
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
  if (u.includes('/chat/history')) return json({ ok: true, messages: u.includes('before=') ? [] : H1, nextBefore: null });
  return call('Fetch.continueRequest', { requestId: rid }, sid);
};
await call('Fetch.enable', { patterns: ['/auth/me', '/moderation/', '/chat/history', '/nicknames/stream', '/account/', '/media/gif/'].map((p) => ({ urlPattern: `*api.jouki.cz${p}*` })) }, sessionId);
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
  ['gif-pending', pend0(20, { text: 'z GET pending' })],   // znovu po připojení streamu → bez duplicity
);
check('A gif-pending ze streamu → karty 21–24', await until(`[21,22,23,24].every(i => !!document.querySelector('.uc-gif-card[data-request-id="' + i + '"]'))`, 10000));
check('A gif-pending z cizího kanálu ignorováno', await ev(`!document.querySelector('.uc-gif-card[data-request-id="25"]')`) === true);
check('A opakované gif-pending bez duplicity', await ev(`document.querySelectorAll('.uc-gif-card[data-request-id="20"]').length`) === 1);

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
mock.sse.push(['gif-message', GM(27, { url: 'https://evil.example/x.gif', kind: 'gif' })]);
mock.sse.push(['gif-message', GM(28, { url: murl(MEDIA.vid), kind: 'mp4', width: 640, height: 360 }, '')]);
check('A MP4 → <video autoplay loop muted playsinline>, 400×225', await until(`!!document.querySelector('.msg[data-msg-id="gif-28"] video.uc-gif-media')`, 6000)
  && await ev(`(() => { const v = document.querySelector('.msg[data-msg-id="gif-28"] video'); return v.autoplay && v.loop && v.muted && v.hasAttribute('playsinline') && v.getAttribute('width') === '400' && v.getAttribute('height') === '225'; })()`) === true);
check('A MP4 viditelné → src z našeho serveru (lazy přes IntersectionObserver)', await until(`document.querySelector('.msg[data-msg-id="gif-28"] video')?.getAttribute('src') === ${JSON.stringify(murl(MEDIA.vid))}`, 4000));
check('A gif-message z cizího kanálu / s cizím médiem ignorováno', await ev(`!document.querySelector('.msg[data-msg-id="gif-26"]') && !document.querySelector('.msg[data-msg-id="gif-27"]')`) === true);

// Smazání GIFu modem → médium pryč
mock.sse.push(['message-deleted', { channel: 'robdiesalot', platform: 'twitch', messageId: 'gif-21', by: 'twitch:jinymod' }]);
check('A message-deleted gif-21 → GIF pryč, zpráva smazaná', await until(`(() => { const m = document.querySelector('.msg[data-msg-id="gif-21"]'); return !!m && m.classList.contains('uc-deleted') && !m.querySelector('.uc-gif'); })()`, 6000));

// ---- fáze B: divák = odesílatel ----
mock.mod = false;
const pendBefore = posts.pending.length;
await boot();
await until(`!document.body.classList.contains('uc-can-moderate')`);
pushAcc(
  ['gif-pending', pend0(30, { own: true, login: 'moduser' })],
  ['gif-pending', pend0(31, { own: true, login: 'moduser' })],
  ['gif-pending', pend0(32, { own: true, login: 'moduser' })],
);
check('B vlastní GIF → karta „GIF čeká na schválení"', await until(`!!document.querySelector('.uc-gif-card[data-request-id="32"]')`, 12000));
const c30 = await card(30);
check('B divák: bez tlačítek, „Tvůj GIF", odpočet', c30?.status === 'GIF čeká na schválení' && c30.buttons.length === 0 && c30.kind === 'Tvůj GIF' && !!c30.timer && c30.cls.includes('uc-gif-card--own'), JSON.stringify(c30));
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
