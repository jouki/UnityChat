import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCatalog, normalizeState } from './soundboard.js';
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
  assert.deepEqual(c.tiers, [{ tier: 1, name: 'Základní' }, { tier: 3, name: null }]);
  assert.deepEqual(normalizeCatalog(null), { tiers: [], sounds: [] });
});

test('normalizeState: tiery, cooldown, výchozí role', () => {
  const s = normalizeState({ role: 'moderator', tiers: [{ tier: 2, startedAt: '2026-09-24T10:00:00Z', expiresAt: null }, { tier: 0 }], cooldown: { globalReadyAt: '2026-09-24T10:00:10Z', userReadyAt: 'nesmysl' } });
  assert.equal(s.role, 'moderator');
  assert.deepEqual(s.tiers, [{ tier: 2, startedAt: '2026-09-24T10:00:00Z', expiresAt: null }]);
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
