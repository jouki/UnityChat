// node scripts/test-personal-zw.js — zero-width u osobního 7TV setu (flags z API: položka 1, data 256)
const assert = require('node:assert/strict');

(async () => {
  const { EmoteManager } = await import('../extension/core/emotes.js');
  const em = new EmoteManager({ log: () => {} });
  const host = { url: '//cdn.7tv.app/emote/X', files: [{ name: '1x.webp', format: 'WEBP' }, { name: '2x.webp', format: 'WEBP' }] };
  em.learnUserEmotes('twitch', 'Jouki728', { emotes: [
    { name: 'LETSGO', flags: 0, data: { flags: 0, host } },
    { name: 'RAVE', flags: 1, data: { flags: 256, host } },
    { name: 'OnlyData', flags: 0, data: { flags: 256, host } },
  ] });
  assert.equal(em._getUserEmote('twitch', 'jouki728', 'RAVE')?.zw, true, 'položka flags=1');
  assert.equal(em._getUserEmote('twitch', 'jouki728', 'OnlyData')?.zw, true, 'data.flags=256');
  assert.equal(em._getUserEmote('twitch', 'jouki728', 'LETSGO')?.zw, false);
  const html = em.renderPlain ? em.renderTwitch('LETSGO RAVE', null, { platform: 'twitch', author: 'Jouki728' }) : '';
  assert.equal((html.match(/emote-stack/g) || []).length, 1, 'LETSGO + RAVE v jednom stacku: ' + html);
  console.log('personal zw: PASS');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
