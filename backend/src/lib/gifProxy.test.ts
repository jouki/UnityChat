import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createGifProxy, isProxiedHost, parseCa } from './gifProxy.js';
import { GifError } from './gifMedia.js';

test('isProxiedHost: imgur.com i subdomény, jiné ne', () => {
  assert.equal(isProxiedHost('imgur.com'), true);
  assert.equal(isProxiedHost('i.imgur.com'), true);
  assert.equal(isProxiedHost('M.IMGUR.COM.'), true);
  assert.equal(isProxiedHost('notimgur.com'), false);
  assert.equal(isProxiedHost('tenor.com'), false);
});

test('parseCa: prázdné → undefined, PEM beze změny, base64 PEM se dekóduje, nesmysl → undefined', () => {
  const pem = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----';
  assert.equal(parseCa(''), undefined);
  assert.equal(parseCa(pem), pem);
  assert.equal(parseCa(Buffer.from(pem).toString('base64')), pem);
  assert.equal(parseCa('xyz'), undefined);
});

test('createGifProxy: bez údajů nebo se stropem 0 vypnuto', () => {
  assert.equal(createGifProxy({ customerId: '', zone: 'z', password: 'p', dailyCap: 5 }), null);
  assert.equal(createGifProxy({ customerId: 'c', zone: 'z', password: 'p', dailyCap: 0 }), null);
  const p = createGifProxy({ customerId: 'c', zone: 'z', password: 'p', dailyCap: 5 })!;
  assert.equal(p.transportFor('tenor.com'), null);
  assert.ok(p.transportFor('i.imgur.com'));
});

/** Malá CONNECT proxy: ověří Proxy-Authorization, propojí socket s cílem; zapíše, co viděla. */
function fakeProxy(seen: { auth?: string; target?: string }): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => { res.statusCode = 405; res.end(); });
    srv.on('connect', (req, socket, head) => {
      seen.auth = String(req.headers['proxy-authorization'] || '');
      seen.target = String(req.url);
      if (!seen.auth) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
      const [host, port] = String(req.url).split(':');
      const up = net.connect(Number(port), host, () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) up.write(head);
        up.pipe(socket); socket.pipe(up);
      });
      up.on('error', () => socket.destroy());
    });
    srv.listen(0, '127.0.0.1', () => resolve({ port: (srv.address() as net.AddressInfo).port, close: () => srv.close() }));
  });
}

test('transport: CONNECT tunel přes proxy s přihlášením zóny, naše hlavičky dorazí k cíli, denní strop', async () => {
  const seenTarget: { headers?: http.IncomingHttpHeaders; path?: string } = {};
  const target = http.createServer((req, res) => { seenTarget.headers = req.headers; seenTarget.path = req.url; res.setHeader('content-type', 'image/gif'); res.end(Buffer.from('GIF89a')); });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  const tPort = (target.address() as net.AddressInfo).port;
  const seenProxy: { auth?: string; target?: string } = {};
  const proxy = await fakeProxy(seenProxy);
  const logs: string[] = [];
  const gp = createGifProxy({ customerId: 'hl_abc', zone: 'unlocker', password: 'SECRET-zone-pw', dailyCap: 2, hosts: ['127.0.0.1'], proxyHost: '127.0.0.1', proxyPort: proxy.port, log: (o, m) => logs.push(`${m} ${JSON.stringify(o)}`) });
  assert.ok(gp);
  const tr = gp!.transportFor('127.0.0.1')!;
  const url = new URL(`http://127.0.0.1:${tPort}/auBmmCk.mp4?x=1`);
  const res = await tr(url, { Accept: 'video/mp4', 'User-Agent': 'uc-test' }, new AbortController().signal);
  const chunks: Buffer[] = []; for await (const c of res.body) chunks.push(Buffer.from(c));
  assert.equal(res.status, 200);
  assert.equal(Buffer.concat(chunks).toString('latin1'), 'GIF89a');
  assert.equal(seenProxy.target, `127.0.0.1:${tPort}`);
  assert.equal(seenProxy.auth, 'Basic ' + Buffer.from('brd-customer-hl_abc-zone-unlocker:SECRET-zone-pw').toString('base64'));
  assert.equal(seenTarget.headers?.accept, 'video/mp4');
  assert.equal(seenTarget.headers?.['user-agent'], 'uc-test');
  assert.equal(seenTarget.path, '/auBmmCk.mp4?x=1');
  assert.equal(gp!.usedToday, 1);
  assert.ok(!logs.some((l) => l.includes('SECRET')), 'heslo nikdy do logu');
  // Druhý požadavek projde, třetí narazí na strop.
  (await tr(url, {}, new AbortController().signal)).dispose();
  await assert.rejects(tr(url, {}, new AbortController().signal), (e: GifError) => e.code === 'proxy_cap');
  assert.equal(gp!.usedToday, 2);
  proxy.close(); target.close();
});

test('transport: bez hesla vypnuto; nedostupný cíl za proxy → chyba se propaguje', async () => {
  const seen: { auth?: string } = {};
  const proxy = await fakeProxy(seen);
  const gp = createGifProxy({ customerId: 'c', zone: 'z', password: '', dailyCap: 2, hosts: ['127.0.0.1'], proxyHost: '127.0.0.1', proxyPort: proxy.port });
  assert.equal(gp, null, 'bez hesla vypnuto');
  // S heslem, ale proxy odmítne (simulace: falešná proxy vyžaduje hlavičku — pošleme ji, ale cíl neexistuje → chyba spojení se propaguje)
  const gp2 = createGifProxy({ customerId: 'c', zone: 'z', password: 'p', dailyCap: 2, hosts: ['127.0.0.1'], proxyHost: '127.0.0.1', proxyPort: proxy.port })!;
  await assert.rejects(gp2.transportFor('127.0.0.1')!(new URL('http://127.0.0.1:1/x.gif'), {}, new AbortController().signal));
  proxy.close();
});
