import { test } from 'node:test';
import assert from 'node:assert/strict';
import { donorNickname } from './donate.js';

test('donorNickname: display name platformy, jinak login, max 40 znaků', () => {
  assert.equal(donorNickname({ displayName: ' Jouki728 ', login: 'jouki728' }), 'Jouki728');
  assert.equal(donorNickname({ displayName: null, login: 'jouki728' }), 'jouki728');
  assert.equal(donorNickname({ displayName: 'x'.repeat(60), login: 'a' }).length, 40);
});
