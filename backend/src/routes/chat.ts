import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
import { db } from '../db/index.js';
import { gifMedia, messages, streamers, type Message } from '../db/schema.js';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';
import { subscribeChatStream, chatStreamClientsForIp } from '../sse/chatBus.js';
import { ucSends, markUc, ucReplies, attachUcReply, parseUcReply, gifReviews } from '../lib/ucSends.js';
import { verifyUcReply } from '../lib/ucReplyVerify.js';
import { listIdentities, requireWebSession } from '../lib/webAuth.js';
import { ownsHandle } from './nicknames.js';
import { gifFromRaw, gifReplaces, gifOrigin, gifMediaIdFromRaw, gifMessageState, GIF_REMOVED_REASON, type GifMediaView } from '../lib/gifIds.js';
import { announcementsBetween, type AnnouncementPayload } from './announcements.js';
import { isDonor, donorAmount } from '../lib/donors.js';
import { authorReplacesGlobal } from '../lib/badgePrefs.js';

/**
 * `donor: true` (+ `donorCzk` = součet za 30 dní, když ho Židolišta posílá) pro autora zprávy (identita nebo jméno =
 * přezdívka donatu), `donorReplace: true` když má autor volbu „místo globálního odznaku Twitche“ (lib/badgePrefs.ts); jinak nic.
 */
export function donorFields(platform: string, channel: string, userId: string | null | undefined, username: string | null | undefined): { donor?: true; donorCzk?: number; donorReplace?: true } {
  if (!isDonor(platform, channel, userId, username)) return {};
  const czk = donorAmount(platform, channel, userId, username);
  return { donor: true, ...(czk ? { donorCzk: czk } : {}), ...(authorReplacesGlobal(platform, userId) ? { donorReplace: true } : {}) };
}

/**
 * Historie chatu pro panel (spec 2026-09-19 §3.2). Zprávy plní ingest
 * (src/ingest), tady se jen čtou: kurzorová paginace odzadu, mapování na
 * tvar, který panel dostává od živých providerů, ať má renderer jednu cestu.
 */

export interface ClientMessage {
  platform: string;
  id: string;
  username: string;
  userId: string;
  message: string;
  timestamp: number;
  color?: string | null;
  badgesRaw?: string;
  twitchEmotes?: string | null;
  twitchEmotesOffset?: number;
  firstMsg?: boolean;
  isAction?: boolean;
  /** platform + uc: odpověď napříč platformami nahlášená UnityChatem (content_raw.ucReply). */
  /** login = login autora citované zprávy, když ho platforma dává (Twitch reply-parent-user-login). */
  replyTo?: { username: string; message: string; id: string; login?: string; platform?: string; uc?: boolean; authorUc?: boolean } | null;
  kickContent?: string;
  ytRuns?: unknown[];
  superChat?: boolean;
  /** true = z /chat/history (DB), false = živě z /chat/stream (ingest, před zápisem). */
  historical: boolean;
  /** Odesláno z UnityChatu bez markeru (command) — server to ví z hlášení odeslání (lib/ucSends.ts). */
  uc?: boolean;
  /** Smazáno modem/platformou/link filtrem (lib/messageDeletes.ts) — obsah pod tímto se nikdy neposílá. */
  deleted?: boolean;
  deletedReason?: string | null;
  /** „Jen UC skrýt“ (lib/messageHides.ts) — na platformě zpráva zůstává, UC ji nevykreslí; obsah se neposílá. */
  hidden?: boolean;
  segments?: unknown[];
  /** Schválený GIF (moderace část 4): syntetická zpráva `gif-<id>`, médium z našeho serveru. */
  gif?: GifMediaView;
  /** Odpověď potlačená kvůli UnityChat announcementu (lib/anncHides.ts) — klient nevykreslí. */
  anncHidden?: boolean;
  /** Announcement jako položka historie (announcementMessage). */
  ucAnnouncement?: unknown;
  /** Autor donatoval v posledních 30 dnech (lib/donors.ts) → odznak dárce; `donorCzk` = součet za okno v Kč (tooltip);
   *  `donorReplace` = odznak UC místo globálních odznaků Twitche (volba účtu, lib/badgePrefs.ts). */
  donor?: boolean;
  donorCzk?: number;
  donorReplace?: boolean;
  /**
   * Jen GIFy schválené před 2026-09-26: nahrazuje původní zprávu (`<platform>:<messageId>`) na jejím místě.
   * Nové schválené GIFy jdou na konec chatu (čas schválení) a nesou jen `gifOrigin`.
   */
  replaces?: string;
  /** Schválený GIF: původní zpráva s odkazem (`<platform>:<messageId>`) — klient jen páruje (optimistická zpráva odesílatele), nic nenahrazuje. */
  gifOrigin?: string;
  /**
   * JEN Profil moda (lib/userHistory.ts buildMessages, spec 2026-09-27-gif-review-upravy §3): médium GIFu už není
   * v knihovně (zamítnuté / odebrané, purging, withdrawn) → klient ho vykreslí rozmazaně (klik = zaostřit);
   * `gifStatus` říká, jestli náhled potřebuje token moda (rejected / purging).
   */
  gifHidden?: true;
  gifStatus?: 'rejected' | 'purging' | 'withdrawn';
  /** Twitch USERNOTICE sub / resub z logu (content_raw.notice) — stejná pole jako core/twitch-irc.js. */
  isSubEvent?: true;
  subPlan?: string;
  subMonths?: number | null;
  subStreak?: number | null;
  /** Twitch USERNOTICE modiversary (moderátorské výročí) z logu — stejná pole jako core/twitch-irc.js. */
  isModiversary?: true;
  modMonths?: number;
}

/** content_raw.notice (ingest normalizeTwitchUsernotice) → pole zprávy, která zná klientský renderer. */
function noticeFields(raw: Record<string, unknown>): Partial<ClientMessage> {
  const n = raw.notice as { type?: string; months?: number | null; streak?: number | null; plan?: string } | undefined;
  if (!n || typeof n !== 'object') return {};
  if (n.type === 'modiversary') return { isModiversary: true, modMonths: Number(n.months) || 0 };
  if (n.type === 'sub' || n.type === 'resub') return { isSubEvent: true, subPlan: String(n.plan || '1000'), subMonths: n.months ?? null, subStreak: n.streak ?? null };
  return {};
}

/** Stav média → zpráva v Profilu moda: rozmazaný GIF (zamítnuté, zahozené), štítek (soubor / médium pryč), jinak normálně. */
export type ProfileGifView = 'visible' | 'hidden' | 'unavailable';
export function profileGifView(status: string | undefined): ProfileGifView {
  if (status === 'approved' || status === 'pending') return 'visible';
  if (status === 'rejected' || status === 'purging' || status === 'withdrawn') return 'hidden';
  return 'unavailable';
}

/**
 * Zpráva pro Profil moda: jako toClientMessage, ale zpráva s GIFem, jehož médium už veřejné není, se NEposílá jako
 * smazaná (`gif_removed`) — mod ji vidí s textem a rozmazaným GIFem (`gifHidden`), soubor / médium pryč = štítek.
 * Smazané a skryté zprávy (mod, platforma, filtr) jdou jako dosud. `statuses` = id média → stav (gifMediaStatuses).
 */
export function toProfileMessage(row: ClientRow, statuses: ReadonlyMap<string, string> | null): ClientMessage {
  const out = toClientMessage(row, true);
  // Stav médií se nepodařilo načíst → GIF jako dosud (klient při 404 napíše „GIF odebrán“).
  const id = statuses && !row.deletedAt && !row.hiddenAt && out.gif ? gifMediaIdFromRaw(row.contentRaw) : null;
  if (!id) return out;
  const st = statuses!.get(id);
  const view = profileGifView(st);
  if (view === 'unavailable') out.gif = { ...out.gif!, unavailable: true };
  else if (view === 'hidden') { out.gifHidden = true; out.gifStatus = st as ClientMessage['gifStatus']; }
  return out;
}

/** Stav médií GIFů v `rows` (id → status; chybějící = médium neexistuje). Bez GIFů se DB nevolá; chyba DB → null. */
export async function gifMediaStatuses(rows: ReadonlyArray<Pick<ClientRow, 'contentRaw'>>, lookup: GifMediaStatusLookup = dbGifMediaStatus): Promise<Map<string, string> | null> {
  const ids = [...new Set(rows.map((r) => gifMediaIdFromRaw(r.contentRaw)).filter((x): x is string => !!x))];
  if (!ids.length) return new Map();
  try { return await lookup(ids); } catch { return null; }
}

/**
 * Pole, která mapování potřebuje — DB řádek (Message) i čerstvý řádek z ingestu (toRow) je mají.
 * deletedAt/deletedReason jsou tu volitelné: živé zprávy z ingestu nikdy nejsou smazané v okamžiku
 * emitu (viz server.ts onLive), takže NewMessage je vůbec nenese.
 */
export type ClientRow = Pick<Message, 'platform' | 'platformMessageId' | 'platformUserId' | 'platformUsername' | 'content' | 'sentAt'> & {
  contentRaw?: unknown;
  /** Platformní kanál (dárce podle workspace, lib/donors.ts). */
  channel?: string;
  isReply?: boolean | null;
  replyToMessageId?: string | null;
  isUnitychatUser?: boolean | null;
  deletedAt?: Date | null;
  deletedReason?: string | null;
  hiddenAt?: Date | null;
};

/**
 * Řádek z DB (nebo z ingestu) → tvar, který panel dostává od providerů (renderer má jednu cestu).
 * `goneGifs` = id médií, která už nejsou veřejná (gifMediaGone) — zpráva se schváleným GIFem na takové médium
 * jde jako smazaná (`gif_removed`) bez obsahu a bez `gif`.
 */
export function toClientMessage(row: ClientRow, historical = true, goneGifs?: GifGone): ClientMessage {
  // Smazaná / skrytá zpráva: text, emoty i reply-to zůstávají jen v DB (audit) — klient nikdy nedostane obsah.
  const meta = {
    platform: row.platform,
    id: row.platformMessageId,
    username: row.platformUsername,
    userId: row.platformUserId,
    message: '',
    timestamp: row.sentAt.getTime(),
    historical,
    // Zlaté logo i bez textu (marker UnityChatu je v textu, který se smazané zprávě neposílá).
    ...(row.isUnitychatUser ? { uc: true } : {}),
  };
  if (row.deletedAt) return { ...meta, deleted: true, deletedReason: row.deletedReason };
  if (row.hiddenAt) return { ...meta, hidden: true, segments: [] };
  // GIF odebraný z knihovny / trvale zahozený: bez obsahu (text nad GIFem patří k GIFu), klient „Zpráva smazána“, OBS skryje.
  const gifId = goneGifs?.size || goneGifs?.unavailable?.size ? gifMediaIdFromRaw(row.contentRaw) : null;
  if (gifId && goneGifs!.has(gifId)) return { ...meta, deleted: true, deletedReason: GIF_REMOVED_REASON };
  const out = toClientContent(row, historical);
  // Odpověď na command potlačená kvůli announcementu (lib/anncHides.ts): klient ji nevykreslí (jako živě).
  if ((row.contentRaw as Record<string, unknown> | null)?.anncHidden) out.anncHidden = true;
  // Schválený GIF — jen u nesmazané/neskryté zprávy (smazání modem GIF všem skryje).
  const gif = gifFromRaw(row.contentRaw);
  if (gif) {
    // Soubor smazán („Odstranit ze serveru“): zpráva zůstává, klient místo GIFu ukáže „[GIF nedostupný]“.
    out.gif = gifId && goneGifs?.unavailable?.has(gifId) ? { ...gif, unavailable: true } : gif;
    const rep = gifReplaces(row.contentRaw);
    if (rep) out.replaces = rep;
    const origin = gifOrigin(row.contentRaw);
    if (origin) out.gifOrigin = origin;
  }
  return out;
}

/**
 * Obsah zprávy v tvaru pro klienta (text, emoty, reply včetně odpovědi napříč platformami) BEZ
 * kontroly smazání/skrytí a bez GIFu. Volá ho toClientMessage (nesmazaná zpráva) a jen pro mody
 * `GET /moderation/deleted-content` (toModeratedContent) — nikdy ho neposílat nemodovi u smazané zprávy.
 */
/** Announcement jako položka historie: klient ho pozná podle `ucAnnouncement` a vykreslí announcement, ne zprávu. */
export function announcementMessage(id: string, at: Date, payload: AnnouncementPayload): ClientMessage {
  return { platform: 'unitychat', id: `annc-${id}`, username: 'UnityChat', userId: '', message: '', timestamp: at.getTime(), historical: true, ucAnnouncement: payload } as ClientMessage;
}

export function toClientContent(row: ClientRow, historical = true): ClientMessage {
  const out = toClientMessageBase(row, historical);
  // Odpověď napříč platformami (UnityChat) — jen když platforma sama odpověď nenese.
  const ur = ((row.contentRaw || {}) as Record<string, unknown>).ucReply as Record<string, unknown> | undefined;
  if (ur && ur.id && !out.replyTo) {
    out.replyTo = { username: String(ur.username || ''), message: String(ur.message || ''), id: String(ur.id), platform: String(ur.platform || ''), uc: true, ...(ur.authorUc ? { authorUc: true } : {}) };
  }
  return out;
}

/**
 * Smazaná / skrytá zpráva i s obsahem — JEN pro moda kanálu (`GET /moderation/deleted-content`).
 * GIF se neposílá: mod smazanou zprávu v chatu stejně nevidí. Médium tím z knihovny NEzmizí a dál se servíruje
 * (stejné médium nese víc zpráv) — z knihovny ho mod odebere zvlášť (unapprove / purge, audit L8).
 */
export function toModeratedContent(row: ClientRow): ClientMessage {
  const out = toClientContent(row, true);
  if (row.deletedAt) { out.deleted = true; out.deletedReason = row.deletedReason ?? null; }
  else if (row.hiddenAt) out.hidden = true;
  return out;
}

/** Stav média pro gifMediaGone: id → status (lib/gifRequests.ts GifMediaStatus); chybějící id = médium neexistuje. */
export type GifMediaStatusLookup = (ids: string[]) => Promise<Map<string, string>>;

/** Média, jejichž zprávy jdou jako smazané (`gif_removed`); `unavailable` = soubor smazán, zpráva se štítkem. */
export type GifGone = ReadonlySet<string> & { unavailable?: ReadonlySet<string> };

const dbGifMediaStatus: GifMediaStatusLookup = async (ids) => {
  const rows = await db.select({ id: gifMedia.id, status: gifMedia.status }).from(gifMedia).where(inArray(gifMedia.id, ids));
  return new Map(rows.map((r) => [r.id, r.status]));
};

/**
 * Média schválených GIFů v `rows`, která už nejsou veřejná (lib/gifIds.ts gifMessageState `removed`): neexistují
 * (smazaná po 7 dnech, sloučená), zamítnutá (odebraná z knihovny) nebo zahozená i se zprávami (purging).
 * `.unavailable` = stažená se smazaným souborem (zpráva zůstává, místo GIFu štítek). Jeden dotaz na stránku (ne N+1);
 * bez GIFů se DB nevolá. Čekající (alias z backfillu) a stažené (withdrawn) médium zůstává vidět. Chyba DB → prázdná
 * množina (GIF se ukáže jako dosud, klient pak po 404 napíše „GIF odebrán“).
 */
export async function gifMediaGone(rows: ReadonlyArray<Pick<ClientRow, 'contentRaw'>>, lookup: GifMediaStatusLookup = dbGifMediaStatus): Promise<Set<string> & { unavailable?: Set<string> }> {
  const ids = [...new Set(rows.map((r) => gifMediaIdFromRaw(r.contentRaw)).filter((x): x is string => !!x))];
  if (!ids.length) return new Set();
  let st: Map<string, string>;
  try { st = await lookup(ids); } catch { return new Set(); }
  const gone: Set<string> & { unavailable?: Set<string> } = new Set(ids.filter((id) => gifMessageState(st.get(id)) === 'removed'));
  const un = ids.filter((id) => gifMessageState(st.get(id)) === 'unavailable');
  if (un.length) gone.unavailable = new Set(un);
  return gone;
}

/**
 * Odkrytá / obnovená zpráva (message-restored, message-unhidden, odpověď POST /moderation/restore): jako
 * toClientMessage, ale GIF nese stav média, aby ho klient vykreslil stejně jako čerstvý stav (test 2026-09-27
 * kolo 4 bod 3; dřív šel holý GIF → 404 → neostylovaný „GIF odebrán“): soubor smazán → `unavailable`
 * („[GIF nedostupný]“), odebrané z knihovny / zahozené / neexistující → `removed` („GIF odebrán“). Zpráva se
 * neposílá jako smazaná (mod ji právě odkryl). Bez GIFu se DB nevolá; chyba DB → GIF jako dosud.
 */
export async function toRestoredMessage(row: ClientRow, lookup: GifMediaStatusLookup = dbGifMediaStatus): Promise<ClientMessage> {
  const out = toClientMessage(row, true);
  const id = out.gif ? gifMediaIdFromRaw(row.contentRaw) : null;
  if (!id) return out;
  const gone = await gifMediaGone([row], lookup);
  if (gone.unavailable?.has(id)) out.gif = { ...out.gif!, unavailable: true };
  else if (gone.has(id)) out.gif = { ...out.gif!, removed: true };
  return out;
}

function toClientMessageBase(row: ClientRow, historical: boolean): ClientMessage {
  const raw = (row.contentRaw || {}) as Record<string, unknown>;
  const base = {
    platform: row.platform,
    id: row.platformMessageId,
    username: row.platformUsername,
    userId: row.platformUserId,
    message: row.content,
    timestamp: row.sentAt.getTime(),
    historical,
    ...(row.isUnitychatUser ? { uc: true } : {}),
    // Dárce za posledních 30 dní (lib/donors.ts) → odznak dárce v chatu (core/donor-badge.js).
    ...donorFields(row.platform, row.channel || '', row.platformUserId, row.platformUsername),
  };
  if (row.platform === 'twitch') {
    return {
      ...base,
      color: (raw.color as string) || null,
      badgesRaw: (raw.badges as string) || '',
      twitchEmotes: (raw.emotes as string) || null,
      twitchEmotesOffset: (raw.emotesOffset as number) || 0,
      firstMsg: !!raw.firstMsg,
      isAction: !!raw.action,
      replyTo: row.isReply && row.replyToMessageId
        ? { username: (raw.replyParentDisplayName as string) || '', message: (raw.replyParentBody as string) || '', id: row.replyToMessageId, ...(raw.replyParentLogin ? { login: String(raw.replyParentLogin) } : {}) }
        : null,
      ...noticeFields(raw),
    };
  }
  if (row.platform === 'kick') {
    const badges = Array.isArray(raw.badges) ? (raw.badges as { type: string; count?: number }[]) : [];
    return {
      ...base,
      color: (raw.color as string) || '#53fc18',
      kickContent: (raw.content as string) || row.content,
      badgesRaw: badges.filter((b) => b && b.type).map((b) => (b.count ? `${b.type}/${b.count}` : b.type)).join(','),
      replyTo: row.isReply && row.replyToMessageId
        ? { username: (raw.replyParentUsername as string) || '', message: (raw.replyParentBody as string) || '', id: row.replyToMessageId }
        : null,
    };
  }
  return {
    ...base,
    ytRuns: Array.isArray(raw.runs) ? (raw.runs as unknown[]) : [],
    superChat: !!raw.superChat,
    color: raw.superChat ? '#ffd600' : null,
  };
}

/** Token bucket per klíč; capacity tokenů, refill tokenů/s. Ochrana proti scroll-spamu, ne proti útoku. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly capacity: number,
    private readonly perSec: number,
    private readonly now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.perSec);
    b.at = t;
    // LRU: naposledy použitý klíč na konec; při přeplnění pryč nejdéle nepoužité (dřív clear() všech → rotace
    // IPv6 adres limit rušila i aktivnímu útočníkovi, audit SEC-2).
    this.buckets.delete(key);
    this.buckets.set(key, b);
    while (this.buckets.size > RateLimiter.MAX_KEYS) this.buckets.delete(this.buckets.keys().next().value!);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  static readonly MAX_KEYS = 5000;
}

const CHANNEL_RE = /^[a-z0-9_]{1,40}$/;
const PLATFORMS = ['twitch', 'kick', 'youtube'] as const;

/** Max zpráv v jednom GET /chat/messages (= strop `messageIds` v SSE gif-media). */
export const MESSAGES_BY_ID_MAX = 200;

/**
 * `twitch:abc,kick:def` → klíče zpráv (bez duplicit, jen platné, nejvýš `max`). Sdílí GET /chat/messages
 * i GET /gif/held (routes/gif.ts parseHeldIds).
 */
export function parseMessageKeys(raw: string | undefined, max: number): Array<{ platform: typeof PLATFORMS[number]; messageId: string }> {
  const out: Array<{ platform: typeof PLATFORMS[number]; messageId: string }> = [];
  const seen = new Set<string>();
  for (const part of String(raw || '').split(',')) {
    const m = /^(twitch|kick|youtube):([\w.:-]{1,200})$/.exec(part.trim());
    if (!m || seen.has(part.trim())) continue;
    seen.add(part.trim());
    out.push({ platform: m[1] as typeof PLATFORMS[number], messageId: m[2] });
    if (out.length >= max) break;
  }
  return out;
}

/** Řádky zpráv kanálů `channels` podle klíčů (routa: DB; testy injektují). */
export type MessageRowsByKeys = (channels: string[], keys: Array<{ platform: string; messageId: string }>) => Promise<Message[]>;

export const dbMessageRowsByKeys: MessageRowsByKeys = async (channels, keys) => {
  if (!keys.length) return [];
  // (platform, platform_message_id) je unikátní index → oba IN seznamy ho využijí; kanál jako pojistka izolace.
  const rows = await db.select().from(messages).where(and(
    inArray(messages.channel, channels),
    inArray(messages.platform, [...new Set(keys.map((k) => k.platform))]),
    inArray(messages.platformMessageId, [...new Set(keys.map((k) => k.messageId))]),
  ));
  const want = new Set(keys.map((k) => `${k.platform}:${k.messageId}`));
  return rows.filter((r) => want.has(`${r.platform}:${r.platformMessageId}`));
};

/**
 * Konkrétní zprávy kanálu podle klíčů (GET /chat/messages — klient si po SSE gif-media visible dotáhne obsah
 * obnovených zpráv). Jen nesmazané a neskryté (i ty, jejichž GIF už není veřejný, se vynechají), tvar jako
 * /chat/history, nejstarší první.
 */
export async function messagesByKeys(channels: string[], keys: Array<{ platform: string; messageId: string }>, deps: { rows?: MessageRowsByKeys; gone?: typeof gifMediaGone } = {}): Promise<ClientMessage[]> {
  const rows = (await (deps.rows ?? dbMessageRowsByKeys)(channels, keys)).filter((r) => !r.deletedAt && !r.hiddenAt);
  const gone = await (deps.gone ?? gifMediaGone)(rows);
  return rows
    .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime() || a.id - b.id)
    .map((r) => toClientMessage(r, true, gone))
    .filter((m) => !m.deleted && !m.hidden);
}
const MAX_STREAMS_PER_IP = 10; // domácnost za NAT, víc tabů

/**
 * Kanál je Twitch login; YouTube/Kick jména podle streamers directory.
 * Když mapování chybí, vrací se jen jméno samotné (zprávy uložené pod ním).
 */
export async function resolveChannels(channel: string): Promise<string[]> {
  const dir = await db
    .select({ yt: streamers.youtubeHandle, kick: streamers.kickSlug })
    .from(streamers)
    .where(eq(streamers.twitchLogin, channel))
    .limit(1);
  return [...new Set([channel, dir[0]?.yt?.toLowerCase(), dir[0]?.kick?.toLowerCase()].filter((c): c is string => !!c))];
}

/**
 * Kanál zprávy v ingestu pro danou platformu (YouTube handle / Kick slug podle streamers directory).
 * Zdroj: adresář `streamers` (fallback UC kanál). Moderace používá lib/platformChannels `registryPlatformChannel` (registr Židolišty).
 */
export async function platformChannel(platform: string, channel: string): Promise<string> {
  if (platform === 'twitch') return channel;
  const dir = await db.select({ yt: streamers.youtubeHandle, kick: streamers.kickSlug }).from(streamers).where(eq(streamers.twitchLogin, channel)).limit(1);
  return ((platform === 'youtube' ? dir[0]?.yt : dir[0]?.kick) || channel).toLowerCase();
}

export default async function chatRoutes(app: FastifyInstance) {
  const limiter = new RateLimiter(10, 10);
  const ucLimiter = new RateLimiter(5, 1);

  /**
   * POST /chat/uc-sent {platform, channel, username, text} — addon po odeslání commandu
   * (`!…`, bez markeru) nahlásí, že ho poslal z UnityChatu; ingest pak zprávu označí
   * (lib/ucSends.ts) a klienti dostanou SSE `uc-mark` → zlaté logo. Jen commandy.
   */
  // Jen přihlášený a jen za vlastní účet (dřív bez ověření → podvržené citace, 2026-09-25).
  app.post<{ Body: { platform?: string; channel?: string; username?: string; text?: string; replyTo?: unknown; gifReview?: boolean } }>('/chat/uc-sent', { preHandler: requireWebSession }, async (req, reply) => {
    if (!ucLimiter.allow(req.ip)) return reply.code(429).send({ ok: false, error: 'rate_limited' });
    const platform = String(req.body?.platform || '');
    const channel = String(req.body?.channel || '').toLowerCase().replace(/^@/, '');
    const username = String(req.body?.username || '').slice(0, 60);
    const text = String(req.body?.text || '').slice(0, 500);
    // Odpověď napříč platformami (záložní odesílání přes kartu): i zpráva, která není command.
    const isCmd = text.trim().startsWith('!');
    if (!(PLATFORMS as readonly string[]).includes(platform) || !CHANNEL_RE.test(channel) || !username) {
      return reply.code(400).send({ ok: false, error: 'bad_request' });
    }
    if (!ownsHandle(await listIdentities(req.webAccountId!), platform, username)) {
      req.log.warn({ platform, username }, 'uc-sent: hlášení za cizí účet odmítnuto');
      return reply.code(403).send({ ok: false, error: 'not_owner' });
    }
    const ucReply = await verifyUcReply(parseUcReply(req.body?.replyTo));
    // GIF od moda v Dev módu (záložní odesílání přes kartu): schvalovat jako od diváka (lib/ucSends.ts gifReviews).
    const gifReview = req.body?.gifReview === true;
    if (!isCmd && !ucReply && !gifReview) return reply.code(400).send({ ok: false, error: 'bad_request' });
    const ch = await platformChannel(platform, channel);
    if (gifReview) gifReviews.report({ platform, channel: ch, username, text });
    let hit = null;
    if (isCmd) {
      hit = ucSends.report({ platform, channel: ch, username, text });
      if (hit) markUc(hit, app.log, { late: true });
    }
    if (ucReply) {
      const rh = ucReplies.report({ platform, channel: ch, username, text, data: ucReply });
      if (rh) attachUcReply(rh, ucReply, app.log, { late: true });
      hit = hit || rh;
    }
    return { ok: true, matched: !!hit };
  });

  // Živé zprávy z ingestu (spec web verze §3.3): SSE, event `message` = stejný
  // tvar jako /chat/history s historical:false; `hello` po připojení;
  // keepalive komentář každých 15 s. Bez replay — klient po reconnectu
  // dorovná přes /chat/history.
  app.get<{ Querystring: { channel?: string; platforms?: string } }>('/chat/stream', async (req, reply) => {
    const channel = (req.query.channel || '').trim().toLowerCase();
    if (!CHANNEL_RE.test(channel)) { reply.code(400); return { ok: false, error: 'channel' }; }
    const wanted = (req.query.platforms || PLATFORMS.join(','))
      .split(',').map((p) => p.trim().toLowerCase()).filter((p): p is typeof PLATFORMS[number] => (PLATFORMS as readonly string[]).includes(p));
    if (!wanted.length) { reply.code(400); return { ok: false, error: 'platforms' }; }
    if (chatStreamClientsForIp(req.ip) >= MAX_STREAMS_PER_IP) { reply.code(429); return { ok: false, error: 'too many streams' }; }

    const channels = await resolveChannels(channel);

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    const unsubscribe = subscribeChatStream(reply, { ip: req.ip, channels, platforms: wanted });
    req.raw.on('close', unsubscribe);
    return undefined; // hijacknuto — odpověď drží SSE, Fastify nic neposílá
  });

  // Konkrétní zprávy podle id (veřejné, jako historie): klient si po SSE gif-media visible dotáhne obsah zpráv,
  // které má jen jako smazané. Jen daný kanál, jen nesmazané a neskryté, nejvýš MESSAGES_BY_ID_MAX klíčů.
  const byIdLimiter = new RateLimiter(10, 2);
  app.get<{ Querystring: { channel?: string; ids?: string } }>('/chat/messages', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!byIdLimiter.allow(req.ip)) { reply.code(429); return { ok: false, error: 'too many requests' }; }
    const channel = (req.query.channel || '').trim().toLowerCase();
    if (!CHANNEL_RE.test(channel)) { reply.code(400); return { ok: false, error: 'channel' }; }
    const keys = parseMessageKeys(req.query.ids, MESSAGES_BY_ID_MAX);
    if (!keys.length) { reply.code(400); return { ok: false, error: 'ids' }; }
    return { ok: true, messages: await messagesByKeys(await resolveChannels(channel), keys) };
  });

  app.get<{ Querystring: { channel?: string; limit?: string; before?: string } }>('/chat/history', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!limiter.allow(req.ip)) { reply.code(429); return { ok: false, error: 'too many requests' }; }

    const channel = (req.query.channel || '').trim().toLowerCase();
    if (!CHANNEL_RE.test(channel)) { reply.code(400); return { ok: false, error: 'channel' }; }
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '100', 10) || 100));
    const cursor = req.query.before ? decodeCursor(req.query.before) : null;
    if (req.query.before && !cursor) { reply.code(400); return { ok: false, error: 'before' }; }

    const channels = await resolveChannels(channel);

    const conds = [inArray(messages.channel, channels)];
    if (cursor) {
      const at = new Date(cursor.sentAtMs);
      conds.push(or(lt(messages.sentAt, at), and(eq(messages.sentAt, at), lt(messages.id, cursor.id)))!);
    }
    const rows = await db
      .select()
      .from(messages)
      .where(and(...conds))
      .orderBy(desc(messages.sentAt), desc(messages.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const oldest = page[page.length - 1];
    // GIFy odebrané z knihovny / zahozené → smazané bez média (dávkově, jeden dotaz na stránku).
    const gone = await gifMediaGone(page);
    const list: ClientMessage[] = page.reverse().map((r) => toClientMessage(r, true, gone));
    // UnityChat Announcementy ve stejném rozmezí časů jako stránka (na první stránce až do teď) — mezi zprávy podle času.
    try {
      const fromMs = oldest ? oldest.sentAt.getTime() : Date.now() - 24 * 3600_000;
      const toMs = cursor ? cursor.sentAtMs : Date.now();
      const anncs = await announcementsBetween(channel, fromMs, toMs);
      for (const a of anncs) list.push(announcementMessage(a.id, a.at, a.payload));
      if (anncs.length) list.sort((x, y) => x.timestamp - y.timestamp);
    } catch (e) { req.log.warn({ err: (e as Error).message }, 'history: announcements nedostupné'); }
    return {
      ok: true,
      messages: list,
      nextBefore: hasMore && oldest ? encodeCursor(oldest.sentAt.getTime(), oldest.id) : null,
    };
  });
}
