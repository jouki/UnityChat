import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emailLinkBody, syncEmailLink, syncAllEmailLinks, EMAIL_LINK_MAX_IDENTITIES, type LinkIdentity } from './emailLink.js';

const IDS: LinkIdentity[] = [
  { platform: 'twitch', userId: '29773606', login: 'Trokner' },
  { platform: 'youtube', userId: 'UC5', login: 'tonne.r' },
];
const AT = new Date('2026-09-29T19:51:37.541Z');

test('emailLinkBody: e-mail malými po trimu, login malými, bez duplicit a prázdných id, max 20', () => {
  assert.deepEqual(emailLinkBody(2, '  Tonner@Example.COM ', [...IDS, IDS[0], { platform: 'kick', userId: ' ', login: 'x' }], AT), {
    ucAccountId: '2',
    email: 'tonner@example.com',
    identities: [{ platform: 'twitch', userId: '29773606', login: 'trokner' }, { platform: 'youtube', userId: 'UC5', login: 'tonne.r' }],
    verifiedAt: '2026-09-29T19:51:37.541Z',
  });
  assert.equal(emailLinkBody(2, '', IDS, AT), null, 'bez e-mailu nic');
  assert.equal(emailLinkBody(2, 'a@b.cz', [], AT), null, 'bez identit nic');
  const many = Array.from({ length: 30 }, (_, i) => ({ platform: 'twitch' as const, userId: String(i), login: `u${i}` }));
  assert.equal(emailLinkBody(2, 'a@b.cz', many, AT)!.identities.length, EMAIL_LINK_MAX_IDENTITIES);
});

const mock = (status = 200) => {
  const calls: Array<{ url: string; method: string; body: string | undefined; headers: Record<string, string> }> = [];
  const fetch = (async (url: string, init: { method: string; body?: string; headers: Record<string, string> }) => {
    calls.push({ url, method: init.method, body: init.body, headers: init.headers });
    return { ok: status < 400, status, type: 'basic', json: async () => ({ ok: status < 400 }) } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
};
const logs = () => { const lines: string[] = []; return { lines, log: { info: (o: object, m: string) => lines.push(`${m} ${JSON.stringify(o)}`), warn: (o: object, m: string) => lines.push(`${m} ${JSON.stringify(o)}`) } }; };

test('syncEmailLink: ověřený e-mail + identity → podepsaný POST, e-mail není v adrese ani v logu', async () => {
  const m = mock(); const l = logs();
  const out = await syncEmailLink(2, { fetch: m.fetch, apiKey: 'k', base: 'https://z.test/', signingKey: 'ab'.repeat(32), log: l.log, emailOf: async () => ({ email: 'Tonner@Example.com', verifiedAt: AT }), identitiesOf: async () => IDS });
  assert.equal(out, 'linked');
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].method, 'POST');
  assert.equal(m.calls[0].url, 'https://z.test/integrations/accounts/email-link');
  assert.equal(JSON.parse(m.calls[0].body!).email, 'tonner@example.com');
  assert.equal(JSON.parse(m.calls[0].body!).ucAccountId, '2');
  assert.equal(m.calls[0].headers['X-Api-Key'], 'k');
  assert.ok(m.calls[0].headers['X-UC-Signature'], 'podpis v2');
  assert.ok(!l.lines.join('\n').toLowerCase().includes('tonner@'), 'e-mail se neloguje');
});

test('syncEmailLink: účet bez ověřeného e-mailu nebo bez identit → DELETE s id v cestě', async () => {
  const m = mock();
  const base = { fetch: m.fetch, apiKey: 'k', base: 'https://z.test', signingKey: 'ab'.repeat(32) };
  assert.equal(await syncEmailLink(7, { ...base, emailOf: async () => null, identitiesOf: async () => IDS }), 'removed');
  assert.equal(await syncEmailLink(8, { ...base, emailOf: async () => ({ email: 'a@b.cz', verifiedAt: AT }), identitiesOf: async () => [] }), 'removed');
  assert.deepEqual(m.calls.map((c) => `${c.method} ${c.url} ${c.body ?? ''}`), [
    'DELETE https://z.test/integrations/accounts/email-link/7 ',
    'DELETE https://z.test/integrations/accounts/email-link/8 ',
  ]);
});

test('syncEmailLink: chyba Židolišty / DB nevyhodí, bez klíče se nic neposílá', async () => {
  const bad = mock(500); const l = logs();
  assert.equal(await syncEmailLink(2, { fetch: bad.fetch, apiKey: 'k', base: 'https://z.test', signingKey: 'ab'.repeat(32), log: l.log, emailOf: async () => ({ email: 'tajny@example.com', verifiedAt: AT }), identitiesOf: async () => IDS }), 'failed');
  assert.ok(!l.lines.join('\n').includes('tajny@'), 'ani při chybě e-mail v logu');
  assert.equal(await syncEmailLink(2, { fetch: bad.fetch, apiKey: 'k', base: 'https://z.test', emailOf: async () => { throw new Error('db'); } }), 'failed');
  const none = mock();
  assert.equal(await syncEmailLink(2, { fetch: none.fetch, apiKey: '', emailOf: async () => ({ email: 'a@b.cz', verifiedAt: AT }), identitiesOf: async () => IDS }), 'skipped');
  assert.equal(none.calls.length, 0);
});

test('syncAllEmailLinks: dorovnání projde všechny účty a sečte výsledky', async () => {
  const m = mock();
  const out = await syncAllEmailLinks({ fetch: m.fetch, apiKey: 'k', base: 'https://z.test', signingKey: 'ab'.repeat(32), emailOf: async (id) => (id === 3 ? null : { email: `u${id}@b.cz`, verifiedAt: AT }), identitiesOf: async () => IDS }, [1, 2, 3]);
  assert.deepEqual(out, { linked: 2, removed: 1, skipped: 0, failed: 0 });
  assert.equal(m.calls.length, 3);
});
