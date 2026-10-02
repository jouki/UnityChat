// Zpráva jen přes UnityChat (pokyn usera 2026-10-02): když se zpráva na platformu nepošle (chyba odeslání) nebo ji
// YouTube přijme a nezobrazí (zadržení filtrem — 2026-10-02 se zprávy objevily až po 40 min), klient ji AUTOMATICKY
// pošle sem. Server ji uloží do archivu jako zprávu té platformy (id `uco-…`, `content_raw.ucOnly`) → historie,
// /chat/stream, SSE `uc-only` (addon / web / OBS — user chce i OBS), klienti místo loga platformy kreslí logo
// UnityChatu. Moderace: „Jen v UC skrýt“ funguje jako u každé zprávy (řádek v messages), blacklist cenzuruje klient.
// Když YouTube zadrženou zprávu později pustí, ingest ji podle `heldId` označí jako duplikát (dupHidden + SSE bot-dup).
import type { Platform } from './zidolista.js';

export const UCO_PREFIX = 'uco-';
export const HELD_TTL_MS = 24 * 3600_000;

/** YouTube: id z liveChatMessages.insert (`LCC.Ehw…`) → id, které pak nese chat / ingest (`Chw…`). */
export function youtubeChatIdFromInsert(id: string | null | undefined): string | null {
  const s = String(id || '');
  if (/^LCC\.Eh[\w-]+$/.test(s)) return 'Ch' + s.slice(6);
  return /^Ch[\w-]{10,}$/.test(s) ? s : null;
}

/** Tvar content_raw podle platformy (toClientMessageBase ho čte jako u zprávy z ingestu) + příznak ucOnly. */
export function ucOnlyContentRaw(platform: Platform, text: string, last: Record<string, unknown> | null, meta: { reason: string; heldId: string | null }): Record<string, unknown> {
  const ucOnly = { reason: meta.reason.slice(0, 200), ...(meta.heldId ? { heldId: meta.heldId } : {}) };
  if (platform === 'twitch') return { color: last?.color ?? null, badges: typeof last?.badges === 'string' ? last.badges : '', login: last?.login, displayName: last?.displayName, ucOnly };
  if (platform === 'kick') return { color: last?.color ?? null, badges: Array.isArray(last?.badges) ? last.badges : [], content: text, ucOnly };
  return { runs: [{ text }], ucOnly };
}

/** Zadržené zprávy YouTube, za které už šla zpráva jen přes UnityChat: id zprávy v chatu → id `uco-…`. */
export class HeldRegistry {
  private m = new Map<string, { uco: string; at: number }>();
  constructor(private now: () => number = Date.now) {}
  remember(heldId: string, uco: string): void {
    this.prune();
    this.m.set(heldId, { uco, at: this.now() });
  }
  /** Zpráva z ingestu je dřív zadržená, za kterou už UnityChat ukázal vlastní → id `uco-…` (spotřebuje). */
  take(platformMessageId: string): string | null {
    const e = this.m.get(platformMessageId);
    if (!e) return null;
    this.m.delete(platformMessageId);
    return this.now() - e.at < HELD_TTL_MS ? e.uco : null;
  }
  private prune(): void {
    const t = this.now();
    for (const [k, v] of this.m) if (t - v.at > HELD_TTL_MS) this.m.delete(k);
    while (this.m.size > 2000) this.m.delete(this.m.keys().next().value!);
  }
}

export const ucOnlyHeld = new HeldRegistry();
