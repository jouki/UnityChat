// Moderátorské scopes navíc k WEB_SCOPES / BOT_SCOPES: mazání zpráv a bany/timeouty
// z UnityChatu (mody vlastním účtem, nebo přes workspace bota). YouTube nemá pro
// mazání/moderaci OAuth scope navíc (liveChatMessages.delete/ban jde na force-ssl,
// který se už žádá v WEB_SCOPES) — MOD_SCOPES pro youtube je prázdné pole.
import type { Platform } from './zidolista.js';

export const MOD_SCOPES: Record<Platform, readonly string[]> = {
  twitch: ['moderator:manage:chat_messages', 'moderator:manage:banned_users', 'moderator:manage:warnings'],
  kick: ['moderation:chat_message:manage', 'moderation:ban'],
  youtube: [],
};

/** Které z MOD_SCOPES[platform] chybí v seznamu uděleného souhlasu. `granted: null` = žádný scope neznámý → chybí všechny. */
export function missingModScopes(platform: Platform, granted: string[] | null): string[] {
  const have = new Set(granted ?? []);
  return MOD_SCOPES[platform].filter((s) => !have.has(s));
}
