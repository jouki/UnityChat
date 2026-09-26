// Návrhy zvukových efektů (spec docs/superpowers/specs/2026-09-25-sfx-navrhy-design.md,
// kontrakt Židolišty v sekci „Dohodnutý kontrakt“). Proxy na Židolištu s identitou
// z přihlášení (klient identitu ani roli neposílá, server je ověří sám):
//
//   POST /soundboard/requests/prepare { channel, platform, url }                         (Bearer)
//   POST /soundboard/requests { channel, platform, previewId, startMs, endMs, name, note? } (Bearer)
//   GET  /soundboard/requests?channel=                                                   (Bearer)
//
// Limit 10 návrhů/den + 30/měsíc (kalendářní v Europe/Prague) na účet UnityChatu se počítá
// z návrhů, které Židolišta vrací pro identity účtu (createdAt) — bez vlastní tabulky.
// Kontrola před prepare i před submit. Změnu stavu hlásí Židolišta webhookem
// reason `sfx-request` → handleSfxRequestWebhook() → SSE `sfx-request` na /nicknames/stream.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { listIdentities, requireWebSession, type PublicIdentity } from '../lib/webAuth.js';
import { chatRole } from '../lib/chatRole.js';
import { twitchChannelsOf, workspaceForChannel, zidolistaBase, zidolistaFetch, type Platform } from '../lib/zidolista.js';
import { broadcast } from '../sse/bus.js';
import { RateLimiter } from './chat.js';

export const DAY_MAX = 10;
export const MONTH_MAX = 30;
export const MAX_CLIP_MS = 30_000;
const LIST_CACHE_MS = 15_000;

// ---- čisté části (testy v sfxRequests.test.ts) ----

const pragueDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit', day: '2-digit' });
/** Kalendářní den v Praze jako „YYYY-MM-DD“ (sv-SE formátuje ISO pořadím). */
export const pragueDay = (d: Date): string => pragueDate.format(d);

export interface Limits { dayUsed: number; dayMax: number; monthUsed: number; monthMax: number }

/** Počty návrhů v dnešním dni a měsíci (Praha) podle createdAt. */
export function computeLimits(createdAt: Array<string | null | undefined>, now = new Date()): Limits {
  const today = pragueDay(now);
  const month = today.slice(0, 7);
  let dayUsed = 0, monthUsed = 0;
  for (const c of createdAt) {
    const t = Date.parse(c ?? '');
    if (Number.isNaN(t)) continue;
    const d = pragueDay(new Date(t));
    if (d.slice(0, 7) === month) monthUsed++;
    if (d === today) dayUsed++;
  }
  return { dayUsed, dayMax: DAY_MAX, monthUsed, monthMax: MONTH_MAX };
}

/** Vyčerpaný limit → chybový kód (den má přednost), jinak null. */
export function limitError(l: Limits): 'limit_day' | 'limit_month' | null {
  if (l.dayUsed >= l.dayMax) return 'limit_day';
  if (l.monthUsed >= l.monthMax) return 'limit_month';
  return null;
}

/** Kódy chyb Židolišty, které jdou klientovi beze změny (se stejným HTTP statusem). */
export const PASS_CODES = new Set(['bad_url', 'unsupported', 'too_long', 'too_large', 'download_failed', 'youtube_blocked', 'busy', 'rate_limited', 'expired', 'bad_range', 'bad_name', 'name_taken', 'timeout', 'tool_missing']);

/** Odpověď Židolišty s chybou → { status, error } pro klienta. */
export function mapUpstreamError(status: number, json: unknown): { status: number; error: string } {
  const code = json && typeof json === 'object' ? (json as { error?: unknown }).error : undefined;
  if (typeof code === 'string' && PASS_CODES.has(code) && status >= 400 && status < 600) return { status, error: code };
  // Klíč / workspace / tvar těla = chyba mezi servery, ne diváka.
  return { status: 502, error: 'zidolista_unavailable' };
}

export interface SfxRequestItem { requestId: number; name: string; status: 'pending' | 'approved' | 'rejected'; reason: string | null; createdAt: string; decidedAt: string | null; soundName: string | null; platform: Platform }
const STATUSES = new Set(['pending', 'approved', 'rejected']);

/** Seznam návrhů jedné identity ze Židolišty → jen validní položky v tvaru pro klienta. */
export function normalizeRequests(raw: unknown, platform: Platform): SfxRequestItem[] {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { requests?: unknown }).requests) ? (raw as { requests: unknown[] }).requests : [];
  const out: SfxRequestItem[] = [];
  for (const r of list) {
    const o = (r ?? {}) as Record<string, unknown>;
    const id = Number(o.requestId);
    if (!Number.isSafeInteger(id) || id <= 0 || typeof o.name !== 'string' || !STATUSES.has(o.status as string) || Number.isNaN(Date.parse(String(o.createdAt)))) continue;
    const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
    out.push({
      requestId: id, name: o.name.slice(0, 80), status: o.status as SfxRequestItem['status'], reason: str(o.reason, 300),
      createdAt: String(o.createdAt), decidedAt: str(o.decidedAt, 40), soundName: str(o.soundName, 80), platform,
    });
  }
  return out;
}

/** Sloučit seznamy identit účtu: bez duplicit podle requestId, nejnovější první. */
export function mergeRequests(lists: SfxRequestItem[][]): SfxRequestItem[] {
  const byId = new Map<number, SfxRequestItem>();
  for (const l of lists) for (const r of l) if (!byId.has(r.requestId)) byId.set(r.requestId, r);
  return [...byId.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.requestId - a.requestId);
}

/** Úsek pro submit: 0 ≤ start < end, délka ≤ 30 s (tolerance 50 ms jako Židolišta). */
export function rangeError(startMs: number, endMs: number): 'bad_range' | 'too_long' | null {
  if (!(startMs >= 0 && endMs > startMs)) return 'bad_range';
  if (endMs - startMs > MAX_CLIP_MS + 50) return 'too_long';
  return null;
}

export interface Prepared {
  previewId: string; mode: 'server' | 'embed'; source: 'youtube' | 'mp3'; durationMs: number | null;
  peaks: number[] | null; previewUrl: string | null; videoId: string | null; expiresAt: string | null; title: string | null;
}

/**
 * Odpověď prepare ze Židolišty → tvar pro klienta; neplatná = null.
 * mode 'server' = stáhnuto (peaks + previewUrl povinné); 'embed' = YouTube blokuje server,
 * klient přehrává video přímo z YouTube (videoId povinné, délka může chybět).
 */
export function normalizePrepared(j: Record<string, unknown>): Prepared | null {
  if (typeof j.previewId !== 'string' || !j.previewId || j.previewId.length > 64) return null;
  const embed = j.mode === 'embed';
  const durationMs = Number.isFinite(j.durationMs) && (j.durationMs as number) > 0 ? Math.round(j.durationMs as number) : null;
  const base = {
    previewId: j.previewId, source: (j.source === 'youtube' || embed ? 'youtube' : 'mp3') as Prepared['source'], durationMs,
    expiresAt: typeof j.expiresAt === 'string' ? j.expiresAt : null, title: typeof j.title === 'string' ? j.title.slice(0, 200) : null,
  };
  if (embed) {
    const videoId = typeof j.videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(j.videoId) ? j.videoId : null;
    return videoId ? { ...base, mode: 'embed', peaks: null, previewUrl: null, videoId } : null;
  }
  const previewUrl = typeof j.previewUrl === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(j.previewUrl) ? j.previewUrl : null;
  if (!previewUrl || durationMs === null) return null;
  const peaks = (Array.isArray(j.peaks) ? j.peaks : []).map((v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v as number)) : 0));
  return { ...base, mode: 'server', peaks, previewUrl, videoId: null };
}

const Channel = z.string().transform((s) => s.toLowerCase().replace(/^@/, '')).pipe(z.string().regex(/^[a-z0-9_]{1,40}$/));
const PlatformZ = z.enum(['twitch', 'kick', 'youtube']);
export const PrepareBody = z.object({ channel: Channel, platform: PlatformZ, url: z.string().trim().min(8).max(2000) }).strict();
export const SubmitBody = z.object({
  channel: Channel,
  platform: PlatformZ,
  previewId: z.string().trim().min(1).max(64),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(1),
  name: z.string().trim().min(1).max(40),
  note: z.string().trim().max(300).optional().nullable(),
}).strict();

// ---- Židolišta ----

interface Upstream { status: number; json: Record<string, unknown> }

async function zidolista(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<Upstream> {
  const r = await zidolistaFetch(`${zidolistaBase()}${path}`, {
    method: init.method ?? 'GET',
    headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
  });
  let json: unknown = null;
  try { json = await r.json(); } catch { /* ne-JSON */ }
  return { status: r.status, json: (json && typeof json === 'object' ? json : {}) as Record<string, unknown> };
}

// Seznam per identita: klient ho načítá při otevření panelu, po SSE a limit se kontroluje
// před každým prepare/submit → krátká cache, ať se Židolišta neptá opakovaně na totéž.
const lists = new Map<string, { at: number; p: Promise<SfxRequestItem[]> }>();
const listKey = (slug: string, platform: string, userId: string) => `${slug}|${platform}|${userId}`;

function listFor(slug: string, platform: Platform, userId: string): Promise<SfxRequestItem[]> {
  const key = listKey(slug, platform, userId);
  const hit = lists.get(key);
  if (hit && Date.now() - hit.at < LIST_CACHE_MS) return hit.p;
  const q = new URLSearchParams({ platform, userId });
  const p = zidolista(`/integrations/${encodeURIComponent(slug)}/sfx-requests?${q}`).then((u) => {
    if (u.status === 404) return [];
    if (u.status >= 400) throw new Error(`zidolista HTTP ${u.status}`);
    return normalizeRequests(u.json, platform);
  });
  lists.set(key, { at: Date.now(), p });
  p.catch(() => lists.delete(key));
  if (lists.size > 5000) for (const [k, v] of lists) if (Date.now() - v.at >= LIST_CACHE_MS) lists.delete(k);
  return p;
}

async function accountRequests(slug: string, idents: PublicIdentity[]): Promise<{ requests: SfxRequestItem[]; limits: Limits }> {
  const all = await Promise.all(idents.map((i) => listFor(slug, i.platform, i.platformUserId)));
  const requests = mergeRequests(all);
  return { requests, limits: computeLimits(requests.map((r) => r.createdAt)) };
}

/** Webhook `sfx-request` ze Židolišty (přes /commands/invalidate → handleSfxWebhook). */
export async function handleSfxRequestWebhook(slug: string, data: unknown, log: FastifyInstance['log']): Promise<string[]> {
  const channels = await twitchChannelsOf(slug);
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const platform = PlatformZ.safeParse(d.platform);
  const userId = typeof d.userId === 'string' || typeof d.userId === 'number' ? String(d.userId) : null;
  const requestId = Number(d.requestId);
  if (!platform.success || !userId || !Number.isSafeInteger(requestId) || !STATUSES.has(d.status as string)) {
    log.warn({ slug }, 'sfx-request: webhook bez platform/userId/requestId/status');
    return channels;
  }
  lists.delete(listKey(slug, platform.data, userId));
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  for (const channel of channels) {
    // Bez důvodu zamítnutí (jde všem divákům kanálu); klient si svůj seznam i s důvodem načte sám.
    broadcast('sfx-request', { channel, platform: platform.data, userId, requestId, status: d.status, soundName: str(d.soundName, 80) });
  }
  log.info({ slug, requestId, status: d.status, channels }, 'sfx-request: webhook');
  return channels;
}

// ---- routy ----

export default async function sfxRequestRoutes(app: FastifyInstance) {
  // Prepare stahuje a převádí zvuk (drahé) → přísnější limit než seznam.
  const prepLimiter = new RateLimiter(4, 0.1);
  const limiter = new RateLimiter(20, 2);

  const bad = (reply: FastifyReply, status: number, error: string, extra: object = {}) => reply.code(status).send({ ok: false, error, ...extra });
  const down = (reply: FastifyReply, e: unknown, what: string) => {
    app.log.warn({ err: (e as Error).message, what }, 'sfx-request: zidolista request failed');
    return bad(reply, 502, 'zidolista_unavailable');
  };

  /** Společný začátek prepare/submit: workspace, ověřená identita na platformě, limit účtu. */
  async function context(reply: FastifyReply, accountId: number, channel: string, platform: Platform) {
    if (!config.ZIDOLISTA_API_KEY) { bad(reply, 503, 'zidolista_unavailable'); return null; }
    const slug = (await workspaceForChannel('twitch', channel))?.slug;
    if (!slug) { bad(reply, 404, 'unknown_channel'); return null; }
    const idents = await listIdentities(accountId);
    const ident = idents.find((i) => i.platform === platform);
    if (!ident) { bad(reply, 403, 'platform_not_linked'); return null; }
    let limits: Limits;
    try { limits = (await accountRequests(slug, idents)).limits; } catch (e) { down(reply, e, 'list'); return null; }
    const over = limitError(limits);
    if (over) { bad(reply, 429, over, { limits }); return null; }
    const role = await chatRole(platform, ident.login, channel);
    const requester = { platform, userId: ident.platformUserId, login: ident.login, role, ucAccountId: String(accountId) };
    return { slug, idents, ident, limits, requester };
  }

  app.post('/soundboard/requests/prepare', { preHandler: requireWebSession }, async (req, reply) => {
    const accountId = req.webAccountId!;
    if (!prepLimiter.allow(`a${accountId}`) || !prepLimiter.allow(req.ip)) return bad(reply, 429, 'rate_limited');
    const body = PrepareBody.safeParse(req.body);
    if (!body.success) return bad(reply, 400, 'bad_body');
    const ctx = await context(reply, accountId, body.data.channel, body.data.platform);
    if (!ctx) return reply;
    let u: Upstream;
    // YouTube se stahuje a převádí na serveru Židolišty — může trvat desítky sekund.
    try { u = await zidolista(`/integrations/${encodeURIComponent(ctx.slug)}/sfx-requests/prepare`, { method: 'POST', body: { url: body.data.url, requester: ctx.requester }, timeoutMs: 120_000 }); }
    catch (e) { return down(reply, e, 'prepare'); }
    if (u.status >= 400 || u.json.ok === false) { const m = mapUpstreamError(u.status, u.json); return bad(reply, m.status, m.error); }
    const out = normalizePrepared(u.json);
    if (!out) return bad(reply, 502, 'zidolista_unavailable');
    app.log.info({ slug: ctx.slug, platform: ctx.requester.platform, source: out.source, mode: out.mode, durationMs: out.durationMs }, 'sfx-request: prepare ok');
    return { ok: true, ...out, limits: ctx.limits };
  });

  app.post('/soundboard/requests', { preHandler: requireWebSession }, async (req, reply) => {
    const accountId = req.webAccountId!;
    if (!limiter.allow(`a${accountId}`)) return bad(reply, 429, 'rate_limited');
    const body = SubmitBody.safeParse(req.body);
    if (!body.success) return bad(reply, 400, 'bad_body');
    const rangeErr = rangeError(body.data.startMs, body.data.endMs);
    if (rangeErr) return bad(reply, 400, rangeErr);
    const ctx = await context(reply, accountId, body.data.channel, body.data.platform);
    if (!ctx) return reply;
    const { previewId, startMs, endMs, name, note } = body.data;
    let u: Upstream;
    try { u = await zidolista(`/integrations/${encodeURIComponent(ctx.slug)}/sfx-requests`, { method: 'POST', body: { previewId, startMs, endMs, name, ...(note ? { note } : {}), requester: ctx.requester }, timeoutMs: 60_000 }); }
    catch (e) { return down(reply, e, 'submit'); }
    if (u.status >= 400 || u.json.ok === false) { const m = mapUpstreamError(u.status, u.json); return bad(reply, m.status, m.error); }
    lists.delete(listKey(ctx.slug, ctx.requester.platform, ctx.requester.userId));
    const limits = { ...ctx.limits, dayUsed: ctx.limits.dayUsed + 1, monthUsed: ctx.limits.monthUsed + 1 };
    app.log.info({ slug: ctx.slug, requestId: u.json.requestId, platform: ctx.requester.platform }, 'sfx-request: submit ok');
    return { ok: true, requestId: u.json.requestId, status: 'pending', limits };
  });

  app.get<{ Querystring: { channel?: string } }>('/soundboard/requests', { preHandler: requireWebSession }, async (req, reply) => {
    const accountId = req.webAccountId!;
    if (!limiter.allow(`a${accountId}`)) return bad(reply, 429, 'rate_limited');
    const ch = Channel.safeParse(req.query.channel ?? '');
    if (!ch.success) return bad(reply, 400, 'bad_channel');
    reply.header('Cache-Control', 'no-store');
    const empty = { ok: true, requests: [], limits: computeLimits([]) };
    const slug = (await workspaceForChannel('twitch', ch.data))?.slug;
    if (!slug || !config.ZIDOLISTA_API_KEY) return empty;
    const idents = await listIdentities(accountId);
    try { return { ok: true, ...(await accountRequests(slug, idents)) }; }
    catch (e) { return down(reply, e, 'list'); }
  });
}
