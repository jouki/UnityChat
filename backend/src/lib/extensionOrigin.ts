import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';

// Validate that request comes from one of our known Chrome extension IDs.
// The Origin header is set by the browser automatically for extension-origin
// fetch requests and cannot be spoofed from regular web pages (enforced by CORS).
// A malicious extension could spoof it only if it knows our extension ID, in which
// case we have bigger problems. This is a reasonable lower-bound defense.

export function parseAllowedExtensionIds(): Set<string> {
  return new Set(
    config.ALLOWED_EXTENSION_IDS.split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

export async function requireExtensionOrigin(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const allowed = parseAllowedExtensionIds();
  // If no allowed IDs configured (dev), skip check — logged as warning.
  if (allowed.size === 0) {
    req.log.warn('ALLOWED_EXTENSION_IDS empty — skipping Origin check (dev only!)');
    return;
  }

  const origin = req.headers.origin;
  if (typeof origin !== 'string') {
    reply.code(403);
    return reply.send({ ok: false, error: 'Missing Origin header' });
  }

  const match = origin.match(/^chrome-extension:\/\/([a-p]{32})\/?$/);
  if (!match || !allowed.has(match[1])) {
    reply.code(403);
    return reply.send({ ok: false, error: 'Forbidden' });
  }
}
