// Kolo štěstí pro podporovatele (spec docs/superpowers/specs/2026-10-02-kolo-stesti-design.md, logika lib/giveaway.ts).
//   GET  /giveaway?channel=                         veřejný stav (jména přihlášených, žádná id účtů), no-store
//   GET  /giveaway/me?channel=                      (session) { joined, isWinner, eligible }
//   POST /giveaway/join    { channel }              (session) jen podporovatel za 30 dní → 403 not_donor
//   POST /giveaway/confirm { channel }              (session) jen vylosovaný výherce před lhůtou
//   POST /moderation/giveaway/start { channel, prize, confirmMinutes? }   mod / streamer (modGate)
//   POST /moderation/giveaway/draw  { channel }
//   POST /moderation/giveaway/end   { channel }
// Každá změna → SSE `giveaway` na /nicknames/stream `{ channel, giveaway: State | null }`.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { giveaways, giveawayEntries, nicknames } from '../db/schema.js';
import { broadcast } from '../sse/bus.js';
import { GiveawayError, GiveawayService, ACTIVE_STATUSES, type GwRepo, type GwRow, type GwStatus, type DonorCheck } from '../lib/giveaway.js';
import { accountIdentities } from '../lib/moderationTargets.js';
import { isDonor, refreshDonors } from '../lib/donors.js';
import { workspaceForChannelSync, type Platform } from '../lib/zidolista.js';
import { sendAsBot } from '../lib/botSend.js';
import type { Ingest } from '../ingest/index.js';

const Channel = z.string().transform((s) => s.toLowerCase().replace(/^@/, '')).pipe(z.string().regex(/^[a-z0-9_]{1,40}$/));
const ChannelBody = z.object({ channel: Channel }).strict();
const StartBody = z.object({ channel: Channel, prize: z.string().max(300), confirmMinutes: z.number().int().optional() }).strict();
const PLATFORM_ORDER: Platform[] = ['twitch', 'kick', 'youtube'];
const REFRESH_EVERY_MS = 20_000;

const toRow = (r: typeof giveaways.$inferSelect): GwRow => ({ ...r, status: r.status as GwStatus });

export const dbGiveawayRepo: GwRepo = {
  async latest(channel) {
    const [r] = await db.select().from(giveaways).where(eq(giveaways.channel, channel)).orderBy(desc(giveaways.id)).limit(1);
    return r ? toRow(r) : null;
  },
  async insert(v) {
    const [r] = await db.insert(giveaways).values(v).returning();
    return toRow(r);
  },
  async update(id, patch) {
    const [r] = await db.update(giveaways).set(patch).where(eq(giveaways.id, id)).returning();
    return toRow(r);
  },
  async entries(id) {
    return db.select({ accountId: giveawayEntries.accountId, name: giveawayEntries.name, platform: giveawayEntries.platform, joinedAt: giveawayEntries.joinedAt, excluded: giveawayEntries.excluded, won: giveawayEntries.won })
      .from(giveawayEntries).where(eq(giveawayEntries.giveawayId, id)).orderBy(giveawayEntries.joinedAt);
  },
  async addEntry(id, e) {
    const r = await db.insert(giveawayEntries).values({ giveawayId: id, ...e }).onConflictDoNothing().returning({ a: giveawayEntries.accountId });
    return r.length > 0;
  },
  async patchEntry(id, accountId, patch) {
    await db.update(giveawayEntries).set(patch).where(and(eq(giveawayEntries.giveawayId, id), eq(giveawayEntries.accountId, accountId)));
  },
};

/**
 * Je účet podporovatel (kterákoli identita, lib/donors.ts — ID nebo jméno s leetspeakem)? `refresh` = jednou obnovit
 * dárce workspace ze Židolišty (donate po vyhlášení), nejvýš 1× / 20 s na workspace. Jméno pro kolo = přezdívka
 * UnityChatu, jinak zobrazované jméno (Twitch → Kick → YouTube).
 */
const lastRefresh = new Map<string, number>();
export async function accountDonorCheck(accountId: number, channel: string, refresh: boolean, log?: FastifyInstance['log']): Promise<DonorCheck> {
  const ids = (await accountIdentities(accountId)).sort((a, b) => PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform));
  const ws = workspaceForChannelSync('twitch', channel);
  if (refresh && ws && Date.now() - (lastRefresh.get(ws.slug) ?? 0) > REFRESH_EVERY_MS) {
    lastRefresh.set(ws.slug, Date.now());
    await refreshDonors(ws.slug, { log });
  }
  const pch = (p: Platform) => ws?.channels[p] || channel;
  const donorId = ids.find((i) => isDonor(i.platform, pch(i.platform), i.userId, i.login) || (i.displayName && isDonor(i.platform, pch(i.platform), null, i.displayName)));
  const main = donorId ?? ids[0];
  let name = main?.displayName || main?.login || 'Divák';
  if (main) {
    const [nick] = await db.select({ nickname: nicknames.nickname }).from(nicknames)
      .where(and(eq(nicknames.platform, main.platform), inArray(nicknames.username, [main.login, main.login.toLowerCase(), main.displayName || main.login]))).limit(1);
    if (nick?.nickname) name = nick.nickname;
  }
  return { ok: !!donorId, name: name.replace(/^@/, '').slice(0, 40), platform: main?.platform || 'twitch' };
}

export interface GiveawayDeps {
  requireSession: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  modGate: (req: FastifyRequest, reply: FastifyReply, channel: string | undefined) => Promise<{ channel: string; accountId: number; by: string } | null>;
  ingest?: Ingest;
  /** Testy: služba s pamětí místo DB. */
  service?: GiveawayService;
}

let shared: GiveawayService | null = null;

export default async function giveawayRoutes(app: FastifyInstance, deps: GiveawayDeps) {
  const svc = deps.service ?? (shared ??= new GiveawayService({
    repo: dbGiveawayRepo,
    log: app.log,
    onChange: (channel, state) => broadcast('giveaway', { channel, giveaway: state }),
    donorCheck: (acc, ch, refresh) => accountDonorCheck(acc, ch, refresh, app.log),
    // JoukiBOT na všechny platformy kanálu (workspace z registru); chyba jen do logu, kolo jede dál.
    bot: (channel, text) => {
      const ws = workspaceForChannelSync('twitch', channel);
      if (!ws) return;
      for (const p of PLATFORM_ORDER) {
        if (!ws.channels[p]) continue;
        sendAsBot({ workspace: ws.slug, platform: p, text }, { ingest: deps.ingest, log: app.log })
          .catch((e) => app.log.warn({ channel, platform: p, err: (e as Error).message }, 'giveaway: zpráva bota selhala'));
      }
    },
  }));
  if (!deps.service) {
    // Po restartu: lhůty rozběhnutých kol znovu naplánovat.
    db.selectDistinct({ channel: giveaways.channel }).from(giveaways).where(inArray(giveaways.status, [...ACTIVE_STATUSES]))
      .then((rows) => svc.resume(rows.map((r) => r.channel)))
      .catch((e) => app.log.warn({ err: (e as Error).message }, 'giveaway: obnova lhůt selhala'));
  }

  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof GiveawayError) return reply.code(e.status).send({ ok: false, error: e.code });
    app.log.warn({ err: (e as Error).message }, 'giveaway: chyba');
    return reply.code(500).send({ ok: false, error: 'internal' });
  };

  app.get<{ Querystring: { channel?: string } }>('/giveaway', async (req, reply) => {
    const ch = Channel.safeParse(req.query.channel ?? '');
    if (!ch.success) return reply.code(400).send({ ok: false, error: 'invalid_channel' });
    reply.header('Cache-Control', 'no-store');
    try { return { ok: true, giveaway: await svc.publicState(ch.data), serverNow: Date.now() }; } catch (e) { return fail(reply, e); }
  });

  app.get<{ Querystring: { channel?: string } }>('/giveaway/me', { preHandler: deps.requireSession }, async (req, reply) => {
    const ch = Channel.safeParse(req.query.channel ?? '');
    if (!ch.success) return reply.code(400).send({ ok: false, error: 'invalid_channel' });
    reply.header('Cache-Control', 'no-store');
    try { return { ok: true, ...(await svc.me(ch.data, req.webAccountId!)) }; } catch (e) { return fail(reply, e); }
  });

  for (const action of ['join', 'confirm'] as const) {
    app.post(`/giveaway/${action}`, { preHandler: deps.requireSession }, async (req, reply) => {
      const b = ChannelBody.safeParse(req.body);
      if (!b.success) return reply.code(400).send({ ok: false, error: 'invalid_body' });
      try { return { ok: true, giveaway: await svc[action](b.data.channel, req.webAccountId!) }; } catch (e) { return fail(reply, e); }
    });
  }

  app.post('/moderation/giveaway/start', { preHandler: deps.requireSession }, async (req, reply) => {
    const b = StartBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ ok: false, error: 'invalid_body' });
    const g = await deps.modGate(req, reply, b.data.channel);
    if (!g) return reply;
    try { return { ok: true, giveaway: await svc.start(g.channel, g.by, b.data.prize, b.data.confirmMinutes) }; } catch (e) { return fail(reply, e); }
  });

  for (const action of ['draw', 'end'] as const) {
    app.post(`/moderation/giveaway/${action}`, { preHandler: deps.requireSession }, async (req, reply) => {
      const b = ChannelBody.safeParse(req.body);
      if (!b.success) return reply.code(400).send({ ok: false, error: 'invalid_body' });
      const g = await deps.modGate(req, reply, b.data.channel);
      if (!g) return reply;
      try { return { ok: true, giveaway: await svc[action](g.channel, g.by) }; } catch (e) { return fail(reply, e); }
    });
  }
}
