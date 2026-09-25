// E2E (headless Chrome + CDP): moderace v addonu — tlačítko „Smazat zprávu", /moderation/me,
// POST /moderation/delete, vzhled smazané/skryté zprávy, SSE message-deleted/-hidden/-unhidden,
// nastavení „Smazané zprávy", odmítnuté smazání (403) → vrácení.
//
// Backend je mockovaný přes Fetch.requestPaused (api.jouki.cz: /auth/me, /moderation/*, /chat/history,
// /nicknames/stream). SSE = odpověď text/event-stream s frontou událostí; EventSource se po konci
// odpovědi sám znovu připojí (retry 300 ms) a dostane další dávku.
//
// Spuštění: node scripts/e2e-moderation.mjs   (Chrome v C:/Program Files/Google/Chrome/…, nebo CHROME=…)
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-e2e-mod-'));
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
const H = (id, text, extra = {}) => ({ platform: 'twitch', id, username: 'Tester', message: text, color: '#1e90ff', timestamp: now - 60000 + Number(id.slice(-1)) * 1000, historical: true, ...extra });
const mock = {
  mod: true,
  deleteStatus: 200,
  deleteResult: 'bot',
  deleteDelayMs: 0,
  history: () => [H('e2e-m1', 'první zpráva'), H('e2e-m2', '', { deleted: true }), H('e2e-m3', 'třetí zpráva')],
  sse: [],   // fronta událostí pro /nicknames/stream
  // GET /moderation/deleted-content — obsah smazané zprávy jen pro moda (Kappa = Twitch emote 25).
  // Smazaná zpráva byla odpověď → po dotažení se doplní i citace ↩ (review 2026-09-25).
  deletedContent: { 'twitch:e2e-m2': H('e2e-m2', 'tst Kappa', { twitchEmotes: '25:4-8', deleted: true, deletedReason: 'mod', replyTo: { username: 'Jiny', message: 'původní otázka', id: 'e2e-x0' } }) },
};
const posts = [];
const contentCalls = [];
s.onevent = async (d) => {
  if (d.method !== 'Fetch.requestPaused') return;
  const q = d.params.request;
  const rid = d.params.requestId;
  const json = (o, code = 200) => call('Fetch.fulfillRequest', { requestId: rid, responseCode: code, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: Buffer.from(JSON.stringify(o)).toString('base64') }, d.sessionId);
  const u = q.url;
  if (u.includes('/nicknames/stream')) {
    const events = mock.sse.splice(0);
    const body = 'retry: 300\n\n' + events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join('');
    return call('Fetch.fulfillRequest', { requestId: rid, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/event-stream' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: Buffer.from(body).toString('base64') }, d.sessionId);
  }
  if (u.includes('/auth/me')) return json({ ok: true, accountId: 7, platforms: { twitch: { login: 'moduser', displayName: 'ModUser' }, kick: null, youtube: null } });
  // Účtu moda chybí Twitch mod scopes (starý token jen s user:write:chat) → po smazání botem nabídka přihlášení.
  if (u.includes('/moderation/me')) return json(mock.mod ? { ok: true, mod: true, platforms: ['twitch'], missingScopes: { twitch: ['moderator:manage:chat_messages'] } } : { ok: true, mod: false, platforms: [], missingScopes: {} });
  // GIFy ke schválení (část 4) — tady žádné; nesmí odejít na produkci.
  if (u.includes('/moderation/gif/pending')) return json({ ok: true, requests: [] });
  if (u.includes('/moderation/deleted-content')) {
    contentCalls.push(u);
    if (!mock.mod) return json({ ok: false, error: 'not_mod' }, 403);
    const ids = (new URL(u).searchParams.get('ids') || '').split(',');
    return json({ ok: true, messages: Object.fromEntries(ids.filter((k) => mock.deletedContent[k]).map((k) => [k, mock.deletedContent[k]])) });
  }
  if (u.includes('/moderation/delete')) {
    posts.push(q.postData ? JSON.parse(q.postData) : null);
    if (mock.deleteDelayMs) await sleep(mock.deleteDelayMs);
    return mock.deleteStatus === 200 ? json({ ok: true, result: mock.deleteResult }) : json({ ok: false, error: 'not_mod' }, mock.deleteStatus);
  }
  if (u.includes('/chat/history')) return json({ ok: true, messages: u.includes('before=') ? [] : mock.history(), nextBefore: null });
  return call('Fetch.continueRequest', { requestId: rid }, d.sessionId);
};
await call('Fetch.enable', { patterns: ['/auth/me', '/moderation/', '/chat/history', '/nicknames/stream'].map((p) => ({ urlPattern: `*api.jouki.cz${p}*` })) }, sessionId);
await call('Runtime.enable', {}, sessionId);
const ev = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId); if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 300) }; return r.result?.result?.value; };
const until = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr) === true) return true; await sleep(150); } return false; };
const msgState = (id) => ev(`(() => { const el = document.querySelector('.msg[data-msg-id="${id}"]'); if (!el) return null; return { cls: [...el.classList].filter(c => c.startsWith('uc-deleted')).sort().join(' '), text: el.querySelector('.tx')?.textContent || '', label: !!el.querySelector('.uc-deleted-label'), tag: el.querySelector('.uc-deleted-tag')?.textContent || '', display: getComputedStyle(el).display }; })()`);
const lastSys = () => ev(`(() => { const a = [...document.querySelectorAll('#chat .sys')]; const l = a[a.length - 1]; return l ? { text: l.textContent, action: l.querySelector('.sys-action')?.textContent || null } : null; })()`);

const boot = async () => {
  await call('Page.navigate', { url: `chrome-extension://${extId}/sidepanel.html` }, sessionId);
  await until(`!!document.querySelector('.msg[data-msg-id="e2e-m1"]')`, 10000);
};

// ---- fáze A: mod ----
await call('Page.navigate', { url: `chrome-extension://${extId}/sidepanel.html` }, sessionId);
await sleep(1500);
await ev(`chrome.storage.local.set({ uc_session: 'tok' })`);
await boot();
check('A historie vykreslena', !!(await msgState('e2e-m1')));
check('A body.uc-can-moderate z /moderation/me', await until(`document.body.classList.contains('uc-can-moderate')`));
const order = await ev(`[...document.querySelector('.msg[data-msg-id="e2e-m1"] .msg-actions').children].map(b => b.dataset.act || b.title).join('|')`);
check('A koš je hned vlevo od 💩', /^delete\|poop\|/.test(order || ''), order);
check('A koš má title „Smazat zprávu" a je vidět', await ev(`(() => { const b = document.querySelector('.msg[data-msg-id="e2e-m1"] [data-act=delete]'); return b.title === 'Smazat zprávu' && getComputedStyle(b).display !== 'none'; })()`) === true);
const setStyle = (v) => ev(`(() => { const s = document.getElementById('input-deleted-style'); s.value = '${v}'; s.dispatchEvent(new Event('change')); return true; })()`);
// Mod, výchozí styl „Zpráva smazána": smazaná zpráva z historie (bez obsahu) → label + štítek + ztlumení.
const waitNode = async (fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(150); } return false; };
check('A mod: obsah smazané zprávy z historie dotažen přes /moderation/deleted-content', await waitNode(() => contentCalls.length > 0), contentCalls.join(' | '));
check('A mod: dotaz s kanálem a id smazané zprávy (jeden dotaz)', contentCalls.length === 1 && /channel=robdiesalot/.test(contentCalls[0]) && new URL(contentCalls[0]).searchParams.get('ids') === 'twitch:e2e-m2', contentCalls.join(' | '));
await sleep(400);
const m2mod = await msgState('e2e-m2');
check('A mod: po dotažení obsahu i citace odpovědi (↩ @Jiny)', await ev(`document.querySelector('.msg[data-msg-id="e2e-m2"] > .reply-ctx .rctx-user')?.textContent`) === '@Jiny', await ev(`document.querySelector('.msg[data-msg-id="e2e-m2"]')?.outerHTML?.slice(0, 300)`));
check('A mod + label: „Zpráva smazána" + štítek Smazáno + ztlumeno', m2mod?.cls === 'uc-deleted uc-deleted--dimmed uc-deleted--label' && m2mod.text.startsWith('Zpráva smazána') && m2mod.tag === 'Smazáno' && m2mod.label, JSON.stringify(m2mod));
// Mod přepne na Přeškrtnuté → dotažený text přeškrtnutý (i přes emote), ztlumený, se štítkem.
await setStyle('strike');
const m2s = await msgState('e2e-m2');
check('A mod + strike: dotažený text přeškrtnutý + ztlumený + štítek', m2s?.cls === 'uc-deleted uc-deleted--dimmed uc-deleted--strike' && m2s.text.includes('tst') && !m2s.label && m2s.tag === 'Smazáno', JSON.stringify(m2s));
const strikeEmote = await ev(`(() => { const w = document.querySelector('.msg[data-msg-id="e2e-m2"] .tx .emote-stack, .msg[data-msg-id="e2e-m2"] .tx .uc-strike-emote'); if (!w) return null; const a = getComputedStyle(w, '::after'); return { img: !!w.querySelector('img.emote'), after: a.content, h: a.height, pos: a.position, dec: getComputedStyle(document.querySelector('.msg[data-msg-id="e2e-m2"] .tx')).textDecorationLine, op: getComputedStyle(document.querySelector('.msg[data-msg-id="e2e-m2"] .tx')).opacity }; })()`);
check('A mod + strike: čára i přes emote (::after přes obal emotu) + text line-through', strikeEmote?.img && strikeEmote.after !== 'none' && strikeEmote.h === '2px' && strikeEmote.pos === 'absolute' && strikeEmote.dec.includes('line-through'), JSON.stringify(strikeEmote));
check('A mod: ztlumení (.tx opacity 0.5)', strikeEmote?.op === '0.5', JSON.stringify(strikeEmote));
await ev(`document.querySelector('.msg[data-msg-id="e2e-m1"] [data-act=delete]').click()`);
await until(`document.querySelector('.msg[data-msg-id="e2e-m1"]').classList.contains('uc-deleted--strike')`, 3000);
const m1mod = await msgState('e2e-m1');
check('A po kliknutí (strike): text zůstává přeškrtnutý, ztlumený, štítek Smazáno', m1mod?.cls === 'uc-deleted uc-deleted--dimmed uc-deleted--strike' && m1mod.text.includes('první zpráva') && m1mod.tag === 'Smazáno', JSON.stringify(m1mod));
await setStyle('label');
const m1l = await msgState('e2e-m1');
check('A mod přepne na „Zpráva smazána": label + štítek + ztlumeno', m1l?.cls === 'uc-deleted uc-deleted--dimmed uc-deleted--label' && m1l.label && m1l.tag === 'Smazáno', JSON.stringify(m1l));
mock.sse.push(['message-hidden', { channel: 'robdiesalot', platform: 'twitch', messageId: 'e2e-m3', by: 'twitch:moduser', at: new Date().toISOString() }]);
check('A mod: skrytá zpráva zůstane vidět', await until(`document.querySelector('.msg[data-msg-id="e2e-m3"]')?.classList.contains('uc-deleted--label')`, 6000));
const m3mod = await msgState('e2e-m3');
check('A mod: skrytá = „Zpráva skryta" + štítek „Skryto v UnityChatu" + ztlumeno', m3mod?.cls === 'uc-deleted uc-deleted--dimmed uc-deleted--label' && m3mod.text.startsWith('Zpráva skryta') && m3mod.tag === 'Skryto v UnityChatu' && m3mod.display !== 'none', JSON.stringify(m3mod));
await until(`[...document.querySelectorAll('#chat .sys')].some(s => s.textContent.includes('provedl bot'))`, 4000);
check('A POST /moderation/delete s kanálem, platformou a id', posts.length === 1 && posts[0]?.platform === 'twitch' && posts[0]?.messageId === 'e2e-m1' && posts[0]?.channel === 'robdiesalot', JSON.stringify(posts));
const sysBot = await lastSys();
check('A výsledek „bot" + chybějící scopes → hláška + „Obnovit přihlášení (moderace)" (Twitch, stejné jako akce z nabídky)', sysBot?.text.startsWith('Na Twitchi akci provedl bot — tvůj účet nemá oprávnění moderovat.') && sysBot.action === 'Obnovit přihlášení (moderace)', JSON.stringify(sysBot));

// ---- fáze B: divák (ne mod) ----
mock.mod = false;
const callsBeforeViewer = contentCalls.length;
await boot();
check('B body.uc-can-moderate pryč', await until(`!document.body.classList.contains('uc-can-moderate')`));
check('B koš u diváka schovaný', await ev(`getComputedStyle(document.querySelector('.msg[data-msg-id="e2e-m1"] [data-act=delete]')).display === 'none'`) === true);
const m2v = await msgState('e2e-m2');
check('B smazaná zpráva z historie u diváka = label „Zpráva smazána" (bez štítku a ztlumení)', m2v?.cls === 'uc-deleted uc-deleted--label' && m2v.text === 'Zpráva smazána' && !m2v.tag, JSON.stringify(m2v));
await setStyle('strike');
await sleep(800);
const m2vs = await msgState('e2e-m2');
check('B divák se strike: smazaná zpráva bez obsahu zůstává „Zpráva smazána"', m2vs?.cls === 'uc-deleted uc-deleted--strike' && m2vs.text === 'Zpráva smazána', JSON.stringify(m2vs));
check('B divák obsah smazané zprávy nedotahuje', contentCalls.length === callsBeforeViewer, `${callsBeforeViewer} → ${contentCalls.length}`);
await setStyle('label');
mock.sse.push(['message-deleted', { channel: 'robdiesalot', platform: 'twitch', messageId: 'e2e-m1', by: 'twitch:moduser', reason: 'mod', at: new Date().toISOString() }]);
check('B SSE message-deleted → label, text pryč', await until(`document.querySelector('.msg[data-msg-id="e2e-m1"]').classList.contains('uc-deleted--label')`));
const m1v = await msgState('e2e-m1');
check('B text smazané zprávy nahrazen', m1v?.text === 'Zpráva smazána', JSON.stringify(m1v));
const btnVis = (id, act) => ev(`getComputedStyle(document.querySelector('.msg[data-msg-id="${id}"] [data-act=${act}]')).display !== 'none'`);
check('B label: Kopírovat a Odpovědět u smazané zprávy schované', (await btnVis('e2e-m1', 'copy')) === false && (await btnVis('e2e-m1', 'reply')) === false);
await ev(`(() => { window.__copied = null; try { navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); }; } catch {} document.querySelector('.msg[data-msg-id="e2e-m1"] [data-act=copy]').click(); document.querySelector('.msg[data-msg-id="e2e-m1"] [data-act=reply]').click(); return true; })()`);
const leak = await ev(`JSON.stringify({ copied: window.__copied, reply: (() => { const r = document.getElementById('reply-indicator'); return !!r && !r.classList.contains('hidden'); })() })`);
check('B label: klik na Kopírovat/Odpovědět text nevydá (nic ve schránce, odpověď nezačne)', leak === JSON.stringify({ copied: null, reply: false }), leak);
await ev(`(() => { const s = document.getElementById('input-deleted-style'); s.value = 'strike'; s.dispatchEvent(new Event('change')); })()`);
const m1s = await msgState('e2e-m1');
check('B nastavení Přeškrtnuté → strike + text zpátky z dat', m1s?.cls.includes('uc-deleted--strike') && m1s.text.includes('první zpráva'), JSON.stringify(m1s));
check('B strike (volba diváka): Kopírovat a Odpovědět jsou vidět', (await btnVis('e2e-m1', 'copy')) === true && (await btnVis('e2e-m1', 'reply')) === true);
await ev(`(() => { const s = document.getElementById('input-deleted-style'); s.value = 'label'; s.dispatchEvent(new Event('change')); })()`);
mock.sse.push(['message-hidden', { channel: 'robdiesalot', platform: 'twitch', messageId: 'e2e-m3', by: 'twitch:moduser', at: new Date().toISOString() }]);
check('B SSE message-hidden → divák zprávu nevidí', await until(`getComputedStyle(document.querySelector('.msg[data-msg-id="e2e-m3"]')).display === 'none'`));
mock.sse.push(['message-unhidden', { channel: 'robdiesalot', platform: 'twitch', messageId: 'e2e-m3', by: 'twitch:moduser', at: new Date().toISOString(), message: H('e2e-m3', 'třetí zpráva') }]);
check('B SSE message-unhidden → zpráva zpět', await until(`getComputedStyle(document.querySelector('.msg[data-msg-id="e2e-m3"]')).display !== 'none'`));
const m3 = await msgState('e2e-m3');
check('B odkrytá zpráva bez uc-deleted a s textem', m3?.cls === '' && m3.text.includes('třetí zpráva'), JSON.stringify(m3));
mock.sse.push(['message-deleted', { platform: 'twitch', messageId: 'e2e-m3', by: 'x', reason: 'mod', at: new Date().toISOString() }]);
mock.sse.push(['message-deleted', { channel: 'jiny_kanal', platform: 'twitch', messageId: 'e2e-m3', by: 'x', reason: 'mod', at: new Date().toISOString() }]);
await sleep(1500);
check('B událost z cizího kanálu / bez kanálu ignorována', (await msgState('e2e-m3'))?.cls === '');

// ---- fáze C: backend odmítne (403) → vrácení ----
mock.mod = true; mock.deleteStatus = 403;
await boot();
await until(`document.body.classList.contains('uc-can-moderate')`);
await ev(`document.querySelector('.msg[data-msg-id="e2e-m3"] [data-act=delete]').click()`);
await until(`[...document.querySelectorAll('#chat .sys')].some(s => s.textContent.includes('Mazat můžou jen modi'))`, 4000);
const m3r = await msgState('e2e-m3');
check('C 403 → optimistické smazání vráceno', m3r?.cls === '' && m3r.text.includes('třetí zpráva'), JSON.stringify(m3r));
check('C 403 → hláška „Mazat můžou jen modi."', await ev(`[...document.querySelectorAll('#chat .sys')].some(s => s.textContent === 'Mazat můžou jen modi.')`) === true);

// ---- fáze D: server potvrdí smazání (SSE) během čekání na POST, POST pak selže → smazání zůstane ----
mock.deleteStatus = 403; mock.deleteDelayMs = 2000;
await boot();
await until(`document.body.classList.contains('uc-can-moderate')`);
await ev(`document.querySelector('.msg[data-msg-id="e2e-m3"] [data-act=delete]').click()`);
mock.sse.push(['message-deleted', { channel: 'robdiesalot', platform: 'twitch', messageId: 'e2e-m3', by: 'twitch:jinymod', reason: 'mod', at: new Date().toISOString() }]);
await until(`[...document.querySelectorAll('#chat .sys')].some(s => s.textContent.includes('Mazat můžou jen modi'))`, 6000);
const m3d = await msgState('e2e-m3');
check('D serverové smazání přežije odmítnutý POST', !!m3d?.cls.includes('uc-deleted'), JSON.stringify(m3d));

console.log(`\n${pass} PASS, ${fail} FAIL`);
finish(fail ? 1 : 0);
