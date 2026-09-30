// Sdílené drobnosti odměny GIF (moderace část 4) bez závislosti na DB — importují je routes/chat.ts
// (toClientMessage) i lib/modActions.ts (syntetické zprávy se na platformě nemažou).
import { config } from '../config.js';

/** Schválený GIF je v archivu syntetická zpráva s id `gif-<requestId>` (na platformě neexistuje). */
export const GIF_MESSAGE_PREFIX = 'gif-';
export const isGifMessageId = (id: string): boolean => String(id || '').startsWith(GIF_MESSAGE_PREFIX);
export const gifMessageId = (requestId: number): string => `${GIF_MESSAGE_PREFIX}${requestId}`;
export const MEDIA_ID_RE = /^[a-f0-9]{32}$/;

/** Absolutní URL média na našem serveru (addon, web i OBS načítají jen z api.jouki.cz). */
export function gifMediaUrl(mediaId: string, base: string = config.PUBLIC_BASE_URL): string {
  return `${base.replace(/\/$/, '')}/media/gif/${mediaId}`;
}

/**
 * `unavailable`: soubor média byl smazán ze serveru („Odstranit ze serveru“ u staženého GIFu) — zpráva zůstává,
 * klient místo GIFu ukáže štítek „[GIF nedostupný]“ (URL zůstává kvůli starším klientům: 404 → „GIF odebrán“).
 */
export interface GifMediaView {
  url: string; kind: string; width: number | null; height: number | null; unavailable?: true;
  /**
   * Médium odebrané z knihovny / zahozené / neexistující u ODKRYTÉ zprávy (routes/chat.ts toRestoredMessage):
   * zpráva zůstává vidět, klient místo GIFu ukáže štítek „GIF odebrán“ (stejně nastylovaný jako „[GIF nedostupný]“).
   */
  removed?: true;
}

/**
 * Stav média → jak se ukáže zpráva se schváleným GIFem (spec 2026-09-27-gif-nahled-zahozeni-design.md):
 *  - `visible`: approved (knihovna), withdrawn („Zahodit, zprávy nechat“), pending (alias z backfillu);
 *  - `removed`: rejected (odebráno z knihovny), purging („Zahodit i se zprávami“, 7 dní), médium neexistuje
 *    → smazaná zpráva `gif_removed` bez obsahu;
 *  - `unavailable`: soubor smazán („Odstranit ze serveru“) → zpráva s textem, místo GIFu štítek.
 */
export type GifMessageState = 'visible' | 'removed' | 'unavailable';
export function gifMessageState(status: string | null | undefined): GifMessageState {
  if (status === 'approved' || status === 'withdrawn' || status === 'pending') return 'visible';
  if (status === 'unavailable') return 'unavailable';
  return 'removed';
}

/** content_raw.gif syntetické zprávy → tvar pro klienty; cokoli jiného → null. */
export function gifFromRaw(raw: unknown): GifMediaView | null {
  const id = gifMediaIdFromRaw(raw);
  if (!id) return null;
  const g = (raw as Record<string, unknown>).gif as Record<string, unknown>;
  const dim = (v: unknown): number | null => (typeof v === 'number' && v > 0 ? v : null);
  return { url: gifMediaUrl(id), kind: String(g.kind || 'gif'), width: dim(g.width), height: dim(g.height) };
}

/** content_raw.gif.mediaId syntetické zprávy (32 hex), jinak null. */
export function gifMediaIdFromRaw(raw: unknown): string | null {
  const g = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>).gif : null) as Record<string, unknown> | null | undefined;
  return g && typeof g.mediaId === 'string' && MEDIA_ID_RE.test(g.mediaId) ? g.mediaId : null;
}

/**
 * Důvod „smazání“ zprávy se schváleným GIFem, jehož médium už veřejné není (odebráno z knihovny = zamítnuté,
 * trvale zahozeno, sloučeno a pryč). V archivu se nic nemění — /chat/history a Profil ji jen pošlou jako smazanou
 * bez obsahu a bez `gif` (divák „Zpráva smazána“, OBS ji skryje). Mod ji v UnityChatu neodkryje (`gif_` prefix).
 */
export const GIF_REMOVED_REASON = 'gif_removed' as const;

const gifKey = (raw: unknown, key: 'replaces' | 'origin'): string | null => {
  const g = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>).gif : null) as Record<string, unknown> | null | undefined;
  const v = g && typeof g[key] === 'string' ? g[key] as string : '';
  return /^(twitch|kick|youtube):[^\s]{1,200}$/.test(v) ? v : null;
};

/** content_raw.gif.replaces (`<platform>:<messageId>` původní zprávy; jen GIFy schválené před 2026-09-26) → řetězec, jinak null. */
export function gifReplaces(raw: unknown): string | null { return gifKey(raw, 'replaces'); }

/** content_raw.gif.origin (`<platform>:<messageId>` původní zprávy s odkazem, jen k párování) → řetězec, jinak null. */
export function gifOrigin(raw: unknown): string | null { return gifKey(raw, 'origin'); }
