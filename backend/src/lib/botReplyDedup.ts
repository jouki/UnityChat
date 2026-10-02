// Odpověď bota na broadcast commandu (2026-10-02, pokyn usera): command poslaný broadcastem z UnityChatu dostane
// odpověď bota na KAŽDÉ platformě (rozhoduje Židolišta), ale v UnityChatu (sjednocený chat) stačí jedna.
// První zpráva bota s daným textem v UC kanálu se ukáže, stejný text od bota z JINÉ platformy do DUP_WINDOW_MS
// je duplikát → content_raw.botDupOf = id první (historie i /chat/stream pošlou `dupHidden`) + SSE `bot-dup`
// (addon / web mají živé zprávy Twitche a Kicku z vlastního spojení, bez příznaku ze serveru).
import { normText } from './ucSends.js';

export const DUP_WINDOW_MS = 15_000;

interface Seen { platform: string; id: string; atMs: number }

export class BotReplyDedup {
  private seen = new Map<string, Seen[]>();   // `${ucChannel}\n${text}` → zprávy (po platformách)
  constructor(private now: () => number = Date.now) {}

  /** Zpráva bota → id první zprávy se stejným textem z jiné platformy (= duplikát), jinak null (zapamatuje si ji). */
  check(m: { platform: string; platformMessageId: string; content: string; sentAt: Date }, ucChannel: string): string | null {
    const text = normText(m.content).toLowerCase();
    if (!text) return null;
    this.prune();
    const key = `${ucChannel.toLowerCase()}\n${text}`;
    const at = m.sentAt.getTime();
    const list = this.seen.get(key) || [];
    const first = list.find((s) => s.platform !== m.platform && Math.abs(at - s.atMs) <= DUP_WINDOW_MS);
    if (first) return first.id;
    // Stejná platforma = nová odpověď (bot smí napsat totéž znovu), tu si pamatovat jako novou první.
    this.seen.set(key, [...list.filter((s) => s.platform !== m.platform), { platform: m.platform, id: m.platformMessageId, atMs: at }].slice(-6));
    return null;
  }

  private prune(): void {
    const t = this.now();
    for (const [k, list] of this.seen) {
      const keep = list.filter((s) => t - s.atMs < DUP_WINDOW_MS * 2);
      if (keep.length) this.seen.set(k, keep); else this.seen.delete(k);
    }
  }

  /** Jen pro testy. */
  _reset(): void { this.seen.clear(); }
}

export const botReplyDedup = new BotReplyDedup();
