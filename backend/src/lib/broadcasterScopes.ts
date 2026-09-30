// Oprávnění „jednou provždy“ (pokyn usera 2026-09-30: „všechna oprávnění, ať se to nemusí
// dělat znovu“). Dvě sady:
//   BROADCASTER_SCOPES — streamer (majitel kanálu) při „Povolit správu kanálu“: kategorie,
//     název streamu, oznámení, odměny, ankety, predikce, raidy, VIP/mod správa, klipy…
//     Platformy mění kategorii JEN tokenem majitele kanálu (Twitch channel:manage:broadcast,
//     Kick channel:write) — bot to nikdy nedostane, proto tahle sada patří Robovi.
//   BOT_EXTRA_SCOPES — chat bot navíc k psaní a moderaci: oznámení, shoutouty, nastavení chatu,
//     automod, blokovaná slova, štít, žádosti o unban, barva, whispery.
// Vynecháno schválně: e-mail (Twitch DA VI.C), stream key (channel:read:stream_key,
// streamkey:read), whispers:read, analytika, extensions, guest star.
// ⚠ Kick: scope musí být zapnutý i v Kick developer dashboardu appky, jinak authorize selže.
import type { Platform } from './zidolista.js';

export const BROADCASTER_SCOPES: Record<Platform, readonly string[]> = {
  twitch: [
    'channel:manage:broadcast', 'channel:read:editors',
    'channel:manage:moderators', 'channel:manage:vips', 'channel:read:vips',
    'channel:manage:polls', 'channel:read:polls', 'channel:manage:predictions', 'channel:read:predictions',
    'channel:manage:raids', 'channel:manage:redemptions', 'channel:read:redemptions', 'channel:manage:schedule',
    'channel:read:subscriptions', 'channel:read:hype_train', 'channel:read:goals', 'channel:read:charity',
    'channel:edit:commercial', 'channel:read:ads', 'channel:manage:ads', 'channel:manage:videos',
    'channel:bot', 'channel:moderate', 'clips:edit', 'bits:read',
    'moderator:manage:announcements', 'moderator:manage:shoutouts', 'moderator:manage:chat_settings',
    'moderator:manage:automod', 'moderator:manage:blocked_terms', 'moderator:manage:shield_mode',
    'moderator:manage:unban_requests', 'moderator:read:chatters', 'moderator:read:followers',
    'user:read:broadcast', 'user:edit:broadcast', 'user:manage:chat_color', 'user:read:follows', 'user:read:subscriptions',
  ],
  kick: ['channel:read', 'channel:write', 'events:subscribe'],
  youtube: [],
};

export const BOT_EXTRA_SCOPES: Record<Platform, readonly string[]> = {
  twitch: [
    'user:read:chat', 'user:manage:chat_color', 'user:manage:whispers',
    'moderator:manage:announcements', 'moderator:manage:shoutouts', 'moderator:manage:chat_settings',
    'moderator:manage:automod', 'moderator:manage:blocked_terms', 'moderator:manage:shield_mode',
    'moderator:manage:unban_requests', 'moderator:read:chatters', 'moderator:read:followers',
  ],
  kick: ['channel:read', 'events:subscribe'],
  youtube: [],
};

/** Scope, bez kterého kategorie nejde přepnout. */
export const CATEGORY_SCOPE: Record<Platform, string | null> = { twitch: 'channel:manage:broadcast', kick: 'channel:write', youtube: null };

export const uniqScopes = (...lists: ReadonlyArray<readonly string[]>): string[] => [...new Set(lists.flat())];
