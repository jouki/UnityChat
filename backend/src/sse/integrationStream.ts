// SSE stream chatu pro Židolištu (GET /integrations/chat/stream, X-Api-Key).
// Spec: docs/superpowers/specs/2026-09-22-zidolista-chat-bot-design.md.
// Každá zpráva z ingestu, jejíž kanál je namapovaný na workspace, jde ven jako
// `event: chat.message` s `id:` = monotónní kurzor; ring buffer 5 min umožní
// replay přes Last-Event-ID (klient po reconnectu nepropásne `!command`).
// Heartbeat `: ping` každých 15 s.
// Moderace (2026-09-25): chat.deleted / chat.hidden / chat.unhidden jdou stejným kanálem
// (společný kurzor i replay), jen pro kanály namapované na workspace.
import type { FastifyReply } from 'fastify';
import type { IngestMessage } from '../ingest/types.js';
import type { Message } from '../db/schema.js';
import { workspaceForChannel, workspaceForChannelSync, type Platform, type WorkspaceInfo } from '../lib/zidolista.js';
import { isBotAuthor } from '../lib/botIdentities.js';

export interface ChatEvent {
  type: 'chat.message';
  workspace: string;
  messageId: string;
  platform: Platform;
  user: string;
  /** Login (malými písmeny) — Židolišta páruje `!se` / dárce (role donor) podle loginu (2026-09-28). */
  login: string;
  userId: string;
  text: string;
  isSub: boolean;
  isMod: boolean;
  isVip: boolean;
  isBroadcaster: boolean;
  isBot: boolean;
  /**
   * Poslaná z UnityChatu (marker v textu). Commandy (`!…`, bez markeru) server označí až po spárování s hlášením
   * klienta — v živém eventu pak může být false, archiv (`/integrations/:slug/chat-log` → viaUnityChat) už true.
   */
  viaUnityChat: boolean;
  /** Smazaná filtrem odkazů už při příjmu → `text` je prázdný (obsah jen v archivu), následuje chat.deleted. */
  deleted?: true;
  /**
   * Schovaná v UnityChatu kvůli GIFu (`gif_request`: čeká na převod / schválení, i při neznámém přístupu) — NENÍ
   * smazaná, `text` je plný (integrace je důvěryhodná, commandy a log Židolišty ji potřebují). Následuje chat.deleted
   * `gif_request`, pak buď rozhodnutí o GIFu (gif.*), nebo chat.restored (zpráva zase vidět). Konec čekání vždy
   * ohlásí chat.held_settled (právě jednou). Od 2026-09-27.
   */
  held?: true;
  hiddenReason?: string;
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
  const held = m.deleted?.reason === 'gif_request';
  const roles = rolesFromBadges(m.platform, raw.badges, m.username, m.channel);
  const replyUser = (raw.replyParentUsername ?? raw.replyParentDisplayName ?? null) as string | null;
  return {
    type: 'chat.message',
    workspace,
    messageId: m.platformMessageId,
    platform: m.platform,
    user: m.username,
    login: String(raw.login ?? raw.senderSlug ?? m.username).replace(/^@/, '').toLowerCase(),
    userId: m.platformUserId,
    ...(held
      ? { text: m.content, held: true as const, hiddenReason: m.deleted!.reason }
      : { text: m.deleted ? '' : m.content, ...(m.deleted ? { deleted: true as const } : {}) }),
    ...roles,
    isBot: isBotAuthor(m.platform, m.username, workspace, m.platformUserId),
    viaUnityChat: !!m.isUnitychatUser,
    replyTo: m.replyToMessageId ? { messageId: m.replyToMessageId, user: replyUser } : null,
    timestamp: m.sentAt.toISOString(),
  };
}

/** Řádek archivu → chat.message (chat.restored nese celou zprávu; Židolišta ji mohla dostat bez textu). */
export function chatEventFromRow(row: Pick<Message, 'platform' | 'platformMessageId' | 'platformUserId' | 'platformUsername' | 'channel' | 'content' | 'contentRaw' | 'sentAt' | 'isUnitychatUser' | 'isReply' | 'replyToMessageId'>, workspace: string): ChatEvent {
  return toChatEvent({
    platform: row.platform as Platform, platformMessageId: row.platformMessageId, platformUserId: row.platformUserId,
    username: row.platformUsername, channel: row.channel, content: row.content,
    contentRaw: (row.contentRaw || {}) as Record<string, unknown>, sentAt: row.sentAt,
    isUnitychatUser: !!row.isUnitychatUser, isReply: !!row.isReply, replyToMessageId: row.replyToMessageId ?? null,
  }, workspace);
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

// ---- moderační události (moderace část 1, Task 6b) ----
export type ModEventType = 'chat.deleted' | 'chat.hidden' | 'chat.unhidden' | 'chat.restored';

export interface ModIntegrationEvent {
  type: ModEventType;
  workspace: string;
  platform: Platform;
  messageId: string;
  by: string | null;
  /** Jen u chat.deleted: 'mod' | 'platform' | 'link_filter'. */
  reason?: string;
  /** Jen u chat.restored (od 2026-09-27): text a celá zpráva (tvar chat.message) — Židolišta ji mohla dostat bez textu. */
  text?: string;
  message?: ChatEvent;
}

/** Zpráva pro chat.restored podle workspace (sestaví se až po jeho dohledání). */
export type ChatForWorkspace = (workspace: string) => ChatEvent | null;

/** Tvar moderační události pro Židolištu; `reason` nese jen chat.deleted. */
export function modIntegrationEvent(
  type: ModEventType,
  workspace: string,
  p: { platform: Platform; messageId: string; by: string | null; reason?: string; chat?: ChatForWorkspace },
): ModIntegrationEvent {
  const ev: ModIntegrationEvent = { type, workspace, platform: p.platform, messageId: p.messageId, by: p.by };
  if (type === 'chat.deleted') ev.reason = p.reason;
  if (type === 'chat.restored' && p.chat) {
    const msg = p.chat(workspace);
    if (msg) { ev.text = msg.text; ev.message = msg; }
  }
  return ev;
}

// ---- moderace uživatelů (moderace část 2): timeout / ban / unban ----
export interface UserModIntegrationEvent {
  type: 'chat.user_moderated';
  workspace: string;
  platform: Platform;
  userId: string;
  login: string;
  action: 'timeout' | 'ban' | 'unban';
  /** Jen u timeoutu: délka v sekundách (u Kicku zaokrouhlená na celé minuty). */
  duration?: number;
  by: string | null;
}

// ---- odměna GIF (moderace část 4): žádost čeká / rozhodnuto (Chat Log Židolišty) ----
export type GifIntegrationEvent =
  | { type: 'gif.pending'; workspace: string; requestId: number; platform: string; userId: string; login: string; messageId: string; text: string; media: { url: string; kind: string; width: number | null; height: number | null }; expiresAt: string }
  | { type: 'gif.decided'; workspace: string; requestId: number; platform: string; userId: string; login: string; status: 'approved' | 'rejected' | 'expired' | 'pending' | 'deleted'; by: string | null };

/**
 * Schovaná zpráva (`held`, `gif_request`) přestala čekat — právě jednou za zprávu, na všech cestách (rozhodnutí
 * modem, tiché auto-schválení / zamítnutí, propadnutí, režim „jen schválené", obnovení, filtr odkazů, dorovnání).
 * `by`: kdo rozhodl (mod `platforma:login`, `zidolista:<id>`), automatika = `filter`. Od 2026-09-27.
 */
export type HeldOutcome = 'approved' | 'rejected' | 'expired' | 'not_allowed' | 'restored' | 'link_filter';
export interface HeldSettledIntegrationEvent {
  type: 'chat.held_settled';
  workspace: string;
  platform: string;
  messageId: string;
  outcome: HeldOutcome;
  requestId?: number;
  by?: string | null;
  reason?: string;
}

type IntegrationEvent = ChatEvent | ModIntegrationEvent | UserModIntegrationEvent | GifIntegrationEvent | HeldSettledIntegrationEvent;

function frameOf(id: number, ev: IntegrationEvent): string {
  return `id: ${id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
}

function write(reply: FastifyReply, s: string): void {
  try { reply.raw.write(s); } catch { clients.delete(reply); }
}

/** Jakákoli událost do integračního streamu: společný kurzor, ring buffer (replay) a rozeslání. Vrací id. */
export function publishIntegrationEvent(ev: IntegrationEvent): number {
  const now = Date.now();
  // Kurzor musí růst i přes restart serveru: klient po reconnectu posílá Last-Event-ID
  // z minulého běhu; kdyby id začínalo od 1, replay by nic nevrátil (2026-09-22, Kick !test
  // 14 s před reconnectem Židolišty). Proto id = ms času, při shodě +1.
  const id = counter = Math.max(counter + 1, now);
  const frame = frameOf(id, ev);
  ring.push({ id, at: now, frame });
  while (ring.length && (ring.length > RING_MAX || now - ring[0].at > RING_MS)) ring.shift();
  for (const c of clients) write(c, frame);
  return id;
}

// Počítadla od startu procesu (diagnostika „bot neodpověděl“, 2026-10-01: z logů nešlo zjistit, jestli Kick
// zpráva do streamu odešla) — v /health.integrationStream: published per platforma, unmapped per platform:kanál.
const STARTED_AT = Date.now();
const published: Record<string, number> = {};
const unmapped: Record<string, number> = {};
let unmappedLogAt = 0;

/** Z ingest onLive: publikovat, když je kanál namapovaný na workspace. */
export function publishIntegration(m: IngestMessage, log?: { warn: (o: object, msg: string) => void }): ChatEvent | null {
  const ws = workspaceForChannelSync(m.platform, m.channel);
  if (!ws) {
    const k = `${m.platform}:${m.channel}`;
    unmapped[k] = (unmapped[k] ?? 0) + 1;
    // Nenamapovaný kanál = zpráva do Židolišty nejde; logovat jen 1× za 10 min (registr nenačtený po startu / cizí kanál).
    if (log && Date.now() - unmappedLogAt > 10 * 60_000) { unmappedLogAt = Date.now(); log.warn({ platform: m.platform, channel: m.channel, unmapped }, 'integration stream: kanál bez workspace, zpráva se neposílá'); }
    return null;
  }
  const ev = toChatEvent(m, ws.slug);
  publishIntegrationEvent(ev);
  published[m.platform] = (published[m.platform] ?? 0) + 1;
  return ev;
}

export interface ModIntegrationDeps {
  workspaceFor: (platform: Platform, channel: string) => Promise<WorkspaceInfo | null>;
  publish: (ev: ModIntegrationEvent) => number;
}

const defaultModDeps: ModIntegrationDeps = { workspaceFor: workspaceForChannel, publish: publishIntegrationEvent };

/**
 * Moderační událost pro UC kanál (Twitch login streamera). Workspace se hledá podle Twitche;
 * když ucChannelFor spadl na platformní kanál (Kick slug / YT handle bez mapování v streamers),
 * ještě podle platformy zprávy. Nenamapovaný kanál → nic (stejně jako chat.message).
 */
export async function publishModIntegration(
  ucChannel: string,
  type: ModEventType,
  p: { platform: Platform; messageId: string; by: string | null; reason?: string; chat?: ChatForWorkspace },
  deps: ModIntegrationDeps = defaultModDeps,
): Promise<ModIntegrationEvent | null> {
  const ws = await workspaceForUc(ucChannel, p.platform, deps.workspaceFor);
  if (!ws) return null;
  const ev = modIntegrationEvent(type, ws.slug, p);
  deps.publish(ev);
  return ev;
}

/** Workspace UC kanálu: podle Twitche, fallback podle platformy (ucChannelFor spadl na platformní kanál). */
async function workspaceForUc(ucChannel: string, platform: Platform, workspaceFor: ModIntegrationDeps['workspaceFor']): Promise<WorkspaceInfo | null> {
  return (await workspaceFor('twitch', ucChannel)) ?? (platform !== 'twitch' ? await workspaceFor(platform, ucChannel) : null);
}

export interface UserModIntegrationDeps {
  workspaceFor: (platform: Platform, channel: string) => Promise<WorkspaceInfo | null>;
  publish: (ev: UserModIntegrationEvent) => number;
}

/** `chat.user_moderated` pro UC kanál; nenamapovaný kanál → nic. */
export async function publishUserModIntegration(
  ucChannel: string,
  p: { platform: Platform; userId: string; login: string; action: UserModIntegrationEvent['action']; duration?: number | null; by: string | null },
  deps: UserModIntegrationDeps = { workspaceFor: workspaceForChannel, publish: publishIntegrationEvent },
): Promise<UserModIntegrationEvent | null> {
  const ws = await workspaceForUc(ucChannel, p.platform, deps.workspaceFor);
  if (!ws) return null;
  const ev: UserModIntegrationEvent = { type: 'chat.user_moderated', workspace: ws.slug, platform: p.platform, userId: p.userId, login: p.login, action: p.action, by: p.by };
  if (p.action === 'timeout' && p.duration) ev.duration = p.duration;
  deps.publish(ev);
  return ev;
}

export function subscribeIntegration(reply: FastifyReply, lastEventId: number | null, log?: { info: (o: object, msg: string) => void }): () => void {
  clients.add(reply);
  write(reply, `: hello cursor=${counter}\n\n`);
  let replayed = 0;
  if (lastEventId !== null && Number.isFinite(lastEventId)) {
    for (const e of ring) if (e.id > lastEventId) { write(reply, e.frame); replayed++; }
  }
  const connectedAt = Date.now();
  let gone = false;
  const unsubscribe = () => {
    if (gone) return;
    gone = true;
    clients.delete(reply);
    log?.info({ clients: clients.size, replayed, seconds: Math.round((Date.now() - connectedAt) / 1000) }, 'integration chat stream: disconnected');
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

export function integrationStreamStats(): { clients: number; cursor: number; buffered: number; startedAt: string; published: Record<string, number>; unmapped: Record<string, number> } {
  return { clients: clients.size, cursor: counter, buffered: ring.length, startedAt: new Date(STARTED_AT).toISOString(), published: { ...published }, unmapped: { ...unmapped } };
}

export function disconnectAllIntegrationStreams(): void {
  for (const c of clients) { try { c.raw.end(); } catch { /* ignore */ } }
  clients.clear();
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}
