// Vlastní modul (ne modActions.ts / chatRole.ts): obě moduly registryPlatformChannel potřebují
// (modActions.ts pro mazání/timeout na platformě, chatRole.ts pro accountModIdentities — ověření
// mod role přes PLATFORMNÍ kanál té které platformy), a modActions.ts zároveň importuje chatRole
// (`chatRole`). Držet funkci tady místo v jednom z nich = žádný cyklický import mezi nimi.
import { workspaceForChannel, type Platform, type WorkspaceInfo } from './zidolista.js';

/** Výchozí workspace pro UC kanál (Twitch login streamera) — registr Židolišty se vždy hledá podle Twitche. */
export const defaultWorkspace = (ucChannel: string) => workspaceForChannel('twitch', ucChannel);

/**
 * Kanál na platformě pro UC kanál (Twitch login streamera): Twitch = týž, Kick/YouTube z registru Židolišty.
 * Registr = kanály, které ingest poslouchá a ukládá do messages.channel (role moda se čte odtud).
 * Pozor: routes/chat.ts `platformChannel(platform, channel)` bere adresář `streamers` (párování uc-sent) — jiný zdroj.
 */
export async function registryPlatformChannel(channel: string, platform: Platform, ws?: WorkspaceInfo | null): Promise<string | null> {
  const c = channel.toLowerCase();
  if (platform === 'twitch') return c;
  const w = ws === undefined ? await defaultWorkspace(c) : ws;
  return w?.channels[platform] ?? null;
}
