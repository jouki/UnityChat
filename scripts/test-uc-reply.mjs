// node scripts/test-uc-reply.mjs — odpovědi napříč platformami (extension/core/uc-reply.js)
import assert from 'node:assert/strict';
import { stripReplyMention, ucReplyPayload, replyMentionRe, stripLinksHtml, isReplyParentGone, replyBodyHtml } from '../extension/core/uc-reply.js';

const rt = { username: 'Tonner', id: 'x', platform: 'kick', uc: true };
// Twitch: text bez @, posun emotů o délku prefixu (code pointy)
let m = stripReplyMention({ platform: 'twitch', message: '@tonner ahoj Kappa', twitchEmotes: '25:13-17', replyTo: rt });
assert.equal(m.message, 'ahoj Kappa');
assert.equal(m.twitchEmotesOffset, 8);
// Kick: kickContent taky
m = stripReplyMention({ platform: 'kick', message: '@Tonner, ahoj', kickContent: '@Tonner, ahoj [emote:1:x]', replyTo: rt });
assert.equal(m.message, 'ahoj');
assert.equal(m.kickContent, 'ahoj [emote:1:x]');
// YouTube: první run
m = stripReplyMention({ platform: 'youtube', message: '@Tonner ahoj', ytRuns: [{ text: '@Tonner ahoj' }], replyTo: rt });
assert.deepEqual(m.ytRuns, [{ text: 'ahoj' }]);
// jiné jméno / samotná zmínka / bez replyTo → beze změny
const other = { platform: 'twitch', message: '@Jiny ahoj', replyTo: rt };
assert.equal(stripReplyMention(other), other);
const only = { platform: 'twitch', message: '@Tonner', replyTo: rt };
assert.equal(stripReplyMention(only), only);
assert.equal(stripReplyMention({ message: 'x' }).message, 'x');
// prefix jména, ne celé jméno („@Tonnerr") → nestrhávat
assert.equal(replyMentionRe('Tonner').test('@Tonnerr ahoj'), false);
// payload
assert.deepEqual(ucReplyPayload({ platform: 'twitch', messageId: 42, username: '@Tonner', message: 'hi' }), { platform: 'twitch', id: '42', username: 'Tonner', message: 'hi' });
assert.equal(ucReplyPayload({ platform: 'twitch' }), null);
// Citace rodiče (review 2026-09-27 I2): nikdy živý odkaz, smazaný rodič bez textu, emoty zůstávají.
assert.equal(stripLinksHtml('hele <a href="https://tenor.com/x" target="_blank" rel="noopener">https://tenor.com/x</a> <img class="emote" src="e">'),
  'hele <span class="uc-link-off">https://tenor.com/x</span> <img class="emote" src="e">');
const em = { renderTwitch: (t) => t.replace(/(https:\S+)/, '<a href="$1">$1</a>').replace('Kappa', '<img class="emote">'), renderKick: (t) => t, renderPlain: (t) => t };
assert.equal(replyBodyHtml({ message: 'hele https://tenor.com/x Kappa' }, 'twitch', em), ' <span class="rctx-body">hele <span class="uc-link-off">https://tenor.com/x</span> <img class="emote"></span>');
assert.equal(replyBodyHtml({ message: 'hele https://tenor.com/x' }, 'twitch', em, { parentGone: true }), '');
assert.equal(replyBodyHtml({ message: '' }, 'twitch', em), '');
assert.equal(isReplyParentGone({ deleted: true, deletedReason: 'gif_not_allowed' }), true);
assert.equal(isReplyParentGone({ _deleted: true }), true);
assert.equal(isReplyParentGone({ id: 'x' }), false);
assert.equal(isReplyParentGone(null), false);
console.log('test-uc-reply: OK');
