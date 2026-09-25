// Moderace uživatelů (spec 2026-09-25 moderace, část 2): timeout / ban / unban.
// Jediné místo pro SSE `user-moderated` (/nicknames/stream), integrační `chat.user_moderated`
// a evidenci známých banů (moderation_bans) — sdílí UC route, integrace Židolišty i ingest
// (Twitch CLEARCHAT). SSE nenese důvod (vidí ho všichni klienti), jen kdo/komu/co/do kdy.
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { moderationBans } from '../db/schema.js';
import { broadcast } from '../sse/bus.js';
import { publishUserModIntegration } from '../sse/integrationStream.js';
import type { Platform } from './zidolista.js';

export type UserModAction = 'timeout' | 'ban' | 'unban';

/** Tvar SSE `user-moderated`. until = konec timeoutu v ms (epoch), null u banu i unbanu. */
export interface UserModeratedEvent {
  channel: string;
  platform: Platform;
  userId: string;
  login: string;
  action: UserModAction;
  until: number | null;
  by: string | null;
  at: number;
}

export interface UserModeratedParams {
  /** UC kanál (streamerův Twitch login), ne platformní. */
  channel: string;
  platform: Platform;
  userId: string;
  login: string;
  action: UserModAction;
  /** Timeout: skutečná délka na platformě v s (Kick zaokrouhlený na minuty); jinak null. */
  durationSec: number | null;
  by: string | null;
  /** 'uc' = vlastní akce (UC route / integrace) — vysílá vždy; 'platform' = ingest (CLEARCHAT) — přeskočí echo vlastní akce. */
  source: 'uc' | 'platform';
}

export interface UserModeratedDeps {
  broadcast: (event: string, data: object) => void;
  integration?: (ev: UserModeratedEvent, durationSec: number | null) => Promise<unknown> | unknown;
  now: () => number;
}

const defaultDeps: UserModeratedDeps = {
  broadcast,
  integration: (ev, durationSec) => publishUserModIntegration(ev.channel, { platform: ev.platform, userId: ev.userId, login: ev.login, action: ev.action, duration: durationSec, by: ev.by }),
  now: Date.now,
};

const ECHO_MS = 30_000;
// Klíč kanál:platforma:userId:akce:délka. Twitch po vlastním banu přes Helix pošle CLEARCHAT — ten by
// jinak přepsal `by` na null a mihnul UI druhou událostí. Délka v klíči: jiný (re)timeout odjinud
// se nespolkne a evidence dostane nové until.
const recent = new Map<string, number>();

/** SSE `user-moderated` + `chat.user_moderated`. Vrací událost, nebo null, když šlo o echo vlastní akce. */
export async function publishUserModerated(p: UserModeratedParams, deps: UserModeratedDeps = defaultDeps): Promise<UserModeratedEvent | null> {
  const t = deps.now();
  const key = `${p.channel}:${p.platform}:${p.userId}:${p.action}:${p.durationSec ?? ''}`;
  const last = recent.get(key);
  if (p.source === 'platform' && last !== undefined && t - last < ECHO_MS) return null;
  recent.set(key, t);
  if (recent.size > 1000) for (const [k, at] of recent) if (t - at >= ECHO_MS) recent.delete(k);

  const ev: UserModeratedEvent = {
    channel: p.channel,
    platform: p.platform,
    userId: p.userId,
    login: p.login,
    action: p.action,
    until: p.action === 'timeout' && p.durationSec ? t + p.durationSec * 1000 : null,
    by: p.by,
    at: t,
  };
  deps.broadcast('user-moderated', ev);
  // Výpadek registru workspaců nesmí shodit akci (SSE už odešlo).
  try { await deps.integration?.(ev, p.action === 'timeout' ? p.durationSec : null); } catch { /* ignore */ }
  return ev;
}

/** Jen pro testy. */
export function _resetUserModeratedDedup(): void { recent.clear(); }

// ---- evidence banů (moderation_bans) ----
export interface BanRow { channel: string; platform: Platform; userId: string; login: string; until: Date | null; youtubeBanId?: string | null }

/** Zapíše / přepíše známý ban nebo timeout. youtubeBanId se nepřepíše na null (CLEARCHAT ho nezná). */
export async function recordBan(r: BanRow): Promise<void> {
  const set: Record<string, unknown> = { targetLogin: r.login, until: r.until, createdAt: new Date() };
  if (r.youtubeBanId) set.youtubeBanId = r.youtubeBanId;
  await db
    .insert(moderationBans)
    .values({ channel: r.channel, platform: r.platform, targetUserId: r.userId, targetLogin: r.login, until: r.until, youtubeBanId: r.youtubeBanId ?? null })
    .onConflictDoUpdate({ target: [moderationBans.channel, moderationBans.platform, moderationBans.targetUserId], set });
}

export async function clearBan(channel: string, platform: Platform, userId: string): Promise<void> {
  await db.delete(moderationBans).where(and(eq(moderationBans.channel, channel), eq(moderationBans.platform, platform), eq(moderationBans.targetUserId, userId)));
}

/** Platný ban/timeout (permanentní, nebo s until v budoucnosti), jinak null. */
export async function activeBan(channel: string, platform: Platform, userId: string, now = Date.now()): Promise<{ until: Date | null; youtubeBanId: string | null } | null> {
  const rows = await db
    .select({ until: moderationBans.until, youtubeBanId: moderationBans.youtubeBanId })
    .from(moderationBans)
    .where(and(eq(moderationBans.channel, channel), eq(moderationBans.platform, platform), eq(moderationBans.targetUserId, userId)))
    .limit(1);
  return banState(rows[0] ?? null, now);
}

/** Čistá část activeBan: propadlý timeout = žádný ban. */
export function banState(row: { until: Date | null; youtubeBanId: string | null } | null, now: number): { until: Date | null; youtubeBanId: string | null } | null {
  if (!row) return null;
  if (row.until && row.until.getTime() <= now) return null;
  return row;
}
