// E2E (headless Chrome + CDP): pole pro psaní a panely v addonu (spec 2026-09-27-composer-animace-ikony).
//  - otevření panelu z nuly: vyroste z tlačítka (scale + fade, origin vpravo dole), po animaci bez inline stylů
//    a klikatelný; zavření obráceně (duch se zmenší a zmizí), Esc / klik během zavírání nic nerozbije;
//  - posuvný indikátor: boční záložky Emoty | GIFy, horní taby GIF panelu (GIFy | Zamítnuté GIFy) a ikony v poli —
//    indikátor přejede (mezisnímky), sedí na aktivní položce i po změně velikosti okna;
//  - ikony v poli: žádný řádek navíc; QR se schová (animovaně) jen při textu v úzkém poli (< 330 px), na dotyku
//    při fokusu pole;
//  - dotyk: otevření panelu emotů / přepnutí záložky nedá fokus do hledání (bez klávesnice), myš ano;
//  - zamčený zvuk (Oblíbené): zámek u zvuku + v hlášce se zatřese, přestavění panelu zatřesení neutne;
//  - Esc v soundboardu / QR vrátí fokus do pole (myš), na dotyku ne;
//  - prefers-reduced-motion → vše okamžitě (zámek jen zčervená a zešedne, bez třesení).
// Backend mockovaný přes Fetch.requestPaused (api.jouki.cz). Spuštění: node scripts/e2e-composer-anim.mjs
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-e2e-composer-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--enable-unsafe-extension-debugging', '--window-size=560,900', 'about:blank'], { stdio: 'ignore' });

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
const soundboard = () => ({
  ok: true, channel: 'robdiesalot', platform: 'twitch', serverNow: iso(Date.now()), loggedIn: true,
  tiers: [{ tier: 1, name: 'BASIC', position: 1 }],
  sounds: [{ id: 1, name: 'boom', displayName: null, tier: 1, emoji: '💥', icon: null, url: 'https://api-zidolista.jouki.cz/public/sfx/rob/e2e.mp3', durationMs: 1000, gainDb: 0 }],
  // Bez odemčeného tieru (panel se otevře, zvuky zamčené) a zvuk v Oblíbených — test zatřesení zámku.
  me: { platform: 'twitch', userId: '42', login: 'tester', role: 'viewer', tiers: [], cooldown: { globalReadyAt: null, userReadyAt: null } },
  favorites: [1], recent: [],
});
s.onevent = async (d) => {
  if (d.method !== 'Fetch.requestPaused') return;
  const q = d.params.request;
  const rid = d.params.requestId;
  const sid = d.sessionId;
  const fulfill = (code, type, body) => call('Fetch.fulfillRequest', { requestId: rid, responseCode: code, responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: Buffer.from(body).toString('base64') }, sid);
  const json = (o, code = 200) => fulfill(code, 'application/json', JSON.stringify(o));
  const u = new URL(q.url);
  if (u.pathname === '/nicknames/stream' || u.pathname === '/account/stream') return fulfill(200, 'text/event-stream', 'retry: 60000\n\n');
  if (u.pathname === '/auth/me') return json({ ok: true, accountId: 7, platforms: { twitch: { login: 'tester', displayName: 'Tester' }, kick: null, youtube: null }, warnings: [] });
  if (u.pathname === '/chat/history') return json({ ok: true, messages: [], nextBefore: null });
  if (u.pathname === '/soundboard') return json(soundboard());
  if (u.pathname === '/donate/config') return json({ ok: true, enabled: true, iban: 'CZ6508000000192000145399', currencies: { CZK: { min: 50 } }, voices: [], version: 1 });
  if (u.pathname.startsWith('/account/')) return json({ ok: true, email: null, emailVerified: false, warnings: [] });
  if (u.pathname.startsWith('/gifs/library')) return json({ ok: true, items: [], nextCursor: null });
  if (u.pathname.startsWith('/gif') || u.pathname.startsWith('/moderation') || u.pathname.startsWith('/commands')) return json({ ok: false, error: 'e2e' }, 404);
  return call('Fetch.continueRequest', { requestId: rid }, sid);
};
await call('Fetch.enable', { patterns: ['/auth/me', '/soundboard', '/chat/history', '/nicknames/stream', '/donate/', '/account/', '/gif', '/moderation/', '/commands'].map((p) => ({ urlPattern: `*api.jouki.cz${p}*` })) }, sessionId);
await call('Runtime.enable', {}, sessionId);
const ev = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId); if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 400) }; return r.result?.result?.value; };
const until = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr) === true) return true; await sleep(100); } return false; };
const mouse = (type, x, y) => call('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse' }, sessionId);
const center = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; })()`);
/** Skutečný klik myší (mousedown → mouseup → click) doprostřed prvku. */
async function realClick(sel) {
  const r = await center(sel);
  if (!r?.w) return false;
  await mouse('mousePressed', r.x, r.y);
  await mouse('mouseReleased', r.x, r.y);
  return true;
}
/** Skutečný dotyk (touchStart → touchEnd → pointer typu touch + click). */
async function tap(sel) {
  const r = await center(sel);
  if (!r?.w) return false;
  await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y }] }, sessionId);
  await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
  return true;
}
// Esc z prvku s fokusem (QR dono poslouchá Esc na panelu, emoty / soundboard na dokumentu).
const esc = () => ev(`(document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
const setWidth = (width) => call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);

// Vzorkování každého snímku výrazem window.__recFn (nastaví test).
await call('Page.enable', {}, sessionId);
await call('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__rec = { on: false, frames: [] };
  const tick = () => { if (window.__rec.on && window.__recFn) { try { window.__rec.frames.push(window.__recFn()); } catch (e) { window.__rec.frames.push({ err: String(e) }); } } requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  window.__scale = (e) => { const t = getComputedStyle(e).transform; if (!t || t === 'none') return 1; const m = t.match(/matrix\\(([^,]+),/); return m ? Number(m[1]) : 1; };
  window.__box = (e) => e ? [e.offsetLeft, e.offsetTop, e.offsetWidth, e.offsetHeight] : null;
  window.__ind = (sel) => { const i = document.querySelector(sel); if (!i) return null; const m = new DOMMatrixReadOnly(getComputedStyle(i).transform === 'none' ? undefined : getComputedStyle(i).transform); return { x: Math.round(m.m41 * 10) / 10, y: Math.round(m.m42 * 10) / 10, w: i.offsetWidth, h: i.offsetHeight, off: i.classList.contains('uc-slide-off'), op: Number(getComputedStyle(i).opacity) }; };
` }, sessionId);
const rec = (fnSrc) => ev(`(() => { window.__recFn = ${fnSrc}; window.__rec.frames = []; window.__rec.on = true; return true; })()`);
const stop = () => ev(`(() => { window.__rec.on = false; return window.__rec.frames; })()`);

// ---- boot ----
await call('Page.navigate', { url: `chrome-extension://${extId}/sidepanel.html` }, sessionId);
await sleep(1500);
await ev(`chrome.storage.local.set({ uc_session: 'tok' })`);
await call('Page.navigate', { url: `chrome-extension://${extId}/sidepanel.html` }, sessionId);
check('boot: emoty, nota i QR jsou vidět v poli pro psaní', await until(`['btn-emotes', 'btn-sfx', 'btn-qrdono'].every((id) => { const b = document.getElementById(id); return b && !b.hidden && !b.classList.contains('hidden') && b.getBoundingClientRect().width > 0 && b.parentElement.classList.contains('msg-input-wrap'); })`, 15000));
check('§3 žádný řádek s ikonami navíc: všechny tři ikony v poli, řádek bodů Twitche bez QR', await ev(`!document.querySelector('#tw-credits .uc-tool-btn') && !document.querySelector('.uc-dock-row') && getComputedStyle(document.getElementById('tw-credits')).display === 'none'`) === true);
const rights = await ev(`['btn-qrdono', 'btn-sfx', 'btn-emotes'].map((id) => getComputedStyle(document.getElementById(id)).right)`);
check('§3 ikony zprava doleva: smajlík 4 px, nota 32 px, QR 60 px; pole má rezervu 90 px', JSON.stringify(rights) === '["60px","32px","4px"]'
  && await until(`getComputedStyle(document.getElementById('msg-input')).paddingRight === '90px'`, 2000), JSON.stringify([rights, await ev(`getComputedStyle(document.getElementById('msg-input')).paddingRight`)]));
await ev(`document.getElementById('msg-input').disabled = false`);

// ---- §1 otevření z nuly: vyroste z tlačítka ----
await rec(`() => { const p = document.querySelector('.uc-ep'); const vis = !p.classList.contains('hidden'); const o = getComputedStyle(p).transformOrigin.split(' ').map(parseFloat);
  return { vis, sc: vis ? __scale(p) : 0, op: vis ? Number(getComputedStyle(p).opacity) : 0, ox: o[0], oy: o[1], w: p.offsetWidth, h: p.offsetHeight }; }`);
await realClick('#btn-emotes');
await sleep(420);
const fo = (await stop()).filter((f) => f.vis);
check('§1 otevření: panel roste (mezisnímky scale 0 → 1) a prolíná se', fo.some((f) => f.sc > 0.02 && f.sc < 0.9) && fo.some((f) => f.op > 0 && f.op < 1) && Math.abs(fo.at(-1).sc - 1) < 0.001 && fo.at(-1).op === 1,
  JSON.stringify(fo.slice(0, 6).map((f) => [f.sc.toFixed(2), f.op.toFixed(2)])));
const mid = fo.find((f) => f.sc > 0.02 && f.sc < 0.9);
check('§1 otevření z pravého spodního rohu (origin vpravo dole u tlačítka)', !!mid && mid.ox > mid.w * 0.75 && mid.oy >= mid.h - 1, JSON.stringify(mid));
const clean = (sel) => ev(`(() => { const p = document.querySelector('${sel}'); const r = p.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 30);
  return { style: p.style.cssText, anims: p.getAnimations().length, ghost: p.classList.contains('uc-morph-ghost'), hit: !!hit && p.contains(hit), pe: getComputedStyle(p).pointerEvents }; })()`);
const c1 = await clean('.uc-ep');
check('§1 po otevření: žádné inline styly ani běžící animace, panel klikatelný', !c1.style && !c1.anims && !c1.ghost && c1.hit && c1.pe !== 'none', JSON.stringify(c1));
check('§1 desktop (myš): fokus v hledání emotů', await ev(`document.activeElement === document.querySelector('.uc-ep-search input')`) === true);

// ---- §1 zavření: zmenší se do tlačítka ----
await rec(`() => { const p = document.querySelector('.uc-ep'); return { hid: p.classList.contains('hidden'), ghost: p.classList.contains('uc-morph-ghost'), sc: __scale(p), op: Number(getComputedStyle(p).opacity) }; }`);
await esc();
const afterEsc = await ev(`({ exp: document.getElementById('btn-emotes').getAttribute('aria-expanded'), ghost: document.querySelector('.uc-ep').classList.contains('uc-morph-ghost'), focusIn: document.querySelector('.uc-ep').contains(document.activeElement) })`);
await sleep(380);
const fc = await stop();
check('§1 zavření: hned zavřený (aria-expanded false, duch, fokus pryč z panelu)', afterEsc.exp === 'false' && afterEsc.ghost && !afterEsc.focusIn, JSON.stringify(afterEsc));
check('§1 zavření: duch se zmenšuje a mizí (mezisnímky), pak skrytý', fc.some((f) => f.ghost && !f.hid && f.sc < 0.95 && f.sc > 0.02) && fc.at(-1).hid, JSON.stringify(fc.slice(0, 8).map((f) => [f.hid ? 'H' : f.ghost ? 'G' : 'V', f.sc.toFixed(2)])));
const c2 = await ev(`(() => { const p = document.querySelector('.uc-ep'); return { style: p.style.cssText, ghost: p.classList.contains('uc-morph-ghost'), aria: p.getAttribute('aria-hidden') }; })()`);
check('§1 po zavření: bez inline stylů, bez ducha', !c2.style && !c2.ghost && !c2.aria, JSON.stringify(c2));

// Klik na tlačítko během zavírání → panel znovu otevřený (neschová ho doběhnutí).
await realClick('#btn-sfx'); await sleep(350);
await esc(); await sleep(40);
await realClick('#btn-sfx'); await sleep(450);
check('§1 klik během zavírání: panel zase otevřený a čistý', await ev(`(() => { const p = document.querySelector('.uc-sb'); return !p.classList.contains('hidden') && !p.classList.contains('uc-morph-ghost') && !p.style.cssText; })()`) === true);
// Klik mimo zavře (s animací).
{ const r = await ev(`(() => { const r = document.getElementById('chat').getBoundingClientRect(); return { x: r.left + 40, y: r.top + 12 }; })()`); await mouse('mousePressed', r.x, r.y); await mouse('mouseReleased', r.x, r.y); }
check('§1 klik mimo panel zavře', await until(`document.querySelector('.uc-sb').classList.contains('hidden')`, 1500));

// ---- §1 posuvný indikátor: boční záložky Emoty | GIFy ----
await realClick('#btn-emotes'); await sleep(350);
const tabBox = (k) => ev(`__box(document.querySelector('.uc-ep-tab[data-tab="${k}"]'))`);
const IND_SIDE = '.uc-ep-side > .uc-slide-ind';
const e0 = await tabBox('emotes'), g0 = await tabBox('gif');
const i0 = await ev(`__ind('${IND_SIDE}')`);
check('§1 záložky: indikátor sedí na „Emoty“', i0 && !i0.off && i0.y === e0[1] && i0.h === e0[3] && i0.w === e0[2], JSON.stringify({ i0, e0 }));
await rec(`() => __ind('${IND_SIDE}')`);
await realClick('.uc-ep-tab[data-tab="gif"]');
await sleep(400);
const ft = await stop();
check('§1 záložky: indikátor přejede na „GIFy“ (mezisnímky mezi oběma)', ft.some((f) => f.y > e0[1] + 1 && f.y < g0[1] - 1) && ft.at(-1).y === g0[1], JSON.stringify(ft.map((f) => f.y).slice(0, 14)));
check('§1 záložky: aktivní záložka nekreslí vlastní pozadí (kreslí ho indikátor)', await ev(`getComputedStyle(document.querySelector('.uc-ep-tab[data-tab="gif"]')).backgroundColor`) === 'rgba(0, 0, 0, 0)');
// Resize: indikátor zůstane na aktivní záložce.
await setWidth(700); await sleep(300);
const g1 = await tabBox('gif'); const i1 = await ev(`__ind('${IND_SIDE}')`);
check('§1 záložky: po změně velikosti okna indikátor pořád na „GIFy“', i1.y === g1[1] && i1.x === g1[0] && i1.w === g1[2], JSON.stringify({ i1, g1 }));
await call('Emulation.clearDeviceMetricsOverride', {}, sessionId); await sleep(250);

// ---- §1 ikony v poli: indikátor u aktivní ikony ----
const IND_TOOL = '.msg-input-wrap > .uc-slide-ind--tool';
const bx = (id) => ev(`__box(document.getElementById('${id}'))`);
const t0 = await ev(`__ind('${IND_TOOL}')`), be = await bx('btn-emotes');
check('§1 ikony: indikátor na smajlíku (otevřené emoty)', t0 && !t0.off && t0.x === be[0] && t0.y === be[1] && t0.w === be[2], JSON.stringify({ t0, be }));
const bs = await bx('btn-sfx');
await rec(`() => __ind('${IND_TOOL}')`);
await realClick('#btn-sfx');
await sleep(450);
const fi = await stop();
check('§1 ikony: indikátor přejede ze smajlíku na notu (mezisnímky)', fi.some((f) => f.x < be[0] - 1 && f.x > bs[0] + 1) && fi.at(-1).x === bs[0] && !fi.at(-1).off, JSON.stringify(fi.map((f) => f.x).slice(0, 14)));
await rec(`() => __ind('${IND_TOOL}')`);
await realClick('#btn-qrdono');
await sleep(450);
const fq = await stop(); const bq = await bx('btn-qrdono');
check('§1 ikony: indikátor přejede na QR', fq.some((f) => f.x < bs[0] - 1 && f.x > bq[0] + 1) && fq.at(-1).x === bq[0], JSON.stringify({ bq, bs, x: fq.map((f) => f.x).slice(0, 14) }));
await esc(); await sleep(350);
const tEnd = await ev(`({ ind: __ind('${IND_TOOL}'), act: ['btn-qrdono', 'btn-sfx', 'btn-emotes'].filter((id) => document.getElementById(id).classList.contains('active')), qd: document.querySelector('.uc-qd').className })`);
check('§1 ikony: po zavření panelu indikátor zmizí', tEnd.ind?.off === true && tEnd.ind?.op === 0, JSON.stringify(tEnd));

// ---- §1 horní taby GIF panelu (GIFy | Zamítnuté GIFy) — panel moda přímo z core ----
const gl = await ev(`(async () => {
  const pane = document.createElement('div');
  pane.id = 'e2e-gl'; pane.style.cssText = 'position:fixed;left:10px;top:10px;width:380px;height:320px;display:flex;flex-direction:column;background:#111;z-index:99';
  document.body.appendChild(pane);
  const api = async (p) => (p.startsWith('/gifs/library') ? { ok: true, items: [], nextCursor: null } : { ok: true, items: [], suggestions: [] });
  window.__gl = window.UC_CORE.createGifPanel({ pane, api, channel: () => 'robdiesalot', canModerate: () => true, onPick: () => {} });
  window.__gl.show();
  await new Promise((r) => setTimeout(r, 300));
  return { tabs: !pane.querySelector('.uc-gl-tabs').hidden, ind: !!pane.querySelector('.uc-gl-tabs > .uc-slide-ind') };
})()`);
check('§1 GIF taby (mod): viditelné, s indikátorem', gl?.tabs && gl.ind, JSON.stringify(gl));
const IND_GL = '#e2e-gl .uc-gl-tabs > .uc-slide-ind';
const lb = await ev(`__box(document.querySelector('#e2e-gl .uc-gl-tab[data-gl-tab="lib"]'))`), rb = await ev(`__box(document.querySelector('#e2e-gl .uc-gl-tab[data-gl-tab="rej"]'))`);
const gi0 = await ev(`__ind('${IND_GL}')`);
check('§1 GIF taby: indikátor na „GIFy“', gi0?.x === lb[0] && gi0.w === lb[2] && !gi0.off, JSON.stringify({ gi0, lb }));
await rec(`() => __ind('${IND_GL}')`);
await realClick('#e2e-gl .uc-gl-tab[data-gl-tab="rej"]');
await sleep(400);
const fg = await stop();
check('§1 GIF taby: indikátor přejede na „Zamítnuté GIFy“', fg.some((f) => f.x > lb[0] + 1 && f.x < rb[0] - 1) && fg.at(-1).x === rb[0] && fg.at(-1).w === rb[2], JSON.stringify(fg.map((f) => f.x).slice(0, 14)));
await ev(`(() => { document.getElementById('e2e-gl').style.width = '300px'; return true; })()`); await sleep(250);
const rb2 = await ev(`__box(document.querySelector('#e2e-gl .uc-gl-tab[data-gl-tab="rej"]'))`), gi2 = await ev(`__ind('${IND_GL}')`);
check('§1 GIF taby: po zúžení panelu indikátor pořád přesně na aktivním tabu', gi2.x === rb2[0] && gi2.w === rb2[2], JSON.stringify({ gi2, rb2 }));
await ev(`(() => { window.__gl.destroy(); document.getElementById('e2e-gl').remove(); return true; })()`);

// ---- §3 QR ustoupí psaní: jen úzké pole (< 330 px) + text ----
const typeIn = (t) => ev(`(() => { const i = document.getElementById('msg-input'); i.focus(); i.value = ${JSON.stringify(t)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const qr = () => ev(`(() => { const b = document.getElementById('btn-qrdono'); const w = document.querySelector('.msg-input-wrap'); return { col: b.classList.contains('uc-tool-collapsed'), w: Math.round(b.getBoundingClientRect().width), op: Number(getComputedStyle(b).opacity), wrap: Math.round(w.getBoundingClientRect().width), pad: getComputedStyle(document.getElementById('msg-input')).paddingRight }; })()`);
await typeIn('ahoj');
await sleep(350);
const q1 = await qr();
check('§3 široké pole (≥ 330 px) + text → QR zůstává', q1.wrap >= 330 && !q1.col && q1.w === 26 && q1.op === 1, JSON.stringify(q1));
await typeIn('');
await setWidth(360); await sleep(350);
const q2 = await qr();
check('§3 úzké pole bez textu → QR vidět (i s fokusem na desktopu)', q2.wrap < 330 && !q2.col && q2.w === 26 && q2.pad === '90px', JSON.stringify(q2));
await rec(`() => { const b = document.getElementById('btn-qrdono'); return { w: b.getBoundingClientRect().width, op: Number(getComputedStyle(b).opacity) }; }`);
await typeIn('ahoj');
await sleep(400);
const fqh = await stop(); const q3 = await qr();
check('§3 úzké pole + text → QR se animovaně sbalí (šířka i průhlednost), pole získá místo', q3.col && q3.w === 0 && q3.op === 0 && q3.pad === '62px'
  && fqh.some((f) => f.w > 0.5 && f.w < 25.5) && fqh.some((f) => f.op > 0 && f.op < 1), JSON.stringify({ q3, frames: fqh.slice(0, 8).map((f) => [f.w.toFixed(1), f.op.toFixed(2)]) }));
check('§3 sbalený QR není klikatelný ani v tabulátoru', await ev(`(() => { const b = document.getElementById('btn-qrdono'); return getComputedStyle(b).pointerEvents === 'none' && b.tabIndex === -1; })()`) === true);
// Odeslání Enterem pole vyprázdní bez události input → QR se vrátí (keyup).
await ev(`(() => { const i = document.getElementById('msg-input'); i.value = ''; i.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true })); return true; })()`);
await sleep(350);
check('§3 prázdné pole → QR zpátky', !(await qr()).col && (await qr()).w === 26);
await call('Emulation.clearDeviceMetricsOverride', {}, sessionId); await sleep(250);
await ev(`document.getElementById('msg-input').blur()`);

// ---- §3 + §4 dotyk ----
await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);
await call('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] }, sessionId);
const coarse = await ev(`matchMedia('(pointer: coarse)').matches`);
check('dotyk: emulace pointer: coarse', coarse === true, String(coarse));
await ev(`window.ucComposerDock = null`);
await tap('#msg-input'); await sleep(350);
const q4 = await qr();
check('§3 dotyk: fokus pole → QR se schová (i v širokém poli, bez textu)', await ev(`document.activeElement === document.getElementById('msg-input')`) === true && q4.col && q4.w === 0, JSON.stringify(q4));
await ev(`document.getElementById('msg-input').blur()`); await sleep(350);
check('§3 dotyk: opuštění pole → QR zpátky', !(await qr()).col && (await qr()).w === 26);

await tap('#btn-emotes');
check('§4 dotyk: tap na smajlík otevře emoty', await until(`!document.querySelector('.uc-ep').classList.contains('hidden')`, 2000));
await sleep(300);
check('§4 dotyk: po otevření NENÍ fokus v hledání (klávesnice nevyskočí)', await ev(`document.activeElement !== document.querySelector('.uc-ep-search input')`) === true, await ev(`document.activeElement?.tagName || ''`));
await tap('.uc-ep-tab[data-tab="gif"]'); await sleep(300);
check('§4 dotyk: záložka GIFy bez fokusu do hledání GIFů', await ev(`document.activeElement !== document.querySelector('.uc-gl-search input')`) === true);
await tap('.uc-ep-tab[data-tab="emotes"]'); await sleep(300);
check('§4 dotyk: návrat na záložku Emoty bez fokusu do hledání (dřívější příčina regrese)', await ev(`document.activeElement !== document.querySelector('.uc-ep-search input')`) === true);
await tap('#btn-emotes'); await sleep(350);
await tap('#btn-sfx'); await sleep(400);
check('§4 dotyk: soundboard bez fokusu do hledání', await ev(`!document.querySelector('.uc-sb').classList.contains('hidden') && document.activeElement !== document.querySelector('.uc-sb-top input')`) === true);
await tap('#btn-sfx'); await sleep(350);
await call('Emulation.setEmulatedMedia', { features: [] }, sessionId);
await call('Emulation.setTouchEmulationEnabled', { enabled: false }, sessionId);
await realClick('#btn-emotes'); await sleep(350);
check('§4 zpět myš: otevření emotů dá fokus do hledání', await ev(`document.activeElement === document.querySelector('.uc-ep-search input')`) === true);
await esc(); await sleep(350);

// ---- §2 zamčený zvuk v Oblíbených: zámek u zvuku + v hlášce, ne v hlavičce tieru; přestavění neutne ----
await realClick('#btn-sfx'); await sleep(350);
check('§2 soundboard bez odměny: zámek + „Odměna není aktivována“, zamčený zvuk se zámkem', await ev(`!!document.querySelector('.uc-sb-status .uc-lock') && document.querySelector('.uc-sb-status').textContent.trim() === 'Odměna není aktivována' && !!document.querySelector('.uc-sb-sec[data-sec="fav"] .uc-sb-s.locked .uc-sb-slock')`) === true);
await realClick('.uc-sb-sec[data-sec="fav"] .uc-sb-play');
await sleep(60);
const sh1 = await ev(`({ status: !!document.querySelector('.uc-sb-status .uc-lock.uc-lock-shake'), card: !!document.querySelector('.uc-sb-sec[data-sec="fav"] .uc-lock.uc-lock-shake'),
  tier: !!document.querySelector('.uc-sb-h .uc-lock.uc-lock-shake'), anim: getComputedStyle(document.querySelector('.uc-sb-status .uc-lock')).animationName })`);
check('§2 klik na zamčený zvuk v Oblíbených: zatřese zámek u zvuku a v hlášce, ne v hlavičce tieru', sh1.status && sh1.card && !sh1.tier && sh1.anim === 'uc-lock-shake', JSON.stringify(sh1));
await sleep(250);
// Přestavění panelu (hledání / tik / SSE) — zatřesení na novém prvku pokračuje, nezačíná znovu ani se neutne.
await ev(`(() => { const i = document.querySelector('.uc-sb-top input'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const sh2 = await ev(`(() => { const l = document.querySelector('.uc-sb-sec[data-sec="fav"] .uc-lock'); return { shake: l.classList.contains('uc-lock-shake'), delay: l.style.animationDelay, t: l.getAnimations()[0]?.currentTime }; })()`);
check('§2 přestavění panelu během zatřesení: nový zámek pokračuje (záporné zpoždění, ~300 ms)', sh2.shake && /^-\d+ms$/.test(sh2.delay) && parseInt(sh2.delay.slice(1)) >= 200 && parseInt(sh2.delay.slice(1)) < 700, JSON.stringify(sh2));
check('§2 zatřesení doběhne (~1 s)', await until(`!document.querySelector('.uc-sb .uc-lock-shake')`, 2000));

// ---- Esc v soundboardu / QR: fokus zpět do pole (myš), na dotyku ne ----
await ev(`document.querySelector('.uc-sb-top input').focus()`);
await esc();
check('Esc v soundboardu (myš): panel zavřený, fokus v poli pro psaní', await ev(`document.activeElement === document.getElementById('msg-input')`) === true && await until(`document.querySelector('.uc-sb').classList.contains('hidden')`, 1500));
await ev(`document.getElementById('msg-input').blur()`);
await realClick('#btn-qrdono'); await sleep(350);
await esc();
check('Esc v QR donu (myš): panel zavřený, fokus v poli pro psaní', await ev(`document.activeElement === document.getElementById('msg-input')`) === true && await until(`document.querySelector('.uc-qd').classList.contains('hidden')`, 1500));
await ev(`document.getElementById('msg-input').blur()`);
await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);
await call('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] }, sessionId);
await tap('#btn-sfx'); await sleep(350);
await esc(); await sleep(300);
check('Esc v soundboardu na dotyku: fokus do pole nevrací (klávesnice)', await ev(`document.activeElement !== document.getElementById('msg-input')`) === true);
await tap('#btn-qrdono'); await sleep(350);
await esc(); await sleep(300);
check('Esc v QR donu na dotyku: fokus do pole nevrací', await ev(`document.activeElement !== document.getElementById('msg-input') && document.querySelector('.uc-qd').classList.contains('hidden')`) === true);
await call('Emulation.setEmulatedMedia', { features: [] }, sessionId);
await call('Emulation.setTouchEmulationEnabled', { enabled: false }, sessionId);

// ---- prefers-reduced-motion → vše okamžitě ----
await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
await rec(`() => { const p = document.querySelector('.uc-ep'); return { vis: !p.classList.contains('hidden'), sc: __scale(p), op: Number(getComputedStyle(p).opacity), anims: p.getAnimations().length }; }`);
await realClick('#btn-emotes');
await sleep(200);
const fr = (await stop()).filter((f) => f.vis);
check('reduced motion: otevření okamžité (bez scale / fade)', fr.length > 2 && fr.every((f) => f.sc === 1 && f.op === 1 && !f.anims), JSON.stringify(fr.slice(0, 3)));
await esc();
check('reduced motion: zavření okamžité', await ev(`document.querySelector('.uc-ep').classList.contains('hidden')`) === true);
const tr = await ev(`[getComputedStyle(document.querySelector('.uc-slide-ind')).transitionDuration, getComputedStyle(document.getElementById('btn-qrdono')).transitionDuration]`);
check('reduced motion: indikátor ani ikony bez přechodů', tr.every((d) => d.split(',').every((x) => parseFloat(x) === 0)), JSON.stringify(tr));
const rl = await ev(`(() => { const l = document.createElement('span'); l.className = 'uc-lock'; document.body.appendChild(l); window.UC_CORE.shakeLock(l);
  const r = getComputedStyle(l).animationName; l.remove(); return r; })()`);
check('reduced motion: zámek bez třesení, ale zčervená a zešedne (uc-lock-flash)', rl === 'uc-lock-flash', rl);
await call('Emulation.setEmulatedMedia', { features: [] }, sessionId);

console.log(`\n${pass} PASS, ${fail} FAIL`);
finish(fail ? 1 : 0);
