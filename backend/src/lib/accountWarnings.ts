// Varování uživatele UnityChatu (spec 2026-09-25 moderace, část 2): mod varuje diváka, divák v UC
// (všechny propojené platformy) dostane okno s důvodem a nemůže psát, dokud nepotvrdí.
//
// Doručení JEN dotčenému účtu: /nicknames/stream je veřejný broadcast bez identity (a s replay
// bufferem pro kohokoli), tam důvod nesmí. Proto samostatný stream /account/stream. EventSource
// neumí hlavičku Authorization, takže klient si nejdřív Bearer session vymění za jednorázový
// ticket (POST /account/stream-ticket, 60 s, jedno použití) a otevře
// GET /account/stream?ticket=… — v URL (a tedy v access logu) je jen propadlý jednorázový ticket,
// nikdy session token.
import { randomBytes } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accountWarnings } from '../db/schema.js';

export interface WarningView { id: number; channel: string; reason: string; createdAt: string }

export const REASON_MAX = 500;

function view(r: { id: number; channel: string; reason: string; createdAt: Date }): WarningView {
  return { id: r.id, channel: r.channel, reason: r.reason, createdAt: r.createdAt.toISOString() };
}

export async function createWarning(p: { accountId: number; channel: string; reason: string; by: string | null }): Promise<WarningView> {
  const [r] = await db
    .insert(accountWarnings)
    .values({ accountId: p.accountId, channel: p.channel, reason: p.reason.slice(0, REASON_MAX), by: p.by })
    .returning({ id: accountWarnings.id, channel: accountWarnings.channel, reason: accountWarnings.reason, createdAt: accountWarnings.createdAt });
  return view(r);
}

/** Nepotvrzená varování účtu, nejstarší první. */
export async function pendingWarnings(accountId: number): Promise<WarningView[]> {
  const rows = await db
    .select({ id: accountWarnings.id, channel: accountWarnings.channel, reason: accountWarnings.reason, createdAt: accountWarnings.createdAt })
    .from(accountWarnings)
    .where(and(eq(accountWarnings.accountId, accountId), isNull(accountWarnings.acknowledgedAt)))
    .orderBy(asc(accountWarnings.id));
  return rows.map(view);
}

/** Potvrdí varování — jen vlastní (account_id v podmínce). false = neexistuje / cizí / už potvrzené. */
export async function ackWarning(accountId: number, id: number): Promise<boolean> {
  const rows = await db
    .update(accountWarnings)
    .set({ acknowledgedAt: new Date() })
    .where(and(eq(accountWarnings.id, id), eq(accountWarnings.accountId, accountId), isNull(accountWarnings.acknowledgedAt)))
    .returning({ id: accountWarnings.id });
  return rows.length > 0;
}

// ---- jednorázové tickety pro /account/stream ----
const TICKET_TTL_MS = 60_000;
const tickets = new Map<string, { accountId: number; exp: number }>();

export function issueStreamTicket(accountId: number, now = Date.now()): string {
  for (const [k, v] of tickets) if (v.exp <= now) tickets.delete(k);
  const t = randomBytes(24).toString('base64url');
  tickets.set(t, { accountId, exp: now + TICKET_TTL_MS });
  return t;
}

/** Spotřebuje ticket (jen jednou); propadlý/neznámý → null. */
export function consumeStreamTicket(ticket: string, now = Date.now()): number | null {
  const hit = tickets.get(ticket);
  if (!hit) return null;
  tickets.delete(ticket);
  return hit.exp > now ? hit.accountId : null;
}

// ---- klienti streamu per účet ----
export const MAX_STREAMS_PER_ACCOUNT = 10;
const streams = new Map<number, Set<FastifyReply>>();
let keepalive: ReturnType<typeof setInterval> | null = null;

function writeTo(accountId: number, reply: FastifyReply, s: string): void {
  try { reply.raw.write(s); } catch { streams.get(accountId)?.delete(reply); }
}

/** Zaregistruje stream účtu; false = limit spojení. Vrací odhlášení. */
export function addAccountStream(accountId: number, reply: FastifyReply): (() => void) | null {
  let set = streams.get(accountId);
  if (!set) { set = new Set(); streams.set(accountId, set); }
  if (set.size >= MAX_STREAMS_PER_ACCOUNT) return null;
  set.add(reply);
  if (!keepalive) {
    keepalive = setInterval(() => {
      for (const [id, s] of streams) for (const r of s) writeTo(id, r, ': keepalive\n\n');
    }, 25_000);
    keepalive.unref?.();
  }
  return () => {
    const s = streams.get(accountId);
    s?.delete(reply);
    if (s && !s.size) streams.delete(accountId);
    if (!streams.size && keepalive) { clearInterval(keepalive); keepalive = null; }
  };
}

/** Událost jen streamům daného účtu (žádný broadcast, žádný replay buffer). Vrací počet doručení. */
export function sendToAccount(accountId: number, event: string, data: object): number {
  const set = streams.get(accountId);
  if (!set) return 0;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const r of set) writeTo(accountId, r, frame);
  return set.size;
}

/** Účty s otevřeným /account/stream (soukromé doručení žádostí o GIF modům, část 4). */
export function connectedAccountIds(): number[] {
  return [...streams.keys()];
}

export function disconnectAllAccountStreams(): void {
  for (const s of streams.values()) for (const r of s) { try { r.raw.end(); } catch { /* ignore */ } }
  streams.clear();
  if (keepalive) { clearInterval(keepalive); keepalive = null; }
}
