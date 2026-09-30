import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reservedNicknameClash, simplifyName } from './reservedNicknames.js';

const RES = ['robdiesalot', 'tensterakdary', 'unitychat', 'joukibot'];

test('simplifyName: malá písmena, bez mezer, teček, podtržítek, pomlček a zavináče', () => {
  assert.equal(simplifyName(' Rob Dies A Lot '), 'robdiesalot');
  assert.equal(simplifyName('rob_dies-a.lot'), 'robdiesalot');
  assert.equal(simplifyName('@RobDiesALot'), 'robdiesalot');
  assert.equal(simplifyName(null), '');
});

test('reservedNicknameClash: jméno streamera smí jen účet s tím loginem', () => {
  assert.equal(reservedNicknameClash('RobDiesALot', ['jouki728'], RES), 'robdiesalot');
  assert.equal(reservedNicknameClash('Rob Dies A Lot', ['jouki728'], RES), 'robdiesalot', 'mezery neobejdou');
  assert.equal(reservedNicknameClash('rob_dies_a_lot', ['jouki728'], RES), 'robdiesalot');
  assert.equal(reservedNicknameClash('RobDiesALot', ['robdiesalot'], RES), null, 'Rob sám může');
  assert.equal(reservedNicknameClash('Rob Dies A Lot', ['RobDiesALot', 'jouki728'], RES), null, 'login na jiné platformě účtu stačí');
  assert.equal(reservedNicknameClash('UnityChat', ['jouki728'], RES), 'unitychat');
  assert.equal(reservedNicknameClash('Jouki', ['jouki728'], RES), null, 'běžná přezdívka projde');
  assert.equal(reservedNicknameClash('RobDiesALot2', ['jouki728'], RES), null, 'jiné jméno není rezervované');
  assert.equal(reservedNicknameClash('', ['x'], RES), null);
});
