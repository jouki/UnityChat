// E2E (headless Chrome + CDP): moderace část 2 v addonu — nabídka moda na jméno (pravé tlačítko),
// timeout (tělo POST /moderation/user), Unban podle /moderation/user-state, target_protected,
// SSE user-moderated (styl + štítek na předchozích zprávách, unban štítek sundá), divák má nativní menu,
// varování účtu (okno z /auth/me i z /account/stream, blokace psaní do potvrzení, 403 warning_pending),
// Chat historie (panel přes chat: hlavička, záložky kanálů ze summary, přepnutí záložky, starší stránka, Esc).
//
// Backend je mockovaný přes Fetch.requestPaused (api.jouki.cz). /nicknames/stream = SSE s frontou
// (EventSource se po konci odpovědi sám znovu připojí, retry 300 ms). /account/stream = požadavek se
// podrží, dokud mock nemá událost (klient po konci spojení žádá nový ticket).
//
// Spuštění: node scripts/e2e-mod-menu.mjs   (Chrome v C:/Program Files/Google/Chrome/…, nebo CHROME=…)
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-e2e-modmenu-'));
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
const H = (id, user, userId, text, i) => ({ platform: 'twitch', id, username: user, userId, message: text, color: '#1e90ff', timestamp: now - 60000 + i * 1000, historical: true });
const mock = {
  mod: true,
  banned: false,
  userStatus: 200,
  userError: null,
  warnings: [],          // /auth/me + /account/warnings
  sendWarningPending: false,
  sse: [],               // /nicknames/stream
  acc: [],               // /account/stream
  heldAcc: null,         // podržený požadavek /account/stream
};
const H1 = [H('e2e-a1', 'Tester', 'u1', 'první zpráva testera', 1), H('e2e-b1', 'Other', 'u2', 'zpráva jiného', 2), H('e2e-a2', 'Tester', 'u1', 'druhá zpráva testera', 3)];
const posts = { user: [], ack: [], send: [], tickets: 0, hist: [] };
const sseBody = (events) => 'retry: 300\n\n' + events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join('');
const fulfill = (rid, sid, code, type, body) => call('Fetch.fulfillRequest', { requestId: rid, responseCode: code, responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: Buffer.from(body).toString('base64') }, sid);
const pushAcc = (type, data) => {
  mock.acc.push([type, data]);
  if (mock.heldAcc) { const h = mock.heldAcc; mock.heldAcc = null; fulfill(h.rid, h.sid, 200, 'text/event-stream', sseBody(mock.acc.splice(0))); }
};
s.onevent = async (d) => {
  if (d.method !== 'Fetch.requestPaused') return;
  const q = d.params.request;
  const rid = d.params.requestId;
  const sid = d.sessionId;
  const json = (o, code = 200) => fulfill(rid, sid, code, 'application/json', JSON.stringify(o));
  const u = q.url;
  const body = q.postData ? JSON.parse(q.postData) : null;
  if (u.includes('/nicknames/stream')) return fulfill(rid, sid, 200, 'text/event-stream', sseBody(mock.sse.splice(0)));
  if (u.includes('/account/stream-ticket')) { posts.tickets++; return json({ ok: true, ticket: `tk${posts.tickets}`, expiresInMs: 60000 }); }
  if (u.includes('/account/stream')) {
    if (mock.acc.length) return fulfill(rid, sid, 200, 'text/event-stream', sseBody(mock.acc.splice(0)));
    mock.heldAcc = { rid, sid };
    return;
  }
  if (/\/account\/warnings\/[^/]+\/ack/.test(u)) { const id = u.match(/warnings\/([^/]+)\/ack/)[1]; posts.ack.push(id); mock.warnings = mock.warnings.filter((w) => w.id !== id); return json({ ok: true }); }
  if (u.includes('/account/warnings')) return json({ ok: true, warnings: mock.warnings });
  if (u.includes('/auth/me')) return json({ ok: true, accountId: 7, platforms: { twitch: { login: 'moduser', displayName: 'ModUser' }, kick: null, youtube: null }, warnings: mock.warnings });
  if (u.includes('/moderation/me')) return json(mock.mod ? { ok: true, mod: true, platforms: ['twitch'], missingScopes: {} } : { ok: true, mod: false, platforms: [], missingScopes: {} });
  // Chat historie (před /moderation/user — ten by ji pohltil).
  if (u.includes('/moderation/user-history/summary')) {
    posts.hist.push(u);
    return json({ ok: true,
      user: { platform: 'twitch', userId: 'u1', login: 'tester', displayName: 'Tester', nickname: null, color: null, identities: [{ platform: 'twitch', login: 'tester', userId: 'u1' }, { platform: 'kick', login: 'tester_k', userId: 'k1' }], firstSeen: now - 86400000, lastSeen: now, total: 6 },
      channels: [{ channel: 'robdiesalot', count: 2, firstAt: now - 60000, lastAt: now }, { channel: 'arcadebulls', count: 3, firstAt: now - 86400000, lastAt: now - 3600000 }, { channel: 'tensterakdary', count: 1, firstAt: now - 7200000, lastAt: now - 7200000 }],
      moderation: [{ action: 'timeout', at: now - 1000, by: 'twitch:modik', platform: 'twitch', params: { durationSec: 600, reason: 'spam' } }] });
  }
  if (u.includes('/moderation/user-history/messages')) {
    posts.hist.push(u);
    const inCh = new URL(u).searchParams.get('inChannel');
    if (inCh === 'arcadebulls') return json({ ok: true, messages: [H('h-b1', 'Tester', 'u1', 'zpráva u Bulls 1', 1), H('h-b2', 'Tester', 'u1', 'zpráva u Bulls 2', 2), { ...H('h-b3', 'Tester', 'u1', '', 3), deleted: true }], nextBefore: null });
    // Dvě stránky: první nezaplní panel → klient sám dotáhne starší (before=c1).
    if (inCh === 'robdiesalot') return json(u.includes('before=c1')
      ? { ok: true, messages: [H('h-old', 'Tester', 'u1', 'nejstarší zpráva', -50)], nextBefore: null }
      : { ok: true, messages: [H1[0], H1[2]], nextBefore: 'c1' });
    return json({ ok: true, messages: [], nextBefore: null });
  }
  if (u.includes('/moderation/user-state')) return json({ ok: true, banned: mock.banned, until: null });
  if (u.includes('/moderation/user')) {
    posts.user.push(body);
    if (mock.userStatus !== 200) return json({ ok: false, error: mock.userError }, mock.userStatus);
    return json({ ok: true, action: body.action, until: null, results: { twitch: 'ok', kick: 'bot' }, targets: [], notes: {} });
  }
  if (u.includes('/chat/send')) {
    posts.send.push(body);
    if (mock.sendWarningPending) { mock.warnings = [{ id: 'w3', channel: 'robdiesalot', reason: 'Třetí varování', createdAt: new Date().toISOString() }]; return json({ ok: false, error: 'warning_pending' }, 403); }
    return json({ ok: true, id: 'x' });
  }
  if (u.includes('/chat/history')) return json({ ok: true, messages: u.includes('before=') ? [] : H1, nextBefore: null });
  return call('Fetch.continueRequest', { requestId: rid }, sid);
};
await call('Fetch.enable', { patterns: ['/auth/me', '/moderation/', '/chat/history', '/chat/send', '/nicknames/stream', '/account/'].map((p) => ({ urlPattern: `*api.jouki.cz${p}*` })) }, sessionId);
await call('Runtime.enable', {}, sessionId);
const ev = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId); if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 300) }; return r.result?.result?.value; };
const until = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr) === true) return true; await sleep(150); } return false; };
const key = (k) => ev(`(() => { const t = document.activeElement || document.body; t.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true })); return true; })()`);
// Pravé tlačítko na jméno zprávy → { prevented, menu }.
const rightClick = (id) => ev(`(() => { const un = document.querySelector('.msg[data-msg-id="${id}"] .un'); const r = un.getBoundingClientRect(); const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 4, clientY: r.top + 4, button: 2 }); un.dispatchEvent(e); return { prevented: e.defaultPrevented, menu: !!document.querySelector('.uc-mod-menu') }; })()`);
const menuItems = () => ev(`[...document.querySelectorAll('.uc-mod-menu .uc-mm-item')].map(b => b.textContent.replace('›', '').trim())`);
const lastSys = () => ev(`(() => { const a = [...document.querySelectorAll('#chat .sys')]; return a.length ? a[a.length - 1].textContent : null; })()`);
const msgState = (id) => ev(`(() => { const el = document.querySelector('.msg[data-msg-id="${id}"]'); if (!el) return null; return { cls: [...el.classList].filter(c => c.startsWith('uc-')).sort().join(' '), modTag: el.querySelector('.uc-mod-tag')?.textContent || null, delTagVisible: (() => { const t = el.querySelector('.uc-deleted-tag'); return !!t && getComputedStyle(t).display !== 'none'; })(), text: el.querySelector('.tx')?.textContent || '' }; })()`);

const boot = async () => {
  await call('Page.navigate', { url: `chrome-extension://${extId}/sidepanel.html` }, sessionId);
  await until(`!!document.querySelector('.msg[data-msg-id="e2e-a1"]')`, 10000);
};

await call('Page.navigate', { url: `chrome-extension://${extId}/sidepanel.html` }, sessionId);
await sleep(1500);
await ev(`chrome.storage.local.set({ uc_session: 'tok' })`);

// ---- fáze A: mod — nabídka ----
await boot();
check('A body.uc-can-moderate', await until(`document.body.classList.contains('uc-can-moderate')`));
const rc = await rightClick('e2e-a1');
check('A pravé tlačítko na jméno → vlastní nabídka (nativní menu potlačené)', rc?.prevented === true && rc.menu === true, JSON.stringify(rc));
const head = await ev(`document.querySelector('.uc-mod-menu .uc-mm-head')?.textContent`);
check('A hlavička: jméno + platforma', /Tester/.test(head || '') && /Twitch/.test(head || ''), head);
await until(`!!document.querySelector('.uc-mod-menu')`, 1000);
const items = await menuItems();
check('A položky nabídky', JSON.stringify(items) === JSON.stringify(['Smazat zprávu', 'Timeout', 'Zabanovat…', 'Přejmenovat…', 'Chat historie', 'Varovat…', 'Permit']), JSON.stringify(items));
check('A fokus na první položce', await ev(`document.activeElement?.dataset?.id === 'delete'`) === true);
await key('ArrowDown');
check('A šipka dolů → Timeout', await ev(`document.activeElement?.dataset?.id === 'timeout'`) === true);
await key('ArrowRight');
// Počítač s myší: podnabídka vyjede vedle (.uc-mm-fly), fokus na její první položce.
const sub = await ev(`JSON.stringify([...document.querySelectorAll('.uc-mod-menu .uc-mm-fly .uc-mm-item')].map(b => b.textContent))`);
check('A šipka doprava → podnabídka timeoutu vedle', sub === JSON.stringify(['5 s', '30 s', '1 min', '5 min', '10 min', '30 min', '1 h', '2 h']), sub);
check('A fokus v podnabídce', await ev(`document.activeElement?.dataset?.id === 'timeout:5'`) === true);
await key('ArrowDown'); await key('ArrowDown'); await key('ArrowDown');
check('A fokus na „5 min"', await ev(`document.activeElement?.dataset?.id === 'timeout:300'`) === true, await ev(`document.activeElement?.dataset?.id`));
await ev(`document.activeElement.click()`);
check('A po výběru nabídka zavřená', await until(`!document.querySelector('.uc-mod-menu')`, 2000));
await until(`[...document.querySelectorAll('#chat .sys')].some(s => s.textContent.startsWith('Timeout 5 min'))`, 4000);
const tb = posts.user[0];
check('A POST /moderation/user tělo', tb && tb.channel === 'robdiesalot' && tb.platform === 'twitch' && tb.userId === 'u1' && tb.login === 'Tester' && tb.action === 'timeout' && tb.durationSec === 300, JSON.stringify(tb));
check('A hláška výsledku po platformách', (await lastSys()) === 'Timeout 5 min pro Tester: Twitch ✓ · Kick ✓ (bot)', await lastSys());

// Vlastní délka: kolečko nad polem (nejméně 1) + jednotka → akce s n × jednotka
await rightClick('e2e-a1');
await key('ArrowDown'); await key('ArrowRight');
check('A podnabídka má řádek vlastní délky s/m/h', await ev(`JSON.stringify([...document.querySelectorAll('.uc-mod-menu .uc-mm-fly .uc-mm-custom .uc-mm-unit')].map(b => b.textContent))`) === JSON.stringify(['s', 'm', 'h']));
const wheel = await ev(`(() => { const i = document.querySelector('.uc-mod-menu .uc-mm-fly .uc-mm-custom-num');
  const w = (dy) => i.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, bubbles: true, cancelable: true }));
  w(100); const low = i.value; w(-100); w(-100); w(-100); return low + '|' + i.value; })()`);
check('A kolečko: pod 1 nejde, nahoru přičítá', wheel === '1|4', wheel);
const nUser = posts.user.length;
await ev(`[...document.querySelectorAll('.uc-mod-menu .uc-mm-fly .uc-mm-unit')].find(b => b.textContent === 'm').click()`);
check('A klik na „m" zavře nabídku', await until(`!document.querySelector('.uc-mod-menu')`, 2000));
await until(`[...document.querySelectorAll('#chat .sys')].some(s => s.textContent.startsWith('Timeout 4 min'))`, 4000);
check('A vlastní timeout 4 min → durationSec 240', posts.user.length === nUser + 1 && posts.user.at(-1)?.durationSec === 240, JSON.stringify(posts.user.at(-1)));
await rightClick('e2e-a1');
await ev(`document.querySelector('.uc-mod-menu [data-id="permit"]').click()`);
await ev(`(() => { const i = document.querySelector('.uc-mod-menu .uc-mm-custom-num'); i.value = '25'; })()`);
await ev(`[...document.querySelectorAll('.uc-mod-menu .uc-mm-unit')].find(b => b.textContent === 'h').click()`);
check('A permit 25 h (nad strop 24 h) → neodejde, nabídka zůstane', await ev(`!!document.querySelector('.uc-mod-menu .uc-mm-custom--bad')`) === true);
await key('Escape'); await key('Escape'); await key('Escape');

// Esc zavře, Esc v podnabídce se vrátí
await rightClick('e2e-a1');
await key('ArrowDown');
await ev(`document.activeElement.click()`);   // Enter v headless neklikne → klik na fokusovaný „Timeout"
check('A v podnabídce', await ev(`!!document.querySelector('.uc-mod-menu .uc-mm-fly')`) === true);
await key('Escape');
check('A Esc v podnabídce → zpět na hlavní', await ev(`!document.querySelector('.uc-mod-menu .uc-mm-fly') && !!document.querySelector('.uc-mod-menu') && document.activeElement?.dataset?.id === 'timeout'`) === true);
await key('Escape');
check('A Esc → nabídka zavřená', await ev(`!document.querySelector('.uc-mod-menu')`) === true);

// Unban podle user-state
mock.banned = true;
await rightClick('e2e-a1');
check('A user-state banned → Unban místo Timeout/Zabanovat', await until(`[...document.querySelectorAll('.uc-mod-menu .uc-mm-item')].some(b => b.textContent === 'Unban')`, 3000));
const bItems = await menuItems();
check('A bez Timeout a Zabanovat', !bItems.includes('Timeout') && !bItems.includes('Zabanovat…'), JSON.stringify(bItems));
await key('Escape');
mock.banned = false;

// target_protected
mock.userStatus = 403; mock.userError = 'target_protected';
await rightClick('e2e-b1');
await ev(`document.querySelector('.uc-mod-menu [data-id="ban"]').click()`);
check('A Zabanovat → potvrzovací dialog', await until(`!!document.querySelector('.uc-mod-dialog')`, 2000));
await ev(`document.querySelector('.uc-mod-dialog button[type=submit]').click()`);
await until(`[...document.querySelectorAll('#chat .sys')].some(s => s.textContent === 'Na streamera nebo moda to nejde.')`, 4000);
check('A target_protected → „Na streamera nebo moda to nejde."', (await lastSys()) === 'Na streamera nebo moda to nejde.', await lastSys());
check('A ban POST s action ban a userId u2', posts.user.at(-1)?.action === 'ban' && posts.user.at(-1)?.userId === 'u2');
mock.userStatus = 200;

// Varovat… — dialog s povinným důvodem (prázdný neodejde)
await rightClick('e2e-a1');
await ev(`document.querySelector('.uc-mod-menu [data-id="warn"]').click()`);
await until(`!!document.querySelector('.uc-mod-dialog textarea')`, 2000);
await ev(`document.querySelector('.uc-mod-dialog button[type=submit]').click()`);
check('A varování bez důvodu → chyba v dialogu', await until(`document.querySelector('.uc-mod-dialog-err')?.hidden === false`, 2000));
await ev(`document.querySelector('.uc-mod-dialog button[type=button]').click()`);
check('A Zrušit zavře dialog', await ev(`!document.querySelector('.uc-mod-dialog')`) === true);

// ---- Chat historie ----
await rightClick('e2e-a1');
const nameColor = await ev(`document.querySelector('.msg[data-msg-id="e2e-a1"] .un').style.color`);
await ev(`document.querySelector('.uc-mod-menu [data-id="history"]').click()`);
check('H „Chat historie" → panel přes chat, nabídka zavřená', await until(`!!document.querySelector('#chat-wrapper > .uc-uh') && !document.querySelector('.uc-mod-menu')`, 3000));
await until(`document.querySelectorAll('.uc-uh-tab').length > 0`, 4000);
check('H summary GET s kanálem a cílem', /summary\?channel=robdiesalot&platform=twitch&userId=u1/.test(posts.hist[0] || ''), posts.hist[0]);
check('H hlavička: jméno v barvě uživatele', await until(`document.querySelector('.uc-uh-name')?.textContent === 'Tester'`, 3000)
  && !!nameColor && (await ev(`document.querySelector('.uc-uh-name').style.color`)) === nameColor, String(nameColor));
const idsTxt = await ev(`[...document.querySelectorAll('.uc-uh-id')].map(e => e.textContent + ':' + !!e.querySelector('img')).join(',')`);
check('H propojené identity s logy', idsTxt === 'tester:true,tester_k:true', idsTxt);
const statsTxt = await ev(`document.querySelector('.uc-uh-stats').textContent`);
check('H statistika česky (3 tvary)', /^Poprvé viděn .+ · naposledy .+ · celkem 6 zpráv$/.test(statsTxt || ''), statsTxt);
const modTxt = await ev(`document.querySelector('.uc-uh-mod').textContent`);
check('H moderace: timeout 10 min + důvod + kdo', /Timeout 10 min/.test(modTxt || '') && /spam/.test(modTxt) && /modik \(Twitch\)/.test(modTxt), modTxt);
const tabsTxt = await ev(`[...document.querySelectorAll('.uc-uh-tab')].map(b => b.dataset.channel + ':' + b.querySelector('.uc-uh-tab-count').textContent).join(',')`);
check('H záložky = kanály ze summary s počty, aktuální první', tabsTxt === 'robdiesalot:2,arcadebulls:3,tensterakdary:1', tabsTxt);
check('H výchozí záložka = aktuální kanál, zprávy načtené', await until(`document.querySelectorAll('.uc-uh-list .uc-uh-msg').length === 3`, 3000) && posts.hist.some((x) => /inChannel=robdiesalot&limit=50$/.test(x)), posts.hist.join(' | '));
const order = await ev(`[...document.querySelectorAll('.uc-uh-list .uc-uh-msg')].map(r => r.dataset.id).join(',')`);
check('H starší stránka (nextBefore) doplněná nahoru + konec historie', order === 'h-old,e2e-a1,e2e-a2' && /before=c1/.test(posts.hist.at(-1) || '') && await ev(`document.querySelector('.uc-uh-list').firstElementChild.classList.contains('uc-uh-edge')`) === true, order);
const row0 = await ev(`(() => { const r = document.querySelector('.uc-uh-msg[data-id="e2e-a1"]'); return { time: r.querySelector('.uc-uh-time').textContent, logo: !!r.querySelector('.uc-uh-pi img'), text: r.querySelector('.uc-uh-tx').textContent }; })()`);
check('H řádek: datum + čas, logo, text', /^\d{1,2}\. \d{1,2}\. \d{4} \d{2}:\d{2}$/.test(row0?.time || '') && row0.logo && row0.text === 'první zpráva testera', JSON.stringify(row0));
await ev(`document.querySelector('.uc-uh-tab[data-channel="arcadebulls"]').click()`);
check('H přepnutí záložky načte zprávy kanálu', await until(`document.querySelectorAll('.uc-uh-list .uc-uh-msg').length === 3 && document.querySelector('.uc-uh-list .uc-uh-msg .uc-uh-tx').textContent === 'zpráva u Bulls 1'`, 3000) && /inChannel=arcadebulls/.test(posts.hist.at(-1) || ''), posts.hist.at(-1));
check('H aktivní záložka přepnutá', await ev(`document.querySelector('.uc-uh-tab--on')?.dataset.channel`) === 'arcadebulls');
check('H smazaná zpráva bez obsahu', await ev(`document.querySelector('.uc-uh-msg[data-id="h-b3"] .uc-uh-tx').textContent`) === 'Zpráva smazána');
await ev(`document.querySelector('.uc-uh-tab[data-channel="tensterakdary"]').click()`);
check('H prázdná záložka → „V tomto kanálu nic nenapsal."', await until(`document.querySelector('.uc-uh-status')?.textContent === 'V tomto kanálu nic nenapsal.'`, 3000));
await key('Escape');
check('H Esc zavře panel', await until(`!document.querySelector('.uc-uh')`, 2000));

// ---- SSE user-moderated ----
const at = Date.now();
mock.sse.push(['user-moderated', { channel: 'robdiesalot', platform: 'twitch', userId: 'u1', login: 'tester', action: 'timeout', until: at + 300000, by: 'twitch:jinymod', at }]);
check('A SSE user-moderated → předchozí zprávy uživatele smazané', await until(`document.querySelector('.msg[data-msg-id="e2e-a2"]')?.classList.contains('uc-deleted')`, 6000));
const a1 = await msgState('e2e-a1'), a2 = await msgState('e2e-a2'), b1 = await msgState('e2e-b1');
check('A obě zprávy Testera: mod vidí dim + štítek „Timeout (5 min)"', a1?.cls.includes('uc-deleted--dim') && a1.modTag === 'Timeout (5 min)' && a2?.modTag === 'Timeout (5 min)', JSON.stringify([a1, a2]));
check('A štítek „Smazáno" se se štítkem timeoutu nezdvojí', a1?.delTagVisible === false, JSON.stringify(a1));
check('A zpráva jiného uživatele beze změny', b1?.cls === '' && !b1.modTag, JSON.stringify(b1));
mock.sse.push(['user-moderated', { channel: 'robdiesalot', platform: 'twitch', userId: 'u1', login: 'tester', action: 'timeout', until: at + 300000, by: null, at }]);
await sleep(1200);
check('A druhé SSE (echo CLEARCHAT) → pořád jeden štítek', await ev(`document.querySelectorAll('.msg[data-msg-id="e2e-a1"] .uc-mod-tag').length`) === 1);
mock.sse.push(['user-moderated', { channel: 'robdiesalot', platform: 'twitch', userId: 'u1', login: 'tester', action: 'unban', until: null, by: 'twitch:jinymod', at: Date.now() }]);
check('A unban → štítek pryč', await until(`!document.querySelector('.msg[data-msg-id="e2e-a1"] .uc-mod-tag')`, 6000));
check('A unban → obsah zůstává (styl smazané)', (await msgState('e2e-a1'))?.cls.includes('uc-deleted'));
mock.sse.push(['user-moderated', { channel: 'jiny', platform: 'twitch', userId: 'u2', login: 'other', action: 'ban', until: null, by: null, at: Date.now() }]);
await sleep(1200);
check('A user-moderated z cizího kanálu ignorováno', (await msgState('e2e-b1'))?.cls === '');

// ---- fáze B: divák — nativní menu ----
mock.mod = false;
await boot();
await until(`!document.body.classList.contains('uc-can-moderate')`);
const rcV = await rightClick('e2e-a1');
check('B divák: nativní menu (nepotlačené), žádná nabídka', rcV?.prevented === false && rcV.menu === false, JSON.stringify(rcV));
mock.sse.push(['user-moderated', { channel: 'robdiesalot', platform: 'twitch', userId: 'u2', login: 'other', action: 'ban', until: null, by: 'twitch:modik', at: Date.now() }]);
check('B divák: ban → „Zpráva smazána" + štítek „Zabanován"', await until(`document.querySelector('.msg[data-msg-id="e2e-b1"] .uc-mod-tag')?.textContent === 'Zabanován'`, 6000));
const b1v = await msgState('e2e-b1');
check('B divák: výchozí styl label (text pryč)', b1v?.cls.includes('uc-deleted--label') && b1v.text === 'Zpráva smazána', JSON.stringify(b1v));

// ---- fáze C: varování účtu ----
mock.warnings = [{ id: 'w1', channel: 'robdiesalot', reason: 'Nespamuj odkazy', createdAt: new Date().toISOString() }];
await boot();
check('C okno varování z /auth/me', await until(`!!document.querySelector('.uc-warn-dialog')`, 6000));
check('C důvod v okně', await ev(`document.querySelector('.uc-warn-reason')?.textContent`) === 'Nespamuj odkazy');
check('C psaní zablokované + vysvětlení', await until(`document.getElementById('msg-input').disabled && document.getElementById('msg-input').placeholder.includes('varování')`, 3000));
const sendsBefore = posts.send.length;
await ev(`(() => { const i = document.getElementById('msg-input'); i.disabled = false; i.value = 'ahoj'; document.getElementById('btn-send').disabled = false; document.getElementById('btn-send').click(); return true; })()`);
await sleep(600);
check('C odeslání s nepotvrzeným varováním neodejde', posts.send.length === sendsBefore);
await ev(`document.querySelector('.uc-warn-dialog button').click()`);
check('C Rozumím → ack + okno zavřené', await until(`!document.querySelector('.uc-warn-dialog')`, 4000) && posts.ack.includes('w1'), JSON.stringify(posts.ack));
check('C po potvrzení psaní povolené', await until(`!document.getElementById('msg-input').disabled`, 3000));
check('C stream varování přes ticket', posts.tickets >= 1, `tickets=${posts.tickets}`);
pushAcc('account-warning', { id: 'w2', channel: 'robdiesalot', reason: 'Druhé varování', createdAt: new Date().toISOString() });
check('C nové varování z /account/stream → okno', await until(`document.querySelector('.uc-warn-reason')?.textContent === 'Druhé varování'`, 8000));
check('C … a zase blokace psaní', await ev(`document.getElementById('msg-input').disabled`) === true);
pushAcc('account-warning-ack', { id: 'w2' });
check('C ack z jiného okna → okno zavřené', await until(`!document.querySelector('.uc-warn-dialog')`, 10000));
check('C reconnect streamu s novým ticketem', posts.tickets >= 2, `tickets=${posts.tickets}`);
mock.sendWarningPending = true;
await until(`!document.getElementById('msg-input').disabled`, 3000);
await ev(`(() => { const i = document.getElementById('msg-input'); i.value = 'zkouška'; document.getElementById('btn-send').click(); return true; })()`);
check('C /chat/send 403 warning_pending → okno varování', await until(`document.querySelector('.uc-warn-reason')?.textContent === 'Třetí varování'`, 6000));

console.log(`\n${pass} PASS, ${fail} FAIL`);
finish(fail ? 1 : 0);
