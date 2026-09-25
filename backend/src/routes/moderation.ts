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
//   POST /moderation/restore { channel, platform, messageId }   (odkrýt smazanou/skrytou zprávu jen v UnityChatu)
//   PUT  /moderation/nickname { channel, platform, login, nickname|null, color? }
//   GET  /moderation/user-state?channel&platform&userId   → { banned, until }
//   GET  /moderation/user-history/{summary,messages,donations}   (Profil uživatele — routes/userHistory.ts)
//   GET  /moderation/deleted-content?channel&ids=<platform>:<id>,…   (obsah smazaných/skrytých zpráv jen pro moda)
//   Kontrakt: docs/superpowers/plans/2026-09-25-moderace-cast-2-kontrakt.md
//
// Kdo smí mazat: účet, jehož NĚKTERÁ propojená identita je mod/broadcaster kanálu na SVÉ
// platformě (accountModIdentities, chatRole.ts) — mod aspoň na jedné platformě smí mazat na
// všech (deletePlatformMessage/bot to zvládne i bez vlastních scopes dané platformy).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { moderationActions, messages, type NewModerationAction } from '../db/schema.js';
import { and, eq, inArray } from 'drizzle-orm';
import { requireWebSession, getDecryptedIdentity } from '../lib/webAuth.js';
import { accountModIdentities, accountModPlatforms } from '../lib/chatRole.js';
import { publishDeleted, archivedMessageChannel, channelMatches, type DeleteReason } from '../lib/messageDeletes.js';
import { publishUnhidden, type HideParams, type HideResult } from '../lib/messageHides.js';
import { registryPlatformChannel } from '../lib/platformChannels.js';
import { deletePlatformMessage, banPlatformUser, unbanUser, warnUser, MAX_TIMEOUT_SEC, type ModResult, type ModDeps } from '../lib/modActions.js';
import { resolveUserTargets, dbTargetDeps, archivedUserByLogin, makeTargetRole } from '../lib/moderationTargets.js';
import { blacklistFor } from './blacklist.js';
import { containsBlacklisted } from '../lib/blacklistMatch.js';
import { publishUserModerated, recordBan, clearBan, activeBan, expectEcho, forgetEcho } from '../lib/userModeration.js';
import { runUserAction, runWarn, runPermit, runRename, MAX_PERMIT_SEC, type UserActionDeps } from '../lib/userModActions.js';
import { createWarning, sendToAccount, REASON_MAX } from '../lib/accountWarnings.js';
import { storePermits } from '../lib/linkFilter.js';
import { restoreOnPermit, publishRestored, type RestoreParams, type RestoreResult } from '../lib/linkRestore.js';
import { sendAsAccount } from '../lib/accountSend.js';
import { sendAsBot, BotSendError } from '../lib/botSend.js';
import { outgoingText } from '../lib/webSend.js';
import { defaultWorkspace } from '../lib/platformChannels.js';
import { NicknameField, ColorField, upsertNickname, deleteNickname } from './nicknames.js';
import type { Ingest } from '../ingest/index.js';
import { missingModScopes } from '../lib/modScopes.js';
import type { Platform } from '../lib/zidolista.js';
import { RateLimiter, toModeratedContent, toClientMessage, type ClientRow, type ClientMessage } from './chat.js';
import { dbHistoryDeps } from '../lib/userHistory.js';
import { userHistoryRoutes, optionalWebSession } from './userHistory.js';
import { userSearchRoutes } from './userSearch.js';
import { dbUserSearchDeps } from '../lib/userSearch.js';
import { accountIdentities } from '../lib/moderationTargets.js';
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

// ---- Obsah smazaných / skrytých zpráv pro moda (historie a stream ho neposílají nikomu) ----
export const DELETED_CONTENT_MAX = 100;

export const DeletedContentQuery = z.object({
  channel: z.string().min(1).max(40).optional(),
  // <platform>:<id> čárkou; max 100 × (7 + 1 + 128) + čárky.
  ids: z.string().min(1).max(DELETED_CONTENT_MAX * 137),
});

export type DeletedKey = { platform: Platform; id: string };

/** `twitch:abc,kick:123` → klíče (dedup). null = prázdné, neplatné nebo víc než DELETED_CONTENT_MAX. */
export function parseDeletedKeys(raw: string): DeletedKey[] | null {
  const seen = new Set<string>();
  const out: DeletedKey[] = [];
  for (const part of raw.split(',')) {
    const s = part.trim();
    if (!s) continue;
    const i = s.indexOf(':');
    if (i <= 0) return null;
    const platform = s.slice(0, i);
    const id = s.slice(i + 1);
    if (!PlatformEnum.safeParse(platform).success || !id || id.length > 128) return null;
    const key = `${platform}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ platform: platform as Platform, id });
  }
  return out.length && out.length <= DELETED_CONTENT_MAX ? out : null;
}

export type DeletedContentRow = ClientRow & { channel: string };

export interface DeletedContentDeps {
  /** Platformní kanál UC kanálu (registr). */
  platformChannel: (channel: string, platform: Platform) => Promise<string | null>;
  /** Řádky archivu podle platformy a id zpráv. */
  rows: (platform: Platform, ids: string[]) => Promise<DeletedContentRow[]>;
}

/**
 * Plný tvar smazaných/skrytých zpráv kanálu `channel` (mod už ověřený). Zprávy z cizího kanálu
 * a nesmazané/neskryté zprávy se vynechají (neskrytou zprávu klient má z historie/streamu).
 */
export async function buildDeletedContent(channel: string, keys: DeletedKey[], deps: DeletedContentDeps): Promise<Record<string, ClientMessage>> {
  const byPlatform = new Map<Platform, string[]>();
  for (const k of keys) byPlatform.set(k.platform, [...(byPlatform.get(k.platform) ?? []), k.id]);
  const out: Record<string, ClientMessage> = {};
  for (const [platform, ids] of byPlatform) {
    const want = await deps.platformChannel(channel, platform);
    if (!want) continue;
    for (const row of await deps.rows(platform, ids)) {
      if (row.platform !== platform || !ids.includes(row.platformMessageId)) continue;
      if (!channelMatches(row.channel, want)) continue;
      if (!row.deletedAt && !row.hiddenAt) continue;
      out[`${platform}:${row.platformMessageId}`] = toModeratedContent(row);
    }
  }
  return out;
}

/** Celá obsluha `GET /moderation/deleted-content` bez HTTP: ids → brána moda → obsah. */
export async function runDeletedContent(
  q: { accountId: number; channel?: string; ids: string; fallback: string },
  deps: DeletedContentDeps & { modIdentities: Parameters<typeof resolveModGate>[3] },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const keys = parseDeletedKeys(q.ids);
  if (!keys) return { status: 400, body: { ok: false, error: 'ids' } };
  const g = await resolveModGate(q.accountId, q.channel, q.fallback, deps.modIdentities);
  if ('error' in g) return { status: g.error === 'channel' ? 400 : 403, body: { ok: false, error: g.error } };
  return { status: 200, body: { ok: true, messages: await buildDeletedContent(g.channel, keys, deps) } };
}

// ---- Odkrytí zprávy jen v UnityChatu (smazaná / skrytá → zase vidět; na platformě zůstává smazaná) ----
export const RestoreBody = z.object({
  channel: z.string().min(1).max(40).optional(),
  platform: PlatformEnum,
  messageId: z.string().min(1).max(128),
});

/** Důvody smazání, které smí mod v UnityChatu odkrýt. gif_request rozhoduje karta GIFu, jiné/null nic. */
export const RESTORABLE_REASONS = ['mod', 'platform', 'link_filter'] as const;

/** Řádek archivu (klientský tvar + kanál) — po odkrytí z něj jde `message` v odpovědi (Profil ho vykreslí). */
export type RestoreState = DeletedContentRow;

export interface RestoreDeps {
  /** Platformní kanál UC kanálu (registr). */
  platformChannel: (channel: string, platform: Platform) => Promise<string | null>;
  /** Stav zprávy v archivu; null = není. */
  messageState: (platform: Platform, messageId: string) => Promise<RestoreState | null>;
  publishRestored: (p: RestoreParams) => Promise<RestoreResult>;
  publishUnhidden: (p: HideParams) => Promise<HideResult>;
  recordAction: (v: NewModerationAction) => Promise<void>;
  log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}

export type RestoreOutcome = 'ok' | 'not_deleted' | 'not_found';

/**
 * `POST /moderation/restore` bez HTTP (mod už ověřený branou): zpráva musí patřit kanálu gate.
 * Smazaná (mod | platform | link_filter) → publishRestored (SSE message-restored + chat.restored,
 * značka proti ozvěně smazání z platformy), záznam `restore` s původním důvodem; skrytá → publishUnhidden,
 * záznam `unhide`. gif_request → 409 gif_pending, jiný důvod → 409 not_restorable.
 * Po úplném odkrytí odpověď nese i `message` (tvar /chat/history) — Profil ji vykreslí bez SSE.
 */
export async function runRestore(
  g: Pick<Gate, 'channel' | 'accountId' | 'by'>,
  b: { platform: Platform; messageId: string },
  deps: RestoreDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { platform, messageId } = b;
  const want = await deps.platformChannel(g.channel, platform);
  const state = want ? await deps.messageState(platform, messageId) : null;
  if (!want || !state || !channelMatches(state.channel, want)) {
    deps.log.info({ accountId: g.accountId, channel: g.channel, platform }, 'moderation restore: zpráva mimo kanál / není v archivu');
    return { status: 404, body: { ok: false, error: 'not_found', result: 'not_found' satisfies RestoreOutcome } };
  }
  const record = async (action: 'restore' | 'unhide', params: Record<string, unknown>, result: Record<string, unknown>) => {
    try { await deps.recordAction({ channel: g.channel, accountId: g.accountId, actor: g.by, action, platform, targetMessageId: messageId, params, result }); }
    catch (e) { deps.log.warn({ err: (e as Error).message }, 'moderation restore: zápis do moderation_actions selhal'); }
  };

  let done = false;
  let whole = true;   // zpráva je po akci celá vidět (nic nezůstalo smazané / skryté)
  if (state.deletedAt) {
    const reason = state.deletedReason;
    if (reason === 'gif_request') return { status: 409, body: { ok: false, error: 'gif_pending' } };
    if (!(RESTORABLE_REASONS as readonly string[]).includes(reason ?? '')) return { status: 409, body: { ok: false, error: 'not_restorable' } };
    const r = await deps.publishRestored({ channel: g.channel, platform, messageId, platformChannel: want, by: g.by, reason: reason as DeleteReason });
    await record('restore', { reason }, { restore: r });
    done = r === 'ok';
    whole = done;
  }
  if (state.hiddenAt) {
    const r = await deps.publishUnhidden({ channel: g.channel, platform, messageId, by: g.by });
    await record('unhide', {}, { unhide: r });
    done = done || r === 'ok';
    whole = whole && r === 'ok';
  }
  const result: RestoreOutcome = done ? 'ok' : 'not_deleted';
  const body: Record<string, unknown> = { ok: true, result };
  if (done && whole) body.message = toClientMessage({ ...state, deletedAt: null, deletedReason: null, hiddenAt: null }, true);
  return { status: 200, body };
}

const restoreStateDeps = {
  messageState: async (platform: Platform, messageId: string): Promise<RestoreState | null> => {
    const rows = await db
      .select()
      .from(messages)
      .where(and(eq(messages.platform, platform), eq(messages.platformMessageId, messageId)))
      .limit(1);
    return rows[0] ?? null;
  },
};

const deletedContentDeps: DeletedContentDeps = {
  platformChannel: (channel, platform) => registryPlatformChannel(channel, platform),
  rows: (platform, ids) => db.select().from(messages).where(and(eq(messages.platform, platform), inArray(messages.platformMessageId, ids))),
};

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

  // ---- Profil uživatele (nabídka moda): routes/userHistory.ts, stejná brána moda, vlastní limity ----
  await userHistoryRoutes(app, {
    requireSession: requireWebSession,
    optionalSession: optionalWebSession,
    modIdentities: accountModIdentities,
    history: dbHistoryDeps(
      (channel, platform, userId) => resolveUserTargets(channel, platform, userId, targets),
      accountIdentities,
      async (channel, platform, login) => {
        const pch = await registryPlatformChannel(channel, platform);
        return pch ? (await archivedUserByLogin(platform, pch, login))?.userId ?? null : null;
      },
      app.log,
    ),
    defaultChannel: DEFAULT_CHANNEL,
  });

  // ---- `/user <text>`: našeptávač uživatelů kanálu (routes/userSearch.ts), jen mod ----
  await userSearchRoutes(app, {
    requireSession: requireWebSession,
    modIdentities: accountModIdentities,
    search: dbUserSearchDeps((channel, platform) => registryPlatformChannel(channel, platform)),
    defaultChannel: DEFAULT_CHANNEL,
  });

  // ---- obsah smazaných / skrytých zpráv (mod vidí text, divák nikdy) ----
  const deletedLimiter = new RateLimiter(10, 2);
  app.get('/moderation/deleted-content', { preHandler: requireWebSession }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const q = DeletedContentQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ ok: false, error: 'query' });
    const accountId = req.webAccountId!;
    if (!deletedLimiter.allow(String(accountId))) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const out = await runDeletedContent({ accountId, channel: q.data.channel, ids: q.data.ids, fallback: DEFAULT_CHANNEL }, { ...deletedContentDeps, modIdentities: accountModIdentities });
    if (out.status === 403) req.log.info({ accountId, route: req.routeOptions.url }, 'moderation: not_mod');
    else if (out.status === 200) req.log.info({ accountId, asked: q.data.ids.split(',').length, got: Object.keys(out.body.messages as object).length }, 'moderation deleted-content');
    return reply.code(out.status).send(out.body);
  });

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

  // ---- odkrytí smazané / skryté zprávy jen v UnityChatu (na platformě zůstává smazaná) ----
  app.post('/moderation/restore', { preHandler: requireWebSession }, async (req, reply) => {
    const body = RestoreBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: 'body' });
    const g = await modGate(req, reply, body.data.channel);
    if (!g) return reply;
    const out = await runRestore(g, { platform: body.data.platform, messageId: body.data.messageId }, {
      platformChannel: (channel, platform) => registryPlatformChannel(channel, platform),
      messageState: restoreStateDeps.messageState,
      publishRestored: (p) => publishRestored(p),
      publishUnhidden: (p) => publishUnhidden(p),
      recordAction,
      log: req.log,
    });
    if (out.status === 200) req.log.info({ accountId: g.accountId, channel: g.channel, platform: body.data.platform, result: out.body.result }, 'moderation restore');
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
