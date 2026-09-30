import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePrefs, DONOR_BADGE_DEFAULT } from './channelPrefs.js';

const D = { donorBadge: DONOR_BADGE_DEFAULT, donorSpeed: 3, donorStrength: 1, donorGapMin: 2, donorGapMax: 6, donorReplaceGlobal: false };
test('normalizePrefs: známá varianta projde, neznámá / prázdná → výchozí, cizí klíče se zahodí, animace v mezích', () => {
  assert.deepEqual(normalizePrefs({ donorBadge: 'money-bag' }), { ...D, donorBadge: 'money-bag' });
  assert.deepEqual(normalizePrefs({ donorBadge: 'nesmysl', foo: 1 }), D);
  assert.deepEqual(normalizePrefs(null), D);
  assert.deepEqual(normalizePrefs('x'), D);
  assert.deepEqual(normalizePrefs({ donorSpeed: 2.2, donorStrength: 0.6, donorGapMin: 10, donorGapMax: 4, donorReplaceGlobal: true }), { ...D, donorSpeed: 2.2, donorStrength: 0.6, donorGapMin: 10, donorGapMax: 10, donorReplaceGlobal: true }, 'gapMax ≥ gapMin');
  assert.deepEqual(normalizePrefs({ donorSpeed: 9, donorStrength: 'x', donorGapMin: -1, donorGapMax: 999 }), { ...D, donorGapMin: 0, donorGapMax: 120 });
});
