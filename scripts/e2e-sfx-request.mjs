// E2E (headless Chrome + CDP): návrh zvukového efektu v addonu — tlačítko „Navrhnout zvuk“
// v soundboardu, prepare → průběh hlasitosti + dvě značky, tah značek (max 30 s), šipky,
// submit (startMs/endMs/name), chyba youtube_blocked, režim embed (přehrávač YouTube přes
// postMessage + ruční časy, když přehrávač neodpoví), Moje návrhy + SSE sfx-request, limit.
//
// Backend je mockovaný přes Fetch.requestPaused (api.jouki.cz: /auth/me, /soundboard*,
// /chat/history, /nicknames/stream); přehrávač youtube-nocookie.com je stub stránka, která
// odpovídá na „listening“ jako YouTube (infoDelivery) a hlásí přijaté příkazy na /__e2e_cmd.
//
// Spuštění: node scripts/e2e-sfx-request.mjs   (Chrome v C:/Program Files/Google/Chrome/…, nebo CHROME=…)
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-e2e-sfx-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--enable-unsafe-extension-debugging', '--autoplay-policy=no-user-gesture-required', '--window-size=500,900', 'about:blank'], { stdio: 'ignore' });

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
const iso = (ms) => new Date(ms).toISOString();
const NOW = Date.now();
const peaks = Array.from({ length: 200 }, (_, i) => Math.abs(Math.sin(i / 9)) * 0.9 + 0.05);
const mock = {
  requests: [
    { requestId: 11, name: 'cekajici', status: 'pending', reason: null, createdAt: iso(NOW - 3600e3), decidedAt: null, soundName: null, platform: 'twitch' },
    { requestId: 10, name: 'zamitnuty', status: 'rejected', reason: 'Moc hlasité', createdAt: iso(NOW - 7200e3), decidedAt: iso(NOW - 3000e3), soundName: null, platform: 'twitch' },
  ],
  limits: { dayUsed: 2, dayMax: 10, monthUsed: 2, monthMax: 30 },
  prepare: null,   // (body) => [status, json]
  sse: [],
};
const log = { prepare: [], submit: [], list: 0, ytCmds: [] };
const soundboard = () => ({
  ok: true, channel: 'robdiesalot', platform: 'twitch', serverNow: iso(Date.now()), loggedIn: true,
  tiers: [{ tier: 1, name: 'BASIC', position: 1 }],
  sounds: [{ id: 1, name: 'boom', displayName: null, tier: 1, emoji: '💥', icon: null, url: 'https://api-zidolista.jouki.cz/public/sfx/rob/e2e.mp3', durationMs: 1000, gainDb: -3 }],
  me: { platform: 'twitch', userId: '42', login: 'tester', role: 'viewer', tiers: [{ tier: 1, startedAt: iso(NOW), expiresAt: null, paused: false, remainingMs: null, available: true, totalMs: null }], cooldown: { globalReadyAt: null, userReadyAt: null } },
  favorites: [], recent: [],
});
// Náhled ze serveru: tichý WAV 95 s (8 kHz, 8 bit mono) místo mp3 Židolišty.
const wav = (() => {
  const n = 8000 * 95, b = Buffer.alloc(44 + n, 128);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40);
  return b;
})();
// Stub přehrávače YouTube: odpovídá jako embed se zapnutým enablejsapi; NOREPLY = embed odmítnut.
const YT_STUB = `<!doctype html><html><body style="background:#000"><script>
const vid = location.pathname.split('/').pop(); let t = 0;
addEventListener('message', (e) => {
  let d; try { d = JSON.parse(e.data); } catch { return; }
  fetch('/__e2e_cmd?' + encodeURIComponent(e.data)).catch(() => {});
  if (vid === 'NOREPLY0000') return;
  const send = (info) => parent.postMessage(JSON.stringify({ event: 'infoDelivery', id: d.id, channel: 'widget', info }), '*');
  if (d.event === 'listening') send({ duration: 120.5, currentTime: 0, playerState: -1 });
  if (d.event === 'command' && d.func === 'seekTo') t = d.args[0];
  if (d.event === 'command' && d.func === 'playVideo') send({ currentTime: t, playerState: 1 });
});
</script></body></html>`;

s.onevent = async (d) => {
  if (d.method !== 'Fetch.requestPaused') return;
  const q = d.params.request;
  const rid = d.params.requestId;
  const sid = d.sessionId;
  const fulfill = (code, type, body) => call('Fetch.fulfillRequest', { requestId: rid, responseCode: code, responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: Buffer.from(body).toString('base64') }, sid);
  const json = (o, code = 200) => fulfill(code, 'application/json', JSON.stringify(o));
  const u = new URL(q.url);
  if (u.hostname === 'api-zidolista.jouki.cz' && u.pathname.startsWith('/sfx-preview/')) {
    // Range jako Židolišta (sfx-preview podporuje Accept-Ranges) — bez něj by nešlo posouvat.
    const m = /bytes=(\d*)-(\d*)/.exec(q.headers.Range || q.headers.range || '');
    const a = m && m[1] ? Number(m[1]) : 0, b = m && m[2] ? Math.min(Number(m[2]), wav.length - 1) : wav.length - 1;
    const hdr = [{ name: 'Content-Type', value: 'audio/wav' }, { name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Accept-Ranges', value: 'bytes' }, { name: 'Content-Length', value: String(b - a + 1) }];
    if (m) hdr.push({ name: 'Content-Range', value: `bytes ${a}-${b}/${wav.length}` });
    return call('Fetch.fulfillRequest', { requestId: rid, responseCode: m ? 206 : 200, responseHeaders: hdr, body: wav.subarray(a, b + 1).toString('base64') }, sid);
  }
  if (u.hostname === 'www.youtube-nocookie.com') {
    if (u.pathname === '/__e2e_cmd') { log.ytCmds.push(decodeURIComponent(u.search.slice(1))); return fulfill(204, 'text/plain', ''); }
    return fulfill(200, 'text/html', YT_STUB);
  }
  if (u.pathname === '/nicknames/stream') {
    const events = mock.sse.splice(0);
    return fulfill(200, 'text/event-stream', 'retry: 300\n\n' + events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
  }
  if (u.pathname === '/auth/me') return json({ ok: true, accountId: 7, platforms: { twitch: { login: 'tester', displayName: 'Tester' }, kick: null, youtube: null } });
  if (u.pathname === '/chat/history') return json({ ok: true, messages: [], nextBefore: null });
  if (u.pathname === '/soundboard') return json(soundboard());
  if (u.pathname === '/soundboard/requests/prepare') {
    const body = JSON.parse(q.postData || '{}');
    log.prepare.push({ body, auth: q.headers.Authorization || q.headers.authorization || null });
    const [code, out] = mock.prepare(body);
    return json(code === 200 ? { ...out, limits: mock.limits } : out, code);
  }
  if (u.pathname === '/soundboard/requests' && q.method === 'POST') {
    const body = JSON.parse(q.postData || '{}');
    log.submit.push(body);
    mock.limits = { ...mock.limits, dayUsed: mock.limits.dayUsed + 1, monthUsed: mock.limits.monthUsed + 1 };
    mock.requests.unshift({ requestId: 100 + log.submit.length, name: body.name, status: 'pending', reason: null, createdAt: iso(Date.now()), decidedAt: null, soundName: null, platform: 'twitch' });
    return json({ ok: true, requestId: 100 + log.submit.length, status: 'pending', limits: mock.limits });
  }
  if (u.pathname === '/soundboard/requests') { log.list++; return json({ ok: true, requests: mock.requests, limits: mock.limits }); }
  return call('Fetch.continueRequest', { requestId: rid }, sid);
};
// Stránka addonu i OOPIF přehrávače (jiný proces) → zachytávat na úrovni prohlížeče.
await call('Fetch.enable', { patterns: [
  ...['/auth/me', '/soundboard', '/chat/history', '/nicknames/stream'].map((p) => ({ urlPattern: `*api.jouki.cz${p}*` })),
  { urlPattern: '*www.youtube-nocookie.com/*' },
  { urlPattern: '*api-zidolista.jouki.cz/sfx-preview/*' },
] });
await call('Runtime.enable', {}, sessionId);
const ev = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId); if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 300) }; return r.result?.result?.value; };
const until = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr) === true) return true; await sleep(150); } return false; };
const txt = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
const rect = (sel) => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
const mouse = (type, x, y) => call('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse' }, sessionId);
/** Tah značky na zlomek šířky osy. */
async function dragHandle(which, frac) {
  const h = await rect(`.uc-sr-h-${which}`);
  const t = await rect('.uc-sr-track');
  const x0 = h.x + h.w / 2, y = h.y + h.h / 2, x1 = t.x + t.w * frac;
  await mouse('mousePressed', x0, y);
  for (let i = 1; i <= 5; i++) await mouse('mouseMoved', x0 + ((x1 - x0) * i) / 5, y);
  await mouse('mouseReleased', x1, y);
  await sleep(50);
}
const setVal = (sel, v) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const click = (sel) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);

// ---- boot ----
await call('Page.navigate', { url: `chrome-extension://${extId}/sidepanel.html` }, sessionId);
await sleep(1500);
await ev(`chrome.storage.local.set({ uc_session: 'tok' })`);
await call('Page.navigate', { url: `chrome-extension://${extId}/sidepanel.html` }, sessionId);

// ---- A: tlačítko v soundboardu ----
check('A nota soundboardu aktivní (přihlášený, tier odemčený)', await until(`(() => { const b = document.getElementById('btn-sfx'); return !!b && !b.classList.contains('hidden') && !b.classList.contains('uc-sb-off'); })()`, 12000));
await click('#btn-sfx');
check('A panel soundboardu otevřený', await until(`!document.querySelector('.uc-sb').classList.contains('hidden')`));
const reqBtn = await ev(`(() => { const b = document.querySelector('.uc-sb-top .uc-sb-reqbtn'); return b ? { title: b.title, afterSearch: b.previousElementSibling?.type === 'search', svg: !!b.querySelector('svg') } : null; })()`);
check('A tlačítko „Navrhnout zvuk“ vedle hledání', reqBtn?.title === 'Navrhnout zvuk' && reqBtn.afterSearch && reqBtn.svg, JSON.stringify(reqBtn));
await click('.uc-sb-reqbtn');
check('A klik → formulář návrhu místo seznamu', await until(`document.querySelector('.uc-sb').classList.contains('uc-sb-req-on') && !document.querySelector('.uc-sr').classList.contains('hidden') && getComputedStyle(document.querySelector('.uc-sb-body')).display === 'none'`));
check('A Moje návrhy načtené (GET /soundboard/requests)', await until(`document.querySelectorAll('.uc-sr-r').length === 2`) && log.list >= 1);
const mine = await ev(`[...document.querySelectorAll('.uc-sr-r')].map(r => r.querySelector('.uc-sr-rn').textContent + ':' + r.querySelector('.uc-sr-st').textContent + ':' + (r.querySelector('.uc-sr-rsub')?.textContent || '')).join('|')`);
check('A stavy návrhů česky + důvod zamítnutí', mine === 'cekajici:čeká na schválení:|zamitnuty:zamítnuto:Moc hlasité', mine);
check('A zbývající limit', (await txt('.uc-sr-limits')) === 'Dnes zbývá 8 z 10 · tento měsíc 28 z 30', await txt('.uc-sr-limits'));

// ---- B: prepare (server) → osa ----
mock.prepare = () => [200, { ok: true, previewId: 'prev-1', mode: 'server', source: 'mp3', durationMs: 95_000, peaks, previewUrl: 'https://api-zidolista.jouki.cz/sfx-preview/e2e.mp3', expiresAt: iso(Date.now() + 1800e3), title: 'Test zvuk' }];
await setVal('.uc-sr-link input[name=url]', 'https://example.com/zvuk.mp3');
await click('.uc-sr-load');
check('B prepare → časová osa', await until(`!document.querySelector('.uc-sr-edit').hidden`));
check('B prepare poslal kanál, platformu a odkaz (s Bearer)', log.prepare[0]?.body.channel === 'robdiesalot' && log.prepare[0]?.body.platform === 'twitch' && log.prepare[0]?.body.url === 'https://example.com/zvuk.mp3' && /^Bearer /.test(log.prepare[0]?.auth || ''), JSON.stringify(log.prepare[0]));
check('B waveform z 200 peaks', (await ev(`document.querySelectorAll('.uc-sr-wave i').length`)) === 200);
const handles = await ev(`(() => { const t = document.querySelector('.uc-sr-track').getBoundingClientRect(); const a = document.querySelector('.uc-sr-h-start').getBoundingClientRect(); const b = document.querySelector('.uc-sr-h-end').getBoundingClientRect(); return { start: Math.round(a.left + a.width / 2 - t.left), end: Math.round(b.left + b.width / 2 - t.left), w: Math.round(t.width) }; })()`);
check('B dvě značky: začátek vlevo, konec na 30 s', handles && handles.start === 0 && Math.abs(handles.end - handles.w * 30 / 95) <= 2, JSON.stringify(handles));
check('B výchozí výběr 0:00,0 – 0:30,0 (30,0 s)', (await txt('.uc-sr-ts')) === '0:00,0' && (await txt('.uc-sr-te')) === '0:30,0' && (await txt('.uc-sr-tl2')) === '30,0 s');
check('B úsek zvýrazněný mezi značkami', await ev(`(() => { const s = document.querySelector('.uc-sr-sel'); return parseFloat(s.style.left) === 0 && Math.abs(parseFloat(s.style.width) - 3000 / 95) < 0.1; })()`) === true);

// ---- C: tah značek ----
// Bootovací overlay (providery se v headless nepřipojí) by jinak zachytil skutečné události myši.
await ev(`document.querySelectorAll('.loading-overlay').forEach((o) => o.remove())`);
await dragHandle('end', 0.2);
const te1 = await txt('.uc-sr-te');
check('C tah konce na 20 % → konec 0:19,0', te1 === '0:19,0', te1);
await dragHandle('start', 0.1);
check('C tah začátku na 10 % → 0:09,5', (await txt('.uc-sr-ts')) === '0:09,5', await txt('.uc-sr-ts'));
await dragHandle('end', 0.9);
check('C konec se nepustí dál než začátek + 30 s', (await txt('.uc-sr-te')) === '0:39,5' && (await txt('.uc-sr-tl2')) === '30,0 s', `${await txt('.uc-sr-te')} / ${await txt('.uc-sr-tl2')}`);
await dragHandle('start', 0.95);
check('C začátek se nepustí za konec', (await txt('.uc-sr-ts')) === '0:39,3', await txt('.uc-sr-ts'));
await dragHandle('start', 0.3);
check('C značky přes sebe: tah doleva posune začátek (0:28,5)', (await txt('.uc-sr-ts')) === '0:28,5' && (await txt('.uc-sr-te')) === '0:39,5', `${await txt('.uc-sr-ts')} – ${await txt('.uc-sr-te')}`);
await ev(`document.querySelector('.uc-sr-h-start').focus()`);
await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }, sessionId);
await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }, sessionId);
check('C šipka → posun o 0,1 s', (await txt('.uc-sr-ts')) === '0:28,6', await txt('.uc-sr-ts'));
await click('.uc-sr-play');
check('C ▶ přehrává úsek z previewUrl (ukazatel na ose od začátku úseku)', await until(`document.querySelector('.uc-sr-play').classList.contains('playing') && !document.querySelector('.uc-sr-ph').hidden && parseFloat(document.querySelector('.uc-sr-ph').style.left) >= 28.6 / 95 * 100 - 0.01`, 4000),
  await ev(`JSON.stringify({ err: document.querySelector('.uc-sr-err').textContent, ph: document.querySelector('.uc-sr-ph').style.left })`));
await sleep(700);
check('C ukazatel přehrávání se posouvá', await ev(`parseFloat(document.querySelector('.uc-sr-ph').style.left) > 28.7 / 95 * 100`) === true, await ev(`document.querySelector('.uc-sr-ph').style.left`));
await click('.uc-sr-play');
check('C ■ zastaví', await ev(`!document.querySelector('.uc-sr-play').classList.contains('playing') && document.querySelector('.uc-sr-ph').hidden`) === true);

// ---- D: submit ----
await setVal('.uc-sr-edit input[name=name]', 'e2e boom');
check('D název → náhled commandu !se e2e_boom', (await txt('.uc-sr-cmd')) === '!se e2e_boom');
await setVal('.uc-sr-edit textarea[name=note]', 'z testu');
await click('.uc-sr-go');
check('D odesláno → potvrzení', await until(`!document.querySelector('.uc-sr-done').hidden`));
const sb0 = log.submit[0];
check('D submit poslal previewId, startMs, endMs, name, note, kanál a platformu', sb0?.previewId === 'prev-1' && sb0.startMs === 28_600 && sb0.endMs === 39_500 && sb0.name === 'e2e_boom' && sb0.note === 'z testu' && sb0.channel === 'robdiesalot' && sb0.platform === 'twitch', JSON.stringify(sb0));
check('D limit po odeslání', (await txt('.uc-sr-limits')) === 'Dnes zbývá 7 z 10 · tento měsíc 27 z 30', await txt('.uc-sr-limits'));
check('D nový návrh v Moje návrhy', await until(`document.querySelector('.uc-sr-r .uc-sr-rn')?.textContent === 'e2e_boom'`));

// ---- E: chyba youtube_blocked ----
await click('[data-act=again]');
mock.prepare = () => [400, { ok: false, error: 'youtube_blocked' }];
await setVal('.uc-sr-link input[name=url]', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
await click('.uc-sr-load');
check('E youtube_blocked → česká hláška', await until(`document.querySelector('.uc-sr-err').textContent === 'YouTube stahování ze serveru teď blokuje — pošli odkaz na mp3.' && !document.querySelector('.uc-sr-err').hidden`), await txt('.uc-sr-err'));
check('E formulář odkazu zůstal', await ev(`!document.querySelector('.uc-sr-link').hidden && document.querySelector('.uc-sr-edit').hidden`) === true);

// ---- F: režim embed (přehrávač odpovídá) ----
mock.prepare = () => [200, { ok: true, previewId: 'prev-emb', mode: 'embed', source: 'youtube', videoId: 'dQw4w9WgXcQ', title: 'Video', durationMs: null, peaks: null, previewUrl: null, expiresAt: iso(Date.now() + 1800e3) }];
await click('.uc-sr-load');
check('F embed → iframe youtube-nocookie se správnou URL', await until(`(() => { const f = document.querySelector('.uc-sr-yt-frame'); return !!f && f.src === 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?enablejsapi=1&controls=0&playsinline=1&origin=' + encodeURIComponent(location.origin); })()`),
  await ev(`document.querySelector('.uc-sr-yt-frame')?.src`));
check('F délka z infoDelivery → posuvník aktivní, výběr 0:00–0:30', await until(`!document.querySelector('.uc-sr-track').classList.contains('uc-sr-off') && document.querySelector('.uc-sr-te').textContent === '0:30,0'`, 6000),
  JSON.stringify(await ev(`({ off: document.querySelector('.uc-sr-track').classList.contains('uc-sr-off'), te: document.querySelector('.uc-sr-te').textContent, cmds: 0 })`)));
check('F osa bez waveformu (plná lišta)', await ev(`document.querySelector('.uc-sr-track').classList.contains('uc-sr-flat') && document.querySelectorAll('.uc-sr-wave i').length === 0 && document.querySelector('.uc-sr-yt-wait').hidden`) === true);
check('F listening poslán přehrávači', log.ytCmds.some((c) => JSON.parse(c).event === 'listening'), log.ytCmds.slice(0, 2).join(' '));
await dragHandle('start', 0.1);
const embStart = await txt('.uc-sr-ts');
await click('.uc-sr-play');
await until(`document.querySelector('.uc-sr-play').classList.contains('playing')`, 2000);
await sleep(600);
const cmds = log.ytCmds.map((c) => JSON.parse(c)).filter((c) => c.event === 'command');
const seek = cmds.find((c) => c.func === 'seekTo');
check('F ▶ = seekTo(začátek) + playVideo', embStart === '0:12,1' && !!seek && Math.abs(seek.args[0] - 12.05) < 0.06 && seek.args[1] === true && cmds.some((c) => c.func === 'playVideo'), `${embStart} ${JSON.stringify(cmds)}`);
await click('.uc-sr-play');
await sleep(400);
check('F ■ = pauseVideo', log.ytCmds.map((c) => JSON.parse(c)).some((c) => c.func === 'pauseVideo'));

// ---- G: embed odmítnut → ruční časy ----
mock.prepare = () => [200, { ok: true, previewId: 'prev-man', mode: 'embed', source: 'youtube', videoId: 'NOREPLY0000', title: null, durationMs: null, peaks: null, previewUrl: null, expiresAt: iso(Date.now() + 1800e3) }];
await click('[data-act=other]');
await setVal('.uc-sr-link input[name=url]', 'https://youtu.be/NOREPLY0000');
await click('.uc-sr-load');
check('G dokud přehrávač neodpoví: „Načítám video…“, posuvník neaktivní', await until(`!document.querySelector('.uc-sr-yt-wait').hidden && document.querySelector('.uc-sr-track').classList.contains('uc-sr-off')`, 3000));
check('G po 8 s bez infoDelivery → ruční časy + odkaz na video', await until(`!document.querySelector('.uc-sr-manual').hidden && document.querySelector('.uc-sr-tl').hidden && !document.querySelector('.uc-sr-yt-frame')`, 11000));
check('G odkaz na YouTube', (await ev(`document.querySelector('.uc-sr-ytlink').href`)) === 'https://www.youtube.com/watch?v=NOREPLY0000');
await setVal('.uc-sr-edit input[name=from]', '1:05');
await setVal('.uc-sr-edit input[name=to]', '1:40');
await setVal('.uc-sr-edit input[name=name]', 'rucni');
await click('.uc-sr-go');
check('G úsek delší než 30 s → hláška, nic neodesláno', await until(`document.querySelector('.uc-sr-err').textContent === 'Úsek je delší než 30 s.'`, 2000) && log.submit.length === 1, await txt('.uc-sr-err'));
await setVal('.uc-sr-edit input[name=to]', '1:20,5');
check('G délka ručního úseku', (await txt('.uc-sr-manual-len')) === 'Délka 15,5 s', await txt('.uc-sr-manual-len'));
await click('.uc-sr-go');
check('G ruční časy odeslané', await until(`!document.querySelector('.uc-sr-done').hidden`) && log.submit[1]?.startMs === 65_000 && log.submit[1]?.endMs === 80_500 && log.submit[1]?.previewId === 'prev-man', JSON.stringify(log.submit[1]));

// ---- H: SSE sfx-request → Moje návrhy ----
const before = log.list;
mock.requests = mock.requests.map((r) => (r.requestId === 11 ? { ...r, status: 'approved', soundName: 'cekajici', decidedAt: iso(Date.now()) } : r));
mock.sse.push(['sfx-request', { channel: 'robdiesalot', platform: 'twitch', userId: '42', requestId: 11, status: 'approved', soundName: 'cekajici' }]);
check('H SSE sfx-request → seznam obnoven, schváleno + !se', await until(`[...document.querySelectorAll('.uc-sr-r')].some(r => r.querySelector('.uc-sr-rn').textContent === 'cekajici' && r.querySelector('.uc-sr-st').textContent === 'schváleno' && r.querySelector('.uc-sr-rsub')?.textContent === '!se cekajici')`, 6000) && log.list > before);

// ---- I: vyčerpaný limit ----
mock.limits = { dayUsed: 10, dayMax: 10, monthUsed: 14, monthMax: 30 };
await click('[data-act=again]');
await click('.uc-sr-back');
check('I šipka zpět → seznam zvuků', await ev(`!document.querySelector('.uc-sb').classList.contains('uc-sb-req-on') && getComputedStyle(document.querySelector('.uc-sb-body')).display !== 'none'`) === true);
await click('.uc-sb-reqbtn');
check('I vyčerpaný denní limit → Načíst neaktivní + hláška', await until(`document.querySelector('.uc-sr-load').disabled && document.querySelector('.uc-sr-err').textContent.includes('Dnešní limit 10 návrhů')`));

console.log(`\n${pass} PASS, ${fail} FAIL`);
finish(fail ? 1 : 0);
