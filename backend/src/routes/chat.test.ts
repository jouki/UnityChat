import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toClientMessage, toModeratedContent, RateLimiter, gifMediaGone, parseMessageKeys, messagesByKeys, MESSAGES_BY_ID_MAX } from './chat.js';
import type { Message } from '../db/schema.js';

const base: Message = {
  id: 7, platform: 'twitch', platformMessageId: 'abc', platformUserId: '1', platformUsername: 'Trokner', userId: null,
  content: 'hi LUL',
  contentRaw: { color: '#B22222', badges: 'moderator/1', emotes: '425618:3-5', emotesOffset: 0, firstMsg: false, action: false, replyParentDisplayName: 'hlavis697', replyParentBody: 'x' },
  channel: 'robdiesalot', isUnitychatUser: false, isReply: true, replyToMessageId: 'p1',
  sentAt: new Date(1789820014396), createdAt: new Date(),
  deletedAt: null, deletedBy: null, deletedReason: null,
  hiddenAt: null, hiddenBy: null,
};

test('toClientMessage: twitch', () => {
  const c = toClientMessage(base);
  assert.deepEqual(c, {
    platform: 'twitch', id: 'abc', username: 'Trokner', userId: '1', message: 'hi LUL', timestamp: 1789820014396,
    color: '#B22222', badgesRaw: 'moderator/1', twitchEmotes: '425618:3-5', twitchEmotesOffset: 0, firstMsg: false, isAction: false,
    replyTo: { username: 'hlavis697', message: 'x', id: 'p1' }, historical: true,
  });
});

test('toClientMessage: kick a youtube nesou platformní payload', () => {
  const k = toClientMessage({ ...base, platform: 'kick', contentRaw: { content: 'a [emote:1:X]', color: '#53fc18', badges: [{ type: 'moderator', text: 'Moderator' }] }, isReply: false, replyToMessageId: null });
  assert.equal(k.kickContent, 'a [emote:1:X]');
  assert.equal(k.badgesRaw, 'moderator');
  const y = toClientMessage({ ...base, platform: 'youtube', contentRaw: { runs: [{ text: 'hi' }], superChat: true, badges: ['Moderátor'] }, isReply: false, replyToMessageId: null });
  assert.deepEqual(y.ytRuns, [{ text: 'hi' }]);
  assert.equal(y.superChat, true);
  assert.equal(y.color, '#ffd600');
});

test('RateLimiter: 10 tokenů, doplňuje 10/s', () => {
  let now = 0;
  const rl = new RateLimiter(10, 10, () => now);
  for (let i = 0; i < 10; i++) assert.equal(rl.allow('ip'), true);
  assert.equal(rl.allow('ip'), false);
  now = 100; // +1 token
  assert.equal(rl.allow('ip'), true);
  assert.equal(rl.allow('ip'), false);
  assert.equal(rl.allow('other'), true);
});

test('toClientMessage: historical=false pro živé zprávy z ingestu (řádek bez id)', () => {
  const { id: _id, createdAt: _c, userId: _u, ...fresh } = base;
  const c = toClientMessage(fresh, false);
  assert.equal(c.historical, false);
  assert.equal(c.id, 'abc');
  assert.equal(c.timestamp, 1789820014396);
});

test('toClientMessage: odpověď napříč platformami z content_raw.ucReply (YouTube i Kick), nativní má přednost', () => {
  const ucReply = { platform: 'twitch', id: 'tw-9', username: 'Tonner', message: 'ahoj' };
  const yt = toClientMessage({ ...base, platform: 'youtube', isReply: false, replyToMessageId: null, contentRaw: { runs: [], ucReply } });
  assert.deepEqual(yt.replyTo, { ...ucReply, uc: true });
  const kick = toClientMessage({ ...base, platform: 'kick', isReply: false, replyToMessageId: null, contentRaw: { content: 'x', ucReply } });
  assert.equal(kick.replyTo?.id, 'tw-9');
  const native = toClientMessage({ ...base, contentRaw: { ...(base.contentRaw as object), ucReply } });
  assert.equal(native.replyTo?.id, 'p1', 'nativní odpověď platformy vyhrává');
});

test('toClientMessage: smazaná zpráva nenese obsah', () => {
  const row = { ...base, content: 'https://evil', contentRaw: { segments: [{ type: 'text', value: 'https://evil' }] }, deletedAt: new Date(), deletedReason: 'mod' };
  const m = toClientMessage(row as any, true);
  assert.equal(m.deleted, true);
  assert.equal(m.message, '');
  assert.ok(!JSON.stringify(m).includes('evil'));
});

test('toClientMessage: skrytá zpráva (Jen UC skrýt) = bez obsahu, hidden: true', () => {
  const row = { ...base, content: 'tajne', contentRaw: { emotes: 'x' }, hiddenAt: new Date(), hiddenBy: 'zidolista:7' };
  const m = toClientMessage(row as any, true);
  assert.equal(m.hidden, true);
  assert.equal(m.deleted, undefined);
  assert.equal(m.message, '');
  assert.deepEqual(m.segments, []);
  assert.equal(m.id, 'abc');
  assert.equal(m.historical, true);
  assert.ok(!JSON.stringify(m).includes('tajne'));
  assert.ok(!JSON.stringify(m).includes('zidolista'), 'kdo skryl, klient nedostane');
});

test('toClientMessage: smazaná i skrytá → deleted má přednost', () => {
  const m = toClientMessage({ ...base, deletedAt: new Date(), deletedReason: 'mod', hiddenAt: new Date() } as any);
  assert.equal(m.deleted, true);
  assert.equal(m.hidden, undefined);
});

test('toModeratedContent: smazaná i skrytá zpráva s plným obsahem (jen pro moda), bez GIFu', () => {
  const del = toModeratedContent({ ...base, content: 'tst', deletedAt: new Date(), deletedReason: 'mod', contentRaw: { ...(base.contentRaw as object), gif: { id: 'x' } } } as any);
  assert.equal(del.message, 'tst');
  assert.equal(del.deleted, true);
  assert.equal(del.deletedReason, 'mod');
  assert.equal(del.gif, undefined);
  assert.equal(del.twitchEmotes, toClientMessage(base).twitchEmotes, 'emoty jako u nesmazané zprávy');
  const hid = toModeratedContent({ ...base, content: 'tajne', hiddenAt: new Date() } as any);
  assert.equal(hid.message, 'tajne');
  assert.equal(hid.hidden, true);
  assert.equal(hid.deleted, undefined);
  // Stejný řádek přes veřejnou cestu obsah nenese.
  assert.equal(toClientMessage({ ...base, content: 'tst', deletedAt: new Date(), deletedReason: 'mod' } as any).message, '');
});

test('I2 gifMediaGone + toClientMessage: GIF odebraný z knihovny / zahozený → smazaná zpráva gif_removed bez obsahu a bez gif; dávkově', async () => {
  const A = 'a'.repeat(32), B = 'b'.repeat(32), C = 'c'.repeat(32), D = 'd'.repeat(32);
  const gifRow = (n: number, mediaId: string): Message => ({ ...base, id: n, platformMessageId: `gif-${n}`, content: 'hele lol', isReply: false, replyToMessageId: null, contentRaw: { gif: { mediaId, kind: 'gif', width: 10, height: 10, origin: 'twitch:x' } } });
  const rows = [gifRow(1, A), gifRow(2, B), gifRow(3, C), gifRow(4, D), gifRow(5, A), base];
  const asked: string[][] = [];
  const gone = await gifMediaGone(rows, async (ids) => { asked.push(ids); return new Map([[A, 'approved'], [B, 'rejected'], [C, 'pending']]); });
  assert.deepEqual(asked, [[A, B, C, D]], 'jeden dotaz, bez duplicit');
  assert.deepEqual([...gone].sort(), [B, D], 'zamítnuté (odebrané) a neexistující; čekající alias zůstává');
  const ok = toClientMessage(rows[0], true, gone);
  assert.equal(ok.gif?.url.endsWith(`/media/gif/${A}`), true);
  assert.equal(ok.message, 'hele lol');
  const removed = toClientMessage(rows[1], true, gone);
  assert.deepEqual(removed, { platform: 'twitch', id: 'gif-2', username: 'Trokner', userId: '1', message: '', timestamp: base.sentAt.getTime(), historical: true, deleted: true, deletedReason: 'gif_removed' });
  assert.equal(toClientMessage(rows[2], true, gone).gif !== undefined, true);
  assert.equal(toClientMessage(rows[3], true, gone).deletedReason, 'gif_removed');
  // Bez GIFů se DB nevolá; chyba DB = nic neschovat.
  assert.equal((await gifMediaGone([base], async () => { throw new Error('nevolat'); })).size, 0);
  assert.equal((await gifMediaGone([rows[0]], async () => { throw new Error('db'); })).size, 0);
  // Bez množiny (živé zprávy, jiná místa) beze změny.
  assert.equal(toClientMessage(rows[1]).gif !== undefined, true);
});

test('GET /chat/messages: parseMessageKeys (platné, bez duplicit, strop) + messagesByKeys (jen kanál, nesmazané, neskryté, GIF podle stavu, nejstarší první)', async () => {
  assert.deepEqual(parseMessageKeys('twitch:gif-1, kick:x ,twitch:gif-1,evil:x,youtube:', 200), [{ platform: 'twitch', messageId: 'gif-1' }, { platform: 'kick', messageId: 'x' }]);
  assert.equal(parseMessageKeys(Array.from({ length: 250 }, (_, i) => `twitch:gif-${i}`).join(','), MESSAGES_BY_ID_MAX).length, 200);
  const A = 'a'.repeat(32), P = 'b'.repeat(32);
  const row = (id: number, extra: Partial<Message> = {}): Message => ({ ...base, id, platformMessageId: `gif-${id}`, content: `t${id}`, isReply: false, replyToMessageId: null, sentAt: new Date(10_000 - id), contentRaw: { gif: { mediaId: A, kind: 'gif' } }, ...extra });
  const asked: unknown[] = [];
  const rows = [row(1), row(2), row(3, { deletedAt: new Date(), deletedReason: 'mod' }), row(4, { hiddenAt: new Date() }), row(5, { contentRaw: { gif: { mediaId: P, kind: 'gif' } } })];
  const out = await messagesByKeys(['robdiesalot'], [{ platform: 'twitch', messageId: 'gif-1' }], {
    rows: async (ch, keys) => { asked.push([ch, keys]); return rows; },
    gone: async () => new Set([P]),
  });
  assert.deepEqual(asked, [[['robdiesalot'], [{ platform: 'twitch', messageId: 'gif-1' }]]]);
  assert.deepEqual(out.map((m) => m.id), ['gif-2', 'gif-1'], 'nejstarší první, bez smazaných / skrytých / s neveřejným GIFem');
  assert.equal(out[0].gif?.url.endsWith(`/media/gif/${A}`), true);
  assert.equal(out[0].message, 't2');
});

test('gifMediaGone: zahozené GIFy v historii — withdrawn normálně, purging smazaná (gif_removed), unavailable se štítkem', async () => {
  const W = 'a'.repeat(32), P = 'b'.repeat(32), U = 'c'.repeat(32);
  const gifRow = (n: number, mediaId: string): Message => ({ ...base, id: n, platformMessageId: `gif-${n}`, content: 'hele lol', isReply: false, replyToMessageId: null, contentRaw: { gif: { mediaId, kind: 'gif', width: 10, height: 10 } } });
  const rows = [gifRow(1, W), gifRow(2, P), gifRow(3, U)];
  const gone = await gifMediaGone(rows, async () => new Map([[W, 'withdrawn'], [P, 'purging'], [U, 'unavailable']]));
  assert.deepEqual([...gone], [P]);
  assert.deepEqual([...(gone.unavailable ?? [])], [U]);
  const w = toClientMessage(rows[0], true, gone);
  assert.equal(w.gif?.unavailable, undefined);
  assert.equal(w.deleted, undefined);
  assert.equal(toClientMessage(rows[1], true, gone).deletedReason, 'gif_removed');
  const u = toClientMessage(rows[2], true, gone);
  assert.equal(u.deleted, undefined, 'zpráva zůstává');
  assert.equal(u.message, 'hele lol', 'text nad GIFem zůstává');
  assert.equal(u.gif?.unavailable, true);
  assert.equal(u.gif?.url.endsWith(`/media/gif/${U}`), true, 'URL zůstává (starší klienti: 404 → „GIF odebrán“)');
  // Jen unavailable (bez smazaných) — toClientMessage ho pozná i při prázdné množině gone.
  const onlyU = await gifMediaGone([rows[2]], async () => new Map([[U, 'unavailable']]));
  assert.equal(onlyU.size, 0);
  assert.equal(toClientMessage(rows[2], true, onlyU).gif?.unavailable, true);
});
