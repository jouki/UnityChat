// Resolve a platform handle to its stable user_id via public/unauth endpoints.
// Used for handle-rename self-healing: when a viewer visits a handle we don't
// have in DB, we resolve it to user_id and check if we have that user_id under
// a different (old) handle — if yes, update the handle.

export type Platform = 'twitch' | 'youtube' | 'kick';

export interface ResolvedIdentity {
  userId: string;
  displayName?: string;
  avatarUrl?: string;
  handleCanonical: string; // normalized (e.g. lowercase twitch login)
}

// In-memory cache: handle → ResolvedIdentity (or null for negative)
// Keyed by `${platform}:${handleLower}`. 24h TTL for positives, 5m for negatives.
interface CacheEntry {
  value: ResolvedIdentity | null;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): CacheEntry | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit;
}

function cachePut(key: string, value: ResolvedIdentity | null): void {
  const ttl = value ? 24 * 60 * 60 * 1000 : 5 * 60 * 1000;
  cache.set(key, { value, expiresAt: Date.now() + ttl });
  // Simple GC: if cache grows too big, drop oldest half
  if (cache.size > 2000) {
    const entries = [...cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (let i = 0; i < entries.length / 2; i++) cache.delete(entries[i][0]);
  }
}

export async function resolvePlatformHandle(
  platform: Platform,
  handle: string,
): Promise<ResolvedIdentity | null> {
  const norm = handle.trim().replace(/^@/, '').toLowerCase();
  if (!norm) return null;

  const cacheKey = `${platform}:${norm}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached.value;

  let result: ResolvedIdentity | null = null;
  try {
    if (platform === 'twitch') result = await resolveTwitch(norm);
    else if (platform === 'youtube') result = await resolveYoutube(norm);
    else if (platform === 'kick') result = await resolveKick(norm);
  } catch {
    result = null;
  }

  cachePut(cacheKey, result);
  return result;
}

// IVR API — unauthenticated Twitch user lookup.
async function resolveTwitch(login: string): Promise<ResolvedIdentity | null> {
  const resp = await fetch(
    `https://api.ivr.fi/v2/twitch/user?login=${encodeURIComponent(login)}`,
    { signal: AbortSignal.timeout(5000) },
  );
  if (!resp.ok) return null;
  const data = (await resp.json()) as unknown;
  const arr = Array.isArray(data) ? data : [data];
  const first = arr[0] as {
    id?: string;
    displayName?: string;
    login?: string;
    logo?: string;
  } | undefined;
  if (!first?.id || !first.login) return null;
  return {
    userId: String(first.id),
    handleCanonical: first.login.toLowerCase(),
    displayName: first.displayName,
    avatarUrl: first.logo,
  };
}

// YouTube — scrape channel page to get channel_id from handle.
// The /@handle URL returns HTML containing "channelId":"UCxxx".
async function resolveYoutube(handle: string): Promise<ResolvedIdentity | null> {
  const resp = await fetch(`https://www.youtube.com/@${encodeURIComponent(handle)}`, {
    signal: AbortSignal.timeout(5000),
    headers: { 'User-Agent': 'Mozilla/5.0 UnityChat' },
  });
  if (!resp.ok) return null;
  const html = await resp.text();
  const channelIdMatch = html.match(/"channelId":"(UC[A-Za-z0-9_-]{22})"/);
  if (!channelIdMatch) return null;
  const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
  const avatarMatch = html.match(/"avatar":\{"thumbnails":\[\{"url":"([^"]+)"/);
  return {
    userId: channelIdMatch[1],
    handleCanonical: handle.toLowerCase(),
    displayName: titleMatch?.[1],
    avatarUrl: avatarMatch?.[1]?.replace(/\\u0026/g, '&'),
  };
}

// Kick — public channels endpoint.
async function resolveKick(slug: string): Promise<ResolvedIdentity | null> {
  const resp = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
    signal: AbortSignal.timeout(5000),
    headers: { 'User-Agent': 'Mozilla/5.0 UnityChat', 'Accept': 'application/json' },
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as {
    id?: number;
    slug?: string;
    user?: { username?: string; profile_pic?: string };
  };
  if (!data?.id || !data.slug) return null;
  return {
    userId: String(data.id),
    handleCanonical: data.slug.toLowerCase(),
    displayName: data.user?.username,
    avatarUrl: data.user?.profile_pic,
  };
}
