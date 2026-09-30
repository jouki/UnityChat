// Sonda: časový průběh spodní hrany panelu a patičky při přepnutí záložky (core switchPanes + morphResize).
// node scripts/probe-switch-panes.mjs  (Chrome v C:/Program Files/…, nebo CHROME=…)
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };
const srvPort = await freePort();
const srv = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
}).listen(srvPort);
const port = await freePort();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-probe-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=500,900', 'about:blank'], { stdio: 'ignore' });
const finish = (code) => { try { chrome.kill(); } catch {} srv.close(); setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} process.exit(code); }, 300); };
let ver = null;
for (let i = 0; i < 50 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(200); } }
const pend = new Map(); let id = 0;
const ws = await new Promise((res) => { const w = new WebSocket(ver.webSocketDebuggerUrl); w.onopen = () => res(w); w.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } }; });
const call = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
const { result: { targetId } } = await call('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await call('Target.attachToTarget', { targetId, flatten: true });
await call('Page.enable', {}, sessionId); await call('Runtime.enable', {}, sessionId);
await call('Page.navigate', { url: `http://127.0.0.1:${srvPort}/scripts/probe-switch-panes.html` }, sessionId);
await sleep(800);
const ev = async (expr) => { const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId); return r.result?.result?.value; };
for (const tab of ['b', 'a']) {
  await ev(`window.go('${tab}')`);
  await sleep(700);
  const s = await ev('JSON.stringify(window.samples)');
  console.log(`→ ${tab}:`, s);
}
finish(0);
