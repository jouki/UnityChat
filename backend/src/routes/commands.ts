import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { RateLimiter } from './chat.js';
import { broadcast } from '../sse/bus.js';
import { getWorkspaces, invalidateWorkspaces, twitchChannelsOf, workspaceForChannel, workspaceBySlug } from '../lib/zidolista.js';
import { invalidateLinkFilter } from '../lib/linkFilter.js';
import { invalidateGifAccess } from '../lib/gifAccess.js';
import { invalidateBlacklist } from './blacklist.js';
import { handleSfxWebhook } from './soundboard.js';
import { inboundAuthorized } from '../lib/inboundAuth.js';

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
  /** Surová odpověď do chatu (s %proměnnými%) — pro lokální náhled `/uc command`. */
  reply?: string;
  /** Konfigurace UnityChat Announcementu commandu (bez id/at) — pro lokální náhled. */
  announcement?: { text: string; textHtml: string; media: { url: string; kind: 'video' | 'image'; width?: number; height?: number; loop?: boolean; loopDelayMs?: number; stillUrl?: string | null } | null; hideChatReplyInUnityChat: boolean; hideBotReplies: string[]; hideInBrowserSource: boolean } | null;
}

const isHttps = (u: unknown): u is string => typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(u);

/** Loginy botů: lowercase, platný login, max 5 (stejně jako core normBotLogins; sdílí announcements.ts). */
export const botLogins = (v: unknown): string[] => Array.isArray(v) ? [...new Set(v.map((x) => String(x ?? '').trim().toLowerCase()).filter((x) => /^[a-z0-9_]{2,25}$/.test(x)))].slice(0, 5) : [];

function publicAnnouncement(raw: unknown): PublicCommand['announcement'] {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  const m = a.media && typeof a.media === 'object' ? (a.media as Record<string, unknown>) : null;
  const media = m && isHttps(m.url) ? {
    url: m.url, kind: m.kind === 'image' ? 'image' as const : 'video' as const,
    width: Number(m.width) > 0 ? Math.round(Number(m.width)) : undefined,
    height: Number(m.height) > 0 ? Math.round(Number(m.height)) : undefined,
    loop: m.loop !== false, loopDelayMs: Math.max(0, Math.min(60_000, Math.round(Number(m.loopDelayMs) || 0))),
    stillUrl: isHttps(m.stillUrl) ? m.stillUrl : null,
  } : null;
  const text = String(a.text ?? '').slice(0, 500);
  const textHtml = String(a.textHtml ?? '').slice(0, 4000);
  if (!media && !text.trim() && !textHtml.trim()) return null;
  return { text, textHtml, media, hideChatReplyInUnityChat: !!a.hideChatReplyInUnityChat, hideBotReplies: botLogins(a.hideBotReplies), hideInBrowserSource: !!a.hideInBrowserSource };
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
      reply: String(r.reply ?? '').slice(0, 500),
      announcement: publicAnnouncement(r.announcement),
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

export default async function commandRoutes(app: FastifyInstance) {
  const limiter = new RateLimiter(10, 10);

  /**
   * Webhook ze Židolišty po změně commandu (stejný klíč, opačný směr): zahodit
   * cache kanálů daného workspace, načíst znovu a klientům poslat SSE
   * `commands-change` (stejný bus jako /nicknames/stream), ať mají nový
   * command v našeptávání hned. `reason: "workspaces"` = změna mapování
   * kanálů / bota → obnovit registr workspaců (lib/zidolista.ts).
   */
  app.post<{ Body: { workspace?: string; reason?: string; data?: unknown } }>('/commands/invalidate', async (req, reply) => {
    if (!inboundAuthorized(req, reply)) return reply;
    const slug = String(req.body?.workspace || '').toLowerCase();
    const reason = String(req.body?.reason || 'update');
    // Změna blacklistu slov (stejný webhook) → jen cache blacklistu + SSE `blacklist-change`.
    if (reason === 'blacklist') {
      const channels = await invalidateBlacklist(slug, app.log);
      if (!channels.length) return reply.code(404).send({ ok: false, error: 'unknown_workspace' });
      return { ok: true, channels };
    }
    // Soundboard (katalog, odemčení, přehrání, zamítnutí) → cache katalogu + SSE `soundboard-*`.
    if (reason === 'sfx' || reason.startsWith('sfx-')) {
      const channels = await handleSfxWebhook(slug, reason, req.body?.data, app.log);
      if (!channels.length) return reply.code(404).send({ ok: false, error: 'unknown_workspace' });
      return { ok: true, channels };
    }
    // Změna nastavení donací (minimum, hlasy, účty…) → otevřené QR dono formuláře si config načtou hned.
    if (reason === 'donate') {
      const channels = await twitchChannelsOf(slug);
      if (!channels.length) return reply.code(404).send({ ok: false, error: 'unknown_workspace' });
      for (const channel of channels) broadcast('donate-config-change', { channel });
      app.log.info({ slug, channels }, 'donate: config change broadcast');
      return { ok: true, channels };
    }
    // Nastavení filtru odkazů (moderace část 3) → zahodit cache + ETag a načíst znovu (onLive čte jen cache).
    if (reason === 'link-filter') {
      const ws = await workspaceBySlug(slug);
      if (!ws) return reply.code(404).send({ ok: false, error: 'unknown_workspace' });
      const settings = await invalidateLinkFilter(ws.slug, app.log);
      app.log.info({ slug: ws.slug, enabled: settings.enabled, version: settings.version }, 'link filter: invalidated');
      return { ok: true, workspace: ws.slug, enabled: settings.enabled, version: settings.version };
    }
    // Odemčení GIFů (moderace část 4: label s akcí „Posílání GIFů", časovač, cooldown) → cache stavu pryč.
    if (reason === 'gif-access') {
      const ws = await workspaceBySlug(slug);
      if (!ws) return reply.code(404).send({ ok: false, error: 'unknown_workspace' });
      const dropped = invalidateGifAccess(ws.slug);
      app.log.info({ slug: ws.slug, dropped }, 'gif access: invalidated');
      return { ok: true, workspace: ws.slug };
    }
    if (reason === 'workspaces') { invalidateWorkspaces(); await getWorkspaces({ force: true, log: app.log }); }
    const channels = await twitchChannelsOf(slug);
    if (!channels.length) {
      if (reason === 'workspaces') { app.log.info({ slug, reason }, 'commands: workspaces refreshed (no twitch channel)'); return { ok: true, channels: [] }; }
      return reply.code(404).send({ ok: false, error: 'unknown_workspace' });
    }
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
    const slug = (await workspaceForChannel('twitch', channel))?.slug;
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
