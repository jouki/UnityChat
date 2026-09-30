import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendUcReply } from './accountSend.js';
import type { QuoteLookup } from './ucReplyVerify.js';

const lookup: QuoteLookup = async (platform, id) =>
  platform === 'kick' && id === 'k1' ? { platformUsername: 'Skutecny', content: 'pravý text ⠀', isUnitychatUser: true, deletedAt: null, hiddenAt: null } : null;

test('/chat/send: citace odpovědi vždy z archivu, podvržený autor/text se zahodí', async () => {
  const r = await sendUcReply({ ucReplyTo: { platform: 'kick', id: 'k1', username: 'Podvrh', message: 'vymyšlená citace' } }, lookup);
  assert.deepEqual(r, { platform: 'kick', id: 'k1', username: 'Skutecny', message: 'pravý text', authorUc: true });
});

test('/chat/send: zpráva mimo archiv → bez citace; nativní replyTo → žádná UC odpověď (lookup se nevolá)', async () => {
  assert.equal(await sendUcReply({ ucReplyTo: { platform: 'kick', id: 'neni', username: 'x', message: 'y' } }, lookup), null);
  let asked = 0;
  assert.equal(await sendUcReply({ replyTo: 'tw-1', ucReplyTo: { platform: 'kick', id: 'k1' } }, async () => { asked++; return null; }), null);
  assert.equal(asked, 0);
});
