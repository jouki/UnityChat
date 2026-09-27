// E2E (headless Chrome + CDP): Broadcast v addonu — volba „Broadcast" v menu „Psát jako" (mod / streamer,
// aspoň dvě přihlášené platformy), odeslání na všechny platformy jedním POST /chat/broadcast (texty pro
// jednotlivé platformy, optimistická zpráva na každé, neodeslaná část označená), command jen na vybranou
// platformu, GIF odkaz se neodešle, odpověď přepne na platformu autora a po odeslání / zrušení zpět na
// Broadcast, 403 not_mod ze serveru (klient roli podstrčit nemůže), divák volbu nevidí, volba přežije reload.
// Backend (api.jouki.cz) mockovaný přes Fetch.requestPaused. Spuštění: node scripts/e2e-broadcast.mjs
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-e2e-bc-'));
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
const H = (platform, id, user, text, i) => ({ platform, id, username: user, userId: `u-${id}`, message: text, color: '#1e90ff', timestamp: now - 60000 + i * 1000, historical: true });
const H1 = [H('twitch', 'tw-1', 'TwTester', 'ahoj z twitche', 1), H('kick', 'ki-1', 'KickTester', 'ahoj z kicku', 2), H('youtube', 'yt-1', 'YtTester', 'ahoj z youtube', 3)];
const mock = { mod: true, broadcast: 'ok' };   // broadcast: 'ok' | 'kickfail' | 'not_mod'
const posts = { send: [], broadcast: [] };
const fulfill = (rid, sid, code, type, body) => call('Fetch.fulfillRequest', { requestId: rid, responseCode: code, responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: Buffer.from(body).toString('base64') }, sid);
s.onevent = async (d) => {
  if (d.method !== 'Fetch.requestPaused') return;
  const q = d.params.request;
  const rid = d.params.requestId;
  const sid = d.sessionId;
  const json = (o, code = 200) => fulfill(rid, sid, code, 'application/json', JSON.stringify(o));
  const u = q.url;
  const body = q.postData ? JSON.parse(q.postData) : null;
  if (u.includes('/nicknames/stream')) return fulfill(rid, sid, 200, 'text/event-stream', 'retry: 60000\n\n');
  if (u.includes('/account/stream-ticket')) return json({ ok: true, ticket: 'tk', expiresInMs: 60000 });
  if (u.includes('/account/stream')) return;   // podržet
  if (u.includes('/account/warnings')) return json({ ok: true, warnings: [] });
  if (u.includes('/auth/me')) return json({ ok: true, accountId: 7, platforms: { twitch: { login: 'moduser', displayName: 'ModUser' }, kick: { login: 'modkick', displayName: 'ModKick' }, youtube: { login: '@modyt', displayName: 'Mod YT' } }, warnings: [] });
  if (u.includes('/moderation/me')) return json(mock.mod ? { ok: true, mod: true, platforms: ['twitch'], missingScopes: {} } : { ok: true, mod: false, platforms: [], missingScopes: {} });
  if (u.includes('/moderation/')) return json({ ok: true, requests: [], messages: {} });
  if (u.includes('/chat/broadcast')) {
    posts.broadcast.push(body);
    if (mock.broadcast === 'not_mod') return json({ ok: false, error: 'not_mod' }, 403);
    const results = { twitch: { ok: true, id: 'b-tw', text: body.texts.twitch }, kick: { ok: true, id: 'b-ki', text: body.texts.kick }, youtube: { ok: true, id: 'b-yt', text: body.texts.youtube } };
    if (mock.broadcast === 'kickfail') results.kick = { ok: false, status: 401, error: 'kick: token expired, login again' };
    return json({ ok: true, results });
  }
  if (u.includes('/chat/send')) { posts.send.push(body); return json({ ok: true, id: `s-${posts.send.length}` }); }
  if (u.includes('/chat/history')) return json({ ok: true, messages: u.includes('before=') ? [] : H1, nextBefore: null });
  return call('Fetch.continueRequest', { requestId: rid }, sid);
};
await call('Fetch.enable', { patterns: ['/auth/me', '/moderation/', '/chat/', '/nicknames/stream', '/account/'].map((p) => ({ urlPattern: `*api.jouki.cz${p}*` })) }, sessionId);
await call('Runtime.enable', {}, sessionId);
const ev = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId); if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 300) }; return r.result?.result?.value; };
const until = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr) === true) return true; await sleep(150); } return false; };
const boot = async () => {
  await call('Page.navigate', { url: `chrome-extension://${extId}/sidepanel.html` }, sessionId);
  await until(`!!document.querySelector('.msg[data-msg-id="yt-1"]')`, 10000);
};
const openMenu = () => ev(`(() => { const m = document.getElementById('platform-menu'); if (m.classList.contains('hidden')) document.getElementById('platform-btn').click(); return [...m.querySelectorAll('.pm-row')].map(r => (r.dataset.action || r.dataset.platform) + (r.classList.contains('selected') ? '*' : '')); })()`);
const type = (t) => ev(`(() => { const i = document.getElementById('msg-input'); i.value = ${JSON.stringify(t)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
const state = () => ev(`({ bc: document.getElementById('active-badge').classList.contains('bc'), cls: document.getElementById('active-badge').className, ph: document.getElementById('msg-input').placeholder })`);
const lastSys = () => ev(`(() => { const a = [...document.querySelectorAll('#chat .sys')]; return a.length ? a[a.length - 1].textContent : null; })()`);
const reply = (id) => ev(`(() => { document.querySelector('.msg[data-msg-id="${id}"] [data-act="reply"]').click(); return true; })()`);

await call('Page.navigate', { url: `chrome-extension://${extId}/sidepanel.html` }, sessionId);
await sleep(1500);
await ev(`chrome.storage.local.set({ uc_session: 'tok', uc_send_platform: 'twitch', uc_send_broadcast: false })`);

// ---- A: mod — volba v menu ----
await boot();
await until(`document.body.classList.contains('uc-can-moderate')`);
let rows = await openMenu();
check('A menu: Broadcast první, pak platformy', JSON.stringify(rows.slice(0, 4)) === JSON.stringify(['broadcast', 'twitch*', 'kick', 'youtube']), JSON.stringify(rows));
check('A řádek Broadcast: tři loga + text', await ev(`(() => { const r = document.querySelector('#platform-menu .pm-broadcast'); return r.querySelectorAll('.pm-bc-logos .pm-badge').length === 3 && r.querySelector('.pm-name').textContent === 'Broadcast'; })()`) === true);
await ev(`document.querySelector('#platform-menu .pm-broadcast').click()`);
let st = await state();
check('A po výběru: badge se třemi logy + placeholder', st.bc === true && st.ph === 'Zpráva na všechny platformy...', JSON.stringify(st));
rows = await openMenu();
check('A v menu vybraný Broadcast, žádná platforma', rows[0] === 'broadcast*' && !rows.slice(1).some((r) => r.endsWith('*')), JSON.stringify(rows));
await ev(`document.getElementById('platform-menu').classList.add('hidden')`);

// ---- B: odeslání ----
mock.broadcast = 'kickfail';
await type('ahoj všichni');
await until(`document.querySelectorAll('#chat .msg[data-msg-id^="sent-"]').length >= 3`, 4000);
const b = posts.broadcast[0];
check('B jeden POST /chat/broadcast s texty pro všechny platformy', posts.broadcast.length === 1 && b.text === 'ahoj všichni' && b.channel && Object.keys(b.texts).sort().join() === 'kick,twitch,youtube', JSON.stringify(b));
check('B nic přes /chat/send', posts.send.length === 0);
const opt = await ev(`[...document.querySelectorAll('#chat .msg[data-msg-id^="sent-"]')].map(e => ({ p: e.dataset.platform || [...e.querySelectorAll('.pi')].map(x => x.className).join(), failed: e.classList.contains('send-failed'), tx: e.querySelector('.tx')?.textContent }))`);
check('B optimistická zpráva na každé platformě', opt.length === 3 && opt.every((m) => /ahoj všichni/.test(m.tx)), JSON.stringify(opt));
check('B neodeslaná část (Kick) označená, ostatní ne', await until(`[...document.querySelectorAll('#chat .msg.send-failed')].length === 1`, 3000), JSON.stringify(await ev(`[...document.querySelectorAll('#chat .msg.send-failed')].map(e => e.outerHTML.slice(0, 160))`)));
check('B pole prázdné (část prošla)', await ev(`document.getElementById('msg-input').value`) === '');
mock.broadcast = 'ok';

// ---- C: command jen na vybranou platformu, GIF se neodešle ----
await type('!test');
await until(`${posts.send.length} < 1 ? false : true`, 1);
check('C command → /chat/send na jednu platformu', await (async () => { await sleep(500); return posts.send.length === 1 && posts.send[0].text === '!test' && posts.broadcast.length === 1; })(), JSON.stringify(posts.send));
await type('koukej https://media.tenor.com/abc/x.gif');
await sleep(400);
check('C GIF odkaz Broadcastem ne → hláška, nic neodešlo', posts.broadcast.length === 1 && posts.send.length === 1 && /GIF pošli na jednu platformu/.test(await lastSys() || ''), await lastSys());
await ev(`(() => { const i = document.getElementById('msg-input'); i.value = ''; return true; })()`);

// ---- D: odpověď → platforma autora, pak zpět ----
await reply('ki-1');
st = await state();
check('D odpověď na Kick → píšu na Kick (bez Broadcastu)', st.bc === false && /Kick/.test(st.ph), JSON.stringify(st));
await type('díky');
await sleep(600);
const ds = posts.send[1];
check('D odpověď odešla přes /chat/send na Kick s nativní odpovědí', ds?.platform === 'kick' && ds.replyTo === 'ki-1', JSON.stringify(ds));
check('D po odeslání zpátky Broadcast', await until(`document.getElementById('active-badge').classList.contains('bc')`, 3000), JSON.stringify(await state()));
await reply('yt-1');
st = await state();
check('D odpověď na YouTube → píšu na YouTube', st.bc === false && /YouTube/.test(st.ph), JSON.stringify(st));
await reply('tw-1');
check('D další odpověď (Twitch) během odpovídání → Twitch, ne Broadcast', await ev(`document.getElementById('msg-input').placeholder`) === 'Zpráva do Twitch...' && (await state()).bc === false);
await ev(`document.querySelector('#reply-indicator .ri-close').click()`);
check('D zrušení odpovědi → zpátky Broadcast', await until(`document.getElementById('active-badge').classList.contains('bc')`, 3000));

// ---- E: server roli nepotvrdí ----
mock.broadcast = 'not_mod';
await type('zkouška role');
check('E 403 not_mod → hláška, zprávy neodeslané, text zpět v poli', await until(`/jen mod nebo streamer/.test([...document.querySelectorAll('#chat .sys')].pop()?.textContent || '')`, 4000)
  && await until(`document.getElementById('msg-input').value === 'zkouška role'`, 2000), await lastSys());
mock.broadcast = 'ok';

// ---- F: volba přežije reload; ruční volba platformy ji zruší ----
await boot();
check('F po reloadu zase Broadcast', await until(`document.getElementById('active-badge').classList.contains('bc')`, 6000));
await openMenu();
await ev(`document.querySelector('#platform-menu .pm-row[data-platform="youtube"]').click()`);
st = await state();
check('F ruční výběr platformy Broadcast vypne', st.bc === false && /YouTube/.test(st.ph), JSON.stringify(st));
check('F uloženo', await ev(`chrome.storage.local.get('uc_send_broadcast').then(r => r.uc_send_broadcast)`) === false);

// ---- G: divák volbu nemá (ani s uloženým Broadcastem) ----
mock.mod = false;
await ev(`chrome.storage.local.set({ uc_send_broadcast: true })`);
await boot();
await sleep(1500);
rows = await openMenu();
check('G divák: v menu žádný Broadcast', !rows.some((r) => r.startsWith('broadcast')), JSON.stringify(rows));
st = await state();
check('G divák: píše na vybranou platformu', st.bc === false && !/všechny/.test(st.ph), JSON.stringify(st));
const nb = posts.broadcast.length;
await ev(`document.getElementById('platform-menu').classList.add('hidden')`);
await type('divák píše');
await sleep(600);
check('G divák: zpráva přes /chat/send, ne Broadcast', posts.broadcast.length === nb && posts.send.at(-1)?.text === 'divák píše', JSON.stringify(posts.send.at(-1)));

console.log(`\n${pass} PASS, ${fail} FAIL`);
finish(fail ? 1 : 0);
