import { config } from '../config.js';

/**
 * Odeslání zprávy do chatu platformy tokenem uživatele (web verze, spec §3.3).
 * fetch je injektovatelný kvůli testům. NIKDY nelogovat tokeny.
 */

export const UC_MARKER = '⠀'; // Braille Pattern Blank — stejný marker jako addon
export const MAX_LEN = 500;

export class SendError extends Error {
  constructor(message: string, public status = 400, public retryable = false) {
    super(message);
  }
}

/** Normalizace odchozího textu: trim, limit, UC marker (ne na !/ příkazy — rozbilo by boty). */
export function outgoingText(raw: string): string {
  const text = String(raw || '').replace(/\s+$/g, '').replace(/^\s+/g, '');
  if (!text) throw new SendError('empty message');
  if (text.length > MAX_LEN) throw new SendError(`message too long (max ${MAX_LEN})`);
  if (text.startsWith('!') || text.startsWith('/')) return text;
  return `${text} ${UC_MARKER}`;
}

type FetchLike = typeof fetch;

async function readJson(resp: Response): Promise<Record<string, unknown>> {
  try { return (await resp.json()) as Record<string, unknown>; } catch { return {}; }
}

// ---- Twitch: Helix POST /chat/messages (scope user:write:chat) -------------
export async function sendTwitch(
  p: { accessToken: string; senderId: string; broadcasterId: string; text: string; replyTo?: string | null },
  fetchImpl: FetchLike = fetch,
): Promise<{ id: string | null }> {
  const body: Record<string, string> = { broadcaster_id: p.broadcasterId, sender_id: p.senderId, message: p.text };
  if (p.replyTo) body.reply_parent_message_id = p.replyTo;
  const resp = await fetchImpl('https://api.twitch.tv/helix/chat/messages', {
    method: 'POST',
    headers: { Authorization: `Bearer ${p.accessToken}`, 'Client-Id': config.TWITCH_CLIENT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await readJson(resp);
  if (resp.status === 401) throw new SendError('twitch: unauthorized', 401, true);
  if (!resp.ok) throw new SendError(`twitch: HTTP ${resp.status} ${(data.message as string) || ''}`.trim(), resp.status);
  const first = (data.data as Array<{ message_id?: string; is_sent?: boolean; drop_reason?: { code?: string; message?: string } }> | undefined)?.[0];
  // Twitch vrátí 200 i pro zahozenou zprávu — důvod je v drop_reason (code je klíčový pro diagnostiku:
  // msg_rejected, msg_requires_verified_phone_number, msg_followersonly, msg_ratelimit, …).
  if (first && first.is_sent === false) throw new SendError(`twitch: ${first.drop_reason?.message || 'dropped'} [${first.drop_reason?.code || 'no_code'}]`, 422);
  return { id: first?.message_id || null };
}

// ---- Kick: public API POST /public/v1/chat (scope chat:write) ---------------
/** Diagnostika chyby Kicku do textu chyby (log + `detail` pro Židolištu): hlavičky Cloudflare / limitů + začátek těla bez tagů. */
export function kickErrorDiag(resp: { headers: { get(name: string): string | null } }, rawBody: string): string {
  const h: string[] = [];
  for (const name of ['cf-ray', 'cf-mitigated', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'server']) {
    const v = resp.headers.get(name);
    if (v) h.push(`${name}=${v.slice(0, 80)}`);
  }
  const body = rawBody.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  return (h.length ? ` [${h.join(' ')}]` : '') + (body ? ` body: ${body}` : '');
}

export async function sendKick(
  p: { accessToken: string; broadcasterUserId: string; text: string; replyTo?: string | null },
  fetchImpl: FetchLike = fetch,
): Promise<{ id: string | null }> {
  const body: Record<string, unknown> = { broadcaster_user_id: Number(p.broadcasterUserId), content: p.text, type: 'user' };
  if (p.replyTo) body.reply_to_message_id = p.replyTo;
  const resp = await fetchImpl('https://api.kick.com/public/v1/chat', {
    method: 'POST',
    headers: { Authorization: `Bearer ${p.accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  // Tělo jako text: 403 od Cloudflare je HTML, ne JSON (diagnostika občasného 403 JoukiBOTa, 2026-10-02).
  const rawBody = await resp.text().catch(() => '');
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(rawBody) as Record<string, unknown>; } catch { /* HTML / prázdné */ }
  if (resp.status === 401) throw new SendError('kick: unauthorized', 401, true);
  // Kick nepustí odkaz od účtu, který v kanálu není moderátor (zjištěno 2026-10-02, JoukiBOT a !logi).
  if (data.data === 'NO_LINKS_ERROR') throw new SendError('kick: odkazy smí posílat jen moderátor kanálu (NO_LINKS_ERROR)', resp.status || 400);
  if (!resp.ok) throw new SendError(`kick: HTTP ${resp.status} ${(data.message as string) || ''}`.trim() + kickErrorDiag(resp, rawBody), resp.status);
  const d = data.data as { message_id?: string; is_sent?: boolean } | undefined;
  if (d && d.is_sent === false) throw new SendError('kick: not sent', 422);
  return { id: d?.message_id || null };
}

// ---- YouTube: liveChatMessages.insert (scope youtube.force-ssl) -------------
export async function youtubeLiveChatId(
  p: { accessToken: string; videoId: string },
  fetchImpl: FetchLike = fetch,
): Promise<string | null> {
  const u = new URL('https://www.googleapis.com/youtube/v3/videos');
  u.searchParams.set('part', 'liveStreamingDetails');
  u.searchParams.set('id', p.videoId);
  const resp = await fetchImpl(u, { headers: { Authorization: `Bearer ${p.accessToken}` }, signal: AbortSignal.timeout(10_000) });
  if (resp.status === 401) throw new SendError('youtube: unauthorized', 401, true);
  if (!resp.ok) throw new SendError(`youtube: videos.list HTTP ${resp.status}`, resp.status);
  const data = await readJson(resp);
  const items = data.items as Array<{ liveStreamingDetails?: { activeLiveChatId?: string } }> | undefined;
  return items?.[0]?.liveStreamingDetails?.activeLiveChatId || null;
}

export async function sendYoutube(
  p: { accessToken: string; liveChatId: string; text: string },
  fetchImpl: FetchLike = fetch,
): Promise<{ id: string | null }> {
  const resp = await fetchImpl('https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet', {
    method: 'POST',
    headers: { Authorization: `Bearer ${p.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ snippet: { liveChatId: p.liveChatId, type: 'textMessageEvent', textMessageDetails: { messageText: p.text } } }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await readJson(resp);
  if (resp.status === 401) throw new SendError('youtube: unauthorized', 401, true);
  if (!resp.ok) {
    const err = data.error as { message?: string } | undefined;
    throw new SendError(`youtube: HTTP ${resp.status} ${err?.message || ''}`.trim(), resp.status);
  }
  return { id: (data.id as string) || null };
}
