import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLimits, limitError, mapUpstreamError, mergeRequests, normalizeRequests, PrepareBody, pragueDay, rangeError, SubmitBody } from './sfxRequests.js';
import { normalizeCatalog } from './soundboard.js';

test('pragueDay: hranice dne podle Europe/Prague (léto +2, zima +1)', () => {
  assert.equal(pragueDay(new Date('2026-09-30T21:59:59Z')), '2026-09-30');
  assert.equal(pragueDay(new Date('2026-09-30T22:00:00Z')), '2026-10-01', 'CEST: 22:00 UTC = půlnoc');
  assert.equal(pragueDay(new Date('2026-12-31T22:59:59Z')), '2026-12-31');
  assert.equal(pragueDay(new Date('2026-12-31T23:00:00Z')), '2027-01-01', 'CET: 23:00 UTC = půlnoc');
});

test('computeLimits: den a měsíc v Praze, ne v UTC', () => {
  // 1. 10. 00:30 pražského času = 30. 9. 22:30 UTC.
  const now = new Date('2026-09-30T22:30:00Z');
  const l = computeLimits([
    '2026-09-30T22:05:00Z',   // 1. 10. 00:05 Praha → dnes i tento měsíc
    '2026-09-30T21:59:00Z',   // 30. 9. 23:59 Praha → minulý měsíc
    '2026-09-15T10:00:00Z',   // září
    'nesmysl', null, undefined,
  ], now);
  assert.deepEqual(l, { dayUsed: 1, dayMax: 10, monthUsed: 1, monthMax: 30 });

  const mid = new Date('2026-09-20T12:00:00Z');
  const same = Array.from({ length: 12 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}T12:00:00Z`);
  const l2 = computeLimits([...same, '2026-09-20T01:00:00Z', '2026-09-19T22:30:00Z'], mid);
  assert.equal(l2.dayUsed, 2, '19. 9. 22:30 UTC = 20. 9. 00:30 Praha');
  assert.equal(l2.monthUsed, 14);
});

test('limitError: den před měsícem, jinak null', () => {
  const base = { dayMax: 10, monthMax: 30 };
  assert.equal(limitError({ ...base, dayUsed: 9, monthUsed: 29 }), null);
  assert.equal(limitError({ ...base, dayUsed: 10, monthUsed: 10 }), 'limit_day');
  assert.equal(limitError({ ...base, dayUsed: 2, monthUsed: 30 }), 'limit_month');
  assert.equal(limitError({ ...base, dayUsed: 10, monthUsed: 30 }), 'limit_day');
});

test('mapUpstreamError: kódy Židolišty beze změny se stejným statusem, jiné = 502', () => {
  assert.deepEqual(mapUpstreamError(400, { ok: false, error: 'youtube_blocked' }), { status: 400, error: 'youtube_blocked' });
  assert.deepEqual(mapUpstreamError(429, { ok: false, error: 'busy' }), { status: 429, error: 'busy' });
  assert.deepEqual(mapUpstreamError(410, { ok: false, error: 'expired' }), { status: 410, error: 'expired' });
  assert.deepEqual(mapUpstreamError(409, { ok: false, error: 'name_taken' }), { status: 409, error: 'name_taken' });
  assert.deepEqual(mapUpstreamError(401, { ok: false, error: 'unauthorized' }), { status: 502, error: 'zidolista_unavailable' });
  assert.deepEqual(mapUpstreamError(400, { ok: false, error: 'invalid_body' }), { status: 502, error: 'zidolista_unavailable' });
  assert.deepEqual(mapUpstreamError(500, null), { status: 502, error: 'zidolista_unavailable' });
});

test('normalizeRequests + mergeRequests: validní položky, bez duplicit, nejnovější první', () => {
  const tw = normalizeRequests({ requests: [
    { requestId: 3, name: 'boom', status: 'approved', createdAt: '2026-09-25T10:00:00Z', decidedAt: '2026-09-25T11:00:00Z', soundName: 'boom' },
    { requestId: 1, name: 'x', status: 'rejected', reason: ' ošklivé ', createdAt: '2026-09-24T10:00:00Z' },
    { requestId: 'a', name: 'bad', status: 'pending', createdAt: '2026-09-24T10:00:00Z' },
    { requestId: 9, name: 'bad', status: 'weird', createdAt: '2026-09-24T10:00:00Z' },
  ] }, 'twitch');
  assert.equal(tw.length, 2);
  assert.equal(tw[1].reason, 'ošklivé');
  assert.equal(tw[1].soundName, null);
  const kick = normalizeRequests({ requests: [{ requestId: 5, name: 'k', status: 'pending', createdAt: '2026-09-25T12:00:00Z' }, { requestId: 3, name: 'dup', status: 'approved', createdAt: '2026-09-25T10:00:00Z' }] }, 'kick');
  const m = mergeRequests([tw, kick]);
  assert.deepEqual(m.map((r) => r.requestId), [5, 3, 1]);
  assert.equal(m[0].platform, 'kick');
  assert.deepEqual(normalizeRequests(null, 'twitch'), []);
});

test('rangeError: start < end, max 30 s (+50 ms tolerance)', () => {
  assert.equal(rangeError(0, 30_000), null);
  assert.equal(rangeError(1000, 31_050), null);
  assert.equal(rangeError(1000, 31_051), 'too_long');
  assert.equal(rangeError(5000, 5000), 'bad_range');
  assert.equal(rangeError(-1, 5000), 'bad_range');
});

test('zod těla: prepare a submit', () => {
  assert.equal(PrepareBody.safeParse({ channel: '@RobDiesALot', platform: 'twitch', url: 'https://youtu.be/abcdefgh' }).data?.channel, 'robdiesalot');
  assert.equal(PrepareBody.safeParse({ channel: 'rob', platform: 'tiktok', url: 'https://youtu.be/abcdefgh' }).success, false);
  assert.equal(PrepareBody.safeParse({ channel: 'rob', platform: 'twitch', url: 'x' }).success, false);
  assert.equal(PrepareBody.safeParse({ channel: 'rob', platform: 'twitch', url: 'https://a.b/c.mp3', requester: {} }).success, false, 'identitu klient neposílá');
  const ok = { channel: 'rob', platform: 'kick', previewId: 'abc', startMs: 0, endMs: 5000, name: 'boom' };
  assert.equal(SubmitBody.safeParse(ok).success, true);
  assert.equal(SubmitBody.safeParse({ ...ok, note: 'poznámka' }).success, true);
  assert.equal(SubmitBody.safeParse({ ...ok, name: '' }).success, false);
  assert.equal(SubmitBody.safeParse({ ...ok, name: 'x'.repeat(41) }).success, false);
  assert.equal(SubmitBody.safeParse({ ...ok, startMs: 1.5 }).success, false);
  assert.equal(SubmitBody.safeParse({ ...ok, note: 'x'.repeat(301) }).success, false);
});

test('normalizeCatalog: gainDb se propíše (0 = beze změny, ořez ±20 dB)', () => {
  const c = normalizeCatalog({ sounds: [
    { id: 1, name: 'a', tier: 1, url: 'https://z/a.mp3', gainDb: -3.46 },
    { id: 2, name: 'b', tier: 1, url: 'https://z/b.mp3' },
    { id: 3, name: 'c', tier: 1, url: 'https://z/c.mp3', gainDb: 99 },
  ] });
  assert.deepEqual(c.sounds.map((s) => s.gainDb), [-3.5, 0, 20]);
});
