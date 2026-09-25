import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUserTargets, type TargetDeps } from './moderationTargets.js';
import type { Platform } from './zidolista.js';

const channels: Record<Platform, string | null> = { twitch: 'robdiesalot', kick: 'robdiesalot', youtube: null };

function deps(over: Partial<TargetDeps> = {}): TargetDeps {
  return {
    platformChannel: async (_c, p) => channels[p],
    archivedLogin: async (platform, pch, userId) => (platform === 'twitch' && pch === 'robdiesalot' && userId === 't1' ? 'Spammer' : null),
    accountOf: async (platform, userId) => (platform === 'twitch' && userId === 't1' ? 50 : null),
    accountIdentities: async () => [
      { platform: 'twitch', userId: 't1', login: 'spammer' },
      { platform: 'kick', userId: '77', login: 'Spammer_K' },
      { platform: 'youtube', userId: 'UCx', login: 'spammeryt' },
    ],
    ...over,
  };
}

test('resolveUserTargets: login z archivu (lowercase), propojené identity jen na platformách kanálu', async () => {
  const r = await resolveUserTargets('robdiesalot', 'twitch', 't1', deps());
  assert.deepEqual(r, {
    primary: { platform: 'twitch', userId: 't1', login: 'spammer' },
    all: [{ platform: 'twitch', userId: 't1', login: 'spammer' }, { platform: 'kick', userId: '77', login: 'spammer_k' }],
    accountId: 50,
  });
});

test('resolveUserTargets: uživatel v archivu kanálu nepsal → null (cíl musí patřit kanálu)', async () => {
  assert.equal(await resolveUserTargets('robdiesalot', 'twitch', 'cizi', deps()), null);
});

test('resolveUserTargets: kanál nemá platformu v registru → null (archiv se ani nedotazuje)', async () => {
  let asked = 0;
  const r = await resolveUserTargets('robdiesalot', 'youtube', 'UCx', deps({ archivedLogin: async () => { asked++; return 'x'; } }));
  assert.equal(r, null);
  assert.equal(asked, 0);
});

test('resolveUserTargets: bez UC účtu jen platforma zprávy', async () => {
  const r = await resolveUserTargets('robdiesalot', 'twitch', 't1', deps({ accountOf: async () => null }));
  assert.equal(r!.all.length, 1);
  assert.equal(r!.accountId, null);
});
