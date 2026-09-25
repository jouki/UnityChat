import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIrcLine, normalizeTwitchPrivmsg, normalizeKickMessage, normalizeYoutubeAction, normalizeYoutubeDelete, toRow } from './normalize.js';

const IRC = '@badge-info=subscriber/12;badges=moderator/1,subscriber/12;color=#B22222;display-name=Trokner;emotes=425618:10-12;first-msg=0;id=2efb6cb3-47ec-4288-8c41-885b4147d478;mod=1;reply-parent-display-name=hlavis697;reply-parent-msg-body=Ehmm\\sco\\sje;reply-parent-msg-id=10050d7c-f53a-455f-9a3d-4a9586687739;room-id=39661750;tmi-sent-ts=1789820014396;user-id=12345 :trokner!trokner@trokner.tmi.twitch.tv PRIVMSG #robdiesalot :@hlavis697 specifick LUL build';

test('parseIrcLine rozloží tagy, prefix, command, trailing', () => {
  const p = parseIrcLine(IRC)!;
  assert.equal(p.command, 'PRIVMSG');
  assert.equal(p.tags['display-name'], 'Trokner');
  assert.equal(p.tags['tmi-sent-ts'], '1789820014396');
  assert.equal(p.trailing, '@hlavis697 specifick LUL build');
  assert.equal(p.prefix, 'trokner!trokner@trokner.tmi.twitch.tv');
});

test('normalizeTwitchPrivmsg: čas z tmi-sent-ts, reply prefix stripnutý, raw nese emotes/badges', () => {
  const m = normalizeTwitchPrivmsg(IRC, 'robdiesalot')!;
  assert.equal(m.platform, 'twitch');
  assert.equal(m.platformMessageId, '2efb6cb3-47ec-4288-8c41-885b4147d478');
  assert.equal(m.platformUserId, '12345');
  assert.equal(m.username, 'Trokner');
  assert.equal(m.channel, 'robdiesalot');
  assert.equal(m.content, 'specifick LUL build');
  assert.equal(m.sentAt.getTime(), 1789820014396);
  assert.equal(m.isReply, true);
  assert.equal(m.replyToMessageId, '10050d7c-f53a-455f-9a3d-4a9586687739');
  assert.equal(m.contentRaw.emotes, '425618:10-12');
  assert.equal(m.contentRaw.emotesOffset, 11); // délka "@hlavis697 "
  assert.equal(m.contentRaw.badges, 'moderator/1,subscriber/12');
  assert.equal(m.contentRaw.color, '#B22222');
  assert.equal(m.contentRaw.replyParentBody, 'Ehmm co je');
  assert.equal(m.isUnitychatUser, false);
});

test('normalizeTwitchPrivmsg: UC marker → isUnitychatUser, /me → action', () => {
  const line = '@display-name=Jouki;id=abc;tmi-sent-ts=1700000000000;user-id=1 :jouki!jouki@jouki.tmi.twitch.tv PRIVMSG #robdiesalot :ACTION mává ⠀';
  const m = normalizeTwitchPrivmsg(line, 'robdiesalot')!;
  assert.equal(m.isUnitychatUser, true);
  assert.equal(m.contentRaw.action, true);
  assert.equal(m.content, 'mává ⠀');
});

test('normalizeTwitchPrivmsg: bez id → null, bez tmi-sent-ts → sentAt ≈ now', () => {
  assert.equal(normalizeTwitchPrivmsg('@display-name=X :x!x@x PRIVMSG #c :hi', 'c'), null);
  const m = normalizeTwitchPrivmsg('@id=1;display-name=X :x!x@x PRIVMSG #c :hi', 'c')!;
  assert.ok(Math.abs(m.sentAt.getTime() - Date.now()) < 2000);
});

test('normalizeKickMessage: created_at ISO, identity badges, reply metadata', () => {
  const data = {
    id: 'k1', type: 'reply', content: '@Trokner jo [emote:37221:KEKW]', created_at: '2026-09-19T12:13:34.396Z',
    sender: { id: 77, username: 'mikita1977', slug: 'mikita1977', identity: { color: '#53fc18', badges: [{ type: 'moderator', text: 'Moderator' }, { type: 'subscriber', text: 'Subscriber', count: 8 }] } },
    metadata: { original_message: { id: 'k0', content: 'ahoj' }, original_sender: { id: 5, username: 'Trokner' } },
  };
  const m = normalizeKickMessage(data, 'robdiesalot')!;
  assert.equal(m.platform, 'kick');
  assert.equal(m.platformMessageId, 'k1');
  assert.equal(m.platformUserId, '77');
  assert.equal(m.username, 'mikita1977');
  assert.equal(m.content, 'jo [emote:37221:KEKW]');
  assert.equal(m.sentAt.toISOString(), '2026-09-19T12:13:34.396Z');
  assert.equal(m.isReply, true);
  assert.equal(m.replyToMessageId, 'k0');
  assert.deepEqual(m.contentRaw.badges, [{ type: 'moderator', text: 'Moderator' }, { type: 'subscriber', text: 'Subscriber', count: 8 }]);
  assert.equal(m.contentRaw.content, '@Trokner jo [emote:37221:KEKW]');
});

test('normalizeKickMessage: jiný typ eventu nebo chybějící id → null', () => {
  assert.equal(normalizeKickMessage({ type: 'something', id: 'x', content: 'a', sender: {} }, 'c'), null);
  assert.equal(normalizeKickMessage({ type: 'message', content: 'a', sender: {} }, 'c'), null);
});

test('normalizeYoutubeAction: timestampUsec → ms, handle bez @, runs uložené', () => {
  const action = { addChatItemAction: { item: { liveChatTextMessageRenderer: {
    id: 'yt1', timestampUsec: '1789820014396123',
    authorName: { simpleText: '@EricThorwaldson' }, authorExternalChannelId: 'UCabc',
    authorPhoto: { thumbnails: [{ url: 'https://yt3/x.jpg' }] },
    message: { runs: [{ text: 'ked mozu ' }, { emoji: { emojiId: 'x', shortcuts: [':grinning_face:'] } }] },
    authorBadges: [{ liveChatAuthorBadgeRenderer: { tooltip: 'Moderátor' } }],
  } } } };
  const m = normalizeYoutubeAction(action, 'robdiesalot')!;
  assert.equal(m.platform, 'youtube');
  assert.equal(m.platformMessageId, 'yt1');
  assert.equal(m.platformUserId, 'UCabc');
  assert.equal(m.username, 'EricThorwaldson');
  assert.equal(m.content, 'ked mozu :grinning_face:');
  assert.equal(m.sentAt.getTime(), 1789820014396);
  assert.deepEqual(m.contentRaw.badges, ['Moderátor']);
  assert.equal((m.contentRaw.runs as unknown[]).length, 2);
  assert.equal(m.contentRaw.superChat, false);
});

test('normalizeYoutubeAction: paid message → superChat + purchaseAmount; jiná akce → null', () => {
  const action = { addChatItemAction: { item: { liveChatPaidMessageRenderer: {
    id: 'yt2', timestampUsec: '1789820014396123', authorName: { simpleText: 'Dono' }, authorExternalChannelId: 'UCd',
    purchaseAmountText: { simpleText: '100 Kč' }, message: { runs: [{ text: 'dík' }] },
  } } } };
  const m = normalizeYoutubeAction(action, 'c')!;
  assert.equal(m.contentRaw.superChat, true);
  assert.equal(m.contentRaw.purchaseAmount, '100 Kč');
  assert.equal(normalizeYoutubeAction({ markChatItemAsDeletedAction: {} }, 'c'), null);
});

test('normalizeYoutubeDelete: markChatItemAsDeletedAction i removeChatItemAction → targetItemId, jinak null', () => {
  assert.equal(normalizeYoutubeDelete({ markChatItemAsDeletedAction: { targetItemId: 'yt-1' } }), 'yt-1');
  assert.equal(normalizeYoutubeDelete({ removeChatItemAction: { targetItemId: 'yt-1' } }), 'yt-1');
  assert.equal(normalizeYoutubeDelete({ addChatItemAction: {} }), null);
  assert.equal(normalizeYoutubeDelete({}), null);
});

test('toRow mapuje na NewMessage', () => {
  const m = normalizeTwitchPrivmsg(IRC, 'robdiesalot')!;
  const row = toRow(m);
  assert.equal(row.platform, 'twitch');
  assert.equal(row.platformMessageId, m.platformMessageId);
  assert.equal(row.platformUsername, 'Trokner');
  assert.equal(row.channel, 'robdiesalot');
  assert.equal(row.sentAt, m.sentAt);
  assert.equal(row.isReply, true);
  assert.equal(row.replyToMessageId, m.replyToMessageId);
});
