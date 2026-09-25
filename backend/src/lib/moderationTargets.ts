// Cíl moderace uživatele (spec 2026-09-25 moderace, část 2): z (platforma, userId) zprávy najít
// uživatele v archivu kanálu a všechny jeho identity v UnityChatu (timeout/ban/unban platí na všech
// platformách, kde ho známe). Bez UC účtu jen platforma zprávy.
//
// Bezpečnost: cíl MUSÍ mít zprávu v archivu platformního kanálu (registr = to, co ingest poslouchá).
// Tím je ban vázaný na kontext kanálu — broadcaster vlastního (neregistrovaného) kanálu nemůže
// nikoho banovat/přejmenovat přes UnityChat, protože jeho kanál v archivu není. Login se bere
// z archivu, klientovi se nevěří.
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { messages, webIdentities } from '../db/schema.js';
import { usernameEqualsCondition, chatRole, type ChatRole } from './chatRole.js';
import { normPlatformChannel } from './ucChannel.js';
import type { Platform } from './zidolista.js';

export interface UserTarget { platform: Platform; userId: string; login: string }

export interface ResolvedTargets {
  /** Uživatel na platformě zprávy (login z archivu). */
  primary: UserTarget;
  /** primary + propojené identity na platformách, které má kanál v registru. */
  all: UserTarget[];
  /** UC účet cíle (varování napříč platformami), null = není uživatel UnityChatu. */
  accountId: number | null;
}

export interface TargetDeps {
  /** Platformní kanál UC kanálu (registryPlatformChannel, integrace: ws.channels). */
  platformChannel: (channel: string, platform: Platform) => Promise<string | null>;
  /** Poslední login uživatele v archivu platformního kanálu, null = v kanálu nepsal. */
  archivedLogin: (platform: Platform, platformChannel: string, userId: string) => Promise<string | null>;
  /** UC účet podle identity platformy. */
  accountOf: (platform: Platform, userId: string) => Promise<number | null>;
  /** Všechny identity UC účtu. */
  accountIdentities: (accountId: number) => Promise<UserTarget[]>;
}

export async function resolveUserTargets(channel: string, platform: Platform, userId: string, deps: TargetDeps): Promise<ResolvedTargets | null> {
  const pch = await deps.platformChannel(channel, platform);
  if (!pch) return null;
  const login = await deps.archivedLogin(platform, pch, userId);
  if (!login) return null;
  const primary: UserTarget = { platform, userId, login: login.toLowerCase() };
  const accountId = await deps.accountOf(platform, userId);
  const all: UserTarget[] = [primary];
  if (accountId !== null) {
    for (const i of await deps.accountIdentities(accountId)) {
      if (i.platform === platform || all.some((t) => t.platform === i.platform)) continue;
      if (!(await deps.platformChannel(channel, i.platform))) continue;
      all.push({ platform: i.platform, userId: i.userId, login: i.login.toLowerCase() });
    }
  }
  return { primary, all, accountId };
}

/** Hodnoty messages.channel pro platformní kanál (ingest ukládá lowercase, YouTube handle i s '@'). */
function channelValues(platformChannel: string): string[] {
  const n = normPlatformChannel(platformChannel);
  return [n, `@${n}`];
}

export async function archivedLogin(platform: Platform, platformChannel: string, userId: string): Promise<string | null> {
  const rows = await db
    .select({ login: messages.platformUsername })
    .from(messages)
    .where(and(inArray(messages.channel, channelValues(platformChannel)), eq(messages.platform, platform), eq(messages.platformUserId, userId)))
    .orderBy(desc(messages.sentAt))
    .limit(1);
  return rows[0]?.login ?? null;
}

/** Uživatel podle loginu v archivu platformního kanálu (přejmenování) — přesná shoda, žádný (I)LIKE. */
export async function archivedUserByLogin(platform: Platform, platformChannel: string, login: string): Promise<UserTarget | null> {
  const rows = await db
    .select({ login: messages.platformUsername, userId: messages.platformUserId })
    .from(messages)
    .where(and(inArray(messages.channel, channelValues(platformChannel)), eq(messages.platform, platform), usernameEqualsCondition(login)))
    .orderBy(desc(messages.sentAt))
    .limit(1);
  return rows[0] ? { platform, userId: rows[0].userId, login: rows[0].login.toLowerCase() } : null;
}

export async function accountOf(platform: Platform, userId: string): Promise<number | null> {
  const rows = await db
    .select({ accountId: webIdentities.accountId })
    .from(webIdentities)
    .where(and(eq(webIdentities.platform, platform), eq(webIdentities.platformUserId, userId)))
    .limit(1);
  return rows[0]?.accountId ?? null;
}

/** Všechny identity účtu včetně odhlášených — pořád je to týž člověk (ban se ho týká). */
export async function accountIdentities(accountId: number): Promise<UserTarget[]> {
  const rows = await db
    .select({ platform: webIdentities.platform, userId: webIdentities.platformUserId, login: webIdentities.login })
    .from(webIdentities)
    .where(eq(webIdentities.accountId, accountId));
  return rows.map((r) => ({ platform: r.platform as Platform, userId: r.userId, login: r.login }));
}

export const dbTargetDeps = (platformChannel: TargetDeps['platformChannel']): TargetDeps => ({
  platformChannel, archivedLogin, accountOf, accountIdentities,
});

/**
 * Role cíle v kanálu pro hierarchii (checkHierarchy): chatRole na platformním kanálu jeho platformy
 * (broadcaster = login shodný s kanálem, jinak badge v archivu). Platforma bez kanálu = viewer.
 */
export const makeTargetRole = (
  platformChannel: TargetDeps['platformChannel'],
  role: (platform: Platform, login: string, channel: string) => Promise<ChatRole> = chatRole,
) => async (channel: string, t: UserTarget): Promise<ChatRole> => {
  const pch = await platformChannel(channel, t.platform);
  return pch ? role(t.platform, t.login, pch) : 'viewer';
};
