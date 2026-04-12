import type { FastifyReply } from 'fastify';

interface SSEClient {
  id: string;
  reply: FastifyReply;
}

interface SSEEvent {
  id: number;
  event: string;
  data: string;
}

const clients = new Set<SSEClient>();
const ringBuffer: SSEEvent[] = [];
const RING_MAX = 100;
let eventCounter = 0;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

function formatSSE(event: string, data: string, id: number): string {
  return `id: ${id}\nevent: ${event}\ndata: ${data}\n\n`;
}

export function addClient(reply: FastifyReply): () => void {
  const client: SSEClient = { id: crypto.randomUUID(), reply };
  clients.add(client);

  // Start keepalive timer if first client
  if (clients.size === 1 && !keepaliveTimer) {
    keepaliveTimer = setInterval(() => {
      for (const c of clients) {
        try {
          c.reply.raw.write(': keepalive\n\n');
        } catch {
          clients.delete(c);
        }
      }
    }, 30_000);
  }

  return () => {
    clients.delete(client);
    if (clients.size === 0 && keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  };
}

export function broadcast(event: string, data: object): void {
  eventCounter++;
  const entry: SSEEvent = {
    id: eventCounter,
    event,
    data: JSON.stringify(data),
  };

  ringBuffer.push(entry);
  if (ringBuffer.length > RING_MAX) {
    ringBuffer.splice(0, ringBuffer.length - RING_MAX);
  }

  const frame = formatSSE(entry.event, entry.data, entry.id);
  for (const client of clients) {
    try {
      client.reply.raw.write(frame);
    } catch {
      clients.delete(client);
    }
  }
}

export function replaySince(lastEventId: number, reply: FastifyReply): void {
  for (const entry of ringBuffer) {
    if (entry.id > lastEventId) {
      reply.raw.write(formatSSE(entry.event, entry.data, entry.id));
    }
  }
}

export function disconnectAll(): void {
  for (const client of clients) {
    try {
      client.reply.raw.end();
    } catch { /* ignore */ }
  }
  clients.clear();
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

export function clientCount(): number {
  return clients.size;
}
