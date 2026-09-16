/**
 * Reprodukce race při dvou rychle po sobě odeslaných Twitch zprávách.
 * Spouští SKUTEČNÝ kód sendChat/sendChatNow vytažený z extension/content/twitch.js
 * proti mocku Slate editoru (async paste commit + klik, který odešle obsah).
 */
const fs = require('fs');
const vm = require('vm');

const path = require('path');
const SRC = path.join(__dirname, '..', 'extension', 'content', 'twitch.js');
const lines = fs.readFileSync(SRC, 'utf8').split(/\r?\n/);
const from = lines.findIndex((l) => l.includes('let _sendChain = Promise.resolve();'));
const to = lines.findIndex((l) => l.startsWith('  async function replyChat('));
const code = lines.slice(from, to).join('\n');

function makeEnv({ pasteDelay, sendDelay }) {
  const sent = [];
  const editor = {
    tagName: 'DIV',
    textContent: '',
    focus() {},
    _selectAll: false,
    dispatchEvent(ev) {
      if (ev.type === 'paste') {
        const t = ev.clipboardData._data;
        const replace = editor._selectAll;
        editor._selectAll = false;
        // Slate commituje paste asynchronně (React scheduler).
        setTimeout(() => { editor.textContent = replace ? t : editor.textContent + t; }, pasteDelay);
      }
      return true;
    }
  };
  const btn = {
    disabled: false,
    getAttribute: () => null,
    click() {
      const payload = editor.textContent;
      if (!payload.trim()) return;           // Twitch prázdnou zprávu neodešle
      setTimeout(() => { sent.push(payload); editor.textContent = ''; }, sendDelay);
    }
  };
  const document = {
    contains: () => true,
    querySelector(sel) {
      if (sel.includes('chat-send-button')) return btn;
      if (sel.includes('chat-input')) return editor;
      return null;
    },
    hasFocus: () => false,
    visibilityState: 'visible',
    execCommand: () => true,
    createRange: () => ({ selectNodeContents: () => { editor._selectAll = true; } })
  };
  const logs = [];
  const sandbox = {
    document,
    window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
    performance: { now: () => Date.now() },
    setTimeout, clearTimeout, Promise, console,
    chrome: { runtime: { sendMessage: (m) => { logs.push(m.tag + ' ' + m.args.join(' ')); } } },
    DataTransfer: class { setData(_t, d) { this._data = d; } },
    ClipboardEvent: class { constructor(type, init) { this.type = type; this.clipboardData = init.clipboardData; } },
    InputEvent: class { constructor(type) { this.type = type; } },
    KeyboardEvent: class { constructor(type) { this.type = type; } },
    Event: class { constructor(type) { this.type = type; } },
    findInput: () => editor,
    HTMLTextAreaElement: { prototype: {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { sandbox, sent, logs, editor };
}

async function scenario(label, useQueue, opts) {
  const { sandbox, sent, logs } = makeEnv(opts);
  const send = useQueue ? sandbox.sendChat : sandbox.sendChatNow;

  const results = await Promise.allSettled([
    send('prvni zprava'),
    // Druhý Enter přijde 120 ms po prvním — dřív, než Slate commitne první paste.
    new Promise((r) => setTimeout(r, 120)).then(() => send('druha zprava'))
  ]);

  const ok = results.map((r) => (r.status === 'fulfilled' ? 'ok' : 'ERR:' + r.reason.message));
  console.log('\n=== ' + label + ' ===');
  console.log('sendChat hlásí:', ok.join(' | '));
  console.log('reálně odesláno na Twitch:', JSON.stringify(sent));
  const bothSent = sent.some((s) => s.includes('prvni')) && sent.some((s) => s.includes('druha'));
  const silentLoss = ok.every((r) => r === 'ok') && !bothSent;
  console.log('obě zprávy dorazily:', bothSent, '| tichá ztráta (hlásí ok, ale nedorazilo):', silentLoss);
  return { bothSent, silentLoss, logs };
}

(async () => {
  const timings = [
    { pasteDelay: 200, sendDelay: 150 },   // typický scheduler lag
    { pasteDelay: 50, sendDelay: 400 },    // rychlý paste, pomalý commit sendu
    { pasteDelay: 700, sendDelay: 100 }    // nejhorší naměřený throttle sidepanelu
  ];
  let allPass = true;
  let lastLogs = [];
  for (const t of timings) {
    const tag = `paste=${t.pasteDelay}ms send=${t.sendDelay}ms`;
    await scenario('BEZ fronty — ' + tag, false, t);
    const after = await scenario('S frontou — ' + tag, true, t);
    lastLogs = after.logs;
    if (!after.bothSent || after.silentLoss) allPass = false;
  }

  console.log('\n--- TwSend log (poslední běh) ---');
  lastLogs.forEach((l) => console.log('  ' + l));

  console.log('\n=== VÝSLEDEK ===');
  console.log(allPass ? 'PASS — obě zprávy odeslány ve všech timingech' : 'FAIL');
  process.exit(allPass ? 0 : 1);
})();
