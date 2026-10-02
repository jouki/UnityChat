import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RawSettings } from './rawProfiles.js';

test('RawSettings: volba announcementů (annc) — 0 / 1 / boolean, jiné hodnoty a neznámé klíče odmítnuté', () => {
  for (const annc of ['0', '1', true, false]) assert.equal(RawSettings.safeParse({ annc, gifs: '1' }).success, true, String(annc));
  assert.equal(RawSettings.safeParse({ annc: 'ne' }).success, false);
  assert.equal(RawSettings.safeParse({ announcements: '0' }).success, false, 'strict');
});
