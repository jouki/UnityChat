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
  // Model slate-react: vnitřní stav (`state`) se mění SYNCHRONNĚ v handleru
  // paste, DOM (`textContent`) dobíhá až po React commitu (pasteDelay).
  // Výběr z DOM se do Slate propíše přes throttlovaný `selectionchange`
  // (~100 ms) — select-all těsně před pastem tedy ještě neplatí a paste
  // se vloží za existující stav (přesně to zdvojilo text PanPixu 2026-09-19).
  const SEL_SYNC_MS = 100;
  const editor = {
    tagName: 'DIV',
    textContent: '',
    state: '',
    focus() {},
    _selectAllAt: 0,
    dispatchEvent(ev) {
      if (ev.type === 'paste') {
        const t = ev.clipboardData._data;
        const replace = editor._selectAllAt && (Date.now() - editor._selectAllAt) >= SEL_SYNC_MS;
        editor._selectAllAt = 0;
        editor.state = replace ? t : editor.state + t;
        const snapshot = editor.state;
        setTimeout(() => { editor.textContent = snapshot; }, pasteDelay);
      }
      return true;
    }
  };
  const btn = {
    disabled: false,
    getAttribute: () => null,
    click() {
      const payload = editor.state;          // Twitch odešle vnitřní stav editoru
      if (!payload.trim()) return;           // Twitch prázdnou zprávu neodešle
      editor.state = '';
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
    createRange: () => ({ selectNodeContents: () => { editor._selectAllAt = Date.now(); } })
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

async function scenarioSlowSingle(pasteDelay) {
  const { sandbox, sent, logs } = makeEnv({ pasteDelay, sendDelay: 100 });
  const text = 'Nedelej to Robe RAGEY prohrajes treti a vypnes to nasranej KEKLEO';
  const r = await Promise.allSettled([sandbox.sendChat(text)]);
  const status = r[0].status === 'fulfilled' ? 'ok' : 'ERR:' + r[0].reason.message;
  const doubled = sent.some((m) => m.split('Nedelej').length - 1 > 1);
  const exactlyOnce = sent.length === 1 && sent[0].trim() === text;
  console.log(`\n=== JEDNA pomalá zpráva — paste=${pasteDelay}ms ===`);
  console.log('sendChat hlásí:', status);
  console.log('reálně odesláno na Twitch:', JSON.stringify(sent));
  console.log('odesláno přesně 1× nezdvojeně:', exactlyOnce, '| zdvojený text v jedné zprávě:', doubled);
  return { exactlyOnce, doubled, logs };
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

  // Pomalý Slate (2 s) — dřív zdvojilo text (repaste během čekajícího pastu).
  for (const d of [1800, 2600]) {
    const r = await scenarioSlowSingle(d);
    lastLogs = r.logs;
    if (!r.exactlyOnce || r.doubled) allPass = false;
  }

  console.log('\n--- TwSend log (poslední běh) ---');
  lastLogs.forEach((l) => console.log('  ' + l));

  console.log('\n=== VÝSLEDEK ===');
  console.log(allPass ? 'PASS — obě zprávy odeslány ve všech timingech, pomalý paste nezdvojí text' : 'FAIL');
  process.exit(allPass ? 0 : 1);
})();
