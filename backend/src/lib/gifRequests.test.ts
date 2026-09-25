import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGifFlow, createGifNotifier, approvedMessageRow, type GifFlowDeps, type GifStore, type NewGifRequest } from './gifRequests.js';
import type { GifRequest } from '../db/schema.js';
import type { IngestMessage } from '../ingest/types.js';
import { GifError, type ResolvedGif } from './gifMedia.js';
import { toClientMessage } from '../routes/chat.js';

const MEDIA = 'a'.repeat(32);
const quiet = { info() {}, warn() {} };

function memStore(now: () => number) {
  const reqs = new Map<number, GifRequest>();
  const media = new Set<string>();
  const log: string[] = [];
  let seq = 0;
  let retagOk = true;
  const store: GifStore = {
    async saveMedia() { media.add(MEDIA); return MEDIA; },
    async deleteMedia(id) { media.delete(id); log.push(`deleteMedia:${id}`); },
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
    async listPending(at) { return [...reqs.values()].filter((r) => r.status === 'pending' && r.expiresAt > at && !(r.meta as Record<string, unknown>)?.auto); },
    async markDeletedByMessage(messageId) { const r = reqs.get(Number(messageId.slice(4))); if (r?.status === 'approved') { r.status = 'deleted'; return r; } return null; },
    async insertApprovedMessage(r, at) { log.push(`message:${r.id}`); return toClientMessage(approvedMessageRow(r, at), false); },
    async retagDeleted(_p, id, from, to) { log.push(`retag:${id}:${from}->${to}`); return retagOk; },
    async statusByMessage(_p, id) { const r = [...reqs.values()].reverse().find((x) => x.messageId === id); return (r?.status as never) ?? null; },
  };
  return { store, reqs, media, log, setRetag: (v: boolean) => { retagOk = v; } };
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
  assert.deepEqual(b.body, { ok: false, error: 'already_decided', status: 'approved' });
  assert.equal((await flow.decide({ requestId: 99, approve: true, by: 'x', accountId: 1 })).status, 404);
  // Schváleno: veřejná zpráva s GIFem + /chat/stream + cooldown + soukromé gif-decided.
  const pub = calls.find((c) => c[0] === 'broadcast:gif-message')![1] as { channel: string; message: Record<string, unknown> };
  assert.equal(pub.channel, 'robdiesalot');
  assert.equal(pub.message.id, 'gif-1');
  assert.equal(pub.message.message, 'hele lol');
  assert.equal(pub.message.username, 'Divak');
  assert.equal(pub.message.badgesRaw, 'subscriber/1');
  assert.deepEqual(pub.message.gif, { url: `http://localhost:3000/media/gif/${MEDIA}`, kind: 'gif', width: 320, height: 240 });
  // Nahrazuje původní zprávu na jejím místě: stejný čas, replaces.
  assert.equal(pub.message.timestamp, 1_000_000 - 500);
  assert.equal(pub.message.replaces, 'twitch:m1');
  assert.equal(names(calls).includes('broadcast:message-deleted'), false, 'schválení původní zprávu neukazuje jako smazanou');
  assert.equal(names(calls).filter((n) => n === 'publishChat').length, 1);
  assert.deepEqual(calls.find((c) => c[0] === 'used')![1], { workspace: 'rob', platform: 'twitch', userId: '42' });
  assert.deepEqual(calls.find((c) => c[0] === 'notify:gif-decided')![1], { requestId: 1, channel: 'robdiesalot', approved: true, status: 'approved', by: 'twitch:moda' });
  assert.equal(flow.tryReserve('robdiesalot', 'twitch', '42'), true, 'po rozhodnutí smí poslat další');
});

test('decide: zamítnutí = médium pryč, bez GIFu; původní zpráva → gif_rejected (běžně smazaná); propadlá → 409 expired', async () => {
  const s = setup();
  await s.flow.intercept(params());
  s.calls.length = 0;
  assert.equal((await s.flow.decide({ requestId: 1, approve: false, by: 'twitch:moda', accountId: 1 })).status, 200);
  assert.deepEqual(s.mem.log, [`deleteMedia:${MEDIA}`, 'retag:m1:gif_request->gif_rejected']);
  assert.equal(names(s.calls).some((n) => n === 'broadcast:gif-message' || n === 'publishChat' || n === 'used'), false);
  assert.deepEqual(s.calls.find((c) => c[0] === 'broadcast:message-deleted')![1], { channel: 'robdiesalot', platform: 'twitch', messageId: 'm1', by: 'twitch:moda', reason: 'gif_rejected', at: 1_000_000 });
  assert.equal((s.calls.find((c) => c[0] === 'notify:gif-decided')![1] as { approved: boolean }).approved, false);

  const e = setup();
  await e.flow.intercept(params());
  e.advance(121_000);
  assert.deepEqual((await e.flow.decide({ requestId: 1, approve: true, by: 'twitch:moda', accountId: 1 })).body, { ok: false, error: 'already_decided', status: 'expired' });
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

test('intercept auto (mod): schváleno hned, bez Židolišty, bez gif-used, bez karet; GIF na místě původní zprávy', async () => {
  let accessCalls = 0;
  const s = setup({ access: async () => { accessCalls++; return null; } });
  assert.equal(await s.flow.intercept(params({ auto: true, query: { workspace: 'rob', platform: 'twitch', userId: '42', login: 'moda', role: 'moderator' } })), 'approved');
  assert.equal(accessCalls, 0, 'mod má vždy povoleno');
  const n = names(s.calls);
  assert.deepEqual(n.filter((x) => x.startsWith('notify:') || x.startsWith('integration:')), [], 'nikdo nic neschvaluje');
  assert.equal(n.includes('used'), false, 'mod bez cooldownu');
  assert.ok(n.indexOf('deletePlatform') > n.indexOf('broadcast:gif-message'), 'původní zpráva pryč i z platformy (až po schválení)');
  const pub = s.calls.find((c) => c[0] === 'broadcast:gif-message')![1] as { message: Record<string, unknown> };
  assert.equal(pub.message.replaces, 'twitch:m1');
  assert.equal(pub.message.timestamp, 1_000_000 - 500);
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
