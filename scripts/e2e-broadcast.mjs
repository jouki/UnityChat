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
const mock = { mod: true, broadcast: 'ok', sameName: false };   // broadcast: 'ok' | 'kickfail' | 'not_mod'; sameName = stejný login na všech platformách
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
  if (u.includes('/auth/me') && mock.sameName) return json({ ok: true, accountId: 7, platforms: { twitch: { login: 'jouki728', displayName: 'Jouki728' }, kick: { login: 'jouki728', displayName: 'Jouki728' }, youtube: { login: 'jouki728', displayName: 'Jouki' } }, warnings: [] });
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
check('A menu: Broadcast první, pak platformy, UnityChat a odhlásit', JSON.stringify(rows.slice(0, 6)) === JSON.stringify(['broadcast', 'twitch*', 'kick', 'youtube', 'uconly', 'logout']), JSON.stringify(rows));
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
await until(`document.querySelectorAll('#chat .msg[data-msg-id^="sent-"]').length >= 1`, 4000);
// POST jde až po vykreslení optimistických zpráv (token, fetch) → počkat na zachycení, jinak test závodí.
for (let i = 0; i < 40 && !posts.broadcast.length; i++) await sleep(100);
const b = posts.broadcast[0];
check('B jeden POST /chat/broadcast s texty pro všechny platformy', posts.broadcast.length === 1 && b.text === 'ahoj všichni' && b.channel && Object.keys(b.texts).sort().join() === 'kick,twitch,youtube', JSON.stringify(b));
check('B nic přes /chat/send', posts.send.length === 0);
// Jedna zpráva s logy všech cílů (pokyn usera 2026-10-02): ztmavená, dokud nedorazí první kopie z chatu platformy.
const opt = await ev(`[...document.querySelectorAll('#chat .msg[data-msg-id^="sent-"]')].map(e => ({ slots: [...e.querySelectorAll('.pi-bc .uc-bc-slot')].map(x => x.dataset.platform + ':' + x.className.replace('uc-bc-slot uc-bc-', '')), pending: e.classList.contains('uc-bc-pending'), single: getComputedStyle(e.querySelector(':scope > .pi')).display, failed: e.classList.contains('send-failed'), tx: e.querySelector('.tx')?.textContent }))`);
check('B jedna optimistická zpráva s logy všech platforem, ztmavená', opt.length === 1 && /ahoj všichni/.test(opt[0].tx) && /^twitch:wait,kick:(wait|fail),youtube:wait$/.test(opt[0].slots.join()) && opt[0].pending && opt[0].single === 'none', JSON.stringify(opt));
const kf = await until(`(() => { const s = document.querySelector('#chat .msg[data-msg-id^="sent-"] .uc-bc-slot[data-platform="kick"]'); return !!s && s.classList.contains('uc-bc-fail') && !!s.querySelector('.uc-bc-warn'); })()`, 3000);
const kfInfo = await ev(`(() => { const e = document.querySelector('#chat .msg[data-msg-id^="sent-"]'); return { failed: e.classList.contains('send-failed'), tip: e.querySelector('.uc-bc-slot[data-platform="kick"]')?.dataset.tooltip, tw: e.querySelector('.uc-bc-slot[data-platform="twitch"]')?.className }; })()`);
check('B neodeslaný Kick: vykřičník u loga + tooltip s důvodem, zpráva ne celá neodeslaná', kf && !kfInfo.failed && /^Kick — neodesláno: kick: token expired/.test(kfInfo.tip) && /uc-bc-wait/.test(kfInfo.tw), JSON.stringify(kfInfo));
await ev(`(() => { window.ucGif.add({ platform: 'youtube', id: 'b-echo-yt', username: 'modyt', userId: 'u-yt', message: 'ahoj všichni \u2800', timestamp: Date.now() }); return true; })()`);
await sleep(300);
const bAfter = await ev(`[...document.querySelectorAll('#chat .msg')].filter(x => /ahoj všichni/.test(x.querySelector('.tx')?.textContent || '')).map(x => ({ id: x.dataset.msgId, pending: x.classList.contains('uc-bc-pending'), slots: [...x.querySelectorAll('.uc-bc-slot')].map(s => s.dataset.platform + ':' + s.className.replace('uc-bc-slot uc-bc-', '')).join() }))`);
check('B první kopie (YouTube) zprávu rozsvítí a zapne logo YouTube, druhá zpráva nevznikne', bAfter.length === 1 && bAfter[0].id === 'b-echo-yt' && !bAfter[0].pending && bAfter[0].slots === 'twitch:wait,kick:fail,youtube:on', JSON.stringify(bAfter));
check('B pole prázdné (část prošla)', await ev(`document.getElementById('msg-input').value`) === '');
mock.broadcast = 'ok';

// ---- C: !command Broadcastem na všechny platformy (pokyn usera 2026-09-29), lomítkový jen na vybranou, GIF se neodešle ----
await type('!test');
for (let i = 0; i < 40 && posts.broadcast.length < 2; i++) await sleep(100);
check('C !command → Broadcast na všechny platformy, nic přes /chat/send', posts.broadcast.length === 2 && posts.broadcast[1].text === '!test' && Object.keys(posts.broadcast[1].texts).sort().join() === 'kick,twitch,youtube' && posts.send.length === 0, JSON.stringify({ bc: posts.broadcast[1], send: posts.send }));
await type('/me test');
for (let i = 0; i < 40 && posts.send.length < 1; i++) await sleep(100);
check('C lomítkový command → /chat/send na jednu platformu', posts.send.length === 1 && posts.send[0].text === '/me test' && posts.broadcast.length === 2, JSON.stringify(posts.send));
await type('koukej https://media.tenor.com/abc/x.gif');
await sleep(400);
check('C GIF odkaz Broadcastem ne → hláška, nic neodešlo', posts.broadcast.length === 2 && posts.send.length === 1 && /GIF pošli na jednu platformu/.test(await lastSys() || ''), await lastSys());
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
// Počkat na zachycení POSTu (ne pevná pauza) — jinak test závodí s odesláním.
for (let i = 0; i < 40 && posts.send.at(-1)?.text !== 'divák píše'; i++) await sleep(100);
check('G divák: zpráva přes /chat/send, ne Broadcast', posts.broadcast.length === nb && posts.send.at(-1)?.text === 'divák píše', JSON.stringify(posts.send.at(-1)));

// ---- H: stejný login na všech platformách — echo se páruje s optimistickou zprávou SVÉ platformy (hlášení 2026-09-29:
// klíč bez platformy → tři optimistické zprávy sdílely jeden klíč a odesílatel viděl broadcast dvakrát) ----
mock.mod = true; mock.sameName = true; mock.broadcast = 'ok';
await ev(`chrome.storage.local.set({ uc_send_platform: 'twitch', uc_send_broadcast: true })`);
await boot();
await until(`document.body.classList.contains('uc-can-moderate')`);
await until(`document.getElementById('active-badge').classList.contains('bc')`, 6000);
await type('hmm, test');
await until(`[...document.querySelectorAll('#chat .msg[data-msg-id^="sent-"]')].filter(e => /hmm, test/.test(e.textContent)).length === 1`, 4000);
await ev(`(() => { const t = Date.now(); for (const [platform, id, username] of [['twitch', 'echo-tw', 'Jouki728'], ['kick', 'echo-ki', 'Jouki728'], ['youtube', 'echo-yt', 'jouki728']]) window.ucGif.add({ platform, id, username, userId: 'u-' + id, message: 'hmm, test \u2800', timestamp: t, color: '#ff8c00' }); return true; })()`);
await sleep(400);
const hRows = await ev(`[...document.querySelectorAll('#chat .msg')].filter(e => /hmm, test/.test(e.querySelector('.tx')?.textContent || '')).map(e => ({ id: e.dataset.msgId, p: e.dataset.platform, pending: e.classList.contains('uc-bc-pending'), slots: [...e.querySelectorAll('.uc-bc-slot')].map(s => s.className.replace('uc-bc-slot uc-bc-', '')).join() }))`);
check('H stejný login: echa ze všech platforem = pořád JEDNA zpráva, optimistická nezbyla', Array.isArray(hRows) && hRows.length === 1 && hRows[0].id === 'echo-tw' && hRows[0].p === 'twitch', JSON.stringify(hRows));
check('H všechna loga rozsvícená, zpráva už není ztmavená', hRows?.[0]?.slots === 'on,on,on' && hRows[0].pending === false, JSON.stringify(hRows));

// ---- I: cizí Broadcast — historie s `bcast` (jedna zpráva) a živé kopie z IRC + SSE bcast-mark (před i po zprávě) ----
await ev(`(() => { const t = Date.now(); const bc = { id: 'g-hist', targets: ['twitch', 'kick', 'youtube'] };
  window.ucGif.add({ platform: 'twitch', id: 'oh-tw', username: 'RobDiesALot', userId: 'r1', message: 'cizí broadcast', timestamp: t, bcast: bc, uc: true });
  window.ucGif.add({ platform: 'kick', id: 'oh-ki', username: 'robdiesalot', userId: 'r2', message: 'cizí broadcast', timestamp: t + 1, bcast: bc, uc: true });
  window.ucGif.add({ platform: 'twitch', id: 'ol-tw', username: 'RobDiesALot', userId: 'r1', message: 'živý broadcast', timestamp: t + 2 });
  window.ucGif.bcastMark({ platform: 'twitch', id: 'ol-tw', group: 'g-live', targets: ['twitch', 'kick'] });
  window.ucGif.bcastMark({ platform: 'kick', id: 'ol-ki', group: 'g-live', targets: ['twitch', 'kick'] });
  window.ucGif.add({ platform: 'kick', id: 'ol-ki', username: 'robdiesalot', userId: 'r2', message: 'živý broadcast', timestamp: t + 3 });
  window.ucGif.add({ platform: 'twitch', id: 'om-tw', username: 'RobDiesALot', userId: 'r1', message: 'třetí broadcast', timestamp: t + 4 });
  window.ucGif.add({ platform: 'kick', id: 'om-ki', username: 'robdiesalot', userId: 'r2', message: 'třetí broadcast', timestamp: t + 5 });
  window.ucGif.bcastMark({ platform: 'twitch', id: 'om-tw', group: 'g-m', targets: ['twitch', 'kick'] });
  window.ucGif.bcastMark({ platform: 'kick', id: 'om-ki', group: 'g-m', targets: ['twitch', 'kick'] });
  return true; })()`);
await sleep(300);
const iRows = await ev(`['cizí broadcast', 'živý broadcast', 'třetí broadcast'].map((t) => [...document.querySelectorAll('#chat .msg')].filter(e => (e.querySelector('.tx')?.textContent || '').includes(t)).map(e => e.dataset.msgId + '=' + [...e.querySelectorAll('.uc-bc-slot')].map(s => s.className.replace('uc-bc-slot uc-bc-', '')).join('/')))`);
check('I historie s bcast: jedna zpráva, Twitch + Kick rozsvícené, YouTube čeká', JSON.stringify(iRows[0]) === JSON.stringify(['oh-tw=on/on/wait']), JSON.stringify(iRows));
check('I živě z IRC + bcast-mark po zprávě i před ní: jedna zpráva', JSON.stringify(iRows[1]) === JSON.stringify(['ol-tw=on/on']), JSON.stringify(iRows));
check('I kopie vykreslená před markem se vstřebá (zmizí)', JSON.stringify(iRows[2]) === JSON.stringify(['om-tw=on/on']), JSON.stringify(iRows));

// ---- J: odpověď bota na broadcast commandu z víc platforem = JEDNA zpráva s logy (2026-10-03). Server: první odpověď
// dostane bcast-mark se skupinou bot-<id>, kopie z další platformy přijde s bcast a cíle se postupně rozšiřují. ----
await ev(`(() => { const t = Date.now();
  window.ucGif.add({ platform: 'twitch', id: 'bot-tw', username: 'JoukiBOT', userId: 'b1', message: 'Kategorie: World of Warcraft', timestamp: t });
  window.ucGif.bcastMark({ platform: 'twitch', id: 'bot-tw', group: 'bot-bot-tw', targets: ['twitch', 'kick'] });
  window.ucGif.bcastMark({ platform: 'kick', id: 'bot-ki', group: 'bot-bot-tw', targets: ['twitch', 'kick'] });
  window.ucGif.add({ platform: 'kick', id: 'bot-ki', username: 'JoukiBOT', userId: 'b2', message: 'Kategorie: World of Warcraft', timestamp: t + 800, bcast: { id: 'bot-bot-tw', targets: ['twitch', 'kick'] } });
  window.ucGif.bcastMark({ platform: 'twitch', id: 'bot-tw', group: 'bot-bot-tw', targets: ['twitch', 'kick', 'youtube'] });
  window.ucGif.bcastMark({ platform: 'youtube', id: 'bot-yt', group: 'bot-bot-tw', targets: ['twitch', 'kick', 'youtube'] });
  window.ucGif.add({ platform: 'youtube', id: 'bot-yt', username: 'JoukiBOT', userId: 'b3', message: 'Kategorie: World of Warcraft', timestamp: t + 2000, bcast: { id: 'bot-bot-tw', targets: ['twitch', 'kick', 'youtube'] } });
  return true; })()`);
await sleep(300);
const jRows = await ev(`[...document.querySelectorAll('#chat .msg')].filter(e => (e.querySelector('.tx')?.textContent || '').includes('World of Warcraft')).map(e => e.dataset.msgId + '=' + [...e.querySelectorAll('.uc-bc-slot')].map(s => s.dataset.platform + ':' + s.className.replace('uc-bc-slot uc-bc-', '')).join('/'))`);
check('J odpověď bota z Twitche, Kicku a YouTube = jedna zpráva, všechna tři loga rozsvícená', JSON.stringify(jRows) === JSON.stringify(['bot-tw=twitch:on/kick:on/youtube:on']), JSON.stringify(jRows));

// ---- Filtry platforem přežijí obnovení panelu (pokyn usera 2026-09-30) ----
await ev(`(() => { const b = document.querySelector('.fbtn[data-platform="youtube"]'); if (b.classList.contains('active')) b.click(); return true; })()`);
const fSaved = await ev(`chrome.storage.local.get('uc_filters').then((r) => r.uc_filters)`);
check('filtr: vypnutí YouTube se uloží', fSaved && fSaved.youtube === false && fSaved.twitch === true, JSON.stringify(fSaved));
await boot();
await sleep(300);
const fAfter = await ev(`(() => ({ yt: document.querySelector('.fbtn[data-platform="youtube"]').classList.contains('active'), tw: document.querySelector('.fbtn[data-platform="twitch"]').classList.contains('active'), hidden: document.querySelector('.msg[data-msg-id="yt-1"]')?.classList.contains('hide-platform') }))()`);
check('filtr: po obnovení panelu je YouTube dál vypnuté a jeho zprávy schované', fAfter && fAfter.yt === false && fAfter.tw === true && fAfter.hidden === true, JSON.stringify(fAfter));
await ev(`chrome.storage.local.remove('uc_filters').then(() => true)`);

console.log(`\n${pass} PASS, ${fail} FAIL`);
finish(fail ? 1 : 0);
