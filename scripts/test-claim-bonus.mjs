// Test hledání tlačítka „Vyzvednout bonus“ (extension/content/twitch.js findClaimBonusBtn) v headless Chromu:
// promo Twitche „Dárek: bonusová předplatná“ (gift-button, aria-label s „bonus“) se za bonus brát nesmí,
// skutečné tlačítko (ikona .claimable-bonus__icon / aria-label uvnitř widgetu bodů) ano.
// Spuštění: node scripts/test-claim-bonus.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const src = fs.readFileSync(path.join(here, '../extension/content/twitch.js'), 'utf8').replace(/\r\n/g, '\n');
const m = /const CREDITS_SUMMARY_SEL = [^\n]+\n[\s\S]*?\/\/ --- findClaimBonusBtn[^\n]*\n([\s\S]*?)\/\/ --- \/findClaimBonusBtn/.exec(src);
const sel = /const CREDITS_SUMMARY_SEL = [^\n]+/.exec(src);
if (!m || !sel) { console.log('FAIL funkce findClaimBonusBtn v content/twitch.js nenalezena'); process.exit(1); }
const fnSrc = `${sel[0]}\n${m[1]}`;

const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-claim-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
let ver = null;
for (let i = 0; i < 40 && !ver; i++) { await sleep(250); ver = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => null); }
let seq = 0; const pend = new Map();
const s = await new Promise((res) => { const w = new WebSocket(ver.webSocketDebuggerUrl); w.onopen = () => res(w); w.onmessage = (e) => { const d = JSON.parse(e.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } }; });
const call = (method, params = {}, sessionId) => new Promise((res) => { const i = ++seq; pend.set(i, res); s.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
const { result: { targetId } } = await call('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await call('Target.attachToTarget', { targetId, flatten: true });
const ev = async (expr) => (await call('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId)).result?.result?.value;

const GIFT = '<button aria-label="Dárek: bonusová předplatná" data-a-target="gift-button" style="width:80px;height:30px">Dárek</button>';
const SUMMARY = (inner) => `<div class="community-points-summary" data-test-selector="community-points-summary"><button aria-label="Zůstatek bitů a bodů" style="width:60px;height:30px">120</button>${inner}</div>`;
const run = (html) => ev(`(() => { document.body.innerHTML = ${JSON.stringify(html)}; ${fnSrc}; const b = findClaimBonusBtn(); return b ? (b.getAttribute('aria-label') || b.id || 'btn') : null; })()`);

check('promo „Dárek: bonusová předplatná“ bez bonusu → žádné tlačítko', await run(GIFT + SUMMARY('')) === null, String(await run(GIFT + SUMMARY(''))));
check('bez widgetu bodů → nic', await run(GIFT) === null);
check('ikona .claimable-bonus__icon → její tlačítko', await run(GIFT + SUMMARY('<button id="claim" aria-label="Vyzvednout bonus" style="width:30px;height:30px"><div class="claimable-bonus__icon"></div></button>')) === 'Vyzvednout bonus');
check('bez ikony: aria-label uvnitř widgetu (EN)', await run(GIFT + SUMMARY('<button aria-label="Claim Bonus" style="width:30px;height:30px"></button>')) === 'Claim Bonus');
check('neviditelné tlačítko se nebere', await run(SUMMARY('<button aria-label="Claim Bonus" style="display:none"></button>')) === null);

console.log(`\n${pass} PASS, ${fail} FAIL`);
try { chrome.kill(); } catch {}
setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} process.exit(fail ? 1 : 0); }, 300);
