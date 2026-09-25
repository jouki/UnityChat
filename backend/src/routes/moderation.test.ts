import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeleteBody, parseChannel, resultRecord, meResponse, buildMissingScopes } from './moderation.js';

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
