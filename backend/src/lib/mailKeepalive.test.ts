import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueProviders, keepaliveMail, KEEPALIVE_DAYS } from './mailKeepalive.js';

test('mailKeepalive: posílá přes službu, která dlouho nic neposlala (nebo nikdy)', () => {
  const now = Date.UTC(2026, 8, 25);
  const day = 24 * 60 * 60 * 1000;
  assert.deepEqual(dueProviders({ brevo: null }, ['brevo'], now), ['brevo']);
  assert.deepEqual(dueProviders({ brevo: new Date(now - 2 * day) }, ['brevo'], now), []);
  assert.deepEqual(dueProviders({ brevo: new Date(now - (KEEPALIVE_DAYS + 1) * day), resend: new Date(now - day) }, ['brevo', 'resend'], now), ['brevo']);
  const m = keepaliveMail('a@b.cz', 'brevo');
  assert.match(m.subject, /Brevo/);
  assert.doesNotMatch(m.html, /<a /, 'bez odkazů');
});
