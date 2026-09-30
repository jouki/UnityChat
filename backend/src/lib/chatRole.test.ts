import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PgDialect } from 'drizzle-orm/pg-core';
import { accountModIdentities, accountModPlatforms, usernameEqualsCondition, type AccountModDeps } from './chatRole.js';
import type { PublicIdentity } from './webAuth.js';

const dialect = new PgDialect();
/** Vyrenderuje SQL podmínku bez připojení k DB (čistě textová/parametrová reprezentace pro test). */
function render(cond: ReturnType<typeof usernameEqualsCondition>) {
  return dialect.sqlToQuery(cond);
}

function ident(platform: 'twitch' | 'kick' | 'youtube', login: string): PublicIdentity {
  return { platform, login, displayName: null, avatarUrl: null, platformUserId: '1' };
}

function deps(over: Partial<AccountModDeps> & { ids: PublicIdentity[] }): AccountModDeps {
  const { ids, ...rest } = over;
  return {
    listIdentities: async () => ids,
    registryPlatformChannel: async (_c, p) => `pch-${p}`,
    chatRole: async () => 'viewer',
    ...rest,
  };
}

test('accountModIdentities: mod na jedné z propojených platforem, ostatní viewer', async () => {
  const ids = [ident('twitch', 'jouki'), ident('kick', 'jouki')];
  const r = await accountModIdentities(1, 'robdiesalot', deps({
    ids,
    chatRole: async (p) => (p === 'twitch' ? 'moderator' : 'viewer'),
  }));
  assert.deepEqual(r, [{ platform: 'twitch', login: 'jouki', role: 'moderator' }]);
});

test('accountModIdentities: broadcaster role taky počítá jako mod', async () => {
  const ids = [ident('kick', 'robdiesalot')];
  const r = await accountModIdentities(1, 'robdiesalot', deps({ ids, chatRole: async () => 'broadcaster' }));
  assert.deepEqual(r, [{ platform: 'kick', login: 'robdiesalot', role: 'broadcaster' }]);
});

test('accountModIdentities: platforma bez registrovaného kanálu (Kick/YT nenamapované) se přeskočí', async () => {
  const ids = [ident('youtube', 'jouki')];
  const r = await accountModIdentities(1, 'robdiesalot', deps({ ids, registryPlatformChannel: async () => null, chatRole: async () => 'moderator' }));
  assert.deepEqual(r, []);
});

test('accountModIdentities: role se ověřuje přes PLATFORMNÍ kanál té platformy, ne UC kanál napříč platformami', async () => {
  const calls: [string, string, string][] = [];
  const ids = [ident('twitch', 'jouki'), ident('kick', 'jouki')];
  await accountModIdentities(1, 'robdiesalot', deps({
    ids,
    registryPlatformChannel: async (channel, platform) => (platform === 'twitch' ? channel : 'rob-kick-slug'),
    chatRole: async (platform, login, channel) => { calls.push([platform, login, channel]); return 'viewer'; },
  }));
  assert.deepEqual(calls, [['twitch', 'jouki', 'robdiesalot'], ['kick', 'jouki', 'rob-kick-slug']]);
});

test('accountModIdentities: žádná propojená identita → prázdný seznam', async () => {
  const r = await accountModIdentities(1, 'robdiesalot', deps({ ids: [] }));
  assert.deepEqual(r, []);
});

test('accountModPlatforms: jen seznam platforem (bez loginů)', async () => {
  const ids = [ident('twitch', 'jouki'), ident('kick', 'jouki')];
  const r = await accountModPlatforms(1, 'robdiesalot', deps({ ids, chatRole: async () => 'moderator' }));
  assert.deepEqual(r, ['twitch', 'kick']);
});

// Regrese (security fix code review): dřív `ilike(col, login)` — login je uživatelský vstup a
// `_`/`%` jsou v (I)LIKE wildcard znaky. Útočník s loginem "jouki_28" by matchoval řádky
// "jouki728" (podtržítko = libovolný znak) → prošel by 403 gate za cizí mod řádky. `=` na
// `lower(...)` porovnává byte-přesně, žádná DB nutná (offline SQL render přes PgDialect).
test('usernameEqualsCondition: = na lower(...), NIKDY LIKE/ILIKE — _ a % v loginu nejsou wildcard', () => {
  const q = render(usernameEqualsCondition('jouki_28'));
  assert.doesNotMatch(q.sql.toLowerCase(), /\blike\b/);
  assert.match(q.sql, /^lower\(.*\)\s*=\s*\$1$/);
  assert.deepEqual(q.params, ['jouki_28']); // param nese doslovný string, ne LIKE pattern
});

test('usernameEqualsCondition: % v loginu taky doslovně (ne "libovolný řetězec")', () => {
  const q = render(usernameEqualsCondition('100%rob'));
  assert.deepEqual(q.params, ['100%rob']);
});

test('usernameEqualsCondition: login se před porovnáním lowercasuje (case-insensitive shoda)', () => {
  const q = render(usernameEqualsCondition('JOUKI728'));
  assert.deepEqual(q.params, ['jouki728']);
});
