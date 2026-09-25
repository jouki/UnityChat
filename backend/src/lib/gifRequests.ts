// Odměna „Posílání GIFů" (moderace část 4, spec docs/superpowers/specs/2026-09-25-moderace-odkazy-gify-design.md,
// kontrakt docs/superpowers/plans/2026-09-25-moderace-cast-2-kontrakt.md §Část 4).
//
// Tok:
//   ingest onLive → filtr odkazů (lib/linkFilter.ts) pozná odkaz na GIF od uživatele s odemčenými GIFy
//   → původní zpráva se smaže (deleted_reason 'gif_request', v UC hned, na platformě botem po úspěšném převodu)
//   → server médium stáhne a uloží (gif_media) → žádost (gif_requests, pending, expires = +requestTtlSec)
//   → SSE `gif-pending` JEN modům kanálu a odesílateli (/account/stream, soukromě)
//   → první rozhodnutí moda (POST /moderation/gif/:id/decide, podmíněný UPDATE) vyhrává:
//       schváleno → syntetická zpráva `gif-<id>` v archivu (messages, content_raw.gif) + SSE `gif-message`
//                   všem (/nicknames/stream) + /chat/stream + Židolišta gif-used (cooldown);
//       zamítnuto → médium pryč, nic veřejně;
//     obojí → `gif-decided` modům + odesílateli.
//   Propadnutí: pending po expires_at → expired + `gif-decided` (status expired), médium pryč.
//   Převod selže → zpráva se bere jako běžný odkaz (filtr ji smaže, nebo se v UC obnoví, když by ji filtr pustil).
// Nic tady nesmí shodit ingest. NIKDY nelogovat tokeny.
import { randomBytes, createHash } from 'node:crypto';
import { and, eq, inArray, isNull, lte, gt } from 'drizzle-orm';
import { db } from '../db/index.js';
import { gifMedia, gifRequests, messages, webIdentities, type GifRequest } from '../db/schema.js';
import type { IngestMessage } from '../ingest/types.js';
import { toClientMessage, type ClientMessage } from '../routes/chat.js';
import type { GifAccess, GifAccessQuery } from './gifAccess.js';
import { gifUsable } from './gifAccess.js';
import type { GifCandidate, GifSource, ResolvedGif } from './gifMedia.js';
import { GifError, textWithoutLink } from './gifMedia.js';
import { gifMediaUrl, gifMessageId } from './gifIds.js';
import type { Platform } from './zidolista.js';

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

export type GifStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'deleted';

/** Tvar žádosti pro klienty (gif-pending, GET /moderation/gif/pending) — bez identity moda, bez URL zdroje. */
export interface GifPendingView {
  requestId: number;
  channel: string;
  platform: string;
  login: string;
  userId: string;
  messageId: string;
  text: string;
  media: { url: string; kind: string; width: number | null; height: number | null };
  createdAt: number;
  expiresAt: number;
}

export function pendingView(r: GifRequest): GifPendingView {
  return {
    requestId: r.id,
    channel: r.channel,
    platform: r.platform,
    login: r.login,
    userId: r.userId,
    messageId: r.messageId,
    text: r.textWithoutLink,
    media: { url: r.mediaId ? gifMediaUrl(r.mediaId) : '', kind: r.kind, width: r.width, height: r.height },
    createdAt: r.createdAt.getTime(),
    expiresAt: r.expiresAt.getTime(),
  };
}

/** Řádek schválené žádosti → syntetická zpráva archivu (messages). Id `gif-<requestId>`, čas = schválení. */
export function approvedMessageRow(r: GifRequest, at: Date) {
  const meta = (r.meta || {}) as Record<string, unknown>;
  const text = r.textWithoutLink;
  const contentRaw: Record<string, unknown> = {
    gif: { mediaId: r.mediaId, kind: r.kind, width: r.width, height: r.height, requestId: r.id },
    ...(meta.color ? { color: meta.color } : {}),
    ...(meta.badges !== undefined ? { badges: meta.badges } : {}),
  };
  if (r.platform === 'kick') contentRaw.content = text;
  if (r.platform === 'youtube') contentRaw.runs = text ? [{ text }] : [];
  return {
    platform: r.platform,
    platformMessageId: gifMessageId(r.id),
    platformUserId: r.userId,
    platformUsername: typeof meta.displayName === 'string' && meta.displayName ? meta.displayName : r.login,
    content: text,
    contentRaw,
    channel: r.platformChannel,
    isUnitychatUser: false,
    isReply: false,
    replyToMessageId: null,
    sentAt: at,
  };
}

// ---------------------------------------------------------------------------
// Úložiště (DB) — rozhraní kvůli testům
// ---------------------------------------------------------------------------

export interface NewGifRequest {
  channel: string; workspace: string; platform: Platform; platformChannel: string; userId: string; login: string;
  messageId: string; textWithoutLink: string; mediaId: string; kind: string; width: number | null; height: number | null;
  meta: Record<string, unknown>; expiresAt: Date;
}

export interface GifStore {
  saveMedia(m: ResolvedGif): Promise<string>;
  deleteMedia(id: string): Promise<void>;
  insertRequest(v: NewGifRequest): Promise<GifRequest>;
  /** Podmíněně: jen pending a ještě nepropadlá. null = už rozhodnuto / propadlo / neexistuje. */
  decide(id: number, status: 'approved' | 'rejected', by: string, at: Date): Promise<GifRequest | null>;
  get(id: number): Promise<GifRequest | null>;
  expireDue(at: Date): Promise<GifRequest[]>;
  listPending(at: Date): Promise<GifRequest[]>;
  /** Schválený GIF smazaný modem (část 1) → status deleted. */
  markDeletedByMessage(messageId: string): Promise<GifRequest | null>;
  insertApprovedMessage(r: GifRequest, at: Date): Promise<ClientMessage>;
  /** deleted_reason původní zprávy from → to (jen když je smazaná s from). */
  retagDeleted(platform: Platform, messageId: string, from: string, to: string): Promise<void>;
}

export const dbGifStore: GifStore = {
  async saveMedia(m) {
    const id = randomBytes(16).toString('hex');
    await db.insert(gifMedia).values({
      id, kind: m.kind, contentType: m.contentType, bytes: m.bytes, size: m.bytes.length,
      sha256: createHash('sha256').update(m.bytes).digest('hex'), width: m.width, height: m.height,
    });
    return id;
  },
  async deleteMedia(id) { await db.delete(gifMedia).where(eq(gifMedia.id, id)); },
  async insertRequest(v) { const [r] = await db.insert(gifRequests).values(v).returning(); return r; },
  async decide(id, status, by, at) {
    const rows = await db.update(gifRequests)
      .set({ status, decidedBy: by, decidedAt: at })
      .where(and(eq(gifRequests.id, id), eq(gifRequests.status, 'pending'), gt(gifRequests.expiresAt, at)))
      .returning();
    return rows[0] ?? null;
  },
  async get(id) { const rows = await db.select().from(gifRequests).where(eq(gifRequests.id, id)).limit(1); return rows[0] ?? null; },
  async expireDue(at) {
    return db.update(gifRequests).set({ status: 'expired', decidedAt: at })
      .where(and(eq(gifRequests.status, 'pending'), lte(gifRequests.expiresAt, at))).returning();
  },
  async listPending(at) {
    return db.select().from(gifRequests).where(and(eq(gifRequests.status, 'pending'), gt(gifRequests.expiresAt, at))).limit(500);
  },
  async markDeletedByMessage(messageId) {
    const id = Number(messageId.slice(4));
    if (!Number.isSafeInteger(id)) return null;
    const rows = await db.update(gifRequests).set({ status: 'deleted' })
      .where(and(eq(gifRequests.id, id), eq(gifRequests.status, 'approved'))).returning();
    return rows[0] ?? null;
  },
  async insertApprovedMessage(r, at) {
    const row = approvedMessageRow(r, at);
    await db.insert(messages).values(row).onConflictDoNothing({ target: [messages.platform, messages.platformMessageId] });
    return toClientMessage(row, false);
  },
  async retagDeleted(platform, messageId, from, to) {
    await db.update(messages).set({ deletedReason: to })
      .where(and(eq(messages.platform, platform), eq(messages.platformMessageId, messageId), eq(messages.deletedReason, from)));
  },
};

/** Účet UnityChatu odesílatele (propojená identita, ne odhlášená); null = nemá. */
export async function senderAccount(platform: Platform, userId: string): Promise<number | null> {
  const rows = await db.select({ accountId: webIdentities.accountId }).from(webIdentities)
    .where(and(eq(webIdentities.platform, platform), eq(webIdentities.platformUserId, userId), isNull(webIdentities.signedOutAt))).limit(1);
  return rows[0]?.accountId ?? null;
}

/** Médium pro GET /media/gif/:id — jen když k němu patří čekající nebo schválená žádost. */
export async function servableMedia(id: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  const rows = await db.select({ bytes: gifMedia.bytes, contentType: gifMedia.contentType, status: gifRequests.status })
    .from(gifMedia)
    .innerJoin(gifRequests, eq(gifRequests.mediaId, gifMedia.id))
    .where(and(eq(gifMedia.id, id), inArray(gifRequests.status, ['pending', 'approved'])))
    .limit(1);
  return rows[0] ? { bytes: rows[0].bytes, contentType: rows[0].contentType } : null;
}

// ---------------------------------------------------------------------------
// Soukromé doručení (mody kanálu + odesílatel) přes /account/stream
// ---------------------------------------------------------------------------

export interface GifNotifierDeps {
  /** Účty s otevřeným /account/stream. */
  connected: () => number[];
  isMod: (accountId: number, channel: string) => Promise<boolean>;
  senderAccount: (platform: Platform, userId: string) => Promise<number | null>;
  send: (accountId: number, event: string, data: object) => number;
  now?: () => number;
}

const MOD_CACHE_MS = 60_000;

/**
 * `/nicknames/stream` je veřejný (a s replay bufferem), čekající GIF tam nesmí. Proto události `gif-pending`
 * a `gif-decided` jdou jen spojením /account/stream účtů, které jsou mody kanálu (accountModIdentities, cache 60 s)
 * nebo odesílatelem (má `own: true`).
 */
export function createGifNotifier(deps: GifNotifierDeps) {
  const now = deps.now ?? Date.now;
  const modCache = new Map<string, { at: number; mod: boolean }>();
  const isMod = async (accountId: number, channel: string): Promise<boolean> => {
    const k = `${accountId}|${channel}`;
    const hit = modCache.get(k);
    if (hit && now() - hit.at < MOD_CACHE_MS) return hit.mod;
    let mod = false;
    try { mod = await deps.isMod(accountId, channel); } catch { mod = false; }
    modCache.set(k, { at: now(), mod });
    if (modCache.size > 2000) modCache.clear();
    return mod;
  };
  return {
    isMod,
    /** Rozešle událost modům kanálu + odesílateli; vrací id účtů, kterým šla. */
    async notify(r: Pick<GifRequest, 'channel' | 'platform' | 'userId'>, event: string, data: object): Promise<number[]> {
      let sender: number | null = null;
      try { sender = await deps.senderAccount(r.platform as Platform, r.userId); } catch { sender = null; }
      const out: number[] = [];
      if (sender !== null) { deps.send(sender, event, { ...data, own: true }); out.push(sender); }
      for (const acc of deps.connected()) {
        if (acc === sender) continue;
        if (await isMod(acc, r.channel)) { deps.send(acc, event, data); out.push(acc); }
      }
      return out;
    },
    /** Čekající žádosti, které účet smí vidět (po připojení /account/stream). */
    async visibleTo(accountId: number, rows: GifRequest[]): Promise<Array<GifPendingView & { own?: true }>> {
      const out: Array<GifPendingView & { own?: true }> = [];
      for (const r of rows) {
        let own = false;
        try { own = (await deps.senderAccount(r.platform as Platform, r.userId)) === accountId; } catch { own = false; }
        if (own) out.push({ ...pendingView(r), own: true });
        else if (await isMod(accountId, r.channel)) out.push(pendingView(r));
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Tok žádostí
// ---------------------------------------------------------------------------

/** Událost pro integrační stream Židolišty (sse/integrationStream.ts GifIntegrationEvent). */
export type GifIntegration =
  | { type: 'gif.pending'; workspace: string; requestId: number; platform: string; userId: string; login: string; messageId: string; text: string; media: GifPendingView['media']; expiresAt: string }
  | { type: 'gif.decided'; workspace: string; requestId: number; platform: string; userId: string; login: string; status: GifStatus; by: string | null };

export interface GifFlowDeps {
  store: GifStore;
  resolve: (src: GifSource) => Promise<ResolvedGif>;
  access: (q: GifAccessQuery) => Promise<GifAccess | null>;
  used: (p: { workspace: string; platform: Platform; userId: string }) => Promise<unknown>;
  /** publishDeleted (SSE message-deleted + chat.deleted). */
  publishDeleted: (p: { channel: string; platform: Platform; messageId: string; by: string; reason: 'gif_request' }) => Promise<void>;
  /** deletePlatformMessage botem workspace (accountId null). */
  deletePlatform: (p: { accountId: null; channel: string; platform: Platform; messageId: string }) => Promise<string>;
  /** Převod selhal a filtr by zprávu pustil → obnovit v UC (publishRestored pro deleted_reason gif_request). */
  restore: (p: { channel: string; platform: Platform; messageId: string; userId: string; platformChannel: string }) => Promise<string>;
  broadcast: (event: string, data: object) => void;
  publishChat: (platformChannel: string, platform: string, msg: ClientMessage) => void;
  notify: (r: GifRequest, event: string, data: object) => Promise<unknown>;
  integration: (ev: GifIntegration) => void | Promise<unknown>;
  recordAction?: (v: { channel: string; accountId: number | null; actor: string; action: string; platform: string; targetLogin: string | null; targetMessageId?: string | null; params: object; result: object }) => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Médium smazané z DB (zamítnutí, propadnutí) → pryč i z paměťové cache /media/gif. */
  mediaDeleted?: (id: string) => void;
  log: Log;
}

export interface GifInterceptParams {
  m: IngestMessage;
  ucChannel: string;
  workspace: string;
  candidate: GifCandidate;
  query: GifAccessQuery;
  /** Jak je zpráva už označená: 'gif_request' (přístup z cache), 'link_filter' (smazal ji filtr), null (zobrazená). */
  preDeleted: 'gif_request' | 'link_filter' | null;
  /** Přístup cache neznala → nejdřív ověřit u Židolišty. */
  needAccess: boolean;
  /** Akce filtru odkazů (smazat jako běžný odkaz) — při selhání převodu, když by filtr zprávu smazal; jinak null. */
  filterAct: (() => Promise<void>) | null;
}

/**
 * Čekání na zápis původní zprávy do archivu (ingest dávkuje po 500 ms): přeznačení/obnovení v DB musí
 * najít řádek. Běží souběžně se stahováním média, zdržení je jen u rychlých chyb.
 */
export const FLUSH_WAIT_MS = 1500;

export function createGifFlow(deps: GifFlowDeps) {
  const busy = new Set<string>();
  const pending = new Map<string, number>();
  const userKey = (channel: string, platform: string, userId: string) => `${channel}|${platform}|${userId}`;
  const safe = async (what: string, fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) { deps.log.warn({ err: (e as Error).message }, `gif: ${what} selhalo`); }
  };

  const decided = async (r: GifRequest, status: GifStatus, by: string | null) => {
    pending.delete(userKey(r.channel, r.platform, r.userId));
    const ev = { requestId: r.id, channel: r.channel, approved: status === 'approved', status, by };
    await safe('gif-decided', () => deps.notify(r, 'gif-decided', ev));
    await safe('integrace gif.decided', async () => deps.integration({ type: 'gif.decided', workspace: r.workspace, requestId: r.id, platform: r.platform, userId: r.userId, login: r.login, status, by }));
  };

  return {
    /** Synchronně (onLive): smí uživatel založit žádost? Rezervuje místo (jedna žádost na uživatele současně). */
    tryReserve(channel: string, platform: string, userId: string): boolean {
      const k = userKey(channel, platform, userId);
      if (busy.has(k) || pending.has(k)) return false;
      busy.add(k);
      return true;
    },

    /** Převod + žádost na pozadí. Vrací výsledek (log/testy); nikdy nevyhodí. */
    async intercept(p: GifInterceptParams): Promise<'requested' | 'denied' | 'failed'> {
      const { m } = p;
      const k = userKey(p.ucChannel, m.platform, m.platformUserId);
      busy.add(k);
      try {
        // Addon čte Twitch IRC napřímo → původní zprávu schovat hned, ne až po stažení média.
        if (p.preDeleted === 'gif_request') await safe('publishDeleted', () => deps.publishDeleted({ channel: p.ucChannel, platform: m.platform, messageId: m.platformMessageId, by: 'filter', reason: 'gif_request' }));
        if (p.needAccess) {
          const a = await deps.access(p.query).catch(() => null);
          if (!gifUsable(a, deps.now())) return 'denied';
        }
        const [res] = await Promise.all([
          deps.resolve(p.candidate).then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, code: e instanceof GifError ? e.code : 'exception' })),
          deps.sleep(FLUSH_WAIT_MS),
        ]);
        let created: GifRequest | null = null;
        if (res.ok) {
          let mediaId: string | null = null;
          try {
            mediaId = await deps.store.saveMedia(res.v);
            const raw = (m.contentRaw || {}) as Record<string, unknown>;
            // requestTtlSec z odpovědi Židolišty (z cache, už načtená); chybí → 300 s.
            const access = await deps.access(p.query).catch(() => null);
            created = await deps.store.insertRequest({
              channel: p.ucChannel, workspace: p.workspace, platform: m.platform, platformChannel: m.channel,
              userId: m.platformUserId, login: m.username.toLowerCase(), messageId: m.platformMessageId,
              textWithoutLink: textWithoutLink(m.content, p.candidate.token), mediaId, kind: res.v.kind,
              width: res.v.width, height: res.v.height,
              meta: { displayName: m.username, ...(raw.color ? { color: raw.color } : {}), ...(raw.badges !== undefined ? { badges: raw.badges } : {}) },
              expiresAt: new Date(deps.now() + (access?.requestTtlSec ?? 300) * 1000),
            });
          } catch (e) {
            deps.log.warn({ err: (e as Error).message }, 'gif: uložení žádosti selhalo');
            if (mediaId) await safe('úklid média', () => deps.store.deleteMedia(mediaId!));
          }
        } else {
          deps.log.info({ channel: p.ucChannel, platform: m.platform, code: res.code }, 'gif: převod odkazu selhal (běžný odkaz)');
        }

        if (!created) {
          // Převod selhal → běžný odkaz: filtr ho smaže, jinak se v UC obnoví (smazali jsme ho my).
          if (p.preDeleted === 'gif_request') {
            if (p.filterAct) {
              await safe('přeznačení na link_filter', () => deps.store.retagDeleted(m.platform, m.platformMessageId, 'gif_request', 'link_filter'));
              await safe('filtr odkazů', () => p.filterAct!());
            } else {
              await safe('obnovení zprávy', () => deps.restore({ channel: p.ucChannel, platform: m.platform, messageId: m.platformMessageId, userId: m.platformUserId, platformChannel: m.channel }));
            }
          }
          return 'failed';
        }

        // Původní zpráva: v UC smazat (pokud ještě není), na platformě botem (filtr to už udělal, když ji mazal on).
        if (p.preDeleted === 'link_filter') {
          await safe('přeznačení na gif_request', () => deps.store.retagDeleted(m.platform, m.platformMessageId, 'link_filter', 'gif_request'));
        } else {
          if (p.preDeleted === null) await safe('publishDeleted', () => deps.publishDeleted({ channel: p.ucChannel, platform: m.platform, messageId: m.platformMessageId, by: 'filter', reason: 'gif_request' }));
          let result = 'error:exception';
          try { result = await deps.deletePlatform({ accountId: null, channel: p.ucChannel, platform: m.platform, messageId: m.platformMessageId }); }
          catch (e) { deps.log.warn({ err: (e as Error).message }, 'gif: smazání původní zprávy na platformě vyhodilo výjimku'); }
          deps.log.info({ channel: p.ucChannel, platform: m.platform, result }, 'gif: původní zpráva smazána');
        }

        pending.set(k, created.id);
        const view = pendingView(created);
        await safe('gif-pending', () => deps.notify(created!, 'gif-pending', view));
        await safe('integrace gif.pending', async () => deps.integration({ type: 'gif.pending', workspace: created!.workspace, requestId: created!.id, platform: created!.platform, userId: created!.userId, login: created!.login, messageId: created!.messageId, text: view.text, media: view.media, expiresAt: created!.expiresAt.toISOString() }));
        await safe('moderation_actions', async () => deps.recordAction?.({ channel: p.ucChannel, accountId: null, actor: 'filter', action: 'gif_request', platform: m.platform, targetLogin: created!.login, targetMessageId: m.platformMessageId, params: { requestId: created!.id, kind: created!.kind, source: new URL(p.candidate.url).hostname }, result: {} }));
        deps.log.info({ channel: p.ucChannel, platform: m.platform, requestId: created.id, kind: created.kind }, 'gif: žádost o schválení');
        return 'requested';
      } catch (e) {
        deps.log.warn({ err: (e as Error).message }, 'gif: zachycení selhalo');
        return 'failed';
      } finally {
        busy.delete(k);
      }
    },

    /**
     * Rozhodnutí moda (mod už ověřený routou). První vyhrává: podmíněný UPDATE; pozdější → 409 already_decided.
     */
    async decide(p: { requestId: number; approve: boolean; by: string; accountId: number | null }): Promise<{ status: number; body: Record<string, unknown> }> {
      const at = new Date(deps.now());
      const r = await deps.store.decide(p.requestId, p.approve ? 'approved' : 'rejected', p.by, at);
      if (!r) {
        const cur = await deps.store.get(p.requestId);
        if (!cur) return { status: 404, body: { ok: false, error: 'not_found' } };
        return { status: 409, body: { ok: false, error: 'already_decided', status: cur.status === 'pending' ? 'expired' : cur.status } };
      }
      const status: GifStatus = p.approve ? 'approved' : 'rejected';
      if (p.approve) {
        let msg: ClientMessage | null = null;
        try { msg = await deps.store.insertApprovedMessage(r, at); }
        catch (e) { deps.log.warn({ err: (e as Error).message }, 'gif: zápis schválené zprávy do archivu selhal'); msg = toClientMessage(approvedMessageRow(r, at), false); }
        deps.broadcast('gif-message', { channel: r.channel, requestId: r.id, message: msg });
        await safe('chat stream', async () => deps.publishChat(r.platformChannel, r.platform, msg!));
        await safe('gif-used', () => deps.used({ workspace: r.workspace, platform: r.platform as Platform, userId: r.userId }));
      } else if (r.mediaId) {
        await safe('smazání média', async () => { await deps.store.deleteMedia(r.mediaId!); deps.mediaDeleted?.(r.mediaId!); });
      }
      await decided(r, status, p.by);
      await safe('moderation_actions', async () => deps.recordAction?.({ channel: r.channel, accountId: p.accountId, actor: p.by, action: p.approve ? 'gif_approve' : 'gif_reject', platform: r.platform, targetLogin: r.login, targetMessageId: r.messageId, params: { requestId: r.id }, result: { status } }));
      return { status: 200, body: { ok: true, requestId: r.id, status } };
    },

    /** Propadlé žádosti → expired, médium pryč, gif-decided (status expired). Vrací počet. */
    async expireTick(): Promise<number> {
      let rows: GifRequest[] = [];
      try { rows = await deps.store.expireDue(new Date(deps.now())); }
      catch (e) { deps.log.warn({ err: (e as Error).message }, 'gif: propadnutí selhalo'); return 0; }
      for (const r of rows) {
        if (r.mediaId) await safe('smazání média', async () => { await deps.store.deleteMedia(r.mediaId!); deps.mediaDeleted?.(r.mediaId!); });
        await decided(r, 'expired', null);
      }
      if (rows.length) deps.log.info({ n: rows.length }, 'gif: žádosti propadly');
      return rows.length;
    },

    /** Po startu: čekající žádosti do paměti (jedna žádost na uživatele). */
    async loadPending(): Promise<number> {
      const rows = await deps.store.listPending(new Date(deps.now()));
      for (const r of rows) pending.set(userKey(r.channel, r.platform, r.userId), r.id);
      return rows.length;
    },

    /** Schválený GIF smazaný modem (část 1, id `gif-…`) → status deleted, rezervace pryč. */
    async onMessageDeleted(messageId: string): Promise<void> {
      await safe('označení smazaného GIFu', () => deps.store.markDeletedByMessage(messageId));
    },

    _pendingSize: () => pending.size,
  };
}

export type GifFlow = ReturnType<typeof createGifFlow>;
