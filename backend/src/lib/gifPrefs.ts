// Předvolba účtu „stažení GIFu prohlížečem odesílatele" (spec 2026-09-29 §5, Task 6): ask (zeptat se pokaždé,
// výchozí) | always (rovnou stahovat sám) | never (nikdy — server GIF zahodí jako selhání). Ukládá se ze dvou
// míst: zaškrtnutí „Nezobrazovat znovu" u nabídky (POST /gif/client-upload, /gif/client-fetch/decline) a
// PUT /account/gif-prefs (nastavení). Tabulka account_gif_prefs vytvořena ručně SQL (sql/2026-09-29-gif-client-fetch.sql).
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accountGifPrefs } from '../db/schema.js';

export const CLIENT_FETCH_PREFS = ['ask', 'always', 'never'] as const;
export type ClientFetchPref = (typeof CLIENT_FETCH_PREFS)[number];
export const isClientFetchPref = (v: unknown): v is ClientFetchPref => (CLIENT_FETCH_PREFS as readonly unknown[]).includes(v);

/** Předvolba účtu; chybí řádek (nikdy nenastaveno) nebo neplatná hodnota → 'ask'. */
export async function getClientFetchPref(accountId: number): Promise<ClientFetchPref> {
  const [r] = await db.select({ v: accountGifPrefs.clientFetch }).from(accountGifPrefs).where(eq(accountGifPrefs.accountId, accountId)).limit(1);
  return isClientFetchPref(r?.v) ? r.v : 'ask';
}

export async function setClientFetchPref(accountId: number, v: ClientFetchPref): Promise<void> {
  await db.insert(accountGifPrefs).values({ accountId, clientFetch: v })
    .onConflictDoUpdate({ target: accountGifPrefs.accountId, set: { clientFetch: v, updatedAt: new Date() } });
}

/** Tvar podle GifRouteOpts.prefs (routes/gif.ts) — DB implementace vs. testy. */
export const gifPrefs = { getClientFetch: getClientFetchPref, setClientFetch: setClientFetchPref };
