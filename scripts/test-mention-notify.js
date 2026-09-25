// node scripts/test-mention-notify.js — upozornění na zmínky (core/mention-notify.js)
const assert = require('node:assert/strict');

(async () => {
  const m = await import('../extension/core/mention-notify.js');
  const my = new Set(['jouki728', 'jouki']);

  // hasMention — celé slovo
  assert.equal(m.hasMention('ahoj @jouki', 'jouki'), true);
  assert.equal(m.hasMention('ahoj @joukibot', 'jouki'), false, 'delší jméno není zmínka');
  assert.equal(m.hasMention('mail@jouki', 'jouki'), false, 'uprostřed slova ne');
  assert.equal(m.hasMention('@jouki, čau', 'jouki'), true);
  assert.equal(m.hasMention('', 'jouki'), false);

  // mentionKind — odpověď má přednost
  assert.equal(m.mentionKind({ text: '@Jouki728 díky', myNames: my }), 'mention');
  assert.equal(m.mentionKind({ text: 'díky', replyTarget: '@Jouki', myNames: my }), 'reply');
  assert.equal(m.mentionKind({ text: '@jouki', replyTarget: 'jouki', myNames: my }), 'reply');
  assert.equal(m.mentionKind({ text: 'nic', replyTarget: 'cizi', myNames: my }), null);
  assert.equal(m.mentionKind({ text: '@jouki', myNames: new Set() }), null, 'bez jmen nic');
  assert.equal(m.mentionKind({ text: '@jouki', myNames: ['jouki'] }), 'mention', 'pole jmen');

  // shouldNotify
  const base = { enabled: true, kind: 'mention', historical: false, own: false, moderated: false, watching: false };
  assert.deepEqual(m.shouldNotify(base), { ok: true, reason: 'mention' });
  assert.equal(m.shouldNotify({ ...base, enabled: false }).reason, 'off');
  assert.equal(m.shouldNotify({ ...base, kind: null }).reason, 'none');
  assert.equal(m.shouldNotify({ ...base, historical: true }).reason, 'history');
  assert.equal(m.shouldNotify({ ...base, own: true }).reason, 'own');
  assert.equal(m.shouldNotify({ ...base, moderated: true }).reason, 'moderated');
  assert.equal(m.shouldNotify({ ...base, watching: true }).reason, 'watching');

  // notificationText
  assert.equal(m.notificationText('ahoj ⠀'), 'ahoj', 'UC marker pryč');
  assert.equal(m.notificationText('a  [emote:123:Kappa]\n b'), 'a Kappa b');
  const long = m.notificationText('x'.repeat(300));
  assert.equal([...long].length, 140);
  assert.ok(long.endsWith('…'));
  assert.equal([...m.notificationText('😀'.repeat(200), 10)].length, 10, 'emoji se nepůlí');

  // formatNotification
  assert.deepEqual(
    m.formatNotification({ platform: 'twitch', username: 'Rob', message: '@jouki ahoj ⠀' }, 'mention', { channel: 'robdiesalot' }),
    { title: 'Zmínka od Rob', message: '@jouki ahoj', contextMessage: 'Twitch · robdiesalot' },
  );
  const r = m.formatNotification({ platform: 'youtube', username: '@Pepa', message: 'jo' }, 'reply', { displayName: 'Pepík', channel: '@rob' });
  assert.equal(r.title, 'Odpověď od Pepík');
  assert.equal(r.contextMessage, 'YouTube · rob');

  // moreLabel + withMore
  assert.equal(m.moreLabel(1), 'a 1 další zpráva');
  assert.equal(m.moreLabel(3), 'a 3 další zprávy');
  assert.equal(m.moreLabel(5), 'a 5 dalších zpráv');
  assert.equal(m.withMore({ contextMessage: 'Kick · x' }, 2).contextMessage, 'Kick · x (a 2 další zprávy)');
  assert.equal(m.withMore({ contextMessage: 'Kick' }, 0).contextMessage, 'Kick');

  // createMentionNotifier — dedup + throttle + sloučení
  let t = 1000;
  const timers = [];
  const out = [];
  const n = m.createMentionNotifier({
    emit: (note, more) => out.push([note.title, more]),
    now: () => t,
    setTimer: (fn, ms) => { timers.push({ fn, at: t + ms }); return timers.length; },
    clearTimer: () => { timers.length = 0; },
  });
  assert.equal(n.offer('a', { title: 'A' }), 'shown');
  assert.equal(n.offer('a', { title: 'A' }), 'dup', 'stejné id podruhé ne');
  t = 2000;
  assert.equal(n.offer('b', { title: 'B' }), 'queued');
  assert.equal(n.offer('c', { title: 'C' }), 'queued');
  assert.equal(n.offer('d', { title: 'D' }), 'queued');
  assert.equal(timers.length, 1, 'jeden časovač na okno');
  assert.equal(timers[0].at, 6000, 'flush na konci okna');
  assert.deepEqual(out, [['A', 0]]);
  t = 6000; timers.shift().fn();
  assert.deepEqual(out, [['A', 0], ['D', 2]], 'poslední + 2 další');
  t = 8000;
  assert.equal(n.offer('e', { title: 'E' }), 'queued', 'po flushi znovu okno');
  n.reset();
  t = 20000;
  assert.equal(n.offer('f', { title: 'F' }), 'shown');
  assert.deepEqual(out.at(-1), ['F', 0]);

  console.log('test-mention-notify: OK');
})().catch((e) => { console.error(e); process.exit(1); });
