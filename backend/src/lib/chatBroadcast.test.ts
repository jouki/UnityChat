import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBroadcast, type BroadcastDeps } from './chatBroadcast.js';
import { SendError } from './webSend.js';
import type { Platform } from './zidolista.js';

const MOD = [{ platform: 'twitch' as Platform, login: 'jouki728', role: 'moderator' as const }];

function deps(over: Partial<BroadcastDeps> & { linked?: Platform[]; sent?: string[] } = {}): BroadcastDeps {
  const sent = over.sent ?? [];
  return {
    pendingWarnings: async () => [],
    modIdentities: async () => MOD,
    listIdentities: async () => (over.linked ?? ['twitch', 'kick', 'youtube']).map((platform) => ({ platform })),
    send: async (p, text) => { sent.push(`${p}:${text}`); return { id: `${p}-1` }; },
    ...over,
  };
}

test('bez role moda / streamera se nic neodešle (403 not_mod) — klient roli podstrčit nemůže', async () => {
  const sent: string[] = [];
  const out = await runBroadcast({ accountId: 1, channel: 'robdiesalot', text: 'ahoj' }, deps({ modIdentities: async () => [], sent }));
  assert.equal(out.status, 403);
  assert.equal(out.body.error, 'not_mod');
  assert.deepEqual(sent, []);
});

test('selhání ověření role = nic se neodešle (fail closed)', async () => {
  const sent: string[] = [];
  const out = await runBroadcast({ accountId: 1, channel: 'robdiesalot', text: 'ahoj' }, deps({ modIdentities: async () => { throw new Error('db down'); }, sent }));
  assert.equal(out.status, 503);
  assert.deepEqual(sent, []);
});

test('mod: zpráva na všechny přihlášené platformy s markerem UnityChatu', async () => {
  const sent: string[] = [];
  const out = await runBroadcast({ accountId: 1, channel: 'robdiesalot', text: '  ahoj všichni ' }, deps({ sent }));
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  assert.deepEqual(sent.map((x) => x.split(':')[0]), ['twitch', 'kick', 'youtube']);
  assert.ok(sent.every((x) => x.endsWith('ahoj všichni ⠀')));
  assert.deepEqual(Object.keys(out.body.results as object), ['twitch', 'kick', 'youtube']);
});

test('jen přihlášené platformy; méně než dvě = 400 targets', async () => {
  const sent: string[] = [];
  const two = await runBroadcast({ accountId: 1, channel: 'robdiesalot', text: 'x' }, deps({ linked: ['youtube', 'twitch'], sent }));
  assert.deepEqual(Object.keys(two.body.results as object), ['twitch', 'youtube']);
  const one = await runBroadcast({ accountId: 1, channel: 'robdiesalot', text: 'x' }, deps({ linked: ['twitch'] }));
  assert.equal(one.status, 400);
  assert.equal(one.body.error, 'targets');
});

test('command s vykřičníkem jde Broadcastem na všechny platformy (bez markeru); lomítkový a GIF odkaz ne', async () => {
  // Pokyn usera 2026-09-29: „přece jen je to broadcast“ — !command (i StreamElements) na všechny platformy.
  const bang: string[] = [];
  const ok = await runBroadcast({ accountId: 1, channel: 'robdiesalot', text: '!logi' }, deps({ sent: bang }));
  assert.equal(ok.status, 200);
  assert.deepEqual(bang, ['twitch:!logi', 'kick:!logi', 'youtube:!logi']);
  const sent: string[] = [];
  // Lomítkové commandy jsou věc platformy (/me, /timeout…) → dál jen na vybranou platformu přes /chat/send.
  const slash = await runBroadcast({ accountId: 1, channel: 'robdiesalot', text: '/me ahoj' }, deps({ sent }));
  assert.equal(slash.body.error, 'command');
  const gif = await runBroadcast({ accountId: 1, channel: 'robdiesalot', text: 'koukej https://media.tenor.com/abc/x.gif' }, deps({ sent }));
  assert.equal(gif.body.error, 'gif');
  assert.deepEqual(sent, []);
});

test('texty pro jednotlivé platformy: každá svůj, kontrola i na nich (command / GIF nejde propašovat)', async () => {
  const sent: string[] = [];
  const out = await runBroadcast({ accountId: 1, channel: 'robdiesalot', text: '@Přezdívka ahoj', texts: { twitch: '@jouki728 ahoj', youtube: '@jouki ahoj' } }, deps({ sent }));
  assert.equal(out.status, 200);
  assert.deepEqual(sent, ['twitch:@jouki728 ahoj ⠀', 'kick:@Přezdívka ahoj ⠀', 'youtube:@jouki ahoj ⠀']);
  const cmd = await runBroadcast({ accountId: 1, channel: 'robdiesalot', text: 'ahoj', texts: { kick: '/ban nekdo' } }, deps({ sent: [] }));
  assert.equal(cmd.body.error, 'command');
  const gif = await runBroadcast({ accountId: 1, channel: 'robdiesalot', text: 'ahoj', texts: { youtube: 'https://media.tenor.com/a/b.gif' } }, deps({ sent: [] }));
  assert.equal(gif.body.error, 'gif');
});

test('nepotvrzené varování blokuje', async () => {
  const out = await runBroadcast({ accountId: 1, channel: 'robdiesalot', text: 'x' }, deps({ pendingWarnings: async () => [{}] }));
  assert.equal(out.status, 403);
  assert.equal(out.body.error, 'warning_pending');
});

test('částečné selhání: výsledek po platformách, 200 dokud aspoň jedna prošla; všechny selhaly = 502', async () => {
  const out = await runBroadcast({ accountId: 1, channel: 'robdiesalot', text: 'x' }, deps({
    send: async (p) => { if (p === 'kick') throw new SendError('kick: token expired, login again', 401); return { id: `${p}-1` }; },
  }));
  assert.equal(out.status, 200);
  const r = out.body.results as Record<string, { ok: boolean; status?: number }>;
  assert.equal(r.kick.ok, false);
  assert.equal(r.kick.status, 401);
  assert.equal(r.twitch.ok, true);
  const all = await runBroadcast({ accountId: 1, channel: 'robdiesalot', text: 'x' }, deps({ send: async () => { throw new Error('down'); } }));
  assert.equal(all.status, 502);
  assert.equal(all.body.ok, false);
});

test('skupina broadcastu: cíle se doplní před odesláním (send je už vidí), odpověď nese id skupiny', async () => {
  const group = { id: 'g1', targets: [] as string[] };
  const seen: string[][] = [];
  const out = await runBroadcast({ accountId: 1, channel: 'robdiesalot', text: 'ahoj', group }, deps({ linked: ['twitch', 'youtube'], send: async (p) => { seen.push([...group.targets]); return { id: `${p}-1` }; } }));
  assert.equal(out.body.group, 'g1');
  assert.deepEqual(group.targets, ['twitch', 'youtube']);
  assert.deepEqual(seen, [['twitch', 'youtube'], ['twitch', 'youtube']]);
});
