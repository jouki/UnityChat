// Nejvyšší role uživatele v kanálu podle serverového logu zpráv (badge posledních zpráv
// za 24 h). Sdílí reakce (smí mod/broadcaster) a soundboard (role pro Židolištu).
import { and, desc, eq, gt, ilike } from 'drizzle-orm';
import { db } from '../db/index.js';
import { messages } from '../db/schema.js';
import { rolesFromBadges } from '../sse/integrationStream.js';

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
