// E2E (headless Chrome + CDP): záloha „jen přes UnityChat“ (core/uc-only.js, backend /chat/uc-only) v addonu —
// neodeslaná zpráva se automaticky pošle přes server a ukáže s logem UnityChatu; commandy ne; SSE zpráva jiného.
// Spuštění: node scripts/e2e-uc-only.mjs
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-e2e-uco-'));
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
const now = Date.now();
const H1 = [{ platform: 'twitch', id: 'tw-1', username: 'TwTester', userId: 'u1', message: 'ahoj', color: '#1e90ff', timestamp: now - 30000, historical: true }];
const mock = { sendFail: true };
const posts = { send: [], uco: [] };
const fulfill = (rid, sid, code, type, body) => call('Fetch.fulfillRequest', { requestId: rid, responseCode: code, responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: Buffer.from(body).toString('base64') }, sid);
s.onevent = async (d) => {
  if (d.method !== 'Fetch.requestPaused') return;
  const q = d.params.request; const rid = d.params.requestId; const sid = d.sessionId;
  const json = (o, code = 200) => fulfill(rid, sid, code, 'application/json', JSON.stringify(o));
  const u = q.url;
  const body = q.postData ? JSON.parse(q.postData) : null;
  if (u.includes('/nicknames/stream')) return fulfill(rid, sid, 200, 'text/event-stream', 'retry: 60000\n\n');
  if (u.includes('/nicknames')) return json({ ok: true, nicknames: [{ platform: 'youtube', username: 'winter_ian', nickname: 'W1nter I.', color: null }] });
  if (u.includes('/account/stream-ticket')) return json({ ok: true, ticket: 'tk', expiresInMs: 60000 });
  if (u.includes('/account/stream')) return;
  if (u.includes('/account/warnings')) return json({ ok: true, warnings: [] });
  if (u.includes('/auth/me')) return json({ ok: true, accountId: 7, platforms: { twitch: { login: 'moduser', displayName: 'ModUser' }, youtube: { login: '@moduser', displayName: 'ModUser' } }, warnings: [] });
  if (u.includes('/moderation/me')) return json({ ok: true, mod: false, platforms: [], missingScopes: {} });
  if (u.includes('/chat/uc-only')) {
    posts.uco.push(body);
    if (posts.uco.length > 2) {
      // E: přímé odeslání z YouTube — GIF server schová (gif_request) a pošle bez obsahu.
      const id = `uco-${posts.uco.length}`;
      const gif = /\.gif\b/.test(body.text);
      return json({ ok: true, id, message: { platform: body.platform, id, username: 'ModUser', userId: 'y7', message: gif ? '' : body.text, timestamp: Date.now(), uc: true, ucOnly: true, historical: false, ...(gif ? { deleted: true, deletedReason: 'gif_request' } : {}) } });
    }
    return json({ ok: true, id: 'uco-1', message: { platform: body.platform, id: 'uco-1', username: 'ModUser', userId: 'u7', message: body.text, timestamp: Date.now(), uc: true, ucOnly: true, color: '#ff8c00', badgesRaw: '', historical: false } });
  }
  if (u.includes('/chat/send')) { posts.send.push(body); return mock.sendFail ? json({ ok: false, error: 'twitch: message dropped (msg_rejected)' }, 422) : json({ ok: true, id: 's-1' }); }
  if (u.includes('/chat/history')) return json({ ok: true, messages: u.includes('before=') ? [] : H1, nextBefore: null });
  if (u.includes('/moderation/')) return json({ ok: true, requests: [], messages: {} });
  return call('Fetch.continueRequest', { requestId: rid }, sid);
};
await call('Fetch.enable', { patterns: ['/auth/me', '/moderation/', '/chat/', '/nicknames', '/account/'].map((p) => ({ urlPattern: `*api.jouki.cz${p}*` })) }, sessionId);
await call('Runtime.enable', {}, sessionId);
const ev = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId); if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 300) }; return r.result?.result?.value; };
const until = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr) === true) return true; await sleep(150); } return false; };
const type = (t) => ev(`(() => { const i = document.getElementById('msg-input'); i.value = ${JSON.stringify(t)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
const ROW = (txt) => `(() => { const e = [...document.querySelectorAll('#chat .msg')].filter(x => (x.querySelector('.tx')?.textContent || '').includes(${JSON.stringify(txt)})); return e.map(x => ({ id: x.dataset.msgId, uco: x.classList.contains('uc-only-msg'), failed: x.classList.contains('send-failed'), tip: x.querySelector(':scope > .pi')?.dataset.tooltip || '', bg: getComputedStyle(x.querySelector(':scope > .pi')).backgroundImage })); })()`;

await call('Page.navigate', { url: `chrome-extension://${extId}/sidepanel.html` }, sessionId);
await sleep(1500);
await ev(`chrome.storage.local.set({ uc_session: 'tok', uc_send_platform: 'twitch', uc_send_broadcast: false })`);
await call('Page.navigate', { url: `chrome-extension://${extId}/sidepanel.html` }, sessionId);
await until(`!!document.querySelector('.msg[data-msg-id="tw-1"]')`, 10000);
await until(`!document.getElementById('msg-input').disabled`, 6000);

// A: odeslání na Twitch selže → zpráva automaticky jen přes UnityChat
await type('ahoj z unitychatu');
check('A záloha: POST /chat/uc-only s textem a platformou', await until(`true`, 100) && await (async () => { for (let i = 0; i < 40 && !posts.uco.length; i++) await sleep(100); return posts.uco.length === 1 && posts.uco[0].text === 'ahoj z unitychatu' && posts.uco[0].platform === 'twitch' && posts.uco[0].channel === 'robdiesalot' && /msg_rejected/.test(posts.uco[0].reason); })(), JSON.stringify(posts.uco));
await until(`${ROW('ahoj z unitychatu')}.some(r => r.uco)`, 3000);
const a = await ev(ROW('ahoj z unitychatu'));
check('A jedna zpráva s logem UnityChatu, ne NEODESLÁNO', a.length === 1 && a[0].id === 'uco-1' && a[0].uco && !a[0].failed && /icon48\.png/.test(a[0].bg) && /^Jen v UnityChatu — Twitch/.test(a[0].tip), JSON.stringify(a));
check('A text se do pole nevrátil', await ev(`document.getElementById('msg-input').value`) === '');

// B: command a GIF odkaz se zálohou neposílají
await type('!logi');
await sleep(800);
check('B command: bez zálohy (zůstane neodesláno)', posts.uco.length === 1 && (await ev(ROW('!logi'))).some((r) => r.failed), JSON.stringify(await ev(ROW('!logi'))));

// C: SSE uc-only od jiného uživatele → vykreslí se s logem UnityChatu; duplicitní SSE vlastní zprávy nic nepřidá
await ev(`window.ucGif.add({ platform: 'youtube', id: 'uco-9', username: 'Divak', userId: 'y9', message: 'zadržená youtubem', timestamp: Date.now(), uc: true, ucOnly: true })`);
await ev(`window.ucGif.add({ platform: 'twitch', id: 'uco-1', username: 'ModUser', userId: 'u7', message: 'ahoj z unitychatu', timestamp: Date.now(), uc: true, ucOnly: true })`);
await sleep(300);
const c = await ev(ROW('zadržená youtubem'));
check('C cizí zpráva jen přes UnityChat: logo UC + tooltip YouTube', c.length === 1 && c[0].uco && /^Jen v UnityChatu — YouTube/.test(c[0].tip), JSON.stringify(c));
check('C vlastní zpráva ze SSE se nezdvojí', (await ev(ROW('ahoj z unitychatu'))).length === 1);

// D: volba „Jen UnityChat“ v menu Psát jako → text rovnou přes /chat/uc-only, command dál na platformu
mock.sendFail = false;
const menuRows = await ev(`(() => { document.getElementById('platform-btn').click(); return [...document.querySelectorAll('#platform-menu .pm-row')].map(r => r.dataset.action || r.dataset.platform); })()`);
check('D menu: volba Jen UnityChat', menuRows.includes('uconly'), JSON.stringify(menuRows));
await ev(`document.querySelector('#platform-menu .pm-row[data-action="uconly"]').click()`);
const st = await ev(`({ uco: document.getElementById('active-badge').classList.contains('uco'), ph: document.getElementById('msg-input').placeholder })`);
check('D badge s logem UC a placeholder', st.uco && st.ph === 'Zpráva jen do UnityChatu...', JSON.stringify(st));
const sendsBefore = posts.send.length;
await type('jen pro unitychat');
for (let i = 0; i < 30 && posts.uco.length < 2; i++) await sleep(100);
check('D text → /chat/uc-only (volba), ne /chat/send', posts.uco.length === 2 && posts.uco[1].text === 'jen pro unitychat' && /volba/.test(posts.uco[1].reason) && posts.send.length === sendsBefore, JSON.stringify(posts.uco[1]));
await type('!test');
for (let i = 0; i < 30 && posts.send.length === sendsBefore; i++) await sleep(100);
check('D command v režimu Jen UnityChat jde na platformu', posts.send.at(-1)?.text === '!test' && posts.uco.length === 2, JSON.stringify(posts.send.at(-1)));
await ev(`(() => { document.getElementById('platform-btn').click(); document.querySelector('#platform-menu .pm-row[data-platform="twitch"]').click(); return true; })()`);
check('D výběr platformy volbu zruší', await ev(`!document.getElementById('active-badge').classList.contains('uco') && document.getElementById('msg-input').placeholder === 'Zpráva do Twitch...'`) === true);

// E: YouTube — divák (ne mod) s odkazem → rovnou přes UnityChat (YouTube odkazy diváků nezveřejní); bez odkazu na YouTube
await ev(`(() => { document.getElementById('platform-btn').click(); document.querySelector('#platform-menu .pm-row[data-platform="youtube"]').click(); return true; })()`);
const sendsE = posts.send.length;
await type('koukni https://example.com/clanek');
for (let i = 0; i < 30 && posts.uco.length < 3; i++) await sleep(100);
check('E odkaz z YouTube → /chat/uc-only, ne /chat/send', posts.uco.length === 3 && posts.uco[2].platform === 'youtube' && posts.uco[2].text === 'koukni https://example.com/clanek' && posts.send.length === sendsE, JSON.stringify(posts.uco[2]));
await until(`${ROW('koukni https://example.com/clanek')}.some(r => r.uco)`, 3000);
const e1 = await ev(ROW('koukni https://example.com/clanek'));
check('E jedna zpráva s logem UnityChatu (optimistická upgradovaná)', e1.length === 1 && e1[0].id === 'uco-3' && e1[0].uco && !e1[0].failed, JSON.stringify(e1));
await type('https://media.tenor.com/abc/x.gif');
for (let i = 0; i < 30 && posts.uco.length < 4; i++) await sleep(100);
check('E GIF z YouTube → /chat/uc-only', posts.uco.length === 4 && posts.send.length === sendsE, JSON.stringify(posts.uco[3]));
await sleep(400);
const e2 = await ev(`[...document.querySelectorAll('#chat .msg')].filter(x => x.dataset.msgId === 'uco-4').map(x => ({ cls: x.className, tx: x.querySelector('.tx')?.textContent || '' }))`);
check('E GIF: jedna vlastní zpráva pod id uco-4 (bez neodesláno)', e2.length === 1 && !/send-failed/.test(e2[0].cls), JSON.stringify(e2));
await type('ahoj youtube');
for (let i = 0; i < 30 && posts.send.length === sendsE; i++) await sleep(100);
check('E bez odkazu → na YouTube (/chat/send)', posts.send.at(-1)?.platform === 'youtube' && posts.send.at(-1)?.text?.startsWith('ahoj youtube') && posts.uco.length === 4, JSON.stringify(posts.send.at(-1)));

// F: víceslovná přezdívka v @zmínce odejde jako login → echo z YouTube se spáruje s optimistickou (2026-10-03 dvakrát).
const sendsF = posts.send.length;
await type('@W1nter I. ahoj tam');
for (let i = 0; i < 30 && posts.send.length === sendsF; i++) await sleep(100);
const sentF = posts.send.at(-1)?.text || '';
check('F na YouTube odešel login místo přezdívky', /^@winter_ian ahoj tam/i.test(sentF), sentF);
await ev(`(() => { const o = [...document.querySelectorAll('#chat .msg')].find(x => (x.querySelector('.tx')?.textContent || '').includes('ahoj tam')); const m = window.ucGif.msg(o.dataset.msgId); window.ucGif.add({ platform: 'youtube', id: 'yt-echo-f', username: m.username, userId: 'y7', message: '@Winter_Ian ahoj tam \\u2800', timestamp: Date.now(), uc: true }); return true; })()`);
await sleep(400);
const f = await ev(`[...document.querySelectorAll('#chat .msg')].filter(x => (x.querySelector('.tx')?.textContent || '').includes('ahoj tam')).map(x => x.dataset.msgId)`);
check('F echo spárované: jedna zpráva s id echa', f.length === 1 && f[0] === 'yt-echo-f', JSON.stringify(f));

console.log(`\n${pass} PASS, ${fail} FAIL`);
finish(fail ? 1 : 0);
