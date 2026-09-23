// node scripts/test-mentions.js — @přezdívka (i víceslovná) → login před odesláním (core/mentions.js)
const assert = require('node:assert/strict');

(async () => {
  const { nicknameEntries, resolveNicknameMentions } = await import('../extension/core/mentions.js');
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
  console.log('mentions: PASS');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
