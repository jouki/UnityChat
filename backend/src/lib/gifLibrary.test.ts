import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareLibrary, libraryCursorOf, parseLibraryCursor, parseLibraryQuery, libraryPage, libraryView, updateTags,
  resolveDuplicate, createPhashWorker, duplicateView, LIBRARY_PAGE,
  type GifLibraryStore, type LibraryItem, type LibraryCursor, type DuplicatePair, type LibMedia,
} from './gifLibrary.js';

const id = (c: string) => c.repeat(32);
const quiet = { info() {}, warn() {} };

type M = LibMedia & { channel: string; bytes: Buffer; phash: string[] | null; phashAt: Date | null; dupCheckedAt: Date | null; lastUsedAt: Date | null; vault: boolean; approvedAt: Date | null };

/** Paměťové úložiště se stejnou sémantikou jako dbGifLibraryStore. */
function memLibrary() {
  const media = new Map<string, M>();
  const dups = new Map<number, { id: number; channel: string; a: string; b: string; score: number; status: string; createdAt: Date; decidedBy: string | null }>();
  const requests: Array<{ id: number; mediaId: string }> = [];
  const messages: Array<{ id: string; mediaId: string }> = [];
  let seq = 0;
  const add = (m: Partial<M> & { id: string }) => {
    const full: M = { channel: 'robdiesalot', status: 'approved', kind: 'gif', width: 100, height: 80, tags: [], useCount: 0, lastUsedAt: null, createdAt: new Date(1000), bytes: Buffer.from('GIF89a'), phash: null, phashAt: null, dupCheckedAt: null, vault: false, approvedAt: new Date(1000), ...m };
    media.set(full.id, full);
    return full;
  };
  const lu = (m: M) => m.lastUsedAt?.getTime() ?? 0;
  const store: GifLibraryStore = {
    async listLibrary(channel, o) {
      return [...media.values()]
        .filter((m) => m.channel === channel && m.status === 'approved' && (!o.q || m.tags.some((t) => t.includes(o.q!))))
        .filter((m) => !o.after || compareLibrary({ ...m }, { useCount: o.after.useCount, lastUsedAt: o.after.lastUsedMs ? new Date(o.after.lastUsedMs) : null, id: o.after.id } as LibraryItem) > 0)
        .sort(compareLibrary).slice(0, o.limit)
        .map((m) => ({ id: m.id, kind: m.kind, width: m.width, height: m.height, tags: m.tags, useCount: m.useCount, lastUsedAt: m.lastUsedAt }));
    },
    async setTags(mid, tags) { const m = media.get(mid); if (m) m.tags = tags; },
    async mediaChannel(mid) { return media.get(mid)?.channel ?? null; },
    async listDuplicates(channel, limit) {
      const out: DuplicatePair[] = [];
      for (const d of [...dups.values()].filter((x) => x.channel === channel && x.status === 'pending').sort((x, y) => x.id - y.id).slice(0, limit)) {
        const a = media.get(d.a)!, b = media.get(d.b)!;
        out.push({ id: d.id, channel: d.channel, score: d.score, status: d.status, createdAt: d.createdAt, first: a, second: b });
      }
      return out;
    },
    async getDuplicate(did) { const d = dups.get(did); return d ? { id: d.id, channel: d.channel, a: d.a, b: d.b, status: d.status } : null; },
    async keepBoth(did, by) { const d = dups.get(did); if (!d || d.status !== 'pending') return false; d.status = 'kept_both'; d.decidedBy = by; return true; },
    async mergeInto(keep, drop, at) {
      const k = media.get(keep), d = media.get(drop);
      if (!k || !d) return false;
      for (const r of requests) if (r.mediaId === drop) r.mediaId = keep;
      for (const x of messages) if (x.mediaId === drop) x.mediaId = keep;
      media.delete(drop);
      for (const [did, x] of dups) if (x.a === drop || x.b === drop) dups.delete(did);
      k.useCount += d.useCount;
      k.lastUsedAt = lu(k) >= lu(d) ? k.lastUsedAt : d.lastUsedAt;
      k.tags = [...new Set([...k.tags, ...d.tags])].slice(0, 20);
      k.vault = k.vault || d.vault;
      if (d.status === 'approved' && k.status !== 'approved') Object.assign(k, { status: 'approved', approvedAt: d.approvedAt ?? at, vault: false });
      return true;
    },
    async nextToHash() {
      const m = [...media.values()].filter((x) => x.phashAt === null && x.status !== 'pending').sort((x, y) => Number(x.status !== 'approved') - Number(y.status !== 'approved') || x.createdAt.getTime() - y.createdAt.getTime())[0];
      return m ? { id: m.id, kind: m.kind as 'gif', bytes: m.bytes } : null;
    },
    async saveHash(mid, hashes, at) { const m = media.get(mid); if (m) { m.phash = hashes; m.phashAt = at; } },
    async nextToCheck() {
      const m = [...media.values()].filter((x) => x.dupCheckedAt === null && x.phash && x.status !== 'pending').sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())[0];
      return m ? { id: m.id, channel: m.channel, phash: m.phash!, createdAt: m.createdAt } : null;
    },
    async channelHashes(channel, exclude) {
      return [...media.values()].filter((x) => x.channel === channel && x.id !== exclude && x.phash && x.status !== 'pending').map((x) => ({ id: x.id, phash: x.phash!, createdAt: x.createdAt }));
    },
    async insertDuplicate(v) {
      if ([...dups.values()].some((d) => (d.a === v.a && d.b === v.b) || (d.a === v.b && d.b === v.a))) return false;
      const d = { ...v, id: ++seq, status: 'pending', createdAt: new Date(5000), decidedBy: null };
      dups.set(d.id, d);
      return true;
    },
    async markChecked(mid, at) { const m = media.get(mid); if (m) m.dupCheckedAt = at; },
  };
  return { store, media, dups, add, requests, messages };
}

test('knihovna: řazení use_count desc, last_used desc, id desc; kurzor bez ztrát a duplicit mezi stránkami', async () => {
  const L = memLibrary();
  L.add({ id: id('a'), useCount: 5, lastUsedAt: new Date(3000) });
  L.add({ id: id('b'), useCount: 5, lastUsedAt: new Date(4000) });
  L.add({ id: id('c'), useCount: 9, lastUsedAt: null });
  L.add({ id: id('d'), useCount: 5, lastUsedAt: new Date(4000) });
  L.add({ id: id('e'), useCount: 0, lastUsedAt: null });
  L.add({ id: id('f'), useCount: 100, status: 'rejected' });
  L.add({ id: id('9'), useCount: 100, channel: 'cizi' });
  const all: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 5; i++) {
    const out = await libraryPage(L.store, 'robdiesalot', { cursor, limit: '2' });
    assert.equal(out.status, 200);
    const body = out.body as { items: Array<{ mediaId: string }>; nextCursor: string | null };
    all.push(...body.items.map((x) => x.mediaId));
    if (!body.nextCursor) break;
    cursor = body.nextCursor;
  }
  assert.deepEqual(all, [id('c'), id('d'), id('b'), id('a'), id('e')], 'jen schválené kanálu, stabilní pořadí');
});

test('knihovna: tvar položky (URL našeho média, rozměry, tagy, useCount), hledání v tagech, neplatný kurzor 400', async () => {
  const L = memLibrary();
  L.add({ id: id('a'), tags: ['cat dance', 'cat'], useCount: 2, lastUsedAt: new Date(7000) });
  L.add({ id: id('b'), tags: ['dog'], useCount: 1 });
  const out = await libraryPage(L.store, 'robdiesalot', { q: '  CAT ' });
  assert.deepEqual(out, { status: 200, body: { ok: true, items: [{
    mediaId: id('a'), url: `http://localhost:3000/media/gif/${id('a')}`, kind: 'gif', width: 100, height: 80, tags: ['cat dance', 'cat'], useCount: 2, lastUsedAt: 7000,
  }], nextCursor: null } });
  assert.deepEqual(await libraryPage(L.store, 'robdiesalot', { cursor: 'nesmysl' }), { status: 400, body: { ok: false, error: 'cursor' } });
  assert.equal(parseLibraryQuery(''), null);
  assert.equal(parseLibraryQuery('x'.repeat(80))!.length, 40);
  assert.equal(parseLibraryCursor(undefined), null);
  assert.equal(parseLibraryCursor('1:2:zz'), false);
  const item: LibraryItem = { id: id('a'), kind: 'gif', width: null, height: null, tags: [], useCount: 3, lastUsedAt: null };
  const c = libraryCursorOf(item);
  assert.deepEqual(parseLibraryCursor(c), { useCount: 3, lastUsedMs: 0, id: id('a') } satisfies LibraryCursor);
  assert.equal(LIBRARY_PAGE, 50);
  assert.equal(libraryView({ id: id('a'), kind: 'mp4', width: 1, height: 2, tags: [], useCount: 0, lastUsedAt: null }).lastUsedAt, null);
});

test('tagy: úprava normalizuje (malá písmena, ≤ 20, ≤ 40 znaků, bez duplicit); médium jiného kanálu / neexistující = 404; špatné tělo 400', async () => {
  const L = memLibrary();
  L.add({ id: id('a') });
  L.add({ id: id('b'), channel: 'cizi' });
  const out = await updateTags(L.store, 'robdiesalot', id('a'), { tags: ['Cat', 'cat', ' #Dance ', 'x'.repeat(50), ...Array.from({ length: 30 }, (_, i) => `t${i}`)] });
  assert.equal(out.status, 200);
  const tags = (out.body as { tags: string[] }).tags;
  assert.equal(tags.length, 20);
  assert.deepEqual(tags.slice(0, 3), ['cat', 'dance', 'x'.repeat(40)]);
  assert.deepEqual(L.media.get(id('a'))!.tags, tags);
  assert.equal((await updateTags(L.store, 'robdiesalot', id('b'), { tags: ['a'] })).status, 404);
  assert.equal((await updateTags(L.store, 'robdiesalot', id('c'), { tags: ['a'] })).status, 404);
  assert.equal((await updateTags(L.store, 'robdiesalot', id('a'), { tags: 'a' })).status, 400);
  assert.equal((await updateTags(L.store, 'robdiesalot', 'spatne', { tags: [] })).status, 404);
  assert.deepEqual((await updateTags(L.store, 'robdiesalot', id('a'), { tags: [] })).body, { ok: true, mediaId: id('a'), tags: [] });
});

// ---- hash + návrhy duplikátů ----
const H1 = ['0f0f0f0f0f0f0f0f', 'f0f0f0f0f0f0f0f0', '00ff00ff00ff00ff', 'ff00ff00ff00ff00'];
const H1b = ['0f0f0f0f0f0f0f0e', 'f0f0f0f0f0f0f0f0', '00ff00ff00ff00fe', 'ff00ff00ff00ff00'];
const H2 = ['123456789abcdef0', '0fedcba987654321', 'aaaaaaaaaaaaaaaa', '5555555555555555'];

test('worker: dopočet hashů (schválené přednostně, čekající ne), pak návrhy jen v rámci kanálu a jen pro novou dvojici', async () => {
  const L = memLibrary();
  L.add({ id: id('a'), createdAt: new Date(1000), status: 'rejected' });
  L.add({ id: id('b'), createdAt: new Date(2000) });
  L.add({ id: id('c'), createdAt: new Date(3000) });
  L.add({ id: id('d'), createdAt: new Date(4000), channel: 'cizi' });
  L.add({ id: id('e'), createdAt: new Date(500), status: 'pending' });
  const hashes: Record<string, string[] | null> = { [id('a')]: H1, [id('b')]: H1b, [id('c')]: H2, [id('d')]: H1 };
  const computed: string[] = [];
  const w = createPhashWorker({
    store: L.store, log: quiet, now: () => 9000,
    compute: async (bytes, kind) => { const mid = [...L.media.values()].find((m) => m.bytes === bytes)!.id; computed.push(mid); assert.equal(kind, 'gif'); return hashes[mid]; },
  });
  // Každé médium má vlastní bajty (hledání podle identity bufferu).
  for (const m of L.media.values()) m.bytes = Buffer.from(m.id);
  const steps: string[] = [];
  for (let i = 0; i < 12; i++) steps.push(await w.tick());
  assert.deepEqual(computed, [id('b'), id('c'), id('d'), id('a')], 'schválené první, čekající vůbec');
  assert.equal(steps.filter((s) => s === 'hashed').length, 4);
  assert.equal(steps.filter((s) => s === 'checked').length, 4);
  assert.equal(steps[steps.length - 1], 'idle');
  const pairs = [...L.dups.values()];
  assert.equal(pairs.length, 1, 'a~b (d je jiný kanál, c jiný obsah)');
  assert.deepEqual([pairs[0].a, pairs[0].b, pairs[0].channel], [id('a'), id('b'), 'robdiesalot'], 'a = starší („první")');
  assert.ok(pairs[0].score >= 0.6);
  // Čekající se po rozhodnutí zkontroluje taky; dvojice se nenavrhne podruhé.
  L.media.get(id('e'))!.status = 'approved';
  hashes[id('e')] = H1;
  for (let i = 0; i < 4; i++) await w.tick();
  assert.equal(L.dups.size, 3, 'e~a, e~b nové; a~b jen jednou');
});

test('worker: hash selže (null) → médium označené, znovu se nezkouší, žádné návrhy; výjimka nic neshodí', async () => {
  const L = memLibrary();
  L.add({ id: id('a') });
  L.add({ id: id('b') });
  let calls = 0;
  const warns: string[] = [];
  const w = createPhashWorker({ store: L.store, log: { info() {}, warn: (_o, m) => warns.push(m) }, now: () => 1, compute: async () => { calls++; if (calls === 1) throw new Error('boom'); return null; } });
  assert.equal(await w.tick(), 'hashed');
  assert.equal(await w.tick(), 'hashed');
  assert.equal(await w.tick(), 'idle');
  assert.equal(calls, 2);
  assert.equal(L.dups.size, 0);
  assert.ok(warns.length >= 1);
});

test('duplicity: keep-first = druhé médium pryč, použití (žádosti, zprávy, počty, tagy) na první; schválení se přenese', async () => {
  const L = memLibrary();
  L.add({ id: id('a'), status: 'rejected', approvedAt: null, useCount: 1, tags: ['cat'], lastUsedAt: new Date(100) });
  L.add({ id: id('b'), status: 'approved', useCount: 4, tags: ['kočka', 'cat'], lastUsedAt: new Date(900) });
  L.requests.push({ id: 1, mediaId: id('b') });
  L.messages.push({ id: 'gif-1', mediaId: id('b') });
  await L.store.insertDuplicate({ channel: 'robdiesalot', a: id('a'), b: id('b'), score: 0.8 });
  const gone: string[] = [], changed: string[] = [], rec: object[] = [];
  const deps = { store: L.store, log: quiet, now: () => 5000, mediaDeleted: (x: string) => gone.push(x), mediaChanged: (x: string) => changed.push(x), recordAction: async (v: object) => { rec.push(v); } };
  const out = await resolveDuplicate(deps, { id: 1, action: 'keep-first', by: 'twitch:moda', accountId: 7 });
  assert.deepEqual(out, { status: 200, body: { ok: true, id: 1, action: 'keep-first', kept: id('a'), removed: id('b') } });
  const a = L.media.get(id('a'))!;
  assert.equal(L.media.has(id('b')), false);
  assert.equal(a.status, 'approved', 'druhé bylo v knihovně → ponechané je v knihovně');
  assert.equal(a.useCount, 5);
  assert.equal(a.lastUsedAt!.getTime(), 900);
  assert.deepEqual(a.tags, ['cat', 'kočka']);
  assert.deepEqual(L.requests, [{ id: 1, mediaId: id('a') }]);
  assert.deepEqual(L.messages, [{ id: 'gif-1', mediaId: id('a') }]);
  assert.deepEqual(gone, [id('b')]);
  assert.deepEqual(changed, [id('a')]);
  assert.equal((rec[0] as { action: string }).action, 'gif_duplicate_keep_first');
  // Řádek zmizel s médiem → další rozhodnutí 404.
  assert.equal((await resolveDuplicate(deps, { id: 1, action: 'keep-both', by: 'x', accountId: null })).status, 404);
});

test('duplicity: keep-second, keep-both (znovu 409), cizí kanál 404, souběh (médium mezitím pryč) 409', async () => {
  const L = memLibrary();
  L.add({ id: id('a') }); L.add({ id: id('b') }); L.add({ id: id('c') });
  await L.store.insertDuplicate({ channel: 'robdiesalot', a: id('a'), b: id('b'), score: 0.7 });
  await L.store.insertDuplicate({ channel: 'robdiesalot', a: id('b'), b: id('c'), score: 0.9 });
  const deps = { store: L.store, log: quiet, now: () => 1 };
  assert.equal((await resolveDuplicate(deps, { id: 1, action: 'keep-both', by: 'x', accountId: null, channel: 'cizi' })).status, 404);
  assert.deepEqual(await resolveDuplicate(deps, { id: 1, action: 'keep-both', by: 'x', accountId: null }), { status: 200, body: { ok: true, id: 1, action: 'keep-both' } });
  assert.deepEqual(await resolveDuplicate(deps, { id: 1, action: 'keep-both', by: 'x', accountId: null }), { status: 409, body: { ok: false, error: 'already_decided', status: 'kept_both' } });
  // keep-second u dvojice 2 → b pryč, ponechané c.
  const L2 = memLibrary();
  L2.add({ id: id('a') }); L2.add({ id: id('b') });
  await L2.store.insertDuplicate({ channel: 'robdiesalot', a: id('a'), b: id('b'), score: 0.7 });
  const out = await resolveDuplicate({ store: L2.store, log: quiet, now: () => 1 }, { id: 1, action: 'keep-second', by: 'x', accountId: null });
  assert.deepEqual(out.body, { ok: true, id: 1, action: 'keep-second', kept: id('b'), removed: id('a') });
  // Souběh: médium mezitím pryč (merge vrátí false) → 409 gone.
  const L3 = memLibrary();
  L3.add({ id: id('a') }); L3.add({ id: id('b') });
  await L3.store.insertDuplicate({ channel: 'robdiesalot', a: id('a'), b: id('b'), score: 0.7 });
  L3.store.mergeInto = async () => false;
  assert.deepEqual(await resolveDuplicate({ store: L3.store, log: quiet, now: () => 1 }, { id: 1, action: 'keep-first', by: 'x', accountId: null }), { status: 409, body: { ok: false, error: 'gone' } });
  // Tvar pro klienty.
  const [p] = await L.store.listDuplicates('robdiesalot', 10);
  const v = duplicateView(p);
  assert.equal(v.first.url, `http://localhost:3000/media/gif/${id('b')}`);
  assert.deepEqual(Object.keys(v).sort(), ['channel', 'createdAt', 'first', 'id', 'score', 'second', 'status']);
});
