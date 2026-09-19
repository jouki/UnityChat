import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeCursor, decodeCursor } from './cursor.js';

test('cursor roundtrip + odmítne nesmysly', () => {
  assert.equal(encodeCursor(1789820014396, 42), '1789820014396:42');
  assert.deepEqual(decodeCursor('1789820014396:42'), { sentAtMs: 1789820014396, id: 42 });
  assert.equal(decodeCursor(''), null);
  assert.equal(decodeCursor('abc:1'), null);
  assert.equal(decodeCursor('1:-5'), null);
  assert.equal(decodeCursor('1:2:3'), null);
});
