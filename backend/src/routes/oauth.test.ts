// Callbacky OAuth: vypnutý streamer flow (410) a vazba bot linku na prohlížeč (login CSRF, audit C1).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TOKEN_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString('base64');
process.env.ZIDOLISTA_RETURN_ORIGINS ||= 'https://jouki.cz';

const Fastify = (await import('fastify')).default;
const oauthRoutes = (await import('./oauth.js')).default;
const { signState } = await import('../lib/session.js');
const { newBotBinding, bindCookieHeader, verifyBotBinding } = await import('./integrations.js');
import type { FastifyRequest } from 'fastify';

async function app() {
  const a = Fastify();
  await a.register(oauthRoutes);
  return a;
}

test('streamer flow: start → 410, callback se streamer state → 410 (nic se neukládá)', async () => {
  const a = await app();
  const start = await a.inject({ method: 'POST', url: '/streamers/oauth/twitch/start', headers: { origin: `chrome-extension://${'a'.repeat(32)}` } });
  assert.equal(start.statusCode, 410);
  assert.equal(start.json().error, 'gone');
  const legacy = encodeURIComponent(`${'a'.repeat(32)}.${signState({ platform: 'twitch', sessionId: 'x'.repeat(64) })}`);
  const cb = await a.inject({ method: 'GET', url: `/streamers/oauth/twitch/callback?code=abc&state=${legacy}` });
  assert.equal(cb.statusCode, 410);
  assert.match(cb.body, /zrušeno/);
  const junk = await a.inject({ method: 'GET', url: '/streamers/oauth/twitch/callback?code=abc&state=nonsense.sig' });
  assert.equal(junk.statusCode, 400);
  await a.close();
});

test('bot link: callback bez cookie z /bot/link → #bot_error=link_not_bound, k výměně kódu nedojde', async () => {
  const a = await app();
  const bind = newBotBinding();
  const state = signState({ platform: 'twitch', kind: 'bot', workspace: 'rob', returnTo: 'https://jouki.cz/admin', bindId: bind.bindId, bindHash: bind.bindHash });
  const noCookie = await a.inject({ method: 'GET', url: `/streamers/oauth/twitch/callback?code=abc&state=${encodeURIComponent(state)}` });
  assert.equal(noCookie.statusCode, 302);
  assert.equal(noCookie.headers.location, 'https://jouki.cz/admin#bot_error=link_not_bound%3Atwitch');
  const wrong = await a.inject({ method: 'GET', url: `/streamers/oauth/twitch/callback?code=abc&state=${encodeURIComponent(state)}`, headers: { cookie: `ucb_${bind.bindId}=jine-tajemstvi` } });
  assert.match(String(wrong.headers.location), /bot_error=link_not_bound/);
  // Starý state bez vazby (vydaný před touto změnou) neprojde.
  const legacy = signState({ platform: 'twitch', kind: 'bot', workspace: 'rob', returnTo: 'https://jouki.cz/admin' });
  const old = await a.inject({ method: 'GET', url: `/streamers/oauth/twitch/callback?code=abc&state=${encodeURIComponent(legacy)}` });
  assert.match(String(old.headers.location), /bot_error=link_not_bound/);
  await a.close();
});

test('bot link: verifyBotBinding přijme jen cookie se shodným tajemstvím', () => {
  const b = newBotBinding();
  const cookie = bindCookieHeader(b.bindId, b.secret);
  assert.match(cookie, /HttpOnly; Secure; SameSite=Lax/);
  assert.match(cookie, /Path=\/streamers\/oauth\//);
  const req = (c?: string) => ({ headers: { cookie: c } }) as unknown as FastifyRequest;
  const pair = cookie.split(';')[0];
  assert.equal(verifyBotBinding(req(`a=b; ${pair}`), b), true);
  assert.equal(verifyBotBinding(req(`ucb_${b.bindId}=x`), b), false);
  assert.equal(verifyBotBinding(req(), b), false);
  assert.equal(verifyBotBinding(req(pair), { bindId: b.bindId }), false);
  const other = newBotBinding();
  assert.equal(verifyBotBinding(req(pair), other), false, 'tajemství jiného linku');
});
