import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { userHistoryRoutes, optionalWebSession, UserHistoryMessagesQuery, UserHistoryQuery, parseInChannel } from './userHistory.js';
import { requireWebSession } from '../lib/webAuth.js';
import type { HistoryDeps } from '../lib/userHistory.js';
import type { Message } from '../db/schema.js';

const ROUTES = ['summary', 'messages', 'donations'] as const;
/** Jen pro moda (summary je veřejná s oříznutými poli). */
const MOD_ROUTES = ['messages', 'donations'] as const;
const url = (r: string, q = 'channel=robdiesalot&platform=twitch&userId=1') => `/moderation/user-history/${r}?${q}`;

/** Jako requireWebSession, jen bez DB: „Bearer mod“ = účet 1 (mod), „Bearer divak“ = účet 2. */
async function fakeSession(req: FastifyRequest, reply: FastifyReply) {
  const h = String(req.headers.authorization || '');
  const acc = h === 'Bearer mod' ? 1 : h === 'Bearer divak' ? 2 : null;
  if (acc === null) { reply.code(401); return reply.send({ ok: false, error: 'no session' }); }
  req.webAccountId = acc;
}
const fakeOptional = async (req: FastifyRequest) => { const h = String(req.headers.authorization || ''); return h === 'Bearer mod' ? 1 : h === 'Bearer divak' ? 2 : null; };

const row = (id: number, platform: 'twitch' | 'kick', userId: string, channel: string): Message => ({
  id, platform, platformMessageId: `m${id}`, platformUserId: userId, platformUsername: 'Spammer', userId: null, content: 'text', contentRaw: { badges: 'moderator/1' },
  channel, isUnitychatUser: false, isReply: false, replyToMessageId: null, sentAt: new Date(1_700_000_000_000 + id), createdAt: new Date(),
  deletedAt: null, deletedBy: null, deletedReason: null, hiddenAt: null, hiddenBy: null,
});

function historyDeps() {
  const calls: string[] = [];
  const spy = <T extends unknown[], R>(name: string, fn: (...a: T) => R) => (...a: T): R => { calls.push(name); return fn(...a); };
  const deps: HistoryDeps = {
    resolveTargets: spy('resolveTargets', async (channel: string, platform: string, userId: string) => (channel === 'robdiesalot' && platform === 'twitch' && userId === '1'
      ? { primary: { platform: 'twitch' as const, userId: '1', login: 'spammer' }, all: [{ platform: 'twitch' as const, userId: '1', login: 'spammer' }], accountId: 9 }
      : null)),
    accountIdentities: spy('accountIdentities', async () => []),
    channelGroups: spy('channelGroups', async () => [{ platform: 'twitch' as const, channel: 'robdiesalot', count: 1, firstAt: new Date(1), lastAt: new Date(2) }]),
    ucChannelOf: spy('ucChannelOf', async (_p: string, ch: string) => ch),
    latestName: spy('latestName', async () => 'Spammer'),
    nickname: spy('nickname', async () => null),
    moderation: spy('moderation', async () => []),
    messagesPage: spy('messagesPage', async () => [row(1, 'twitch', '1', 'robdiesalot')]),
    userIdByLogin: spy('userIdByLogin', async (channel: string, _p: string, login: string) => (channel === 'robdiesalot' && login.toLowerCase() === 'spammer' ? '1' : null)),
    donations: spy('donations', async (channel: string) => (channel === 'robdiesalot'
      ? [{ id: 'd1', amount: 150, currency: 'CZK', amountCzk: 150, paidAt: 5, via: 'qr', matchedBy: 'uc', nickname: 'spammer', message: 'díky' },
        { id: 'd2', amount: 99, currency: 'CZK', amountCzk: 99, paidAt: 4, via: 'qr', matchedBy: 'uc', nickname: 'tajny', message: 'anonym' },
        { id: 'd3', amount: 50, currency: 'CZK', amountCzk: 50, paidAt: 3, via: 'qr', matchedBy: 'nickname', nickname: 'spammer', message: 'odhad' }]
      : null)),
  };
  return { deps, calls };
}

async function app(opts: { session?: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>; optional?: (req: FastifyRequest) => Promise<number | null>; now?: () => number } = {}) {
  const h = historyDeps();
  const modCalls: string[] = [];
  const a = Fastify();
  await a.register(async (inst) => userHistoryRoutes(inst, {
    requireSession: opts.session ?? fakeSession,
    optionalSession: opts.optional ?? fakeOptional,
    modIdentities: async (accountId: number, channel: string) => { modCalls.push(`${accountId}:${channel}`); return accountId === 1 ? [{ platform: 'twitch' as const, login: 'modik', role: 'moderator' as const }] : []; },
    history: h.deps,
    defaultChannel: 'robdiesalot',
    now: opts.now,
  }));
  return { a, calls: h.calls, modCalls };
}

test('Profil: messages + donations bez tokenu 401 (skutečný requireWebSession), žádná data, no-store', async () => {
  const { a, calls, modCalls } = await app({ session: requireWebSession, optional: optionalWebSession });
  for (const r of MOD_ROUTES) {
    const res = await a.inject({ method: 'GET', url: url(r) });
    assert.equal(res.statusCode, 401, r);
    assert.equal(res.headers['cache-control'], 'no-store', `${r} no-store i u 401`);
  }
  assert.deepEqual(calls, [], 'bez tokenu se nic nenačte');
  assert.deepEqual(modCalls, [], 'ani ověření moda');
});

test('Profil: nemod u messages + donations 403 not_mod, data (DB ani Židolišta) se nenačtou — i podle loginu', async () => {
  const { a, calls } = await app();
  for (const r of MOD_ROUTES) {
    for (const q of ['channel=robdiesalot&platform=twitch&userId=1', 'channel=robdiesalot&platform=twitch&login=spammer']) {
      const res = await a.inject({ method: 'GET', url: url(r, q), headers: { authorization: 'Bearer divak' } });
      assert.equal(res.statusCode, 403, `${r} ${q}`);
      assert.deepEqual(res.json(), { ok: false, error: 'not_mod' });
      assert.equal(res.headers['cache-control'], 'no-store');
    }
  }
  assert.deepEqual(calls, []);
});

test('Profil: mod — summary (latest bez textu, dona), zprávy, dona; kanál gate jde do dotazu na dona', async () => {
  const { a, calls, modCalls } = await app();
  const s = await a.inject({ method: 'GET', url: url('summary'), headers: { authorization: 'Bearer mod' } });
  assert.equal(s.statusCode, 200);
  const b = s.json();
  assert.equal(b.latest.twitch.badgesRaw, 'moderator/1');
  assert.equal(b.latest.twitch.message, undefined, 'latest nenese text zprávy');
  assert.equal(b.view, 'mod');
  assert.deepEqual(b.donations.total, { czk: 299, byCurrency: { CZK: 299 } });
  assert.deepEqual(b.donations.uc, { czk: 249, count: 2 });
  assert.equal(b.donations.guess.czk, 50);
  assert.ok(Array.isArray(b.user.identities) && Array.isArray(b.channels) && Array.isArray(b.moderation));
  assert.equal(modCalls[0], '1:robdiesalot');
  const m = await a.inject({ method: 'GET', url: url('messages'), headers: { authorization: 'Bearer mod' } });
  assert.equal(m.statusCode, 200);
  assert.equal(m.json().messages.length, 1);
  const d = await a.inject({ method: 'GET', url: url('donations', 'channel=robdiesalot&platform=twitch&userId=1&workspace=cizi&slug=cizi'), headers: { authorization: 'Bearer mod' } });
  assert.equal(d.statusCode, 200);
  assert.deepEqual(d.json().items.map((i: { id: string }) => i.id), ['d1', 'd2', 'd3']);
  assert.ok(calls.includes('donations'));
});

test('Profil: otevření podle loginu jen s uživatelem z archivu aktuálního kanálu, jinak 404 (bez enumerace archivu)', async () => {
  const { a } = await app();
  const ok = await a.inject({ method: 'GET', url: url('summary', 'channel=robdiesalot&platform=twitch&login=SpAmMeR'), headers: { authorization: 'Bearer mod' } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().user.userId, '1');
  for (const r of ROUTES) {
    const miss = await a.inject({ method: 'GET', url: url(r, 'channel=robdiesalot&platform=twitch&login=nekdojiny'), headers: { authorization: 'Bearer mod' } });
    assert.equal(miss.statusCode, 404, r);
  }
  const bad = await a.inject({ method: 'GET', url: url('summary', 'channel=robdiesalot&platform=twitch'), headers: { authorization: 'Bearer mod' } });
  assert.equal(bad.statusCode, 400, 'bez userId i loginu');
});

const PUBLIC_KEYS = ['donations', 'latest', 'ok', 'user', 'view'];
const PUBLIC_USER = ['color', 'displayName', 'firstSeen', 'lastSeen', 'login', 'nickname', 'platform', 'total', 'userId'];

test('Profil veřejný: divák i nepřihlášený dostanou JEN veřejná pole (bez identities, channels, moderation, donations.items, czk, uc)', async () => {
  for (const [who, headers, optional] of [['divák', { authorization: 'Bearer divak' }, fakeOptional], ['nepřihlášený', {}, optionalWebSession]] as const) {
    const { a, calls, modCalls } = await app({ optional, session: requireWebSession });
    const res = await a.inject({ method: 'GET', url: url('summary'), headers });
    assert.equal(res.statusCode, 200, who);
    assert.equal(res.headers['cache-control'], 'no-store');
    const b = res.json();
    assert.deepEqual(Object.keys(b).sort(), PUBLIC_KEYS, who);
    assert.equal(b.view, 'public');
    assert.deepEqual(Object.keys(b.user).sort(), PUBLIC_USER, who);
    for (const k of ['identities', 'channels', 'moderation']) { assert.equal(b[k], undefined, `${who}: ${k}`); assert.equal(b.user[k], undefined, `${who}: user.${k}`); }
    assert.deepEqual(b.donations, { total: { czk: 299, byCurrency: { CZK: 299 } }, count: 3 }, `${who}: jen celková suma (bez uc, guess, items)`);
    assert.ok(!JSON.stringify(b).includes('anonym') && !JSON.stringify(b).includes('díky'), `${who}: žádné texty donů`);
    assert.ok(!calls.includes('moderation'), `${who}: moderace se ani nenačte`);
    if (who === 'divák') assert.deepEqual(modCalls, ['2:robdiesalot']); else assert.deepEqual(modCalls, []);
    const miss = await a.inject({ method: 'GET', url: url('summary', 'channel=robdiesalot&platform=twitch&login=nekdojiny'), headers });
    assert.equal(miss.statusCode, 404, `${who}: mimo archiv kanálu 404`);
  }
});

test('Profil veřejný: limit per IP PŘED ověřením tokenu — náhodné Bearer tokeny nedělají dotazy do DB', async () => {
  let sessions = 0;
  const { a } = await app({ optional: async () => { sessions++; return null; }, now: () => 1000 });
  const codes: number[] = [];
  for (let i = 0; i < 12; i++) codes.push((await a.inject({ method: 'GET', url: url('summary'), headers: { authorization: `Bearer nahodny${i}` } })).statusCode);
  assert.deepEqual(codes.slice(9), [200, 429, 429]);
  assert.equal(sessions, 10, 'po vyčerpání IP limitu se token vůbec neověřuje');
});

test('Profil veřejný: bez přihlášení rate limit per IP', async () => {
  const { a } = await app({ optional: optionalWebSession, now: () => 1000 });
  const codes: number[] = [];
  for (let i = 0; i < 12; i++) codes.push((await a.inject({ method: 'GET', url: url('summary') })).statusCode);
  assert.deepEqual(codes.slice(9), [200, 429, 429]);
});

test('Profil: rate limit na účet (429), dona mají vlastní limit', async () => {
  const { a } = await app({ now: () => 1000 });
  const codes: number[] = [];
  for (let i = 0; i < 7; i++) codes.push((await a.inject({ method: 'GET', url: url('summary'), headers: { authorization: 'Bearer mod' } })).statusCode);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
  assert.equal((await a.inject({ method: 'GET', url: url('donations'), headers: { authorization: 'Bearer mod' } })).statusCode, 200);
});

test('Profil: query + záložka (UC kanál i nenamapovaný Kick slug s pomlčkou)', () => {
  assert.equal(UserHistoryMessagesQuery.safeParse({ platform: 'twitch', userId: '1' }).success, true);
  assert.equal(UserHistoryMessagesQuery.safeParse({ platform: 'twitch', login: 'x' }).success, true);
  assert.equal(UserHistoryQuery.safeParse({ platform: 'twitch' }).success, false);
  assert.equal(UserHistoryMessagesQuery.safeParse({ platform: 'discord', userId: '1' }).success, false);
  assert.equal(UserHistoryMessagesQuery.safeParse({ platform: 'twitch', userId: '' }).success, false);
  assert.equal(parseInChannel(undefined, 'robdiesalot'), 'robdiesalot');
  assert.equal(parseInChannel('@TenSterakDary', 'x'), 'tensterakdary');
  assert.equal(parseInChannel('some-slug.x', 'x'), 'some-slug.x');
  assert.equal(parseInChannel('a b', 'x'), null);
});
