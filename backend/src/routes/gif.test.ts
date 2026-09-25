import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediaServer, mediaCacheControl, gifStateFor, gifHeldState, parseHeldIds, GIF_HELD_BATCH, type MediaEntry, type GifStateDeps, type GifHeldDeps } from './gif.js';
import type { Message } from '../db/schema.js';

const entry = (status: MediaEntry['status'] = 'pending'): MediaEntry => ({ bytes: Buffer.from('GIF89a'), contentType: 'image/gif', status });
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

test('MediaServer: souběžná čtení téhož média sdílí jedno načtení z DB (bod 1), pak z cache', async () => {
  let loads = 0;
  const d = deferred<MediaEntry | null>();
  const s = new MediaServer(async () => { loads++; return d.promise; });
  const all = Array.from({ length: 200 }, () => s.get('a'));
  assert.equal(s._inflightSize, 1);
  d.resolve(entry());
  const got = await Promise.all(all);
  assert.equal(loads, 1);
  assert.ok(got.every((g) => g === got[0]));
  await s.get('a');
  assert.equal(loads, 1, 'z cache');
  assert.equal(s._inflightSize, 0);
});

test('MediaServer.prewarm: schválené médium je v cache se stavem approved (bod 1/4)', async () => {
  let loads = 0;
  const s = new MediaServer(async () => { loads++; return entry('approved'); });
  await s.prewarm('a');
  assert.equal(loads, 1);
  assert.equal((await s.get('a'))!.status, 'approved');
  assert.equal(loads, 1);
  // Čekající v cache → po schválení se jen přepne stav.
  const p = new MediaServer(async () => entry('pending'));
  assert.equal((await p.get('b'))!.status, 'pending');
  await p.prewarm('b');
  assert.equal((await p.get('b'))!.status, 'approved');
});

test('MediaServer: tombstone — smazané/zamítnuté médium se nevrátí z cache ani z načtení běžícího souběžně (bod 4)', async () => {
  const s = new MediaServer(async () => entry());
  await s.get('a');
  s.forget('a');
  assert.equal(await s.get('a'), null);

  const d = deferred<MediaEntry | null>();
  const r = new MediaServer(async () => d.promise);
  const pending = r.get('b');
  r.forget('b'); // zamítnuto, zatímco se médium načítá z DB
  d.resolve(entry());
  assert.equal(await pending, null);
  assert.equal(await r.get('b'), null);
});

test('mediaCacheControl: čekající private no-store, schválené hodina bez immutable (bod 4)', () => {
  assert.equal(mediaCacheControl('pending'), 'private, no-store');
  assert.equal(mediaCacheControl('approved'), 'public, max-age=3600');
});

function stateDeps(over: Partial<GifStateDeps> = {}, log: unknown[] = []): GifStateDeps {
  return {
    workspaceSlug: async (ch) => (ch === 'robdiesalot' ? 'rob' : null),
    identities: async () => [{ platform: 'twitch', login: 'Divak', platformUserId: '42' }, { platform: 'kick', login: 'divak_k', platformUserId: 'k9' }],
    platformChannel: async (_c, p) => (p === 'kick' ? 'robdiesalot_kick' : null),
    role: async () => 'sub',
    access: async (q) => { log.push(q); return { allowed: true, until: null, cooldownUntil: 2_000_000 + 30_000, cooldownSec: 120, requestTtlSec: 300 }; },
    now: () => 2_000_000,
    ...over,
  };
}

test('gifStateFor: cooldown vlastní identity na platformě, kam píše (role z archivu), serverNow', async () => {
  const log: unknown[] = [];
  const s = await gifStateFor(7, { channel: 'robdiesalot', platform: 'kick' }, stateDeps({}, log));
  assert.deepEqual(s, { ok: true, allowed: true, cooldownUntil: 2_030_000, cooldownSec: 120, serverNow: 2_000_000 });
  assert.deepEqual(log[0], { workspace: 'rob', platform: 'kick', userId: 'k9', login: 'divak_k', role: 'sub' });
  // Prošlý cooldown → null; bez platformy první identita.
  const past = await gifStateFor(7, { channel: 'robdiesalot' }, stateDeps({ access: async () => ({ allowed: true, until: null, cooldownUntil: 1, cooldownSec: 60, requestTtlSec: 300 }) }));
  assert.equal(past.cooldownUntil, null);
});

test('gifStateFor: mod bez Dev módu = povoleno bez cooldownu (Židolišta se neptá); s review jako divák', async () => {
  const log: unknown[] = [];
  const mod = await gifStateFor(7, { channel: 'robdiesalot', platform: 'twitch' }, stateDeps({ role: async () => 'moderator' }, log));
  assert.deepEqual(mod, { ok: true, allowed: true, cooldownUntil: null, cooldownSec: 0, serverNow: 2_000_000, mod: true });
  assert.equal(log.length, 0);
  const rev = await gifStateFor(7, { channel: 'robdiesalot', platform: 'twitch', review: true }, stateDeps({ role: async () => 'moderator' }, log));
  assert.equal(rev.cooldownUntil, 2_030_000);
  assert.equal((log[0] as { role: string }).role, 'moderator');
});

test('gifStateFor: neznámý kanál / bez identity na platformě / Židolišta nedostupná → neodemčeno', async () => {
  const none = { ok: true, allowed: false, cooldownUntil: null, cooldownSec: 0, serverNow: 2_000_000 };
  assert.deepEqual(await gifStateFor(7, { channel: 'cizi' }, stateDeps()), none);
  assert.deepEqual(await gifStateFor(7, { channel: 'robdiesalot', platform: 'youtube' }, stateDeps()), none);
  assert.deepEqual(await gifStateFor(7, { channel: 'robdiesalot', platform: 'twitch' }, stateDeps({ access: async () => null })), none);
  // Odemčení vypršelo.
  const exp = await gifStateFor(7, { channel: 'robdiesalot', platform: 'twitch' }, stateDeps({ access: async () => ({ allowed: true, until: 1, cooldownUntil: null, cooldownSec: 0, requestTtlSec: 300 }) }));
  assert.equal(exp.allowed, false);
});

// ---- GET /gif/held (pojistka klientů pro zprávy schované jako gif_request) ----

const row = (id: string, over: Partial<Message> = {}): Message => ({
  id: 1, platform: 'twitch', platformMessageId: id, platformUserId: '42', platformUsername: 'Jouki', content: 'https://i.4pcdn.org/pol/1.gif',
  contentRaw: {}, channel: 'robdiesalot', isUnitychatUser: false, isReply: false, replyToMessageId: null, sentAt: new Date(1000),
  receivedAt: new Date(1000), deletedAt: null, deletedBy: null, deletedReason: null, ...over,
} as Message);

function heldDeps(rows: Record<string, Message | null>, over: Partial<GifHeldDeps> = {}) {
  const calls: string[] = [];
  const deps: GifHeldDeps = {
    inFlight: () => false,
    requestStatus: async () => null,
    row: async (_p, id) => rows[id] ?? null,
    platformChannel: async (ch, p) => (p === 'twitch' ? ch : null),
    restore: async (p) => { calls.push(`restore:${p.messageId}`); return 'ok'; },
    retag: async (_p, id, from, to) => { calls.push(`retag:${id}:${from}->${to}`); return true; },
    ...over,
  };
  return { deps, calls };
}

test('parseHeldIds: platné klíče, bez duplicit, strop dávky', () => {
  assert.deepEqual(parseHeldIds('twitch:a,kick:b,twitch:a,evil:c,youtube:'), [{ platform: 'twitch', messageId: 'a' }, { platform: 'kick', messageId: 'b' }]);
  assert.equal(parseHeldIds(Array.from({ length: 80 }, (_, i) => `twitch:m${i}`).join(',')).length, GIF_HELD_BATCH);
  assert.deepEqual(parseHeldIds(undefined), []);
});

test('gifHeldState: zaseknutý gif_request bez žádosti a bez zachycení → obnovit (message-restored všem) + visible s obsahem', async () => {
  const { deps, calls } = heldDeps({ f6: row('f6', { deletedAt: new Date(), deletedBy: 'filter', deletedReason: 'gif_request' }) });
  const [r] = await gifHeldState('robdiesalot', [{ platform: 'twitch', messageId: 'f6' }], deps);
  assert.equal(r.state, 'visible');
  assert.equal((r.message as unknown as Record<string, unknown>).message, 'https://i.4pcdn.org/pol/1.gif');
  assert.deepEqual(calls, ['restore:f6']);
});

test('gifHeldState: běžící zachycení / čekající žádost = held; schváleno = replaced; zamítnuto = deleted gif_rejected (archiv dorovnán)', async () => {
  const held = row('a', { deletedAt: new Date(), deletedReason: 'gif_request' });
  const inflight = heldDeps({ a: held }, { inFlight: () => true });
  assert.equal((await gifHeldState('robdiesalot', [{ platform: 'twitch', messageId: 'a' }], inflight.deps))[0].state, 'held');
  assert.deepEqual(inflight.calls, []);
  const pend = heldDeps({ a: held }, { requestStatus: async () => 'pending' });
  assert.equal((await gifHeldState('robdiesalot', [{ platform: 'twitch', messageId: 'a' }], pend.deps))[0].state, 'held');
  const appr = heldDeps({ a: held }, { requestStatus: async () => 'approved' });
  assert.equal((await gifHeldState('robdiesalot', [{ platform: 'twitch', messageId: 'a' }], appr.deps))[0].state, 'replaced');
  const rej = heldDeps({ a: held }, { requestStatus: async () => 'expired' });
  assert.deepEqual((await gifHeldState('robdiesalot', [{ platform: 'twitch', messageId: 'a' }], rej.deps))[0], { platform: 'twitch', messageId: 'a', state: 'deleted', reason: 'gif_rejected' });
  assert.deepEqual(rej.calls, ['retag:a:gif_request->gif_rejected']);
});

test('gifHeldState: nesmazaný řádek = visible; jiný důvod = deleted; cizí kanál / chybí = unknown', async () => {
  const { deps, calls } = heldDeps({
    ok: row('ok'),
    lf: row('lf', { deletedAt: new Date(), deletedReason: 'link_filter' }),
    cizi: row('cizi', { channel: 'jinykanal' }),
  });
  const out = await gifHeldState('robdiesalot', ['ok', 'lf', 'cizi', 'nic'].map((messageId) => ({ platform: 'twitch' as const, messageId })), deps);
  assert.deepEqual(out.map((o) => o.state), ['visible', 'deleted', 'unknown', 'unknown']);
  assert.equal(out[1].reason, 'link_filter');
  assert.equal(out[2].message, undefined, 'cizí kanál bez obsahu');
  // Platforma bez kanálu v registru → unknown, bez dotazu na řádek.
  const k = await gifHeldState('robdiesalot', [{ platform: 'kick', messageId: 'ok' }], deps);
  assert.equal(k[0].state, 'unknown');
  assert.deepEqual(calls, []);
});
