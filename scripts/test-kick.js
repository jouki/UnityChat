// KickProvider z extension/core/kick.js proti mock fetch + mock Pusher WS.
// Spuštění: node scripts/test-kick.js
import('../extension/core/kick.js').then(async ({ KickProvider }) => {
  let fails = 0;
  const check = (n, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) fails++; };

  class MockWS {
    constructor(url) { MockWS.last = this; this.url = url; this.sent = []; this.readyState = 1; }
    send(s) { this.sent.push(s); }
    close() { this.readyState = 3; this.onclose?.({}); }
  }
  const fetchCalls = [];
  const fetch = async (url) => {
    fetchCalls.push(url);
    return { ok: true, status: 200, json: async () => ({ chatroom: { id: 4242 }, user_id: 77, subscriber_badges: [] }) };
  };
  const logs = [];
  const ki = new KickProvider({ WebSocket: MockWS, fetch, log: (tag, text) => logs.push(tag + ' ' + text) });
  const status = [];
  ki.onStatus = (s) => status.push(s);
  let userId = null;
  ki.onUserId = (id) => { userId = id; };
  let got = null;
  ki.onMessage = (m) => { got = m; };

  await ki.connect('RobDiesALot');
  check('fetch channels API', fetchCalls[0] === 'https://kick.com/api/v2/channels/robdiesalot');
  check('chatroomId + onUserId', ki.chatroomId === 4242 && userId === 77);
  check('Pusher WS', MockWS.last && /pusher\.com/.test(MockWS.last.url));
  MockWS.last.onopen?.();
  MockWS.last.onmessage({ data: JSON.stringify({ event: 'pusher:connection_established', data: '{}' }) });
  check('subscribe chatrooms.4242.v2', MockWS.last.sent.some((s) => s.includes('chatrooms.4242.v2')));
  MockWS.last.onmessage({ data: JSON.stringify({ event: 'pusher_internal:subscription_succeeded', channel: 'chatrooms.4242.v2', data: '{}' }) });
  check('status connected po subscription_succeeded', status.includes('connected'));

  const payload = {
    id: 'k1', type: 'message', content: 'hi [emote:1:Kappa] &amp; bye', created_at: '2026-09-19T12:13:34.396Z',
    sender: { id: 5, username: 'kicker', identity: { color: '#53fc18', badges: [{ type: 'moderator' }, { type: 'subscriber', count: 3 }] } },
  };
  MockWS.last.onmessage({ data: JSON.stringify({ event: 'App\\Events\\ChatMessageEvent', data: JSON.stringify(payload) }) });
  check('ChatMessageEvent → onMessage', !!got && got.platform === 'kick' && got.id === 'k1' && got.username === 'kicker');
  check('timestamp = created_at', got && got.timestamp === Date.parse('2026-09-19T12:13:34.396Z'));
  check('badgesRaw type[/count]', got && got.badgesRaw === 'moderator,subscriber/3');
  check('KickBadge log přes injektovaný log', logs.some((l) => l.startsWith('KickBadge kicker')));
  check('kickContent = původní HTML/tag obsah', got && got.kickContent === payload.content);

  check('_textOnly bez DOM: tagy pryč, entity dekódované', ki._textOnly('a <img src="x" alt="E"> &amp; b') === 'a  & b');

  ki.disconnect();
  check('disconnect zavře WS', MockWS.last.readyState === 3 && ki.connected === false);

  process.exit(fails ? 1 : 0);
});
