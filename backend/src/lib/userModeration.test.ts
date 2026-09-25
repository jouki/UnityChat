import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishUserModerated, banState, _resetUserModeratedDedup, type UserModeratedDeps } from './userModeration.js';

function deps(t: { now: number }, sent: Array<{ event: string; data: Record<string, unknown> }>, integ: unknown[] = [], over: Partial<UserModeratedDeps> = {}): UserModeratedDeps {
  return {
    broadcast: (event, data) => sent.push({ event, data: data as Record<string, unknown> }),
    integration: (ev, d) => { integ.push({ ev, d }); },
    now: () => t.now,
    ...over,
  };
}
const base = { channel: 'robdiesalot', platform: 'twitch' as const, userId: '42', login: 'spammer', by: 'twitch:modik' };

test('user-moderated: tvar SSE (bez důvodu), until u timeoutu, null u banu/unbanu', async () => {
  _resetUserModeratedDedup();
  const t = { now: 1000 };
  const sent: Array<{ event: string; data: Record<string, unknown> }> = [];
  const integ: unknown[] = [];
  await publishUserModerated({ ...base, action: 'timeout', durationSec: 300, source: 'uc' }, deps(t, sent, integ));
  await publishUserModerated({ ...base, action: 'ban', durationSec: null, source: 'uc' }, deps(t, sent, integ));
  assert.deepEqual(sent[0], { event: 'user-moderated', data: { channel: 'robdiesalot', platform: 'twitch', userId: '42', login: 'spammer', action: 'timeout', until: 301_000, by: 'twitch:modik', at: 1000 } });
  assert.equal(sent[1].data.until, null);
  assert.equal(Object.keys(sent[0].data).includes('reason'), false);
  assert.deepEqual((integ[0] as { d: number }).d, 300);
  assert.equal((integ[1] as { d: number | null }).d, null);
});

test('user-moderated: CLEARCHAT echo vlastní akce do 30 s se přeskočí; vlastní akce se vysílá vždy; po 30 s platforma projde', async () => {
  _resetUserModeratedDedup();
  const t = { now: 5000 };
  const sent: Array<{ event: string; data: Record<string, unknown> }> = [];
  await publishUserModerated({ ...base, action: 'timeout', durationSec: 60, source: 'uc' }, deps(t, sent));
  t.now += 2000;
  assert.equal(await publishUserModerated({ ...base, by: null, action: 'timeout', durationSec: 60, source: 'platform' }, deps(t, sent)), null);
  await publishUserModerated({ ...base, action: 'timeout', durationSec: 3600, source: 'uc' }, deps(t, sent));
  assert.equal(sent.length, 2);
  t.now += 31_000;
  assert.ok(await publishUserModerated({ ...base, by: null, action: 'timeout', durationSec: 60, source: 'platform' }, deps(t, sent)));
  assert.equal(sent.length, 3);
});

test('user-moderated: re-timeout odjinud s JINOU délkou do 30 s se nespolkne (nové until)', async () => {
  _resetUserModeratedDedup();
  const t = { now: 5000 };
  const sent: Array<{ event: string; data: Record<string, unknown> }> = [];
  await publishUserModerated({ ...base, action: 'timeout', durationSec: 60, source: 'uc' }, deps(t, sent));
  t.now += 1000;
  const ev = await publishUserModerated({ ...base, by: null, action: 'timeout', durationSec: 600, source: 'platform' }, deps(t, sent));
  assert.equal(ev?.until, 6000 + 600_000);
  assert.equal(sent.length, 2);
});

test('user-moderated: chyba integrace nevyhodí', async () => {
  _resetUserModeratedDedup();
  const sent: Array<{ event: string; data: Record<string, unknown> }> = [];
  const ev = await publishUserModerated({ ...base, action: 'unban', durationSec: null, source: 'uc' }, deps({ now: 1 }, sent, [], { integration: async () => { throw new Error('registry down'); } }));
  assert.equal(ev!.action, 'unban');
  assert.equal(sent.length, 1);
});

test('banState: propadlý timeout = žádný ban, permanentní i běžící platí', () => {
  assert.equal(banState(null, 10), null);
  assert.equal(banState({ until: new Date(5), youtubeBanId: null }, 10), null);
  assert.deepEqual(banState({ until: new Date(50), youtubeBanId: null }, 10), { until: new Date(50), youtubeBanId: null });
  assert.deepEqual(banState({ until: null, youtubeBanId: 'B' }, 10), { until: null, youtubeBanId: 'B' });
});
