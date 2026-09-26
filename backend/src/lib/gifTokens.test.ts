import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGifTokenVerifier, hashToken, issueAccountToken, issueIntegrationToken, type GifTokenStore, type GifTokenRow } from './gifTokens.js';

function memTokens() {
  const rows: Array<GifTokenRow & { tokenHash: string; revokedAt: Date | null }> = [];
  const store: GifTokenStore = {
    async revoke(owner, at) {
      for (const r of rows) if (!r.revokedAt && (owner.accountId !== undefined ? r.accountId === owner.accountId : r.integrationSlug === owner.integrationSlug)) r.revokedAt = at;
    },
    async insert(v) { rows.push({ accountId: v.accountId, integrationSlug: v.integrationSlug, tokenHash: v.tokenHash, revokedAt: null }); },
    async findActive(hash) { const r = rows.find((x) => x.tokenHash === hash && !x.revokedAt); return r ? { accountId: r.accountId, integrationSlug: r.integrationSlug } : null; },
  };
  return { store, rows };
}

test('issueAccountToken: náhodný token vrácen jen jednou, v DB jen hash; nový token zneplatní starý', async () => {
  const { store, rows } = memTokens();
  const t1 = await issueAccountToken(7, store, () => 1000);
  assert.match(t1, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(rows[0].tokenHash, hashToken(t1));
  assert.ok(!JSON.stringify(rows).includes(t1), 'token v DB není');
  const t2 = await issueAccountToken(7, store, () => 2000);
  assert.notEqual(t1, t2);
  assert.ok(rows[0].revokedAt, 'starý token zneplatněn');
  assert.equal(rows[1].revokedAt, null);
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
  // Zneplatněný (vydán nový).
  const t2 = await issueAccountToken(7, store, () => 2);
  const verify3 = createGifTokenVerifier({ store, isMod: async () => true, slugForChannel: async () => 'rob', now: () => 0 });
  assert.equal(await verify3(t, 'robdiesalot'), false);
  assert.equal(await verify3(t2, 'robdiesalot'), true);
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
