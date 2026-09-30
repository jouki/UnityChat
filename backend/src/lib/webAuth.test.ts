import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  hashToken, issuePendingCode, consumePendingCode, exchangePendingCode, resolveLinkTarget, needsRefresh,
  isAllowedReturnTo, bearerToken, CODE_TTL_MS, type Platform, type IdentityInfo, type TokenSet, type ExchangeDeps,
} from './webAuth.js';
import { completeWebCallback } from '../routes/webAuth.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

test('hashToken je SHA-256 hex, deterministický', () => {
  assert.equal(hashToken('a'), 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
  assert.equal(hashToken('a'), hashToken('a'));
});

const TOKENS: TokenSet = { accessToken: 'at', refreshToken: 'rt', expiresIn: 3600, scopes: ['user:write:chat'] };
const idOf = (userId: string, login = `u${userId}`): IdentityInfo => ({ platformUserId: userId, login });

test('čekající kód: jednorázový, platí CODE_TTL_MS (5 min)', () => {
  assert.equal(CODE_TTL_MS, 5 * 60 * 1000);
  const p = { platform: 'twitch' as Platform, identity: idOf('1'), tokens: TOKENS, linkAccountId: null };
  const code = issuePendingCode(p, 1000);
  assert.deepEqual(consumePendingCode(code, 1000 + CODE_TTL_MS), p);
  assert.equal(consumePendingCode(code, 1000), null, 'druhé použití selže');
  const late = issuePendingCode(p, 1000);
  assert.equal(consumePendingCode(late, 1000 + CODE_TTL_MS + 1), null, 'po expiraci selže');
  assert.equal(consumePendingCode(late, 1000), null, 'expirovaný kód je i tak spotřebovaný');
  assert.equal(consumePendingCode('nonsense'), null);
});

test('resolveLinkTarget: jen shodný účet z Beareru', () => {
  assert.equal(resolveLinkTarget(7, 7), 7);
  assert.equal(resolveLinkTarget(7, null), null);
  assert.equal(resolveLinkTarget(7, 8), null);
  assert.equal(resolveLinkTarget(null, 7), null);
  assert.equal(resolveLinkTarget(null, null), null);
});

/**
 * Falešná „DB" se stejnou logikou jako completeWebLogin: známá identita → její účet;
 * jinak existingAccountId; jinak nový účet. Sessions = raw token → účet.
 */
function fakeStore() {
  let nextAccount = 100;
  const identities = new Map<string, number>(); // `${platform}:${userId}` → accountId
  const sessions = new Map<string, number>();
  const calls: Array<{ existing: number | null }> = [];
  const newSession = (accountId: number) => {
    const raw = createHash('sha256').update(`s${sessions.size}:${accountId}:${Math.random()}`).digest('hex');
    sessions.set(raw, accountId);
    return raw;
  };
  const deps: ExchangeDeps = {
    validateSession: async (raw) => sessions.get(raw) ?? null,
    completeLogin: async (platform, identity, _tokens, existing) => {
      calls.push({ existing });
      const key = `${platform}:${identity.platformUserId}`;
      let accountId = identities.get(key) ?? existing ?? null;
      if (accountId === null) accountId = nextAccount++;
      identities.set(key, accountId);
      return { accountId, sessionToken: newSession(accountId) };
    },
  };
  const account = (accountId: number, platform: Platform, userId: string) => {
    identities.set(`${platform}:${userId}`, accountId);
    return newSession(accountId);
  };
  return { deps, identities, calls, account, accountOf: (p: Platform, u: string) => identities.get(`${p}:${u}`) };
}

/** Callback (kind:'web') → vrátí kód z redirectu (#uc_code) a cílovou URL. */
async function runCallback(p: { returnTo?: string; webAccountId?: number }, platform: Platform, identity: IdentityInfo) {
  let location = '';
  const reply = { redirect: (url: string) => { location = url; return reply; } } as unknown as FastifyReply;
  const req = { log: { info() {}, warn() {}, error() {} } } as unknown as FastifyRequest;
  await completeWebCallback(req, reply, platform, p, identity, TOKENS);
  const u = new URL(location);
  const code = new URLSearchParams(u.hash.slice(1)).get('uc_code');
  assert.ok(code, 'redirect nese #uc_code');
  return { code: code!, location };
}

test('login CSRF: útočník pustí start se svou session, oběť dokončí souhlas → identita NEskončí u útočníka', async () => {
  const s = fakeStore();
  const ATTACKER = 1;
  const attackerSession = s.account(ATTACKER, 'twitch', 'attacker-tw');
  const victimTwitch = idOf('victim-tw', 'obet');

  // Oběť bez session v prohlížeči: výměna bez Beareru → nový účet, ne útočník.
  const a = await runCallback({ returnTo: 'https://robdiesalot.com/chat/', webAccountId: ATTACKER }, 'twitch', victimTwitch);
  assert.equal(s.calls.length, 0, 'callback do „DB" nesahá');
  const r1 = await exchangePendingCode(a.code, null, s.deps);
  assert.ok(r1);
  assert.notEqual(r1!.accountId, ATTACKER);
  assert.equal(r1!.linked, false);
  assert.equal(r1!.linkRefused, true);
  assert.equal(s.accountOf('twitch', 'victim-tw'), r1!.accountId);

  // Oběť s vlastní session (jiný účet): taky ne útočník; identita jde na svůj (nový) účet.
  const VICTIM = 2;
  const victimSession = s.account(VICTIM, 'kick', 'victim-kick');
  const victimYt = idOf('victim-yt');
  const b = await runCallback({ returnTo: 'https://robdiesalot.com/chat/', webAccountId: ATTACKER }, 'youtube', victimYt);
  const r2 = await exchangePendingCode(b.code, victimSession, s.deps);
  assert.ok(r2);
  assert.notEqual(r2!.accountId, ATTACKER);
  assert.notEqual(s.accountOf('youtube', 'victim-yt'), ATTACKER);
  assert.equal(r2!.linked, false);

  // Oběť, jejíž identita už účet má → zůstane na svém účtu.
  const c = await runCallback({ webAccountId: ATTACKER }, 'kick', idOf('victim-kick'));
  const r3 = await exchangePendingCode(c.code, null, s.deps);
  assert.equal(r3!.accountId, VICTIM);

  // Útočník do účtu nic nedostal.
  assert.ok(![...s.identities.entries()].some(([k, acc]) => acc === ATTACKER && k !== 'twitch:attacker-tw'));
  void attackerSession;
});

test('legitimní napojení: start i výměna se session téhož účtu → platforma na tom účtu', async () => {
  const s = fakeStore();
  const ME = 5;
  const mySession = s.account(ME, 'twitch', 'me-tw');
  const { code } = await runCallback({ returnTo: 'https://robdiesalot.com/chat/', webAccountId: ME }, 'kick', idOf('me-kick'));
  const r = await exchangePendingCode(code, mySession, s.deps);
  assert.equal(r!.accountId, ME);
  assert.equal(r!.linked, true);
  assert.equal(s.accountOf('kick', 'me-kick'), ME);
  assert.deepEqual(s.calls.at(-1), { existing: ME });
});

test('bez záměru napojení se Bearer ignoruje (běžné přihlášení)', async () => {
  const s = fakeStore();
  const mySession = s.account(9, 'twitch', 'x');
  const { code } = await runCallback({}, 'kick', idOf('new-kick'));
  const r = await exchangePendingCode(code, mySession, s.deps);
  assert.notEqual(r!.accountId, 9);
  assert.equal(r!.linked, false);
  assert.equal(r!.linkRefused, false);
});

test('výměna: kód jednorázový a s expirací', async () => {
  const s = fakeStore();
  const { code } = await runCallback({}, 'twitch', idOf('t1'));
  assert.ok(await exchangePendingCode(code, null, s.deps));
  assert.equal(await exchangePendingCode(code, null, s.deps), null, 'podruhé ne');
  const old = issuePendingCode({ platform: 'twitch', identity: idOf('t2'), tokens: TOKENS, linkAccountId: null }, 1000);
  assert.equal(await exchangePendingCode(old, null, s.deps, 1000 + CODE_TTL_MS + 1), null, 'po 5 min ne');
  assert.equal(s.calls.length, 1, 'neplatný kód nic nezaloží');
});

test('callback: returnTo mimo allowlist → výchozí web, ne cizí origin', async () => {
  const { location } = await runCallback({ returnTo: `https://${'a'.repeat(32)}.chromiumapp.org/` }, 'twitch', idOf('z'));
  assert.ok(location.startsWith('https://robdiesalot.com/chat/#uc_code='), location);
});

test('needsRefresh: bez expirace / do minuty = true', () => {
  const now = 1_000_000_000_000;
  assert.equal(needsRefresh(null, now), true);
  assert.equal(needsRefresh(new Date(now + 30_000), now), true);
  assert.equal(needsRefresh(new Date(now + 120_000), now), false);
});

test('isAllowedReturnTo: jen WEB_ORIGINS a NAŠE rozšíření, bez credentials v URL', () => {
  assert.equal(isAllowedReturnTo('https://robdiesalot.com/chat/'), true);
  assert.equal(isAllowedReturnTo('http://localhost:5173/chat/?debug=1'), true);
  assert.equal(isAllowedReturnTo('https://evil.example/chat/'), false);
  assert.equal(isAllowedReturnTo('https://user:pw@robdiesalot.com/'), false);
  assert.equal(isAllowedReturnTo('not a url'), false);
  // Chrome: jen ID z ALLOWED_AUTH_EXTENSION_IDS (výchozí = Chrome Web Store).
  assert.equal(isAllowedReturnTo('https://picaeipbmkgcippknkpkbnbgjlkblbnp.chromiumapp.org/'), true);
  assert.equal(isAllowedReturnTo(`https://${'a'.repeat(32)}.chromiumapp.org/`), false, 'cizí rozšíření');
  // Firefox: sha1("unitychat@jouki.cz").
  const ff = createHash('sha1').update('unitychat@jouki.cz').digest('hex');
  assert.equal(ff, '32f603ec9aeca37c2078fac9ec3497daa28ba5e5');
  assert.equal(isAllowedReturnTo(`https://${ff}.extensions.allizom.org/`), true);
  assert.equal(isAllowedReturnTo(`https://${'0f'.repeat(20)}.extensions.allizom.org/`), false, 'cizí doplněk');
  assert.equal(isAllowedReturnTo('https://evil.extensions.allizom.org/'), false);
});

test('bearerToken: jen 64 hex', () => {
  const tok = 'ab'.repeat(32);
  const req = (h?: string) => ({ headers: { authorization: h } }) as unknown as FastifyRequest;
  assert.equal(bearerToken(req(`Bearer ${tok.toUpperCase()}`)), tok);
  assert.equal(bearerToken(req('Bearer short')), null);
  assert.equal(bearerToken(req()), null);
});
