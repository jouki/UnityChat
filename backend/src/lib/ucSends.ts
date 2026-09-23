// Zprávy odeslané z UnityChatu bez skrytého markeru (commandy `!…` — marker by rozbil boty).
// Klient (addon po odeslání, web přes /chat/send) nahlásí {platform, channel, username, text};
// ingest pak odpovídající příchozí zprávu označí jako UnityChat (is_unitychat_user) a pošle
// klientům SSE `uc-mark`, ať dostane zlaté logo. Párování: stejná platforma, kanál, login
// a text do SEND_TTL_MS; zpráva, která přišla dřív než hlášení, se dohledá zpětně (RECENT_TTL_MS).
import { and, eq } from 'drizzle-orm';
import type { IngestMessage } from '../ingest/types.js';
import { UC_MARKER } from '../ingest/normalize.js';
import { db } from '../db/index.js';
import { messages } from '../db/schema.js';
import { broadcast } from '../sse/bus.js';

export const SEND_TTL_MS = 20_000;
export const RECENT_TTL_MS = 60_000;
const RECENT_MAX = 300;

/** Odesílatel: login (addon ho zná) nebo ID uživatele na platformě (web přes /chat/send). */
export interface UcSend { platform: string; channel: string; username?: string; userId?: string; text: string }
interface Pending { username: string; userId: string; text: string; until: number }
interface Recent { username: string; userId: string; text: string; at: number; msg: IngestMessage }
const sameSender = (a: { username: string; userId: string }, b: { username: string; userId: string }) =>
  (!!a.userId && a.userId === b.userId) || (!!a.username && a.username === b.username);

const key = (platform: string, channel: string) => `${platform}:${channel.toLowerCase().replace(/^@/, '')}`;
export const normText = (s: string) => String(s || '').replaceAll(UC_MARKER, '').replace(/\s+/g, ' ').trim();
const normUser = (s: string) => String(s || '').toLowerCase().replace(/^@/, '').trim();

export class UcSendRegistry {
  private pending = new Map<string, Pending[]>();
  private recent = new Map<string, Recent[]>();
  constructor(private now: () => number = Date.now) {}

  /**
   * Hlášení odeslání. Když už odpovídající zpráva přišla (ingest byl rychlejší), vrátí ji
   * (a spotřebuje), jinak si hlášení pamatuje pro match().
   */
  report(s: UcSend): IngestMessage | null {
    const k = key(s.platform, s.channel);
    const t = this.now();
    const who = { username: normUser(s.username || ''), userId: String(s.userId || '') };
    const text = normText(s.text);
    const rec = (this.recent.get(k) || []).filter((r) => t - r.at < RECENT_TTL_MS);
    this.recent.set(k, rec);
    const i = rec.findIndex((r) => sameSender(r, who) && r.text === text);
    if (i >= 0) { const [hit] = rec.splice(i, 1); return hit.msg; }
    const list = (this.pending.get(k) || []).filter((p) => p.until > t);
    list.push({ ...who, text, until: t + SEND_TTL_MS });
    this.pending.set(k, list.slice(-50));
    return null;
  }

  /** Volá ingest pro každou příchozí zprávu: true = je to nahlášené odeslání z UnityChatu. */
  match(m: IngestMessage): boolean {
    const k = key(m.platform, m.channel);
    const t = this.now();
    const who = { username: normUser(m.username), userId: String(m.platformUserId || '') };
    const text = normText(m.content);
    const list = (this.pending.get(k) || []).filter((p) => p.until > t);
    const i = list.findIndex((p) => sameSender(p, who) && p.text === text);
    if (i >= 0) { list.splice(i, 1); this.pending.set(k, list); return true; }
    this.pending.set(k, list);
    // Zapamatovat pro pozdní hlášení (jen zprávy bez markeru — s markerem to klient pozná sám).
    if (!m.isUnitychatUser) {
      const rec = (this.recent.get(k) || []).filter((r) => t - r.at < RECENT_TTL_MS);
      rec.push({ ...who, text, at: t, msg: m });
      this.recent.set(k, rec.slice(-RECENT_MAX));
    }
    return false;
  }
}

export const ucSends = new UcSendRegistry();

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
