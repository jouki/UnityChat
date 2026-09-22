import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWorkspaces, workspacesFromEnv } from './zidolista.js';

test('normalizeWorkspaces: slug lowercase, kanály bez @, výchozí bot shared/JoukiBOT', () => {
  const out = normalizeWorkspaces({ ok: true, workspaces: [
    { slug: 'Rob', channels: { twitch: 'RobDiesALot', kick: 'robdiesalot', youtube: '@robdiesalot' }, bot: { mode: 'sb', displayName: 'JoukiBOT' } },
    { slug: 'jouki', channels: { twitch: null, kick: null, youtube: null }, bot: { mode: 'own', displayName: '  RobBot ', ownLogins: { twitch: 'RobBot', kick: '' } } },
    { slug: 'bad slug!', channels: {}, bot: {} },
    { slug: 'x', bot: { mode: 'weird' } },
  ] });
  assert.deepEqual(out, [
    { slug: 'rob', channels: { twitch: 'robdiesalot', kick: 'robdiesalot', youtube: 'robdiesalot' }, bot: { mode: 'sb', displayName: 'JoukiBOT' } },
    { slug: 'jouki', channels: { twitch: null, kick: null, youtube: null }, bot: { mode: 'own', displayName: 'RobBot', ownLogins: { twitch: 'robbot' } } },
    { slug: 'x', channels: { twitch: null, kick: null, youtube: null }, bot: { mode: 'sb', displayName: 'JoukiBOT' } },
  ]);
  assert.deepEqual(normalizeWorkspaces(null), []);
});

test('workspacesFromEnv: kanál=slug → jen Twitch, sdílený bot', () => {
  assert.deepEqual(workspacesFromEnv('robdiesalot=rob, uctest=uctest,bad'), [
    { slug: 'rob', channels: { twitch: 'robdiesalot', kick: null, youtube: null }, bot: { mode: 'shared', displayName: 'JoukiBOT' } },
    { slug: 'uctest', channels: { twitch: 'uctest', kick: null, youtube: null }, bot: { mode: 'shared', displayName: 'JoukiBOT' } },
  ]);
});
