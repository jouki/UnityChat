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

export interface GifMediaView { url: string; kind: string; width: number | null; height: number | null }

/** content_raw.gif syntetické zprávy → tvar pro klienty; cokoli jiného → null. */
export function gifFromRaw(raw: unknown): GifMediaView | null {
  const g = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>).gif : null) as Record<string, unknown> | null | undefined;
  if (!g || typeof g.mediaId !== 'string' || !MEDIA_ID_RE.test(g.mediaId)) return null;
  const dim = (v: unknown): number | null => (typeof v === 'number' && v > 0 ? v : null);
  return { url: gifMediaUrl(g.mediaId), kind: String(g.kind || 'gif'), width: dim(g.width), height: dim(g.height) };
}
