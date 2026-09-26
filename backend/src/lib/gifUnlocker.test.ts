import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveGif, GifError, GIF_MAX_BYTES, type Transport, type LookupAll } from './gifMedia.js';
import { createUnlocker, UNLOCKER_ENDPOINT, UNLOCKER_NEGATIVE_TTL_MS, type UnlockerOptions } from './gifUnlocker.js';

const KEY = 'SECRET-brd-key-9f8e7d';
const gif = (): Buffer => { const b = Buffer.alloc(32); b.write('GIF89a', 0, 'latin1'); b.writeUInt16LE(320, 6); b.writeUInt16LE(240, 8); return b; };
const URL_4PC = 'https://i.4pcdn.org/pol/1562850136932.gif';

const lookupAll: LookupAll = async (h) => [{ address: /internal/.test(h) ? '10.0.0.1' : '8.8.8.8', family: 4 }];

type Route = { status?: number; headers?: Record<string, string>; body?: Buffer | Buffer[] };
function transportOf(routes: Record<string, Route>, calls: string[] = []): Transport {
  return async (url) => {
    calls.push(url.toString());
    const r = routes[url.toString()] ?? { status: 404 };
    const chunks = Array.isArray(r.body) ? r.body : r.body ? [r.body] : [];
    return { status: r.status ?? 200, headers: r.headers ?? {}, body: (async function* () { for (const c of chunks) yield c; })(), dispose() {} };
  };
}
const challenge: Route = { status: 403, headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html', server: 'cloudflare' }, body: Buffer.from('<html>Just a moment...</html>') };

type Call = { url: string; init: RequestInit };
/** Falešný fetch Bright Data: odpověď podle cílové URL v těle požadavku. */
function brdFetch(reply: (target: string, signal: AbortSignal) => Response | Promise<Response>, calls: Call[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    const target = JSON.parse(String(init!.body)).url as string;
    return reply(target, init!.signal as AbortSignal);
  }) as typeof fetch;
}
const ok = (body: Buffer | string, headers: Record<string, string> = {}): Response =>
  new Response(body, { status: 200, headers: { 'x-brd-status-code': '200', 'content-type': 'image/gif', ...headers } });

function mk(o: Partial<UnlockerOptions> & { fetch: typeof fetch }, logs: string[] = []) {
  return createUnlocker({ apiKey: KEY, zone: 'uc_gif', dailyCap: 100, log: (obj, msg) => logs.push(`${msg} ${JSON.stringify(obj)}`), ...o });
}

test('unlocker: po Cloudflare challenge stáhne přes Bright Data (POST, Bearer, zone/url/format raw), stejný výstup', async () => {
  const calls: Call[] = [];
  const logs: string[] = [];
  const unlocker = mk({ fetch: brdFetch(() => ok(gif()), calls) }, logs);
  const r = await resolveGif({ url: URL_4PC, mode: 'direct' }, { transport: transportOf({ [URL_4PC]: challenge }), lookupAll, unlocker });
  assert.deepEqual([r.kind, r.contentType, r.width, r.height, r.sourceUrl], ['gif', 'image/gif', 320, 240, URL_4PC]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, UNLOCKER_ENDPOINT);
  assert.equal(calls[0].init.method, 'POST');
  const h = calls[0].init.headers as Record<string, string>;
  assert.equal(h.Authorization, `Bearer ${KEY}`);
  assert.equal(h['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { zone: 'uc_gif', url: URL_4PC, format: 'raw' });
  assert.deepEqual(logs, ['gif: unlocker ok {"host":"i.4pcdn.org"}']);
});

test('unlocker: 403 s HTML „Just a moment“ a cf- hlavičkami (bez cf-mitigated) i 503 challenge spustí fallback', async () => {
  const calls: Call[] = [];
  const unlocker = mk({ fetch: brdFetch(() => ok(gif()), calls) });
  const html: Route = { status: 403, headers: { 'content-type': 'text/html; charset=UTF-8', 'cf-ray': '8abc-PRG' }, body: Buffer.from('<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/x"></script>') };
  assert.equal((await resolveGif({ url: 'https://a.cz/x.gif', mode: 'direct' }, { transport: transportOf({ 'https://a.cz/x.gif': html }), lookupAll, unlocker })).kind, 'gif');
  const s503: Route = { status: 503, headers: { 'cf-mitigated': 'challenge' } };
  assert.equal((await resolveGif({ url: 'https://b.cz/x.gif', mode: 'direct' }, { transport: transportOf({ 'https://b.cz/x.gif': s503 }), lookupAll, unlocker })).kind, 'gif');
  assert.equal(calls.length, 2);
});

test('unlocker: bez klíče / zóny vypnutý; ne-challenge 403 a neveřejná URL fallback nevolají', async () => {
  const calls: Call[] = [];
  const f = brdFetch(() => ok(gif()), calls);
  assert.equal(createUnlocker({ apiKey: '', zone: 'z', dailyCap: 100, fetch: f }), null);
  assert.equal(createUnlocker({ apiKey: KEY, zone: '', dailyCap: 100, fetch: f }), null);
  assert.equal(createUnlocker({ apiKey: KEY, zone: 'z', dailyCap: 0, fetch: f }), null);
  // Bez unlockeru: challenge = původní chyba.
  await assert.rejects(resolveGif({ url: URL_4PC, mode: 'direct' }, { transport: transportOf({ [URL_4PC]: challenge }), lookupAll, unlocker: null }), (e: GifError) => e.code === 'bot_protection');

  const unlocker = mk({ fetch: f });
  const plain403: Route = { status: 403, headers: { 'content-type': 'text/html' }, body: Buffer.from('<h1>Forbidden</h1>') };
  await assert.rejects(resolveGif({ url: 'https://a.cz/x.gif', mode: 'direct' }, { transport: transportOf({ 'https://a.cz/x.gif': plain403 }), lookupAll, unlocker }), (e: GifError) => e.code === 'http_403');
  const cfNoChallenge: Route = { status: 403, headers: { 'content-type': 'text/html', 'cf-ray': '1' }, body: Buffer.from('<h1>Access denied (hotlink)</h1>') };
  await assert.rejects(resolveGif({ url: 'https://a.cz/y.gif', mode: 'direct' }, { transport: transportOf({ 'https://a.cz/y.gif': cfNoChallenge }), lookupAll, unlocker }), (e: GifError) => e.code === 'http_403');
  const s500: Route = { status: 500, headers: { 'cf-mitigated': 'challenge' } };
  await assert.rejects(resolveGif({ url: 'https://a.cz/z.gif', mode: 'direct' }, { transport: transportOf({ 'https://a.cz/z.gif': s500 }), lookupAll, unlocker }), (e: GifError) => e.code === 'http_500');

  // Neveřejná URL: ani transport, ani Bright Data.
  const tCalls: string[] = [];
  const all = transportOf({ 'http://10.0.0.1/a.gif': challenge, 'https://internal.cz/a.gif': challenge }, tCalls);
  await assert.rejects(resolveGif({ url: 'http://10.0.0.1/a.gif', mode: 'direct' }, { transport: all, lookupAll, unlocker }), (e: GifError) => e.code === 'blocked');
  await assert.rejects(resolveGif({ url: 'https://internal.cz/a.gif', mode: 'direct' }, { transport: all, lookupAll, unlocker }), (e: GifError) => e.code === 'blocked');
  // Přesměrování na neveřejnou adresu, která by vrátila challenge → blocked dřív, než se cokoli pošle.
  const redir = transportOf({ 'https://a.cz/r.gif': { status: 302, headers: { location: 'https://internal.cz/a.gif' } }, 'https://internal.cz/a.gif': challenge }, tCalls);
  await assert.rejects(resolveGif({ url: 'https://a.cz/r.gif', mode: 'direct' }, { transport: redir, lookupAll, unlocker }), (e: GifError) => e.code === 'blocked');
  assert.deepEqual(tCalls, ['https://a.cz/r.gif']);
  assert.equal(calls.length, 0);
});

test('unlocker: přesměrování / cílová adresa z odpovědi Bright Data na neveřejnou adresu → blocked', async () => {
  const toInternal = mk({ fetch: brdFetch(() => new Response(null, { status: 200, headers: { 'x-brd-status-code': '302', location: 'http://169.254.169.254/latest' } })) });
  await assert.rejects(resolveGif({ url: URL_4PC, mode: 'direct' }, { transport: transportOf({ [URL_4PC]: challenge }), lookupAll, unlocker: toInternal }), (e: GifError) => e.code === 'blocked');
  const finalUrl = mk({ fetch: brdFetch(() => ok(gif(), { 'x-brd-final-url': 'https://internal.cz/x.gif' })) });
  await assert.rejects(resolveGif({ url: URL_4PC, mode: 'direct' }, { transport: transportOf({ [URL_4PC]: challenge }), lookupAll, unlocker: finalUrl }), (e: GifError) => e.code === 'blocked');
  // Veřejné přesměrování se sleduje (znovu ověřené) a projde.
  const toPublic = mk({ fetch: brdFetch((t) => (t === URL_4PC ? new Response(null, { status: 200, headers: { 'x-brd-status-code': '301', location: 'https://i.4pcdn.org/b.gif' } }) : ok(gif()))) });
  const r = await resolveGif({ url: URL_4PC, mode: 'direct' }, { transport: transportOf({ [URL_4PC]: challenge, 'https://i.4pcdn.org/b.gif': challenge }), lookupAll, unlocker: toPublic });
  assert.equal(r.sourceUrl, 'https://i.4pcdn.org/b.gif');
});

test('unlocker: stejné kontroly — too_large, HTML (bad_type / bad_magic), chyba cíle, chyba API, timeout', async () => {
  const t = transportOf({ [URL_4PC]: challenge });
  const run = (f: typeof fetch, extra: Partial<UnlockerOptions> = {}, timeoutMs?: number) =>
    resolveGif({ url: URL_4PC, mode: 'direct' }, { transport: t, lookupAll, unlocker: mk({ fetch: f, ...extra }), timeoutMs });
  const code = (c: string) => (e: GifError) => e instanceof GifError && e.code === c;

  const chunk = Buffer.alloc(1024 * 1024);
  await assert.rejects(run(brdFetch(() => ok(Buffer.concat([gif(), ...Array(11).fill(chunk)])))), code('too_large'));
  await assert.rejects(run(brdFetch(() => ok(gif(), { 'content-length': String(GIF_MAX_BYTES + 1) }))), code('too_large'));
  await assert.rejects(run(brdFetch(() => ok('<!doctype html><title>Just a moment</title>', { 'content-type': 'text/html' }))), code('bad_type'));
  await assert.rejects(run(brdFetch(() => ok('<!doctype html><html></html>', { 'content-type': 'application/octet-stream' }))), code('bad_magic'));
  await assert.rejects(run(brdFetch(() => ok('<html>', { 'x-brd-status-code': '403', 'content-type': 'text/html' }))), code('http_403'));
  await assert.rejects(run(brdFetch(() => new Response('x', { status: 502, headers: { 'x-brd-error': 'failed', 'x-brd-error-code': 'captcha_failed' } }))), code('unlocker_captcha_failed'));
  await assert.rejects(run(brdFetch(() => new Response('Unauthorized', { status: 401 }))), code('unlocker_401'));
  // Bez Content-Type od unlockeru rozhodnou magic bytes.
  assert.equal((await run(brdFetch(() => new Response(gif(), { status: 200, headers: { 'x-brd-status-code': '200' } })))).kind, 'gif');

  // Timeout: Bright Data neodpoví → limit fallbacku (ne původní 10 s, ale ani víc než timeoutMs unlockeru).
  const hang = brdFetch((_t, signal) => new Promise<Response>((_r, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))));
  const t0 = Date.now();
  await assert.rejects(run(hang, { timeoutMs: 120 }, 20), code('timeout'));
  const took = Date.now() - t0;
  assert.ok(took >= 100 && took < 2000, `fallback limit ${took} ms`);
  // Tělo, které se zasekne uprostřed čtení.
  const stall = brdFetch((_t, signal) => ok(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(gif())); signal.addEventListener('abort', () => c.error(new Error('aborted'))); },
  }) as unknown as Buffer));
  await assert.rejects(run(stall, { timeoutMs: 80 }, 20), code('timeout'));
});

test('unlocker: denní strop → původní chyba bez volání; reset o půlnoci UTC', async () => {
  let now = Date.parse('2026-09-26T10:00:00Z');
  const calls: Call[] = [];
  const unlocker = mk({ fetch: brdFetch(() => ok(gif()), calls), dailyCap: 2, now: () => now });
  const routes: Record<string, Route> = {};
  for (let i = 0; i < 4; i++) routes[`https://i.4pcdn.org/${i}.gif`] = challenge;
  const t = transportOf(routes);
  const go = (i: number) => resolveGif({ url: `https://i.4pcdn.org/${i}.gif`, mode: 'direct' }, { transport: t, lookupAll, unlocker });
  await go(0); await go(1);
  await assert.rejects(go(2), (e: GifError) => e.code === 'bot_protection');
  assert.equal(calls.length, 2);
  now = Date.parse('2026-09-26T23:59:59Z');
  await assert.rejects(go(2), (e: GifError) => e.code === 'bot_protection');
  now = Date.parse('2026-09-27T00:00:01Z');
  assert.equal((await go(3)).kind, 'gif');
  assert.equal(calls.length, 3);
});

test('unlocker: negativní cache — po selhání stejnou URL 10 min nevolá', async () => {
  let now = Date.parse('2026-09-26T10:00:00Z');
  const calls: Call[] = [];
  let fail = true;
  const unlocker = mk({ fetch: brdFetch(() => (fail ? ok('<html>', { 'content-type': 'text/html' }) : ok(gif())), calls), now: () => now });
  const t = transportOf({ [URL_4PC]: challenge, 'https://i.4pcdn.org/other.gif': challenge });
  const go = (u = URL_4PC) => resolveGif({ url: u, mode: 'direct' }, { transport: t, lookupAll, unlocker });
  await assert.rejects(go(), (e: GifError) => e.code === 'bad_type');
  fail = false;
  await assert.rejects(go(), (e: GifError) => e.code === 'bot_protection'); // z cache: ochrana, bez volání
  assert.equal(calls.length, 1);
  assert.equal((await go('https://i.4pcdn.org/other.gif')).kind, 'gif'); // jiná URL volá
  now += UNLOCKER_NEGATIVE_TTL_MS + 1;
  assert.equal((await go()).kind, 'gif');
  assert.equal(calls.length, 3);

  // Chyba samotného API (502) se cachuje taky.
  const apiCalls: Call[] = [];
  const api = mk({ fetch: brdFetch(() => new Response('x', { status: 502, headers: { 'x-brd-error-code': 'nav_timeout' } }), apiCalls), now: () => now });
  const goApi = () => resolveGif({ url: URL_4PC, mode: 'direct' }, { transport: t, lookupAll, unlocker: api });
  await assert.rejects(goApi(), (e: GifError) => e.code === 'unlocker_nav_timeout');
  await assert.rejects(goApi(), (e: GifError) => e.code === 'bot_protection');
  assert.equal(apiCalls.length, 1);
});

test('unlocker: API klíč se neobjeví v chybě ani v logu', async () => {
  const logs: string[] = [];
  const errors: string[] = [];
  const t = transportOf({ [URL_4PC]: challenge });
  const fetches: Array<typeof fetch> = [
    (async () => { throw new Error(`connect failed Authorization: Bearer ${KEY}`); }) as typeof fetch,
    brdFetch(() => new Response(`invalid key ${KEY}`, { status: 401 })),
    brdFetch(() => new Response('x', { status: 502, headers: { 'x-brd-error': `bad ${KEY}`, 'x-brd-error-code': `${KEY}` } })),
    brdFetch(() => ok('<html>', { 'content-type': 'text/html' })),
    brdFetch(() => ok(gif())),
  ];
  for (const f of fetches) {
    try { await resolveGif({ url: URL_4PC, mode: 'direct' }, { transport: t, lookupAll, unlocker: mk({ fetch: f }, logs) }); }
    catch (e) { errors.push(`${(e as Error).message} ${(e as GifError).code} ${(e as Error).stack}`); }
  }
  assert.equal(errors.length, 4);
  assert.equal(logs.length, 5, logs.join('\n'));
  for (const s of [...errors, ...logs]) {
    assert.ok(!s.includes(KEY), s);
    assert.ok(!/bearer/i.test(s), s);
  }
  // Log nese jen host a výsledek.
  for (const l of logs) assert.match(l, /^gif: unlocker (ok|err) \{"host":"i\.4pcdn\.org"(,"code":"[a-z0-9_-]+")?\}$/i);
});
