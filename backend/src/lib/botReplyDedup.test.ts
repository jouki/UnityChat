import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BotReplyDedup } from './botReplyDedup.js';

const T0 = Date.parse('2026-10-02T11:44:00Z');
const msg = (platform: string, id: string, content: string, dt = 0) => ({ platform, platformMessageId: id, content, sentAt: new Date(T0 + dt) });

test('botReplyDedup: stejná odpověď bota z další platformy do 15 s = duplikát první; stejná platforma ne; po okně ne', () => {
  const d = new BotReplyDedup(() => T0);
  assert.equal(d.check(msg('twitch', 't1', 'Koukáš na stream? https://jouki.cz/aoe/ ⠀'), 'robdiesalot'), null);
  assert.equal(d.check(msg('kick', 'k1', 'Koukáš  na stream? https://jouki.cz/aoe/', 1500), 'RobDiesALot'), 't1', 'marker a mezery sjednocené');
  assert.equal(d.check(msg('youtube', 'y1', 'koukáš na stream? https://jouki.cz/aoe/', 3000), 'robdiesalot'), 't1');
  assert.equal(d.check(msg('twitch', 't2', 'Koukáš na stream? https://jouki.cz/aoe/', 5000), 'robdiesalot'), null, 'znovu na stejné platformě = nová odpověď');
  assert.equal(d.check(msg('kick', 'k2', 'jiný text', 1000), 'robdiesalot'), null);
  assert.equal(d.check(msg('kick', 'k3', 'Koukáš na stream? https://jouki.cz/aoe/', 25_000), 'robdiesalot'), null, 'mimo okno');
  assert.equal(d.check(msg('kick', 'k4', 'Koukáš na stream? https://jouki.cz/aoe/', 1000), 'jinykanal'), null, 'jiný kanál');
});

test('botReplyDedup: skupina odpovědí — platforma první + všechny platformy, kde bot odpověděl (jedna zpráva s logy)', () => {
  const d = new BotReplyDedup(() => T0);
  d.check(msg('twitch', 't1', 'Kategorie: WoW'), 'robdiesalot');
  assert.equal(d.group('t1'), null, 'bez kopie zatím žádná skupina');
  assert.equal(d.check(msg('kick', 'k1', 'Kategorie: WoW', 800), 'robdiesalot'), 't1');
  assert.deepEqual(d.group('t1'), { platform: 'twitch', platforms: ['twitch', 'kick'] });
  d.check(msg('youtube', 'y1', 'Kategorie: WoW', 2000), 'robdiesalot');
  assert.deepEqual(d.group('t1'), { platform: 'twitch', platforms: ['twitch', 'kick', 'youtube'] });
});
