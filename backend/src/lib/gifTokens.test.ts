import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGifTokenVerifier, hashToken, issueAccountToken, issueIntegrationToken, type GifTokenStore, type GifTokenRow } from './gifTokens.js';

function memTokens() {
  const rows: Array<GifTokenRow & { tokenHash: string; revokedAt: Date | null }> = [];
  const store: GifTokenStore = {
    async revokeExcess(owner, keep, at) {
      const mine = rows.filter((r) => !r.revokedAt && (owner.accountId !== undefined ? r.accountId === owner.accountId : r.integrationSlug === owner.integrationSlug));
      for (const r of mine.reverse().slice(keep)) r.revokedAt = at; // nejnovější první
    },
    async insert(v) { rows.push({ accountId: v.accountId, integrationSlug: v.integrationSlug, tokenHash: v.tokenHash, revokedAt: null }); },
    async findActive(hash) { const r = rows.find((x) => x.tokenHash === hash && !x.revokedAt); return r ? { accountId: r.accountId, integrationSlug: r.integrationSlug } : null; },
  };
  return { store, rows };
}

test('issueAccountToken: náhodný token vrácen jen jednou, v DB jen hash; až 5 aktivních (zařízení), šestý zneplatní nejstarší', async () => {
  const { store, rows } = memTokens();
  const t1 = await issueAccountToken(7, store, () => 1000);
  assert.match(t1, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(rows[0].tokenHash, hashToken(t1));
  assert.ok(!JSON.stringify(rows).includes(t1), 'token v DB není');
  const more = [];
  for (let i = 0; i < 4; i++) more.push(await issueAccountToken(7, store, () => 2000 + i));
  assert.equal(new Set([t1, ...more]).size, 5);
  assert.ok(rows.every((r) => r.revokedAt === null), '5 aktivních');
  await issueAccountToken(8, store, () => 3000); // jiný účet se nepočítá
  await issueAccountToken(7, store, () => 4000);
  assert.ok(rows[0].revokedAt, 'nejstarší zneplatněn');
  assert.equal(rows.filter((r) => r.accountId === 7 && !r.revokedAt).length, 5);
  assert.equal(rows.find((r) => r.accountId === 8)!.revokedAt, null);
});

test('verify: bez tokenu / špatný / zneplatněný / účet už není mod → false; mod kanálu → true', async () => {
  const { store } = memTokens();
  const mods = new Set(['7|robdiesalot']);
  const verify = createGifTokenVerifier({ store, isMod: async (acc, ch) => mods.has(`${acc}|${ch}`), slugForChannel: async () => 'rob', now: () => 0 });
  const t = await issueAccountToken(7, store, () => 1);
  assert.equal(await verify(undefined, 'robdiesalot'), false);
  assert.equal(await verify('', 'robdiesalot'), false);
  assert.equal(await verify('spatny-token-ale-dost-dlouhy-aaaaaaaaaaaaaaaaaaa', 'robdiesalot'), false);
  assert.equal(await verify('<script>', 'robdiesalot'), false);
  assert.equal(await verify(t, 'robdiesalot'), true);
  assert.equal(await verify(t, 'cizikanal'), false, 'mod jiného kanálu ne');
  // Odebraný mod (cache vypršela) → false.
  const verify2 = createGifTokenVerifier({ store, isMod: async () => false, slugForChannel: async () => 'rob', now: () => 0 });
  assert.equal(await verify2(t, 'robdiesalot'), false);
  // Druhé zařízení: starý token platí dál; po pěti dalších je nejstarší zneplatněný.
  const t2 = await issueAccountToken(7, store, () => 2);
  const verify3 = createGifTokenVerifier({ store, isMod: async () => true, slugForChannel: async () => 'rob', now: () => 0 });
  assert.equal(await verify3(t, 'robdiesalot'), true);
  assert.equal(await verify3(t2, 'robdiesalot'), true);
  for (let i = 0; i < 4; i++) await issueAccountToken(7, store, () => 3 + i);
  const verify4 = createGifTokenVerifier({ store, isMod: async () => true, slugForChannel: async () => 'rob', now: () => 0 });
  assert.equal(await verify4(t, 'robdiesalot'), false, 'zneplatněný');
  assert.equal(await verify4(t2, 'robdiesalot'), true);
});

test('verify: integrační token Židolišty platí jen pro kanál svého workspace', async () => {
  const { store } = memTokens();
  const t = await issueIntegrationToken('rob', store, () => 1);
  const verify = createGifTokenVerifier({ store, isMod: async () => false, slugForChannel: async (ch) => (ch === 'robdiesalot' ? 'rob' : 'jiny'), now: () => 0 });
  assert.equal(await verify(t, 'robdiesalot'), true);
  assert.equal(await verify(t, 'cizikanal'), false);
});

test('verify: výsledek v cache 60 s (bez dotazu do DB při každém načtení média)', async () => {
  const { store } = memTokens();
  let finds = 0;
  const orig = store.findActive.bind(store);
  store.findActive = async (h) => { finds++; return orig(h); };
  let now = 0;
  const verify = createGifTokenVerifier({ store, isMod: async () => true, slugForChannel: async () => 'rob', now: () => now });
  const t = await issueAccountToken(7, store, () => 1);
  await verify(t, 'robdiesalot');
  await verify(t, 'robdiesalot');
  assert.equal(finds, 1);
  now = 61_000;
  await verify(t, 'robdiesalot');
  assert.equal(finds, 2);
});
