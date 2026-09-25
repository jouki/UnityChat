// Změny přezdívek z databáze (trigger nicknames_notify → pg_notify 'uc_nickname', SQL
// backend/sql/2026-09-25-nicknames-notify.sql) → SSE všem klientům. Jediný zdroj událostí:
// funguje pro API i pro ruční opravu přímo v DB.
import { listenDb } from '../db/index.js';
import { broadcast } from '../sse/bus.js';

export const NICKNAME_CHANNEL = 'uc_nickname';

export type NicknameEvent =
  | { event: 'nickname-change'; data: { platform: string; username: string; nickname: string; color: string | null } }
  | { event: 'nickname-delete'; data: { platform: string; username: string } };

/** Payload z pg_notify → SSE událost (neplatný = null). */
export function parseNicknameNotify(payload: string): NicknameEvent | null {
  let j: Record<string, unknown>;
  try { j = JSON.parse(payload); } catch { return null; }
  const platform = typeof j.platform === 'string' ? j.platform : '';
  const username = typeof j.username === 'string' ? j.username : '';
  if (!platform || !username) return null;
  if (j.op === 'delete') return { event: 'nickname-delete', data: { platform, username } };
  if (j.op === 'upsert' && typeof j.nickname === 'string') {
    return { event: 'nickname-change', data: { platform, username, nickname: j.nickname, color: typeof j.color === 'string' ? j.color : null } };
  }
  return null;
}

export async function startNicknameNotify(log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void }): Promise<void> {
  await listenDb(NICKNAME_CHANNEL, (payload) => {
    const ev = parseNicknameNotify(payload);
    if (!ev) { log.warn({ payload: payload.slice(0, 200) }, 'nicknames: neplatná notifikace z DB'); return; }
    broadcast(ev.event, ev.data);
  });
  log.info({ channel: NICKNAME_CHANNEL }, 'nicknames: poslouchám změny z DB');
}
