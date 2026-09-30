// `/user <text>` v poli pro psaní — našeptávač uživatelů kanálu pro moda (2026-09-25). Kontrakt:
// docs/superpowers/plans/2026-09-25-moderace-cast-2-kontrakt.md, sekce „Vyhledání uživatele“.
//
//   GET /moderation/users/search?channel&q&fulltext=0|1&limit    jen mod aktuálního kanálu
//
// Ochrana (v tomto pořadí): no-store hned v onRequest (i 401/403/429) → requireWebSession (401) →
// validace query (400) → rate limit na účet (429) → modGate na kanál (403 not_mod) — teprve pak dotaz do DB.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { resolveModGate } from './moderation.js';
import { RateLimiter } from './chat.js';
import { searchUsers, normalizeQuery, clampSearchLimit, USER_SEARCH_Q_MAX, type UserSearchDeps } from '../lib/userSearch.js';

export const UserSearchQuery = z.object({
  channel: z.string().min(1).max(40).optional(),
  // +1 na úvodní „@“, normalizeQuery ho zahodí a zkontroluje délku znovu.
  q: z.string().min(1).max(USER_SEARCH_Q_MAX + 1),
  fulltext: z.enum(['0', '1']).optional(),
  limit: z.string().max(3).optional(),
});

export interface UserSearchRouteDeps {
  requireSession: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  modIdentities: Parameters<typeof resolveModGate>[3];
  search: UserSearchDeps;
  defaultChannel: string;
  now?: () => number;
}

const noStore = async (_req: FastifyRequest, reply: FastifyReply) => { reply.header('Cache-Control', 'no-store'); };

export async function userSearchRoutes(app: FastifyInstance, deps: UserSearchRouteDeps) {
  // Klient dotazuje s debounce 200 ms a cache; psaní jména = pár dotazů za sekundu.
  const limiter = new RateLimiter(8, 3, deps.now);

  app.get('/moderation/users/search', { onRequest: noStore, preHandler: deps.requireSession }, async (req, reply) => {
    const parsed = UserSearchQuery.safeParse(req.query);
    const q = parsed.success ? normalizeQuery(parsed.data.q) : null;
    if (!parsed.success || !q) return reply.code(400).send({ ok: false, error: 'query' });
    const accountId = req.webAccountId!;
    if (!limiter.allow(String(accountId))) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const g = await resolveModGate(accountId, parsed.data.channel, deps.defaultChannel, deps.modIdentities);
    if ('error' in g) {
      if (g.error === 'not_mod') req.log.info({ accountId, route: req.routeOptions.url }, 'moderation: not_mod');
      return reply.code(g.error === 'channel' ? 400 : 403).send({ ok: false, error: g.error });
    }
    const fulltext = parsed.data.fulltext === '1';
    const users = await searchUsers({ channel: g.channel, q, fulltext, limit: clampSearchLimit(parsed.data.limit) }, deps.search);
    req.log.info({ accountId, channel: g.channel, qLen: q.length, fulltext, n: users.length }, 'moderation users search');
    return { ok: true, users };
  });
}
