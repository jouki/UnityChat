import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyUcReply } from './ucReplyVerify.js';

const row = (o = {}) => ({ platformUsername: 'RobDiesALot', content: 'ahoj ⠀', isUnitychatUser: false, deletedAt: null, hiddenAt: null, ...o });

test('verifyUcReply: citace z archivu, podvrh zahodit', async () => {
  const fake = { platform: 'twitch', id: 'x1', username: 'robdiesalot', message: 'vymyšlený text' };
  assert.deepEqual(await verifyUcReply(fake, async () => row()), { platform: 'twitch', id: 'x1', username: 'RobDiesALot', message: 'ahoj' });
  assert.equal(await verifyUcReply(fake, async () => null), null);
  assert.equal(await verifyUcReply(fake, async () => row({ deletedAt: new Date() })), null);
  assert.equal(await verifyUcReply(fake, async () => row({ hiddenAt: new Date() })), null);
  assert.equal((await verifyUcReply(fake, async () => row({ isUnitychatUser: true })))?.authorUc, true);
  assert.equal(await verifyUcReply(null, async () => row()), null);
});
