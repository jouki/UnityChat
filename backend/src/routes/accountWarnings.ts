// Varování od moda pro uživatele UnityChatu (moderace část 2) — jen vlastní účet.
//
//   GET  /account/warnings                  (Bearer) → { ok, warnings: [{ id, channel, reason, createdAt }] }  nepotvrzená
//   POST /account/warnings/:id/ack          (Bearer) → { ok }  (cizí / neexistující / už potvrzené → 404)
//   POST /account/stream-ticket             (Bearer) → { ok, ticket, expiresInMs }  jednorázový, 60 s
//   GET  /account/stream?ticket=…           SSE jen pro tento účet: account-warning, account-warning-ack
//
// Proč ticket: EventSource neposílá Authorization; session token do URL (access log) nepatří.
// Potvrzení se rozešle ostatním spojením téhož účtu (account-warning-ack), aby okno zmizelo všude.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireWebSession } from '../lib/webAuth.js';
import { pendingWarnings, ackWarning, issueStreamTicket, consumeStreamTicket, addAccountStream, sendToAccount } from '../lib/accountWarnings.js';
import { RateLimiter } from './chat.js';

const IdParam = z.object({ id: z.coerce.number().int().positive() });

export default async function accountWarningRoutes(app: FastifyInstance) {
  const ticketLimiter = new RateLimiter(10, 0.5);

  app.get('/account/warnings', { preHandler: requireWebSession }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { ok: true, warnings: await pendingWarnings(req.webAccountId!) };
  });

  app.post('/account/warnings/:id/ack', { preHandler: requireWebSession }, async (req, reply) => {
    const p = IdParam.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ ok: false, error: 'id' });
    const accountId = req.webAccountId!;
    if (!(await ackWarning(accountId, p.data.id))) return reply.code(404).send({ ok: false, error: 'not_found' });
    sendToAccount(accountId, 'account-warning-ack', { id: p.data.id });
    return { ok: true };
  });

  app.post('/account/stream-ticket', { preHandler: requireWebSession }, async (req, reply) => {
    const accountId = req.webAccountId!;
    if (!ticketLimiter.allow(String(accountId))) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    return { ok: true, ticket: issueStreamTicket(accountId), expiresInMs: 60_000 };
  });

  app.get<{ Querystring: { ticket?: string } }>('/account/stream', async (req, reply) => {
    const ticket = String(req.query.ticket || '');
    const accountId = ticket && ticket.length <= 64 ? consumeStreamTicket(ticket) : null;
    if (accountId === null) return reply.code(401).send({ ok: false, error: 'ticket' });

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    const remove = addAccountStream(accountId, reply);
    if (!remove) { raw.write('event: error\ndata: {"error":"too_many_streams"}\n\n'); raw.end(); return; }
    raw.write(': connected\n\n');
    // Nepotvrzená varování hned po připojení (klient nemusí zvlášť volat /account/warnings).
    try {
      for (const w of await pendingWarnings(accountId)) raw.write(`event: account-warning\ndata: ${JSON.stringify(w)}\n\n`);
    } catch (e) { req.log.warn({ err: (e as Error).message }, 'account stream: varování nenačtena'); }
    req.raw.on('close', remove);
    raw.on('error', remove);
  });
}
