import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNicknameNotify } from './nicknameNotify.js';

test('parseNicknameNotify: upsert, delete, neplatné', () => {
  assert.deepEqual(parseNicknameNotify('{"op":"upsert","platform":"twitch","username":"robdiesalot","nickname":"RobDiesALot","color":null}'),
    { event: 'nickname-change', data: { platform: 'twitch', username: 'robdiesalot', nickname: 'RobDiesALot', color: null } });
  assert.deepEqual(parseNicknameNotify('{"op":"delete","platform":"kick","username":"x"}'),
    { event: 'nickname-delete', data: { platform: 'kick', username: 'x' } });
  assert.equal(parseNicknameNotify('nope'), null);
  assert.equal(parseNicknameNotify('{"op":"upsert","platform":"twitch"}'), null);
});
