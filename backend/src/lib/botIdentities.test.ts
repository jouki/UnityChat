import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rememberBot, isBotAuthor, _resetBotsForTest, SHARED } from './botIdentities.js';

test('isBotAuthor: Kick bot podle id, i když se username liší od slugu', () => {
  _resetBotsForTest();
  rememberBot('kick', 'jouki-bot', SHARED, '987');
  assert.equal(isBotAuthor('kick', 'Jouki_BOT', 'rob', '987'), true, 'shoda podle id');
  assert.equal(isBotAuthor('kick', 'Jouki_BOT', 'rob', '111'), false, 'jiné id, jiné jméno');
  assert.equal(isBotAuthor('kick', 'jouki-bot', 'rob', ''), true, 'záloha podle loginu');
});

test('isBotAuthor: vlastní bot workspace platí jen pro svůj workspace, sdílený pro všechny', () => {
  _resetBotsForTest();
  rememberBot('twitch', 'robbot', 'rob', '555');
  assert.equal(isBotAuthor('twitch', 'RobBot', 'rob', '555'), true);
  assert.equal(isBotAuthor('twitch', 'RobBot', 'jiny', '555'), false);
  rememberBot('youtube', 'joukibot', SHARED, 'UCabc');
  assert.equal(isBotAuthor('youtube', 'Jouki BOT', 'jiny', 'UCabc'), true, 'YouTube: jméno se liší, id sedí');
});
