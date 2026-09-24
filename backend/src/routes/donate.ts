// QR dono v UnityChatu (spec docs/superpowers/specs/2026-09-25-qr-dono-v-unitychatu-design.md):
// proxy na veřejné API donací Židolišty (RobJewsALot docs/fio-donations/04-public-api.md, 13-czk).
// Addon ani web nevolají Židolištu přímo (CORS z chrome-extension:// neprojde, nové oprávnění
// addonu user nechce). Přezdívku posílá klient (předvyplněná), e-mail ověřený k účtu doplní server.
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
import QRCode from 'qrcode';
import { z } from 'zod';
import { config } from '../config.js';
import { listIdentities, requireWebSession } from '../lib/webAuth.js';
import { EMAIL_RE, normEmail } from '../lib/emailVerify.js';
import { rememberDonateNickname, verifiedEmail } from './account.js';
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
  // Přezdívka je vidět vždy (předvyplněná), e-mail jen když účet ještě nemá ověřený.
  nickname: z.string().trim().min(1).max(40),
  email: z.string().trim().max(120).optional(),
}).strict();
const TokenBody = z.object({ channel: Channel, token: z.string().trim().min(1).max(200) }).strict();

/**
 * QR řetězec (PayBySquare / SPD) → SVG. Addon nesmí načítat vzdálený kód (MV3/CWS), takže
 * QR nekreslí klient knihovnou z CDN jako web Židolišty, ale server. Úroveň opravy M jako tam.
 */
export async function qrSvg(text: string): Promise<string | null> {
  if (!text || text.length > 2000) return null;
  return QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, color: { dark: '#000000', light: '#ffffff' } });
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
    const { channel: _c, platform: _p, email: givenEmail, ...rest } = b.data;
    // E-mail: ověřený e-mail účtu má přednost, jinak ten, který divák zadal (povinný).
    // Z loginů platforem se e-mail nečte (Twitch Developer Agreement VI.C, spec „Identita“).
    const email = (await verifiedEmail(req.webAccountId!)) ?? (givenEmail ? normEmail(givenEmail) : '');
    if (!EMAIL_RE.test(email)) return reply.code(400).send({ ok: false, error: 'email_required' });
    const body = { ...rest, email };
    try {
      const u = await upstream(req, `/donate/public/${encodeURIComponent(slug)}/intents`, { method: 'POST', body });
      req.log.info({ slug, platform: b.data.platform, currency: b.data.currency, status: u.status, test: !!b.data.testToken }, 'donate: intent');
      if (u.status === 200) await rememberDonateNickname(req.webAccountId!, b.data.nickname).catch((e) => req.log.warn({ err: (e as Error).message }, 'donate: nickname save failed'));
      if (u.status === 200 && typeof u.json.qrString === 'string') {
        try { u.json.qrSvg = await qrSvg(u.json.qrString); } catch (e) { req.log.warn({ err: (e as Error).message }, 'donate: qr svg failed'); }
      }
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
