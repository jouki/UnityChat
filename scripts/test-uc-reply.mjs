// node scripts/test-uc-reply.mjs — odpovědi napříč platformami (extension/core/uc-reply.js)
import assert from 'node:assert/strict';
import { stripReplyMention, ucReplyPayload, replyMentionRe } from '../extension/core/uc-reply.js';

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
console.log('test-uc-reply: OK');
