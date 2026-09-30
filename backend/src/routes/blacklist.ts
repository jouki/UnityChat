import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { RateLimiter } from './chat.js';
import { broadcast } from '../sse/bus.js';
import { twitchChannelsOf, workspaceForChannel, zidolistaBase, zidolistaFetch } from '../lib/zidolista.js';

/**
 * GET /blacklist?channel=<twitch login> — blacklist slov pro cenzuru v UnityChatu
 * (text zpráv + jména; addon, web, OBS). Zdroj pravdy je Židolišta
 * (`GET <ZIDOLISTA_API_BASE>/integrations/:slug/blacklist`, X-Api-Key) — tentýž
 * seznam, který v dashboardu spravují pro TTS a který čtou i další projekty.
 * Cache 60 s; při výpadku Židolišty poslední známý stav (`stale`). Změnu hlásí
 * Židolišta webhookem `POST /commands/invalidate {reason:"blacklist"}` →
 * invalidateBlacklist() → SSE `blacklist-change` na /nicknames/stream.
 */

const CACHE_MS = 60_000;
interface Entry { at: number; terms: string[]; updatedAt: string | null; etag: string | null; error?: string }
const cache = new Map<string, Entry>();   // klíč = slug workspace

export function normalizeTerms(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((x) => String(x ?? '').trim().toLowerCase()).filter((x) => x && x.length <= 60))].slice(0, 5000);
}

async function fetchBlacklist(slug: string, prev?: Entry): Promise<Entry> {
  const r = await zidolistaFetch(`${zidolistaBase()}/integrations/${encodeURIComponent(slug)}/blacklist`, {
    headers: prev?.etag ? { 'If-None-Match': prev.etag } : {},
    signal: AbortSignal.timeout(8000),
  });
  if (r.status === 304 && prev) return { ...prev, at: Date.now(), error: undefined };
  // Endpoint ještě neexistuje (Židolišta ho nasazuje) = prázdný seznam, ne chyba.
  if (r.status === 404) return { at: Date.now(), terms: [], updatedAt: null, etag: null };
  if (!r.ok) throw new Error(`zidolista HTTP ${r.status}`);
  const j = (await r.json()) as { terms?: unknown; updatedAt?: unknown };
  return { at: Date.now(), terms: normalizeTerms(j.terms), updatedAt: typeof j.updatedAt === 'string' ? j.updatedAt : null, etag: r.headers.get('etag') };
}

/** Webhook ze Židolišty (přes /commands/invalidate): zahodit cache a klientům poslat SSE. */
export async function invalidateBlacklist(slug: string, log: FastifyInstance['log']): Promise<string[]> {
  cache.delete(slug);
  const channels = await twitchChannelsOf(slug);
  let count = 0;
  try { const e = await fetchBlacklist(slug); cache.set(slug, e); count = e.terms.length; }
  catch (err) { log.warn({ slug, err: (err as Error).message }, 'blacklist: refetch after invalidate failed'); }
  for (const channel of channels) broadcast('blacklist-change', { channel, count });
  log.info({ slug, channels, count }, 'blacklist: invalidated');
  return channels;
}

/**
 * Blacklist kanálu (Twitch login) z cache / Židolišty — sdílí GET /blacklist i server (přejmenování
 * modem, moderace část 2). Výpadek Židolišty = poslední známý stav (stale), jinak prázdný seznam.
 */
export async function blacklistFor(channel: string, log: FastifyInstance['log']): Promise<{ terms: string[]; updatedAt: string | null; stale?: true }> {
  const slug = (await workspaceForChannel('twitch', channel))?.slug;
  if (!slug || !config.ZIDOLISTA_API_KEY) return { terms: [], updatedAt: null };
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < CACHE_MS) return { terms: hit.terms, updatedAt: hit.updatedAt, ...(hit.error ? { stale: true as const } : {}) };
  try {
    const e = await fetchBlacklist(slug, hit);
    cache.set(slug, e);
    return { terms: e.terms, updatedAt: e.updatedAt };
  } catch (err) {
    const msg = (err as Error).message;
    log.warn({ channel, slug, err: msg }, 'blacklist: zidolista fetch failed');
    const stale: Entry = hit ? { ...hit, at: Date.now(), error: msg } : { at: Date.now(), terms: [], updatedAt: null, etag: null, error: msg };
    cache.set(slug, stale);
    return { terms: stale.terms, updatedAt: stale.updatedAt, stale: true };
  }
}

export default async function blacklistRoutes(app: FastifyInstance) {
  const limiter = new RateLimiter(10, 10);

  app.get<{ Querystring: { channel?: string } }>('/blacklist', async (req, reply) => {
    if (!limiter.allow(req.ip)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const channel = String(req.query.channel || '').toLowerCase().replace(/^@/, '');
    if (!/^[a-z0-9_]{1,40}$/.test(channel)) return reply.code(400).send({ ok: false, error: 'bad_channel' });
    // Bez HTTP cache: po SSE `blacklist-change` si klient seznam stáhne znovu.
    reply.header('Cache-Control', 'no-store');
    return { ok: true, channel, ...(await blacklistFor(channel, app.log)) };
  });
}
