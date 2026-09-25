// Nejvyšší role uživatele v kanálu podle serverového logu zpráv (badge posledních zpráv
// za 24 h). Sdílí reakce (smí mod/broadcaster) a soundboard (role pro Židolištu).
import { and, desc, eq, gt, ilike } from 'drizzle-orm';
import { db } from '../db/index.js';
import { messages } from '../db/schema.js';
import { rolesFromBadges } from '../sse/integrationStream.js';
import { listIdentities, type PublicIdentity } from './webAuth.js';
import { registryPlatformChannel } from './modActions.js';
import type { Platform } from './zidolista.js';

export type ChatRole = 'broadcaster' | 'moderator' | 'vip' | 'sub' | 'viewer';
const RANK: ChatRole[] = ['viewer', 'sub', 'vip', 'moderator', 'broadcaster'];

/** Nejvyšší role z příznaků badge (isBroadcaster > isMod > isVip > isSub > viewer). */
export function highestRole(r: { isBroadcaster: boolean; isMod: boolean; isVip: boolean; isSub: boolean }): ChatRole {
  return r.isBroadcaster ? 'broadcaster' : r.isMod ? 'moderator' : r.isVip ? 'vip' : r.isSub ? 'sub' : 'viewer';
}

/**
 * Role loginu v kanálu. Broadcaster = login shodný s kanálem (u Roba i Joukiho stejný
 * na všech platformách); jinak nejvyšší role z badge posledních 5 zpráv za 24 h.
 * Když uživatel v kanálu nepsal, `viewer`.
 */
export async function chatRole(platform: 'twitch' | 'kick' | 'youtube', login: string, channel: string): Promise<ChatRole> {
  const l = login.toLowerCase();
  if (l === channel.toLowerCase()) return 'broadcaster';
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ raw: messages.contentRaw, username: messages.platformUsername })
    .from(messages)
    .where(and(eq(messages.channel, channel.toLowerCase()), eq(messages.platform, platform), ilike(messages.platformUsername, l), gt(messages.sentAt, since)))
    .orderBy(desc(messages.sentAt))
    .limit(5);
  let best: ChatRole = 'viewer';
  for (const r of rows) {
    const role = highestRole(rolesFromBadges(platform, (r.raw as Record<string, unknown> | null)?.badges, r.username, channel));
    if (RANK.indexOf(role) > RANK.indexOf(best)) best = role;
  }
  return best;
}

/** Identita propojeného účtu UnityChatu, kde je mod/broadcaster kanálu. */
export interface AccountModIdentity {
  platform: Platform;
  login: string;
}

export interface AccountModDeps {
  listIdentities: (accountId: number) => Promise<Pick<PublicIdentity, 'platform' | 'login'>[]>;
  registryPlatformChannel: (channel: string, platform: Platform) => Promise<string | null>;
  chatRole: (platform: Platform, login: string, channel: string) => Promise<ChatRole>;
}

const defaultAccountModDeps: AccountModDeps = { listIdentities, registryPlatformChannel, chatRole };

/**
 * Propojené identity účtu (Task 6, moderace mazání), kde je uživatel mod/broadcaster kanálu.
 * Role se VŽDY ověřuje přes platformní kanál té které platformy (Twitch = kanál sám, Kick/
 * YouTube z registru Židolišty), NIKDY přes UC kanál napříč platformami — jinak by twitch mod
 * dostal roli i na platformě, kde vůbec nechatuje. Platforma bez registrovaného kanálu (Kick/
 * YouTube nenamapované) se přeskočí (žádný záznam, ne chyba).
 */
export async function accountModIdentities(
  accountId: number,
  channel: string,
  deps: AccountModDeps = defaultAccountModDeps,
): Promise<AccountModIdentity[]> {
  const ids = await deps.listIdentities(accountId);
  const out: AccountModIdentity[] = [];
  for (const i of ids) {
    const platformChannel = await deps.registryPlatformChannel(channel, i.platform);
    if (!platformChannel) continue;
    const role = await deps.chatRole(i.platform, i.login, platformChannel);
    if (role === 'moderator' || role === 'broadcaster') out.push({ platform: i.platform, login: i.login });
  }
  return out;
}

/** Jen platformy z `accountModIdentities` — pro `GET /moderation/me` (tlačítko/nabídka scopes). */
export async function accountModPlatforms(accountId: number, channel: string, deps?: AccountModDeps): Promise<Platform[]> {
  return (await accountModIdentities(accountId, channel, deps)).map((m) => m.platform);
}
