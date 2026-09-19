import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIngestChannels } from './channels.js';

test('parseIngestChannels: prázdné = nic', () => {
  assert.deepEqual(parseIngestChannels(''), []);
  assert.deepEqual(parseIngestChannels('   '), []);
});

test('parseIngestChannels: tři platformy, lowercase, trim', () => {
  assert.deepEqual(
    parseIngestChannels('twitch:RobDiesALot, kick:robdiesalot ,youtube:robdiesalot'),
    [
      { platform: 'twitch', channel: 'robdiesalot' },
      { platform: 'kick', channel: 'robdiesalot' },
      { platform: 'youtube', channel: 'robdiesalot' },
    ],
  );
});

test('parseIngestChannels: neznámá platforma nebo chybějící kanál → throw', () => {
  assert.throws(() => parseIngestChannels('discord:x'), /neznámá platforma/);
  assert.throws(() => parseIngestChannels('twitch:'), /chybí kanál/);
});
