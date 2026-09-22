import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAnnouncement } from './announcements.js';

const ws = new Map([['robdiesalot', 'rob'], ['robmirror', 'rob'], ['tensterakdary', 'stera']]);

test('validateAnnouncement: plný payload projde, ořeže se a rozpadne na kanály workspace', () => {
  const r = validateAnnouncement({ id: 'a1', workspace: 'Rob', command: 'Brohemians', text: ' hi ', media: { url: 'https://cdn/x.webm', kind: 'video', width: '200', loop: 1, stillUrl: 'https://cdn/s.webp' }, chatReply: { text: 'Top D resetováno', hideInUnityChat: 1 }, triggeredBy: { user: 'Jouki728', platform: 'twitch' }, at: '2026-09-22T10:00:00.000Z', extra: 1 }, ws);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.values.map((v) => v.channel), ['robdiesalot', 'robmirror']);
  assert.deepEqual(r.values[0], { id: 'a1', workspace: 'rob', channel: 'robdiesalot', text: 'hi', textHtml: '', media: { url: 'https://cdn/x.webm', kind: 'video', width: 200, height: undefined, loop: true, loopDelayMs: 0, stillUrl: 'https://cdn/s.webp' }, at: '2026-09-22T10:00:00.000Z', chatReply: { text: 'Top D resetováno', hideInUnityChat: true }, command: 'Brohemians', triggeredBy: { user: 'Jouki728', platform: 'twitch' } });
});

test('validateAnnouncement: chyby a okraje', () => {
  assert.deepEqual(validateAnnouncement({ workspace: 'rob', text: 'x' }, ws), { ok: false, error: 'missing_id' });
  assert.deepEqual(validateAnnouncement({ id: '1', workspace: 'nekdo', text: 'x' }, ws), { ok: false, error: 'unknown_workspace' });
  assert.deepEqual(validateAnnouncement({ id: '1', workspace: 'rob', media: { url: 'http://cdn/x.webm' } }, ws), { ok: false, error: 'media_url_must_be_https' });
  assert.deepEqual(validateAnnouncement({ id: '1', workspace: 'rob' }, ws), { ok: false, error: 'empty_announcement' });
  const r = validateAnnouncement({ id: '1', workspace: 'stera', text: 'jen text', media: null, chatReply: { text: '   ' }, at: 'blbost' }, ws);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.values.length, 1);
  assert.equal(r.values[0].media, null);
  assert.equal(r.values[0].chatReply, null, 'prázdná odpověď = null');
  assert.equal(Number.isFinite(Date.parse(r.values[0].at)), true);
  const rich = validateAnnouncement({ id: '2', workspace: 'rob', text: '**b**', textHtml: '<b>b</b>', format: 'markdown' }, ws);
  assert.equal(rich.ok && rich.values[0].textHtml, '<b>b</b>');
  const onlyHtml = validateAnnouncement({ id: '3', workspace: 'rob', textHtml: '<i>x</i>' }, ws);
  assert.equal(onlyHtml.ok, true, 'jen textHtml stačí');
});
