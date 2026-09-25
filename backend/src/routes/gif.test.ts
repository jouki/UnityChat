import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediaServer, mediaCacheControl, type MediaEntry } from './gif.js';

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
