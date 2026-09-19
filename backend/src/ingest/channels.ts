export type IngestPlatform = 'twitch' | 'kick' | 'youtube';
export interface IngestChannel { platform: IngestPlatform; channel: string }

const PLATFORMS: IngestPlatform[] = ['twitch', 'kick', 'youtube'];

/** `twitch:robdiesalot,kick:robdiesalot` → seznam; prázdný string = ingest vypnutý. */
export function parseIngestChannels(raw: string): IngestChannel[] {
  const out: IngestChannel[] = [];
  for (const part of raw.split(',')) {
    const item = part.trim();
    if (!item) continue;
    const idx = item.indexOf(':');
    const platform = (idx === -1 ? item : item.slice(0, idx)).trim().toLowerCase() as IngestPlatform;
    const channel = idx === -1 ? '' : item.slice(idx + 1).trim().toLowerCase();
    if (!PLATFORMS.includes(platform)) throw new Error(`CHAT_INGEST_CHANNELS: neznámá platforma "${platform}"`);
    if (!channel) throw new Error(`CHAT_INGEST_CHANNELS: chybí kanál u "${item}"`);
    out.push({ platform, channel });
  }
  return out;
}
