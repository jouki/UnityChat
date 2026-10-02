import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import giveawayRoutes from './giveaway.js';
import { GiveawayService, memoryRepo } from '../lib/giveaway.js';

// Bearer mod → účet 1 (mod), Bearer d2 / d3 → diváci 2 / 3 (2 je dárce, 3 ne).
const fakeSession = async (req: FastifyRequest, reply: FastifyReply) => {
  const m = /^Bearer (\w+)$/.exec(String(req.headers.authorization || ''));
  const map: Record<string, number> = { mod: 1, d2: 2, d3: 3 };
  if (!m || !map[m[1]]) { reply.code(401).send({ ok: false, error: 'unauthorized' }); return; }
  req.webAccountId = map[m[1]];
};
const modGate = async (req: FastifyRequest, reply: FastifyReply, ch: string | undefined) => {
  if (req.webAccountId !== 1) { reply.code(403).send({ ok: false, error: 'not_mod' }); return null; }
  return { channel: String(ch), accountId: 1, by: 'twitch:modik' };
};

async function app() {
  const states: unknown[] = [];
  const service = new GiveawayService({
    repo: memoryRepo(),
    random: () => 0,
    onChange: (_c, s) => states.push(s),
    donorCheck: async (acc) => ({ ok: acc === 2, name: `User${acc}`, platform: 'kick' }),
    setTimer: () => 0, clearTimer: () => {},
  });
  const a = Fastify();
  await a.register((inst) => giveawayRoutes(inst, { requireSession: fakeSession, modGate, service }));
  const call = (method: 'GET' | 'POST', url: string, who?: string, payload?: object) =>
    a.inject({ method, url, payload, headers: who ? { authorization: `Bearer ${who}` } : {} });
  return { a, call, states };
}

test('giveaway routes: mod vyhlásí, dárce se připojí, nedárce 403, divák nesmí losovat, výherce potvrdí', async () => {
  const { call, states } = await app();
  assert.deepEqual((await call('GET', '/giveaway?channel=robdiesalot')).json().giveaway, null);
  assert.equal((await call('POST', '/moderation/giveaway/start', 'd2', { channel: 'robdiesalot', prize: 'Klíč' })).statusCode, 403);
  assert.equal((await call('POST', '/moderation/giveaway/start', undefined, { channel: 'robdiesalot', prize: 'Klíč' })).statusCode, 401);
  const st = await call('POST', '/moderation/giveaway/start', 'mod', { channel: 'RobDiesALot', prize: 'Klíč', confirmMinutes: 5 });
  assert.equal(st.statusCode, 200);
  assert.equal(st.json().giveaway.channel, 'robdiesalot');
  assert.equal((await call('POST', '/moderation/giveaway/start', 'mod', { channel: 'robdiesalot', prize: 'x' })).json().error, 'active');

  assert.equal((await call('POST', '/giveaway/join', 'd3', { channel: 'robdiesalot' })).json().error, 'not_donor');
  const j = await call('POST', '/giveaway/join', 'd2', { channel: 'robdiesalot' });
  assert.equal(j.json().giveaway.count, 1);
  const pub = (await call('GET', '/giveaway?channel=robdiesalot')).json();
  assert.deepEqual(pub.giveaway.names, ['User2']);
  assert.equal(typeof pub.serverNow, 'number');
  assert.equal(JSON.stringify(pub).includes('accountId'), false);
  assert.deepEqual((await call('GET', '/giveaway/me?channel=robdiesalot', 'd2')).json(), { ok: true, joined: true, isWinner: false, eligible: true });

  assert.equal((await call('POST', '/moderation/giveaway/draw', 'd2', { channel: 'robdiesalot' })).statusCode, 403);
  const d = await call('POST', '/moderation/giveaway/draw', 'mod', { channel: 'robdiesalot' });
  assert.deepEqual(d.json().giveaway.winner, { name: 'User2', platform: 'kick' });
  assert.equal((await call('POST', '/giveaway/confirm', 'd3', { channel: 'robdiesalot' })).json().error, 'not_winner');
  assert.equal((await call('POST', '/giveaway/confirm', 'd2', { channel: 'robdiesalot' })).json().giveaway.status, 'confirmed');
  assert.equal((await call('POST', '/moderation/giveaway/end', 'mod', { channel: 'robdiesalot' })).json().giveaway.status, 'ended');
  assert.ok(states.length >= 5, 'každá změna → SSE');
  assert.equal((await call('POST', '/giveaway/join', 'd2', { channel: 'robdiesalot', extra: 1 })).statusCode, 400, 'strict body');
  assert.equal((await call('GET', '/giveaway?channel=../x')).statusCode, 400);
});
