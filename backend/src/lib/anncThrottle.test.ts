import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnncThrottle, ANNC_MIN_GAP_MESSAGES } from './anncThrottle.js';

test('anncThrottle: bez UnityChatu jen po 10 zprávách od posledního zobrazení téhož commandu; UC uživatel vždy', () => {
  let now = 1_000_000;
  const t = new AnncThrottle(() => now);
  const msg = (n: number, extra: Partial<{ platform: string; username: string; isUnitychatUser: boolean; isBot: boolean }> = {}) => {
    for (let i = 0; i < n; i++) t.onMessage('RobDiesALot', { platform: 'twitch', username: 'divak', ...extra });
  };
  const trig = { user: 'treficek34', platform: 'twitch' };
  assert.equal(t.decide('robdiesalot', 'Chci Hrát', trig).show, true, 'první announcement vždy');
  msg(3);
  assert.deepEqual(t.decide('robdiesalot', 'Chci Hrát', trig), { show: false, since: 3, uc: false }, 'spam bez UC → potlačen');
  assert.equal(t.decide('robdiesalot', 'Jiný command', trig).show, true, 'jiný command se počítá zvlášť');
  // Uživatel UnityChatu (psal přes UC) → vždy.
  t.onMessage('robdiesalot', { platform: 'kick', username: 'Jouki728', isUnitychatUser: true });
  assert.equal(t.decide('robdiesalot', 'Chci Hrát', { user: 'jouki728', platform: 'kick' }).show, true);
  // Zobrazení výše resetuje počítadlo → zase 10 zpráv; boti se nepočítají.
  msg(9);
  msg(5, { isBot: true, username: 'JoukiBOT' });
  assert.equal(t.decide('robdiesalot', 'Chci Hrát', trig).show, false, '9 zpráv (+ boti) nestačí');
  msg(1);
  assert.equal(t.decide('robdiesalot', 'Chci Hrát', trig).show, true, `${ANNC_MIN_GAP_MESSAGES} zpráv → zase zobrazit`);
  // Dodatečně označený command z UC (markUc) — platí 2 min.
  t.noteUc('youtube', '@Winter_Ian');
  assert.equal(t.decide('robdiesalot', 'Chci Hrát', { user: 'Winter_Ian', platform: 'youtube' }).show, true);
  now += 3 * 60_000;
  assert.equal(t.isUcAuthor('youtube', 'winter_ian'), false, 'po 2 min už ne');
  // Bez triggeredBy = nelze ověřit UC → jen podle počtu zpráv.
  assert.equal(t.decide('robdiesalot', 'Chci Hrát', null).show, false);
  // Časovač commandu (Židolišta triggeredBy.user „timer“) → vždy.
  assert.equal(t.decide('robdiesalot', 'Chci Hrát', { user: 'timer', platform: 'twitch' }).show, true);
});
