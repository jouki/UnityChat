import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { broadcast } from '../sse/bus.js';
import { keyMatches, parseWorkspaceMap } from './commands.js';

/**
 * POST /announcements — UnityChat Announcement ze Židolišty (RobJewsALot).
 *
 * Command v Židolištce může mít jako odpověď honosnou zprávu s videem a
 * textem, kterou vidí jen uživatelé UnityChatu (addon + robdiesalot.com/chat).
 * Židolišta ji po spuštění commandu pošle sem (X-Api-Key = ZIDOLISTA_API_KEY),
 * backend ji jen ověří a rozešle přes SSE `announcement` na /nicknames/stream.
 * Nic se neukládá — je to živá událost, historie ji nemá.
 *
 * Tělo (kontrakt dohodnutý se session RobJewsALot 2026-09-22):
 *   { id, workspace: 'rob', command?, text?, media?: { url (https), kind: 'video'|'image',
 *     width?, height?, loop?, stillUrl? } | null, chatReply?: { text, hideInUnityChat } | null,
 *     triggeredBy?: { user, platform }, at? }
 * Židolišta zná jen slug workspace; na kanál(y) ho mapuje ZIDOLISTA_WORKSPACES a SSE
 * událost nese `channel`. `chatReply` = běžná odpověď, kterou SB pošle do chatu všem;
 * klient UnityChatu ji při `hideInUnityChat` skryje (uvidí místo ní announcement).
 */

export interface AnnouncementPayload {
  id: string;
  workspace: string;
  channel: string;
  command?: string;
  text?: string;
  /** Rich text (Markdown → HTML na serveru Židolišty); klient ho ještě sanitizuje. */
  textHtml?: string;
  media?: { url: string; kind: 'video' | 'image'; width?: number; height?: number; loop?: boolean; loopDelayMs?: number; stillUrl?: string | null } | null;
  chatReply?: { text: string; hideInUnityChat: boolean } | null;
  triggeredBy?: { user: string; platform?: string } | null;
  at: string;
}

const isHttps = (u: unknown): u is string => typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(u);

/** Ověření + ořez; vrací chybový kód místo výjimky. */
export function validateAnnouncement(body: unknown, workspaces: Map<string, string>): { ok: true; values: AnnouncementPayload[] } | { ok: false; error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const id = String(b.id ?? '').slice(0, 80);
  const workspace = String(b.workspace ?? '').toLowerCase().slice(0, 40);
  if (!id) return { ok: false, error: 'missing_id' };
  const channels = [...workspaces.entries()].filter(([, slug]) => slug === workspace).map(([ch]) => ch);
  if (!workspace || !channels.length) return { ok: false, error: 'unknown_workspace' };
  const text = String(b.text ?? '').slice(0, 500).trim();
  const textHtml = String(b.textHtml ?? '').slice(0, 4000).trim();
  const m = b.media && typeof b.media === 'object' ? (b.media as Record<string, unknown>) : null;
  let media: AnnouncementPayload['media'] = null;
  if (m) {
    if (!isHttps(m.url)) return { ok: false, error: 'media_url_must_be_https' };
    media = {
      url: m.url,
      kind: m.kind === 'image' ? 'image' : 'video',
      width: Number(m.width) > 0 ? Math.round(Number(m.width)) : undefined,
      height: Number(m.height) > 0 ? Math.round(Number(m.height)) : undefined,
      loop: !!m.loop,
      loopDelayMs: Math.max(0, Math.min(60_000, Math.round(Number(m.loopDelayMs) || 0))),
      stillUrl: isHttps(m.stillUrl) ? m.stillUrl : null,
    };
  }
  if (!media && !text && !textHtml) return { ok: false, error: 'empty_announcement' };
  const by = b.triggeredBy && typeof b.triggeredBy === 'object' ? (b.triggeredBy as Record<string, unknown>) : null;
  const cr = b.chatReply && typeof b.chatReply === 'object' ? (b.chatReply as Record<string, unknown>) : null;
  const chatReply = cr && String(cr.text ?? '').trim() ? { text: String(cr.text).slice(0, 500), hideInUnityChat: !!cr.hideInUnityChat } : null;
  const at = typeof b.at === 'string' && Number.isFinite(Date.parse(b.at)) ? b.at : new Date().toISOString();
  const base = {
    id, workspace, text, textHtml, media, at, chatReply,
    command: String(b.command ?? '').slice(0, 80),
    triggeredBy: by && by.user ? { user: String(by.user).slice(0, 60), platform: String(by.platform ?? '').slice(0, 20) } : null,
  };
  return { ok: true, values: channels.map((channel) => ({ ...base, channel })) };
}

export default async function announcementRoutes(app: FastifyInstance) {
  const workspaces = parseWorkspaceMap(config.ZIDOLISTA_WORKSPACES);

  app.post('/announcements', async (req, reply) => {
    if (!keyMatches(req.headers['x-api-key'])) return reply.code(401).send({ ok: false, error: 'unauthorized' });
    const v = validateAnnouncement(req.body, workspaces);
    if (!v.ok) return reply.code(v.error === 'unknown_workspace' ? 404 : 400).send({ ok: false, error: v.error });
    for (const value of v.values) broadcast('announcement', value);
    app.log.info({ id: v.values[0].id, channels: v.values.map((x) => x.channel), command: v.values[0].command, media: !!v.values[0].media, hideReply: !!v.values[0].chatReply?.hideInUnityChat }, 'announcement: broadcast');
    return reply.code(202).send({ ok: true, channels: v.values.map((x) => x.channel) });
  });
}
