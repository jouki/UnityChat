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

  // Moderátorské výročí (podklad 2026-09-27-twitch-vyroci-research.md §3): msg-param-months + text uživatele.
  got = null;
  MockWS.last.onmessage({ data: '@badge-info=subscriber/30;badges=moderator/1,subscriber/24;color=#00FF7F;display-name=ModPepa;emotes=25:14-18;id=mv1;login=modpepa;mod=1;msg-id=modiversary;msg-param-months=24;room-id=160028137;system-msg=ModPepa\\shas\\sbeen\\sa\\smoderator;tmi-sent-ts=1700000002000;user-id=4242 :tmi.twitch.tv USERNOTICE #robdiesalot :dva roky už! Kappa\r\n' });
  check('USERNOTICE modiversary → isModiversary + modMonths', got && got.isModiversary === true && got.modMonths === 24 && got.id === 'mv1');
  check('modiversary: text uživatele, emoty, badge, čas, userId', got && got.message === 'dva roky už! Kappa' && got.twitchEmotes === '25:14-18'
    && got.badgesRaw === 'moderator/1,subscriber/24' && got.timestamp === 1700000002000 && got.userId === '4242' && got.username === 'ModPepa' && got.color === '#00FF7F');
  got = null;
  MockWS.last.onmessage({ data: '@display-name=Tichý;id=mv2;login=tichy;msg-id=modiversary;msg-param-months=3;user-id=5 :tmi.twitch.tv USERNOTICE #robdiesalot\r\n' });
  check('modiversary bez textu → prázdná zpráva, 3 měsíce', got && got.isModiversary && got.modMonths === 3 && got.message === '');

  // Sdílený resub: text uživatele, měsíce a série (jen se should-share-streak=1).
  got = null;
  MockWS.last.onmessage({ data: '@badges=subscriber/6;color=;display-name=Subík;emotes=;id=rs1;login=subik;msg-id=resub;msg-param-cumulative-months=7;msg-param-should-share-streak=1;msg-param-streak-months=3;msg-param-sub-plan=1000;tmi-sent-ts=1700000003000;user-id=77 :tmi.twitch.tv USERNOTICE #robdiesalot :sedm měsíců s Robem\r\n' });
  check('resub: text uživatele + měsíce + série', got && got.isSubEvent && got.message === 'sedm měsíců s Robem' && got.subMonths === 7 && got.subStreak === 3);

  // Neznámý typ: nevykreslí se, log jen msg-id a názvy tagů (bez hodnot a textu), každý typ jednou.
  got = null;
  logs.length = 0;
  const unk = '@display-name=Tajný;id=u1;login=tajny;msg-id=useranniversary;msg-param-years=3;user-id=1 :tmi.twitch.tv USERNOTICE #robdiesalot :tajný text\r\n';
  MockWS.last.onmessage({ data: unk });
  MockWS.last.onmessage({ data: unk.replace('id=u1', 'id=u2') });
  const un = logs.filter((l) => l.startsWith('UserNotice '));
  check('neznámý USERNOTICE → žádná zpráva', got === null);
  check('neznámý USERNOTICE → log UserNotice jednou, jen msg-id a názvy tagů', un.length === 1
    && un[0] === 'UserNotice neznámý msg-id=useranniversary tagy=display-name,id,login,msg-id,msg-param-years,user-id'
    && !un[0].includes('Tajný') && !un[0].includes('tajný text'));

  tw.disconnect();
  check('disconnect zavře WS', MockWS.last.readyState === 3 && tw.connected === false);

  process.exit(fails ? 1 : 0);
});
