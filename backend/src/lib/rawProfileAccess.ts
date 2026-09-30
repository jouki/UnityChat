// Instance OBS chatu (raw_profiles) patří kanálu (pokyn usera 2026-09-28): vidí je, upravují, přidávají a mažou jen
// streamer a modi kanálu — roli ověřuje server (accountModIdentities — badge ze serverového logu / login = kanál).
// Nikdo jiný přístup nemá ani se znalostí id. OBS zdroj nastavení jen čte (GET /raw-profiles/:id).

export const CHANNEL_RE = /^[a-z0-9_]{1,40}$/;

export interface ProfileAccessDeps {
  /** Je účet streamer nebo mod kanálu? */
  isEditor: (accountId: number, channel: string) => Promise<boolean>;
}

export type EditCheck = { ok: true } | { ok: false; status: 401 | 403 | 404; error: 'login_required' | 'not_editor' | 'not_found' };

/**
 * Smí `accountId` (null = bez přihlášení) upravit / smazat instanci? `row` = null (neexistuje), jinak její kanál
 * (null = nepřipojená — po úklidu 2026-09-28 žádná není; upravit ji nesmí nikdo).
 */
export async function canEditProfile(row: { channel: string | null } | null, accountId: number | null, deps: ProfileAccessDeps): Promise<EditCheck> {
  if (accountId === null) return { ok: false, status: 401, error: 'login_required' };
  if (!row) return { ok: false, status: 404, error: 'not_found' };
  if (!row.channel) return { ok: false, status: 403, error: 'not_editor' };
  const editor = await deps.isEditor(accountId, row.channel).catch(() => false);
  return editor ? { ok: true } : { ok: false, status: 403, error: 'not_editor' };
}

/** Smí `accountId` spravovat instance kanálu (seznam, nová instance)? Chyba ověření = ne. */
export async function canManageChannel(channel: string, accountId: number | null, deps: ProfileAccessDeps): Promise<EditCheck> {
  if (accountId === null) return { ok: false, status: 401, error: 'login_required' };
  const editor = await deps.isEditor(accountId, channel).catch(() => false);
  return editor ? { ok: true } : { ok: false, status: 403, error: 'not_editor' };
}
