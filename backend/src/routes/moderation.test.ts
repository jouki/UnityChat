import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeleteBody, parseChannel, resultRecord, meResponse, buildMissingScopes, resolveDeleteTarget, resolveModGate, UserActionBody, PermitBody, RenameBody, WarnBody, parseDeletedKeys, buildDeletedContent, runDeletedContent, DELETED_CONTENT_MAX, runRestore, RestoreBody, type RestoreDeps, type RestoreState, type DeleteTargetDeps, type DeletedContentRow } from './moderation.js';

test('resolveModGate: nemod → not_mod, neplatný kanál → channel (bez dotazu na role), mod → by + platformy', async () => {
  let asked = 0;
  const ids = async (_a: number, channel: string) => { asked++; return channel === 'robdiesalot' ? [{ platform: 'kick' as const, login: 'modik', role: 'moderator' as const }, { platform: 'twitch' as const, login: 'modik', role: 'moderator' as const }] : channel === 'modik' ? [{ platform: 'twitch' as const, login: 'modik', role: 'broadcaster' as const }] : []; };
  assert.deepEqual(await resolveModGate(1, 'x!', 'robdiesalot', ids), { error: 'channel' });
  assert.equal(asked, 0);
  assert.deepEqual(await resolveModGate(1, 'jouki', 'robdiesalot', ids), { error: 'not_mod' });
  assert.deepEqual(await resolveModGate(1, 'RobDiesALot', 'x', ids), { channel: 'robdiesalot', accountId: 1, by: 'kick:modik', modPlatforms: ['kick', 'twitch'], isBroadcaster: false });
  assert.equal(((await resolveModGate(1, 'modik', 'x', ids)) as { isBroadcaster: boolean }).isBroadcaster, true, 'broadcaster jen vlastního kanálu');
});

test('UserActionBody: timeout jen s povolenou délkou, ban/unban bez ní', () => {
  const b = { platform: 'twitch', userId: '1' };
  assert.equal(UserActionBody.safeParse({ ...b, action: 'timeout', durationSec: 300 }).success, true);
  assert.equal(UserActionBody.safeParse({ ...b, action: 'timeout', durationSec: 301 }).success, true);
  assert.equal(UserActionBody.safeParse({ ...b, action: 'timeout', durationSec: 0 }).success, false);
  assert.equal(UserActionBody.safeParse({ ...b, action: 'timeout', durationSec: 1_209_601 }).success, false);
  assert.equal(UserActionBody.safeParse({ ...b, action: 'timeout' }).success, false);
  assert.equal(UserActionBody.safeParse({ ...b, action: 'ban' }).success, true);
  assert.equal(UserActionBody.safeParse({ ...b, action: 'kill' }).success, false);
});

test('PermitBody / WarnBody / RenameBody: délky permitu, povinný důvod, null přezdívka = smazat', () => {
  assert.equal(PermitBody.safeParse({ platform: 'kick', userId: '1', durationSec: 120 }).success, true);
  assert.equal(PermitBody.safeParse({ platform: 'kick', userId: '1', durationSec: 90 }).success, true);
  assert.equal(PermitBody.safeParse({ platform: 'kick', userId: '1', durationSec: 0 }).success, false);
  assert.equal(PermitBody.safeParse({ platform: 'kick', userId: '1', durationSec: 86_401 }).success, false);
  assert.equal(WarnBody.safeParse({ platform: 'kick', userId: '1', reason: '   ' }).success, false);
  assert.equal(WarnBody.safeParse({ platform: 'kick', userId: '1', reason: 'x'.repeat(501) }).success, false);
  const r = RenameBody.safeParse({ platform: 'twitch', login: '@Spammer', nickname: null });
  assert.equal(r.success && r.data.login, 'spammer');
  assert.equal(RenameBody.safeParse({ platform: 'twitch', login: 's', nickname: 'x'.repeat(31) }).success, false);
  assert.equal(RenameBody.safeParse({ platform: 'twitch', login: 's', nickname: 'Pan', color: 'red' }).success, false);
});

test('DeleteBody: platný požadavek projde', () => {
  const r = DeleteBody.safeParse({ platform: 'twitch', messageId: 'abc-123' });
  assert.equal(r.success, true);
});

test('DeleteBody: neznámá platforma odmítnuta', () => {
  assert.equal(DeleteBody.safeParse({ platform: 'discord', messageId: 'x' }).success, false);
});

test('DeleteBody: messageId 1–128 znaků, mimo rozsah odmítnuto', () => {
  assert.equal(DeleteBody.safeParse({ platform: 'twitch', messageId: '' }).success, false);
  assert.equal(DeleteBody.safeParse({ platform: 'twitch', messageId: 'x'.repeat(129) }).success, false);
  assert.equal(DeleteBody.safeParse({ platform: 'twitch', messageId: 'x'.repeat(128) }).success, true);
});

test('DeleteBody: channel volitelný, jen hrubá délková mez — přesný formát řeší parseChannel PO lowercase', () => {
  assert.equal(DeleteBody.safeParse({ platform: 'twitch', messageId: 'x' }).success, true);
  assert.equal(DeleteBody.safeParse({ platform: 'twitch', messageId: 'x', channel: 'robdiesalot' }).success, true);
  // Velké písmeno tu projde záměrně (zod validuje jen hrubě) — reálný formát/case řeší parseChannel
  // až PO zlowercasování, jinak by "Rob" spadl na 400 dřív, než dostane šanci se zlowercasovat.
  assert.equal(DeleteBody.safeParse({ platform: 'twitch', messageId: 'x', channel: 'Rob' }).success, true);
  assert.equal(DeleteBody.safeParse({ platform: 'twitch', messageId: 'x', channel: '' }).success, false);
  assert.equal(DeleteBody.safeParse({ platform: 'twitch', messageId: 'x', channel: 'a'.repeat(41) }).success, false);
});

test('parseChannel: lowercase PRVNÍ, pak validace ^[a-z0-9_]{2,25}$ — "Rob" je platný kanál "rob"', () => {
  assert.equal(parseChannel('Rob', 'robdiesalot'), 'rob');
  assert.equal(parseChannel('ROBDIESALOT', 'x'), 'robdiesalot');
});

test('parseChannel: chybějící vstup → fallback (i ten se lowercasuje)', () => {
  assert.equal(parseChannel(undefined, 'RobDiesalot'), 'robdiesalot');
});

test('parseChannel: mimo formát (moc krátký/dlouhý, neplatný znak) → null', () => {
  assert.equal(parseChannel('a', 'x'), null);
  assert.equal(parseChannel('a'.repeat(26), 'x'), null);
  assert.equal(parseChannel('rob-diesalot', 'x'), null);
  assert.equal(parseChannel('rob diesalot', 'x'), null);
});

test('resultRecord: zabalí ModResult pod klíč platformy (tvar sloupce moderation_actions.result)', () => {
  assert.deepEqual(resultRecord('twitch', 'ok'), { twitch: 'ok' });
  assert.deepEqual(resultRecord('kick', 'error:403'), { kick: 'error:403' });
});

test('meResponse: mod=false pro prázdný seznam platforem', () => {
  assert.deepEqual(meResponse([], {}), { ok: true, mod: false, platforms: [], missingScopes: {} });
});

test('meResponse: mod=true, platformy a missingScopes se propíšou beze změny', () => {
  const r = meResponse(['twitch'], { twitch: ['moderator:manage:chat_messages'] });
  assert.deepEqual(r, { ok: true, mod: true, platforms: ['twitch'], missingScopes: { twitch: ['moderator:manage:chat_messages'] } });
});

test('buildMissingScopes: missingModScopes pro každou platformu ze scopesFor (null = žádný scope)', async () => {
  const r = await buildMissingScopes(['twitch', 'kick'], async (p) => (p === 'twitch' ? [] : null));
  assert.deepEqual(r.twitch, ['moderator:manage:chat_messages', 'moderator:manage:banned_users', 'moderator:manage:warnings']);
  assert.deepEqual(r.kick, ['moderation:chat_message:manage', 'moderation:ban']);
});

test('buildMissingScopes: prázdný seznam platforem → prázdný objekt', async () => {
  const r = await buildMissingScopes([], async () => null);
  assert.deepEqual(r, {});
});

// Archiv: platform:id → messages.channel; registr: Rob má Kick "robdiesalot", YouTube "@RobDiesALot".
const archive: Record<string, string> = { 'twitch:rob-1': 'robdiesalot', 'twitch:jouki-1': 'jouki', 'youtube:yt-1': '@robdiesalot', 'kick:k-1': 'robdiesalot' };
const targetDeps: DeleteTargetDeps = {
  platformChannel: async (channel, platform) => (platform === 'twitch' ? channel : channel === 'robdiesalot' ? (platform === 'youtube' ? '@RobDiesALot' : 'robdiesalot') : null),
  messageChannel: async (platform, id) => archive[`${platform}:${id}`] ?? null,
};

test('resolveDeleteTarget: zpráva z vlastního kanálu → kanál přesně z archivu', async () => {
  assert.equal(await resolveDeleteTarget('robdiesalot', 'twitch', 'rob-1', targetDeps), 'robdiesalot');
  assert.equal(await resolveDeleteTarget('robdiesalot', 'youtube', 'yt-1', targetDeps), '@robdiesalot');
  assert.equal(await resolveDeleteTarget('robdiesalot', 'kick', 'k-1', targetDeps), 'robdiesalot');
});

test('resolveDeleteTarget: broadcaster vlastního kanálu nesmí smazat zprávu z cizího kanálu → null', async () => {
  // jouki je "broadcaster" kanálu jouki (login == channel), ale zpráva rob-1 patří Robovi
  assert.equal(await resolveDeleteTarget('jouki', 'twitch', 'rob-1', targetDeps), null);
  assert.equal(await resolveDeleteTarget('robdiesalot', 'twitch', 'jouki-1', targetDeps), null);
});

test('resolveDeleteTarget: zpráva není v archivu / kanál nemá platformu v registru → null', async () => {
  assert.equal(await resolveDeleteTarget('robdiesalot', 'twitch', 'neexistuje', targetDeps), null);
  assert.equal(await resolveDeleteTarget('jouki', 'kick', 'k-1', targetDeps), null);
});

// ---- GET /moderation/deleted-content ----
test('parseDeletedKeys: platforma:id, dedup, id s dvojtečkou; neplatné / prázdné / nad limit → null', () => {
  assert.deepEqual(parseDeletedKeys('twitch:a, kick:b,twitch:a,youtube:Ch:x=='), [{ platform: 'twitch', id: 'a' }, { platform: 'kick', id: 'b' }, { platform: 'youtube', id: 'Ch:x==' }]);
  assert.equal(parseDeletedKeys(''), null);
  assert.equal(parseDeletedKeys('discord:a'), null);
  assert.equal(parseDeletedKeys('twitch:'), null);
  assert.equal(parseDeletedKeys('abc'), null);
  assert.equal(parseDeletedKeys(`twitch:${'x'.repeat(129)}`), null);
  assert.equal(parseDeletedKeys(Array.from({ length: DELETED_CONTENT_MAX }, (_, i) => `twitch:${i}`).join(','))?.length, DELETED_CONTENT_MAX);
  assert.equal(parseDeletedKeys(Array.from({ length: DELETED_CONTENT_MAX + 1 }, (_, i) => `twitch:${i}`).join(',')), null);
});

const dRow = (o: Partial<DeletedContentRow>): DeletedContentRow => ({
  platform: 'twitch', platformMessageId: 'm1', platformUserId: '1', platformUsername: 'tester', content: 'tst', sentAt: new Date(1000),
  contentRaw: { color: '#fff', badges: '', emotes: null }, isReply: false, replyToMessageId: null, channel: 'robdiesalot', deletedAt: new Date(2000), deletedReason: 'mod', hiddenAt: null, ...o,
});

const deletedDeps = (rows: DeletedContentRow[], calls: string[] = []) => ({
  platformChannel: async (_c: string, p: 'twitch' | 'kick' | 'youtube') => (p === 'twitch' ? 'robdiesalot' : p === 'kick' ? 'rob-kick' : null),
  rows: async (p: 'twitch' | 'kick' | 'youtube', ids: string[]) => { calls.push(`${p}:${ids.join('|')}`); return rows.filter((r) => r.platform === p && ids.includes(r.platformMessageId)); },
});

test('buildDeletedContent: smazaná i skrytá zpráva vlastního kanálu s textem; cizí kanál, nesmazaná a platforma mimo registr vynechané', async () => {
  const calls: string[] = [];
  const rows = [
    dRow({}),
    dRow({ platformMessageId: 'm2', deletedAt: null, hiddenAt: new Date(3000), content: 'skryte' }),
    dRow({ platformMessageId: 'm3', deletedAt: null, content: 'normalni' }),
    dRow({ platformMessageId: 'm4', channel: 'cizi_kanal', content: 'cizi' }),
    dRow({ platform: 'kick', platformMessageId: 'k1', channel: 'Rob-Kick', content: 'kick smazana', contentRaw: { content: 'kick smazana' } }),
    dRow({ platform: 'youtube', platformMessageId: 'y1', channel: 'robyt', content: 'yt' }),
  ];
  const keys = parseDeletedKeys('twitch:m1,twitch:m2,twitch:m3,twitch:m4,twitch:chybi,kick:k1,youtube:y1')!;
  const out = await buildDeletedContent('robdiesalot', keys, deletedDeps(rows, calls));
  assert.deepEqual(Object.keys(out).sort(), ['kick:k1', 'twitch:m1', 'twitch:m2']);
  assert.equal(out['twitch:m1'].message, 'tst');
  assert.equal(out['twitch:m1'].deleted, true);
  assert.equal(out['twitch:m2'].message, 'skryte');
  assert.equal(out['twitch:m2'].hidden, true);
  assert.equal(out['kick:k1'].kickContent, 'kick smazana');
  assert.deepEqual(calls, ['twitch:m1|m2|m3|m4|chybi', 'kick:k1'], 'YouTube bez registru → žádný dotaz do DB');
});

test('runDeletedContent: nemod → 403 not_mod a DB se nedotkne; neplatné ids → 400; mod → 200 s obsahem', async () => {
  const calls: string[] = [];
  const noMod = async () => [];
  const mod = async () => [{ platform: 'twitch' as const, login: 'modik', role: 'moderator' as const }];
  const viewer = await runDeletedContent({ accountId: 1, channel: 'robdiesalot', ids: 'twitch:m1', fallback: 'robdiesalot' }, { ...deletedDeps([dRow({})], calls), modIdentities: noMod });
  assert.equal(viewer.status, 403);
  assert.deepEqual(viewer.body, { ok: false, error: 'not_mod' });
  assert.equal(JSON.stringify(viewer.body).includes('tst'), false);
  assert.deepEqual(calls, [], 'nemod nevyvolá čtení archivu');
  assert.equal((await runDeletedContent({ accountId: 1, ids: 'x', fallback: 'robdiesalot' }, { ...deletedDeps([]), modIdentities: mod })).status, 400);
  assert.equal((await runDeletedContent({ accountId: 1, channel: 'x!', ids: 'twitch:m1', fallback: 'robdiesalot' }, { ...deletedDeps([]), modIdentities: mod })).status, 400);
  const ok = await runDeletedContent({ accountId: 1, channel: 'RobDiesALot', ids: 'twitch:m1', fallback: 'x' }, { ...deletedDeps([dRow({})]), modIdentities: mod });
  assert.equal(ok.status, 200);
  assert.equal((ok.body.messages as Record<string, { message: string }>)['twitch:m1'].message, 'tst');
});

// ---- POST /moderation/restore ----
function restoreDeps(state: RestoreState | null, over: Partial<RestoreDeps> = {}) {
  const calls: Array<[string, unknown]> = [];
  const d: RestoreDeps = {
    platformChannel: async (_c, p) => (p === 'youtube' ? null : 'robdiesalot'),
    messageState: async () => state,
    publishRestored: async (p) => { calls.push(['restored', p]); return 'ok'; },
    publishUnhidden: async (p) => { calls.push(['unhidden', p]); return 'ok'; },
    recordAction: async (v) => { calls.push(['record', v]); },
    log: { info() {}, warn() {} },
    ...over,
  };
  return { d, calls };
}
const G = { channel: 'robdiesalot', accountId: 7, by: 'twitch:modik' };
const st = (o: Partial<RestoreState>): RestoreState => dRow({ deletedAt: null, deletedReason: null, hiddenAt: null, ...o });

test('RestoreBody: platforma + messageId povinné', () => {
  assert.equal(RestoreBody.safeParse({ platform: 'twitch', messageId: 'm1' }).success, true);
  assert.equal(RestoreBody.safeParse({ platform: 'x', messageId: 'm1' }).success, false);
  assert.equal(RestoreBody.safeParse({ platform: 'twitch' }).success, false);
});

test('runRestore: smazaná modem / platformou / filtrem → publishRestored se skutečným důvodem + záznam restore', async () => {
  for (const reason of ['mod', 'platform', 'link_filter']) {
    const { d, calls } = restoreDeps(st({ deletedAt: new Date(), deletedReason: reason }));
    const out = await runRestore(G, { platform: 'twitch', messageId: 'm1' }, d);
    assert.equal(out.status, 200);
    assert.equal(out.body.result, 'ok');
    assert.equal((out.body.message as { message: string; deleted?: boolean }).message, 'tst', 'odpověď nese celou zprávu');
    assert.equal((out.body.message as { deleted?: boolean }).deleted, undefined);
    assert.deepEqual(calls[0], ['restored', { channel: 'robdiesalot', platform: 'twitch', messageId: 'm1', platformChannel: 'robdiesalot', by: 'twitch:modik', reason }]);
    const rec = calls[1][1] as { action: string; params: { reason: string }; actor: string; accountId: number; targetMessageId: string };
    assert.equal(rec.action, 'restore');
    assert.equal(rec.params.reason, reason);
    assert.equal(rec.actor, 'twitch:modik');
    assert.equal(rec.accountId, 7);
    assert.equal(rec.targetMessageId, 'm1');
  }
});

test('runRestore: gif_request → 409 gif_pending, neznámý důvod → 409 not_restorable, nic se neposílá', async () => {
  const a = restoreDeps(st({ deletedAt: new Date(), deletedReason: 'gif_request' }));
  const out = await runRestore(G, { platform: 'twitch', messageId: 'm1' }, a.d);
  assert.equal(out.status, 409);
  assert.equal(out.body.error, 'gif_pending');
  assert.equal(a.calls.length, 0);
  const b = restoreDeps(st({ deletedAt: new Date(), deletedReason: null }));
  assert.equal((await runRestore(G, { platform: 'twitch', messageId: 'm1' }, b.d)).body.error, 'not_restorable');
  assert.equal(b.calls.length, 0);
});

test('runRestore: skrytá → publishUnhidden + záznam unhide; smazaná i skrytá → obojí', async () => {
  const a = restoreDeps(st({ hiddenAt: new Date() }));
  const ha = await runRestore(G, { platform: 'twitch', messageId: 'h1' }, a.d);
  assert.equal(ha.body.result, 'ok');
  assert.equal((ha.body.message as { hidden?: boolean }).hidden, undefined);
  assert.deepEqual(a.calls.map((c) => c[0]), ['unhidden', 'record']);
  assert.equal((a.calls[1][1] as { action: string }).action, 'unhide');
  const b = restoreDeps(st({ hiddenAt: new Date(), deletedAt: new Date(), deletedReason: 'mod' }));
  await runRestore(G, { platform: 'twitch', messageId: 'h1' }, b.d);
  assert.deepEqual(b.calls.map((c) => c[0]), ['restored', 'record', 'unhidden', 'record']);
  // Odkrytí skrytí selhalo (not_found) → výsledek ok (smazání zrušeno), ale bez message (pořád skrytá).
  const c = restoreDeps(st({ hiddenAt: new Date(), deletedAt: new Date(), deletedReason: 'mod' }), { publishUnhidden: async () => 'not_found' });
  const oc = await runRestore(G, { platform: 'twitch', messageId: 'h1' }, c.d);
  assert.equal(oc.body.result, 'ok');
  assert.equal(oc.body.message, undefined);
});

test('runRestore: nesmazaná → not_deleted; cizí kanál / není v archivu / platforma mimo registr → 404, nic se neposílá', async () => {
  const a = restoreDeps(st({}));
  assert.deepEqual((await runRestore(G, { platform: 'twitch', messageId: 'm1' }, a.d)).body, { ok: true, result: 'not_deleted' });
  assert.equal(a.calls.length, 0);
  const cases: Array<[RestoreState | null, 'twitch' | 'youtube']> = [
    [st({ channel: 'cizi', deletedAt: new Date(), deletedReason: 'mod' }), 'twitch'],
    [null, 'twitch'],
    [st({ deletedAt: new Date(), deletedReason: 'mod' }), 'youtube'],
  ];
  for (const [state, platform] of cases) {
    const x = restoreDeps(state);
    const out = await runRestore(G, { platform, messageId: 'm1' }, x.d);
    assert.equal(out.status, 404);
    assert.equal(out.body.result, 'not_found');
    assert.equal(x.calls.length, 0);
  }
});

test('runRestore: souběh (už obnovená jiným modem) → not_deleted; chyba zápisu záznamu neshodí odkrytí', async () => {
  const a = restoreDeps(st({ deletedAt: new Date(), deletedReason: 'mod' }), { publishRestored: async () => 'not_found', recordAction: async () => { throw new Error('db'); } });
  assert.deepEqual((await runRestore(G, { platform: 'twitch', messageId: 'm1' }, a.d)).body, { ok: true, result: 'not_deleted' });
});
