// SSE stream chatu pro Židolištu (GET /integrations/chat/stream, X-Api-Key).
// Spec: docs/superpowers/specs/2026-09-22-zidolista-chat-bot-design.md.
// Každá zpráva z ingestu, jejíž kanál je namapovaný na workspace, jde ven jako
// `event: chat.message` s `id:` = monotónní kurzor; ring buffer 5 min umožní
// replay přes Last-Event-ID (klient po reconnectu nepropásne `!command`).
// Heartbeat `: ping` každých 15 s.
import type { FastifyReply } from 'fastify';
import type { IngestMessage } from '../ingest/types.js';
import { workspaceForChannelSync, type Platform } from '../lib/zidolista.js';
import { isBotAuthor } from '../lib/botIdentities.js';

export interface ChatEvent {
  type: 'chat.message';
  workspace: string;
  messageId: string;
  platform: Platform;
  user: string;
  userId: string;
  text: string;
  isSub: boolean;
  isMod: boolean;
  isVip: boolean;
  isBroadcaster: boolean;
  isBot: boolean;
  replyTo: { messageId: string; user: string | null } | null;
  timestamp: string;
}

export interface Roles { isSub: boolean; isMod: boolean; isVip: boolean; isBroadcaster: boolean }

/** Role z badge, jak je nese contentRaw ingestu (Twitch tag string, Kick pole objektů, YouTube tooltipy). */
export function rolesFromBadges(platform: Platform, raw: unknown, username?: string, channel?: string): Roles {
  const r: Roles = { isSub: false, isMod: false, isVip: false, isBroadcaster: false };
  if (platform === 'twitch') {
    const b = String(raw ?? '').toLowerCase();
    r.isBroadcaster = /(^|,)broadcaster\//.test(b);
    r.isMod = /(^|,)moderator\//.test(b);
    r.isVip = /(^|,)vip\//.test(b);
    r.isSub = /(^|,)(subscriber|founder)\//.test(b);
  } else if (platform === 'kick') {
    const types = Array.isArray(raw) ? raw.map((x) => String((x && typeof x === 'object' ? (x as { type?: unknown }).type : x) ?? '').toLowerCase()) : [];
    r.isBroadcaster = types.includes('broadcaster');
    r.isMod = types.includes('moderator');
    r.isVip = types.includes('vip') || types.includes('og');
    r.isSub = types.includes('subscriber') || types.includes('founder');
  } else {
    const tips = Array.isArray(raw) ? raw.map((x) => String(x ?? '').toLowerCase()) : [];
    r.isBroadcaster = tips.some((t) => t === 'owner' || t === 'vlastník');
    r.isMod = tips.some((t) => t.startsWith('moderator') || t.startsWith('moderátor'));
    r.isSub = tips.some((t) => t.includes('member') || t.includes('člen'));
  }
  if (!r.isBroadcaster && username && channel && (platform === 'twitch' || platform === 'kick') && username.toLowerCase() === channel.toLowerCase()) r.isBroadcaster = true;
  return r;
}

export function toChatEvent(m: IngestMessage, workspace: string): ChatEvent {
  const raw = m.contentRaw || {};
  const roles = rolesFromBadges(m.platform, raw.badges, m.username, m.channel);
  const replyUser = (raw.replyParentUsername ?? raw.replyParentDisplayName ?? null) as string | null;
  return {
    type: 'chat.message',
    workspace,
    messageId: m.platformMessageId,
    platform: m.platform,
    user: m.username,
    userId: m.platformUserId,
    text: m.content,
    ...roles,
    isBot: isBotAuthor(m.platform, m.username, workspace, m.platformUserId),
    replyTo: m.replyToMessageId ? { messageId: m.replyToMessageId, user: replyUser } : null,
    timestamp: m.sentAt.toISOString(),
  };
}

// ---- ring buffer + klienti ----
const RING_MS = 5 * 60_000;
const RING_MAX = 5000;
const PING_MS = 15_000;
interface Entry { id: number; at: number; frame: string }
const ring: Entry[] = [];
let counter = 0;
const clients = new Set<FastifyReply>();
let pingTimer: ReturnType<typeof setInterval> | null = null;

function frameOf(id: number, ev: ChatEvent): string {
  return `id: ${id}\nevent: chat.message\ndata: ${JSON.stringify(ev)}\n\n`;
}

function write(reply: FastifyReply, s: string): void {
  try { reply.raw.write(s); } catch { clients.delete(reply); }
}

/** Z ingest onLive: publikovat, když je kanál namapovaný na workspace. */
export function publishIntegration(m: IngestMessage): ChatEvent | null {
  const ws = workspaceForChannelSync(m.platform, m.channel);
  if (!ws) return null;
  const ev = toChatEvent(m, ws.slug);
  const now = Date.now();
  // Kurzor musí růst i přes restart serveru: klient po reconnectu posílá Last-Event-ID
  // z minulého běhu; kdyby id začínalo od 1, replay by nic nevrátil (2026-09-22, Kick !test
  // 14 s před reconnectem Židolišty). Proto id = ms času, při shodě +1.
  const id = counter = Math.max(counter + 1, now);
  ring.push({ id, at: now, frame: frameOf(id, ev) });
  while (ring.length && (ring.length > RING_MAX || now - ring[0].at > RING_MS)) ring.shift();
  for (const c of clients) write(c, ring[ring.length - 1].frame);
  return ev;
}

export function subscribeIntegration(reply: FastifyReply, lastEventId: number | null): () => void {
  clients.add(reply);
  write(reply, `: hello cursor=${counter}\n\n`);
  if (lastEventId !== null && Number.isFinite(lastEventId)) {
    for (const e of ring) if (e.id > lastEventId) write(reply, e.frame);
  }
  const unsubscribe = () => {
    clients.delete(reply);
    if (!clients.size && pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  };
  const raw = reply.raw as unknown as NodeJS.EventEmitter;
  raw.on?.('close', unsubscribe);
  raw.on?.('error', unsubscribe);
  if (!pingTimer) {
    pingTimer = setInterval(() => {
      for (const c of clients) {
        const r = c.raw as unknown as { destroyed?: boolean; writableEnded?: boolean; socket?: { destroyed?: boolean } | null };
        if (r.destroyed || r.writableEnded || !r.socket || r.socket.destroyed) { clients.delete(c); continue; }
        write(c, ': ping\n\n');
      }
      if (!clients.size && pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    }, PING_MS);
    pingTimer.unref?.();
  }
  return unsubscribe;
}

export function integrationStreamStats(): { clients: number; cursor: number; buffered: number } {
  return { clients: clients.size, cursor: counter, buffered: ring.length };
}

export function disconnectAllIntegrationStreams(): void {
  for (const c of clients) { try { c.raw.end(); } catch { /* ignore */ } }
  clients.clear();
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}
