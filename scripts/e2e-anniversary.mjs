// E2E (headless Chrome + CDP): výročí na Twitchi v addonu (podklad docs/superpowers/specs/2026-09-27-twitch-vyroci-research.md).
//  - zobrazení cizích výročí z /chat/history (tvar backendu): modiversary karta s mečem a textem, sdílený resub s textem;
//  - banner výročí předplatného (priorita): texty, Sdílet → zpráva s počítadlem a volbou série, Odeslat →
//    useChatNotificationToken {channelLogin, message, includeStreak, tokenID}, potvrzení, další výzva (mod);
//  - moderátorské výročí: předvyplněný text, prázdná zpráva nejde, ALREADY_SENT česky, integrity challenge →
//    záloha přes stránku Twitche (tady žádná karta Twitche → hláška), × → DismissUserModiversaryCallout;
//  - persisted query → PersistedQueryNotFound → plný dotaz; cookie jen v hlavičce, nikdy v logu;
//  - zavření resubu platí jen pro jeho id (další měsíc = nové id → banner znovu), resub × bez volání Twitche;
//  - darované předplatné → poděkování dárci; prefers-reduced-motion → bez animace.
// Backend (api.jouki.cz) mockovaný v panelu, Twitch GQL mockovaný v service workeru (Fetch.requestPaused).
// Spuštění: node scripts/e2e-anniversary.mjs
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-e2e-anniv-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--enable-unsafe-extension-debugging', '--window-size=520,900', 'about:blank'], { stdio: 'ignore' });

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

// ---- mock Twitch GQL (service worker) ----
const COOKIE = 'e2e-cookie-secret-123';
const gqlLog = [];            // { op, via, variables, auth }
const gql = {
  resub: { id: 'rn-7', cumulativeTenureMonths: 7, months: 7, streakTenureMonths: 3, isGiftSubscription: false, gifter: null },
  mod: { hasMilestoneAlert: true, canSendUserNotice: true, months: 24 },
  modSend: 'ok',               // 'ok' | 'ALREADY_SENT' | 'integrity'
  resubOk: true,
};
function gqlAnswer(body) {
  const op = body.operationName;
  const via = body.query ? 'query' : 'hash';
  gqlLog.push({ op, via, variables: body.variables, hash: body.extensions?.persistedQuery?.sha256Hash || null });
  // Persisted hashe „nezná“ (ověří zálohu na plný dotaz), kromě mutace resubu (ověří, že hash projde bez zálohy).
  if (via === 'hash' && op !== 'Chat_ShareResub_UseResubToken') return { errors: [{ message: 'PersistedQueryNotFound' }] };
  switch (op) {
    case 'UcAnnivContext': if (gql.contextError) return { errors: [{ message: 'service error' }] }; return { data: { currentUser: { id: '4242', login: 'tester' }, user: { id: '160028137' } } };
    case 'UcAnnivResub': return { data: { user: { id: '160028137', self: { resubNotification: gql.resub } } } };
    case 'ModiversaryStatusQuery': return { data: { userModiversary: gql.mod } };
    case 'Chat_ShareResub_UseResubToken': return { data: { useChatNotificationToken: { isSuccess: gql.resubOk } } };
    case 'SendUserModiversaryNotice':
      if (gql.modSend === 'integrity') return { errors: [{ message: 'failed integrity check', path: ['sendUserModiversaryNotice'] }], extensions: { challenge: { type: 'integrity' } } };
      return { data: { sendUserModiversaryNotice: { modiversary: null, error: gql.modSend === 'ok' ? null : gql.modSend } } };
    case 'DismissUserModiversaryCallout': return { data: { dismissUserModiversaryCallout: { modiversary: null, error: null } } };
    default: return { errors: [{ message: 'unknown op ' + op }] };
  }
}
const attachedSw = new Set();
async function attachSw() {
  const { result } = await call('Target.getTargets');
  for (const t of result.targetInfos) {
    if (t.type !== 'service_worker' || !t.url.startsWith(`chrome-extension://${extId}/`) || attachedSw.has(t.targetId)) continue;
    const a = await call('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    const sid = a.result?.sessionId;
    if (!sid) continue;
    attachedSw.add(t.targetId);
    await call('Fetch.enable', { patterns: [{ urlPattern: '*gql.twitch.tv/gql*' }] }, sid);
    await call('Runtime.runIfWaitingForDebugger', {}, sid);
  }
}
await call('Target.setDiscoverTargets', { discover: true });

const { result: { targetId } } = await call('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await call('Target.attachToTarget', { targetId, flatten: true });

// ---- mock backendu (panel) ----
const HISTORY = [
  { platform: 'twitch', id: 'mv-1', username: 'ModPepa', userId: '4242', message: 'dva roky už! Kappa', timestamp: Date.now() - 60000, historical: true,
    color: '#00FF7F', badgesRaw: 'moderator/1', twitchEmotes: null, twitchEmotesOffset: 0, firstMsg: false, isAction: false, replyTo: null, isModiversary: true, modMonths: 24 },
  { platform: 'twitch', id: 'rs-1', username: 'Subík', userId: '77', message: 'sedm měsíců s Robem', timestamp: Date.now() - 50000, historical: true,
    color: '#8A2BE2', badgesRaw: 'subscriber/6', twitchEmotes: null, twitchEmotesOffset: 0, firstMsg: false, isAction: false, replyTo: null,
    isSubEvent: true, subPlan: '1000', subMonths: 7, subStreak: 3 },
];
s.onevent = async (d) => {
  if (d.method === 'Target.targetCreated' && d.params.targetInfo.type === 'service_worker') { attachSw().catch(() => {}); return; }
  if (d.method !== 'Fetch.requestPaused') return;
  const q = d.params.request;
  const rid = d.params.requestId;
  const sid = d.sessionId;
  const fulfill = (code, type, body) => call('Fetch.fulfillRequest', { requestId: rid, responseCode: code, responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: Buffer.from(body).toString('base64') }, sid);
  const json = (o, code = 200) => fulfill(code, 'application/json', JSON.stringify(o));
  const u = new URL(q.url);
  if (u.hostname === 'gql.twitch.tv') {
    const auth = q.headers.Authorization || q.headers.authorization || '';
    let body = {};
    try { body = JSON.parse(q.postData || '{}'); } catch {}
    const ans = gqlAnswer(body);
    gqlLog[gqlLog.length - 1].auth = auth;
    return json(ans);
  }
  if (u.pathname === '/nicknames/stream' || u.pathname === '/account/stream') return fulfill(200, 'text/event-stream', 'retry: 60000\n\n');
  if (u.pathname === '/auth/me') return json({ ok: true, accountId: 7, platforms: { twitch: { login: 'tester', displayName: 'Tester' }, kick: null, youtube: null }, warnings: [] });
  if (u.pathname === '/chat/history') return json({ ok: true, messages: HISTORY, nextBefore: null });
  if (u.pathname.startsWith('/account/')) return json({ ok: true, email: null, emailVerified: false, warnings: [] });
  return json({ ok: false, error: 'e2e' }, 404);
};
await call('Fetch.enable', { patterns: ['/auth/me', '/soundboard', '/chat/history', '/nicknames', '/donate/', '/account/', '/gif', '/moderation/', '/commands', '/users', '/blacklist', '/announcements', '/reactions', '/streamers'].map((p) => ({ urlPattern: `*api.jouki.cz${p}*` })) }, sessionId);
await call('Runtime.enable', {}, sessionId);
const ev = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId); if (r.result?.exceptionDetails) return { __err: JSON.stringify(r.result.exceptionDetails).slice(0, 400) }; return r.result?.result?.value; };
const until = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr) === true) return true; await sleep(100); } return false; };
const click = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
const txt = (sel) => ev(`(document.querySelector(${JSON.stringify(sel)})?.textContent || '').trim()`);
const typeInto = (sel, value) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const gqlOps = () => gqlLog.map((g) => `${g.op}:${g.via}`);

// ---- boot: session UC + cookie Twitche ----
await call('Page.enable', {}, sessionId);
await call('Page.navigate', { url: `chrome-extension://${extId}/sidepanel.html` }, sessionId);
await sleep(1200);
await attachSw();
await ev(`Promise.all([chrome.storage.local.set({ uc_session: 'tok' }), chrome.cookies.set({ url: 'https://www.twitch.tv', name: 'auth-token', value: '${COOKIE}', secure: true })])`);
await call('Page.navigate', { url: `chrome-extension://${extId}/sidepanel.html` }, sessionId);
await attachSw();

// ---- zobrazení cizích výročí (historie ze serveru) ----
check('modiversary z historie: zelená karta s mečem', await until(`!!document.querySelector('.msg.modiversary-event .modiv-icon svg')`, 15000));
check('modiversary: „ModPepa je už 2 roky moderátorem!“', await txt('.msg.modiversary-event .modiv-line') === 'ModPepa je už 2 roky moderátorem!', await txt('.msg.modiversary-event .modiv-line'));
check('modiversary: text uživatele pod tím', (await txt('.msg.modiversary-event .modiv-text')).startsWith('dva roky už!'));
check('modiversary: bez hover akcí (systémová událost)', await ev(`!document.querySelector('.msg.modiversary-event .msg-actions')`) === true);
const subLine = await txt('.msg.sub-event .sub-line');
check('sdílený resub česky: „Předplatné Tier 1. Celkem 7 měsíců, 3 měsíce v řadě.“ + text uživatele', subLine === 'Předplatné Tier 1. Celkem 7 měsíců, 3 měsíce v řadě.' && await txt('.msg.sub-event .sub-text') === 'sedm měsíců s Robem', subLine);

// ---- banner výročí předplatného ----
check('banner resubu po přihlášení', await until(`!!document.querySelector('#anniv-banner .uc-anniv--resub') && !document.getElementById('anniv-banner').classList.contains('hidden')`, 10000));
check('banner resubu: „Předplatné: 7 měsíců!“ + „Sdílej to v chatu“', await txt('.uc-anniv-title') === 'Předplatné: 7 měsíců!' && await txt('.uc-anniv-sub') === 'Sdílej to v chatu');
check('stav: kontext + resub plným dotazem, ModiversaryStatusQuery hash → PersistedQueryNotFound → plný dotaz',
  ['UcAnnivContext:query', 'UcAnnivResub:query', 'ModiversaryStatusQuery:hash', 'ModiversaryStatusQuery:query'].every((x) => gqlOps().includes(x)), JSON.stringify(gqlOps()));
const ms = gqlLog.find((g) => g.op === 'ModiversaryStatusQuery');
check('ModiversaryStatusQuery: parametrizované proměnné {channelID, userID} + hash z podkladu', ms && ms.variables.channelID === '160028137' && ms.variables.userID === '4242' && ms.hash === '811a62815487547845c1da820f8f9a927ef90f348bf818b3b6c6753246f3aaa0', JSON.stringify(ms));
check('GQL: cookie jen jako Authorization OAuth', gqlLog.every((g) => g.auth === `OAuth ${COOKIE}`));

await click('.uc-anniv-share');
check('Sdílet → rozbalené pole, Sdílet schované', await until(`document.querySelector('.uc-anniv').classList.contains('uc-anniv--open') && document.querySelector('.uc-anniv-share').hidden`, 2000));
check('resub: prázdná zpráva jde odeslat, počítadlo 0/500', await txt('.uc-anniv-count') === '0/500' && await ev(`document.querySelector('.uc-anniv-send').disabled`) === false);
check('resub: volba série „…mou 3měsíční sérii“, zapnutá', await txt('.uc-anniv-streak') === 'Zobrazit v chatové zprávě mou 3měsíční sérii' && await ev(`document.querySelector('.uc-anniv-streak input').checked`) === true);
check('pole má limit 500 znaků', await ev(`document.querySelector('.uc-anniv-input').maxLength`) === 500);
// Odkaz ve zprávě: červené varování nad polem, Odeslat zakázané, Enter nic nepošle.
await typeInto('.uc-anniv-input', 'mrkněte na https://example.com');
check('odkaz → varování nad polem', await ev(`(() => { const w = document.querySelector('.uc-anniv-linkwarn'); const i = document.querySelector('.uc-anniv-input'); return !!w && !w.hidden && w.textContent === 'Odkazy nejsou ve zprávě povolené.' && !!(w.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_FOLLOWING); })()`) === true);
check('odkaz → Odeslat zakázané', await ev(`document.querySelector('.uc-anniv-send').disabled`) === true);
const gqlBeforeLink = gqlLog.length;
await ev(`document.querySelector('.uc-anniv-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
await new Promise((r) => setTimeout(r, 300));
check('odkaz → Enter nic neodešle', gqlLog.length === gqlBeforeLink);
await typeInto('.uc-anniv-input', 'Díky Robe!');
check('bez odkazu → varování zmizí', await ev(`document.querySelector('.uc-anniv-linkwarn').hidden`) === true);
check('počítadlo 10/500', await txt('.uc-anniv-count') === '10/500');
// Zrušit sbalí, Sdílet znovu otevře s textem.
await click('.uc-anniv-cancel');
check('Zrušit sbalí pole', await until(`!document.querySelector('.uc-anniv').classList.contains('uc-anniv--open')`, 1000));
await click('.uc-anniv-share');
await click('.uc-anniv-send');
check('odesláno → „Sdíleno v chatu!“', await until(`(document.querySelector('.uc-anniv-title')?.textContent || '') === 'Sdíleno v chatu!'`, 5000));
const share = gqlLog.find((g) => g.op === 'Chat_ShareResub_UseResubToken');
check('useChatNotificationToken: {channelLogin, message, includeStreak, tokenID = id notifikace}, persisted hash prošel',
  share && share.via === 'hash' && JSON.stringify(share.variables) === JSON.stringify({ input: { channelLogin: 'robdiesalot', message: 'Díky Robe!', includeStreak: true, tokenID: 'rn-7' } }), JSON.stringify(share));
check('po potvrzení další výzva: moderátorské výročí', await until(`!!document.querySelector('.uc-anniv--mod')`, 6000));
check('resub zapamatovaný jako sdílený (id)', await ev(`chrome.storage.local.get('uc_anniv_dismissed').then((r) => r.uc_anniv_dismissed?.['resub:rn-7']?.type)`) === 'shared');

// ---- moderátorské výročí ----
check('mod: „Blahopřejeme k 2letému moderátorskému výročí!“', await txt('.uc-anniv-title') === 'Blahopřejeme k 2letému moderátorskému výročí!');
check('mod: ikona meče', await ev(`!!document.querySelector('.uc-anniv--mod .uc-anniv-icon svg')`) === true);
await click('.uc-anniv-share');
check('mod: předvyplněno „Oslavuji 2leté moderátorské výročí!“', await ev(`document.querySelector('.uc-anniv-input').value`) === 'Oslavuji 2leté moderátorské výročí!');
await typeInto('.uc-anniv-input', '   ');
check('mod: prázdná zpráva nejde odeslat', await ev(`document.querySelector('.uc-anniv-send').disabled`) === true);
await typeInto('.uc-anniv-input', 'Dva roky s vámi!');
gql.modSend = 'ALREADY_SENT';
await click('.uc-anniv-send');
check('ALREADY_SENT → česká hláška, banner zůstává', await until(`(document.querySelector('.uc-anniv-msg')?.textContent || '') === 'Tohle výročí už je v tomto kanálu sdílené.'`, 5000) && await ev(`!!document.querySelector('.uc-anniv--mod.uc-anniv--open')`) === true);
const send1 = gqlLog.filter((g) => g.op === 'SendUserModiversaryNotice').at(-1);
check('SendUserModiversaryNotice: {channelID, noticeMessage}', send1 && JSON.stringify(send1.variables) === JSON.stringify({ input: { channelID: '160028137', noticeMessage: 'Dva roky s vámi!' } }), JSON.stringify(send1));
gql.modSend = 'integrity';
await click('.uc-anniv-send');
check('integrity challenge → bez stránky Twitche hláška „Sdílet se teď nepovedlo, zkus to přímo na Twitchi.“',
  await until(`(document.querySelector('.uc-anniv-msg')?.textContent || '') === 'Sdílet se teď nepovedlo, zkus to přímo na Twitchi.'`, 8000), await txt('.uc-anniv-msg'));
const logs = await ev(`chrome.runtime.sendMessage({ type: 'GET_LOGS' }).then((r) => r.text)`);
check('UC_LOG Anniversary: errors + extensions s challenge, žádná záloha přes stránku Twitche', /\[Anniversary\] SendUserModiversaryNotice .*errors=.*integrity.*"challenge":\{"type":"integrity"\}/.test(logs) && !/záloha|ANNIV_DOM/.test(logs));
check('integrity: banner zůstává otevřený s textem', await ev(`!!document.querySelector('.uc-anniv--mod.uc-anniv--open') && document.querySelector('.uc-anniv-input').value === 'Dva roky s vámi!'`) === true);
check('log neobsahuje cookie ani text zprávy', !logs.includes(COOKIE) && !logs.includes('Dva roky s vámi'));
await click('.uc-anniv-close');
check('× u mod výročí → banner pryč + DismissUserModiversaryCallout {channelID}', await until(`document.getElementById('anniv-banner').classList.contains('hidden')`, 2000)
  && await until(`true`, 300) && gqlLog.some((g) => g.op === 'DismissUserModiversaryCallout' && g.variables.input.channelID === '160028137'));

check('mod zavření zapamatované s id Twitch účtu (mod:<účet>:<kanál>:<měsíce>)', await ev(`chrome.storage.local.get('uc_anniv_dismissed').then((r) => r.uc_anniv_dismissed?.['mod:4242:160028137:24']?.type)`) === 'dismissed');

// ---- zavření resubu platí jen pro dané id ----
gql.mod = { hasMilestoneAlert: false, canSendUserNotice: false, months: 24 };
await ev(`chrome.storage.local.set({ uc_anniv_dismissed: { 'resub:rn-7': { at: Date.now(), type: 'dismissed' } } })`);
await call('Page.navigate', { url: `chrome-extension://${extId}/sidepanel.html` }, sessionId);
await attachSw();
await until(`!!document.querySelector('.msg.modiversary-event')`, 15000);
await sleep(2500);
check('zavřený resub (stejné id) se po načtení neukáže', await ev(`document.getElementById('anniv-banner').classList.contains('hidden')`) === true);
gql.resub = { ...gql.resub, id: 'rn-8', cumulativeTenureMonths: 8, months: 8, streakTenureMonths: 4 };
const before = gqlLog.length;
await call('Page.navigate', { url: `chrome-extension://${extId}/sidepanel.html` }, sessionId);
await attachSw();
check('další měsíc (nové id) → banner znovu „Předplatné: 8 měsíců!“', await until(`(document.querySelector('.uc-anniv-title')?.textContent || '') === 'Předplatné: 8 měsíců!'`, 15000));
check('bez reduced motion → animace příchodu', await ev(`document.querySelector('.uc-anniv').classList.contains('uc-anniv--enter') || getComputedStyle(document.querySelector('.uc-anniv')).animationName !== 'none'`) === true);
await click('.uc-anniv-close');
await sleep(600);
const dm = await ev(`chrome.storage.local.get('uc_anniv_dismissed').then((r) => r.uc_anniv_dismissed || {})`);
check('× u resubu: zapamatováno jen „resub:rn-8“ (a staré rn-7), Twitch se nevolá', dm['resub:rn-8']?.type === 'dismissed' && dm['resub:rn-7'] && !gqlLog.slice(before).some((g) => /Dismiss/.test(g.op)), JSON.stringify(dm));

// ---- darované předplatné + reduced motion ----
gql.resub = { id: 'rn-9', cumulativeTenureMonths: 3, months: 3, streakTenureMonths: 0, isGiftSubscription: true, gifter: { id: '1', login: 'darce', displayName: 'Dárce' } };
await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
await call('Page.navigate', { url: `chrome-extension://${extId}/sidepanel.html` }, sessionId);
await attachSw();
check('dar: „Předplatné: 3 měsíce!“', await until(`(document.querySelector('.uc-anniv-title')?.textContent || '') === 'Předplatné: 3 měsíce!'`, 15000));
check('reduced motion: bez animace příchodu', await ev(`getComputedStyle(document.querySelector('.uc-anniv')).animationName === 'none'`) === true);
await click('.uc-anniv-share');
check('dar: předvyplněno „Děkuji za dárek, @Dárce!“, bez volby série', await ev(`document.querySelector('.uc-anniv-input').value`) === 'Děkuji za dárek, @Dárce!' && await ev(`!document.querySelector('.uc-anniv-streak')`) === true);
gql.resubOk = false;
await click('.uc-anniv-send');
check('resub isSuccess=false → česká hláška', await until(`(document.querySelector('.uc-anniv-msg')?.textContent || '') === 'Twitch výročí předplatného nepřijal (možná už je sdílené).'`, 5000), await txt('.uc-anniv-msg'));

// ---- chyba stavu (GQL) a odhlášení z UnityChatu → žádný banner ----
await call('Emulation.setEmulatedMedia', { features: [] }, sessionId);
gql.resub = { id: 'rn-10', cumulativeTenureMonths: 10, months: 10, streakTenureMonths: 0, isGiftSubscription: false, gifter: null };
gql.contextError = true;
await call('Page.navigate', { url: `chrome-extension://${extId}/sidepanel.html` }, sessionId);
await attachSw();
await until(`!!document.querySelector('.msg.modiversary-event')`, 15000);
await sleep(2500);
check('chyba GQL stavu → banner se neukáže', await ev(`document.getElementById('anniv-banner').classList.contains('hidden')`) === true);
gql.contextError = false;
const n0 = gqlLog.filter((g) => g.op === 'UcAnnivContext').length;
await ev(`chrome.storage.local.remove('uc_session')`);
await call('Page.navigate', { url: `chrome-extension://${extId}/sidepanel.html` }, sessionId);
await attachSw();
await sleep(4000);
check('bez přihlášení do UnityChatu → žádný banner ani dotaz na Twitch', await ev(`document.getElementById('anniv-banner').classList.contains('hidden')`) === true
  && gqlLog.filter((g) => g.op === 'UcAnnivContext').length === n0, String(gqlLog.filter((g) => g.op === 'UcAnnivContext').length - n0));

console.log(`\n${pass} PASS, ${fail} FAIL`);
finish(fail ? 1 : 0);
