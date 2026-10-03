// E2E (headless Chrome + CDP): UnityChat Announcement z /chat/history se v addonu vykreslí na svém místě,
// i znovu po resetu chatu (přepnutí streamera / vyčištění) — dedup podle uzlu v chatu, ne podle paměti (2026-10-03).
// Spuštění: node scripts/e2e-announcement-history.mjs
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-e2e-annc-'));
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
const H1 = [{ platform: 'twitch', id: 'tw-1', username: 'TwTester', userId: 'u1', message: 'ahoj', color: '#1e90ff', timestamp: now - 30000, historical: true },
  { platform: 'unitychat', id: 'annc-a1', username: 'UnityChat', userId: '', message: '', timestamp: now - 20000, historical: true, ucAnnouncement: { id: 'a1', workspace: 'rob', channel: 'robdiesalot', command: 'Chci Hrát', text: 'Koukáš na stream?', textHtml: '', media: null, at: new Date(now - 20000).toISOString(), chatReply: null, hideBotReplies: ['joukibot'], hideInBrowserSource: false, triggeredBy: { user: 'Jouki728', platform: 'twitch' } } },
  { platform: 'twitch', id: 'tw-2', username: 'TwTester', userId: 'u1', message: 'po announcementu', color: '#1e90ff', timestamp: now - 10000, historical: true }];
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
  if (u.includes('/account/stream-ticket')) return json({ ok: true, ticket: 'tk', expiresInMs: 60000 });
  if (u.includes('/account/stream')) return;
  if (u.includes('/account/warnings')) return json({ ok: true, warnings: [] });
  if (u.includes('/auth/me')) return json({ ok: true, accountId: 7, platforms: { twitch: { login: 'moduser', displayName: 'ModUser' } }, warnings: [] });
  if (u.includes('/moderation/me')) return json({ ok: true, mod: false, platforms: [], missingScopes: {} });
  if (u.includes('/chat/uc-only')) {
    posts.uco.push(body);
    return json({ ok: true, id: 'uco-1', message: { platform: body.platform, id: 'uco-1', username: 'ModUser', userId: 'u7', message: body.text, timestamp: Date.now(), uc: true, ucOnly: true, color: '#ff8c00', badgesRaw: '', historical: false } });
  }
  if (u.includes('/chat/send')) { posts.send.push(body); return mock.sendFail ? json({ ok: false, error: 'twitch: message dropped (msg_rejected)' }, 422) : json({ ok: true, id: 's-1' }); }
  if (u.includes('/chat/history')) return json({ ok: true, messages: u.includes('before=') ? [] : H1, nextBefore: null });
  if (u.includes('/moderation/')) return json({ ok: true, requests: [], messages: {} });
  return call('Fetch.continueRequest', { requestId: rid }, sid);
};
await call('Fetch.enable', { patterns: ['/auth/me', '/moderation/', '/chat/', '/nicknames/stream', '/account/'].map((p) => ({ urlPattern: `*api.jouki.cz${p}*` })) }, sessionId);
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

await sleep(1500);
const r = await ev(`({ annc: document.querySelectorAll('#chat .uc-annc').length, order: [...document.querySelectorAll('#chat > *')].map(e => e.dataset.msgId || e.dataset.anncId || e.className).slice(-6) })`);
check('addon: announcement z historie vykreslený', r.annc === 1, JSON.stringify(r));
const ORDER = `[...document.querySelectorAll('#chat > *')].map(e => e.dataset.msgId || e.dataset.anncId).filter(Boolean)`;
check('announcement mezi zprávami podle času', JSON.stringify(await ev(ORDER)) === JSON.stringify(['tw-1', 'a1', 'tw-2']), JSON.stringify(await ev(ORDER)));
await ev(`(async () => { window.ucHistory.reset(); await window.ucHistory.load(); return true; })()`);
check('po resetu chatu + historii znovu vykreslený', await until(`document.querySelectorAll('#chat .uc-annc').length === 1`, 3000), JSON.stringify(await ev(ORDER)));
await ev(`(async () => { await window.ucHistory.load({ reconcile: true }); return true; })()`);
check('reconcile ho nezdvojí', await ev(`document.querySelectorAll('#chat .uc-annc').length`) === 1);

console.log(`
${pass} PASS, ${fail} FAIL`);
finish(fail ? 1 : 0);
