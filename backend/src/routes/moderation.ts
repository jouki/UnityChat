// Moderace zpráv z UnityChatu (spec 2026-09-25-moderace-odkazy-gify-design.md, část 1 — mazání):
// přihlášený mod smaže zprávu na platformě, ostatní klienti se dozví hned přes SSE
// message-deleted (Task 2 lib/messageDeletes.ts), samotné smazání na platformě dělá Task 5
// lib/modActions.ts (vlastní účet moda, jinak bot workspace).
//
//   GET  /moderation/me?channel=                          (stav pro tlačítko + nabídku scopes)
//   POST /moderation/delete { channel, platform, messageId }
//
// Kdo smí mazat: účet, jehož NĚKTERÁ propojená identita je mod/broadcaster kanálu na SVÉ
// platformě (accountModIdentities, chatRole.ts) — mod aspoň na jedné platformě smí mazat na
// všech (deletePlatformMessage/bot to zvládne i bez vlastních scopes dané platformy).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { moderationActions } from '../db/schema.js';
import { requireWebSession, getDecryptedIdentity } from '../lib/webAuth.js';
import { accountModIdentities, accountModPlatforms } from '../lib/chatRole.js';
import { publishDeleted, archivedMessageChannel, channelMatches } from '../lib/messageDeletes.js';
import { registryPlatformChannel } from '../lib/platformChannels.js';
import { deletePlatformMessage, type ModResult } from '../lib/modActions.js';
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

export default async function moderationRoutes(app: FastifyInstance) {
  const limiter = new RateLimiter(10, 2);
  const DEFAULT_CHANNEL = (config.CHAT_INGEST_CHANNELS.split(',').find((c) => c.startsWith('twitch:'))?.split(':')[1] || 'robdiesalot').toLowerCase();

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
}
