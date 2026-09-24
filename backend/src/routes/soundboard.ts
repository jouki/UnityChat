// Soundboard (spec docs/superpowers/specs/2026-09-24-soundboard-se-tiers-design.md,
// kontrakt Židolišty v RobJewsALot docs/reference/api-endpoints.md „Sound efekty").
//
//   GET /soundboard?channel=&platform=   katalog + stav přihlášeného diváka (Bearer volitelně)
//   PUT /soundboard/favorites            { channel, soundId, on }   (Bearer)
//
// Zvuky, tiery, odemčení i cooldowny počítá Židolišta; tady se jen skládá odpověď pro
// klienta (katalog z cache, stav diváka s ověřenou rolí z ingestu) a drží se oblíbené
// a počty přehrání per účet. Změny hlásí Židolišta webhookem (/commands/invalidate,
// reason sfx*) → handleSfxWebhook() → SSE soundboard-* na /nicknames/stream.
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { soundboardFavorites, soundboardUsage, webIdentities } from '../db/schema.js';
import { bearerToken, listIdentities, requireWebSession, validateWebSession } from '../lib/webAuth.js';
import { chatRole } from '../lib/chatRole.js';
import { twitchChannelsOf, workspaceForChannel } from '../lib/zidolista.js';
import { broadcast } from '../sse/bus.js';
import { RateLimiter } from './chat.js';

type Platform = 'twitch' | 'kick' | 'youtube';
const PLATFORMS: Platform[] = ['twitch', 'kick', 'youtube'];
const RECENT_MAX = 8;
const CATALOG_CACHE_MS = 60_000;

export type SoundIcon = { kind: 'emoji'; value: string } | { kind: '7tv'; id: string; name: string; url: string };
export interface Sound { id: number; name: string; displayName: string | null; tier: number; emoji: string | null; icon: SoundIcon | null; url: string; durationMs: number | null }

/** Ikona zvuku z katalogu: emoji, nebo 7TV emote (URL jen z cdn.7tv.app — obrázek se vkládá do klienta). */
export function normalizeIcon(v: unknown, emoji: string | null): SoundIcon | null {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  if (o.kind === '7tv' && typeof o.id === 'string' && /^[A-Za-z0-9]{1,40}$/.test(o.id)
    && typeof o.url === 'string' && /^https:\/\/cdn\.7tv\.app\/emote\/[A-Za-z0-9]{1,40}\/[1-4]x\.(webp|avif|png|gif)$/.test(o.url)) {
    return { kind: '7tv', id: o.id, name: typeof o.name === 'string' ? o.name.slice(0, 40) : '', url: o.url };
  }
  if (o.kind === 'emoji' && typeof o.value === 'string' && o.value.trim() && o.value.length <= 16) return { kind: 'emoji', value: o.value.trim() };
  return emoji ? { kind: 'emoji', value: emoji } : null;
}
export interface Tier { tier: number; name: string | null; position: number }
interface Catalog { at: number; etag: string | null; tiers: Tier[]; sounds: Sound[]; serverNow: string | null; error?: string }

const isHttps = (u: unknown): u is string => typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(u);
const posInt = (v: unknown): number | null => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : null);
const iso = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);

/** Katalog ze Židolišty → jen pole, která klient potřebuje; nevalidní položky pryč. */
export function normalizeCatalog(raw: unknown): { tiers: Tier[]; sounds: Sound[] } {
  const j = (raw && typeof raw === 'object' ? raw : {}) as { tiers?: unknown; sounds?: unknown };
  const sounds: Sound[] = [];
  for (const s of Array.isArray(j.sounds) ? j.sounds : []) {
    const o = (s ?? {}) as Record<string, unknown>;
    const id = posInt(o.id); const tier = posInt(o.tier);
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    if (!id || !tier || !name || name.length > 40 || /\s/.test(name) || !isHttps(o.url)) continue;
    const emoji = typeof o.emoji === 'string' && o.emoji.trim() && o.emoji.length <= 16 ? o.emoji.trim() : null;
    const durationMs = Number.isFinite(o.durationMs) && (o.durationMs as number) > 0 ? Math.round(o.durationMs as number) : null;
    const displayName = typeof o.displayName === 'string' && o.displayName.trim() ? o.displayName.trim().slice(0, 40) : null;
    sounds.push({ id, name, displayName, tier, emoji, icon: normalizeIcon(o.icon, emoji), url: o.url, durationMs });
  }
  const tiers = new Map<number, Tier>();
  for (const t of Array.isArray(j.tiers) ? j.tiers : []) {
    const o = (t ?? {}) as Record<string, unknown>;
    const tier = posInt(o.tier);
    // position = pořadí z dashboardu Židolišty (v1.2); bez něj pořadí podle čísla tieru.
    if (tier) tiers.set(tier, { tier, name: typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 40) : null, position: posInt(o.position) ?? tier });
  }
  // Tier, který má zvuky, ale v seznamu tierů chybí → doplnit bez názvu.
  for (const s of sounds) if (!tiers.has(s.tier)) tiers.set(s.tier, { tier: s.tier, name: null, position: s.tier });
  const pos = new Map([...tiers.values()].map((t) => [t.tier, t.position]));
  return {
    tiers: [...tiers.values()].sort((a, b) => a.position - b.position || a.tier - b.tier),
    sounds: sounds.sort((a, b) => (pos.get(a.tier)! - pos.get(b.tier)!) || a.name.localeCompare(b.name, 'cs', { sensitivity: 'base' })),
  };
}

/** Stav diváka ze Židolišty (sfx-state) → tvar `me` pro klienta (bez identity). */
export interface StateTier { tier: number; startedAt: string | null; expiresAt: string | null; paused: boolean; remainingMs: number | null; available: boolean; totalMs: number | null }
const nonNeg = (v: unknown): number | null => (Number.isFinite(v) && (v as number) >= 0 ? Math.round(v as number) : null);

/** Kontrakt v1.1: zmrazený tier = paused + remainingMs (zamrzlý zbytek), available = smí se přehrát, totalMs = délka se sečtenými prodlouženími. */
export function normalizeState(raw: unknown): { role: string; tiers: StateTier[]; cooldown: { globalReadyAt: string | null; userReadyAt: string | null } } {
  const j = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const tiers = (Array.isArray(j.tiers) ? j.tiers : [])
    .map((t) => (t ?? {}) as Record<string, unknown>)
    .filter((t) => posInt(t.tier))
    .map((t) => {
      const paused = t.paused === true;
      return { tier: t.tier as number, startedAt: iso(t.startedAt), expiresAt: paused ? null : iso(t.expiresAt), paused, remainingMs: paused ? nonNeg(t.remainingMs) : null, available: !paused && t.available !== false, totalMs: nonNeg(t.totalMs) };
    });
  const cd = (j.cooldown && typeof j.cooldown === 'object' ? j.cooldown : {}) as Record<string, unknown>;
  return { role: typeof j.role === 'string' ? j.role : 'viewer', tiers, cooldown: { globalReadyAt: iso(cd.globalReadyAt), userReadyAt: iso(cd.userReadyAt) } };
}

const base = () => config.ZIDOLISTA_API_BASE.replace(/\/$/, '');
const catalogs = new Map<string, Catalog>();   // klíč = slug workspace

async function fetchCatalog(slug: string, prev?: Catalog): Promise<Catalog> {
  const r = await fetch(`${base()}/integrations/${encodeURIComponent(slug)}/sound-effects`, {
    headers: { 'X-Api-Key': config.ZIDOLISTA_API_KEY, Accept: 'application/json', ...(prev?.etag ? { 'If-None-Match': prev.etag } : {}) },
    signal: AbortSignal.timeout(8000),
  });
  if (r.status === 304 && prev) return { ...prev, at: Date.now(), error: undefined };
  // Endpoint ještě neexistuje (Židolišta ho nasazuje) = prázdný katalog, ne chyba.
  if (r.status === 404) return { at: Date.now(), etag: null, tiers: [], sounds: [], serverNow: null };
  if (!r.ok) throw new Error(`zidolista HTTP ${r.status}`);
  const j = (await r.json()) as { serverNow?: unknown };
  return { at: Date.now(), etag: r.headers.get('etag'), ...normalizeCatalog(j), serverNow: iso(j.serverNow) };
}

async function getCatalog(slug: string, log: FastifyInstance['log']): Promise<Catalog> {
  const hit = catalogs.get(slug);
  if (hit && Date.now() - hit.at < CATALOG_CACHE_MS) return hit;
  try { const c = await fetchCatalog(slug, hit); catalogs.set(slug, c); return c; }
  catch (e) {
    const msg = (e as Error).message;
    log.warn({ slug, err: msg }, 'soundboard: catalog fetch failed');
    const stale: Catalog = hit ? { ...hit, at: Date.now(), error: msg } : { at: Date.now(), etag: null, tiers: [], sounds: [], serverNow: null, error: msg };
    catalogs.set(slug, stale);
    return stale;
  }
}

// sfx-state per divák: Židolišta má limit na IP a všechna volání jdou odsud. Po SSE
// soundboard-change se ptají všichni klienti naráz → souběžné dotazy na stejný klíč se
// sloučí a výsledek drží 2 s. Webhook změny (sfx-unlocks/-played) cache maže.
const STATE_CACHE_MS = 2000;
const states = new Map<string, { at: number; p: Promise<Record<string, unknown> | null> }>();

function cachedState(slug: string, platform: Platform, userId: string, role: string) {
  const key = `${slug}|${platform}|${userId}|${role}`;
  const hit = states.get(key);
  if (hit && Date.now() - hit.at < STATE_CACHE_MS) return hit.p;
  const p = fetchState(slug, platform, userId, role);
  states.set(key, { at: Date.now(), p });
  p.catch(() => states.delete(key));
  if (states.size > 5000) for (const [k, v] of states) if (Date.now() - v.at >= STATE_CACHE_MS) states.delete(k);
  return p;
}

function dropStates(slug: string): void {
  for (const k of states.keys()) if (k.startsWith(`${slug}|`)) states.delete(k);
}

async function fetchState(slug: string, platform: Platform, userId: string, role: string) {
  const q = new URLSearchParams({ platform, userId, role });
  const r = await fetch(`${base()}/integrations/${encodeURIComponent(slug)}/sfx-state?${q}`, {
    headers: { 'X-Api-Key': config.ZIDOLISTA_API_KEY, Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`zidolista HTTP ${r.status}`);
  return (await r.json()) as Record<string, unknown>;
}

/**
 * Webhook ze Židolišty (přes /commands/invalidate, reason sfx / sfx-unlocks / sfx-played /
 * sfx-denied). Vrací kanály workspace; prázdné = neznámý workspace.
 */
export async function handleSfxWebhook(slug: string, reason: string, data: unknown, log: FastifyInstance['log']): Promise<string[]> {
  const channels = await twitchChannelsOf(slug);
  if (!channels.length) return channels;
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  if (reason === 'sfx-unlocks' || reason === 'sfx-played') dropStates(slug);
  if (reason === 'sfx' || reason === 'sfx-unlocks') {
    if (reason === 'sfx') catalogs.delete(slug);
    for (const channel of channels) broadcast('soundboard-change', { channel, reason });
  } else if (reason === 'sfx-played' || reason === 'sfx-denied') {
    const platform = PLATFORMS.includes(d.platform as Platform) ? (d.platform as Platform) : null;
    const userId = typeof d.userId === 'string' || typeof d.userId === 'number' ? String(d.userId) : null;
    if (!platform || !userId) { log.warn({ slug, reason }, 'soundboard: webhook without platform/userId'); return channels; }
    const soundId = posInt(d.soundId);
    const name = typeof d.name === 'string' ? d.name.slice(0, 40) : null;
    if (reason === 'sfx-played') {
      if (soundId) await countUsage(slug, platform, userId, soundId).catch((e) => log.warn({ err: (e as Error).message }, 'soundboard: usage count failed'));
      for (const channel of channels) broadcast('soundboard-played', { channel, soundId, name, platform, userId, playedAt: iso(d.playedAt), globalReadyAt: iso(d.globalReadyAt), userReadyAt: iso(d.userReadyAt) });
    } else {
      const why = ['cooldown', 'locked', 'unknown'].includes(d.reason as string) ? d.reason : 'unknown';
      for (const channel of channels) broadcast('soundboard-denied', { channel, name, platform, userId, reason: why, retryAt: iso(d.retryAt) });
    }
  }
  log.info({ slug, reason, channels }, 'soundboard: webhook');
  return channels;
}

/** Přehrání → +1 do „často používaných" účtu, kterému patří identita (platform, userId). */
async function countUsage(slug: string, platform: Platform, userId: string, soundId: number): Promise<void> {
  const [ident] = await db.select({ accountId: webIdentities.accountId }).from(webIdentities)
    .where(and(eq(webIdentities.platform, platform), eq(webIdentities.platformUserId, userId))).limit(1);
  if (!ident) return;   // divák UnityChat účet nemá — nic k zapamatování
  await db.insert(soundboardUsage)
    .values({ accountId: ident.accountId, workspace: slug, soundId, count: 1, lastUsedAt: new Date() })
    .onConflictDoUpdate({ target: [soundboardUsage.accountId, soundboardUsage.workspace, soundboardUsage.soundId], set: { count: sql`${soundboardUsage.count} + 1`, lastUsedAt: new Date() } });
}

const Channel = z.string().transform((s) => s.toLowerCase().replace(/^@/, '')).pipe(z.string().regex(/^[a-z0-9_]{1,40}$/));
const FavBody = z.object({ channel: Channel, soundId: z.number().int().positive(), on: z.boolean() });

export default async function soundboardRoutes(app: FastifyInstance) {
  const limiter = new RateLimiter(10, 10);
  const favLimiter = new RateLimiter(20, 5);

  app.get<{ Querystring: { channel?: string; platform?: string } }>('/soundboard', async (req, reply) => {
    if (!limiter.allow(req.ip)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const ch = Channel.safeParse(req.query.channel ?? '');
    if (!ch.success) return reply.code(400).send({ ok: false, error: 'bad_channel' });
    const platform: Platform = PLATFORMS.includes(req.query.platform as Platform) ? (req.query.platform as Platform) : 'twitch';
    reply.header('Cache-Control', 'no-store');

    const raw = bearerToken(req);
    const accountId = raw ? await validateWebSession(raw) : null;
    const empty = { ok: true, channel: ch.data, platform, serverNow: new Date().toISOString(), loggedIn: accountId !== null, tiers: [], sounds: [], me: null, favorites: [], recent: [] };
    const slug = (await workspaceForChannel('twitch', ch.data))?.slug;
    if (!slug || !config.ZIDOLISTA_API_KEY) return empty;

    const cat = await getCatalog(slug, app.log);
    const out = { ...empty, serverNow: cat.serverNow ?? empty.serverNow, tiers: cat.tiers, sounds: cat.sounds, ...(cat.error ? { stale: true } : {}) };
    if (accountId === null || !cat.sounds.length) return out;

    const [favs, usage, idents] = await Promise.all([
      db.select({ soundId: soundboardFavorites.soundId }).from(soundboardFavorites)
        .where(and(eq(soundboardFavorites.accountId, accountId), eq(soundboardFavorites.workspace, slug))).orderBy(soundboardFavorites.createdAt),
      db.select({ soundId: soundboardUsage.soundId }).from(soundboardUsage)
        .where(and(eq(soundboardUsage.accountId, accountId), eq(soundboardUsage.workspace, slug)))
        .orderBy(desc(soundboardUsage.count), desc(soundboardUsage.lastUsedAt)).limit(RECENT_MAX),
      listIdentities(accountId),
    ]);
    const known = new Set(cat.sounds.map((s) => s.id));
    const res = { ...out, favorites: favs.map((f) => f.soundId).filter((id) => known.has(id)), recent: usage.map((u) => u.soundId).filter((id) => known.has(id)) };

    const ident = idents.find((i) => i.platform === platform);
    if (!ident) return res;
    const role = await chatRole(platform, ident.login, ch.data);
    // Přihlášený divák bez stavu od Židolišty (nic odemčeno / výpadek) = me s prázdnými tiery,
    // ne null: null klient bere jako „nepřipojený účet" a nabízel přihlášení (2026-09-24).
    const noState = { platform, userId: ident.platformUserId, login: ident.login, ...normalizeState({}), role };
    try {
      const st = await cachedState(slug, platform, ident.platformUserId, role);
      if (!st) return { ...res, me: noState };
      return { ...res, serverNow: iso(st.serverNow) ?? res.serverNow, me: { platform, userId: ident.platformUserId, login: ident.login, ...normalizeState(st), role } };
    } catch (e) {
      app.log.warn({ slug, platform, err: (e as Error).message }, 'soundboard: sfx-state failed');
      return { ...res, stale: true, me: noState };
    }
  });

  app.put('/soundboard/favorites', { preHandler: requireWebSession }, async (req, reply) => {
    if (!favLimiter.allow(req.ip)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const body = FavBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: 'bad_body' });
    const slug = (await workspaceForChannel('twitch', body.data.channel))?.slug;
    if (!slug) return reply.code(404).send({ ok: false, error: 'unknown_channel' });
    const accountId = req.webAccountId!;
    const key = and(eq(soundboardFavorites.accountId, accountId), eq(soundboardFavorites.workspace, slug), eq(soundboardFavorites.soundId, body.data.soundId));
    if (body.data.on) await db.insert(soundboardFavorites).values({ accountId, workspace: slug, soundId: body.data.soundId }).onConflictDoNothing();
    else await db.delete(soundboardFavorites).where(key);
    return { ok: true };
  });
}
