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
const prefPuts = [];
const badgePuts = [];
const contentCalls = [];
s.onevent = async (d) => {
  if (d.method !== 'Fetch.requestPaused') return;
  const q = d.params.request;
  const rid = d.params.requestId;
  const json = (o, code = 200) => call('Fetch.fulfillRequest', { requestId: rid, responseCode: code, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: Buffer.from(JSON.stringify(o)).toString('base64') }, d.sessionId);
  const u = q.url;
  const svg = () => call('Fetch.fulfillRequest', { requestId: rid, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'image/svg+xml' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"><rect width="18" height="18" fill="#6a6"/></svg>').toString('base64') }, d.sessionId);
  if (u.startsWith('https://x/')) return svg();   // testovací odznaky Twitche (mod.png, glitch.png) — s rozměrem, ať jde měřit posun
  if (u.includes('/nicknames/stream')) {
    const events = mock.sse.splice(0);
    const body = 'retry: 300\n\n' + events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join('');
    return call('Fetch.fulfillRequest', { requestId: rid, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/event-stream' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: Buffer.from(body).toString('base64') }, d.sessionId);
  }
  if (u.includes('/auth/me')) return json({ ok: true, accountId: 7, platforms: { twitch: { login: 'moduser', displayName: 'ModUser' }, kick: null, youtube: null }, badgeReplaceGlobal: mock.badgeReplace === true });
  if (u.includes('/account/badge-prefs')) { const b = q.postData ? JSON.parse(q.postData) : {}; badgePuts.push(b); mock.badgeReplace = b.replaceGlobal === true; return json({ ok: true, replaceGlobal: mock.badgeReplace }); }
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
  // Nastavení kanálu (odznak dárce, routes/channelPrefs.ts).
  if (u.includes('/channel/prefs')) return json({ ok: true, channel: 'robdiesalot', prefs: mock.prefs || {} });
  if (u.includes('/moderation/channel-prefs')) { const b = q.postData ? JSON.parse(q.postData) : {}; prefPuts.push(b); mock.prefs = { ...(mock.prefs || {}), ...(b?.prefs || {}) }; return json({ ok: true, channel: 'robdiesalot', prefs: mock.prefs }); }
  if (u.includes('/moderation/delete')) {
    posts.push(q.postData ? JSON.parse(q.postData) : null);
    if (mock.deleteDelayMs) await sleep(mock.deleteDelayMs);
    return mock.deleteStatus === 200 ? json({ ok: true, result: mock.deleteResult }) : json({ ok: false, error: 'not_mod' }, mock.deleteStatus);
  }
  if (u.includes('/chat/history')) return json({ ok: true, messages: u.includes('before=') ? [] : mock.history(), nextBefore: null });
  return call('Fetch.continueRequest', { requestId: rid }, d.sessionId);
};
await call('Fetch.enable', { patterns: [...['/auth/me', '/moderation/', '/chat/history', '/nicknames/stream', '/channel/prefs', '/account/badge-prefs'].map((p) => ({ urlPattern: `*api.jouki.cz${p}*` })), { urlPattern: 'https://x/*' }] }, sessionId);
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
check('A 💩 první, koš hned za ním (oko pro smazanou zprávu před košem, skryté) — pokyn usera 2026-09-30', /^poop\|restore\|delete\|/.test(order || ''), order);
// Nastavení: sekce Účet / Rozhraní, výběr odznaku dárce jen pro moda (core/donor-badge.js), PUT + překreslení.
const secT = await ev(`(async () => { document.getElementById('btn-settings').click();
  const st = document.getElementById('settings'); const openAnim = st.getAnimations().length; await new Promise((r) => setTimeout(r, 400));
  const tabs = [...document.querySelectorAll('#settings .settings-tab')].map((t) => t.textContent.trim());
  const vis = () => [...document.querySelectorAll('#settings .settings-pane:not(.uc-morph-ghost)')].filter((p) => !p.hidden).map((p) => p.dataset.pane);
  const a = vis(); document.querySelector('#settings .settings-tab[data-tab="ui"]').click(); const tabAnim = st.getAnimations().length;
  const paneAnim = st.querySelector('.settings-pane[data-pane="ui"]').getAnimations().length; const ghost = st.querySelector('.uc-morph-ghost'); const ghostOk = !!ghost && ghost.hasAttribute('aria-hidden') && !ghost.querySelector('[id]');
  await new Promise((r) => setTimeout(r, 50)); const b = vis(); await new Promise((r) => setTimeout(r, 450)); const ghostGone = !st.querySelector('.uc-morph-ghost');
  const ind = !!document.querySelector('#settings .settings-tabs .uc-slide-ind'); const saved = localStorage.getItem('uc_settings_tab');
  document.querySelector('#settings .settings-tab[data-tab="account"]').click();
  const foot = !!document.querySelector('#settings .settings-foot .settings-links a[href*="privacy"]') && !!document.querySelector('#settings .settings-foot .kofi-link');
  return { tabs, a, b, ind, saved, foot, openAnim, tabAnim, paneAnim, ghostOk, ghostGone }; })()`);
// Přepnutí záložky: výšku vede animace příchozí záložky (switchPanes), panel ji jen následuje — morphResize nemá co přejíždět.
check('nastavení: otevření mění výšku panelu plynule (core morphResize), přepnutí záložky animuje výšku obsahu', secT && secT.openAnim > 0 && (secT.tabAnim > 0 || secT.paneAnim > 0), JSON.stringify({ o: secT?.openAnim, t: secT?.tabAnim, p: secT?.paneAnim }));
check('nastavení: obsah záložky přijede (animace nové) a starý odjede jako kopie bez id, po doběhnutí pryč (core switchPanes)', secT && secT.paneAnim > 0 && secT.ghostOk === true && secT.ghostGone === true, JSON.stringify({ p: secT?.paneAnim, g: secT?.ghostOk, gone: secT?.ghostGone }));
check('nastavení: záložky Účet | Rozhraní přepínají panely (posuvné zvýraznění, volba uložená), patička s odkazy', secT && secT.tabs.join(',') === 'Účet,Rozhraní' && secT.a.join() === 'account' && secT.b.join() === 'ui' && secT.ind && secT.saved === 'ui' && secT.foot, JSON.stringify(secT));
// Instance UnityChat není globální → zachytit přes prototyp při dalším logu (stejně jako e2e-mention-notify.mjs).
await ev(`(() => { const o = UnityChat.prototype._ucLog; UnityChat.prototype._ucLog = function (...a) { window.__uc = this; return o.apply(this, a); }; return true; })()`);
await ev(`document.getElementById('input-deleted-style')?.dispatchEvent(new Event('change'))`);
check('instance zachycena', await until(`!!window.__uc`, 8000));
// Volby odznaku kanálu jen modovi v Dev mode (pokyn usera 2026-09-30): bez Dev mode schované i modovi; Dev mode řádek jen modovi.
const devRow = await ev(`(() => { const r = document.getElementById('row-donor-badge'); const dm = document.querySelector('.dev-mode-row'); return { hiddenNoDev: getComputedStyle(r).display === 'none', devRowShown: getComputedStyle(dm).display !== 'none' }; })()`);
check('mod bez Dev mode: volby odznaku kanálu schované, přepínač Dev mode vidí jen mod', devRow?.hiddenNoDev === true && devRow.devRowShown === true, JSON.stringify(devRow));
await ev(`(() => { const c = document.getElementById('chk-devmode'); c.checked = true; c.dispatchEvent(new Event('change')); return true; })()`);
check('mod + Dev mode: volby odznaku kanálu vidět', await until(`getComputedStyle(document.getElementById('row-donor-badge')).display !== 'none'`, 3000));
// Volba účtu „místo globálního odznaku“ + náhled vlastní zprávy (core badgeReplaceHtml / badgePreviewHtml), jen s Twitchem.
const br = await ev(`(async () => { const row = document.getElementById('badge-replace-row'); const q = (s) => row.querySelector(s);
  // Vlastní odznaky Twitche v náhledu (role + globální): mapa odznaků + poslední zpráva uživatele.
  window.__uc._twitchBadges['moderator/1'] = 'https://x/mod.png'; window.__uc._twitchBadges['glitchcon2020/1'] = 'https://x/glitch.png';
  window.__uc._chatUsers.set('twitch:moduser', { name: 'ModUser', platform: 'twitch', badgesRaw: 'moderator/1,glitchcon2020/1' });
  document.getElementById('input-nickname').dispatchEvent(new Event('input'));
  const pv = () => [...row.querySelectorAll('.uc-dbr-preview .bdg img')].map((i) => i.dataset.donorBadge ? 'UC' : (i.alt || '').replace(' (ukázka)', '')).join(',');
  const before = { hidden: row.hidden, inSettings: row.closest('.settings-pane')?.dataset.pane, afterColor: row.previousElementSibling?.classList.contains('color-row'), beforeSave: row.nextElementSibling?.classList.contains('save-row'), pv: pv(), name: q('.uc-dbr-preview .un')?.textContent, color: q('.uc-dbr-preview .un')?.style.color };
  document.getElementById('input-nickname').value = 'Modík'; document.getElementById('input-nickname').dispatchEvent(new Event('input'));
  document.getElementById('input-color-hex').value = '#00ff00'; document.getElementById('input-color-hex').dispatchEvent(new Event('input'));
  const live = { name: q('.uc-dbr-preview .un')?.textContent, color: q('.uc-dbr-preview .un')?.style.color };
  const cb = q('[name="uc-badge-replace"]'); cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
  const anim = { uc: q('.uc-dbr-preview img[data-donor-badge]')?.getAnimations().length, ghost: !!q('.uc-dbr-preview img[aria-hidden]')?.getAnimations().length, name: q('.uc-dbr-preview .un')?.getAnimations().length };
  await new Promise((r) => setTimeout(r, 300));
  return { before, live, pvOn: pv(), checked: cb.checked, anim }; })()`);
check('náhled: změna volby animovaná (odznak UC přejede, globální vybledne, jméno se posune) — core renderBadgePreviewInto', br?.anim && br.anim.uc > 0 && br.anim.ghost === true && br.anim.name > 0, JSON.stringify(br?.anim));
check('volba účtu: pod barvou jména, nad Uložit; náhled = odznak UC poslední za vlastními odznaky (role + globální), jméno účtu', br?.before && !br.before.hidden && br.before.inSettings === 'account' && br.before.afterColor && br.before.beforeSave && br.before.pv === 'moderator,glitchcon2020,UC' && br.before.name === 'ModUser', JSON.stringify(br?.before));
check('náhled sleduje přezdívku a barvu při psaní', br?.live?.name === 'Modík' && /rgb\(0, 255, 0\)|#00ff00/i.test(br.live.color || ''), JSON.stringify(br?.live));
check('zaškrtnutí → PUT /account/badge-prefs {replaceGlobal:true}, v náhledu odznak UC na místě globálního (role zůstává)', br?.checked === true && br.pvOn === 'moderator,UC' && badgePuts.length === 1 && badgePuts[0]?.replaceGlobal === true, JSON.stringify({ pvOn: br?.pvOn, badgePuts }));
const dbp = await ev(`(async () => { const row = document.getElementById('row-donor-badge'); const items = [...row.querySelectorAll('.uc-dbp-item')];
  const pics = () => items.map((i) => i.querySelector('img').dataset.donorBadge).join(',');
  const before = { hidden: row.hidden, disp: getComputedStyle(row).display, n: items.length, on: row.querySelector('.uc-dbp-item.on input')?.value, imgs: items.every((i) => i.querySelector('img')?.src.startsWith('data:image/svg+xml')), pics: pics(),
    opts: ['uc-donor-speed', 'uc-donor-strength', 'uc-donor-gapmin', 'uc-donor-gapmax'].map((n) => row.querySelector('[name="' + n + '"]')?.value ?? 'x').join('|') + '|' + !!row.querySelector('[name="uc-donor-replace"]') };
  // Zpráva dárce na Twitchi s globálním odznakem (glitchcon2020) + rolí (moderator): sada odznaků podle „nahradit globální“.
  window.__uc._twitchBadges['moderator/1'] = 'https://x/mod.png'; window.__uc._twitchBadges['glitchcon2020/1'] = 'https://x/glitch.png';
  window.__uc._addMessage({ platform: 'twitch', id: 'e2e-donor', username: 'Darce', userId: 'u55', message: 'ahoj', color: '#00ff00', timestamp: Date.now(), donor: true, donorCzk: 1130, badgesRaw: 'moderator/1,glitchcon2020/1' });
  window.__uc._addMessage({ platform: 'twitch', id: 'e2e-donor-r', username: 'DarceR', userId: 'u58', message: 'ahoj', color: '#00ff00', timestamp: Date.now(), donor: true, donorReplace: true, badgesRaw: 'moderator/1,glitchcon2020/1' });
  const replaced = [...document.querySelectorAll('.msg[data-msg-id="e2e-donor-r"] .bdg img')].map((i) => i.dataset.donorBadge || i.src.split('/').pop()).join(',');
  const msgBadges = () => [...document.querySelectorAll('.msg[data-msg-id="e2e-donor"] .bdg img')].map((i) => i.dataset.donorBadge || i.src.split('/').pop()).join(',');
  const withGlobal = msgBadges(); const title = document.querySelector('.msg[data-msg-id="e2e-donor"] img[data-donor-badge]')?.dataset.tooltip;
  const inp = row.querySelector('input[value="money-bag"]'); inp.checked = true; inp.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  const afterVariant = msgBadges();
  const sp = row.querySelector('[name="uc-donor-speed"]'); sp.value = '1.5'; sp.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  return { before, on: row.querySelector('.uc-dbp-item.on input')?.value, pics: pics(), withGlobal, title, afterVariant, replaced, status: document.getElementById('donor-badge-status')?.textContent }; })()`);
check('mod: výběr odznaku kanálu, 4 varianty s vloženým SVG náhledem, výchozí mince, volby tempo/intenzita/odstupy (bez společného „nahradit“)', dbp?.before && !dbp.before.hidden && dbp.before.disp !== 'none' && dbp.before.n === 4 && dbp.before.on === 'donor-coin' && dbp.before.imgs && dbp.before.pics === 'qr-patron,donor-coin,money-bag,support-card' && dbp.before.opts === '3|1|2|6|false', JSON.stringify(dbp?.before));
check('mod: změna odznaku → PUT celých prefs, náhledy ve výběru se nemění (každý svou variantu), odznak v chatu ano, „Uloženo pro celý kanál“', dbp && dbp.on === 'money-bag' && dbp.pics === 'qr-patron,donor-coin,money-bag,support-card' && dbp.afterVariant === 'mod.png,glitch.png,money-bag' && prefPuts.length === 2 && prefPuts[0]?.prefs?.donorBadge === 'money-bag' && prefPuts[0]?.prefs?.donorSpeed === 3 && !('donorReplaceGlobal' in prefPuts[0].prefs) && prefPuts[1]?.prefs?.donorSpeed === 1.5 && prefPuts[0]?.channel === 'robdiesalot' && dbp.status === 'Uloženo pro celý kanál', JSON.stringify({ dbp, prefPuts }));
// Živá zpráva z vlastního IRC (bez `donor`) → SSE donor-mark doplní odznak; mark před zprávou se uplatní při vykreslení.
await ev(`window.__uc._addMessage({ platform: 'twitch', id: 'e2e-live1', username: 'Zivy', userId: 'u56', message: 'ahoj', color: '#00ff00', timestamp: Date.now(), badgesRaw: 'glitchcon2020/1' })`);
const dmBefore = await ev(`!!document.querySelector('.msg[data-msg-id="e2e-live1"] img[data-donor-badge]')`);
mock.sse.push(['donor-mark', { platform: 'twitch', channel: 'robdiesalot', id: 'e2e-live1', czk: 199, replace: true }]);
mock.sse.push(['donor-mark', { platform: 'twitch', channel: 'robdiesalot', id: 'e2e-live2', czk: 50 }]);
check('SSE donor-mark (replace) → odznak podporovatele u živé zprávy (částka v tooltipu), globální odznak pryč podle volby autora', dmBefore === false && await until(`document.querySelector('.msg[data-msg-id="e2e-live1"] img[data-donor-badge]')?.dataset.tooltip === 'Podporovatel · 199 Kč (za 30 dní)' && document.querySelectorAll('.msg[data-msg-id="e2e-live1"] .bdg img').length === 1`, 6000), await ev(`document.querySelector('.msg[data-msg-id="e2e-live1"] .bdg')?.outerHTML`));
await ev(`window.__uc._addMessage({ platform: 'twitch', id: 'e2e-live2', username: 'Zivy2', userId: 'u57', message: 'ahoj', color: '#00ff00', timestamp: Date.now() })`);
check('donor-mark před zprávou → odznak hned při vykreslení', await ev(`document.querySelector('.msg[data-msg-id="e2e-live2"] img[data-donor-badge]')?.dataset.tooltip`) === 'Podporovatel · 50 Kč (za 30 dní)');
check('dárce: tooltip „Podporovatel · 1 130 Kč (za 30 dní)“; autor s volbou (server donorReplace) má jen roli + odznak UC, ostatní dárci vlastní slot', dbp && dbp.withGlobal === 'mod.png,glitch.png,donor-coin' && /^Podporovatel · 1.130 Kč \(za 30 dní\)$/.test(dbp.title || '') && dbp.replaced === 'mod.png,donor-coin', JSON.stringify(dbp));
check('A koš má title „Smazat zprávu" a je vidět', await ev(`(() => { const b = document.querySelector('.msg[data-msg-id="e2e-m1"] [data-act=delete]'); return b.title === 'Smazat zprávu' && getComputedStyle(b).display !== 'none'; })()`) === true);
const rowVis = () => ev(`(() => { const r = document.getElementById('row-deleted-style'); return !!r && !r.hidden && getComputedStyle(r).display !== 'none'; })()`);
check('A nastavení „Smazané zprávy" vidí mod, jen 3 volby', await until(`!document.getElementById('row-deleted-style').hidden`, 3000) && await rowVis() === true
  && await ev(`[...document.querySelectorAll('#input-deleted-style option')].map(o => o.value + ':' + o.textContent).join(',')`) === 'label:Zpráva smazána,dim:Zašedlé,strike:Přeškrtnuté');
const setStyle = (v) => ev(`(() => { const s = document.getElementById('input-deleted-style'); s.value = '${v}'; s.dispatchEvent(new Event('change')); return true; })()`);
// Kolo 4 bod 5: bez uložené volby je výchozí „Zašedlé“ (dim).
check('A bez uložené volby: „Smazané zprávy“ = Zašedlé (dim)', await ev(`document.getElementById('input-deleted-style').value`) === 'dim'
  && await ev(`(async () => (await chrome.storage.sync.get('uc_config')).uc_config?.deletedStyle ?? null)()`) !== 'label', await ev(`document.getElementById('input-deleted-style').value`));
check('A bez uložené volby: smazaná zpráva z historie (po dotažení obsahu) jako Zašedlé', await until(`!!document.querySelector('.msg[data-msg-id="e2e-m2"].uc-deleted--dim .uc-deleted-tag')`, 4000), JSON.stringify(await msgState('e2e-m2')));
await setStyle('label');
// Mod, styl „Zpráva smazána": smazaná zpráva z historie (bez obsahu) → label + štítek + ztlumení.
const waitNode = async (fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(150); } return false; };
check('A mod: obsah smazané zprávy z historie dotažen přes /moderation/deleted-content', await waitNode(() => contentCalls.length > 0), contentCalls.join(' | '));
check('A mod: dotaz s kanálem a id smazané zprávy (jeden dotaz)', contentCalls.length === 1 && /channel=robdiesalot/.test(contentCalls[0]) && new URL(contentCalls[0]).searchParams.get('ids') === 'twitch:e2e-m2', contentCalls.join(' | '));
await sleep(400);
const m2mod = await msgState('e2e-m2');
check('A mod: po dotažení obsahu i citace odpovědi (↩ @Jiny)', await ev(`document.querySelector('.msg[data-msg-id="e2e-m2"] > .reply-ctx .rctx-user')?.textContent`) === '@Jiny', await ev(`document.querySelector('.msg[data-msg-id="e2e-m2"]')?.outerHTML?.slice(0, 300)`));
check('A mod + label: zašedlé „Zpráva smazána" bez štítku', m2mod?.cls === 'uc-deleted uc-deleted--dimmed uc-deleted--label uc-deleted--restorable' && m2mod.text.startsWith('Zpráva smazána') && !m2mod.tag && m2mod.label, JSON.stringify(m2mod));
// Mod přepne na Přeškrtnuté → dotažený text přeškrtnutý (i přes emote), ztlumený, se štítkem.
await setStyle('strike');
const m2s = await msgState('e2e-m2');
check('A mod + strike: dotažený text přeškrtnutý + ztlumený + štítek', m2s?.cls === 'uc-deleted uc-deleted--dimmed uc-deleted--restorable uc-deleted--strike' && m2s.text.includes('tst') && !m2s.label && m2s.tag === 'Smazáno', JSON.stringify(m2s));
const strikeEmote = await ev(`(() => { const w = document.querySelector('.msg[data-msg-id="e2e-m2"] .tx .emote-stack, .msg[data-msg-id="e2e-m2"] .tx .uc-strike-emote'); if (!w) return null; const a = getComputedStyle(w, '::after'); return { img: !!w.querySelector('img.emote'), after: a.content, h: a.height, pos: a.position, dec: getComputedStyle(document.querySelector('.msg[data-msg-id="e2e-m2"] .tx')).textDecorationLine, op: getComputedStyle(document.querySelector('.msg[data-msg-id="e2e-m2"] .tx')).opacity }; })()`);
check('A mod + strike: čára i přes emote (::after přes obal emotu) + text line-through', strikeEmote?.img && strikeEmote.after !== 'none' && strikeEmote.h === '2px' && strikeEmote.pos === 'absolute' && strikeEmote.dec.includes('line-through'), JSON.stringify(strikeEmote));
check('A mod: ztlumení (.tx opacity 0.5)', strikeEmote?.op === '0.5', JSON.stringify(strikeEmote));
// Smazání až druhým klikem (pokyn usera 2026-09-30): první klik koš natáhne (červený, title „Klikni znovu“), nic nesmaže.
await ev(`document.querySelector('.msg[data-msg-id="e2e-m1"] [data-act=delete]').click()`);
await sleep(150);
const armed = await ev(`(() => { const b = document.querySelector('.msg[data-msg-id="e2e-m1"] [data-act=delete]'); return { armed: b.classList.contains('uc-del-armed'), title: b.title, deleted: b.closest('.msg').classList.contains('uc-deleted'), posts: ${posts.length} }; })()`);
check('A první klik na koš jen natáhne (nic nesmaže, title „Klikni znovu pro smazání“)', armed?.armed === true && armed.title === 'Klikni znovu pro smazání' && !armed.deleted && posts.length === 0, JSON.stringify(armed));
// Malý tooltip s datem u času zprávy.
const tsTip = await ev(`(() => { const ts = document.querySelector('.msg[data-msg-id="e2e-m1"] .ts'); return ts?.getAttribute('data-tooltip') || ''; })()`);
check('čas zprávy má tooltip s celým datem (den, datum, čas)', /^(po|út|st|čt|pá|so|ne) \d{1,2}\. \d{1,2}\. \d{4}, \d\d:\d\d:\d\d$/.test(tsTip), tsTip);
await ev(`document.querySelector('.msg[data-msg-id="e2e-m1"] [data-act=delete]').click()`);
await until(`document.querySelector('.msg[data-msg-id="e2e-m1"]').classList.contains('uc-deleted--strike')`, 3000);
const m1mod = await msgState('e2e-m1');
check('A po kliknutí (strike): text zůstává přeškrtnutý, ztlumený, štítek Smazáno', m1mod?.cls === 'uc-deleted uc-deleted--dimmed uc-deleted--restorable uc-deleted--strike' && m1mod.text.includes('první zpráva') && m1mod.tag === 'Smazáno', JSON.stringify(m1mod));
await setStyle('label');
const m1l = await msgState('e2e-m1');
check('A mod přepne na „Zpráva smazána": zašedlý label bez štítku', m1l?.cls === 'uc-deleted uc-deleted--dimmed uc-deleted--label uc-deleted--restorable' && m1l.label && !m1l.tag, JSON.stringify(m1l));
await setStyle('dim');
const m1d = await msgState('e2e-m1');
check('A mod „Zašedlé": zašedlý text + štítek Smazáno', m1d?.cls === 'uc-deleted uc-deleted--dim uc-deleted--dimmed uc-deleted--restorable' && m1d.text.includes('první zpráva') && m1d.tag === 'Smazáno', JSON.stringify(m1d));
await setStyle('label');
mock.sse.push(['message-hidden', { channel: 'robdiesalot', platform: 'twitch', messageId: 'e2e-m3', by: 'twitch:moduser', at: new Date().toISOString() }]);
check('A mod: skrytá zpráva zůstane vidět', await until(`document.querySelector('.msg[data-msg-id="e2e-m3"]')?.classList.contains('uc-deleted--label')`, 6000));
const m3mod = await msgState('e2e-m3');
check('A mod: skrytá = zašedlé „Zpráva skryta" (label bez štítku)', m3mod?.cls === 'uc-deleted uc-deleted--dimmed uc-deleted--label uc-deleted--restorable' && m3mod.text.startsWith('Zpráva skryta') && !m3mod.tag && m3mod.display !== 'none', JSON.stringify(m3mod));
await until(`[...document.querySelectorAll('#chat .sys')].some(s => s.textContent.includes('provedl bot'))`, 4000);
check('A POST /moderation/delete s kanálem, platformou a id', posts.length === 1 && posts[0]?.platform === 'twitch' && posts[0]?.messageId === 'e2e-m1' && posts[0]?.channel === 'robdiesalot', JSON.stringify(posts));
const sysBot = await lastSys();
check('A výsledek „bot" + chybějící scopes → hláška + „Obnovit přihlášení (moderace)" (Twitch, stejné jako akce z nabídky)', sysBot?.text.startsWith('Na Twitchi akci provedl bot — tvůj účet nemá oprávnění moderovat.') && sysBot.action === 'Obnovit přihlášení (moderace)', JSON.stringify(sysBot));
// Kolo 4 bod 5 + review I1: migrace uložené konfigurace (celá se ukládá, takže 'label' mají i ti, kdo nevybírali).
const setCfg = (o) => ev(`(async () => { const c = (await chrome.storage.sync.get('uc_config')).uc_config || {}; const n = { ...c, ...${JSON.stringify(o)} }; for (const k of Object.keys(n)) if (n[k] === null) delete n[k]; await chrome.storage.sync.set({ uc_config: n }); return true; })()`);
const cfgStyle = () => ev(`(async () => { const c = (await chrome.storage.sync.get('uc_config')).uc_config; return c.deletedStyle + '|' + (c.deletedStyleChosen === true); })()`);
await setCfg({ deletedStyle: 'label', deletedStyleChosen: null });
await boot();
check('A uložené „label“ bez ruční volby (starý výchozí) → Zašedlé', await until(`document.getElementById('input-deleted-style').value === 'dim'`, 4000), await ev(`document.getElementById('input-deleted-style').value`));
await setCfg({ deletedStyle: 'strike', deletedStyleChosen: null });
await boot();
check('A uložené „Přeškrtnuté“ zůstane (mohl ho nastavit jen člověk)', await until(`document.getElementById('input-deleted-style').value === 'strike'`, 4000) && (await cfgStyle()).startsWith('strike|'));
await setStyle('label');
check('A ruční volba „Zpráva smazána“ uloží příznak deletedStyleChosen', await cfgStyle() === 'label|true', await cfgStyle());
await boot();
check('A ruční „Zpráva smazána“ zůstane i po reloadu', await until(`document.getElementById('input-deleted-style').value === 'label'`, 4000) && await cfgStyle() === 'label|true', await cfgStyle());

// ---- fáze B: divák (ne mod) ----
mock.mod = false;
const callsBeforeViewer = contentCalls.length;
await boot();
check('B body.uc-can-moderate pryč', await until(`!document.body.classList.contains('uc-can-moderate')`));
check('B divák: výběr odznaku dárce schovaný', await ev(`getComputedStyle(document.getElementById('row-donor-badge')).display === 'none'`) === true);
check('B koš u diváka schovaný', await ev(`getComputedStyle(document.querySelector('.msg[data-msg-id="e2e-m1"] [data-act=delete]')).display === 'none'`) === true);
const m2v = await msgState('e2e-m2');
check('B divák nevidí nastavení „Smazané zprávy"', await rowVis() === false);
check('B smazaná zpráva z historie u diváka = zašedlé „Zpráva smazána" bez štítku', m2v?.cls === 'uc-deleted uc-deleted--dimmed uc-deleted--label uc-deleted--restorable' && m2v.text === 'Zpráva smazána' && !m2v.tag, JSON.stringify(m2v));
await setStyle('strike');
await sleep(800);
const m2vs = await msgState('e2e-m2');
check('B divák: uložené strike se ignoruje → „Zpráva smazána" bez přeškrtnutí', m2vs?.cls === 'uc-deleted uc-deleted--dimmed uc-deleted--label uc-deleted--restorable' && m2vs.text === 'Zpráva smazána', JSON.stringify(m2vs));
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
check('B divák: ani strike v nastavení text nevrátí (pořád „Zpráva smazána", bez štítku)', m1s?.cls.includes('uc-deleted--label') && !m1s.cls.includes('uc-deleted--strike') && m1s.text === 'Zpráva smazána' && !m1s.tag, JSON.stringify(m1s));
check('B divák: Kopírovat a Odpovědět pořád schované', (await btnVis('e2e-m1', 'copy')) === false && (await btnVis('e2e-m1', 'reply')) === false);
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
// Dvojí klik (pojistka proti nechtěnému smazání).
await ev(`(() => { const b = document.querySelector('.msg[data-msg-id="e2e-m3"] [data-act=delete]'); b.click(); b.click(); return true; })()`);
await until(`[...document.querySelectorAll('#chat .sys')].some(s => s.textContent.includes('Mazat můžou jen modi'))`, 4000);
const m3r = await msgState('e2e-m3');
check('C 403 → optimistické smazání vráceno', m3r?.cls === '' && m3r.text.includes('třetí zpráva'), JSON.stringify(m3r));
check('C 403 → hláška „Mazat můžou jen modi."', await ev(`[...document.querySelectorAll('#chat .sys')].some(s => s.textContent === 'Mazat můžou jen modi.')`) === true);

// ---- fáze D: server potvrdí smazání (SSE) během čekání na POST, POST pak selže → smazání zůstane ----
mock.deleteStatus = 403; mock.deleteDelayMs = 2000;
await boot();
await until(`document.body.classList.contains('uc-can-moderate')`);
await ev(`(() => { const b = document.querySelector('.msg[data-msg-id="e2e-m3"] [data-act=delete]'); b.click(); b.click(); return true; })()`);
mock.sse.push(['message-deleted', { channel: 'robdiesalot', platform: 'twitch', messageId: 'e2e-m3', by: 'twitch:jinymod', reason: 'mod', at: new Date().toISOString() }]);
await until(`[...document.querySelectorAll('#chat .sys')].some(s => s.textContent.includes('Mazat můžou jen modi'))`, 6000);
const m3d = await msgState('e2e-m3');
check('D serverové smazání přežije odmítnutý POST', !!m3d?.cls.includes('uc-deleted'), JSON.stringify(m3d));

console.log(`\n${pass} PASS, ${fail} FAIL`);
finish(fail ? 1 : 0);
