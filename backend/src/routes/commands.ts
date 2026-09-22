import type { FastifyInstance } from 'fastify';
import { timingSafeEqual, createHash } from 'node:crypto';
import { config } from '../config.js';
import { RateLimiter } from './chat.js';
import { broadcast } from '../sse/bus.js';

/**
 * GET /commands?channel=<twitch login>
 *
 * Chat commandy streamera pro našeptávání „!" v panelu a na webu. Zdroj:
 * Židolišta (RobJewsALot server, `GET /integrations/:slug/chat-commands`,
 * hlavička `X-Api-Key`). Klíč zůstává tady na serveru — klient dostane jen
 * veřejná data (jméno, literál spouštěče, role). StreamElements commandy si
 * klient bere z veřejného SE API sám, tady se neslučují.
 *
 * Kanál → workspace Židolišty přes ZIDOLISTA_WORKSPACES ("robdiesalot=rob,…").
 * Cache 60 s per kanál; při výpadku Židolišty se vrací poslední známý stav.
 */

export interface CommandTrigger { kind: 'prefix' | 'regex'; value: string }

export interface PublicCommand {
  name: string;
  /** Literál, který se vloží do chatu (např. "!topd reset"). */
  trigger: string;
  /** Všechny literály commandu (první = trigger). */
  triggers: string[];
  /** Role, které command smí spustit (viewer/sub/vip/moderator/broadcaster). Prázdné = jen jmenovaní. */
  roles: string[];
  cooldownSeconds: number;
  source: 'zidolista';
}

const REGEX_META = /[[\](){}|*+?.\\^$]/;

/**
 * Spouštěč → literál pro našeptávač. Prefix je literál sám. U regexu se
 * odstraní kotvy a obvyklé „mezera nepovinná" tvary (`!topd ?reset`,
 * `!topd\s*reset`); když po tom zbude cokoli regexového, spouštěč se
 * vynechá — radši nic než nesmysl v chatu.
 */
export function triggerToLiteral(t: CommandTrigger): string | null {
  const raw = String(t?.value ?? '').trim();
  if (!raw) return null;
  if (t.kind !== 'regex') return raw.replace(/\s+/g, ' ');
  let v = raw.replace(/^\^/, '').replace(/\$$/, '');
  v = v.replace(/\\b/g, '');
  v = v.replace(/(?:\\s| )[?*]/g, ' ');       // " ?" / "\s*" → mezera
  v = v.replace(/\\s\+?/g, ' ');
  v = v.replace(/\\([!#@$.,:;\-/])/g, '$1');   // escapované běžné znaky
  v = v.replace(/\s+/g, ' ').trim();
  if (!v || REGEX_META.test(v)) return null;
  return v;
}

export function toPublicCommands(rows: unknown): PublicCommand[] {
  if (!Array.isArray(rows)) return [];
  const out: PublicCommand[] = [];
  for (const r of rows as Array<Record<string, unknown>>) {
    const triggers = (Array.isArray(r.triggers) ? r.triggers : [])
      .map((t) => triggerToLiteral(t as CommandTrigger))
      .filter((s): s is string => !!s);
    if (!triggers.length) continue;
    out.push({
      name: String(r.name ?? ''),
      trigger: triggers[0],
      triggers: [...new Set(triggers)],
      roles: Array.isArray(r.allowRoles) ? (r.allowRoles as unknown[]).map(String) : [],
      cooldownSeconds: Number(r.cooldownSeconds) || 0,
      source: 'zidolista',
    });
  }
  return out;
}

export function parseWorkspaceMap(csv: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of String(csv || '').split(',')) {
    const [ch, slug] = part.split('=').map((s) => s.trim().toLowerCase());
    if (ch && slug) m.set(ch, slug);
  }
  return m;
}

const CACHE_MS = 60_000;
interface CacheEntry { at: number; commands: PublicCommand[]; error?: string }
const cache = new Map<string, CacheEntry>();

async function fetchZidolista(slug: string): Promise<PublicCommand[]> {
  const r = await fetch(`${config.ZIDOLISTA_API_BASE.replace(/\/$/, '')}/integrations/${encodeURIComponent(slug)}/chat-commands`, {
    headers: { 'X-Api-Key': config.ZIDOLISTA_API_KEY, Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`zidolista HTTP ${r.status}`);
  const j = (await r.json()) as { ok?: boolean; commands?: unknown };
  if (!j.ok) throw new Error('zidolista not ok');
  return toPublicCommands(j.commands);
}

export function keyMatches(candidate: unknown): boolean {
  const key = config.ZIDOLISTA_API_KEY;
  const got = String(Array.isArray(candidate) ? candidate[0] : candidate ?? '').trim();
  if (!key || !got) return false;
  const a = createHash('sha256').update(key).digest();
  const b = createHash('sha256').update(got).digest();
  return timingSafeEqual(a, b);
}

export default async function commandRoutes(app: FastifyInstance) {
  const limiter = new RateLimiter(10, 10);
  const workspaces = parseWorkspaceMap(config.ZIDOLISTA_WORKSPACES);

  /**
   * Webhook ze Židolišty po změně commandu (stejný klíč, opačný směr): zahodit
   * cache kanálů daného workspace, načíst znovu a klientům poslat SSE
   * `commands-change` (stejný bus jako /nicknames/stream), ať mají nový
   * command v našeptávání hned.
   */
  app.post<{ Body: { workspace?: string; reason?: string } }>('/commands/invalidate', async (req, reply) => {
    if (!keyMatches(req.headers['x-api-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const slug = String(req.body?.workspace || '').toLowerCase();
    const channels = [...workspaces.entries()].filter(([, s]) => s === slug).map(([ch]) => ch);
    if (!channels.length) return reply.code(404).send({ ok: false, error: 'unknown_workspace' });
    for (const channel of channels) {
      cache.delete(channel);
      let count = 0;
      try { const commands = await fetchZidolista(slug); cache.set(channel, { at: Date.now(), commands }); count = commands.length; }
      catch (e) { app.log.warn({ channel, err: (e as Error).message }, 'commands: refetch after invalidate failed'); }
      broadcast('commands-change', { channel, reason: String(req.body?.reason || 'update'), count });
    }
    app.log.info({ slug, channels, reason: req.body?.reason }, 'commands: invalidated');
    return { ok: true, channels };
  });

  app.get<{ Querystring: { channel?: string } }>('/commands', async (req, reply) => {
    if (!limiter.allow(req.ip)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const channel = String(req.query.channel || '').toLowerCase().replace(/^@/, '');
    if (!/^[a-z0-9_]{1,40}$/.test(channel)) return reply.code(400).send({ ok: false, error: 'bad_channel' });
    // Bez HTTP cache: po SSE `commands-change` si klient tahá seznam znovu a cache prohlížeče by mu vrátila starý stav.
    reply.header('Cache-Control', 'no-store');
    const slug = workspaces.get(channel);
    if (!slug || !config.ZIDOLISTA_API_KEY) return { ok: true, channel, sources: [], commands: [] };

    const hit = cache.get(channel);
    if (hit && Date.now() - hit.at < CACHE_MS) return { ok: true, channel, sources: ['zidolista'], commands: hit.commands, ...(hit.error ? { stale: true } : {}) };
    try {
      const commands = await fetchZidolista(slug);
      cache.set(channel, { at: Date.now(), commands });
      return { ok: true, channel, sources: ['zidolista'], commands };
    } catch (e) {
      const msg = (e as Error).message;
      app.log.warn({ channel, slug, err: msg }, 'commands: zidolista fetch failed');
      const stale = hit?.commands ?? [];
      cache.set(channel, { at: Date.now(), commands: stale, error: msg });
      return { ok: true, channel, sources: ['zidolista'], commands: stale, stale: true };
    }
  });
}
