import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeleteBody, parseChannel, resultRecord, meResponse, buildMissingScopes, resolveDeleteTarget, resolveModGate, UserActionBody, PermitBody, RenameBody, WarnBody, type DeleteTargetDeps } from './moderation.js';

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
  assert.equal(UserActionBody.safeParse({ ...b, action: 'timeout', durationSec: 301 }).success, false);
  assert.equal(UserActionBody.safeParse({ ...b, action: 'timeout' }).success, false);
  assert.equal(UserActionBody.safeParse({ ...b, action: 'ban' }).success, true);
  assert.equal(UserActionBody.safeParse({ ...b, action: 'kill' }).success, false);
});

test('PermitBody / WarnBody / RenameBody: délky permitu, povinný důvod, null přezdívka = smazat', () => {
  assert.equal(PermitBody.safeParse({ platform: 'kick', userId: '1', durationSec: 120 }).success, true);
  assert.equal(PermitBody.safeParse({ platform: 'kick', userId: '1', durationSec: 90 }).success, false);
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
