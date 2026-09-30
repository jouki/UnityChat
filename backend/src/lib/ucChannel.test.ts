import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normPlatformChannel, pickUcChannel, ucChannelFor, clearUcChannelCache } from './ucChannel.js';

const url = process.env.TEST_DATABASE_URL;

test('normPlatformChannel: lowercase, ořez, YouTube bez úvodního @', () => {
  assert.equal(normPlatformChannel('  RobDieSalot  '), 'robdiesalot');
  assert.equal(normPlatformChannel('@RobDieSalot'), 'robdiesalot');
});

test('pickUcChannel: streamerův twitchLogin má přednost, jinak fallback (platformní kanál)', () => {
  assert.equal(pickUcChannel({ twitchLogin: 'robdiesalot' }, 'kick-slug'), 'robdiesalot');
  assert.equal(pickUcChannel({ twitchLogin: null }, 'kick-slug'), 'kick-slug');
  assert.equal(pickUcChannel(undefined, 'kick-slug'), 'kick-slug');
});

test('ucChannelFor: Twitch — ingest kanál je UC kanál rovnou, bez DB dotazu', async () => {
  clearUcChannelCache();
  assert.equal(await ucChannelFor('twitch', 'RobDieSalot'), 'robdiesalot');
});

test(
  'ucChannelFor: Kick/YouTube — mapování na streamers.twitch_login, fallback když streamer neexistuje',
  { skip: !url && 'TEST_DATABASE_URL není nastavené' },
  async () => {
    process.env.DATABASE_URL = url!;
    clearUcChannelCache();
    const { db, closeDb } = await import('../db/index.js');
    const { streamers } = await import('../db/schema.js');
    const { eq } = await import('drizzle-orm');
    const slug = 'uctest-kick-' + Date.now();
    try {
      await db.insert(streamers).values({ twitchLogin: 'robdiesalot', kickSlug: slug, verified: false });
      assert.equal(await ucChannelFor('kick', slug), 'robdiesalot');
      assert.equal(await ucChannelFor('youtube', '@neznamy-kanal-xyz'), 'neznamy-kanal-xyz');
    } finally {
      await db.delete(streamers).where(eq(streamers.kickSlug, slug));
      await closeDb();
    }
  },
);
