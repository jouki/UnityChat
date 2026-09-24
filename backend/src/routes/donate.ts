// QR dono v UnityChatu (spec docs/superpowers/specs/2026-09-25-qr-dono-v-unitychatu-design.md):
// proxy na veřejné API donací Židolišty (RobJewsALot docs/fio-donations/04-public-api.md, 13-czk).
// Addon ani web nevolají Židolištu přímo (CORS z chrome-extension:// neprojde, nové oprávnění
// addonu user nechce). Přezdívku doplňuje server z přihlášeného účtu, klient ji nepošle.
//
//   GET  /donate/config?channel=               konfigurace formuláře (+ absolutní URL ukázek hlasů)
//   POST /donate/test-token {channel, token}   → {valid} (token ověřuje Židolišta, nikdy klient)
//   POST /donate/intents {channel, platform, currency, amount, message, ttsVoice, ttsLanguage,
//                         testToken?, markTest?, markPaid?}   (Bearer) → QR + VS + IBAN
//   GET  /donate/intents/:publicId             stav platby (klient polluje)
//
// Limity Židolišty jsou per IP → posíláme X-UC-Client-Ip (reálná IP diváka, trustProxy)
// spolu s X-Api-Key, ať se limit počítá podle diváka, ne podle backendu.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { listIdentities, requireWebSession } from '../lib/webAuth.js';
import { workspaceForChannel } from '../lib/zidolista.js';
import { RateLimiter } from './chat.js';

const base = () => config.ZIDOLISTA_API_BASE.replace(/\/$/, '');
const Channel = z.string().transform((s) => s.toLowerCase().replace(/^@/, '')).pipe(z.string().regex(/^[a-z0-9_]{1,40}$/));
const Platform = z.enum(['twitch', 'kick', 'youtube']);

const IntentBody = z.object({
  channel: Channel,
  platform: Platform,
  currency: z.enum(['EUR', 'CZK']).default('EUR'),
  amount: z.number().positive().max(10000),
  message: z.string().trim().max(300).default(''),
  ttsVoice: z.string().trim().max(64).default(''),
  ttsLanguage: z.string().trim().max(8).default('cs'),
  testToken: z.string().trim().max(200).optional(),
  markTest: z.boolean().optional(),
  markPaid: z.boolean().optional(),
}).strict();
const TokenBody = z.object({ channel: Channel, token: z.string().trim().min(1).max(200) }).strict();

/** Přezdívka pro Židolištu: display name platformy, na kterou divák píše (≤ 40 znaků, jako jejich zod). */
export function donorNickname(identity: { displayName: string | null; login: string }): string {
  return (identity.displayName?.trim() || identity.login).slice(0, 40);
}

async function slugFor(channel: string): Promise<string | null> {
  return (await workspaceForChannel('twitch', channel))?.slug ?? null;
}

/** Požadavek na Židolištu: klíč UnityChatu + IP diváka; odpověď (status + JSON) se přepošle beze změny. */
async function upstream(req: FastifyRequest, path: string, init: { method?: string; body?: unknown } = {}) {
  const r = await fetch(`${base()}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Accept: 'application/json',
      'X-Api-Key': config.ZIDOLISTA_API_KEY,
      'X-UC-Client-Ip': req.ip,
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  let json: unknown = null;
  try { json = await r.json(); } catch { /* ne-JSON odpověď */ }
  return { status: r.status, json: (json && typeof json === 'object' ? json : { ok: false, error: `upstream_${r.status}` }) as Record<string, unknown> };
}

function fail(reply: FastifyReply, e: unknown, log: FastifyInstance['log'], what: string) {
  log.warn({ err: (e as Error).message, what }, 'donate: zidolista request failed');
  return reply.code(502).send({ ok: false, error: 'zidolista_unavailable' });
}

export default async function donateRoutes(app: FastifyInstance) {
  const limiter = new RateLimiter(20, 2);        // config + stav platby (polling po 3 s)
  const writeLimiter = new RateLimiter(10, 0.2); // test-token + intents (Židolišta má vlastní přísnější)

  app.get<{ Querystring: { channel?: string } }>('/donate/config', async (req, reply) => {
    if (!limiter.allow(req.ip)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const ch = Channel.safeParse(req.query.channel ?? '');
    if (!ch.success) return reply.code(400).send({ ok: false, error: 'bad_channel' });
    reply.header('Cache-Control', 'no-store');
    const slug = await slugFor(ch.data);
    if (!slug) return { ok: true, enabled: false, reason: 'no_workspace' };
    try {
      const u = await upstream(req, `/donate/public/${encodeURIComponent(slug)}/config`);
      if (u.status !== 200) return reply.code(u.status).send(u.json);
      // Ukázky hlasů hraje klient přímo ze Židolišty (<audio> CORS nepotřebuje) → absolutní URL.
      const voices = Array.isArray(u.json.voices) ? (u.json.voices as Record<string, unknown>[]) : [];
      const withSamples = voices.map((v) => ({
        ...v,
        sampleUrl: v.sample === true && typeof v.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v.id)
          ? `${base()}/donate/public/${encodeURIComponent(slug)}/voices/${encodeURIComponent(v.id)}/sample.mp3` : null,
      }));
      return { ...u.json, voices: withSamples };
    } catch (e) { return fail(reply, e, app.log, 'config'); }
  });

  app.post('/donate/test-token', async (req, reply) => {
    if (!writeLimiter.allow(req.ip)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const b = TokenBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'invalid_body' });
    const slug = await slugFor(b.data.channel);
    if (!slug) return reply.code(404).send({ ok: false, error: 'workspace_not_found' });
    try {
      const u = await upstream(req, `/donate/public/${encodeURIComponent(slug)}/test-token`, { method: 'POST', body: { token: b.data.token } });
      // Ven jen {ok, valid}: token ani nic dalšího se klientovi nevrací.
      if (u.status !== 200) return reply.code(u.status).send({ ok: false, error: u.json.error ?? `upstream_${u.status}` });
      return { ok: true, valid: u.json.valid === true };
    } catch (e) { return fail(reply, e, app.log, 'test-token'); }
  });

  app.post('/donate/intents', { preHandler: requireWebSession }, async (req, reply) => {
    if (!writeLimiter.allow(req.ip)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const b = IntentBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'invalid_body', issues: b.error.issues.map((i) => i.path.join('.')) });
    const slug = await slugFor(b.data.channel);
    if (!slug) return reply.code(404).send({ ok: false, error: 'workspace_not_found' });
    const ident = (await listIdentities(req.webAccountId!)).find((i) => i.platform === b.data.platform);
    if (!ident) return reply.code(403).send({ ok: false, error: 'platform_not_linked' });
    const { channel: _c, platform: _p, ...rest } = b.data;
    // E-mail zatím NE: čeká na právní analýzu a úpravu zásad ochrany soukromí (spec, task „E-mail k identitě“).
    const body = { ...rest, nickname: donorNickname(ident), email: '' };
    try {
      const u = await upstream(req, `/donate/public/${encodeURIComponent(slug)}/intents`, { method: 'POST', body });
      req.log.info({ slug, platform: b.data.platform, currency: b.data.currency, status: u.status, test: !!b.data.testToken }, 'donate: intent');
      return reply.code(u.status).send(u.json);
    } catch (e) { return fail(reply, e, app.log, 'intents'); }
  });

  app.get<{ Params: { publicId: string } }>('/donate/intents/:publicId', async (req, reply) => {
    if (!limiter.allow(req.ip)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(req.params.publicId)) return reply.code(400).send({ ok: false, error: 'bad_id' });
    reply.header('Cache-Control', 'no-store');
    try {
      const u = await upstream(req, `/donate/public/intents/${encodeURIComponent(req.params.publicId)}`);
      return reply.code(u.status).send(u.json);
    } catch (e) { return fail(reply, e, app.log, 'intent-status'); }
  });
}
