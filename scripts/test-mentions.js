// node scripts/test-mentions.js — @přezdívka (i víceslovná) → login před odesláním (core/mentions.js)
const assert = require('node:assert/strict');

(async () => {
  const { nicknameEntries, resolveNicknameMentions, bareWords, hasBareMention, isUrlToken } = await import('../extension/core/mentions.js');
  const map = new Map([
    ['twitch:robdiesalot', { nickname: 'Naprostej Kokot' }],
    ['twitch:naprostej', { nickname: 'Naprostej' }],
    ['twitch:jouki728', { nickname: 'Jouki' }],
    ['youtube:robdiesalot', { nickname: 'Rob YT' }],
    ['twitch:bez', { nickname: '' }],
  ]);
  const tw = nicknameEntries(map, 'twitch');
  assert.deepEqual(tw.map((e) => e.login), ['robdiesalot', 'naprostej', 'jouki728'], 'jen platforma, nejdelší první, bez prázdných');
  const r = (t) => resolveNicknameMentions(t, tw, (l) => (l === 'robdiesalot' ? 'RobDiesALot' : l));
  assert.equal(r('@Naprostej Kokot ahoj'), '@RobDiesALot ahoj', 'víceslovná přezdívka');
  assert.equal(r('čau @naprostej kokot!'), 'čau @RobDiesALot!', 'velikost písmen + interpunkce za');
  assert.equal(r('@Naprostej Kokot'), '@RobDiesALot', 'konec textu');
  assert.equal(r('@Naprostej KokotX'), '@naprostej KokotX', 'hranice slova → kratší přezdívka „Naprostej"');
  assert.equal(r('@Naprostej ahoj'), '@naprostej ahoj', 'jednoslovná');
  assert.equal(r('@Jouki a @Naprostej Kokot'), '@jouki728 a @RobDiesALot', 'víc zmínek');
  assert.equal(r('mail@Jouki'), 'mail@Jouki', 'uvnitř slova ne');
  assert.equal(r('@@Jouki'), '@@Jouki', 'dvojité @ ne');
  assert.equal(r('@Neznamy Clovek'), '@Neznamy Clovek', 'neznámá přezdívka beze změny');
  assert.equal(r('bez zmínky'), 'bez zmínky');
  assert.equal(resolveNicknameMentions('@Rob YT', nicknameEntries(map, 'youtube')), '@robdiesalot', 'jiná platforma');

  // Stejná přezdívka u dvou loginů platformy (starý handle) → přednost má ten, kdo v chatu píše.
  const dup = new Map([['youtube:marekjoukal287', { nickname: 'Jouki' }], ['youtube:jouki728', { nickname: 'Jouki' }]]);
  assert.equal(resolveNicknameMentions('@Jouki ahoj', nicknameEntries(dup, 'youtube', (l) => l === 'jouki728')), '@jouki728 ahoj', 'známý login první');
  assert.equal(resolveNicknameMentions('@Jouki ahoj', nicknameEntries(dup, 'youtube')), '@marekjoukal287 ahoj', 'bez znalosti chatu pořadí mapy');

  // Jména bez zavináče: jen celá slova (i s diakritikou), ne v adrese.
  const words = (t) => bareWords(t).map((w) => w.word);
  assert.deepEqual(words('hrál s kamošem po telefonu'), ['hrál', 'kamošem', 'telefonu'], '„kamo“ uvnitř „kamošem“ není slovo');
  assert.equal(hasBareMention('hrál warcrafty s kamošem', 'kamo'), false);
  assert.equal(hasBareMention('čau kamo, jak je', 'kamo'), true);
  assert.equal(hasBareMention('to byl jouki!', 'jouki'), true, 'interpunkce za jménem');
  assert.equal(hasBareMention('to byl jouki.', 'jouki'), true, 'tečka na konci věty není adresa');
  assert.equal(hasBareMention('joukibot to smazal', 'jouki'), false);
  assert.equal(hasBareMention('šjouki', 'jouki'), false, 'písmeno s diakritikou před jménem');
  assert.equal(hasBareMention('ahoj @jouki', 'jouki'), false, 'se zavináčem řeší hasMention');
  assert.equal(hasBareMention('ahoj jo', 'jo'), false, 'kratší než 3 znaky ne');
  for (const u of ['www.robdiesalot.com/chat', 'https://www.robdiesalot.com/chat/', 'robdiesalot.com', 'koukni na https://jouki.cz/unitychat.', 'twitch.tv/robdiesalot'])
    assert.equal(hasBareMention(u, 'robdiesalot') || hasBareMention(u, 'jouki') || hasBareMention(u, 'unitychat'), false, `adresa: ${u}`);
  assert.equal(hasBareMention('robdiesalot je live', 'robdiesalot'), true);
  assert.equal(isUrlToken('Jouki.'), false);
  assert.equal(isUrlToken('jouki.cz'), true);
  assert.deepEqual(bareWords('ab abc').map((w) => w.index), [3]);
  console.log('mentions: PASS');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
