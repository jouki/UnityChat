// Odměna „Posílání GIFů" (moderace část 4), kontrakt docs/superpowers/plans/2026-09-25-moderace-cast-2-kontrakt.md §Část 4.
//
//   GET  /media/gif/:id[?t=token]                 médium z našeho serveru (schválené/čekající veřejně, zamítnuté jen s tokenem)
//   POST /moderation/gif/:requestId/decide        (Bearer, mod kanálu žádosti) { approve: boolean }; pozdní → 409 { status, decidedBy }
//   GET  /moderation/gif/pending?channel=         (Bearer, mod) čekající žádosti kanálu, FIFO
//   POST /moderation/gif/access-token             (Bearer, mod) vydá/obnoví vlastní token pro zamítnutá média (jen jednou)
//   GET  /moderation/gif/rejected?channel&before  (Bearer, mod) zamítnuté GIFy kanálu
//   GET  /moderation/gif/{withdrawn|purging}?channel&before  (Bearer, mod) zahozené: Stažené GIFy / Ke smazání
//   POST /moderation/gif/:mediaId/{approve|vault|purge|ban12h|unapprove|restore|remove-file}  (Bearer, mod kanálu média;
//        unapprove = odebrat schválený z knihovny → zamítnutý; purge { keepMessages } = trvale zahodit schválený
//        i zamítnutý: true → withdrawn (zprávy nechat), jinak → purging (i se zprávami, 7 dní); restore = jen purging;
//        remove-file = jen withdrawn → unavailable)
//   GET  /gif/state?channel=&platform=&review=1   (Bearer) cooldown + režim odměny pro vlastní účet (bublina u pole)
//
// Médium: Content-Type podle ověřeného druhu, CSP default-src 'none', nosniff; čekající, zamítnuté a purging
// `private, no-store` (zamítnuté a purging jen s tokenem), schválené a stažené (withdrawn) `public, max-age=300`,
// unavailable 404. Paměťová cache se sdílenými načteními — schválený GIF si stáhnou všichni naráz.
import type { FastifyInstance, FastifyReply, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import { requireWebSession, listIdentities, type PublicIdentity } from '../lib/webAuth.js';
import { accountModIdentities, chatRole, type ChatRole } from '../lib/chatRole.js';
import { gifAccess, type GifAccess, type GifAccessQuery, type GifMode } from '../lib/gifAccess.js';
import { workspaceForChannel, type Platform } from '../lib/zidolista.js';
import { registryPlatformChannel } from '../lib/platformChannels.js';
import { MEDIA_ID_RE, gifMediaUrl, isGifMessageId } from '../lib/gifIds.js';
import { pendingView, GIF_MEDIA_ACTIONS, GIF_REJECTED_REASON, REJECTED_RETENTION_MS, type GifDiscardedStatus, type GifFlow, type GifMediaInfo, type GifMediaStatus, type GifStatus, type GifStore } from '../lib/gifRequests.js';
import { ACCOUNT_TOKEN_TTL_MS, createGifTokenVerifier, dbGifTokenStore, issueAccountToken, type GifTokenVerifier } from '../lib/gifTokens.js';
import { parseChannel } from './moderation.js';
import { RateLimiter, toClientMessage, parseMessageKeys, dbMessageRowsByKeys, gifMediaGone, type ClientMessage, type GifGone } from './chat.js';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { moderationActions, type Message } from '../db/schema.js';
import { dbGifLibraryStore, duplicateView, libraryErrorReply, libraryPage, resolveDuplicate, DUPLICATE_ACTIONS, DUPLICATES_PAGE, type DuplicateDeps, type GifLibraryStore } from '../lib/gifLibrary.js';
import { channelMatches } from '../lib/messageDeletes.js';
import { publishRestored } from '../lib/linkRestore.js';
import { GIF_MAX_BYTES, type MediaProber } from '../lib/gifMedia.js';
import type { ClientFetchGrants } from '../lib/gifClientFetch.js';

export type MediaEntry = { bytes: Buffer; contentType: string; status: Exclude<GifMediaStatus, 'unavailable'>; channel?: string | null };
/** Médium bez bajtů (stav + kanál kvůli tokenu) — ověřuje se dřív, než se z DB načtou bajty (audit SEC-2). */
export type MediaMeta = Omit<MediaEntry, 'bytes'>;
/** Brána vydání média (token u zamítnutých / purging); volá se nad metadaty i nad načteným médiem. */
export type MediaGate = (m: MediaMeta) => Promise<boolean>;

export interface GifRouteOpts {
  flow: GifFlow;
  store: GifStore;
  /** Sdílené médium (server ho čistí při propadnutí/zahození/retenci, invaliduje při změně stavu, předehřívá při schválení). */
  media: MediaServer;
  /** Tokeny pro zamítnutá média (testy); chybí = DB (lib/gifTokens.ts). */
  tokens?: { issue: (accountId: number) => Promise<string>; verify: GifTokenVerifier };
  /** Ověření session (testy); chybí = requireWebSession. */
  auth?: preHandlerAsyncHookHandler;
  /** Identity moda kanálu (testy); chybí = accountModIdentities. */
  modIdentities?: (accountId: number, channel: string) => Promise<Array<{ platform: string; login: string }>>;
  /** GET /gif/state (testy); chybí = DB, registr Židolišty, gifAccess. */
  stateDeps?: GifStateDeps;
  /** GET /gif/held (testy); chybí = flow, store, DB, registr. */
  heldDeps?: GifHeldDeps;
  /** Knihovna + návrhy duplikátů (testy); chybí = DB (lib/gifLibrary.ts). */
  library?: GifLibraryStore;
  /** Audit rozhodnutí o duplikátech (testy); chybí = moderation_actions. */
  recordAction?: DuplicateDeps['recordAction'];
  /** Granty pro stažení GIFu prohlížečem odesílatele (Task 3, spec 2026-09-29 §6); chybí = /gif/client-upload vrací 503. */
  grants?: ClientFetchGrants;
  /** Sonda nahraných bajtů (stejná jako u serverového stažení) — rozměry/počet snímků nad limit → bad_media/too_large. */
  probe?: MediaProber;
  /** Předvolba klienta „stahovat sám" (Task 6); chybí = zaškrtnutí „Nezobrazovat znovu" se nezapamatuje. */
  prefs?: { getClientFetch(accountId: number): Promise<'ask' | 'always' | 'never'>; setClientFetch(accountId: number, v: 'ask' | 'always' | 'never'): Promise<void> };
}

const DecideBody = z.object({ approve: z.boolean() });
const IdParam = z.object({ requestId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) });

/**
 * Cache-Control podle stavu: čekající médium vidí jen modi a odesílatel a může být zamítnuté, zamítnuté jde jen
 * s tokenem → nikam neukládat; schválené → 5 minut, bez `immutable` (odebrání z knihovny / zahození se
 * v prohlížečích a na proxy projeví nejpozději do 5 minut; rozhodnutí 2026-09-26).
 */
export function mediaCacheControl(status: MediaEntry['status']): string {
  // Stažený GIF (withdrawn, „Zahodit, zprávy nechat“) staré zprávy dál ukazují veřejně jako schválený.
  return status === 'approved' || status === 'withdrawn' ? 'public, max-age=300' : 'private, no-store';
}

/** Stav média, které se vydá jen s tokenem moda / integrace: zamítnuté a zahozené i se zprávami (náhled „Ke smazání“). */
const TOKEN_ONLY: ReadonlySet<string> = new Set(['rejected', 'purging']);

/**
 * Smí se médium vydat? Schválené a stažené (veřejné, i Discord embed) a čekající (náhodné id) ano; zamítnuté
 * a purging jen s tokenem `?t=` platným pro kanál média (mod kanálu / integrace jeho workspace). Jinak 404
 * (neprozradit existenci). Unavailable (soubor smazán) sem vůbec nedojde (servableMedia → null).
 */
export async function mediaAllowed(m: MediaMeta, token: string | undefined, verify: (t: string | undefined, channel: string) => Promise<boolean>): Promise<boolean> {
  if (!TOKEN_ONLY.has(m.status)) return true;
  if (!m.channel) return false;
  return verify(token, m.channel);
}

/** Kurzor `<rejectedAt ms>:<mediaId>` → hodnota pro listRejected; chybí → null; neplatný → false. */
export function parseRejectedCursor(raw: string | undefined): { at: Date; id: string } | null | false {
  if (raw === undefined || raw === '') return null;
  const m = /^(\d{1,15}):([a-f0-9]{32})$/.exec(String(raw));
  if (!m || !(Number(m[1]) > 0)) return false;
  return { at: new Date(Number(m[1])), id: m[2] };
}

/** Zamítnuté médium → položka záložky „Zamítnuté GIFy" (URL bez tokenu — klient ho přidá sám). */
export function rejectedView(md: GifMediaInfo) {
  const at = md.rejectedAt ? md.rejectedAt.getTime() : null;
  return {
    mediaId: md.id, url: gifMediaUrl(md.id), kind: md.kind, width: md.width, height: md.height, tags: md.tags ?? [],
    rejectedAt: at, rejectedBy: md.rejectedBy, vault: md.vault,
    deleteAt: md.vault || at === null ? null : at + REJECTED_RETENTION_MS,
  };
}

/**
 * Zahozené médium → položka sekce „Stažené GIFy“ (withdrawn) / „Ke smazání“ (purging): kdy a kým zahozeno, kdy
 * se smaže (jen purging), kam se obnoví (`restoreTo` = stav před zahozením). URL bez tokenu (purging ho potřebuje).
 */
export function discardedView(md: GifMediaInfo) {
  return {
    mediaId: md.id, url: gifMediaUrl(md.id), kind: md.kind, width: md.width, height: md.height, tags: md.tags ?? [],
    status: md.status, purgedAt: md.purgedAt ? md.purgedAt.getTime() : null, purgedBy: md.purgedBy ?? null,
    purgeAt: md.purgeAt ? md.purgeAt.getTime() : null, restoreTo: md.statusBeforePurge === 'approved' ? 'approved' : 'rejected',
  };
}

/** Stránka zahozených (UC mod i integrace): `{ ok, items, nextBefore }`, kurzor `<purgedAt ms>:<mediaId>`. */
export async function discardedPage(store: Pick<GifStore, 'listDiscarded'>, channel: string, status: GifDiscardedStatus, before: { at: Date; id: string } | null) {
  const rows = await store.listDiscarded(channel, status, before, DISCARDED_PAGE);
  const items = rows.map(discardedView);
  const last = items[items.length - 1];
  return { ok: true, items, nextBefore: rows.length === DISCARDED_PAGE && last?.purgedAt != null ? `${last.purgedAt}:${last.mediaId}` : null };
}
export const DISCARDED_PAGE = 50;
export const DISCARDED_STATUSES = ['withdrawn', 'purging'] as const satisfies readonly GifDiscardedStatus[];

/** Tělo akce nad médiem: `keepMessages` jen boolean (u purge; chybí = i se zprávami). null = neplatné. */
export function parseMediaActionBody(body: unknown): { keepMessages: boolean } | null {
  const k = body && typeof body === 'object' ? (body as Record<string, unknown>).keepMessages : undefined;
  if (k !== undefined && typeof k !== 'boolean') return null;
  return { keepMessages: k === true };
}

/** Jak dlouho smí schválené / stažené médium zůstat v paměťové cache bez načtení z DB (audit L7). */
export const MEDIA_CACHE_TTL_MS = 10 * 60_000;
const MEDIA_GEN_MAX = 10_000;

/**
 * Médium z DB pro GET /media/gif/:id:
 * - LRU cache v paměti (strop v bajtech, TTL 10 min) se stavem žádosti;
 * - souběžná čtení téhož id sdílí jedno rozpracované načtení (bytea jde z Postgresu v hexu = 2× velikost;
 *   stovky diváků hned po schválení by jinak držely stovky kopií naráz);
 * - tombstone: id smazané/zamítnuté/propadlé se už nevrátí, ani když načtení z DB běželo souběžně se smazáním.
 */
export class MediaServer {
  private m = new Map<string, MediaEntry>();
  private size = 0;
  private inflight = new Map<string, Promise<MediaEntry | null>>();
  private tombstones = new Set<string>();
  /** Kdy se položka dostala do cache (TTL). */
  private at = new Map<string, number>();
  /**
   * Generace: invalidate(id) = globálně rostoucí pořadí. Načtení se uloží jen, když od jeho začátku médium nikdo
   * neinvalidoval. Přeplnění vyhazuje nejstarší záznamy a pamatuje si nejvyšší vyhozenou generaci (`genFloor`) —
   * dřív clear() vrátil vše na 0 a zastaralé načtení se uložilo (audit B4).
   */
  private gen = new Map<string, number>();
  private seq = 0;
  private genFloor = 0;
  /**
   * `loadMeta` (produkce: servableMeta): stav a kanál bez bajtů. S branou v `get` se nejdřív ověří metadata a bajty
   * se z DB načtou až po průchodu (audit SEC-2 — jinak každý požadavek bez tokenu na zamítnuté médium tahal až 10 MB).
   */
  constructor(
    private readonly load: (id: string) => Promise<MediaEntry | null>,
    private readonly maxBytes = 64 * 1024 * 1024,
    private readonly loadMeta?: (id: string) => Promise<MediaMeta | null>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Médium od `since` (seq) neinvalidované? Vyhozená generace (přeplnění) se bere jako možná změna. */
  private unchangedSince(id: string, since: number): boolean {
    return (this.gen.get(id) ?? this.genFloor) <= since;
  }

  /**
   * Cachuje se JEN veřejné médium se stálým stavem: schválené a stažené (withdrawn). Změnu stavu (odebrání,
   * zahození, odstranění souboru) hlásí flow přes invalidate / forget. Čekající, zamítnuté a purging se čtou vždy
   * z DB (souběžná čtení sdílí jedno načtení) — stav se mění rozhodnutím, propadnutím, obnovou.
   * `gate` (token): false → null; ověřuje se nad metadaty (před bajty) i nad načteným médiem (stav se mohl změnit).
   */
  async get(id: string, gate?: MediaGate): Promise<MediaEntry | null> {
    if (this.tombstones.has(id)) return null;
    let hit = this.m.get(id);
    if (hit && this.now() - (this.at.get(id) ?? 0) >= MEDIA_CACHE_TTL_MS) { this.drop(id); hit = undefined; }
    if (hit) {
      this.m.delete(id); this.m.set(id, hit);
      return !gate || (await gate(hit)) ? hit : null;
    }
    if (gate && this.loadMeta) {
      const meta = await this.loadMeta(id);
      if (!meta || this.tombstones.has(id) || !(await gate(meta))) return null;
    }
    const v = await this.loadShared(id);
    return v && (!gate || (await gate(v))) ? v : null;
  }

  private loadShared(id: string): Promise<MediaEntry | null> {
    let p = this.inflight.get(id);
    if (!p) {
      const since = this.seq;
      const mine: Promise<MediaEntry | null> = this.load(id).then((v) => {
        // Smazáno během načítání → nevracet a necachovat.
        if (!v || this.tombstones.has(id)) return null;
        // Stav se mezitím změnil (invalidate) → vrátit, ale necachovat.
        if ((v.status === 'approved' || v.status === 'withdrawn') && this.unchangedSince(id, since)) this.put(id, v);
        return v;
      }).finally(() => { if (this.inflight.get(id) === mine) this.inflight.delete(id); });
      p = mine;
      this.inflight.set(id, p);
    }
    return p;
  }

  /** Schváleno: médium do cache jako approved před rozesláním zprávy (diváci přijdou naráz). */
  async prewarm(id: string): Promise<void> {
    const cur = this.m.get(id);
    if (cur) { cur.status = 'approved'; return; }
    this.invalidate(id);
    const since = this.seq;
    const v = await this.load(id).catch(() => null);
    // Mezitím odebráno z knihovny / zahozeno (invalidate) → nevkládat jako approved (audit L7).
    if (v && !this.tombstones.has(id) && this.unchangedSince(id, since)) this.put(id, { ...v, status: 'approved' });
  }

  /** Stav média se změnil → zahodit z cache i rozběhnuté načtení, další čtení z DB. */
  invalidate(id: string): void {
    this.gen.delete(id);
    this.gen.set(id, ++this.seq);
    while (this.gen.size > MEDIA_GEN_MAX) {
      const [k, g] = this.gen.entries().next().value!;
      this.gen.delete(k);
      this.genFloor = Math.max(this.genFloor, g);
    }
    this.inflight.delete(id);
    this.drop(id);
  }

  private drop(id: string): void {
    const v = this.m.get(id);
    if (v) { this.size -= v.bytes.length; this.m.delete(id); }
    this.at.delete(id);
  }

  /** Médium smazané (propadlé, trvale zahozené, retence) → pryč a už nikdy nevracet. */
  forget(id: string): void {
    this.tombstones.add(id);
    if (this.tombstones.size > 10_000) this.tombstones.delete(this.tombstones.values().next().value!);
    this.drop(id);
  }

  private put(id: string, v: MediaEntry): void {
    if (v.bytes.length > this.maxBytes) return;
    const old = this.m.get(id);
    if (old) { this.size -= old.bytes.length; this.m.delete(id); }
    this.m.set(id, v); this.size += v.bytes.length;
    this.at.set(id, this.now());
    for (const [k, e] of this.m) { if (this.size <= this.maxBytes) break; this.m.delete(k); this.at.delete(k); this.size -= e.bytes.length; }
  }

  get _inflightSize(): number { return this.inflight.size; }
}

// ---------------------------------------------------------------------------
// GET /gif/state — cooldown odměny pro vlastní účet (bublina nad polem pro psaní, core/gif-cooldown.js)
// ---------------------------------------------------------------------------

export interface GifStateDeps {
  workspaceSlug: (channel: string) => Promise<string | null>;
  identities: (accountId: number) => Promise<Array<Pick<PublicIdentity, 'platform' | 'login' | 'platformUserId'>>>;
  platformChannel: (channel: string, platform: Platform) => Promise<string | null>;
  role: (platform: Platform, login: string, platformChannel: string) => Promise<ChatRole>;
  access: (q: GifAccessQuery) => Promise<GifAccess | null>;
  now: () => number;
}

export interface GifStateView {
  ok: true;
  /** Smí teď GIF poslat (odemčeno a nevypršelo; cooldown se hlásí zvlášť). */
  allowed: boolean;
  /** Konec cooldownu v čase SERVERU (ms), null = bez cooldownu. Klient přepočte přes serverNow. */
  cooldownUntil: number | null;
  /** Délka cooldownu odměny (s) — klient ji po odeslání GIFu nastaví lokálně. */
  cooldownSec: number;
  serverNow: number;
  /** Režim odměny (`approved` = jen GIFy z knihovny, platí i pro mody); bez odpovědi Židolišty `all`. */
  mode: GifMode;
  /** Cooldown celého chatu (s) ze Židolišty — jen k zobrazení (`cooldownUntil` už je pozdější z obou). */
  cooldownGlobalSec: number;
  /** Konec odemčené odměny v čase SERVERU (ms), null = bez konce / neodemčeno — časový pásek u ikony emotů. */
  rewardUntil?: number | null;
}

/**
 * Stav odměny pro identitu účtu na platformě, kam uživatel píše (`platform`, jinak první propojená).
 * Stejný zdroj jako zachycení v ingestu: role z badge v archivu (chatRole), přístup gifAccess (cache 60 s
 * + lokální cooldown po schválení). Mod bez výjimky (od 2026-09-27); `review` (Dev mód) stav nemění.
 */
export async function gifStateFor(accountId: number, q: { channel: string; platform?: Platform | null; review?: boolean }, deps: GifStateDeps): Promise<GifStateView> {
  const now = deps.now();
  const none: GifStateView = { ok: true, allowed: false, cooldownUntil: null, cooldownSec: 0, serverNow: now, mode: 'all', cooldownGlobalSec: 0 };
  const slug = await deps.workspaceSlug(q.channel);
  if (!slug) return none;
  const ids = await deps.identities(accountId);
  const ident = (q.platform ? ids.find((i) => i.platform === q.platform) : null) ?? (q.platform ? null : ids[0]);
  if (!ident) return none;
  const pc = ident.platform === 'twitch' ? q.channel : await deps.platformChannel(q.channel, ident.platform);
  const role = pc ? await deps.role(ident.platform, ident.login, pc) : 'viewer';
  const a = await deps.access({ workspace: slug, platform: ident.platform, userId: ident.platformUserId, login: ident.login.toLowerCase(), role });
  const extra = { mode: a?.mode ?? 'all', cooldownGlobalSec: a?.cooldownGlobalSec ?? 0 } as const;
  // Mod / broadcaster bez výjimky: odemčení, cooldown i pásek ze Židolišty stejně jako divák (spec 2026-09-27-gif-review-upravy
  // §5; Židolišta dostává roli). S `review` (Dev mód) je proto stav stejný; parametr zůstává kvůli kompatibilitě klientů.
  if (!a) return none;
  return {
    ok: true,
    allowed: a.allowed && (a.until === null || a.until > now),
    cooldownUntil: a.cooldownUntil !== null && a.cooldownUntil > now ? a.cooldownUntil : null,
    cooldownSec: a.cooldownSec,
    serverNow: now,
    rewardUntil: a.allowed && a.until !== null && a.until > now ? a.until : null,
    ...extra,
  };
}

const defaultStateDeps: GifStateDeps = {
  workspaceSlug: async (channel) => (await workspaceForChannel('twitch', channel))?.slug ?? null,
  identities: (accountId) => listIdentities(accountId),
  platformChannel: (channel, platform) => registryPlatformChannel(channel, platform),
  role: (platform, login, pc) => chatRole(platform, login, pc),
  access: (q) => gifAccess(q),
  now: Date.now,
};

// ---------------------------------------------------------------------------
// GET /gif/held — pojistka klientů: zpráva schovaná jako gif_request bez rozhodnutí (core GifHoldWatch)
// ---------------------------------------------------------------------------

/** Max zpráv v jednom dotazu. */
export const GIF_HELD_BATCH = 50;

export type GifHeldState = 'held' | 'visible' | 'deleted' | 'replaced' | 'unknown';
/**
 * `status` = stav žádosti o GIF k té zprávě (pending | approved | rejected | expired | deleted), když žádost existuje —
 * odesílatel podle něj usadí štítek u vlastní zprávy (core GifOutbox), když se `gif-decided` ztratilo.
 */
export interface GifHeldItem { platform: Platform; messageId: string; state: GifHeldState; reason?: string; message?: ClientMessage; status?: GifStatus }

export interface GifHeldDeps {
  inFlight: (platform: Platform, messageId: string) => boolean;
  /** Stav poslední žádosti ke zprávám jedním dotazem (`<platform>:<messageId>` → stav; bez žádosti chybí). */
  requestStatuses: (keys: Array<{ platform: Platform; messageId: string }>) => Promise<Map<string, GifStatus>>;
  /** Řádky zpráv kanálů `channels` podle klíčů jedním dotazem (chat.ts dbMessageRowsByKeys). */
  rows: (channels: string[], keys: Array<{ platform: Platform; messageId: string }>) => Promise<Message[]>;
  /** Média GIFů, jejichž zprávy už nejsou veřejné (chat.ts gifMediaGone); chybí = DB. */
  gone?: (rows: Message[]) => Promise<GifGone>;
  platformChannel: (channel: string, platform: Platform) => Promise<string | null>;
  /** Obnovení zaseknutého gif_request (publishRestored — message-restored všem). */
  restore: (p: { channel: string; platform: Platform; messageId: string; platformChannel: string }) => Promise<string>;
  /** Přeznačení gif_request → gif_rejected (žádost rozhodnutá, archiv pozadu). */
  retag: (platform: Platform, messageId: string, from: string, to: string) => Promise<boolean>;
  log?: { info: (o: object, m: string) => void };
}

/** `twitch:abc,kick:def` → klíče (nejvýš GIF_HELD_BATCH, bez duplicit, jen platné). */
export function parseHeldIds(raw: string | undefined): Array<{ platform: Platform; messageId: string }> {
  return parseMessageKeys(raw, GIF_HELD_BATCH);
}

/**
 * Stav zpráv, které klient drží schované jako gif_request déle než 30 s (server rozhodnutí neposlal, nebo
 * se ztratilo — výpadek SSE). Dávkově: jeden dotaz na řádky, jeden na stavy žádostí (audit C1).
 *  - syntetická zpráva `gif-<n>` → `unknown` (klient drží jen původní zprávy; sekvenční id by šla projít a vydat
 *    text GIFu, který mod schoval — audit SEC-3);
 *  - zachycení ještě běží / žádost čeká → `held` (klient se zeptá znovu);
 *  - žádost schválena → `replaced` (GIF ji nahradil, zůstává schovaná); zamítnuta/propadla → `deleted` gif_rejected;
 *    se žádostí navíc `status` (stav žádosti — odesílatel podle něj usadí štítek, když se gif-decided ztratilo);
 *  - řádek v archivu nesmazaný → `visible` + zpráva ve veřejném tvaru (jako /chat/history: skrytá bez obsahu,
 *    GIF, který už není veřejný → `deleted` gif_removed bez textu); smazaný jiným důvodem → `deleted` + důvod;
 *  - zaseknutý gif_request bez žádosti a bez běžícího zachycení (převod selhal a rozhodnutí se neuložilo,
 *    restart serveru) → obnovit (fail-open: na platformě zpráva zůstala, bot maže až po úspěšném převodu)
 *    a `visible`; message-restored jde zároveň všem;
 *  - zpráva mimo kanál / v archivu není → `unknown`.
 */
export async function gifHeldState(channel: string, keys: Array<{ platform: Platform; messageId: string }>, deps: GifHeldDeps): Promise<GifHeldItem[]> {
  const kk = (k: { platform: string; messageId: string }) => `${k.platform}:${k.messageId}`;
  const pcs = new Map<Platform, string | null>();
  for (const k of keys) if (!isGifMessageId(k.messageId) && !pcs.has(k.platform)) pcs.set(k.platform, await deps.platformChannel(channel, k.platform));
  // Klíče, na které se má smysl ptát DB: ne syntetické, ne rozpracované, platforma s kanálem v registru.
  const ask = keys.filter((k) => !isGifMessageId(k.messageId) && !deps.inFlight(k.platform, k.messageId) && pcs.get(k.platform));
  const channels = [...new Set([...pcs.values()].filter((c): c is string => !!c))];
  const rows = ask.length && channels.length ? await deps.rows(channels, ask) : [];
  const rowBy = new Map<string, Message>();
  for (const r of rows) if (channelMatches(r.channel, pcs.get(r.platform as Platform))) rowBy.set(`${r.platform}:${r.platformMessageId}`, r);
  const withRow = ask.filter((k) => rowBy.has(kk(k)));
  const statuses = withRow.length ? await deps.requestStatuses(withRow) : new Map<string, GifStatus>();
  // Zprávy, které můžou jít ven s obsahem: GIF, který už není veřejný, jde jako smazaný (jako /chat/history).
  const shown = withRow.map((k) => rowBy.get(kk(k))!).filter((r) => !statuses.has(`${r.platform}:${r.platformMessageId}`) && (!r.deletedAt || r.deletedReason === GIF_HELD));
  const gone: GifGone = shown.length ? await (deps.gone ?? gifMediaGone)(shown) : new Set<string>();
  const publicItem = (base: { platform: Platform; messageId: string }, r: Message): GifHeldItem => {
    const msg = toClientMessage(r, true, gone);
    return msg.deleted ? { ...base, state: 'deleted', reason: msg.deletedReason ?? 'mod' } : { ...base, state: 'visible', message: msg };
  };
  const out: GifHeldItem[] = [];
  for (const { platform, messageId } of keys) {
    const base = { platform, messageId };
    if (isGifMessageId(messageId)) { out.push({ ...base, state: 'unknown' }); continue; }
    if (deps.inFlight(platform, messageId)) { out.push({ ...base, state: 'held' }); continue; }
    const row = rowBy.get(kk(base));
    if (!row) { out.push({ ...base, state: 'unknown' }); continue; }
    const st = statuses.get(kk(base)) ?? null;
    if (st === 'pending') { out.push({ ...base, state: 'held', status: st }); continue; }
    if (st === 'approved' || st === 'deleted') { out.push({ ...base, state: 'replaced', status: st }); continue; }
    if (st === 'rejected' || st === 'expired') {
      if (row.deletedReason === GIF_HELD) await deps.retag(platform, messageId, GIF_HELD, GIF_REJECTED_REASON).catch(() => false);
      out.push({ ...base, state: 'deleted', reason: GIF_REJECTED_REASON, status: st });
      continue;
    }
    if (!row.deletedAt) { out.push(publicItem(base, row)); continue; }
    if (row.deletedReason !== GIF_HELD) { out.push({ ...base, state: 'deleted', reason: row.deletedReason ?? 'mod' }); continue; }
    deps.log?.info({ channel, platform }, 'gif/held: zaseknutý gif_request bez žádosti → obnoveno');
    await deps.restore({ channel, platform, messageId, platformChannel: row.channel }).catch(() => 'error');
    out.push(publicItem(base, { ...row, deletedAt: null, deletedReason: null }));
  }
  return out;
}

const GIF_HELD = 'gif_request';

export default async function gifRoutes(app: FastifyInstance, opts: GifRouteOpts) {
  const mediaLimiter = new RateLimiter(60, 10);
  const modLimiter = new RateLimiter(20, 4);
  const DEFAULT_CHANNEL = (config.CHAT_INGEST_CHANNELS.split(',').find((c) => c.startsWith('twitch:'))?.split(':')[1] || 'robdiesalot').toLowerCase();
  const session = opts.auth ?? requireWebSession;
  // Výchozí no-store pro všechny odpovědi pluginu, i 401 z preHandleru a 404 média (audit L12); úspěšné médium si
  // Cache-Control nastaví podle stavu (schválené public 300 s).
  app.addHook('onRequest', async (_req, reply) => { reply.header('Cache-Control', 'no-store'); });
  const modsOf = opts.modIdentities ?? ((accountId: number, channel: string) => accountModIdentities(accountId, channel));

  const tokens = opts.tokens ?? {
    issue: (accountId: number) => issueAccountToken(accountId),
    verify: createGifTokenVerifier({
      store: dbGifTokenStore,
      isMod: async (accountId, channel) => (await modsOf(accountId, channel)).length > 0,
      slugForChannel: async (channel) => (await workspaceForChannel('twitch', channel))?.slug ?? null,
      now: Date.now,
    }),
  };

  app.get<{ Params: { id: string }; Querystring: { t?: string } }>('/media/gif/:id', async (req, reply) => {
    const id = String(req.params.id || '');
    if (!MEDIA_ID_RE.test(id)) return reply.code(404).send({ ok: false, error: 'not_found' });
    if (!mediaLimiter.allow(req.ip)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const token = typeof req.query.t === 'string' ? req.query.t : undefined;
    // Zamítnuté bez platného tokenu = 404 (jako neexistující); token se ověří nad metadaty, bajty až potom (SEC-2).
    const m = await opts.media.get(id, (x) => mediaAllowed(x, token, tokens.verify));
    if (!m) return reply.code(404).send({ ok: false, error: 'not_found' });
    return reply
      .header('Content-Type', m.contentType)
      .header('Content-Length', String(m.bytes.length))
      .header('Cache-Control', mediaCacheControl(m.status))
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cross-Origin-Resource-Policy', 'cross-origin')
      .header('Content-Disposition', 'inline')
      .send(m.bytes);
  });

  app.post('/moderation/gif/:requestId/decide', { preHandler: session }, async (req, reply) => {
    const p = IdParam.safeParse(req.params);
    const b = DecideBody.safeParse(req.body);
    if (!p.success || !b.success) return reply.code(400).send({ ok: false, error: 'body' });
    const accountId = req.webAccountId!;
    if (!modLimiter.allow(String(accountId))) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const r = await opts.store.get(p.data.requestId);
    if (!r) return reply.code(404).send({ ok: false, error: 'not_found' });
    // Kanál VŽDY z žádosti (ne od klienta) — mod jiného kanálu nerozhoduje.
    const mods = await modsOf(accountId, r.channel);
    if (!mods.length) return reply.code(403).send({ ok: false, error: 'not_mod' });
    const out = await opts.flow.decide({ requestId: r.id, approve: b.data.approve, by: `${mods[0].platform}:${mods[0].login}`, accountId });
    return reply.code(out.status).send(out.body);
  });

  app.get<{ Querystring: { channel?: string } }>('/moderation/gif/pending', { preHandler: session }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const accountId = req.webAccountId!;
    if (!modLimiter.allow(String(accountId))) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const channel = parseChannel(req.query.channel, DEFAULT_CHANNEL);
    if (!channel) return reply.code(400).send({ ok: false, error: 'channel' });
    if (!(await modsOf(accountId, channel)).length) return reply.code(403).send({ ok: false, error: 'not_mod' });
    // FIFO (created_at, id): klient ukazuje jen nejstarší kartu + „+N čeká".
    const rows = await opts.store.listPending(new Date(), channel);
    const serverNow = Date.now();
    return { ok: true, requests: rows.map((r) => ({ ...pendingView(r), serverNow })) };
  });

  // Token pro zamítnutá média (`/media/gif/:id?t=`): vydá / obnoví vlastní token účtu moda, vrací ho jen jednou.
  const tokenLimiter = new RateLimiter(5, 0.1);
  app.post<{ Body: { channel?: string } }>('/moderation/gif/access-token', { preHandler: session }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const accountId = req.webAccountId!;
    if (!tokenLimiter.allow(String(accountId))) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const channel = parseChannel(req.body?.channel, DEFAULT_CHANNEL);
    if (!channel) return reply.code(400).send({ ok: false, error: 'channel' });
    if (!(await modsOf(accountId, channel)).length) return reply.code(403).send({ ok: false, error: 'not_mod' });
    const token = await tokens.issue(accountId);
    // expiresAt (čas serveru, ms): token moda platí 30 dní (audit L1) — klient si pak vydá nový.
    return { ok: true, token, expiresAt: Date.now() + ACCOUNT_TOKEN_TTL_MS, serverNow: Date.now() };
  });

  // Zamítnuté GIFy kanálu (záložka „Zamítnuté GIFy"), nejnovější první; `before` = `<rejectedAt ms>:<mediaId>` (nextBefore).
  const REJECTED_PAGE = 50;
  app.get<{ Querystring: { channel?: string; before?: string } }>('/moderation/gif/rejected', { preHandler: session }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const accountId = req.webAccountId!;
    if (!modLimiter.allow(String(accountId))) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const channel = parseChannel(req.query.channel, DEFAULT_CHANNEL);
    if (!channel) return reply.code(400).send({ ok: false, error: 'channel' });
    const before = parseRejectedCursor(req.query.before);
    if (before === false) return reply.code(400).send({ ok: false, error: 'before' });
    if (!(await modsOf(accountId, channel)).length) return reply.code(403).send({ ok: false, error: 'not_mod' });
    const rows = await opts.store.listRejected(channel, before, REJECTED_PAGE);
    const items = rows.map(rejectedView);
    const last = items[items.length - 1];
    return { ok: true, items, nextBefore: rows.length === REJECTED_PAGE && last?.rejectedAt != null ? `${last.rejectedAt}:${last.mediaId}` : null };
  });

  // Zahozené GIFy kanálu (záložka Zamítnuté: „Stažené GIFy“ / „Ke smazání“), nejnovější zahození první;
  // `before` = `<purgedAt ms>:<mediaId>` (nextBefore).
  for (const status of DISCARDED_STATUSES) {
    app.get<{ Querystring: { channel?: string; before?: string } }>(`/moderation/gif/${status}`, { preHandler: session }, async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const accountId = req.webAccountId!;
      if (!modLimiter.allow(String(accountId))) return reply.code(429).send({ ok: false, error: 'rate_limited' });
      const channel = parseChannel(req.query.channel, DEFAULT_CHANNEL);
      if (!channel) return reply.code(400).send({ ok: false, error: 'channel' });
      const before = parseRejectedCursor(req.query.before);
      if (before === false) return reply.code(400).send({ ok: false, error: 'before' });
      if (!(await modsOf(accountId, channel)).length) return reply.code(403).send({ ok: false, error: 'not_mod' });
      try { return await discardedPage(opts.store, channel, status, before); }
      catch (e) { return libraryFail(reply, e, `moderation/gif/${status}`); }
    });
  }

  // Akce nad médiem: approve / vault (zamítnuté), purge { keepMessages } (schválené / zamítnuté), restore (purging),
  // remove-file (withdrawn), unapprove (schválené) a ban12h („Automaticky zahazovat 12 h"). Kanál z média.
  for (const action of GIF_MEDIA_ACTIONS) {
    app.post<{ Params: { requestId: string } }>(`/moderation/gif/:requestId/${action}`, { preHandler: session }, async (req, reply) => {
      // Parametr sdílí jméno s /decide (router); tady je to id média (32 hex).
      const mediaId = String(req.params.requestId || '');
      if (!MEDIA_ID_RE.test(mediaId)) return reply.code(404).send({ ok: false, error: 'not_found' });
      const body = parseMediaActionBody(req.body);
      if (!body) return reply.code(400).send({ ok: false, error: 'body' });
      const accountId = req.webAccountId!;
      if (!modLimiter.allow(String(accountId))) return reply.code(429).send({ ok: false, error: 'rate_limited' });
      const md = await opts.store.getMedia(mediaId);
      if (!md?.channel) return reply.code(404).send({ ok: false, error: 'not_found' });
      const mods = await modsOf(accountId, md.channel);
      if (!mods.length) return reply.code(403).send({ ok: false, error: 'not_mod' });
      const out = await opts.flow.mediaAction({ mediaId, action, by: `${mods[0].platform}:${mods[0].login}`, accountId, keepMessages: body.keepMessages });
      return reply.code(out.status).send(out.body);
    });
  }

  // --- GIF knihovna (Task 2) ---
  const library = opts.library ?? dbGifLibraryStore;
  const dupDeps: DuplicateDeps = {
    store: library,
    mediaDeleted: (id) => opts.media.forget(id),
    mediaChanged: (id) => opts.media.invalidate(id),
    recordAction: opts.recordAction ?? (async (v) => { await db.insert(moderationActions).values(v); }),
    now: Date.now,
    log: app.log,
  };

  /** Chyba DB knihovny: chybí tabulka / sloupec → 503 not_ready, jinak 500. */
  const libraryFail = (reply: FastifyReply, e: unknown, what: string) => {
    const out = libraryErrorReply(e);
    app.log.warn({ err: (e as Error).message, error: out.body.error }, `${what} selhalo`);
    return reply.code(out.status).send(out.body);
  };

  // Veřejné (divák bez odměny knihovnu vidí): schválené GIFy kanálu podle použití, `cursor` = nextCursor.
  const libraryLimiter = new RateLimiter(10, 5);
  app.get<{ Querystring: { channel?: string; q?: string; cursor?: string; limit?: string } }>('/gifs/library', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!libraryLimiter.allow(req.ip)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const channel = parseChannel(req.query.channel, DEFAULT_CHANNEL);
    if (!channel) return reply.code(400).send({ ok: false, error: 'channel' });
    try {
      const out = await libraryPage(library, channel, req.query);
      return reply.code(out.status).send(out.body);
    } catch (e) { return libraryFail(reply, e, 'gifs/library'); }
  });

  // Návrhy duplikátů kanálu (mod) — nejstarší první; rozhodnutí keep-first | keep-second | keep-both.
  app.get<{ Querystring: { channel?: string } }>('/moderation/gif/duplicates', { preHandler: session }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const accountId = req.webAccountId!;
    if (!modLimiter.allow(String(accountId))) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const channel = parseChannel(req.query.channel, DEFAULT_CHANNEL);
    if (!channel) return reply.code(400).send({ ok: false, error: 'channel' });
    if (!(await modsOf(accountId, channel)).length) return reply.code(403).send({ ok: false, error: 'not_mod' });
    try { return { ok: true, items: (await library.listDuplicates(channel, DUPLICATES_PAGE)).map(duplicateView) }; }
    catch (e) { return libraryFail(reply, e, 'moderation/gif/duplicates'); }
  });

  app.post<{ Params: { id: string; action: string } }>('/moderation/gif/duplicates/:id/:action', { preHandler: session }, async (req, reply) => {
    const id = Number(req.params.id);
    const action = DUPLICATE_ACTIONS.find((a) => a === req.params.action);
    if (!action || !Number.isSafeInteger(id) || id <= 0) return reply.code(404).send({ ok: false, error: 'not_found' });
    const accountId = req.webAccountId!;
    if (!modLimiter.allow(String(accountId))) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    try {
      // Kanál z návrhu (ne od klienta) — mod jiného kanálu nerozhoduje.
      const d = await library.getDuplicate(id);
      if (!d) return reply.code(404).send({ ok: false, error: 'not_found' });
      const mods = await modsOf(accountId, d.channel);
      if (!mods.length) return reply.code(403).send({ ok: false, error: 'not_mod' });
      const out = await resolveDuplicate(dupDeps, { id, action, by: `${mods[0].platform}:${mods[0].login}`, accountId, channel: d.channel });
      return reply.code(out.status).send(out.body);
    } catch (e) { return libraryFail(reply, e, 'moderation/gif/duplicates rozhodnutí'); }
  });

  const stateLimiter = new RateLimiter(10, 1);
  app.get<{ Querystring: { channel?: string; platform?: string; review?: string } }>('/gif/state', { preHandler: session }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const accountId = req.webAccountId!;
    if (!stateLimiter.allow(String(accountId))) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const channel = parseChannel(req.query.channel, DEFAULT_CHANNEL);
    if (!channel) return reply.code(400).send({ ok: false, error: 'channel' });
    const platform = ['twitch', 'kick', 'youtube'].includes(String(req.query.platform)) ? req.query.platform as Platform : null;
    try {
      return await gifStateFor(accountId, { channel, platform, review: req.query.review === '1' }, opts.stateDeps ?? { ...defaultStateDeps, access: (q) => gifAccess(q, { log: app.log }) });
    } catch (e) {
      app.log.warn({ err: (e as Error).message }, 'gif/state selhalo');
      return reply.code(503).send({ ok: false, error: 'unavailable' });
    }
  });

  // Veřejné (divák nemá účet): stav zpráv schovaných jako gif_request, které klient drží déle než 30 s.
  const heldLimiter = new RateLimiter(10, 1);
  const heldDeps: GifHeldDeps = opts.heldDeps ?? {
    inFlight: (platform, messageId) => opts.flow.isInFlight(platform, messageId),
    requestStatuses: (keys) => opts.store.statusByMessages(keys),
    rows: (channels, keys) => dbMessageRowsByKeys(channels, keys),
    platformChannel: (channel, platform) => registryPlatformChannel(channel, platform),
    restore: (p) => publishRestored({ ...p, by: 'filter', reason: 'gif_request' }),
    retag: (platform, messageId, from, to) => opts.store.retagDeleted(platform, messageId, from, to),
    log: app.log,
  };
  app.get<{ Querystring: { channel?: string; ids?: string } }>('/gif/held', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!heldLimiter.allow(req.ip)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const channel = parseChannel(req.query.channel, DEFAULT_CHANNEL);
    if (!channel) return reply.code(400).send({ ok: false, error: 'channel' });
    const keys = parseHeldIds(req.query.ids);
    if (!keys.length) return reply.code(400).send({ ok: false, error: 'ids' });
    try {
      return { ok: true, messages: await gifHeldState(channel, keys, heldDeps) };
    } catch (e) {
      app.log.warn({ err: (e as Error).message }, 'gif/held selhalo');
      return reply.code(503).send({ ok: false, error: 'unavailable' });
    }
  });

  // --- Stažení GIFu prohlížečem odesílatele (spec 2026-09-29 §6): tělo = bajty média, token v hlavičce (ne v URL — logy) ---
  const grants = opts.grants ?? null;
  const uploadByAccount = new RateLimiter(5, 5 / 60);
  const uploadByIp = new RateLimiter(20, 20 / 60);
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  // Tělo přes limit → Fastify vyhodí FST_ERR_CTP_BODY_TOO_LARGE dřív, než handler doběhne; grant by jinak visel
  // do TTL. Účet tady ještě není (preHandler s Bearer session proběhne až PO parsování těla) → jen `expire` bez
  // kontroly účtu (nic neprozradí, jen zruší čekající grant podle tokenu z hlavičky).
  app.addHook('onError', async (req, _reply, err) => {
    if ((err as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE' && req.url.startsWith('/gif/client-upload')) {
      grants?.expire(String(req.headers['x-gif-token'] || ''));
    }
  });
  app.post('/gif/client-upload', { preHandler: session, bodyLimit: GIF_MAX_BYTES + 1024 }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!grants) return reply.code(503).send({ ok: false, error: 'unavailable' });
    const acc = req.webAccountId!;
    if (!uploadByAccount.allow(String(acc)) || !uploadByIp.allow(req.ip)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const token = String(req.headers['x-gif-token'] || '');
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const r = await grants.complete(token, acc, body, opts.probe);
    if (!r.ok) {
      app.log.info({ accountId: acc, error: r.error, bytes: body.length }, 'gif: upload z prohlížeče odmítnut');
      return reply.code(400).send({ ok: false, error: r.error });
    }
    if (req.headers['x-gif-remember'] === '1') await opts.prefs?.setClientFetch(acc, 'always').catch(() => {});
    app.log.info({ accountId: acc, bytes: body.length }, 'gif: médium z prohlížeče odesílatele přijato');
    return reply.code(202).send({ ok: true });
  });

  app.post<{ Body: { token?: unknown; remember?: unknown } }>('/gif/client-fetch/decline', { preHandler: session }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const acc = req.webAccountId!;
    grants?.decline(String(req.body?.token || ''), acc);
    if (req.body?.remember === true) await opts.prefs?.setClientFetch(acc, 'never').catch(() => {});
    return { ok: true };
  });
}
