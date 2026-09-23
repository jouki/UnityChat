import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTerms } from './blacklist.js';

test('normalizeTerms: lowercase, ořez, bez prázdných a duplicit, max 60 znaků', () => {
  assert.deepEqual(normalizeTerms([' Kokot ', 'kokot', '', 'heil hitler', 'negroid*', 42, 'x'.repeat(61)]), ['kokot', 'heil hitler', 'negroid*', '42']);
  assert.deepEqual(normalizeTerms('kokot'), []);
  assert.deepEqual(normalizeTerms(null), []);
});
