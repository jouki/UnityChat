/**
 * Providery musí brát čas zprávy z platformy (tmi-sent-ts, created_at,
 * timestampUsec), ne z Date.now() klienta. Spouští skutečné třídy z
 * extension/sidepanel.js ve vm sandboxu (stejný vzor jako test-send-race.js).
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'sidepanel.js'), 'utf8');
const between = (a, b) => {
  const i = src.indexOf(a), j = src.indexOf(b);
  if (i === -1 || j === -1 || j < i) throw new Error(`anchor ${a} / ${b} nenalezen`);
  return src.slice(i, j);
};
// TwitchProvider → KickProvider → YouTubeProvider jdou za sebou, před class UnityChat.
const code = between('class TwitchProvider', 'class UnityChat');

const sandbox = {
  console,
  crypto: { randomUUID: () => 'r' },
  twitchDefaultColor: () => '#fff',
  ytNameColor: () => '#fff',
  chrome: { runtime: { sendMessage: () => ({ catch() {} }) } },
  setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, Number, JSON, String,
  WebSocket: class {},
  fetch: async () => { throw new Error('no net'); },
  performance,
};
vm.createContext(sandbox);
vm.runInContext(code + '\nthis.TwitchProvider = TwitchProvider; this.KickProvider = KickProvider; this.YouTubeProvider = YouTubeProvider;', sandbox);

let fails = 0;
const check = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fails++; };
let got;

const tw = new sandbox.TwitchProvider();
tw.onMessage = (m) => { got = m; };
tw._parse('@id=m1;display-name=A;tmi-sent-ts=1789820014396;user-id=1 :a!a@a PRIVMSG #c :hi');
check('twitch PRIVMSG: timestamp = tmi-sent-ts', got && got.timestamp === 1789820014396);
tw._parse('@id=m2;display-name=A;user-id=1 :a!a@a PRIVMSG #c :hi');
check('twitch PRIVMSG: bez tagu fallback Date.now()', got && Math.abs(got.timestamp - Date.now()) < 1000);
got = null;
tw._parseNotice('@id=r1;msg-id=raid;msg-param-displayName=X;msg-param-viewerCount=5;tmi-sent-ts=1789820014000;user-id=9 :tmi.twitch.tv USERNOTICE #c');
check('twitch USERNOTICE raid: timestamp = tmi-sent-ts', got && got.timestamp === 1789820014000);

const ki = new sandbox.KickProvider();
ki.onMessage = (m) => { got = m; };
ki._parse({ id: 'k', type: 'message', content: 'x', created_at: '2026-09-19T12:13:34.396Z', sender: { id: 1, username: 'u', identity: { badges: [] } } });
check('kick: timestamp = created_at', got && got.timestamp === Date.parse('2026-09-19T12:13:34.396Z'));

const yt = new sandbox.YouTubeProvider();
yt.onMessage = (m) => { got = m; };
yt._processActions([{ addChatItemAction: { item: { liveChatTextMessageRenderer: { id: 'y', timestampUsec: '1789820014396123', authorName: { simpleText: '@a' }, message: { runs: [{ text: 'hi' }] } } } } }]);
check('youtube: timestamp = timestampUsec/1000', got && got.timestamp === 1789820014396);

process.exit(fails ? 1 : 0);
