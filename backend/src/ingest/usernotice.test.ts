import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTwitchUsernotice, parseIrcLine, isTwitchNotice, unknownUsernotice, toRow } from './normalize.js';
import { TwitchListener } from './twitch.js';
import { toClientMessage } from '../routes/chat.js';
import type { IngestMessage } from './types.js';

// Tvar podle podkladu docs/superpowers/specs/2026-09-27-twitch-vyroci-research.md §3 (IRC USERNOTICE).
const MODIV = '@badge-info=subscriber/30;badges=moderator/1,subscriber/24;color=#00FF7F;display-name=ModPepa;emotes=25:14-18;'
  + 'id=mv-1;login=modpepa;mod=1;msg-id=modiversary;msg-param-months=24;room-id=160028137;'
  + 'system-msg=ModPepa\\shas\\sbeen\\sa\\smoderator\\sfor\\s24\\smonths!;tmi-sent-ts=1790000000000;user-id=4242;user-type=mod '
  + ':tmi.twitch.tv USERNOTICE #robdiesalot :dva roky už! Kappa';
const RESUB = '@badge-info=subscriber/7;badges=subscriber/6;color=;display-name=Subík;emotes=;id=rs-1;login=subik;mod=0;'
  + 'msg-id=resub;msg-param-cumulative-months=7;msg-param-months=0;msg-param-should-share-streak=1;msg-param-streak-months=3;'
  + 'msg-param-sub-plan=1000;msg-param-sub-plan-name=Channel\\sSub;tmi-sent-ts=1790000001000;user-id=77 '
  + ':tmi.twitch.tv USERNOTICE #robdiesalot :sedm měsíců s Robem';

test('normalizeTwitchUsernotice: modiversary → zpráva s textem uživatele, měsíci, emoty a badge', () => {
  const m = normalizeTwitchUsernotice(MODIV, 'RobDiesALot')!;
  assert.equal(m.platform, 'twitch');
  assert.equal(m.platformMessageId, 'mv-1');
  assert.equal(m.platformUserId, '4242');
  assert.equal(m.username, 'ModPepa');
  assert.equal(m.channel, 'robdiesalot');
  assert.equal(m.content, 'dva roky už! Kappa');
  assert.equal(m.sentAt.getTime(), 1790000000000);
  assert.equal(m.isReply, false);
  assert.deepEqual(m.contentRaw.notice, { type: 'modiversary', months: 24 });
  assert.equal(m.contentRaw.login, 'modpepa');
  assert.equal(m.contentRaw.emotes, '25:14-18');
  assert.equal(m.contentRaw.badges, 'moderator/1,subscriber/24');
  assert.equal(m.contentRaw.color, '#00FF7F');
  assert.ok(isTwitchNotice(m));
});

test('normalizeTwitchUsernotice: resub → kumulativní měsíce, sdílená série, tier', () => {
  const m = normalizeTwitchUsernotice(RESUB, 'robdiesalot')!;
  assert.equal(m.content, 'sedm měsíců s Robem');
  assert.equal(m.username, 'Subík');
  assert.deepEqual(m.contentRaw.notice, { type: 'resub', months: 7, streak: 3, plan: '1000' });
  assert.equal(m.contentRaw.color, null);
});

test('normalizeTwitchUsernotice: série jen se should-share-streak=1, sub bez textu, bez id → null', () => {
  const noStreak = RESUB.replace('msg-param-should-share-streak=1', 'msg-param-should-share-streak=0');
  assert.deepEqual(normalizeTwitchUsernotice(noStreak, 'c')!.contentRaw.notice, { type: 'resub', months: 7, streak: null, plan: '1000' });
  const sub = '@display-name=Nový;id=s-1;login=novy;msg-id=sub;msg-param-cumulative-months=1;msg-param-sub-plan=Prime;tmi-sent-ts=1;user-id=5 :tmi.twitch.tv USERNOTICE #c';
  const s = normalizeTwitchUsernotice(sub, 'c')!;
  assert.equal(s.content, '');
  assert.deepEqual(s.contentRaw.notice, { type: 'sub', months: 1, streak: null, plan: 'Prime' });
  assert.equal(normalizeTwitchUsernotice(MODIV.replace('id=mv-1;', ''), 'c'), null);
});

test('normalizeTwitchUsernotice: raid / neznámý typ / PRIVMSG → null (neukládá se)', () => {
  assert.equal(normalizeTwitchUsernotice('@id=r;msg-id=raid;msg-param-viewerCount=5;user-id=1 :tmi.twitch.tv USERNOTICE #c', 'c'), null);
  assert.equal(normalizeTwitchUsernotice('@id=u;msg-id=useranniversary;msg-param-years=3;user-id=1 :tmi.twitch.tv USERNOTICE #c :x', 'c'), null);
  assert.equal(normalizeTwitchUsernotice('@id=p;user-id=1 :a!a@a PRIVMSG #c :hi', 'c'), null);
});

test('unknownUsernotice: neznámý msg-id → jen msg-id a názvy tagů, známé → null', () => {
  const u = unknownUsernotice(parseIrcLine('@display-name=Tajný;id=x;login=tajny;msg-id=useranniversary;msg-param-years=3;user-id=1 :tmi.twitch.tv USERNOTICE #c :ahoj')!);
  assert.deepEqual(u, { msgId: 'useranniversary', tags: ['display-name', 'id', 'login', 'msg-id', 'msg-param-years', 'user-id'] });
  assert.ok(!JSON.stringify(u).includes('Tajný'), 'žádné hodnoty tagů ani text');
  for (const id of ['raid', 'sub', 'resub', 'subgift', 'submysterygift', 'viewermilestone', 'announcement', 'modiversary']) {
    assert.equal(unknownUsernotice(parseIrcLine(`@id=x;msg-id=${id} :tmi.twitch.tv USERNOTICE #c`)!), null, id);
  }
});

test('toClientMessage: uložené výročí → stejný tvar jako core parser (isModiversary / isSubEvent)', () => {
  const mv = toClientMessage(toRow(normalizeTwitchUsernotice(MODIV, 'robdiesalot')!), true);
  assert.equal(mv.isModiversary, true);
  assert.equal(mv.modMonths, 24);
  assert.equal(mv.message, 'dva roky už! Kappa');
  assert.equal(mv.twitchEmotes, '25:14-18');
  assert.equal(mv.badgesRaw, 'moderator/1,subscriber/24');
  assert.equal(mv.isSubEvent, undefined);
  const rs = toClientMessage(toRow(normalizeTwitchUsernotice(RESUB, 'robdiesalot')!), false);
  assert.equal(rs.isSubEvent, true);
  assert.equal(rs.subMonths, 7);
  assert.equal(rs.subStreak, 3);
  assert.equal(rs.subPlan, '1000');
  assert.equal(rs.message, 'sedm měsíců s Robem');
  assert.equal(rs.historical, false);
  assert.equal(rs.isModiversary, undefined);
});

class FakeWs {
  static instances: FakeWs[] = [];
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(public url: string) { FakeWs.instances.push(this); }
  send(s: string) { this.sent.push(s); }
  close() { this.onclose?.(); }
}

test('TwitchListener: USERNOTICE modiversary/resub → onMessage, neznámý typ jen info log (jednou), raid nic', () => {
  FakeWs.instances = [];
  const got: IngestMessage[] = [];
  const infos: Array<{ o: object; msg: string }> = [];
  const log = { info: (o: object, msg: string) => infos.push({ o, msg }), warn() {}, error() {} };
  const l = new TwitchListener('robdiesalot', (m) => got.push(m), { WebSocketCtor: FakeWs as unknown as typeof WebSocket, log });
  l.start();
  const ws = FakeWs.instances[0];
  ws.onopen?.();
  ws.onmessage?.({ data: `${MODIV}\r\n${RESUB}\r\n` });
  ws.onmessage?.({ data: '@id=r;msg-id=raid;msg-param-viewerCount=5;user-id=1 :tmi.twitch.tv USERNOTICE #robdiesalot\r\n' });
  const unk = '@display-name=Tajný;id=u1;login=tajny;msg-id=useranniversary;msg-param-years=3;user-id=1 :tmi.twitch.tv USERNOTICE #robdiesalot :tajný text\r\n';
  ws.onmessage?.({ data: unk });
  ws.onmessage?.({ data: unk.replace('id=u1', 'id=u2') });
  assert.deepEqual(got.map((m) => m.platformMessageId), ['mv-1', 'rs-1']);
  const unknownLogs = infos.filter((i) => /neznámý USERNOTICE/.test(i.msg));
  assert.equal(unknownLogs.length, 1, 'stejný neznámý typ se loguje jednou');
  assert.deepEqual(unknownLogs[0].o, { channel: 'robdiesalot', msgId: 'useranniversary', tags: ['display-name', 'id', 'login', 'msg-id', 'msg-param-years', 'user-id'] });
  assert.ok(!JSON.stringify(infos).includes('tajný text') && !JSON.stringify(infos).includes('Tajný'));
  l.stop();
});
