// Odznak podporovatele — individuální volba účtu (pokyn usera 2026-09-30): `replaceGlobal` = odznak UnityChat
// u vlastních zpráv na Twitchi nahradí globální odznak Twitche (jinak má vlastní slot vedle ostatních; role / sub
// zůstávají vždy). Volba se ukazuje jen účtu s propojeným Twitchem. Ostatní volby odznaku (varianta, tempo,
// intenzita, odstupy) jsou společné pro kanál (routes/channelPrefs.ts, jen mod / streamer v dev módu).
//
// Zprávy: toClientMessage (routes/chat.ts) dá dárci s touhle volbou `donorReplace: true`, klient globální odznaky
// vynechá (core stripGlobalTwitchBadges); addon u živé zprávy z vlastního IRC dostane totéž v SSE donor-mark.
// Dotaz ze zpráv je synchronní z cache `twitch:<userId>` → účty s volbou (naplněno při startu, aktualizace při PUT
// a při změně identit účtu přes refreshAccount).
// Tabulka account_badge_prefs vytvořena ručně SQL (sql/2026-09-30-account-badge-prefs.sql).
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accountBadgePrefs, webIdentities } from '../db/schema.js';

type Log = { info?: (o: object, m: string) => void; warn: (o: object, m: string) => void };
/** platform:userId → účet s volbou replaceGlobal (jen Twitch — jinde globální odznaky nejsou). */
const replaceByIdentity = new Map<string, number>();
const key = (platform: string, userId: string) => `${platform}:${userId}`;

/** Má autor zprávy (identita platformy) zapnuté „místo globálního odznaku“? Jen z cache. */
export function authorReplacesGlobal(platform: string, userId: string | null | undefined): boolean {
  return platform === 'twitch' && !!userId && replaceByIdentity.has(key(platform, String(userId)));
}

export async function getReplaceGlobalPref(accountId: number): Promise<boolean> {
  const [r] = await db.select({ v: accountBadgePrefs.replaceGlobal }).from(accountBadgePrefs).where(eq(accountBadgePrefs.accountId, accountId)).limit(1);
  return r?.v === true;
}

export async function setReplaceGlobalPref(accountId: number, v: boolean): Promise<void> {
  await db.insert(accountBadgePrefs).values({ accountId, replaceGlobal: v })
    .onConflictDoUpdate({ target: accountBadgePrefs.accountId, set: { replaceGlobal: v, updatedAt: new Date() } });
  await refreshAccount(accountId, v);
}

/** Cache pro jeden účet: identity účtu (přihlášené) → podle volby přidat / odebrat. Volat i po změně identit. */
export async function refreshAccount(accountId: number, pref?: boolean): Promise<void> {
  const v = pref ?? (await getReplaceGlobalPref(accountId));
  for (const [k, acc] of replaceByIdentity) if (acc === accountId) replaceByIdentity.delete(k);
  if (!v) return;
  const ids = await db.select({ platform: webIdentities.platform, userId: webIdentities.platformUserId }).from(webIdentities)
    .where(and(eq(webIdentities.accountId, accountId), eq(webIdentities.platform, 'twitch'), isNull(webIdentities.signedOutAt)));
  for (const i of ids) replaceByIdentity.set(key(i.platform, i.userId), accountId);
}

/** Při startu: všechny účty s volbou → cache. Výpadek DB = prázdná cache (odznak ve vlastním slotu), žádný pád. */
export async function loadBadgePrefs(log?: Log): Promise<number> {
  try {
    const rows = await db.select({ accountId: accountBadgePrefs.accountId, platform: webIdentities.platform, userId: webIdentities.platformUserId })
      .from(accountBadgePrefs)
      .innerJoin(webIdentities, and(eq(webIdentities.accountId, accountBadgePrefs.accountId), eq(webIdentities.platform, 'twitch'), isNull(webIdentities.signedOutAt)))
      .where(eq(accountBadgePrefs.replaceGlobal, true));
    replaceByIdentity.clear();
    for (const r of rows) replaceByIdentity.set(key(r.platform, r.userId), r.accountId);
    log?.info?.({ n: replaceByIdentity.size }, 'badge-prefs: cache načtena');
    return replaceByIdentity.size;
  } catch (e) {
    log?.warn({ err: (e as Error).message }, 'badge-prefs: cache nenačtena (odznaky ve vlastním slotu)');
    return 0;
  }
}

/** Jen pro testy. */
export function _setReplaceForTest(entries: Array<[string, string, number]>): void {
  replaceByIdentity.clear();
  for (const [p, id, acc] of entries) replaceByIdentity.set(key(p, id), acc);
}
