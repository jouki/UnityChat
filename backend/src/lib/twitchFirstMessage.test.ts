import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeFirstMessage, isTwitchRejected, NEW_ACCOUNT_MS } from './twitchFirstMessage.js';

const NOW = 1_800_000_000_000;
const deps = (has: boolean | Error, created: number | null | Error) => ({
  hasMessage: async () => { if (has instanceof Error) throw has; return has; },
  createdAt: async () => { if (created instanceof Error) throw created; return created; },
  now: () => NOW,
});
const P = { channel: 'robdiesalot', userId: '123' };

test('isTwitchRejected: jen obecné odmítnutí Twitche', () => {
  assert.equal(isTwitchRejected('twitch: Your message could not be sent, please try again later. [msg_rejected]'), true);
  assert.equal(isTwitchRejected('twitch: slow down [msg_ratelimit]'), false);
  assert.equal(isTwitchRejected('twitch: [msg_rejected_mandatory]'), false, 'AutoMod je jiný kód');
});

test('první zpráva: bez zprávy v archivu kanálu → ano (i starý účet)', async () => {
  assert.equal(await looksLikeFirstMessage(P, deps(false, NOW - 400 * 86400_000)), true);
});

test('účet mladší než 24 h → ano i se zprávou v archivu; starší se zprávou → ne', async () => {
  assert.equal(await looksLikeFirstMessage(P, deps(true, NOW - 60_000)), true);
  assert.equal(await looksLikeFirstMessage(P, deps(true, NOW - NEW_ACCOUNT_MS - 1)), false);
  assert.equal(await looksLikeFirstMessage(P, deps(true, null)), false, 'stáří nezjištěné');
});

test('chyba dotazů = radši původní hláška Twitche', async () => {
  assert.equal(await looksLikeFirstMessage(P, deps(new Error('db'), new Error('ivr'))), false);
  assert.equal(await looksLikeFirstMessage({ channel: 'robdiesalot', userId: '' }, deps(false, null)), false);
});
