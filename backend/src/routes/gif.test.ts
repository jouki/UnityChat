import { test } from 'node:test';
import assert from 'node:assert/strict';
import { servableStatus } from '../lib/gifRequests.js';
import { MediaServer, mediaCacheControl, mediaAllowed, rejectedView, discardedView, parseRejectedCursor, gifStateFor, gifHeldState, parseHeldIds, GIF_HELD_BATCH, type MediaEntry, type GifStateDeps, type GifHeldDeps } from './gif.js';
import type { Message } from '../db/schema.js';

const entry = (status: MediaEntry['status'] = 'pending'): MediaEntry => ({ bytes: Buffer.from('GIF89a'), contentType: 'image/gif', status });
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

test('MediaServer: souběžná čtení téhož média sdílí jedno načtení z DB (bod 1), pak z cache', async () => {
  let loads = 0;
  const d = deferred<MediaEntry | null>();
  const s = new MediaServer(async () => { loads++; return d.promise; });
  const all = Array.from({ length: 200 }, () => s.get('a'));
  assert.equal(s._inflightSize, 1);
  d.resolve(entry('approved'));
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

test('mediaCacheControl: čekající a zamítnuté private no-store, schválené hodina bez immutable (bod 4)', () => {
  assert.equal(mediaCacheControl('pending'), 'private, no-store');
  assert.equal(mediaCacheControl('rejected'), 'private, no-store');
  assert.equal(mediaCacheControl('approved'), 'public, max-age=300');
});

test('mediaAllowed: schválené a čekající veřejně; zamítnuté jen s platným tokenem pro kanál média (bez / špatný / nemod → ne)', async () => {
  const seen: Array<[string | undefined, string]> = [];
  const verify = async (t: string | undefined | null, ch: string) => { seen.push([t ?? undefined, ch]); return t === 'dobry' && ch === 'robdiesalot'; };
  const rej = { ...entry(), status: 'rejected' as const, channel: 'robdiesalot' };
  assert.equal(await mediaAllowed(entry('approved'), undefined, verify), true);
  assert.equal(await mediaAllowed(entry('pending'), undefined, verify), true);
  assert.equal(seen.length, 0, 'veřejné médium token neověřuje');
  assert.equal(await mediaAllowed(rej, undefined, verify), false);
  assert.equal(await mediaAllowed(rej, 'spatny', verify), false);
  assert.equal(await mediaAllowed(rej, 'dobry', verify), true);
  assert.equal(await mediaAllowed({ ...rej, channel: 'cizi' }, 'dobry', verify), false);
  assert.equal(await mediaAllowed({ ...rej, channel: null }, 'dobry', verify), false, 'bez kanálu nikdy');
});

test('MediaServer: čekající a zamítnuté se necachují (každé čtení z DB), schválené ano', async () => {
  let loads = 0;
  let status: MediaEntry['status'] = 'pending';
  const s = new MediaServer(async () => { loads++; return { ...entry(), status }; });
  await s.get('a'); await s.get('a');
  assert.equal(loads, 2);
  status = 'rejected';
  await s.get('a'); await s.get('a');
  assert.equal(loads, 4);
  status = 'approved';
  await s.get('a'); await s.get('a');
  assert.equal(loads, 5);
});

test('GET /media/gif: propadnutí žádosti na dříve zamítnutém médiu → bez tokenu 404 (stav bez zastaralé cache)', async () => {
  const { default: Fastify } = await import('fastify');
  const { default: gifRoutes } = await import('./gif.js');
  const id = 'e'.repeat(32);
  // Zamítnuté médium s čekající žádostí = veřejné (servableMedia vrací pending); po propadnutí rejected.
  let status: MediaEntry['status'] = 'pending';
  const media = new MediaServer(async () => ({ bytes: Buffer.from('GIF89a'), contentType: 'image/gif', status, channel: 'robdiesalot' }));
  const app = Fastify();
  await app.register(gifRoutes, { flow: {} as never, store: {} as never, media, tokens: { issue: async () => 'x', verify: async () => false } });
  assert.equal((await app.inject({ method: 'GET', url: `/media/gif/${id}` })).statusCode, 200);
  status = 'rejected';
  assert.equal((await app.inject({ method: 'GET', url: `/media/gif/${id}` })).statusCode, 404);
  await app.close();
});

test('MediaServer.invalidate: změna stavu (zamítnuto) → další čtení z DB, bez tombstone', async () => {
  let status: MediaEntry['status'] = 'pending';
  let loads = 0;
  const s = new MediaServer(async () => { loads++; return { ...entry(), status }; });
  assert.equal((await s.get('a'))!.status, 'pending');
  status = 'rejected';
  s.invalidate('a');
  assert.equal((await s.get('a'))!.status, 'rejected');
  assert.equal(loads, 2);
});

test('GET /media/gif/:id: zamítnuté bez tokenu / se špatným 404, s platným 200 private no-store; routy akcí se zaregistrují vedle /decide', async () => {
  const { default: Fastify } = await import('fastify');
  const { default: gifRoutes } = await import('./gif.js');
  const app = Fastify();
  const id = 'f'.repeat(32);
  const media = new MediaServer(async (x) => (x === id ? { bytes: Buffer.from('GIF89a'), contentType: 'image/gif', status: 'rejected', channel: 'robdiesalot' } : null));
  const verify = async (t: string | undefined | null, ch: string) => t === 'T'.repeat(43) && ch === 'robdiesalot';
  await app.register(gifRoutes, { flow: {} as never, store: {} as never, media, tokens: { issue: async () => 'x', verify } });
  await app.ready();
  assert.equal((await app.inject({ method: 'GET', url: `/media/gif/${id}` })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/media/gif/${id}?t=spatny` })).statusCode, 404);
  const ok = await app.inject({ method: 'GET', url: `/media/gif/${id}?t=${'T'.repeat(43)}` });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['cache-control'], 'private, no-store');
  // Bez přihlášení → 401 (route existuje, ne 404).
  for (const a of ['approve', 'vault', 'purge', 'ban12h', 'unapprove', 'restore', 'remove-file', 'decide']) {
    assert.equal((await app.inject({ method: 'POST', url: `/moderation/gif/${id}/${a}`, payload: {} })).statusCode, 401, a);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/moderation/gif/access-token', payload: {} })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/moderation/gif/rejected' })).statusCode, 401);
  await app.close();
});

test('nemod → 403 na access-token, rejected a akcích nad médiem; mod → token / seznam s kurzorem rejectedAt:id', async () => {
  const { default: Fastify } = await import('fastify');
  const { default: gifRoutes } = await import('./gif.js');
  const id = 'a'.repeat(32);
  const md = { id, channel: 'robdiesalot', status: 'rejected' as const, kind: 'gif', width: null, height: null, sha256: 'x', approvedAt: null, rejectedAt: new Date(5000), rejectedBy: 'twitch:moda', vault: false };
  const listed: unknown[] = [];
  const store = {
    getMedia: async (m: string) => (m === id ? md : null),
    listRejected: async (_ch: string, before: unknown, limit: number) => { listed.push(before); return Array.from({ length: limit }, () => md); },
  };
  const actions: string[] = [];
  const flow = { mediaAction: async (p: { action: string }) => { actions.push(p.action); return { status: 200, body: { ok: true } }; } };
  let account = 1;
  const app = Fastify();
  await app.register(gifRoutes, {
    flow: flow as never, store: store as never, media: new MediaServer(async () => null),
    tokens: { issue: async () => 'NOVY', verify: async () => false },
    auth: async (req) => { req.webAccountId = account; },
    modIdentities: async (acc) => (acc === 7 ? [{ platform: 'twitch', login: 'moda' }] : []),
  });
  const calls = () => [
    app.inject({ method: 'POST', url: '/moderation/gif/access-token', payload: { channel: 'robdiesalot' } }),
    app.inject({ method: 'GET', url: '/moderation/gif/rejected?channel=robdiesalot' }),
    ...['approve', 'vault', 'purge', 'ban12h'].map((a) => app.inject({ method: 'POST', url: `/moderation/gif/${id}/${a}`, payload: {} })),
  ];
  for (const r of await Promise.all(calls())) assert.equal(r.statusCode, 403, r.body);
  assert.deepEqual(actions, []);
  account = 7;
  const [tok, rej, ...acts] = await Promise.all(calls());
  assert.deepEqual(tok.json(), { ok: true, token: 'NOVY' });
  assert.equal(tok.headers['cache-control'], 'no-store');
  assert.equal(rej.json().nextBefore, `5000:${id}`);
  assert.deepEqual(acts.map((r) => r.statusCode), [200, 200, 200, 200]);
  assert.deepEqual(actions.sort(), ['approve', 'ban12h', 'purge', 'vault']);
  // Kurzor dál + neplatný kurzor.
  await app.inject({ method: 'GET', url: `/moderation/gif/rejected?channel=robdiesalot&before=5000:${id}` });
  assert.deepEqual(listed.at(-1), { at: new Date(5000), id });
  assert.equal((await app.inject({ method: 'GET', url: '/moderation/gif/rejected?channel=robdiesalot&before=5000' })).statusCode, 400);
  await app.close();
});

test('parseRejectedCursor', () => {
  const id = 'b'.repeat(32);
  assert.equal(parseRejectedCursor(undefined), null);
  assert.deepEqual(parseRejectedCursor(`123:${id}`), { at: new Date(123), id });
  assert.equal(parseRejectedCursor('123'), false);
  assert.equal(parseRejectedCursor(`0:${id}`), false);
});

test('rejectedView: tvar pro záložku Zamítnuté GIFy (smazání za 14 dní, vault bez smazání)', () => {
  const md = { id: 'a'.repeat(32), channel: 'robdiesalot', status: 'rejected' as const, kind: 'mp4', width: 498, height: 280, sha256: 'x', approvedAt: null, rejectedAt: new Date(1000), rejectedBy: 'twitch:moda', vault: false };
  assert.deepEqual(rejectedView(md), {
    mediaId: md.id, url: `http://localhost:3000/media/gif/${md.id}`, kind: 'mp4', width: 498, height: 280,
    tags: [], rejectedAt: 1000, rejectedBy: 'twitch:moda', vault: false, deleteAt: 1000 + 14 * 86_400_000,
  });
  assert.equal(rejectedView({ ...md, vault: true }).deleteAt, null);
  assert.deepEqual(rejectedView({ ...md, tags: ['cat'] }).tags, ['cat']);
});

test('discardedView: Stažené / Ke smazání — kdy, kým, kdy se smaže, kam se obnoví, tagy', () => {
  const md = { id: 'a'.repeat(32), channel: 'robdiesalot', status: 'purging' as const, kind: 'gif', width: 10, height: 20, sha256: 'x', approvedAt: null, rejectedAt: null, rejectedBy: null, vault: false, tags: ['cat'], purgedAt: new Date(1000), purgedBy: 'twitch:moda', purgeAt: new Date(1000 + 7 * 86_400_000), statusBeforePurge: 'approved' };
  assert.deepEqual(discardedView(md), {
    mediaId: md.id, url: `http://localhost:3000/media/gif/${md.id}`, kind: 'gif', width: 10, height: 20, tags: ['cat'],
    status: 'purging', purgedAt: 1000, purgedBy: 'twitch:moda', purgeAt: 1000 + 7 * 86_400_000, restoreTo: 'approved',
  });
  const w = discardedView({ ...md, status: 'withdrawn', purgeAt: null, statusBeforePurge: 'rejected', tags: undefined });
  assert.equal(w.purgeAt, null);
  assert.equal(w.restoreTo, 'rejected');
  assert.deepEqual(w.tags, []);
});

test('média podle stavu: withdrawn veřejně (cache 300 s, cachuje se), purging jen s tokenem; unavailable = 404 (servableStatus)', async () => {
  assert.equal(mediaCacheControl('withdrawn'), 'public, max-age=300');
  assert.equal(mediaCacheControl('purging'), 'private, no-store');
  const verify = async (t: string | undefined | null) => t === 'dobry';
  const purging = { ...entry('purging'), channel: 'robdiesalot' };
  assert.equal(await mediaAllowed(entry('withdrawn'), undefined, verify), true);
  assert.equal(await mediaAllowed(purging, undefined, verify), false);
  assert.equal(await mediaAllowed(purging, 'dobry', verify), true);
  assert.equal(servableStatus('withdrawn', false), 'withdrawn');
  assert.equal(servableStatus('purging', true), 'purging');
  assert.equal(servableStatus('unavailable', false), null);
  assert.equal(servableStatus('rejected', true), 'pending');
  assert.equal(servableStatus('rejected', false), 'rejected');
  assert.equal(servableStatus('pending', false), 'pending');
  let loads = 0;
  const s = new MediaServer(async () => { loads++; return entry('withdrawn'); });
  await s.get('a'); await s.get('a');
  assert.equal(loads, 1, 'withdrawn se stavem nemění → cache');
  let status: MediaEntry['status'] = 'purging';
  const p = new MediaServer(async () => { loads++; return { ...entry(), status }; });
  loads = 0;
  await p.get('b'); await p.get('b');
  assert.equal(loads, 2, 'purging se necachuje');
  status = 'approved';
  p.invalidate('b');
  assert.equal((await p.get('b'))!.status, 'approved');
});

test('routy zahození: purge { keepMessages }, restore, remove-file (mod kanálu média), GET withdrawn / purging s kurzorem purgedAt:id', async () => {
  const { default: Fastify } = await import('fastify');
  const { default: gifRoutes } = await import('./gif.js');
  const id = 'a'.repeat(32);
  const md = { id, channel: 'robdiesalot', status: 'withdrawn' as const, kind: 'gif', width: 1, height: 1, sha256: 'x', approvedAt: null, rejectedAt: null, rejectedBy: null, vault: false, tags: [], purgedAt: new Date(7000), purgedBy: 'twitch:moda', purgeAt: null, statusBeforePurge: 'approved' };
  const listed: unknown[] = [];
  const store = {
    getMedia: async (m: string) => (m === id ? md : null),
    listDiscarded: async (_ch: string, status: string, before: unknown, limit: number) => { listed.push([status, before]); return Array.from({ length: limit }, () => ({ ...md, status })); },
  };
  const actions: unknown[] = [];
  const flow = { mediaAction: async (p: { action: string; keepMessages?: boolean }) => { actions.push([p.action, p.keepMessages]); return { status: 200, body: { ok: true } }; } };
  let account = 1;
  const app = Fastify();
  await app.register(gifRoutes, {
    flow: flow as never, store: store as never, media: new MediaServer(async () => null),
    tokens: { issue: async () => 'x', verify: async () => false },
    auth: async (req) => { req.webAccountId = account; },
    modIdentities: async (acc) => (acc === 7 ? [{ platform: 'twitch', login: 'moda' }] : []),
  });
  for (const u of ['/moderation/gif/withdrawn?channel=robdiesalot', '/moderation/gif/purging?channel=robdiesalot']) assert.equal((await app.inject({ method: 'GET', url: u })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: `/moderation/gif/${id}/restore`, payload: {} })).statusCode, 403);
  account = 7;
  const w = await app.inject({ method: 'GET', url: '/moderation/gif/withdrawn?channel=robdiesalot' });
  assert.equal(w.statusCode, 200);
  assert.equal(w.headers['cache-control'], 'no-store');
  assert.equal(w.json().items[0].status, 'withdrawn');
  assert.equal(w.json().nextBefore, `7000:${id}`);
  await app.inject({ method: 'GET', url: `/moderation/gif/purging?channel=robdiesalot&before=7000:${id}` });
  assert.deepEqual(listed.at(-1), ['purging', { at: new Date(7000), id }]);
  assert.equal((await app.inject({ method: 'GET', url: '/moderation/gif/purging?channel=robdiesalot&before=x' })).statusCode, 400);
  // purge: keepMessages true / false / chybí (= i se zprávami) / neplatný typ → 400.
  await app.inject({ method: 'POST', url: `/moderation/gif/${id}/purge`, payload: { keepMessages: true } });
  await app.inject({ method: 'POST', url: `/moderation/gif/${id}/purge`, payload: { keepMessages: false } });
  await app.inject({ method: 'POST', url: `/moderation/gif/${id}/purge`, payload: {} });
  assert.equal((await app.inject({ method: 'POST', url: `/moderation/gif/${id}/purge`, payload: { keepMessages: 'ano' } })).statusCode, 400);
  await app.inject({ method: 'POST', url: `/moderation/gif/${id}/restore`, payload: {} });
  await app.inject({ method: 'POST', url: `/moderation/gif/${id}/remove-file`, payload: {} });
  assert.deepEqual(actions, [['purge', true], ['purge', false], ['purge', false], ['restore', false], ['remove-file', false]]);
  await app.close();
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
  assert.deepEqual(s, { ok: true, allowed: true, cooldownUntil: 2_030_000, cooldownSec: 120, serverNow: 2_000_000, rewardUntil: null, mode: 'all', cooldownGlobalSec: 0 });
  assert.deepEqual(log[0], { workspace: 'rob', platform: 'kick', userId: 'k9', login: 'divak_k', role: 'sub' });
  // Prošlý cooldown → null; bez platformy první identita.
  const past = await gifStateFor(7, { channel: 'robdiesalot' }, stateDeps({ access: async () => ({ allowed: true, until: null, cooldownUntil: 1, cooldownSec: 60, requestTtlSec: 300 }) }));
  assert.equal(past.cooldownUntil, null);
});

test('gifStateFor: mod bez Dev módu = povoleno bez cooldownu (Židolišta jen kvůli režimu); s review jako divák', async () => {
  const log: unknown[] = [];
  const mod = await gifStateFor(7, { channel: 'robdiesalot', platform: 'twitch' }, stateDeps({ role: async () => 'moderator' }, log));
  assert.deepEqual(mod, { ok: true, allowed: true, cooldownUntil: null, cooldownSec: 0, serverNow: 2_000_000, mode: 'all', cooldownGlobalSec: 0, mod: true });
  // Režim „jen schválené" platí i pro mody → i jim se vrací.
  const modApproved = await gifStateFor(7, { channel: 'robdiesalot', platform: 'twitch' }, stateDeps({ role: async () => 'moderator', access: async () => ({ allowed: false, until: null, cooldownUntil: null, cooldownSec: 0, requestTtlSec: 300, mode: 'approved' }) }));
  assert.equal(modApproved.mode, 'approved');
  assert.equal(modApproved.allowed, true);
  assert.equal((await gifStateFor(7, { channel: 'robdiesalot', platform: 'twitch' }, stateDeps({ role: async () => 'moderator', access: async () => null }))).mode, 'all');
  log.length = 0;
  const rev = await gifStateFor(7, { channel: 'robdiesalot', platform: 'twitch', review: true }, stateDeps({ role: async () => 'moderator' }, log));
  assert.equal(rev.cooldownUntil, 2_030_000);
  assert.equal((log[0] as { role: string }).role, 'moderator');
});

test('gifStateFor: režim a globální cooldown ze Židolišty (klient je zobrazí)', async () => {
  const s = await gifStateFor(7, { channel: 'robdiesalot', platform: 'twitch' }, stateDeps({ access: async () => ({ allowed: true, until: null, cooldownUntil: null, cooldownSec: 60, requestTtlSec: 300, mode: 'approved', cooldownGlobalSec: 30 }) }));
  assert.equal(s.mode, 'approved');
  assert.equal(s.cooldownGlobalSec, 30);
});

test('gifStateFor: konec odemčené odměny (rewardUntil) pro časový pásek; neodemčeno / bez konce → null', async () => {
  const on = await gifStateFor(7, { channel: 'robdiesalot', platform: 'twitch' }, stateDeps({ access: async () => ({ allowed: true, until: 2_600_000, cooldownUntil: null, cooldownSec: 60, requestTtlSec: 300 }) }));
  assert.equal(on.rewardUntil, 2_600_000);
  const endless = await gifStateFor(7, { channel: 'robdiesalot', platform: 'twitch' }, stateDeps({ access: async () => ({ allowed: true, until: null, cooldownUntil: null, cooldownSec: 60, requestTtlSec: 300 }) }));
  assert.equal(endless.rewardUntil, null);
  const locked = await gifStateFor(7, { channel: 'robdiesalot', platform: 'twitch' }, stateDeps({ access: async () => ({ allowed: false, until: 2_600_000, cooldownUntil: null, cooldownSec: 60, requestTtlSec: 300 }) }));
  assert.equal(locked.rewardUntil, null);
});

test('gifStateFor: neznámý kanál / bez identity na platformě / Židolišta nedostupná → neodemčeno', async () => {
  const none = { ok: true, allowed: false, cooldownUntil: null, cooldownSec: 0, serverNow: 2_000_000, mode: 'all', cooldownGlobalSec: 0 };
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
  // Se žádostí nese položka i `status` (odesílatel podle něj usadí štítek, když se gif-decided ztratilo).
  assert.deepEqual((await gifHeldState('robdiesalot', [{ platform: 'twitch', messageId: 'a' }], pend.deps))[0], { platform: 'twitch', messageId: 'a', state: 'held', status: 'pending' });
  const appr = heldDeps({ a: held }, { requestStatus: async () => 'approved' });
  assert.deepEqual((await gifHeldState('robdiesalot', [{ platform: 'twitch', messageId: 'a' }], appr.deps))[0], { platform: 'twitch', messageId: 'a', state: 'replaced', status: 'approved' });
  const rej = heldDeps({ a: held }, { requestStatus: async () => 'expired' });
  assert.deepEqual((await gifHeldState('robdiesalot', [{ platform: 'twitch', messageId: 'a' }], rej.deps))[0], { platform: 'twitch', messageId: 'a', state: 'deleted', reason: 'gif_rejected', status: 'expired' });
  const rj = heldDeps({ a: held }, { requestStatus: async () => 'rejected' });
  assert.equal((await gifHeldState('robdiesalot', [{ platform: 'twitch', messageId: 'a' }], rj.deps))[0].status, 'rejected');
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

// ---- GIF knihovna (Task 2) ----
const libStore = (over: Record<string, unknown> = {}) => {
  const lib = 'b'.repeat(32);
  const calls: Array<[string, unknown]> = [];
  const store = {
    listLibrary: async (channel: string, o: unknown) => { calls.push(['listLibrary', { channel, o }]); return channel === 'robdiesalot' ? [{ id: lib, kind: 'gif', width: 10, height: 20, tags: ['cat'], useCount: 3, lastUsedAt: new Date(9000) }] : []; },
    listDuplicates: async (channel: string) => { calls.push(['listDuplicates', channel]); return []; },
    getDuplicate: async (id: number) => (id === 5 ? { id: 5, channel: 'robdiesalot', a: 'a'.repeat(32), b: lib, status: 'pending' } : null),
    keepBoth: async () => true,
    mergeInto: async () => ({ ok: true }),
    ...over,
  };
  return { store, calls, lib };
};

test('GET /gifs/library: veřejné (bez přihlášení), kanál z parametru, URL našeho média, rate limit per IP, no-store', async () => {
  const { default: Fastify } = await import('fastify');
  const { default: gifRoutes } = await import('./gif.js');
  const { store, calls, lib } = libStore();
  const app = Fastify();
  await app.register(gifRoutes, { flow: {} as never, store: {} as never, media: new MediaServer(async () => null), library: store as never, tokens: { issue: async () => 'x', verify: async () => false } });
  const r = await app.inject({ method: 'GET', url: '/gifs/library?channel=RobDiesALot&q=cat&limit=10' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.deepEqual(r.json(), { ok: true, items: [{ mediaId: lib, url: `http://localhost:3000/media/gif/${lib}`, kind: 'gif', width: 10, height: 20, tags: ['cat'], useCount: 3, lastUsedAt: 9000 }], nextCursor: null });
  assert.deepEqual(calls[0], ['listLibrary', { channel: 'robdiesalot', o: { q: 'cat', after: null, limit: 10 } }]);
  assert.equal((await app.inject({ method: 'GET', url: '/gifs/library?channel=../x' })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/gifs/library?cursor=zzz' })).statusCode, 400);
  let last = 200;
  for (let i = 0; i < 40 && last !== 429; i++) last = (await app.inject({ method: 'GET', url: '/gifs/library' })).statusCode;
  assert.equal(last, 429);
  await app.close();
});

test('duplicity v UC: bez přihlášení 401, nemod 403, mod → seznam a rozhodnutí (kanál z návrhu); unapprove route', async () => {
  const { default: Fastify } = await import('fastify');
  const { default: gifRoutes } = await import('./gif.js');
  const merged: string[] = [];
  const { store } = libStore({ mergeInto: async (_id: number, k: string, d: string) => { merged.push(`${k}<-${d}`); return { ok: true }; } });
  const forgotten: string[] = [];
  const media = new MediaServer(async () => null);
  media.forget = (id: string) => { forgotten.push(id); };
  const actions: string[] = [];
  const flow = { mediaAction: async (p: { action: string }) => { actions.push(p.action); return { status: 200, body: { ok: true } }; } };
  const gstore = { getMedia: async () => ({ id: 'c'.repeat(32), channel: 'robdiesalot', status: 'approved' }) };
  let account = 1;
  const app = Fastify();
  await app.register(gifRoutes, {
    flow: flow as never, store: gstore as never, media, library: store as never, recordAction: async () => {},
    tokens: { issue: async () => 'x', verify: async () => false },
    auth: async (req, reply) => { if (!req.headers.authorization) { reply.code(401).send({ ok: false }); return; } req.webAccountId = account; },
    modIdentities: async (acc) => (acc === 7 ? [{ platform: 'twitch', login: 'moda' }] : []),
  });
  const H = { authorization: 'Bearer x' };
  assert.equal((await app.inject({ method: 'GET', url: '/moderation/gif/duplicates?channel=robdiesalot' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/moderation/gif/duplicates/5/keep-first', payload: {} })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/moderation/gif/duplicates?channel=robdiesalot', headers: H })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/moderation/gif/duplicates/5/keep-first', headers: H, payload: {} })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: `/moderation/gif/${'c'.repeat(32)}/unapprove`, headers: H, payload: {} })).statusCode, 403);
  account = 7;
  const list = await app.inject({ method: 'GET', url: '/moderation/gif/duplicates?channel=robdiesalot', headers: H });
  assert.deepEqual(list.json(), { ok: true, items: [] });
  assert.equal((await app.inject({ method: 'POST', url: '/moderation/gif/duplicates/99/keep-first', headers: H, payload: {} })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/moderation/gif/duplicates/5/keep-nothing', headers: H, payload: {} })).statusCode, 404);
  const r = await app.inject({ method: 'POST', url: '/moderation/gif/duplicates/5/keep-second', headers: H, payload: {} });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(merged, [`${'b'.repeat(32)}<-${'a'.repeat(32)}`]);
  assert.deepEqual(forgotten, ['a'.repeat(32)]);
  assert.equal((await app.inject({ method: 'POST', url: `/moderation/gif/${'c'.repeat(32)}/unapprove`, headers: H, payload: {} })).statusCode, 200);
  assert.deepEqual(actions, ['unapprove']);
  await app.close();
});

test('duplicity v UC + knihovna: chybí tabulka/sloupec → 503 not_ready, jiná chyba DB → 500', async () => {
  const { default: Fastify } = await import('fastify');
  const { default: gifRoutes } = await import('./gif.js');
  const missing = Object.assign(new Error('relation "gif_duplicates" does not exist'), { code: '42P01' });
  let err: Error = missing;
  const { store } = libStore({
    listDuplicates: async () => { throw err; },
    getDuplicate: async () => { throw err; },
    listLibrary: async () => { throw err; },
  });
  const app = Fastify();
  await app.register(gifRoutes, {
    flow: {} as never, store: {} as never, media: new MediaServer(async () => null), library: store as never,
    tokens: { issue: async () => 'x', verify: async () => false },
    auth: async (req) => { req.webAccountId = 7; },
    modIdentities: async () => [{ platform: 'twitch', login: 'moda' }],
  });
  const calls = () => Promise.all([
    app.inject({ method: 'GET', url: '/moderation/gif/duplicates?channel=robdiesalot' }),
    app.inject({ method: 'POST', url: '/moderation/gif/duplicates/5/keep-both', payload: {} }),
    app.inject({ method: 'GET', url: '/gifs/library' }),
  ]);
  for (const r of await calls()) assert.deepEqual([r.statusCode, r.json()], [503, { ok: false, error: 'not_ready' }]);
  err = Object.assign(new Error('column "phash" does not exist'), { code: '42703' });
  for (const r of await calls()) assert.equal(r.statusCode, 503);
  err = new Error('connection reset');
  for (const r of await calls()) assert.deepEqual([r.statusCode, r.json()], [500, { ok: false, error: 'internal' }]);
  await app.close();
});
