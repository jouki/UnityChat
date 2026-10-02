// E2E (headless Chrome + CDP): Kolo štěstí v addonu (core/giveaway.js) — tlačítko moda v poli, vyhlášení formulářem,
// lišta nad polem, připojení (nedárce → hláška + Zkusit znovu), SSE změny, losování s animací kola zastavenou na
// výherci, potvrzení výhercem s odpočtem, divák bez ovládání moda. Backend mockovaný (Fetch.requestPaused).
// Spuštění: node scripts/e2e-giveaway.mjs
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-e2e-gw-'));
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

// ---- mock backendu (stav kola v testu) ----
const now = Date.now();
const H1 = [{ platform: 'twitch', id: 'tw-1', username: 'TwTester', userId: 'u1', message: 'ahoj', color: '#1e90ff', timestamp: now - 30000, historical: true }];
const mock = { mod: true, donor: false, gw: null, me: { joined: false, isWinner: false, eligible: false } };
const posts = [];
const base = (over) => ({ id: 1, channel: 'robdiesalot', prize: 'Klíč ke hře', status: 'open', count: 0, names: [], winner: null, deadline: null, drawSeq: 0, winners: [], confirmMinutes: 15, updatedAt: Date.now(), ...over });
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
  if (u.includes('/moderation/me')) return json(mock.mod ? { ok: true, mod: true, platforms: ['twitch'], missingScopes: {} } : { ok: true, mod: false, platforms: [], missingScopes: {} });
  if (u.includes('/giveaway/me')) return json({ ok: true, ...mock.me });
  if (u.includes('/giveaway?')) return json({ ok: true, giveaway: mock.gw, serverNow: Date.now() });
  if (q.method === 'POST' && u.includes('giveaway/')) {
    const act = u.split('/').pop();
    posts.push({ act, body });
    if (act === 'start') { mock.gw = base({ prize: body.prize, confirmMinutes: body.confirmMinutes }); return json({ ok: true, giveaway: mock.gw }); }
    if (act === 'join') {
      if (!mock.donor) return json({ ok: false, error: 'not_donor' }, 403);
      mock.me = { joined: true, isWinner: false, eligible: true };
      mock.gw = base({ ...mock.gw, count: mock.gw.count + 1, names: [...mock.gw.names, 'ModUser'] });
      return json({ ok: true, giveaway: mock.gw });
    }
    if (act === 'draw') {
      mock.me = { joined: true, isWinner: true, eligible: true };
      mock.gw = base({ ...mock.gw, status: 'pending', winner: { name: 'ModUser', platform: 'twitch' }, deadline: Date.now() + 15 * 60_000, drawSeq: mock.gw.drawSeq + 1 });
      return json({ ok: true, giveaway: mock.gw });
    }
    if (act === 'confirm') {
      mock.me = { joined: true, isWinner: false, eligible: true };
      mock.gw = base({ ...mock.gw, status: 'confirmed', deadline: null, winners: [{ name: 'ModUser', platform: 'twitch' }] });
      return json({ ok: true, giveaway: mock.gw });
    }
  }
  if (u.includes('/moderation/')) return json({ ok: true, requests: [], messages: {} });
  if (u.includes('/chat/history')) return json({ ok: true, messages: u.includes('before=') ? [] : H1, nextBefore: null });
  return call('Fetch.continueRequest', { requestId: rid }, sid);
};
await call('Fetch.enable', { patterns: ['/auth/me', '/moderation/', '/chat/', '/nicknames/stream', '/account/', '/giveaway'].map((p) => ({ urlPattern: `*api.jouki.cz${p}*` })) }, sessionId);
await call('Runtime.enable', {}, sessionId);
const ev = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId); if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 300) }; return r.result?.result?.value; };
const until = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr) === true) return true; await sleep(150); } return false; };
const boot = async () => {
  await call('Page.navigate', { url: `chrome-extension://${extId}/sidepanel.html` }, sessionId);
  await until(`!!document.querySelector('.msg[data-msg-id="tw-1"]')`, 10000);
};
const BAR = `(() => { const b = document.getElementById('gw-bar'); return { hidden: b.classList.contains('hidden'), text: b.textContent.replace(/\\s+/g, ' ').trim(), acts: [...b.querySelectorAll('[data-act]')].map(x => x.dataset.act) }; })()`;
// SHOT_DIR=<složka> → snímky lišty a kola (vizuální kontrola).
const shot = async (name) => { if (!process.env.SHOT_DIR) return; const r = await call('Page.captureScreenshot', { format: 'png' }, sessionId); fs.writeFileSync(path.join(process.env.SHOT_DIR, `${name}.png`), Buffer.from(r.result.data, 'base64')); };
const click = (act) => ev(`(() => { const b = document.querySelector('#gw-bar [data-act="${act}"]'); if (!b) return false; b.click(); return true; })()`);

await call('Page.navigate', { url: `chrome-extension://${extId}/sidepanel.html` }, sessionId);
await sleep(1500);
await ev(`chrome.storage.local.set({ uc_session: 'tok', uc_send_platform: 'twitch' })`);
await boot();
await until(`document.body.classList.contains('uc-can-moderate')`);

// ---- A: mod vyhlásí ----
check('A bez kola: lišta schovaná', (await ev(BAR)).hidden === true);
check('A tlačítko kola v poli pro moda', await until(`!document.getElementById('btn-giveaway').hidden && !!document.querySelector('#btn-giveaway svg')`, 4000));
await ev(`document.getElementById('btn-giveaway').click()`);
check('A klik → formulář vyhlášení', await until(`!!document.querySelector('#gw-bar .uc-gw-form input[name="prize"]')`, 2000));
await ev(`(() => { const f = document.querySelector('#gw-bar .uc-gw-form'); f.prize.value = 'Klíč ke hře'; f.minutes.value = '10'; f.requestSubmit(); return true; })()`);
await until(`/Klíč ke hře/.test(document.getElementById('gw-bar').textContent) && !document.querySelector('#gw-bar .uc-gw-form')`, 3000);
let bar = await ev(BAR);
check('A vyhlášeno: POST start s výhrou a lhůtou', posts[0]?.act === 'start' && posts[0].body.prize === 'Klíč ke hře' && posts[0].body.confirmMinutes === 10 && posts[0].body.channel === 'robdiesalot', JSON.stringify(posts[0]));
await shot('a-bar');
check('A lišta: výhra, 0 přihlášených, Připojit se + Losovat + Zrušit', /Kolo štěstí.*Klíč ke hře.*0 přihlášených/.test(bar.text) && bar.acts.join() === 'join,draw,end', JSON.stringify(bar));

// ---- B: připojení ----
await click('join');
await until(`/Jen pro podporovatele/.test(document.getElementById('gw-bar').textContent)`, 3000);
bar = await ev(BAR);
await shot('b-notdonor');
check('B nedárce: hláška + Zkusit znovu, bez připojení', /Jen pro podporovatele za posledních 30 dní/.test(bar.text) && bar.acts.includes('join') && !/Připojeno/.test(bar.text), JSON.stringify(bar));
mock.donor = true;
await click('join');
await until(`/Připojeno ✓/.test(document.getElementById('gw-bar').textContent)`, 3000);
bar = await ev(BAR);
check('B po donatu Zkusit znovu → Připojeno ✓, 1 přihlášený', /Připojeno ✓/.test(bar.text) && /1 přihlášený/.test(bar.text) && !bar.acts.includes('join'), JSON.stringify(bar));
// SSE: další lidé se připojili
mock.gw = base({ ...mock.gw, count: 4, names: ['ModUser', 'Anna', 'Petr', 'Zdeněk'] });
await ev(`window.ucGif.giveaway({ channel: 'robdiesalot', giveaway: ${JSON.stringify(mock.gw)} })`);
check('B SSE giveaway: počet se přepíše živě (4 přihlášení)', await until(`/4 přihlášení/.test(document.getElementById('gw-bar').textContent)`, 2000));
await ev(`window.ucGif.giveaway({ channel: 'jinykanal', giveaway: ${JSON.stringify(base({ prize: 'cizí', count: 9 }))} })`);
await sleep(200);
check('B SSE jiného kanálu se ignoruje', !/cizí/.test((await ev(BAR)).text));

// ---- C: losování s kolem ----
await click('draw');
check('C losování: překryv s kolem a jmény', await until(`!!document.querySelector('#chat-wrapper .uc-gw-overlay .uc-gw-wheel-svg') && document.querySelectorAll('.uc-gw-wheel-svg text').length === 4`, 3000));
await sleep(1500); await shot('c-spin');
const during = await ev(BAR);
check('C během točení lišta výherce neprozradí', !/Vyhráváš/.test(during.text), JSON.stringify(during));
check('C kolo dotočí a ukáže výherce', await until(`/Vylosováno\\s*ModUser/.test(document.querySelector('.uc-gw-result:not([hidden])')?.textContent || '')`, 8000));
await shot('c-result');
const ang = await ev(`(() => { const g = document.querySelector('.uc-gw-wheel-rot'); const a = g.getAnimations()[0]; const t = getComputedStyle(g).transform; return t; })()`);
check('C kolo stojí natočené (transform)', typeof ang === 'string' && ang !== 'none', String(ang));
bar = await ev(BAR);
await until(`!document.querySelector('.uc-gw-overlay')`, 5000); await shot('c-winner');
check('C výherce vidí Potvrdit výhru s odpočtem', /Vyhráváš!.*Potvrď do 1[45]:\d\d/.test(bar.text) && bar.acts.includes('confirm') && bar.acts.includes('end'), JSON.stringify(bar));
check('C překryv zmizí', await until(`!document.querySelector('.uc-gw-overlay')`, 5000));

// ---- D: potvrzení ----
await click('confirm');
await until(`/Výherce:/.test(document.getElementById('gw-bar').textContent)`, 3000);
bar = await ev(BAR);
check('D potvrzeno: Výherce ModUser + Losovat dalšího / Ukončit', /Výherce: ModUser 🎉/.test(bar.text) && bar.acts.join() === 'draw,end', JSON.stringify(bar));

// ---- E: divák (bez role) ----
mock.mod = false;
mock.me = { joined: false, isWinner: false, eligible: true };
mock.gw = base({ status: 'open', count: 2, names: ['A', 'B'] });
await boot();
await sleep(1200);
bar = await ev(BAR);
check('E divák: lišta bez ovládání moda, jen Připojit se', bar.acts.join() === 'join', JSON.stringify(bar));
check('E divák: tlačítko kola v poli schované', await ev(`document.getElementById('btn-giveaway').hidden`) === true);

console.log(`\n${pass} PASS, ${fail} FAIL`);
finish(fail ? 1 : 0);
