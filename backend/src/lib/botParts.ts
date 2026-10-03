// Odpověď bota rozdělená na víc zpráv (kontrakt se Židolištou 2026-10-03, Židolišta 981fcab): odpověď delší než
// limit platformy jde jako víc POST /bot/send s `part { group, index (1-based), total, fullText }`. V UnityChatu
// (sjednocený chat) má být JEDNA zpráva: díl 1 nese celý text (content_raw.segmentFull → klient ho kreslí místo dílu,
// živě SSE `bot-segment`), díly 2..n jsou jeho součást (content_raw.segmentOf = id dílu 1 → dupHidden, živě SSE
// `bot-dup`). Dedup broadcastu (lib/botReplyDedup.ts) a skrývání odpovědi kvůli announcementu porovnávají fullText.
//
// Spárování dílu se zprávou z ingestu podle id zprávy na platformě (YouTube insert `LCC.Eh…` → `Ch…`). Pořadí
// není zaručené: echo z platformy může přijít dřív než odpověď /bot/send → `note()` vrátí už došlou zprávu (late).
import { and, eq, sql } from 'drizzle-orm';
import type { IngestMessage } from '../ingest/types.js';
import { db } from '../db/index.js';
import { messages } from '../db/schema.js';
import { broadcast } from '../sse/bus.js';
import { youtubeChatIdFromInsert } from './ucOnly.js';

export interface BotPart { group: string; index: number; total: number; fullText: string }

export const PART_TTL_MS = 120_000;

export class BotPartRegistry {
  private pending = new Map<string, { part: BotPart; at: number }>();   // platforma:id → díl (hlášení dřív než echo)
  private seen = new Map<string, { m: IngestMessage; at: number }>();    // platforma:id → zpráva bota (echo dřív než hlášení)
  private firsts = new Map<string, { id: string; at: number }>();        // platforma:group → id dílu 1
  constructor(private now: () => number = Date.now) {}

  /** /bot/send po odeslání: díl k id zprávy. Když zpráva už přišla, vrátí ji (zpracovat zpětně), jinak null. */
  note(platform: string, id: string, part: BotPart): IngestMessage | null {
    this.prune();
    const k = `${platform}:${id}`;
    const hit = this.seen.get(k);
    if (hit) { this.seen.delete(k); return hit.m; }
    this.pending.set(k, { part, at: this.now() });
    return null;
  }

  /** Ingest (zpráva bota): díl, pokud ho /bot/send už nahlásil; jinak si zprávu zapamatuje pro pozdní hlášení. */
  take(m: IngestMessage): BotPart | null {
    this.prune();
    const k = `${m.platform}:${m.platformMessageId}`;
    const p = this.pending.get(k);
    if (p) { this.pending.delete(k); return p.part; }
    this.seen.set(k, { m, at: this.now() });
    return null;
  }

  setFirst(platform: string, group: string, id: string): void { this.firsts.set(`${platform}:${group}`, { id, at: this.now() }); }
  firstOf(platform: string, group: string): string | null { return this.firsts.get(`${platform}:${group}`)?.id ?? null; }

  private prune(): void {
    const t = this.now();
    for (const map of [this.pending, this.seen, this.firsts] as Map<string, { at: number }>[]) {
      for (const [k, v] of map) { if (t - v.at > PART_TTL_MS) map.delete(k); else break; }
    }
  }

  /** Jen pro testy. */
  _reset(): void { this.pending.clear(); this.seen.clear(); this.firsts.clear(); }
}

export const botParts = new BotPartRegistry();

/**
 * Zpráva bota s dílem → úprava pro ingest / zpětné zpracování: díl 1 (z víc dílů) dostane `segmentFull`, další díl
 * `segmentOf` (id dílu 1, pokud už dorazil). Vrací id dílu 1 pro skrytí (díl 2..n), jinak null. Mutuje `m.contentRaw`.
 */
export function applyBotPart(m: IngestMessage, part: BotPart, reg: BotPartRegistry = botParts): string | null {
  if (part.total <= 1) return null;
  if (part.index === 1) {
    reg.setFirst(m.platform, part.group, m.platformMessageId);
    m.contentRaw = { ...(m.contentRaw || {}), segmentFull: part.fullText };
    return null;
  }
  const first = reg.firstOf(m.platform, part.group);
  if (first) m.contentRaw = { ...(m.contentRaw || {}), segmentOf: first };
  return first;
}

/** Id zprávy z /bot/send → id, pod kterým ji nese ingest (YouTube insert `LCC.Eh…` → `Ch…`). */
export function ingestIdFor(platform: string, id: string): string {
  return platform === 'youtube' ? (youtubeChatIdFromInsert(id) ?? id) : id;
}

type Log = { info(o: object, msg: string): void; warn(o: object, msg: string): void };

/**
 * /bot/send nahlásil díl až po příchodu zprávy (echo z platformy bylo rychlejší): díl 1 dostane celý text, další díl
 * se skryje — objekt zprávy (ingest ho může mít ve frontě na zápis), UPDATE v DB (hned + po 3 s) a SSE pro klienty.
 * Dedup broadcastu se zpětně nedělá (dělená odpověď je delší než limit, echo obvykle přijde až po 202).
 */
export function applyBotPartLate(m: IngestMessage, part: BotPart, ucChannel: string, log?: Log, reg: BotPartRegistry = botParts): void {
  const segOf = applyBotPart(m, part, reg);
  const raw = (m.contentRaw || {}) as Record<string, unknown>;
  let patch: Record<string, unknown> | null = null;
  if (part.index === 1 && part.total > 1) {
    patch = { segmentFull: part.fullText };
    broadcast('bot-segment', { platform: m.platform, channel: ucChannel, id: m.platformMessageId, fullText: part.fullText });
  } else if (segOf) {
    patch = { segmentOf: segOf };
    broadcast('bot-dup', { platform: m.platform, channel: ucChannel, id: m.platformMessageId });
  }
  log?.info({ platform: m.platform, id: m.platformMessageId, index: part.index, total: part.total, segmentOf: segOf, applied: !!patch, hasFull: !!raw.segmentFull }, 'bot: díl odpovědi nahlášen po příchodu zprávy');
  if (!patch) return;
  const update = () => db.update(messages).set({ contentRaw: sql`coalesce(${messages.contentRaw}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
    .where(and(eq(messages.platform, m.platform), eq(messages.platformMessageId, m.platformMessageId)))
    .catch((err) => log?.warn({ err: (err as Error).message, id: m.platformMessageId }, 'bot: zápis dílu do DB selhal'));
  void update();
  setTimeout(() => void update(), 3000).unref?.();
}
