// Nastavení kanálu společné pro všechny uživatele UnityChatu (pokyn usera 2026-09-30).
//   GET /channel/prefs?channel=                  veřejné, `{ ok, channel, prefs: { donorBadge } }`, cache 30 s
//   PUT /moderation/channel-prefs {channel, prefs} jen mod / streamer kanálu (modGate) → uloží, SSE `channel-prefs`
//                                                  na /nicknames/stream `{ channel, prefs }` → klienti přepnou hned
// Zatím jediná volba: `donorBadge` = varianta odznaku dárce (core/donor-badge.js DONOR_BADGE_VARIANTS). Nastavení
// je globální pro kanál (dočasně — user rozhodne, jestli bude i individuální).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { channelPrefs } from '../db/schema.js';
import { broadcast } from '../sse/bus.js';

export const DONOR_BADGE_VARIANTS = ['qr-patron', 'donor-coin', 'money-bag', 'support-card'] as const;
export const DONOR_BADGE_DEFAULT = 'donor-coin';
const DONOR_SPEEDS = [1.5, 2.2, 3] as const;
const DONOR_STRENGTHS = [0.6, 1, 1.3] as const;
const DONOR_GAP_MAX = 120;
/** Odznak dárce: varianta, tempo (s), intenzita, odstup mezi animacemi (s), nahrazení globálního odznaku Twitche. */
export type ChannelPrefs = { donorBadge: (typeof DONOR_BADGE_VARIANTS)[number]; donorSpeed: number; donorStrength: number; donorGapMin: number; donorGapMax: number; donorReplaceGlobal: boolean };
const DEFAULT_PREFS: ChannelPrefs = { donorBadge: DONOR_BADGE_DEFAULT, donorSpeed: 3, donorStrength: 1, donorGapMin: 2, donorGapMax: 6, donorReplaceGlobal: false };

const Channel = z.string().transform((s) => s.toLowerCase().replace(/^@/, '')).pipe(z.string().regex(/^[a-z0-9_]{1,40}$/));
const PrefsBody = z.object({
  channel: Channel.optional(),
  prefs: z.object({
    donorBadge: z.enum(DONOR_BADGE_VARIANTS).optional(),
    donorSpeed: z.number().optional(), donorStrength: z.number().optional(),
    donorGapMin: z.number().min(0).max(DONOR_GAP_MAX).optional(), donorGapMax: z.number().min(0).max(DONOR_GAP_MAX).optional(),
    donorReplaceGlobal: z.boolean().optional(),
  }).strict(),
}).strict();

/** Uložené hodnoty + výchozí (čistá funkce). Neznámé klíče / hodnoty se zahodí. */
export function normalizePrefs(raw: unknown): ChannelPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const db = String(r.donorBadge ?? '');
  const num = (v: unknown, min: number, max: number, d: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
  const pick = <T extends readonly number[]>(v: unknown, list: T, d: number) => (list as readonly number[]).includes(Number(v)) ? Number(v) : d;
  const gapMin = num(r.donorGapMin, 0, DONOR_GAP_MAX, DEFAULT_PREFS.donorGapMin);
  return {
    donorBadge: (DONOR_BADGE_VARIANTS as readonly string[]).includes(db) ? (db as ChannelPrefs['donorBadge']) : DONOR_BADGE_DEFAULT,
    donorSpeed: pick(r.donorSpeed, DONOR_SPEEDS, DEFAULT_PREFS.donorSpeed),
    donorStrength: pick(r.donorStrength, DONOR_STRENGTHS, DEFAULT_PREFS.donorStrength),
    donorGapMin: gapMin,
    donorGapMax: Math.max(gapMin, num(r.donorGapMax, 0, DONOR_GAP_MAX, DEFAULT_PREFS.donorGapMax)),
    donorReplaceGlobal: r.donorReplaceGlobal === true,
  };
}

export async function readChannelPrefs(channel: string): Promise<ChannelPrefs> {
  const [row] = await db.select({ prefs: channelPrefs.prefs }).from(channelPrefs).where(eq(channelPrefs.channel, channel)).limit(1);
  return normalizePrefs(row?.prefs);
}

export interface ChannelPrefsDeps {
  /** modGate z routes/moderation.ts: null = odpověď už odeslaná (403 / 429). */
  modGate: (req: FastifyRequest, reply: FastifyReply, channel: string | undefined) => Promise<{ channel: string; accountId: number; by: string } | null>;
  requireSession: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

export default async function channelPrefsRoutes(app: FastifyInstance, deps: ChannelPrefsDeps) {
  app.get<{ Querystring: { channel?: string } }>('/channel/prefs', async (req, reply) => {
    const ch = Channel.safeParse(req.query.channel ?? '');
    if (!ch.success) return reply.code(400).send({ ok: false, error: 'invalid_channel' });
    reply.header('Cache-Control', 'public, max-age=30');
    return { ok: true, channel: ch.data, prefs: await readChannelPrefs(ch.data) };
  });

  app.put('/moderation/channel-prefs', { preHandler: deps.requireSession }, async (req, reply) => {
    const body = PrefsBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: 'invalid_body' });
    const g = await deps.modGate(req, reply, body.data.channel);
    if (!g) return reply;
    const current = await readChannelPrefs(g.channel);
    const next = normalizePrefs({ ...current, ...body.data.prefs });
    await db.insert(channelPrefs).values({ channel: g.channel, prefs: next, updatedBy: g.by, updatedAt: new Date() })
      .onConflictDoUpdate({ target: channelPrefs.channel, set: { prefs: next, updatedBy: g.by, updatedAt: new Date() } });
    broadcast('channel-prefs', { channel: g.channel, prefs: next });
    req.log.info({ channel: g.channel, by: g.by, prefs: next }, 'channel-prefs: změna');
    return { ok: true, channel: g.channel, prefs: next };
  });
}
