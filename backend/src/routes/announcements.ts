import { anncThrottle } from '../lib/anncThrottle.js';
import type { FastifyInstance } from 'fastify';
import { broadcast } from '../sse/bus.js';
import { botLogins } from './commands.js';
import { inboundAuthorized } from '../lib/inboundAuth.js';
import { getWorkspaces } from '../lib/zidolista.js';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { announcements, messages } from '../db/schema.js';
import { anncHides, ANNC_BOT_BEHIND_MS } from '../lib/anncHides.js';

/**
 * POST /announcements — UnityChat Announcement ze Židolišty (RobJewsALot).
 *
 * Command v Židolištce může mít jako odpověď honosnou zprávu s videem a
 * textem, kterou vidí jen uživatelé UnityChatu (addon + robdiesalot.com/chat).
 * Židolišta ji po spuštění commandu pošle sem (X-Api-Key = ZIDOLISTA_API_KEY),
 * backend ji ověří, rozešle přes SSE `announcement` na /nicknames/stream a ULOŽÍ (tabulka announcements,
 * 2026-09-30) — /chat/history ji vrací mezi zprávami (`ucAnnouncement`), takže po obnovení nezmizí. Potlačenou
 * odpověď bota / commandu označí server v ingestu (lib/anncHides.ts → content_raw.anncHidden), historie ji
 * pošle s `anncHidden: true` a klienti ji nevykreslí — stejně jako živě.
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
  /** Loginy botů (StreamElements…), jejichž odpověď na command klient uživatelům UnityChatu skryje. */
  hideBotReplies: string[];
  /** true = browser source pro OBS (/chat/raw/) announcement nevykreslí. */
  hideInBrowserSource: boolean;
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
    id, workspace, text, textHtml, media, at, chatReply, hideBotReplies: botLogins(b.hideBotReplies), hideInBrowserSource: !!b.hideInBrowserSource,
    command: String(b.command ?? '').slice(0, 80),
    triggeredBy: by && by.user ? { user: String(by.user).slice(0, 60), platform: String(by.platform ?? '').slice(0, 20) } : null,
  };
  return { ok: true, values: channels.map((channel) => ({ ...base, channel })) };
}

/** Zprávy botů těsně PŘED announcementem (bot odpověděl dřív, než Židolišta poslala announcement) → anncHidden. */
async function hideEarlierBotReplies(channel: string, logins: string[], atMs: number, anncId: string): Promise<void> {
  for (const login of logins) {
    const [row] = await db.select({ id: messages.id, raw: messages.contentRaw }).from(messages)
      .where(and(eq(messages.channel, channel), sql`lower(${messages.platformUsername}) = ${login}`, gte(messages.sentAt, new Date(atMs - ANNC_BOT_BEHIND_MS)), lte(messages.sentAt, new Date(atMs + 1000))))
      .orderBy(desc(messages.sentAt)).limit(1);
    if (!row) continue;
    const raw = (row.raw && typeof row.raw === 'object' ? row.raw : {}) as Record<string, unknown>;
    if (raw.anncHidden) continue;
    await db.update(messages).set({ contentRaw: { ...raw, anncHidden: anncId } }).where(eq(messages.id, row.id));
  }
}

/** Announcementy kanálu v časovém rozmezí (pro /chat/history), vzestupně. */
export async function announcementsBetween(channel: string, fromMs: number, toMs: number, limit = 50): Promise<Array<{ id: string; at: Date; payload: AnnouncementPayload }>> {
  const rows = await db.select({ id: announcements.id, at: announcements.at, payload: announcements.payload }).from(announcements)
    .where(and(eq(announcements.channel, channel), gte(announcements.at, new Date(fromMs)), lte(announcements.at, new Date(toMs))))
    .orderBy(desc(announcements.at)).limit(limit);
  return rows.reverse().map((r) => ({ id: r.id, at: r.at, payload: r.payload as AnnouncementPayload }));
}

export default async function announcementRoutes(app: FastifyInstance) {
  app.post('/announcements', async (req, reply) => {
    if (!inboundAuthorized(req, reply)) return reply;
    // Mapování kanál → workspace z registru Židolišty (lib/zidolista.ts); env je jen fallback.
    const workspaces = new Map<string, string>();
    for (const w of await getWorkspaces({ log: app.log })) if (w.channels.twitch) workspaces.set(w.channels.twitch, w.slug);
    const v = validateAnnouncement(req.body, workspaces);
    if (!v.ok) return reply.code(v.error === 'unknown_workspace' ? 404 : 400).send({ ok: false, error: v.error });
    const suppressed: string[] = [];
    for (const value of v.values) {
      // Bez spamu (pokyn usera 2026-10-03): spouštěč bez UnityChatu + méně než 10 zpráv od posledního zobrazení téhož
      // commandu → announcement se nezobrazí ani neschová odpověď bota (ta se ukáže normálně).
      const d = anncThrottle.decide(value.channel, value.command || value.id, value.triggeredBy ?? null);
      if (!d.show) {
        suppressed.push(value.channel);
        app.log.info({ id: value.id, channel: value.channel, command: value.command, since: d.since, by: value.triggeredBy?.user }, 'announcement: potlačen (bez UnityChatu, méně než 10 zpráv od posledního)');
        continue;
      }
      broadcast('announcement', value);
      const hide = anncHides.remember(value);
      try {
        await db.insert(announcements).values({ id: value.id, channel: value.channel, workspace: value.workspace, at: new Date(value.at), payload: value })
          .onConflictDoNothing({ target: [announcements.id, announcements.channel] });
        // Bot rychlejší než announcement: jeho poslední zpráva nejvýš 5 s před ním už může být v DB → označit.
        if (hide?.botLogins.length) await hideEarlierBotReplies(value.channel, hide.botLogins, hide.atMs, value.id);
      } catch (e) { app.log.warn({ err: (e as Error).message, id: value.id }, 'announcement: uložení selhalo (v historii nebude)'); }
    }
    app.log.info({ id: v.values[0].id, channels: v.values.map((x) => x.channel), command: v.values[0].command, media: !!v.values[0].media, hideReply: !!v.values[0].chatReply?.hideInUnityChat, hideBots: v.values[0].hideBotReplies, hideObs: v.values[0].hideInBrowserSource }, 'announcement: broadcast');
    return reply.code(202).send({ ok: true, channels: v.values.map((x) => x.channel), ...(suppressed.length ? { suppressed } : {}) });
  });
}
