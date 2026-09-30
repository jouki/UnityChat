// Broadcast (mod / streamer): jedna zpráva účtem uživatele na všechny jeho přihlášené platformy
// (POST /chat/broadcast). Roli ověřuje VÝHRADNĚ server (accountModIdentities — badge ze serverového
// logu zpráv nebo login = kanál), klient ji nemůže podstrčit: volba v menu je jen pohodlí, bez role
// server nic neodešle (403 not_mod). Commandy a GIF odkazy Broadcastem nejdou (bot by reagoval
// vícekrát, vznikly by tři žádosti o GIF) — ty patří na jednu platformu přes /chat/send.
import { outgoingText, SendError } from './webSend.js';
import { gifCandidate } from './gifMedia.js';
import type { AccountModIdentity } from './chatRole.js';
import type { Platform } from './zidolista.js';

export interface BroadcastSent { id?: string | null; sentText?: string | null }

export interface BroadcastDeps {
  pendingWarnings: (accountId: number) => Promise<unknown[]>;
  modIdentities: (accountId: number, channel: string) => Promise<AccountModIdentity[]>;
  listIdentities: (accountId: number) => Promise<{ platform: Platform }[]>;
  send: (platform: Platform, text: string) => Promise<BroadcastSent>;
  log?: { info: (o: object, msg: string) => void; warn: (o: object, msg: string) => void };
}

export type BroadcastResult =
  | { ok: true; id: string | null; text: string }
  | { ok: false; status: number; error: string };

const ORDER: Platform[] = ['twitch', 'kick', 'youtube'];

/**
 * @returns HTTP status + tělo: 200 `{ok, results: {platform: BroadcastResult}}` (ok = aspoň jedna platforma
 * prošla, jinak 502), 400 `command` / `gif` / `targets` / text, 403 `warning_pending` / `not_mod`.
 */
export async function runBroadcast(
  p: { accountId: number; channel: string; text: string; texts?: Partial<Record<Platform, string>> | null },
  deps: BroadcastDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  // `texts` = podoba pro jednotlivé platformy (klient překládá @přezdívku na login dané platformy);
  // každá projde stejnou kontrolou jako `text`, jinak by jí šel propašovat command / GIF.
  const prepared: Partial<Record<Platform, string>> = {};
  for (const pl of [null, ...ORDER] as (Platform | null)[]) {
    const raw = String((pl ? p.texts?.[pl] : p.text) ?? '').trim();
    if (pl && !p.texts?.[pl]) continue;
    // !command jde na všechny platformy (pokyn usera 2026-09-29, i commandy StreamElements); lomítkové commandy
    // jsou věc platformy (/me, /timeout…) → jen přes /chat/send na vybranou platformu.
    if (raw.startsWith('/')) return { status: 400, body: { ok: false, error: 'command' } };
    let out: string;
    try { out = outgoingText(raw); } catch (e) { return { status: 400, body: { ok: false, error: (e as Error).message } }; }
    if (gifCandidate(raw)) return { status: 400, body: { ok: false, error: 'gif' } };
    if (pl) prepared[pl] = out; else prepared.twitch = prepared.kick = prepared.youtube = out;
  }

  // Nepotvrzené varování blokuje psaní jako u /chat/send; výpadek kontroly psaní neblokuje.
  try {
    if ((await deps.pendingWarnings(p.accountId)).length) return { status: 403, body: { ok: false, error: 'warning_pending' } };
  } catch (e) { deps.log?.warn({ err: (e as Error).message }, 'broadcast: kontrola varování selhala'); }

  // Role ze serveru — PŘED jakýmkoli odesláním. Chyba ověření = žádné odeslání (fail closed).
  let mods: AccountModIdentity[];
  try { mods = await deps.modIdentities(p.accountId, p.channel); } catch (e) {
    deps.log?.warn({ accountId: p.accountId, err: (e as Error).message }, 'broadcast: ověření role selhalo');
    return { status: 503, body: { ok: false, error: 'role_check_failed' } };
  }
  if (!mods.length) {
    deps.log?.info({ accountId: p.accountId, channel: p.channel }, 'broadcast: not_mod');
    return { status: 403, body: { ok: false, error: 'not_mod' } };
  }

  const linked = new Set((await deps.listIdentities(p.accountId)).map((i) => i.platform));
  const targets = ORDER.filter((pl) => linked.has(pl));
  if (targets.length < 2) return { status: 400, body: { ok: false, error: 'targets' } };

  const settled = await Promise.allSettled(targets.map((pl) => deps.send(pl, prepared[pl]!)));
  const results: Record<string, BroadcastResult> = {};
  targets.forEach((pl, i) => {
    const s = settled[i];
    if (s.status === 'fulfilled') results[pl] = { ok: true, id: s.value.id ?? null, text: s.value.sentText ?? prepared[pl]! };
    else {
      const err = s.reason as Error;
      const status = err instanceof SendError ? err.status : 502;
      results[pl] = { ok: false, status, error: err?.message || 'send failed' };
    }
  });
  const okCount = Object.values(results).filter((r) => r.ok).length;
  deps.log?.info({ accountId: p.accountId, channel: p.channel, by: `${mods[0].platform}:${mods[0].login}`, targets, ok: okCount, len: prepared.twitch?.length ?? 0 }, 'chat broadcast');
  return { status: okCount ? 200 : 502, body: { ok: okCount > 0, results } };
}
