// „Profil“ uživatele (2026-09-25; dřív „Chat historie“ jen pro moda). Kontrakt:
// docs/superpowers/plans/2026-09-25-moderace-cast-2-kontrakt.md, sekce „Profil“.
//
//   GET /moderation/user-history/summary?channel&platform&(userId|login)     veřejná: divák / bez přihlášení
//                                                                           dostane veřejný tvar, mod plný
//   GET /moderation/user-history/messages?channel&platform&(userId|login)&inChannel&before&limit   jen mod
//   GET /moderation/user-history/donations?channel&platform&(userId|login)                         jen mod
//
// Ochrana (pokyn usera 2026-09-25 — data smí vidět jen oprávnění):
//   - všechny: `Cache-Control: no-store` hned v onRequest (i 401/403/429), validace query (400),
//   - messages + donations: requireWebSession (401) → rate limit na účet (429) → modGate na AKTUÁLNÍ kanál
//     (nemod 403 not_mod) — teprve pak jakýkoli dotaz na data nebo na Židolištu,
//   - summary: session nepovinná; rate limit per účet, bez přihlášení per IP; nemod / nepřihlášený → veřejný
//     tvar (buildPublicSummary — výběr polí dělá server, ne klient),
//   - cíl musí mít zprávu v archivu aktuálního kanálu (resolveUserTargets / userIdByLogin), jinak 404 —
//     ani podle loginu nejde procházet celý archiv,
//   - dona jen z workspace kanálu gate (registr Židolišty), slug nikdy od klienta; klíč Židolišty jen na serveru.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { resolveModGate, parseChannel, type Gate } from './moderation.js';
import { RateLimiter } from './chat.js';
import { decodeCursor } from '../lib/cursor.js';
import { bearerToken, validateWebSession } from '../lib/webAuth.js';
import { buildSummary, buildPublicSummary, buildMessages, buildDonations, clampHistoryLimit, HistoryTabsCache, type HistoryDeps, type SummaryInput } from '../lib/userHistory.js';
import type { Platform } from '../lib/zidolista.js';

const PlatformEnum = z.enum(['twitch', 'kick', 'youtube']);

export const UserHistoryQuery = z.object({
  channel: z.string().min(1).max(40).optional(),
  platform: PlatformEnum,
  userId: z.string().min(1).max(64).optional(),
  /** Bez userId = cíl podle loginu (citace v odpovědi); s userId jen do logu — server bere login z archivu. */
  login: z.string().trim().min(1).max(60).optional(),
}).refine((q) => !!q.userId || !!q.login, { message: 'userId|login', path: ['userId'] });

/** Záložka Profilu: UC kanál, nebo nenamapovaný Kick slug / YouTube handle (i '-' a '.'). */
export function parseInChannel(raw: string | undefined, fallback: string): string | null {
  const c = (raw || fallback).trim().toLowerCase().replace(/^@/, '');
  return /^[a-z0-9_.-]{1,60}$/.test(c) ? c : null;
}

export const UserHistoryMessagesQuery = z.object({
  channel: z.string().min(1).max(40).optional(),
  platform: PlatformEnum,
  userId: z.string().min(1).max(64).optional(),
  login: z.string().trim().min(1).max(60).optional(),
  /** Záložka (UC kanál); výchozí = aktuální kanál. */
  inChannel: z.string().min(1).max(61).optional(),
  before: z.string().max(40).optional(),
  limit: z.string().max(4).optional(),
}).refine((q) => !!q.userId || !!q.login, { message: 'userId|login', path: ['userId'] });

export interface UserHistoryRouteDeps {
  requireSession: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  /** Účet z Bearer tokenu, null = bez tokenu nebo neplatný (veřejný Profil). */
  optionalSession: (req: FastifyRequest) => Promise<number | null>;
  modIdentities: Parameters<typeof resolveModGate>[3];
  history: HistoryDeps;
  defaultChannel: string;
  log?: (o: object, m: string) => void;
  now?: () => number;
}

/** Nepovinná session (veřejný Profil): účet z Bearer tokenu, bez tokenu / s neplatným null. */
export async function optionalWebSession(req: FastifyRequest): Promise<number | null> {
  const raw = bearerToken(req);
  return raw ? validateWebSession(raw) : null;
}

/** no-store už před ověřením session — platí i pro 401/403/429. */
const noStore = async (_req: FastifyRequest, reply: FastifyReply) => { reply.header('Cache-Control', 'no-store'); };

const target = (g: Gate, q: { platform: Platform; userId?: string; login?: string }): SummaryInput => ({
  accountId: g.accountId, channel: g.channel, platform: q.platform, userId: q.userId ?? null, login: q.userId ? null : (q.login ?? null),
});

export async function userHistoryRoutes(app: FastifyInstance, deps: UserHistoryRouteDeps) {
  // Čtení je levnější než akce, ale scroll dělá víc dotazů; dona mají vlastní limit, ať otevření profilu
  // (summary + zprávy + starší stránka + dona) nesežere limit zpráv.
  const historyLimiter = new RateLimiter(5, 2, deps.now);
  const donationsLimiter = new RateLimiter(5, 1, deps.now);
  // Veřejný Profil bez přihlášení: per IP (za Traefikem trustProxy → skutečná IP klienta).
  const publicLimiter = new RateLimiter(10, 1, deps.now);
  const tabsCache = new HistoryTabsCache(undefined, deps.now);

  const gate = async (req: FastifyRequest, reply: FastifyReply, limiter: RateLimiter, rawChannel: string | undefined): Promise<Gate | null> => {
    const accountId = req.webAccountId!;
    if (!limiter.allow(String(accountId))) { reply.code(429).send({ ok: false, error: 'rate_limited' }); return null; }
    const g = await resolveModGate(accountId, rawChannel, deps.defaultChannel, deps.modIdentities);
    if ('error' in g) {
      if (g.error === 'not_mod') req.log.info({ accountId, route: req.routeOptions.url }, 'moderation: not_mod');
      reply.code(g.error === 'channel' ? 400 : 403).send({ ok: false, error: g.error });
      return null;
    }
    return g;
  };

  // Summary je veřejná (Profil pro všechny): bez přihlášení / neplatný token / nemod → veřejný tvar
  // (buildPublicSummary — výběr polí dělá server), mod aktuálního kanálu → plný tvar.
  app.get('/moderation/user-history/summary', { onRequest: noStore }, async (req, reply) => {
    const q = UserHistoryQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ ok: false, error: 'query' });
    const accountId = await deps.optionalSession(req);
    let g: Gate | null = null;
    if (accountId === null) {
      if (!publicLimiter.allow(`ip:${req.ip}`)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    } else {
      if (!historyLimiter.allow(String(accountId))) return reply.code(429).send({ ok: false, error: 'rate_limited' });
      const r = await resolveModGate(accountId, q.data.channel, deps.defaultChannel, deps.modIdentities);
      if ('error' in r && r.error === 'channel') return reply.code(400).send({ ok: false, error: 'channel' });
      if (!('error' in r)) g = r;
    }
    if (!g) {
      const channel = parseChannel(q.data.channel, deps.defaultChannel);
      if (!channel) return reply.code(400).send({ ok: false, error: 'channel' });
      const out = await buildPublicSummary({ channel, platform: q.data.platform, userId: q.data.userId ?? null, login: q.data.userId ? null : (q.data.login ?? null) }, deps.history);
      req.log.info({ accountId, channel, platform: q.data.platform, status: out.status }, 'user-history summary (veřejná)');
      return reply.code(out.status).send(out.body);
    }
    req.log.info({ accountId: g.accountId, channel: g.channel, platform: q.data.platform, userId: q.data.userId ?? null, login: q.data.login ?? null }, 'moderation user-history');
    const out = await buildSummary(target(g, q.data), deps.history, tabsCache);
    return reply.code(out.status).send(out.body);
  });

  app.get('/moderation/user-history/messages', { onRequest: noStore, preHandler: deps.requireSession }, async (req, reply) => {
    const q = UserHistoryMessagesQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ ok: false, error: 'query' });
    const cursor = q.data.before ? decodeCursor(q.data.before) : null;
    if (q.data.before && !cursor) return reply.code(400).send({ ok: false, error: 'before' });
    const g = await gate(req, reply, historyLimiter, q.data.channel);
    if (!g) return reply;
    const inChannel = parseInChannel(q.data.inChannel, g.channel);
    if (!inChannel) return reply.code(400).send({ ok: false, error: 'in_channel' });
    const out = await buildMessages({ ...target(g, q.data), inChannel, cursor, limit: clampHistoryLimit(q.data.limit) }, deps.history, tabsCache);
    return reply.code(out.status).send(out.body);
  });

  app.get('/moderation/user-history/donations', { onRequest: noStore, preHandler: deps.requireSession }, async (req, reply) => {
    const q = UserHistoryQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ ok: false, error: 'query' });
    const g = await gate(req, reply, donationsLimiter, q.data.channel);
    if (!g) return reply;
    const out = await buildDonations(target(g, q.data), deps.history, tabsCache);
    if (out.status === 200) req.log.info({ accountId: g.accountId, channel: g.channel, platform: q.data.platform, available: out.body.available, n: (out.body.items as unknown[]).length }, 'moderation user-history donations');
    return reply.code(out.status).send(out.body);
  });
}
