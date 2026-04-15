import type { FastifyRequest, FastifyReply } from 'fastify';
import { validateSession } from './session.js';

// Augment FastifyRequest to carry authed streamer id.
declare module 'fastify' {
  interface FastifyRequest {
    streamerId?: number;
  }
}

// Reads session from X-UC-Session header (extension can't send cookies across
// chrome-extension:// ↔ jouki.cz origins reliably, so header is simpler).
export async function requireSession(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const raw = req.headers['x-uc-session'];
  const sessionId = typeof raw === 'string' ? raw.trim() : '';
  if (!sessionId) {
    reply.code(401);
    return reply.send({ ok: false, error: 'No session' });
  }
  const streamerId = await validateSession(sessionId);
  if (streamerId === null) {
    reply.code(401);
    return reply.send({ ok: false, error: 'Invalid or expired session' });
  }
  req.streamerId = streamerId;
}
