import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyReply } from 'fastify';
import { issueStreamTicket, consumeStreamTicket, addAccountStream, sendToAccount, disconnectAllAccountStreams, MAX_STREAMS_PER_ACCOUNT } from './accountWarnings.js';

function fakeReply() {
  const out: string[] = [];
  return { out, reply: { raw: { write: (s: string) => { out.push(s); return true; }, end() {} } } as unknown as FastifyReply };
}

test('stream ticket: jednorázový, propadá po 60 s, neznámý → null', () => {
  const t = issueStreamTicket(7, 1000);
  assert.equal(consumeStreamTicket(t, 2000), 7);
  assert.equal(consumeStreamTicket(t, 2000), null, 'druhé použití');
  const t2 = issueStreamTicket(7, 1000);
  assert.equal(consumeStreamTicket(t2, 61_001), null, 'propadlý');
  assert.equal(consumeStreamTicket('nesmysl'), null);
});

test('sendToAccount: událost dostanou JEN spojení daného účtu', () => {
  const a = fakeReply();
  const a2 = fakeReply();
  const b = fakeReply();
  const ra = addAccountStream(1, a.reply)!;
  const ra2 = addAccountStream(1, a2.reply)!;
  const rb = addAccountStream(2, b.reply)!;
  assert.equal(sendToAccount(1, 'account-warning', { id: 5, reason: 'x' }), 2);
  assert.deepEqual(a.out, ['event: account-warning\ndata: {"id":5,"reason":"x"}\n\n']);
  assert.equal(a2.out.length, 1);
  assert.deepEqual(b.out, []);
  assert.equal(sendToAccount(3, 'account-warning', {}), 0);
  ra(); ra2(); rb();
  assert.equal(sendToAccount(1, 'account-warning', {}), 0, 'po odhlášení nic');
});

test('addAccountStream: limit spojení na účet', () => {
  const removers = [];
  for (let i = 0; i < MAX_STREAMS_PER_ACCOUNT; i++) removers.push(addAccountStream(9, fakeReply().reply));
  assert.ok(removers.every(Boolean));
  assert.equal(addAccountStream(9, fakeReply().reply), null);
  disconnectAllAccountStreams();
});
