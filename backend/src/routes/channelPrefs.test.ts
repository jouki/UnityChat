import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePrefs, DONOR_BADGE_DEFAULT } from './channelPrefs.js';

test('normalizePrefs: známá varianta projde, neznámá / prázdná → výchozí, cizí klíče se zahodí', () => {
  assert.deepEqual(normalizePrefs({ donorBadge: 'money-bag' }), { donorBadge: 'money-bag' });
  assert.deepEqual(normalizePrefs({ donorBadge: 'nesmysl', foo: 1 }), { donorBadge: DONOR_BADGE_DEFAULT });
  assert.deepEqual(normalizePrefs(null), { donorBadge: DONOR_BADGE_DEFAULT });
  assert.deepEqual(normalizePrefs('x'), { donorBadge: DONOR_BADGE_DEFAULT });
});
