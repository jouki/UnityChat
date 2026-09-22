// Registr workspaců Židolišty (RobJewsALot server): jediný zdroj pravdy pro
// mapování workspace ↔ kanály platforem + nastavení bota. Čte se z
// `GET <ZIDOLISTA_API_BASE>/integrations/workspaces` (X-Api-Key), cache 60 s,
// při výpadku poslední známý stav; když Židolišta nikdy neodpověděla, platí
// env `ZIDOLISTA_WORKSPACES` ("robdiesalot=rob,…", jen Twitch). Změna v
// Židolištce → webhook `POST /commands/invalidate` s `reason: "workspaces"`.
//
// Stream pro integraci (sse/integrationStream.ts) potřebuje mapování synchronně
// (volá se z ingest onLive), proto `workspaceForChannelSync` čte jen cache,
// kterou drží čerstvou `startWorkspaceRefresh()` ze serveru.
import { config } from '../config.js';

export type Platform = 'twitch' | 'kick' | 'youtube';
export const PLATFORMS: Platform[] = ['twitch', 'kick', 'youtube'];

export interface WorkspaceInfo {
  slug: string;
  channels: Record<Platform, string | null>;
  bot: {
    mode: 'sb' | 'shared' | 'own';
    displayName: string;
    ownLogins?: Partial<Record<Platform, string>>;
  };
}

const CACHE_MS = 60_000;
let cache: { at: number; list: WorkspaceInfo[]; source: 'zidolista' | 'env' } | null = null;
let inflight: Promise<WorkspaceInfo[]> | null = null;

const normChannel = (v: unknown): string | null => {
  const s = String(v ?? '').trim().toLowerCase().replace(/^@/, '');
  return /^[a-z0-9_.-]{1,60}$/.test(s) ? s : null;
};

/** Čistý převod odpovědi Židolišty na WorkspaceInfo[] (testovatelné bez sítě). */
export function normalizeWorkspaces(raw: unknown): WorkspaceInfo[] {
  const list = (raw && typeof raw === 'object' && Array.isArray((raw as { workspaces?: unknown }).workspaces))
    ? ((raw as { workspaces: unknown[] }).workspaces)
    : Array.isArray(raw) ? raw : [];
  const out: WorkspaceInfo[] = [];
  for (const item of list as Array<Record<string, unknown>>) {
    const slug = String(item?.slug ?? '').trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,40}$/.test(slug)) continue;
    const ch = (item.channels && typeof item.channels === 'object' ? item.channels : {}) as Record<string, unknown>;
    const bot = (item.bot && typeof item.bot === 'object' ? item.bot : {}) as Record<string, unknown>;
    const mode = bot.mode === 'own' || bot.mode === 'shared' ? bot.mode : 'sb';
    const own = (bot.ownLogins && typeof bot.ownLogins === 'object' ? bot.ownLogins : {}) as Record<string, unknown>;
    const ownLogins: Partial<Record<Platform, string>> = {};
    for (const p of PLATFORMS) { const l = normChannel(own[p]); if (l) ownLogins[p] = l; }
    out.push({
      slug,
      channels: { twitch: normChannel(ch.twitch), kick: normChannel(ch.kick), youtube: normChannel(ch.youtube) },
      bot: { mode, displayName: String(bot.displayName ?? '').trim().slice(0, 40) || 'JoukiBOT', ...(Object.keys(ownLogins).length ? { ownLogins } : {}) },
    });
  }
  return out;
}

/** Fallback z env "kanál=slug,…" (jen Twitch, sdílený bot). */
export function workspacesFromEnv(csv: string): WorkspaceInfo[] {
  const bySlug = new Map<string, WorkspaceInfo>();
  for (const part of String(csv || '').split(',')) {
    const [ch, slug] = part.split('=').map((s) => s.trim().toLowerCase());
    if (!ch || !slug) continue;
    const ws = bySlug.get(slug) ?? { slug, channels: { twitch: null, kick: null, youtube: null }, bot: { mode: 'shared' as const, displayName: 'JoukiBOT' } };
    if (!ws.channels.twitch) ws.channels.twitch = ch;
    bySlug.set(slug, ws);
  }
  return [...bySlug.values()];
}

async function fetchWorkspaces(): Promise<WorkspaceInfo[]> {
  const r = await fetch(`${config.ZIDOLISTA_API_BASE.replace(/\/$/, '')}/integrations/workspaces`, {
    headers: { 'X-Api-Key': config.ZIDOLISTA_API_KEY, Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`zidolista workspaces HTTP ${r.status}`);
  const j = (await r.json()) as { ok?: boolean };
  if (!j.ok) throw new Error('zidolista workspaces not ok');
  return normalizeWorkspaces(j);
}

/** Aktuální seznam: čerstvá cache, jinak fetch; při chybě poslední známý stav nebo env. */
export async function getWorkspaces(opts: { force?: boolean; log?: { warn: (o: object, m: string) => void } } = {}): Promise<WorkspaceInfo[]> {
  if (!opts.force && cache && Date.now() - cache.at < CACHE_MS) return cache.list;
  if (!config.ZIDOLISTA_API_KEY) return cache?.list ?? (cache = { at: Date.now(), list: workspacesFromEnv(config.ZIDOLISTA_WORKSPACES), source: 'env' }).list;
  if (!inflight) {
    inflight = fetchWorkspaces()
      .then((list) => { cache = { at: Date.now(), list, source: 'zidolista' }; return list; })
      .catch((e) => {
        opts.log?.warn({ err: (e as Error).message }, 'zidolista workspaces: fetch failed');
        if (cache) { cache.at = Date.now(); return cache.list; }
        cache = { at: Date.now(), list: workspacesFromEnv(config.ZIDOLISTA_WORKSPACES), source: 'env' };
        return cache.list;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

export function invalidateWorkspaces(): void { if (cache) cache.at = 0; }
export function workspacesSource(): 'zidolista' | 'env' | 'none' { return cache?.source ?? 'none'; }

/** Synchronní varianta z cache (ingest onLive). */
export function workspaceForChannelSync(platform: Platform, channel: string): WorkspaceInfo | null {
  const c = channel.toLowerCase().replace(/^@/, '');
  return cache?.list.find((w) => w.channels[platform] === c) ?? null;
}

export async function workspaceForChannel(platform: Platform, channel: string): Promise<WorkspaceInfo | null> {
  await getWorkspaces();
  return workspaceForChannelSync(platform, channel);
}

export async function workspaceBySlug(slug: string): Promise<WorkspaceInfo | null> {
  const list = await getWorkspaces();
  const s = slug.toLowerCase();
  return list.find((w) => w.slug === s) ?? null;
}

/** Twitch kanály workspace (commandy/announcementy jsou per Twitch login kanálu). */
export async function twitchChannelsOf(slug: string): Promise<string[]> {
  const ws = await workspaceBySlug(slug);
  return ws?.channels.twitch ? [ws.channels.twitch] : [];
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;
/** Držet cache čerstvou pro synchronní použití (server boot). */
export function startWorkspaceRefresh(log?: { warn: (o: object, m: string) => void }): void {
  void getWorkspaces({ log });
  if (refreshTimer) return;
  refreshTimer = setInterval(() => { void getWorkspaces({ log }); }, CACHE_MS);
  refreshTimer.unref?.();
}
export function stopWorkspaceRefresh(): void { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } }
