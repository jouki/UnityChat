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
//   UX 2026-09-25: původní zprávu (gif_request) klienti nevykreslují; schválený GIF `gif-<id>` nese čas původní
//   zprávy a `replaces: <platform>:<messageId>` (nahradí ji na místě); zamítnutí/propadnutí → důvod přeznačen
//   na gif_rejected + SSE message-deleted (běžně smazaná zpráva). Mod / broadcaster (badge) → `auto`: schváleno
//   hned bez Židolišty, bez cooldownu (gif-used se nevolá) a bez karet; Dev mód v UC (gifReview) = jako divák.
//   Převod selže → zpráva se bere jako běžný odkaz (filtr ji smaže, nebo se v UC obnoví, když by ji filtr pustil).
// Nic tady nesmí shodit ingest. NIKDY nelogovat tokeny.
import { randomBytes, createHash } from 'node:crypto';
import { and, eq, inArray, isNull, lte, gt, sql } from 'drizzle-orm';
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

/**
 * Důvod smazání původní zprávy po zamítnutí / propadnutí žádosti (UX 2026-09-25): `gif_request` klienti
 * nevykreslují vůbec (odesílatel má kartu „čeká na schválení", po schválení zprávu nahradí GIF), po
 * zamítnutí se z ní stane běžně smazaná zpráva. Vlastní důvod (ne `mod`), ať audit ukáže, že šlo o GIF,
 * a mod ji v UnityChatu neodkryje (POST /moderation/restore → 409 not_restorable).
 */
export const GIF_REJECTED_REASON = 'gif_rejected' as const;

/** Čas původní zprávy (meta.sentAt, ms) — schválený GIF ji nahradí na jejím místě; starší žádosti bez něj = vznik žádosti. */
export function originalSentAt(r: Pick<GifRequest, 'meta' | 'createdAt'>): Date {
  const v = Number(((r.meta || {}) as Record<string, unknown>).sentAt);
  return Number.isFinite(v) && v > 0 ? new Date(v) : r.createdAt;
}

/**
 * Řádek schválené žádosti → syntetická zpráva archivu (messages). Id `gif-<requestId>`, čas = čas PŮVODNÍ
 * zprávy (nahrazuje ji na jejím místě, `replaces: <platform>:<messageId>`); `_at` (čas schválení) se nepoužívá.
 */
export function approvedMessageRow(r: GifRequest, _at?: Date) {
  const meta = (r.meta || {}) as Record<string, unknown>;
  const text = r.textWithoutLink;
  const contentRaw: Record<string, unknown> = {
    gif: { mediaId: r.mediaId, kind: r.kind, width: r.width, height: r.height, requestId: r.id, replaces: `${r.platform}:${r.messageId}` },
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
    sentAt: originalSentAt(r),
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
  /** Čekající a nepropadlé, BEZ auto-schválení modem (meta.auto — schvaluje se hned, nikdo jiný je nerozhoduje); `channel` = jen UC kanál (filtr v SQL). */
  listPending(at: Date, channel?: string): Promise<GifRequest[]>;
  /** Schválený GIF smazaný modem (část 1) → status deleted. */
  markDeletedByMessage(messageId: string): Promise<GifRequest | null>;
  insertApprovedMessage(r: GifRequest, at: Date): Promise<ClientMessage>;
  /** deleted_reason původní zprávy from → to (jen když je smazaná s from). false = řádek nenalezen. */
  retagDeleted(platform: Platform, messageId: string, from: string, to: string): Promise<boolean>;
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
  async listPending(at, channel) {
    return db.select().from(gifRequests)
      .where(and(eq(gifRequests.status, 'pending'), gt(gifRequests.expiresAt, at), sql`(${gifRequests.meta}->>'auto') is null`, channel !== undefined ? eq(gifRequests.channel, channel) : undefined))
      .limit(500);
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
    const rows = await db.update(messages).set({ deletedReason: to })
      .where(and(eq(messages.platform, platform), eq(messages.platformMessageId, messageId), eq(messages.deletedReason, from)))
      .returning({ id: messages.id });
    return rows.length > 0;
  },
};

/** Účet UnityChatu odesílatele (propojená identita, ne odhlášená); null = nemá. */
export async function senderAccount(platform: Platform, userId: string): Promise<number | null> {
  const rows = await db.select({ accountId: webIdentities.accountId }).from(webIdentities)
    .where(and(eq(webIdentities.platform, platform), eq(webIdentities.platformUserId, userId), isNull(webIdentities.signedOutAt))).limit(1);
  return rows[0]?.accountId ?? null;
}

/** Médium pro GET /media/gif/:id — jen když k němu patří čekající nebo schválená žádost (se stavem pro Cache-Control). */
export async function servableMedia(id: string): Promise<{ bytes: Buffer; contentType: string; status: 'pending' | 'approved' } | null> {
  const rows = await db.select({ bytes: gifMedia.bytes, contentType: gifMedia.contentType, status: gifRequests.status })
    .from(gifMedia)
    .innerJoin(gifRequests, eq(gifRequests.mediaId, gifMedia.id))
    .where(and(eq(gifMedia.id, id), inArray(gifRequests.status, ['pending', 'approved'])))
    .limit(1);
  return rows[0] ? { bytes: rows[0].bytes, contentType: rows[0].contentType, status: rows[0].status === 'approved' ? 'approved' : 'pending' } : null;
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
  /** Schváleno: médium do paměťové cache jako approved PŘED rozesláním (diváci přijdou naráz). */
  mediaApproved?: (id: string) => Promise<void>;
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
  /** Filtr odkazů by host zablokoval → token se vyřadí i z textu nad GIFem. Chybí = ponechat ostatní odkazy. */
  linkBlocked?: (host: string) => boolean;
  /**
   * Mod / broadcaster (badge zprávy): GIF se schválí rovnou (`by` = on sám), bez přístupu ze Židolišty,
   * bez cooldownu (gif-used se nevolá) a bez karty ke schválení.
   */
  auto?: boolean;
  /**
   * Klient nahlásil „schvalovat jako divák" (Dev mód, lib/ucSends.ts gifReviews) až po echu zprávy
   * (/chat/uc-sent). Ověří se po stažení média; true → z auto se stane běžná žádost.
   */
  lateReview?: () => boolean;
}

/**
 * Čekání na zápis původní zprávy do archivu (ingest dávkuje po 500 ms): přeznačení/obnovení v DB musí
 * najít řádek. Běží souběžně se stahováním média, zdržení je jen u rychlých chyb.
 */
export const FLUSH_WAIT_MS = 1500;

export function createGifFlow(deps: GifFlowDeps) {
  const busy = new Set<string>();
  const pending = new Map<string, number>();
  // Žádosti už rozhodnuté/propadlé (v tomto procesu): zámek uživatele se nesmí nastavit zpětně, když mod
  // rozhodl dřív, než intercept došel k pending.set (GET /moderation/gif/pending žádost ukáže hned po insertu).
  const closed = new Set<number>();
  const userKey = (channel: string, platform: string, userId: string) => `${channel}|${platform}|${userId}`;
  const safe = async (what: string, fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) { deps.log.warn({ err: (e as Error).message }, `gif: ${what} selhalo`); }
  };

  const decided = async (r: GifRequest, status: GifStatus, by: string | null, opts: { quiet?: boolean } = {}) => {
    closed.add(r.id);
    if (closed.size > 2000) closed.delete(closed.values().next().value!);
    const k = userKey(r.channel, r.platform, r.userId);
    if (pending.get(k) === r.id) pending.delete(k);
    // Zamítnuto / propadlo: původní zpráva (v UC dosud nevykreslená, gif_request) → běžně smazaná.
    if (status === 'rejected' || status === 'expired') await rejectOriginal(r, status === 'rejected' ? by : null);
    // Auto-schválení modem: nikdo žádost neviděl (gif-pending ani gif.pending nešlo) → ani rozhodnutí neohlašovat.
    if (opts.quiet) return;
    const ev = { requestId: r.id, channel: r.channel, approved: status === 'approved', status, by };
    await safe('gif-decided', () => deps.notify(r, 'gif-decided', ev));
    await safe('integrace gif.decided', async () => deps.integration({ type: 'gif.decided', workspace: r.workspace, requestId: r.id, platform: r.platform, userId: r.userId, login: r.login, status, by }));
  };

  /** Původní zpráva: gif_request → gif_rejected v archivu + SSE message-deleted (klienti ji ukážou jako smazanou). */
  const rejectOriginal = async (r: GifRequest, by: string | null) => {
    await safe('přeznačení původní zprávy na gif_rejected', () => deps.store.retagDeleted(r.platform as Platform, r.messageId, 'gif_request', GIF_REJECTED_REASON));
    await safe('message-deleted gif_rejected', async () => deps.broadcast('message-deleted', { channel: r.channel, platform: r.platform, messageId: r.messageId, by: by ?? 'filter', reason: GIF_REJECTED_REASON, at: deps.now() }));
  };

  /**
   * Rozhodnutí (mod přes routu, nebo auto-schválení modova GIFu). První vyhrává: podmíněný UPDATE; pozdější → 409.
   * `auto`: bez gif-used (mod nemá cooldown) a bez gif-decided / gif.decided (žádost nikdo neviděl).
   */
  const decideCore = async (p: { requestId: number; approve: boolean; by: string; accountId: number | null; auto?: boolean }): Promise<{ status: number; body: Record<string, unknown> }> => {
    const at = new Date(deps.now());
    const r = await deps.store.decide(p.requestId, p.approve ? 'approved' : 'rejected', p.by, at);
    if (!r) {
      const cur = await deps.store.get(p.requestId);
      if (!cur) return { status: 404, body: { ok: false, error: 'not_found' } };
      return { status: 409, body: { ok: false, error: 'already_decided', status: cur.status === 'pending' ? 'expired' : cur.status } };
    }
    const status: GifStatus = p.approve ? 'approved' : 'rejected';
    let published = true;
    if (p.approve) {
      // Cooldown hned (gifUsed ho nastaví lokálně synchronně, před voláním Židolišty), ne až po rozeslání.
      // Auto (mod / broadcaster): cooldown se neuplatňuje → gif-used se nevolá.
      const usedP = p.auto ? Promise.resolve() : Promise.resolve().then(() => deps.used({ workspace: r.workspace, platform: r.platform as Platform, userId: r.userId }))
        .catch((e) => deps.log.warn({ err: (e as Error).message }, 'gif: gif-used selhalo'));
      // Zpráva jde ven jen když je v archivu (jinak by po reloadu zmizela) — jeden opakovaný pokus.
      let msg: ClientMessage | null = null;
      for (let attempt = 0; attempt < 2 && !msg; attempt++) {
        try { msg = await deps.store.insertApprovedMessage(r, at); }
        catch (e) { deps.log.warn({ requestId: r.id, attempt: attempt + 1, err: (e as Error).message }, 'gif: zápis schválené zprávy do archivu selhal'); }
      }
      if (msg) {
        if (r.mediaId) await safe('předehřátí média', async () => deps.mediaApproved?.(r.mediaId!));
        deps.broadcast('gif-message', { channel: r.channel, requestId: r.id, message: msg });
        await safe('chat stream', async () => deps.publishChat(r.platformChannel, r.platform, msg!));
      } else {
        published = false;
        deps.log.warn({ requestId: r.id, channel: r.channel }, 'gif: schválený GIF se nezapsal do archivu → nerozeslán');
        // Původní zpráva nesmí zůstat navždy schovaná (gif_request) → běžně smazaná (gif_rejected + message-deleted).
        await rejectOriginal(r, p.by);
      }
      await usedP;
    } else if (r.mediaId) {
      await safe('smazání média', async () => { await deps.store.deleteMedia(r.mediaId!); deps.mediaDeleted?.(r.mediaId!); });
    }
    await decided(r, status, p.by, { quiet: p.auto });
    await safe('moderation_actions', async () => deps.recordAction?.({ channel: r.channel, accountId: p.accountId, actor: p.by, action: p.approve ? 'gif_approve' : 'gif_reject', platform: r.platform, targetLogin: r.login, targetMessageId: r.messageId, params: { requestId: r.id, ...(p.auto ? { auto: true } : {}) }, result: { status } }));
    return { status: 200, body: { ok: true, requestId: r.id, status, ...(published ? {} : { published: false }) } };
  };
  const approveCore = (requestId: number, by: string, accountId: number | null, opts: { auto?: boolean } = {}) =>
    decideCore({ requestId, approve: true, by, accountId, auto: opts.auto });

  return {
    /** Synchronně (onLive): smí uživatel založit žádost? Rezervuje místo (jedna žádost na uživatele současně). */
    tryReserve(channel: string, platform: string, userId: string): boolean {
      const k = userKey(channel, platform, userId);
      if (busy.has(k) || pending.has(k)) return false;
      busy.add(k);
      return true;
    },

    /** Převod + žádost na pozadí. Vrací výsledek (log/testy); nikdy nevyhodí. */
    async intercept(p: GifInterceptParams): Promise<'requested' | 'approved' | 'denied' | 'failed' | 'cancelled'> {
      const { m } = p;
      let auto = !!p.auto;
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
        // Mod z UnityChatu v Dev módu (hlášení došlo po echu) → schvalování jako divák.
        if (auto && p.lateReview?.()) {
          auto = false;
          deps.log.info({ channel: p.ucChannel, platform: m.platform }, 'gif: mod v Dev módu → žádost ke schválení (pozdní hlášení)');
        }
        let created: GifRequest | null = null;
        if (res.ok && p.preDeleted === 'link_filter') {
          // Zprávu smazal filtr; mezitím ji mohl obnovit permit (deleted_reason zrušen) → žádost nevytvářet.
          let retagged = false;
          try { retagged = await deps.store.retagDeleted(m.platform, m.platformMessageId, 'link_filter', 'gif_request'); }
          catch (e) { deps.log.warn({ err: (e as Error).message }, 'gif: přeznačení na gif_request selhalo'); }
          if (!retagged) {
            deps.log.info({ channel: p.ucChannel, platform: m.platform }, 'gif: původní zpráva už není smazaná filtrem (permit) → bez žádosti');
            return 'cancelled';
          }
        }
        if (res.ok) {
          let mediaId: string | null = null;
          try {
            mediaId = await deps.store.saveMedia(res.v);
            const raw = (m.contentRaw || {}) as Record<string, unknown>;
            // requestTtlSec z odpovědi Židolišty (z cache, už načtená); chybí → 300 s. Auto (mod) Židolištu nepotřebuje.
            const access = auto ? null : await deps.access(p.query).catch(() => null);
            created = await deps.store.insertRequest({
              channel: p.ucChannel, workspace: p.workspace, platform: m.platform, platformChannel: m.channel,
              userId: m.platformUserId, login: m.username.toLowerCase(), messageId: m.platformMessageId,
              textWithoutLink: textWithoutLink(m.content, p.candidate.token, p.linkBlocked), mediaId, kind: res.v.kind,
              width: res.v.width, height: res.v.height,
              // sentAt: schválený GIF nahradí původní zprávu na jejím místě (approvedMessageRow).
              meta: { displayName: m.username, sentAt: m.sentAt.getTime(), ...(raw.color ? { color: raw.color } : {}), ...(raw.badges !== undefined ? { badges: raw.badges } : {}), ...(auto ? { auto: true } : {}) },
              expiresAt: new Date(deps.now() + (access?.requestTtlSec ?? 300) * 1000),
            });
            // Zámek uživatele hned po vzniku žádosti (ne až po mazání na platformě) — a jen když ji mezitím
            // nikdo nerozhodl (rozhodnutí by zámek už nesundalo a visel by do restartu).
            if (!closed.has(created.id)) pending.set(k, created.id);
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
          } else if (p.preDeleted === 'link_filter' && res.ok) {
            // Přeznačení na gif_request proběhlo (výš), ale médium/žádost se neuložily → vrátit link_filter,
            // jinak by zpráva zůstala smazaná bez žádosti a permit by ji už neobnovil.
            await safe('vrácení na link_filter', () => deps.store.retagDeleted(m.platform, m.platformMessageId, 'gif_request', 'link_filter'));
          }
          return 'failed';
        }

        // Mod / broadcaster: schválit HNED po insertu (stejná cesta jako decide approve), bez cooldownu a bez karet —
        // dřív, než by žádost mohl uvidět a rozhodnout jiný mod (listPending auto žádosti navíc vynechává).
        // Mazání na platformě až potom (níž).
        let autoOut: { status: number } | null = null;
        if (auto) {
          const by = `${m.platform}:${m.username.toLowerCase()}`;
          autoOut = await approveCore(created.id, by, null, { auto: true });
          deps.log.info({ channel: p.ucChannel, platform: m.platform, requestId: created.id, status: autoOut.status }, 'gif: mod → schváleno rovnou');
        }

        // Původní zpráva: v UC smazat (pokud ještě není), na platformě botem (filtr to už udělal, když ji mazal on;
        // přeznačení na gif_request proběhlo výš).
        if (p.preDeleted !== 'link_filter') {
          if (p.preDeleted === null) await safe('publishDeleted', () => deps.publishDeleted({ channel: p.ucChannel, platform: m.platform, messageId: m.platformMessageId, by: 'filter', reason: 'gif_request' }));
          let result = 'error:exception';
          try { result = await deps.deletePlatform({ accountId: null, channel: p.ucChannel, platform: m.platform, messageId: m.platformMessageId }); }
          catch (e) { deps.log.warn({ err: (e as Error).message }, 'gif: smazání původní zprávy na platformě vyhodilo výjimku'); }
          deps.log.info({ channel: p.ucChannel, platform: m.platform, result }, 'gif: původní zpráva smazána');
        }
        if (autoOut) return autoOut.status === 200 ? 'approved' : 'requested';

        const view = pendingView(created);
        // Rozhodnuto dřív, než jsme stihli ohlásit (mod ji viděl v GET /moderation/gif/pending) → gif-pending neposílat,
        // gif-decided už odešlo.
        if (closed.has(created.id)) return 'requested';
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
    decide(p: { requestId: number; approve: boolean; by: string; accountId: number | null }): Promise<{ status: number; body: Record<string, unknown> }> {
      return decideCore(p);
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
