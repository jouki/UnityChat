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
  // Skupiny po workspacu: streamer smí jméno svého kanálu z jiné platformy (jouki728 ↔ YouTube @Jouki, živě 2026-09-30).
  const GROUPS = [['unitychat', 'joukibot'], ['jouki728', 'jouki728', '@Jouki'], ['robdiesalot', '@robdiesalot']];
  assert.equal(reservedNicknameClash('Jouki', ['jouki728'], GROUPS), null, 'vlastník workspace jouki');
  assert.equal(reservedNicknameClash('Jouki', ['nekdojiny'], GROUPS), '@Jouki', 'cizí účet ne');
  assert.equal(reservedNicknameClash('RobDiesALot', ['jouki728'], GROUPS), 'robdiesalot', 'jiný workspace zůstává rezervovaný');
  assert.equal(reservedNicknameClash('JoukiBOT', ['jouki728'], GROUPS), 'joukibot', 'pevná jména jsou vlastní skupina');
});
