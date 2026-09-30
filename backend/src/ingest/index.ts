import type { IngestChannel } from './channels.js';
import { insertMessages, deleteOlderThan } from './store.js';
import { toRow } from './normalize.js';
import { TwitchListener, type Logger } from './twitch.js';
import { KickListener } from './kick.js';
import { YouTubeListener } from './youtube.js';
import type { IngestDelete, IngestListener, IngestMessage, IngestUserModeration, PlatformStatus } from './types.js';

export interface IngestStatus {
  twitch: PlatformStatus;
  kick: PlatformStatus;
  youtube: PlatformStatus;
  lastMessageAt: string | null;
  inserted: number;
  dropped: number;
}

interface CreateOpts {
  channels: IngestChannel[];
  retentionDays: number;
  log: Logger;
  insert?: typeof insertMessages;
  deleteOld?: typeof deleteOlderThan;
  listenerFactory?: (c: IngestChannel, onMessage: (m: IngestMessage) => void, onDelete?: (d: IngestDelete) => void, onUserModerated?: (d: IngestUserModeration) => void) => IngestListener;
  flushMs?: number;
  retentionMs?: number;
  /**
   * Živé rozesílání (GET /chat/stream): volá se synchronně pro každou přijatou
   * zprávu PŘED zařazením do dávky, aby SSE nečekalo na flush. Chyba se
   * zaloguje a ingest jede dál.
   */
  onLive?: (m: IngestMessage) => void;
  /** Smazání zprávy na platformě (Twitch CLEARMSG, Kick, YouTube) — server ho napojuje na publishDeleted. Chyba se zaloguje a ingest jede dál. */
  onDelete?: (d: IngestDelete) => void;
  /** Timeout/ban uživatele na platformě (Twitch CLEARCHAT) — server ho napojuje na user-moderated. Chyba se zaloguje a ingest jede dál. */
  onUserModerated?: (d: IngestUserModeration) => void;
}

function defaultFactory(log: Logger) {
  return (c: IngestChannel, onMessage: (m: IngestMessage) => void, onDelete?: (d: IngestDelete) => void, onUserModerated?: (d: IngestUserModeration) => void): IngestListener => {
    if (c.platform === 'twitch') return new TwitchListener(c.channel, onMessage, { log, onDelete, onUserModerated });
    if (c.platform === 'kick') return new KickListener(c.channel, onMessage, { log, onDelete });
    return new YouTubeListener(c.channel, onMessage, { log, onDelete });
  };
}

/**
 * Orchestrace: jeden listener na (platforma, kanál), zprávy se dávkují
 * (flush po 500 ms nebo 50 kusech → jeden INSERT), retence 1× za hodinu.
 */
export function createIngest(opts: CreateOpts) {
  const insert = opts.insert ?? insertMessages;
  const deleteOld = opts.deleteOld ?? deleteOlderThan;
  const factory = opts.listenerFactory ?? defaultFactory(opts.log);
  const flushMs = opts.flushMs ?? 500;
  const retentionMs = opts.retentionMs ?? 60 * 60 * 1000;

  // Klíč platforma:kanál — víc kanálů na jedné platformě je běžné (Rob + Stéra).
  const listeners = new Map<string, IngestListener>();
  let queue: IngestMessage[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  let retentionTimer: NodeJS.Timeout | null = null;
  let inserted = 0;
  let dropped = 0;
  let lastAt: Date | null = null;
  let flushing: Promise<void> = Promise.resolve();

  const flush = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!queue.length) return flushing;
    const batch = queue;
    queue = [];
    flushing = flushing.then(async () => {
      try {
        const n = await insert(batch.map(toRow));
        inserted += n;
        dropped += batch.length - n;
      } catch (err) {
        opts.log.error({ err, size: batch.length }, 'chat ingest: insert selhal, dávka zahozena');
        dropped += batch.length;
      }
    });
    return flushing;
  };

  const onMessage = (m: IngestMessage) => {
    lastAt = !lastAt || m.sentAt > lastAt ? m.sentAt : lastAt;
    if (opts.onLive) {
      try { opts.onLive(m); } catch (err) { opts.log.error({ err }, 'chat ingest: onLive selhal'); }
    }
    queue.push(m);
    if (queue.length >= 50) { void flush(); return; }
    if (!flushTimer) flushTimer = setTimeout(() => void flush(), flushMs);
  };

  const onDelete = (d: IngestDelete) => {
    if (!opts.onDelete) return;
    try { opts.onDelete(d); } catch (err) { opts.log.error({ err }, 'chat ingest: onDelete selhal'); }
  };

  const onUserModerated = (d: IngestUserModeration) => {
    if (!opts.onUserModerated) return;
    try { opts.onUserModerated(d); } catch (err) { opts.log.error({ err }, 'chat ingest: onUserModerated selhal'); }
  };

  const runRetention = async () => {
    if (!(opts.retentionDays > 0)) return; // 0 = bez retence
    try {
      const n = await deleteOld(opts.retentionDays);
      if (n) opts.log.info({ deleted: n, days: opts.retentionDays }, 'chat ingest: retence');
    } catch (err) {
      opts.log.error({ err }, 'chat ingest: retence selhala');
    }
  };

  let started = false;

  return {
    start() {
      started = true;
      if (!opts.channels.length) return;
      for (const c of opts.channels) {
        const l = factory(c, onMessage, onDelete, onUserModerated);
        listeners.set(`${c.platform}:${c.channel}`, l);
        l.start();
      }
      if (opts.retentionDays > 0) {
        void runRetention();
        retentionTimer = setInterval(() => void runRetention(), retentionMs);
      }
      opts.log.info({ channels: opts.channels }, 'chat ingest: started');
    },
    async stop() {
      for (const l of listeners.values()) l.stop();
      listeners.clear();
      if (retentionTimer) { clearInterval(retentionTimer); retentionTimer = null; }
      await flush();
    },
    /**
     * Přidat kanál za běhu (registr workspaců Židolišty: kanály bota se sledují
     * automaticky, ne jen ty z env). Vrací true, když vznikl nový listener.
     */
    ensureChannel(c: IngestChannel): boolean {
      const key = `${c.platform}:${c.channel.toLowerCase()}`;
      if (listeners.has(key)) return false;
      const l = factory({ platform: c.platform, channel: c.channel.toLowerCase() }, onMessage, onDelete, onUserModerated);
      listeners.set(key, l);
      if (started) l.start();
      return true;
    },
    channels(): string[] { return [...listeners.keys()]; },
    /** videoId živého streamu daného kanálu (jen youtube listener), jinak null. */
    videoIdFor(platform: IngestChannel['platform'], channel: string): string | null {
      const l = listeners.get(`${platform}:${channel.toLowerCase()}`);
      return l?.currentVideoId?.() ?? null;
    },
    status(): IngestStatus {
      // Souhrn per platforma: connected, když aspoň jeden kanál běží; jinak
      // nejhorší z ostatních stavů (reconnecting > connecting > error).
      const rank: Record<PlatformStatus, number> = { off: 0, connected: 1, connecting: 2, error: 3, reconnecting: 4 };
      const st = (p: IngestChannel['platform']): PlatformStatus => {
        const states = [...listeners.entries()].filter(([k]) => k.startsWith(p + ':')).map(([, l]) => l.status());
        if (!states.length) return 'off';
        if (states.includes('connected')) return 'connected';
        return states.sort((a, b) => rank[b] - rank[a])[0];
      };
      return {
        twitch: st('twitch'),
        kick: st('kick'),
        youtube: st('youtube'),
        lastMessageAt: lastAt ? lastAt.toISOString() : null,
        inserted,
        dropped,
      };
    },
  };
}

export type Ingest = ReturnType<typeof createIngest>;
