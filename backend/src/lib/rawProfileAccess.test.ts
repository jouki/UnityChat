import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canEditProfile, canManageChannel } from './rawProfileAccess.js';

const deps = (editors: Record<number, string[]>) => ({ isEditor: async (acc: number, ch: string) => (editors[acc] || []).includes(ch) });
const D = deps({ 1: ['robdiesalot'], 2: ['jinykanal'] });

test('canEditProfile: jen přihlášený streamer / mod kanálu instance; nikdo jiný ani se znalostí id', async () => {
  assert.deepEqual(await canEditProfile({ channel: 'robdiesalot' }, null, D), { ok: false, status: 401, error: 'login_required' });
  assert.deepEqual(await canEditProfile({ channel: 'robdiesalot' }, 2, D), { ok: false, status: 403, error: 'not_editor' });
  assert.deepEqual(await canEditProfile({ channel: 'robdiesalot' }, 1, D), { ok: true });
  assert.deepEqual(await canEditProfile(null, 1, D), { ok: false, status: 404, error: 'not_found' });
  assert.deepEqual(await canEditProfile({ channel: null }, 1, D), { ok: false, status: 403, error: 'not_editor' }, 'nepřipojená = nikdo');
  assert.deepEqual(await canEditProfile({ channel: 'robdiesalot' }, 1, { isEditor: async () => { throw new Error('db'); } }), { ok: false, status: 403, error: 'not_editor' }, 'chyba ověření = ne');
});

test('canManageChannel: seznam a nová instance jen pro editora kanálu', async () => {
  assert.deepEqual(await canManageChannel('robdiesalot', null, D), { ok: false, status: 401, error: 'login_required' });
  assert.deepEqual(await canManageChannel('robdiesalot', 2, D), { ok: false, status: 403, error: 'not_editor' });
  assert.deepEqual(await canManageChannel('robdiesalot', 1, D), { ok: true });
});
