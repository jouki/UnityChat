import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClientFetchGrants, CLIENT_FETCH_TTL_MS } from './gifClientFetch.js';

// Stejný helper jako v gifMedia.test.ts (ftyp + tkhd s rozměry).
const mp4 = (w: number, h: number): Buffer => {
  const ftyp = Buffer.alloc(16); ftyp.writeUInt32BE(16, 0); ftyp.write('ftypisom', 4, 'latin1');
  const tkhd = Buffer.alloc(92); tkhd.writeUInt32BE(92, 0); tkhd.write('tkhd', 4, 'latin1'); tkhd.writeUInt32BE(w << 16, 84); tkhd.writeUInt32BE(h << 16, 88);
  return Buffer.concat([ftyp, Buffer.from([0, 0, 0, 8]), Buffer.from('free', 'latin1'), tkhd]);
};
const gif = (w: number, h: number): Buffer => { const b = Buffer.alloc(32); b.write('GIF89a', 0, 'latin1'); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); return b; };
const base = { requestKey: 'twitch:m1', channel: 'robdiesalot', accountId: 7, mediaUrl: 'https://i.imgur.com/a.gif', host: 'i.imgur.com', kind: 'gif' as const, width: 320, height: 240 };

test('granty: upload správných bajtů splní result, grant je jednorázový', async () => {
  const g = createClientFetchGrants({ now: () => 1000, random: () => 'tok-1' });
  const { token, grant, result } = g.issue(base);
  assert.equal(token, 'tok-1');
  assert.equal(grant.expiresAt, 1000 + CLIENT_FETCH_TTL_MS);
  assert.equal(grant.maxBytes, 10 * 1024 * 1024);
  assert.deepEqual(await g.complete(token, 7, gif(320, 240)), { ok: true });
  const r = await result;
  assert.equal(r?.kind, 'gif'); assert.deepEqual([r?.width, r?.height], [320, 240]); assert.equal(r?.sourceUrl, base.mediaUrl);
  assert.deepEqual(await g.complete(token, 7, gif(320, 240)), { ok: false, error: 'bad_token' }, 'podruhé ne');
  assert.equal(g.size, 0);
});

test('granty: cizí účet, po TTL, prázdné, jiný typ, jiné rozměry → chyba a result null', async () => {
  let t = 1000;
  const g = createClientFetchGrants({ now: () => t });
  const a = g.issue(base);
  assert.deepEqual(await g.complete(a.token, 8, gif(320, 240)), { ok: false, error: 'bad_token' });
  assert.equal(await a.result, null, 'po chybě uploadu grant končí');
  const b = g.issue(base);
  t += CLIENT_FETCH_TTL_MS + 1;
  assert.deepEqual(await g.complete(b.token, 7, gif(320, 240)), { ok: false, error: 'bad_token' });
  assert.equal(await b.result, null);
  // Pozn.: gif(322, 240) místo brief-verzí gif(321, 240) — diff přesně 1 px je podle tolerance (±1) v pořádku
  // (viz `tol` case níže), takže jako "mimo toleranci" musí sloužit rozdíl > 1, jinak si testy protiřečí.
  for (const [bytes, err] of [[Buffer.alloc(0), 'empty'], [mp4(320, 240), 'bad_type'], [gif(322, 240), 'size_mismatch'], [Buffer.from('nesmysl'), 'bad_type']] as const) {
    const x = g.issue(base);
    assert.deepEqual(await g.complete(x.token, 7, bytes as Buffer), { ok: false, error: err });
    assert.equal(await x.result, null);
  }
  const tol = g.issue(base);
  assert.deepEqual(await g.complete(tol.token, 7, gif(321, 239)), { ok: true }, 'tolerance ±1 px');
  const noDims = g.issue({ ...base, kind: null, width: null, height: null });
  assert.deepEqual(await g.complete(noDims.token, 7, mp4(640, 360)), { ok: true }, 'bez popisu jen limity');
});

test('granty: vlastní timer na grant (nezávisí na sweep) — vyprší sám; complete() zruší timer jiného grantu', async () => {
  const timers: Array<{ fn: () => void; cleared: boolean }> = [];
  const fakeSetTimeout = (fn: () => void): unknown => { const t = { fn, cleared: false }; timers.push(t); return t; };
  const fakeClearTimeout = (t: unknown): void => { (t as { cleared: boolean }).cleared = true; };
  const g = createClientFetchGrants({ random: () => 'tok-live', setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout });

  const a = g.issue(base);
  assert.equal(timers.length, 1, 'issue() naplánuje vlastní timer');
  timers[0].fn(); // vyprší sám — bez volání sweep()
  assert.equal(await a.result, null);
  assert.equal(g.size, 0);

  const b = g.issue(base);
  assert.equal(timers.length, 2);
  assert.deepEqual(await g.complete(b.token, 7, gif(320, 240)), { ok: true });
  assert.equal(timers[1].cleared, true, 'complete() zruší timer grantu');
});

test('granty: decline → result null hned; sweep po TTL; strop počtu', async () => {
  let t = 0;
  const g = createClientFetchGrants({ now: () => t, max: 2 });
  const a = g.issue(base);
  assert.equal(g.decline(a.token, 7), true);
  assert.equal(await a.result, null);
  assert.equal(g.decline('neznamy', 7), true, 'neznámý token tiše');
  const ex = g.issue(base);
  assert.equal(g.expire(ex.token), true); assert.equal(await ex.result, null); assert.equal(g.expire(ex.token), false);
  const b = g.issue(base); g.issue(base); g.issue(base);
  assert.equal(g.size, 2, 'nejstarší vypadl');
  assert.equal(await b.result, null, 'vypadlý grant = null');
  t = CLIENT_FETCH_TTL_MS + 1;
  assert.equal(g.sweep(), 2);
  assert.equal(g.size, 0);
});
