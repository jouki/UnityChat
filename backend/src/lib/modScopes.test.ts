import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOD_SCOPES, missingModScopes } from './modScopes.js';

test('missingModScopes: twitch — chybí scope se seznamem, kompletní seznam prázdné pole', () => {
  assert.deepEqual(missingModScopes('twitch', ['user:write:chat']), [
    'moderator:manage:chat_messages',
    'moderator:manage:banned_users',
    'moderator:manage:warnings',
  ]);
  assert.deepEqual(missingModScopes('twitch', [...MOD_SCOPES.twitch]), []);
});

test('missingModScopes: kick — přesné hodnoty scope', () => {
  assert.deepEqual(missingModScopes('kick', []), ['moderation:chat_message:manage', 'moderation:ban']);
  assert.deepEqual(missingModScopes('kick', ['moderation:chat_message:manage', 'moderation:ban']), []);
});

test('missingModScopes: youtube vždy prázdné pole (žádné MOD_SCOPES)', () => {
  assert.deepEqual(MOD_SCOPES.youtube, []);
  assert.deepEqual(missingModScopes('youtube', null), []);
  assert.deepEqual(missingModScopes('youtube', []), []);
});

test('missingModScopes: granted null = chybí všechny scopes dané platformy', () => {
  assert.deepEqual(missingModScopes('kick', null), ['moderation:chat_message:manage', 'moderation:ban']);
});
