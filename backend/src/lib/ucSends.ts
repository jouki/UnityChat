// Zprávy odeslané z UnityChatu bez skrytého markeru (commandy `!…` — marker by rozbil boty).
// Klient (addon po odeslání, web přes /chat/send) nahlásí {platform, channel, username, text};
// ingest pak odpovídající příchozí zprávu označí jako UnityChat (is_unitychat_user) a pošle
// klientům SSE `uc-mark`, ať dostane zlaté logo. Párování: stejná platforma, kanál, login
// a text do SEND_TTL_MS; zpráva, která přišla dřív než hlášení, se dohledá zpětně (RECENT_TTL_MS).
import { and, eq, sql } from 'drizzle-orm';
import type { IngestMessage } from '../ingest/types.js';
import { UC_MARKER } from '../ingest/normalize.js';
import { db } from '../db/index.js';
import { messages } from '../db/schema.js';
import { broadcast } from '../sse/bus.js';

export const SEND_TTL_MS = 20_000;
export const RECENT_TTL_MS = 60_000;
const RECENT_MAX = 300;

/** Odesílatel: login (addon ho zná) nebo ID uživatele na platformě (web přes /chat/send). */
export interface UcSend<T = undefined> { platform: string; channel: string; username?: string; userId?: string; text: string; data?: T }
interface Pending<T> { username: string; userId: string; text: string; until: number; data?: T }
interface Recent { username: string; userId: string; text: string; at: number; msg: IngestMessage }
const sameSender = (a: { username: string; userId: string }, b: { username: string; userId: string }) =>
  (!!a.userId && a.userId === b.userId) || (!!a.username && a.username === b.username);

const key = (platform: string, channel: string) => `${platform}:${channel.toLowerCase().replace(/^@/, '')}`;
export const normText = (s: string) => String(s || '').replaceAll(UC_MARKER, '').replace(/\s+/g, ' ').trim();
const normUser = (s: string) => String(s || '').toLowerCase().replace(/^@/, '').trim();

export class UcSendRegistry<T = undefined> {
  private pending = new Map<string, Pending<T>[]>();
  private recent = new Map<string, Recent[]>();
  /** recentMarked: pamatovat si i zprávy s markerem (odpovědi napříč platformami je mají). */
  constructor(private now: () => number = Date.now, private opts: { recentMarked?: boolean } = {}) {}

  /**
   * Hlášení odeslání. Když už odpovídající zpráva přišla (ingest byl rychlejší), vrátí ji
   * (a spotřebuje), jinak si hlášení pamatuje pro match().
   */
  report(s: UcSend<T>): IngestMessage | null {
    const k = key(s.platform, s.channel);
    const t = this.now();
    const who = { username: normUser(s.username || ''), userId: String(s.userId || '') };
    const text = normText(s.text);
    const rec = (this.recent.get(k) || []).filter((r) => t - r.at < RECENT_TTL_MS);
    this.recent.set(k, rec);
    const i = rec.findIndex((r) => sameSender(r, who) && r.text === text);
    if (i >= 0) { const [hit] = rec.splice(i, 1); return hit.msg; }
    const list = (this.pending.get(k) || []).filter((p) => p.until > t);
    list.push({ ...who, text, until: t + SEND_TTL_MS, data: s.data });
    this.pending.set(k, list.slice(-50));
    return null;
  }

  /** Volá ingest pro každou příchozí zprávu: true = je to nahlášené odeslání z UnityChatu. */
  match(m: IngestMessage): boolean {
    return this.take(m) !== null;
  }

  /** Jako match(), ale vrátí nahlášený záznam (s daty), nebo null. */
  take(m: IngestMessage): { data?: T } | null {
    const k = key(m.platform, m.channel);
    const t = this.now();
    const who = { username: normUser(m.username), userId: String(m.platformUserId || '') };
    const text = normText(m.content);
    const list = (this.pending.get(k) || []).filter((p) => p.until > t);
    const i = list.findIndex((p) => sameSender(p, who) && p.text === text);
    if (i >= 0) { const [hit] = list.splice(i, 1); this.pending.set(k, list); return { data: hit.data }; }
    this.pending.set(k, list);
    // Zapamatovat pro pozdní hlášení (commandy jen bez markeru — s markerem to klient pozná sám).
    if (!m.isUnitychatUser || this.opts.recentMarked) {
      const rec = (this.recent.get(k) || []).filter((r) => t - r.at < RECENT_TTL_MS);
      rec.push({ ...who, text, at: t, msg: m });
      this.recent.set(k, rec.slice(-RECENT_MAX));
    }
    return null;
  }
}

export const ucSends = new UcSendRegistry();

/** Odpověď napříč platformami: na kterou zprávu se odpovídá (extension/core/uc-reply.js). */
export interface UcReply { platform: string; id: string; username: string; message: string }
export const ucReplies = new UcSendRegistry<UcReply>(Date.now, { recentMarked: true });

/** Validace odpovědi z klienta (/chat/send ucReplyTo, /chat/uc-sent replyTo). */
export function parseUcReply(v: unknown): UcReply | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const platform = String(o.platform || '');
  const id = String(o.id || '').slice(0, 200);
  if (!['twitch', 'kick', 'youtube'].includes(platform) || !id) return null;
  return {
    platform, id,
    username: String(o.username || '').replace(/^@/, '').slice(0, 60),
    message: String(o.message || '').slice(0, 300),
  };
}

/**
 * Připojit k zprávě odpověď napříč platformami: content_raw.ucReply (ingest ji ještě může
 * mít ve frontě na zápis → /chat/history i /chat/stream ji vrátí jako replyTo), SSE `uc-reply`
 * pro klienty, kteří zprávu mají z vlastního spojení (addon), u zpětného nálezu UPDATE v DB.
 */
export function attachUcReply(m: IngestMessage, reply: UcReply, log?: { info(o: object, msg: string): void; warn(o: object, msg: string): void }, opts: { late?: boolean } = {}): void {
  const raw = (m.contentRaw && typeof m.contentRaw === 'object' ? m.contentRaw : {}) as Record<string, unknown>;
  raw.ucReply = reply;
  m.contentRaw = raw;
  broadcast('uc-reply', { platform: m.platform, channel: m.channel, id: m.platformMessageId, replyTo: { ...reply, uc: true } });
  log?.info({ platform: m.platform, id: m.platformMessageId, to: `${reply.platform}:${reply.id}`, late: !!opts.late }, 'uc-reply: odpověď napříč platformami');
  if (!opts.late) return;
  const update = () => db.update(messages).set({ contentRaw: sql`coalesce(${messages.contentRaw}, '{}'::jsonb) || ${JSON.stringify({ ucReply: reply })}::jsonb` })
    .where(and(eq(messages.platform, m.platform), eq(messages.platformMessageId, m.platformMessageId)))
    .catch((err) => log?.warn({ err, id: m.platformMessageId }, 'uc-reply: update DB selhal'));
  void update();
  setTimeout(() => void update(), 3000).unref?.();
}

/**
 * Označit zprávu jako odeslanou z UnityChatu: příznak na objektu (ingest ho ještě může mít
 * ve frontě na zápis), SSE `uc-mark` pro klienty (addon má zprávu z vlastního IRC, o příznaku
 * by se jinak nedozvěděl) a u zpětného nálezu i UPDATE v DB (hned + po 3 s — dávka ingestu
 * mohla být zrovna rozepsaná).
 */
export function markUc(m: IngestMessage, log?: { info(o: object, msg: string): void; warn(o: object, msg: string): void }, opts: { late?: boolean } = {}): void {
  m.isUnitychatUser = true;
  broadcast('uc-mark', { platform: m.platform, channel: m.channel, id: m.platformMessageId });
  log?.info({ platform: m.platform, channel: m.channel, id: m.platformMessageId, late: !!opts.late }, 'uc-send: zpráva označena jako UnityChat');
  if (!opts.late) return;
  const update = () => db.update(messages).set({ isUnitychatUser: true })
    .where(and(eq(messages.platform, m.platform), eq(messages.platformMessageId, m.platformMessageId)))
    .catch((err) => log?.warn({ err, id: m.platformMessageId }, 'uc-send: update DB selhal'));
  void update();
  setTimeout(() => void update(), 3000).unref?.();
}
