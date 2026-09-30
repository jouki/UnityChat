// GIF knihovna — Task 2 (spec docs/superpowers/specs/2026-09-26-gif-knihovna-design.md §3 a §6,
// kontrakt docs/superpowers/plans/2026-09-25-moderace-cast-2-kontrakt.md §Část 4 „GIF knihovna").
//
//   knihovna   schválené GIFy kanálu řazené podle použití (use_count desc, last_used_at desc, id desc), tagy, kurzor
//              → GET /gifs/library (veřejné), GET /integrations/:slug/gifs (Židolišta)
//   tagy       ze stránky zdroje při stažení (lib/gifMedia.ts pageTags), úprava přes integraci (updateTags)
//   duplicity  perceptuální hash (lib/gifPhash.ts) na pozadí, 1 médium za 2 s: nejdřív dopočet hashů rozhodnutých
//              médií (schválená přednostně), pak porovnání s médii TÉHOŽ kanálu → návrh `gif_duplicates` jen pro
//              dvojici, která ještě nemá záznam. Nic se neslučuje samo: mod / Židolišta rozhodne
//              keep-first | keep-second | keep-both (sloučení = použití na ponechané médium, druhé smazat).
// Použití (use_count++, last_used_at) počítá lib/gifRequests.ts při každém zobrazení schváleného GIFu (decideCore).
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/index.js';
import { gifBans, gifDuplicates, gifMedia, gifRejections } from '../db/schema.js';
import { gifMediaUrl, MEDIA_ID_RE } from './gifIds.js';
import { normalizeTags, MAX_TAGS, MAX_TAG_LEN, type GifKind } from './gifMedia.js';
import { sequenceSimilarity, PHASH_MIN_SCORE } from './gifPhash.js';
import { likePattern } from '../routes/chatLog.js';

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
type Out = { status: number; body: Record<string, unknown> };

export const LIBRARY_PAGE = 50;
export const LIBRARY_MAX_PAGE = 100;
export const DUPLICATES_PAGE = 50;
/** Dopočet hashů / kontrola duplikátů: jedno médium za interval (CPU VPS). */
export const PHASH_INTERVAL_MS = 2000;

// ---------------------------------------------------------------------------
// Knihovna
// ---------------------------------------------------------------------------

export interface LibraryItem {
  id: string;
  kind: string;
  width: number | null;
  height: number | null;
  tags: string[];
  useCount: number;
  lastUsedAt: Date | null;
}

/** Kurzor `<useCount>:<lastUsedMs|0>:<mediaId>` poslední položky stránky. */
export interface LibraryCursor { useCount: number; lastUsedMs: number; id: string }

const lastMs = (d: Date | null): number => (d ? d.getTime() : 0);

/** Pořadí knihovny: use_count desc, last_used_at desc (bez použití = nejstarší), id desc. Záporné = `a` dřív. */
export function compareLibrary(a: Pick<LibraryItem, 'useCount' | 'lastUsedAt' | 'id'>, b: Pick<LibraryItem, 'useCount' | 'lastUsedAt' | 'id'>): number {
  return b.useCount - a.useCount || lastMs(b.lastUsedAt) - lastMs(a.lastUsedAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

export const libraryCursorOf = (i: Pick<LibraryItem, 'useCount' | 'lastUsedAt' | 'id'>): string => `${i.useCount}:${lastMs(i.lastUsedAt)}:${i.id}`;

/** Chybí → null; neplatný → false. */
export function parseLibraryCursor(raw: unknown): LibraryCursor | null | false {
  if (raw === undefined || raw === null || raw === '') return null;
  const m = /^(\d{1,9}):(\d{1,15}):([a-f0-9]{32})$/.exec(String(raw));
  if (!m) return false;
  return { useCount: Number(m[1]), lastUsedMs: Number(m[2]), id: m[3] };
}

/** Hledaný text v tagech (podřetězec, malými písmeny, ≤ 40 znaků); prázdný → null. */
export function parseLibraryQuery(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const q = raw.normalize('NFKC').toLowerCase().trim().replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LEN).trim();
  return q || null;
}

/** Položka knihovny pro klienty: URL našeho média (api.jouki.cz/media/gif/<id>), rozměry, tagy, použití. */
export function libraryView(i: LibraryItem) {
  return {
    mediaId: i.id, url: gifMediaUrl(i.id), kind: i.kind, width: i.width, height: i.height,
    tags: i.tags, useCount: i.useCount, lastUsedAt: i.lastUsedAt ? i.lastUsedAt.getTime() : null,
  };
}

// ---------------------------------------------------------------------------
// Duplicity
// ---------------------------------------------------------------------------

/** Médium v návrhu duplikátu. */
export interface LibMedia {
  id: string;
  status: string;
  kind: string;
  width: number | null;
  height: number | null;
  tags: string[];
  useCount: number;
  createdAt: Date;
}

export interface DuplicatePair {
  id: number;
  channel: string;
  score: number;
  status: string;
  createdAt: Date;
  /** Starší médium („nechat první"). */
  first: LibMedia;
  /** Novější médium („nechat druhý"). */
  second: LibMedia;
}

const mediaView = (m: LibMedia) => ({
  mediaId: m.id, url: gifMediaUrl(m.id), kind: m.kind, width: m.width, height: m.height, status: m.status,
  tags: m.tags, useCount: m.useCount, createdAt: m.createdAt.getTime(),
});

/** Návrh pro klienty; URL zamítnutého média je bez tokenu (klient ho přidá sám). */
export function duplicateView(p: DuplicatePair) {
  return { id: p.id, channel: p.channel, score: Math.round(p.score * 1000) / 1000, status: p.status, createdAt: p.createdAt.getTime(), first: mediaView(p.first), second: mediaView(p.second) };
}

/** Postgres: chybí tabulka (42P01) nebo sloupec (42703) — SQL z 2026-09-26 ještě neběželo. */
export function isSchemaMissing(e: unknown): boolean {
  for (let x: unknown = e, i = 0; x && i < 3; x = (x as { cause?: unknown }).cause, i++) {
    const code = (x as { code?: unknown }).code;
    if (code === '42P01' || code === '42703') return true;
  }
  return false;
}

/** Chyba DB v routě knihovny → 503 not_ready (chybí schéma) / 500 internal. */
export function libraryErrorReply(e: unknown): Out {
  return isSchemaMissing(e) ? { status: 503, body: { ok: false, error: 'not_ready' } } : { status: 500, body: { ok: false, error: 'internal' } };
}

export type MergeResult ={ ok: true } | { ok: false; error: 'gone' } | { ok: false; error: 'already_decided'; status: string };

/** Médium, které smí být v návrhu duplikátu (ne trvale zahozené). */
export const duplicateCandidate = (status: string): boolean => status === 'approved' || status === 'rejected' || status === 'pending';

/** Vault po sloučení: schválené médium vault nemá (vault = zamítnutý bez retence). */
export const mergedVault = (resultApproved: boolean, keepVault: boolean, dropVault: boolean): boolean => (resultApproved ? false : keepVault || dropVault);

export const DUPLICATE_ACTIONS =['keep-first', 'keep-second', 'keep-both'] as const;
export type DuplicateAction = typeof DUPLICATE_ACTIONS[number];

// ---------------------------------------------------------------------------
// Přesun média do jiného (sloučení duplikátu modem i souběh dedupu při schválení) — jeden zdroj pravdy
// ---------------------------------------------------------------------------

/**
 * SQL přesměrování odkazů z média `drop` na `keep`: syntetické zprávy schválených GIFů (`content_raw.gif.mediaId`
 * zpráv `gif-<requestId>` žádostí na `drop`) a žádosti. Pořadí je důležité — zprávy se hledají přes žádosti.
 */
export function redirectMediaRefsSql(drop: string, keep: string): SQL[] {
  return [
    sql`update messages m set content_raw = jsonb_set(m.content_raw, '{gif,mediaId}', to_jsonb(${keep}::text))
      from gif_requests r
      where r.media_id = ${drop} and m.platform = r.platform and m.platform_message_id = 'gif-' || r.id::text`,
    sql`update gif_requests set media_id = ${keep} where media_id = ${drop}`,
  ];
}

/**
 * Normalizovaná URL zdroje zahozeného média → ponechanému, když žádnou nemá (dedup té URL bez stahování dál
 * funguje). Nepřepisuje existující URL (schéma má jednu URL na médium — URL zahozeného média se pak ztratí,
 * dedup ji pozná až po stažení podle sha256) a nekoliduje s jiným schváleným médiem kanálu (unikátní index).
 */
export function adoptSourceUrlSql(keep: string, url: string): SQL {
  return sql`update gif_media k set source_url_norm = ${url}
    where k.id = ${keep} and k.source_url_norm is null
      and not exists (select 1 from gif_media o where o.channel = k.channel and o.source_url_norm = ${url}
                      and o.status = 'approved' and o.id <> k.id)`;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Schválení média ruší „tresty“ (spec 2026-09-27-gif-review-upravy-design.md §1): zamítnutí (strike) všech uživatelů
 * i zákaz 12 h pro médium. Volá se VŽDY v téže transakci jako schválení (rozhodnutí moda, „Schválit“ ze Zamítnutých,
 * obnova do schváleného, sloučení do schváleného) — po pozdějším odebrání z knihovny je další poslání běžná žádost.
 */
export async function clearMediaStrikes(tx: Tx, mediaId: string): Promise<void> {
  await tx.delete(gifRejections).where(eq(gifRejections.mediaId, mediaId));
  await tx.delete(gifBans).where(eq(gifBans.mediaId, mediaId));
}

/**
 * Médium `drop` do `keep` (v transakci volajícího): odkazy (zprávy, žádosti) přesměrovat, `drop` smazat (jeho
 * zamítnutí, zákaz a návrhy duplikátů kaskádou), jeho URL zdroje převzít, když ji `keep` nemá.
 * Používá ho sloučení duplikátu (mergeInto) i souběh dedupu při schválení (lib/gifRequests.ts mergeMedia).
 */
export async function moveMediaInto(tx: Tx, drop: string, keep: string): Promise<void> {
  const [d] = await tx.select({ url: gifMedia.sourceUrlNorm }).from(gifMedia).where(eq(gifMedia.id, drop)).limit(1);
  for (const q of redirectMediaRefsSql(drop, keep)) await tx.execute(q);
  await tx.delete(gifMedia).where(eq(gifMedia.id, drop));
  if (d?.url) await tx.execute(adoptSourceUrlSql(keep, d.url));
}

// ---------------------------------------------------------------------------
// Úložiště (DB) — rozhraní kvůli testům
// ---------------------------------------------------------------------------

export interface GifLibraryStore {
  listLibrary(channel: string, o: { q: string | null; after: LibraryCursor | null; limit: number }): Promise<LibraryItem[]>;
  setTags(id: string, tags: string[]): Promise<void>;
  /** Kanál média; null = neexistuje. */
  mediaChannel(id: string): Promise<string | null>;
  /** Čekající návrhy kanálu (nejstarší první). */
  listDuplicates(channel: string, limit: number): Promise<DuplicatePair[]>;
  getDuplicate(id: number): Promise<{ id: number; channel: string; a: string; b: string; status: string } | null>;
  /** Podmíněně pending → kept_both; false = už rozhodnuto / neexistuje. */
  keepBoth(id: number, by: string, at: Date): Promise<boolean>;
  /**
   * Sloučení (transakce): nejdřív zamkne řádek návrhu `dupId` (FOR UPDATE) a vyžaduje `pending` (souběh
   * s keep-both / jiným sloučením → `already_decided`). Pak žádosti a syntetické zprávy `gif-<id>` s `drop` → `keep`
   * (moveMediaInto; URL zdroje `drop` převezme `keep`, když žádnou nemá),
   * `keep` dostane součet použití, pozdější last_used_at, sjednocení tagů, a když `drop` byl v knihovně (approved),
   * i schválení; vault jen když výsledek není schválený. `drop` se smaže (jeho zamítnutí, zákaz a návrhy kaskádou).
   * `gone` = návrh nebo některé médium mezitím zmizelo.
   */
  mergeInto(dupId: number, keep: string, drop: string, at: Date): Promise<MergeResult>;
  /** Rozhodnuté médium (approved/rejected) bez pokusu o hash; schválená přednostně, pak nejstarší. */
  nextToHash(): Promise<{ id: string; kind: GifKind; bytes: Buffer } | null>;
  /** Hash (null = selhal) + čas pokusu (znovu se nezkouší). */
  saveHash(id: string, hashes: string[] | null, at: Date): Promise<void>;
  /** Rozhodnuté médium s hashem, zatím neporovnané s kanálem. */
  nextToCheck(): Promise<{ id: string; channel: string; phash: string[]; createdAt: Date } | null>;
  /** Rozhodnutá média kanálu s hashem (kromě `excludeId`). */
  channelHashes(channel: string, excludeId: string): Promise<Array<{ id: string; phash: string[]; createdAt: Date }>>;
  /** Nový návrh; false = dvojice už záznam má (v libovolném pořadí). */
  insertDuplicate(v: { channel: string; a: string; b: string; score: number }): Promise<boolean>;
  markChecked(id: string, at: Date): Promise<void>;
}

const libCols = {
  id: gifMedia.id, kind: gifMedia.kind, width: gifMedia.width, height: gifMedia.height,
  tags: gifMedia.tags, useCount: gifMedia.useCount, lastUsedAt: gifMedia.lastUsedAt,
};
const decided = inArray(gifMedia.status, ['approved', 'rejected']);
/** Ms přesnost (kurzor je v ms; last_used_at zapisuje JS Date). */
const lastUsedKey = sql`date_trunc('milliseconds', coalesce(${gifMedia.lastUsedAt}, 'epoch'::timestamptz))`;

export const dbGifLibraryStore: GifLibraryStore = {
  async listLibrary(channel, o) {
    // Hledání v tazích bez diakritiky a velikosti písmen (uc_fold jako Chat Log, sql/2026-09-25-chat-log-search.sql):
    // „mikir“ najde „mikýř“ i „mikíř“. Víc slov = každé slovo musí sedět na některý tag (fulltext přes tagy).
    const words = (o.q ?? '').split(' ').filter(Boolean).slice(0, 6);
    const rows = await db.select(libCols).from(gifMedia)
      .where(and(
        eq(gifMedia.channel, channel), eq(gifMedia.status, 'approved'),
        ...words.map((w) => sql`exists (select 1 from unnest(${gifMedia.tags}) as t(tag) where uc_fold(t.tag) like uc_fold(${likePattern(w)}))`),
        o.after ? sql`(${gifMedia.useCount}, ${lastUsedKey}, ${gifMedia.id}) < (${o.after.useCount}, ${new Date(o.after.lastUsedMs).toISOString()}::timestamptz, ${o.after.id})` : undefined,
      ))
      .orderBy(desc(gifMedia.useCount), desc(lastUsedKey), desc(gifMedia.id))
      .limit(o.limit);
    return rows.map((r) => ({ ...r, tags: r.tags ?? [] }));
  },
  async setTags(id, tags) { await db.update(gifMedia).set({ tags }).where(eq(gifMedia.id, id)); },
  async mediaChannel(id) {
    const rows = await db.select({ channel: gifMedia.channel }).from(gifMedia).where(eq(gifMedia.id, id)).limit(1);
    return rows[0]?.channel ?? null;
  },
  async listDuplicates(channel, limit) {
    const rows = await db.select().from(gifDuplicates)
      .where(and(eq(gifDuplicates.channel, channel), eq(gifDuplicates.status, 'pending')))
      .orderBy(asc(gifDuplicates.createdAt), asc(gifDuplicates.id)).limit(limit);
    if (!rows.length) return [];
    const ids = [...new Set(rows.flatMap((r) => [r.a, r.b]))];
    const media = await db.select({ ...libCols, status: gifMedia.status, createdAt: gifMedia.createdAt }).from(gifMedia).where(inArray(gifMedia.id, ids));
    const by = new Map(media.map((m) => [m.id, { ...m, tags: m.tags ?? [] }]));
    const out: DuplicatePair[] = [];
    for (const r of rows) {
      const a = by.get(r.a), b = by.get(r.b);
      // Trvale zahozené médium (withdrawn / purging / unavailable) se nenavrhuje (sloučení by ho vrátilo do hry).
      if (a && b && duplicateCandidate(a.status) && duplicateCandidate(b.status)) out.push({ id: r.id, channel: r.channel, score: r.score, status: r.status, createdAt: r.createdAt, first: a, second: b });
    }
    return out;
  },
  async getDuplicate(id) {
    const rows = await db.select({ id: gifDuplicates.id, channel: gifDuplicates.channel, a: gifDuplicates.a, b: gifDuplicates.b, status: gifDuplicates.status })
      .from(gifDuplicates).where(eq(gifDuplicates.id, id)).limit(1);
    return rows[0] ?? null;
  },
  async keepBoth(id, by, at) {
    const rows = await db.update(gifDuplicates).set({ status: 'kept_both', decidedBy: by, decidedAt: at })
      .where(and(eq(gifDuplicates.id, id), eq(gifDuplicates.status, 'pending'))).returning({ id: gifDuplicates.id });
    return rows.length > 0;
  },
  async mergeInto(dupId, keep, drop, at) {
    return db.transaction(async (tx): Promise<MergeResult> => {
      // Zámek návrhu: souběžné keep-both / jiné sloučení počká a pak uvidí, že už není pending.
      const [dup] = await tx.select({ status: gifDuplicates.status }).from(gifDuplicates).where(eq(gifDuplicates.id, dupId)).for('update');
      if (!dup) return { ok: false, error: 'gone' };
      if (dup.status !== 'pending') return { ok: false, error: 'already_decided', status: dup.status };
      const rows = await tx.select({
        id: gifMedia.id, status: gifMedia.status, useCount: gifMedia.useCount, lastUsedAt: gifMedia.lastUsedAt,
        tags: gifMedia.tags, vault: gifMedia.vault, approvedAt: gifMedia.approvedAt,
      }).from(gifMedia).where(inArray(gifMedia.id, [keep, drop])).for('update');
      const k = rows.find((r) => r.id === keep), d = rows.find((r) => r.id === drop);
      // Mezitím trvale zahozené médium = jako by zmizelo (nesloučit — zprávy by se přesměrovaly / vzkřísily).
      if (!k || !d || !duplicateCandidate(k.status) || !duplicateCandidate(d.status)) return { ok: false, error: 'gone' };
      // Syntetické zprávy a žádosti → ponechané médium (jinak by GIFy v historii zmizely), drop pryč, jeho URL zdroje
      // převzít, když ji ponechané nemá (moveMediaInto — stejná cesta jako souběh dedupu při schválení).
      await moveMediaInto(tx, drop, keep);
      const later = (k.lastUsedAt?.getTime() ?? 0) >= (d.lastUsedAt?.getTime() ?? 0) ? k.lastUsedAt : d.lastUsedAt;
      const approve = d.status === 'approved' && k.status !== 'approved';
      await tx.update(gifMedia).set({
        useCount: k.useCount + d.useCount, lastUsedAt: later,
        tags: normalizeTags([...(k.tags ?? []), ...(d.tags ?? [])]),
        vault: mergedVault(approve || k.status === 'approved', k.vault, d.vault),
        ...(approve ? { status: 'approved', approvedAt: d.approvedAt ?? at, rejectedAt: null, rejectedBy: null } : {}),
      }).where(eq(gifMedia.id, keep));
      // Sloučení do schváleného = schválení → tresty ponechaného média pryč (tresty `drop` smazalo kaskádové mazání).
      if (approve || k.status === 'approved') await clearMediaStrikes(tx, keep);
      return { ok: true };
    });
  },
  async nextToHash() {
    const rows = await db.select({ id: gifMedia.id, kind: gifMedia.kind, bytes: gifMedia.bytes }).from(gifMedia)
      .where(and(isNull(gifMedia.phashAt), decided))
      .orderBy(sql`(${gifMedia.status} <> 'approved')`, asc(gifMedia.createdAt)).limit(1);
    return rows[0] ? { ...rows[0], kind: rows[0].kind as GifKind } : null;
  },
  async saveHash(id, hashes, at) { await db.update(gifMedia).set({ phash: hashes, phashAt: at }).where(eq(gifMedia.id, id)); },
  async nextToCheck() {
    const rows = await db.select({ id: gifMedia.id, channel: gifMedia.channel, phash: gifMedia.phash, createdAt: gifMedia.createdAt }).from(gifMedia)
      .where(and(isNull(gifMedia.dupCheckedAt), isNotNull(gifMedia.phash), isNotNull(gifMedia.channel), decided))
      .orderBy(asc(gifMedia.createdAt)).limit(1);
    const r = rows[0];
    return r && r.channel && r.phash ? { id: r.id, channel: r.channel, phash: r.phash, createdAt: r.createdAt } : null;
  },
  async channelHashes(channel, excludeId) {
    const rows = await db.select({ id: gifMedia.id, phash: gifMedia.phash, createdAt: gifMedia.createdAt }).from(gifMedia)
      .where(and(eq(gifMedia.channel, channel), ne(gifMedia.id, excludeId), isNotNull(gifMedia.phash), decided));
    return rows.filter((r): r is { id: string; phash: string[]; createdAt: Date } => Array.isArray(r.phash));
  },
  async insertDuplicate(v) {
    const rows = await db.insert(gifDuplicates).values(v).onConflictDoNothing().returning({ id: gifDuplicates.id });
    return rows.length > 0;
  },
  async markChecked(id, at) { await db.update(gifMedia).set({ dupCheckedAt: at }).where(eq(gifMedia.id, id)); },
};

// ---------------------------------------------------------------------------
// Operace sdílené routami (UC veřejné / mod, integrace Židolišty)
// ---------------------------------------------------------------------------

/** Stránka knihovny kanálu: `{ ok, items, nextCursor }`; neplatný kurzor 400. */
export async function libraryPage(store: GifLibraryStore, channel: string, q: { q?: unknown; cursor?: unknown; limit?: unknown }): Promise<Out> {
  const after = parseLibraryCursor(q.cursor);
  if (after === false) return { status: 400, body: { ok: false, error: 'cursor' } };
  const n = Number(q.limit);
  const limit = Number.isInteger(n) && n > 0 ? Math.min(LIBRARY_MAX_PAGE, n) : LIBRARY_PAGE;
  const rows = await store.listLibrary(channel, { q: parseLibraryQuery(q.q), after, limit });
  const last = rows[rows.length - 1];
  return { status: 200, body: { ok: true, items: rows.map(libraryView), nextCursor: rows.length === limit && last ? libraryCursorOf(last) : null } };
}

/** Úprava tagů média kanálu (integrace): `{ tags: string[] }` → normalizace (≤ 20, ≤ 40 znaků, malá písmena). */
export async function updateTags(store: GifLibraryStore, channel: string, mediaId: string, body: unknown): Promise<Out> {
  if (!MEDIA_ID_RE.test(mediaId)) return { status: 404, body: { ok: false, error: 'not_found' } };
  const raw = (body && typeof body === 'object' ? (body as Record<string, unknown>).tags : undefined);
  if (!Array.isArray(raw) || raw.length > MAX_TAGS * 5 || raw.some((t) => typeof t !== 'string' || t.length > 200)) return { status: 400, body: { ok: false, error: 'body' } };
  if ((await store.mediaChannel(mediaId)) !== channel) return { status: 404, body: { ok: false, error: 'not_found' } };
  const tags = normalizeTags(raw);
  await store.setTags(mediaId, tags);
  return { status: 200, body: { ok: true, mediaId, tags } };
}

export interface DuplicateDeps {
  store: GifLibraryStore;
  /** Médium smazané (sloučení) → tombstone v /media/gif. */
  mediaDeleted?: (id: string) => void;
  /** Stav / počty ponechaného média se změnily → cache /media/gif zahodit. */
  mediaChanged?: (id: string) => void;
  recordAction?: (v: { channel: string; accountId: number | null; actor: string; action: string; platform: string; targetLogin: string | null; params: object; result: object }) => Promise<void>;
  now: () => number;
  log: Log;
}

/**
 * Rozhodnutí o návrhu duplikátu. `channel` (integrace / kontrola moda) = návrh musí patřit kanálu, jinak 404.
 * keep-both → kept_both (znovu se nenavrhne); keep-first / keep-second → sloučení do ponechaného (první = starší).
 * Už rozhodnuto → 409 already_decided; médium mezitím pryč (souběh) → 409 gone.
 */
export async function resolveDuplicate(deps: DuplicateDeps, p: { id: number; action: DuplicateAction; by: string; accountId: number | null; channel?: string }): Promise<Out> {
  const d = await deps.store.getDuplicate(p.id);
  if (!d || (p.channel !== undefined && d.channel !== p.channel)) return { status: 404, body: { ok: false, error: 'not_found' } };
  if (d.status !== 'pending') return { status: 409, body: { ok: false, error: 'already_decided', status: d.status } };
  const at = new Date(deps.now());
  const record = async (result: object) => {
    try {
      await deps.recordAction?.({ channel: d.channel, accountId: p.accountId, actor: p.by, action: `gif_duplicate_${p.action.replace('-', '_')}`, platform: 'uc', targetLogin: null, params: { duplicateId: d.id, a: d.a, b: d.b }, result });
    } catch (e) { deps.log.warn({ err: (e as Error).message }, 'gif duplicity: zápis do moderation_actions selhal'); }
  };
  if (p.action === 'keep-both') {
    if (!(await deps.store.keepBoth(d.id, p.by, at))) return { status: 409, body: { ok: false, error: 'already_decided', status: 'kept_both' } };
    await record({ ok: true });
    return { status: 200, body: { ok: true, id: d.id, action: p.action } };
  }
  const [keep, drop] = p.action === 'keep-first' ? [d.a, d.b] : [d.b, d.a];
  const merged = await deps.store.mergeInto(d.id, keep, drop, at);
  if (!merged.ok) {
    return merged.error === 'already_decided'
      ? { status: 409, body: { ok: false, error: 'already_decided', status: merged.status } }
      : { status: 409, body: { ok: false, error: 'gone' } };
  }
  deps.mediaDeleted?.(drop);
  deps.mediaChanged?.(keep);
  await record({ ok: true, kept: keep, removed: drop });
  deps.log.info({ channel: d.channel, duplicateId: d.id, action: p.action }, 'gif duplicity: sloučeno');
  return { status: 200, body: { ok: true, id: d.id, action: p.action, kept: keep, removed: drop } };
}

// ---------------------------------------------------------------------------
// Dopočet hashů a návrhy duplikátů na pozadí
// ---------------------------------------------------------------------------

export interface PhashWorkerDeps {
  store: GifLibraryStore;
  /** lib/gifPhash.ts computePhash (null = selhalo / nástroj chybí). */
  compute: (bytes: Buffer, kind: GifKind) => Promise<string[] | null>;
  now: () => number;
  log: Log;
}

export type PhashTick = 'hashed' | 'checked' | 'idle' | 'error';

/**
 * Jeden krok = nejvýš jedno médium: nejdřív hash (rozhodnutá média bez pokusu), jinak porovnání jednoho
 * média s ostatními médii kanálu. Návrh jen pro podobnost ≥ PHASH_MIN_SCORE a dvojici bez záznamu.
 */
export function createPhashWorker(deps: PhashWorkerDeps) {
  return {
    async tick(): Promise<PhashTick> {
      try {
        const h = await deps.store.nextToHash();
        if (h) {
          let hashes: string[] | null = null;
          try { hashes = await deps.compute(h.bytes, h.kind); }
          catch (e) { deps.log.warn({ kind: h.kind, err: (e as Error).message }, 'gif phash: výpočet vyhodil výjimku'); hashes = null; }
          await deps.store.saveHash(h.id, hashes && hashes.length ? hashes : null, new Date(deps.now()));
          return 'hashed';
        }
        const c = await deps.store.nextToCheck();
        if (!c) return 'idle';
        let proposed = 0;
        for (const o of await deps.store.channelHashes(c.channel, c.id)) {
          const score = sequenceSimilarity(c.phash, o.phash);
          if (score < PHASH_MIN_SCORE) continue;
          // a = starší médium („nechat první"), b = novější.
          const older = o.createdAt.getTime() < c.createdAt.getTime() || (o.createdAt.getTime() === c.createdAt.getTime() && o.id < c.id);
          if (await deps.store.insertDuplicate({ channel: c.channel, a: older ? o.id : c.id, b: older ? c.id : o.id, score })) proposed++;
        }
        await deps.store.markChecked(c.id, new Date(deps.now()));
        if (proposed) deps.log.info({ channel: c.channel, proposed }, 'gif phash: návrhy duplikátů');
        return 'checked';
      } catch (e) {
        deps.log.warn({ err: (e as Error).message }, 'gif phash: krok selhal');
        return 'error';
      }
    },
  };
}

/**
 * Smyčka na pozadí: krok, pak pauza `intervalMs` (kroky se nepřekrývají). Nic se neděje (idle) → delší pauza.
 * Vrací zastavení.
 */
export function startPhashWorker(worker: ReturnType<typeof createPhashWorker>, intervalMs = PHASH_INTERVAL_MS, idleMs = 30_000): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const loop = async () => {
    if (stopped) return;
    const r = await worker.tick();
    if (stopped) return;
    timer = setTimeout(() => { void loop(); }, r === 'idle' || r === 'error' ? idleMs : intervalMs);
    timer.unref?.();
  };
  timer = setTimeout(() => { void loop(); }, intervalMs);
  timer.unref?.();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
