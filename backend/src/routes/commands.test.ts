import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triggerToLiteral, toPublicCommands, parseWorkspaceMap } from './commands.js';

test('triggerToLiteral: prefix beze změny, regex s kotvami a nepovinnou mezerou → literál', () => {
  assert.equal(triggerToLiteral({ kind: 'prefix', value: '!topd' }), '!topd');
  assert.equal(triggerToLiteral({ kind: 'prefix', value: ' !c  title ' }), '!c title');
  assert.equal(triggerToLiteral({ kind: 'regex', value: '!topd ?reset' }), '!topd reset');
  assert.equal(triggerToLiteral({ kind: 'regex', value: '^!topd\\s*reset$' }), '!topd reset');
  assert.equal(triggerToLiteral({ kind: 'regex', value: '^\\!video\\b' }), '!video');
  assert.equal(triggerToLiteral({ kind: 'regex', value: '!se (add|remove)' }), null, 'alternace není literál');
  assert.equal(triggerToLiteral({ kind: 'regex', value: '!c\\+' }), null);
  assert.equal(triggerToLiteral({ kind: 'regex', value: '' }), null);
});

test('toPublicCommands: jen commandy s literálem, role a prodleva, bez reply a jmen', () => {
  const out = toPublicCommands([
    { id: 1, name: 'Reset Top D', triggers: [{ kind: 'regex', value: '!topd ?reset' }, { kind: 'prefix', value: '!topdreset' }], allowRoles: ['moderator', 'broadcaster'], cooldownSeconds: 0, reply: 'tajné', allowUsers: ['x'] },
    { id: 2, name: 'Jen regex', triggers: [{ kind: 'regex', value: '(a|b)+' }], allowRoles: ['viewer'] },
    { id: 3, name: 'Top D', triggers: [{ kind: 'prefix', value: '!topd' }], allowRoles: ['viewer', 'sub', 'vip', 'moderator', 'broadcaster'], cooldownSeconds: 30 },
  ]);
  assert.deepEqual(out, [
    { name: 'Reset Top D', trigger: '!topd reset', triggers: ['!topd reset', '!topdreset'], roles: ['moderator', 'broadcaster'], cooldownSeconds: 0, source: 'zidolista', reply: 'tajné', announcement: null },
    { name: 'Top D', trigger: '!topd', triggers: ['!topd'], roles: ['viewer', 'sub', 'vip', 'moderator', 'broadcaster'], cooldownSeconds: 30, source: 'zidolista', reply: '', announcement: null },
  ]);
  const withAnnc = toPublicCommands([{ name: 'B', triggers: [{ kind: 'prefix', value: '!b' }], announcement: { text: '**x**', textHtml: '<b>x</b>', media: { url: 'https://cdn/a.webm', kind: 'video', width: 200, loopDelayMs: 500 }, hideChatReplyInUnityChat: true } }]);
  assert.deepEqual(withAnnc[0].announcement, { text: '**x**', textHtml: '<b>x</b>', media: { url: 'https://cdn/a.webm', kind: 'video', width: 200, height: undefined, loop: true, loopDelayMs: 500, stillUrl: null }, hideChatReplyInUnityChat: true });
  assert.equal(toPublicCommands([{ name: 'C', triggers: [{ kind: 'prefix', value: '!c' }], announcement: { media: { url: 'http://x' } } }])[0].announcement, null, 'http médium = bez announcementu');
  assert.deepEqual(toPublicCommands(null), []);
});

test('parseWorkspaceMap', () => {
  const m = parseWorkspaceMap(' RobDiesALot=rob , tensterakdary=stera,bad,');
  assert.equal(m.get('robdiesalot'), 'rob');
  assert.equal(m.get('tensterakdary'), 'stera');
  assert.equal(m.size, 2);
});
