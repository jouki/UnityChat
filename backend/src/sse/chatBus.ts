import type { FastifyReply } from 'fastify';

/**
 * SSE rozesílání živých zpráv z ingestu (GET /chat/stream). Oddělené od
 * sse/bus.ts (nicknames): ten je broadcast všem + ring buffer; tady se filtruje
 * per klient podle kanálů a platforem a replay se nedělá — klient po
 * reconnectu dorovná historii přes /chat/history (stejně jako addon).
 *
 * Latence: publishChat volá ingest hned po přijetí zprávy, před dávkovým
 * zápisem do DB, takže zpráva na webu není zdržená flush intervalem.
 */

export interface ChatStreamClient {
  id: string;
  reply: FastifyReply;
  ip: string;
  channels: Set<string>;   // lowercase názvy kanálů per platforma (twitch login, kick slug, yt handle)
  platforms: Set<string>;  // 'twitch' | 'kick' | 'youtube'
  sent: number;
}

const clients = new Set<ChatStreamClient>();
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
const KEEPALIVE_MS = 15_000;

export function formatEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function safeWrite(c: ChatStreamClient, frame: string): boolean {
  try {
    c.reply.raw.write(frame);
    return true;
  } catch {
    clients.delete(c);
    return false;
  }
}

export function subscribeChatStream(reply: FastifyReply, opts: { ip: string; channels: string[]; platforms: string[] }): () => void {
  const client: ChatStreamClient = {
    id: crypto.randomUUID(),
    reply,
    ip: opts.ip,
    channels: new Set(opts.channels.map((c) => c.toLowerCase())),
    platforms: new Set(opts.platforms),
    sent: 0,
  };
  clients.add(client);
  safeWrite(client, formatEvent('hello', { channels: [...client.channels], platforms: [...client.platforms] }));

  const unsubscribe = () => {
    clients.delete(client);
    if (clients.size === 0 && keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  };
  // Odpojení klienta za proxy (Traefik) nepřijde vždy jako 'close' na requestu —
  // raw.write() na mrtvý socket nehází, jen emituje 'error'/'close' na response.
  // Bez tohohle klienti „zůstávali" (2026-09-21: 5 leaknutých → 429 pro celou IP).
  const raw = reply.raw as unknown as NodeJS.EventEmitter & { destroyed?: boolean; writableEnded?: boolean };
  raw.on?.('close', unsubscribe);
  raw.on?.('error', unsubscribe);

  if (!keepaliveTimer) {
    keepaliveTimer = setInterval(() => {
      for (const c of clients) {
        const r = c.reply.raw as unknown as { destroyed?: boolean; writableEnded?: boolean; socket?: { destroyed?: boolean } | null };
        if (r.destroyed || r.writableEnded || !r.socket || r.socket.destroyed) { clients.delete(c); continue; }
        safeWrite(c, ': keepalive\n\n');
      }
      if (clients.size === 0 && keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
    }, KEEPALIVE_MS);
    keepaliveTimer.unref?.();
  }

  return unsubscribe;
}

/** Doručí zprávu klientům, které odebírají daný kanál + platformu. Vrací počet doručení. */
export function publishChat(channel: string, platform: string, message: object): number {
  if (!clients.size) return 0;
  const ch = channel.toLowerCase();
  let frame: string | null = null;
  let delivered = 0;
  for (const c of clients) {
    if (!c.platforms.has(platform) || !c.channels.has(ch)) continue;
    if (frame === null) frame = formatEvent('message', message);
    if (safeWrite(c, frame)) { c.sent++; delivered++; }
  }
  return delivered;
}

export function chatStreamClientCount(): number {
  return clients.size;
}

export function chatStreamClientsForIp(ip: string): number {
  let n = 0;
  for (const c of clients) if (c.ip === ip) n++;
  return n;
}

export function disconnectAllChatStreams(): void {
  for (const c of clients) {
    try { c.reply.raw.end(); } catch { /* ignore */ }
  }
  clients.clear();
  if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
}
