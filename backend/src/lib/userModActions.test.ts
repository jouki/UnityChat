import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runUserAction, runWarn, runPermit, runRename, effectiveDuration, type UserActionDeps, type WarnDeps, type PermitDeps, type RenameDeps, type TargetRole } from './userModActions.js';
import type { ResolvedTargets } from './moderationTargets.js';
import type { NewModerationAction } from '../db/schema.js';
import type { ChatRole } from './chatRole.js';
import { publishUserModerated, expectEcho, forgetEcho, _resetUserModeratedDedup } from './userModeration.js';

const silent = { warn() {}, info() {} };
const NOW = 1_800_000_000_000;
const viewer: TargetRole = async () => 'viewer';
const roleOf = (map: Record<string, ChatRole>): TargetRole => async (_c, t) => map[`${t.platform}:${t.login}`] ?? 'viewer';

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
    targetRole: viewer,
    publish: async (p) => { log.push(`sse:${p.platform}:${p.action}:${p.durationSec}`); },
    expectEcho: () => {},
    forgetEcho: () => {},
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

const input = { channel: 'robdiesalot', accountId: 1, by: 'twitch:modik', callerIsBroadcaster: false, platform: 'twitch' as const, userId: 't1', reason: null };

test('effectiveDuration: Kick na celé minuty, ostatní beze změny', () => {
  assert.equal(effectiveDuration('kick', 5), 60);
  assert.equal(effectiveDuration('kick', 90), 120);
  assert.equal(effectiveDuration('twitch', 5), 5);
});

test('timeout: akce na všech identitách, pak SSE, Kick s minutovou délkou, evidence + log', async () => {
  const { deps, actions, bans, log } = actionDeps();
  const out = await runUserAction({ ...input, action: 'timeout', durationSec: 30 }, deps);
  assert.equal(out.status, 200);
  assert.ok(log.indexOf('sse:twitch:timeout:30') > log.indexOf('ban:youtube:30'), 'SSE až po výsledku platforem');
  assert.ok(log.includes('sse:kick:timeout:60'));
  assert.deepEqual(out.body.results, { twitch: 'ok', kick: 'ok', youtube: 'bot' });
  assert.equal(out.body.until, NOW + 30_000);
  assert.deepEqual(out.body.notes, { kick: 'rounded_to_minutes:1' });
  assert.equal((bans as Array<{ platform: string; until: Date }>).find((b) => b.platform === 'kick')!.until.getTime(), NOW + 60_000);
  assert.equal((bans as Array<{ platform: string; youtubeBanId: string | null }>).find((b) => b.platform === 'youtube')!.youtubeBanId, 'B1');
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, 'timeout');
  assert.equal(actions[0].targetLogin, 'spammer');
});

test('SSE i evidence JEN pro platformy, kde akce prošla; výsledky pořád všechny', async () => {
  const { deps, log } = actionDeps({
    ban: async (p) => (p.platform === 'kick' ? { result: 'error:no_actor' } : p.platform === 'youtube' ? { result: 'error:not_live', youtubeBanId: null } : { result: 'ok' }),
  });
  const out = await runUserAction({ ...input, action: 'ban', durationSec: null }, deps);
  assert.deepEqual(out.body.results, { twitch: 'ok', kick: 'error:no_actor', youtube: 'error:not_live' });
  assert.deepEqual(log, ['sse:twitch:ban:null', 'record:twitch']);
});

test('unban: id banu YouTube z evidence, clearBan jen po úspěchu', async () => {
  const { deps, log } = actionDeps({ unban: async (p) => { log.push(`unban:${p.platform}:${p.youtubeBanId}`); return p.platform === 'kick' ? 'error:403' : 'ok'; } });
  const out = await runUserAction({ ...input, action: 'unban', durationSec: null }, deps);
  assert.equal(out.status, 200);
  assert.ok(log.includes('unban:youtube:B9'));
  assert.ok(log.includes('clear:youtube'));
  assert.ok(!log.includes('clear:kick'));
  assert.ok(!log.includes('sse:kick:unban:null'));
});

test('hierarchie: broadcaster cíle nikdo, mod jen broadcaster — 403 target_protected, nic se neděje', async () => {
  let d = actionDeps({ targetRole: roleOf({ 'kick:spammer_k': 'moderator' }) });
  let out = await runUserAction({ ...input, action: 'ban', durationSec: null }, d.deps);
  assert.deepEqual(out, { status: 403, body: { ok: false, error: 'target_protected' } });
  assert.deepEqual(d.log, []);

  d = actionDeps({ targetRole: roleOf({ 'kick:spammer_k': 'moderator' }) });
  out = await runUserAction({ ...input, callerIsBroadcaster: true, action: 'ban', durationSec: null }, d.deps);
  assert.equal(out.status, 200, 'broadcaster smí na moda');

  d = actionDeps({ targetRole: roleOf({ 'twitch:spammer': 'broadcaster' }) });
  out = await runUserAction({ ...input, callerIsBroadcaster: true, action: 'timeout', durationSec: 5 }, d.deps);
  assert.equal(out.status, 403, 'na broadcastera ani broadcaster (jiný účet)');
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

test('výjimka platformy / evidence / logu → pořád 200, error:exception, bez SSE', async () => {
  const { deps, log } = actionDeps({
    resolveTargets: async () => single,
    ban: async () => { throw new Error('boom'); },
    recordBan: async () => { throw new Error('db down'); },
    recordAction: async () => { throw new Error('db down'); },
  });
  const out = await runUserAction({ ...input, platform: 'kick', userId: '77', action: 'timeout', durationSec: 300 }, deps);
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.results, { kick: 'error:exception' });
  assert.equal(out.body.until, null);
  assert.deepEqual(log, []);
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
    targetRole: viewer,
    warnTwitch: async (p) => { twitch.push(p); return 'ok'; },
    createWarning: async (p) => { created.push(p); return { id: 9, channel: p.channel, reason: p.reason, createdAt: 'x' }; },
    sendToAccount: (accountId, event, data) => { sent.push({ accountId, event, data }); return 1; },
    recordAction: async () => {},
    log: silent,
    ...over,
  };
  return { deps, sent, created, twitch };
}
const warnIn = { channel: 'robdiesalot', accountId: 1, by: 'twitch:modik', callerIsBroadcaster: false, platform: 'kick' as const, userId: '77', reason: 'Nespamuj' };

test('warn: Twitch nativně (Twitch identita cíle), UC varování JEN účtu cíle', async () => {
  const { deps, sent, created, twitch } = warnDeps();
  const out = await runWarn(warnIn, deps);
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.results, { twitch: 'ok', unitychat: 'ok' });
  assert.equal((twitch[0] as { userId: string }).userId, 't1');
  assert.equal((created[0] as { accountId: number }).accountId, 50);
  assert.deepEqual(sent, [{ accountId: 50, event: 'account-warning', data: { id: 9, channel: 'robdiesalot', reason: 'Nespamuj', createdAt: 'x' } }]);
});

test('warn: divák mimo UC na Kicku → žádná Twitch akce, unitychat no_account, nic se neposílá', async () => {
  const { deps, sent, twitch } = warnDeps({ resolveTargets: async () => single });
  const out = await runWarn({ ...warnIn, reason: 'x' }, deps);
  assert.deepEqual(out.body.results, { unitychat: 'no_account' });
  assert.equal(twitch.length, 0);
  assert.equal(sent.length, 0);
});

test('warn: cíl mimo kanál 404, na sebe 400, na moda 403', async () => {
  assert.equal((await runWarn(warnIn, warnDeps({ resolveTargets: async () => null }).deps)).status, 404);
  assert.equal((await runWarn({ ...warnIn, accountId: 50 }, warnDeps().deps)).status, 400);
  const d = warnDeps({ targetRole: roleOf({ 'twitch:spammer': 'moderator' }) });
  assert.equal((await runWarn(warnIn, d.deps)).status, 403);
  assert.equal(d.sent.length + d.twitch.length, 0);
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

test('permit: login s mezerou / zvláštními znaky → 400 bad_login, nic se neposílá ani neukládá', async () => {
  const bad: ResolvedTargets = { primary: { platform: 'youtube', userId: 'UCx', login: 'jméno s mezerou' }, all: [{ platform: 'youtube', userId: 'UCx', login: 'jméno s mezerou' }], accountId: null };
  const d = permitDeps({ resolveTargets: async () => bad });
  const out = await runPermit({ ...permitIn, platform: 'youtube', userId: 'UCx', modPlatforms: ['youtube'] }, d.deps);
  assert.deepEqual(out, { status: 400, body: { ok: false, error: 'bad_login' } });
  assert.deepEqual(d.log, []);
  assert.equal(d.rows.length, 0);
});

// ---- přejmenování ----
function renameDeps(over: Partial<RenameDeps> = {}) {
  const calls: string[] = [];
  const deps: RenameDeps = {
    findUser: async (_c, platform, login) => (login === 'nobody' ? null : { platform, userId: 'u', login }),
    targetRole: viewer,
    blacklisted: async (_c, nick) => nick.toLowerCase().includes('zlé'),
    upsert: async (p, u, n, c) => { calls.push(`up:${p}:${u}:${n}:${c}`); },
    remove: async (p, u) => { calls.push(`rm:${p}:${u}`); },
    recordAction: async () => {},
    log: silent,
    ...over,
  };
  return { deps, calls };
}
const renameBase = { channel: 'robdiesalot', accountId: 1, by: 'twitch:modik', callerIsBroadcaster: false, platform: 'twitch' as const, color: null };

test('rename: login z archivu, upsert / smazání; mimo kanál 404', async () => {
  const { deps, calls } = renameDeps();
  assert.equal((await runRename({ ...renameBase, login: 'spammer', nickname: 'Pan Spam' }, deps)).status, 200);
  assert.equal((await runRename({ ...renameBase, login: 'spammer', nickname: null }, deps)).status, 200);
  assert.equal((await runRename({ ...renameBase, login: 'nobody', nickname: 'x' }, deps)).status, 404);
  assert.deepEqual(calls, ['up:twitch:spammer:Pan Spam:null', 'rm:twitch:spammer']);
});

test('rename: přezdívka s blacklistem → 400 nickname_blacklisted; mod/broadcaster cíle → 403', async () => {
  let d = renameDeps();
  assert.deepEqual(await runRename({ ...renameBase, login: 'spammer', nickname: 'Zlé slovo' }, d.deps), { status: 400, body: { ok: false, error: 'nickname_blacklisted' } });
  d = renameDeps({ targetRole: async () => 'moderator' });
  assert.equal((await runRename({ ...renameBase, login: 'modik2', nickname: 'X' }, d.deps)).status, 403);
  d = renameDeps({ targetRole: async () => 'broadcaster' });
  assert.equal((await runRename({ ...renameBase, callerIsBroadcaster: true, login: 'robdiesalot', nickname: null }, d.deps)).status, 403);
  assert.deepEqual(d.calls, []);
});

test('echo CLEARCHAT dorazí DŘÍV než výsledek Helixu → jediná událost (od moda), žádný druhý zápis banu', async () => {
  _resetUserModeratedDedup();
  const sent: Array<Record<string, unknown>> = [];
  const integ: unknown[] = [];
  const bans: unknown[] = [];
  const pubDeps = { broadcast: (_e: string, d: object) => { sent.push(d as Record<string, unknown>); }, integration: (ev: unknown) => { integ.push(ev); }, now: () => NOW };
  // Stejně jako server.ts onUserModerated: echo s source 'platform'; null = přeskočit i recordBan.
  const ingestEcho = async (durationSec: number) => {
    const ev = await publishUserModerated({ channel: 'robdiesalot', platform: 'twitch', userId: 't1', login: 'spammer', action: 'timeout', durationSec, by: null, source: 'platform' }, pubDeps);
    if (ev) bans.push('ingest');
  };
  const single: ResolvedTargets = { primary: linked.primary, all: [linked.primary], accountId: null };
  const { deps } = actionDeps({
    resolveTargets: async () => single,
    publish: (p) => publishUserModerated(p, pubDeps),
    expectEcho: (k) => expectEcho(k, NOW),
    forgetEcho,
    ban: async (p) => { await ingestEcho(p.durationSec!); return { result: 'ok' }; },
    recordBan: async () => { bans.push('uc'); },
  });
  const out = await runUserAction({ ...input, action: 'timeout', durationSec: 300 }, deps);
  assert.equal(out.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].by, 'twitch:modik');
  assert.equal(integ.length, 1);
  assert.deepEqual(bans, ['uc']);
});

test('selhání platformy zruší očekávané echo → pozdější CLEARCHAT odjinud projde', async () => {
  _resetUserModeratedDedup();
  const sent: unknown[] = [];
  const pubDeps = { broadcast: (_e: string, d: object) => { sent.push(d); }, now: () => NOW };
  const single: ResolvedTargets = { primary: linked.primary, all: [linked.primary], accountId: null };
  const { deps } = actionDeps({
    resolveTargets: async () => single,
    publish: (p) => publishUserModerated(p, pubDeps),
    expectEcho: (k) => expectEcho(k, NOW),
    forgetEcho,
    ban: async () => ({ result: 'error:403' }),
  });
  await runUserAction({ ...input, action: 'ban', durationSec: null }, deps);
  assert.equal(sent.length, 0);
  const ev = await publishUserModerated({ channel: 'robdiesalot', platform: 'twitch', userId: 't1', login: 'spammer', action: 'ban', durationSec: null, by: null, source: 'platform' }, pubDeps);
  assert.ok(ev);
  assert.equal(sent.length, 1);
});
