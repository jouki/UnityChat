// Moderace zpráv z UnityChatu (spec 2026-09-25-moderace-odkazy-gify-design.md, část 1 — mazání):
// přihlášený mod smaže zprávu na platformě, ostatní klienti se dozví hned přes SSE
// message-deleted (Task 2 lib/messageDeletes.ts), samotné smazání na platformě dělá Task 5
// lib/modActions.ts (vlastní účet moda, jinak bot workspace).
//
//   GET  /moderation/me?channel=                          (stav pro tlačítko + nabídku scopes)
//   POST /moderation/delete { channel, platform, messageId }
//   POST /moderation/user   { channel, platform, userId, action: timeout|ban|unban, durationSec?, reason? }   (část 2)
//   POST /moderation/warn   { channel, platform, userId, reason }
//   POST /moderation/permit { channel, platform, userId, durationSec, messageId? }   (messageId: obnovení zprávy smazané filtrem odkazů, část 3)
//   PUT  /moderation/nickname { channel, platform, login, nickname|null, color? }
//   GET  /moderation/user-state?channel&platform&userId   → { banned, until }
//   Kontrakt: docs/superpowers/plans/2026-09-25-moderace-cast-2-kontrakt.md
//
// Kdo smí mazat: účet, jehož NĚKTERÁ propojená identita je mod/broadcaster kanálu na SVÉ
// platformě (accountModIdentities, chatRole.ts) — mod aspoň na jedné platformě smí mazat na
// všech (deletePlatformMessage/bot to zvládne i bez vlastních scopes dané platformy).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { moderationActions, type NewModerationAction } from '../db/schema.js';
import { requireWebSession, getDecryptedIdentity } from '../lib/webAuth.js';
import { accountModIdentities, accountModPlatforms } from '../lib/chatRole.js';
import { publishDeleted, archivedMessageChannel, channelMatches } from '../lib/messageDeletes.js';
import { registryPlatformChannel } from '../lib/platformChannels.js';
import { deletePlatformMessage, banPlatformUser, unbanUser, warnUser, MAX_TIMEOUT_SEC, type ModResult, type ModDeps } from '../lib/modActions.js';
import { resolveUserTargets, dbTargetDeps, archivedUserByLogin, makeTargetRole } from '../lib/moderationTargets.js';
import { blacklistFor } from './blacklist.js';
import { containsBlacklisted } from '../lib/blacklistMatch.js';
import { publishUserModerated, recordBan, clearBan, activeBan, expectEcho, forgetEcho } from '../lib/userModeration.js';
import { runUserAction, runWarn, runPermit, runRename, MAX_PERMIT_SEC, type UserActionDeps } from '../lib/userModActions.js';
import { createWarning, sendToAccount, REASON_MAX } from '../lib/accountWarnings.js';
import { storePermits } from '../lib/linkFilter.js';
import { restoreOnPermit, publishRestored } from '../lib/linkRestore.js';
import { sendAsAccount } from '../lib/accountSend.js';
import { sendAsBot, BotSendError } from '../lib/botSend.js';
import { outgoingText } from '../lib/webSend.js';
import { defaultWorkspace } from '../lib/platformChannels.js';
import { NicknameField, ColorField, upsertNickname, deleteNickname } from './nicknames.js';
import type { Ingest } from '../ingest/index.js';
import { missingModScopes } from '../lib/modScopes.js';
import type { Platform } from '../lib/zidolista.js';
import { RateLimiter } from './chat.js';
import { config } from '../config.js';

const CHANNEL_RE = /^[a-z0-9_]{2,25}$/;

export const DeleteBody = z.object({
  platform: z.enum(['twitch', 'kick', 'youtube']),
  messageId: z.string().min(1).max(128),
  // Formát/délka kanálu se NEřeší tady regexem case-sensitive (viz parseChannel) — jinak by
  // "Rob" spadl na 400 dřív, než se stihne zlowercasovat (bug nalezený v code review).
  channel: z.string().min(1).max(40).optional(),
});

/** Kanál → lowercase → validace `^[a-z0-9_]{2,25}$` (VŽDY v tomhle pořadí, ne obráceně — jinak
 * velká písmena ve vstupu spadnou na chybu, než dostanou šanci se zlowercasovat). `null` = neplatný. */
export function parseChannel(raw: string | undefined, fallback: string): string | null {
  const c = (raw || fallback).toLowerCase();
  return CHANNEL_RE.test(c) ? c : null;
}

/** Tvar `moderation_actions.result` pro akci 'delete' — jeden klíč = zasažená platforma. */
export function resultRecord(platform: Platform, result: ModResult): Record<string, ModResult> {
  return { [platform]: result };
}

// Jen platformy, kde je účet mod, mají klíč (ne všechny 3 platformy vždy) — Partial, ne Record.
export type PlatformScopeMap = Partial<Record<Platform, string[]>>;

export type MeResponse = {
  ok: true;
  mod: boolean;
  platforms: Platform[];
  missingScopes: PlatformScopeMap;
};

/** Sestaví odpověď `GET /moderation/me` — čistá funkce, žádné I/O. */
export function meResponse(platforms: Platform[], missingScopes: PlatformScopeMap): MeResponse {
  return { ok: true, mod: platforms.length > 0, platforms, missingScopes };
}

/** `missingModScopes` pro každou platformu, kde je účet mod; `scopesFor` = injektovaný lookup (test i route). */
export async function buildMissingScopes(
  platforms: Platform[],
  scopesFor: (platform: Platform) => Promise<string[] | null>,
): Promise<PlatformScopeMap> {
  const out: PlatformScopeMap = {};
  for (const p of platforms) out[p] = missingModScopes(p, await scopesFor(p));
  return out;
}

export interface DeleteTargetDeps {
  /** Platformní kanál UC kanálu (registr, viz registryPlatformChannel). */
  platformChannel: (channel: string, platform: Platform) => Promise<string | null>;
  /** messages.channel zprávy, null = v archivu není. */
  messageChannel: (platform: Platform, messageId: string) => Promise<string | null>;
}

/**
 * Zpráva musí být v archivu a patřit kanálu, jehož modem účet je. Vrací kanál přesně jak je
 * v messages.channel (pro markDeleted expectedChannel), jinak null → 404, bez SSE/platformy/zápisu.
 * Bez toho by broadcaster vlastního kanálu (login == channel) smazal zprávu z cizího kanálu.
 */
export async function resolveDeleteTarget(channel: string, platform: Platform, messageId: string, deps: DeleteTargetDeps): Promise<string | null> {
  const want = await deps.platformChannel(channel, platform);
  if (!want) return null;
  const got = await deps.messageChannel(platform, messageId);
  return channelMatches(got, want) ? got : null;
}

const targetDeps: DeleteTargetDeps = {
  platformChannel: (channel, platform) => registryPlatformChannel(channel, platform),
  messageChannel: archivedMessageChannel,
};

// ---- část 2: kontextová nabídka na jméno ----
const PlatformEnum = z.enum(['twitch', 'kick', 'youtube']);
const UserIdField = z.string().min(1).max(64);
const ReasonField = z.string().trim().max(REASON_MAX);

export const UserActionBody = z.object({
  channel: z.string().min(1).max(40).optional(),
  platform: PlatformEnum,
  userId: UserIdField,
  /** Klient ho posílá pro čitelnost; server bere login z archivu. */
  login: z.string().max(60).optional(),
  action: z.enum(['timeout', 'ban', 'unban']),
  durationSec: z.number().int().optional(),
  reason: ReasonField.optional(),
}).refine((b) => b.action !== 'timeout' || (Number.isInteger(b.durationSec) && b.durationSec! >= 1 && b.durationSec! <= MAX_TIMEOUT_SEC), { message: 'durationSec', path: ['durationSec'] });

export const WarnBody = z.object({
  channel: z.string().min(1).max(40).optional(),
  platform: PlatformEnum,
  userId: UserIdField,
  login: z.string().max(60).optional(),
  reason: ReasonField.min(1),
});

export const PermitBody = z.object({
  channel: z.string().min(1).max(40).optional(),
  platform: PlatformEnum,
  userId: UserIdField,
  login: z.string().max(60).optional(),
  durationSec: z.number().int().min(1).max(MAX_PERMIT_SEC),
  /** Část 3: zpráva, na které mod permit udělil — smazaná filtrem odkazů se v UnityChatu obnoví. */
  messageId: z.string().min(1).max(128).optional(),
});

export const RenameBody = z.object({
  channel: z.string().min(1).max(40).optional(),
  platform: PlatformEnum,
  login: z.string().min(1).max(60).transform((s) => s.trim().replace(/^@/, '').toLowerCase()),
  nickname: NicknameField.nullable(),
  color: ColorField,
});

export const UserStateQuery = z.object({
  channel: z.string().min(1).max(40).optional(),
  platform: PlatformEnum,
  userId: UserIdField,
});

export type Gate = { channel: string; accountId: number; by: string; modPlatforms: Platform[]; isBroadcaster: boolean };

/**
 * Ověření moda pro routy části 2 (bez HTTP): kanál → lowercase + formát, pak accountModIdentities.
 * Mod = některá identita účtu je mod/broadcaster kanálu na své platformě; broadcaster jen
 * vlastního kanálu (login == kanál). Cizí kanál práva nedá — a cíl akce musí být navíc v archivu
 * kanálu (moderationTargets), takže vlastní neregistrovaný kanál nic nezmůže.
 */
export async function resolveModGate(
  accountId: number,
  rawChannel: string | undefined,
  fallback: string,
  modIdentities: (accountId: number, channel: string) => Promise<Array<{ platform: Platform; login: string; role: 'moderator' | 'broadcaster' }>>,
): Promise<Gate | { error: 'channel' | 'not_mod' }> {
  const channel = parseChannel(rawChannel, fallback);
  if (!channel) return { error: 'channel' };
  const mods = await modIdentities(accountId, channel);
  if (mods.length === 0) return { error: 'not_mod' };
  return { channel, accountId, by: `${mods[0].platform}:${mods[0].login}`, modPlatforms: mods.map((m) => m.platform), isBroadcaster: mods.some((m) => m.role === 'broadcaster') };
}

export default async function moderationRoutes(app: FastifyInstance, opts: { ingest?: Ingest } = {}) {
  const limiter = new RateLimiter(10, 2);
  const DEFAULT_CHANNEL = (config.CHAT_INGEST_CHANNELS.split(',').find((c) => c.startsWith('twitch:'))?.split(':')[1] || 'robdiesalot').toLowerCase();

  /**
   * Společná brána rout části 2: rate limit, kanál, ověření moda (resolveModGate) PŘED čímkoli
   * dalším (SSE, platforma, DB). null = odpověď už odeslaná.
   */
  const modGate = async (req: FastifyRequest, reply: FastifyReply, rawChannel: string | undefined, rateLimit = true): Promise<Gate | null> => {
    const accountId = req.webAccountId!;
    if (rateLimit && !limiter.allow(String(accountId))) { reply.code(429).send({ ok: false, error: 'rate_limited' }); return null; }
    const g = await resolveModGate(accountId, rawChannel, DEFAULT_CHANNEL, accountModIdentities);
    if ('error' in g) {
      if (g.error === 'not_mod') req.log.info({ accountId, route: req.routeOptions.url }, 'moderation: not_mod');
      reply.code(g.error === 'channel' ? 400 : 403).send({ ok: false, error: g.error });
      return null;
    }
    return g;
  };

  const modDeps: ModDeps = { log: app.log, youtubeVideoId: (pch) => opts.ingest?.videoIdFor('youtube', pch) ?? null };
  const targets = dbTargetDeps((channel, platform) => registryPlatformChannel(channel, platform));
  const targetRole = makeTargetRole(targets.platformChannel);
  const recordAction = async (v: NewModerationAction) => { await db.insert(moderationActions).values(v); };
  const userActionDeps: UserActionDeps = {
    resolveTargets: (channel, platform, userId) => resolveUserTargets(channel, platform, userId, targets),
    targetRole,
    publish: (p) => publishUserModerated(p),
    expectEcho: (k) => expectEcho(k),
    forgetEcho,
    ban: (p) => banPlatformUser(p, modDeps),
    unban: (p) => unbanUser(p, modDeps),
    activeBan: (channel, platform, userId) => activeBan(channel, platform, userId),
    recordBan, clearBan, recordAction,
    now: Date.now,
    log: app.log,
  };

  app.get<{ Querystring: { channel?: string } }>('/moderation/me', { preHandler: requireWebSession }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const channel = parseChannel(req.query.channel, DEFAULT_CHANNEL);
    if (!channel) return reply.code(400).send({ ok: false, error: 'channel' });

    const accountId = req.webAccountId!;
    const platforms = await accountModPlatforms(accountId, channel);
    const missingScopes = await buildMissingScopes(platforms, async (p) => {
      const id = await getDecryptedIdentity(accountId, p);
      return id?.scopes ?? null;
    });
    return meResponse(platforms, missingScopes);
  });

  app.post<{ Body: z.infer<typeof DeleteBody> }>('/moderation/delete', { preHandler: requireWebSession }, async (req, reply) => {
    const body = DeleteBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: 'body' });
    const accountId = req.webAccountId!;
    if (!limiter.allow(String(accountId))) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const channel = parseChannel(body.data.channel, DEFAULT_CHANNEL);
    if (!channel) return reply.code(400).send({ ok: false, error: 'channel' });
    const { platform, messageId } = body.data;

    // Ověřit moda PŘED SSE/mazáním — přihlášený divák bez mod role bota mazat nesmí.
    const mods = await accountModIdentities(accountId, channel);
    if (mods.length === 0) {
      req.log.info({ accountId, channel }, 'moderation delete: not_mod');
      return reply.code(403).send({ ok: false, error: 'not_mod' });
    }
    const by = `${mods[0].platform}:${mods[0].login}`;

    // Zpráva musí patřit kanálu moda — jinak nic (žádné SSE, platforma ani zápis).
    const stored = await resolveDeleteTarget(channel, platform, messageId, targetDeps);
    if (!stored) {
      req.log.info({ accountId, channel, platform }, 'moderation delete: zpráva mimo kanál / není v archivu');
      return reply.code(404).send({ ok: false, error: 'not_found' });
    }

    // SSE hned — klienti skryjí zprávu okamžitě, nečekají na platformu.
    await publishDeleted({ channel, platform, messageId, by, reason: 'mod', expectedChannel: stored });

    // Chyba platformy po SSE se nesmí propsat jako 500 — deletePlatformMessage svoje chyby
    // sama zabalí do ModResult, try/catch je jen pojistka proti neočekávané výjimce.
    let result: ModResult;
    try {
      result = await deletePlatformMessage({ accountId, channel, platform, messageId });
    } catch (e) {
      req.log.warn({ platform, err: (e as Error).message }, 'moderation delete: deletePlatformMessage vyhodilo výjimku');
      result = 'error:exception';
    }

    try {
      await db.insert(moderationActions).values({
        channel,
        accountId,
        actor: by,
        action: 'delete',
        platform,
        targetMessageId: messageId,
        params: {},
        result: resultRecord(platform, result),
      });
    } catch (e) {
      req.log.warn({ err: (e as Error).message }, 'moderation delete: zápis do moderation_actions selhal');
    }

    return reply.send({ ok: true, result });
  });

  // ---- část 2: timeout / ban / unban na všech platformách, kde člověka známe ----
  app.post('/moderation/user', { preHandler: requireWebSession }, async (req, reply) => {
    const body = UserActionBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: 'body' });
    const g = await modGate(req, reply, body.data.channel);
    if (!g) return reply;
    const out = await runUserAction({
      channel: g.channel, accountId: g.accountId, by: g.by, callerIsBroadcaster: g.isBroadcaster, platform: body.data.platform, userId: body.data.userId,
      action: body.data.action, durationSec: body.data.action === 'timeout' ? body.data.durationSec! : null, reason: body.data.reason || null,
    }, userActionDeps);
    if (out.status === 200) req.log.info({ accountId: g.accountId, channel: g.channel, action: body.data.action, results: out.body.results }, 'moderation user');
    return reply.code(out.status).send(out.body);
  });

  // ---- varování (Twitch nativně + uživatel UnityChatu napříč platformami) ----
  app.post('/moderation/warn', { preHandler: requireWebSession }, async (req, reply) => {
    const body = WarnBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: 'body' });
    const g = await modGate(req, reply, body.data.channel);
    if (!g) return reply;
    const out = await runWarn({ channel: g.channel, accountId: g.accountId, by: g.by, callerIsBroadcaster: g.isBroadcaster, platform: body.data.platform, userId: body.data.userId, reason: body.data.reason }, {
      resolveTargets: userActionDeps.resolveTargets,
      targetRole,
      warnTwitch: (p) => warnUser(p, modDeps),
      createWarning, sendToAccount, recordAction,
      log: app.log,
    });
    return reply.code(out.status).send(out.body);
  });

  // ---- permit: !permit <login> do chatu + náš permit (část 3) ----
  app.post('/moderation/permit', { preHandler: requireWebSession }, async (req, reply) => {
    const body = PermitBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: 'body' });
    const g = await modGate(req, reply, body.data.channel);
    if (!g) return reply;
    const out = await runPermit({ channel: g.channel, accountId: g.accountId, by: g.by, platform: body.data.platform, userId: body.data.userId, durationSec: body.data.durationSec, modPlatforms: g.modPlatforms }, {
      resolveTargets: userActionDeps.resolveTargets,
      // Paměť (synchronní filtr odkazů) + link_permits.
      insertPermits: (rows) => storePermits(rows),
      sendAsMod: async (platform, text) => { await sendAsAccount({ accountId: g.accountId, platform, channel: g.channel, text: outgoingText(text), ingest: opts.ingest, log: req.log }); },
      sendAsBot: async (platform, text) => {
        const ws = await defaultWorkspace(g.channel);
        if (!ws) throw new BotSendError('no workspace', 404, 'no_actor');
        await sendAsBot({ workspace: ws.slug, platform, text }, { ingest: opts.ingest, log: req.log });
      },
      recordAction,
      now: Date.now,
      log: req.log,
    });
    // Část 3: permit na zprávě smazané filtrem odkazů ji v UnityChatu obnoví (SSE message-restored).
    if (out.status === 200 && body.data.messageId) {
      const restore = await restoreOnPermit({ channel: g.channel, platform: body.data.platform, userId: body.data.userId, messageId: body.data.messageId, by: g.by }, {
        platformChannel: (channel, platform) => registryPlatformChannel(channel, platform),
        publishRestored: (p) => publishRestored(p),
        log: req.log,
      });
      if (restore) {
        const results = (out.body.results ?? {}) as Record<string, unknown>;
        out.body.results = { ...results, restore };
        out.body.restored = restore === 'ok';
      }
    }
    return reply.code(out.status).send(out.body);
  });

  // ---- přejmenování: mod nastaví/smaže divákovi přezdívku (bez 10s limitu /nicknames) ----
  app.put('/moderation/nickname', { preHandler: requireWebSession }, async (req, reply) => {
    const body = RenameBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: 'body' });
    const g = await modGate(req, reply, body.data.channel);
    if (!g) return reply;
    const out = await runRename({ channel: g.channel, accountId: g.accountId, by: g.by, callerIsBroadcaster: g.isBroadcaster, platform: body.data.platform, login: body.data.login, nickname: body.data.nickname, color: body.data.color ?? null }, {
      findUser: async (channel, platform, login) => {
        const pch = await registryPlatformChannel(channel, platform);
        return pch ? archivedUserByLogin(platform, pch, login) : null;
      },
      targetRole,
      blacklisted: async (channel, nickname) => containsBlacklisted(nickname, (await blacklistFor(channel, req.log)).terms),
      upsert: upsertNickname,
      remove: deleteNickname,
      recordAction,
      log: req.log,
    });
    return reply.code(out.status).send(out.body);
  });

  // ---- stav banu pro nabídku (Unban místo Timeout/Zabanovat) ----
  app.get('/moderation/user-state', { preHandler: requireWebSession }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const q = UserStateQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ ok: false, error: 'query' });
    const g = await modGate(req, reply, q.data.channel);
    if (!g) return reply;
    let ban: Awaited<ReturnType<typeof activeBan>> = null;
    try { ban = await activeBan(g.channel, q.data.platform, q.data.userId); }
    catch (e) { req.log.warn({ err: (e as Error).message }, 'moderation user-state: dotaz selhal'); }
    return { ok: true, banned: !!ban, until: ban?.until ? ban.until.getTime() : null };
  });
}
