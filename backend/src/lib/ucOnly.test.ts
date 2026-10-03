import { test } from 'node:test';
import assert from 'node:assert/strict';
import { youtubeChatIdFromInsert, ucOnlyContentRaw, HeldRegistry, HELD_TTL_MS } from './ucOnly.js';

test('ucOnly: id zprávy YouTube z insertu → id v chatu (ověřeno 2026-10-02: LCC.Eh… ↔ Ch…)', () => {
  assert.equal(youtubeChatIdFromInsert('LCC.EhwKGkNMN3A3X2F2bTVjREZleFlxd0lkUEdnSVN3'), 'ChwKGkNMN3A3X2F2bTVjREZleFlxd0lkUEdnSVN3');
  assert.equal(youtubeChatIdFromInsert('ChwKGkNMN3A3X2F2bTVjREZleFlxd0lkUEdnSVN3'), 'ChwKGkNMN3A3X2F2bTVjREZleFlxd0lkUEdnSVN3');
  assert.equal(youtubeChatIdFromInsert(null), null);
  assert.equal(youtubeChatIdFromInsert('nesmysl'), null);
});

test('ucOnly: content_raw ve tvaru platformy + příznak', () => {
  const tw = ucOnlyContentRaw('twitch', 'ahoj', { color: '#f00', badges: 'subscriber/12', login: 'x' }, { reason: 'drop', heldId: null });
  assert.deepEqual(tw, { color: '#f00', badges: 'subscriber/12', login: 'x', displayName: undefined, ucOnly: { reason: 'drop' } });
  assert.deepEqual(ucOnlyContentRaw('youtube', 'ahoj', null, { reason: 'held', heldId: 'Chw1' }), { runs: [{ text: 'ahoj' }], ucOnly: { reason: 'held', heldId: 'Chw1' } });
  assert.deepEqual(ucOnlyContentRaw('kick', 'ahoj', null, { reason: '', heldId: null }).content, 'ahoj');
});

test('ucOnly: zadržená zpráva se spáruje jednou, po 24 h ne', () => {
  let now = 0;
  const r = new HeldRegistry(() => now);
  r.remember('Chw1', 'uco-a');
  assert.equal(r.take('Chw1'), 'uco-a');
  assert.equal(r.take('Chw1'), null, 'spotřebováno');
  r.remember('Chw2', 'uco-b');
  now = HELD_TTL_MS + 1;
  assert.equal(r.take('Chw2'), null);
});

test('ucOnlyContentRaw: YouTube nese odznaky z poslední zprávy (role pro filtr odkazů a GIFy)', () => {
  assert.deepEqual(ucOnlyContentRaw('youtube', 'x', { badges: ['Moderátor'] }, { reason: '', heldId: null }).badges, ['Moderátor']);
  assert.equal('badges' in ucOnlyContentRaw('youtube', 'x', null, { reason: '', heldId: null }), false);
});
