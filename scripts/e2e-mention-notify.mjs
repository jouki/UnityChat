// E2E (headless Chrome + CDP): oznámení prohlížeče na @zmínku / odpověď (core/mention-notify.js).
// chrome.notifications.create v panelu je nahrazený zapisovačem; fokus panelu přes document.hasFocus.
// Backend mockovaný přes Fetch.requestPaused (/chat/history s historickou zmínkou).
//
// Spuštění: node scripts/e2e-mention-notify.mjs   (CHROME=… pro jinou cestu k Chromu)
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-e2e-notify-'));
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

const now = Date.now();
const history = [
  { platform: 'twitch', id: 'e2e-h1', username: 'Tester', message: '@notifyme stará zmínka', color: '#1e90ff', timestamp: now - 60000, historical: true },
  { platform: 'twitch', id: 'e2e-h2', username: 'Tester', message: 'obyčejná zpráva', color: '#1e90ff', timestamp: now - 50000, historical: true },
];
s.onevent = async (d) => {
  if (d.method !== 'Fetch.requestPaused') return;
  const rid = d.params.requestId; const u = d.params.request.url;
  const json = (o) => call('Fetch.fulfillRequest', { requestId: rid, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: Buffer.from(JSON.stringify(o)).toString('base64') }, d.sessionId);
  if (u.includes('/chat/history')) return json({ ok: true, messages: u.includes('before=') ? [] : history, nextBefore: null });
  return call('Fetch.continueRequest', { requestId: rid }, d.sessionId);
};
await call('Fetch.enable', { patterns: [{ urlPattern: '*api.jouki.cz/chat/history*' }] }, sessionId);
await call('Runtime.enable', {}, sessionId);
const ev = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId); if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 300) }; return r.result?.result?.value; };
const until = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr) === true) return true; await sleep(150); } return false; };

// Konfigurace: moje jméno + zapnutá oznámení, pak reload panelu.
await call('Page.navigate', { url: `chrome-extension://${extId}/sidepanel.html` }, sessionId);
await sleep(1500);
await ev(`chrome.storage.sync.set({ uc_config: { username: 'NotifyMe', mentionNotify: true } })`);
await call('Page.navigate', { url: `chrome-extension://${extId}/sidepanel.html` }, sessionId);
check('historie vykreslena', await until(`!!document.querySelector('.msg[data-msg-id="e2e-h1"]')`, 10000));
check('historická zmínka zvýrazněná', await ev(`document.querySelector('.msg[data-msg-id="e2e-h1"]').classList.contains('mentioned')`) === true);
// Instance UnityChat není globální → zachytit přes prototyp při dalším logu; zapisovač oznámení + fokus.
await ev(`(() => {
  window.__notes = [];
  document.hasFocus = () => window.__focus === true;
  chrome.notifications.create = (id, opts) => { window.__notes.push({ id, ...opts }); return Promise.resolve(id); };
  const o = UnityChat.prototype._ucLog;
  UnityChat.prototype._ucLog = function (...a) { window.__uc = this; return o.apply(this, a); };
  return true;
})()`);
await ev(`document.getElementById('input-deleted-style')?.dispatchEvent(new Event('change'))`);
check('instance zachycena', await until(`!!window.__uc`, 8000));
check('boot s historickou zmínkou oznámení nevytvořil', await ev(`!window.__uc._mentionNotifier`) === true);
check('checkbox zapnutý z configu', await ev(`document.getElementById('chk-mention-notify').checked`) === true);
await sleep(300);
check('historická zmínka → žádné oznámení', await ev(`window.__notes.length`) === 0, JSON.stringify(await ev('window.__notes')));

const live = (id, extra = {}) => `window.__uc._addMessage(${JSON.stringify({ platform: 'twitch', id, username: 'Pepa', message: '@NotifyMe ahoj ' + '\u2800', color: '#ff0000', timestamp: Date.now(), ...extra })})`;
await ev(live('e2e-l1'));
await sleep(300);
const notes = await ev('window.__notes');
check('živá zmínka bez fokusu → právě jedno oznámení', notes?.length === 1, JSON.stringify(notes));
check('titulek / text / kontext', notes?.[0]?.title === 'Zmínka od Pepa' && notes[0].message === '@NotifyMe ahoj' && notes[0].contextMessage === 'Twitch · robdiesalot' && notes[0].iconUrl.endsWith('icons/icon128.png'), JSON.stringify(notes?.[0]));
check('id nese okno panelu', /^ucm\|/.test(notes?.[0]?.id || ''), notes?.[0]?.id);

await ev(live('e2e-l1'));
await ev(live('e2e-own', { username: 'NotifyMe' }));
await ev(live('e2e-hist', { historical: true }));
await ev(live('e2e-del', { deleted: true }));
await ev(`window.__focus = true`);
await ev(live('e2e-watch'));
await ev(`window.__focus = false`);
await sleep(300);
check('duplicita / vlastní / historická / smazaná / při fokusu → nic', await ev('window.__notes.length') === 1, JSON.stringify(await ev('window.__notes.map(n => n.id)')));

// Throttle: dvě další zmínky do 5 s → jedno sloučené oznámení po uplynutí okna.
await ev(live('e2e-t1', { message: 'x @notifyme první' }));
await ev(live('e2e-t2', { message: 'odpověď', replyTo: { id: 'p', username: 'NotifyMe', message: 'moje' }, username: 'Karel' }));
check('v okně 5 s nic dalšího', await ev('window.__notes.length') === 1);
check('po okně sloučené oznámení', await until('window.__notes.length === 2', 7000));
const last = await ev('window.__notes[1]');
check('sloučené = poslední (odpověď) + „a 1 další zpráva"', last?.title === 'Odpověď od Karel' && /a 1 další zpráva/.test(last.contextMessage || ''), JSON.stringify(last));

console.log(`\n${pass} PASS, ${fail} FAIL`);
finish(fail ? 1 : 0);
