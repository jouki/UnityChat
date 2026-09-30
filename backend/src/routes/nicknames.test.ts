import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownsHandle } from './nicknames.js';

const ids = [{ platform: 'twitch', login: 'Jouki728' }, { platform: 'youtube', login: '@Jouki' }] as const;

test('ownsHandle: jen vlastní identita na stejné platformě', () => {
  assert.equal(ownsHandle([...ids], 'twitch', 'jouki728'), true);
  assert.equal(ownsHandle([...ids], 'twitch', '@JOUKI728'), true);
  assert.equal(ownsHandle([...ids], 'youtube', 'jouki'), true);
  assert.equal(ownsHandle([...ids], 'kick', 'jouki728'), false);
  assert.equal(ownsHandle([...ids], 'twitch', 'robdiesalot'), false);
  assert.equal(ownsHandle([], 'twitch', 'jouki728'), false);
});
