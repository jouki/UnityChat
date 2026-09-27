// Odměna „Posílání GIFů" (moderace část 4, spec docs/superpowers/specs/2026-09-25-moderace-odkazy-gify-design.md,
// GIF knihovna spec docs/superpowers/specs/2026-09-26-gif-knihovna-design.md,
// kontrakt docs/superpowers/plans/2026-09-25-moderace-cast-2-kontrakt.md §Část 4).
//
// Tok:
//   ingest onLive → filtr odkazů (lib/linkFilter.ts) pozná odkaz na GIF od uživatele s odemčenými GIFy
//   → původní zpráva se smaže (deleted_reason 'gif_request', v UC hned, na platformě botem po úspěšném převodu)
//   → dedup: náš odkaz /media/gif/<id> → médium podle id; jinak normalizovaná URL zdroje (bez stahování);
//     jinak stažení (průběh `gif-progress` odesílateli) a sha256 obsahu
//   → známé schválené médium = rovnou `gif-message` (bez žádosti ke schválení, use_count++);
//     režim odměny `approved` (gif-access.mode) + cokoli jiného = zpráva smazaná (gif_not_allowed) + `gif-notice`;
//     známé zamítnuté: zákaz 12 h nebo 3.+ pokus téhož uživatele = automaticky zamítnuto (zpráva smazaná),
//     jinak žádost s `previouslyRejected` (kdy, kým);
//     jinak žádost (gif_requests, pending, expires = +requestTtlSec)
//   → SSE `gif-pending` JEN modům kanálu a odesílateli (/account/stream, soukromě) + `gif-queue` modům (FIFO)
//   → první rozhodnutí moda (POST /moderation/gif/:id/decide, podmíněný UPDATE) vyhrává:
//       schváleno → médium approved (knihovna), syntetická zpráva `gif-<id>` na KONCI chatu (čas schválení)
//                   + SSE `gif-message` všem + /chat/stream + Židolišta gif-used (cooldown); ostatní čekající
//                   žádosti na stejné médium se schválí taky;
//       zamítnuto → médium rejected (jen s tokenem, retence 14 dní, vault), počítadlo zamítnutí uživatele;
//     obojí → `gif-decided` modům + odesílateli, `gif-queue` modům.
//   Propadnutí: pending po expires_at → expired + `gif-decided` (status expired); médium čekající jen na ni pryč.
//   Trvale zahodit (spec 2026-09-27-gif-nahled-zahozeni-design.md, mediaAction purge/restore/remove-file):
//     withdrawn (zprávy nechat) / purging (i se zprávami, smazání po 7 dnech, obnova) / unavailable (soubor pryč);
//     zahozené médium dedup pozná → nový odkaz automaticky zamítnut; změna viditelnosti zpráv → SSE `gif-media`.
//   Mod / broadcaster (badge) s odemčenou odměnou → `auto`: schváleno hned, bez karet; přístup i cooldown ze Židolišty
//   jako u diváka (spec 2026-09-27-gif-review-upravy §5); Dev mód v UC = jako divák.
//   Převod selže → zpráva se bere jako běžný odkaz (filtr ji smaže, nebo se v UC obnoví, když by ji filtr pustil).
// Nic tady nesmí shodit ingest. NIKDY nelogovat tokeny.
import { randomBytes, createHash } from 'node:crypto';
import { and, asc, desc, eq, exists, gt, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { gifBans, gifMedia, gifRejections, gifRequests, messages, webIdentities, type GifRequest } from '../db/schema.js';
import type { IngestMessage } from '../ingest/types.js';
import { toRow } from '../ingest/normalize.js';
import { toClientMessage, type ClientMessage } from '../routes/chat.js';
import type { GifAccess, GifAccessQuery } from './gifAccess.js';
import { gifUsable } from './gifAccess.js';
import type { GifCandidate, GifFetchProgress, GifSource, ResolvedGif } from './gifMedia.js';
import { GifError, normalizeSourceUrl, textWithoutLink } from './gifMedia.js';
import { gifMediaUrl, gifMessageId, gifMessageState } from './gifIds.js';
import { clearMediaStrikes, moveMediaInto } from './gifLibrary.js';
import type { Platform } from './zidolista.js';

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

export type GifStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'deleted';
/**
 * Stav média. Trvale zahodit (spec 2026-09-27-gif-nahled-zahozeni-design.md):
 *  - withdrawn („Zahodit, zprávy nechat“): mimo knihovnu i zamítnuté, soubor zůstává, staré zprávy ho ukazují veřejně;
 *  - purging („Zahodit i se zprávami“): zprávy schované, soubor se smaže v purge_at (7 dní), do té doby jde obnovit;
 *  - unavailable (stažený, „Odstranit ze serveru“): soubor pryč, záznam zůstává (štítek ve zprávách, dedup).
 */
export type GifMediaStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'purging' | 'unavailable';
export type GifDiscardedStatus = 'withdrawn' | 'purging';
/** Zahozené médium: nový odkaz na něj se do chatu nepustí (auto zamítnuto, i od moda). */
export const GIF_DISCARDED: ReadonlySet<string> = new Set(['withdrawn', 'purging', 'unavailable']);
/** „Zahodit i se zprávami“: soubor se smaže po 7 dnech (do té doby „Obnovit“). */
export const PURGE_DELAY_MS = 7 * 86_400_000;
/** Kolik zpráv s GIFem nese SSE `gif-media` při zviditelnění (starší se opraví při dalším načtení historie). */
export const GIF_MEDIA_EVENT_MESSAGES = 200;

/** Médium bez bajtů (dedup, knihovna, zamítnuté, zahozené). */
export interface GifMediaInfo {
  id: string;
  channel: string | null;
  status: GifMediaStatus;
  kind: string;
  width: number | null;
  height: number | null;
  sha256: string;
  approvedAt: Date | null;
  rejectedAt: Date | null;
  rejectedBy: string | null;
  vault: boolean;
  tags?: string[];
  purgedAt?: Date | null;
  purgedBy?: string | null;
  purgeAt?: Date | null;
  statusBeforePurge?: string | null;
}

/** GIF byl dříve zamítnut: kdy (ms) a kým (odesílatel „kým" nedostává). */
export interface PreviouslyRejected { at: number | null; by?: string | null }

/** Tvar žádosti pro klienty (gif-pending, GET /moderation/gif/pending) — bez identity moda, bez URL zdroje. */
export interface GifPendingView {
  requestId: number;
  channel: string;
  platform: string;
  login: string;
  userId: string;
  messageId: string;
  text: string;
  /**
   * `tokenRequired`: médium je zamítnuté (nová žádost na dříve zamítnutý GIF) → vydá se jen s tokenem moda
   * (`?t=`, audit SEC-1); karta moda ho načítá s tokenem.
   */
  media: { url: string; kind: string; width: number | null; height: number | null; tokenRequired?: true };
  createdAt: number;
  expiresAt: number;
  /** GIF byl už dříve zamítnut (karta moda: kdy, kým; odesílatel jen ⚠). */
  previouslyRejected?: PreviouslyRejected;
}

const prevRejected = (meta: unknown): PreviouslyRejected | undefined => {
  const p = (meta && typeof meta === 'object' ? (meta as Record<string, unknown>).previouslyRejected : null) as Record<string, unknown> | null | undefined;
  if (!p || typeof p !== 'object') return undefined;
  return { at: typeof p.at === 'number' ? p.at : null, by: typeof p.by === 'string' ? p.by : null };
};

export function pendingView(r: GifRequest): GifPendingView {
  const pr = prevRejected(r.meta);
  return {
    requestId: r.id,
    channel: r.channel,
    platform: r.platform,
    login: r.login,
    userId: r.userId,
    messageId: r.messageId,
    text: r.textWithoutLink,
    media: {
      url: r.mediaId ? gifMediaUrl(r.mediaId) : '', kind: r.kind, width: r.width, height: r.height,
      ...((r.meta as Record<string, unknown> | null)?.tokenRequired ? { tokenRequired: true as const } : {}),
    },
    createdAt: r.createdAt.getTime(),
    expiresAt: r.expiresAt.getTime(),
    ...(pr ? { previouslyRejected: pr } : {}),
  };
}

/**
 * Důvod smazání původní zprávy po zamítnutí / propadnutí žádosti (UX 2026-09-25): `gif_request` klienti
 * nevykreslují vůbec (odesílatel má kartu „čeká na schválení", po schválení se GIF ukáže na konci chatu), po
 * zamítnutí se z ní stane běžně smazaná zpráva. Vlastní důvod (ne `mod`), ať audit ukáže, že šlo o GIF,
 * a mod ji v UnityChatu neodkryje (POST /moderation/restore → 409 not_restorable).
 */
export const GIF_REJECTED_REASON = 'gif_rejected' as const;
/** Nový GIF v režimu odměny „jen schválené" (gif-access.mode = approved). */
export const GIF_NOT_ALLOWED_REASON = 'gif_not_allowed' as const;

/** Retence zamítnutých médií (bez vaultu). */
export const REJECTED_RETENTION_MS = 14 * 86_400_000;
/** „Automaticky zahazovat 12 h". */
export const GIF_BAN_MS = 12 * 3600_000;
/** Kolikátý pokus téhož uživatele o zamítnutý GIF se zamítne automaticky (1. mod, 2. znovu mod, 3.+ auto). */
export const AUTO_REJECT_AFTER = 2;

/**
 * Řádek schválené žádosti → syntetická zpráva archivu (messages). Id `gif-<requestId>`, čas = čas SCHVÁLENÍ
 * (GIF knihovna 2026-09-26: schválený GIF na konci chatu), `origin: <platform>:<messageId>` jen k párování.
 */
export function approvedMessageRow(r: GifRequest, at?: Date) {
  const meta = (r.meta || {}) as Record<string, unknown>;
  const text = r.textWithoutLink;
  const contentRaw: Record<string, unknown> = {
    gif: { mediaId: r.mediaId, kind: r.kind, width: r.width, height: r.height, requestId: r.id, origin: `${r.platform}:${r.messageId}` },
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
    sentAt: at ?? r.decidedAt ?? r.createdAt,
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
  saveMedia(m: ResolvedGif, meta: { channel: string; sourceUrlNorm: string | null; sha256: string }): Promise<string>;
  deleteMedia(id: string): Promise<void>;
  getMedia(id: string): Promise<GifMediaInfo | null>;
  /** Médium kanálu podle normalizované URL nebo sha256; přednost approved > rejected > pending. */
  findMedia(channel: string, by: { url?: string; sha256?: string }): Promise<GifMediaInfo | null>;
  /**
   * approved + approved_at (první), zruší rejected_* a vault a v téže transakci i tresty média (gif_rejections všech
   * uživatelů + gif_bans). Vrací id schváleného média: když už je stejný obsah
   * (channel, sha256) schválený jako JINÉ médium (souběh dedupu, unikátní index), vrátí jeho id a toto nemění.
   */
  // null = médium mezitím trvale zahozené (withdrawn / purging / unavailable) nebo pryč → schválení se neprovede.
  // `onlyApproved` (GIF z knihovny, audit A2): jen když je médium pořád approved — odebrané z knihovny mezitím → null.
  setMediaApproved(id: string, at: Date, opts?: { onlyApproved?: boolean }): Promise<string | null>;
  /** Schválená žádost na zahozené médium (souběh) → rejected (podmíněně jen approved). */
  setRequestRejected(id: number, by: string, at: Date): Promise<GifRequest | null>;
  /**
   * Duplikát `fromId` do `toId` (souběh dedupu): žádosti i syntetické zprávy (`content_raw.gif.mediaId`) přesměrovat,
   * `fromId` smazat, jeho URL zdroje převzít (lib/gifLibrary.ts moveMediaInto — stejně jako sloučení duplikátu).
   */
  mergeMedia(fromId: string, toId: string): Promise<void>;
  /** rejected + rejected_at/by (jen čekající / zamítnuté — schválené ani zahozené se nemění). */
  setMediaRejected(id: string, by: string, at: Date): Promise<void>;
  /**
   * Trvale zahodit (jedna transakce): approved | rejected → `to` (withdrawn / purging), status_before_purge,
   * purged_at/by, purge_at (jen purging) + čekající žádosti na médium → rejected (`rejected` = zamítnuté řádky).
   * ok false = médium mezitím v jiném stavu (nic se nezměnilo).
   */
  purgeMedia(id: string, to: GifDiscardedStatus, by: string, at: Date, purgeAt: Date | null): Promise<{ ok: boolean; rejected: GifRequest[] }>;
  /**
   * Obnovit: jen purging → stav před zahozením (approved / rejected; bez záznamu rejected), purge_* pryč. Obnova mezi
   * zamítnuté = nové zamítnutí: rejected_at = `at` (retence 14 dní znovu od obnovy), rejected_by chybí → purged_by / `by`.
   * null = není purging. `mergedInto`: stejný obsah je mezitím schválený jako jiné médium → volající sloučí.
   */
  restoreMedia(id: string, at: Date, by: string): Promise<{ status: 'approved' | 'rejected'; mergedInto?: string } | null>;
  /** Odstranit ze serveru: jen withdrawn → unavailable, bajty pryč (řádek zůstává). false = jiný stav. */
  removeMediaFile(id: string): Promise<boolean>;
  /** Zahozená média kanálu (Stažené / Ke smazání), nejnovější zahození první; `before` = kurzor purgedAt:id. */
  listDiscarded(channel: string, status: GifDiscardedStatus, before: { at: Date; id: string } | null, limit: number): Promise<GifMediaInfo[]>;
  /** Retence: purging s purge_at <= at pryč (i záznam); vrací id. */
  purgeDue(at: Date): Promise<string[]>;
  /**
   * Klíče `<platform>:<id>` syntetických zpráv s médiem (nesmazané, neskryté), nejnovější první — do SSE `gif-media`
   * při zviditelnění (klient si obsah dotáhne přes GET /chat/messages).
   */
  messageKeysForMedia(mediaId: string, limit: number): Promise<string[]>;
  /** Odebrat z knihovny: jen approved → rejected (approved_at pryč, rejected_at/by, bez vaultu). false = nebylo schválené. */
  setMediaUnapproved(id: string, by: string, at: Date): Promise<boolean>;
  markMediaUsed(id: string, at: Date): Promise<void>;
  rejectionCount(channel: string, mediaId: string, platform: string, userId: string): Promise<number>;
  /**
   * Má médium v kanálu nějaké zamítnutí modem (strike kohokoli)? Karta ⚠ „už dříve zamítnut“ jen tehdy — po schválení
   * se strike mažou, takže GIF odebraný z knihovny (unapprove) jde dál jako běžná žádost bez ⚠.
   */
  hasRejections(channel: string, mediaId: string): Promise<boolean>;
  /** +1 zamítnutí uživatele; vrací nový počet. */
  addRejection(channel: string, mediaId: string, platform: string, userId: string, at: Date): Promise<number>;
  activeBan(channel: string, mediaId: string, at: Date): Promise<{ until: Date; by: string | null } | null>;
  setBan(channel: string, mediaId: string, until: Date, by: string): Promise<void>;
  /** Čekající nepropadlé žádosti na médium. */
  pendingForMedia(mediaId: string, at: Date): Promise<GifRequest[]>;
  /**
   * Odkazuje na médium ještě něco kromě propadlých žádostí? (čekající / schválená / smazaná / zamítnutá žádost;
   * schválená a smazaná = syntetická zpráva v archivu, např. čekající alias z backfillu) — propadnutí ho pak nesmaže.
   */
  mediaReferenced(mediaId: string): Promise<boolean>;
  /** Zamítnutá média kanálu, nejnovější první (rejected_at, id); `before` = kurzor poslední položky předchozí stránky. */
  listRejected(channel: string, before: { at: Date; id: string } | null, limit: number): Promise<GifMediaInfo[]>;
  setVault(id: string, vault: boolean): Promise<void>;
  /** Smaže zamítnutá bez vaultu s rejected_at < before (a bez čekající žádosti); vrací id. */
  retentionDue(before: Date, at: Date): Promise<string[]>;
  insertRequest(v: NewGifRequest): Promise<GifRequest>;
  /** Podmíněně: jen pending a ještě nepropadlá. null = už rozhodnuto / propadlo / neexistuje. */
  decide(id: number, status: 'approved' | 'rejected', by: string, at: Date): Promise<GifRequest | null>;
  get(id: number): Promise<GifRequest | null>;
  expireDue(at: Date): Promise<GifRequest[]>;
  /**
   * Čekající a nepropadlé, FIFO (created_at, id), BEZ auto-schválení modem (meta.auto) a okamžitých
   * schválení z knihovny (meta.instant) — ty nikdo nerozhoduje; `channel` = jen UC kanál (filtr v SQL).
   */
  listPending(at: Date, channel?: string): Promise<GifRequest[]>;
  /** Schválený GIF smazaný modem (část 1) → status deleted. */
  markDeletedByMessage(messageId: string): Promise<GifRequest | null>;
  insertApprovedMessage(r: GifRequest, at: Date): Promise<ClientMessage>;
  /**
   * Dorovnání (audit A1): schválené žádosti rozhodnuté v intervalu (after, before), kterým chybí syntetická zpráva
   * `gif-<id>`, nebo jejich médium zůstalo čekající (restart / chyba DB mezi rozhodnutím a zápisem). Nejstarší první.
   * `mediaStatus` null = médium už neexistuje.
   */
  unpublishedApproved(before: Date, after: Date, limit: number): Promise<Array<{ request: GifRequest; mediaStatus: string | null; hasMessage: boolean }>>;
  /** deleted_reason původní zprávy from → to (jen když je smazaná s from). false = řádek nenalezen. */
  retagDeleted(platform: Platform, messageId: string, from: string, to: string): Promise<boolean>;
  /**
   * Stav poslední žádosti k původním zprávám (GET /gif/held) jedním dotazem (audit C1): klíč `<platform>:<messageId>`
   * → stav; zpráva bez žádosti v mapě chybí. Index gif_requests_message_idx (sql/2026-09-27-gif-audit.sql).
   */
  statusByMessages(keys: Array<{ platform: Platform; messageId: string }>): Promise<Map<string, GifStatus>>;
}

const mediaCols = {
  id: gifMedia.id, channel: gifMedia.channel, status: gifMedia.status, kind: gifMedia.kind, width: gifMedia.width, height: gifMedia.height,
  sha256: gifMedia.sha256, approvedAt: gifMedia.approvedAt, rejectedAt: gifMedia.rejectedAt, rejectedBy: gifMedia.rejectedBy, vault: gifMedia.vault,
  tags: gifMedia.tags, purgedAt: gifMedia.purgedAt, purgedBy: gifMedia.purgedBy, purgeAt: gifMedia.purgeAt, statusBeforePurge: gifMedia.statusBeforePurge,
};
/** findMedia: schválené (knihovna) > zahozené (auto zamítnout) > zamítnuté > čekající. */
const FIND_ORDER = sql`case ${gifMedia.status} when 'approved' then 0 when 'withdrawn' then 1 when 'purging' then 1 when 'unavailable' then 1 when 'rejected' then 2 else 3 end`;
const asInfo = (r: Record<string, unknown>): GifMediaInfo => r as unknown as GifMediaInfo;
const isUniqueViolation = (e: unknown): boolean => (e as { code?: string })?.code === '23505' || /duplicate key/i.test(String((e as Error)?.message));
/** Čekající nepropadlá žádost na médium (retence / propadnutí nesmí médium smazat). */
const livePendingFor = (at: Date) => db.select({ one: sql`1` }).from(gifRequests)
  .where(and(eq(gifRequests.mediaId, gifMedia.id), eq(gifRequests.status, 'pending'), gt(gifRequests.expiresAt, at)));

export const dbGifStore: GifStore = {
  async saveMedia(m, meta) {
    const id = randomBytes(16).toString('hex');
    await db.insert(gifMedia).values({
      id, kind: m.kind, contentType: m.contentType, bytes: m.bytes, size: m.bytes.length,
      sha256: meta.sha256, width: m.width, height: m.height, channel: meta.channel, sourceUrlNorm: meta.sourceUrlNorm, status: 'pending',
      // Tagy ze stránky zdroje (Tenor/Giphy, lib/gifMedia.ts pageTags); hash a duplicity dopočítá lib/gifLibrary.ts na pozadí.
      tags: m.tags ?? [],
    });
    return id;
  },
  async deleteMedia(id) { await db.delete(gifMedia).where(eq(gifMedia.id, id)); },
  async getMedia(id) {
    const rows = await db.select(mediaCols).from(gifMedia).where(eq(gifMedia.id, id)).limit(1);
    return rows[0] ? asInfo(rows[0]) : null;
  },
  async findMedia(channel, by) {
    const cond = by.url ? eq(gifMedia.sourceUrlNorm, by.url) : by.sha256 ? eq(gifMedia.sha256, by.sha256) : null;
    if (!cond) return null;
    const rows = await db.select(mediaCols).from(gifMedia).where(and(eq(gifMedia.channel, channel), cond))
      .orderBy(FIND_ORDER, asc(gifMedia.createdAt)).limit(1);
    return rows[0] ? asInfo(rows[0]) : null;
  },
  async setMediaApproved(id, at, opts) {
    const from = opts?.onlyApproved ? ['approved'] : ['pending', 'rejected', 'approved'];
    const set = { status: 'approved', approvedAt: sql`coalesce(${gifMedia.approvedAt}, ${at.toISOString()}::timestamptz)`, rejectedAt: null, rejectedBy: null, vault: false };
    for (let attempt = 0; ; attempt++) {
      // Zahozené médium (withdrawn / purging / unavailable) se schválením z karty nevzkřísí (souběh se zahozením).
      // 0 řádků = médium mezitím zahozené nebo pryč → null (volající žádost zamítne, nic nerozešle).
      // Schválení + zrušení trestů (zamítnutí uživatelů, zákaz 12 h) v jedné transakci (spec 2026-09-27-gif-review-upravy §1).
      try {
        return await db.transaction(async (tx) => {
          const rows = await tx.update(gifMedia).set(attempt ? { ...set, sourceUrlNorm: null } : set)
            .where(and(eq(gifMedia.id, id), inArray(gifMedia.status, from))).returning({ id: gifMedia.id });
          if (!rows.length) return null;
          await clearMediaStrikes(tx, id);
          return id;
        });
      }
      catch (e) {
        if (!isUniqueViolation(e) || attempt) throw e;
        // Souběh dedupu (unikátní indexy pro schválené): stejný obsah už je schválený → použít ho.
        const [me] = await db.select({ channel: gifMedia.channel, sha256: gifMedia.sha256 }).from(gifMedia).where(eq(gifMedia.id, id)).limit(1);
        if (me?.channel) {
          const [other] = await db.select({ id: gifMedia.id }).from(gifMedia)
            .where(and(eq(gifMedia.channel, me.channel), eq(gifMedia.sha256, me.sha256), eq(gifMedia.status, 'approved'), ne(gifMedia.id, id))).limit(1);
          if (other) return other.id;
        }
        // Jinak kolize URL (jiný obsah na stejné URL) → URL tomuhle nenechat a zkusit znovu.
      }
    }
  },
  async mergeMedia(fromId, toId) {
    // Cíl je vždy schválené médium (souběh dedupu při schválení, obnova sloučená do schváleného) → i jeho tresty pryč.
    await db.transaction(async (tx) => { await moveMediaInto(tx, fromId, toId); await clearMediaStrikes(tx, toId); });
  },
  async setMediaRejected(id, by, at) {
    await db.update(gifMedia).set({ status: 'rejected', rejectedAt: at, rejectedBy: by }).where(and(eq(gifMedia.id, id), inArray(gifMedia.status, ['pending', 'rejected'])));
  },
  async purgeMedia(id, to, by, at, purgeAt) {
    return db.transaction(async (tx) => {
      // status_before_purge = starý stav (v UPDATE … SET se pravá strana čte z původního řádku).
      const rows = await tx.update(gifMedia).set({ status: to, statusBeforePurge: sql`${gifMedia.status}`, purgedAt: at, purgedBy: by, purgeAt })
        .where(and(eq(gifMedia.id, id), inArray(gifMedia.status, ['approved', 'rejected']))).returning({ id: gifMedia.id });
      if (!rows.length) return { ok: false, rejected: [] };
      // Čekající žádosti na médium zamítnout v téže transakci (souběžné rozhodnutí moda už pending nenajde).
      const rejected = await tx.update(gifRequests).set({ status: 'rejected', decidedBy: by, decidedAt: at })
        .where(and(eq(gifRequests.mediaId, id), eq(gifRequests.status, 'pending'))).returning();
      return { ok: true, rejected };
    });
  },
  async setRequestRejected(id, by, at) {
    const rows = await db.update(gifRequests).set({ status: 'rejected', decidedBy: by, decidedAt: at })
      .where(and(eq(gifRequests.id, id), eq(gifRequests.status, 'approved'))).returning();
    return rows[0] ?? null;
  },
  async restoreMedia(id, at, by) {
    const [me] = await db.select({ status: gifMedia.status, before: gifMedia.statusBeforePurge, channel: gifMedia.channel, sha256: gifMedia.sha256 })
      .from(gifMedia).where(eq(gifMedia.id, id)).limit(1);
    if (!me || me.status !== 'purging') return null;
    const to = me.before === 'approved' ? 'approved' as const : 'rejected' as const;
    const base = { status: to, statusBeforePurge: null, purgedAt: null, purgedBy: null, purgeAt: null };
    // Mezi zamítnuté = nové zamítnutí (retence 14 dní od obnovy); kdo zamítl: původní, jinak kdo zahodil / obnovil.
    const clear = to === 'rejected'
      ? { ...base, rejectedAt: at, rejectedBy: sql`coalesce(${gifMedia.rejectedBy}, ${gifMedia.purgedBy}, ${by})` }
      : base;
    for (let attempt = 0; ; attempt++) {
      try {
        return await db.transaction(async (tx) => {
          const rows = await tx.update(gifMedia).set(attempt ? { ...clear, sourceUrlNorm: null } : clear)
            .where(and(eq(gifMedia.id, id), eq(gifMedia.status, 'purging'))).returning({ id: gifMedia.id });
          if (!rows.length) return null;
          // Obnova do schváleného = schválení → tresty pryč (téže transakce).
          if (to === 'approved') await clearMediaStrikes(tx, id);
          return { status: to };
        });
      } catch (e) {
        if (!isUniqueViolation(e) || attempt || to !== 'approved') throw e;
        // Stejný obsah je mezitím schválený jako jiné médium → sloučit do něj (volající).
        if (me.channel) {
          const [other] = await db.select({ id: gifMedia.id }).from(gifMedia)
            .where(and(eq(gifMedia.channel, me.channel), eq(gifMedia.sha256, me.sha256), eq(gifMedia.status, 'approved'), ne(gifMedia.id, id))).limit(1);
          if (other) return { status: 'approved' as const, mergedInto: other.id };
        }
        // Jinak kolize URL (jiný obsah na stejné URL) → URL tomuhle nenechat a zkusit znovu.
      }
    }
  },
  async removeMediaFile(id) {
    // Bajty pryč (bytea NOT NULL → prázdné), hash taky; řádek zůstává (štítek „[GIF nedostupný]“, dedup podle sha256/URL).
    const rows = await db.update(gifMedia).set({ status: 'unavailable', bytes: Buffer.alloc(0), size: 0, phash: null })
      .where(and(eq(gifMedia.id, id), eq(gifMedia.status, 'withdrawn'))).returning({ id: gifMedia.id });
    return rows.length > 0;
  },
  async listDiscarded(channel, status, before, limit) {
    const rows = await db.select(mediaCols).from(gifMedia)
      .where(and(eq(gifMedia.channel, channel), eq(gifMedia.status, status),
        before ? or(lt(gifMedia.purgedAt, before.at), and(eq(gifMedia.purgedAt, before.at), lt(gifMedia.id, before.id))) : undefined))
      .orderBy(desc(gifMedia.purgedAt), desc(gifMedia.id)).limit(limit);
    return rows.map(asInfo);
  },
  async purgeDue(at) {
    // Záznam pryč (zamítnutí, zákaz, návrhy duplikátů kaskádou; žádosti media_id → NULL). Zprávy s GIFem pak
    // /chat/history pošle jako gif_removed (médium neexistuje) — byly schované už od zahození.
    const rows = await db.delete(gifMedia).where(and(eq(gifMedia.status, 'purging'), lte(gifMedia.purgeAt, at))).returning({ id: gifMedia.id });
    return rows.map((r) => r.id);
  },
  async messageKeysForMedia(mediaId, limit) {
    // Přes žádosti (index gif_requests_media_idx + unikátní platform/platform_message_id), ne JSONB scan zpráv.
    const rows = await db.select({ platform: messages.platform, id: messages.platformMessageId }).from(messages)
      .innerJoin(gifRequests, and(eq(gifRequests.mediaId, mediaId), eq(messages.platform, gifRequests.platform), eq(messages.platformMessageId, sql`'gif-' || ${gifRequests.id}::text`)))
      .where(and(isNull(messages.deletedAt), isNull(messages.hiddenAt)))
      .orderBy(desc(messages.sentAt)).limit(limit);
    return rows.map((r) => `${r.platform}:${r.id}`);
  },
  async setMediaUnapproved(id, by, at) {
    const rows = await db.update(gifMedia).set({ status: 'rejected', approvedAt: null, rejectedAt: at, rejectedBy: by, vault: false })
      .where(and(eq(gifMedia.id, id), eq(gifMedia.status, 'approved'))).returning({ id: gifMedia.id });
    return rows.length > 0;
  },
  async markMediaUsed(id, at) {
    await db.update(gifMedia).set({ useCount: sql`${gifMedia.useCount} + 1`, lastUsedAt: at }).where(eq(gifMedia.id, id));
  },
  async rejectionCount(channel, mediaId, platform, userId) {
    const rows = await db.select({ count: gifRejections.count }).from(gifRejections)
      .where(and(eq(gifRejections.channel, channel), eq(gifRejections.mediaId, mediaId), eq(gifRejections.platform, platform), eq(gifRejections.userId, userId))).limit(1);
    return rows[0]?.count ?? 0;
  },
  async hasRejections(channel, mediaId) {
    const rows = await db.select({ one: sql`1` }).from(gifRejections)
      .where(and(eq(gifRejections.channel, channel), eq(gifRejections.mediaId, mediaId))).limit(1);
    return rows.length > 0;
  },
  async addRejection(channel, mediaId, platform, userId, at) {
    const rows = await db.insert(gifRejections).values({ channel, mediaId, platform, userId, count: 1, lastAt: at })
      .onConflictDoUpdate({ target: [gifRejections.channel, gifRejections.mediaId, gifRejections.platform, gifRejections.userId], set: { count: sql`${gifRejections.count} + 1`, lastAt: at } })
      .returning({ count: gifRejections.count });
    return rows[0]?.count ?? 1;
  },
  async activeBan(channel, mediaId, at) {
    const rows = await db.select({ until: gifBans.until, by: gifBans.by }).from(gifBans)
      .where(and(eq(gifBans.channel, channel), eq(gifBans.mediaId, mediaId), gt(gifBans.until, at))).limit(1);
    return rows[0] ?? null;
  },
  async setBan(channel, mediaId, until, by) {
    await db.insert(gifBans).values({ channel, mediaId, until, by })
      .onConflictDoUpdate({ target: [gifBans.channel, gifBans.mediaId], set: { until, by } });
  },
  async pendingForMedia(mediaId, at) {
    return db.select().from(gifRequests)
      .where(and(eq(gifRequests.mediaId, mediaId), eq(gifRequests.status, 'pending'), gt(gifRequests.expiresAt, at)))
      .orderBy(asc(gifRequests.createdAt), asc(gifRequests.id)).limit(200);
  },
  async mediaReferenced(mediaId) {
    const rows = await db.select({ one: sql`1` }).from(gifRequests)
      .where(and(eq(gifRequests.mediaId, mediaId), ne(gifRequests.status, 'expired'))).limit(1);
    return rows.length > 0;
  },
  async listRejected(channel, before, limit) {
    const rows = await db.select(mediaCols).from(gifMedia)
      .where(and(eq(gifMedia.channel, channel), eq(gifMedia.status, 'rejected'),
        before ? or(lt(gifMedia.rejectedAt, before.at), and(eq(gifMedia.rejectedAt, before.at), lt(gifMedia.id, before.id))) : undefined))
      .orderBy(desc(gifMedia.rejectedAt), desc(gifMedia.id)).limit(limit);
    return rows.map(asInfo);
  },
  async setVault(id, vault) { await db.update(gifMedia).set({ vault }).where(eq(gifMedia.id, id)); },
  async retentionDue(before, at) {
    const rows = await db.delete(gifMedia)
      .where(and(eq(gifMedia.status, 'rejected'), eq(gifMedia.vault, false), lt(gifMedia.rejectedAt, before), sql`not ${exists(livePendingFor(at))}`))
      .returning({ id: gifMedia.id });
    // Propadlé zákazy pryč (jen úklid; activeBan je stejně ignoruje).
    await db.delete(gifBans).where(lte(gifBans.until, at));
    return rows.map((r) => r.id);
  },
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
      .where(and(eq(gifRequests.status, 'pending'), gt(gifRequests.expiresAt, at),
        sql`(${gifRequests.meta}->>'auto') is null`, sql`(${gifRequests.meta}->>'instant') is null`,
        channel !== undefined ? eq(gifRequests.channel, channel) : undefined))
      .orderBy(asc(gifRequests.createdAt), asc(gifRequests.id))
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
  async unpublishedApproved(before, after, limit) {
    // Syntetická zpráva schválené žádosti: unikátní (platform, platform_message_id) → korelovaný EXISTS je levný.
    const msgExists = exists(db.select({ one: sql`1` }).from(messages)
      .where(and(eq(messages.platform, gifRequests.platform), eq(messages.platformMessageId, sql`'gif-' || ${gifRequests.id}::text`))));
    const rows = await db.select({ request: gifRequests, mediaStatus: gifMedia.status, hasMessage: sql<boolean>`${msgExists}` })
      .from(gifRequests).leftJoin(gifMedia, eq(gifMedia.id, gifRequests.mediaId))
      .where(and(eq(gifRequests.status, 'approved'), lt(gifRequests.decidedAt, before), gt(gifRequests.decidedAt, after),
        or(sql`not ${msgExists}`, eq(gifMedia.status, 'pending'))))
      .orderBy(asc(gifRequests.id)).limit(limit);
    return rows.map((r) => ({ request: r.request, mediaStatus: r.mediaStatus ?? null, hasMessage: !!r.hasMessage }));
  },
  async retagDeleted(platform, messageId, from, to) {
    const rows = await db.update(messages).set({ deletedReason: to })
      .where(and(eq(messages.platform, platform), eq(messages.platformMessageId, messageId), eq(messages.deletedReason, from)))
      .returning({ id: messages.id });
    return rows.length > 0;
  },
  async statusByMessages(keys) {
    const out = new Map<string, GifStatus>();
    if (!keys.length) return out;
    const want = new Set(keys.map((k) => `${k.platform}:${k.messageId}`));
    const rows = await db.select({ id: gifRequests.id, platform: gifRequests.platform, messageId: gifRequests.messageId, status: gifRequests.status }).from(gifRequests)
      .where(and(inArray(gifRequests.platform, [...new Set(keys.map((k) => k.platform))]), inArray(gifRequests.messageId, [...new Set(keys.map((k) => k.messageId))])))
      .orderBy(asc(gifRequests.id));
    // Vzestupně podle id → poslední žádost ke zprávě přepíše starší.
    for (const r of rows) { const k = `${r.platform}:${r.messageId}`; if (want.has(k)) out.set(k, r.status as GifStatus); }
    return out;
  },
};

/** Účet UnityChatu odesílatele (propojená identita, ne odhlášená); null = nemá. */
export async function senderAccount(platform: Platform, userId: string): Promise<number | null> {
  const rows = await db.select({ accountId: webIdentities.accountId }).from(webIdentities)
    .where(and(eq(webIdentities.platform, platform), eq(webIdentities.platformUserId, userId), isNull(webIdentities.signedOutAt))).limit(1);
  return rows[0]?.accountId ?? null;
}

/**
 * Stav média pro GET /media/gif/:id (bez `unavailable` — soubor pryč → null). Zamítnuté jen s tokenem i s čekající
 * novou žádostí (audit SEC-1: jinak by šel zamítnutý GIF znovu zveřejnit vlastním odkazem); withdrawn veřejně jako
 * schválené, purging jen s tokenem (náhled v „Ke smazání“).
 */
export function servableStatus(status: string): Exclude<GifMediaStatus, 'unavailable'> | null {
  switch (status) {
    case 'approved': case 'withdrawn': case 'purging': case 'rejected': return status;
    case 'unavailable': return null;
    default: return 'pending';
  }
}

/**
 * Metadata média pro GET /media/gif/:id BEZ bajtů (audit SEC-2): stav a kanál se ověří (token) dřív, než se z DB
 * načte až 10 MB bytea. Soubor pryč (unavailable / prázdné bajty) → null.
 */
export async function servableMeta(id: string): Promise<{ contentType: string; status: Exclude<GifMediaStatus, 'unavailable'>; channel: string | null } | null> {
  const rows = await db.select({ contentType: gifMedia.contentType, status: gifMedia.status, channel: gifMedia.channel, size: gifMedia.size })
    .from(gifMedia).where(eq(gifMedia.id, id)).limit(1);
  const r = rows[0];
  const st = r ? servableStatus(r.status) : null;
  if (!r || !st || !(r.size > 0)) return null;
  return { contentType: r.contentType, status: st, channel: r.channel };
}

/** Médium pro GET /media/gif/:id: stav média (+ kanál kvůli tokenu). Volá se až po ověření přes servableMeta. */
export async function servableMedia(id: string): Promise<{ bytes: Buffer; contentType: string; status: Exclude<GifMediaStatus, 'unavailable'>; channel: string | null } | null> {
  const rows = await db.select({ bytes: gifMedia.bytes, contentType: gifMedia.contentType, status: gifMedia.status, channel: gifMedia.channel })
    .from(gifMedia).where(eq(gifMedia.id, id)).limit(1);
  const r = rows[0];
  if (!r) return null;
  const st = servableStatus(r.status);
  if (!st || !r.bytes?.length) return null;
  return { bytes: r.bytes, contentType: r.contentType, status: st, channel: r.channel };
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
 * Odesílatel nevidí, KDO o jeho GIFu rozhodl: bez `by` (gif-decided) a u dříve zamítnutého jen ⚠ „byl už dříve
 * zamítnut" (`previouslyRejected` bez `by`). Mody dostávají `by` dál.
 */
export const forSender = (data: object): object => {
  const { by: _by, ...d } = data as Record<string, unknown>;
  const pr = d.previouslyRejected as PreviouslyRejected | undefined;
  return pr ? { ...d, previouslyRejected: { at: pr.at } } : d;
};

/** Jedna zpráva gif-queue: stav fronty kanálu (FIFO). */
export const queueEvent = (channel: string, rows: GifRequest[]) => ({ channel, pendingCount: rows.length, headId: rows[0]?.id ?? null });

/**
 * `/nicknames/stream` je veřejný (a s replay bufferem), čekající GIF tam nesmí. Proto události `gif-pending`,
 * `gif-decided`, `gif-queue`, `gif-progress` a `gif-notice` jdou jen spojením /account/stream účtů, které jsou
 * mody kanálu (accountModIdentities, cache 60 s) nebo odesílatelem (má `own: true`).
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
      if (sender !== null) { deps.send(sender, event, { ...forSender(data), own: true }); out.push(sender); }
      for (const acc of deps.connected()) {
        if (acc === sender) continue;
        if (await isMod(acc, r.channel)) { deps.send(acc, event, data); out.push(acc); }
      }
      return out;
    },
    /** Jen modům kanálu (gif-queue). */
    async notifyMods(channel: string, event: string, data: object): Promise<number[]> {
      const out: number[] = [];
      for (const acc of deps.connected()) if (await isMod(acc, channel)) { deps.send(acc, event, data); out.push(acc); }
      return out;
    },
    /** Kanál k odesílateli (gif-progress, gif-notice); null = nemá účet UnityChatu. */
    async toSender(platform: Platform, userId: string): Promise<((event: string, data: object) => void) | null> {
      let acc: number | null = null;
      try { acc = await deps.senderAccount(platform, userId); } catch { acc = null; }
      if (acc === null) return null;
      const a = acc;
      return (event, data) => { deps.send(a, event, data); };
    },
    /** Čekající žádosti, které účet smí vidět (po připojení /account/stream). */
    async visibleTo(accountId: number, rows: GifRequest[]): Promise<Array<GifPendingView & { own?: true }>> {
      const out: Array<GifPendingView & { own?: true }> = [];
      for (const r of rows) {
        let own = false;
        try { own = (await deps.senderAccount(r.platform as Platform, r.userId)) === accountId; } catch { own = false; }
        if (own) out.push({ ...(forSender(pendingView(r)) as GifPendingView), own: true });
        else if (await isMod(accountId, r.channel)) out.push(pendingView(r));
      }
      return out;
    },
    /** Stav front kanálů, kde je účet mod (po připojení /account/stream); `rows` = listPending (FIFO). */
    async queuesFor(accountId: number, rows: GifRequest[]): Promise<Array<ReturnType<typeof queueEvent>>> {
      const by = new Map<string, GifRequest[]>();
      for (const r of rows) { const l = by.get(r.channel) ?? []; l.push(r); by.set(r.channel, l); }
      const out: Array<ReturnType<typeof queueEvent>> = [];
      for (const [ch, list] of by) if (await isMod(accountId, ch)) out.push(queueEvent(ch, list));
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Tok žádostí
// ---------------------------------------------------------------------------

/** Událost pro integrační stream Židolišty (sse/integrationStream.ts GifIntegrationEvent). */
export type GifIntegration =
  | { type: 'gif.pending'; workspace: string; requestId: number; platform: string; userId: string; login: string; messageId: string; text: string; media: GifPendingView['media']; expiresAt: string; previouslyRejected?: PreviouslyRejected }
  | { type: 'gif.decided'; workspace: string; requestId: number; platform: string; userId: string; login: string; status: GifStatus; by: string | null };

export interface GifFlowDeps {
  store: GifStore;
  /** `noUnlock`: bez fallbacku přes Bright Data (režim approved — neznámý GIF nesmí stát kredit). */
  resolve: (src: GifSource, hooks?: { onProgress?: (e: GifFetchProgress) => void; noUnlock?: boolean }) => Promise<ResolvedGif>;
  access: (q: GifAccessQuery) => Promise<GifAccess | null>;
  used: (p: { workspace: string; platform: Platform; userId: string }) => Promise<unknown>;
  /** publishDeleted (SSE message-deleted + chat.deleted). */
  publishDeleted: (p: { channel: string; platform: Platform; messageId: string; by: string; reason: 'gif_request' | 'gif_rejected' | 'gif_not_allowed' }) => Promise<void>;
  /** deletePlatformMessage botem workspace (accountId null). */
  deletePlatform: (p: { accountId: null; channel: string; platform: Platform; messageId: string }) => Promise<string>;
  /**
   * Převod selhal a filtr by zprávu pustil → obnovit v UC (publishRestored pro deleted_reason gif_request).
   * 'ok' = řádek obnoven a message-restored odešlo; cokoli jiného (not_found = řádek ještě není v archivu) →
   * flow pošle message-restored sám ze zprávy (settleHeld).
   */
  restore: (p: { channel: string; platform: Platform; messageId: string; userId: string; platformChannel: string }) => Promise<string>;
  /** Zapomenout dedup smazání (messageDeletes forgetPublished) — jinak by message-deleted link_filter do 60 s po gif_request spolklo. */
  forgetDeleted?: (platform: Platform, messageId: string) => void;
  broadcast: (event: string, data: object) => void;
  publishChat: (platformChannel: string, platform: string, msg: ClientMessage) => void;
  notify: (r: GifRequest, event: string, data: object) => Promise<unknown>;
  /** Jen modům kanálu (gif-queue); chybí = neposílá se. */
  notifyMods?: (channel: string, event: string, data: object) => Promise<unknown>;
  /** Kanál k odesílateli (gif-progress, gif-notice); chybí / null = neposílá se. */
  toSender?: (platform: Platform, userId: string) => Promise<((event: string, data: object) => void) | null>;
  integration: (ev: GifIntegration) => void | Promise<unknown>;
  recordAction?: (v: { channel: string; accountId: number | null; actor: string; action: string; platform: string; targetLogin: string | null; targetMessageId?: string | null; params: object; result: object }) => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /**
   * Okamžité schválení (auto modem / GIF z knihovny) si synchronně vezme slot globálního cooldownu chatu
   * (gifAccess.ts claimGifSlot, audit SEC-8); false = cooldown běží, GIF teď neprojde. Chybí = bez kontroly.
   */
  claim?: (workspace: string) => boolean;
  /** Médium smazané z DB (propadnutí, trvalé zahození, retence) → pryč i z paměťové cache /media/gif (tombstone). */
  mediaDeleted?: (id: string) => void;
  /** Stav média se změnil (zamítnuto, vault, schváleno ze zamítnutých) → cache /media/gif zahodit (bez tombstone). */
  mediaChanged?: (id: string) => void;
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
   * Mod / broadcaster (badge zprávy) s odemčenou odměnou: GIF se schválí rovnou (`by` = on sám), bez karty ke
   * schválení. Přístup (needAccess), cooldown (gif-used) i režim odměny `approved` platí stejně jako pro diváka.
   */
  auto?: boolean;
  /**
   * Klient nahlásil „schvalovat jako divák" (Dev mód, lib/ucSends.ts gifReviews) až po echu zprávy
   * (/chat/uc-sent). Ověří se po stažení média; true → z auto se stane běžná žádost.
   */
  lateReview?: () => boolean;
}

/** Akce moda / Židolišty nad médiem (routes/gif.ts, routes/integrationGif.ts). */
export const GIF_MEDIA_ACTIONS = ['approve', 'vault', 'purge', 'ban12h', 'unapprove', 'restore', 'remove-file'] as const;
export type GifMediaAction = typeof GIF_MEDIA_ACTIONS[number];

export type GifInterceptResult ='requested' | 'approved' | 'denied' | 'failed' | 'cancelled' | 'rejected' | 'not_allowed';

/**
 * Čekání na zápis původní zprávy do archivu (ingest dávkuje po 500 ms): přeznačení/obnovení v DB musí
 * najít řádek. Běží souběžně se stahováním média, zdržení je jen u rychlých chyb.
 */
export const FLUSH_WAIT_MS = 1500;

/**
 * Druhý pokus o dorovnání archivu po rozhodnutí o schované zprávě (zápis dávky mohl běžet souběžně
 * s prvním pokusem — toRow už zprávu převedl i se smazáním gif_request).
 */
export const SETTLE_RETRY_MS = 5000;

/** Dorovnání schválených žádostí bez zprávy (audit A1): řeší se až po této době od rozhodnutí (souběh s decide). */
export const RECONCILE_GRACE_MS = 60_000;
/** … a nejvýš takhle staré (starší schválené bez zprávy už nikdo nečeká). */
export const RECONCILE_WINDOW_MS = 7 * 86_400_000;
/** Po tolika neúspěšných pokusech o dopsání se žádost zamítne (původní zpráva nesmí zůstat navždy schovaná). */
export const RECONCILE_MAX_ATTEMPTS = 10;
const RECONCILE_BATCH = 50;

/** Bez známé velikosti: průběh stahování 10–50 % jako 1 − e^(−bajty / 2 MB). */
const UNKNOWN_SIZE_SCALE = 2 * 1024 * 1024;

/** Host odkazu do logu (bez cesty a query). */
const safeHost = (u: unknown): string => { try { return new URL(String(u)).hostname; } catch { return '?'; } };

export function createGifFlow(deps: GifFlowDeps) {
  const busy = new Set<string>();
  // Původní zprávy právě v interceptu (`platform:messageId`) — GET /gif/held je hlásí jako „čeká".
  const inflight = new Set<string>();
  // Dorovnání archivu na pozadí (testy na ně čekají přes _idle).
  const background = new Set<Promise<unknown>>();
  const later = (fn: () => Promise<unknown>) => {
    const p = Promise.resolve().then(() => deps.sleep(SETTLE_RETRY_MS)).then(fn).catch(() => {});
    background.add(p);
    void p.finally(() => background.delete(p));
  };
  const pending = new Map<string, number>();
  // Žádosti už rozhodnuté/propadlé (v tomto procesu): zámek uživatele se nesmí nastavit zpětně, když mod
  // rozhodl dřív, než intercept došel k pending.set (GET /moderation/gif/pending žádost ukáže hned po insertu).
  const closed = new Set<number>();
  const userKey = (channel: string, platform: string, userId: string) => `${channel}|${platform}|${userId}`;
  // Neúspěšné pokusy dorovnání per žádost (audit A1).
  const reconcileFails = new Map<number, number>();
  const safe = async (what: string, fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) { deps.log.warn({ err: (e as Error).message }, `gif: ${what} selhalo`); }
  };

  /** gif-queue modům kanálu (FIFO: počet + id nejstarší čekající). */
  const emitQueue = async (channel: string) => {
    if (!deps.notifyMods) return;
    await safe('gif-queue', async () => {
      const rows = await deps.store.listPending(new Date(deps.now()), channel);
      await deps.notifyMods!(channel, 'gif-queue', queueEvent(channel, rows));
    });
  };

  /**
   * Změnila se viditelnost zpráv se schváleným GIFem (routes/chat.ts gifMessageState) → SSE `gif-media` na veřejný
   * /nicknames/stream: { channel, mediaId, state: visible | removed | unavailable, messages? }. Otevření klienti
   * překreslí zprávy s GIFem (removed = „Zpráva smazána“, unavailable = štítek); `visible` nese zprávy s obsahem
   * (klient je má jen jako smazané bez obsahu), bez zpráv se neposílá. Jen veřejné údaje (stav pro zprávy, ne
   * interní stav média ani kdo zahodil). `effective` = médium, na které zprávy teď ukazují (sloučení).
   */
  const announceMedia = async (channel: string, mediaId: string, before: string, after: string, effective = mediaId) => {
    const state = gifMessageState(after);
    await safe('gif-media', async () => {
      // Viditelnost zpráv beze změny (approved→withdrawn, rejected→purging, purging→rejected…) → jen lehký signál
      // pro otevřené panely GIFů (knihovna / zamítnuté / zahozené se načtou znovu).
      if (gifMessageState(before) === state) { deps.broadcast('gif-media', { channel, mediaId, state: 'library' }); return; }
      if (state === 'visible') {
        // Jen klíče zpráv (max 200) — obsah si klient dotáhne přes GET /chat/messages (payload SSE + replay buffer).
        const messageIds = await deps.store.messageKeysForMedia(effective, GIF_MEDIA_EVENT_MESSAGES);
        deps.broadcast('gif-media', { channel, mediaId, state, messageIds });
        return;
      }
      deps.broadcast('gif-media', { channel, mediaId, state });
    });
  };

  /**
   * Schválení žádosti na médium, které mezitím přestalo jít schválit: trvale zahozené (souběh s „Trvale zahodit“,
   * `purged`) nebo — u GIFu z knihovny — odebrané z knihovny (souběh s „Odebrat z knihovny“, `unapproved`, audit A2):
   * žádost → rejected, žádná zpráva ani gif-message, médium beze změny (akce moda platí), strike se nepočítá;
   * odesílatel dostane gif-notice auto_rejected + zamítnuto. `instant` (zachycení v ingestu): původní zprávu
   * a hlášku vyřídí intercept (dropOriginal).
   */
  const rejectGone = async (r: GifRequest, p: { by: string; accountId: number | null; auto?: boolean; quiet?: boolean; instant?: boolean }, at: Date, reason: 'purged' | 'unapproved'): Promise<{ status: number; body: Record<string, unknown> }> => {
    await safe('zamítnutí žádosti na neschvalitelné médium', () => deps.store.setRequestRejected(r.id, p.by, at));
    r.status = 'rejected';
    deps.log.info({ requestId: r.id, channel: r.channel, reason }, 'gif: schválení žádosti na zahozené / odebrané médium → zamítnuto');
    if (!p.instant && deps.toSender) {
      await safe('gif-notice purged', async () => {
        const tell = await deps.toSender!(r.platform as Platform, r.userId);
        tell?.('gif-notice', { requestKey: `${r.platform}:${r.messageId}`, channel: r.channel, platform: r.platform, messageId: r.messageId, kind: 'auto_rejected', reason });
      });
    }
    await decided(r, 'rejected', p.by, { quiet: p.quiet ?? p.auto, keepOriginal: p.instant });
    await safe('moderation_actions', async () => deps.recordAction?.({ channel: r.channel, accountId: p.accountId, actor: p.by, action: 'gif_reject', platform: r.platform, targetLogin: r.login, targetMessageId: r.messageId, params: { requestId: r.id, reason }, result: { status: 'rejected' } }));
    return { status: 200, body: { ok: true, requestId: r.id, status: 'rejected', reason } };
  };

  const decided = async (r: GifRequest, status: GifStatus, by: string | null, opts: { quiet?: boolean; keepOriginal?: boolean } = {}) => {
    closed.add(r.id);
    if (closed.size > 2000) closed.delete(closed.values().next().value!);
    const k = userKey(r.channel, r.platform, r.userId);
    if (pending.get(k) === r.id) pending.delete(k);
    // Zamítnuto / propadlo: původní zpráva (v UC dosud nevykreslená, gif_request) → běžně smazaná.
    if ((status === 'rejected' || status === 'expired') && !opts.keepOriginal) await rejectOriginal(r);
    // Auto-schválení modem / z knihovny: nikdo žádost neviděl (gif-pending ani gif.pending nešlo) → ani rozhodnutí neohlašovat.
    if (opts.quiet) return;
    const ev = { requestId: r.id, channel: r.channel, approved: status === 'approved', status, by };
    await safe('gif-decided', () => deps.notify(r, 'gif-decided', ev));
    await safe('integrace gif.decided', async () => deps.integration({ type: 'gif.decided', workspace: r.workspace, requestId: r.id, platform: r.platform, userId: r.userId, login: r.login, status, by }));
    await emitQueue(r.channel);
  };

  /**
   * Původní zpráva: gif_request → gif_rejected v archivu + SSE message-deleted (klienti ji ukážou jako smazanou).
   * `/nicknames/stream` je veřejný (i replay) → bez `by`: odesílatel nesmí vidět, KDO o jeho GIFu rozhodl (audit SEC-4);
   * mod je v gif-decided modům a v moderation_actions.
   */
  const rejectOriginal = async (r: GifRequest) => {
    await safe('přeznačení původní zprávy na gif_rejected', () => deps.store.retagDeleted(r.platform as Platform, r.messageId, 'gif_request', GIF_REJECTED_REASON));
    await safe('message-deleted gif_rejected', async () => deps.broadcast('message-deleted', { channel: r.channel, platform: r.platform, messageId: r.messageId, by: null, reason: GIF_REJECTED_REASON, at: deps.now() }));
  };

  /**
   * Zpráva s odkazem nesmí projít (automatické zamítnutí, režim „jen schválené"): v UC smazaná s `reason`
   * (schovaná gif_request / přeznačená z link_filter → přeznačit + message-deleted; zobrazená → publishDeleted),
   * na platformě botem (když ji nesmazal už filtr).
   */
  const dropOriginal = async (p: GifInterceptParams, reason: typeof GIF_REJECTED_REASON | typeof GIF_NOT_ALLOWED_REASON) => {
    const { m } = p;
    const pl = m.platform, id = m.platformMessageId;
    if (p.preDeleted === null) {
      await safe('publishDeleted', () => deps.publishDeleted({ channel: p.ucChannel, platform: pl, messageId: id, by: 'filter', reason }));
    } else {
      // Nezapsaná dávka ingestu se zapíše rovnou s novým důvodem; zapsaný řádek se přeznačí (a po chvíli znovu).
      m.deleted = { by: 'filter', reason };
      await safe(`přeznačení na ${reason}`, () => deps.store.retagDeleted(pl, id, 'gif_request', reason));
      deps.forgetDeleted?.(pl, id);
      await safe(`message-deleted ${reason}`, async () => deps.broadcast('message-deleted', { channel: p.ucChannel, platform: pl, messageId: id, by: 'filter', reason, at: deps.now() }));
      later(() => deps.store.retagDeleted(pl, id, 'gif_request', reason));
    }
    if (p.preDeleted !== 'link_filter') {
      let result = 'error:exception';
      try { result = await deps.deletePlatform({ accountId: null, channel: p.ucChannel, platform: pl, messageId: id }); }
      catch (e) { deps.log.warn({ err: (e as Error).message }, 'gif: smazání zprávy na platformě vyhodilo výjimku'); }
      deps.log.info({ channel: p.ucChannel, platform: pl, reason, result }, 'gif: zpráva s odkazem smazána');
    }
  };

  /**
   * Převod selhal (nebo zachycení spadlo) a původní zpráva je v UC schovaná jako gif_request → klienti VŽDY
   * dostanou rozhodnutí, nezávisle na tom, jestli už je řádek v archivu (ingest dávkuje po 500 ms):
   *  - filtr by ji smazal → link_filter: v paměti (nezapsaná dávka se zapíše už takhle), v archivu přeznačit,
   *    zapomenout dedup smazání (gif_request před chvílí by message-deleted link_filter spolkl) a akce filtru;
   *  - jinak obnovit: smazání pryč z paměti, publishRestored; bez řádku / při chybě DB → message-restored
   *    s celou zprávou z `m` i tak.
   * Archiv se po SETTLE_RETRY_MS dorovná ještě jednou (zápis dávky mohl běžet souběžně).
   */
  const settleHeld = async (p: GifInterceptParams) => {
    const { m } = p;
    const pl = m.platform, id = m.platformMessageId;
    if (p.filterAct) {
      m.deleted = { by: 'filter', reason: 'link_filter' };
      await safe('přeznačení na link_filter', () => deps.store.retagDeleted(pl, id, 'gif_request', 'link_filter'));
      deps.forgetDeleted?.(pl, id);
      await safe('filtr odkazů', () => p.filterAct!());
      later(() => deps.store.retagDeleted(pl, id, 'gif_request', 'link_filter'));
      return;
    }
    if (m.deleted?.reason === 'gif_request') delete m.deleted;
    const rp = { channel: p.ucChannel, platform: pl, messageId: id, userId: m.platformUserId, platformChannel: m.channel };
    let res = 'error:exception';
    try { res = await deps.restore(rp); }
    catch (e) { deps.log.warn({ err: (e as Error).message }, 'gif: obnovení zprávy selhalo'); }
    if (res !== 'ok') {
      deps.log.info({ channel: p.ucChannel, platform: pl, result: res }, 'gif: řádek k obnovení v archivu není → message-restored ze zprávy');
      deps.forgetDeleted?.(pl, id);
      await safe('message-restored ze zprávy', async () => deps.broadcast('message-restored', {
        channel: p.ucChannel, platform: pl, messageId: id, by: 'filter', at: deps.now(), message: toClientMessage(toRow(m), true),
      }));
      // Řádek se mohl zapsat se smazáním gif_request (dávka běžela souběžně) → zkusit znovu (další message-restored neškodí).
      later(() => deps.restore(rp));
    }
  };

  /**
   * Rozhodnutí (mod přes routu, auto-schválení modova GIFu, okamžité schválení z knihovny). První vyhrává:
   * podmíněný UPDATE; pozdější → 409 { status, decidedBy }.
   * `auto`: schválení modem samým (bez karty). `quiet`: bez gif-decided / gif.decided (žádost nikdo neviděl).
   * `cascade`: schválení z jiné žádosti na stejné médium (sama už dál nekaskáduje).
   */
  const decideCore = async (p: { requestId: number; approve: boolean; by: string; accountId: number | null; auto?: boolean; quiet?: boolean; cascade?: boolean; instant?: boolean }): Promise<{ status: number; body: Record<string, unknown> }> => {
    const at = new Date(deps.now());
    const r = await deps.store.decide(p.requestId, p.approve ? 'approved' : 'rejected', p.by, at);
    if (!r) {
      const cur = await deps.store.get(p.requestId);
      if (!cur) return { status: 404, body: { ok: false, error: 'not_found' } };
      return { status: 409, body: { ok: false, error: 'already_decided', status: cur.status === 'pending' ? 'expired' : cur.status, decidedBy: cur.decidedBy ?? null } };
    }
    const status: GifStatus = p.approve ? 'approved' : 'rejected';
    let published = true;
    // Médium do knihovny (approved = veřejné) PŘED čímkoli dalším: zahozené mezitím (souběh s Trvale zahodit) →
    // žádost zamítnout jako zahozený dedup, žádná zpráva, žádný gif-message ani cooldown.
    let effective: string | null | undefined = r.mediaId ?? undefined;
    if (p.approve && r.mediaId) {
      // GIF z knihovny (instant, ne mod): médium musí být pořád schválené — odebrané z knihovny mezitím se nevzkřísí (A2).
      const library = !!p.instant && !p.auto;
      try { effective = await deps.store.setMediaApproved(r.mediaId, at, library ? { onlyApproved: true } : undefined); }
      catch (e) { deps.log.warn({ err: (e as Error).message }, 'gif: schválení média selhalo'); effective = undefined; }
      if (effective === null) {
        const cur = library ? await deps.store.getMedia(r.mediaId).catch(() => null) : null;
        return rejectGone(r, p, at, cur && !GIF_DISCARDED.has(cur.status) ? 'unapproved' : 'purged');
      }
    }
    if (p.approve) {
      // Cooldown hned (gifUsed ho nastaví lokálně synchronně, před voláním Židolišty), ne až po rozeslání.
      // Platí i pro auto (mod / broadcaster se schvaluje sám, ale cooldown má jako ostatní — spec 2026-09-27 §5).
      const usedP = Promise.resolve().then(() => deps.used({ workspace: r.workspace, platform: r.platform as Platform, userId: r.userId }))
        .catch((e) => deps.log.warn({ err: (e as Error).message }, 'gif: gif-used selhalo'));
      // Počítadlo použití; souběh dedupu (stejný obsah schválený jako jiné médium) → sloučit.
      if (r.mediaId && effective) {
        await safe('schválení média', async () => {
          if (effective !== r.mediaId) {
            // Souběh dedupu: stejný obsah už je schválený jako jiné médium → žádosti (i ostatní) na něj, duplikát pryč.
            const dup = r.mediaId!;
            await deps.store.mergeMedia(dup, effective!);
            deps.mediaDeleted?.(dup);
            r.mediaId = effective!;
            deps.log.info({ requestId: r.id }, 'gif: duplikát schváleného média (souběh) → sloučeno');
          }
          await deps.store.markMediaUsed(r.mediaId!, at);
          deps.mediaChanged?.(r.mediaId!);
        });
      }
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
        // Žádost zůstává schválená, původní zpráva schovaná (/gif/held: replaced) — zprávu dopíše reconcileTick
        // (audit A1); když se to nepodaří ani po RECONCILE_MAX_ATTEMPTS pokusech, žádost zamítne.
        deps.log.warn({ requestId: r.id, channel: r.channel }, 'gif: schválený GIF se nezapsal do archivu → nerozeslán, dopíše ho dorovnání');
      }
      await usedP;
    } else if (r.mediaId) {
      // Zamítnuté médium zůstává (retence 14 dní, vault, token pro mody) — dedup ho pozná a počítá pokusy.
      await safe('zamítnutí média', async () => {
        await deps.store.setMediaRejected(r.mediaId!, p.by, at);
        await deps.store.addRejection(r.channel, r.mediaId!, r.platform, r.userId, at);
        deps.mediaChanged?.(r.mediaId!);
      });
    }
    await decided(r, status, p.by, { quiet: p.quiet ?? p.auto });
    await safe('moderation_actions', async () => deps.recordAction?.({ channel: r.channel, accountId: p.accountId, actor: p.by, action: p.approve ? 'gif_approve' : 'gif_reject', platform: r.platform, targetLogin: r.login, targetMessageId: r.messageId, params: { requestId: r.id, ...(p.auto ? { auto: true } : {}), ...(p.cascade ? { cascade: true } : {}) }, result: { status } }));
    // Schválený GIF = bez nového schvalování: ostatní čekající žádosti na stejné médium se schválí taky.
    if (p.approve && !p.cascade && r.mediaId) {
      let others: GifRequest[] = [];
      try { others = (await deps.store.pendingForMedia(r.mediaId, at)).filter((o) => o.id !== r.id); } catch { others = []; }
      for (const o of others) await decideCore({ requestId: o.id, approve: true, by: p.by, accountId: p.accountId, cascade: true });
    }
    return { status: 200, body: { ok: true, requestId: r.id, status, ...(published ? {} : { published: false }) } };
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
    async intercept(p: GifInterceptParams): Promise<GifInterceptResult> {
      const { m } = p;
      let auto = !!p.auto;
      const k = userKey(p.ucChannel, m.platform, m.platformUserId);
      const mk = `${m.platform}:${m.platformMessageId}`;
      busy.add(k);
      inflight.add(mk);
      // Žádost vznikla (o původní zprávě pak rozhoduje mod / propadnutí) / o schované zprávě už je rozhodnuto.
      let created: GifRequest | null = null;
      let settled = false;
      // Průběh a hlášky jen odesílateli (má-li účet UnityChatu).
      let tell: ((event: string, data: object) => void) | null = null;
      const base = { requestKey: mk, channel: p.ucChannel, platform: m.platform, messageId: m.platformMessageId };
      let lastPct = -1;
      const progress = (phase: string, pct: number, extra: object = {}) => {
        if (!tell) return;
        lastPct = Math.max(lastPct, pct);
        try { tell('gif-progress', { ...base, phase, pct, ...extra }); } catch { /* ignore */ }
      };
      const done = (outcome: GifInterceptResult) => { if (tell) progress('done', 100, { outcome: outcome === 'requested' ? 'pending' : outcome }); };
      const notice = (kind: string, extra: object = {}) => { if (tell) { try { tell('gif-notice', { ...base, kind, ...extra }); } catch { /* ignore */ } } };
      const finish = (outcome: GifInterceptResult): GifInterceptResult => { done(outcome); return outcome; };
      try {
        // Addon čte Twitch IRC napřímo → původní zprávu schovat hned, ne až po stažení média.
        if (p.preDeleted === 'gif_request') await safe('publishDeleted', () => deps.publishDeleted({ channel: p.ucChannel, platform: m.platform, messageId: m.platformMessageId, by: 'filter', reason: 'gif_request' }));
        if (deps.toSender) tell = await deps.toSender(m.platform, m.platformUserId).catch(() => null);
        progress('detect', 0);
        // Přístup (cache 60 s): odemčení a cooldown (i mod — spec 2026-09-27-gif-review-upravy §5), requestTtlSec a režim odměny.
        const access = await deps.access(p.query).catch(() => null);
        if (p.needAccess && !gifUsable(access, deps.now())) return finish('denied');
        const mode = access?.mode ?? 'all';
        progress('access', 10);

        // Známé médium bez stahování: náš odkaz podle id, jinak normalizovaná URL; pak stažení + sha256.
        const urlNorm = p.candidate.mode === 'own' ? null : normalizeSourceUrl(p.candidate.url);
        const obtain = async (): Promise<{ ok: true; known: GifMediaInfo | null; fresh: ResolvedGif | null; sha256: string } | { ok: false; code: string }> => {
          if (p.candidate.mode === 'own') {
            const own = p.candidate.mediaId ? await deps.store.getMedia(p.candidate.mediaId) : null;
            return own && own.channel === p.ucChannel ? { ok: true, known: own, fresh: null, sha256: own.sha256 } : { ok: false, code: 'own_unknown' };
          }
          const byUrl = urlNorm ? await deps.store.findMedia(p.ucChannel, { url: urlNorm }) : null;
          if (byUrl) return { ok: true, known: byUrl, fresh: null, sha256: byUrl.sha256 };
          let v: ResolvedGif;
          try {
            v = await deps.resolve(p.candidate, { noUnlock: mode === 'approved', onProgress: (e) => {
              if (e.phase === 'unlock') { progress('unlock', 50, { estimateMs: e.estimateMs, elapsedMs: e.elapsedMs }); return; }
              const frac = e.total ? e.loaded / e.total : 1 - Math.exp(-e.loaded / UNKNOWN_SIZE_SCALE);
              const pct = Math.min(50, 10 + Math.floor(40 * Math.max(0, Math.min(1, frac))));
              if (pct > lastPct && (pct >= lastPct + 5 || pct === 50)) progress('download', pct);
            } });
          } catch (e) { return { ok: false, code: e instanceof GifError ? e.code : 'exception' }; }
          const sha256 = createHash('sha256').update(v.bytes).digest('hex');
          const bySha = await deps.store.findMedia(p.ucChannel, { sha256 });
          return bySha ? { ok: true, known: bySha, fresh: null, sha256 } : { ok: true, known: null, fresh: v, sha256 };
        };
        const [res] = await Promise.all([
          obtain().catch((e) => ({ ok: false as const, code: e instanceof GifError ? e.code : 'exception' })),
          deps.sleep(FLUSH_WAIT_MS),
        ]);
        if (res.ok) progress('verify', 95);
        // Mod z UnityChatu v Dev módu (hlášení došlo po echu) → schvalování jako divák.
        if (auto && p.lateReview?.()) {
          auto = false;
          deps.log.info({ channel: p.ucChannel, platform: m.platform }, 'gif: mod v Dev módu → žádost ke schválení (pozdní hlášení)');
        }
        if (res.ok && p.preDeleted === 'link_filter') {
          // Zprávu smazal filtr; mezitím ji mohl obnovit permit (deleted_reason zrušen) → žádost nevytvářet.
          let retagged = false;
          try { retagged = await deps.store.retagDeleted(m.platform, m.platformMessageId, 'link_filter', 'gif_request'); }
          catch (e) { deps.log.warn({ err: (e as Error).message }, 'gif: přeznačení na gif_request selhalo'); }
          if (!retagged) {
            deps.log.info({ channel: p.ucChannel, platform: m.platform }, 'gif: původní zpráva už není smazaná filtrem (permit) → bez žádosti');
            return finish('cancelled');
          }
        }

        let instant = false;
        // Globální cooldown chatu běží (okamžité schválení by GIF pustilo hned, audit SEC-8) → jako neodemčeno.
        let blocked = false;
        if (res.ok) {
          const known = res.known;
          const approvedKnown = known?.status === 'approved';
          // Režim „jen schválené": nový / nerozhodnutý / zamítnutý GIF neprojde (i od moda).
          if (mode === 'approved' && !approvedKnown) {
            await dropOriginal(p, GIF_NOT_ALLOWED_REASON);
            notice('approved_only');
            await safe('moderation_actions', async () => deps.recordAction?.({ channel: p.ucChannel, accountId: null, actor: 'filter', action: 'gif_not_allowed', platform: m.platform, targetLogin: m.username.toLowerCase(), targetMessageId: m.platformMessageId, params: { mode, known: known?.status ?? null }, result: {} }));
            deps.log.info({ channel: p.ucChannel, platform: m.platform, known: known?.status ?? null }, 'gif: režim jen schválené → nový GIF smazán');
            return finish('not_allowed');
          }
          // Trvale zahozený GIF (withdrawn / purging / unavailable): do chatu se nepustí — bez schvalování, od všech
          // (i od moda: auto-schválení by zahozené médium vrátilo do knihovny).
          if (known && GIF_DISCARDED.has(known.status)) {
            await dropOriginal(p, GIF_REJECTED_REASON);
            notice('auto_rejected', { reason: 'purged' });
            await safe('moderation_actions', async () => deps.recordAction?.({ channel: p.ucChannel, accountId: null, actor: 'filter', action: 'gif_auto_reject', platform: m.platform, targetLogin: m.username.toLowerCase(), targetMessageId: m.platformMessageId, params: { mediaId: known.id, reason: 'purged', status: known.status }, result: {} }));
            deps.log.info({ channel: p.ucChannel, platform: m.platform, status: known.status }, 'gif: zahozený GIF → automaticky zamítnuto');
            return finish('rejected');
          }
          // Známý zamítnutý (divák): zákaz 12 h / 3.+ pokus téhož uživatele = automaticky; jinak ke schválení s ⚠.
          let previouslyRejected: PreviouslyRejected | undefined;
          if (!auto && known?.status === 'rejected') {
            const at = new Date(deps.now());
            const ban = await deps.store.activeBan(p.ucChannel, known.id, at);
            const count = ban ? 0 : await deps.store.rejectionCount(p.ucChannel, known.id, m.platform, m.platformUserId);
            if (ban || count >= AUTO_REJECT_AFTER) {
              const n = await deps.store.addRejection(p.ucChannel, known.id, m.platform, m.platformUserId, at).catch(() => count + 1);
              await dropOriginal(p, GIF_REJECTED_REASON);
              const reason = ban ? 'ban' : 'repeat';
              notice('auto_rejected', { reason });
              await safe('moderation_actions', async () => deps.recordAction?.({ channel: p.ucChannel, accountId: null, actor: 'filter', action: 'gif_auto_reject', platform: m.platform, targetLogin: m.username.toLowerCase(), targetMessageId: m.platformMessageId, params: { mediaId: known.id, reason, count: n }, result: {} }));
              deps.log.info({ channel: p.ucChannel, platform: m.platform, reason, count: n }, 'gif: dříve zamítnutý GIF → automaticky zamítnuto');
              return finish('rejected');
            }
            // ⚠ jen když GIF někdo opravdu zamítl (strike); odebraný z knihovny (bez strike) = běžná žádost.
            const struck = count > 0 || await deps.store.hasRejections(p.ucChannel, known.id).catch(() => true);
            if (struck) previouslyRejected = { at: known.rejectedAt ? known.rejectedAt.getTime() : null, by: known.rejectedBy };
          }
          instant = auto || approvedKnown;
          let mediaId: string | null = known?.id ?? null;
          let savedFresh = false;
          if (instant && deps.claim && !deps.claim(p.workspace)) {
            blocked = true;
            deps.log.info({ channel: p.ucChannel, platform: m.platform, auto }, 'gif: globální cooldown chatu běží → okamžité schválení neprojde');
          } else try {
            if (!mediaId && res.fresh) {
              mediaId = await deps.store.saveMedia(res.fresh, { channel: p.ucChannel, sourceUrlNorm: urlNorm, sha256: res.sha256 });
              savedFresh = true;
            }
            const v = res.fresh ?? known!;
            const raw = (m.contentRaw || {}) as Record<string, unknown>;
            created = await deps.store.insertRequest({
              channel: p.ucChannel, workspace: p.workspace, platform: m.platform, platformChannel: m.channel,
              userId: m.platformUserId, login: m.username.toLowerCase(), messageId: m.platformMessageId,
              textWithoutLink: textWithoutLink(m.content, p.candidate.token, p.linkBlocked), mediaId: mediaId!, kind: v.kind,
              width: v.width, height: v.height,
              meta: {
                displayName: m.username, sentAt: m.sentAt.getTime(), ...(raw.color ? { color: raw.color } : {}), ...(raw.badges !== undefined ? { badges: raw.badges } : {}),
                ...(auto ? { auto: true } : {}), ...(approvedKnown && !auto ? { instant: true } : {}), ...(previouslyRejected ? { previouslyRejected } : {}),
                // Zamítnuté médium zůstává jen s tokenem i s novou žádostí (audit SEC-1) → karta moda ho načte s tokenem.
                ...(known?.status === 'rejected' ? { tokenRequired: true } : {}),
              },
              // requestTtlSec z odpovědi Židolišty (z cache, už načtená); chybí → 300 s.
              expiresAt: new Date(deps.now() + (access?.requestTtlSec ?? 300) * 1000),
            });
            // Zámek uživatele hned po vzniku žádosti (ne až po mazání na platformě) — a jen když ji mezitím
            // nikdo nerozhodl (rozhodnutí by zámek už nesundalo a visel by do restartu).
            if (!closed.has(created.id)) pending.set(k, created.id);
          } catch (e) {
            deps.log.warn({ err: (e as Error).message }, 'gif: uložení žádosti selhalo');
            if (savedFresh && mediaId) await safe('úklid média', () => deps.store.deleteMedia(mediaId!));
          }
        } else {
          deps.log.info({ channel: p.ucChannel, platform: m.platform, host: safeHost(p.candidate.url), code: res.code }, 'gif: převod odkazu selhal (běžný odkaz)');
          // Režim „jen schválené": náš odkaz na neznámé médium i odkaz za ochranou proti botům (Bright Data se
          // v tomhle režimu nevolá) je nový GIF (smazaný filtrem už je pryč).
          if (mode === 'approved' && (p.candidate.mode === 'own' || res.code === 'bot_protection') && p.preDeleted !== 'link_filter') {
            await dropOriginal(p, GIF_NOT_ALLOWED_REASON);
            notice('approved_only');
            return finish('not_allowed');
          }
        }

        if (!created) {
          // Převod selhal → běžný odkaz: filtr ho smaže, jinak se v UC obnoví (smazali jsme ho my).
          if (p.preDeleted === 'gif_request') {
            settled = true;
            await settleHeld(p);
          } else if (p.preDeleted === 'link_filter' && res.ok) {
            // Přeznačení na gif_request proběhlo (výš), ale médium/žádost se neuložily → vrátit link_filter,
            // jinak by zpráva zůstala smazaná bez žádosti a permit by ji už neobnovil.
            await safe('vrácení na link_filter', () => deps.store.retagDeleted(m.platform, m.platformMessageId, 'gif_request', 'link_filter'));
          }
          return finish(blocked ? 'denied' : 'failed');
        }

        // Mod / broadcaster nebo známý schválený GIF z knihovny: schválit HNED po insertu (stejná cesta jako
        // decide approve), bez karet — dřív, než by žádost mohl uvidět a rozhodnout jiný mod (listPending
        // auto/instant žádosti vynechává). Mazání na platformě až potom (níž).
        let instantOut: { status: number; body: Record<string, unknown> } | null = null;
        if (instant) {
          const by = auto ? `${m.platform}:${m.username.toLowerCase()}` : 'library';
          instantOut = await decideCore({ requestId: created.id, approve: true, by, accountId: null, auto, quiet: true, instant: true });
          // Médium zahozené během stahování / FLUSH_WAIT (souběh s „Trvale zahodit“) → jako zahozený dedup.
          if (instantOut.body.reason === 'purged' || instantOut.body.reason === 'unapproved') {
            await dropOriginal(p, GIF_REJECTED_REASON);
            notice('auto_rejected', { reason: instantOut.body.reason });
            deps.log.info({ channel: p.ucChannel, platform: m.platform, requestId: created.id }, 'gif: médium zahozené během zachycení → automaticky zamítnuto');
            return finish('rejected');
          }
          deps.log.info({ channel: p.ucChannel, platform: m.platform, requestId: created.id, status: instantOut.status, auto }, auto ? 'gif: mod → schváleno rovnou' : 'gif: známý schválený GIF → rovnou do chatu');
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
        if (instantOut) return finish(instantOut.status === 200 ? 'approved' : 'requested');

        const view = pendingView(created);
        // Rozhodnuto dřív, než jsme stihli ohlásit (mod ji viděl v GET /moderation/gif/pending) → gif-pending neposílat,
        // gif-decided už odešlo.
        if (closed.has(created.id)) return finish('requested');
        await safe('gif-pending', () => deps.notify(created!, 'gif-pending', view));
        await safe('integrace gif.pending', async () => deps.integration({ type: 'gif.pending', workspace: created!.workspace, requestId: created!.id, platform: created!.platform, userId: created!.userId, login: created!.login, messageId: created!.messageId, text: view.text, media: view.media, expiresAt: created!.expiresAt.toISOString(), ...(view.previouslyRejected ? { previouslyRejected: view.previouslyRejected } : {}) }));
        await emitQueue(p.ucChannel);
        await safe('moderation_actions', async () => deps.recordAction?.({ channel: p.ucChannel, accountId: null, actor: 'filter', action: 'gif_request', platform: m.platform, targetLogin: created!.login, targetMessageId: m.platformMessageId, params: { requestId: created!.id, kind: created!.kind, source: safeHost(p.candidate.url), ...(view.previouslyRejected ? { previouslyRejected: true } : {}) }, result: {} }));
        deps.log.info({ channel: p.ucChannel, platform: m.platform, requestId: created.id, kind: created.kind }, 'gif: žádost o schválení');
        return finish('requested');
      } catch (e) {
        deps.log.warn({ err: (e as Error).message }, 'gif: zachycení selhalo');
        // Schovaná zpráva bez žádosti nesmí zůstat bez rozhodnutí (s žádostí rozhodne mod / propadnutí).
        if (!created && !settled && p.preDeleted === 'gif_request') await safe('rozhodnutí po chybě', () => settleHeld(p));
        return finish('failed');
      } finally {
        busy.delete(k);
        inflight.delete(mk);
      }
    },

    /**
     * Rozhodnutí moda (mod už ověřený routou). První vyhrává: podmíněný UPDATE; pozdější → 409 already_decided
     * `{ status, decidedBy }`.
     */
    decide(p: { requestId: number; approve: boolean; by: string; accountId: number | null }): Promise<{ status: number; body: Record<string, unknown> }> {
      return decideCore(p);
    },

    /**
     * Akce nad médiem (mod už ověřený routou podle kanálu média):
     *  - approve (jen zamítnuté): do knihovny, do chatu nic;
     *  - vault (jen zamítnuté): retence 14 dní se na něj nevztahuje;
     *  - purge (zamítnuté i schválené, „Trvale zahodit"): `keepMessages` → withdrawn (soubor zůstává, zprávy vidět),
     *    jinak (i bez parametru — zpětná kompatibilita Židolišty) → purging: zprávy hned schované, smazání za 7 dní;
     *  - restore (jen purging): zpět do stavu před zahozením (knihovna / zamítnuté), zprávy se znovu ukážou;
     *  - remove-file (jen withdrawn): soubor pryč → unavailable, zprávy ukážou „[GIF nedostupný]" (nevratné);
     *  - unapprove (jen schválené): „odebrat z knihovny" → zamítnuté (retence 14 dní, jen s tokenem);
     *  - ban12h (čekající / zamítnuté): „Automaticky zahazovat 12 h" od všech + čekající žádosti na médium zamítnout.
     * Změna stavu → SSE `gif-media` { channel, mediaId, state: visible|removed|unavailable|library, messageIds? } (veřejné).
     */
    async mediaAction(p: { mediaId: string; action: GifMediaAction; by: string; accountId: number | null; keepMessages?: boolean }): Promise<{ status: number; body: Record<string, unknown> }> {
      const md = await deps.store.getMedia(p.mediaId);
      if (!md || !md.channel) return { status: 404, body: { ok: false, error: 'not_found' } };
      const at = new Date(deps.now());
      const record = (result: object) => safe('moderation_actions', async () => deps.recordAction?.({ channel: md.channel!, accountId: p.accountId, actor: p.by, action: `gif_media_${p.action.replace('-', '_')}`, platform: 'uc', targetLogin: null, params: { mediaId: md.id, ...(p.action === 'purge' ? { keepMessages: !!p.keepMessages } : {}) }, result }));
      const conflict = (error: string, status: string) => ({ status: 409, body: { ok: false, error, status } });
      if (p.action === 'unapprove') {
        if (md.status !== 'approved') return conflict('not_approved', md.status);
        if (!(await deps.store.setMediaUnapproved(md.id, p.by, at))) return conflict('not_approved', 'rejected');
        // Schválené bylo v paměťové cache jako veřejné → zahodit (teď jen s tokenem).
        deps.mediaChanged?.(md.id);
        await announceMedia(md.channel, md.id, 'approved', 'rejected');
        await record({ ok: true });
        return { status: 200, body: { ok: true, mediaId: md.id, action: p.action } };
      }
      if (p.action === 'restore') {
        if (md.status !== 'purging') return conflict('not_purging', md.status);
        const r = await deps.store.restoreMedia(md.id, at, p.by);
        if (!r) return conflict('not_purging', (await deps.store.getMedia(md.id))?.status ?? 'gone');
        let effective = md.id;
        if (r.mergedInto) {
          // Stejný obsah je mezitím schválený jako jiné médium → zprávy a žádosti na něj, tohle pryč.
          await deps.store.mergeMedia(md.id, r.mergedInto);
          deps.mediaDeleted?.(md.id);
          effective = r.mergedInto;
        }
        deps.mediaChanged?.(effective);
        await announceMedia(md.channel, md.id, 'purging', r.status, effective);
        await record({ ok: true, status: r.status, ...(r.mergedInto ? { mergedInto: r.mergedInto } : {}) });
        return { status: 200, body: { ok: true, mediaId: md.id, action: p.action, status: r.status } };
      }
      if (p.action === 'remove-file') {
        if (md.status !== 'withdrawn') return conflict('not_withdrawn', md.status);
        if (!(await deps.store.removeMediaFile(md.id))) return conflict('not_withdrawn', (await deps.store.getMedia(md.id))?.status ?? 'gone');
        // Soubor je pryč natrvalo → tombstone (další čtení nevrátí nic ani ze souběžného načtení).
        deps.mediaDeleted?.(md.id);
        await announceMedia(md.channel, md.id, 'withdrawn', 'unavailable');
        await record({ ok: true });
        return { status: 200, body: { ok: true, mediaId: md.id, action: p.action, status: 'unavailable' } };
      }
      if (p.action === 'purge') {
        const prev = md.status;
        if (prev !== 'approved' && prev !== 'rejected') return conflict(GIF_DISCARDED.has(prev) ? 'already_purged' : 'not_rejected', prev);
        const to: GifDiscardedStatus = p.keepMessages ? 'withdrawn' : 'purging';
        const purgeAt = to === 'purging' ? new Date(at.getTime() + PURGE_DELAY_MS) : null;
        // Zahození + zamítnutí čekajících žádostí na médium v jedné transakci (rozhodnutí moda už nic nenajde).
        const out = await deps.store.purgeMedia(md.id, to, p.by, at, purgeAt);
        if (!out.ok) return conflict('already_purged', (await deps.store.getMedia(md.id))?.status ?? 'gone');
        const pendingRows = out.rejected;
        // Zamítnuté žádosti: původní zprávy → běžně smazané, gif-decided / gif.decided / fronta jako u zamítnutí modem.
        for (const r of pendingRows) {
          await decided(r, 'rejected', p.by);
          await safe('moderation_actions', async () => deps.recordAction?.({ channel: r.channel, accountId: p.accountId, actor: p.by, action: 'gif_reject', platform: r.platform, targetLogin: r.login, targetMessageId: r.messageId, params: { requestId: r.id, reason: 'purged' }, result: { status: 'rejected' } }));
        }
        // Stav se změnil (withdrawn veřejně, purging jen s tokenem) → cache /media/gif zahodit.
        deps.mediaChanged?.(md.id);
        await announceMedia(md.channel, md.id, prev, to);
        await record({ ok: true, status: to, requests: pendingRows.length });
        return { status: 200, body: { ok: true, mediaId: md.id, action: p.action, status: to, ...(purgeAt ? { purgeAt: purgeAt.getTime() } : {}), ...(pendingRows.length ? { requests: pendingRows.length } : {}) } };
      }
      if (p.action === 'ban12h') {
        if (md.status === 'approved') return conflict('approved', md.status);
        if (GIF_DISCARDED.has(md.status)) return conflict('already_purged', md.status);
        const until = new Date(at.getTime() + GIF_BAN_MS);
        await deps.store.setBan(md.channel, md.id, until, p.by);
        // Zákaz = médium zamítnuté (dedup ho pak u každého pozná jako zamítnuté a ban uplatní).
        await deps.store.setMediaRejected(md.id, p.by, at);
        deps.mediaChanged?.(md.id);
        const rows = await deps.store.pendingForMedia(md.id, at).catch(() => [] as GifRequest[]);
        for (const r of rows) await decideCore({ requestId: r.id, approve: false, by: p.by, accountId: p.accountId });
        await record({ until: until.toISOString(), rejected: rows.length });
        return { status: 200, body: { ok: true, mediaId: md.id, bannedUntil: until.getTime(), rejected: rows.length } };
      }
      if (md.status !== 'rejected') return conflict('not_rejected', md.status);
      const pendingRows = await deps.store.pendingForMedia(md.id, at).catch(() => [] as GifRequest[]);
      if (p.action === 'approve') {
        // Do knihovny; čekající žádosti na totéž médium se schválí taky (bez nového schvalování).
        const effective = await deps.store.setMediaApproved(md.id, at);
        // Mezitím zahozené (souběh s jiným modem) → nic neschvalovat.
        if (effective === null) return conflict('already_purged', (await deps.store.getMedia(md.id))?.status ?? 'gone');
        if (effective !== md.id) { await deps.store.mergeMedia(md.id, effective); deps.mediaDeleted?.(md.id); }
        else deps.mediaChanged?.(md.id);
        // Zprávy s GIFem odebraným z knihovny se znovu ukážou (i ty přesměrované na sloučené médium).
        await announceMedia(md.channel, md.id, 'rejected', 'approved', effective);
        for (const r of pendingRows) await decideCore({ requestId: r.id, approve: true, by: p.by, accountId: p.accountId, cascade: true });
      } else {
        await deps.store.setVault(md.id, true);
      }
      await record({ ok: true, requests: pendingRows.length });
      return { status: 200, body: { ok: true, mediaId: md.id, action: p.action, ...(pendingRows.length && p.action !== 'vault' ? { requests: pendingRows.length } : {}) } };
    },

    /** Propadlé žádosti → expired, médium čekající jen na ně pryč, gif-decided (status expired). Vrací počet. */
    async expireTick(): Promise<number> {
      let rows: GifRequest[] = [];
      const at = new Date(deps.now());
      try { rows = await deps.store.expireDue(at); }
      catch (e) { deps.log.warn({ err: (e as Error).message }, 'gif: propadnutí selhalo'); return 0; }
      for (const r of rows) {
        if (r.mediaId) {
          await safe('úklid média', async () => {
            deps.mediaChanged?.(r.mediaId!);
            const md = await deps.store.getMedia(r.mediaId!);
            // Propadlá žádost na zamítnuté médium = strike jako zamítnutí modem (audit SEC-1): jinak by šel dříve
            // zamítnutý GIF posílat ke schválení donekonečna, když mody kartu ignorují.
            if (md?.status === 'rejected') await deps.store.addRejection(r.channel, md.id, r.platform, r.userId, at);
            if (md?.status !== 'pending') return; // schválené (knihovna) / zamítnuté (retence) zůstávají
            // Čeká na něj jiná žádost, nebo na něj odkazují starší zprávy (čekající alias z backfillu: schválené žádosti).
            if (await deps.store.mediaReferenced(r.mediaId!)) return;
            await deps.store.deleteMedia(r.mediaId!);
            deps.mediaDeleted?.(r.mediaId!);
          });
        }
        await decided(r, 'expired', null);
      }
      if (rows.length) deps.log.info({ n: rows.length }, 'gif: žádosti propadly');
      return rows.length;
    },

    /**
     * Retence (1×/h): zamítnutá média starší 14 dní bez vaultu pryč; zahozená „i se zprávami“ (purging) po purge_at
     * (7 dní) pryč i se záznamem — zprávy jsou schované už od zahození (zůstanou gif_removed). Vrací počet.
     */
    async retentionTick(): Promise<number> {
      const now = deps.now();
      let ids: string[] = [];
      try { ids = await deps.store.retentionDue(new Date(now - REJECTED_RETENTION_MS), new Date(now)); }
      catch (e) { deps.log.warn({ err: (e as Error).message }, 'gif: retence zamítnutých selhala'); }
      for (const id of ids) deps.mediaDeleted?.(id);
      if (ids.length) deps.log.info({ n: ids.length }, 'gif: zamítnuté GIFy po 14 dnech smazány');
      let purged: string[] = [];
      try { purged = await deps.store.purgeDue(new Date(now)); }
      catch (e) { deps.log.warn({ err: (e as Error).message }, 'gif: smazání zahozených (purging) selhalo'); }
      for (const id of purged) deps.mediaDeleted?.(id);
      if (purged.length) deps.log.info({ n: purged.length }, 'gif: zahozené GIFy po 7 dnech smazány');
      return ids.length + purged.length;
    },

    /**
     * Dorovnání (audit A1; při startu a pak pravidelně): restart nebo chyba DB mezi schválením žádosti a zápisem
     * zprávy nechal žádost `approved` bez syntetické zprávy `gif-<id>` (původní zpráva navždy schovaná) nebo s médiem
     * pořád čekajícím (mimo knihovnu). Médium čekající → schválit (souběh dedupu → sloučit); zpráva chybí → zapsat
     * s časem schválení a rozeslat (gif-message, /chat/stream). Médium zamítnuté / zahozené / pryč a zpráva chybí →
     * žádost zamítnout a původní zprávu ukázat jako smazanou. Vrací počet vyřízených žádostí.
     */
    async reconcileTick(): Promise<number> {
      const now = deps.now();
      let rows: Awaited<ReturnType<GifStore['unpublishedApproved']>> = [];
      try { rows = await deps.store.unpublishedApproved(new Date(now - RECONCILE_GRACE_MS), new Date(now - RECONCILE_WINDOW_MS), RECONCILE_BATCH); }
      catch (e) { deps.log.warn({ err: (e as Error).message }, 'gif: dorovnání schválených žádostí selhalo'); return 0; }
      const giveUp = async (r: GifRequest, why: string) => {
        await deps.store.setRequestRejected(r.id, r.decidedBy ?? 'filter', new Date(now));
        r.status = 'rejected';
        await rejectOriginal(r);
        deps.log.warn({ requestId: r.id, channel: r.channel, why }, 'gif: schválenou žádost nejde dopsat → zamítnuta');
      };
      let n = 0;
      for (const { request: r, mediaStatus, hasMessage } of rows) {
        const at = r.decidedAt ?? new Date(now);
        try {
          let status = mediaStatus;
          if (r.mediaId && status === 'pending') {
            const effective = await deps.store.setMediaApproved(r.mediaId, at);
            if (effective === null) status = 'gone';
            else {
              if (effective !== r.mediaId) { await deps.store.mergeMedia(r.mediaId, effective); deps.mediaDeleted?.(r.mediaId); r.mediaId = effective; }
              await deps.store.markMediaUsed(r.mediaId, at);
              deps.mediaChanged?.(r.mediaId);
              status = 'approved';
            }
          }
          if (!hasMessage) {
            if (!r.mediaId || status !== 'approved') await giveUp(r, `media:${status ?? 'none'}`);
            else {
              const msg = await deps.store.insertApprovedMessage(r, at);
              await safe('předehřátí média', async () => deps.mediaApproved?.(r.mediaId!));
              deps.broadcast('gif-message', { channel: r.channel, requestId: r.id, message: msg });
              await safe('chat stream', async () => deps.publishChat(r.platformChannel, r.platform, msg));
              deps.log.info({ requestId: r.id, channel: r.channel }, 'gif: schválený GIF bez zprávy → dopsán (dorovnání)');
            }
          }
          reconcileFails.delete(r.id);
          n++;
        } catch (e) {
          const f = (reconcileFails.get(r.id) ?? 0) + 1;
          reconcileFails.set(r.id, f);
          if (reconcileFails.size > 2000) reconcileFails.delete(reconcileFails.keys().next().value!);
          deps.log.warn({ requestId: r.id, attempt: f, err: (e as Error).message }, 'gif: dorovnání žádosti selhalo');
          if (f >= RECONCILE_MAX_ATTEMPTS) {
            reconcileFails.delete(r.id);
            await safe('zamítnutí nedopsatelné žádosti', () => giveUp(r, 'attempts'));
          }
        }
      }
      return n;
    },

    /** Po startu: čekající žádosti do paměti (jedna žádost na uživatele). */
    async loadPending(): Promise<number> {
      const rows = await deps.store.listPending(new Date(deps.now()));
      for (const r of rows) pending.set(userKey(r.channel, r.platform, r.userId), r.id);
      return rows.length;
    },

    /** Schválený GIF smazaný modem (část 1, id `gif-…`) → status deleted, rezervace pryč. Médium zůstává v knihovně. */
    async onMessageDeleted(messageId: string): Promise<void> {
      await safe('označení smazaného GIFu', () => deps.store.markDeletedByMessage(messageId));
    },

    /** Běží zachycení původní zprávy (převod / rozhodování)? GET /gif/held ji pak hlásí jako „čeká". */
    isInFlight(platform: string, messageId: string): boolean { return inflight.has(`${platform}:${messageId}`); },

    _pendingSize: () => pending.size,
    /** Testy: počkat na dorovnání archivu na pozadí. */
    _idle: async () => { while (background.size) await Promise.all([...background]); },
  };
}

export type GifFlow = ReturnType<typeof createGifFlow>;

type TimerFns = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  setInterval: (fn: () => void, ms: number) => unknown;
  clear: (t: unknown) => void;
};
const nodeTimers: TimerFns = {
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; },
  clear: (t) => { clearTimeout(t as ReturnType<typeof setTimeout>); clearInterval(t as ReturnType<typeof setInterval>); },
};

/**
 * Údržba GIFů na pozadí (server.ts onReady): propadnutí žádostí každých 10 s; dorovnání schválených bez zprávy
 * (audit A1) 30 s po startu a pak 1×/min; retence (zamítnuté 14 dní, purging 7 dní) 2 min po startu a pak 1×/h —
 * dřív až hodinu po startu, takže se při častých deployích z dev nespustila vůbec (audit B2). Vrací stop.
 */
export function startGifMaintenance(flow: Pick<GifFlow, 'expireTick' | 'reconcileTick' | 'retentionTick'>, timers: TimerFns = nodeTimers): () => void {
  const handles: unknown[] = [];
  const run = (fn: () => Promise<unknown>) => () => { void fn().catch(() => {}); };
  const later = (fn: () => Promise<unknown>, firstMs: number, everyMs: number) => {
    handles.push(timers.setTimeout(() => { run(fn)(); handles.push(timers.setInterval(run(fn), everyMs)); }, firstMs));
  };
  handles.push(timers.setInterval(run(() => flow.expireTick()), 10_000));
  later(() => flow.reconcileTick(), 30_000, 60_000);
  later(() => flow.retentionTick(), 120_000, 3600_000);
  return () => { for (const h of handles) timers.clear(h); };
}
