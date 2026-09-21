import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outgoingText, sendTwitch, sendKick, sendYoutube, youtubeLiveChatId, SendError, UC_MARKER } from './webSend.js';

type Call = { url: string; init: RequestInit };
function mockFetch(status: number, body: unknown, calls: Call[] = []) {
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init || {} });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}

test('outgoingText: trim, marker, příkazy bez markeru, limity', () => {
  assert.equal(outgoingText('  ahoj  '), `ahoj ${UC_MARKER}`);
  assert.equal(outgoingText('!points'), '!points');
  assert.equal(outgoingText('/me tančí'), '/me tančí');
  assert.throws(() => outgoingText('   '), /empty/);
  assert.throws(() => outgoingText('x'.repeat(501)), /too long/);
});

test('sendTwitch: Helix payload + reply, drop_reason → chyba, 401 = retryable', async () => {
  const { f, calls } = mockFetch(200, { data: [{ message_id: 'm1', is_sent: true }] });
  const r = await sendTwitch({ accessToken: 'tok', senderId: '1', broadcasterId: '160028137', text: 'hi', replyTo: 'p1' }, f);
  assert.equal(r.id, 'm1');
  assert.equal(calls[0].url, 'https://api.twitch.tv/helix/chat/messages');
  const sent = JSON.parse(calls[0].init.body as string);
  assert.deepEqual(sent, { broadcaster_id: '160028137', sender_id: '1', message: 'hi', reply_parent_message_id: 'p1' });
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer tok');

  const dropped = mockFetch(200, { data: [{ message_id: '', is_sent: false, drop_reason: { code: 'x', message: 'followers only' } }] });
  await assert.rejects(sendTwitch({ accessToken: 't', senderId: '1', broadcasterId: '2', text: 'hi' }, dropped.f), /followers only/);

  const unauth = mockFetch(401, { message: 'Invalid OAuth token' });
  await assert.rejects(sendTwitch({ accessToken: 't', senderId: '1', broadcasterId: '2', text: 'hi' }, unauth.f), (e: unknown) => e instanceof SendError && e.retryable && e.status === 401);
});

test('sendKick: public API payload, broadcaster id jako číslo', async () => {
  const { f, calls } = mockFetch(200, { data: { message_id: 'k1', is_sent: true } });
  const r = await sendKick({ accessToken: 'tok', broadcasterUserId: '92265443', text: 'hi' }, f);
  assert.equal(r.id, 'k1');
  assert.equal(calls[0].url, 'https://api.kick.com/public/v1/chat');
  assert.deepEqual(JSON.parse(calls[0].init.body as string), { broadcaster_user_id: 92265443, content: 'hi', type: 'user' });
});

test('youtube: liveChatId z videos.list, insert payload', async () => {
  const v = mockFetch(200, { items: [{ liveStreamingDetails: { activeLiveChatId: 'LC1' } }] });
  assert.equal(await youtubeLiveChatId({ accessToken: 't', videoId: 'abc' }, v.f), 'LC1');
  assert.match(v.calls[0].url, /videos\?part=liveStreamingDetails&id=abc$/);

  const none = mockFetch(200, { items: [{}] });
  assert.equal(await youtubeLiveChatId({ accessToken: 't', videoId: 'abc' }, none.f), null);

  const ins = mockFetch(200, { id: 'y1' });
  const r = await sendYoutube({ accessToken: 't', liveChatId: 'LC1', text: 'hi' }, ins.f);
  assert.equal(r.id, 'y1');
  assert.deepEqual(JSON.parse(ins.calls[0].init.body as string), { snippet: { liveChatId: 'LC1', type: 'textMessageEvent', textMessageDetails: { messageText: 'hi' } } });

  const forbidden = mockFetch(403, { error: { message: 'insufficient scope' } });
  await assert.rejects(sendYoutube({ accessToken: 't', liveChatId: 'LC1', text: 'hi' }, forbidden.f), /insufficient scope/);
});
