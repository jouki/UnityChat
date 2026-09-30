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

// ---- Jména bez zavináče: celé slovo mimo adresu (hlášení usera 2026-09-29) ----
const bare = async (id, message, username = 'Pepa') => {
  await ev(`window.__uc._addMessage(${JSON.stringify({ platform: 'twitch', id, username, message, color: '#00ff00', timestamp: Date.now() })})`);
  await sleep(150);
  return ev(`(() => { const el = document.querySelector('.msg[data-msg-id="${id}"]'); return el ? { hl: el.classList.contains('mentioned'), spans: [...el.querySelectorAll('.tx .mention')].map((m) => m.textContent) } : null; })()`);
};
await ev(`window.__uc._addMessage(${JSON.stringify({ platform: 'twitch', id: 'e2e-kamo', username: 'kamo', message: 'zdar', color: '#ff00ff', timestamp: Date.now() })})`);
await ev(`window.__uc._addMessage(${JSON.stringify({ platform: 'twitch', id: 'e2e-rob', username: 'RobDiesALot', message: 'zdar', color: '#ff00ff', timestamp: Date.now() })})`);
const b1 = await bare('e2e-b1', 'to byl NotifyMe, ne?');
check('moje jméno bez zavináče zprávu zvýrazní', b1?.hl === true, JSON.stringify(b1));
const b2 = await bare('e2e-b2', 'hrál warcrafty s kamošem po telefonu');
check('„kamo“ uvnitř „kamošem“ se nebarví', b2 && b2.spans.length === 0, JSON.stringify(b2));
const b3 = await bare('e2e-b3', 'čau kamo jak je');
check('„kamo“ jako celé slovo se barví', b3 && b3.spans.join() === 'kamo', JSON.stringify(b3));
const b4 = await bare('e2e-b4', 'chat je na www.robdiesalot.com/chat a robdiesalot.com');
check('jméno uvnitř adresy se nebarví', b4 && !b4.spans.some((t) => /robdiesalot/i.test(t)), JSON.stringify(b4));
// Moje UC přezdívka bez zavináče (mapa přezdívek: notifyme → „Notík“) se obarví mou barvou a zpráva dostane štítek.
await ev(`(() => { window.__uc.nicknames._map.set('twitch:notifyme', { nickname: 'Notík', color: '#ff8400' }); return true; })()`);
const b6 = await bare('e2e-b6', 'to řekl Notík včera');
check('přezdívka bez zavináče: zvýraznění + štítek Mentions you + barva jména', b6?.hl === true && b6.spans.join() === 'Notík' && (await ev(`document.querySelector('.msg[data-msg-id="e2e-b6"] .msg-tag')?.textContent`)) === 'Mentions you', JSON.stringify(b6));
const b5 = await bare('e2e-b5', 'mrkni na notifyme.cz/profil');
check('moje jméno uvnitř adresy zprávu nezvýrazní', b5?.hl === false, JSON.stringify(b5));

// ---- Zvýraznění doplněné po načtení účtu + výchozí barva Twitche (hlášení usera 2026-09-30) ----
const late = await ev(`(() => { const uc = window.__uc; const keepCfg = uc.config.username; const keepNames = { ...uc._platformUsernames };
  uc.config.username = ''; uc._platformUsernames = {};
  uc._addMessage({ platform: 'twitch', id: 'e2e-late1', username: 'JoukiBOT', message: 'Top D resetováno', color: null, timestamp: Date.now(), historical: true, replyTo: { username: 'NotifyMe', message: '!topd reset', id: 'x1' } });
  uc._addMessage({ platform: 'twitch', id: 'e2e-late2', username: 'Pepa', message: 'čau @NotifyMe', color: '#00ff00', timestamp: Date.now(), historical: true });
  uc._addMessage({ platform: 'twitch', id: 'e2e-late3', username: 'Pepa', message: 'nic pro tebe', color: '#00ff00', timestamp: Date.now(), historical: true });
  const st = (id) => { const el = document.querySelector('.msg[data-msg-id="' + id + '"]'); return { hl: el.classList.contains('mentioned'), tag: el.querySelector('.msg-tag')?.textContent || '', color: el.querySelector('.un')?.style.color || '' }; };
  const before = [st('e2e-late1'), st('e2e-late2')];
  uc.config.username = keepCfg; uc._platformUsernames = keepNames;
  const n = uc._refreshMentionHighlights();
  return { before, n, after: [st('e2e-late1'), st('e2e-late2'), st('e2e-late3')] }; })()`);
check('historie vykreslená bez jmen je bez zvýraznění', late && late.before.every((x) => !x.hl && !x.tag), JSON.stringify(late?.before));
check('po načtení jmen se doplní „Replying to you“ a „Mentions you“', late && late.after[0].hl && late.after[0].tag === 'Replying to you' && late.after[1].hl && late.after[1].tag === 'Mentions you' && !late.after[2].hl, JSON.stringify(late?.after));
check('zpráva z Twitche bez barvy má výchozí barvu podle jména (ne bílou)', late && /rgb|#/.test(late.after[0].color), JSON.stringify(late?.after?.[0]));

// Zpráva dárce (server `donor: true`) → odznak dárce (core/donor-badge.js, varianta kanálu; bez načtených prefs výchozí mince).
const dn = await ev(`(() => { window.__uc._addMessage({ platform: 'twitch', id: 'e2e-donor', username: 'Darce', userId: 'u55', message: 'ahoj', color: '#00ff00', timestamp: Date.now(), donor: true });
  const img = document.querySelector('.msg[data-msg-id="e2e-donor"] .bdg img[data-donor-badge]'); return { has: !!img, v: img?.dataset.donorBadge, src: img?.getAttribute('src') || '', alt: img?.alt }; })()`);
check('zpráva dárce má odznak dárce (vložené SVG, tooltip „Podporovatel“)', dn && dn.has && dn.src.startsWith('data:image/svg+xml') && dn.alt === 'Podporovatel', JSON.stringify(dn));

console.log(`\n${pass} PASS, ${fail} FAIL`);
finish(fail ? 1 : 0);
