import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGifFlow, createGifNotifier, approvedMessageRow, pendingView, forSender, RECONCILE_MAX_ATTEMPTS, startGifMaintenance, GIF_UNLOCK_PER_USER_DAY, GIF_NOT_ALLOWED_TEXT, GIF_NOT_ALLOWED_REPLY_MS, GIF_NOT_ALLOWED_REPLY_CHANNEL_MS, GIF_GONE_PARENT_MS, type GifFlowDeps, type GifStore, type NewGifRequest, type GifMediaInfo } from './gifRequests.js';
import type { GifRequest } from '../db/schema.js';
import type { IngestMessage } from '../ingest/types.js';
import { GifError, type ResolvedGif } from './gifMedia.js';
import { createClientFetchGrants } from './gifClientFetch.js';
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
  const msgs = new Set<number>();
  const rk = (ch: string, id: string, pl: string, u: string) => `${ch}|${id}|${pl}|${u}`;
  // Schválení ruší tresty média (zamítnutí všech uživatelů + zákaz), jako clearMediaStrikes v DB.
  const clearStrikes = (id: string) => {
    for (const k of [...rejections.keys()]) if (k.split('|')[1] === id) rejections.delete(k);
    for (const k of [...bans.keys()]) if (k.split('|')[1] === id) bans.delete(k);
  };
  const livePending = (id: string, at: Date) => [...reqs.values()].filter((r) => r.mediaId === id && r.status === 'pending' && r.expiresAt > at);
  const store: GifStore = {
    async saveMedia(m, meta) {
      const id = mediaSeq++ === 0 ? MEDIA : `${String(mediaSeq).padStart(2, '0')}${'b'.repeat(30)}`;
      media.set(id, { id, channel: meta.channel, status: 'pending', kind: m.kind, width: m.width, height: m.height, sha256: meta.sha256, approvedAt: null, rejectedAt: null, rejectedBy: null, vault: false, urlNorm: meta.sourceUrlNorm, useCount: 0, source: meta.source ?? 'server' });
      return id;
    },
    async deleteMedia(id) { media.delete(id); log.push(`deleteMedia:${id}`); },
    async getMedia(id) { return media.get(id) ?? null; },
    async findMedia(channel, by) {
      const order = ['approved', 'rejected', 'pending'];
      // Zahozené médium dedup nevidí (jako dbGifStore, pokyn usera 2026-09-28).
      return [...media.values()].filter((x) => x.channel === channel && !['withdrawn', 'purging', 'unavailable'].includes(x.status) && (by.url ? x.urlNorm === by.url : x.sha256 === by.sha256))
        .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))[0] ?? null;
    },
    async setMediaApproved(id, at, opts) {
      const x = media.get(id);
      if (!x) return id;
      // Zahozené médium se nevzkřísí → null (souběh se zahozením); z knihovny jen dosud schválené.
      if (!(opts?.onlyApproved ? ['approved'] : ['pending', 'rejected', 'approved']).includes(x.status)) return null;
      // Unikátní (channel, sha256) pro schválené: jiné schválené médium se stejným obsahem vyhrává.
      const other = [...media.values()].find((o) => o.id !== id && o.status === 'approved' && o.channel === x.channel && o.sha256 === x.sha256);
      if (other) return other.id;
      Object.assign(x, { status: 'approved', approvedAt: x.approvedAt ?? at, rejectedAt: null, rejectedBy: null, vault: false });
      clearStrikes(id);
      return id;
    },
    async mergeMedia(from, to) {
      for (const r of reqs.values()) if (r.mediaId === from) r.mediaId = to;
      media.delete(from);
      clearStrikes(from);
      clearStrikes(to);
      log.push(`merge:${from}->${to}`);
    },
    async setMediaRejected(id, by, at) { const x = media.get(id); if (x && (x.status === 'pending' || x.status === 'rejected')) Object.assign(x, { status: 'rejected', rejectedAt: at, rejectedBy: by }); },
    async purgeMedia(id, to, by, at, purgeAt) {
      const x = media.get(id);
      if (!x || (x.status !== 'approved' && x.status !== 'rejected')) return { ok: false, rejected: [] };
      Object.assign(x, { statusBeforePurge: x.status, status: to, purgedAt: at, purgedBy: by, purgeAt });
      const rejected: GifRequest[] = [];
      for (const r of reqs.values()) if (r.mediaId === id && r.status === 'pending') { Object.assign(r, { status: 'rejected', decidedBy: by, decidedAt: at }); rejected.push(r); }
      return { ok: true, rejected };
    },
    async setRequestRejected(id, by, at) {
      const r = reqs.get(id);
      if (!r || r.status !== 'approved') return null;
      Object.assign(r, { status: 'rejected', decidedBy: by, decidedAt: at });
      return r;
    },
    async restoreMedia(id, at, by) {
      const x = media.get(id);
      if (!x || x.status !== 'purging') return null;
      const to = x.statusBeforePurge === 'approved' ? 'approved' as const : 'rejected' as const;
      const other = to === 'approved' ? [...media.values()].find((o) => o.id !== id && o.status === 'approved' && o.channel === x.channel && o.sha256 === x.sha256) : null;
      if (other) return { status: 'approved' as const, mergedInto: other.id };
      const rej = to === 'rejected' ? { rejectedAt: at, rejectedBy: x.rejectedBy ?? x.purgedBy ?? by } : {};
      Object.assign(x, { status: to, statusBeforePurge: null, purgedAt: null, purgedBy: null, purgeAt: null, ...rej });
      if (to === 'approved') clearStrikes(id);
      return { status: to };
    },
    async removeMediaFile(id) {
      const x = media.get(id);
      if (!x || x.status !== 'withdrawn') return false;
      x.status = 'unavailable';
      log.push(`removeFile:${id}`);
      return true;
    },
    async listDiscarded(ch, status, before, limit) {
      const t = (x: GifMediaInfo) => x.purgedAt!.getTime();
      return [...media.values()].filter((x) => x.channel === ch && x.status === status
        && (!before || t(x) < before.at.getTime() || (t(x) === before.at.getTime() && x.id < before.id)))
        .sort((a, b) => t(b) - t(a) || (a.id < b.id ? 1 : -1)).slice(0, limit);
    },
    async purgeDue(at) {
      const out: string[] = [];
      for (const x of [...media.values()]) if (x.status === 'purging' && x.purgeAt && x.purgeAt <= at) { media.delete(x.id); out.push(x.id); }
      return out;
    },
    async messageKeysForMedia(id, limit) {
      return [...reqs.values()].filter((r) => r.mediaId === id && r.status === 'approved').slice(0, limit).map((r) => `${r.platform}:gif-${r.id}`);
    },
    async setMediaUnapproved(id, by, at) {
      const x = media.get(id);
      if (!x || x.status !== 'approved') return false;
      Object.assign(x, { status: 'rejected', approvedAt: null, rejectedAt: at, rejectedBy: by, vault: false });
      return true;
    },
    async markMediaUsed(id) { const x = media.get(id); if (x) x.useCount++; },
    async rejectionCount(ch, id, pl, u) { return rejections.get(rk(ch, id, pl, u)) ?? 0; },
    async hasRejections(ch, id) { return [...rejections.keys()].some((k) => k.startsWith(`${ch}|${id}|`)); },
    async addRejection(ch, id, pl, u) { const n = (rejections.get(rk(ch, id, pl, u)) ?? 0) + 1; rejections.set(rk(ch, id, pl, u), n); return n; },
    async activeBan(ch, id, at) { const b = bans.get(`${ch}|${id}`); return b && b.until > at ? b : null; },
    async setBan(ch, id, until, by) { bans.set(`${ch}|${id}`, { until, by }); },
    async pendingForMedia(id, at) { return livePending(id, at); },
    async mediaReferenced(id) { return [...reqs.values()].some((r) => r.mediaId === id && r.status !== 'expired'); },
    async listRejected(ch, before, limit) {
      const t = (x: GifMediaInfo) => x.rejectedAt!.getTime();
      return [...media.values()].filter((x) => x.channel === ch && x.status === 'rejected'
        && (!before || t(x) < before.at.getTime() || (t(x) === before.at.getTime() && x.id < before.id)))
        .sort((a, b) => t(b) - t(a) || (a.id < b.id ? 1 : -1)).slice(0, limit);
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
    async insertApprovedMessage(r, at) { log.push(`message:${r.id}`); msgs.add(r.id); return toClientMessage(approvedMessageRow(r, at), false); },
    async unpublishedApproved(before, after, limit) {
      return [...reqs.values()].filter((r) => r.status === 'approved' && r.decidedAt && r.decidedAt < before && r.decidedAt > after)
        .map((r) => ({ request: r, mediaStatus: r.mediaId ? media.get(r.mediaId)?.status ?? null : null, hasMessage: msgs.has(r.id) }))
        .filter((x) => !x.hasMessage || x.mediaStatus === 'pending').slice(0, limit);
    },
    async retagDeleted(_p, id, from, to) { log.push(`retag:${id}:${from}->${to}`); return retagOk; },
    async statusByMessages(keys) {
      const out = new Map();
      for (const k of keys) { const r = [...reqs.values()].reverse().find((x) => x.platform === k.platform && x.messageId === k.messageId); if (r) out.set(`${k.platform}:${k.messageId}`, r.status as never); }
      return out;
    },
  };
  return { store, reqs, media, rejections, bans, log, setRetag: (v: boolean) => { retagOk = v; } };
}

const resolved: ResolvedGif = { bytes: Buffer.from('GIF89a'), kind: 'gif', contentType: 'image/gif', width: 320, height: 240, sourceUrl: 'https://media.tenor.com/x.gif' };

/** GIF hlavička s rozměry (jako `gif()` v gifUnlocker.test.ts) — bajty pro upload klienta. */
const gifBytes = (w: number, h: number): Buffer => { const b = Buffer.alloc(32); b.write('GIF89a', 0, 'latin1'); b.writeUInt16LE(w, 6); b.writeUInt16LE(h, 8); return b; };

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
  assert.deepEqual(r.meta, { displayName: 'Divak', sentAt: 1_000_000 - 500, color: '#ff0000', badges: 'subscriber/1', role: 'sub' }, 'role pro gif-used po schválení (bod 5)');
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
  assert.deepEqual(names(b.calls), ['publishDeleted', 'restore', 'integration:chat.held_settled']);
  assert.equal(b.mem.reqs.size, 0);
});

test('A12 oprava: obnovení ze zprávy (řádek ještě není v archivu) pošle Židolištce chat.restored s textem', async () => {
  const restoredInt: Array<Record<string, unknown>> = [];
  // Neznámý přístup (Židolišta neodpověděla) → zprávu obnovit; potvrzené „bez odměny“ je gif_denied (test níž).
  const s = setup({
    access: async () => null,
    restore: async () => 'not_found',
    restoredIntegration: (p) => { restoredInt.push(p as unknown as Record<string, unknown>); },
  });
  assert.equal(await s.flow.intercept(params({ needAccess: true })), 'denied');
  assert.equal(restoredInt.length, 1);
  assert.equal((restoredInt[0].message as { content: string }).content, 'hele https://tenor.com/view/cat-gif-1 lol');
  assert.equal(restoredInt[0].channel, 'robdiesalot');
  await s.flow._idle();
});

test('A12: zpráva schovaná hned (gif_request) → bez odměny = gif_denied všem (štítek, na platformě smazaná); neznámý přístup = obnovit / filtr', async () => {
  const deny = { access: async () => ({ allowed: false, until: null, cooldownUntil: null, cooldownSec: 0, requestTtlSec: 300 }) };
  const a = setup(deny);
  assert.equal(await a.flow.intercept(params({ needAccess: true })), 'denied');
  assert.ok(events(a.calls, 'broadcast:message-deleted').some((e) => e.messageId === 'm1' && e.reason === 'gif_denied'), JSON.stringify(names(a.calls)));
  assert.ok(names(a.calls).includes('deletePlatform'), 'na platformě smazaná');
  assert.equal(names(a.calls).includes('restore'), false, 'odkaz se nevrátí');
  assert.deepEqual(settled(a.calls), [hs('m1', 'not_allowed', { by: 'filter', reason: 'no_reward' })]);
  assert.ok(a.mem.log.includes('retag:m1:gif_request->gif_denied'), JSON.stringify(a.mem.log));
  assert.equal(a.mem.reqs.size, 0);
  assert.equal(a.flow.tryReserve('robdiesalot', 'twitch', '42'), true);
  let acted = 0;
  const b = setup(deny);
  assert.equal(await b.flow.intercept(params({ needAccess: true, filterAct: async () => { acted++; } })), 'denied');
  assert.equal(acted, 0, 'bez odměny štítek, ne filtr odkazů');
  assert.ok(b.mem.log.includes('retag:m1:gif_request->gif_denied'));
  // Neznámý přístup (výpadek Židolišty) → dřívější cesta: obnovit / smazat filtrem.
  const u = setup({ access: async () => null });
  assert.equal(await u.flow.intercept(params({ needAccess: true })), 'denied');
  assert.deepEqual(names(u.calls), ['publishDeleted', 'restore', 'integration:chat.held_settled']);
  const uf = setup({ access: async () => null });
  let actedU = 0;
  assert.equal(await uf.flow.intercept(params({ needAccess: true, filterAct: async () => { actedU++; } })), 'denied');
  assert.equal(actedU, 1);
  assert.deepEqual(uf.mem.log, ['retag:m1:gif_request->link_filter']);
  await u.flow._idle(); await uf.flow._idle();
  // Odemčeno → běžná žádost (zpráva už je schovaná).
  const c = setup();
  assert.equal(await c.flow.intercept(params({ needAccess: true })), 'requested');
  await a.flow._idle(); await b.flow._idle();
});

test('intercept: neznámý přístup → ověřit; bez odměny = zobrazená zpráva smazaná (gif_denied); po úspěchu se smaže zpětně', async () => {
  const denied = setup({ access: async () => ({ allowed: false, until: null, cooldownUntil: null, cooldownSec: 0, requestTtlSec: 300 }) });
  assert.equal(await denied.flow.intercept(params({ preDeleted: null, needAccess: true })), 'denied');
  assert.deepEqual(names(denied.calls).slice(0, 2), ['publishDeleted', 'deletePlatform']);
  assert.equal((denied.calls.find((c) => c[0] === 'publishDeleted')![1] as { reason: string }).reason, 'gif_denied');
  // Neznámý přístup → nic (zpráva zůstane).
  const unknown = setup({ access: async () => null });
  assert.equal(await unknown.flow.intercept(params({ preDeleted: null, needAccess: true })), 'denied');
  assert.deepEqual(unknown.calls, []);

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
  assert.deepEqual(calls.find((c) => c[0] === 'used')![1], { workspace: 'rob', platform: 'twitch', userId: '42', role: 'sub' }, 'gif-used s rolí (z žádosti, meta.role)');
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
  assert.deepEqual(s.calls.find((c) => c[0] === 'broadcast:message-deleted')![1], { channel: 'robdiesalot', platform: 'twitch', messageId: 'm1', by: null, reason: 'gif_rejected', at: 1_000_000 });
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
  assert.equal(s.mem.rejections.size, 0, 'propadnutí nového (čekajícího) GIFu strike nepočítá');
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
  // gif-pending nese čas serveru (audit F1) — klient přepočte expiresAt na své hodiny.
  for (const s of sent) { assert.equal(typeof (s[2] as { serverNow?: unknown }).serverNow, 'number'); delete (s[2] as { serverNow?: unknown }).serverNow; }
  assert.deepEqual(sent, [[7, 'gif-pending', { requestId: 1, own: true }], [2, 'gif-pending', { requestId: 1 }]]);
  await n.notify(r, 'gif-decided', { requestId: 1 });
  assert.equal(modChecks, 3, 'mod stav z cache (účty 1, 2, 3)');
});

test('M4 notifier: odesílatel gif-decided bez `by` (kdo zamítl), mod ho dostává; previouslyRejected odesílateli bez by', async () => {
  const sent: Array<[number, string, Record<string, unknown>]> = [];
  const n = createGifNotifier({
    connected: () => [2, 7],
    isMod: async (acc) => acc === 2,
    senderAccount: async () => 7,
    send: (acc, e, d) => { sent.push([acc, e, d as Record<string, unknown>]); return 1; },
  });
  const ev = { requestId: 1, channel: 'robdiesalot', approved: false, status: 'rejected', by: 'twitch:modik' };
  await n.notify({ channel: 'robdiesalot', platform: 'twitch', userId: '42' }, 'gif-decided', ev);
  assert.deepEqual(sent[0], [7, 'gif-decided', { requestId: 1, channel: 'robdiesalot', approved: false, status: 'rejected', own: true }]);
  assert.equal('by' in sent[0][2], false);
  assert.deepEqual(sent[1], [2, 'gif-decided', ev]);
  assert.deepEqual(forSender({ requestId: 2, previouslyRejected: { at: 5, by: 'kick:x' } }), { requestId: 2, previouslyRejected: { at: 5 } });
  assert.deepEqual(ev.by, 'twitch:modik', 'původní událost (pro mody) se nemění');
});

test('M1 expireTick: čekající alias z backfillu (schválená žádost = zpráva v archivu) se po propadnutí jiné žádosti nesmaže', async () => {
  const s = setup();
  // Nová žádost na médium (náš odkaz na alias) → propadne.
  await s.flow.intercept(params());
  // Starší schválená žádost na totéž médium (syntetická zpráva gif-<id> odkazuje na médium).
  const old = await s.mem.store.insertRequest({ ...s.mem.reqs.get(1)!, messageId: 'old' } as unknown as NewGifRequest);
  old.status = 'approved';
  s.advance(120_000);
  assert.equal(await s.flow.expireTick(), 1);
  assert.equal(s.mem.media.has(MEDIA), true, 'médium zůstává (odkazuje na něj schválená žádost)');
  assert.equal(s.mem.log.includes(`deleteMedia:${MEDIA}`), false);
  // Bez jiné žádosti se propadlé čekající médium smaže jako dřív.
  const t = setup();
  await t.flow.intercept(params());
  t.advance(120_000);
  await t.flow.expireTick();
  assert.equal(t.mem.media.has(MEDIA), false);
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

test('decide: zápis do archivu selže i napodruhé → nic se nerozešle, cooldown ano (bod 8); dopíše ho reconcileTick (audit A1); médium se předehřeje před rozesláním', async () => {
  const s = setup({ mediaApproved: async () => { s.calls.push(['warm', null]); } });
  await s.flow.intercept(params());
  let tries = 0;
  const insert = s.mem.store.insertApprovedMessage.bind(s.mem.store);
  s.mem.store.insertApprovedMessage = async () => { tries++; throw new Error('db down'); };
  s.calls.length = 0;
  const out = await s.flow.decide({ requestId: 1, approve: true, by: 'twitch:moda', accountId: 1 });
  assert.deepEqual(out.body, { ok: true, requestId: 1, status: 'approved', published: false });
  assert.equal(tries, 2);
  // Žádost zůstává schválená, původní zpráva schovaná (/gif/held: replaced) — zprávu dopíše reconcileTick.
  assert.equal(s.mem.reqs.get(1)!.status, 'approved');
  assert.equal(s.mem.log.includes('retag:m1:gif_request->gif_rejected'), false, s.mem.log.join(' | '));
  assert.equal(names(s.calls).some((n) => n === 'broadcast:gif-message' || n === 'publishChat' || n === 'warm'), false);
  assert.equal(names(s.calls).includes('used'), true);
  assert.equal(await s.flow.reconcileTick(), 0, 'rozhodnutí před chvílí (souběh s decide) se neřeší');
  s.advance(61_000);
  assert.equal(await s.flow.reconcileTick(), 0, 'DB pořád dole');
  s.mem.store.insertApprovedMessage = insert;
  s.calls.length = 0;
  assert.equal(await s.flow.reconcileTick(), 1);
  const pub = events(s.calls, 'broadcast:gif-message')[0];
  assert.equal(pub.requestId, 1);
  assert.equal((pub.message as Record<string, unknown>).timestamp, 1_000_000, 'čas schválení');
  assert.deepEqual(names(s.calls).filter((n) => n === 'warm' || n === 'publishChat'), ['warm', 'publishChat']);
  assert.equal(await s.flow.reconcileTick(), 0, 'dopsané se už neřeší');

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

test('intercept auto (mod s odemčenou odměnou): schváleno hned, bez karet, cooldown (gif-used) jako u diváka; GIF na konci chatu', async () => {
  let accessCalls = 0;
  const s = setup({ access: async () => { accessCalls++; return { allowed: true, until: null, cooldownUntil: null, cooldownSec: 60, requestTtlSec: 120 }; } });
  assert.equal(await s.flow.intercept(params({ auto: true, query: { workspace: 'rob', platform: 'twitch', userId: '42', login: 'moda', role: 'moderator' } })), 'approved');
  assert.equal(accessCalls, 1);
  const n = names(s.calls);
  assert.deepEqual(n.filter((x) => x.startsWith('notify:') || x.startsWith('integration:')), ['integration:chat.held_settled'], 'nikdo nic neschvaluje (jen konec čekání pro Židolištu)');
  assert.equal(n.includes('used'), true, 'mod má cooldown jako ostatní');
  assert.equal((s.calls.find((c) => c[0] === 'used')![1] as { role?: string }).role, 'moderator', 'gif-used s rolí moda (Židolišta jinak počítá jako viewer)');
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

test('intercept auto (mod) s neznámým přístupem: ověří se u Židolišty; neodemčeno / cooldown → denied jako u diváka', async () => {
  for (const a of [null, { allowed: true, until: null, cooldownUntil: 2_000_000, cooldownSec: 60, requestTtlSec: 120 }]) {
    const s = setup({ access: async () => a });
    assert.equal(await s.flow.intercept(params({ auto: true, needAccess: true, preDeleted: null })), 'denied');
    assert.equal(s.mem.reqs.size, 0);
    assert.equal(names(s.calls).includes('publishDeleted'), false, 'neznámý přístup / cooldown: zpráva zůstane');
  }
  // Mod bez odměny → jako divák: smazaná všem se štítkem (gif_denied).
  const no = setup({ access: async () => ({ allowed: false, until: null, cooldownUntil: null, cooldownSec: 60, requestTtlSec: 120 }) });
  assert.equal(await no.flow.intercept(params({ auto: true, needAccess: true, preDeleted: null })), 'denied');
  assert.equal((no.calls.find((c) => c[0] === 'publishDeleted')![1] as { reason: string }).reason, 'gif_denied');
  const ok = setup();
  assert.equal(await ok.flow.intercept(params({ auto: true, needAccess: true, preDeleted: null })), 'approved');
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
  assert.deepEqual(names(s.calls), ['publishDeleted', 'restore', 'integration:chat.held_settled']);
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
  assert.deepEqual(names(s.calls), ['publishDeleted', 'restore', 'integration:chat.held_settled']);
  assert.equal(events(s.calls, 'integration:chat.held_settled')[0].reason, 'error');
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

test('L4: Bright Data nejvýš GIF_UNLOCK_PER_USER_DAY pokusů na uživatele za den (vlastní server s challenge nevyčerpá denní strop)', async () => {
  const noUnlock: boolean[] = [];
  const s = setup({
    resolve: async (_src, hooks) => {
      noUnlock.push(!!hooks?.noUnlock);
      if (!hooks?.noUnlock) hooks?.onProgress?.({ phase: 'unlock', estimateMs: 1000, elapsedMs: 0 });
      throw new GifError('bot_protection');
    },
  });
  for (let i = 0; i < GIF_UNLOCK_PER_USER_DAY + 2; i++) await s.flow.intercept(from('42', `m${i}`, `https://evil.example/x${i}.gif`));
  assert.deepEqual(noUnlock, [...Array(GIF_UNLOCK_PER_USER_DAY).fill(false), true, true]);
  // Jiný uživatel má vlastní rozpočet; další den zase.
  await s.flow.intercept(from('43', 'n1', 'https://evil.example/y.gif'));
  assert.equal(noUnlock.at(-1), false);
  s.advance(86_400_000);
  await s.flow.intercept(from('42', 'm99', 'https://evil.example/z.gif'));
  assert.equal(noUnlock.at(-1), false);
  await s.flow._idle();
});

test('A2: GIF z knihovny souběžně s „Odebrat z knihovny“ → instantní schválení médium nevrátí do knihovny, zpráva automaticky zamítnuta', async () => {
  const told: Array<[string, Record<string, unknown>]> = [];
  const s = setup({ toSender: async () => (e: string, d: object) => { told.push([e, d as Record<string, unknown>]); } });
  await s.flow.intercept(from('42', 'm1'));
  await s.flow.decide({ requestId: 1, approve: true, by: 'twitch:moda', accountId: 1 });
  // Mod odebere GIF z knihovny přesně v okně mezi dedupem (findMedia = approved) a instantním schválením.
  const orig = s.mem.store.insertRequest.bind(s.mem.store);
  s.mem.store.insertRequest = async (v) => {
    await s.flow.mediaAction({ mediaId: MEDIA, action: 'unapprove', by: 'twitch:modb', accountId: 2 });
    return orig(v);
  };
  s.calls.length = 0;
  assert.equal(await s.flow.intercept(from('43', 'm2')), 'rejected');
  const md = s.mem.media.get(MEDIA)!;
  assert.deepEqual([md.status, md.rejectedBy], ['rejected', 'twitch:modb'], 'akce moda platí');
  assert.equal(s.mem.reqs.get(2)!.status, 'rejected');
  assert.equal(names(s.calls).includes('broadcast:gif-message'), false);
  assert.ok(events(s.calls, 'broadcast:message-deleted').some((e) => e.messageId === 'm2' && e.reason === 'gif_rejected'));
  assert.equal(told.find(([e]) => e === 'gif-notice')![1].kind, 'auto_rejected');
  assert.equal(s.mem.rejections.size, 0, 'bez strike');
  // Mod (auto) GIF dál schválit smí (jeho rozhodnutí), i když je médium zamítnuté.
  s.mem.store.insertRequest = orig;
  assert.equal(await s.flow.intercept(from('44', 'm3', TENOR, { auto: true })), 'approved');
  assert.equal(s.mem.media.get(MEDIA)!.status, 'approved');
  await s.flow._idle();
});

test('B2: údržba GIFů — propadnutí po 10 s, dorovnání brzy po startu a pak 1×/min, retence 2 min po startu a pak 1×/h', () => {
  const timers: Array<{ kind: string; ms: number; fn: () => void }> = [];
  const ran: string[] = [];
  const stop = startGifMaintenance(
    { expireTick: async () => { ran.push('expire'); return 0; }, reconcileTick: async () => { ran.push('reconcile'); return 0; }, retentionTick: async () => { ran.push('retention'); return 0; } },
    {
      setTimeout: (fn, ms) => { timers.push({ kind: 'once', ms, fn }); return timers.length as never; },
      setInterval: (fn, ms) => { timers.push({ kind: 'every', ms, fn }); return timers.length as never; },
      clear: () => { ran.push('clear'); },
    },
  );
  const sched = timers.map((t) => `${t.kind}:${t.ms}`).sort();
  assert.deepEqual(sched, ['every:10000', 'once:120000', 'once:30000'].sort());
  // Po prvním běhu se naplánuje pravidelný.
  for (const t of timers.filter((x) => x.kind === 'once')) t.fn();
  assert.deepEqual(ran.sort(), ['reconcile', 'retention']);
  assert.deepEqual(timers.filter((x) => x.kind === 'every').map((t) => t.ms).sort((a, b) => a - b), [10_000, 60_000, 3_600_000]);
  stop();
  assert.ok(ran.includes('clear'));
});

test('A1: restart mezi schválením a zápisem zprávy → reconcileTick dopíše zprávu a schválí médium (čekající zůstalo)', async () => {
  const s = setup();
  await s.flow.intercept(from('42', 'm1'));
  // Simulace restartu: žádost schválená (autocommit UPDATE), médium ani zpráva už ne.
  Object.assign(s.mem.reqs.get(1)!, { status: 'approved', decidedBy: 'twitch:moda', decidedAt: new Date(s.now()) });
  assert.equal(s.mem.media.get(MEDIA)!.status, 'pending');
  s.advance(61_000);
  assert.equal(await s.flow.reconcileTick(), 1);
  assert.equal(s.mem.media.get(MEDIA)!.status, 'approved', 'médium do knihovny');
  assert.ok(s.mem.log.includes('message:1'));
  assert.equal(events(s.calls, 'broadcast:gif-message').length, 1);
  assert.equal(await s.flow.reconcileTick(), 0);
});

test('A1: zpráva existuje, ale médium zůstalo čekající (setMediaApproved selhalo) → reconcile jen schválí médium; zahozené → žádost zamítnuta, původní zpráva smazaná', async () => {
  const s = setup();
  await s.flow.intercept(from('42', 'm1'));
  const approve = s.mem.store.setMediaApproved.bind(s.mem.store);
  s.mem.store.setMediaApproved = async () => { throw new Error('db blip'); };
  await s.flow.decide({ requestId: 1, approve: true, by: 'twitch:moda', accountId: 1 });
  assert.equal(s.mem.media.get(MEDIA)!.status, 'pending');
  s.mem.store.setMediaApproved = approve;
  s.calls.length = 0;
  s.advance(61_000);
  assert.equal(await s.flow.reconcileTick(), 1);
  assert.equal(s.mem.media.get(MEDIA)!.status, 'approved');
  assert.equal(events(s.calls, 'broadcast:gif-message').length, 0, 'zpráva už je');
  // Médium mezitím zahozené (purging) a zpráva chybí → žádost zamítnout, původní zprávu ukázat jako smazanou.
  const p = setup();
  await p.flow.intercept(from('42', 'm1'));
  Object.assign(p.mem.reqs.get(1)!, { status: 'approved', decidedBy: 'twitch:moda', decidedAt: new Date(p.now()) });
  Object.assign(p.mem.media.get(MEDIA)!, { status: 'purging' });
  p.advance(61_000);
  assert.equal(await p.flow.reconcileTick(), 1);
  assert.equal(p.mem.reqs.get(1)!.status, 'rejected');
  assert.ok(p.mem.log.includes('retag:m1:gif_request->gif_rejected'));
  assert.equal(events(p.calls, 'broadcast:gif-message').length, 0);
});

test('A1: zápis zprávy selhává trvale → po RECONCILE_MAX_ATTEMPTS pokusech žádost zamítnout (původní zpráva nezůstane navždy schovaná)', async () => {
  const s = setup();
  await s.flow.intercept(from('42', 'm1'));
  s.mem.store.insertApprovedMessage = async () => { throw new Error('constraint'); };
  await s.flow.decide({ requestId: 1, approve: true, by: 'twitch:moda', accountId: 1 });
  s.advance(61_000);
  for (let i = 0; i < RECONCILE_MAX_ATTEMPTS - 1; i++) await s.flow.reconcileTick();
  assert.equal(s.mem.reqs.get(1)!.status, 'approved');
  s.calls.length = 0;
  await s.flow.reconcileTick();
  assert.equal(s.mem.reqs.get(1)!.status, 'rejected');
  assert.ok(s.mem.log.includes('retag:m1:gif_request->gif_rejected'));
  // Odesílatel dostane gif-decided (štítek nevisí), stav rejected.
  const dec = events(s.calls, 'notify:gif-decided');
  assert.equal(dec.length, 1);
  assert.deepEqual([dec[0].requestId, dec[0].status], [1, 'rejected']);
});

test('A1 review: dva souběžné běhy dorovnání — druhý nic nedělá (žádná zpráva dvakrát)', async () => {
  const s = setup();
  await s.flow.intercept(from('42', 'm1'));
  Object.assign(s.mem.reqs.get(1)!, { status: 'approved', decidedBy: 'twitch:moda', decidedAt: new Date(s.now()) });
  s.advance(61_000);
  const [a, b] = await Promise.all([s.flow.reconcileTick(), s.flow.reconcileTick()]);
  assert.deepEqual([a, b].sort(), [0, 1]);
  assert.equal(events(s.calls, 'broadcast:gif-message').length, 1);
});

test('SEC-8 review: slot globálního cooldownu se uvolní, když se GIF nakonec nezobrazí (odebráno z knihovny, chyba zápisu)', async () => {
  let taken = 0, released = 0;
  const s = setup({ claim: () => { taken++; return () => { released++; }; } });
  await s.flow.intercept(from('42', 'm1'));
  await s.flow.decide({ requestId: 1, approve: true, by: 'twitch:moda', accountId: 1 });
  // Zobrazeno → slot zůstává.
  assert.equal(await s.flow.intercept(from('43', 'm2')), 'approved');
  assert.deepEqual([taken, released], [1, 0]);
  // Zápis zprávy selže → nezobrazeno → uvolnit.
  const insert = s.mem.store.insertApprovedMessage.bind(s.mem.store);
  s.mem.store.insertApprovedMessage = async () => { throw new Error('db'); };
  await s.flow.intercept(from('44', 'm3'));
  assert.deepEqual([taken, released], [2, 1]);
  s.mem.store.insertApprovedMessage = insert;
  // Odebráno z knihovny mezi dedupem a schválením → uvolnit.
  const orig = s.mem.store.insertRequest.bind(s.mem.store);
  s.mem.store.insertRequest = async (v) => { await s.flow.mediaAction({ mediaId: MEDIA, action: 'unapprove', by: 'twitch:modb', accountId: 2 }); return orig(v); };
  assert.equal(await s.flow.intercept(from('45', 'm4')), 'rejected');
  assert.deepEqual([taken, released], [3, 2]);
  // Uložení žádosti selže → uvolnit.
  await s.flow.mediaAction({ mediaId: MEDIA, action: 'approve', by: 'twitch:moda', accountId: 1 });
  s.mem.store.insertRequest = async () => { throw new Error('db'); };
  await s.flow.intercept(from('46', 'm5'));
  assert.deepEqual([taken, released], [4, 3]);
  await s.flow._idle();
});

test('SEC-8: okamžité schválení (knihovna / mod) při běžícím globálním cooldownu chatu → neprojde, zpráva se vrátí (bez žádosti)', async () => {
  const claims: string[] = [];
  let free = true;
  const s = setup({ claim: (ws) => { claims.push(ws); return free ? () => {} : null; } });
  await s.flow.intercept(from('42', 'm1'));
  await s.flow.decide({ requestId: 1, approve: true, by: 'twitch:moda', accountId: 1 });
  assert.deepEqual(claims, [], 'ruční schválení modem si slot nebere (cooldown nastaví gif-used)');
  free = false;
  s.calls.length = 0;
  assert.equal(await s.flow.intercept(from('43', 'm2')), 'denied');
  assert.deepEqual(claims, ['rob']);
  assert.equal(s.mem.reqs.size, 1, 'žádná žádost');
  assert.equal(names(s.calls).includes('broadcast:gif-message'), false);
  assert.ok(names(s.calls).includes('restore'), 'schovaná zpráva se vrátí jako běžný odkaz');
  assert.equal(s.flow.tryReserve('robdiesalot', 'twitch', '43'), true);
  // Mod (auto) bez výjimky.
  assert.equal(await s.flow.intercept(from('44', 'm3', 'https://media1.tenor.com/m/b/other.gif', { auto: true })), 'denied');
  free = true;
  assert.equal(await s.flow.intercept(from('45', 'm4')), 'approved');
  await s.flow._idle();
});

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
  assert.deepEqual(events(s.calls, 'used')[0], { workspace: 'rob', platform: 'twitch', userId: '43', role: 'sub' }, 'divák: cooldown (s rolí)');
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

test('režim approved, odesílatel bez účtu UnityChatu: bot odpoví na zprávu („Nové GIFy teď nejsou povolené“) PŘED smazáním; UC uživatel bez odpovědi; limit 60 s; bot nedostupný → jen smazání', async () => {
  const access = async () => ({ allowed: true, until: null, cooldownUntil: null, cooldownSec: 60, requestTtlSec: 120, mode: 'approved' as const });
  const order: string[] = [];
  const replies: Array<Record<string, unknown>> = [];
  let botResult = 'ok';
  const ucUsers = new Set(['77']);
  const s = setup({
    access,
    toSender: async (_pl, userId) => (ucUsers.has(userId) ? () => {} : null),
    botReply: async (p) => { order.push(`reply:${p.messageId}`); replies.push(p); return botResult; },
    deletePlatform: async (p) => { order.push(`delete:${p.messageId}`); return 'bot'; },
  });
  // Non-UC: reply na zprávu, pak smazání (reply potřebuje rodiče).
  assert.equal(await s.flow.intercept(from('42', 'm1')), 'not_allowed');
  assert.deepEqual(order, ['reply:m1', 'delete:m1']);
  assert.deepEqual(replies[0], { workspace: 'rob', platform: 'twitch', messageId: 'm1', text: GIF_NOT_ALLOWED_TEXT });
  assert.equal(GIF_NOT_ALLOWED_TEXT, 'Nové GIFy teď nejsou povolené');
  // Týž uživatel do 60 s: bez odpovědi, smaže se vždy.
  s.advance(30_000);
  assert.equal(await s.flow.intercept(from('42', 'm2')), 'not_allowed');
  assert.deepEqual(order.slice(2), ['delete:m2']);
  // Po 60 s znovu odpověď.
  s.advance(GIF_NOT_ALLOWED_REPLY_MS);
  assert.equal(await s.flow.intercept(from('42', 'm3')), 'not_allowed');
  assert.deepEqual(order.slice(3), ['reply:m3', 'delete:m3']);
  // UC uživatel: štítek (gif-notice), bez odpovědi bota.
  assert.equal(await s.flow.intercept(from('77', 'm4')), 'not_allowed');
  assert.deepEqual(order.slice(5), ['delete:m4']);
  // Bot nedostupný → jen smazání (bez výjimky); jiný uživatel po limitu kanálu (10 s).
  botResult = 'error:bot_unavailable';
  s.advance(GIF_NOT_ALLOWED_REPLY_CHANNEL_MS);
  assert.equal(await s.flow.intercept(from('43', 'm5')), 'not_allowed');
  assert.deepEqual(order.slice(6), ['reply:m5', 'delete:m5']);
  await s.flow._idle();
  // Režim all / běžná žádost: bot neodpovídá.
  const a = setup({ botReply: async () => { order.push('reply:x'); return 'ok'; } });
  assert.equal(await a.flow.intercept(from('44', 'm6')), 'requested');
  assert.ok(!order.includes('reply:x'));
  await a.flow._idle();
});

test('odpověď bota na nepovolený GIF: účet odesílatele nezjištěn (chyba) → bez odpovědi; limit kanálu 10 s; YouTube nikdy', async () => {
  const access = async () => ({ allowed: true, until: null, cooldownUntil: null, cooldownSec: 60, requestTtlSec: 120, mode: 'approved' as const });
  const order: string[] = [];
  let fail = true;
  const s = setup({
    access,
    toSender: async () => { if (fail) throw new Error('db down'); return null; },
    botReply: async (p) => { order.push(`reply:${p.messageId}`); return 'ok'; },
    deletePlatform: async (p) => { order.push(`delete:${p.messageId}`); return 'bot'; },
  });
  // „Nevím“ (chyba dotazu na účet) → bot mlčí, zpráva se smaže.
  assert.equal(await s.flow.intercept(from('42', 'm1')), 'not_allowed');
  assert.deepEqual(order, ['delete:m1']);
  // Prokazatelně bez účtu → odpověď; jiný uživatel do 10 s → limit kanálu, jen smazání; po 10 s zase odpověď.
  fail = false;
  assert.equal(await s.flow.intercept(from('42', 'm2')), 'not_allowed');
  assert.equal(await s.flow.intercept(from('43', 'm3')), 'not_allowed');
  s.advance(GIF_NOT_ALLOWED_REPLY_CHANNEL_MS);
  assert.equal(await s.flow.intercept(from('44', 'm4')), 'not_allowed');
  assert.deepEqual(order.slice(1), ['reply:m2', 'delete:m2', 'delete:m3', 'reply:m4', 'delete:m4']);
  // YouTube: jen smazání (reply neumí, stojí kvótu).
  s.advance(GIF_NOT_ALLOWED_REPLY_MS);
  const yt = from('45', 'y1');
  yt.m = { ...yt.m, platform: 'youtube' };
  (yt as { query: object }).query = { ...yt.query, platform: 'youtube' as const };
  assert.equal(await s.flow.intercept(yt), 'not_allowed');
  assert.ok(!order.includes('reply:y1'), order.join(','));
  // Bez deps.toSender (nevím) → bez odpovědi.
  const b = setup({ access, botReply: async (p) => { order.push(`reply-b:${p.messageId}`); return 'ok'; } });
  assert.equal(await b.flow.intercept(from('46', 'b1')), 'not_allowed');
  assert.ok(!order.includes('reply-b:b1'));
  await s.flow._idle();
  await b.flow._idle();
});

test('citace rodiče smazaného kvůli GIFu (i odpověď bota): replyParentBody se vyprázdní (review I2); jiné odpovědi beze změny', async () => {
  const access = async () => ({ allowed: true, until: null, cooldownUntil: null, cooldownSec: 60, requestTtlSec: 120, mode: 'approved' as const });
  const s = setup({ access, toSender: async () => null, botReply: async () => 'ok' });
  assert.equal(await s.flow.intercept(from('42', 'm1')), 'not_allowed');
  const reply = msg({ platformMessageId: 'r1', platformUserId: '99', isReply: true, replyToMessageId: 'm1', contentRaw: { replyParentBody: 'hele https://tenor.com/view/cat-gif-1', replyParentDisplayName: 'U42' } });
  assert.equal(s.flow.scrubReplyParent(reply), true);
  assert.equal((reply.contentRaw as Record<string, unknown>).replyParentBody, null);
  assert.equal((reply.contentRaw as Record<string, unknown>).replyParentDisplayName, 'U42', 'jméno zůstává');
  const other = msg({ platformMessageId: 'r2', isReply: true, replyToMessageId: 'jina', contentRaw: { replyParentBody: 'https://example.com' } });
  assert.equal(s.flow.scrubReplyParent(other), false);
  assert.equal((other.contentRaw as Record<string, unknown>).replyParentBody, 'https://example.com');
  // Jiná platforma se stejným id ne; po 30 min se zapomene.
  const kick = msg({ platform: 'kick', platformMessageId: 'r3', isReply: true, replyToMessageId: 'm1', contentRaw: { replyParentBody: 'x' } });
  assert.equal(s.flow.scrubReplyParent(kick), false);
  s.advance(GIF_GONE_PARENT_MS);
  const late = msg({ platformMessageId: 'r4', isReply: true, replyToMessageId: 'm1', contentRaw: { replyParentBody: 'https://tenor.com/view/cat-gif-1' } });
  assert.equal(s.flow.scrubReplyParent(late), false);
  await s.flow._idle();
});

test('kolo 4 bod 4b: kanál bez bota (no_actor) → vlastní zprávu moda smaže jeho token; divák bez bota zůstane (log)', async () => {
  const access = async () => ({ allowed: true, until: null, cooldownUntil: null, cooldownSec: 60, requestTtlSec: 120, mode: 'approved' as const });
  const logs: string[] = [];
  const log = { ...quiet, info: (_o: object, m: string) => { logs.push(m); } };
  const asSender: Array<Record<string, unknown>> = [];
  // Mod (u50) má účet UnityChatu s moderátorskými scopy → smaže se jeho tokenem; divák (u42) → null (nesmí).
  const deleteAsSender = async (p: { channel: string; platform: string; messageId: string; userId: string; login: string }) => {
    asSender.push(p);
    return p.userId === '50' ? 'ok' : null;
  };
  const s = setup({ access, log, deletePlatform: async (p) => { s.calls.push(['deletePlatform', p]); return 'error:no_actor'; }, deleteAsSender });
  assert.equal(await s.flow.intercept({ ...from('50', 'm5'), auto: true }), 'not_allowed');
  assert.deepEqual(asSender.map((p) => [p.userId, p.messageId, p.channel, p.platform]), [['50', 'm5', 'robdiesalot', 'twitch']], 'jen po no_actor, vlastní zpráva');
  assert.ok(logs.some((m) => /tokenem odesílatele/.test(m)), logs.join(' | '));
  logs.length = 0;
  assert.equal(await s.flow.intercept(from('42', 'm1')), 'not_allowed');
  assert.equal(asSender.at(-1)!.userId, '42');
  assert.ok(logs.some((m) => /na platformě zůstává/.test(m)), logs.join(' | '));
  // S botem (výsledek ≠ no_actor) se token odesílatele vůbec nezkouší.
  const before = asSender.length;
  const b = setup({ access, deleteAsSender });
  assert.equal(await b.flow.intercept({ ...from('50', 'm6'), auto: true }), 'not_allowed');
  assert.equal(asSender.length, before);
  await s.flow._idle();
  await b.flow._idle();
});

test('režim approved: neznámá URL se stahuje jen přímo (bez Bright Data); bot_protection = nový GIF → smazat + approved_only', async () => {
  const told: Array<[string, Record<string, unknown>]> = [];
  const seen: Array<boolean | undefined> = [];
  const access = async () => ({ allowed: true, until: null, cooldownUntil: null, cooldownSec: 60, requestTtlSec: 120, mode: 'approved' as const });
  const s = setup({
    access,
    toSender: async () => (e: string, d: object) => { told.push([e, d as Record<string, unknown>]); },
    resolve: async (_src, hooks) => { seen.push(hooks?.noUnlock); throw new GifError('bot_protection'); },
  });
  assert.equal(await s.flow.intercept(from('42', 'm1')), 'not_allowed');
  assert.deepEqual(seen, [true], 'unlocker vypnutý');
  assert.equal(told.find(([e]) => e === 'gif-notice')![1].kind, 'approved_only');
  assert.equal(events(s.calls, 'broadcast:message-deleted')[0].reason, 'gif_not_allowed');
  assert.ok(names(s.calls).includes('deletePlatform'));
  await s.flow._idle();
  // Režim all: unlocker povolený.
  const a = setup({ resolve: async (_src, hooks) => { seen.push(hooks?.noUnlock as boolean); return resolved; } });
  await a.flow.intercept(from('42', 'm1'));
  assert.equal(seen[1], false);
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

test('test2 bod 4: náš odkaz na schválené médium (mod) → bez stahování, bez čekání na zápis dávky, okamžitá gif-message, use_count++, bez karty ani průběhu stahování', async () => {
  const s = setup();
  await s.flow.intercept(from('42', 'm1'));
  await s.flow.decide({ requestId: 1, approve: true, by: 'twitch:moda', accountId: 1 });
  assert.equal(s.mem.media.get(MEDIA)!.useCount, 1);
  await s.flow._idle();

  const told: Array<[string, Record<string, unknown>]> = [];
  let resolveCalls = 0;
  let released = false;
  let release: () => void = () => {};
  let usedAt: number | null = null;
  const b = setup({
    store: s.mem.store,
    resolve: async () => { resolveCalls++; throw new Error('nestahovat'); },
    // Čekání na zápis dávky ingestu: náš odkaz na schválené médium na něj nesmí čekat.
    sleep: () => new Promise<void>((r) => { release = () => { released = true; r(); }; }),
    used: async () => { usedAt = 1_000_000; },
    // Po schválení (gif-used) běží cooldown → přístup ho vrací (lokální / globální cooldown serveru).
    access: async () => ({ allowed: true, until: null, cooldownUntil: usedAt === null ? null : usedAt + 45_000, cooldownSec: 0, requestTtlSec: 120 }),
    toSender: async () => (e: string, d: object) => { told.push([e, d as Record<string, unknown>]); },
  });
  const own = `https://api.jouki.cz/media/gif/${MEDIA}`;
  const p = b.flow.intercept({ ...from('50', 'm9', own), auto: true, candidate: { url: own, mode: 'own' as const, mediaId: MEDIA, token: own } });
  for (let i = 0; i < 50 && !events(b.calls, 'broadcast:gif-message').length; i++) await new Promise((r) => setImmediate(r));
  assert.equal(events(b.calls, 'broadcast:gif-message').length, 1, 'gif-message dřív, než doběhne FLUSH_WAIT');
  assert.equal(released, false);
  assert.equal(await p, 'approved');
  release();
  assert.equal(resolveCalls, 0, 'náš odkaz se nikdy nestahuje');
  assert.equal(s.mem.media.get(MEDIA)!.useCount, 2, 'use_count++');
  assert.equal(names(b.calls).includes('notify:gif-pending'), false, 'bez karty');
  assert.equal(names(b.calls).includes('notify:gif-decided'), false);
  const phases = told.filter(([e]) => e === 'gif-progress').map(([, d]) => d.phase);
  assert.equal(phases.includes('download') || phases.includes('unlock'), false, `bez fáze stahování: ${phases.join(',')}`);
  const done = told.find(([e, d]) => e === 'gif-progress' && d.phase === 'done')![1];
  assert.equal(done.outcome, 'approved');
  assert.equal(done.cooldownUntil, 1_045_000, 'odesílatel se dozví konec cooldownu i při tichém schválení');
  assert.equal(done.serverNow, 1_000_000);
  await b.flow._idle();
});

test('test2 bod 4.1: tiché schválení z knihovny (divák) → done approved nese cooldownUntil; bez cooldownu null', async () => {
  const s = setup();
  await s.flow.intercept(from('42', 'm1'));
  await s.flow.decide({ requestId: 1, approve: true, by: 'twitch:moda', accountId: 1 });
  await s.flow._idle();
  const told: Array<Record<string, unknown>> = [];
  const b = setup({ store: s.mem.store, toSender: async () => (e: string, d: object) => { if (e === 'gif-progress') told.push(d as Record<string, unknown>); } });
  const own = `https://api.jouki.cz/media/gif/${MEDIA}`;
  assert.equal(await b.flow.intercept({ ...from('51', 'm8', own), candidate: { url: own, mode: 'own' as const, mediaId: MEDIA, token: own } }), 'approved');
  const done = told.find((d) => d.phase === 'done')!;
  assert.equal(done.outcome, 'approved');
  assert.equal(done.cooldownUntil, null, 'přístup bez cooldownu → null');
  await b.flow._idle();
});

test('test2 bod 4.1: GIF odkaz v cooldownu (přístup z intercept) → běžný odkaz + log + gif-notice cooldown { until }', async () => {
  const told: Array<[string, Record<string, unknown>]> = [];
  const logs: string[] = [];
  const s = setup({
    access: async () => ({ allowed: true, until: null, cooldownUntil: 1_030_000, cooldownSec: 60, requestTtlSec: 120 }),
    toSender: async () => (e: string, d: object) => { told.push([e, d as Record<string, unknown>]); },
    log: { info: (_o: object, m: string) => { logs.push(m); }, warn() {} },
  });
  assert.equal(await s.flow.intercept({ ...from('42', 'm1'), needAccess: true }), 'denied');
  assert.ok(logs.includes('gif: cooldown → běžný odkaz'), logs.join(' | '));
  const notice = told.find(([e]) => e === 'gif-notice')![1];
  assert.deepEqual([notice.kind, notice.until, notice.serverNow, notice.requestKey, notice.removed], ['cooldown', 1_030_000, 1_000_000, 'twitch:m1', false]);
  assert.equal(told.at(-1)![1].outcome, 'denied');
  // Review M2: filtr odkazů zprávu smaže (filterAct) → hláška to říká (removed: true), ne „odkaz zůstal“.
  const toldF: Array<[string, Record<string, unknown>]> = [];
  const f = setup({
    access: async () => ({ allowed: true, until: null, cooldownUntil: 1_030_000, cooldownSec: 60, requestTtlSec: 120 }),
    toSender: async () => (e: string, d: object) => { toldF.push([e, d as Record<string, unknown>]); },
  });
  assert.equal(await f.flow.intercept({ ...from('42', 'm1'), needAccess: true, filterAct: async () => {} }), 'denied');
  assert.equal(toldF.find(([e]) => e === 'gif-notice')![1].removed, true);
  // Review M1: odměně vypršel čas (until) → není to cooldown, žádná hláška.
  const toldE: Array<[string, Record<string, unknown>]> = [];
  const ex = setup({
    access: async () => ({ allowed: true, until: 999_000, cooldownUntil: 1_030_000, cooldownSec: 60, requestTtlSec: 120 }),
    toSender: async () => (e: string, d: object) => { toldE.push([e, d as Record<string, unknown>]); },
  });
  assert.equal(await ex.flow.intercept({ ...from('42', 'm1'), needAccess: true }), 'denied');
  assert.equal(toldE.some(([e]) => e === 'gif-notice'), false, 'vypršelá odměna = bez hlášky cooldownu');
  // Neodemčeno (ne cooldown) → bez hlášky.
  const told2: Array<[string, Record<string, unknown>]> = [];
  const n = setup({
    access: async () => ({ allowed: false, until: null, cooldownUntil: null, cooldownSec: 0, requestTtlSec: 300 }),
    toSender: async () => (e: string, d: object) => { told2.push([e, d as Record<string, unknown>]); },
  });
  assert.equal(await n.flow.intercept({ ...from('42', 'm1'), needAccess: true }), 'denied');
  assert.equal(told2.some(([e]) => e === 'gif-notice'), false);
});

test('test2 bod 4.1: cooldownDenied (filtr odkazů zná cooldown z cache) → log + gif-notice cooldown odesílateli', async () => {
  const told: Array<[string, Record<string, unknown>]> = [];
  const logs: string[] = [];
  const s = setup({
    toSender: async () => (e: string, d: object) => { told.push([e, d as Record<string, unknown>]); },
    log: { info: (_o: object, m: string) => { logs.push(m); }, warn() {} },
  });
  await s.flow.cooldownDenied({ m: msg({ platformMessageId: 'm7' }), ucChannel: 'robdiesalot', until: 1_020_000 });
  assert.ok(logs.includes('gif: cooldown → běžný odkaz'));
  assert.deepEqual(told, [['gif-notice', { requestKey: 'twitch:m7', channel: 'robdiesalot', platform: 'twitch', messageId: 'm7', kind: 'cooldown', until: 1_020_000, serverNow: 1_000_000, removed: false }]]);
  // Review M2: zprávu pak smaže běžný filtr odkazů → removed: true (klient neřekne „odkaz zůstal“).
  await s.flow.cooldownDenied({ m: msg({ platformMessageId: 'm8' }), ucChannel: 'robdiesalot', until: 1_020_000, removed: true });
  assert.equal(told.at(-1)![1].removed, true);
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

test('intercept: host blokuje server → popis + grant jen odesílateli (gif-progress client_fetch bez logu tokenu), upload → žádost; médium bez URL klíče', async () => {
  const grants = createClientFetchGrants({ now: () => 1_000_000, random: () => 'tok-A' });
  const sent: Array<[string, Record<string, unknown>]> = [];
  const s = setup({
    resolve: async () => { throw new GifError('host_blocked'); },
    describe: async () => ({ url: 'https://i.imgur.com/a.gif', kind: 'gif', width: 320, height: 240, host: 'i.imgur.com' }),
    grants,
    senderAccount: async () => 7,
    clientFetchPref: async () => 'ask',
    toSender: async () => (e, d) => { sent.push([e, d as Record<string, unknown>]); },
  });
  const run = s.flow.intercept(params({ candidate: { url: 'https://imgur.com/a/8as1KiG', mode: 'page', token: 'https://imgur.com/a/8as1KiG' } }));
  await new Promise((r) => setImmediate(r));
  const cf = sent.find(([e, d]) => e === 'gif-progress' && d.phase === 'client_fetch')?.[1];
  assert.ok(cf, 'výzva odešla');
  assert.equal(cf!.token, 'tok-A'); assert.equal(cf!.url, 'https://i.imgur.com/a.gif'); assert.equal(cf!.host, 'i.imgur.com'); assert.equal(cf!.pref, 'ask'); assert.equal(cf!.pct, 50);
  assert.deepEqual(await grants.complete('tok-A', 7, gifBytes(320, 240)), { ok: true });
  assert.equal(await run, 'requested');
  const r = s.mem.reqs.get(1)!;
  assert.equal((r.meta as Record<string, unknown>).clientFetched, true);
  const m = [...s.mem.media.values()][0];
  assert.equal(m.urlNorm, null, 'URL zdroje není klíč dedupu');
  assert.equal(m.source, 'client');
  const pending = s.calls.find((c) => c[0] === 'notify:gif-pending')![1] as { media: Record<string, unknown> };
  assert.equal(pending.media.clientFetched, true);
});

test('intercept: odmítnutí / vypršení grantu → běžný odkaz (settleHeld error); bez účtu, v režimu approved a bez popisu se výzva nenabízí', async () => {
  const grants = createClientFetchGrants({ now: () => 1_000_000, random: () => 'tok-B' });
  const sent: string[] = [];
  const mk = (over: Partial<GifFlowDeps>) => setup({ resolve: async () => { throw new GifError('host_blocked'); }, describe: async () => ({ url: 'https://i.imgur.com/a.gif', kind: 'gif', width: 320, height: 240, host: 'i.imgur.com' }), grants, senderAccount: async () => 7, toSender: async () => (e, d) => { sent.push(`${e}:${(d as { phase?: string }).phase ?? ''}`); }, ...over });
  const a = mk({});
  const run = a.flow.intercept(params());
  await new Promise((r) => setImmediate(r));
  assert.ok(sent.includes('gif-progress:client_fetch'));
  grants.decline('tok-B', 7);
  assert.equal(await run, 'failed');
  assert.ok(a.calls.some((c) => c[0] === 'restore'), 'zpráva obnovena jako běžný odkaz');
  sent.length = 0;
  const noAcc = mk({ toSender: async () => null });
  assert.equal(await noAcc.flow.intercept(params()), 'failed');
  assert.equal(sent.length, 0);
  const approved = mk({ access: async () => ({ allowed: true, until: null, cooldownUntil: null, cooldownSec: 60, requestTtlSec: 120, mode: 'approved' }) });
  assert.equal(await approved.flow.intercept(params()), 'not_allowed');
  assert.ok(!sent.includes('gif-progress:client_fetch'));
  const noDesc = mk({ describe: async () => null });
  assert.equal(await noDesc.flow.intercept(params()), 'failed');
  assert.ok(!sent.includes('gif-progress:client_fetch'));
});

// ---- opravná vlna po review (C1, I2, I4) ----

/** Počkat, až intercept vydá grant (jinak by odmítnutí přišlo dřív než grant a intercept visel do TTL). */
const untilGrant = async (g: { readonly size: number }) => { for (let i = 0; i < 200 && !g.size; i++) await new Promise((r) => setImmediate(r)); assert.ok(g.size > 0, 'grant vydán'); };
const blockedDesc = { url: 'https://i.imgur.com/a.gif', kind: 'gif' as const, width: 320, height: 240, host: 'i.imgur.com' };

test('review I2: notifier toSender vrací počet doručení (0 = odesílatel nemá otevřený stream)', async () => {
  let streams = 0;
  const n = createGifNotifier({ connected: () => [], isMod: async () => false, senderAccount: async () => 7, send: () => streams });
  const tell = await n.toSender('twitch', '42');
  assert.equal(tell!('gif-progress', {}), 0);
  streams = 2;
  assert.equal(tell!('gif-progress', {}), 2);
});

test('review I2: výzva nikomu nedošla (0 doručení) → grant hned zrušen, bez čekání, failed', async () => {
  const grants = createClientFetchGrants({ now: () => 1_000_000, random: () => 'tok-I2' });
  const sent: string[] = [];
  const s = setup({
    resolve: async () => { throw new GifError('host_blocked'); }, describe: async () => blockedDesc, grants,
    senderAccount: async () => 7, clientFetchPref: async () => 'ask',
    toSender: async () => (e, d) => { sent.push(`${e}:${(d as { phase?: string }).phase ?? ''}`); return 0; },
  });
  // Bez rozhodnutí grantu by intercept visel do TTL (90 s) — tady musí skončit sám.
  assert.equal(await s.flow.intercept(params()), 'failed');
  assert.equal(grants.size, 0, 'grant zrušen');
  assert.ok(s.calls.some((c) => c[0] === 'restore'), 'zpráva obnovena jako běžný odkaz');
});

test('review I2: předvolba never → bez grantu a bez výzvy', async () => {
  let issued = 0;
  const grants = createClientFetchGrants({ now: () => 1_000_000, random: () => 'tok-N' });
  const counting = { ...grants, issue: (g: Parameters<typeof grants.issue>[0]) => { issued++; return grants.issue(g); } };
  let described = 0;
  const sent: string[] = [];
  const s = setup({
    resolve: async () => { throw new GifError('host_blocked'); }, describe: async () => { described++; return blockedDesc; }, grants: counting as never,
    senderAccount: async () => 7, clientFetchPref: async () => 'never',
    toSender: async () => (e, d) => { sent.push(`${e}:${(d as { phase?: string }).phase ?? ''}`); return 1; },
  });
  assert.equal(await s.flow.intercept(params()), 'failed');
  assert.equal(issued, 0);
  assert.equal(described, 0, 'popis (unlocker) se kvůli never nepálí');
  assert.ok(!sent.includes('gif-progress:client_fetch'));
});

test('review C1: popis z chyby host_blocked (stránka už prošla unlockerem) → describe se nevolá, grant s tímto popisem', async () => {
  const grants = createClientFetchGrants({ now: () => 1_000_000, random: () => 'tok-C1' });
  let described = 0;
  const sent: Array<[string, Record<string, unknown>]> = [];
  const s = setup({
    resolve: async (_src, hooks) => { hooks?.onProgress?.({ phase: 'unlock', estimateMs: 8000, elapsedMs: 0 }); throw new GifError('host_blocked', { ...blockedDesc, url: 'https://i.imgur.com/z.gif' }); },
    describe: async () => { described++; return blockedDesc; }, grants,
    senderAccount: async () => 7, clientFetchPref: async () => 'ask',
    toSender: async () => (e, d) => { sent.push([e, d as Record<string, unknown>]); return 1; },
  });
  const run = s.flow.intercept(params());
  await untilGrant(grants);
  const cf = sent.find(([e, d]) => e === 'gif-progress' && d.phase === 'client_fetch')?.[1];
  assert.equal(cf?.url, 'https://i.imgur.com/z.gif');
  assert.equal(described, 0);
  grants.decline('tok-C1', 7);
  assert.equal(await run, 'failed');
});

test('review I4: vyčerpaný denní limit unlockeru uživatele → bez popisu a bez výzvy; popis přes unlocker se do limitu počítá', async () => {
  const grants = createClientFetchGrants({ now: () => 1_000_000, random: () => 'tok-I4' });
  let described = 0;
  const sent: string[] = [];
  const noUnlock: boolean[] = [];
  const s = setup({
    resolve: async (_src, hooks) => { noUnlock.push(!!hooks?.noUnlock); throw new GifError('host_blocked'); },
    describe: async () => { described++; return blockedDesc; }, grants,
    senderAccount: async () => 7, clientFetchPref: async () => 'ask',
    toSender: async () => (e, d) => { sent.push(`${e}:${(d as { phase?: string }).phase ?? ''}`); return 1; },
  });
  // Každý pokus: describe stránky (mode page) = jedno použití unlockeru; výzvu odesílatel odmítne.
  for (let i = 0; i < GIF_UNLOCK_PER_USER_DAY; i++) {
    const run = s.flow.intercept(from('42', `u${i}`, 'https://tenor.com/view/cat-gif-1'));
    await untilGrant(grants);
    grants.decline('tok-I4', 7);
    await run;
  }
  assert.equal(described, GIF_UNLOCK_PER_USER_DAY);
  sent.length = 0;
  assert.equal(await s.flow.intercept(from('42', 'u-last', 'https://tenor.com/view/cat-gif-1')), 'failed');
  assert.equal(described, GIF_UNLOCK_PER_USER_DAY, 'popis se už nezkouší');
  assert.ok(!sent.includes('gif-progress:client_fetch'), 'bez výzvy');
  assert.equal(noUnlock.at(-1), true);
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
  assert.deepEqual((await s.flow.mediaAction({ mediaId: MEDIA, action: 'vault', by: 'twitch:moda', accountId: 1 })).body, { ok: false, error: 'not_rejected', status: 'approved' });
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
  // Trvale zahodit (bez keepMessages = i se zprávami): 7 dní ke smazání, pak retence.
  assert.equal((await p.flow.mediaAction({ mediaId: MEDIA, action: 'purge', by: 'twitch:moda', accountId: 1 })).status, 200);
  assert.equal(p.mem.media.get(MEDIA)!.status, 'purging');
  p.advance(7 * 86_400_000);
  assert.equal(await p.flow.retentionTick(), 1);
  assert.equal(p.mem.media.size, 0);
  assert.ok(gone.includes(`p:${MEDIA}`));
});

test('odebrat z knihovny: unapprove = schválený → zamítnutý (retence, token); purge schváleného = trvale pryč; čekající ani jedno', async () => {
  const gone: string[] = [];
  const changed: string[] = [];
  const s = setup({ mediaDeleted: (id) => gone.push(id), mediaChanged: (id) => changed.push(id) });
  await s.flow.intercept(from('42', 'm1'));
  // Čekající médium: odebrat z knihovny nejde (není v ní), trvale zahodit taky ne.
  assert.deepEqual((await s.flow.mediaAction({ mediaId: MEDIA, action: 'unapprove', by: 'twitch:moda', accountId: 1 })).body, { ok: false, error: 'not_approved', status: 'pending' });
  assert.deepEqual((await s.flow.mediaAction({ mediaId: MEDIA, action: 'purge', by: 'twitch:moda', accountId: 1 })).body, { ok: false, error: 'not_rejected', status: 'pending' });
  await s.flow.decide({ requestId: 1, approve: true, by: 'twitch:moda', accountId: 1 });
  assert.equal(s.mem.media.get(MEDIA)!.status, 'approved');
  changed.length = 0;
  const out = await s.flow.mediaAction({ mediaId: MEDIA, action: 'unapprove', by: 'twitch:modb', accountId: 2 });
  assert.deepEqual(out, { status: 200, body: { ok: true, mediaId: MEDIA, action: 'unapprove' } });
  const md = s.mem.media.get(MEDIA)!;
  assert.equal(md.status, 'rejected');
  assert.equal(md.rejectedBy, 'twitch:modb');
  assert.equal(md.approvedAt, null);
  assert.deepEqual(changed, [MEDIA], 'cache /media/gif zahodit (schválené bylo veřejné)');
  // Znovu → 409.
  assert.equal((await s.flow.mediaAction({ mediaId: MEDIA, action: 'unapprove', by: 'twitch:modb', accountId: 2 })).status, 409);

  // Trvale zahodit schválený GIF (i se zprávami): purging, po 7 dnech pryč.
  const p = setup({ mediaDeleted: (id) => gone.push(`p:${id}`) });
  await p.flow.intercept(from('42', 'm1'));
  await p.flow.decide({ requestId: 1, approve: true, by: 'twitch:moda', accountId: 1 });
  assert.equal((await p.flow.mediaAction({ mediaId: MEDIA, action: 'purge', by: 'twitch:moda', accountId: 1 })).status, 200);
  assert.equal(p.mem.media.get(MEDIA)!.status, 'purging');
  p.advance(7 * 86_400_000 + 1);
  await p.flow.retentionTick();
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
  assert.equal(s.mem.rejections.get(`robdiesalot|${MEDIA}|twitch|43`), 1, 'propadnutí žádosti na zamítnuté médium = strike (audit SEC-1)');
});

test('SEC-1: nová žádost na zamítnuté médium ho nezveřejní (zůstává rejected, karta tokenRequired); propadnutí = strike → 3. pokus automaticky', async () => {
  const s = setup();
  await s.flow.intercept(from('42', 'm1'));
  await s.flow.decide({ requestId: 1, approve: false, by: 'twitch:moda', accountId: 1 });
  s.advance(1000);
  assert.equal(await s.flow.intercept(from('42', 'm2')), 'requested');
  assert.equal(s.mem.media.get(MEDIA)!.status, 'rejected', 'médium zůstává zamítnuté (jen s tokenem)');
  assert.equal(pendingView(s.mem.reqs.get(2)!).media.tokenRequired, true);
  assert.equal(pendingView(s.mem.reqs.get(1)!).media.tokenRequired, undefined);
  // Mody kartu ignorují → propadne; počítá se jako zamítnutí, takže další pokus už ke schválení nejde.
  s.advance(200_000);
  assert.equal(await s.flow.expireTick(), 1);
  assert.equal(s.mem.rejections.get(`robdiesalot|${MEDIA}|twitch|42`), 2);
  s.advance(1000);
  assert.equal(await s.flow.intercept(from('42', 'm3')), 'rejected');
  assert.equal(s.mem.reqs.size, 2, 'žádná další žádost');
  await s.flow._idle();
});

test('souběh dedupu: dvě stažení stejného obsahu → dvě média; schválení druhého přesměruje žádost na už schválené, duplikát pryč', async () => {
  const gone: string[] = [];
  const s = setup({ mediaDeleted: (id) => gone.push(id) });
  // Obě stažení doběhnou dřív, než se kterékoli uloží (sha lookup nic nenajde).
  const orig = s.mem.store.findMedia.bind(s.mem.store);
  s.mem.store.findMedia = async (ch, by) => (by.sha256 ? null : orig(ch, by));
  await s.flow.intercept(from('42', 'm1', 'https://a.cz/x.gif'));
  await s.flow.intercept(from('43', 'm2', 'https://b.cz/y.gif'));
  const dup = s.mem.reqs.get(2)!.mediaId!;
  assert.notEqual(dup, MEDIA);
  assert.equal(s.mem.media.size, 2);
  await s.flow.decide({ requestId: 1, approve: true, by: 'twitch:moda', accountId: 1 });
  s.calls.length = 0;
  await s.flow.decide({ requestId: 2, approve: true, by: 'twitch:moda', accountId: 1 });
  assert.equal(s.mem.reqs.get(2)!.mediaId, MEDIA);
  assert.equal(s.mem.media.has(dup), false);
  assert.deepEqual(gone, [dup]);
  const msg2 = events(s.calls, 'broadcast:gif-message')[0].message as Record<string, unknown>;
  assert.deepEqual(msg2.gif, { url: `http://localhost:3000/media/gif/${MEDIA}`, kind: 'gif', width: 320, height: 240 });
  assert.equal(s.mem.media.get(MEDIA)!.useCount, 2);
});

test('mediaChanged: nová žádost na známé médium, propadnutí i rozhodnutí → stav média v /media/gif znovu z DB', async () => {
  const changed: string[] = [];
  const s = setup({ mediaChanged: (id) => changed.push(id) });
  await s.flow.intercept(from('42', 'm1'));
  await s.flow.decide({ requestId: 1, approve: false, by: 'twitch:moda', accountId: 1 });
  assert.deepEqual(changed, [MEDIA], 'zamítnutí');
  await s.flow.intercept(from('43', 'm2'));
  assert.deepEqual(changed, [MEDIA], 'nová žádost na zamítnuté médium ho nezveřejní (audit SEC-1) → stav se nemění');
  s.advance(200_000);
  await s.flow.expireTick();
  assert.deepEqual(changed, [MEDIA, MEDIA], 'propadnutí');
});

test('zamítnuté médium: trvale zahodit nejdřív zamítne čekající žádosti; schválit schválí i čekající; ban12h označí médium zamítnuté', async () => {
  const p = setup();
  await p.flow.intercept(from('42', 'm1'));
  await p.flow.decide({ requestId: 1, approve: false, by: 'twitch:moda', accountId: 1 });
  await p.flow.intercept(from('43', 'm2'));
  const out = await p.flow.mediaAction({ mediaId: MEDIA, action: 'purge', by: 'twitch:moda', accountId: 1 });
  assert.equal(out.status, 200);
  assert.equal(p.mem.reqs.get(2)!.status, 'rejected');
  assert.ok(events(p.calls, 'broadcast:message-deleted').some((e) => e.messageId === 'm2' && e.reason === 'gif_rejected'));
  assert.equal(p.mem.media.get(MEDIA)!.status, 'purging');
  await p.flow._idle();

  const a = setup();
  await a.flow.intercept(from('42', 'm1'));
  await a.flow.decide({ requestId: 1, approve: false, by: 'twitch:moda', accountId: 1 });
  await a.flow.intercept(from('43', 'm2'));
  a.calls.length = 0;
  assert.equal((await a.flow.mediaAction({ mediaId: MEDIA, action: 'approve', by: 'twitch:modb', accountId: 2 })).status, 200);
  assert.equal(a.mem.reqs.get(2)!.status, 'approved');
  assert.deepEqual(events(a.calls, 'broadcast:gif-message').map((e) => e.requestId), [2]);

  // Ban na čekajícím (nikdy nezamítnutém) médiu: médium rejected → další pokus = auto zamítnuto.
  const b = setup();
  await b.flow.intercept(from('42', 'm1'));
  await b.flow.mediaAction({ mediaId: MEDIA, action: 'ban12h', by: 'twitch:moda', accountId: 1 });
  assert.equal(b.mem.media.get(MEDIA)!.status, 'rejected');
  assert.equal(await b.flow.intercept(from('44', 'm3')), 'rejected');
  await b.flow._idle();
});

test('listRejected: kurzor rejectedAt:id (stejný čas zamítnutí se neztratí mezi stránkami)', async () => {
  const s = setup();
  const at = new Date(5000);
  for (const id of ['a', 'b', 'c'].map((c) => c.repeat(32))) {
    s.mem.media.set(id, { id, channel: 'robdiesalot', status: 'rejected', kind: 'gif', width: null, height: null, sha256: id, approvedAt: null, rejectedAt: at, rejectedBy: 'x', vault: false, urlNorm: null, useCount: 0 });
  }
  const p1 = await s.mem.store.listRejected('robdiesalot', null, 2);
  assert.deepEqual(p1.map((m) => m.id[0]), ['c', 'b']);
  const p2 = await s.mem.store.listRejected('robdiesalot', { at, id: p1[1].id }, 2);
  assert.deepEqual(p2.map((m) => m.id[0]), ['a']);
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

// ---------------------------------------------------------------------------
// Náhled + dvě varianty zahození (spec 2026-09-27-gif-nahled-zahozeni-design.md)
// ---------------------------------------------------------------------------

const approvedGif = async (s: ReturnType<typeof setup>) => {
  await s.flow.intercept(from('42', 'm1'));
  await s.flow.decide({ requestId: 1, approve: true, by: 'twitch:moda', accountId: 1 });
  s.calls.length = 0;
};

test('zahodit, zprávy nechat: withdrawn — z knihovny pryč, stav před zahozením, zprávy dál vidět (bez gif-media), cache invalidována', async () => {
  const changed: string[] = [];
  const s = setup({ mediaChanged: (id) => changed.push(id) });
  await approvedGif(s);
  changed.length = 0;
  const out = await s.flow.mediaAction({ mediaId: MEDIA, action: 'purge', by: 'twitch:modb', accountId: 2, keepMessages: true });
  assert.deepEqual(out, { status: 200, body: { ok: true, mediaId: MEDIA, action: 'purge', status: 'withdrawn' } });
  const md = s.mem.media.get(MEDIA)!;
  assert.equal(md.status, 'withdrawn');
  assert.equal(md.statusBeforePurge, 'approved');
  assert.equal(md.purgedBy, 'twitch:modb');
  assert.equal(md.purgeAt, null);
  assert.deepEqual(changed, [MEDIA]);
  // Zprávy zůstávají vidět → jen lehký signál pro panely GIFů (knihovna / zahozené).
  assert.deepEqual(events(s.calls, 'broadcast:gif-media'), [{ channel: 'robdiesalot', mediaId: MEDIA, state: 'library' }]);
  assert.deepEqual((await s.mem.store.listDiscarded('robdiesalot', 'withdrawn', null, 10)).map((m) => m.id), [MEDIA]);
  // Znovu zahodit / obnovit (jen purging) / zákaz → 409.
  assert.equal((await s.flow.mediaAction({ mediaId: MEDIA, action: 'purge', by: 'x', accountId: 1 })).body.error, 'already_purged');
  assert.equal((await s.flow.mediaAction({ mediaId: MEDIA, action: 'restore', by: 'x', accountId: 1 })).body.error, 'not_purging');
  assert.equal((await s.flow.mediaAction({ mediaId: MEDIA, action: 'ban12h', by: 'x', accountId: 1 })).body.error, 'already_purged');
  // Retence (zamítnuté 14 dní i purging) stažený GIF nemaže.
  s.advance(30 * 86_400_000);
  assert.equal(await s.flow.retentionTick(), 0);
  assert.equal(s.mem.media.get(MEDIA)!.status, 'withdrawn');
});

test('zahodit, zprávy nechat u odebraného z knihovny: zprávy se znovu ukážou → gif-media visible se zprávami; unapprove → removed (M5)', async () => {
  const s = setup();
  await approvedGif(s);
  await s.flow.mediaAction({ mediaId: MEDIA, action: 'unapprove', by: 'twitch:moda', accountId: 1 });
  assert.deepEqual(events(s.calls, 'broadcast:gif-media').map((e) => [e.mediaId, e.state]), [[MEDIA, 'removed']]);
  s.calls.length = 0;
  await s.flow.mediaAction({ mediaId: MEDIA, action: 'purge', by: 'twitch:moda', accountId: 1, keepMessages: true });
  const [ev] = events(s.calls, 'broadcast:gif-media');
  assert.equal(ev.state, 'visible');
  assert.equal(ev.channel, 'robdiesalot');
  assert.deepEqual(ev.messageIds, ['twitch:gif-1'], 'jen klíče zpráv, obsah si klient dotáhne (GET /chat/messages)');
  assert.equal(ev.messages, undefined);
  assert.equal(s.mem.media.get(MEDIA)!.statusBeforePurge, 'rejected');
});

test('schválení zamítnutého ze Zamítnutých → gif-media visible se zprávami', async () => {
  const s = setup();
  await approvedGif(s);
  await s.flow.mediaAction({ mediaId: MEDIA, action: 'unapprove', by: 'twitch:moda', accountId: 1 });
  s.calls.length = 0;
  await s.flow.mediaAction({ mediaId: MEDIA, action: 'approve', by: 'twitch:moda', accountId: 1 });
  assert.deepEqual(events(s.calls, 'broadcast:gif-media').map((e) => e.state), ['visible']);
});

test('odstranit ze serveru: jen withdrawn → unavailable, tombstone v cache, gif-media unavailable; nevratné', async () => {
  const gone: string[] = [];
  const s = setup({ mediaDeleted: (id) => gone.push(id) });
  await approvedGif(s);
  assert.equal((await s.flow.mediaAction({ mediaId: MEDIA, action: 'remove-file', by: 'x', accountId: 1 })).body.error, 'not_withdrawn');
  await s.flow.mediaAction({ mediaId: MEDIA, action: 'purge', by: 'twitch:moda', accountId: 1, keepMessages: true });
  s.calls.length = 0;
  const out = await s.flow.mediaAction({ mediaId: MEDIA, action: 'remove-file', by: 'twitch:moda', accountId: 1 });
  assert.deepEqual(out, { status: 200, body: { ok: true, mediaId: MEDIA, action: 'remove-file', status: 'unavailable' } });
  assert.equal(s.mem.media.get(MEDIA)!.status, 'unavailable');
  assert.deepEqual(gone, [MEDIA]);
  assert.deepEqual(events(s.calls, 'broadcast:gif-media').map((e) => [e.mediaId, e.state, e.messageIds]), [[MEDIA, 'unavailable', undefined]]);
  assert.equal((await s.flow.mediaAction({ mediaId: MEDIA, action: 'remove-file', by: 'x', accountId: 1 })).status, 409);
  assert.equal((await s.flow.mediaAction({ mediaId: MEDIA, action: 'restore', by: 'x', accountId: 1 })).status, 409);
});

test('zahodit i se zprávami: purging na 7 dní, zprávy hned schované (gif-media removed); obnovit → zpět do knihovny + zprávy', async () => {
  const s = setup();
  await approvedGif(s);
  const out = await s.flow.mediaAction({ mediaId: MEDIA, action: 'purge', by: 'twitch:moda', accountId: 1, keepMessages: false });
  assert.equal(out.status, 200);
  assert.equal(out.body.status, 'purging');
  assert.equal(out.body.purgeAt, 1_000_000 + 7 * 86_400_000);
  assert.deepEqual(events(s.calls, 'broadcast:gif-media').map((e) => e.state), ['removed']);
  s.advance(6 * 86_400_000);
  assert.equal(await s.flow.retentionTick(), 0, 'před uplynutím 7 dní se nemaže');
  s.calls.length = 0;
  const r = await s.flow.mediaAction({ mediaId: MEDIA, action: 'restore', by: 'twitch:modb', accountId: 2 });
  assert.deepEqual(r, { status: 200, body: { ok: true, mediaId: MEDIA, action: 'restore', status: 'approved' } });
  const md = s.mem.media.get(MEDIA)!;
  assert.equal(md.status, 'approved');
  assert.equal(md.purgeAt, null);
  const [ev] = events(s.calls, 'broadcast:gif-media');
  assert.equal(ev.state, 'visible');
  assert.deepEqual(ev.messageIds, ['twitch:gif-1']);
  // Obnovené médium jde znovu zahodit.
  assert.equal((await s.flow.mediaAction({ mediaId: MEDIA, action: 'purge', by: 'x', accountId: 1 })).status, 200);
});

test('obnovit zamítnutý: purging → rejected (zpět do zamítnutých), jen gif-media library (zprávy zůstávají schované)', async () => {
  const s = setup();
  await s.flow.intercept(from('42', 'm1'));
  await s.flow.decide({ requestId: 1, approve: false, by: 'twitch:moda', accountId: 1 });
  await s.flow.mediaAction({ mediaId: MEDIA, action: 'purge', by: 'twitch:moda', accountId: 1 });
  assert.deepEqual(events(s.calls, 'broadcast:gif-media').map((e) => e.state), ['library'], 'zamítnutý → purging: zprávy už byly schované, jen panely');
  assert.equal((await s.mem.store.listRejected('robdiesalot', null, 10)).length, 0, 'ze Zamítnutých zmizí');
  assert.deepEqual((await s.mem.store.listDiscarded('robdiesalot', 'purging', null, 10)).map((m) => m.id), [MEDIA]);
  s.calls.length = 0;
  const r = await s.flow.mediaAction({ mediaId: MEDIA, action: 'restore', by: 'twitch:moda', accountId: 1 });
  assert.equal(r.body.status, 'rejected');
  assert.equal(s.mem.media.get(MEDIA)!.status, 'rejected');
  assert.deepEqual(events(s.calls, 'broadcast:gif-media').map((e) => e.state), ['library']);
});

test('obnova mezi zamítnuté = nové zamítnutí: zamítnuté před 20 dny → zahozené → obnovené → retence ho nesmaže, deleteAt za 14 dní', async () => {
  const { rejectedView } = await import('../routes/gif.js');
  const s = setup();
  await s.flow.intercept(from('42', 'm1'));
  await s.flow.decide({ requestId: 1, approve: false, by: 'twitch:moda', accountId: 1 });
  s.advance(20 * 86_400_000);
  // Bez obnovy by ho retence smazala (starší 14 dní) — tady ho mod mezitím zahodil.
  await s.flow.mediaAction({ mediaId: MEDIA, action: 'purge', by: 'twitch:modb', accountId: 2 });
  s.advance(3 * 86_400_000);
  await s.flow.mediaAction({ mediaId: MEDIA, action: 'restore', by: 'twitch:modc', accountId: 3 });
  const restoredAt = s.now();
  const md = s.mem.media.get(MEDIA)!;
  assert.equal(md.rejectedAt!.getTime(), restoredAt);
  assert.equal(md.rejectedBy, 'twitch:moda', 'kdo zamítl zůstává');
  assert.equal(rejectedView(md).deleteAt, restoredAt + 14 * 86_400_000);
  assert.equal(await s.flow.retentionTick(), 0);
  s.advance(13 * 86_400_000);
  assert.equal(await s.flow.retentionTick(), 0);
  s.advance(2 * 86_400_000);
  assert.equal(await s.flow.retentionTick(), 1);
  // Bez záznamu o zamítnutí → kdo zahodil.
  const t = setup();
  await t.flow.intercept(from('42', 'm1'));
  await t.flow.decide({ requestId: 1, approve: false, by: 'twitch:moda', accountId: 1 });
  Object.assign(t.mem.media.get(MEDIA)!, { rejectedBy: null });
  await t.flow.mediaAction({ mediaId: MEDIA, action: 'purge', by: 'twitch:modb', accountId: 2 });
  Object.assign(t.mem.media.get(MEDIA)!, { statusBeforePurge: null });
  await t.flow.mediaAction({ mediaId: MEDIA, action: 'restore', by: 'twitch:modc', accountId: 3 });
  assert.equal(t.mem.media.get(MEDIA)!.status, 'rejected', 'status_before_purge NULL → rejected');
  assert.equal(t.mem.media.get(MEDIA)!.rejectedBy, 'twitch:modb');
});

test('souběh: mod schvaluje žádost na médium zahozené mezitím → žádost zamítnuta, žádná zpráva ani gif-message, odesílatel jako u zahozeného', async () => {
  const told: Array<[string, Record<string, unknown>]> = [];
  const s = setup({ toSender: async () => (ev, d) => { told.push([ev, d as Record<string, unknown>]); } });
  await s.flow.intercept(from('42', 'm1'));
  // Zahození proběhlo mezi zobrazením karty a klikem (médium mimo pending/approved/rejected).
  s.mem.media.get(MEDIA)!.status = 'withdrawn';
  s.calls.length = 0;
  const out = await s.flow.decide({ requestId: 1, approve: true, by: 'twitch:moda', accountId: 1 });
  assert.deepEqual(out, { status: 200, body: { ok: true, requestId: 1, status: 'rejected', reason: 'purged' } });
  assert.equal(s.mem.reqs.get(1)!.status, 'rejected');
  assert.equal(names(s.calls).includes('broadcast:gif-message'), false);
  assert.equal(s.mem.log.some((l) => l.startsWith('message:')), false, 'nic do archivu');
  assert.equal(names(s.calls).includes('used'), false, 'bez cooldownu');
  assert.ok(events(s.calls, 'broadcast:message-deleted').some((e) => e.messageId === 'm1' && e.reason === 'gif_rejected'));
  assert.ok(events(s.calls, 'notify:gif-decided').some((e) => e.status === 'rejected'));
  assert.ok(told.some(([ev, d]) => ev === 'gif-notice' && d.kind === 'auto_rejected' && d.reason === 'purged'));
  assert.equal(s.mem.media.get(MEDIA)!.status, 'withdrawn', 'médium se nevzkřísí');
  assert.equal(s.flow._pendingSize(), 0, 'zámek uživatele pryč');
  await s.flow._idle();
});

test('souběh: instantní schválení (známý schválený GIF) a zahození během FLUSH_WAIT → automaticky zamítnuto, bez gif-message', async () => {
  let purgeDuring: (() => Promise<unknown>) | null = null;
  const told: Array<[string, Record<string, unknown>]> = [];
  const s = setup({
    // FLUSH_WAIT: médium už je nalezené jako schválené, mod ho mezitím trvale zahodí.
    sleep: async () => { await new Promise((r) => setImmediate(r)); const f = purgeDuring; purgeDuring = null; await f?.(); },
    toSender: async () => (ev, d) => { told.push([ev, d as Record<string, unknown>]); },
  });
  await approvedGif(s);
  // DB vrací snímek řádku (ne živý objekt) — dedup vidí „approved“, zahození přijde až po něm.
  const orig = s.mem.store.findMedia.bind(s.mem.store);
  s.mem.store.findMedia = async (ch, by) => { const x = await orig(ch, by); return x ? { ...x } : x; };
  told.length = 0;
  purgeDuring =() => s.flow.mediaAction({ mediaId: MEDIA, action: 'purge', by: 'twitch:modb', accountId: 2, keepMessages: true });
  s.calls.length = 0;
  assert.equal(await s.flow.intercept(from('43', 'm2')), 'rejected');
  assert.equal(s.mem.media.get(MEDIA)!.status, 'withdrawn');
  assert.equal(names(s.calls).includes('broadcast:gif-message'), false);
  assert.equal(s.mem.reqs.get(2)!.status, 'rejected');
  assert.ok(events(s.calls, 'broadcast:message-deleted').some((e) => e.messageId === 'm2' && e.reason === 'gif_rejected'));
  assert.ok(told.some(([ev, d]) => ev === 'gif-notice' && d.kind === 'auto_rejected' && d.reason === 'purged'), JSON.stringify(told));
  await s.flow._idle();
});

test('zahození zamítne čekající žádosti v téže operaci (purgeMedia) → gif-decided rejected, původní zprávy smazané', async () => {
  const s = setup();
  await s.flow.intercept(from('42', 'm1'));
  await s.flow.decide({ requestId: 1, approve: false, by: 'twitch:moda', accountId: 1 });
  await s.flow.intercept(from('43', 'm2'));
  s.calls.length = 0;
  const out = await s.flow.mediaAction({ mediaId: MEDIA, action: 'purge', by: 'twitch:modb', accountId: 2 });
  assert.equal(out.body.requests, 1);
  assert.equal(s.mem.reqs.get(2)!.status, 'rejected');
  assert.equal(s.mem.reqs.get(2)!.decidedBy, 'twitch:modb');
  assert.ok(events(s.calls, 'notify:gif-decided').some((e) => e.requestId === 2 && e.status === 'rejected'));
  assert.ok(events(s.calls, 'broadcast:message-deleted').some((e) => e.messageId === 'm2' && e.reason === 'gif_rejected'));
  // Pozdní klik moda → 409 (už rozhodnuto).
  assert.equal((await s.flow.decide({ requestId: 2, approve: true, by: 'twitch:moda', accountId: 1 })).status, 409);
  await s.flow._idle();
});

test('purge bez keepMessages (dnešní Židolišta) = i se zprávami; obnova se souběhem dedupu → sloučení do schváleného', async () => {
  const gone: string[] = [];
  const s = setup({ mediaDeleted: (id) => gone.push(id) });
  await approvedGif(s);
  await s.flow.mediaAction({ mediaId: MEDIA, action: 'purge', by: 'zidolista', accountId: null });
  assert.equal(s.mem.media.get(MEDIA)!.status, 'purging');
  // Mezitím schválené jiné médium se stejným obsahem → obnova sloučí.
  const other = 'c'.repeat(32);
  s.mem.media.set(other, { ...s.mem.media.get(MEDIA)!, id: other, status: 'approved', statusBeforePurge: null, purgeAt: null });
  const r = await s.flow.mediaAction({ mediaId: MEDIA, action: 'restore', by: 'x', accountId: 1 });
  assert.equal(r.status, 200);
  assert.equal(s.mem.media.has(MEDIA), false);
  assert.equal(s.mem.reqs.get(1)!.mediaId, other);
  assert.deepEqual(gone, [MEDIA]);
});

test('zahozený GIF poslaný znovu = jako nikdy neviděný: odměna všechny → nová žádost (mod schválí sám), jen schválené → nepovolený; náš odkaz na zahozené = neznámý', async () => {
  for (const variant of ['withdrawn', 'purging', 'unavailable'] as const) {
    // Odměna „všechny“: nová žádost s novým médiem (zahozené zůstává zahozené), mod ho schválí rovnou.
    const s = setup();
    await approvedGif(s);
    await s.flow.mediaAction({ mediaId: MEDIA, action: 'purge', by: 'twitch:moda', accountId: 1, keepMessages: variant !== 'purging' });
    if (variant === 'unavailable') await s.flow.mediaAction({ mediaId: MEDIA, action: 'remove-file', by: 'twitch:moda', accountId: 1 });
    assert.equal(s.mem.media.get(MEDIA)!.status, variant);
    s.calls.length = 0;
    assert.equal(await s.flow.intercept(from('43', 'm2')), 'requested', `${variant}: URL → nová žádost`);
    const req = [...s.mem.reqs.values()].at(-1)!;
    assert.notEqual(req.mediaId, MEDIA, `${variant}: nové médium, ne zahozené`);
    assert.equal(s.mem.media.get(req.mediaId!)!.status, 'pending');
    assert.equal((req.meta as Record<string, unknown>).previouslyRejected, undefined, `${variant}: bez ⚠`);
    assert.ok(!events(s.calls, 'broadcast:message-deleted').some((e) => e.messageId === 'm2' && e.reason === 'gif_rejected'), `${variant}: bez gif_rejected`);
    assert.equal(await s.flow.intercept(from('46', 'm5', TENOR, { auto: true })), 'approved', `${variant}: mod schválí sám`);
    assert.equal(s.mem.media.get(MEDIA)!.status, variant, `${variant}: zahozené médium se nevzkřísí`);
    await s.flow._idle();

    // Odměna „jen schválené“: zahozený GIF je nový → nepovolený (i od moda), i náš odkaz na zahozené médium.
    const access = async () => ({ allowed: true, until: null, cooldownUntil: null, cooldownSec: 60, requestTtlSec: 120, mode: 'approved' as const });
    const a = setup({ access });
    await approvedGif(a);
    await a.flow.mediaAction({ mediaId: MEDIA, action: 'purge', by: 'twitch:moda', accountId: 1, keepMessages: variant !== 'purging' });
    if (variant === 'unavailable') await a.flow.mediaAction({ mediaId: MEDIA, action: 'remove-file', by: 'twitch:moda', accountId: 1 });
    a.calls.length = 0;
    const own = `http://localhost:3000/media/gif/${MEDIA}`;
    assert.equal(await a.flow.intercept(from('43', 'm2')), 'not_allowed', `${variant}: jen schválené → URL nepovolená`);
    assert.equal(await a.flow.intercept(from('46', 'm5', TENOR, { auto: true })), 'not_allowed', `${variant}: jen schválené → i mod`);
    assert.equal(await a.flow.intercept(from('45', 'm4', own, { candidate: { url: own, mode: 'own' as const, mediaId: MEDIA, token: own } })), 'not_allowed', `${variant}: náš odkaz na zahozené`);
    assert.ok(events(a.calls, 'broadcast:message-deleted').filter((e) => e.reason === 'gif_not_allowed').length >= 3, JSON.stringify(events(a.calls, 'broadcast:message-deleted')));
    assert.ok(!events(a.calls, 'broadcast:message-deleted').some((e) => e.reason === 'gif_rejected'));
    await a.flow._idle();
  }
});

test('setMediaRejected zahozené médium nepřepíše', async () => {
  const s = setup();
  await approvedGif(s);
  await s.flow.mediaAction({ mediaId: MEDIA, action: 'purge', by: 'twitch:moda', accountId: 1, keepMessages: true });
  await s.mem.store.setMediaRejected(MEDIA, 'x', new Date());
  assert.equal(s.mem.media.get(MEDIA)!.status, 'withdrawn');
});

test('schválení ruší tresty: zamítnuto → schváleno ze Zamítnutých → odebráno z knihovny → další poslání = běžná žádost bez ⚠', async () => {
  const s = setup();
  await s.flow.intercept(from('42', 'm1'));
  await s.flow.decide({ requestId: 1, approve: false, by: 'twitch:moda', accountId: 1 });
  assert.equal(s.mem.rejections.get(`robdiesalot|${MEDIA}|twitch|42`), 1);
  assert.equal((await s.flow.mediaAction({ mediaId: MEDIA, action: 'approve', by: 'twitch:moda', accountId: 1 })).status, 200);
  assert.equal(s.mem.rejections.size, 0, 'schválení smazalo strike');
  assert.equal((await s.flow.mediaAction({ mediaId: MEDIA, action: 'unapprove', by: 'twitch:moda', accountId: 1 })).status, 200);
  assert.equal(s.mem.rejections.size, 0, 'odebrání strike nepřidává');
  s.advance(1000);
  assert.equal(await s.flow.intercept(from('42', 'm2')), 'requested');
  assert.equal((s.mem.reqs.get(2)!.meta as Record<string, unknown>).previouslyRejected, undefined, 'bez ⚠');
  // Znovu zamítnout → 1 strike (ne 2), další poslání ke schválení s ⚠, až třetí automaticky.
  await s.flow.decide({ requestId: 2, approve: false, by: 'twitch:modb', accountId: 2 });
  assert.equal(s.mem.rejections.get(`robdiesalot|${MEDIA}|twitch|42`), 1);
  assert.equal(await s.flow.intercept(from('42', 'm3')), 'requested');
  assert.ok((s.mem.reqs.get(3)!.meta as Record<string, unknown>).previouslyRejected);
  await s.flow._idle();
});

test('schválení ruší tresty: rozhodnutí moda (2. pokus schválen) i zákaz 12 h všech uživatelů', async () => {
  const s = setup();
  await s.flow.intercept(from('42', 'm1'));
  await s.flow.decide({ requestId: 1, approve: false, by: 'twitch:moda', accountId: 1 });
  await s.flow.intercept(from('43', 'm2'));
  await s.flow.decide({ requestId: 2, approve: false, by: 'twitch:moda', accountId: 1 });
  await s.flow.mediaAction({ mediaId: MEDIA, action: 'ban12h', by: 'twitch:moda', accountId: 1 });
  assert.equal(s.mem.bans.size, 1);
  s.advance(12 * 3600_000 + 1);
  assert.equal(await s.flow.intercept(from('44', 'm3')), 'requested');
  await s.flow.decide({ requestId: 3, approve: true, by: 'twitch:moda', accountId: 1 });
  assert.equal(s.mem.rejections.size, 0, 'strike 42 i 43 pryč');
  assert.equal(s.mem.bans.size, 0, 'zákaz pryč');
  await s.flow._idle();
});

test('schválení ruší tresty: obnova zahozeného do schváleného', async () => {
  const s = setup();
  await s.flow.intercept(from('42', 'm1'));
  await s.flow.decide({ requestId: 1, approve: true, by: 'twitch:moda', accountId: 1 });
  // Legacy strike na schváleném médiu (před zavedením mazání) — obnova ho smaže taky.
  s.mem.rejections.set(`robdiesalot|${MEDIA}|twitch|42`, 1);
  await s.flow.mediaAction({ mediaId: MEDIA, action: 'purge', by: 'twitch:moda', accountId: 1 });
  assert.equal(s.mem.rejections.size, 1, 'zahození strike nemaže ani nepřidává');
  assert.equal((await s.flow.mediaAction({ mediaId: MEDIA, action: 'restore', by: 'twitch:moda', accountId: 1 })).status, 200);
  assert.equal(s.mem.rejections.size, 0);
  await s.flow._idle();
});

// ---- chat.held_settled (2026-09-27): konec čekání schované zprávy — právě jednou, na všech cestách ----

const settled = (calls: Array<[string, unknown]>) => events(calls, 'integration:chat.held_settled');
const hs = (messageId: string, outcome: string, extra: Record<string, unknown> = {}) => ({ type: 'chat.held_settled', workspace: 'rob', platform: 'twitch', messageId, outcome, ...extra });
const denyAccess = async () => ({ allowed: false, until: null, cooldownUntil: null, cooldownSec: 0, requestTtlSec: 300 });

test('held_settled: rozhodnutí modem — schváleno / zamítnuto (by = mod), jednou', async () => {
  const a = setup();
  await a.flow.intercept(from('42', 'm1'));
  assert.deepEqual(settled(a.calls), [], 'žádost čeká → held trvá');
  await a.flow.decide({ requestId: 1, approve: true, by: 'twitch:moda', accountId: 1 });
  assert.deepEqual(settled(a.calls), [hs('m1', 'approved', { requestId: 1, by: 'twitch:moda' })]);
  await a.flow.decide({ requestId: 1, approve: false, by: 'twitch:modb', accountId: 2 });
  assert.equal(settled(a.calls).length, 1, '409 nic neposílá');

  const b = setup();
  await b.flow.intercept(from('42', 'm1'));
  await b.flow.decide({ requestId: 1, approve: false, by: 'zidolista:7', accountId: null });
  assert.deepEqual(settled(b.calls), [hs('m1', 'rejected', { requestId: 1, by: 'zidolista:7' })]);
  await b.flow._idle();
});

test('held_settled: kaskáda na stejné médium → každá původní zpráva zvlášť', async () => {
  const s = setup();
  await s.flow.intercept(from('42', 'm1'));
  await s.flow.intercept(from('43', 'm2'));
  await s.flow.decide({ requestId: 1, approve: true, by: 'twitch:moda', accountId: 1 });
  assert.deepEqual(settled(s.calls).map((e) => [e.messageId, e.outcome, e.requestId]), [['m1', 'approved', 1], ['m2', 'approved', 2]]);
});

test('held_settled: propadnutí → expired, by filter; další tick nic', async () => {
  const s = setup();
  await s.flow.intercept(from('42', 'm1'));
  s.advance(120_000);
  await s.flow.expireTick();
  await s.flow.expireTick();
  assert.deepEqual(settled(s.calls), [hs('m1', 'expired', { requestId: 1, by: 'filter' })]);
  await s.flow._idle();
});

test('held_settled: instantní schválení (knihovna = filter, mod = on sám) — až po schování původní zprávy, i bez gif.decided', async () => {
  const s = setup();
  await approvedGif(s);
  assert.equal(await s.flow.intercept(from('43', 'm2')), 'approved');
  assert.deepEqual(settled(s.calls), [hs('m2', 'approved', { requestId: 2, by: 'filter' })]);
  assert.equal(events(s.calls, 'integration:gif.decided').length, 0, 'tiché rozhodnutí gif.decided dál neposílá');

  // Zobrazená zpráva (preDeleted null): held začne až publishDeleted gif_request → held_settled až po něm.
  const m = setup();
  assert.equal(await m.flow.intercept(params({ auto: true, preDeleted: null })), 'approved');
  const n = names(m.calls);
  assert.ok(n.indexOf('publishDeleted') >= 0 && n.indexOf('publishDeleted') < n.indexOf('integration:chat.held_settled'), n.join(','));
  assert.deepEqual(settled(m.calls), [hs('m1', 'approved', { requestId: 1, by: 'twitch:divak' })]);
});

test('held_settled: tiché automatické zamítnutí (opakovaně zamítnutý, zákaz, zahozený) → rejected s důvodem, by filter', async () => {
  const s = setup();
  await s.flow.intercept(from('42', 'm1'));
  await s.flow.decide({ requestId: 1, approve: false, by: 'twitch:moda', accountId: 1 });
  await s.flow.intercept(from('42', 'm2'));
  await s.flow.decide({ requestId: 2, approve: false, by: 'twitch:moda', accountId: 1 });
  s.calls.length = 0;
  assert.equal(await s.flow.intercept(from('42', 'm3')), 'rejected');
  assert.deepEqual(settled(s.calls), [hs('m3', 'rejected', { by: 'filter', reason: 'repeat' })]);
  await s.flow.mediaAction({ mediaId: MEDIA, action: 'ban12h', by: 'twitch:moda', accountId: 1 });
  s.calls.length = 0;
  assert.equal(await s.flow.intercept(from('44', 'm4')), 'rejected');
  assert.deepEqual(settled(s.calls), [hs('m4', 'rejected', { by: 'filter', reason: 'ban' })]);
  await s.flow._idle();

  // Instantní schválení na médium zahozené během zachycení → rejected (purged) s requestId, jednou.
  let purgeDuring: (() => Promise<unknown>) | null = null;
  const p = setup({ sleep: async () => { await new Promise((r) => setImmediate(r)); const f = purgeDuring; purgeDuring = null; await f?.(); } });
  await approvedGif(p);
  const orig = p.mem.store.findMedia.bind(p.mem.store);
  p.mem.store.findMedia = async (ch, by) => { const x = await orig(ch, by); return x ? { ...x } : x; };
  purgeDuring = () => p.flow.mediaAction({ mediaId: MEDIA, action: 'purge', by: 'twitch:modb', accountId: 2, keepMessages: true });
  assert.equal(await p.flow.intercept(from('43', 'm2')), 'rejected');
  assert.deepEqual(settled(p.calls), [hs('m2', 'rejected', { requestId: 2, by: 'filter', reason: 'purged' })]);
  await p.flow._idle();
});

test('held_settled: režim „jen schválené" → not_allowed; zobrazená zpráva (nikdy schovaná) nic', async () => {
  const access = async () => ({ allowed: true, until: null, cooldownUntil: null, cooldownSec: 60, requestTtlSec: 120, mode: 'approved' as const });
  const s = setup({ access });
  assert.equal(await s.flow.intercept(from('42', 'm1')), 'not_allowed');
  assert.deepEqual(settled(s.calls), [hs('m1', 'not_allowed', { by: 'filter', reason: 'approved_only' })]);
  const n = setup({ access });
  assert.equal(await n.flow.intercept(params({ preDeleted: null })), 'not_allowed');
  assert.deepEqual(settled(n.calls), [], 'held nikdy nezačal');
  await s.flow._idle();
});

test('held_settled: převod selže (too_large) → restored / link_filter s důvodem; neodemčeno → restored denied', async () => {
  const big = { resolve: async () => { throw new GifError('too_large'); } };
  const a = setup(big);
  assert.equal(await a.flow.intercept(params()), 'failed');
  assert.deepEqual(settled(a.calls), [hs('m1', 'restored', { by: 'filter', reason: 'too_large' })]);
  const b = setup(big);
  assert.equal(await b.flow.intercept(params({ filterAct: async () => {} })), 'failed');
  assert.deepEqual(settled(b.calls), [hs('m1', 'link_filter', { by: 'filter', reason: 'too_large' })]);
  const c = setup({ access: denyAccess });
  assert.equal(await c.flow.intercept(params({ needAccess: true })), 'denied');
  assert.deepEqual(settled(c.calls), [hs('m1', 'not_allowed', { by: 'filter', reason: 'no_reward' })], 'bez odměny = smazaná se štítkem');
  // Zobrazená zpráva, neodemčeno → nic (nikdy schovaná).
  const d = setup({ access: denyAccess });
  await d.flow.intercept(params({ needAccess: true, preDeleted: null }));
  assert.deepEqual(settled(d.calls), []);
  await a.flow._idle(); await b.flow._idle();
});

test('held_settled: schváleno, ale zpráva se nezapsala → held trvá; dorovnání dopíše (approved) / vzdá (giveUp → rejected, by filter)', async () => {
  const s = setup();
  await s.flow.intercept(from('42', 'm1'));
  const insert = s.mem.store.insertApprovedMessage.bind(s.mem.store);
  s.mem.store.insertApprovedMessage = async () => { throw new Error('db down'); };
  await s.flow.decide({ requestId: 1, approve: true, by: 'twitch:moda', accountId: 1 });
  assert.deepEqual(settled(s.calls), [], 'původní zpráva pořád schovaná');
  s.mem.store.insertApprovedMessage = insert;
  s.advance(61_000);
  assert.equal(await s.flow.reconcileTick(), 1);
  assert.deepEqual(settled(s.calls), [hs('m1', 'approved', { requestId: 1, by: 'twitch:moda' })]);

  const g = setup();
  await g.flow.intercept(from('42', 'm1'));
  g.mem.store.insertApprovedMessage = async () => { throw new Error('constraint'); };
  await g.flow.decide({ requestId: 1, approve: true, by: 'twitch:moda', accountId: 1 });
  g.advance(61_000);
  for (let i = 0; i < RECONCILE_MAX_ATTEMPTS; i++) await g.flow.reconcileTick();
  assert.equal(g.mem.reqs.get(1)!.status, 'rejected');
  assert.deepEqual(settled(g.calls), [hs('m1', 'rejected', { requestId: 1, by: 'filter', reason: 'reconcile:attempts' })]);
});

test('held_settled: stejná zpráva zachycená dvakrát (opakování) → neposílá se dvakrát', async () => {
  const s = setup({ access: denyAccess });
  await s.flow.intercept(params({ needAccess: true }));
  await s.flow.intercept(params({ needAccess: true }));
  assert.equal(settled(s.calls).length, 1);
  await s.flow._idle();
});

test('nový GIF v knihovně (auto-schválení moda) → gif-media library pro panely; znovu stejný (už schválený) → bez signálu', async () => {
  const s = setup();
  assert.equal(await s.flow.intercept(from('46', 'm1', TENOR, { auto: true })), 'approved');
  assert.deepEqual(events(s.calls, 'broadcast:gif-media').map((e) => [e.mediaId, e.state]), [[MEDIA, 'library']]);
  s.calls.length = 0;
  s.advance(120_000);
  assert.equal(await s.flow.intercept(from('46', 'm2', TENOR, { auto: true })), 'approved');
  assert.deepEqual(events(s.calls, 'broadcast:gif-media'), [], 'už schválené médium knihovnu nemění');
  await s.flow._idle();
});

test('zpráva s GIFem z UnityChatu drží zlaté logo i v archivu (meta.uc → isUnitychatUser / uc)', async () => {
  const s = setup();
  const p = from('46', 'm1', TENOR, { auto: true });
  p.m = { ...p.m, isUnitychatUser: true, content: `${p.m.content} \u2800` };
  assert.equal(await s.flow.intercept(p), 'approved');
  const r = s.mem.reqs.get(1)!;
  assert.equal((r.meta as Record<string, unknown>).uc, true);
  assert.equal(approvedMessageRow(r).isUnitychatUser, true);
  const gm = events(s.calls, 'broadcast:gif-message')[0]?.message as Record<string, unknown>;
  assert.equal(gm?.uc, true, 'klient dostane uc: true');
  // Bez markeru (vanilla chat) zůstává bez zlatého loga.
  const v = setup();
  assert.equal(await v.flow.intercept(from('47', 'm2', TENOR, { auto: true })), 'approved');
  assert.equal(approvedMessageRow(v.mem.reqs.get(1)!).isUnitychatUser, false);
  await s.flow._idle(); await v.flow._idle();
});
