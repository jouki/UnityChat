import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import integrationGifRoutes, { type IntegrationGifOpts } from './integrationGif.js';
import { MediaServer } from './gif.js';
import type { WorkspaceInfo } from '../lib/zidolista.js';
import type { GifLibraryStore } from '../lib/gifLibrary.js';

const ws: WorkspaceInfo = { slug: 'rob', channels: { twitch: 'RobDiesALot', kick: null, youtube: null }, bot: { mode: 'shared', displayName: 'JoukiBOT' } };
const actor = { source: 'zidolista', userId: '7', name: 'Jouki', role: 'owner' };
const M = (c: string) => c.repeat(32);

function setup(over: Partial<IntegrationGifOpts> = {}) {
  const calls: Array<[string, unknown]> = [];
  const mediaCh: Record<string, string> = { [M('a')]: 'robdiesalot', [M('b')]: 'cizi' };
  const library: Partial<GifLibraryStore> = {
    listLibrary: async (ch, o) => { calls.push(['listLibrary', { ch, o }]); return []; },
    setTags: async (id, tags) => { calls.push(['setTags', { id, tags }]); },
    mediaChannel: async (id) => mediaCh[id] ?? null,
    listDuplicates: async (ch) => { calls.push(['listDuplicates', ch]); return []; },
    getDuplicate: async (id) => (id === 3 ? { id: 3, channel: 'robdiesalot', a: M('a'), b: M('c'), status: 'pending' } : id === 4 ? { id: 4, channel: 'cizi', a: M('b'), b: M('d'), status: 'pending' } : null),
    keepBoth: async (id, by) => { calls.push(['keepBoth', { id, by }]); return true; },
    mergeInto: async () => true,
  };
  const opts: IntegrationGifOpts = {
    authorize: () => true,
    workspaceBySlug: async (s) => (s === 'rob' ? ws : null),
    flow: { mediaAction: async (p) => { calls.push(['mediaAction', p]); return { status: 200, body: { ok: true, mediaId: p.mediaId, action: p.action } }; } },
    store: {
      getMedia: async (id) => (mediaCh[id] ? { id, channel: mediaCh[id], status: 'rejected', kind: 'gif', width: 1, height: 2, sha256: 'x', approvedAt: null, rejectedAt: new Date(5000), rejectedBy: 'twitch:m', vault: false } : null),
      listRejected: async (ch, before, limit) => { calls.push(['listRejected', { ch, before, limit }]); return []; },
    },
    library: library as GifLibraryStore,
    issueToken: async (slug) => { calls.push(['issueToken', slug]); return 'TAJNY-TOKEN'; },
    recordAction: async (v) => { calls.push(['recordAction', v]); },
    media: new MediaServer(async () => null),
    ...over,
  };
  return { opts, calls };
}

async function app(opts: IntegrationGifOpts) {
  const a = Fastify();
  await a.register(integrationGifRoutes, opts);
  await a.ready();
  return a;
}

test('integrace GIF: bez platného podpisu (inboundAuthorized) 401 na všech routách, nic se nevolá', async () => {
  const { opts, calls } = setup();
  delete (opts as Partial<IntegrationGifOpts>).authorize; // výchozí inboundAuthorized; v testu není klíč → 401
  const a = await app(opts);
  const routes: Array<[string, string]> = [
    ['GET', '/integrations/rob/gifs'], ['PUT', `/integrations/rob/gifs/${M('a')}/tags`], ['GET', '/integrations/rob/gifs/rejected'],
    ['POST', `/integrations/rob/gifs/${M('a')}/approve`], ['POST', `/integrations/rob/gifs/${M('a')}/unapprove`],
    ['GET', '/integrations/rob/gifs/duplicates'], ['POST', '/integrations/rob/gifs/duplicates/3/keep-both'],
    ['POST', '/integrations/rob/gifs/access-token'],
  ];
  for (const [method, url] of routes) {
    const r = await a.inject({ method: method as 'GET', url, payload: method === 'GET' ? undefined : { tags: [], actor }, headers: { 'x-api-key': 'spatny' } });
    assert.equal(r.statusCode, 401, `${method} ${url}`);
  }
  assert.deepEqual(calls, []);
  await a.close();
});

test('integrace GIF: kanál jen ze slugu; neznámý slug 404; médium / návrh jiného kanálu 404', async () => {
  const { opts, calls } = setup();
  const a = await app(opts);
  assert.equal((await a.inject({ method: 'GET', url: '/integrations/nikdo/gifs' })).statusCode, 404);
  const lib = await a.inject({ method: 'GET', url: '/integrations/ROB/gifs?q=cat&limit=5' });
  assert.equal(lib.statusCode, 200);
  assert.deepEqual(lib.json(), { ok: true, items: [], nextCursor: null });
  assert.deepEqual(calls.at(-1), ['listLibrary', { ch: 'robdiesalot', o: { q: 'cat', after: null, limit: 5 } }]);
  assert.equal((await a.inject({ method: 'POST', url: `/integrations/rob/gifs/${M('b')}/approve`, payload: { actor } })).statusCode, 404);
  assert.equal((await a.inject({ method: 'PUT', url: `/integrations/rob/gifs/${M('b')}/tags`, payload: { tags: ['x'], actor } })).statusCode, 404);
  assert.equal((await a.inject({ method: 'POST', url: '/integrations/rob/gifs/duplicates/4/keep-both', payload: { actor } })).statusCode, 404);
  assert.equal((await a.inject({ method: 'POST', url: `/integrations/rob/gifs/${M('a')}/zmiz`, payload: { actor } })).statusCode, 404);
  assert.equal(calls.some((c) => c[0] === 'mediaAction' || c[0] === 'setTags' || c[0] === 'keepBoth'), false);
  await a.close();
});

test('integrace GIF: tagy, zamítnuté, akce nad médiem (by zidolista:<id>), duplicity, token jen jednou a no-store', async () => {
  const { opts, calls } = setup();
  const a = await app(opts);
  const t = await a.inject({ method: 'PUT', url: `/integrations/rob/gifs/${M('a')}/tags`, payload: { tags: ['Kočka', '#kočka', 'Pes'], actor } });
  assert.deepEqual(t.json(), { ok: true, mediaId: M('a'), tags: ['kočka', 'pes'] });
  assert.equal((await a.inject({ method: 'PUT', url: `/integrations/rob/gifs/${M('a')}/tags`, payload: { tags: 'x', actor } })).statusCode, 400);

  const rej = await a.inject({ method: 'GET', url: `/integrations/rob/gifs/rejected?before=5000:${M('a')}` });
  assert.deepEqual(rej.json(), { ok: true, items: [], nextBefore: null });
  assert.equal((await a.inject({ method: 'GET', url: '/integrations/rob/gifs/rejected?before=zz' })).statusCode, 400);

  for (const action of ['approve', 'vault', 'purge', 'ban12h', 'unapprove']) {
    const r = await a.inject({ method: 'POST', url: `/integrations/rob/gifs/${M('a')}/${action}`, payload: { actor } });
    assert.equal(r.statusCode, 200, action);
  }
  const acts = calls.filter((c) => c[0] === 'mediaAction').map((c) => c[1] as { action: string; by: string; accountId: null });
  assert.deepEqual(acts.map((x) => x.action), ['approve', 'vault', 'purge', 'ban12h', 'unapprove']);
  assert.ok(acts.every((x) => x.by === 'zidolista:7' && x.accountId === null));

  assert.deepEqual((await a.inject({ method: 'GET', url: '/integrations/rob/gifs/duplicates' })).json(), { ok: true, items: [] });
  const kb = await a.inject({ method: 'POST', url: '/integrations/rob/gifs/duplicates/3/keep-both', payload: { actor } });
  assert.deepEqual(kb.json(), { ok: true, id: 3, action: 'keep-both' });
  assert.deepEqual(calls.find((c) => c[0] === 'keepBoth')![1], { id: 3, by: 'zidolista:7' });

  const tok = await a.inject({ method: 'POST', url: '/integrations/rob/gifs/access-token', payload: {} });
  assert.deepEqual(tok.json(), { ok: true, token: 'TAJNY-TOKEN' });
  assert.equal(tok.headers['cache-control'], 'no-store');
  assert.deepEqual(calls.find((c) => c[0] === 'issueToken'), ['issueToken', 'rob']);
  await a.close();
});

test('integrace GIF: akce bez aktéra = by "zidolista"; neplatný aktér 400', async () => {
  const { opts, calls } = setup();
  const a = await app(opts);
  assert.equal((await a.inject({ method: 'POST', url: `/integrations/rob/gifs/${M('a')}/vault` })).statusCode, 200);
  assert.equal((calls.find((c) => c[0] === 'mediaAction')![1] as { by: string }).by, 'zidolista');
  assert.equal((await a.inject({ method: 'POST', url: `/integrations/rob/gifs/${M('a')}/vault`, payload: { actor: { source: 'jinde' } } })).statusCode, 400);
  await a.close();
});
