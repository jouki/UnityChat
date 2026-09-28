import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeFirstMessage, isTwitchRejected } from './twitchFirstMessage.js';

const deps = (has: boolean | Error) => ({ hasMessage: async () => { if (has instanceof Error) throw has; return has; } });
const P = { channel: 'robdiesalot', userId: '123' };

test('isTwitchRejected: jen obecné odmítnutí Twitche', () => {
  assert.equal(isTwitchRejected('twitch: Your message could not be sent, please try again later. [msg_rejected]'), true);
  assert.equal(isTwitchRejected('twitch: slow down [msg_ratelimit]'), false);
  assert.equal(isTwitchRejected('twitch: [msg_rejected_mandatory]'), false, 'AutoMod je jiný kód');
});

test('první zpráva: bez zprávy v archivu kanálu → ano; se zprávou → ne', async () => {
  assert.equal(await looksLikeFirstMessage(P, deps(false)), true);
  assert.equal(await looksLikeFirstMessage(P, deps(true)), false);
});

test('chyba dotazu / bez id = radši původní hláška Twitche', async () => {
  assert.equal(await looksLikeFirstMessage(P, deps(new Error('db'))), false);
  assert.equal(await looksLikeFirstMessage({ channel: 'robdiesalot', userId: '' }, deps(false)), false);
});
