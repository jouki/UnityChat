// E2E (headless Chrome + CDP): přepínání panelů u pole pro psaní v addonu (test2 bod 5, core/panel-morph.js).
//  - emoty → soundboard → QR dono → emoty skutečným klikem myši (mousedown + click): po celou dobu je vidět
//    právě jeden panel (odcházející se jen rozplývá jako „duch“ nad novým), nikdy žádný (problik);
//  - rámeček nového panelu jede z rozměru starého na svůj (mezisnímek s šířkou mezi oběma);
//  - na konci správný obsah, rozepsané hledání v emotech zůstalo, Esc a klik mimo zavírají;
//  - prefers-reduced-motion → okamžitá výměna bez ducha; otevření z nuly a zavření bez animace.
//
// Backend mockovaný přes Fetch.requestPaused (api.jouki.cz). Spuštění: node scripts/e2e-panel-morph.mjs
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-e2e-morph-'));
// Široké okno: všechna tři tlačítka v poli pro psaní (tool dock je nepřesouvá do řádku).
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
  me: { platform: 'twitch', userId: '42', login: 'tester', role: 'viewer', tiers: [{ tier: 1, startedAt: iso(Date.now()), expiresAt: null, paused: false, remainingMs: null, available: true, totalMs: null }], cooldown: { globalReadyAt: null, userReadyAt: null } },
  favorites: [], recent: [],
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
  if (u.pathname.startsWith('/gif') || u.pathname.startsWith('/moderation') || u.pathname.startsWith('/commands')) return json({ ok: false, error: 'e2e' }, 404);
  return call('Fetch.continueRequest', { requestId: rid }, sid);
};
await call('Fetch.enable', { patterns: ['/auth/me', '/soundboard', '/chat/history', '/nicknames/stream', '/donate/', '/account/', '/gif', '/moderation/', '/commands'].map((p) => ({ urlPattern: `*api.jouki.cz${p}*` })) }, sessionId);
await call('Runtime.enable', {}, sessionId);
const ev = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId); if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 300) }; return r.result?.result?.value; };
const until = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr) === true) return true; await sleep(150); } return false; };
const mouse = (type, x, y) => call('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse' }, sessionId);
/** Skutečný klik myší (mousedown → mouseup → click) doprostřed prvku. */
async function realClick(sel) {
  const r = await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; })()`);
  if (!r?.w) return false;
  await mouse('mousePressed', r.x, r.y);
  await mouse('mouseReleased', r.x, r.y);
  return true;
}

// Vzorkování každého snímku: kolik panelů je vidět (bez ducha), kolik duchů, šířka viditelného panelu.
const PANELS = '.uc-ep, .uc-sb, .uc-qd';
await call('Page.enable', {}, sessionId);
await call('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__morph = { frames: [], on: false };
  const vis = (e) => !e.classList.contains('hidden') && getComputedStyle(e).display !== 'none';
  const tick = () => {
    if (window.__morph.on) {
      const ps = [...document.querySelectorAll(${JSON.stringify(PANELS)})].filter(vis);
      const real = ps.filter((e) => !e.classList.contains('uc-morph-ghost'));
      const ghosts = ps.filter((e) => e.classList.contains('uc-morph-ghost'));
      window.__morph.frames.push({ n: real.length, g: ghosts.length, cls: real.map((e) => e.className.split(' ')[0]).join(','), w: real[0] ? Math.round(real[0].getBoundingClientRect().width) : 0, go: ghosts[0] ? Number(getComputedStyle(ghosts[0]).opacity) : null });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
` }, sessionId);

// ---- boot ----
await call('Page.navigate', { url: `chrome-extension://${extId}/sidepanel.html` }, sessionId);
await sleep(1500);
await ev(`chrome.storage.local.set({ uc_session: 'tok' })`);
await call('Page.navigate', { url: `chrome-extension://${extId}/sidepanel.html` }, sessionId);
check('boot: tlačítka emotů, noty i QR dona jsou vidět', await until(`['btn-emotes', 'btn-sfx', 'btn-qrdono'].every((id) => { const b = document.getElementById(id); return b && !b.hidden && !b.classList.contains('hidden') && b.getBoundingClientRect().width > 0; })`, 15000),
  JSON.stringify(await ev(`['btn-emotes', 'btn-sfx', 'btn-qrdono'].map((id) => { const b = document.getElementById(id); return id + ':' + (b ? Math.round(b.getBoundingClientRect().width) + (b.hidden ? 'H' : '') + b.className : '-'); })`)));

const shown = () => ev(`[...document.querySelectorAll(${JSON.stringify(PANELS)})].filter((e) => !e.classList.contains('hidden') && getComputedStyle(e).display !== 'none').map((e) => e.className.split(' ')[0]).join(',')`);
const startRec = async () => { const r = await ev(`(() => { window.__morph.frames = []; window.__morph.on = true; return true; })()`); if (r !== true) console.log('startRec', JSON.stringify(r)); };
const stopRec = () => ev(`(() => { window.__morph.on = false; return window.__morph.frames; })()`);

// Otevření z nuly: bez animace (hned vidět, žádný duch).
await startRec();
await realClick('#btn-emotes');
await sleep(120);
const f0 = await stopRec();
check('otevření z nuly: panel emotů hned, bez ducha', (await shown()) === 'uc-ep' && f0.length > 0 && f0.every((f) => f.g === 0), JSON.stringify(f0.slice(0, 5)));
await ev(`(() => { const i = document.querySelector('.uc-ep-search input'); i.value = 'abc'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

/** Přepnutí klikem na tlačítko druhého panelu: po celou dobu právě jeden panel (+ nejvýš jeden duch), nikdy žádný. */
async function switchTo(btn, cls, label) {
  const wFrom = await ev(`Math.round([...document.querySelectorAll(${JSON.stringify(PANELS)})].find((e) => !e.classList.contains('hidden')).getBoundingClientRect().width)`);
  await startRec();
  await realClick(btn);
  await sleep(450);
  const fr = await stopRec();
  const final = await shown();
  const wTo = await ev(`Math.round(document.querySelector('.${cls}').getBoundingClientRect().width)`);
  check(`${label}: každý snímek právě jeden panel (žádný problik ani dva panely)`, fr.length > 5 && fr.every((f) => f.n === 1), JSON.stringify(fr.filter((f) => f.n !== 1).slice(0, 4)));
  check(`${label}: starý panel se rozplývá jako duch (průhlednost klesá) a pak zmizí`, fr.some((f) => f.g === 1 && f.go > 0 && f.go < 1) && fr.at(-1).g === 0, JSON.stringify(fr.filter((f) => f.g).map((f) => f.go?.toFixed(2)).slice(0, 12)));
  const mids = fr.filter((f) => f.cls === cls && f.w > Math.min(wFrom, wTo) + 2 && f.w < Math.max(wFrom, wTo) - 2);
  check(`${label}: rámeček plynule mění šířku (${wFrom} → ${wTo} px)`, wFrom === wTo || mids.length > 0, JSON.stringify(fr.map((f) => f.w)));
  check(`${label}: na konci jen ${cls}`, final === cls, final);
  return fr;
}

await switchTo('#btn-sfx', 'uc-sb', 'emoty → soundboard');
check('soundboard: obsah (zvuky) a tlačítko aktivní, emoty zavřené', await ev(`document.querySelectorAll('.uc-sb .uc-sb-s').length > 0 && document.getElementById('btn-sfx').classList.contains('active') && !document.getElementById('btn-emotes').classList.contains('active')`) === true);
await switchTo('#btn-qrdono', 'uc-qd', 'soundboard → QR dono');
check('QR dono: formulář vidět, soundboard zavřený', await ev(`!!document.querySelector('.uc-qd form') && document.getElementById('btn-qrdono').classList.contains('active') && !document.getElementById('btn-sfx').classList.contains('active')`) === true);
await switchTo('#btn-emotes', 'uc-ep', 'QR dono → emoty');
check('emoty: rozepsané hledání zůstalo („abc“), fokus v hledání', await ev(`document.querySelector('.uc-ep-search input').value === 'abc' && document.activeElement === document.querySelector('.uc-ep-search input')`) === true);
check('po přetvoření žádné zbylé inline styly (rozměry z CSS)', await ev(`[...document.querySelectorAll(${JSON.stringify(PANELS)})].every((e) => !e.style.width && !e.style.height && !e.style.left && !e.style.top && !e.classList.contains('uc-morph-ghost'))`) === true);

// Esc zavře, klik mimo zavře (beze změny chování).
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
check('Esc zavře panel', (await shown()) === '');
await realClick('#btn-sfx');
check('nota znovu otevře soundboard (z nuly)', await until(`!document.querySelector('.uc-sb').classList.contains('hidden')`, 2000));
// Klik do chatu nad panely (horní okraj seznamu zpráv).
{ const r = await ev(`(() => { const r = document.getElementById('chat').getBoundingClientRect(); return { x: r.left + 40, y: r.top + 12 }; })()`); await mouse('mousePressed', r.x, r.y); await mouse('mouseReleased', r.x, r.y); }
check('klik mimo (do chatu) panel zavře', await until(`[...document.querySelectorAll(${JSON.stringify(PANELS)})].every((e) => e.classList.contains('hidden'))`, 2000), await shown());

// Klávesnice: Enter na tlačítku (bez mousedown) přepne taky — jen jeden panel.
await realClick('#btn-emotes');
await until(`!document.querySelector('.uc-ep').classList.contains('hidden')`, 2000);
await ev(`document.getElementById('btn-sfx').click()`);
await sleep(450);
check('přepnutí bez myši (click z klávesnice): zůstane jen soundboard', (await shown()) === 'uc-sb', await shown());
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

// Review C1: rychlé A → B → C (odstup 60 ms, druhé přetvoření během prvního) → žádný zamrzlý inline stav.
const leftovers = () => ev(`[...document.querySelectorAll(${JSON.stringify(PANELS)})].filter((e) => e.style.cssText || e.classList.contains('uc-morph-ghost') || e.hasAttribute('aria-hidden')).map((e) => e.className.split(' ')[0] + ' "' + e.style.cssText + '"')`);
await realClick('#btn-emotes'); await sleep(400);
await realClick('#btn-sfx'); await sleep(60);
await realClick('#btn-qrdono'); await sleep(700);
check('C1 rychle emoty → nota → QR: jen QR, žádné zbylé inline styly ani duch', (await shown()) === 'uc-qd' && (await leftovers()).length === 0, JSON.stringify({ shown: await shown(), left: await leftovers() }));
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await sleep(200);
for (const [btn, cls] of [['#btn-emotes', 'uc-ep'], ['#btn-sfx', 'uc-sb'], ['#btn-qrdono', 'uc-qd']]) {
  await realClick(btn); await sleep(350);
  const ok = (await shown()) === cls && (await leftovers()).length === 0
    && await ev(`(() => { const p = document.querySelector('.${cls}'); const r = p.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 30); return !!hit && p.contains(hit) && getComputedStyle(p).pointerEvents !== 'none'; })()`) === true;
  check(`C1 potom ${cls} jde otevřít z nuly a klikat (bez zbytkových stylů, pointer-events)`, ok, JSON.stringify({ shown: await shown(), left: await leftovers() }));
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await sleep(200);
}
// Review I1: A → B a hned zpět A (do 220 ms) → A otevřený (klik na ducha ho nezavře).
await realClick('#btn-emotes'); await sleep(400);
await realClick('#btn-sfx'); await sleep(60);
await realClick('#btn-emotes'); await sleep(700);
check('I1 emoty → nota → hned zpět emoty: otevřené emoty, bez zbytků', (await shown()) === 'uc-ep' && (await leftovers()).length === 0 && await ev(`document.getElementById('btn-emotes').classList.contains('active') && !document.getElementById('btn-sfx').classList.contains('active')`) === true,
  JSON.stringify({ shown: await shown(), left: await leftovers() }));
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await sleep(200);
// Review M3/M4: bez nativního title u záložek a u tlačítek panelu.
check('M3 záložky panelu emotů bez nativního title', await ev(`[...document.querySelectorAll('.uc-ep-tab')].every((t) => !t.hasAttribute('title'))`) === true);

// prefers-reduced-motion → okamžitá výměna bez ducha.
await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
await realClick('#btn-emotes');
await until(`!document.querySelector('.uc-ep').classList.contains('hidden')`, 2000);
await startRec();
await realClick('#btn-sfx');
await sleep(300);
const fr = await stopRec();
check('reduced motion: okamžitá výměna — bez ducha, vždy jeden panel, hned soundboard', fr.length > 3 && fr.every((f) => f.g === 0 && f.n === 1) && fr.slice(1).every((f) => f.cls === 'uc-sb'), JSON.stringify(fr.slice(0, 4)));
await call('Emulation.setEmulatedMedia', { features: [] }, sessionId);

console.log(`\n${pass} PASS, ${fail} FAIL`);
finish(fail ? 1 : 0);
