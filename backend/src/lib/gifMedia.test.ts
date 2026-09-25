import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import {
  classifyGifUrl, gifCandidate, textWithoutLink, isBlockedIp, assertPublicUrl, sniffKind, mediaSize, pickOgMedia,
  resolveGif, contentTypeOk, GifError, GIF_MAX_BYTES, type Transport, type TransportResponse, type LookupAll,
} from './gifMedia.js';

// ---- vzorky médií ----
const gif = (w = 320, h = 240): Buffer => { const b = Buffer.alloc(32); b.write('GIF89a', 0, 'latin1'); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); return b; };
const webpX = (w: number, h: number): Buffer => { const b = Buffer.alloc(40); b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b.write('VP8X', 12, 'latin1'); b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); return b; };
const mp4 = (w: number, h: number): Buffer => {
  const ftyp = Buffer.alloc(16); ftyp.writeUInt32BE(16, 0); ftyp.write('ftypisom', 4, 'latin1');
  const tkhd = Buffer.alloc(92); tkhd.writeUInt32BE(92, 0); tkhd.write('tkhd', 4, 'latin1'); tkhd.writeUInt32BE(w << 16, 84); tkhd.writeUInt32BE(h << 16, 88);
  return Buffer.concat([ftyp, Buffer.from([0, 0, 0, 8]), Buffer.from('free', 'latin1'), tkhd]);
};

test('classifyGifUrl: stránky Tenor/Giphy/Imgur/7TV, média CDN, přímé soubory, .gifv → .mp4', () => {
  assert.deepEqual(classifyGifUrl('https://tenor.com/view/cat-dance-gif-123'), { url: 'https://tenor.com/view/cat-dance-gif-123', mode: 'page' });
  assert.equal(classifyGifUrl('https://tenor.com/cs/view/cat-gif-1')?.mode, 'page');
  assert.equal(classifyGifUrl('https://tenor.com/pt-BR/view/cat-gif-1')?.mode, 'page');
  assert.equal(classifyGifUrl('https://tenor.com/search/cat'), null);
  assert.equal(classifyGifUrl('https://media1.tenor.com/m/abc/cat.gif')?.mode, 'direct');
  assert.equal(classifyGifUrl('https://media.tenor.com/abcAAAAC/x')?.mode, 'direct');
  assert.equal(classifyGifUrl('https://giphy.com/gifs/cat-abc123')?.mode, 'page');
  assert.equal(classifyGifUrl('https://giphy.com/explore/cat'), null);
  assert.equal(classifyGifUrl('https://media3.giphy.com/media/abc/giphy.gif')?.mode, 'direct');
  assert.equal(classifyGifUrl('https://i.giphy.com/abc.webp')?.mode, 'direct');
  assert.deepEqual(classifyGifUrl('https://i.imgur.com/AbCdE12.gifv'), { url: 'https://i.imgur.com/AbCdE12.mp4', mode: 'direct' });
  assert.equal(classifyGifUrl('https://imgur.com/gallery/AbCdE12')?.mode, 'page');
  assert.equal(classifyGifUrl('https://i.imgur.com/AbCdE12.png'), null);
  assert.deepEqual(classifyGifUrl('https://7tv.app/emotes/01F7JCJ0D80007RBBSW6MHGEVC'), { url: 'https://cdn.7tv.app/emote/01F7JCJ0D80007RBBSW6MHGEVC/4x.webp', mode: 'direct' });
  assert.equal(classifyGifUrl('https://neco.cz/obrazek.GIF?x=1')?.mode, 'direct');
  assert.equal(classifyGifUrl('neco.cz/video.mp4')?.url, 'https://neco.cz/video.mp4');
  assert.equal(classifyGifUrl('https://neco.cz/obrazek.png'), null);
  assert.equal(classifyGifUrl('https://neco.cz/'), null);
  assert.equal(classifyGifUrl('ftp://neco.cz/a.gif'), null);
});

test('gifCandidate: první GIF odkaz ve zprávě (i bez schématu, s interpunkcí), text bez odkazu', () => {
  const c = gifCandidate('koukni tohle: https://tenor.com/view/cat-gif-1. lol');
  assert.equal(c?.url, 'https://tenor.com/view/cat-gif-1');
  assert.equal(c?.token, 'https://tenor.com/view/cat-gif-1.');
  assert.equal(textWithoutLink('koukni tohle: https://tenor.com/view/cat-gif-1. lol', c!.token), 'koukni tohle: lol');
  assert.equal(gifCandidate('ahoj neco.cz/x a giphy.com/gifs/abc-1')?.url, 'https://giphy.com/gifs/abc-1');
  assert.equal(gifCandidate('ahoj seznam.cz'), null);
  assert.equal(gifCandidate('bez odkazu'), null);
});

test('isBlockedIp: privátní, loopback, link-local, CGNAT, mapped IPv6 blokované; veřejné ne', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::a00:1', 'nesmysl']) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '151.101.1.1', '2606:4700::1111', '::ffff:8.8.8.8']) assert.equal(isBlockedIp(ip), false, ip);
});

test('assertPublicUrl: DNS na privátní adresu, IP literál, port, přihlašovací údaje → blocked/bad_url', async () => {
  const dns = (map: Record<string, string[]>): LookupAll => async (h) => (map[h] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  const lookup = dns({ 'ok.cz': ['8.8.8.8'], 'evil.cz': ['8.8.8.8', '10.0.0.5'], 'rebind.cz': ['::ffff:192.168.0.1'] });
  await assertPublicUrl(new URL('https://ok.cz/a.gif'), lookup);
  await assert.rejects(assertPublicUrl(new URL('https://evil.cz/a.gif'), lookup), (e: GifError) => e.code === 'blocked');
  await assert.rejects(assertPublicUrl(new URL('https://rebind.cz/a.gif'), lookup), (e: GifError) => e.code === 'blocked');
  await assert.rejects(assertPublicUrl(new URL('http://127.0.0.1/a.gif'), lookup), (e: GifError) => e.code === 'blocked');
  await assert.rejects(assertPublicUrl(new URL('http://[::1]/a.gif'), lookup), (e: GifError) => e.code === 'blocked');
  await assert.rejects(assertPublicUrl(new URL('https://ok.cz:8080/a.gif'), lookup), (e: GifError) => e.code === 'blocked');
  await assert.rejects(assertPublicUrl(new URL('https://u:p@ok.cz/a.gif'), lookup), (e: GifError) => e.code === 'bad_url');
  await assert.rejects(assertPublicUrl(new URL('https://nic.cz/a.gif'), lookup), (e: GifError) => e.code === 'blocked');
});

test('sniffKind + mediaSize + contentTypeOk', () => {
  assert.equal(sniffKind(gif()), 'gif');
  assert.equal(sniffKind(webpX(10, 20)), 'webp');
  assert.equal(sniffKind(mp4(10, 20)), 'mp4');
  assert.equal(sniffKind(Buffer.from('<!doctype html><html>')), null);
  assert.deepEqual(mediaSize(gif(498, 280), 'gif'), { width: 498, height: 280 });
  assert.deepEqual(mediaSize(webpX(640, 360), 'webp'), { width: 640, height: 360 });
  assert.deepEqual(mediaSize(mp4(480, 270), 'mp4'), { width: 480, height: 270 });
  assert.deepEqual(mediaSize(Buffer.from('GIF89a'), 'gif'), { width: null, height: null });
  assert.equal(contentTypeOk('image/gif', 'gif'), true);
  assert.equal(contentTypeOk('application/octet-stream', 'mp4'), true);
  assert.equal(contentTypeOk('video/mp4', 'gif'), false);
  assert.equal(contentTypeOk('text/html', 'gif'), false);
});

test('pickOgMedia: og:video MP4 přednostně, jinak og:image, entity + relativní URL', () => {
  const base = new URL('https://tenor.com/view/x');
  const html = `<head><meta property="og:image" content="https://media1.tenor.com/a.gif"><meta property="og:video" content="https://media1.tenor.com/a.mp4?x=1&amp;y=2"></head>`;
  assert.equal(pickOgMedia(html, base), 'https://media1.tenor.com/a.mp4?x=1&y=2');
  assert.equal(pickOgMedia(`<meta content="/img/a.gif" property="og:image" />`, base), 'https://tenor.com/img/a.gif');
  assert.equal(pickOgMedia(`<meta property="og:video" content="https://x/a.webm"><meta property="og:image" content="https://x/a.gif">`, base), 'https://x/a.gif');
  assert.equal(pickOgMedia('<title>nic</title>', base), null);
});

// ---- falešný transport ----
type Route = { status?: number; headers?: Record<string, string>; body?: Buffer | Buffer[] };
function fakeTransport(routes: Record<string, Route>, seen: Array<{ url: string; headers: Record<string, string> }> = []): Transport {
  return async (url, headers) => {
    seen.push({ url: url.toString(), headers });
    const r = routes[url.toString()];
    if (!r) return { status: 404, headers: {}, body: (async function* () {})(), dispose() {} } satisfies TransportResponse;
    const chunks = Array.isArray(r.body) ? r.body : r.body ? [r.body] : [];
    return { status: r.status ?? 200, headers: r.headers ?? {}, body: (async function* () { for (const c of chunks) yield c; })(), dispose() {} };
  };
}
const publicDns: LookupAll = async () => [{ address: '8.8.8.8', family: 4 }];

test('resolveGif: Tenor stránka → og:video MP4, médium s Accept image/*,video/*', async () => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const transport = fakeTransport({
    'https://tenor.com/view/cat-gif-1': { headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from('<meta property="og:image" content="https://media1.tenor.com/m/a/cat.gif"><meta property="og:video" content="https://media1.tenor.com/m/a/cat.mp4">') },
    'https://media1.tenor.com/m/a/cat.mp4': { headers: { 'content-type': 'video/mp4' }, body: mp4(498, 280) },
  }, seen);
  const r = await resolveGif({ url: 'https://tenor.com/view/cat-gif-1', mode: 'page' }, { transport, lookupAll: publicDns });
  assert.equal(r.kind, 'mp4');
  assert.equal(r.contentType, 'video/mp4');
  assert.deepEqual([r.width, r.height], [498, 280]);
  assert.equal(seen[1].headers.Accept, 'image/*,video/*');
  assert.match(seen[0].headers.Accept, /text\/html/);
});

test('resolveGif: přímý Tenor GIF, který bez Accept vrací HTML → s Accept čistý GIF; HTML → bad_type', async () => {
  const url = 'https://media1.tenor.com/m/a/cat.gif';
  const accepting: Transport = async (_u, headers) => {
    const img = /image\//.test(headers.Accept);
    return { status: 200, headers: { 'content-type': img ? 'image/gif' : 'text/html' }, body: (async function* () { yield img ? gif(220, 124) : Buffer.from('<html>'); })(), dispose() {} };
  };
  const r = await resolveGif({ url, mode: 'direct' }, { transport: accepting, lookupAll: publicDns });
  assert.deepEqual([r.kind, r.width, r.height], ['gif', 220, 124]);
  const html = fakeTransport({ [url]: { headers: { 'content-type': 'text/html' }, body: Buffer.from('<html>') } });
  await assert.rejects(resolveGif({ url, mode: 'direct' }, { transport: html, lookupAll: publicDns }), (e: GifError) => e.code === 'bad_type');
});

test('resolveGif: limit velikosti (Content-Length i streamem), magic bytes, špatný typ', async () => {
  const url = 'https://x.cz/a.gif';
  const big = fakeTransport({ [url]: { headers: { 'content-type': 'image/gif', 'content-length': String(GIF_MAX_BYTES + 1) }, body: gif() } });
  await assert.rejects(resolveGif({ url, mode: 'direct' }, { transport: big, lookupAll: publicDns }), (e: GifError) => e.code === 'too_large');
  const chunk = Buffer.alloc(1024 * 1024);
  const stream = fakeTransport({ [url]: { headers: { 'content-type': 'image/gif' }, body: [gif(), ...Array(11).fill(chunk)] } });
  await assert.rejects(resolveGif({ url, mode: 'direct' }, { transport: stream, lookupAll: publicDns }), (e: GifError) => e.code === 'too_large');
  const png = fakeTransport({ [url]: { headers: { 'content-type': 'image/gif' }, body: Buffer.from('\x89PNG\r\n\x1a\n0000', 'latin1') } });
  await assert.rejects(resolveGif({ url, mode: 'direct' }, { transport: png, lookupAll: publicDns }), (e: GifError) => e.code === 'bad_magic');
  const wrong = fakeTransport({ [url]: { headers: { 'content-type': 'video/mp4' }, body: gif() } });
  await assert.rejects(resolveGif({ url, mode: 'direct' }, { transport: wrong, lookupAll: publicDns }), (e: GifError) => e.code === 'bad_type');
});

test('resolveGif: přesměrování se znovu ověřuje (na privátní adresu → blocked), max 3', async () => {
  const lookupAll: LookupAll = async (h) => [{ address: h === 'internal.cz' ? '10.0.0.1' : '8.8.8.8', family: 4 }];
  const toInternal = fakeTransport({ 'https://x.cz/a.gif': { status: 302, headers: { location: 'http://internal.cz/secret.gif' } } });
  await assert.rejects(resolveGif({ url: 'https://x.cz/a.gif', mode: 'direct' }, { transport: toInternal, lookupAll }), (e: GifError) => e.code === 'blocked');
  const toMeta = fakeTransport({ 'https://x.cz/a.gif': { status: 301, headers: { location: 'http://169.254.169.254/latest' } } });
  await assert.rejects(resolveGif({ url: 'https://x.cz/a.gif', mode: 'direct' }, { transport: toMeta, lookupAll }), (e: GifError) => e.code === 'blocked');
  const loop = fakeTransport({
    'https://x.cz/1.gif': { status: 302, headers: { location: '/2.gif' } },
    'https://x.cz/2.gif': { status: 302, headers: { location: '/3.gif' } },
    'https://x.cz/3.gif': { status: 302, headers: { location: '/4.gif' } },
    'https://x.cz/4.gif': { status: 302, headers: { location: '/5.gif' } },
  });
  await assert.rejects(resolveGif({ url: 'https://x.cz/1.gif', mode: 'direct' }, { transport: loop, lookupAll }), (e: GifError) => e.code === 'too_many_redirects');
  const ok = fakeTransport({
    'https://x.cz/1.gif': { status: 302, headers: { location: '/2.gif' } },
    'https://x.cz/2.gif': { headers: { 'content-type': 'image/gif' }, body: gif() },
  });
  assert.equal((await resolveGif({ url: 'https://x.cz/1.gif', mode: 'direct' }, { transport: ok, lookupAll })).kind, 'gif');
});

test('resolveGif: stránka bez og médií → no_media; HTTP chyba → http_<status>', async () => {
  const t = fakeTransport({ 'https://giphy.com/gifs/a-1': { headers: { 'content-type': 'text/html' }, body: Buffer.from('<title>x</title>') } });
  await assert.rejects(resolveGif({ url: 'https://giphy.com/gifs/a-1', mode: 'page' }, { transport: t, lookupAll: publicDns }), (e: GifError) => e.code === 'no_media');
  await assert.rejects(resolveGif({ url: 'https://giphy.com/gifs/b-2', mode: 'page' }, { transport: t, lookupAll: publicDns }), (e: GifError) => e.code === 'http_404');
});

// Klient (bublina cooldownu) rozpoznává GIF odkazy kopií v extension/core/gif-links.js — musí dát stejný výsledek.
test('gifCandidate / classifyGifUrl: core/gif-links.js = backend (vědomá kopie)', async () => {
  const corePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../extension/core/gif-links.js');
  if (!existsSync(corePath)) return; // Docker image (jen backend/)
  const core = (await import(pathToFileURL(corePath).href)) as { gifCandidate: typeof gifCandidate; classifyGifUrl: typeof classifyGifUrl; hasGifLink: (t: string) => boolean };
  const texts = [
    'koukni tohle: https://tenor.com/view/cat-gif-1. lol', 'ahoj neco.cz/x a giphy.com/gifs/abc-1', 'ahoj seznam.cz', 'bez odkazu', '',
    'https://media1.tenor.com/m/abc/cat.gif', 'i.imgur.com/AbCdE12.gifv', 'https://7tv.app/emotes/01F7JCJ0D80007RBBSW6MHGEVC', 'neco.cz/video.mp4',
    'https://neco.cz/obrazek.png', 'https://imgur.com/gallery/AbCdE12', '(https://giphy.com/gifs/x-1)', 'ftp://neco.cz/a.gif', 'www.tenor.com/cs/view/a-1',
    'https://tenor.com/search/cat', 'mail@tenor.com', 'https://media3.giphy.com/media/abc/giphy.gif!', '🔥https://i.giphy.com/abc.webp',
  ];
  for (const t of texts) {
    assert.deepEqual(core.gifCandidate(t), gifCandidate(t), t);
    assert.equal(core.hasGifLink(t), gifCandidate(t) !== null, t);
  }
});
