// TwitchProvider z extension/core/twitch-irc.js proti mock WebSocketu.
// Spuštění: node scripts/test-twitch-irc.js
import('../extension/core/twitch-irc.js').then(({ TwitchProvider }) => {
  let fails = 0;
  const check = (n, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) fails++; };

  class MockWS {
    constructor(url) { MockWS.last = this; this.url = url; this.sent = []; this.readyState = 1; }
    send(s) { this.sent.push(s); }
    close() { this.readyState = 3; this.onclose?.({}); }
  }
  const logs = [];
  const tw = new TwitchProvider({ WebSocket: MockWS, log: (tag, text) => logs.push(tag + ' ' + text) });
  const status = [];
  tw.onStatus = (s) => status.push(s);
  let got = null;
  tw.onMessage = (m) => { got = m; };
  let roomId = null;
  tw.onRoomId = (id) => { roomId = id; };

  tw.connect('RobDiesALot ');
  check('WS na Twitch IRC', MockWS.last && MockWS.last.url === 'wss://irc-ws.chat.twitch.tv:443');
  check('status connecting', status[0] === 'connecting');
  MockWS.last.onopen();
  check('JOIN #robdiesalot (lowercase + trim)', MockWS.last.sent.some((s) => s === 'JOIN #robdiesalot'));
  check('anonymní justinfan login', MockWS.last.sent.some((s) => /^NICK justinfan\d+$/.test(s)));
  check('status connected', status.includes('connected') && tw.connected === true);

  MockWS.last.onmessage({ data: 'PING :tmi.twitch.tv\r\n' });
  check('PING → PONG', MockWS.last.sent.includes('PONG :tmi.twitch.tv'));

  MockWS.last.onmessage({ data: '@emote-only=0;room-id=160028137 :tmi.twitch.tv ROOMSTATE #robdiesalot\r\n' });
  check('ROOMSTATE → onRoomId', roomId === '160028137');

  MockWS.last.onmessage({ data: '@badge-info=;badges=moderator/1;color=#FF0000;display-name=TestUser;emotes=;first-msg=0;id=abc;tmi-sent-ts=1700000000000;user-id=1 :test!test@test.tmi.twitch.tv PRIVMSG #robdiesalot :hello world\r\n' });
  check('PRIVMSG → onMessage', !!got && got.platform === 'twitch' && got.id === 'abc');
  check('timestamp z tmi-sent-ts', got && got.timestamp === 1700000000000);
  check('display-name', got && got.username === 'TestUser');
  check('text zprávy', got && got.message === 'hello world');
  check('barva z tagu', got && got.color === '#FF0000');
  check('badgesRaw', got && got.badgesRaw === 'moderator/1');

  got = null;
  MockWS.last.onmessage({ data: '@id=rp1;display-name=Replier;user-id=3;reply-parent-msg-id=abc;reply-parent-display-name=TestUser;reply-parent-msg-body=hello\\sworld\\:\\sx :replier!r@r PRIVMSG #robdiesalot :@TestUser yes\r\n' });
  check('reply: parent body unescape \\s a \\:', got && got.replyTo && got.replyTo.message === 'hello world; x' && got.replyTo.id === 'abc');
  check('reply: @user prefix stripnutý z textu', got && got.message === 'yes');

  got = null;
  MockWS.last.onmessage({ data: '@id=n1;color=;display-name=NoColor;user-id=2 :nocolor!x@x PRIVMSG #robdiesalot :hi\r\n' });
  check('bez barvy → default z palety', got && /^#[0-9A-Fa-f]{6}$/.test(got.color));

  got = null;
  MockWS.last.onmessage({ data: '@id=r1;msg-id=raid;msg-param-displayName=Raider;msg-param-viewerCount=5;tmi-sent-ts=1700000001000;user-id=9;display-name=Raider :tmi.twitch.tv USERNOTICE #robdiesalot\r\n' });
  check('USERNOTICE raid → isRaid', got && got.isRaid === true && got.timestamp === 1700000001000);

  tw.disconnect();
  check('disconnect zavře WS', MockWS.last.readyState === 3 && tw.connected === false);

  process.exit(fails ? 1 : 0);
});
