import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGifFlow, createGifNotifier, approvedMessageRow, pendingView, type GifFlowDeps, type GifStore, type NewGifRequest, type GifMediaInfo } from './gifRequests.js';
import type { GifRequest } from '../db/schema.js';
import type { IngestMessage } from '../ingest/types.js';
import { GifError, type ResolvedGif } from './gifMedia.js';
import { toClientMessage } from '../routes/chat.js';

const MEDIA = 'a'.repeat(32);
const quiet = { info() {}, warn() {} };

function memStore(now: () => number) {
  const reqs = new Map<number, GifRequest>();
  const media = new Map<string, GifMediaInfo & { urlNorm: string | null; useCount: number }>();
  const rejections = new Map<string, number>();
  const bans = new Map<string, { until: Date; by: string | null }>();
  const log: string[] = [];
  let seq = 0;
  let mediaSeq = 0;
  let retagOk = true;
  const rk = (ch: string, id: string, pl: string, u: string) => `${ch}|${id}|${pl}|${u}`;
  const livePending = (id: string, at: Date) => [...reqs.values()].filter((r) => r.mediaId === id && r.status === 'pending' && r.expiresAt > at);
  const store: GifStore = {
    async saveMedia(m, meta) {
      const id = mediaSeq++ === 0 ? MEDIA : `${String(mediaSeq).padStart(2, '0')}${'b'.repeat(30)}`;
      media.set(id, { id, channel: meta.channel, status: 'pending', kind: m.kind, width: m.width, height: m.height, sha256: meta.sha256, approvedAt: null, rejectedAt: null, rejectedBy: null, vault: false, urlNorm: meta.sourceUrlNorm, useCount: 0 });
      return id;
    },
    async deleteMedia(id) { media.delete(id); log.push(`deleteMedia:${id}`); },
    async getMedia(id) { return media.get(id) ?? null; },
    async findMedia(channel, by) {
      const order = ['approved', 'rejected', 'pending'];
      return [...media.values()].filter((x) => x.channel === channel && (by.url ? x.urlNorm === by.url : x.sha256 === by.sha256))
        .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))[0] ?? null;
    },
    async setMediaApproved(id, at) { const x = media.get(id); if (x) Object.assign(x, { status: 'approved', approvedAt: x.approvedAt ?? at, rejectedAt: null, rejectedBy: null, vault: false }); },
    async setMediaRejected(id, by, at) { const x = media.get(id); if (x && x.status !== 'approved') Object.assign(x, { status: 'rejected', rejectedAt: at, rejectedBy: by }); },
    async markMediaUsed(id) { const x = media.get(id); if (x) x.useCount++; },
    async rejectionCount(ch, id, pl, u) { return rejections.get(rk(ch, id, pl, u)) ?? 0; },
    async addRejection(ch, id, pl, u) { const n = (rejections.get(rk(ch, id, pl, u)) ?? 0) + 1; rejections.set(rk(ch, id, pl, u), n); return n; },
    async activeBan(ch, id, at) { const b = bans.get(`${ch}|${id}`); return b && b.until > at ? b : null; },
    async setBan(ch, id, until, by) { bans.set(`${ch}|${id}`, { until, by }); },
    async pendingForMedia(id, at) { return livePending(id, at); },
    async listRejected(ch, before, limit) {
      return [...media.values()].filter((x) => x.channel === ch && x.status === 'rejected' && (!before || x.rejectedAt! < before))
        .sort((a, b) => b.rejectedAt!.getTime() - a.rejectedAt!.getTime()).slice(0, limit);
    },
    async setVault(id, v) { const x = media.get(id); if (x) x.vault = v; },
    async retentionDue(before, at) {
      const out: string[] = [];
      for (const x of [...media.values()]) {
        if (x.status === 'rejected' && !x.vault && x.rejectedAt! < before && !livePending(x.id, at).length) { media.delete(x.id); out.push(x.id); }
      }
      return out;
    },
    async insertRequest(v: NewGifRequest) {
      const r = { ...v, id: ++seq, status: 'pending', decidedBy: null, decidedAt: null, createdAt: new Date(now()) } as unknown as GifRequest;
      reqs.set(r.id, r); return r;
    },
    async decide(id, status, by, at) {
      await new Promise((r) => setImmediate(r)); // souběh: oba požadavky dojdou až sem
      const r = reqs.get(id);
      if (!r || r.status !== 'pending' || r.expiresAt.getTime() <= at.getTime()) return null;
      Object.assign(r, { status, decidedBy: by, decidedAt: at });
      return r;
    },
    async get(id) { return reqs.get(id) ?? null; },
    async expireDue(at) {
      const out: GifRequest[] = [];
      for (const r of reqs.values()) if (r.status === 'pending' && r.expiresAt.getTime() <= at.getTime()) { r.status = 'expired'; out.push(r); }
      return out;
    },
    async listPending(at, channel) {
      return [...reqs.values()].filter((r) => r.status === 'pending' && r.expiresAt > at && !(r.meta as Record<string, unknown>)?.auto && !(r.meta as Record<string, unknown>)?.instant && (channel === undefined || r.channel === channel))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id);
    },
    async markDeletedByMessage(messageId) { const r = reqs.get(Number(messageId.slice(4))); if (r?.status === 'approved') { r.status = 'deleted'; return r; } return null; },
    async insertApprovedMessage(r, at) { log.push(`message:${r.id}`); return toClientMessage(approvedMessageRow(r, at), false); },
    async retagDeleted(_p, id, from, to) { log.push(`retag:${id}:${from}->${to}`); return retagOk; },
    async statusByMessage(_p, id) { const r = [...reqs.values()].reverse().find((x) => x.messageId === id); return (r?.status as never) ?? null; },
  };
  return { store, reqs, media, rejections, bans, log, setRetag: (v: boolean) => { retagOk = v; } };
}

const resolved: ResolvedGif = { bytes: Buffer.from('GIF89a'), kind: 'gif', contentType: 'image/gif', width: 320, height: 240, sourceUrl: 'https://media.tenor.com/x.gif' };

function setup(over: Partial<GifFlowDeps> = {}) {
  let t = 1_000_000;
  const mem = memStore(() => t);
  const calls: Array<[string, unknown]> = [];
  const deps: GifFlowDeps = {
    store: mem.store,
    resolve: async () => resolved,
    access: async () => ({ allowed: true, until: null, cooldownUntil: null, cooldownSec: 60, requestTtlSec: 120 }),
    used: async (p) => { calls.push(['used', p]); },
    publishDeleted: async (p) => { calls.push(['publishDeleted', p]); },
    deletePlatform: async (p) => { calls.push(['deletePlatform', p]); return 'bot'; },
    restore: async (p) => { calls.push(['restore', p]); return 'ok'; },
    broadcast: (e, d) => { calls.push([`broadcast:${e}`, d]); },
    publishChat: (ch, pl, msg) => { calls.push(['publishChat', { ch, pl, msg }]); },
    notify: async (_r, e, d) => { calls.push([`notify:${e}`, d]); },
    integration: (ev) => { calls.push([`integration:${ev.type}`, ev]); },
    now: () => t,
    sleep: async () => {},
    log: quiet,
    ...over,
  };
  return { flow: createGifFlow(deps), mem, calls, advance: (ms: number) => { t += ms; }, now: () => t };
}

const msg = (over: Partial<IngestMessage> = {}): IngestMessage => ({
  platform: 'twitch', platformMessageId: 'm1', platformUserId: '42', username: 'Divak', channel: 'robdiesalot',
  content: 'hele https://tenor.com/view/cat-gif-1 lol', contentRaw: { color: '#ff0000', badges: 'subscriber/1' },
  sentAt: new Date(1_000_000 - 500), isUnitychatUser: false, isReply: false, replyToMessageId: null, ...over,
});
const params = (over: Record<string, unknown> = {}) => ({
  m: msg(), ucChannel: 'robdiesalot', workspace: 'rob',
  candidate: { url: 'https://tenor.com/view/cat-gif-1', mode: 'page' as const, token: 'https://tenor.com/view/cat-gif-1' },
  query: { workspace: 'rob', platform: 'twitch' as const, userId: '42', login: 'divak', role: 'sub' as const },
  preDeleted: 'gif_request' as const, needAccess: false, filterAct: null, ...over,
});
const names = (calls: Array<[string, unknown]>) => calls.map((c) => c[0]);

test('intercept: přístup z cache → původní zpráva hned pryč v UC, pak platforma, žádost + gif-pending jen soukromě', async () => {
  const { flow, mem, calls, now } = setup();
  assert.equal(await flow.intercept(params()), 'requested');
  assert.deepEqual(names(calls), ['publishDeleted', 'deletePlatform', 'notify:gif-pending', 'integration:gif.pending']);
  assert.deepEqual(calls[0][1], { channel: 'robdiesalot', platform: 'twitch', messageId: 'm1', by: 'filter', reason: 'gif_request' });
  const r = mem.reqs.get(1)!;
  assert.equal(r.textWithoutLink, 'hele lol');
  assert.equal(r.expiresAt.getTime(), now() + 120_000);
  assert.deepEqual(r.meta, { displayName: 'Divak', sentAt: 1_000_000 - 500, color: '#ff0000', badges: 'subscriber/1' });
  const pending = calls[2][1] as Record<string, unknown>;
  assert.equal(pending.requestId, 1);
  assert.deepEqual(pending.media, { url: `http://localhost:3000/media/gif/${MEDIA}`, kind: 'gif', width: 320, height: 240 });
  assert.equal(names(calls).includes('broadcast:gif-pending'), false, 'pending nikdy veřejně');
  // Druhý GIF téhož uživatele, dokud žádost čeká → rezervace neprojde.
  assert.equal(flow.tryReserve('robdiesalot', 'twitch', '42'), false);
  assert.equal(flow.tryReserve('robdiesalot', 'twitch', '43'), true);
});

test('intercept: převod selže → filtr by smazal = přeznačit na link_filter + akce filtru; jinak obnovit v UC', async () => {
  const fail = { resolve: async () => { throw new GifError('no_media'); } };
  const a = setup(fail);
  let acted = 0;
  assert.equal(await a.flow.intercept(params({ filterAct: async () => { acted++; } })), 'failed');
  assert.equal(acted, 1);
  assert.deepEqual(a.mem.log, ['retag:m1:gif_request->link_filter']);
  assert.equal(names(a.calls).includes('deletePlatform'), false);
  assert.equal(a.flow.tryReserve('robdiesalot', 'twitch', '42'), true, 'rezervace uvolněna');

  const b = setup(fail);
  assert.equal(await b.flow.intercept(params()), 'failed');
  assert.deepEqual(names(b.calls), ['publishDeleted', 'restore']);
  assert.equal(b.mem.reqs.size, 0);
});

test('intercept: neznámý přístup → ověřit; neodemčeno = nic se nestane; zobrazená zpráva se po úspěchu smaže zpětně', async () => {
  const denied = setup({ access: async () => ({ allowed: false, until: null, cooldownUntil: null, cooldownSec: 0, requestTtlSec: 300 }) });
  assert.equal(await denied.flow.intercept(params({ preDeleted: null, needAccess: true })), 'denied');
  assert.deepEqual(denied.calls, []);

  const ok = setup();
  assert.equal(await ok.flow.intercept(params({ preDeleted: null, needAccess: true })), 'requested');
  assert.deepEqual(names(ok.calls).slice(0, 2), ['publishDeleted', 'deletePlatform']);

  // Filtr ji už smazal (link_filter) → jen přeznačit, platformu mazal filtr.
  const lf = setup();
  assert.equal(await lf.flow.intercept(params({ preDeleted: 'link_filter', needAccess: true })), 'requested');
  assert.deepEqual(lf.mem.log, ['retag:m1:link_filter->gif_request']);
  assert.equal(names(lf.calls).includes('deletePlatform'), false);
  assert.equal(names(lf.calls).includes('publishDeleted'), false);
});

test('decide: první rozhodnutí vyhrává (souběh dvou modů), druhý 409 already_decided', async () => {
  const { flow, calls } = setup();
  await flow.intercept(params());
  calls.length = 0;
  const [a, b] = await Promise.all([
    flow.decide({ requestId: 1, approve: true, by: 'twitch:moda', accountId: 1 }),
    flow.decide({ requestId: 1, approve: false, by: 'kick:modb', accountId: 2 }),
  ]);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, { ok: true, requestId: 1, status: 'approved' });
  assert.equal(b.status, 409);
  assert.deepEqual(b.body, { ok: false, error: 'already_decided', status: 'approved', decidedBy: 'twitch:moda' });
  assert.equal((await flow.decide({ requestId: 99, approve: true, by: 'x', accountId: 1 })).status, 404);
  // Schváleno: veřejná zpráva s GIFem + /chat/stream + cooldown + soukromé gif-decided.
  const pub = calls.find((c) => c[0] === 'broadcast:gif-message')![1] as { channel: string; message: Record<string, unknown> };
  assert.equal(pub.channel, 'robdiesalot');
  assert.equal(pub.message.id, 'gif-1');
  assert.equal(pub.message.message, 'hele lol');
  assert.equal(pub.message.username, 'Divak');
  assert.equal(pub.message.badgesRaw, 'subscriber/1');
  assert.deepEqual(pub.message.gif, { url: `http://localhost:3000/media/gif/${MEDIA}`, kind: 'gif', width: 320, height: 240 });
  // GIF knihovna 2026-09-26: na konci chatu = čas schválení; původní zpráva jen k párování (gifOrigin), bez replaces.
  assert.equal(pub.message.timestamp, 1_000_000);
  assert.equal(pub.message.replaces, undefined);
  assert.equal(pub.message.gifOrigin, 'twitch:m1');
  assert.equal(names(calls).includes('broadcast:message-deleted'), false, 'schválení původní zprávu neukazuje jako smazanou');
  assert.equal(names(calls).filter((n) => n === 'publishChat').length, 1);
  assert.deepEqual(calls.find((c) => c[0] === 'used')![1], { workspace: 'rob', platform: 'twitch', userId: '42' });
  assert.deepEqual(calls.find((c) => c[0] === 'notify:gif-decided')![1], { requestId: 1, channel: 'robdiesalot', approved: true, status: 'approved', by: 'twitch:moda' });
  assert.equal(flow.tryReserve('robdiesalot', 'twitch', '42'), true, 'po rozhodnutí smí poslat další');
});

test('decide: zamítnutí = médium zůstává jako zamítnuté (retence, token), bez GIFu; původní zpráva → gif_rejected; propadlá → 409 expired', async () => {
  const s = setup();
  await s.flow.intercept(params());
  s.calls.length = 0;
  assert.equal((await s.flow.decide({ requestId: 1, approve: false, by: 'twitch:moda', accountId: 1 })).status, 200);
  assert.deepEqual(s.mem.log, ['retag:m1:gif_request->gif_rejected']);
  const md = s.mem.media.get(MEDIA)!;
  assert.deepEqual([md.status, md.rejectedAt?.getTime(), md.rejectedBy], ['rejected', 1_000_000, 'twitch:moda']);
  assert.equal(s.mem.rejections.get(`robdiesalot|${MEDIA}|twitch|42`), 1);
  assert.equal(names(s.calls).some((n) => n === 'broadcast:gif-message' || n === 'publishChat' || n === 'used'), false);
  assert.deepEqual(s.calls.find((c) => c[0] === 'broadcast:message-deleted')![1], { channel: 'robdiesalot', platform: 'twitch', messageId: 'm1', by: 'twitch:moda', reason: 'gif_rejected', at: 1_000_000 });
  assert.equal((s.calls.find((c) => c[0] === 'notify:gif-decided')![1] as { approved: boolean }).approved, false);

  const e = setup();
  await e.flow.intercept(params());
  e.advance(121_000);
  assert.deepEqual((await e.flow.decide({ requestId: 1, approve: true, by: 'twitch:moda', accountId: 1 })).body, { ok: false, error: 'already_decided', status: 'expired', decidedBy: null });
});

test('expireTick: propadlé → expired, médium pryč, gif-decided (expired) modům + odesílateli', async () => {
  const s = setup();
  await s.flow.intercept(params());
  s.calls.length = 0;
  assert.equal(await s.flow.expireTick(), 0);
  s.advance(120_000);
  assert.equal(await s.flow.expireTick(), 1);
  assert.equal(s.mem.reqs.get(1)!.status, 'expired');
  assert.deepEqual(s.mem.log, [`deleteMedia:${MEDIA}`, 'retag:m1:gif_request->gif_rejected']);
  assert.equal((s.calls.find((c) => c[0] === 'broadcast:message-deleted')![1] as { reason: string; by: string }).reason, 'gif_rejected');
  assert.deepEqual(s.calls.find((c) => c[0] === 'notify:gif-decided')![1], { requestId: 1, channel: 'robdiesalot', approved: false, status: 'expired', by: null });
  assert.equal((s.calls.find((c) => c[0] === 'integration:gif.decided')![1] as { status: string }).status, 'expired');
  assert.equal(s.flow.tryReserve('robdiesalot', 'twitch', '42'), true);
});

test('notifier: odesílatel (own) + jen mody kanálu mezi připojenými účty, stav moda z cache', async () => {
  const sent: Array<[number, string, object]> = [];
  let modChecks = 0;
  const n = createGifNotifier({
    connected: () => [1, 2, 3, 7],
    isMod: async (acc, ch) => { modChecks++; return ch === 'robdiesalot' && (acc === 2 || acc === 7); },
    senderAccount: async () => 7,
    send: (acc, e, d) => { sent.push([acc, e, d]); return 1; },
  });
  const r = { channel: 'robdiesalot', platform: 'twitch', userId: '42' };
  assert.deepEqual(await n.notify(r, 'gif-pending', { requestId: 1 }), [7, 2]);
  assert.deepEqual(sent, [[7, 'gif-pending', { requestId: 1, own: true }], [2, 'gif-pending', { requestId: 1 }]]);
  await n.notify(r, 'gif-decided', { requestId: 1 });
  assert.equal(modChecks, 3, 'mod stav z cache (účty 1, 2, 3)');
});

test('intercept: mod rozhodne dřív, než se nastaví zámek (bod 2) → zámek nevisí a gif-pending se nepošle', async () => {
  const s = setup();
  const orig = s.mem.store.insertRequest.bind(s.mem.store);
  s.mem.store.insertRequest = async (v) => {
    const r = await orig(v);
    // Mod žádost uvidí v GET /moderation/gif/pending hned po insertu a zamítne ji dřív, než intercept pokračuje.
    await s.flow.decide({ requestId: r.id, approve: false, by: 'twitch:moda', accountId: 1 });
    return r;
  };
  assert.equal(await s.flow.intercept(params()), 'requested');
  assert.equal(s.flow._pendingSize(), 0);
  assert.equal(s.flow.tryReserve('robdiesalot', 'twitch', '42'), true, 'uživatel může poslat další GIF');
  assert.equal(names(s.calls).includes('notify:gif-pending'), false);
  assert.equal(names(s.calls).includes('notify:gif-decided'), true);
});

test('intercept: zámek platí hned po vzniku žádosti, ještě během mazání na platformě (bod 2)', async () => {
  let lockedDuringDelete: boolean | null = null;
  const s = setup({ deletePlatform: async () => { lockedDuringDelete = s.flow._pendingSize() === 1; return 'bot'; } });
  await s.flow.intercept(params());
  assert.equal(lockedDuringDelete, true);
});

test('intercept: zprávu smazanou filtrem mezitím obnovil permit (bod 6) → žádost ani médium nevzniknou', async () => {
  const s = setup();
  s.mem.setRetag(false);
  assert.equal(await s.flow.intercept(params({ preDeleted: 'link_filter', needAccess: true })), 'cancelled');
  assert.equal(s.mem.reqs.size, 0);
  assert.equal(s.mem.media.size, 0);
  assert.equal(names(s.calls).some((n) => n === 'notify:gif-pending' || n === 'deletePlatform'), false);
  assert.equal(s.flow.tryReserve('robdiesalot', 'twitch', '42'), true);
});

test('intercept: text nad GIFem bez odkazů, které by filtr zablokoval (bod 5)', async () => {
  const s = setup();
  await s.flow.intercept(params({ m: msg({ content: 'hele https://tenor.com/view/cat-gif-1 a evil.cz/x a youtu.be/abc' }), linkBlocked: (h: string) => h !== 'youtu.be' }));
  assert.equal(s.mem.reqs.get(1)!.textWithoutLink, 'hele a a youtu.be/abc');
});

test('decide: zápis do archivu selže i napodruhé → nic se nerozešle, cooldown ano (bod 8); médium se předehřeje před rozesláním', async () => {
  const s = setup({ mediaApproved: async () => { s.calls.push(['warm', null]); } });
  await s.flow.intercept(params());
  let tries = 0;
  s.mem.store.insertApprovedMessage = async () => { tries++; throw new Error('db down'); };
  s.calls.length = 0;
  const out = await s.flow.decide({ requestId: 1, approve: true, by: 'twitch:moda', accountId: 1 });
  assert.deepEqual(out.body, { ok: true, requestId: 1, status: 'approved', published: false });
  assert.equal(tries, 2);
  // Původní zpráva nezůstane navždy schovaná: gif_request → gif_rejected + message-deleted.
  assert.ok(s.mem.log.includes('retag:m1:gif_request->gif_rejected'), s.mem.log.join(' | '));
  assert.deepEqual(s.calls.find((c) => c[0] === 'broadcast:message-deleted')![1], { channel: 'robdiesalot', platform: 'twitch', messageId: 'm1', by: 'twitch:moda', reason: 'gif_rejected', at: 1_000_000 });
  assert.equal(names(s.calls).some((n) => n === 'broadcast:gif-message' || n === 'publishChat' || n === 'warm'), false);
  assert.equal(names(s.calls).includes('used'), true);

  const ok = setup({ mediaApproved: async () => { ok.calls.push(['warm', null]); } });
  await ok.flow.intercept(params());
  ok.calls.length = 0;
  await ok.flow.decide({ requestId: 1, approve: true, by: 'twitch:moda', accountId: 1 });
  const n = names(ok.calls);
  assert.ok(n.indexOf('warm') >= 0 && n.indexOf('warm') < n.indexOf('broadcast:gif-message'), 'předehřátí před rozesláním');
});

test('intercept: smazáno filtrem, přeznačení uspěje, pak selže uložení média / žádosti → zpět na link_filter (permit ji obnoví)', async () => {
  for (const broken of ['saveMedia', 'insertRequest'] as const) {
    const s = setup();
    s.mem.store[broken] = async () => { throw new Error('db down'); };
    assert.equal(await s.flow.intercept(params({ preDeleted: 'link_filter', needAccess: true })), 'failed');
    assert.deepEqual(s.mem.log.filter((l) => l.startsWith('retag:')), ['retag:m1:link_filter->gif_request', 'retag:m1:gif_request->link_filter'], broken);
    assert.equal(s.mem.reqs.size, 0);
    assert.equal(s.flow.tryReserve('robdiesalot', 'twitch', '42'), true);
  }
});

test('intercept auto (mod): schváleno hned, bez gif-used, bez karet; GIF na konci chatu', async () => {
  let accessCalls = 0;
  const s = setup({ access: async () => { accessCalls++; return null; } });
  assert.equal(await s.flow.intercept(params({ auto: true, query: { workspace: 'rob', platform: 'twitch', userId: '42', login: 'moda', role: 'moderator' } })), 'approved');
  assert.equal(accessCalls, 1, 'Židolišta jen kvůli režimu odměny; null = mod má povoleno (režim all)');
  const n = names(s.calls);
  assert.deepEqual(n.filter((x) => x.startsWith('notify:') || x.startsWith('integration:')), [], 'nikdo nic neschvaluje');
  assert.equal(n.includes('used'), false, 'mod bez cooldownu');
  assert.ok(n.indexOf('deletePlatform') > n.indexOf('broadcast:gif-message'), 'původní zpráva pryč i z platformy (až po schválení)');
  const pub = s.calls.find((c) => c[0] === 'broadcast:gif-message')![1] as { message: Record<string, unknown> };
  assert.equal(pub.message.gifOrigin, 'twitch:m1');
  assert.equal(pub.message.timestamp, 1_000_000, 'čas schválení');
  assert.equal(s.mem.media.get(MEDIA)!.status, 'approved');
  const r = s.mem.reqs.get(1)!;
  assert.equal(r.status, 'approved');
  assert.equal(r.decidedBy, 'twitch:divak', 'by = on sám');
  assert.equal(s.flow._pendingSize(), 0);
  assert.equal(s.flow.tryReserve('robdiesalot', 'twitch', '42'), true);
});

test('intercept auto + pozdní hlášení Dev módu (gifReview po echu) → běžná žádost ke schválení (jako divák)', async () => {
  const s = setup();
  assert.equal(await s.flow.intercept(params({ auto: true, lateReview: () => true })), 'requested');
  assert.deepEqual(names(s.calls), ['publishDeleted', 'deletePlatform', 'notify:gif-pending', 'integration:gif.pending']);
  assert.equal(s.mem.reqs.get(1)!.status, 'pending');
  await s.flow.decide({ requestId: 1, approve: true, by: 'twitch:modb', accountId: 2 });
  assert.equal(names(s.calls).includes('used'), true, 'jako divák: cooldown platí');
});

test('intercept auto: převod selže → původní zpráva se v UC obnoví (mod filtr nemá)', async () => {
  const s = setup({ resolve: async () => { throw new GifError('no_media'); } });
  assert.equal(await s.flow.intercept(params({ auto: true })), 'failed');
  assert.deepEqual(names(s.calls), ['publishDeleted', 'restore']);
});

test('intercept auto: schválení hned po insertu, před mazáním na platformě; auto žádost není v listPending (jiný mod ji nevidí)', async () => {
  let seenByOtherMod: unknown[] | null = null;
  let statusAtDelete: string | null = null;
  const s = setup({
    deletePlatform: async () => { statusAtDelete = s.mem.reqs.get(1)!.status; s.calls.push(['deletePlatform', null]); return 'bot'; },
  });
  const orig = s.mem.store.insertRequest.bind(s.mem.store);
  s.mem.store.insertRequest = async (v) => {
    const r = await orig(v);
    // Jiný mod v tu chvíli otevře GET /moderation/gif/pending.
    seenByOtherMod = await s.mem.store.listPending(new Date(s.now()), 'robdiesalot');
    return r;
  };
  assert.equal(await s.flow.intercept(params({ auto: true })), 'approved');
  assert.deepEqual(seenByOtherMod, [], 'auto žádost se v pending neukáže');
  assert.equal(statusAtDelete, 'approved', 'na platformě se maže až po schválení');
  const n = names(s.calls);
  assert.ok(n.indexOf('broadcast:gif-message') < n.indexOf('deletePlatform'), n.join(','));
  assert.deepEqual((s.mem.reqs.get(1)!.meta as Record<string, unknown>).auto, true);
  // Běžná (neauto) žádost v pending je.
  const b = setup();
  await b.flow.intercept(params());
  assert.equal((await b.mem.store.listPending(new Date(b.now()))).length, 1);
});

// ---- Převod selže: klienti VŽDY dostanou rozhodnutí (živě 2026-09-26: mod, 4chan CDN → http_403) ----

test('převod selže, řádek ještě není v archivu (restore not_found) → message-restored s celou zprávou ze `m`, smazání pryč z paměti, archiv se dorovná', async () => {
  const restores: unknown[] = [];
  const s = setup({
    resolve: async () => { throw new GifError('http_403'); },
    restore: async (p) => { restores.push(p); s.calls.push(['restore', p]); return restores.length === 1 ? 'not_found' : 'ok'; },
    forgetDeleted: (pl, id) => { s.calls.push(['forget', `${pl}:${id}`]); },
  });
  const m = msg({ content: 'https://i.4pcdn.org/pol/1562850136932.gif', deleted: { by: 'filter', reason: 'gif_request' } });
  assert.equal(await s.flow.intercept(params({ m, auto: true })), 'failed');
  assert.equal(m.deleted, undefined, 'nezapsaná dávka půjde do archivu jako viditelná');
  const ev = s.calls.find((c) => c[0] === 'broadcast:message-restored')?.[1] as Record<string, unknown>;
  assert.ok(ev, names(s.calls).join(','));
  assert.equal(ev.channel, 'robdiesalot');
  assert.equal(ev.messageId, 'm1');
  const cm = ev.message as Record<string, unknown>;
  assert.equal(cm.message, 'https://i.4pcdn.org/pol/1562850136932.gif');
  assert.equal(cm.deleted, undefined);
  assert.equal(cm.id, 'm1');
  assert.ok(names(s.calls).includes('forget'));
  await s.flow._idle();
  assert.equal(restores.length, 2, 'druhý pokus o obnovení v archivu');
  assert.equal(s.flow.isInFlight('twitch', 'm1'), false);
});

test('převod selže, restore vyhodí (DB) → message-restored ze zprávy i tak', async () => {
  const s = setup({ resolve: async () => { throw new GifError('http_403'); }, restore: async () => { throw new Error('db down'); } });
  assert.equal(await s.flow.intercept(params()), 'failed');
  assert.ok(names(s.calls).includes('broadcast:message-restored'));
  await s.flow._idle();
});

test('převod selže, restore ok → message-restored posílá publishRestored (flow už ne), bez druhého pokusu', async () => {
  let n = 0;
  const s = setup({ resolve: async () => { throw new GifError('http_403'); }, restore: async () => { n++; return 'ok'; } });
  await s.flow.intercept(params());
  await s.flow._idle();
  assert.equal(n, 1);
  assert.equal(names(s.calls).includes('broadcast:message-restored'), false);
});

test('převod selže, filtr by smazal → link_filter v paměti i archivu, dedup smazání zapomenut PŘED akcí filtru (jinak by message-deleted link_filter spolkl)', async () => {
  const order: string[] = [];
  const s = setup({ resolve: async () => { throw new GifError('http_403'); }, forgetDeleted: () => { order.push('forget'); } });
  const m = msg({ deleted: { by: 'filter', reason: 'gif_request' } });
  assert.equal(await s.flow.intercept(params({ m, filterAct: async () => { order.push('filter'); } })), 'failed');
  assert.deepEqual(m.deleted, { by: 'filter', reason: 'link_filter' });
  assert.deepEqual(order, ['forget', 'filter']);
  await s.flow._idle();
  assert.deepEqual(s.mem.log, ['retag:m1:gif_request->link_filter', 'retag:m1:gif_request->link_filter'], 'archiv se dorovná i po souběžném zápisu dávky');
  assert.equal(names(s.calls).includes('restore'), false);
});

test('zachycení spadne výjimkou (bez žádosti) → schovaná zpráva se i tak obnoví', async () => {
  const s = setup({ sleep: async () => { throw new Error('boom'); } });
  assert.equal(await s.flow.intercept(params()), 'failed');
  assert.deepEqual(names(s.calls), ['publishDeleted', 'restore']);
});

test('isInFlight: během zachycení true, po něm false', async () => {
  let during = false;
  const s = setup({ resolve: async () => { during = s.flow.isInFlight('twitch', 'm1'); return resolved; } });
  await s.flow.intercept(params());
  assert.equal(during, true);
  assert.equal(s.flow.isInFlight('twitch', 'm1'), false);
});

// ---- GIF knihovna 2026-09-26: dedup, opakovaně zamítnuté, režim approved, FIFO, průběh, retence ----

const TENOR = 'https://tenor.com/view/cat-gif-1';
/** Zpráva od jiného uživatele (userId, messageId) s odkazem `url`. */
const from = (userId: string, messageId: string, url = TENOR, over: Record<string, unknown> = {}) => params({
  m: msg({ platformUserId: userId, platformMessageId: messageId, username: `U${userId}`, content: `hele ${url}` }),
  candidate: { url, mode: 'page' as const, token: url },
  query: { workspace: 'rob', platform: 'twitch' as const, userId, login: `u${userId}`, role: 'sub' as const },
  ...over,
});
const events = (calls: Array<[string, unknown]>, name: string) => calls.filter((c) => c[0] === name).map((c) => c[1] as Record<string, unknown>);

test('dedup URL: schválený GIF (i s utm/fragmentem) → rovnou gif-message bez žádosti a bez stahování, use_count++, cooldown platí', async () => {
  let resolves = 0;
  const s = setup({ resolve: async () => { resolves++; return resolved; } });
  await s.flow.intercept(from('42', 'm1'));
  await s.flow.decide({ requestId: 1, approve: true, by: 'twitch:moda', accountId: 1 });
  s.calls.length = 0;
  assert.equal(await s.flow.intercept(from('43', 'm2', `${TENOR}?utm_source=x#a`)), 'approved');
  assert.equal(resolves, 1, 'podruhé se nestahuje');
  const n = names(s.calls);
  assert.equal(n.includes('notify:gif-pending'), false, 'bez schvalování');
  assert.equal(n.includes('notify:gif-decided'), false);
  const pub = events(s.calls, 'broadcast:gif-message')[0];
  assert.equal((pub.message as Record<string, unknown>).gifOrigin, 'twitch:m2');
  assert.deepEqual((pub.message as Record<string, unknown>).gif, { url: `http://localhost:3000/media/gif/${MEDIA}`, kind: 'gif', width: 320, height: 240 });
  assert.deepEqual(events(s.calls, 'used')[0], { workspace: 'rob', platform: 'twitch', userId: '43' }, 'divák: cooldown');
  assert.equal(s.mem.media.size, 1);
  assert.equal(s.mem.media.get(MEDIA)!.useCount, 2);
  assert.equal(s.mem.reqs.get(2)!.status, 'approved');
  assert.ok(n.includes('deletePlatform'), 'původní zpráva s odkazem pryč z platformy');
  assert.equal(s.flow.tryReserve('robdiesalot', 'twitch', '43'), true);
});

test('dedup sha256: jiná URL na stejný soubor → po stažení se použije naše verze (médium se neukládá znovu)', async () => {
  const s = setup();
  await s.flow.intercept(from('42', 'm1'));
  await s.flow.decide({ requestId: 1, approve: true, by: 'twitch:moda', accountId: 1 });
  assert.equal(await s.flow.intercept(from('43', 'm2', 'https://media1.tenor.com/m/xyz/jina.gif')), 'approved');
  assert.equal(s.mem.media.size, 1);
  assert.equal(s.mem.reqs.get(2)!.mediaId, MEDIA);
  // Čekající médium (ještě nerozhodnuté) → další žádost na stejné médium, bez nového uložení.
  const p = setup();
  await p.flow.intercept(from('42', 'm1'));
  assert.equal(await p.flow.intercept(from('43', 'm2', 'https://media1.tenor.com/m/xyz/jina.gif')), 'requested');
  assert.equal(p.mem.media.size, 1);
  assert.equal(p.mem.reqs.get(2)!.mediaId, MEDIA);
});

test('schválení jednoho = schválení i ostatních čekajících žádostí na stejné médium (bez nového schvalování)', async () => {
  const s = setup();
  await s.flow.intercept(from('42', 'm1'));
  await s.flow.intercept(from('43', 'm2'));
  s.calls.length = 0;
  await s.flow.decide({ requestId: 1, approve: true, by: 'twitch:moda', accountId: 1 });
  assert.equal(s.mem.reqs.get(2)!.status, 'approved');
  assert.equal(s.mem.reqs.get(2)!.decidedBy, 'twitch:moda');
  assert.deepEqual(events(s.calls, 'broadcast:gif-message').map((e) => e.requestId), [1, 2]);
});

test('opakovaně zamítnutý GIF: 1. zamítne mod, 2. znovu ke schválení (previouslyRejected), 3. a další automaticky + zpráva smazána', async () => {
  const told: Array<[string, Record<string, unknown>]> = [];
  const s = setup({ toSender: async () => (e: string, d: object) => { told.push([e, d as Record<string, unknown>]); } });
  await s.flow.intercept(from('42', 'm1'));
  await s.flow.decide({ requestId: 1, approve: false, by: 'twitch:moda', accountId: 1 });
  s.advance(1000);
  assert.equal(await s.flow.intercept(from('42', 'm2')), 'requested');
  assert.deepEqual((s.mem.reqs.get(2)!.meta as Record<string, unknown>).previouslyRejected, { at: 1_000_000, by: 'twitch:moda' });
  await s.flow.decide({ requestId: 2, approve: false, by: 'twitch:modb', accountId: 2 });
  s.calls.length = 0;
  told.length = 0;
  s.mem.store.saveMedia = async () => { throw new Error('nesmí se ukládat'); };
  assert.equal(await s.flow.intercept(from('42', 'm3')), 'rejected');
  assert.equal(s.mem.reqs.size, 2, 'žádná žádost');
  assert.equal(s.mem.rejections.get(`robdiesalot|${MEDIA}|twitch|42`), 3);
  const del = events(s.calls, 'broadcast:message-deleted')[0];
  assert.deepEqual([del.messageId, del.reason], ['m3', 'gif_rejected']);
  assert.ok(names(s.calls).includes('deletePlatform'), 'smazaná i na platformě');
  assert.equal(names(s.calls).includes('notify:gif-pending'), false);
  const notice = told.find(([e]) => e === 'gif-notice')![1];
  assert.deepEqual([notice.kind, notice.reason, notice.messageId, notice.requestKey], ['auto_rejected', 'repeat', 'm3', 'twitch:m3']);
  await s.flow._idle();
});

test('jiný uživatel pošle dříve zamítnutý GIF → ke schválení s previouslyRejected (kdy, kým); odesílatel bez „kým"', async () => {
  const sent: Array<[number, string, Record<string, unknown>]> = [];
  const notifier = createGifNotifier({
    connected: () => [2, 7],
    isMod: async (acc) => acc === 2,
    senderAccount: async () => 7,
    send: (acc, e, d) => { sent.push([acc, e, d as Record<string, unknown>]); return 1; },
  });
  const s = setup({ notify: (r, e, d) => notifier.notify(r, e, d) });
  await s.flow.intercept(from('42', 'm1'));
  await s.flow.decide({ requestId: 1, approve: false, by: 'twitch:moda', accountId: 1 });
  sent.length = 0;
  s.advance(5000);
  assert.equal(await s.flow.intercept(from('43', 'm2')), 'requested');
  const toMod = sent.find(([a, e]) => a === 2 && e === 'gif-pending')![2];
  const toSender = sent.find(([a, e]) => a === 7 && e === 'gif-pending')![2];
  assert.deepEqual(toMod.previouslyRejected, { at: 1_000_000, by: 'twitch:moda' });
  assert.deepEqual(toSender.previouslyRejected, { at: 1_000_000 }, 'divák nevidí, kdo zamítl');
  assert.equal(toSender.own, true);
});

test('zákaz 12 h: GIF od všech automaticky zamítnut; tlačítko zamítne i čekající žádosti; po 12 h zase ke schválení', async () => {
  const s = setup();
  await s.flow.intercept(from('42', 'm1'));
  await s.flow.decide({ requestId: 1, approve: false, by: 'twitch:moda', accountId: 1 });
  await s.flow.intercept(from('43', 'm2'));
  const out = await s.flow.mediaAction({ mediaId: MEDIA, action: 'ban12h', by: 'twitch:moda', accountId: 1 });
  assert.equal(out.status, 200);
  assert.equal(s.mem.reqs.get(2)!.status, 'rejected', 'čekající žádost zamítnuta');
  assert.equal(s.mem.bans.get(`robdiesalot|${MEDIA}`)!.until.getTime(), 1_000_000 + 12 * 3600_000);
  assert.equal(await s.flow.intercept(from('44', 'm3')), 'rejected', 'nový uživatel = auto');
  s.advance(12 * 3600_000 + 1);
  assert.equal(await s.flow.intercept(from('45', 'm4')), 'requested');
  await s.flow._idle();
});

test('režim approved: nový GIF → zpráva smazána (gif_not_allowed) + gif-notice approved_only; známý schválený / náš odkaz projde; platí i pro mody', async () => {
  const told: Array<[string, Record<string, unknown>]> = [];
  const access = async () => ({ allowed: true, until: null, cooldownUntil: null, cooldownSec: 60, requestTtlSec: 120, mode: 'approved' as const });
  const s = setup({ access, toSender: async () => (e: string, d: object) => { told.push([e, d as Record<string, unknown>]); } });
  assert.equal(await s.flow.intercept(from('42', 'm1')), 'not_allowed');
  assert.equal(s.mem.media.size, 0, 'nic se neukládá');
  assert.equal(s.mem.reqs.size, 0);
  assert.ok(s.mem.log.includes('retag:m1:gif_request->gif_not_allowed'), s.mem.log.join(' | '));
  const del = events(s.calls, 'broadcast:message-deleted')[0];
  assert.deepEqual([del.messageId, del.reason], ['m1', 'gif_not_allowed']);
  assert.ok(names(s.calls).includes('deletePlatform'));
  const notice = told.find(([e]) => e === 'gif-notice')![1];
  assert.equal(notice.kind, 'approved_only');
  assert.equal(told.at(-1)![1].outcome, 'not_allowed');
  // Mod v režimu approved: nový GIF taky ne.
  assert.equal(await s.flow.intercept({ ...from('50', 'm5'), auto: true }), 'not_allowed');
  await s.flow._idle();

  // Známý schválený (URL i náš odkaz /media/gif/<id>) projde.
  const a = setup();
  await a.flow.intercept(from('42', 'm1'));
  await a.flow.decide({ requestId: 1, approve: true, by: 'twitch:moda', accountId: 1 });
  const b = setup({ access, store: a.mem.store, resolve: async () => { throw new Error('nestahovat'); } });
  assert.equal(await b.flow.intercept(from('43', 'm2')), 'approved');
  const own = `https://api.jouki.cz/media/gif/${MEDIA}`;
  assert.equal(await b.flow.intercept({ ...from('44', 'm3', own), candidate: { url: own, mode: 'own' as const, mediaId: MEDIA, token: own } }), 'approved');
  // Náš odkaz na neznámé / zamítnuté médium v režimu approved → ne.
  const unknown = `https://api.jouki.cz/media/gif/${'c'.repeat(32)}`;
  assert.equal(await b.flow.intercept({ ...from('45', 'm4', unknown), candidate: { url: unknown, mode: 'own' as const, mediaId: 'c'.repeat(32), token: unknown } }), 'not_allowed');
  await b.flow._idle();
});

test('náš odkaz v režimu all: schválené → gif-message; neznámé id → běžný odkaz (failed)', async () => {
  const s = setup();
  await s.flow.intercept(from('42', 'm1'));
  await s.flow.decide({ requestId: 1, approve: true, by: 'twitch:moda', accountId: 1 });
  const own = `https://api.jouki.cz/media/gif/${MEDIA}`;
  assert.equal(await s.flow.intercept({ ...from('43', 'm2', own), candidate: { url: own, mode: 'own' as const, mediaId: MEDIA, token: own } }), 'approved');
  const bad = `https://api.jouki.cz/media/gif/${'d'.repeat(32)}`;
  assert.equal(await s.flow.intercept({ ...from('44', 'm3', bad), candidate: { url: bad, mode: 'own' as const, mediaId: 'd'.repeat(32), token: bad } }), 'failed');
  await s.flow._idle();
});

test('fronta FIFO: listPending podle vzniku; gif-queue { pendingCount, headId } modům po každé změně', async () => {
  const q: Array<Record<string, unknown>> = [];
  const s = setup({ notifyMods: async (ch, e, d) => { if (e === 'gif-queue') q.push({ ch, ...(d as object) }); } });
  await s.flow.intercept(from('42', 'm1'));
  s.advance(10);
  await s.flow.intercept(from('43', 'm2', 'https://media1.tenor.com/m/b/other.gif'));
  assert.deepEqual((await s.mem.store.listPending(new Date(s.now()), 'robdiesalot')).map((r) => r.id), [1, 2]);
  await s.flow.decide({ requestId: 1, approve: false, by: 'twitch:moda', accountId: 1 });
  s.advance(200_000);
  await s.flow.expireTick();
  assert.deepEqual(q, [
    { ch: 'robdiesalot', channel: 'robdiesalot', pendingCount: 1, headId: 1 },
    { ch: 'robdiesalot', channel: 'robdiesalot', pendingCount: 2, headId: 1 },
    { ch: 'robdiesalot', channel: 'robdiesalot', pendingCount: 1, headId: 2 },
    { ch: 'robdiesalot', channel: 'robdiesalot', pendingCount: 0, headId: null },
  ]);
});

test('průběh: gif-progress jen odesílateli — detekce 0, přístup 10, stahování 10–50 (bajty), unlock 50 + odhad, kontrola 95, hotovo 100', async () => {
  const told: Array<Record<string, unknown>> = [];
  const s = setup({
    toSender: async () => (e: string, d: object) => { if (e === 'gif-progress') told.push(d as Record<string, unknown>); },
    resolve: async (_src, hooks) => {
      hooks?.onProgress?.({ phase: 'download', loaded: 250, total: 1000 });
      hooks?.onProgress?.({ phase: 'download', loaded: 260, total: 1000 }); // pod krokem 5 % → neposílá se
      hooks?.onProgress?.({ phase: 'download', loaded: 1000, total: 1000 });
      hooks?.onProgress?.({ phase: 'unlock', estimateMs: 9000, elapsedMs: 0 });
      return resolved;
    },
  });
  await s.flow.intercept(params());
  assert.deepEqual(told.map((t) => [t.phase, t.pct]), [['detect', 0], ['access', 10], ['download', 20], ['download', 50], ['unlock', 50], ['verify', 95], ['done', 100]]);
  assert.equal(told[4].estimateMs, 9000);
  assert.deepEqual([told[0].requestKey, told[0].messageId, told[0].platform, told[0].channel], ['twitch:m1', 'm1', 'twitch', 'robdiesalot']);
  assert.equal(told.at(-1)!.outcome, 'pending');
  // Známé médium (dedup URL): bez stahování rovnou na 95.
  told.length = 0;
  await s.flow.decide({ requestId: 1, approve: true, by: 'twitch:moda', accountId: 1 });
  await s.flow.intercept(from('43', 'm2'));
  assert.deepEqual(told.map((t) => [t.phase, t.pct]), [['detect', 0], ['access', 10], ['verify', 95], ['done', 100]]);
  assert.equal(told.at(-1)!.outcome, 'approved');
  // Stahování bez známé velikosti: odhad roste, nikdy nad 50.
  told.length = 0;
  const u = setup({
    toSender: async () => (e: string, d: object) => { if (e === 'gif-progress') told.push(d as Record<string, unknown>); },
    resolve: async (_src, hooks) => { for (let i = 1; i <= 40; i++) hooks?.onProgress?.({ phase: 'download', loaded: i * 1024 * 1024, total: null }); return resolved; },
  });
  await u.flow.intercept(params());
  const dl = told.filter((t) => t.phase === 'download').map((t) => t.pct as number);
  assert.ok(dl.length > 1 && dl.every((p, i) => p <= 50 && (i === 0 || p > dl[i - 1])), dl.join(','));
});

test('průběh: převod selže → hotovo s výsledkem failed; neodemčeno → denied', async () => {
  const told: Array<Record<string, unknown>> = [];
  const toSender = async () => (e: string, d: object) => { if (e === 'gif-progress') told.push(d as Record<string, unknown>); };
  const f = setup({ toSender, resolve: async () => { throw new GifError('no_media'); } });
  await f.flow.intercept(params());
  assert.equal(told.at(-1)!.outcome, 'failed');
  told.length = 0;
  const d = setup({ toSender, access: async () => ({ allowed: false, until: null, cooldownUntil: null, cooldownSec: 0, requestTtlSec: 300 }) });
  await d.flow.intercept(params({ preDeleted: null, needAccess: true }));
  assert.equal(told.at(-1)!.outcome, 'denied');
  await f.flow._idle();
});

test('zamítnuté médium: schválit (jen do knihovny) / vault / trvale zahodit; retence 14 dní bez vaultu', async () => {
  const gone: string[] = [];
  const s = setup({ mediaDeleted: (id) => gone.push(id) });
  await s.flow.intercept(from('42', 'm1'));
  await s.flow.decide({ requestId: 1, approve: false, by: 'twitch:moda', accountId: 1 });
  s.calls.length = 0;
  // Vault → retence ho nesmaže.
  assert.equal((await s.flow.mediaAction({ mediaId: MEDIA, action: 'vault', by: 'twitch:moda', accountId: 1 })).status, 200);
  s.advance(15 * 86_400_000);
  assert.equal(await s.flow.retentionTick(), 0);
  // Schválit → do knihovny, do chatu nic.
  assert.equal((await s.flow.mediaAction({ mediaId: MEDIA, action: 'approve', by: 'twitch:moda', accountId: 1 })).status, 200);
  assert.equal(s.mem.media.get(MEDIA)!.status, 'approved');
  assert.equal(names(s.calls).includes('broadcast:gif-message'), false);
  assert.deepEqual((await s.flow.mediaAction({ mediaId: MEDIA, action: 'purge', by: 'twitch:moda', accountId: 1 })).body, { ok: false, error: 'not_rejected', status: 'approved' });
  assert.equal((await s.flow.mediaAction({ mediaId: 'e'.repeat(32), action: 'vault', by: 'x', accountId: 1 })).status, 404);

  // Retence: zamítnuté starší 14 dní bez vaultu pryč, mladší zůstávají; trvale zahodit hned.
  const r = setup({ mediaDeleted: (id) => gone.push(id) });
  await r.flow.intercept(from('42', 'm1'));
  await r.flow.decide({ requestId: 1, approve: false, by: 'twitch:moda', accountId: 1 });
  r.advance(13 * 86_400_000);
  assert.equal(await r.flow.retentionTick(), 0);
  r.advance(2 * 86_400_000);
  assert.equal(await r.flow.retentionTick(), 1);
  assert.equal(r.mem.media.size, 0);
  assert.ok(gone.includes(MEDIA));
  const p = setup({ mediaDeleted: (id) => gone.push(`p:${id}`) });
  await p.flow.intercept(from('42', 'm1'));
  await p.flow.decide({ requestId: 1, approve: false, by: 'twitch:moda', accountId: 1 });
  assert.equal((await p.flow.mediaAction({ mediaId: MEDIA, action: 'purge', by: 'twitch:moda', accountId: 1 })).status, 200);
  assert.equal(p.mem.media.size, 0);
  assert.ok(gone.includes(`p:${MEDIA}`));
});

test('propadnutí: médium čekající jen na tuto žádost pryč; už zamítnuté (dříve) zůstává', async () => {
  const s = setup();
  await s.flow.intercept(from('42', 'm1'));
  await s.flow.decide({ requestId: 1, approve: false, by: 'twitch:moda', accountId: 1 });
  await s.flow.intercept(from('43', 'm2'));
  s.advance(200_000);
  assert.equal(await s.flow.expireTick(), 1);
  assert.equal(s.mem.media.get(MEDIA)?.status, 'rejected');
});

test('listRejected + pendingView: previouslyRejected ve tvaru pro kartu', async () => {
  const s = setup();
  await s.flow.intercept(from('42', 'm1'));
  await s.flow.decide({ requestId: 1, approve: false, by: 'twitch:moda', accountId: 1 });
  await s.flow.intercept(from('43', 'm2'));
  const [row] = await s.mem.store.listPending(new Date(s.now()), 'robdiesalot');
  assert.deepEqual(pendingView(row).previouslyRejected, { at: 1_000_000, by: 'twitch:moda' });
  assert.equal(pendingView(s.mem.reqs.get(1)!).previouslyRejected, undefined);
});
