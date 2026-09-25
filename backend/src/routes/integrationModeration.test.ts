import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IntegrationModBody, runIntegrationModeration, runIntegrationUserModeration, type IntegrationModDeps, type IntegrationUserModDeps } from './integrationModeration.js';
import type { UserActionDeps } from '../lib/userModActions.js';
import type { UserModeratedParams } from '../lib/userModeration.js';
import type { BanParams } from '../lib/modActions.js';
import type { WorkspaceInfo } from '../lib/zidolista.js';

const ws: WorkspaceInfo = { slug: 'rob', channels: { twitch: 'robdiesalot', kick: 'robkick', youtube: null }, bot: { mode: 'shared', displayName: 'JoukiBOT' } };
const actor = { source: 'zidolista', userId: '7', name: 'Jouki', role: 'owner' };

function mkDeps(over: Partial<IntegrationModDeps> = {}) {
  const log: { name: string; args: unknown[] }[] = [];
  const rec = (name: string) => async (...args: unknown[]) => { log.push({ name, args }); };
  const deps: IntegrationModDeps = {
    workspaceBySlug: async (s) => (s === 'rob' ? ws : null),
    messageChannel: async (platform) => (platform === 'kick' ? 'robkick' : 'robdiesalot'),
    publishDeleted: rec('publishDeleted') as IntegrationModDeps['publishDeleted'],
    deleteAsBot: async (p) => { log.push({ name: 'deleteAsBot', args: [p] }); return 'bot'; },
    publishHidden: async (p) => { log.push({ name: 'publishHidden', args: [p] }); return 'ok'; },
    publishUnhidden: async (p) => { log.push({ name: 'publishUnhidden', args: [p] }); return 'ok'; },
    recordAction: rec('recordAction') as IntegrationModDeps['recordAction'],
    log: { warn: () => {}, info: () => {} },
    ...over,
  };
  return { deps, log };
}

test('IntegrationModBody: actor povinný a source = zidolista', () => {
  assert.equal(IntegrationModBody.safeParse({ platform: 'twitch', messageId: 'm1', actor }).success, true);
  assert.equal(IntegrationModBody.safeParse({ platform: 'twitch', messageId: 'm1' }).success, false);
  assert.equal(IntegrationModBody.safeParse({ platform: 'twitch', messageId: 'm1', actor: { ...actor, source: 'jinde' } }).success, false);
  assert.equal(IntegrationModBody.safeParse({ platform: 'twitch', messageId: 'm1', actor: { ...actor, userId: '' } }).success, false);
  assert.equal(IntegrationModBody.safeParse({ platform: 'discord', messageId: 'm1', actor }).success, false);
});

test('špatné tělo → 400 body, neznámý slug → 404 unknown_workspace', async () => {
  const { deps, log } = mkDeps();
  assert.deepEqual(await runIntegrationModeration('delete', 'rob', { platform: 'twitch' }, deps), { status: 400, body: { ok: false, error: 'body' } });
  assert.deepEqual(await runIntegrationModeration('hide', 'nikdo', { platform: 'twitch', messageId: 'm1', actor }, deps), { status: 404, body: { ok: false, error: 'unknown_workspace' } });
  assert.equal(log.length, 0);
});

test('delete: SSE (reason mod, by zidolista:<id>) → smazání botem → moderation_actions bez účtu', async () => {
  const { deps, log } = mkDeps();
  const r = await runIntegrationModeration('delete', 'Rob', { platform: 'twitch', messageId: 'm1', actor }, deps);
  assert.deepEqual(r, { status: 200, body: { ok: true, result: 'bot' } });
  assert.deepEqual(log.map((l) => l.name), ['publishDeleted', 'deleteAsBot', 'recordAction']);
  assert.deepEqual(log[0].args[0], { channel: 'robdiesalot', platform: 'twitch', messageId: 'm1', by: 'zidolista:7', reason: 'mod', expectedChannel: 'robdiesalot' });
  assert.deepEqual(log[1].args[0], { channel: 'robdiesalot', platform: 'twitch', messageId: 'm1' });
  assert.deepEqual(log[2].args[0], {
    channel: 'robdiesalot', accountId: null, actor: 'zidolista:7', action: 'delete', platform: 'twitch',
    targetMessageId: 'm1', params: { actor }, result: { twitch: 'bot' },
  });
});

test('delete: výjimka platformy po SSE → 200 s error:exception, záznam se zapíše', async () => {
  const { deps, log } = mkDeps({ deleteAsBot: async () => { throw new Error('síť'); } });
  const r = await runIntegrationModeration('delete', 'rob', { platform: 'twitch', messageId: 'm1', actor }, deps);
  assert.deepEqual(r, { status: 200, body: { ok: true, result: 'error:exception' } });
  assert.deepEqual((log.at(-1)!.args[0] as { result: object }).result, { twitch: 'error:exception' });
});

test('delete: zpráva z cizího kanálu (jiný workspace) → error:not_found, nic se nemaže', async () => {
  const { deps, log } = mkDeps({ messageChannel: async () => 'cizikanal' });
  const r = await runIntegrationModeration('delete', 'rob', { platform: 'twitch', messageId: 'm1', actor }, deps);
  assert.deepEqual(r, { status: 200, body: { ok: true, result: 'error:not_found' } });
  assert.deepEqual(log.map((l) => l.name), []);
});

test('hide: Kick zpráva workspace → publishHidden s UC kanálem, záznam hide s result {}', async () => {
  const { deps, log } = mkDeps();
  const r = await runIntegrationModeration('hide', 'rob', { platform: 'kick', messageId: 'k1', actor }, deps);
  assert.deepEqual(r, { status: 200, body: { ok: true, result: 'ok' } });
  assert.deepEqual(log[0], { name: 'publishHidden', args: [{ channel: 'robdiesalot', platform: 'kick', messageId: 'k1', by: 'zidolista:7' }] });
  assert.deepEqual(log[1].args[0], {
    channel: 'robdiesalot', accountId: null, actor: 'zidolista:7', action: 'hide', platform: 'kick',
    targetMessageId: 'k1', params: { actor }, result: {},
  });
});

test('unhide: neznámá zpráva → not_found (ok: true)', async () => {
  const { deps, log } = mkDeps({ messageChannel: async () => null });
  const r = await runIntegrationModeration('unhide', 'rob', { platform: 'twitch', messageId: 'zz', actor }, deps);
  assert.deepEqual(r, { status: 200, body: { ok: true, result: 'not_found' } });
  assert.equal(log.length, 0);
});

test('unhide: publishUnhidden, záznam unhide', async () => {
  const { deps, log } = mkDeps();
  const r = await runIntegrationModeration('unhide', 'rob', { platform: 'twitch', messageId: 'm1', actor }, deps);
  assert.deepEqual(r, { status: 200, body: { ok: true, result: 'ok' } });
  assert.equal(log[0].name, 'publishUnhidden');
  assert.equal((log[1].args[0] as { action: string }).action, 'unhide');
});

// ---- část 2: timeout / ban / unban z Chat Logu ----
function userDeps() {
  const seen: { ws: string[]; resolve: unknown[]; published: UserModeratedParams[]; bans: BanParams[] } = { ws: [], resolve: [], published: [], bans: [] };
  const deps: IntegrationUserModDeps = {
    workspaceBySlug: async (s) => (s === 'rob' ? ws : null),
    userActionDeps: (w): UserActionDeps => {
      seen.ws.push(w.slug);
      return {
        resolveTargets: async (channel, platform, userId) => {
          seen.resolve.push({ channel, platform, userId });
          return userId === '77' ? { primary: { platform: 'kick', userId: '77', login: 'k' }, all: [{ platform: 'kick', userId: '77', login: 'k' }], accountId: null }
            : userId === '88' ? { primary: { platform: 'kick', userId: '88', login: 'modk' }, all: [{ platform: 'kick', userId: '88', login: 'modk' }], accountId: null } : null;
        },
        targetRole: async (_c, t) => (t.login === 'modk' ? 'moderator' : 'viewer'),
        publish: async (p) => { seen.published.push(p); },
        ban: async (p) => { seen.bans.push(p); return { result: 'bot' }; },
        unban: async () => 'bot',
        activeBan: async () => null,
        recordBan: async () => {},
        clearBan: async () => {},
        recordAction: async () => {},
        now: () => 1,
        log: { warn: () => {}, info: () => {} },
      };
    },
  };
  return { deps, seen };
}

test('integrace timeout: kanál JEN ze slugu, bot (accountId null), by zidolista:<id>', async () => {
  const { deps, seen } = userDeps();
  const r = await runIntegrationUserModeration('timeout', 'ROB', { platform: 'kick', userId: '77', durationSec: 600, reason: 'spam', actor }, deps);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results, { kick: 'bot' });
  assert.deepEqual(seen.ws, ['rob']);
  assert.deepEqual(seen.resolve, [{ channel: 'robdiesalot', platform: 'kick', userId: '77' }]);
  assert.equal(seen.published[0].by, 'zidolista:7');
  assert.equal(seen.bans[0].accountId, null);
  assert.equal(seen.bans[0].durationSec, 600);
});

test('integrace: timeout bez durationSec 400, neznámý slug 404, cíl mimo workspace 200 not_found, bez actor 400', async () => {
  const { deps, seen } = userDeps();
  assert.equal((await runIntegrationUserModeration('timeout', 'rob', { platform: 'kick', userId: '77', actor }, deps)).status, 400);
  assert.equal((await runIntegrationUserModeration('ban', 'cizi', { platform: 'kick', userId: '77', actor }, deps)).status, 404);
  assert.deepEqual(await runIntegrationUserModeration('ban', 'rob', { platform: 'twitch', userId: 'x', actor }, deps), { status: 200, body: { ok: true, result: 'not_found' } });
  assert.equal((await runIntegrationUserModeration('unban', 'rob', { platform: 'kick', userId: '77' }, deps)).status, 400);
  assert.equal(seen.published.length, 0);
});

test('integrace: mod cíle jen pro aktéra v roli majitele workspace', async () => {
  const { deps } = userDeps();
  assert.equal((await runIntegrationUserModeration('ban', 'rob', { platform: 'kick', userId: '88', actor: { ...actor, role: 'moderator' } }, deps)).status, 403);
  assert.equal((await runIntegrationUserModeration('ban', 'rob', { platform: 'kick', userId: '88', actor }, deps)).status, 200);
});
