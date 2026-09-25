import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runUserAction, runWarn, runPermit, runRename, effectiveDuration, type UserActionDeps, type WarnDeps, type PermitDeps } from './userModActions.js';
import type { ResolvedTargets } from './moderationTargets.js';
import type { NewModerationAction } from '../db/schema.js';

const silent = { warn() {}, info() {} };
const NOW = 1_800_000_000_000;

const linked: ResolvedTargets = {
  primary: { platform: 'twitch', userId: 't1', login: 'spammer' },
  all: [
    { platform: 'twitch', userId: 't1', login: 'spammer' },
    { platform: 'kick', userId: '77', login: 'spammer_k' },
    { platform: 'youtube', userId: 'UCx', login: 'spammeryt' },
  ],
  accountId: 50,
};
const single: ResolvedTargets = { primary: { platform: 'kick', userId: '77', login: 'k' }, all: [{ platform: 'kick', userId: '77', login: 'k' }], accountId: null };

function actionDeps(over: Partial<UserActionDeps> = {}, log: string[] = []) {
  const actions: NewModerationAction[] = [];
  const bans: unknown[] = [];
  const deps: UserActionDeps = {
    resolveTargets: async () => linked,
    publish: async (p) => { log.push(`sse:${p.platform}:${p.action}:${p.durationSec}`); },
    ban: async (p) => { log.push(`ban:${p.platform}:${p.durationSec}`); return p.platform === 'youtube' ? { result: 'bot', youtubeBanId: 'B1' } : { result: 'ok' }; },
    unban: async (p) => { log.push(`unban:${p.platform}:${p.youtubeBanId}`); return 'ok'; },
    activeBan: async (_c, platform) => (platform === 'youtube' ? { until: null, youtubeBanId: 'B9' } : null),
    recordBan: async (r) => { bans.push(r); log.push(`record:${r.platform}`); },
    clearBan: async (_c, platform) => { log.push(`clear:${platform}`); },
    recordAction: async (v) => { actions.push(v); },
    now: () => NOW,
    log: silent,
    ...over,
  };
  return { deps, actions, bans, log };
}

const input = { channel: 'robdiesalot', accountId: 1, by: 'twitch:modik', platform: 'twitch' as const, userId: 't1', reason: null };

test('effectiveDuration: Kick na celé minuty, ostatní beze změny', () => {
  assert.equal(effectiveDuration('kick', 5), 60);
  assert.equal(effectiveDuration('kick', 90), 120);
  assert.equal(effectiveDuration('twitch', 5), 5);
});

test('timeout: SSE pro všechny identity PŘED akcemi na platformách, Kick s minutovou délkou, evidence + log', async () => {
  const { deps, actions, bans, log } = actionDeps();
  const out = await runUserAction({ ...input, action: 'timeout', durationSec: 30 }, deps);
  assert.equal(out.status, 200);
  assert.deepEqual(log.slice(0, 3), ['sse:twitch:timeout:30', 'sse:kick:timeout:60', 'sse:youtube:timeout:30']);
  assert.ok(log.indexOf('ban:twitch:30') > 2);
  assert.deepEqual(out.body.results, { twitch: 'ok', kick: 'ok', youtube: 'bot' });
  assert.equal(out.body.until, NOW + 30_000);
  assert.deepEqual(out.body.notes, { kick: 'rounded_to_minutes:1' });
  assert.equal((bans as Array<{ platform: string; until: Date; youtubeBanId: string | null }>).find((b) => b.platform === 'kick')!.until.getTime(), NOW + 60_000);
  assert.equal((bans as Array<{ platform: string; youtubeBanId: string | null }>).find((b) => b.platform === 'youtube')!.youtubeBanId, 'B1');
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, 'timeout');
  assert.equal(actions[0].targetLogin, 'spammer');
  assert.equal(actions[0].accountId, 1);
});

test('ban: permanentní (durationSec null na platformě, until null v evidenci)', async () => {
  const { deps, bans, log } = actionDeps({ resolveTargets: async () => single });
  const out = await runUserAction({ ...input, platform: 'kick', userId: '77', action: 'ban', durationSec: null }, deps);
  assert.equal(out.body.until, null);
  assert.ok(log.includes('ban:kick:null'));
  assert.equal((bans[0] as { until: Date | null }).until, null);
  assert.equal(out.body.notes, undefined);
});

test('unban: id banu YouTube z evidence ještě před smazáním, pak clearBan', async () => {
  const { deps, log } = actionDeps();
  const out = await runUserAction({ ...input, action: 'unban', durationSec: null }, deps);
  assert.equal(out.status, 200);
  assert.ok(log.includes('unban:youtube:B9'));
  assert.ok(log.includes('unban:twitch:null'));
  assert.ok(log.indexOf('clear:youtube') > log.indexOf('unban:youtube:B9'));
});

test('cíl mimo archiv kanálu → 404, žádné SSE, platforma ani zápis', async () => {
  const { deps, actions, log } = actionDeps({ resolveTargets: async () => null });
  const out = await runUserAction({ ...input, action: 'ban', durationSec: null }, deps);
  assert.equal(out.status, 404);
  assert.deepEqual(log, []);
  assert.equal(actions.length, 0);
});

test('mod na sebe → 400 self, nic se neděje', async () => {
  const { deps, log } = actionDeps();
  const out = await runUserAction({ ...input, accountId: 50, action: 'ban', durationSec: null }, deps);
  assert.equal(out.status, 400);
  assert.deepEqual(log, []);
});

test('výjimka platformy / evidence / logu po SSE → pořád 200, error:exception', async () => {
  const { deps } = actionDeps({
    resolveTargets: async () => single,
    ban: async () => { throw new Error('boom'); },
    recordBan: async () => { throw new Error('db down'); },
    recordAction: async () => { throw new Error('db down'); },
  });
  const out = await runUserAction({ ...input, platform: 'kick', userId: '77', action: 'timeout', durationSec: 300 }, deps);
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.results, { kick: 'error:exception' });
});

test('integrace (accountId null) nesmí narazit na self kontrolu u cíle bez účtu', async () => {
  const { deps } = actionDeps({ resolveTargets: async () => single });
  const out = await runUserAction({ ...input, accountId: null, platform: 'kick', userId: '77', action: 'ban', durationSec: null }, deps);
  assert.equal(out.status, 200);
});

// ---- varování ----
function warnDeps(over: Partial<WarnDeps> = {}) {
  const sent: Array<{ accountId: number; event: string; data: object }> = [];
  const created: unknown[] = [];
  const twitch: unknown[] = [];
  const deps: WarnDeps = {
    resolveTargets: async () => linked,
    warnTwitch: async (p) => { twitch.push(p); return 'ok'; },
    createWarning: async (p) => { created.push(p); return { id: 9, channel: p.channel, reason: p.reason, createdAt: 'x' }; },
    sendToAccount: (accountId, event, data) => { sent.push({ accountId, event, data }); return 1; },
    recordAction: async () => {},
    log: silent,
    ...over,
  };
  return { deps, sent, created, twitch };
}

test('warn: Twitch nativně (Twitch identita cíle), UC varování JEN účtu cíle', async () => {
  const { deps, sent, created, twitch } = warnDeps();
  const out = await runWarn({ channel: 'robdiesalot', accountId: 1, by: 'twitch:modik', platform: 'kick', userId: '77', reason: 'Nespamuj' }, deps);
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.results, { twitch: 'ok', unitychat: 'ok' });
  assert.equal((twitch[0] as { userId: string }).userId, 't1');
  assert.equal((created[0] as { accountId: number }).accountId, 50);
  assert.deepEqual(sent, [{ accountId: 50, event: 'account-warning', data: { id: 9, channel: 'robdiesalot', reason: 'Nespamuj', createdAt: 'x' } }]);
});

test('warn: divák mimo UC na Kicku → žádná Twitch akce, unitychat no_account, nic se neposílá', async () => {
  const { deps, sent, twitch } = warnDeps({ resolveTargets: async () => single });
  const out = await runWarn({ channel: 'robdiesalot', accountId: 1, by: 'twitch:modik', platform: 'kick', userId: '77', reason: 'x' }, deps);
  assert.deepEqual(out.body.results, { unitychat: 'no_account' });
  assert.equal(twitch.length, 0);
  assert.equal(sent.length, 0);
});

test('warn: cíl mimo kanál 404, na sebe 400', async () => {
  assert.equal((await runWarn({ channel: 'r', accountId: 1, by: 'b', platform: 'twitch', userId: 'x', reason: 'r' }, warnDeps({ resolveTargets: async () => null }).deps)).status, 404);
  assert.equal((await runWarn({ channel: 'r', accountId: 50, by: 'b', platform: 'twitch', userId: 't1', reason: 'r' }, warnDeps().deps)).status, 400);
});

// ---- permit ----
function permitDeps(over: Partial<PermitDeps> = {}) {
  const log: string[] = [];
  const rows: unknown[] = [];
  const deps: PermitDeps = {
    resolveTargets: async () => linked,
    insertPermits: async (r) => { rows.push(...r); },
    sendAsMod: async (platform, text) => { log.push(`mod:${platform}:${text}`); },
    sendAsBot: async (platform, text) => { log.push(`bot:${platform}:${text}`); },
    recordAction: async () => {},
    now: () => NOW,
    log: silent,
    ...over,
  };
  return { deps, log, rows };
}
const permitIn = { channel: 'robdiesalot', accountId: 1, by: 'twitch:modik', platform: 'twitch' as const, userId: 't1', durationSec: 120 };

test('permit: mod na platformě zprávy → !permit <login z archivu> jeho účtem, permit na všech identitách', async () => {
  const { deps, log, rows } = permitDeps();
  const out = await runPermit({ ...permitIn, modPlatforms: ['twitch'] }, deps);
  assert.deepEqual(log, ['mod:twitch:!permit spammer']);
  assert.deepEqual(out.body.results, { permit: 'ok', chat: 'ok' });
  assert.equal(out.body.until, NOW + 120_000);
  assert.equal(rows.length, 3);
  assert.equal((rows[1] as { until: Date }).until.getTime(), NOW + 120_000);
});

test('permit: mod jen na Kicku → Twitch !permit botem; selhání moda → bot; selhání bota → error:<code>', async () => {
  let d = permitDeps();
  await runPermit({ ...permitIn, modPlatforms: ['kick'] }, d.deps);
  assert.deepEqual(d.log, ['bot:twitch:!permit spammer']);

  d = permitDeps({ sendAsMod: async () => { throw new Error('not linked'); } });
  const o2 = await runPermit({ ...permitIn, modPlatforms: ['twitch'] }, d.deps);
  assert.equal((o2.body.results as { chat: string }).chat, 'bot');

  d = permitDeps({ sendAsBot: async () => { throw Object.assign(new Error('x'), { code: 'bot_unavailable' }); } });
  const o3 = await runPermit({ ...permitIn, modPlatforms: [] }, d.deps);
  assert.equal((o3.body.results as { chat: string }).chat, 'error:bot_unavailable');
});

// ---- přejmenování ----
test('rename: login z archivu, upsert / smazání; mimo kanál 404', async () => {
  const calls: string[] = [];
  const deps = {
    findUser: async (_c: string, platform: 'twitch' | 'kick' | 'youtube', login: string) => (login === 'nobody' ? null : { platform, userId: 'u', login }),
    upsert: async (p: string, u: string, n: string, c: string | null) => { calls.push(`up:${p}:${u}:${n}:${c}`); },
    remove: async (p: string, u: string) => { calls.push(`rm:${p}:${u}`); },
    recordAction: async () => {},
    log: silent,
  };
  const base = { channel: 'robdiesalot', accountId: 1, by: 'twitch:modik', platform: 'twitch' as const, color: null };
  assert.equal((await runRename({ ...base, login: 'spammer', nickname: 'Pan Spam' }, deps)).status, 200);
  assert.equal((await runRename({ ...base, login: 'spammer', nickname: null }, deps)).status, 200);
  assert.equal((await runRename({ ...base, login: 'nobody', nickname: 'x' }, deps)).status, 404);
  assert.deepEqual(calls, ['up:twitch:spammer:Pan Spam:null', 'rm:twitch:spammer']);
});
