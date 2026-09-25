// UC kanál = streamerův Twitch login, se kterým klienti porovnávají uc_config.channel
// (viz CLAUDE.md). Ingest ale zná jen platformní kanál (Kick slug / YouTube handle) —
// SSE `message-deleted` (spec 2026-09-25 moderace) musí nést UC kanál, jinak ho klient
// nikdy neuvidí. Mapování je ve streamers (schema.ts), cache 5 min; když streamer
// v DB není nebo mapování na Twitch chybí, spadne na platformní kanál — radši
// nezobrazené mazání u cizího kanálu než pád ingestu.
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { streamers } from '../db/schema.js';
import type { Platform } from './zidolista.js';

/** Normalizace platformního kanálu — malá písmena, YouTube handle bez úvodního '@'. */
export function normPlatformChannel(v: string): string {
  return v.trim().toLowerCase().replace(/^@/, '');
}

/** Čistá část mapování (testovatelná bez DB): streamerův twitchLogin, jinak fallback. */
export function pickUcChannel(row: { twitchLogin: string | null } | undefined, fallback: string): string {
  return row?.twitchLogin?.toLowerCase() || fallback;
}

function platformColumn(platform: 'kick' | 'youtube') {
  return platform === 'kick' ? streamers.kickSlug : streamers.youtubeHandle;
}

const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; value: string }>();

/** Platformní kanál → UC kanál. Twitch: ingest kanál UC kanálem už je, žádný DB dotaz. */
export async function ucChannelFor(platform: Platform, platformChannel: string): Promise<string> {
  const norm = normPlatformChannel(platformChannel);
  if (platform === 'twitch') return norm;
  const key = `${platform}:${norm}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  let uc = norm;
  try {
    const rows = await db.select({ twitchLogin: streamers.twitchLogin }).from(streamers).where(eq(platformColumn(platform), norm)).limit(1);
    uc = pickUcChannel(rows[0], norm);
  } catch {
    // DB nedostupná — fallback na platformní kanál, mazání na platformě nesmí shodit ingest.
  }
  cache.set(key, { at: now, value: uc });
  return uc;
}

/** Jen pro testy — vyprázdnit cache mezi běhy. */
export function clearUcChannelCache(): void {
  cache.clear();
}
