import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCatalog, normalizeState, normalizeIcon } from './soundboard.js';
import { highestRole } from '../lib/chatRole.js';

test('normalizeCatalog: jen validní zvuky, řazení tier → jméno, doplnění chybějícího tieru', () => {
  const c = normalizeCatalog({
    tiers: [{ tier: 1, name: ' Základní ', count: 2 }, { tier: 'x' }],
    sounds: [
      { id: 2, name: 'wololo', tier: 1, emoji: '🙏', url: 'https://z/a.mp3', durationMs: 1840.4 },
      { id: 1, name: 'ahShit', tier: 1, emoji: null, url: 'https://z/b.mp3' },
      { id: 3, name: 'boom', tier: 3, url: 'https://z/c.mp3', durationMs: -1 },
      { id: 4, name: 'bad name', tier: 1, url: 'https://z/d.mp3' },
      { id: 5, name: 'http', tier: 1, url: 'http://z/e.mp3' },
      { id: 0, name: 'zero', tier: 1, url: 'https://z/f.mp3' },
    ],
  });
  assert.deepEqual(c.sounds.map((s) => s.id), [1, 2, 3]);
  assert.equal(c.sounds[1].durationMs, 1840);
  assert.equal(c.sounds[2].durationMs, null);
  assert.equal(c.sounds[1].emoji, '🙏');
  assert.deepEqual(c.tiers, [{ tier: 1, name: 'Základní', position: 1 }, { tier: 3, name: null, position: 3 }]);
  assert.deepEqual(normalizeCatalog(null), { tiers: [], sounds: [] });
});

test('normalizeState: tiery, cooldown, výchozí role', () => {
  const s = normalizeState({ role: 'moderator', tiers: [{ tier: 2, startedAt: '2026-09-24T10:00:00Z', expiresAt: null }, { tier: 0 }], cooldown: { globalReadyAt: '2026-09-24T10:00:10Z', userReadyAt: 'nesmysl' } });
  assert.equal(s.role, 'moderator');
  assert.deepEqual(s.tiers, [{ tier: 2, startedAt: '2026-09-24T10:00:00Z', expiresAt: null, paused: false, remainingMs: null, available: true, totalMs: null }]);
  assert.deepEqual(s.cooldown, { globalReadyAt: '2026-09-24T10:00:10Z', userReadyAt: null });
  assert.deepEqual(normalizeState(undefined), { role: 'viewer', tiers: [], cooldown: { globalReadyAt: null, userReadyAt: null } });
});

test('highestRole: broadcaster > mod > vip > sub > viewer', () => {
  const f = { isBroadcaster: false, isMod: false, isVip: false, isSub: false };
  assert.equal(highestRole(f), 'viewer');
  assert.equal(highestRole({ ...f, isSub: true }), 'sub');
  assert.equal(highestRole({ ...f, isSub: true, isVip: true }), 'vip');
  assert.equal(highestRole({ ...f, isSub: true, isMod: true }), 'moderator');
  assert.equal(highestRole({ ...f, isMod: true, isBroadcaster: true }), 'broadcaster');
});

test('normalizeCatalog: displayName a ikona (emoji / 7TV jen z cdn.7tv.app)', () => {
  const c = normalizeCatalog({ sounds: [
    { id: 1, name: 'cejtimPicu', displayName: '  Cejtím p… ', tier: 1, emoji: '🍺', url: 'https://z/1.mp3' },
    { id: 2, name: 'ragey', tier: 1, icon: { kind: '7tv', id: '01F7JCJ0D80007RBBSW6MHGEVC', name: 'RAGEY', url: 'https://cdn.7tv.app/emote/01F7JCJ0D80007RBBSW6MHGEVC/2x.webp' }, url: 'https://z/2.mp3' },
  ] });
  assert.equal(c.sounds[0].displayName, 'Cejtím p…');
  assert.deepEqual(c.sounds[0].icon, { kind: 'emoji', value: '🍺' }, 'staré pole emoji → ikona');
  assert.equal(c.sounds[1].icon?.kind, '7tv');
  assert.equal(c.sounds[1].displayName, null);
  assert.equal(normalizeIcon({ kind: '7tv', id: 'x', url: 'https://evil.example/emote/x/2x.webp' }, null), null, 'cizí host ne');
  assert.equal(normalizeIcon({ kind: '7tv', id: 'x', url: 'https://cdn.7tv.app/emote/x/2x.webp" onerror="' }, null), null, 'žádné uvozovky');
});

test('normalizeState v1.1: zmrazený tier propustí paused, remainingMs, totalMs; available false', () => {
  const s = normalizeState({ tiers: [
    { tier: 1, startedAt: '2026-09-24T10:00:00Z', expiresAt: null, paused: true, remainingMs: 272000.4, available: false, totalMs: 420000 },
    { tier: 2, startedAt: '2026-09-24T10:00:00Z', expiresAt: '2026-09-24T10:10:00Z', paused: false, available: true, totalMs: 600000 },
    { tier: 3, startedAt: '2026-09-24T10:00:00Z', expiresAt: '2026-09-24T10:10:00Z', available: false },
  ] });
  assert.deepEqual(s.tiers[0], { tier: 1, startedAt: '2026-09-24T10:00:00Z', expiresAt: null, paused: true, remainingMs: 272000, available: false, totalMs: 420000 });
  assert.equal(s.tiers[1].available, true);
  assert.equal(s.tiers[2].available, false, 'server řekl, že nejde přehrát');
});

test('normalizeCatalog v1.2: pořadí tierů podle position, ne podle id', () => {
  const c = normalizeCatalog({ tiers: [{ tier: 1, position: 2 }, { tier: 4, name: 'VIP zvuky', position: 1 }], sounds: [
    { id: 1, name: 'a', tier: 1, url: 'https://z/1.mp3' }, { id: 2, name: 'b', tier: 4, url: 'https://z/2.mp3' },
  ] });
  assert.deepEqual(c.tiers.map((t) => t.tier), [4, 1]);
  assert.deepEqual(c.sounds.map((s) => s.id), [2, 1]);
});
