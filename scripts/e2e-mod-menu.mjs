// E2E (headless Chrome + CDP): moderace část 2 v addonu — nabídka moda na jméno (pravé tlačítko),
// timeout (tělo POST /moderation/user), Unban podle /moderation/user-state, target_protected,
// SSE user-moderated (styl + štítek na předchozích zprávách, unban štítek sundá), divák má nativní menu,
// varování účtu (okno z /auth/me i z /account/stream, blokace psaní do potvrzení, 403 warning_pending),
// Profil (dřív Chat historie; panel přes chat: hlavička s badge vč. 7TV, identity, suma donů, záložky kanálů,
// oddělovače dnů, řádky donů, citace odpovědí + profil autora, ikony akcí moda a přihlášení s moderací po no_actor,
// přepnutí záložky, starší stránka, Esc; divák: levý klik → veřejný Profil jen s hlavičkou).
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
  older429: 1,           // Profil: starší stránka robdiesalot → jednou 429 (klient sám zopakuje za 1 s)
  olderFail: 1,          // Profil: starší stránka arcadebulls → jednou 500 (klient čeká na „Zkusit znovu“)
  missing: { twitch: ['moderator:manage:banned_users'] },   // /moderation/me missingScopes (mod)
  userResults: { twitch: 'ok', kick: 'bot' },               // /moderation/user results
  deleteResult: 'ok',                                       // /moderation/delete result
};
const H1 = [H('e2e-a1', 'Tester', 'u1', 'první zpráva testera', 1), H('e2e-b1', 'Other', 'u2', 'zpráva jiného', 2), H('e2e-a2', 'Tester', 'u1', 'druhá zpráva testera', 3)];
const posts = { user: [], ack: [], send: [], tickets: 0, hist: [], del: [], restore: [], seventv: 0 };
const DAY = 86400000;
// Profil: dona (d1 mezi dvěma zprávami, d2 před dvěma dny = jen podle jména), odpověď na zprávu jiného uživatele.
const DONS = [
  { id: 'd1', amount: 150, currency: 'CZK', amountCzk: 150, paidAt: now - 60000 + 2000, via: 'qr', matchedBy: 'uc', nickname: 'Tester', message: 'díky za stream' },
  { id: 'd2', amount: 250, currency: 'CZK', amountCzk: 250, paidAt: now - 2 * DAY, via: 'qr', matchedBy: 'nickname', nickname: 'tester', message: null },
];
// Twitch dává login autora citace (reply-parent-user-login) → Profil se otevírá podle něj, ne podle display name.
const HREP = { ...H('h-rep', 'Tester', 'u1', 'souhlas', 4), replyTo: { username: 'OtherDisplay', login: 'other', message: 'původní zpráva jiného uživatele, která je dost dlouhá na to, aby se v Profilu nevešla na jeden řádek ani omylem', id: 'e2e-b1' } };
const summaryMod = (who) => who === 'other'
  ? { ok: true, view: 'mod', user: { platform: 'twitch', userId: 'u2', login: 'other', displayName: 'Other', nickname: null, color: null, identities: [{ platform: 'twitch', login: 'other', userId: 'u2', displayName: 'Other' }], firstSeen: now - 60000, lastSeen: now, total: 1 },
    channels: [{ channel: 'robdiesalot', count: 1, firstAt: now - 60000, lastAt: now }], moderation: [], latest: { twitch: { platform: 'twitch', id: 'e2e-b1', username: 'Other', userId: 'u2', timestamp: now, color: null, badgesRaw: '' } } }
  : { ok: true, view: 'mod',
    user: { platform: 'twitch', userId: 'u1', login: 'tester', displayName: 'Tester', nickname: null, color: null, identities: [{ platform: 'twitch', login: 'tester', userId: 'u1', displayName: 'Tester' }, { platform: 'kick', login: 'tester_k', userId: 'k1', displayName: 'Tester K' }], firstSeen: now - 86400000, lastSeen: now, total: 6 },
    channels: [{ channel: 'robdiesalot', count: 2, firstAt: now - 60000, lastAt: now }, { channel: 'arcadebulls', count: 3, firstAt: now - 86400000, lastAt: now - 3600000 }, { channel: 'tensterakdary', count: 1, firstAt: now - 7200000, lastAt: now - 7200000 }],
    moderation: [{ action: 'timeout', at: now - 1000, by: 'twitch:modik', platform: 'twitch', params: { durationSec: 600, reason: 'spam' } }],
    latest: { twitch: { platform: 'twitch', id: 'e2e-a2', username: 'Tester', userId: 'u1', timestamp: now, color: '#1e90ff', badgesRaw: '' }, kick: { platform: 'kick', id: 'k-1', username: 'tester_k', userId: 'k1', timestamp: now, color: null, badgesRaw: 'moderator' } },
    donations: { total: { czk: 1750, byCurrency: { CZK: 1250, EUR: 20 } }, count: 3, uc: { czk: 1500, count: 2 }, guess: { czk: 250, byCurrency: { CZK: 250 }, count: 1 } } };
// Veřejný tvar (divák): jen tahle pole — stejně jako server (buildPublicSummary).
const summaryPublic = { ok: true, view: 'public', user: { platform: 'twitch', userId: 'u1', login: 'tester', displayName: 'Tester', nickname: null, color: null, firstSeen: now - 86400000, lastSeen: now, total: 2 },
  latest: { twitch: { platform: 'twitch', id: 'e2e-a2', username: 'Tester', userId: 'u1', timestamp: now, color: '#1e90ff', badgesRaw: '' } }, donations: { ucNamed: { czk: 1000, count: 1 } } };
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
  if (u.includes('/moderation/me')) return json(mock.mod ? { ok: true, mod: true, platforms: ['twitch'], missingScopes: mock.missing } : { ok: true, mod: false, platforms: [], missingScopes: {} });
  // Profil (před /moderation/user — ten by ho pohltil).
  if (u.includes('/moderation/user-history/summary')) {
    posts.hist.push(u);
    const sp = new URL(u).searchParams;
    if (!mock.mod) return json(summaryPublic);
    return json(summaryMod(!sp.get('userId') && sp.get('login') === 'other' ? 'other' : 'tester'));
  }
  if (u.includes('/moderation/user-history/donations')) {
    posts.hist.push(u);
    if (!mock.mod) return json({ ok: false, error: 'not_mod' }, 403);
    return json({ ok: true, available: true, items: [...DONS].reverse() });
  }
  if (u.includes('/moderation/delete')) { posts.del.push(body); return json({ ok: true, result: mock.deleteResult }); }
  // Odkrýt zprávu: odpověď s celou zprávou (tvar /chat/history), jako server po úplném odkrytí.
  if (u.includes('/moderation/restore')) {
    posts.restore.push(body);
    const orig = [...H1, HREP].find((m) => m.id === body?.messageId);
    return json(orig ? { ok: true, result: 'ok', message: { ...orig, historical: true } } : { ok: false, error: 'not_found', result: 'not_found' }, orig ? 200 : 404);
  }
  if (u.includes('/moderation/user-history/messages')) {
    posts.hist.push(u);
    const inCh = new URL(u).searchParams.get('inChannel');
    if (inCh === 'arcadebulls') {
      if (u.includes('before=c2')) {
        if (mock.olderFail > 0) { mock.olderFail--; return json({ ok: false, error: 'boom' }, 500); }
        return json({ ok: true, messages: [H('h-b0', 'Tester', 'u1', 'nejstarší u Bulls', -40)], nextBefore: null });
      }
      return json({ ok: true, messages: [H('h-b1', 'Tester', 'u1', 'zpráva u Bulls 1', 1), H('h-b2', 'Tester', 'u1', 'zpráva u Bulls 2', 2), { ...H('h-b3', 'Tester', 'u1', '', 3), deleted: true }], nextBefore: 'c2' });
    }
    if (inCh === 'robdiesalot' && u.includes('before=c1') && mock.older429 > 0) { mock.older429--; return json({ ok: false, error: 'rate_limited' }, 429); }
    // Dvě stránky: první nezaplní panel → klient sám dotáhne starší (before=c1).
    if (inCh === 'robdiesalot') return json(u.includes('before=c1')
      ? { ok: true, messages: [H('h-old', 'Tester', 'u1', 'nejstarší zpráva', -50)], nextBefore: null }
      : { ok: true, messages: [H1[0], H1[2], HREP], nextBefore: 'c1' });
    return json({ ok: true, messages: [], nextBefore: null });
  }
  // GIFy ke schválení (část 4, mod dotáhne čekající po /moderation/me) — tady žádné; nesmí odejít na produkci.
  if (u.includes('/moderation/gif/pending')) return json({ ok: true, requests: [] });
  // Obsah smazaných zpráv pro moda — tady nic (zprávy mají text lokálně); nesmí odejít na produkci.
  if (u.includes('/moderation/deleted-content')) return json({ ok: true, messages: {} });
  if (u.includes('/moderation/user-state')) return json({ ok: true, banned: mock.banned, until: null });
  if (u.includes('/moderation/user')) {
    posts.user.push(body);
    if (mock.userStatus !== 200) return json({ ok: false, error: mock.userError }, mock.userStatus);
    return json({ ok: true, action: body.action, until: null, results: mock.userResults, targets: [], notes: {} });
  }
  if (u.includes('/chat/send')) {
    posts.send.push(body);
    if (mock.sendWarningPending) { mock.warnings = [{ id: 'w3', channel: 'robdiesalot', reason: 'Třetí varování', createdAt: new Date().toISOString() }]; return json({ ok: false, error: 'warning_pending' }, 403); }
    return json({ ok: true, id: 'x' });
  }
  if (u.includes('/chat/history')) return json({ ok: true, messages: u.includes('before=') ? [] : H1, nextBefore: null });
  // 7TV: Tester (u1) má 7TV badge B1 (badge i paint hromadně přes GQL, uživatel přes /v3/users/twitch/<id>).
  if (u.includes('7tv.io/v3/users/twitch/')) { posts.seventv++; return json(u.endsWith('/u1') ? { user: { style: { badge_id: 'B1' } }, emote_set: null } : { user: { style: {} } }); }
  if (u.includes('7tv.io/v3/gql')) return json(String(q.postData || '').includes('badges')
    ? { data: { cosmetics: { badges: [{ id: 'B1', tooltip: '7TV Test', host: { url: '//cdn.7tv.app/badge/B1' } }] } } }
    : { data: { cosmetics: { paints: [] } } });
  return call('Fetch.continueRequest', { requestId: rid }, sid);
};
await call('Fetch.enable', { patterns: [...['/auth/me', '/moderation/', '/chat/history', '/chat/send', '/nicknames/stream', '/account/'].map((p) => ({ urlPattern: `*api.jouki.cz${p}*` })),
  { urlPattern: '*7tv.io/v3/users/twitch/*' }, { urlPattern: '*7tv.io/v3/gql*' }] }, sessionId);
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
check('A položky nabídky (Profil první)', JSON.stringify(items) === JSON.stringify(['Profil', 'Smazat zprávu', 'Timeout', 'Zabanovat…', 'Přejmenovat…', 'Varovat…', 'Permit']), JSON.stringify(items));
check('A fokus na první položce (Profil)', await ev(`document.activeElement?.dataset?.id === 'history'`) === true);
await key('ArrowDown');
check('A šipka dolů → Smazat zprávu', await ev(`document.activeElement?.dataset?.id === 'delete'`) === true);
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
await key('ArrowDown'); await key('ArrowDown'); await key('ArrowRight');
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
await key('ArrowDown'); await key('ArrowDown');
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

// ---- Odkrýt zprávu (smazaná / skrytá → jen v UnityChatu zpátky) ----
const actDisp = (id, act) => ev(`getComputedStyle(document.querySelector('.msg[data-msg-id="${id}"] .msg-action-btn[data-act="${act}"]')).display`);
check('R nesmazaná zpráva: koš vidět, oko ne', await actDisp('e2e-b1', 'delete') === 'flex' && await actDisp('e2e-b1', 'restore') === 'none');
mock.sse.push(['message-deleted', { channel: 'robdiesalot', platform: 'twitch', messageId: 'e2e-b1', by: 'twitch:jinymod', reason: 'mod', at: Date.now() }]);
check('R SSE message-deleted → zpráva smazaná', await until(`document.querySelector('.msg[data-msg-id="e2e-b1"]')?.classList.contains('uc-deleted')`, 6000));
check('R smazaná zpráva: oko místo koše + tooltip', await actDisp('e2e-b1', 'delete') === 'none' && await actDisp('e2e-b1', 'restore') === 'flex'
  && await ev(`document.querySelector('.msg[data-msg-id="e2e-b1"] .msg-action-btn[data-act="restore"]').title`) === 'Odkrýt zprávu (jen v UnityChatu)');
await rightClick('e2e-b1');
const rItems = await menuItems();
check('R nabídka u smazané: Profil, Odkrýt zprávu, bez Smazat', rItems[0] === 'Profil' && rItems[1] === 'Odkrýt zprávu' && !rItems.includes('Smazat zprávu'), JSON.stringify(rItems));
await ev(`document.querySelector('.uc-mod-menu [data-id="restore"]').click()`);
check('R Odkrýt → POST /moderation/restore', await (async () => { for (let i = 0; i < 20 && !posts.restore.length; i++) await sleep(150); const b = posts.restore[0]; return b?.channel === 'robdiesalot' && b.platform === 'twitch' && b.messageId === 'e2e-b1'; })(), JSON.stringify(posts.restore[0]));
check('R zpráva zpět (text, bez smazání) + koš místo oka', await until(`(() => { const el = document.querySelector('.msg[data-msg-id="e2e-b1"]'); return !el.classList.contains('uc-deleted') && el.querySelector('.tx').textContent === 'zpráva jiného'; })()`, 3000)
  && await actDisp('e2e-b1', 'delete') === 'flex' && await actDisp('e2e-b1', 'restore') === 'none', JSON.stringify(await msgState('e2e-b1')));
check('R hláška „odkryta v UnityChatu"', await until(`[...document.querySelectorAll('#chat .sys')].some(s => s.textContent === 'Zpráva od Other odkryta v UnityChatu (na platformě zůstává smazaná).')`, 3000), await lastSys());
// Skrytá zpráva + oko v hover akcích
mock.sse.push(['message-hidden', { channel: 'robdiesalot', platform: 'twitch', messageId: 'e2e-b1', by: 'zidolista:1', at: Date.now() }]);
check('R skrytá zpráva: oko místo koše', await until(`document.querySelector('.msg[data-msg-id="e2e-b1"]')?.classList.contains('uc-deleted')`, 6000) && await actDisp('e2e-b1', 'restore') === 'flex');
await ev(`document.querySelector('.msg[data-msg-id="e2e-b1"] .msg-action-btn[data-act="restore"]').click()`);
check('R oko → POST restore + zpráva zpět', await until(`!document.querySelector('.msg[data-msg-id="e2e-b1"]').classList.contains('uc-deleted')`, 3000) && posts.restore.length === 2 && posts.restore[1].messageId === 'e2e-b1', JSON.stringify(posts.restore));
// Odkrytí jiným modem (SSE message-restored) → zpráva zpět i tady, koš se vrátí.
mock.sse.push(['message-deleted', { channel: 'robdiesalot', platform: 'twitch', messageId: 'e2e-b1', by: 'twitch:jinymod', reason: 'mod', at: Date.now() }]);
await until(`document.querySelector('.msg[data-msg-id="e2e-b1"]')?.classList.contains('uc-deleted')`, 6000);
mock.sse.push(['message-restored', { channel: 'robdiesalot', platform: 'twitch', messageId: 'e2e-b1', by: 'twitch:jinymod', at: Date.now(), message: { ...H1[1], historical: true } }]);
check('R SSE message-restored od jiného moda → zpráva zpět, koš', await until(`!document.querySelector('.msg[data-msg-id="e2e-b1"]').classList.contains('uc-deleted')`, 6000) && await actDisp('e2e-b1', 'delete') === 'flex');

// ---- Profil (mod) ----
check('H 7TV badge Testera i u zprávy v chatu (stejný render badge)', await until(`!!document.querySelector('.msg[data-msg-id="e2e-a1"] .bdg .bdg-7tv')`, 8000), `7tv dotazů=${posts.seventv}`);
await rightClick('e2e-a1');
const nameColor = await ev(`document.querySelector('.msg[data-msg-id="e2e-a1"] .un').style.color`);
await ev(`document.querySelector('.uc-mod-menu [data-id="history"]').click()`);
check('H „Profil" → panel přes chat, nabídka zavřená', await until(`!!document.querySelector('#chat-wrapper > .uc-uh') && !document.querySelector('.uc-mod-menu')`, 3000));
check('H 1 nadpis panelu „Profil" (CSS velkými)', await ev(`document.querySelector('.uc-uh-cap').textContent === 'Profil' && getComputedStyle(document.querySelector('.uc-uh-cap')).textTransform === 'uppercase' && document.querySelector('.uc-uh').getAttribute('aria-label').startsWith('Profil: ')`) === true);
await until(`document.querySelectorAll('.uc-uh-tab').length > 0`, 4000);
check('H summary GET s kanálem a cílem', /summary\?channel=robdiesalot&platform=twitch&userId=u1/.test(posts.hist[0] || ''), posts.hist[0]);
check('H hlavička: jméno v barvě uživatele', await until(`document.querySelector('.uc-uh-name')?.textContent === 'Tester'`, 3000)
  && !!nameColor && (await ev(`document.querySelector('.uc-uh-name').style.color`)) === nameColor, String(nameColor));
const badgesH = await ev(`[...document.querySelectorAll('.uc-uh-badge-group')].map(g => g.dataset.platform + ':' + [...g.querySelectorAll('img.bdg-img')].map(i => i.alt).join('+') + ':' + !!g.querySelector('.uc-uh-pi')).join(',')`);
check('H 2 badge u jména: Twitch vč. 7TV + Kick moderator, skupiny s logem platformy', badgesH === 'twitch:7TV Test:true,kick:Moderator:true', badgesH);
const idsTxt = await ev(`[...document.querySelectorAll('.uc-uh-id')].map(e => e.textContent + ':' + !!e.querySelector('img') + ':' + e.title).join(',')`);
check('H 5 chipy identit = zobrazované jméno, login v title', idsTxt === 'Tester:true:Twitch: tester,Tester K:true:Kick: tester_k', idsTxt);
const donSum = await ev(`(() => { const d = document.querySelector('.uc-uh-donsum'); return d && { amt: d.textContent, title: d.title, inTop: d.parentElement.classList.contains('uc-uh-top'), next: d.nextElementSibling?.className }; })()`);
check('H 8 suma darů vpravo nahoře (jen částka, odhad v tooltipu)', donSum?.amt === '1\u00a0250\u00a0Kč + 20\u00a0€' && donSum.title === 'Celkem darováno 1\u00a0250\u00a0Kč + 20\u00a0€ (z toho 250\u00a0Kč jen podle jména)' && donSum.inTop && donSum.next === 'uc-uh-close'
  && await ev(`parseFloat(getComputedStyle(document.querySelector('.uc-uh-donsum-main')).fontSize) >= parseFloat(getComputedStyle(document.querySelector('.uc-uh-name')).fontSize)`) === true, JSON.stringify(donSum));
const statsTxt = await ev(`document.querySelector('.uc-uh-stats').textContent`);
check('H statistika česky (3 tvary)', /^Poprvé viděn .+ · naposledy .+ · celkem 6 zpráv$/.test(statsTxt || ''), statsTxt);
const modTxt = await ev(`document.querySelector('.uc-uh-mod').textContent`);
check('H moderace: timeout 10 min + důvod + kdo', /Timeout 10 min/.test(modTxt || '') && /spam/.test(modTxt) && /modik \(Twitch\)/.test(modTxt), modTxt);
check('H tlačítko na původní kartu platformy', await ev(`document.querySelector('.uc-uh-card')?.textContent`) === 'Karta na Twitchi');
const tabsTxt = await ev(`[...document.querySelectorAll('.uc-uh-tab')].map(b => b.dataset.channel + ':' + b.querySelector('.uc-uh-tab-count').textContent).join(',')`);
check('H záložky = kanály ze summary s počty, aktuální první', tabsTxt === 'robdiesalot:2,arcadebulls:3,tensterakdary:1', tabsTxt);
check('H výchozí záložka = aktuální kanál, zprávy načtené + dona', await until(`document.querySelectorAll('.uc-uh-list .uc-uh-msg').length === 4 && document.querySelectorAll('.uc-uh-list .uc-uh-don').length === 2`, 4000)
  && posts.hist.some((x) => /inChannel=robdiesalot&limit=50$/.test(x)) && posts.hist.some((x) => /donations\?channel=robdiesalot&platform=twitch&userId=u1/.test(x)), posts.hist.join(' | '));
const rowsOrder = await ev(`[...document.querySelectorAll('.uc-uh-list > .uc-uh-msg, .uc-uh-list > .uc-uh-don')].map(r => r.dataset.id).join(',')`);
const c1 = posts.hist.filter((x) => /before=c1/.test(x)).length;
check('H 429 u starší stránky → jedno opakování za 1 s', c1 === 2, String(c1));
check('H 7 dona zařazená mezi zprávy podle času (staré až po konci historie)', rowsOrder === 'd2,h-old,e2e-a1,d1,e2e-a2,h-rep', rowsOrder);
check('H konec historie nahoře', await ev(`document.querySelector('.uc-uh-list').firstElementChild.classList.contains('uc-uh-edge')`) === true);
const days = await ev(`[...document.querySelectorAll('.uc-uh-list > .uc-uh-day')].map(d => d.textContent + '>' + d.nextElementSibling.dataset.id).join('|')`);
check('H 3 oddělovače dnů („čtvrtek 25. 9. 2026") před prvním řádkem každého dne', /^(pondělí|úterý|středa|čtvrtek|pátek|sobota|neděle) \d{1,2}\. \d{1,2}\. \d{4}>d2\|(pondělí|úterý|středa|čtvrtek|pátek|sobota|neděle) \d{1,2}\. \d{1,2}\. \d{4}>h-old$/.test(days || ''), days);
const row0 = await ev(`(() => { const r = document.querySelector('.uc-uh-msg[data-id="e2e-a1"]'); return { time: r.querySelector('.uc-uh-time').textContent, title: r.querySelector('.uc-uh-time').title, logo: !!r.querySelector('.uc-uh-pi img'), text: r.querySelector('.uc-uh-tx').textContent }; })()`);
check('H 3 řádek: jen čas HH:MM (datum v title), logo, text', /^\d{2}:\d{2}$/.test(row0?.time || '') && /^\d{1,2}\. \d{1,2}\. \d{4} \d{2}:\d{2}$/.test(row0?.title || '') && row0.logo && row0.text === 'první zpráva testera', JSON.stringify(row0));
const donRows = await ev(`[...document.querySelectorAll('.uc-uh-don')].map(r => r.querySelector('.uc-uh-don-icon').textContent + r.querySelector('.uc-uh-don-line').textContent + '|' + (r.querySelector('.uc-uh-don-msg')?.textContent || '-') + '|' + (r.querySelector('.uc-uh-don-guess')?.textContent || '-')).join(' / ')`);
check('H 7 řádek dona: „💸 poslal QR dono 150 Kč" + zpráva; odhad šedě „podle jména"', donRows === '💸poslal QR dono 250\u00a0Kč|-|podle jména / 💸poslal QR dono 150\u00a0Kč|díky za stream|-', donRows);
// 4: citace odpovědi na jeden řádek, klik = celý text
const rep = await ev(`(() => { const w = document.querySelector('.uc-uh-msg[data-id="h-rep"] .uc-uh-reply'); if (!w) return null; return { user: w.querySelector('.rctx-user')?.textContent, ws: getComputedStyle(w).whiteSpace, oneLine: w.getBoundingClientRect().height < 24, clickable: !w.querySelector('.reply-ctx.clickable') }; })()`);
check('H 4 citace odpovědi (render chatu) na jeden řádek', rep?.user === '@OtherDisplay' && rep.ws === 'nowrap' && rep.oneLine && rep.clickable, JSON.stringify(rep));
await ev(`document.querySelector('.uc-uh-msg[data-id="h-rep"] .uc-uh-reply .rctx-body').click()`);
const repOpen = await ev(`(() => { const w = document.querySelector('.uc-uh-msg[data-id="h-rep"] .uc-uh-reply'); return { wrap: w.classList.contains('uc-uh-reply--wrap'), h: w.getBoundingClientRect().height }; })()`);
check('H 4 klik na citaci → celý text (zalomení)', repOpen?.wrap === true && repOpen.h > 24 && !(await ev(`!!document.querySelector('.uc-mod-dialog')`)), JSON.stringify(repOpen));
await ev(`document.querySelector('.uc-uh-msg[data-id="h-rep"] .uc-uh-reply .rctx-body').click()`);
check('H 4 další klik → zpět na jeden řádek', await ev(`!document.querySelector('.uc-uh-msg[data-id="h-rep"] .uc-uh-reply').classList.contains('uc-uh-reply--wrap')`) === true);
// 9: ikony akcí u zprávy + 6: no_actor → přihlášení s moderací
const acts = await ev(`[...document.querySelectorAll('.uc-uh-msg[data-id="e2e-a1"] .uc-uh-act')].map(b => b.dataset.act).join(',')`);
check('H 9 ikony akcí u zprávy: smazat / timeout / ban / permit', acts === 'delete,timeout,ban,permit', acts);
mock.deleteResult = 'error:no_actor';
await ev(`document.querySelector('.uc-uh-msg[data-id="e2e-a1"] .uc-uh-act[data-act="delete"]').click()`);
check('H 9 smazání z Profilu → POST /moderation/delete', await until(`true`, 10) && await (async () => { for (let i = 0; i < 20 && !posts.del.length; i++) await sleep(150); return posts.del[0]?.messageId === 'e2e-a1' && posts.del[0]?.platform === 'twitch' && posts.del[0]?.channel === 'robdiesalot'; })(), JSON.stringify(posts.del[0]));
check('H 9 řádek po smazání = styl smazané zprávy (mod „Zpráva smazána": zašedlé, bez štítku), oko místo koše', await until(`(() => { const r = document.querySelector('.uc-uh-msg[data-id="e2e-a1"]'); return r.classList.contains('uc-deleted') && r.classList.contains('uc-deleted--dimmed') && !r.querySelector('.uc-deleted-tag') && r.classList.contains('uc-deleted--restorable') && !r.querySelector('.uc-uh-act[data-act="delete"]') && r.querySelector('.uc-uh-act')?.dataset.act === 'restore'; })()`, 3000));
const sysDel = await ev(`(() => { const a = [...document.querySelectorAll('#chat .sys')]; const s = a[a.length - 1]; return s ? s.textContent + '|' + (s.querySelector('.sys-action')?.textContent || '-') : null; })()`);
check('H 6 no_actor + chybějící scopes → „Obnovit přihlášení (moderace)" (Twitch)', sysDel === 'Na Twitchi se akce nepovedla — tvůj účet nemá oprávnění moderovat. Obnovit přihlášení (moderace)|Obnovit přihlášení (moderace)', sysDel);
// Oko v Profilu → POST restore → řádek znovu s textem a košem (odpověď nese celou zprávu).
const nRestore = posts.restore.length;
await ev(`document.querySelector('.uc-uh-msg[data-id="e2e-a1"] .uc-uh-act[data-act="restore"]').click()`);
check('H oko v Profilu → POST restore, řádek zpět s textem a košem', await until(`(() => { const r = document.querySelector('.uc-uh-msg[data-id="e2e-a1"]'); return !!r && !r.classList.contains('uc-deleted') && r.querySelector('.uc-uh-tx').textContent === 'první zpráva testera' && r.querySelector('.uc-uh-act')?.dataset.act === 'delete'; })()`, 3000)
  && posts.restore.length === nRestore + 1 && posts.restore.at(-1).messageId === 'e2e-a1', JSON.stringify(posts.restore.at(-1)));
mock.userResults = { twitch: 'error:no_actor' };
const nUser2 = posts.user.length;
await ev(`document.querySelector('.uc-uh-msg[data-id="h-rep"] .uc-uh-act[data-act="timeout"]').click()`);
check('H 9 ikona timeoutu → nabídka rovnou s délkami', await until(`!!document.querySelector('.uc-mod-menu [data-id="timeout:300"]')`, 2000));
await ev(`document.querySelector('.uc-mod-menu [data-id="timeout:300"]').click()`);
check('H 9 timeout z Profilu → POST s userId a délkou', await until(`!document.querySelector('.uc-mod-menu')`, 2000) && await (async () => { for (let i = 0; i < 20 && posts.user.length === nUser2; i++) await sleep(150); const b = posts.user.at(-1); return b?.action === 'timeout' && b.userId === 'u1' && b.durationSec === 300; })(), JSON.stringify(posts.user.at(-1)));
check('H 9 po timeoutu: zprávy uživatele v Profilu smazané + štítek „Timeout (5 min)"', await until(`[...document.querySelectorAll('.uc-uh-msg')].every(r => r.classList.contains('uc-deleted') && r.querySelector('.uc-mod-tag')?.textContent === 'Timeout (5 min)')`, 3000));
check('H 9 po timeoutu: bez koše i bez oka (server zprávy nesmazal)', await ev(`(() => { const r = document.querySelector('.uc-uh-msg[data-id="h-rep"]'); return !r.querySelector('.uc-uh-act[data-act="delete"]') && !r.querySelector('.uc-uh-act[data-act="restore"]') && !r.classList.contains('uc-deleted--restorable'); })()`) === true);
check('H 6 timeout no_actor → nabídka přihlášení i u akce z nabídky', await until(`(() => { const a = [...document.querySelectorAll('#chat .sys')]; return a.some(s => s.textContent.startsWith('Na Twitchi se akce nepovedla') && s !== a[0]) && a.filter(s => s.querySelector('.sys-action')).length >= 2; })()`, 3000));
mock.userResults = { twitch: 'ok', kick: 'bot' }; mock.deleteResult = 'ok';
await ev(`document.querySelector('.uc-uh-tab[data-channel="arcadebulls"]').click()`);
check('H 3/9 cizí záložka: bez ikon akcí moda', await until(`document.querySelectorAll('.uc-uh-list .uc-uh-msg').length === 3`, 3000) && await ev(`document.querySelectorAll('.uc-uh-act').length === 0`) === true);
check('H přepnutí záložky načte zprávy kanálu (bez donů — patří jen aktuálnímu kanálu)', await until(`document.querySelectorAll('.uc-uh-list .uc-uh-msg').length === 3 && document.querySelector('.uc-uh-list .uc-uh-msg .uc-uh-tx').textContent === 'zpráva u Bulls 1'`, 3000) && /inChannel=arcadebulls/.test(posts.hist.at(-1) || '') && await ev(`!document.querySelector('.uc-uh-don')`) === true, posts.hist.at(-1));
check('H chyba starší stránky → hláška nahoře + Zkusit znovu', await until(`document.querySelector('.uc-uh-list').firstElementChild?.classList.contains('uc-uh-older-fail') && !!document.querySelector('.uc-uh-older-fail .uc-uh-retry')`, 3000)
  && (await ev(`document.querySelector('.uc-uh-older-fail span').textContent`)) === 'Starší zprávy se nepodařilo načíst', await ev(`document.querySelector('.uc-uh-older-fail')?.textContent`));
await sleep(1800);
const c2 = posts.hist.filter((x) => /before=c2/.test(x)).length;
check('H po chybě žádná smyčka požadavků', c2 === 1, String(c2));
await ev(`document.querySelector('.uc-uh-retry').click()`);
check('H Zkusit znovu → starší zprávy nahoře, hláška pryč', await until(`document.querySelectorAll('.uc-uh-list .uc-uh-msg').length === 4 && document.querySelector('.uc-uh-list .uc-uh-msg').dataset.id === 'h-b0' && !document.querySelector('.uc-uh-older-fail')`, 3000),
  await ev(`[...document.querySelectorAll('.uc-uh-list .uc-uh-msg')].map(r => r.dataset.id).join(',')`));
check('H aktivní záložka přepnutá', await ev(`document.querySelector('.uc-uh-tab--on')?.dataset.channel`) === 'arcadebulls');
check('H smazaná zpráva bez obsahu (zašedlé „Zpráva smazána", bez štítku)', await ev(`document.querySelector('.uc-uh-msg[data-id="h-b3"] .uc-uh-tx').textContent === 'Zpráva smazána' && !document.querySelector('.uc-uh-msg[data-id="h-b3"] .uc-deleted-tag') && document.querySelector('.uc-uh-msg[data-id="h-b3"]').classList.contains('uc-deleted--dimmed')`) === true);
await ev(`document.querySelector('.uc-uh-tab[data-channel="tensterakdary"]').click()`);
check('H prázdná záložka → „V tomto kanálu nic nenapsal."', await until(`document.querySelector('.uc-uh-status')?.textContent === 'V tomto kanálu nic nenapsal.'`, 3000));
// 4: klik na jméno autora citace → potvrzení → Profil autora (jen podle loginu)
await ev(`document.querySelector('.uc-uh-tab[data-channel="robdiesalot"]').click()`);
await until(`!!document.querySelector('.uc-uh-msg[data-id="h-rep"] .rctx-user')`, 4000);
await ev(`document.querySelector('.uc-uh-msg[data-id="h-rep"] .rctx-user').click()`);
check('H 4 klik na jméno v citaci → „Otevřít profil uživatele other?" (login z reply-parent-user-login)', await until(`document.querySelector('.uc-mod-dialog h2')?.textContent === 'Otevřít profil uživatele other?'`, 2000));
const nHist = posts.hist.length;
await ev(`document.querySelector('.uc-mod-dialog button[type=submit]').click()`);
check('H 4 Ano → Profil autora citace (dotaz jen podle loginu)', await until(`document.querySelector('.uc-uh-name')?.textContent === 'Other'`, 3000)
  && await (async () => { for (let i = 0; i < 30 && !posts.hist.slice(nHist).length; i++) await sleep(100); return true; })() && posts.hist.slice(nHist).some((x) => /summary\?channel=robdiesalot&platform=twitch&login=other$/.test(x)), posts.hist.slice(nHist).join(" | ") + " name=" + await ev(`document.querySelector(".uc-uh-name")?.textContent`));
check('H 4 další dotazy už s userId ze summary', await until(`true`, 10) && await (async () => { for (let i = 0; i < 20; i++) { if (posts.hist.slice(nHist).some((x) => /messages\?.*userId=u2/.test(x))) return true; await sleep(150); } return false; })(), posts.hist.slice(nHist).join(' | '));
// Tlačítko ‹ zpět: je jen po přepnutí z citace, vrátí na předchozí profil a pak zmizí.
check('H ‹ zpět se ukáže po přepnutí na profil autora citace', await until(`!!document.querySelector('.uc-uh-back')`, 2000), await ev(`document.querySelector('.uc-uh-back')?.title`));
await ev(`document.querySelector('.uc-uh-back').click()`);
check('H ‹ zpět vrátí předchozí profil a tlačítko zmizí', await until(`document.querySelector('.uc-uh-name')?.textContent !== 'Other' && !document.querySelector('.uc-uh-back')`, 3000), await ev(`document.querySelector('.uc-uh-name')?.textContent`));
await ev(`(() => { const i = document.getElementById('msg-input'); i.disabled = false; i.focus(); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return true; })()`);
await sleep(300);
check('H Esc mimo panel (pole pro psaní) panel nezavře', await ev(`!!document.querySelector('.uc-uh')`) === true);
await ev(`document.querySelector('.uc-uh').focus()`);
await key('Escape');
check('H Esc zavře panel', await until(`!document.querySelector('.uc-uh')`, 2000));
// Fokus se po zavření vrací tam, kde byl před otevřením.
const focusBack = await ev(`(() => { const i = document.getElementById('msg-input'); i.focus(); const p = new window.UC_CORE.UserHistoryPanel({ doc: document, api: () => new Promise(() => {}), container: document.getElementById('chat-wrapper') }); p.open({ channel: 'robdiesalot', platform: 'twitch', userId: 'u1', login: 'tester' }); const inPanel = document.activeElement === p.el; p.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return { inPanel, closed: !p.isOpen, back: document.activeElement === i }; })()`);
check('H fokus do panelu a po zavření zpět na původní prvek', focusBack?.inPanel && focusBack.closed && focusBack.back, JSON.stringify(focusBack));
// 10: levý klik na jméno otevře Profil (mod i divák); pravý klik u moda dál nabídka (fáze A výše).
await ev(`document.querySelector('.msg[data-msg-id="e2e-a1"] .un').click()`);
check('H 10 levý klik na jméno (mod) → Profil', await until(`document.querySelector('.uc-uh .uc-uh-name')?.textContent === 'Tester' && !document.querySelector('.uc-mod-menu')`, 3000));
await ev(`document.querySelector('.uc-uh-close').click()`);

// ---- SSE user-moderated ----
const at = Date.now();
mock.sse.push(['user-moderated', { channel: 'robdiesalot', platform: 'twitch', userId: 'u1', login: 'tester', action: 'timeout', until: at + 300000, by: 'twitch:jinymod', at }]);
check('A SSE user-moderated → předchozí zprávy uživatele smazané', await until(`document.querySelector('.msg[data-msg-id="e2e-a2"]')?.classList.contains('uc-deleted')`, 6000));
const a1 = await msgState('e2e-a1'), a2 = await msgState('e2e-a2'), b1 = await msgState('e2e-b1');
check('A obě zprávy Testera: mod vidí ztlumené + štítek „Timeout (5 min)"', a1?.cls.includes('uc-deleted--dimmed') && a1.modTag === 'Timeout (5 min)' && a2?.modTag === 'Timeout (5 min)', JSON.stringify([a1, a2]));
check('A po timeoutu: oko ne (server zprávu nesmazal), koš zůstává; v nabídce Smazat', !a2.cls.includes('uc-deleted--restorable') && await actDisp('e2e-a2', 'restore') === 'none' && await actDisp('e2e-a2', 'delete') === 'flex'
  && await (async () => { await rightClick('e2e-a2'); const it = await menuItems(); await key('Escape'); return it.includes('Smazat zprávu') && !it.includes('Odkrýt zprávu'); })(), JSON.stringify(a2));
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
// Veřejný Profil: levý klik na jméno i pro diváka, jen hlavička (bez logu, záložek, identit a moderace).
const nHistB = posts.hist.length;
await ev(`document.querySelector('.msg[data-msg-id="e2e-a1"] .un').click()`);
check('B 10 divák: levý klik na jméno → Profil', await until(`document.querySelector('.uc-uh.uc-uh--public .uc-uh-name')?.textContent === 'Tester'`, 4000));
const pub = await ev(`(() => { const q = (s) => document.querySelector(s); return { stats: q('.uc-uh-stats').textContent, don: q('.uc-uh-donsum-main')?.textContent, sub: !!q('.uc-uh-donsum-sub'), list: q('.uc-uh-list').hidden, tabs: q('.uc-uh-tabs').hidden, ids: q('.uc-uh-ids').children.length, mod: q('.uc-uh-mod').hidden, card: q('.uc-uh-card')?.textContent, b7: !!q('.uc-uh-badges .bdg-7tv') }; })()`);
check('B divák: jen hlavička — statistika kanálu, suma jen ucNamed, karta platformy', pub?.stats.startsWith('V tomto kanálu: poprvé viděn ') && /celkem 2 zprávy$/.test(pub.stats) && pub.don === '1 000 Kč' && !pub.sub
  && pub.list && pub.tabs && pub.ids === 0 && pub.mod && pub.card === 'Karta na Twitchi' && pub.b7, JSON.stringify(pub));
await sleep(600);
check('B divák: žádný dotaz na zprávy ani dona', posts.hist.slice(nHistB).every((x) => /\/summary\?/.test(x)) && posts.hist.slice(nHistB).length === 1, posts.hist.slice(nHistB).join(' | '));
await ev(`document.querySelector('.uc-uh-close').click()`);

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
